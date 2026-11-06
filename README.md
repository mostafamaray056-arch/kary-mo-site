# KARY..MO website

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
3. Open your Telegram bot and send it `/start`.
4. Run `node get-chat-id.js`, then put your private-chat ID in `TELEGRAM_CHAT_ID` in `.env`.
5. Start the server with `node server.js`.
6. Open `http://localhost:3000`.

Create the Telegram bot with BotFather. Keep `.env` private; it is excluded by `.gitignore`. Never put the bot token in `site/index.html` or send it in chat.

The site submits completed castle-sale forms to `/api/telegram/order`. The Node server sends the formatted message to Telegram. Deploy the site and server together behind HTTPS, and set the two Telegram environment variables in the hosting provider's secret settings.
