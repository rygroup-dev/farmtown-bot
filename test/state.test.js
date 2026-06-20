import { test } from 'node:test';
import assert from 'node:assert';
import { GameState } from '../src/game/state.js';

test('applies farmState sync', () => {
  const s = new GameState();
  s.apply('player:farmState/sync', { farmState: { gold: 100, xp: 5, level: 2, premiumBalance:{stars:3}, inventory:{ potato_seed: 5 } } });
  assert.strictEqual(s.gold, 100);
  assert.strictEqual(s.stars, 3);
  assert.strictEqual(s.inventory.potato_seed, 5);
});

test('applies tile updates and indexes owned/ready tiles', () => {
  const s = new GameState();
  s.apply('tile:update', { tile: { x:25, y:23, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null } });
  s.apply('tile:update', { tile: { x:25, y:24, ownerState:'owned', groundState:'planted', cropId:'potato', plantedAt: Date.now()-10000, readyAt: Date.now()-1 } });
  assert.strictEqual(s.tilledEmpty().length, 1);
  assert.strictEqual(s.readyToHarvest().length, 1);
});
