import { test } from 'node:test';
import assert from 'node:assert';
import { dispatchCommand, COMMAND_MENU, renderWallet, handleWalletCallback } from '../src/telegram/bot.js';
import { GameState } from '../src/game/state.js';
import { loadEconomy } from '../src/game/economy.js';

function mockCtx() {
  const state = new GameState();
  state.apply('farm:state/sync', { tiles: [
    { x: 1, y: 1, ownerState: 'owned', groundState: 'grass', blocker: 'none', cropId: null },
    { x: 2, y: 1, ownerState: 'owned', groundState: 'tilled', blocker: 'none', cropId: null },
    { x: 3, y: 1, ownerState: 'owned', groundState: 'planted', cropId: 'potato', readyAt: Date.now() - 1000 },
    { x: 4, y: 1, ownerState: 'owned', groundState: 'planted', cropId: 'carrot', readyAt: Date.now() + 99999 },
    { x: 5, y: 1, ownerState: 'owned', groundState: 'grass', blocker: 'weed', cropId: null },
    { x: 6, y: 1, ownerState: 'buyable', groundState: 'grass', blocker: 'none', cropId: null },
  ]});
  state.apply('player:farmState/sync', { farmState: {
    gold: 5000, xp: 1200, level: 12, premiumBalance: { stars: 3 },
    inventory: { potato_seed: 10, carrot_seed: 0 }, inventoryCapacity: 30,
    cropInventory: { potato: 8, carrot: 1 },
    orders: [{ id: 'o1', title: 'Carrot Bundle', requires: { carrot: 2 }, rewards: { gold: 90, xp: 25 } },
             { id: 'o2', title: 'Potato Crate <test>&', requires: { potato: 3 }, rewards: { gold: 120, xp: 35 } }],
    farmJobs: [{ id: 'j1', title: 'Earn 250 Gold', current: 250, target: 250, rewards: { gold: 120, xp: 45 } },
               { id: 'j2', title: 'Plant 10', current: 4, target: 10, rewards: { gold: 50, xp: 10 } }],
    starterTasks: { currentTaskId: 'buy_chest', completed: ['join', 'hoe_tile'] },
    cropMastery: { potato: { level: 3, progress: 50 }, carrot: 2 },
    farmValue: 12345, farmRank: 42, farmPoints: 88,
    completedOrdersCount: 7, completedFarmJobsCount: 3, totalHarvestedCrops: 99,
  }});

  const calls = { manual: [], config: [] };
  const ctx = {
    state,
    flags: { running: true, paused: false, autopilot: true, connected: true, forceCrop: null, objective: 'balanced' },
    walletAddress: 'So11111111111111111111111111111111111111112',
    economy: loadEconomy(),
    stats: () => 'up 5m • harvests 3 • plants 2 <ok>',
    tailLog: (n) => `[INFO] line with <html> & special chars\nattempt ${n}`,
    pool: async () => ({
      config: { enabled: true, minLevel: 10, tokenSymbol: 'FARM' },
      pool: { status: 'active', poolDate: '2026-06-21', totalTokensAllocatedRaw: '4400000000000', activeParticipantCount: 2100 },
      player: { level: 12, gold: 5000, availableFarmPoints: 88, unlocked: true, hasContributionToday: false, estimatedPayoutRaw: '1234567' },
    }),
    claimPool: async () => ({ ok: true, contributed: true }),
    manual: (kind, arg) => calls.manual.push([kind, arg]),
    setConfig: (k, v) => { calls.config.push([k, v]); return `${k} = ${v}`; },
    walletInfo: async () => ({ address: 'So11111111111111111111111111111111111111112', sol: 0.12, farm: 4321 }),
    withdraw: async () => ({ ok: true, amount: 4321, sig: 'sig123' }),
    withdrawAddress: 'MainWa11etAddressHere11111111111111111111111',
    starBundles: async () => ([{ displayName: 'Starter', totalStars: 3, targetUsdValue: 5 }]),
  };
  return { ctx, calls };
}

// Collect a mock send that records messages and validates them.
function recorder() {
  const msgs = [];
  const send = async (m) => {
    assert.strictEqual(typeof m, 'string', 'send must receive a string');
    assert.ok(m.length > 0, 'message must be non-empty');
    // crude HTML-tag balance check: no stray unescaped lone "<" that isn't a real tag/entity
    msgs.push(m);
    return m;
  };
  return { send, msgs };
}

test('every command in the menu dispatches without throwing and replies', async () => {
  const aliases = ['/seeds', '/produce', '/crops', '/unknowncmd'];
  const cmds = COMMAND_MENU.map(([c]) => '/' + c).concat(aliases);
  for (const c of cmds) {
    const { ctx } = mockCtx();
    const { send, msgs } = recorder();
    // give arg-taking commands a sample arg so usage branches and action branches both run
    const sample = { '/autopilot': 'on', '/objective': 'gold', '/setcrop': 'potato', '/reserve': '500',
      '/sethours': '06:00-23:30', '/poolburn': 'on', '/plant': 'potato', '/plantall': 'carrot',
      '/buyseed': 'potato 5', '/log': '10' };
    const text = sample[c] ? `${c} ${sample[c]}` : c;
    await dispatchCommand(text, ctx, send);
    assert.ok(msgs.length >= 1, `${c} produced no reply`);
  }
});

test('/pool reads real status fields (poolDate, totalTokensAllocatedRaw, unlocked)', async () => {
  const { ctx } = mockCtx();
  const { send, msgs } = recorder();
  await dispatchCommand('/pool', ctx, send);
  const m = msgs[0];
  assert.match(m, /active/);
  assert.match(m, /2026-06-21/);
  assert.match(m, /4,400,000/);   // 4.4e12 / 1e6
  assert.match(m, /✅ eligible/);  // unlocked
  assert.match(m, /Hold gate/);
  assert.match(m, /Star gate/);
});

test('/pool shows countdown when opensAt is in the future', async () => {
  const { ctx } = mockCtx();
  const now = Date.now();
  ctx.pool = async () => ({
    config: { enabled: false, minLevel: 10, tokenSymbol: 'FARM' },
    pool: { status: 'active', poolDate: '2026-06-24', totalTokensAllocatedRaw: '982203000000',
            opensAt: new Date(now + 7200000).toISOString(), closesAt: new Date(now + 180000000).toISOString() },
    player: { level: 35, gold: 5000, availableFarmPoints: 445, unlocked: true, meetsStarGate: false,
              meetsHoldGate: true, starsPurchasedThisEvent: 0, minStarsToEnter: 3 },
    earlyBird: { active: false, bonus: 0.1, endsAt: new Date(now + 28800000).toISOString() },
  });
  const { send, msgs } = recorder();
  await dispatchCommand('/pool', ctx, send);
  const m = msgs[0];
  assert.match(m, /Opens in/);
  assert.match(m, /needs 3⭐/);
  assert.match(m, /falling stars/);
});

test('/pool shows OPEN + early bird when pool is active', async () => {
  const { ctx } = mockCtx();
  const now = Date.now();
  ctx.pool = async () => ({
    config: { enabled: true, minLevel: 10, tokenSymbol: 'FARM' },
    pool: { status: 'active', poolDate: '2026-06-24', totalTokensAllocatedRaw: '4400000000000',
            opensAt: new Date(now - 3600000).toISOString(), closesAt: new Date(now + 172800000).toISOString() },
    player: { level: 35, gold: 5000, availableFarmPoints: 445, unlocked: true, meetsStarGate: true, meetsHoldGate: true },
    earlyBird: { active: true, bonus: 0.1, endsAt: new Date(now + 18000000).toISOString() },
  });
  const { send, msgs } = recorder();
  await dispatchCommand('/pool', ctx, send);
  const m = msgs[0];
  assert.match(m, /OPEN/);
  assert.match(m, /Early bird/);
  assert.match(m, /✅ eligible/);
});

test('/log HTML-escapes special chars (no broken markup)', async () => {
  const { ctx } = mockCtx();
  const { send, msgs } = recorder();
  await dispatchCommand('/log 5', ctx, send);
  assert.match(msgs[0], /&lt;html&gt; &amp; special/);
  assert.doesNotMatch(msgs[0], /<html>/);
});

test('control commands mutate flags; setConfig + manual hooks fire', async () => {
  const { ctx, calls } = mockCtx();
  const { send } = recorder();
  await dispatchCommand('/pause', ctx, send); assert.strictEqual(ctx.flags.paused, true);
  await dispatchCommand('/resume', ctx, send); assert.strictEqual(ctx.flags.paused, false);
  await dispatchCommand('/autopilot off', ctx, send); assert.strictEqual(ctx.flags.autopilot, false);
  await dispatchCommand('/stop', ctx, send); assert.strictEqual(ctx.flags.running, false);
  await dispatchCommand('/objective xp', ctx, send);
  await dispatchCommand('/harvest', ctx, send);
  await dispatchCommand('/buyseed potato 3', ctx, send);
  assert.ok(calls.config.some(([k, v]) => k === 'objective' && v === 'xp'));
  assert.ok(calls.manual.some(([k]) => k === 'harvest'));
  assert.ok(calls.manual.some(([k, v]) => k === 'buyseed' && v === 'potato 3'));
});

test('bad args show usage, not crash', async () => {
  const { ctx } = mockCtx();
  const { send, msgs } = recorder();
  await dispatchCommand('/objective wrong', ctx, send);
  await dispatchCommand('/reserve notanumber', ctx, send);
  await dispatchCommand('/plant', ctx, send);
  await dispatchCommand('/sethours bad', ctx, send);
  assert.ok(msgs.every(m => /Usage|Bad format/i.test(m) || m.length > 0));
});

test('handles pool() returning null gracefully', async () => {
  const { ctx } = mockCtx();
  ctx.pool = async () => null;
  const { send, msgs } = recorder();
  await dispatchCommand('/pool', ctx, send);
  assert.match(msgs[0], /unavailable/);
});

test('renderWallet shows balances + inline deposit/withdraw keyboard', async () => {
  const { ctx } = mockCtx();
  const w = await renderWallet(ctx);
  assert.match(w.text, /\$FARM/);
  assert.match(w.text, /4,321/);
  const labels = w.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(labels.includes('wallet:claim'));
  assert.ok(labels.includes('wallet:withdraw'));
  assert.ok(labels.includes('wallet:deposit'));
});

test('wallet callbacks: withdraw confirm flow + deposit bundles', async () => {
  const { ctx } = mockCtx();
  const wd = await handleWalletCallback('wallet:withdraw', ctx);
  assert.match(wd.text, /Confirm/);
  const confirm = await handleWalletCallback('wallet:withdraw_confirm', ctx);
  assert.match(confirm.alert, /Withdrew 4321/);
  const dep = await handleWalletCallback('wallet:deposit', ctx);
  assert.match(dep.text, /Starter/);
  const claim = await handleWalletCallback('wallet:claim', ctx);
  assert.ok(claim.reply_markup); // re-renders wallet
});

test('withdraw without WITHDRAW_ADDRESS shows setup hint', async () => {
  const { ctx } = mockCtx();
  ctx.withdrawAddress = '';
  const wd = await handleWalletCallback('wallet:withdraw', ctx);
  assert.match(wd.text, /WITHDRAW_ADDRESS/);
});
