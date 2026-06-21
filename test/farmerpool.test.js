import { test } from 'node:test';
import assert from 'node:assert';
import { decideContribution } from '../src/game/farmerpool.js';

const base = {
  config: { enabled: true, minLevel: 10, goldPerPower: 250000, farmPointsPerPower: 100, claimPowerPerBurnedLevel: 3 },
  pool: { status: 'active' },
  player: { level: 12, gold: 500000, availableFarmPoints: 40, burnableLevels: 2, hasContributionToday: false },
};

test('contributes farm points by default, never gold/levels', () => {
  const c = decideContribution(base);
  assert.deepStrictEqual(c, { farmPointsToBurn: 40, goldToBurn: 0, levelsToBurn: 0 });
});

test('burnGold spends surplus above reserve', () => {
  const c = decideContribution(base, { burnGold: true, goldReserve: 100000 });
  assert.strictEqual(c.goldToBurn, 400000);
  assert.strictEqual(c.farmPointsToBurn, 40);
});

test('skips when below minLevel', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, level: 5 } }), null);
});

test('skips when pool not active', () => {
  assert.strictEqual(decideContribution({ ...base, pool: { status: 'paused' } }), null);
});

test('skips when already contributed today', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, hasContributionToday: true } }), null);
});

test('skips when nothing to contribute', () => {
  assert.strictEqual(decideContribution({ ...base, player: { ...base.player, availableFarmPoints: 0 } }), null);
});
