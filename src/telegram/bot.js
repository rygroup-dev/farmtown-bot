import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { log } from '../logger.js';

const fmt = (n) => Number(n).toLocaleString('en-US');

function bar(cur, tgt) {
  const pct = tgt > 0 ? Math.min(cur / tgt, 1) : 0;
  const filled = Math.round(pct * 8);
  return '[' + '█'.repeat(filled) + '░'.repeat(8 - filled) + '] ' + Math.round(pct * 100) + '%';
}

export function startTelegram(ctx) {
  if (!config.telegram.token) {
    log.warn('TG', 'no token — telegram disabled');
    return { notify() {} };
  }

  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const chatId = config.telegram.chatId;

  const send = (m) => bot.sendMessage(chatId, m, { parse_mode: 'HTML' }).catch(() => {});
  const guard = (msg) => String(msg.chat.id) === String(chatId);

  bot.on('message', async (msg) => {
    if (!guard(msg)) return;
    const [cmd, ...args] = (msg.text || '').trim().split(/\s+/);
    const arg = args.join(' ');

    try {
      switch (cmd) {

        // ── INFO ──────────────────────────────────────────

        case '/status': {
          const s = ctx.state;
          const f = ctx.flags;
          const statsLine = ctx.stats();
          send(
            `📊 <b>Status</b>\n` +
            `${f.running ? '🟢 Running' : '🔴 Stopped'} | ${f.paused ? '⏸️ Paused' : '▶️ Active'} | Autopilot: ${f.autopilot ? 'ON' : 'OFF'} | Connected: ${f.connected ? '✅' : '❌'}\n` +
            `🎮 Level ${fmt(s.level)} • 💰 ${fmt(s.gold)} gold • ✨ ${fmt(s.xp)} XP • ⭐ ${fmt(s.stars)} stars\n` +
            `🎯 Objective: ${f.objective || 'balanced'}\n` +
            `🏡 Owned tiles: ${s.ownedTiles().length} • Ready: ${s.readyToHarvest().length}\n` +
            `📈 ${statsLine}`
          );
          break;
        }

        case '/balance': {
          const s = ctx.state;
          send(
            `💰 <b>Balance</b>\n` +
            `Gold: ${fmt(s.gold)} • Stars: ${fmt(s.stars)}\n` +
            `XP: ${fmt(s.xp)} • Level: ${fmt(s.level)}\n` +
            `Farm Points: ${fmt(s.farmPoints)} • Farm Value: ${fmt(s.farmValue)}\n` +
            `Farm Rank: ${fmt(s.farmRank)}`
          );
          break;
        }

        case '/farm': {
          const s = ctx.state;
          const owned = s.ownedTiles().length;
          const grass = s.grassEmpty().length;
          const tilled = s.tilledEmpty().length;
          const ready = s.readyToHarvest().length;
          const blocked = s.blocked().length;
          const planted = owned - grass - tilled - ready - blocked;
          send(
            `🌾 <b>Farm</b>\n` +
            `🏡 Owned: ${owned}\n` +
            `🟩 Grass (empty): ${grass}\n` +
            `🟫 Tilled (empty): ${tilled}\n` +
            `🌱 Planted: ${planted}\n` +
            `✅ Ready to harvest: ${ready}\n` +
            `🚫 Blocked: ${blocked}`
          );
          break;
        }

        case '/inventory':
        case '/seeds': {
          const s = ctx.state;
          const inv = s.inventory || {};
          const lines = Object.entries(inv)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `  ${k}: ${fmt(v)}`);
          send(
            `🎒 <b>Seeds Inventory</b>\n` +
            (lines.length ? lines.join('\n') : '  (empty)') +
            `\n\n📦 ${fmt(s.seedCount())} / ${fmt(s.inventoryCapacity)} capacity`
          );
          break;
        }

        case '/basket':
        case '/produce': {
          const ci = ctx.state.cropInventory || {};
          const lines = Object.entries(ci)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `  ${k}: ${fmt(v)}`);
          send(
            `🧺 <b>Harvest Basket</b>\n` +
            (lines.length ? lines.join('\n') : '  (empty)')
          );
          break;
        }

        case '/orders': {
          const orders = ctx.state.orders || [];
          const completable = new Set((ctx.state.completableOrders() || []).map(o => o.id));
          if (!orders.length) { send('📦 <b>Orders</b>\nNo orders available.'); break; }
          const lines = orders.map(o => {
            const reqs = Object.entries(o.requires || {}).map(([c, q]) => `${c}×${q}`).join(', ');
            const rw = [];
            if (o.rewards?.gold) rw.push(`💰${fmt(o.rewards.gold)}`);
            if (o.rewards?.xp) rw.push(`✨${fmt(o.rewards.xp)}`);
            const check = completable.has(o.id) ? ' ✅' : '';
            return `• <b>${o.title}</b>${check}\n  Need: ${reqs}\n  Reward: ${rw.join(' ')}`;
          });
          send(`📦 <b>Orders</b>\n${lines.join('\n')}`);
          break;
        }

        case '/jobs': {
          const jobs = ctx.state.farmJobs || [];
          const claimable = new Set((ctx.state.claimableJobs() || []).map(j => j.id));
          if (!jobs.length) { send('🔨 <b>Farm Jobs</b>\nNo jobs available.'); break; }
          const lines = jobs.map(j => {
            const rw = [];
            if (j.rewards?.gold) rw.push(`💰${fmt(j.rewards.gold)}`);
            if (j.rewards?.xp) rw.push(`✨${fmt(j.rewards.xp)}`);
            const check = claimable.has(j.id) ? ' ✅' : '';
            return `• <b>${j.title}</b>${check}\n  ${bar(j.current, j.target)} (${fmt(j.current)}/${fmt(j.target)})\n  Reward: ${rw.join(' ')}`;
          });
          send(`🔨 <b>Farm Jobs</b>\n${lines.join('\n')}`);
          break;
        }

        case '/quests': {
          const st = ctx.state.starterTasks || {};
          send(
            `📋 <b>Starter Tasks</b>\n` +
            `Current task: ${st.currentTaskId ?? 'none'}\n` +
            `Completed: ${(st.completed || []).length}`
          );
          break;
        }

        case '/mastery': {
          const cm = ctx.state.cropMastery || {};
          const entries = Object.entries(cm);
          if (!entries.length) { send('🏅 <b>Crop Mastery</b>\nNo mastery data yet.'); break; }
          const lines = entries.map(([crop, val]) => {
            if (typeof val === 'number') return `  ${crop}: level ${val}`;
            return `  ${crop}: Lv${val.level} (${val.progress ?? 0}%)`;
          });
          send(`🏅 <b>Crop Mastery</b>\n${lines.join('\n')}`);
          break;
        }

        case '/stats': {
          const s = ctx.state;
          send(
            `📈 <b>Stats</b>\n` +
            `${ctx.stats()}\n` +
            `Completed orders: ${fmt(s.completedOrdersCount)}\n` +
            `Completed jobs: ${fmt(s.completedFarmJobsCount)}\n` +
            `Total harvested: ${fmt(s.totalHarvestedCrops)}`
          );
          break;
        }

        case '/pool': {
          try {
            const p = await ctx.pool();
            if (!p) { send('🏊 <b>Pool</b>\nPool status unavailable.'); break; }
            const pool = p.pool || {};
            const player = p.player || {};
            const cfg = p.config || {};
            send(
              `🏊 <b>Farmer Pool</b>\n` +
              `Status: ${pool.status || cfg.status || 'unknown'}\n` +
              `Date: ${pool.date || 'n/a'}\n` +
              `FARM/day: ${fmt(pool.farmPerDay || 0)}\n` +
              `Player level: ${fmt(player.level || 0)}\n` +
              `Available farm points: ${fmt(player.availableFarmPoints || 0)}\n` +
              `Claim power: ${player.claimPowerEligible ? '✅ Unlocked' : '🔒 Needs L10'}\n` +
              `Estimated payout: ${fmt(player.estimatedPayout || 0)}`
            );
          } catch (e) {
            send(`🏊 <b>Pool</b>\n❌ Error: ${e.message}`);
          }
          break;
        }

        case '/economy':
        case '/crops': {
          const eco = ctx.economy || {};
          const sorted = Object.entries(eco)
            .sort((a, b) => (b[1].profitPerHour || 0) - (a[1].profitPerHour || 0))
            .slice(0, 8);
          if (!sorted.length) { send('🌿 <b>Economy</b>\nNo crop data.'); break; }
          const lines = sorted.map(([name, c]) =>
            `• <b>${name}</b> Lv${c.unlockLevel}\n  Cost: ${fmt(c.cost)} • Sell: ${fmt(c.sell)} • Grow: ${c.growSeconds}s\n  💹 ${fmt(c.profitPerHour)}/hr • ✨ ${fmt(c.xpPerHour)} xp/hr`
          );
          send(`🌿 <b>Economy — Top 8 by profit/hr</b>\n${lines.join('\n')}`);
          break;
        }

        case '/wallet': {
          send(`👛 <b>Wallet</b>\n<code>${ctx.walletAddress}</code>`);
          break;
        }

        // ── CONTROL ───────────────────────────────────────

        case '/start': {
          ctx.flags.running = true;
          ctx.flags.paused = false;
          send('🚀 <b>Started</b> — bot is running.');
          break;
        }

        case '/stop': {
          ctx.flags.running = false;
          send('🛑 <b>Stopped</b> — bot halted.');
          break;
        }

        case '/pause': {
          ctx.flags.paused = true;
          send('⏸️ <b>Paused</b>');
          break;
        }

        case '/resume': {
          ctx.flags.paused = false;
          send('▶️ <b>Resumed</b>');
          break;
        }

        case '/autopilot': {
          const on = arg.toLowerCase() !== 'off';
          ctx.flags.autopilot = on;
          send(`🤖 Autopilot <b>${on ? 'ON' : 'OFF'}</b>`);
          break;
        }

        case '/objective': {
          const val = (args[0] || '').toLowerCase();
          if (!['gold', 'xp', 'balanced'].includes(val)) {
            send('🎯 Usage: /objective gold|xp|balanced');
            break;
          }
          const res = ctx.setConfig('objective', val);
          send(`🎯 Objective → <b>${val}</b>\n${res}`);
          break;
        }

        case '/setcrop': {
          const crop = (args[0] || '').toLowerCase();
          if (!crop) { send('🌱 Usage: /setcrop <crop> (or auto/off to clear)'); break; }
          const val = (crop === 'auto' || crop === 'off') ? null : crop;
          const res = ctx.setConfig('forceCrop', val);
          send(`🌱 Force crop → <b>${val ?? 'auto'}</b>\n${res}`);
          break;
        }

        case '/reserve': {
          const n = Number(args[0]);
          if (isNaN(n)) { send('💰 Usage: /reserve <gold>'); break; }
          const res = ctx.setConfig('goldReserve', n);
          send(`💰 Gold reserve → <b>${fmt(n)}</b>\n${res}`);
          break;
        }

        case '/sethours': {
          if (!args[0]) { send('🕐 Usage: /sethours <HH:MM-HH:MM|24h>'); break; }
          const res = ctx.setConfig('activeHours', args[0]);
          send(`🕐 Active hours → <b>${args[0]}</b>\n${res}`);
          break;
        }

        case '/poolburn': {
          const on = (args[0] || '').toLowerCase() === 'on';
          const res = ctx.setConfig('poolBurnGold', on);
          send(`🔥 Pool burn gold → <b>${on ? 'ON' : 'OFF'}</b>\n${res}`);
          break;
        }

        // ── MANUAL ACTIONS ────────────────────────────────

        case '/harvest': {
          ctx.manual('harvest');
          send('🌾 Harvesting queued.');
          break;
        }

        case '/plant': {
          if (!args[0]) { send('🌱 Usage: /plant <crop>'); break; }
          ctx.manual('plant', args[0]);
          send(`🌱 Planting <b>${args[0]}</b> queued.`);
          break;
        }

        case '/plantall': {
          if (!args[0]) { send('🌱 Usage: /plantall <crop>'); break; }
          ctx.manual('plantall', args[0]);
          send(`🌱 Planting all <b>${args[0]}</b> queued.`);
          break;
        }

        case '/buyplot': {
          ctx.manual('buyplot');
          send('🏗️ Buy plot queued.');
          break;
        }

        case '/buyseed': {
          if (!args[0]) { send('🌰 Usage: /buyseed <crop> [qty]'); break; }
          const crop = args[0];
          const qty = args[1] || '1';
          ctx.manual('buyseed', `${crop} ${qty}`);
          send(`🌰 Buying <b>${qty}x ${crop}</b> seed queued.`);
          break;
        }

        case '/upgradestorage': {
          ctx.manual('upgradestorage');
          send('📦 Upgrade storage queued.');
          break;
        }

        case '/claimpool': {
          try {
            const result = await ctx.claimPool();
            if (!result) { send('🏊 Claim pool: no result returned.'); break; }
            send(
              `🏊 <b>Pool Claim</b>\n` +
              `${result.ok ? '✅ Success' : '❌ Failed'}\n` +
              `Contributed: ${fmt(result.contributed || 0)}`
            );
          } catch (e) {
            send(`🏊 Pool claim error: ${e.message}`);
          }
          break;
        }

        case '/reconnect': {
          ctx.manual('reconnect');
          send('🔌 Reconnect queued.');
          break;
        }

        case '/restart': {
          send('🔄 Restart queued.');
          ctx.manual('restart');
          break;
        }

        // ── DIAGNOSTICS ───────────────────────────────────

        case '/log': {
          const n = Number(args[0]) || 20;
          let logText = ctx.tailLog(n);
          if (logText.length > 3500) logText = logText.slice(-3500);
          send(`📜 <b>Log (last ${n})</b>\n<pre>${logText}</pre>`);
          break;
        }

        case '/ping': {
          send(`🏓 pong — connected: ${ctx.flags.connected}`);
          break;
        }

        case '/help': {
          send(
            `📖 <b>FarmTown Sentinel — Commands</b>\n\n` +
            `<b>INFO</b>\n` +
            `/status — bot state overview\n` +
            `/balance — gold, xp, stars, rank\n` +
            `/farm — tile breakdown\n` +
            `/inventory — seed counts\n` +
            `/basket — harvested produce\n` +
            `/orders — delivery orders\n` +
            `/jobs — farm jobs progress\n` +
            `/quests — starter tasks\n` +
            `/mastery — crop mastery\n` +
            `/stats — lifetime stats\n` +
            `/pool — farmer pool status\n` +
            `/economy — top crops by profit\n` +
            `/wallet — wallet address\n\n` +
            `<b>CONTROL</b>\n` +
            `/start /stop /pause /resume\n` +
            `/autopilot on|off\n` +
            `/objective gold|xp|balanced\n` +
            `/setcrop &lt;crop|auto|off&gt;\n` +
            `/reserve &lt;gold&gt;\n` +
            `/sethours &lt;HH:MM-HH:MM|24h&gt;\n` +
            `/poolburn on|off\n\n` +
            `<b>ACTIONS</b>\n` +
            `/harvest — harvest ready tiles\n` +
            `/plant &lt;crop&gt; — plant one\n` +
            `/plantall &lt;crop&gt; — plant all empty\n` +
            `/buyplot — buy next plot\n` +
            `/buyseed &lt;crop&gt; [qty]\n` +
            `/upgradestorage\n` +
            `/claimpool — manual pool claim\n` +
            `/reconnect /restart\n\n` +
            `<b>DIAG</b>\n` +
            `/log [n] — recent log lines\n` +
            `/ping — connectivity check\n` +
            `/help — this message`
          );
          break;
        }

        default: {
          if (cmd?.startsWith('/')) send('❓ Unknown command. Try /help');
          break;
        }
      }
    } catch (e) {
      log.warn('TG', `command error [${cmd}]: ${e.message}`);
      send(`❌ Error: ${e.message}`).catch(() => {});
    }
  });

  bot.on('polling_error', (e) => log.warn('TG', 'polling_error: ' + e.message));
  log.info('TG', 'telegram bot polling');

  return { notify: (m) => bot.sendMessage(chatId, m, { parse_mode: 'HTML' }).catch(() => {}) };
}
