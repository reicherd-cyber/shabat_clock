// SSH tunnel to the production (DigitalOcean managed) MySQL, via the droplet.
// The local machine cannot reach the DB directly (source-IP filtering), but the
// droplet is whitelisted by resource name — so we forward a local port through it.
//
// Dev and production intentionally share the SAME database: every change made
// locally is a production change.
//
// Usage: npm run db:tunnel   (keep it running; Ctrl+C to close)
// Config comes from .env:
//   DB_TUNNEL_SSH        e.g. root@188.166.29.235
//   DB_TUNNEL_KEY        e.g. C:\Users\me\.ssh\digitalocean_key
//   DB_TUNNEL_REMOTE     e.g. db-mysql-xxx.ondigitalocean.com:25060
//   DB_TUNNEL_LOCAL_PORT e.g. 3307
import 'dotenv/config';
import { spawn } from 'node:child_process';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
  return v;
};

const sshTarget = need('DB_TUNNEL_SSH');
const key = need('DB_TUNNEL_KEY');
const remote = need('DB_TUNNEL_REMOTE');
const localPort = process.env.DB_TUNNEL_LOCAL_PORT || '3307';

console.log(`Tunneling localhost:${localPort} -> ${remote} via ${sshTarget}`);
console.log('DEV USES THE PRODUCTION DB. Keep this window open while developing. Ctrl+C to close.');

const ssh = spawn(
  'ssh',
  [
    '-N',
    '-i', key,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `${localPort}:${remote}`,
    sshTarget,
  ],
  { stdio: 'inherit' }
);

ssh.on('exit', (code) => process.exit(code ?? 0));
