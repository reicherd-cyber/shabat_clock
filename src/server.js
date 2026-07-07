import { env } from './config/env.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { connectMqtt } from './mqtt/client.js';
import { startScheduler } from './scheduler/tick.js';

const app = createApp();

migrate()
  .then(() => {
    connectMqtt();
    startScheduler();
    app.listen(env.port, () => console.log(`shabat-clock listening on :${env.port}`));
  })
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });
