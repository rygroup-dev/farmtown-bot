import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, walletAddress } from '../config.js';
import { log } from '../logger.js';
import { Rest } from '../net/rest.js';
import { loadSession, saveSession, refreshSupabase, supabaseExpiringSoon, keepWalletSessionAlive } from '../auth/session.js';
import { bootstrapSession } from '../auth/bootstrap.js';
import { bindWallet, walletSessionPlayerId } from '../auth/wallet.js';
import { GameSocket } from '../net/socket.js';
import { GameState } from '../game/state.js';
import { ActionRunner } from '../game/actions.js';
import { planActions, planClaims, planStorage } from '../game/brain.js';
import { loadEconomy } from '../game/economy.js';
import { maybeContribute, pollFarmerPool } from '../game/farmerpool.js';
import { getWalletInfo, withdrawFarm } from '../game/wallet_info.js';
import { withinActiveHours, secondsUntilInactive, sleep, gaussianDelay, maybeBreak } from '../safety/humanizer.js';
import { startTelegram } from '../telegram/bot.js';

export async function runAccount() {
  const rest = new Rest();
  const eco = loadEconomy();
  const state = new GameState();
  const flags = { running: true, paused: false, autopilot: true, connected: false, forceCrop: null, objective: 'balanced' };
  const settings = { activeHours: config.activeHours, goldReserve: 150, poolBurnGold: config.pool.burnGold };
  const stats = { started: Date.now(), harvests: 0, plants: 0, goldStart: 0 };
  const manualQueue = [];

  let session = loadSession();
  if (!session) session = await bootstrapSession();

  // Initial auth, retried — the server is sometimes in maintenance / flaky on boot
  // and bind can 401/time-out. Retry with backoff instead of crashing the process.
  async function authenticate() {
    if (supabaseExpiringSoon(session)) await refreshSupabase(session, rest);
    if (session.cookieHeader) rest.setCookie(session.cookieHeader);
    rest.setBearer(session.access_token);
    const v = await bindWallet(rest);
    session.walletSessionToken = v.walletSessionToken;
    rest.setWalletSession(session.walletSessionToken); // x-farmtown-wallet-session header
    session.persistentPlayerId = walletSessionPlayerId(session.walletSessionToken) || session.persistentPlayerId || crypto.randomUUID();
    // Set the in-game display name server-side (best-effort).
    try { await rest.req('/api/auth/profile', { method: 'POST', retries: 0, timeoutMs: 20000, body: { displayName: config.displayName } }); } catch {}
    saveSession(session);
    return v;
  }
  let verified, authAttempt = 0;
  while (flags.running) {
    try { verified = await authenticate(); break; }
    catch (e) {
      authAttempt++;
      const wait = Math.min(5000 * authAttempt, 60000);
      log.warn('AUTH', `failed (${e.message}) — retry in ${Math.round(wait / 1000)}s (attempt ${authAttempt})`);
      await sleep(wait);
    }
  }
  log.info('AUTH', `gameplayAllowed wallet=${verified.walletAddress} player=${session.persistentPlayerId}`);

  const tg = startTelegram({
    state, flags, walletAddress, economy: eco,
    stats: () => {
      const upMin = Math.round((Date.now() - stats.started) / 60000);
      const goldGain = state.gold - (stats.goldStart || state.gold);
      const perHr = upMin > 0 ? Math.round(goldGain / (upMin / 60)) : 0;
      return `⏱️ up ${upMin}m • harvests ${stats.harvests} • plants ${stats.plants} • gold +${goldGain} (~${perHr}/hr) • orders done ${state.completedOrdersCount} • jobs ${state.completedFarmJobsCount} • harvested ${state.totalHarvestedCrops}`;
    },
    tailLog: (n = 20) => { try { return fs.readFileSync('data/bot.log', 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(no log yet)'; } },
    pool: () => pollFarmerPool(rest),
    claimPool: () => maybeContribute(rest, { burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve }),
    walletInfo: () => getWalletInfo(),
    withdraw: () => withdrawFarm(config.withdrawAddress),
    withdrawAddress: config.withdrawAddress,
    starBundles: async () => { const r = await rest.req('/api/token/stars/bundles', { timeoutMs: 20000 }); return r.json?.bundles || []; },
    manual: (kind, arg) => manualQueue.push({ kind, arg }),
    setConfig: (key, val) => {
      if (key === 'activeHours') settings.activeHours = val;
      else if (key === 'goldReserve') settings.goldReserve = Number(val) || settings.goldReserve;
      else if (key === 'poolBurnGold') settings.poolBurnGold = !!val;
      else if (key === 'objective') flags.objective = ['gold', 'xp', 'balanced'].includes(val) ? val : flags.objective;
      else if (key === 'forceCrop') flags.forceCrop = (val === 'auto' || val === 'off' || !val) ? null : val;
      return `${key} = ${val}`;
    },
  });

  // Re-auth so every (re)connect uses fresh tokens (supabase ~1h, walletSession ~30m).
  async function reauth() {
    if (supabaseExpiringSoon(session)) await refreshSupabase(session, rest);
    rest.setBearer(session.access_token);
    const v = await bindWallet(rest);
    session.walletSessionToken = v.walletSessionToken;
    rest.setWalletSession(v.walletSessionToken);
    saveSession(session);
  }

  let gs, runner, lastStateLog = 0, reconnecting = false, lastActionAt = Date.now(), lastSnapshotAt = 0;
  function connect() {
    gs = new GameSocket({ accessToken: session.access_token, walletSessionToken: session.walletSessionToken, displayName: config.displayName, persistentPlayerId: session.persistentPlayerId }).connect();
    runner = new ActionRunner(gs);
    gs.on('event', (ev, data) => {
      state.apply(ev, data);
      if (ev === 'player:farmState/sync' && !stats.goldStart) stats.goldStart = state.gold;
      if (ev === 'game:actionResult' && data.ok) log.info('ACT', (data.type || '?') + ' ok' + (data.message ? (' — ' + data.message) : ''));
      if (ev === 'game:error' || ev === 'farm:error') log.warn('GAMEERR', (data.code || '?') + ' ' + (data.message || ''));
      if (ev === 'game:actionResult' && data.ok) lastActionAt = Date.now();
      if (ev === 'player:farmState/sync') { const now = Date.now(); if (now - lastStateLog >= 30000) { lastStateLog = now; log.info('STATE', `gold=${state.gold} lvl=${state.level} stars=${state.stars} | owned=${state.ownedTiles().length} grass=${state.grassEmpty().length} tilled=${state.tilledEmpty().length} ready=${state.readyToHarvest().length} orders=${state.completableOrders().length}/${state.orders.length} jobs=${state.claimableJobs().length}`); } }
    });
    let lastQueueLog = 0, queuedNotified = false;
    gs.on('queue', (d) => {
      const now = Date.now();
      if (now - lastQueueLog >= 15000) { lastQueueLog = now; log.info('QUEUE', `position ${d.position} (online ${d.online}/${d.capacity})`); }
      if (!queuedNotified) { queuedNotified = true; tg.notify(`⏳ in queue — position ${d.position}, joining automatically`); }
    });
    gs.on('joined', () => { flags.connected = true; reconnecting = false; reconnectAttempt = 0; lastActionAt = Date.now(); gs.refreshSnapshot(); log.info('JOINED', 'farm gold=' + state.gold + ' level=' + state.level + ' owned=' + state.ownedTiles().length); tg.notify('🟢 joined farm — level ' + state.level + ' gold ' + state.gold); });
    gs.on('down', (reason) => { flags.connected = false; scheduleReconnect(reason); });
  }

  let reconnectAttempt = 0;
  async function scheduleReconnect(reason) {
    if (reconnecting || !flags.running) return;
    reconnecting = true;
    flags.connected = false;
    try { gs?.close(); } catch {}
    const backoff = Math.min(2000 * 2 ** reconnectAttempt, 30000) + gaussianDelay(500, 2500);
    reconnectAttempt++;
    log.warn('WS', `down (${reason}) — reconnect in ${Math.round(backoff / 1000)}s (attempt ${reconnectAttempt})`);
    tg.notify('🔴 disconnected — reconnecting');
    await sleep(backoff);
    if (!flags.running) { reconnecting = false; return; }
    try {
      await reauth();
      connect();
    } catch (e) {
      log.error('RECONNECT', e.message + ' — retrying');
    } finally {
      // ALWAYS release the guard so the next 'down' can schedule another attempt.
      // If reauth/connect failed, the freshly-created (or absent) socket's next
      // 'down'/'connect_error' re-enters scheduleReconnect; if reauth threw before
      // connect(), kick a delayed retry here.
      reconnecting = false;
    }
    if (!flags.connected && flags.running && !gs?.socket?.connected) {
      // no socket alive after this attempt → ensure another try is scheduled
      setTimeout(() => scheduleReconnect('retry'), 5000);
    }
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

  // Farmer's Pool earn loop: once at L10+ and the daily pool is open, contribute claim
  // power (farm points by default; gold only if POOL_BURN_GOLD=on) to earn $FARM.
  (async function farmerPoolLoop() {
    while (flags.running) {
      await sleep(gaussianDelay(540000, 660000)); // ~10 min
      if (!config.pool.enabled || !flags.connected || state.level < 10) continue;
      const r = await maybeContribute(rest, { burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve });
      if (r?.contributed) tg.notify(`💎 Farmer's Pool: contributed claim power — earning $FARM`);
    }
  })();

  while (flags.running) {
    try {
      const active = withinActiveHours(settings.activeHours);
      if (flags.connected && !flags.paused && flags.autopilot && active) {
        while (manualQueue.length) { const m = manualQueue.shift(); await handleManual(m, { state, runner, flags, gs, settings, reconnect: () => scheduleReconnect('manual') }); }
        const timeBudgetSeconds = secondsUntilInactive(settings.activeHours);
        const ecoForPlant = flags.forceCrop && eco[flags.forceCrop] ? { [flags.forceCrop]: eco[flags.forceCrop] } : eco;
        const plan = [
          ...planClaims(state),
          ...planActions(state, ecoForPlant, { objective: flags.objective, timeBudgetSeconds, goldReserve: settings.goldReserve }),
          ...planStorage(state),
        ];
        if (plan.length) {
          for (const a of plan) {
            if (!flags.running || flags.paused) break;
            const ok = await runner.do(a.event, a.payload, a.meta);
            if (ok) lastActionAt = Date.now();
            if (a.kind === 'harvest' && ok) stats.harvests++;
            if (a.kind === 'plant' && ok) stats.plants++;
          }
        } else {
          // Nothing to do. If idle for a while, re-request a fresh snapshot in case
          // local tile state went stale (e.g. after a reconnect) — keeps the bot
          // from silently sitting idle on a farm that actually has work.
          const idleMs = Date.now() - lastActionAt;
          if (idleMs > 90000 && Date.now() - lastSnapshotAt > 60000) {
            lastSnapshotAt = Date.now();
            log.info('TICK', `idle ${Math.round(idleMs / 1000)}s — refreshing snapshot (owned=${state.ownedTiles().length})`);
            gs.refreshSnapshot();
          }
        }
        if (maybeBreak(0.02)) { const b = gaussianDelay(8000, 30000); log.info('TICK', 'human break ' + b + 'ms'); await sleep(b); }
      }
    } catch (e) { log.error('TICK', e.message); }
    await sleep(gaussianDelay(4000, 9000));
  }
}

const STORAGE_TIERS = [
  { itemId: 'small_storage_crate', cap: 75, cost: 25000 },
  { itemId: 'big_storage_crate', cap: 125, cost: 100000 },
  { itemId: 'farm_storage_chest', cap: 200, cost: 500000 },
];

async function handleManual(m, { state, runner, flags, gs, settings, reconnect }) {
  log.info('MANUAL', m.kind + (m.arg ? ' ' + m.arg : ''));
  if (m.kind === 'restart') { process.exit(0); }
  if (m.kind === 'reconnect') { if (reconnect) reconnect(); return; }
  if (m.kind === 'harvest') for (const t of state.readyToHarvest()) await runner.do('crop:harvest/request', { tileX: t.x, tileY: t.y }, { action: 'harvest', tool: 'hoe' });
  if ((m.kind === 'plant' || m.kind === 'plantall') && m.arg) {
    const seedId = m.arg.endsWith('_seed') ? m.arg : `${m.arg}_seed`;
    const tiles = m.kind === 'plantall' ? state.tilledEmpty() : state.tilledEmpty().slice(0, 1);
    for (const t of tiles) await runner.do('crop:plant/request', { tileX: t.x, tileY: t.y, seedId }, { action: 'plant', tool: 'seed_bag', seedId });
  }
  if (m.kind === 'buyplot') { const b = state.buyableTiles().find(t => t.ownerState === 'buyable') || state.buyableTiles()[0]; if (b) await runner.do('plot:buy/request', { tileX: b.x, tileY: b.y }, null); }
  if (m.kind === 'buyseed' && m.arg) {
    const [crop, qtyStr] = m.arg.split(/\s+/);
    const seedId = crop.endsWith('_seed') ? crop : `${crop}_seed`;
    const quantity = Math.max(1, Number(qtyStr) || 1);
    await runner.do('store:buySeed/request', { seedId, quantity }, null);
  }
  if (m.kind === 'upgradestorage') {
    const tier = STORAGE_TIERS.find(t => t.cap > state.inventoryCapacity);
    if (tier && state.gold >= tier.cost) await runner.do('store:buyItem/request', { itemId: tier.itemId }, null);
  }
}
