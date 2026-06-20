import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { log } from '../logger.js';

export function startTelegram(ctx) {
  if (!config.telegram.token) { log.warn('TG', 'no token — telegram disabled'); return { notify() {} }; }
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const chat = config.telegram.chatId;
  const ok = (m) => bot.sendMessage(chat, m, { parse_mode: 'HTML' });
  const guard = (msg) => String(msg.chat.id) === String(chat);

  const cmds = {
    '/status': () => ok(`🟢 <b>FarmTown</b>\nrunning: ${ctx.flags.running}\npaused: ${ctx.flags.paused}\nautopilot: ${ctx.flags.autopilot}\nconnected: ${ctx.flags.connected}\nlevel ${ctx.state.level} • gold ${ctx.state.gold} • xp ${ctx.state.xp} • ⭐${ctx.state.stars}`),
    '/balance': () => ok(`💰 gold ${ctx.state.gold} • ⭐ stars ${ctx.state.stars} • xp ${ctx.state.xp} • lvl ${ctx.state.level}`),
    '/inventory': () => ok('🎒 ' + JSON.stringify(ctx.state.inventory)),
    '/farm': () => ok(`🌱 owned ${ctx.state.ownedTiles().length} • ready ${ctx.state.readyToHarvest().length} • tilled-empty ${ctx.state.tilledEmpty().length} • blocked ${ctx.state.blocked().length}`),
    '/stats': () => ok(ctx.stats()),
    '/quests': () => ok('📋 ' + JSON.stringify(ctx.state.quests)),
    '/jobs': () => ok('🔨 ' + JSON.stringify(ctx.state.jobs)),
    '/orders': () => ok('📦 ' + JSON.stringify(ctx.state.orders)),
    '/pause': () => { ctx.flags.paused = true; ok('⏸️ paused'); },
    '/resume': () => { ctx.flags.paused = false; ok('▶️ resumed'); },
    '/stop': () => { ctx.flags.running = false; ok('🛑 stopping'); },
    '/start': () => { ctx.flags.running = true; ctx.flags.paused = false; ok('🚀 started'); },
    '/harvest': () => { ctx.manual('harvest'); ok('harvesting…'); },
    '/sellall': () => { ctx.manual('sellall'); ok('selling…'); },
    '/buyplot': () => { ctx.manual('buyplot'); ok('buying plot…'); },
    '/log': () => ok('📜 ' + ctx.tailLog()),
    '/restart': () => { ok('🔄 restarting'); ctx.manual('restart'); },
    '/help': () => ok(Object.keys(cmds).join('  ') + '\n/plant <crop>  /setcrop <crop>  /autopilot on|off'),
  };

  bot.on('message', (msg) => {
    if (!guard(msg)) return;
    const [cmd, arg] = (msg.text || '').trim().split(/\s+/);
    if (cmd === '/plant') { ctx.manual('plant', arg); return ok('planting ' + arg); }
    if (cmd === '/setcrop') { ctx.flags.forceCrop = arg; return ok('crop set to ' + arg); }
    if (cmd === '/autopilot') { ctx.flags.autopilot = arg !== 'off'; return ok('autopilot ' + (ctx.flags.autopilot ? 'on' : 'off')); }
    const fn = cmds[cmd]; if (fn) fn(); else if (cmd?.startsWith('/')) ok('unknown command — /help');
  });
  bot.on('polling_error', (e) => log.warn('TG', 'polling_error ' + e.message));
  log.info('TG', 'telegram bot polling');
  return { notify: (m) => ok(m).catch(() => {}) };
}
