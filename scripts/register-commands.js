// One-shot: register the Telegram "/" command menu + send a help message.
// Does NOT start the farm bot / polling. Run: node scripts/register-commands.js
import TelegramBot from 'node-telegram-bot-api';
import { config } from '../src/config.js';
import { COMMAND_MENU } from '../src/telegram/bot.js';

if (!config.telegram.token) { console.log('No TELEGRAM_BOT_TOKEN in .env'); process.exit(1); }
const bot = new TelegramBot(config.telegram.token, { polling: false });
await bot.setMyCommands(COMMAND_MENU.map(([command, description]) => ({ command, description })));
console.log('Registered', COMMAND_MENU.length, 'commands to the Telegram "/" menu.');
if (config.telegram.chatId) {
  const grouped =
    '🤖 <b>FarmTown Sentinel — Command Menu Registered</b>\n\n' +
    '<b>INFO</b> /status /balance /farm /inventory /basket /orders /jobs /quests /mastery /stats /pool /leaderboard /economy /wallet\n\n' +
    '<b>MULTI-ACCOUNT</b> /accounts /subacc /genwallets /mintsession /sweep\n' +
    '<b>STARS &amp; FUND</b> /starmain /starsub /sendfarm /sendfee /retrystar\n\n' +
    '<b>CONTROL</b> /start /stop /pause /resume /autopilot /objective /setcrop /reserve /sethours /poolburn\n\n' +
    '<b>ACTIONS</b> /harvest /plant /plantall /buyplot /buyseed /upgradestorage /claimpool /auth /reconnect /restart\n\n' +
    '<b>DIAG</b> /log /ping /help\n\n' +
    'Tip: type "/" in chat to see the autocomplete menu.';
  await bot.sendMessage(config.telegram.chatId, grouped, { parse_mode: 'HTML' });
  console.log('Sent command list to chat', config.telegram.chatId);
}
process.exit(0);
