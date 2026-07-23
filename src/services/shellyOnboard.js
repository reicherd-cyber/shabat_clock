// Remote-Shelly onboarding: everything a NEW Shelly at a remote site needs in order
// to dial our broker — broker credentials + ACL written here on the server, and a
// copy-paste script (PowerShell/bash) that a person on the device's LAN runs once.
// The script installs our device CA, fixes SNTP (a null clock fails all TLS — bit us
// on the first device), points MQTT at the broker, and reboots. After the reboot the
// admin wizard's regular MQTT probe finds the device and registration proceeds.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
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
    // Single call with append:false is a complete upload (data:null would DELETE).
    // The reply's {len} is echoed so a mangled upload is visible immediately.
    putCa: JSON.stringify({ id: 1, method: 'Shelly.PutUserCA', params: { append: false, data: ca } }),
    caLen: ca.length,
    // Last-resort fallback (prompt-gated in the script): TLS without server-cert
    // verification — still encrypted, still per-device credentials + topic ACL.
    mqttNoVerify: JSON.stringify({
      id: 5, method: 'MQTT.SetConfig', params: { config: { ssl_ca: '*' } },
    }),
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
  // Everything lives inside Main so failures throw (never `exit`, which closes a
  // pasted-into console window before anyone reads the verdict); the wrapper prints
  // the throw in red and always pauses at the end.
  return `# Shabat-Clock: one-time Shelly setup (device ${uid}). Run in PowerShell on the same Wi-Fi as the Shelly.
$ErrorActionPreference = 'Stop'
# Talk to the device directly — corporate/system proxies answer local addresses with
# their own pages and break every step (burned a real onboarding).
[System.Net.WebRequest]::DefaultWebProxy = $null
function Main {
  function Rpc($json) {
    # POST /rpc answers with a JSON-RPC envelope {id, src, result|error} — unwrap it.
    $r = Invoke-RestMethod -Uri ("http://{0}/rpc" -f $script:ip) -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 8
    if ($null -ne $r -and $null -ne $r.PSObject.Properties['error'] -and $r.error) { throw ("Device returned error: " + $r.error.message) }
    if ($null -ne $r -and $null -ne $r.PSObject.Properties['result']) { return $r.result }
    return $r
  }
  function WaitBack {
    Write-Host 'Waiting for the device to restart...'
    Start-Sleep 5
    foreach ($i in 1..30) {
      try { Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' | Out-Null; return } catch { Start-Sleep 2 }
    }
    throw 'PROBLEM: device did not come back after reboot - check its power and IP.'
  }
  function ClockOk {
    foreach ($i in 1..10) {
      try { $s = Rpc '{"id":0,"method":"Sys.GetStatus"}'; if ($s.unixtime -gt 1700000000) { return $true } } catch {}
      Start-Sleep 2
    }
    return $false
  }
  # The device announces itself as shellypro2-<mac>.local on the LAN — try that first,
  # but only accept an answer that actually looks like a Shelly (some routers hijack
  # unresolved names and answer with their own web page).
  $script:ip = 'shellypro2-${uid}.local'
  Write-Host "Looking for the Shelly automatically ($script:ip)..."
  $found = $false
  try { if ((Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}').mac) { $found = $true } } catch {}
  if (-not $found) {
    $script:ip = Read-Host 'Not found automatically. Enter the Shelly IP address [press Enter for 192.168.33.1 = when connected to the Shelly own Wi-Fi hotspot]'
    if (-not $script:ip) { $script:ip = '192.168.33.1' }
  }
  Write-Host 'Checking device...'
  $info = Rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}'
  $mac = ($info.mac -replace '[^0-9a-fA-F]', '').ToLower()
  if (-not $mac) { throw 'PROBLEM: this address did not answer like a Shelly (the router may have answered instead). Run the script again and TYPE the device IP address (shown in the Shelly app under Device Information).' }
  if ($mac -ne '${uid}') { throw "PROBLEM: this is a different Shelly (MAC $mac, expected ${uid}). Wrong IP?" }
  $wifi = Rpc '{"id":0,"method":"Wifi.GetStatus"}'
  if ($wifi.status -ne 'got ip') {
    throw 'PROBLEM: the Shelly is not connected to the site Wi-Fi (no internet). Connect it to the Wi-Fi first (Shelly app > device > Wi-Fi settings), then run this script again.'
  }
  Write-Host 'Installing server certificate...'
  $ca = Rpc '${b.putCa}'
  Write-Host "Certificate stored: $($ca.len) bytes (expected ${b.caLen})"
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
    throw 'PROBLEM: the device clock never synced (the router may block NTP/UDP-123). The server connection cannot work until the clock syncs. Report this exact message.'
  }
  Write-Host 'Clock OK. Verifying server connection...'
  foreach ($i in 1..30) {
    try { if ((Rpc '{"id":0,"method":"MQTT.GetStatus"}').connected) {
      Write-Host 'SUCCESS! The device is connected to the server.' -ForegroundColor Green
      return
    } } catch {}
    Start-Sleep 2
  }
  Write-Host 'The verified connection did not come up.' -ForegroundColor Yellow
  $ans = Read-Host 'Try again WITHOUT certificate verification (still encrypted)? y/n'
  if ($ans -ne 'y') {
    throw 'PROBLEM: server connection did not come up (certificate-verified mode). Report this.'
  }
  Rpc '${b.mqttNoVerify}' | Out-Null
  try { Rpc '${b.reboot}' | Out-Null } catch {}
  WaitBack
  Write-Host 'Verifying server connection (no-verify mode)...'
  foreach ($i in 1..30) {
    try { if ((Rpc '{"id":0,"method":"MQTT.GetStatus"}').connected) {
      Write-Host 'SUCCESS - BUT connected WITHOUT certificate verification. Report this exact sentence.' -ForegroundColor Yellow
      return
    } } catch {}
    Start-Sleep 2
  }
  throw 'PROBLEM: no connection even without certificate verification. Report this.'
}
try { Main } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
Read-Host 'Finished - press Enter to close this window' | Out-Null
`;
}

function bashScript(uid, b) {
  return `#!/usr/bin/env bash
# Shabat-Clock: one-time Shelly setup (device ${uid}). Run on the same Wi-Fi as the Shelly.
set -uo pipefail
# Keep the verdict readable even when the terminal window closes on exit.
trap 'read -rp "Finished - press Enter to close this window: "' EXIT
rpc() { curl -sf --noproxy '*' --max-time 8 "http://$IP/rpc" -H 'Content-Type: application/json' -d "$1"; }
# The device announces itself as shellypro2-<mac>.local on the LAN — try that first,
# accepting only an answer that actually looks like a Shelly (routers may hijack
# unresolved names).
IP='shellypro2-${uid}.local'
echo "Looking for the Shelly automatically ($IP)..."
if ! rpc '{"id":0,"method":"Shelly.GetDeviceInfo"}' 2>/dev/null | grep -q '"mac"'; then
  read -rp 'Not found automatically. Enter the Shelly IP address [press Enter for 192.168.33.1 = when connected to the Shelly own Wi-Fi hotspot]: ' IP
  IP=\${IP:-192.168.33.1}
fi
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
rpc '{"id":0,"method":"Wifi.GetStatus"}' | grep -q '"status" *: *"got ip"' || {
  echo 'PROBLEM: the Shelly is not connected to the site Wi-Fi (no internet).'
  echo 'Connect it to the Wi-Fi first (Shelly app > device > Wi-Fi settings), then run this script again.'
  exit 1
}
echo 'Installing server certificate...'
CA_REPLY=$(rpc '${b.putCa}') || { echo 'Certificate install failed'; exit 1; }
echo "Certificate stored: $CA_REPLY (expected len ${b.caLen})"
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
echo 'The verified connection did not come up.'
read -rp 'Try again WITHOUT certificate verification (still encrypted)? y/n: ' ANS
[ "$ANS" = 'y' ] || { echo 'PROBLEM: server connection did not come up (certificate-verified mode). Report this.'; exit 1; }
rpc '${b.mqttNoVerify}' >/dev/null
rpc '${b.reboot}' >/dev/null || true
wait_back
echo 'Verifying server connection (no-verify mode)...'
for i in $(seq 1 30); do
  rpc '{"id":0,"method":"MQTT.GetStatus"}' 2>/dev/null | grep -q '"connected" *: *true' && { echo 'SUCCESS - BUT connected WITHOUT certificate verification. Report this exact sentence.'; exit 0; }
  sleep 2
done
echo 'PROBLEM: no connection even without certificate verification. Report this.'
exit 1
`;
}

// Phone (Android/iPhone) variant: a self-contained HTML page the helper opens in the
// phone's browser on the device's Wi-Fi. Shelly fw 1.3.x answers CORS preflights but
// omits Access-Control-Allow-Origin on real responses, so the browser can SEND
// commands (no-cors, text/plain — the device parses the body regardless) but never
// READ a reply. The page therefore fires the config blind and gets its green/red
// verdict from OUR server instead (statusUrl → MQTT probe), which also catches the
// wrong-physical-device case by comparing the connected device's reported MAC.
//
// Two modes share the template:
//  - per-device: uid + RPC bodies + status URL baked in (b/statusUrl set, prepareUrl '')
//  - universal:  the helper types the MAC; the page asks the server to mint that
//    device's credentials at install time (GET prepareUrl&mac=..., authorized by the
//    30-day installer token in the URL), then proceeds identically.
function htmlPage(uid, b, statusUrl, prepareUrl = '') {
  // Injected as JS string literals — the RPC bodies are JSON (no backticks/quotes issues
  // beyond '); JSON.stringify once more makes them safe literals.
  const inject = {
    uid: JSON.stringify(uid || ''),
    statusUrl: JSON.stringify(statusUrl || ''),
    prepareUrl: JSON.stringify(prepareUrl),
    bodies: b ? JSON.stringify({ putCa: b.putCa, mqtt: b.mqtt, noVerify: b.mqttNoVerify, reboot: b.reboot, sntp: b.sntp }) : 'null',
  };
  return `<!doctype html>
<html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>חיבור Shelly — שעון שבת</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#faf8f4;color:#2b2620;max-width:520px;margin-inline:auto}
 h1{font-size:20px;margin:0 0 4px}
 .mac{direction:ltr;display:inline-block;font-family:monospace;background:#efe9df;border-radius:8px;padding:2px 8px}
 .box{background:#fff;border:1px solid #e3ddd1;border-radius:14px;padding:14px;margin:12px 0}
 input{width:100%;box-sizing:border-box;font-size:18px;direction:ltr;text-align:center;padding:10px;border:1px solid #cfc9bb;border-radius:10px}
 button{width:100%;font-size:18px;padding:12px;border:0;border-radius:10px;background:#b3654a;color:#fff;margin-top:10px}
 button.alt{background:#fff;color:#2b2620;border:1px solid #cfc9bb}
 button:disabled{opacity:.5}
 #log div{padding:3px 0;font-size:15px}
 .ok{color:#3a7d44}.bad{color:#b3372f}.warn{color:#a06a00}
 .verdict{font-size:18px;font-weight:700;border-radius:12px;padding:12px;margin-top:10px}
 .verdict.ok{background:#e5f2e7;color:#3a7d44}.verdict.bad{background:#f7e5e3;color:#b3372f}.verdict.warn{background:#f7efdc;color:#a06a00}
 .hidden{display:none}
</style></head><body>
<h1>חיבור מכשיר Shelly לשעון שבת</h1>
<div>מכשיר: <span class="mac" id="uid">—</span></div>
<div class="box" id="httpsWarn" style="display:none;color:#b3372f;font-weight:600">
 הדף נפתח דרך אתר (https) ולכן הדפדפן יחסום את הגישה למכשיר.
 יש להוריד את הקובץ ולפתוח אותו מתיקיית ההורדות של הטלפון.
</div>
<div class="box">
 <b>איך מתקינים — הסדר המומלץ:</b>
 <ol style="margin:6px 0 0;padding-inline-start:18px">
  <li>חברו את המכשיר ל-Wi-Fi של הבית דרך אפליקציית Shelly.</li>
  <li>חברו את הטלפון הזה לאותו Wi-Fi ביתי.</li>
  <li>הקלידו למטה את קוד המכשיר (MAC) מהמדבקה ולחצו "התחל התקנה".</li>
 </ol>
 <div style="margin-top:8px;font-size:14px;color:#a06a00">
  ⚠ <b>קו אינטרנט מסונן (נטפרי / אתרוג / רימון)?</b> ההתקנה תיראה תקינה אבל המכשיר לא
  יתחבר לשרת עד שספק הסינון יחריג את 188.166.29.235 פורט 8883. כדאי לבקש את ההחרגה מראש.
 </div>
 <details style="margin-top:8px;font-size:14px">
  <summary style="cursor:pointer"><b>אין אפליקציה? התקנה דרך הרשת שהמכשיר משדר ›</b></summary>
  <div style="margin-top:6px">
   שלב א' — בטלפון על Wi-Fi רגיל (עם אינטרנט): הקלידו את הקוד ולחצו "התחל התקנה" עד
   שיופיע "פרטי חיבור נוצרו" (המכשיר עוד לא יימצא — זה בסדר).
   שלב ב' — עברו לרשת שהמכשיר משדר (...-Shelly), השאירו את שדה הכתובת ריק ולחצו שוב —
   ההגדרות יישלחו למכשיר.
   שלב ג' — חזרו ל-Wi-Fi הרגיל ולחצו "בדוק שוב מול השרת".
   שימו לב: גם בדרך זו המכשיר חייב להיות מחובר ל-Wi-Fi הביתי כדי להתחבר לשרת בסוף.
  </div>
 </details>
 <div style="margin-top:10px">
  <div id="macHelp" class="hidden" style="font-size:14px;margin-bottom:6px">
   קוד המכשיר (MAC) מופיע בשם הרשת שהוא משדר — למשל ברשת
   <b dir="ltr">ShellyPro2-80F3DAC8DCA8</b> הקוד הוא <b dir="ltr">80F3DAC8DCA8</b>.
   אפשר להקליד את שם הרשת המלא, את הקוד בלבד, או את ה-MAC מהמדבקה שעל המכשיר.
  </div>
  <input id="mac" class="hidden" placeholder="שם הרשת ShellyPro2-... או קוד המכשיר (MAC)" style="margin-bottom:8px">
  <input id="ip" class="hidden" placeholder="כתובת IP של המכשיר">
  <button id="go">התחל התקנה</button>
 </div>
</div>
<div class="box hidden" id="progress"><div id="log"></div><div id="verdict"></div><div id="actions"></div></div>
<script>
let UID=${inject.uid}, STATUS_URL=${inject.statusUrl}, B=${inject.bodies};
const PREPARE_URL=${inject.prepareUrl};
let IP='', sntpIdx=0;
const $=(id)=>document.getElementById(id);
if(UID)$('uid').textContent=UID;
if(PREPARE_URL){$('mac').classList.remove('hidden');$('macHelp').classList.remove('hidden')}
// Accepts "ShellyPro2-80F3DAC8DCA8", "80F3DAC8DCA8", or a colon-separated MAC —
// the part after the last dash wins so the letters of "shellypro" don't pollute it.
function parseMac(v){const s=v.trim().toLowerCase();const tail=s.includes('-')?s.slice(s.lastIndexOf('-')+1):s;const hex=tail.replace(/[^0-9a-f]/g,'');return hex.length===12?hex:s.replace(/[^0-9a-f]/g,'')}
if(location.protocol==='https:')$('httpsWarn').style.display='block';
const log=(t,cls)=>{const d=document.createElement('div');d.textContent=t;if(cls)d.className=cls;$('log').appendChild(d);d.scrollIntoView()};
const verdict=(t,cls)=>{$('verdict').innerHTML='<div class="verdict '+cls+'">'+t+'</div>'};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// no-cors: an opaque response still resolves = the device answered; reject = unreachable.
async function ping(ip){try{await fetch('http://'+ip+'/rpc/Shelly.GetDeviceInfo',{mode:'no-cors',cache:'no-store',signal:AbortSignal.timeout(4000)});return true}catch{return false}}
async function rpc(body){await fetch('http://'+IP+'/rpc',{method:'POST',mode:'no-cors',cache:'no-store',body,signal:AbortSignal.timeout(10000)})}
async function waitBack(){log('ממתין שהמכשיר יופעל מחדש...');await sleep(6000);for(let i=0;i<30;i++){if(await ping(IP))return true;await sleep(2000)}return false}
async function serverCheck(seconds){log('בודק מול השרת אם המכשיר התחבר...');const until=Date.now()+seconds*1000;while(Date.now()<until){try{const r=await(await fetch(STATUS_URL,{cache:'no-store'})).json();if(r.connected&&r.mac_ok)return 'ok';if(r.connected&&!r.mac_ok)return 'wrong';}catch(e){}await sleep(4000)}return 'no'}
function actionBtn(txt,fn,alt){const b=document.createElement('button');b.textContent=txt;if(alt)b.className='alt';b.onclick=()=>{$('actions').innerHTML='';fn()};$('actions').appendChild(b)}
async function finish(){
 const r=await serverCheck(90);
 if(r==='ok'){verdict('הצליח! המכשיר מחובר לשרת. אפשר לחזור למסך הניהול וללחוץ "בדוק חיבור".','ok');return}
 if(r==='wrong'){verdict('מכשיר אחר התחבר עם ההגדרות האלה — כנראה הוזנה כתובת IP של Shelly אחר. בדקו את הכתובת והריצו שוב.','bad');return}
 verdict('המכשיר עדיין לא התחבר לשרת. אם הטלפון עדיין על רשת המכשיר (ShellyPro2-...) — חזרו ל-Wi-Fi רגיל ולחצו "בדוק שוב" (הבדיקה מול השרת דורשת אינטרנט).<br><br><b>הבית על קו אינטרנט מסונן (נטפרי / אתרוג / רימון)?</b> ככל הנראה הסינון חוסם את החיבור המוצפן של המכשיר. בדיקה: העבירו זמנית את ה-Wi-Fi של המכשיר לנקודה חמה של טלפון — אם התחבר מיד, זו הסיבה. הפתרון: לבקש מספק הסינון להחריג את השרת 188.166.29.235 פורט 8883 (וגם את kosher-teltech.com), ואז המכשיר יתחבר מעצמו.<br><br>בדיקה ממחשב Windows על אותו קו — הדביקו ב-PowerShell:<br><code dir="ltr" style="display:block;background:#efe9df;border-radius:8px;padding:6px 8px;margin-top:4px;text-align:left">Test-NetConnection 188.166.29.235 -Port 8883</code>TcpTestSucceeded: False = הקו חוסם את הפורט. True = הפורט פתוח, אבל ייתכן עדיין יירוט הצפנה (המקרה הנפוץ בקווים מסוננים) — ולכן מבחן הנקודה החמה הוא הקובע.','warn');
 actionBtn('בדוק שוב מול השרת',async()=>{await finish()},true);
 if(sntpIdx<B.sntp.length-1){actionBtn('נסה שרת זמן אחר (בעיית שעון נפוצה)',async()=>{sntpIdx++;log('מגדיר שרת זמן חלופי ומאתחל...');await rpc(B.sntp[sntpIdx]);await rpc(B.reboot).catch(()=>{});await waitBack();await finish()},true)}
 actionBtn('נסה חיבור ללא אימות תעודה (עדיין מוצפן)',async()=>{log('מגדיר חיבור ללא אימות תעודה ומאתחל...');await rpc(B.noVerify);await rpc(B.reboot).catch(()=>{});await waitBack();const r2=await serverCheck(90);if(r2==='ok'){verdict('מחובר — אבל ללא אימות תעודה. דווחו על כך למנהל המערכת.','warn')}else{verdict('אין חיבור גם ללא אימות תעודה. צלמו מסך ודווחו.','bad')}},true);
}
$('go').onclick=async()=>{
 $('go').disabled=true;$('progress').classList.remove('hidden');$('log').innerHTML='';$('verdict').innerHTML='';$('actions').innerHTML='';
 if(PREPARE_URL){
  const mac=parseMac($('mac').value);
  if(mac.length!==12){verdict('קוד המכשיר לא תקין — הקלידו את שם הרשת המלא (ShellyPro2-...) או 12 תווים מהמדבקה.','bad');$('go').disabled=false;return}
  // Credentials already minted for this MAC on a previous press (e.g. before
  // switching to the device hotspot, which has no internet) — reuse, don't re-mint:
  // a re-mint would both fail offline AND rotate the password server-side.
  if(B&&mac===UID){log('פרטי החיבור כבר נוצרו קודם — ממשיך.','ok')}
  else{
   log('יוצר פרטי חיבור למכשיר בשרת... (דורש אינטרנט)');
   try{
    const r=await fetch(PREPARE_URL+'&mac='+mac,{cache:'no-store'});
    if(!r.ok){const e=await r.json().catch(()=>null);throw new Error((e&&e.error&&e.error.message)||('HTTP '+r.status))}
    const j=await r.json();UID=j.mac;B=j.bodies;STATUS_URL=j.status_url;$('uid').textContent=UID;
    log('פרטי חיבור נוצרו.','ok');
   }catch(e){verdict('יצירת פרטי החיבור נכשלה: '+e.message+' — שלב זה דורש אינטרנט. אם אתם על רשת ShellyPro2 (בלי אינטרנט) — עברו ל-Wi-Fi רגיל, לחצו שוב, וכשיופיע "פרטי חיבור נוצרו" חזרו לרשת המכשיר ולחצו שוב (הפרטים נשמרים). אם הקובץ ישן מ-30 יום — בקשו קובץ חדש.','bad');$('go').disabled=false;return}
  }
 }
 const manual=$('ip').value.trim();
 const candidates=manual?[manual]:['shellypro2-'+UID+'.local','192.168.33.1'];
 IP='';
 for(const c of candidates){log('מחפש את המכשיר בכתובת '+c+'...');if(await ping(c)){IP=c;break}}
 if(!IP){
  $('ip').classList.remove('hidden');
  verdict('המכשיר לא נמצא אוטומטית. אפשרויות: (1) התחברו לרשת שהמכשיר משדר (ShellyPro2-...) ולחצו שוב; (2) מצאו את כתובת ה-IP שלו באפליקציית Shelly (תחת Device Information) או ברשימת המכשירים בנתב, הזינו אותה בשדה שנפתח למעלה ולחצו שוב.','warn');
  $('go').disabled=false;return}
 log('המכשיר נמצא ('+IP+'). שולח הגדרות...','ok');
 try{
  log('מתקין תעודת שרת...');await rpc(B.putCa);
  log('מגדיר חיבור לשרת...');await rpc(B.mqtt);
  log('מגדיר שרת זמן...');await rpc(B.sntp[0]);
  log('מאתחל את המכשיר...');await rpc(B.reboot).catch(()=>{});
 }catch(e){verdict('שגיאה בשליחת ההגדרות: '+e.message+' — ודאו שנשארתם על אותו Wi-Fi ונסו שוב.','bad');$('go').disabled=false;return}
 if(!(await waitBack())){verdict('המכשיר לא חזר אחרי האתחול — בדקו חשמל וכתובת, ונסו שוב.','bad');$('go').disabled=false;return}
 log('המכשיר חזר לרשת.','ok');
 await finish();
 $('go').disabled=false;
};
</script></body></html>`;
}

// Validate + mint broker credentials for one device and return its RPC bodies.
// Shared by the admin onboard flow and the universal installer's prepare endpoint.
function mintDeviceCreds(mac) {
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
  return { uid, bodies: rpcBodies({ uid, password, ca }) };
}

// The phone page polls this public endpoint for its verdict; the token only grants
// "is device <uid> connected to the broker" for 48h — nothing else.
const statusUrlFor = (uid, statusBase) =>
  `${statusBase}/api/v1/shelly-onboard/status?token=${jwt.sign({ p: 'shelly-onboard', uid }, env.jwtSecret, { expiresIn: '48h' })}`;

export async function onboardShelly({ mac, statusBase = '' }) {
  const { appVersion } = await import('../config/version.js');
  const { uid, bodies } = mintDeviceCreds(mac);
  const stamp = `# script version ${appVersion.commit} — generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`;
  return {
    mac: uid,
    broker: `${env.deviceBroker.host}:${env.deviceBroker.port}`,
    version: appVersion.commit,
    script_ps: stamp + powershellScript(uid, bodies),
    // keep the shebang as line 1 — the stamp goes right after it
    script_sh: bashScript(uid, bodies).replace('\n', `\n${stamp}`),
    script_html: htmlPage(uid, bodies, statusUrlFor(uid, statusBase)),
  };
}

// Universal installer: one downloadable page valid INSTALLER_TTL for any device — the
// helper types the MAC and the page mints that device's credentials at install time.
// The embedded token is the authorization: whoever holds the file can create broker
// credentials (not app access) until it expires, so it's shared privately like the
// per-device scripts. adm (the generating admin) is carried into the audit log.
const INSTALLER_TTL = '30d';

export function universalInstaller({ statusBase, adminId }) {
  if (!env.deviceBroker.host) {
    throw errors.validation('חיבור מכשירים מרחוק אינו מוגדר בשרת זה (DEVICE_MQTT_HOST)');
  }
  const token = jwt.sign({ p: 'shelly-onboard-any', adm: adminId }, env.jwtSecret, { expiresIn: INSTALLER_TTL });
  const prepareUrl = `${statusBase}/api/v1/shelly-onboard/prepare?token=${token}`;
  return { script_html: htmlPage(null, null, null, prepareUrl), valid_days: 30 };
}

// Called by the public prepare endpoint once the installer token is verified.
export function prepareDevice({ mac, statusBase }) {
  const { uid, bodies } = mintDeviceCreds(mac);
  return {
    mac: uid,
    bodies: { putCa: bodies.putCa, mqtt: bodies.mqtt, noVerify: bodies.mqttNoVerify, reboot: bodies.reboot, sntp: bodies.sntp },
    status_url: statusUrlFor(uid, statusBase),
  };
}
