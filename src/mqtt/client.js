import mqtt from 'mqtt';
import { env } from '../config/env.js';

let client;
const ackWaiters = new Map();

export function getMqttClient() {
  if (!client) {
    client = mqtt.connect(env.mqttUrl, {
      username: env.mqttServerUser,
      password: env.mqttServerPass,
    });
    client.on('message', handleMessage);
    client.on('connect', () => client.subscribe('dev/+/ack'));
  }
  return client;
}

function handleMessage(topic, payload) {
  if (!topic.endsWith('/ack')) return;
  try {
    const ack = JSON.parse(payload.toString('utf8'));
    const waiter = ackWaiters.get(Number(ack.cmd_id));
    if (!waiter) return;
    ackWaiters.delete(Number(ack.cmd_id));
    waiter.resolve(ack);
  } catch (err) {
    console.error('Invalid MQTT ack payload', err);
  }
}

export async function publishCommand({ uid, cmd_id, relay, action }, timeoutMs = 5000) {
  const mqttClient = getMqttClient();
  const payload = JSON.stringify({ cmd_id, relay, action });
  await new Promise((resolve, reject) => mqttClient.publish(`dev/${uid}/cmd`, payload, { qos: 1 }, (err) => (err ? reject(err) : resolve())));

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(cmd_id);
      resolve(null);
    }, timeoutMs);
    ackWaiters.set(cmd_id, {
      resolve: (ack) => {
        clearTimeout(timer);
        resolve(ack);
      },
    });
  });
}
