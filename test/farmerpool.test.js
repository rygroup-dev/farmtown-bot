import { test } from 'node:test';
import assert from 'node:assert';
import { decideContribution } from '../src/game/farmerpool.js';

const base = {
  config: { enabled: true, minLevel: 10, goldPerPower: 250000, farmPointsPerPower: 100, claimPowerPerBurnedLevel: 3 },
  pool: { status: 'active' },
  player: { level: 12, gold: 500000, availableFarmPoints: 250, burnableLevels: 2, hasContributionToday: false, unlocked: true },
};

test('contributes farm points by default, never gold/levels', () => {
  const c = decideContribution(base);
  // 250 FP → 200 burned (2 whole power), 50 kept for next time
  assert.deepStrictEqual(c, { farmPointsToBurn: 200, goldToBurn: 0, levelsToBurn: 0 });
});

test('burns farm points only in whole-power multiples (no waste)', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, availableFarmPoints: 199 } }).farmPointsToBurn, 100);
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, availableFarmPoints: 300 } }).farmPointsToBurn, 300);
  // <1 power and nothing else → skip entirely (keep accumulating)
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, availableFarmPoints: 40 } }), null);
});

test('burnGold spends surplus above reserve, floored to whole power', () => {
  const c = decideContribution(base, { burnGold: true, goldReserve: 100000 });
  // surplus 400000 → floor to 250000 (1 power), keeps 150000
  assert.strictEqual(c.goldToBurn, 250000);
  assert.strictEqual(c.farmPointsToBurn, 200);
});

test('burnGold never goes below reserve', () => {
  const c = decideContribution({ ...base, player: { ...base.player, gold: 120000 } }, { burnGold: true, goldReserve: 100000 });
  // surplus 20000 < 250000 → 0 gold power
  assert.strictEqual(c.goldToBurn, 0);
});

test('NEVER burns levels by default, even with burnable levels available', () => {
  const c = decideContribution({ ...base, player: { ...base.player, burnableLevels: 12 } });
  assert.strictEqual(c.levelsToBurn, 0);
});

test('burns levels only when explicitly opted in', () => {
  const c = decideContribution(base, { burnLevels: true });
  assert.strictEqual(c.levelsToBurn, 2);
});

test('contributes REPEATEDLY — hasContributionToday does NOT stop it', () => {
  const c = decideContribution({ ...base, player: { ...base.player, hasContributionToday: true, contributionCountToday: 50 } });
  assert.strictEqual(c.farmPointsToBurn, 200);
});

test('skips when below minLevel and not unlocked', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, level: 5, unlocked: false } }), null);
});

test('contributes when server says unlocked even if level cache is stale-low', () => {
  const c = decideContribution({ ...base, player: { ...base.player, level: 2, unlocked: true } });
  assert.strictEqual(c.farmPointsToBurn, 200);
});

test('skips when pool not active', () => {
  assert.strictEqual(decideContribution({ ...base, pool: { status: 'paused' } }), null);
});

test('skips when nothing reaches a whole power', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, availableFarmPoints: 0 } }), null);
});
