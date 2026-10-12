// Chat with the WhatsApp bot from the terminal — no Meta account needed.
// Feeds typed lines to the same handler the webhook calls; with WHATSAPP_TOKEN
// blank the bot's replies are printed here instead of sent. Buttons are
// answered by typing כן / לא.
//
//   npm run db:tunnel            (dev uses the production DB)
//   node scripts/wa-chat.mjs 0501234567   ← a phone that is verified on an account
//
// Commands you confirm DO run on that account's real devices.
import 'dotenv/config';
import { createInterface } from 'node:readline';
import { pool } from '../src/db/pool.js';
import { handleInbound } from '../src/whatsapp/bot.js';

const phone = String(process.argv[2] || '').replace(/\D/g, '');
if (!/^0\d{8,9}$/.test(phone)) {
  console.error('usage: node scripts/wa-chat.mjs 05XXXXXXXX');
  process.exit(1);
}
if (process.env.WHATSAPP_TOKEN) {
  console.error('WHATSAPP_TOKEN is set — replies would really be sent. Unset it for the simulator.');
  process.exit(1);
}

const from = `972${phone.slice(1)}`;
console.log(`Simulating ${phone} → the bot. Type a message (שלום, מצב, כבה את הסלון, למה המכשיר מנותק?). Ctrl+C to quit.\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'אתה> ' });
rl.prompt();
rl.on('line', async (line) => {
  const text = line.trim();
  if (text) {
    await handleInbound({ waId: `sim.${Date.now()}`, from, name: 'סימולציה', type: 'text', text, buttonId: null, timestamp: Math.floor(Date.now() / 1000) });
  }
  rl.prompt();
});
rl.on('close', async () => { await pool.end(); process.exit(0); });
