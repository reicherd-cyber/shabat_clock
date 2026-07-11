// Refresh the local dev database with a copy of PRODUCTION data.
//
//   npm run sync:proddb
//
// Path: SSH tunnel via the droplet (ISP CGNAT blocks direct DB access) → mysqldump
// runs inside the local shabat-mysql container against the tunnel → the dump replaces
// the local shabat_clock database wholesale. One-way by design: local experiments
// never touch production and are wiped by the next sync. The prod credentials are
// fetched from the droplet at runtime and never stored locally.
//
// After a sync the local DB is at prod's migration level — the next `npm run dev`
// boot applies any newer dev-branch migrations locally, as usual.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DROPLET = 'root@188.166.29.235';
const KEY = path.join(os.homedir(), '.ssh', 'digitalocean_key');
const LOCAL_PORT = 3307;
const CONTAINER = 'shabat-mysql';
const LOCAL_DB = 'shabat_clock';

console.log('Fetching production DB address from the droplet...');
const line = execFileSync('ssh', ['-i', KEY, DROPLET, "grep '^DATABASE_URL=' /opt/shabat_clock/.env"],
  { encoding: 'utf8' }).trim();
const u = new URL(line.slice('DATABASE_URL='.length));
const remotePort = u.port || '25060';

console.log(`Opening tunnel :${LOCAL_PORT} → ${u.hostname}:${remotePort} (via droplet)...`);
const tunnel = spawn('ssh', ['-i', KEY, '-N', '-o', 'ExitOnForwardFailure=yes',
  '-L', `0.0.0.0:${LOCAL_PORT}:${u.hostname}:${remotePort}`, DROPLET], { stdio: 'inherit' });

const docker = (args, opts = {}) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

try {
  await new Promise((r) => setTimeout(r, 3000));

  console.log('Dumping production database (this can take a moment)...');
  // host.docker.internal = the Windows host from inside the container; TLS is
  // mysqldump's default PREFERRED mode (DO requires TLS; identity is the SSH tunnel's job).
  const dump = docker(['exec', CONTAINER, 'mysqldump',
    '-h', 'host.docker.internal', '-P', String(LOCAL_PORT),
    '-u', u.username, `-p${decodeURIComponent(u.password)}`,
    '--single-transaction', '--set-gtid-purged=OFF', '--no-tablespaces', '--skip-lock-tables',
    u.pathname.slice(1)]);
  const dumpFile = path.join(os.tmpdir(), 'shabat-prod-dump.sql');
  fs.writeFileSync(dumpFile, dump);
  console.log(`Dump OK (${(dump.length / 1024).toFixed(0)} KB). Replacing local ${LOCAL_DB}...`);

  docker(['exec', CONTAINER, 'mysql', '-uroot', '-pdevpass', '-e',
    `DROP DATABASE IF EXISTS ${LOCAL_DB}; CREATE DATABASE ${LOCAL_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`]);
  docker(['exec', '-i', CONTAINER, 'mysql', '-uroot', '-pdevpass', LOCAL_DB],
    { input: fs.readFileSync(dumpFile) });
  fs.rmSync(dumpFile, { force: true });

  console.log('✔ Local DB now mirrors production. Restart the backend (or let --watch pick it up)');
  console.log('  so newer dev-branch migrations apply locally.');
} finally {
  tunnel.kill();
}
process.exit(0);
