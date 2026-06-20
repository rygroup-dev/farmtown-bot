import { test } from 'node:test';
import assert from 'node:assert';
import { loadEconomy, rankCrops, profitPerHour } from '../src/game/economy.js';

test('profitPerHour computes (sell-cost)/hours', () => {
  const c = { cost: 3, sell: 9, growSeconds: 3600 };
  assert.strictEqual(profitPerHour(c), 6);
});

test('rankCrops orders by score and respects affordability + level', () => {
  const eco = {
    a: { id: 'a', cost: 1, sell: 5, growSeconds: 3600, xp: 1, unlockLevel: 1 },
    b: { id: 'b', cost: 100, sell: 200, growSeconds: 3600, xp: 1, unlockLevel: 1 },
    c: { id: 'c', cost: 1, sell: 999, growSeconds: 3600, xp: 1, unlockLevel: 99 },
  };
  const ranked = rankCrops(eco, { gold: 10, level: 1, objective: 'gold' });
  assert.strictEqual(ranked[0].id, 'a');
});
