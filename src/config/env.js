import dotenv from 'dotenv';

dotenv.config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'IVR_TOKEN'];

export function loadEnv() {
  const env = {
    port: Number(process.env.PORT || 3001),
    databaseUrl: process.env.DATABASE_URL,
    ivrToken: process.env.IVR_TOKEN,
    mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
    mqttServerUser: process.env.MQTT_SERVER_USER,
    mqttServerPass: process.env.MQTT_SERVER_PASS,
    jwtSecret: process.env.JWT_SECRET,
    nodeEnv: process.env.NODE_ENV || 'development',
  };

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length && env.nodeEnv === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // In production, reject weak/default secrets. These guard token signing and
  // the IVR entrypoint, so a short or placeholder value must fail closed.
  if (env.nodeEnv === 'production') {
    const weak = [
      ['JWT_SECRET', env.jwtSecret, 32],
      ['IVR_TOKEN', env.ivrToken, 16],
    ].filter(([, value, min]) => !value || value.length < min || /change-me/i.test(value));
    if (weak.length) {
      throw new Error(`Weak or default secrets (min length / no placeholder): ${weak.map(([key]) => key).join(', ')}`);
    }
  }

  return env;
}

export const env = loadEnv();
