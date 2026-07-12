// Remote-Shelly onboarding: everything a NEW Shelly at a remote site needs in order
// to dial our broker — broker credentials + ACL written here on the server, and a
// copy-paste script (PowerShell/bash) that a person on the device's LAN runs once.
// The script installs our device CA, fixes SNTP (a null clock fails all TLS — bit us
// on the first device), points MQTT at the broker, and reboots. After the reboot the
// admin wizard's regular MQTT probe finds the device and registration proceeds.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { mosquittoPasswdHash, writeBrokerPasswdEntry } from './devices.js';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const generatePassword = (len = 24) =>
  Array.from({ length: len }, () => BASE62[crypto.randomInt(BASE62.length)]).join('');

// Idempotent: an existing block for this device is left as-is (password rewrites are
// fine — passwd entry is replaced wholesale by writeBrokerPasswdEntry).
function ensureAclEntry(uid) {
  if (!env.deviceBroker.aclFile) return;
  const user = `shelly-${uid}`;
  let text = '';
  try { text = fs.readFileSync(env.deviceBroker.aclFile, 'utf8'); } catch { /* new file */ }
  if (new RegExp(`^user ${user}$`, 'm').test(text)) return;
  const block = `\nuser ${user}\ntopic readwrite shellypro2-${uid}/#\ntopic write shabat-server/rpc\n`;
  fs.appendFileSync(env.deviceBroker.aclFile, block);
}

function reloadBroker() {
  if (!env.deviceBroker.reloadCmd) return;
  execSync(env.deviceBroker.reloadCmd, { timeout: 10_000 });
}

// Time servers tried in order until the device's clock syncs — an unsynced clock
// makes the device reject the broker certificate ("not yet valid"), the failure
// mode that burned both real onboardings so far.
const SNTP_SERVERS = ['pool.ntp.org', 'time.google.com', 'time.cloudflare.com'];

// The RPC bodies are serialized server-side so the scripts stay dumb pipes — no
// quoting/escaping logic runs on the helper's machine.
function rpcBodies({ uid, password, ca }) {
  const { host, port } = env.deviceBroker;
  return {
    putCa: JSON.stringify({ id: 1, method: 'Shelly.PutUserCA', params: { append: false, data: ca } }),
    mqtt: JSON.stringify({
      id: 2,
      method: 'MQTT.SetConfig',
      params: {
        config: {
          enable: true, server: `${host}:${port}`,
          client_id: `shellypro2-${uid}`, topic_prefix: `shellypro2-${uid}`,
          user: `shelly-${uid}`, pass: password,
          ssl_ca: 'user_ca.pem', rpc_ntf: true, status_ntf: true,
        },
      },
    }),
    sntp: SNTP_SERVERS.map((s) =>
      JSON.stringify({ id: 3, method: 'Sys.SetConfig', params: { config: { sntp: { server: s } } } })),
    reboot: JSON.stringify({ id: 4, method: 'Shelly.Reboot' }),
  };
}

// Configure → reboot → wait for the device → verify clock (rotating time servers,
// each change needs its own reboot) → verify the broker connection. One green/red
// verdict at the end, so a non-technical helper can just read it back.
function powershellScript(uid, b) {
  const sntpArray = b.sntp.map((j) => `'${j}'`).join(', ');
  return `# Shabat-Clock: one-time Shelly setup (device ${uid}). Run in PowerShell on the same Wi-Fi as the Shelly.
$ErrorActionPreference = 'Stop'
$ip = Read-Host 'Enter the Shelly IP address (e.g. 192.168.1.50)'
function Rpc($json) {
  Invoke-RestMethod -Uri ("http://{0}/rpc" -f $ip) -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
function WaitBack {
  Write-Host 'Waiting for the device to restart...'
  Start-Sleep 5
  foreach ($i in 1..30) {
    try { Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' | Out-Null; return } catch { Start-Sleep 2 }
  }
  throw 'Device did not come back after reboot — check its power and IP.'
}
function ClockOk {
  foreach ($i in 1..10) {
    try { $s = Rpc '{"id":0,"method":"Sys.GetStatus"}'; if ($s.unixtime -gt 1700000000) { return $true } } catch {}
    Start-Sleep 2
  }
  return $false
}
Write-Host 'Checking device...'
$info = Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}'
$mac = ($info.mac -replace '[^0-9a-fA-F]', '').ToLower()
if ($mac -ne '${uid}') { throw "This is a different Shelly (MAC $mac, expected ${uid}). Wrong IP?" }
Write-Host 'Installing server certificate...'
Rpc '${b.putCa}' | Out-Null
Write-Host 'Configuring server connection...'
Rpc '${b.mqtt}' | Out-Null
$sntp = @(${sntpArray})
$clock = $false
foreach ($cfg in $sntp) {
  Write-Host 'Setting time server and restarting...'
  Rpc $cfg | Out-Null
  try { Rpc '${b.reboot}' | Out-Null } catch {}
  WaitBack
  if (ClockOk) { $clock = $true; break }
  Write-Host 'Clock not synced yet - trying another time server...' -ForegroundColor Yellow
}
if (-not $clock) {
  Write-Host 'PROBLEM: the device clock never synced (the router may block NTP/UDP-123).' -ForegroundColor Red
  Write-Host 'The server connection cannot work until the clock syncs. Report this exact message.' -ForegroundColor Red
  exit 1
}
Write-Host 'Clock OK. Verifying server connection...'
foreach ($i in 1..30) {
  try { if ((Rpc '{"id":0,"method":"MQTT.GetStatus"}').connected) {
    Write-Host 'SUCCESS! The device is connected to the server.' -ForegroundColor Green
    exit 0
  } } catch {}
  Start-Sleep 2
}
Write-Host 'PROBLEM: clock is fine but the server connection did not come up within a minute.' -ForegroundColor Red
Write-Host 'Most common cause: an older setup script was used - ask for the NEWEST script and run it again.' -ForegroundColor Red
exit 1
`;
}

function bashScript(uid, b) {
  return `#!/usr/bin/env bash
# Shabat-Clock: one-time Shelly setup (device ${uid}). Run on the same Wi-Fi as the Shelly.
set -uo pipefail
read -rp 'Enter the Shelly IP address (e.g. 192.168.1.50): ' IP
rpc() { curl -sf --max-time 8 "http://$IP/rpc" -H 'Content-Type: application/json' -d "$1"; }
wait_back() {
  echo 'Waiting for the device to restart...'
  sleep 5
  for i in $(seq 1 30); do rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' >/dev/null 2>&1 && return 0; sleep 2; done
  echo 'Device did not come back after reboot — check its power and IP.'; exit 1
}
clock_ok() {
  for i in $(seq 1 10); do
    T=$(rpc '{"id":0,"method":"Sys.GetStatus"}' 2>/dev/null | grep -o '"unixtime" *: *[0-9]*' | grep -o '[0-9]*$' || true)
    [ -n "$T" ] && [ "$T" -gt 1700000000 ] && return 0
    sleep 2
  done
  return 1
}
echo 'Checking device...'
MAC=$(rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' | tr '[:upper:]' '[:lower:]' | grep -o '"mac" *: *"[0-9a-f:]*"' | grep -o '[0-9a-f]\\{2\\}\\(:\\?[0-9a-f]\\{2\\}\\)\\{5\\}' | tr -d ':')
[ "$MAC" = "${uid}" ] || { echo "This is a different Shelly (MAC $MAC, expected ${uid}). Wrong IP?"; exit 1; }
echo 'Installing server certificate...'
rpc '${b.putCa}' >/dev/null || { echo 'Certificate install failed'; exit 1; }
echo 'Configuring server connection...'
rpc '${b.mqtt}' >/dev/null || { echo 'MQTT config failed'; exit 1; }
CLOCK=0
while IFS= read -r CFG; do
  echo 'Setting time server and restarting...'
  rpc "$CFG" >/dev/null
  rpc '${b.reboot}' >/dev/null || true
  wait_back
  if clock_ok; then CLOCK=1; break; fi
  echo 'Clock not synced yet - trying another time server...'
done <<'SNTP_LIST'
${b.sntp.join('\n')}
SNTP_LIST
if [ "$CLOCK" != 1 ]; then
  echo 'PROBLEM: the device clock never synced (the router may block NTP/UDP-123).'
  echo 'The server connection cannot work until the clock syncs. Report this exact message.'
  exit 1
fi
echo 'Clock OK. Verifying server connection...'
for i in $(seq 1 30); do
  rpc '{"id":0,"method":"MQTT.GetStatus"}' 2>/dev/null | grep -q '"connected" *: *true' && { echo 'SUCCESS! The device is connected to the server.'; exit 0; }
  sleep 2
done
echo 'PROBLEM: clock is fine but the server connection did not come up within a minute.'
echo 'Most common cause: an older setup script was used - ask for the NEWEST script and run it again.'
exit 1
`;
}

export async function onboardShelly({ mac }) {
  const uid = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (uid.length !== 12) throw errors.validation('כתובת MAC לא תקינה — 12 תווים הקסדצימליים', { mac: 'invalid' });
  if (!env.deviceBroker.host) {
    throw errors.validation('חיבור מכשירים מרחוק אינו מוגדר בשרת זה (DEVICE_MQTT_HOST)');
  }
  let ca;
  try {
    ca = fs.readFileSync(env.deviceBroker.caFile, 'utf8');
  } catch {
    throw errors.validation('תעודת ה-CA של המכשירים לא נמצאה בשרת (DEVICE_CA_FILE)');
  }

  const password = generatePassword();
  writeBrokerPasswdEntry(`shelly-${uid}`, mosquittoPasswdHash(password));
  ensureAclEntry(uid);
  reloadBroker();

  const bodies = rpcBodies({ uid, password, ca });
  return {
    mac: uid,
    broker: `${env.deviceBroker.host}:${env.deviceBroker.port}`,
    script_ps: powershellScript(uid, bodies),
    script_sh: bashScript(uid, bodies),
  };
}
