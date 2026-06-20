import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { Rest } from '../net/rest.js';
import { loadSession, saveSession, refreshSupabase, supabaseExpiringSoon, keepWalletSessionAlive } from '../auth/session.js';
import { bootstrapSession } from '../auth/bootstrap.js';
import { bindWallet } from '../auth/wallet.js';
import { GameSocket } from '../net/socket.js';
import { GameState } from '../game/state.js';
import { ActionRunner } from '../game/actions.js';
import { planActions, planClaims } from '../game/brain.js';
import { loadEconomy } from '../game/economy.js';
import { withinActiveHours, sleep, gaussianDelay, maybeBreak } from '../safety/humanizer.js';
import { startTelegram } from '../telegram/bot.js';

export async function runAccount() {
  const rest = new Rest();
  const eco = loadEconomy();
  const state = new GameState();
  const flags = { running: true, paused: false, autopilot: true, connected: false, forceCrop: null };
  const stats = { started: Date.now(), harvests: 0, plants: 0, goldStart: 0 };
  const manualQueue = [];

  let session = loadSession();
  if (!session) session = await bootstrapSession();
  if (supabaseExpiringSoon(session)) await refreshSupabase(session, rest);
  if (session.cookieHeader) rest.setCookie(session.cookieHeader);
  rest.setBearer(session.access_token);
  await bindWallet(rest);
  session.persistentPlayerId = session.persistentPlayerId || crypto.randomUUID();
  saveSession(session);

  const tg = startTelegram({
    state, flags,
    stats: () => `⏱️ up ${Math.round((Date.now() - stats.started) / 60000)}m • harvests ${stats.harvests} • plants ${stats.plants} • gold ${state.gold}`,
    tailLog: () => 'see data/bot.log',
    manual: (kind, arg) => manualQueue.push({ kind, arg }),
  });

  let gs, runner;
  function connect() {
    gs = new GameSocket({ accessToken: session.access_token, displayName: config.displayName, persistentPlayerId: session.persistentPlayerId }).connect();
    runner = new ActionRunner(gs);
    gs.on('event', (ev, data) => {
      state.apply(ev, data);
      if (ev === 'player:farmState/sync' && !stats.goldStart) stats.goldStart = state.gold;
    });
    gs.on('joined', () => { flags.connected = true; tg.notify('🟢 joined farm — level ' + state.level + ' gold ' + state.gold); });
    gs.on('down', () => { flags.connected = false; tg.notify('🔴 disconnected — reconnecting'); });
  }
  connect();

  (async function keepalive() {
    while (flags.running) {
      try {
        if (supabaseExpiringSoon(session)) { const okR = await refreshSupabase(session, rest); if (!okR) tg.notify('⚠️ Supabase refresh failed'); }
        await keepWalletSessionAlive(rest);
      } catch (e) { log.warn('KEEPALIVE', e.message); }
      await sleep(60000);
    }
  })();

  while (flags.running) {
    try {
      const active = withinActiveHours(config.activeHours);
      if (flags.connected && !flags.paused && flags.autopilot && active) {
        while (manualQueue.length) { const m = manualQueue.shift(); await handleManual(m, { state, runner, flags }); }
        const plan = [...planClaims(state), ...planActions(state, eco, { objective: flags.forceCrop ? 'gold' : 'balanced' })];
        for (const a of plan) {
          if (!flags.running || flags.paused) break;
          const ok = await runner.do(a.event, a.payload, a.meta);
          if (a.kind === 'harvest' && ok) stats.harvests++;
          if (a.kind === 'plant' && ok) stats.plants++;
        }
        if (maybeBreak(0.04)) { const b = gaussianDelay(20000, 90000); log.info('TICK', 'human break ' + b + 'ms'); await sleep(b); }
      }
    } catch (e) { log.error('TICK', e.message); }
    await sleep(gaussianDelay(4000, 9000));
  }
}

async function handleManual(m, { state, runner, flags }) {
  if (m.kind === 'restart') { log.info('MANUAL', 'restart requested'); process.exit(0); }
  if (m.kind === 'harvest') for (const t of state.readyToHarvest()) await runner.do('crop:harvest/request', { tileX: t.x, tileY: t.y }, { action: 'harvest', tool: 'hoe' });
  if (m.kind === 'plant' && m.arg) for (const t of state.tilledEmpty()) await runner.do('crop:plant/request', { tileX: t.x, tileY: t.y, seedId: `${m.arg}_seed` }, { action: 'plant', tool: 'seed_bag', seedId: `${m.arg}_seed` });
  if (m.kind === 'buyplot') { const b = state.buyableTiles()[0]; if (b) await runner.do('plot:buy/request', { tileX: b.x, tileY: b.y }, null); }
  // 'sellall' is a no-op until a sell endpoint is discovered in live capture (documented gap)
}
