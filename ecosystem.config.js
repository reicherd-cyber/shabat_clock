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
  ],
};
