import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
try {
  for (const line of readFileSync(join(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN in your local .env file first.');
  process.exit(1);
}

let response;
try {
  response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(10000)
  });
} catch (error) {
  console.error('Could not reach Telegram:', error.name);
  process.exit(1);
}

let result;
try {
  result = await response.json();
} catch {
  console.error('Telegram returned an unexpected response.');
  process.exit(1);
}

if (!response.ok || !result.ok) {
  console.error('Telegram rejected the request. Check the bot token and try again.');
  process.exit(1);
}

const chats = new Map();
for (const update of result.result) {
  const chat = update.message?.chat || update.edited_message?.chat;
  if (chat) chats.set(String(chat.id), chat.type);
}

if (chats.size === 0) {
  console.log('No chats found. Open your bot, send it /start, then run this command again.');
} else {
  console.log('Chat IDs from recent bot updates:');
  for (const [chatId, type] of chats) console.log(`${chatId} (${type})`);
  console.log('Copy your private-chat ID to TELEGRAM_CHAT_ID in .env.');
}
