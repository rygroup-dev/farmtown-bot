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

test('completableOrders + cropDemand use cropInventory', () => {
  const s = new GameState();
  s.apply('player:farmState/sync', { farmState: {
    cropInventory: { potato: 5, carrot: 1 },
    orders: [
      { id:'o1', requires:{ potato:3 }, rewards:{gold:90,xp:25} },
      { id:'o2', requires:{ carrot:2 }, rewards:{gold:50,xp:10} }
    ]
  } });
  assert.strictEqual(s.completableOrders().length, 1);
  assert.strictEqual(s.completableOrders()[0].id, 'o1');
  assert.strictEqual(s.cropDemand().potato, 3);
  assert.strictEqual(s.cropDemand().carrot, 2);
});

test('claimableJobs returns jobs where current >= target', () => {
  const s = new GameState();
  s.apply('player:farmState/sync', { farmState: {
    farmJobs: [
      { id:'j1', current:5, target:5, rewards:{gold:10,xp:5} },
      { id:'j2', current:2, target:10, rewards:{gold:20,xp:10} }
    ]
  } });
  assert.strictEqual(s.claimableJobs().length, 1);
  assert.strictEqual(s.claimableJobs()[0].id, 'j1');
});

test('starterTasks applied from farmState sync', () => {
  const s = new GameState();
  s.apply('player:farmState/sync', { farmState: {
    starterTasks: { currentTaskId: 'task3', completed: ['task1', 'task2'], starterSeedsGranted: true }
  } });
  assert.strictEqual(s.starterTasks.currentTaskId, 'task3');
  assert.strictEqual(s.starterTasks.completed.length, 2);
});

test('inventoryCapacity defaults to 30 and syncs from farmState', () => {
  const s = new GameState();
  assert.strictEqual(s.inventoryCapacity, 30);
  s.apply('player:farmState/sync', { farmState: { inventoryCapacity: 75 } });
  assert.strictEqual(s.inventoryCapacity, 75);
});

test('seedCount sums all seed inventory values', () => {
  const s = new GameState();
  s.inventory = { potato_seed: 10, carrot_seed: 5, tomato_seed: 0 };
  assert.strictEqual(s.seedCount(), 15);
});

test('seedCount returns 0 for empty inventory', () => {
  const s = new GameState();
  assert.strictEqual(s.seedCount(), 0);
});
