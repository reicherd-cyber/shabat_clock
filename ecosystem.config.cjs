// PM2 — runs alongside ivr-collector (port 3000) on the same droplet (PLAN Decisions #1)
module.exports = {
  apps: [
    {
      name: 'shabat-clock',
      script: 'src/server.js',
      instances: 1, // in-memory IVR sessions + MQTT ack waiters require a single process [D16]
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production', PORT: 3001 },
    },
    {
      // Staging — the dev branch, deployed like production (dev.kosher-teltech.com → :3002).
      // Same DB by user decision; NODE_ENV=staging keeps the health monitor passive and
      // skips Shelly schedule pushes so two servers never act on one device fleet.
      name: 'shabat-clock-dev',
      cwd: '/opt/shabat_clock-dev',
      script: 'src/server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'staging', PORT: 3002 },
    },
  ],
};
