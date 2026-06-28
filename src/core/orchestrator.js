import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, walletAddress } from '../config.js';
import { log } from '../logger.js';
import { Rest } from '../net/rest.js';
import { loadSession, saveSession, refreshSupabase, supabaseExpiringSoon, keepWalletSessionAlive, walletSessionExpiringSoon, walletReverifyRequired, supabaseRemintRequired, parseSupabaseSession, mintSession } from '../auth/session.js';
import { captchaEnabled } from '../auth/captcha.js';
import { bindWallet, walletSessionPlayerId } from '../auth/wallet.js';
import { subSessionStore, hasSubSession } from '../sub_sessions.js';
import { GameSocket } from '../net/socket.js';
import { GameState } from '../game/state.js';
import { ActionRunner } from '../game/actions.js';
import { planActions, planClaims, planStorage, planAnimalActions, planBarnInvestment } from '../game/brain.js';
import { loadEconomy } from '../game/economy.js';
import { maybeContribute, pollFarmerPool, poolTiming, decideCropSacrifice, SACRIFICE_CROPS } from '../game/farmerpool.js';
import { getWalletInfo, withdrawFarm, buyStars, sendFarmTo, sendSolTo, getPendingStars, retryPendingStar } from '../game/wallet_info.js';
import { buildRoster, generateSubWallets, parseSecret, loadSubWallets, MAX_SUB_WALLETS } from '../wallets.js';
import { withinActiveHours, secondsUntilInactive, sleep, gaussianDelay, maybeBreak } from '../safety/humanizer.js';
import { startTelegram } from '../telegram/bot.js';

// === TOP-LEVEL HELPERS (extracted from runAccount closures for testability + reuse) ===

// Proactively renew the walletSessionToken BEFORE it expires, so reconnects don't
// hit the slow /api/auth/wallet/verify on every reconnect — we only re-bind when
// the token is within `expiringSoonFn`'s window. Best-effort: bind errors are logged
// and swallowed (the reconnect path will pick up a true re-bind if needed).
export async function proactiveWalletRefresh({
  session, rest, keypair, sessionStore, tag, walletAddress = null,
  bindWalletFn = bindWallet,
  expiringSoonFn = walletSessionExpiringSoon,
  log,
}) {
  if (!expiringSoonFn(session, 5 * 60_000)) return { renewed: false };
  try {
    const v = await bindWalletFn(rest, keypair);
    session.walletSessionToken = v.walletSessionToken;
    if (walletAddress) session.walletAddress = walletAddress;
    sessionStore.save(session);
    log.info('AUTH', `${tag}proactively renewed walletSessionToken`);
    return { renewed: true };
  } catch (e) {
    log.warn('KEEPALIVE', `${tag}wallet renew failed: ${e.message}`);
    return { renewed: false, error: e.message };
  }
}

// Refresh the Supabase access token. If refresh fails AND captcha is enabled,
// mint a fresh session (player identity survives via re-bind). If refresh fails
// AND captcha is disabled: main accounts THROW (caller must handle / re-paste
// via /auth), sub accounts return 'retry' so ensureSupabaseFreshWithRetry can
// loop without throwing back into the engine loop. Returns true on mint (caller
// must re-bind wallet since gameplayAllowed=false on a fresh session).
export async function ensureSupabaseFresh({
  session, rest, sessionStore, tag, isMain = false, force = false,
  supabaseExpiringSoonFn = supabaseExpiringSoon,
  refreshSupabaseFn = refreshSupabase,
  captchaEnabledFn = captchaEnabled,
  mintSessionFn = mintSession,
  log,
}) {
  if (!force && !supabaseExpiringSoonFn(session)) return false;
  if (await refreshSupabaseFn(session, rest)) {
    sessionStore.save(session);
    return false;
  }
  if (captchaEnabledFn()) {
    log.warn('AUTH', tag + 'supabase refresh failed → minting fresh session via captcha');
    const fresh = await mintSessionFn(rest);
    session.access_token = fresh.access_token;
    session.refresh_token = fresh.refresh_token;
    session.obtainedAt = fresh.obtainedAt;
    sessionStore.save(session);
    return true;
  }
  if (isMain) throw new Error('invalid_grant: supabase refresh failed and no captcha key to re-mint — paste a fresh session via /auth');
  return 'retry';
}

// Retry wrapper: keep calling ensureSupabaseFresh (with force=true) until it
// returns something other than 'retry', or attempts are exhausted. Each retry
// sleeps 30s. Used by boot + reauth() so a transient captcha/refresh hiccup
// doesn't crash the engine — a sub-account can fail-and-retry silently, while
// a main-account failure throws (propagates to the caller's try/catch).
export async function ensureSupabaseFreshWithRetry({
  maxAttempts = 3,
  sleepFn = (ms) => new Promise(r => setTimeout(r, ms)),
  ...deps
} = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await ensureSupabaseFresh({ ...deps, force: true });
    if (r !== 'retry') return r;
    deps.log.warn('AUTH', `${deps.tag}supabase refresh failed (attempt ${i+1}/${maxAttempts}), retrying in 30s`);
    await sleepFn(30000);
  }
  deps.log.error('AUTH', `${deps.tag}supabase refresh exhausted ${maxAttempts} attempts`);
  return 'retry';
}

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
  const flags = { running: true, paused: false, autopilot: true, connected: false, forceCrop: null, objective: 'balanced', poolIsOpen: false };
  const settings = { activeHours: config.activeHours, goldReserve: 2000, poolBurnGold: config.pool.burnGold };
  const stats = { started: Date.now(), harvests: 0, plants: 0, goldStart: 0 };
  const manualQueue = [];
  const reg = registry || new Map(); // shared engine registry (for /accounts); main owns it

  let session = sessionStore.load();
  // No session yet?
  //  • CAPTCHA_API_KEY set → auto-mint an anonymous session (gas-only multi-account).
  //  • otherwise (main, no captcha) → the browser bootstrap is ALWAYS Turnstile-blocked,
  //    so don't crash on it. Wait for the user to supply a session: paste it into
  //    data/session.json (browser F12 one-liner) or via Telegram /auth. Poll until present,
  //    then continue normally. This makes a fresh install come up cleanly instead of FATAL.
  if (!session) {
    if (captchaEnabled()) {
      session = await mintSession(rest);
    } else if (isMain) {
      log.warn('AUTH', 'No Supabase session and no CAPTCHA_API_KEY. To log in: paste your session into '
        + config.sessionFile + ' (browser F12 one-liner) or via Telegram /auth — or set CAPTCHA_API_KEY in .env to auto-mint. Waiting for a session…');
      let waited = 0;
      while (flags.running && !(session = sessionStore.load())) {
        if (waited % 60 === 0) log.info('AUTH', 'still waiting for a session (paste into ' + config.sessionFile + ' or send /auth)…');
        await sleep(5000); waited += 5;
      }
      if (!session) return; // stopped before a session arrived
      log.info('AUTH', 'session detected — continuing boot');
    } else {
      throw new Error(tag + 'sub-account needs CAPTCHA_API_KEY to auto-mint a session');
    }
  }


  // Initial auth, retried — the server is sometimes in maintenance / flaky on boot
  // and bind can 401/time-out. Retry with backoff instead of crashing the process.
  async function authenticate() {
    const reminted = await ensureSupabaseFreshWithRetry({ session, rest, sessionStore, tag, isMain, log });
    if (session.cookieHeader) rest.setCookie(session.cookieHeader);
    rest.setBearer(session.access_token);
    let v;
    if (!reminted && session.walletSessionToken && session.walletAddress === addr && !walletSessionExpiringSoon(session)) {
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
    session.walletAddress = addr;
    // Set the in-game display name server-side (best-effort).
    try { await rest.req('/api/auth/profile', { method: 'POST', retries: 0, timeoutMs: 20000, body: { displayName } }); } catch {}
    sessionStore.save(session);
    return v;
  }
  let verified, authAttempt = 0, collisionAttempt = 0;
  while (flags.running) {
    try {
      verified = await authenticate();
      const existing = [...reg.values()].find(e => e.addr !== addr && e.playerId && e.playerId === session.persistentPlayerId);
      if (existing) {
        const msg = `${tag}playerId collision with ${existing.label} (${session.persistentPlayerId})`;
        if (!isMain && captchaEnabled() && collisionAttempt < 2) {
          collisionAttempt++;
          log.warn('AUTH', `${msg} — dropping sub session and minting a fresh isolated session (${collisionAttempt}/2)`);
          sessionStore.remove?.();
          session = await mintSession(rest);
          continue;
        }
        log.error('AUTH', `${msg} — refusing to run this account to avoid main/sub conflict`);
        flags.running = false;
        return;
      }
      break;
    }
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
    leaderboard: async (category = 'farmRank', limit = 20) => {
      const safeCategory = ['farmRank', 'farmValue', 'ordersCompleted', 'jobsClaimed', 'landOwned', 'cropMastery', 'starfruitHarvests'].includes(category)
        ? category
        : 'farmRank';
      const safeLimit = Math.max(5, Math.min(50, Number(limit) || 20));
      const r = await rest.req(`/api/leaderboard?category=${encodeURIComponent(safeCategory)}&limit=${safeLimit}`, { timeoutMs: 25000, retries: 1 });
      return r.status === 200 ? r.json : null;
    },
    claimPool: () => maybeContribute(rest, { tag, burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve, burnLevels: config.pool.burnLevels, levelFloor: config.pool.levelFloor, sacrificeAt: config.pool.sacrificeAt, currentLevel: state.level, cropInventory: state.cropInventory }),
    walletInfo: () => getWalletInfo(),
    withdraw: () => withdrawFarm(config.withdrawAddress),
    withdrawAddress: config.withdrawAddress,
    // --- multi-account (main + up to 1000 sub wallets, one shared Supabase session) ---
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
      const roster = buildRoster(config.keypair);
      const BATCH = 10;
      const out = [];
      for (let i = 0; i < roster.length; i += BATCH) {
        const batch = roster.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(a => getWalletInfo(a.keypair)));
        for (let j = 0; j < batch.length; j++) {
          const a = batch[j];
          const info = results[j].status === 'fulfilled' ? results[j].value : { sol: 0, farm: 0 };
          const e = reg.get(a.label);
          out.push({ label: a.label, address: a.address, isMain: a.isMain, sol: info.sol, farm: info.farm,
            running: !!e, connected: !!e?.flags?.connected, level: e?.state?.level, gold: e?.state?.gold });
        }
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
    buyStarsMain: (bundleId) => buyStars(rest, bundleId, keypair),
    buyStarsSub: async (bundleId) => {
      const results = [];
      for (const [lbl, engine] of reg) {
        if (engine.isMain) continue;
        try {
          const r = await buyStars(engine.rest, bundleId, engine.keypair);
          results.push({ label: lbl, ...r });
        } catch (e) { results.push({ label: lbl, ok: false, reason: e.message }); }
      }
      return results;
    },
    sendFarmToSubs: async (amountPerSub) => {
      const results = [];
      for (const a of buildRoster(config.keypair)) {
        if (a.isMain) continue;
        const r = await sendFarmTo(a.address, amountPerSub, keypair);
        results.push({ label: a.label, address: a.address, ...r });
      }
      return results;
    },
    sendSolToSubs: async (lamportsPerSub) => {
      const results = [];
      for (const a of buildRoster(config.keypair)) {
        if (a.isMain) continue;
        const r = await sendSolTo(a.address, lamportsPerSub, keypair);
        results.push({ label: a.label, address: a.address, ...r });
      }
      return results;
    },
    retryStars: async () => {
      const pending = getPendingStars();
      if (!pending.length) return [];
      const results = [];
      for (const entry of pending) {
        try {
          const engine = [...reg.values()].find(e => e.addr === entry.wallet);
          if (engine) {
            await bindWallet(engine.rest, engine.keypair);
            const r = await retryPendingStar(engine.rest, entry);
            results.push({ ...entry, ...r });
          } else {
            await bindWallet(rest, keypair);
            const r = await retryPendingStar(rest, entry);
            results.push({ ...entry, ...r });
          }
        } catch (e) { results.push({ ...entry, ok: false, reason: e.message }); }
      }
      return results;
    },
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
      sessionStore.save(session);
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
  reg.set(label, { label, isMain, addr, playerId: session.persistentPlayerId, displayName, state, flags, stats, rest, keypair });

  // Re-auth on (re)connect. Refresh Supabase only when its JWT is near expiry, and
  // REUSE the existing wallet session token until it's near its own 30-min expiry —
  // this avoids hammering the slow /api/auth/wallet/verify endpoint on every reconnect
  // (much more resilient when the server is degraded, and less auth churn = anti-ban).
  async function reauth() {
    // Server-rejected token (forceSupabaseRemint) OR near-expiry → refresh, mint on failure.
    // Use the top-level retry wrapper so a transient captcha/refresh hiccup doesn't crash
    // the reconnect path (sub accounts retry silently; main failures still throw).
    const reminted = await ensureSupabaseFreshWithRetry({ session, rest, sessionStore, tag, isMain, log });
    forceSupabaseRemint = false;
    rest.setBearer(session.access_token);
    // The WS gateway's explicit "Wallet verification required" rejection OVERRIDES the
    // local expiry heuristic: a locally-unexpired token the server no longer honors would
    // otherwise be reused forever (infinite reconnect loop). When forced, re-bind even
    // though walletSessionExpiringSoon() still says the token is fine.
    if (reminted || forceWalletReverify || session.walletAddress !== addr || walletSessionExpiringSoon(session)) {
      const v = await bindWallet(rest, keypair);
      session.walletSessionToken = v.walletSessionToken;
      session.persistentPlayerId = walletSessionPlayerId(session.walletSessionToken) || session.persistentPlayerId;
      session.walletAddress = addr;
      sessionStore.save(session);
      log.info('AUTH', tag + (reminted ? 're-verified wallet (fresh minted session)' : forceWalletReverify ? 're-verified wallet (server rejected session)' : 're-verified wallet (session was expiring)'));
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
      if (ev === 'game:actionResult' && data.ok) log.info('ACT', tag + (data.type || '?') + ' ok' + (data.message ? (' — ' + data.message) : ''));
      if (ev === 'game:actionResult' && data.ok && data.fallingStar?.status === 'claimed') {
        const reward = data.fallingStar.rewardStars || 0;
        log.info('STAR', `${tag}⭐ Falling star claimed! +${reward} star(s) → total ${state.stars}`);
        tg.notify(`${tag}⭐ Falling star collected! +${reward} star(s) (total: ${state.stars})`);
      }
      if (ev === 'game:error' || ev === 'farm:error') log.warn('GAMEERR', tag + (data.code || '?') + ' ' + (data.message || ''));
      if (ev === 'game:actionResult' && data.ok) lastActionAt = Date.now();
      if (ev === 'player:farmState/sync') { const now = Date.now(); if (now - lastStateLog >= 30000) { lastStateLog = now; log.info('STATE', `${tag}gold=${state.gold} lvl=${state.level} stars=${state.stars} | owned=${state.ownedTiles().length} grass=${state.grassEmpty().length} tilled=${state.tilledEmpty().length} ready=${state.readyToHarvest().length} dead=${state.deadCrops().length} blocked=${state.blocked().length} expandable=${state.expandableTiles().length} orders=${state.completableOrders().length}/${state.orders.length} jobs=${state.claimableJobs().length} fallingStars=${state.claimableFallingStars().length}`); } }
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
      log.info('JOINED', tag + 'farm gold=' + state.gold + ' level=' + state.level + ' owned=' + state.ownedTiles().length);
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
  let reconnectAttempt = 0, authFailStreak = 0, degraded = false, forceWalletReverify = false, forceSupabaseRemint = false;
  async function scheduleReconnect(reason) {
    if (reconnecting || !flags.running) return;
    // Server says the wallet session is invalid (not just a transient drop) → force the
    // next reauth() to re-bind the wallet instead of reusing the locally-unexpired token.
    if (walletReverifyRequired(reason)) forceWalletReverify = true;
    // Server rejected the Supabase access token → force next reauth() to refresh/re-mint
    // instead of reconnecting forever with the dead token (the post-restart failure mode).
    if (supabaseRemintRequired(reason)) forceSupabaseRemint = true;
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
        if (supabaseExpiringSoon(session)) {
          const okR = await refreshSupabase(session, rest);
          if (okR) sessionStore.save(session);
          // refresh_token is dead (rotated/expired — the post-restart failure mode). Don't
          // just warn every 60s and rely on the action-path rescue: drive the real recovery
          // here. A reconnect whose reason matches supabaseRemintRequired() forces the next
          // reauth() to ensureSupabaseFresh(true) → re-mint via captcha + re-bind the wallet
          // (same path as a server-rejected token). Self-heals MAIN and stops the once-a-minute
          // "⚠️ Supabase refresh failed" spam (scheduleReconnect notifies once, then the fresh
          // token makes supabaseExpiringSoon() false so this branch goes quiet).
          if (!okR && !reconnecting) scheduleReconnect('invalid_grant: supabase refresh failed');
        }
        // Proactively re-bind the walletSessionToken BEFORE it expires — avoids hitting
        // the slow /api/auth/wallet/verify on every reconnect (each bind is multi-RTT).
        // Best-effort; the reconnect path will pick up the slack if a true re-bind is needed.
        await proactiveWalletRefresh({ session, rest, keypair, sessionStore, tag, walletAddress: addr, log });
        await keepWalletSessionAlive(rest);
      } catch (e) { log.warn('KEEPALIVE', e.message); }
      await sleep(60000);
    }
  })();

  // Farmer's Pool earn loop: contribute claim power to earn $FARM.
  // Server requires minLevel=30 + star gate (3 stars minimum).
  // Contribute repeatedly (~10 min) so share keeps climbing.
  // Pool-timing-aware: polls faster near opensAt, notifies about early bird window.
  let poolNotified = false, poolLastSummary = 0, starGateWarned = false, poolOpenNotified = false, earlyBirdNotified = false;
  (async function farmerPoolLoop() {
    while (flags.running) {
      if (!config.pool.enabled) {
        await sleep(gaussianDelay(540000, 660000));
        continue;
      }
      // On boot/reconnect the loop can start before the socket joins and before the
      // first farmState sync updates level from the default L1. Retry readiness checks
      // quickly so pool contribution starts soon after "server up / auto-rejoined"
      // instead of sleeping a full 9-11 minutes.
      if (!flags.connected || state.level <= 1) {
        await sleep(gaussianDelay(30000, 60000));
        continue;
      }
      if (state.level < 30) {
        await sleep(gaussianDelay(540000, 660000));
        continue;
      }
      try {
        const status = await pollFarmerPool(rest);
        if (status?.player && !status.player.meetsStarGate && !starGateWarned) {
          starGateWarned = true;
          tg.notify(`${tag}⚠️ Pool star gate: need ${status.player.minStarsToEnter || 3} stars (have ${status.player.starsPurchasedThisEvent || 0}). Collect falling stars or buy via /starmain to unlock pool.`);
        }
        if (status?.player?.meetsStarGate) starGateWarned = false;

        const timing = poolTiming(status);
        // Track live pool open state — farming loop uses this to set sacrificeRatio
        flags.poolIsOpen = timing?.isOpen ?? false;
        if (timing) {
          if (!timing.isOpen && timing.msUntilOpen != null && timing.msUntilOpen > 0) {
            if (!poolOpenNotified) {
              const hrs = Math.round(timing.msUntilOpen / 3600000 * 10) / 10;
              if (hrs <= 24) tg.notify(`${tag}🏊 Pool opens in ${hrs}h (${new Date(timing.opensAt).toISOString()}). Early bird +10% in first 6h!`);
              poolOpenNotified = true;
            }
            const waitMs = Math.min(timing.msUntilOpen + 5000, gaussianDelay(540000, 660000));
            await sleep(waitMs);
            continue;
          }
          if (timing.isOpen && timing.isEarlyBird && !earlyBirdNotified) {
            earlyBirdNotified = true;
            const mins = Math.round((timing.msUntilEarlyBirdEnd || 0) / 60000);
            tg.notify(`${tag}🐦 Pool EARLY BIRD active! +10% power bonus for ${mins} more minutes. Auto-contributing now.`);
          }
        }
      } catch { flags.poolIsOpen = false; }

      const r = await maybeContribute(rest, { tag, burnGold: settings.poolBurnGold, goldReserve: config.pool.goldReserve, burnLevels: config.pool.burnLevels, levelFloor: config.pool.levelFloor, sacrificeAt: config.pool.sacrificeAt, currentLevel: state.level, cropInventory: state.cropInventory });
      if (r?.contributed) {
        if (r.contribution?.cropSacrifices) {
          for (const [cropId, qty] of Object.entries(r.contribution.cropSacrifices)) {
            state.cropInventory[cropId] = Math.max(0, Number(state.cropInventory[cropId] || 0) - Number(qty || 0));
          }
        }
        const cropSac = decideCropSacrifice(state.cropInventory);
        if (cropSac) {
          const parts = Object.entries(cropSac.crops).map(([c, n]) => `${n} ${c}`).join(', ');
          log.info('FARMPOOL', `${tag}crop sacrifice sent: ${parts} = +${cropSac.totalPower} power`);
        }
        const now = Date.now();
        const earlyTag = r.timing?.isEarlyBird ? ' [EARLY BIRD]' : '';
        if (!poolNotified) { poolNotified = true; poolLastSummary = now; tg.notify(`${tag}💎 Farmer's Pool is open${earlyTag} — auto-contributing to earn $FARM. /pool for details.`); }
        else if (now - poolLastSummary > 7200000) {
          poolLastSummary = now;
          try { const st = await pollFarmerPool(rest); const me = st?.player; if (me) tg.notify(`${tag}💎 Pool today: power ${me.contributedClaimPowerToday || 0} • est. payout ${(Number(me.estimatedPayoutRaw || 0) / 1e6).toFixed(2)} $FARM${earlyTag}`); } catch {}
        }
      } else if (r?.pool && r.pool !== 'active') {
        poolNotified = false; poolOpenNotified = false; earlyBirdNotified = false;
      } else if (!r?.ok && r?.reason === 'status-unavailable') {
        flags.poolIsOpen = false;
        log.warn('FARMPOOL', `${tag}pool status unreachable — server may still be degraded, retrying in 2-5min`);
      }

      // 409 = server rate-limit on claims — back off 15-20 min before retrying.
      const rateLimited = r?.claimStatus === 409;
      const loopDelay = rateLimited
        ? gaussianDelay(900000, 1200000)
        : gaussianDelay(120000, 300000); // 2-5 min regardless of early bird
      if (rateLimited) log.info('FARMPOOL', `${tag}rate-limited (409) — backing off ${Math.round(loopDelay / 60000)}min`);
      await sleep(loopDelay);
    }
  })();

  // Auto-sweep DISABLED — $FARM stays in sub wallets until manual /sweep command.
  // (async function autoSweepLoop() {
  //   if (!isMain) return;
  //   while (flags.running) {
  //     await sleep(gaussianDelay(5400000, 6600000));
  //     try {
  //       const roster = buildRoster(config.keypair).filter(a => !a.isMain);
  //       if (!roster.length) continue;
  //       const mainAddr = config.keypair.publicKey.toBase58();
  //       let sent = 0, n = 0;
  //       for (const a of roster) { const r = await withdrawFarm(mainAddr, a.keypair); if (r.ok) { sent += r.amount || 0; n++; } }
  //       if (n > 0) tg.notify(`🧹 Auto-swept ${n} sub-wallet(s): ${Math.floor(sent)} $FARM → main wallet.`);
  //     } catch (e) { log.warn('SWEEP', e.message); }
  //   }
  // })();

  while (flags.running) {
    try {
      const active = withinActiveHours(settings.activeHours);
      if (flags.connected && !flags.paused && flags.autopilot && active) {
        while (manualQueue.length) { const m = manualQueue.shift(); await handleManual(m, { state, runner, flags, gs, settings, reconnect: () => scheduleReconnect('manual') }); }
        const timeBudgetSeconds = secondsUntilInactive(settings.activeHours);
        const ecoForPlant = flags.forceCrop && eco[flags.forceCrop] ? { [flags.forceCrop]: eco[flags.forceCrop] } : eco;
        // Below pool minLevel while pool is active → prioritize XP to reach eligibility faster.
        const poolMinLevel = config.pool?.sacrificeAt || 30;
        const autoXp = config.pool.enabled && state.level < poolMinLevel && !flags.forceCrop;
        const effectiveObjective = autoXp ? 'xp' : flags.objective;
        // sacrificeRatio: 0.5 only when pool is confirmed OPEN via live poll — not just config flag.
        // When pool is closed/unreachable, plant max-profit crops to build gold faster.
        const sacrificeRatio = (config.pool.enabled && flags.poolIsOpen) ? 0.5 : 0;
        const plan = [
          ...planClaims(state),
          ...planAnimalActions(state),
          ...planActions(state, ecoForPlant, { objective: effectiveObjective, timeBudgetSeconds, goldReserve: settings.goldReserve, sacrificeRatio }),
          ...planStorage(state),
          ...planBarnInvestment(state, { goldReserve: settings.goldReserve }),
        ];
        if (plan.length) {
          for (const a of plan) {
            if (!flags.running || flags.paused) break;
            const ok = await runner.do(a.event, a.payload, a.meta);
            if (ok) lastActionAt = Date.now();
            else log.warn('ACTFAIL', `${tag}${a.kind || a.event} failed payload=${JSON.stringify(a.payload).slice(0, 180)}`);
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
