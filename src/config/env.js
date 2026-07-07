import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function parseDatabaseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  db: parseDatabaseUrl(required('DATABASE_URL')),
  ivrToken: required('IVR_TOKEN'),
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_SERVER_USER || '',
    password: process.env.MQTT_SERVER_PASS || '',
  },
  jwtSecret: required('JWT_SECRET'),
  otpYemot: {
    user: process.env.OTP_YEMOT_USER || '',
    pass: process.env.OTP_YEMOT_PASS || '',
  },
  mosquittoPasswdFile: process.env.MOSQUITTO_PASSWD_FILE || '',
};
