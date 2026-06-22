import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, walletAddress } from '../config.js';
import { log } from '../logger.js';
import { Rest } from '../net/rest.js';
import { loadSession, saveSession, refreshSupabase, supabaseExpiringSoon, keepWalletSessionAlive, walletSessionExpiringSoon, walletReverifyRequired, parseSupabaseSession, mintSession } from '../auth/session.js';
import { captchaEnabled } from '../auth/captcha.js';
import { bootstrapSession } from '../auth/bootstrap.js';
import { bindWallet, walletSessionPlayerId } from '../auth/wallet.js';
import { subSessionStore, hasSubSession } from '../sub_sessions.js';
import { GameSocket } from '../net/socket.js';
import { GameState } from '../game/state.js';
import { ActionRunner } from '../game/actions.js';
import { planActions, planClaims, planStorage } from '../game/brain.js';
import { loadEconomy } from '../game/economy.js';
import { maybeContribute, pollFarmerPool } from '../game/farmerpool.js';
import { getWalletInfo, withdrawFarm } from '../game/wallet_info.js';
import { buildRoster, generateSubWallets, parseSecret, loadSubWallets, MAX_SUB_WALLETS } from '../wallets.js';
import { withinActiveHours, secondsUntilInactive, sleep, gaussianDelay, maybeBreak } from '../safety/humanizer.js';
import { startTelegram } from '../telegram/bot.js';

export async function runAccount(account = {}) {
  const {
    keypair = config.keypair,
    label = 'main',
    isMain = true,
    sharedTg = null,
    registry = null,
    sessionStore = { load: loadSession, save: saveSession },
  } = account;
  const addr = keypair.publicKey.toBase58();
  const displayName = isMain ? config.displayName : `${config.displayName}_${label}`;
  const tag = isMain ? '' : `[${label}] `;
  const rest = new Rest();
  const eco = account.eco || loadEconomy();
  const state = new GameState();
  const flags = { running: true, paused: false, autopilot: true, connected: false, forceCrop: null, objective: 'balanced' };
  const settings = { activeHours: config.activeHours, goldReserve: 2000, poolBurnGold: config.pool.burnGold };
  const stats = { started: Date.now(), harvests: 0, plants: 0, goldStart: 0 };
  const manualQueue = [];
  const reg = registry || new Map(); // shared engine registry (for /accounts); main owns it

  let session = sessionStore.load();
  // No session yet? AUTO-MINT one via captcha (gas-only multi-account) — else fall back to
  // the one-time browser bootstrap (main account when no captcha key is configured).
  if (!session) session = captchaEnabled() ? await mintSession(rest) : await bootstrapSession();

  // Initial auth, retried — the server is sometimes in maintenance / flaky on boot
  // and bind can 401/time-out. Retry with backoff instead of crashing the process.
  async function authenticate() {
    if (supabaseExpiringSoon(session)) await refreshSupabase(session, rest);
    if (session.cookieHeader) rest.setCookie(session.cookieHeader);
    rest.setBearer(session.access_token);
    let v;
    if (session.walletSessionToken && !walletSessionExpiringSoon(session)) {
      // REUSE a still-valid persisted wallet session (30-min life) on boot instead of
      // ALWAYS hammering the slow /api/auth/wallet/verify. That heavy endpoint is the
      // one that degrades server-side; binding it on every (re)start would block the
      // whole fleet (subs are gated behind main's boot) whenever it's slow. Mirrors
      // reauth() — falls back to a fresh bind only when the session is absent/expiring.
      rest.setWalletSession(session.walletSessionToken); // x-farmtown-wallet-session header
      log.info('AUTH', tag + 'reusing valid wallet session on boot (skip verify)');
      v = { walletSessionToken: session.walletSessionToken };
    } else {
      v = await bindWallet(rest, keypair);
      session.walletSessionToken = v.walletSessionToken;
      rest.setWalletSession(session.walletSessionToken); // x-farmtown-wallet-session header
    }
    session.persistentPlayerId = walletSessionPlayerId(session.walletSessionToken) || session.persistentPlayerId || crypto.randomUUID();
    // Set the in-game display name server-side (best-effort).
    try { await rest.req('/api/auth/profile', { method: 'POST', retries: 0, timeoutMs: 20000, body: { displayName } }); } catch {}
    sessionStore.save(session);
    return v;
  }
  let verified, authAttempt = 0;
  while (flags.running) {
    try { verified = await authenticate(); break; }
    catch (e) {
      authAttempt++;
      const wait = Math.min(5000 * authAttempt, 60000);
      log.warn('AUTH', `${tag}failed (${e.message}) — retry in ${Math.round(wait / 1000)}s (attempt ${authAttempt})`);
      await sleep(wait);
    }
  }
  log.info('AUTH', `${tag}gameplayAllowed wallet=${addr} player=${session.persistentPlayerId}`);

  const ctx = {
    state, flags, walletAddress: addr, economy: eco, registry: reg,
    stats: () => {
      const upMin = Math.round((Date.now() - stats.started) / 60000);
      const goldGain = state.gold - (stats.goldStart || state.gold);
      const perHr = upMin > 0 ? Math.round(goldGain / (upMin / 60)) : 0;
      return `⏱️ up ${upMin}m • harvests ${stats.harvests} • plants ${stats.plants} • gold +${goldGain} (~${perHr}/hr) • orders done ${state.completedOrdersCount} • jobs ${state.completedFarmJobsCount} • harvested ${state.totalHarvestedCrops}`;
    },
    tailLog: (n = 20) => { try { return fs.readFileSync('data/bot.log', 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(no log yet)'; } },
    pool: () => pollFarmerPool(rest),
    claimPool: () => maybeContribute(rest, { burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve, burnLevels: config.pool.burnLevels, levelFloor: config.pool.levelFloor, sacrificeAt: config.pool.sacrificeAt, currentLevel: state.level }),
    walletInfo: () => getWalletInfo(),
    withdraw: () => withdrawFarm(config.withdrawAddress),
    withdrawAddress: config.withdrawAddress,
    // --- multi-account (main + up to 49 sub wallets, one shared Supabase session) ---
    maxSubWallets: MAX_SUB_WALLETS,
    genWallets: (n) => generateSubWallets(n),
    // Verify the captcha key works by minting one throwaway session (no wallet bound).
    testMint: async () => {
      try {
        const s = await mintSession(new Rest());
        let expMin = null; try { expMin = Math.round((JSON.parse(Buffer.from(s.access_token.split('.')[1], 'base64').toString('utf8')).exp * 1000 - Date.now()) / 60000); } catch {}
        return { ok: true, expMin };
      } catch (e) { return { ok: false, reason: e.message }; }
    },
    accountsInfo: async () => {
      const out = [];
      for (const a of buildRoster(config.keypair)) {
        let info = { sol: 0, farm: 0 };
        try { info = await getWalletInfo(a.keypair); } catch { /* RPC may fail */ }
        const e = reg.get(a.label); // live farm state if this account's engine is running
        out.push({ label: a.label, address: a.address, isMain: a.isMain, sol: info.sol, farm: info.farm,
          running: !!e, connected: !!e?.flags?.connected, level: e?.state?.level, gold: e?.state?.gold });
      }
      return out;
    },
    // Sweep ALL $FARM from every sub wallet into the MAIN wallet. Needs a little SOL gas
    // in each sub wallet (the user funds that). Never throws — returns a per-sub summary.
    sweepAll: async () => {
      const mainAddr = config.keypair.publicKey.toBase58();
      const res = [];
      for (const a of buildRoster(config.keypair)) {
        if (a.isMain) continue;
        const r = await withdrawFarm(mainAddr, a.keypair);
        res.push({ label: a.label, ...r });
      }
      return res;
    },
    starBundles: async () => { const r = await rest.req('/api/token/stars/bundles', { timeoutMs: 20000 }); return r.json?.bundles || []; },
    manual: (kind, arg) => manualQueue.push({ kind, arg }),
    // Paste a fresh Supabase session from Telegram → write it + force an immediate
    // re-login. Lets the user recover from a truly-dead refresh token in ~10s without
    // touching files. Accepts the full localStorage JSON, {access_token,...}, or a JWT.
    setAuth: (raw) => {
      const p = parseSupabaseSession(raw);
      if (!p.access_token) return { ok: false, reason: 'no access_token found in pasted value' };
      session.access_token = p.access_token;
      if (p.refresh_token) session.refresh_token = p.refresh_token;
      session.obtainedAt = Date.now();
      saveSession(session);
      authFailStreak = 0; degraded = false;
      flags.running = true;
      reconnecting = false; reconnectAttempt = 0;
      try { gs?.close(); } catch {}
      scheduleReconnect('manual-auth');
      let expMin = null;
      try { expMin = Math.round((JSON.parse(Buffer.from(p.access_token.split('.')[1], 'base64').toString('utf8')).exp * 1000 - Date.now()) / 60000); } catch {}
      return { ok: true, hasRefresh: !!p.refresh_token, expMin };
    },
    setConfig: (key, val) => {
      if (key === 'activeHours') settings.activeHours = val;
      else if (key === 'goldReserve') settings.goldReserve = Number(val) || settings.goldReserve;
      else if (key === 'poolBurnGold') settings.poolBurnGold = !!val;
      else if (key === 'objective') flags.objective = ['gold', 'xp', 'balanced'].includes(val) ? val : flags.objective;
      else if (key === 'forceCrop') flags.forceCrop = (val === 'auto' || val === 'off' || !val) ? null : val;
      return `${key} = ${val}`;
    },
  };
  // Only the MAIN account runs the Telegram bot; sub accounts are headless farmers that
  // share the main bot's notifier and report into the shared registry (for /accounts).
  const tg = isMain ? startTelegram(ctx) : (sharedTg || { notify() {} });
  reg.set(label, { label, isMain, addr, state, flags, stats });

  // Re-auth on (re)connect. Refresh Supabase only when its JWT is near expiry, and
  // REUSE the existing wallet session token until it's near its own 30-min expiry —
  // this avoids hammering the slow /api/auth/wallet/verify endpoint on every reconnect
  // (much more resilient when the server is degraded, and less auth churn = anti-ban).
  async function reauth() {
    if (supabaseExpiringSoon(session)) await refreshSupabase(session, rest);
    rest.setBearer(session.access_token);
    // The WS gateway's explicit "Wallet verification required" rejection OVERRIDES the
    // local expiry heuristic: a locally-unexpired token the server no longer honors would
    // otherwise be reused forever (infinite reconnect loop). When forced, re-bind even
    // though walletSessionExpiringSoon() still says the token is fine.
    if (forceWalletReverify || walletSessionExpiringSoon(session)) {
      const v = await bindWallet(rest, keypair);
      session.walletSessionToken = v.walletSessionToken;
      session.persistentPlayerId = walletSessionPlayerId(session.walletSessionToken) || session.persistentPlayerId;
      sessionStore.save(session);
      log.info('AUTH', tag + (forceWalletReverify ? 're-verified wallet (server rejected session)' : 're-verified wallet (session was expiring)'));
      forceWalletReverify = false;
    } else {
      log.info('AUTH', tag + 'reusing valid wallet session (skip verify)');
    }
    rest.setWalletSession(session.walletSessionToken);
  }

  let gs, runner, lastStateLog = 0, reconnecting = false, lastActionAt = Date.now(), lastSnapshotAt = 0;
  let lastEventAt = Date.now(), reconnectingSince = 0, joinNotifyPending = null;
  function connect() {
    gs = new GameSocket({ accessToken: session.access_token, walletSessionToken: session.walletSessionToken, displayName, persistentPlayerId: session.persistentPlayerId }).connect();
    runner = new ActionRunner(gs);
    gs.on('event', (ev, data) => {
      lastEventAt = Date.now();
      state.apply(ev, data);
      if (ev === 'player:farmState/sync' && !stats.goldStart) stats.goldStart = state.gold;
      // Send the join/recovery notification only AFTER the farm state has synced, so it
      // reports the REAL level/gold (not the level-1/gold-0 defaults at the join instant)
      // and is clearly labelled per account (important once multi-account is running).
      if (ev === 'player:farmState/sync' && joinNotifyPending) {
        const kind = joinNotifyPending; joinNotifyPending = null;
        if (kind === 'recovered') tg.notify(`${tag}✅ <b>SERVER BACK UP</b> — auto-rejoined.\nLevel ${state.level} • gold ${state.gold}`);
        else tg.notify(`${tag}🟢 joined farm — level ${state.level} • gold ${state.gold}`);
      }
      if (ev === 'game:actionResult' && data.ok) log.info('ACT', (data.type || '?') + ' ok' + (data.message ? (' — ' + data.message) : ''));
      if (ev === 'game:error' || ev === 'farm:error') log.warn('GAMEERR', (data.code || '?') + ' ' + (data.message || ''));
      if (ev === 'game:actionResult' && data.ok) lastActionAt = Date.now();
      if (ev === 'player:farmState/sync') { const now = Date.now(); if (now - lastStateLog >= 30000) { lastStateLog = now; log.info('STATE', `gold=${state.gold} lvl=${state.level} stars=${state.stars} | owned=${state.ownedTiles().length} grass=${state.grassEmpty().length} tilled=${state.tilledEmpty().length} ready=${state.readyToHarvest().length} dead=${state.deadCrops().length} blocked=${state.blocked().length} expandable=${state.expandableTiles().length} orders=${state.completableOrders().length}/${state.orders.length} jobs=${state.claimableJobs().length}`); } }
    });
    let lastQueueLog = 0, queuedNotified = false;
    gs.on('queue', (d) => {
      const now = Date.now();
      if (now - lastQueueLog >= 15000) { lastQueueLog = now; log.info('QUEUE', `position ${d.position} (online ${d.online}/${d.capacity})`); }
      if (!queuedNotified) { queuedNotified = true; tg.notify(`⏳ in queue — position ${d.position}, joining automatically`); }
    });
    gs.on('joined', () => {
      const firstJoin = !flags.connected; // the server can emit 'joined' twice — dedupe the notification
      flags.connected = true; reconnecting = false; reconnectAttempt = 0; lastActionAt = Date.now(); gs.refreshSnapshot();
      log.info('JOINED', 'farm gold=' + state.gold + ' level=' + state.level + ' owned=' + state.ownedTiles().length);
      if (!firstJoin) return;
      // Defer the actual notification to the first farmState/sync (real level/gold).
      // The user ALWAYS gets a labelled "server up / back in" ping per (re)join.
      joinNotifyPending = degraded ? 'recovered' : 'joined';
      degraded = false;
    });
    gs.on('down', (reason) => { flags.connected = false; scheduleReconnect(reason); });
  }

  // After this many consecutive failed reconnects (~2-3 min of exponential backoff),
  // treat it as a server-side degradation/maintenance window and alert the user ONCE.
  const DEGRADED_THRESHOLD = 4;
  let reconnectAttempt = 0, authFailStreak = 0, degraded = false, forceWalletReverify = false;
  async function scheduleReconnect(reason) {
    if (reconnecting || !flags.running) return;
    // Server says the wallet session is invalid (not just a transient drop) → force the
    // next reauth() to re-bind the wallet instead of reusing the locally-unexpired token.
    if (walletReverifyRequired(reason)) forceWalletReverify = true;
    reconnecting = true;
    reconnectingSince = Date.now();
    flags.connected = false;
    try { gs?.close(); } catch {}
    const backoff = Math.min(2000 * 2 ** reconnectAttempt, 30000) + gaussianDelay(500, 2500);
    reconnectAttempt++;
    log.warn('WS', `down (${reason}) — reconnect in ${Math.round(backoff / 1000)}s (attempt ${reconnectAttempt})`);
    // Notify ONCE on the first drop — never on every retry (avoids 30+ msg spam in an outage).
    if (reconnectAttempt === 1) tg.notify('🔴 Disconnected — reconnecting…');
    // Sustained failure = server-side degradation/maintenance. One clear alert with guidance.
    if (reconnectAttempt === DEGRADED_THRESHOLD && !degraded) {
      degraded = true;
      tg.notify(
        '🟠 <b>SERVER DEGRADED / MAINTENANCE</b>\n' +
        `Can't hold a connection after ${reconnectAttempt} tries — the game API/auth is slow or down <b>server-side</b>, not the bot.\n\n` +
        '• Safe to <b>/stop</b> now and <b>/start</b> later.\n' +
        "• Or leave it running — I'll keep retrying and send ✅ when the server recovers."
      );
    }
    await sleep(backoff);
    if (!flags.running) { reconnecting = false; return; }
    try {
      await reauth();
      connect();
      authFailStreak = 0;
    } catch (e) {
      log.error('RECONNECT', e.message + ' — retrying');
      // Only cry "session expired" on a GENUINE auth rejection (real 401 / invalid_grant /
      // wallet-not-verified). A timeout ("verify failed: null", "aborted") is server
      // degradation, NOT a dead token — handled by the DEGRADED alert above. This avoids
      // the false "re-paste your session" alarm during a slow-server window.
      const realAuthFail = /challenge failed: 401|invalid_grant|WALLET_NOT_VERIFIED|verify failed: \{.*(invalid|expired|unauthor)/i.test(e.message)
        && !/timeout|aborted|: null/i.test(e.message);
      if (realAuthFail && ++authFailStreak === 3) {
        tg.notify(
          '⚠️ <b>Session expired</b> — bot can\'t re-auth (real auth rejection). Re-login in 10s:\n\n' +
          '1️⃣ Open the game → <b>F12</b> → <b>Console</b>, run this (copies token to clipboard):\n' +
          '<code>copy(localStorage.getItem(Object.keys(localStorage).find(k=&gt;k.includes(\'auth-token\'))))</code>\n' +
          '2️⃣ Send <code>/auth </code> then paste it. I\'ll auto-login + resume.'
        );
      }
    } finally {
      // ALWAYS release the guard so the next 'down' can schedule another attempt.
      reconnecting = false;
      reconnectingSince = 0;
    }
    // The socket connects + joins ASYNCHRONOUSLY (~2.5s after connect()). Re-check
    // connectivity 5s LATER inside the callback — NOT synchronously here, where
    // flags.connected is always still false (join hasn't happened yet), which would
    // schedule a guaranteed reconnect on EVERY healthy socket and cause a ~5s
    // self-disconnect loop per engine. Only force another attempt if STILL not connected.
    setTimeout(() => {
      if (!flags.connected && flags.running && !reconnecting && !gs?.socket?.connected) {
        scheduleReconnect('retry');
      }
    }, 5000);
  }
  connect();

  // MULTI-ACCOUNT: the main account spawns a concurrent headless farming engine for every
  // generated sub-wallet, each under its OWN auto-minted Supabase session (captcha). They
  // share this Telegram bot + registry and sweep their $FARM to main. Gated by MULTI_ACCOUNT.
  if (isMain && config.multiAccount) {
    let subs = loadSubWallets();
    if (config.multiAccountLimit > 0) subs = subs.slice(0, config.multiAccountLimit); // staged rollout
    if (subs.length && !captchaEnabled()) {
      tg.notify('⚠️ MULTI_ACCOUNT is on but CAPTCHA_API_KEY is unset — sub-accounts each need their own session. Set CAPTCHA_API_KEY to auto-mint them.');
    }
    log.info('MULTI', `spawning ${subs.length} sub-account engine(s)`);
    // Sub-accounts farm SILENTLY — a single Telegram bot shared by 31 engines would spam
    // 31× on every pool-open / join / reconnect. Only the main account notifies; the whole
    // fleet (live level/gold/connected per account) is monitored via /accounts. Sub issues
    // still hit the log (/log).
    const silentTg = { notify() {} };
    for (const w of subs) {
      const subLabel = `sub${w.index}`;
      runAccount({ keypair: parseSecret(w.secretKey), label: subLabel, isMain: false, sharedTg: silentTg, registry: reg, sessionStore: subSessionStore(subLabel), eco })
        .catch((e) => log.error('MULTI', `${subLabel} crashed: ${e.message}`));
      await sleep(gaussianDelay(8000, 15000)); // stagger starts (captcha solves + anti-thundering-herd)
    }
    if (subs.length) tg.notify(`👥 Multi-account: started ${subs.length} sub-farm(s) + main. /accounts to monitor.`);
  }

  // WATCHDOG — guarantees the bot always recovers connectivity. Independent of the
  // event-driven reconnect, it catches: (a) zombie connections (joined but no events
  // for >90s = half-open socket), (b) a stuck reconnect guard (>180s), and (c) being
  // disconnected with nothing in flight. Any of these → force a reconnect.
  (async function watchdog() {
    while (flags.running) {
      await sleep(30000);
      const now = Date.now();
      try {
        if (flags.connected && now - lastEventAt > 90000) {
          log.warn('WATCHDOG', `no events for ${Math.round((now - lastEventAt) / 1000)}s — zombie connection, forcing reconnect`);
          flags.connected = false;
          try { gs?.close(); } catch {}
          reconnecting = false; reconnectingSince = 0;
          scheduleReconnect('watchdog-zombie');
        } else if (reconnecting && reconnectingSince && now - reconnectingSince > 180000) {
          log.warn('WATCHDOG', 'reconnect stuck >180s — resetting guard');
          reconnecting = false; reconnectingSince = 0;
          scheduleReconnect('watchdog-stuck');
        } else if (!flags.connected && !reconnecting) {
          log.warn('WATCHDOG', 'disconnected and idle — kicking reconnect');
          scheduleReconnect('watchdog-idle');
        }
      } catch (e) { log.warn('WATCHDOG', e.message); }
    }
  })();

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
  // Contribute repeatedly (~every 10 min ≈ 144x/day, in line with top players) so our
  // share keeps climbing. Notify only the FIRST contribution per pool-open + a periodic
  // summary — never every cycle (would spam). Resets when the pool isn't active.
  let poolNotified = false, poolLastSummary = 0;
  (async function farmerPoolLoop() {
    while (flags.running) {
      await sleep(gaussianDelay(540000, 660000)); // ~10 min
      if (!config.pool.enabled || !flags.connected || state.level < 10) continue;
      const r = await maybeContribute(rest, { burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve, burnLevels: config.pool.burnLevels, levelFloor: config.pool.levelFloor, sacrificeAt: config.pool.sacrificeAt, currentLevel: state.level });
      if (r?.contributed) {
        const now = Date.now();
        if (!poolNotified) { poolNotified = true; poolLastSummary = now; tg.notify("💎 Farmer's Pool is open — auto-contributing free farm points to earn $FARM. /pool for details."); }
        else if (now - poolLastSummary > 7200000) { // ~2h summary
          poolLastSummary = now;
          try { const st = await pollFarmerPool(rest); const me = st?.player; if (me) tg.notify(`💎 Pool today: power ${me.contributedClaimPowerToday || 0} • est. payout ${(Number(me.estimatedPayoutRaw || 0) / 1e6).toFixed(2)} $FARM`); } catch {}
        }
      } else if (r?.pool && r.pool !== 'active') {
        poolNotified = false; // pool closed/paused → re-announce when it next opens
      }
    }
  })();

  // Auto-sweep: periodically move every sub wallet's earned $FARM to the MAIN wallet,
  // so you only ever fund subs with a little SOL for gas and collect $FARM in one place.
  // No-op (and silent) when there are no sub wallets or nothing to send.
  (async function autoSweepLoop() {
    if (!isMain) return; // only the main account runs the global sweep
    while (flags.running) {
      await sleep(gaussianDelay(5400000, 6600000)); // ~1.5–1.8h
      try {
        const roster = buildRoster(config.keypair).filter(a => !a.isMain);
        if (!roster.length) continue;
        const mainAddr = config.keypair.publicKey.toBase58();
        let sent = 0, n = 0;
        for (const a of roster) { const r = await withdrawFarm(mainAddr, a.keypair); if (r.ok) { sent += r.amount || 0; n++; } }
        if (n > 0) tg.notify(`🧹 Auto-swept ${n} sub-wallet(s): ${Math.floor(sent)} $FARM → main wallet.`);
      } catch (e) { log.warn('SWEEP', e.message); }
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
