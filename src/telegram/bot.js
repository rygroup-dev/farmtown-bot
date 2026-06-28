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
  ['leaderboard', 'Pool/top farmers rank'],
  ['economy', 'Top crops by profit'],
  ['wallet', 'Wallet address'],
  ['accounts', 'All accounts + balances'],
  ['genwallets', '<n> generate sub-wallets'],
  ['mintsession', 'Test captcha auto-login'],
  ['sweep', 'Send all sub $FARM → main'],
  ['starmain', '<bundle> buy stars for main'],
  ['starsub', '<bundle> buy stars all subs'],
  ['sendfarm', '<amount> send FARM to all subs'],
  ['sendfee', '<SOL> send SOL gas to all subs'],
  ['subacc', 'Sub account details'],
  ['retrystar', 'Retry pending star purchases'],
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
  ['auth', 'Paste fresh Supabase session to re-login'],
  ['reconnect', 'Force reconnect'],
  ['restart', 'Restart process'],
  ['log', '[n] recent log lines'],
  ['ping', 'Connectivity check'],
  ['help', 'List all commands'],
];

const LEADERBOARD_CATEGORIES = {
  farmRank: 'Farm Rank',
  farmValue: 'Farm Value',
  ordersCompleted: 'Orders',
  jobsClaimed: 'Jobs',
  landOwned: 'Land',
  cropMastery: 'Mastery',
  starfruitHarvests: 'Starfruit',
};

function rankLabel(n) {
  return n ? `#${fmt(n)}` : '#?';
}

function poolParticipantLine(p, rank, label = null) {
  const name = esc(label || p.displayName || p.playerName || p.name || 'Farmer');
  const power = p.claimPower ?? p.contributedClaimPowerToday ?? 0;
  const payoutRaw = p.estimatedPayoutRaw ?? 0;
  const payout = Number(payoutRaw || 0) / 1e6;
  const share = p.estimatedShareBps != null ? ` • ${(Number(p.estimatedShareBps || 0) / 100).toFixed(2)}%` : '';
  return `${p.isCurrentPlayer ? '⭐' : '•'} <b>${rankLabel(rank)}</b> ${name} — ⚡${fmt(power)} power • 💰${payout.toFixed(2)} FARM${share}`;
}

function topFarmerValue(category, entry) {
  const value = entry.leaderboardValue ?? entry[category] ?? entry.farmRank ?? 0;
  if (category === 'ordersCompleted') return `${fmt(value)} orders`;
  if (category === 'jobsClaimed') return `${fmt(value)} jobs`;
  if (category === 'landOwned') return `${fmt(value)} tiles`;
  if (category === 'starfruitHarvests') return `${fmt(value)} starfruit`;
  return fmt(value);
}

function topFarmerLine(category, entry, rank, label = null) {
  const name = esc(label || entry.playerName || 'Farmer');
  const you = label ? ` <i>(${esc(entry.playerName || entry.farmSlug || 'matched')})</i>` : '';
  return `${label ? '⭐' : '•'} <b>${rankLabel(rank)}</b> ${name}${you} — ${topFarmerValue(category, entry)} • L${fmt(entry.level)} • ${fmt(entry.ownedPlots)} plots`;
}

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
        const fStars = s.claimableFallingStars?.() || [];
        return send(
          `📊 <b>Status</b>\n` +
          `${f.running ? '🟢 Running' : '🔴 Stopped'} | ${f.paused ? '⏸️ Paused' : '▶️ Active'} | Autopilot: ${f.autopilot ? 'ON' : 'OFF'} | Connected: ${f.connected ? '✅' : '❌'}\n` +
          `🎮 Level ${fmt(s.level)} • 💰 ${fmt(s.gold)} gold • ✨ ${fmt(s.xp)} XP • ⭐ ${fmt(s.stars)} stars\n` +
          `🎯 Objective: ${f.objective || 'balanced'}${f.forceCrop ? ` • forced: ${esc(f.forceCrop)}` : ''}\n` +
          `🏡 Owned: ${s.ownedTiles().length} • Ready: ${s.readyToHarvest().length}${fStars.length ? ` • 🌟 Falling stars: ${fStars.length}` : ''}\n` +
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
        const ready = s.readyToHarvest().length, blocked = s.blocked().length, dead = s.deadCrops().length;
        const planted = Math.max(0, owned - grass - tilled - ready - blocked - dead);
        // Animal / barn section
        const barnEntries = Object.entries(s.barns || {});
        let animalSection = '';
        if (barnEntries.length) {
          const now = Date.now();
          const ANIM = { cow: { produceId: 'milk', feedCropId: 'wheat', feedAmount: 25, productionIntervalMs: 10800000 } };
          const barnLines = barnEntries.map(([barnId, barn]) => {
            const slots = barn.slots || [];
            const feed = barn.feed || {};
            const slotLines = slots.map((animalId, i) => {
              if (!animalId) return `    Slot ${i + 1}: empty`;
              const cfg = ANIM[animalId];
              const lastFed = feed[String(i)];
              let stateLabel;
              if (lastFed == null) stateLabel = '🍽️ hungry';
              else if (now >= lastFed + (cfg?.productionIntervalMs || 0)) stateLabel = '✅ ready to collect';
              else {
                const left = Math.ceil(((lastFed + (cfg?.productionIntervalMs || 0)) - now) / 60000);
                stateLabel = `⏳ producing (${left}m left)`;
              }
              return `    Slot ${i + 1}: ${animalId} — ${stateLabel}`;
            });
            return `  🏚️ Barn <code>${esc(barnId.slice(0, 8))}</code>\n${slotLines.join('\n')}`;
          });
          const resourceLines = Object.entries(s.resourceInventory || {}).filter(([, v]) => v > 0)
            .map(([k, v]) => `${esc(k)}: ${fmt(v)}`).join(', ');
          animalSection = `\n\n🐄 <b>Animals</b>\n${barnLines.join('\n')}` +
            (resourceLines ? `\n  🥛 Produce: ${resourceLines}` : '');
        } else {
          const SMALL_BARN_COST = 4_000_000;
          const pct = Math.min(100, Math.round(s.gold / SMALL_BARN_COST * 100));
          animalSection = `\n\n🐄 <b>Animals</b>: no barn yet\n  💰 Saving: ${fmt(s.gold)} / ${fmt(SMALL_BARN_COST)} gold ${bar(s.gold, SMALL_BARN_COST)}`;
        }
        return send(`🌾 <b>Farm</b>\n🏡 Owned: ${owned}\n🟩 Grass: ${grass}\n🟫 Tilled: ${tilled}\n🌱 Growing: ${planted}\n✅ Ready: ${ready}\n💀 Dead: ${dead}\n🚫 Blocked: ${blocked}${animalSection}`);
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
          const prod = Object.entries(o.requiresProduce || {}).map(([p, q]) => `🥛${esc(p)}×${q}`).join(', ');
          const needStr = [reqs, prod].filter(Boolean).join(', ');
          const rw = [o.rewards?.gold && `💰${fmt(o.rewards.gold)}`, o.rewards?.xp && `✨${fmt(o.rewards.xp)}`].filter(Boolean).join(' ');
          return `• <b>${esc(o.title || o.id)}</b>${ok.has(o.id) ? ' ✅' : ''}\n  Need: ${needStr}\n  Reward: ${rw}`;
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
        // Mastery is per-crop, harvest-count based. Live shape: { harvested, masteryLevel }.
        // Game thresholds → masteryLevel 0-5 (max = 3000 harvests of one crop).
        const TH = [0, 25, 100, 300, 1000, 3000];
        const info = (v) => {
          if (typeof v === 'number') return { lvl: v, harv: null };
          const harv = v.harvested ?? 0;
          const lvl = v.masteryLevel ?? TH.reduce((a, t, i) => (harv >= t ? i : a), 0);
          const next = TH[lvl + 1];
          const pct = next ? Math.floor(((harv - TH[lvl]) / (next - TH[lvl])) * 100) : 100;
          return { lvl, harv, next, pct };
        };
        const entries = Object.entries(s.cropMastery || {}).map(([crop, v]) => [crop, info(v)]);
        if (!entries.length) return send('🏅 <b>Crop Mastery</b>\nNo mastery data yet.');
        const lines = entries
          .sort((a, b) => b[1].lvl - a[1].lvl || (b[1].harv ?? 0) - (a[1].harv ?? 0))
          .map(([crop, m]) => m.harv == null
            ? `  ${esc(crop)}: Lv${m.lvl}`
            : `  ${esc(crop)}: Lv${m.lvl} ${m.next ? `(${m.harv}/${m.next}, ${m.pct}%)` : `(MAX • ${m.harv} harvested)`}`);
        return send(`🏅 <b>Crop Mastery</b> <i>(max Lv5 = 3000 harvests; no yield bonus, rank only)</i>\n${lines.join('\n')}`);
      }
      case '/stats':
        return send(`📈 <b>Stats</b>\n${esc(ctx.stats())}\nOrders done: ${fmt(s.completedOrdersCount)}\nJobs done: ${fmt(s.completedFarmJobsCount)}\nHarvested: ${fmt(s.totalHarvestedCrops)}`);
      case '/pool': {
        const p = await ctx.pool();
        if (!p) return send('🏊 <b>Farmer Pool</b>\nStatus unavailable (server slow / not logged in).');
        const pool = p.pool || {}, player = p.player || {}, cfg = p.config || {}, eb = p.earlyBird || {};
        const sym = cfg.tokenSymbol || 'FARM';
        const px = Number(p.tokenUsdPrice || 0);
        const farmDay = Number(pool.totalTokensAllocatedRaw || 0) / 1e6;
        const payout = Number(player.estimatedPayoutRaw || 0) / 1e6;
        const unlocked = player.unlocked || (player.level || 0) >= (cfg.minLevel || 30);
        const starGate = player.meetsStarGate !== false;
        const perPower = pool.totalClaimPower > 0 ? farmDay / pool.totalClaimPower : 0;
        const usd = (farm) => px > 0 ? ` (~$${(farm * px).toFixed(2)})` : '';
        const fpPower = Math.floor((player.availableFarmPoints || 0) / (cfg.farmPointsPerPower || 100));
        const lvlBurn = player.burnableLevels || 0;
        const minAfter = cfg.minLevelAfterBurn || 30;
        const eligLine = !unlocked ? `🔒 needs L${cfg.minLevel || 30}` : !starGate ? `🔒 needs ${player.minStarsToEnter || 3}⭐ (collect falling stars or /starmain)` : '✅ eligible';

        const now = Date.now();
        const opensAt = pool.opensAt ? Date.parse(pool.opensAt) : null;
        const closesAt = pool.closesAt ? Date.parse(pool.closesAt) : null;
        const ebEndsAt = eb.endsAt ? Date.parse(eb.endsAt) : null;
        const hms = (ms) => { const h = Math.floor(ms/3600000); const m = Math.floor((ms%3600000)/60000); return `${h}h${m}m`; };
        let timingLine = '';
        if (opensAt && opensAt > now) timingLine = `⏱️ Opens in <b>${hms(opensAt - now)}</b> (${new Date(opensAt).toUTCString()})`;
        else if (opensAt && closesAt && now < closesAt) {
          timingLine = `⏱️ <b>OPEN</b> — closes in ${hms(closesAt - now)}`;
          if (ebEndsAt && now < ebEndsAt) timingLine += ` • 🐦 Early bird +10% for ${hms(ebEndsAt - now)}`;
        } else if (closesAt && now >= closesAt) timingLine = '⏱️ Pool closed';

        const cropInv = s.cropInventory || {};
        const sacLine = (cropInv.starfruit || 0) + (cropInv.crystal_berry || 0) > 0
          ? `\n🌾 Sacrifice crops: starfruit ×${fmt(cropInv.starfruit || 0)} (2 pwr ea) • crystal berry ×${fmt(cropInv.crystal_berry || 0)} (1 pwr ea) <i>(REST not yet enabled)</i>`
          : '';

        // Fleet-wide pool power: poll each running account's pool status
        let fleetLine = '';
        if (ctx.registry?.size > 1) {
          let totalPower = player.contributedClaimPowerToday || 0;
          let totalPayout = payout;
          let totalFp = player.availableFarmPoints || 0;
          const accLines = [`  ⭐ <b>main</b>: ⚡${fmt(player.contributedClaimPowerToday || 0)} power • 💰${payout.toFixed(2)} ${sym}`];
          const { pollFarmerPool: pollSub } = await import('../game/farmerpool.js');
          for (const [lbl, eng] of ctx.registry) {
            if (eng.isMain) continue;
            try {
              const sp = await pollSub(eng.rest);
              const sp2 = sp?.player || {};
              const subPow = sp2.contributedClaimPowerToday || 0;
              const subPay = Number(sp2.estimatedPayoutRaw || 0) / 1e6;
              totalPower += subPow; totalPayout += subPay; totalFp += (sp2.availableFarmPoints || 0);
              accLines.push(`  • <b>${esc(lbl)}</b>: ⚡${fmt(subPow)} power • 💰${subPay.toFixed(2)} ${sym}${sp2.meetsStarGate === false ? ' 🔒star' : ''}`);
            } catch {}
          }
          fleetLine = `\n\n🏭 <b>Fleet Power</b> (${ctx.registry.size} accounts)\n` +
            accLines.join('\n') +
            `\n\n📊 <b>Fleet Total</b>: ⚡${fmt(totalPower)} power • 💰${totalPayout.toFixed(2)} ${sym}${usd(totalPayout)} • FP: ${fmt(totalFp)}`;
        }

        return send(
          `🏊 <b>Farmer Pool</b> ($${sym})\n` +
          `Status: <b>${esc(pool.status || 'unknown')}</b> • Enabled: ${cfg.enabled ? '✅' : '❌'} • Date: ${esc(pool.poolDate || 'n/a')}\n` +
          (timingLine ? timingLine + '\n' : '') +
          `Pool: ${fmt(farmDay)} ${sym}${usd(farmDay)} • Farmers: ${fmt(pool.activeParticipantCount)}\n` +
          `Price: $${px ? px.toFixed(6) : '?'} • Value/power: ${perPower.toFixed(2)} ${sym}${usd(perPower)}\n` +
          `\n<b>You (main)</b> — L${fmt(player.level)} • ${eligLine}\n` +
          `Farm points: ${fmt(player.availableFarmPoints)} (= ${fpPower} power ready, free)\n` +
          `Sacrifice: ${lvlBurn} levels burnable (floor L${minAfter}) • Stars: ${player.starsPurchasedThisEvent || 0}/${player.minStarsToEnter || 3}⭐` +
          sacLine + '\n' +
          `Power today: ${fmt(player.contributedClaimPowerToday)} • Multiplier: ${player.powerMultiplier || 1}x\n` +
          `Est. payout: ${payout.toFixed(2)} ${sym}${usd(payout)} • FARM held: ${fmt(player.farmHeld || 0)} (need ${fmt(player.minFarmToHold || 0)})\n` +
          `Hold gate: ${player.meetsHoldGate ? '✅' : '❌'} • Star gate: ${player.meetsStarGate ? '✅' : '❌'}` +
          fleetLine +
          `\n\n<i>Strategy: auto-burns farm points every ~${eb.active ? '5' : '10'} min. Gold burn: /poolburn on. Level sacrifice: burn ${lvlBurn} levels (L${player.level}→L${minAfter}). Stars: collect falling stars (free!) or /starmain starter.</i>`
        );
      }
      case '/leaderboard': {
        const mode = (args[0] || 'pool').toLowerCase();
        const topMode = Object.keys(LEADERBOARD_CATEGORIES).find(c => c.toLowerCase() === mode);

        if (mode === 'pool' || mode === 'farmpool' || mode === 'farmerpool') {
          const p = await ctx.pool();
          if (!p) return send('🏆 <b>Farmer Pool Leaderboard</b>\nStatus unavailable (server slow / not logged in).');
          const participants = Array.isArray(p.participants) ? p.participants : [];
          const cfg = p.config || {};
          const pool = p.pool || {};
          const top = participants.slice(0, 10);
          const lines = top.length
            ? top.map((row, i) => poolParticipantLine(row, i + 1))
            : ['No sacrifices recorded yet / server did not return participants.'];

          const ours = [];
          const mainIdx = participants.findIndex(row => row.isCurrentPlayer);
          if (mainIdx >= 0) ours.push(poolParticipantLine(participants[mainIdx], mainIdx + 1, 'main'));
          else {
            const player = p.player || {};
            ours.push(`⭐ <b>main</b> — rank not in current participant list • ⚡${fmt(player.contributedClaimPowerToday || 0)} power • 💰${(Number(player.estimatedPayoutRaw || 0) / 1e6).toFixed(2)} FARM`);
          }

          if (ctx.registry?.size > 1) {
            const { pollFarmerPool: pollSub } = await import('../game/farmerpool.js');
            for (const [lbl, eng] of ctx.registry) {
              if (eng.isMain) continue;
              try {
                const sp = await pollSub(eng.rest);
                const subParts = Array.isArray(sp?.participants) ? sp.participants : [];
                const idx = subParts.findIndex(row => row.isCurrentPlayer);
                if (idx >= 0) ours.push(poolParticipantLine(subParts[idx], idx + 1, lbl));
                else {
                  const pl = sp?.player || {};
                  ours.push(`⭐ <b>${esc(lbl)}</b> — rank not in current participant list • ⚡${fmt(pl.contributedClaimPowerToday || 0)} power • 💰${(Number(pl.estimatedPayoutRaw || 0) / 1e6).toFixed(2)} FARM${pl.meetsStarGate === false ? ' 🔒star' : ''}${pl.meetsHoldGate === false ? ' 🔒hold' : ''}`);
                }
              } catch {
                ours.push(`⚠️ <b>${esc(lbl)}</b> — pool status unreachable`);
              }
            }
          }

          return send(
            `🏆 <b>Farmer Pool Leaderboard</b>\n` +
            `Status: <b>${esc(pool.status || 'unknown')}</b> • Date: ${esc(pool.poolDate || 'n/a')} • Token: ${esc(cfg.tokenSymbol || 'FARM')}\n\n` +
            `<b>Top Participants</b>\n${lines.join('\n')}\n\n` +
            `<b>Our Accounts</b>\n${ours.join('\n')}\n\n` +
            `<i>Tip: /leaderboard farmRank, farmValue, ordersCompleted, jobsClaimed, landOwned, cropMastery, starfruitHarvests</i>`
          );
        }

        if (!topMode) {
          return send('🏆 Usage: <code>/leaderboard</code> for Farmer Pool, or <code>/leaderboard farmRank|farmValue|ordersCompleted|jobsClaimed|landOwned|cropMastery|starfruitHarvests</code>');
        }
        if (!ctx.leaderboard) return send('🏆 Top Farmers leaderboard not available in this build.');

        const data = await ctx.leaderboard(topMode, 20);
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        if (!entries.length) return send(`🏆 <b>${esc(LEADERBOARD_CATEGORIES[topMode])}</b>\nNo leaderboard data (server slow / unavailable).`);

        const topLines = entries.slice(0, 10).map((entry, i) => topFarmerLine(topMode, entry, i + 1));
        const ours = [];
        if (ctx.registry?.size) {
          for (const [lbl, eng] of ctx.registry) {
            const idx = entries.findIndex(entry => entry.playerId && eng.playerId && entry.playerId === eng.playerId);
            if (idx >= 0) ours.push(topFarmerLine(topMode, entries[idx], idx + 1, lbl));
            else ours.push(`⭐ <b>${esc(lbl)}</b> — not in top ${entries.length} returned by server${eng.state?.farmRank != null ? ` • farm rank score ${fmt(eng.state.farmRank)}` : ''}`);
          }
        }

        return send(
          `🏆 <b>Top Farmers — ${esc(LEADERBOARD_CATEGORIES[topMode])}</b>\n` +
          `${topLines.join('\n')}\n` +
          (ours.length ? `\n<b>Our Accounts</b>\n${ours.join('\n')}\n` : '') +
          `\n<i>Source: /api/leaderboard category=${esc(topMode)}. Server returns rank window, so accounts outside that window are shown as not in top ${entries.length}.</i>`
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

      case '/accounts': {
        if (!ctx.accountsInfo) return send('👥 Multi-account not available in this build.');
        await send('👥 Fetching on-chain balances + pool power…');
        const list = await ctx.accountsInfo();
        const max = (ctx.maxSubWallets || 1000) + 1;
        const { pollFarmerPool: pollAcc } = await import('../game/farmerpool.js');
        let totPower = 0, totPayout = 0;
        const lines = [];
        for (const a of list) {
          const live = a.running ? ` | ${a.connected ? '🟢' : '🔴'} L${fmt(a.level)} ${fmt(a.gold)}g` : '';
          let poolStr = '';
          if (a.running && ctx.registry) {
            const eng = ctx.registry.get(a.label);
            if (eng?.rest) {
              try {
                const sp = await pollAcc(eng.rest);
                const sp2 = sp?.player || {};
                const pow = sp2.contributedClaimPowerToday || 0;
                const pay = Number(sp2.estimatedPayoutRaw || 0) / 1e6;
                totPower += pow; totPayout += pay;
                poolStr = ` • ⚡${fmt(pow)}`;
              } catch {}
            }
          }
          lines.push(`${a.isMain ? '⭐' : '•'} <b>${esc(a.label)}</b> <code>${esc(a.address.slice(0, 4) + '…' + a.address.slice(-4))}</code> — ◎${(a.sol || 0).toFixed(3)} • 🌾${fmt(Math.floor(a.farm || 0))}${poolStr}${live}`);
        }
        const totFarm = list.reduce((s2, a) => s2 + (a.farm || 0), 0);
        const totSol = list.reduce((s2, a) => s2 + (a.sol || 0), 0);
        return send(
          `👥 <b>Accounts ${list.length}/${max}</b>\n${lines.join('\n')}\n\n` +
          `Total: ◎${totSol.toFixed(3)} SOL • 🌾${fmt(Math.floor(totFarm))} $FARM\n` +
          `⚡ <b>Fleet Pool</b>: ${fmt(totPower)} power • 💰${totPayout.toFixed(2)} FARM payout`
        );
      }
      case '/subacc': {
        if (!ctx.registry) return send('👥 Multi-account not available.');
        const subs = [...ctx.registry.values()].filter(e => !e.isMain);
        if (!subs.length) return send('👥 No sub accounts running.');
        await send('👥 Fetching sub account details…');
        const { pollFarmerPool: pollSub } = await import('../game/farmerpool.js');
        const lines = [];
        let totOwned = 0, totStars = 0, totFarm = 0, totGold = 0, totPower = 0, totPayout = 0;
        const ANIM_CFG = { cow: { productionIntervalMs: 10800000 } };
        for (const e of subs) {
          const st = e.state;
          const owned = st?.ownedTiles?.()?.length ?? 0;
          const ready = st?.readyToHarvest?.()?.length ?? 0;
          const fStars = st?.claimableFallingStars?.()?.length ?? 0;
          let farmBal = 0;
          try { const info = await (await import('../game/wallet_info.js')).getWalletInfo(e.keypair); farmBal = info.farm || 0; } catch {}
          let poolPow = 0, poolPay = 0, poolGate = '';
          try {
            const sp = await pollSub(e.rest);
            const sp2 = sp?.player || {};
            poolPow = sp2.contributedClaimPowerToday || 0;
            poolPay = Number(sp2.estimatedPayoutRaw || 0) / 1e6;
            if (sp2.meetsStarGate === false) poolGate = ' 🔒star';
            else if (sp2.meetsHoldGate === false) poolGate = ' 🔒hold';
          } catch {}
          // Animal summary for this sub
          const barnEntries = Object.entries(st?.barns || {});
          let animalLine = '';
          if (barnEntries.length) {
            const now = Date.now();
            let hungry = 0, collecting = 0, producing = 0, totalAnimals = 0;
            for (const [, barn] of barnEntries) {
              for (let i = 0; i < (barn.slots || []).length; i++) {
                const animalId = barn.slots[i];
                if (!animalId) continue;
                totalAnimals++;
                const lastFed = (barn.feed || {})[String(i)];
                const interval = ANIM_CFG[animalId]?.productionIntervalMs || 10800000;
                if (lastFed == null) hungry++;
                else if (now >= lastFed + interval) collecting++;
                else producing++;
              }
            }
            const milk = st?.resourceInventory?.milk || 0;
            animalLine = `\n  🐄 ${totalAnimals} animal(s) in ${barnEntries.length} barn(s)` +
              (hungry ? ` • 🍽️ ${hungry} hungry` : '') +
              (collecting ? ` • ✅ ${collecting} ready` : '') +
              (producing ? ` • ⏳ ${producing} producing` : '') +
              (milk ? ` • 🥛 ${fmt(milk)} milk` : '');
          } else if (st?.level >= 30) {
            const BARN_COST = 4_000_000;
            const g = st?.gold || 0;
            animalLine = `\n  🐄 No barn — saving ${fmt(g)}/${fmt(BARN_COST)}g (${Math.min(100, Math.round(g / BARN_COST * 100))}%)`;
          }
          totOwned += owned; totStars += (st?.stars ?? 0); totFarm += farmBal; totGold += (st?.gold ?? 0);
          totPower += poolPow; totPayout += poolPay;
          lines.push(
            `• <b>${esc(e.label)}</b> ${e.flags?.connected ? '🟢' : '🔴'} <code>${esc(e.addr?.slice(0, 4) + '…' + e.addr?.slice(-4))}</code>\n` +
            `  L${fmt(st?.level)} • 💰${fmt(st?.gold)}g • ⭐${fmt(st?.stars)} stars • 🌾${fmt(Math.floor(farmBal))} $FARM\n` +
            `  🏡 Plots: ${owned} • ✅ Ready: ${ready}${fStars ? ` • 🌟 Stars: ${fStars}` : ''}${animalLine}\n` +
            `  ⚡ Pool power: ${fmt(poolPow)} • 💰 Payout: ${poolPay.toFixed(2)} FARM${poolGate}`
          );
        }
        return send(
          `👥 <b>Sub Accounts (${subs.length})</b>\n${lines.join('\n')}\n\n` +
          `📊 <b>Sub Total</b>: ${totOwned} plots • ${totStars}⭐ • 💰${fmt(totGold)}g • 🌾${fmt(Math.floor(totFarm))} $FARM\n` +
          `⚡ <b>Sub Pool Total</b>: ${fmt(totPower)} power • 💰${totPayout.toFixed(2)} FARM payout`
        );
      }
      case '/mintsession': {
        if (!ctx.testMint) return send('🧩 Not available in this build.');
        await send('🧩 Solving Turnstile + minting a test session…');
        const r = await ctx.testMint();
        return send(r.ok
          ? `🧩 ✅ Captcha + mint OK — fresh anonymous session valid ~${r.expMin ?? '?'} min.\nMulti-account auto-sessions will work. Enable with MULTI_ACCOUNT=on.`
          : `🧩 ❌ Mint failed: ${esc(r.reason)}\nCheck CAPTCHA_API_KEY / balance.`);
      }
      case '/genwallets': {
        if (!ctx.genWallets) return send('🔑 Multi-account not available in this build.');
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n < 1) return send(`🔑 Usage: <code>/genwallets &lt;n&gt;</code> — create n sub-wallets (max ${ctx.maxSubWallets || 1000} total subs).`);
        const r = ctx.genWallets(n);
        return send(`🔑 Generated <b>${r.added}</b> sub-wallet(s) (total ${r.total}/${ctx.maxSubWallets || 1000}${r.room === 0 ? ', cap reached' : ''}).\nFund each with a little SOL for gas, then /accounts to view. Sub-wallets earn $FARM and you /sweep it to your main wallet.`);
      }
      case '/sweep': {
        if (!ctx.sweepAll) return send('🧹 Multi-account not available in this build.');
        await send('🧹 Sweeping $FARM from all sub-wallets → main…');
        const res = await ctx.sweepAll();
        if (!res.length) return send('🧹 No sub-wallets yet — /genwallets first.');
        const ok = res.filter(r => r.ok);
        const sent = ok.reduce((s, r) => s + (r.amount || 0), 0);
        const lines = res.map(r => `${r.ok ? '✅' : '⚠️'} ${esc(r.label)}: ${r.ok ? fmt(r.amount) + ' FARM' : esc(r.reason || 'skip')}`);
        return send(`🧹 <b>Sweep done</b> — ${ok.length}/${res.length} sent, ${fmt(sent)} $FARM → main.\n${lines.join('\n')}`);
      }

      case '/starmain': {
        if (!ctx.buyStarsMain) return send('⭐ Not available.');
        const bundle = (args[0] || '').toLowerCase();
        const valid = ['starter', 'small', 'medium', 'large', 'degen'];
        if (!valid.includes(bundle)) return send(`⭐ Usage: <code>/starmain ${valid.join('|')}</code>\n\nBundles:\n• starter — 3⭐ (~$5)\n• small — 20⭐ (~$20)\n• medium — 65⭐ (~$50)\n• large — 160⭐ (~$100)\n• degen — 425⭐ (~$250)`);
        await send(`⭐ Buying <b>${esc(bundle)}</b> stars for <b>main</b>…`);
        const r = await ctx.buyStarsMain(bundle);
        if (r.ok) return send(`⭐ ✅ <b>Main</b>: bought ${r.stars}⭐ — spent ${fmt(Math.floor(r.farmSpent))} FARM\nTx: <code>${esc(r.sig?.slice(0, 20))}…</code>`);
        return send(`⭐ ❌ <b>Main</b> failed: ${esc(r.reason)}`);
      }
      case '/starsub': {
        if (!ctx.buyStarsSub) return send('⭐ Not available.');
        const bundle = (args[0] || '').toLowerCase();
        const valid = ['starter', 'small', 'medium', 'large', 'degen'];
        if (!valid.includes(bundle)) return send(`⭐ Usage: <code>/starsub ${valid.join('|')}</code>\n\nBundles:\n• starter — 3⭐ (~$5)\n• small — 20⭐ (~$20)\n• medium — 65⭐ (~$50)\n• large — 160⭐ (~$100)\n• degen — 425⭐ (~$250)`);
        await send(`⭐ Buying <b>${esc(bundle)}</b> stars for <b>all subs</b>… this may take a while.`);
        const results = await ctx.buyStarsSub(bundle);
        if (!results.length) return send('⭐ No sub accounts running.');
        const ok = results.filter(r => r.ok);
        const fail = results.filter(r => !r.ok);
        const totalFarm = ok.reduce((s, r) => s + (r.farmSpent || 0), 0);
        let msg = `⭐ <b>Stars bought for subs</b>\n✅ ${ok.length} OK • ❌ ${fail.length} failed • 🌾 ${fmt(Math.floor(totalFarm))} FARM spent\n`;
        if (fail.length && fail.length <= 10) msg += '\nFailed:\n' + fail.map(r => `• ${esc(r.label)}: ${esc(r.reason)}`).join('\n');
        else if (fail.length > 10) msg += `\nFirst failures: ${fail.slice(0, 5).map(r => `${esc(r.label)}: ${esc(r.reason)}`).join(', ')}…`;
        return send(msg);
      }
      case '/sendfarm': {
        if (!ctx.sendFarmToSubs) return send('🌾 Not available.');
        const amount = Number(args[0]);
        if (!Number.isFinite(amount) || amount <= 0) return send('🌾 Usage: <code>/sendfarm &lt;amount&gt;</code> — send FARM from main to each sub.\nExample: /sendfarm 2000');
        await send(`🌾 Sending <b>${fmt(amount)}</b> FARM to each sub…`);
        const results = await ctx.sendFarmToSubs(amount);
        if (!results.length) return send('🌾 No sub wallets.');
        const ok = results.filter(r => r.ok);
        const fail = results.filter(r => !r.ok);
        const total = ok.length * amount;
        let msg = `🌾 <b>FARM distribution</b>\n✅ ${ok.length} sent • ❌ ${fail.length} failed • Total: ${fmt(total)} FARM\n`;
        if (fail.length && fail.length <= 10) msg += '\nFailed:\n' + fail.map(r => `• ${esc(r.label)}: ${esc(r.reason)}`).join('\n');
        else if (fail.length > 10) msg += `\n${fail.length} failed (check /log)`;
        return send(msg);
      }
      case '/sendfee': {
        if (!ctx.sendSolToSubs) return send('◎ Not available.');
        const sol = Number(args[0]);
        if (!Number.isFinite(sol) || sol <= 0) return send('◎ Usage: <code>/sendfee &lt;SOL&gt;</code> — send SOL from main to each sub for gas.\nExample: /sendfee 0.002');
        const lamports = Math.floor(sol * 1e9);
        await send(`◎ Sending <b>${sol}</b> SOL to each sub…`);
        const results = await ctx.sendSolToSubs(lamports);
        if (!results.length) return send('◎ No sub wallets.');
        const ok = results.filter(r => r.ok);
        const fail = results.filter(r => !r.ok);
        const total = ok.length * sol;
        let msg = `◎ <b>SOL gas distribution</b>\n✅ ${ok.length} sent • ❌ ${fail.length} failed • Total: ${total.toFixed(4)} SOL\n`;
        if (fail.length && fail.length <= 10) msg += '\nFailed:\n' + fail.map(r => `• ${esc(r.label)}: ${esc(r.reason)}`).join('\n');
        else if (fail.length > 10) msg += `\n${fail.length} failed (check /log)`;
        return send(msg);
      }

      case '/retrystar': {
        if (!ctx.retryStars) return send('⭐ Not available.');
        await send('⭐ Retrying pending star confirmations…');
        const results = await ctx.retryStars();
        if (!results.length) return send('⭐ No pending star purchases to retry.');
        const ok = results.filter(r => r.ok);
        const fail = results.filter(r => !r.ok);
        let msg = `⭐ <b>Retry results</b>\n✅ ${ok.length} confirmed • ❌ ${fail.length} still pending\n`;
        for (const r of results) msg += `\n${r.ok ? '✅' : '❌'} ${esc(r.wallet?.slice(0,8))}… ${r.ok ? r.stars + '⭐ credited' : esc(r.reason || 'failed')}`;
        return send(msg);
      }

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
      case '/auth': {
        // Everything after "/auth " is the pasted token (use the untrimmed remainder so
        // a JSON paste survives intact). Token is a secret — only the guarded chat reaches here.
        const raw = (text || '').replace(/^\s*\/auth(@\S+)?\s*/i, '');
        if (!raw.trim()) return send(
          '🔐 <b>Re-login — get your token in 3 steps</b>\n\n' +
          '1️⃣ Open the game in your browser → press <b>F12</b> → <b>Console</b> tab.\n' +
          '2️⃣ Paste &amp; run this (it copies the session straight to your clipboard):\n' +
          '<code>copy(localStorage.getItem(Object.keys(localStorage).find(k=&gt;k.includes(\'auth-token\'))))</code>\n' +
          '3️⃣ Back here, type <code>/auth </code> then paste (Ctrl/Cmd+V) and send.'
        );
        if (!ctx.setAuth) return send('🔐 ❌ Re-login not supported in this build.');
        const r = ctx.setAuth(raw);
        if (!r?.ok) return send(`🔐 ❌ Couldn't read that token: ${esc(r?.reason || 'parse failed')}. Paste the full <code>sb-…-auth-token</code> value.`);
        return send(`🔐 ✅ <b>New session loaded — re-logging in now.</b>\nAccess token valid ~${r.expMin ?? '?'} min${r.hasRefresh ? ' • refresh token saved (auto-renews) 🔁' : ' • ⚠️ no refresh token included → will need another /auth at expiry'}.\nWatch for 🟢/✅ when it joins.`);
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
          `<b>INFO</b> /status /balance /farm /inventory /basket /orders /jobs /quests /mastery /stats /pool /leaderboard /economy /wallet\n\n` +
          `<b>MULTI-ACCOUNT</b> /accounts /subacc /genwallets /mintsession /sweep\n` +
          `<b>STARS &amp; FUND</b> /starmain /starsub /sendfarm /sendfee /retrystar\n\n` +
          `<b>CONTROL</b> /start /stop /pause /resume /autopilot /objective /setcrop /reserve /sethours /poolburn\n\n` +
          `<b>ACTIONS</b> /harvest /plant /plantall /buyplot /buyseed /upgradestorage /claimpool /auth /reconnect /restart\n\n` +
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

// /wallet panel with inline deposit/withdraw buttons. Returns { text, reply_markup }.
export async function renderWallet(ctx) {
  let info = { address: ctx.walletAddress, sol: 0, farm: 0 };
  try { if (ctx.walletInfo) info = await ctx.walletInfo(); } catch { /* RPC may fail */ }
  const text =
    `👛 <b>Wallet</b>\n` +
    `<code>${esc(info.address)}</code>\n\n` +
    `◎ SOL: <b>${(info.sol || 0).toFixed(4)}</b>\n` +
    `🌾 $FARM: <b>${fmt(Math.floor(info.farm || 0))}</b>\n` +
    `⭐ Stars (in-game): <b>${fmt(ctx.state.stars)}</b>\n\n` +
    `<i>Withdraw = claim/move earned $FARM to your wallet.\nDeposit = buy Stars with $FARM (in-game premium).</i>`;
  const rows = [
    [{ text: '💎 Claim Pool $FARM', callback_data: 'wallet:claim' }],
    [{ text: '📤 Withdraw $FARM', callback_data: 'wallet:withdraw' }, { text: '⭐ Deposit (Buy Stars)', callback_data: 'wallet:deposit' }],
    [{ text: '🔄 Refresh', callback_data: 'wallet:refresh' }],
  ];
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Handle a wallet:* inline-button press. Returns { text, reply_markup?, alert? }.
export async function handleWalletCallback(data, ctx) {
  switch (data) {
    case 'wallet:refresh':
      return renderWallet(ctx);
    case 'wallet:claim': {
      const r = await ctx.claimPool();
      const alert = r?.contributed ? '✅ Claimed claim power — earning $FARM' : `ℹ️ ${r?.reason || 'not eligible / pool not open'}`;
      const w = await renderWallet(ctx);
      return { ...w, alert };
    }
    case 'wallet:withdraw': {
      if (!ctx.withdrawAddress) return { text: '📤 <b>Withdraw</b>\n❌ No WITHDRAW_ADDRESS set in .env. Add your main wallet address there to enable withdrawals.', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'wallet:refresh' }]] } };
      return { text: `📤 <b>Withdraw $FARM</b>\nSend ALL $FARM from the bot wallet to:\n<code>${esc(ctx.withdrawAddress)}</code>\n\nConfirm?`, reply_markup: { inline_keyboard: [[{ text: '✅ Confirm withdraw', callback_data: 'wallet:withdraw_confirm' }], [{ text: '⬅️ Cancel', callback_data: 'wallet:refresh' }]] } };
    }
    case 'wallet:withdraw_confirm': {
      const r = await ctx.withdraw();
      const w = await renderWallet(ctx);
      if (r?.ok) return { ...w, alert: `✅ Withdrew ${r.amount} FARM` };
      return { ...w, alert: `❌ ${r?.reason || 'withdraw failed'}` };
    }
    case 'wallet:deposit': {
      let bundles = [];
      try { bundles = (await ctx.starBundles?.()) || []; } catch {}
      const lines = bundles.map(b => `• <b>${esc(b.displayName)}</b> — ${fmt(b.totalStars)}⭐ (~$${b.targetUsdValue})`).join('\n');
      return {
        text: `⭐ <b>Deposit — Buy Stars</b>\n${lines || 'No bundles.'}\n\n<i>Stars are bought with $FARM in-game (sends $FARM to the treasury). Auto-purchase is disabled for safety — buy from the website to avoid accidental spend.</i>`,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'wallet:refresh' }]] },
      };
    }
    default:
      return { text: '❓ Unknown action', reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'wallet:refresh' }]] } };
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

  bot.on('message', async (msg) => {
    if (!guard(msg)) return;
    const cmd = (msg.text || '').trim().split(/\s+/)[0].toLowerCase();
    if (cmd === '/wallet') {
      const w = await renderWallet(ctx);
      bot.sendMessage(chatId, w.text, { parse_mode: 'HTML', reply_markup: w.reply_markup }).catch((e) => log.warn('TG', 'send failed: ' + e.message));
      return;
    }
    dispatchCommand(msg.text, ctx, send);
  });

  bot.on('callback_query', async (q) => {
    if (String(q.message?.chat?.id) !== String(chatId)) return;
    try {
      const r = await handleWalletCallback(q.data, ctx);
      await bot.answerCallbackQuery(q.id, { text: r.alert || '' }).catch(() => {});
      await bot.editMessageText(r.text, { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: r.reply_markup }).catch(() => {});
    } catch (e) {
      log.warn('TG', 'callback error: ' + e.message);
      bot.answerCallbackQuery(q.id, { text: '❌ ' + e.message }).catch(() => {});
    }
  });

  bot.on('polling_error', (e) => log.warn('TG', 'polling_error: ' + e.message));
  log.info('TG', 'telegram bot polling');

  return { notify: (m) => bot.sendMessage(chatId, m, { parse_mode: 'HTML' }).catch(() => {}) };
}
