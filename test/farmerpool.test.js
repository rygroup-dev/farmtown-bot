import { test } from 'node:test';
import assert from 'node:assert';
import { decideContribution, poolTiming, decideCropSacrifice, SACRIFICE_CROPS } from '../src/game/farmerpool.js';

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

test('level-sacrifice: burns down to floor only once at sacrificeAt, capped by burnableLevels', () => {
  const p = (lvl, burnable) => ({ ...base, player: { ...base.player, level: lvl, burnableLevels: burnable, availableFarmPoints: 0 } });
  // L30, floor 13 → 17 levels; live currentLevel overrides
  let c = decideContribution(p(30, 20), { burnLevels: true, levelFloor: 13, sacrificeAt: 30, currentLevel: 30 });
  assert.strictEqual(c.levelsToBurn, 17);
  // not yet at sacrificeAt (L25) → 0
  c = decideContribution(p(25, 15), { burnLevels: true, levelFloor: 13, sacrificeAt: 30, currentLevel: 25 });
  assert.strictEqual(c, null); // nothing else to burn either → null
  // capped by server burnableLevels (only 10 allowed) even though 30-13=17
  c = decideContribution(p(30, 10), { burnLevels: true, levelFloor: 13, sacrificeAt: 30, currentLevel: 30 });
  assert.strictEqual(c.levelsToBurn, 10);
});

test('level-sacrifice uses live currentLevel over stale pool cache, never below floor', () => {
  const stale = { ...base, player: { ...base.player, level: 2, burnableLevels: 20, availableFarmPoints: 0 } };
  const c = decideContribution(stale, { burnLevels: true, levelFloor: 13, sacrificeAt: 30, currentLevel: 30 });
  assert.strictEqual(c.levelsToBurn, 17); // floor 13 respected: 30-13
});

test('level-sacrifice off by default (no accidental burns)', () => {
  const c = decideContribution({ ...base, player: { ...base.player, level: 30, burnableLevels: 20 } }, { currentLevel: 30 });
  assert.strictEqual(c.levelsToBurn, 0);
});

// --- Pool Timing ---

test('poolTiming reports isOpen when now is between opensAt and closesAt', () => {
  const now = Date.now();
  const t = poolTiming({ pool: { opensAt: new Date(now - 3600000).toISOString(), closesAt: new Date(now + 3600000).toISOString() }, earlyBird: {} });
  assert.strictEqual(t.isOpen, true);
});

test('poolTiming reports not open when before opensAt', () => {
  const now = Date.now();
  const t = poolTiming({ pool: { opensAt: new Date(now + 3600000).toISOString(), closesAt: new Date(now + 7200000).toISOString() }, earlyBird: {} });
  assert.strictEqual(t.isOpen, false);
  assert.ok(t.msUntilOpen > 0);
});

test('poolTiming early bird detection', () => {
  const now = Date.now();
  const t = poolTiming({
    pool: { opensAt: new Date(now - 1000).toISOString(), closesAt: new Date(now + 172800000).toISOString() },
    earlyBird: { active: true, bonus: 0.1, endsAt: new Date(now + 21600000).toISOString() },
  });
  assert.strictEqual(t.isOpen, true);
  assert.strictEqual(t.isEarlyBird, true);
});

test('decideContribution skips when pool has opensAt in the future', () => {
  const now = Date.now();
  const status = {
    ...base,
    pool: { ...base.pool, opensAt: new Date(now + 3600000).toISOString(), closesAt: new Date(now + 172800000).toISOString() },
  };
  assert.strictEqual(decideContribution(status), null);
});

test('decideContribution contributes when pool opensAt is in the past', () => {
  const now = Date.now();
  const status = {
    ...base,
    pool: { ...base.pool, opensAt: new Date(now - 3600000).toISOString(), closesAt: new Date(now + 3600000).toISOString() },
  };
  const c = decideContribution(status);
  assert.strictEqual(c.farmPointsToBurn, 200);
});

// --- Crop Sacrifice ---

test('SACRIFICE_CROPS has starfruit=2 and crystal_berry=1 power', () => {
  assert.strictEqual(SACRIFICE_CROPS.starfruit, 2);
  assert.strictEqual(SACRIFICE_CROPS.crystal_berry, 1);
});

test('decideCropSacrifice burns surplus above reserve', () => {
  const r = decideCropSacrifice({ starfruit: 20, crystal_berry: 15 }, { reservePerCrop: 5 });
  assert.deepStrictEqual(r.crops, { starfruit: 15, crystal_berry: 10 });
  assert.strictEqual(r.totalPower, 15 * 2 + 10 * 1);
});

test('decideCropSacrifice returns null when nothing to burn', () => {
  assert.strictEqual(decideCropSacrifice({ starfruit: 3, crystal_berry: 2 }, { reservePerCrop: 5 }), null);
  assert.strictEqual(decideCropSacrifice({}), null);
});
