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

// The RPC bodies are serialized server-side so the scripts stay dumb pipes — no
// quoting/escaping logic runs on the helper's machine.
function rpcBodies({ uid, password, ca }) {
  const { host, port } = env.deviceBroker;
  return [
    ['Installing server certificate', {
      id: 1, method: 'Shelly.PutUserCA', params: { append: false, data: ca },
    }],
    ['Setting time server', {
      id: 2, method: 'Sys.SetConfig', params: { config: { sntp: { server: 'pool.ntp.org' } } },
    }],
    ['Configuring server connection', {
      id: 3,
      method: 'MQTT.SetConfig',
      params: {
        config: {
          enable: true, server: `${host}:${port}`,
          client_id: `shellypro2-${uid}`, topic_prefix: `shellypro2-${uid}`,
          user: `shelly-${uid}`, pass: password,
          ssl_ca: 'user_ca.pem', rpc_ntf: true, status_ntf: true,
        },
      },
    }],
    ['Rebooting device', { id: 4, method: 'Shelly.Reboot' }],
  ];
}

function powershellScript(uid, bodies) {
  const steps = bodies.map(([label, body]) =>
    `Write-Host '${label}...'\nRpc '${JSON.stringify(body)}' | Out-Null`).join('\n');
  return `# Shabat-Clock: one-time Shelly setup (device ${uid}). Run in PowerShell on the same Wi-Fi as the Shelly.
$ErrorActionPreference = 'Stop'
$ip = Read-Host 'Enter the Shelly IP address (e.g. 192.168.1.50)'
function Rpc($json) {
  Invoke-RestMethod -Uri ("http://{0}/rpc" -f $ip) -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json))
}
Write-Host 'Checking device...'
$info = Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}'
$mac = ($info.mac -replace '[^0-9a-fA-F]', '').ToLower()
if ($mac -ne '${uid}') { throw "This is a different Shelly (MAC $mac, expected ${uid}). Wrong IP?" }
${steps}
Write-Host 'Done! The device will connect to the server within a minute.' -ForegroundColor Green
`;
}

function bashScript(uid, bodies) {
  const steps = bodies.map(([label, body]) =>
    `echo '${label}...'\nrpc '${JSON.stringify(body)}' >/dev/null`).join('\n');
  return `#!/usr/bin/env bash
# Shabat-Clock: one-time Shelly setup (device ${uid}). Run on the same Wi-Fi as the Shelly.
set -euo pipefail
read -rp 'Enter the Shelly IP address (e.g. 192.168.1.50): ' IP
rpc() { curl -sf "http://$IP/rpc" -H 'Content-Type: application/json' -d "$1"; }
echo 'Checking device...'
MAC=$(rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' | tr '[:upper:]' '[:lower:]' | grep -o '"mac" *: *"[0-9a-f:]*"' | grep -o '[0-9a-f]\\{2\\}\\(:\\?[0-9a-f]\\{2\\}\\)\\{5\\}' | tr -d ':')
[ "$MAC" = "${uid}" ] || { echo "This is a different Shelly (MAC $MAC, expected ${uid}). Wrong IP?"; exit 1; }
${steps}
echo 'Done! The device will connect to the server within a minute.'
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
