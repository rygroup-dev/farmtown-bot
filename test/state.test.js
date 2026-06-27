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
  s.apply('tile:update', { tile: { x:25, y:24, ownerState:'owned', groundState:'planted', cropId:'potato', plantedAt: Date.now()-10000, readyAt: Date.now()-5000 } });
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

test('actionResult updates gold/xp/level from server after buy or sacrifice', () => {
  const s = new GameState();
  s.gold = 36623;
  s.xp = 1000;
  s.level = 30;
  s.apply('game:actionResult', {
    ok: true,
    type: 'buySeed',
    goldAfter: 11623,
    xpAfter: 1000,
    levelAfter: 30,
    inventoryDelta: { seeds: { crystal_berry_seed: 1 } },
  });
  assert.strictEqual(s.gold, 11623);
  assert.strictEqual(s.xp, 1000);
  assert.strictEqual(s.level, 30);
  assert.strictEqual(s.inventory.crystal_berry_seed, 1);
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

test('expandableTiles returns only locked tiles adjacent to owned', () => {
  const s = new GameState();
  s.apply('farm:state/sync', { tiles: [
    { x: 5, y: 5, ownerState: 'owned', groundState: 'cleared', blocker: 'none' },
    { x: 6, y: 5, ownerState: 'locked' },  // adjacent → expandable
    { x: 5, y: 6, ownerState: 'locked' },  // adjacent → expandable
    { x: 9, y: 9, ownerState: 'locked' },  // far → not
  ]});
  const e = s.expandableTiles().map(t => `${t.x},${t.y}`).sort();
  assert.deepStrictEqual(e, ['5,6', '6,5']);
});

test('fallingStars tracked from snapshot and claimed/expired removed', () => {
  const s = new GameState();
  const now = Date.now();
  s.apply('farm:snapshot', { tiles: [], fallingStars: [
    { id: 'fs1', tileX: 3, tileY: 4, rewardStars: 1, status: 'spawned', spawnedAt: now, expiresAt: now + 60000 },
    { id: 'fs2', tileX: 5, tileY: 6, rewardStars: 2, status: 'spawned', spawnedAt: now, expiresAt: now + 60000 },
  ]});
  assert.strictEqual(s.claimableFallingStars().length, 2);

  s.apply('game:actionResult', { ok: true, fallingStar: { id: 'fs1', status: 'claimed', rewardStars: 1 }, premiumBalance: { stars: 1 } });
  assert.strictEqual(s.fallingStars.length, 1);
  assert.strictEqual(s.stars, 1);

  s.apply('game:actionResult', { ok: true, fallingStar: { id: 'fs2', status: 'expired' } });
  assert.strictEqual(s.fallingStars.length, 0);
});

test('fallingStars updated from actionResult with full array', () => {
  const s = new GameState();
  const now = Date.now();
  s.apply('game:actionResult', { ok: true, fallingStars: [
    { id: 'fs3', tileX: 1, tileY: 1, rewardStars: 1, status: 'spawned', expiresAt: now + 60000 },
  ]});
  assert.strictEqual(s.claimableFallingStars().length, 1);
});

test('expired fallingStars not returned by claimableFallingStars', () => {
  const s = new GameState();
  const now = Date.now();
  s.fallingStars = [
    { id: 'fs4', status: 'spawned', expiresAt: now - 1000 },
    { id: 'fs5', status: 'spawned', expiresAt: now + 60000 },
  ];
  assert.strictEqual(s.claimableFallingStars().length, 1);
  assert.strictEqual(s.claimableFallingStars()[0].id, 'fs5');
});

test('readyToHarvest harvests overdue-but-ready crops (server groundState=ready, diesAt passed)', () => {
  const s = new GameState();
  const now = Date.now();
  // ripe per server (groundState 'ready') but diesAt already passed → must STILL harvest
  s.tiles.set('1,0', { x:1,y:0, ownerState:'owned', groundState:'ready', cropId:'carrot', readyAt: now-60000, diesAt: now-1000 });
  // genuinely dead → NOT harvested (handled by clearDead)
  s.tiles.set('2,0', { x:2,y:0, ownerState:'owned', groundState:'dead', cropId:'corn', readyAt: now-60000, diesAt: now-1000 });
  // timing-ripe fallback (planted, readyAt passed, not dead)
  s.tiles.set('3,0', { x:3,y:0, ownerState:'owned', groundState:'planted', cropId:'wheat', readyAt: now-5000 });
  const ready = s.readyToHarvest().map(t => t.cropId).sort();
  assert.deepStrictEqual(ready, ['carrot', 'wheat']);
  assert.strictEqual(s.deadCrops().length, 1);
});
