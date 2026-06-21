import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { log } from '../logger.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bar(cur, tgt) {
  const pct = tgt > 0 ? Math.min((cur || 0) / tgt, 1) : 0;
  const filled = Math.round(pct * 8);
  return '[' + '█'.repeat(filled) + '░'.repeat(8 - filled) + '] ' + Math.round(pct * 100) + '%';
}

// The Telegram "/" menu — registered via setMyCommands so commands autocomplete.
export const COMMAND_MENU = [
  ['status', 'Bot state overview'],
  ['balance', 'Gold, XP, stars, rank'],
  ['farm', 'Tile breakdown'],
  ['inventory', 'Seed counts'],
  ['basket', 'Harvested produce'],
  ['orders', 'Delivery orders'],
  ['jobs', 'Farm jobs progress'],
  ['quests', 'Starter tasks'],
  ['mastery', 'Crop mastery'],
  ['stats', 'Lifetime stats'],
  ['pool', 'Farmer pool ($FARM) status'],
  ['economy', 'Top crops by profit'],
  ['wallet', 'Wallet address'],
  ['start', 'Start the bot'],
  ['stop', 'Stop the bot'],
  ['pause', 'Pause autopilot'],
  ['resume', 'Resume autopilot'],
  ['autopilot', 'on|off'],
  ['objective', 'gold|xp|balanced'],
  ['setcrop', '<crop|auto>'],
  ['reserve', '<gold> auto-expand reserve'],
  ['sethours', '<HH:MM-HH:MM|24h>'],
  ['poolburn', 'on|off burn gold to pool'],
  ['harvest', 'Harvest ready tiles'],
  ['plant', '<crop> plant one'],
  ['plantall', '<crop> plant all empty'],
  ['buyplot', 'Buy next plot'],
  ['buyseed', '<crop> [qty]'],
  ['upgradestorage', 'Buy next storage tier'],
  ['claimpool', 'Manual pool claim'],
  ['reconnect', 'Force reconnect'],
  ['restart', 'Restart process'],
  ['log', '[n] recent log lines'],
  ['ping', 'Connectivity check'],
  ['help', 'List all commands'],
];

// Pure-ish command dispatcher — testable with a mock ctx + send. `send(text)` should
// accept an HTML string. Returns a promise. Never throws (errors are sent as messages).
export async function dispatchCommand(text, ctx, send) {
  const parts = (text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  const arg = args.join(' ');
  const s = ctx.state;

  try {
    switch (cmd) {
      case '/status': {
        const f = ctx.flags;
        return send(
          `📊 <b>Status</b>\n` +
          `${f.running ? '🟢 Running' : '🔴 Stopped'} | ${f.paused ? '⏸️ Paused' : '▶️ Active'} | Autopilot: ${f.autopilot ? 'ON' : 'OFF'} | Connected: ${f.connected ? '✅' : '❌'}\n` +
          `🎮 Level ${fmt(s.level)} • 💰 ${fmt(s.gold)} gold • ✨ ${fmt(s.xp)} XP • ⭐ ${fmt(s.stars)} stars\n` +
          `🎯 Objective: ${f.objective || 'balanced'}${f.forceCrop ? ` • forced: ${esc(f.forceCrop)}` : ''}\n` +
          `🏡 Owned: ${s.ownedTiles().length} • Ready: ${s.readyToHarvest().length}\n` +
          `📈 ${esc(ctx.stats())}`
        );
      }
      case '/balance':
        return send(
          `💰 <b>Balance</b>\n` +
          `Gold: ${fmt(s.gold)} • Stars: ${fmt(s.stars)}\n` +
          `XP: ${fmt(s.xp)} • Level: ${fmt(s.level)}\n` +
          `Farm Points: ${fmt(s.farmPoints)} • Farm Value: ${fmt(s.farmValue)}\n` +
          `Farm Rank: ${fmt(s.farmRank)}`
        );
      case '/farm': {
        const owned = s.ownedTiles().length, grass = s.grassEmpty().length, tilled = s.tilledEmpty().length;
        const ready = s.readyToHarvest().length, blocked = s.blocked().length;
        const planted = Math.max(0, owned - grass - tilled - ready - blocked);
        return send(`🌾 <b>Farm</b>\n🏡 Owned: ${owned}\n🟩 Grass: ${grass}\n🟫 Tilled: ${tilled}\n🌱 Growing: ${planted}\n✅ Ready: ${ready}\n🚫 Blocked: ${blocked}`);
      }
      case '/inventory':
      case '/seeds': {
        const lines = Object.entries(s.inventory || {}).filter(([, v]) => v > 0).map(([k, v]) => `  ${esc(k)}: ${fmt(v)}`);
        return send(`🎒 <b>Seeds</b>\n${lines.length ? lines.join('\n') : '  (empty)'}\n\n📦 ${fmt(s.seedCount())} / ${fmt(s.inventoryCapacity)} capacity`);
      }
      case '/basket':
      case '/produce': {
        const lines = Object.entries(s.cropInventory || {}).filter(([, v]) => v > 0).map(([k, v]) => `  ${esc(k)}: ${fmt(v)}`);
        return send(`🧺 <b>Harvest Basket</b>\n${lines.length ? lines.join('\n') : '  (empty)'}`);
      }
      case '/orders': {
        const orders = s.orders || [];
        if (!orders.length) return send('📦 <b>Orders</b>\nNone available.');
        const ok = new Set((s.completableOrders() || []).map(o => o.id));
        const lines = orders.map(o => {
          const reqs = Object.entries(o.requires || {}).map(([c, q]) => `${esc(c)}×${q}`).join(', ');
          const rw = [o.rewards?.gold && `💰${fmt(o.rewards.gold)}`, o.rewards?.xp && `✨${fmt(o.rewards.xp)}`].filter(Boolean).join(' ');
          return `• <b>${esc(o.title || o.id)}</b>${ok.has(o.id) ? ' ✅' : ''}\n  Need: ${reqs}\n  Reward: ${rw}`;
        });
        return send(`📦 <b>Orders</b>\n${lines.join('\n')}`);
      }
      case '/jobs': {
        const jobs = s.farmJobs || [];
        if (!jobs.length) return send('🔨 <b>Farm Jobs</b>\nNone available.');
        const ok = new Set((s.claimableJobs() || []).map(j => j.id));
        const lines = jobs.map(j => {
          const rw = [j.rewards?.gold && `💰${fmt(j.rewards.gold)}`, j.rewards?.xp && `✨${fmt(j.rewards.xp)}`].filter(Boolean).join(' ');
          return `• <b>${esc(j.title || j.id)}</b>${ok.has(j.id) ? ' ✅' : ''}\n  ${bar(j.current, j.target)} (${fmt(j.current)}/${fmt(j.target)})\n  Reward: ${rw}`;
        });
        return send(`🔨 <b>Farm Jobs</b>\n${lines.join('\n')}`);
      }
      case '/quests': {
        const st = s.starterTasks || {};
        return send(`📋 <b>Starter Tasks</b>\nCurrent: ${esc(st.currentTaskId ?? 'none')}\nCompleted: ${(st.completed || []).length}`);
      }
      case '/mastery': {
        const entries = Object.entries(s.cropMastery || {});
        if (!entries.length) return send('🏅 <b>Crop Mastery</b>\nNo mastery data yet.');
        const lines = entries.map(([crop, v]) => typeof v === 'number' ? `  ${esc(crop)}: Lv${v}` : `  ${esc(crop)}: Lv${v.level ?? 0} (${v.progress ?? 0}%)`);
        return send(`🏅 <b>Crop Mastery</b>\n${lines.join('\n')}`);
      }
      case '/stats':
        return send(`📈 <b>Stats</b>\n${esc(ctx.stats())}\nOrders done: ${fmt(s.completedOrdersCount)}\nJobs done: ${fmt(s.completedFarmJobsCount)}\nHarvested: ${fmt(s.totalHarvestedCrops)}`);
      case '/pool': {
        const p = await ctx.pool();
        if (!p) return send('🏊 <b>Farmer Pool</b>\nStatus unavailable (server slow / not logged in).');
        const pool = p.pool || {}, player = p.player || {}, cfg = p.config || {};
        const farmDay = Number(pool.totalTokensAllocatedRaw || 0) / 1e6;
        const payout = Number(player.estimatedPayoutRaw || 0) / 1e6;
        const unlocked = player.unlocked || (player.level || 0) >= (cfg.minLevel || 10);
        return send(
          `🏊 <b>Farmer Pool</b> ($${cfg.tokenSymbol || 'FARM'})\n` +
          `Status: <b>${esc(pool.status || 'unknown')}</b> • Date: ${esc(pool.poolDate || 'n/a')}\n` +
          `Pool/day: ${fmt(farmDay)} ${cfg.tokenSymbol || 'FARM'} • Participants: ${fmt(pool.activeParticipantCount)}\n` +
          `You: L${fmt(player.level)} • farm points ${fmt(player.availableFarmPoints)} • gold ${fmt(player.gold)}\n` +
          `Eligible: ${unlocked ? '✅ yes' : `🔒 needs L${cfg.minLevel || 10}`} • contributed today: ${player.hasContributionToday ? 'yes' : 'no'}\n` +
          `Est. payout: ${payout.toFixed(4)} ${cfg.tokenSymbol || 'FARM'}`
        );
      }
      case '/economy':
      case '/crops': {
        const sorted = Object.entries(ctx.economy || {}).sort((a, b) => (b[1].profitPerHour || 0) - (a[1].profitPerHour || 0)).slice(0, 8);
        if (!sorted.length) return send('🌿 <b>Economy</b>\nNo data.');
        const lines = sorted.map(([n, c]) => `• <b>${esc(n)}</b> L${c.unlockLevel} — cost ${fmt(c.cost)} / sell ${fmt(c.sell)} / ${c.growSeconds}s\n  💹 ${fmt(c.profitPerHour)}/hr • ✨ ${fmt(c.xpPerHour)}xp/hr`);
        return send(`🌿 <b>Top crops by profit/hr</b>\n${lines.join('\n')}`);
      }
      case '/wallet':
        return send(`👛 <b>Wallet</b>\n<code>${esc(ctx.walletAddress)}</code>`);

      case '/start': ctx.flags.running = true; ctx.flags.paused = false; return send('🚀 <b>Started</b>');
      case '/stop': ctx.flags.running = false; return send('🛑 <b>Stopped</b>');
      case '/pause': ctx.flags.paused = true; return send('⏸️ <b>Paused</b>');
      case '/resume': ctx.flags.paused = false; return send('▶️ <b>Resumed</b>');
      case '/autopilot': {
        const on = (args[0] || '').toLowerCase() !== 'off'; ctx.flags.autopilot = on;
        return send(`🤖 Autopilot <b>${on ? 'ON' : 'OFF'}</b>`);
      }
      case '/objective': {
        const v = (args[0] || '').toLowerCase();
        if (!['gold', 'xp', 'balanced'].includes(v)) return send('🎯 Usage: /objective gold|xp|balanced');
        return send(`🎯 ${esc(ctx.setConfig('objective', v))}`);
      }
      case '/setcrop': {
        const c = (args[0] || '').toLowerCase();
        if (!c) return send('🌱 Usage: /setcrop &lt;crop&gt; (or auto/off to clear)');
        const v = (c === 'auto' || c === 'off') ? null : c;
        ctx.setConfig('forceCrop', v);
        return send(`🌱 Force crop → <b>${esc(v ?? 'auto')}</b>`);
      }
      case '/reserve': {
        const n = Number(args[0]);
        if (!Number.isFinite(n)) return send('💰 Usage: /reserve &lt;gold&gt;');
        ctx.setConfig('goldReserve', n);
        return send(`💰 Gold reserve → <b>${fmt(n)}</b>`);
      }
      case '/sethours': {
        if (!args[0]) return send('🕐 Usage: /sethours &lt;HH:MM-HH:MM|24h&gt;');
        if (args[0] !== '24h' && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(args[0])) return send('🕐 Bad format. Use HH:MM-HH:MM or 24h');
        ctx.setConfig('activeHours', args[0]);
        return send(`🕐 Active hours → <b>${esc(args[0])}</b>`);
      }
      case '/poolburn': {
        const on = (args[0] || '').toLowerCase() === 'on';
        ctx.setConfig('poolBurnGold', on);
        return send(`🔥 Pool burn-gold → <b>${on ? 'ON' : 'OFF'}</b>`);
      }

      case '/harvest': ctx.manual('harvest'); return send('🌾 Harvest queued.');
      case '/plant':
        if (!args[0]) return send('🌱 Usage: /plant &lt;crop&gt;');
        ctx.manual('plant', args[0].toLowerCase()); return send(`🌱 Plant <b>${esc(args[0])}</b> queued.`);
      case '/plantall':
        if (!args[0]) return send('🌱 Usage: /plantall &lt;crop&gt;');
        ctx.manual('plantall', args[0].toLowerCase()); return send(`🌱 Plant all <b>${esc(args[0])}</b> queued.`);
      case '/buyplot': ctx.manual('buyplot'); return send('🏗️ Buy plot queued.');
      case '/buyseed': {
        if (!args[0]) return send('🌰 Usage: /buyseed &lt;crop&gt; [qty]');
        const qty = args[1] || '1';
        ctx.manual('buyseed', `${args[0].toLowerCase()} ${qty}`);
        return send(`🌰 Buy <b>${esc(qty)}× ${esc(args[0])}</b> queued.`);
      }
      case '/upgradestorage': ctx.manual('upgradestorage'); return send('📦 Upgrade storage queued.');
      case '/claimpool': {
        const r = await ctx.claimPool();
        if (!r) return send('🏊 Claim: no result.');
        if (r.contributed) return send('🏊 <b>Pool Claim</b>\n✅ Contributed claim power — earning $FARM.');
        return send(`🏊 <b>Pool Claim</b>\nℹ️ Not contributed${r.reason ? ` (${esc(r.reason)})` : ''}${r.pool ? ` • pool ${esc(r.pool)}` : ''}${r.level != null ? ` • L${r.level}` : ''}`);
      }
      case '/reconnect': ctx.manual('reconnect'); return send('🔌 Reconnect queued.');
      case '/restart': await send('🔄 Restart queued.'); ctx.manual('restart'); return;

      case '/log': {
        const n = Math.min(200, Math.max(1, Number(args[0]) || 20));
        let t = String(ctx.tailLog(n) || '(empty)');
        if (t.length > 3500) t = t.slice(-3500);
        return send(`📜 <b>Log (last ${n})</b>\n<pre>${esc(t)}</pre>`);
      }
      case '/ping': return send(`🏓 pong — connected: ${ctx.flags.connected ? '✅' : '❌'}`);
      case '/help':
        return send(
          `📖 <b>FarmTown Sentinel</b>\n\n` +
          `<b>INFO</b> /status /balance /farm /inventory /basket /orders /jobs /quests /mastery /stats /pool /economy /wallet\n\n` +
          `<b>CONTROL</b> /start /stop /pause /resume /autopilot /objective /setcrop /reserve /sethours /poolburn\n\n` +
          `<b>ACTIONS</b> /harvest /plant /plantall /buyplot /buyseed /upgradestorage /claimpool /reconnect /restart\n\n` +
          `<b>DIAG</b> /log /ping /help`
        );

      default:
        if (cmd.startsWith('/')) return send('❓ Unknown command. Try /help');
        return;
    }
  } catch (e) {
    log.warn('TG', `command error [${cmd}]: ${e.message}`);
    return send(`❌ Error: ${esc(e.message)}`);
  }
}

export function startTelegram(ctx) {
  if (!config.telegram.token) {
    log.warn('TG', 'no token — telegram disabled');
    return { notify() {} };
  }
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const chatId = config.telegram.chatId;
  const send = (m) => bot.sendMessage(chatId, m, { parse_mode: 'HTML' }).catch((e) => log.warn('TG', 'send failed: ' + e.message));
  const guard = (msg) => String(msg.chat.id) === String(chatId);

  bot.setMyCommands(COMMAND_MENU.map(([command, description]) => ({ command, description }))).catch(() => {});

  bot.on('message', (msg) => { if (guard(msg)) dispatchCommand(msg.text, ctx, send); });
  bot.on('polling_error', (e) => log.warn('TG', 'polling_error: ' + e.message));
  log.info('TG', 'telegram bot polling');

  return { notify: (m) => bot.sendMessage(chatId, m, { parse_mode: 'HTML' }).catch(() => {}) };
}
