import { test } from 'node:test';
import assert from 'node:assert';
import { planActions, planClaims, planStorage } from '../src/game/brain.js';
import { GameState } from '../src/game/state.js';

const eco = { potato: { id:'potato', seedId:'potato_seed', cost:3, sell:6, growSeconds:60, xp:1, unlockLevel:1 } };

test('plans harvest before plant', () => {
  const s = new GameState();
  s.gold = 100; s.inventory.potato_seed = 5;
  s.tiles.set('25,24', { x:25,y:24, ownerState:'owned', groundState:'planted', cropId:'potato', readyAt: Date.now()-5000 });
  s.tiles.set('25,25', { x:25,y:25, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null });
  const plan = planActions(s, eco, { objective:'gold' });
  assert.strictEqual(plan[0].kind, 'harvest');
});

test('hoes grass then plants when seeds available', () => {
  const s = new GameState();
  s.gold = 100; s.inventory.potato_seed = 5;
  s.tiles.set('25,25', { x:25,y:25, ownerState:'owned', groundState:'grass', blocker:'none', cropId:null });
  const plan = planActions(s, eco, { objective:'gold' });
  const kinds = plan.map(p=>p.kind);
  assert.ok(kinds.includes('hoe'));
});

test('planClaims emits starter, completable orders, claimable jobs', () => {
  const s = new GameState();
  s.starterTasks = { currentTaskId: 'task1', completed: [] };
  s.orders = [
    { id:'o1', requires:{ potato:3 }, rewards:{gold:90,xp:25} },
    { id:'o2', requires:{ carrot:2 }, rewards:{gold:50,xp:10} }
  ];
  s.cropInventory = { potato: 5, carrot: 1 };
  s.farmJobs = [
    { id:'j1', current:10, target:10, rewards:{gold:20,xp:5} },
    { id:'j2', current:1, target:5, rewards:{gold:10,xp:3} }
  ];
  const plan = planClaims(s);
  assert.strictEqual(plan.length, 3); // starter + 1 order + 1 job
  assert.strictEqual(plan[0].kind, 'starter');
  assert.strictEqual(plan[0].event, 'starter:complete/request');
  assert.strictEqual(plan[0].payload.taskId, 'task1');
  assert.strictEqual(plan[1].kind, 'order');
  assert.strictEqual(plan[1].payload.orderId, 'o1');
  assert.strictEqual(plan[2].kind, 'job');
  assert.strictEqual(plan[2].payload.jobId, 'j1');
});

test('planClaims returns empty when nothing claimable', () => {
  const s = new GameState();
  s.starterTasks = { currentTaskId: null, completed: ['t1'] };
  s.orders = [{ id:'o1', requires:{ potato:10 }, rewards:{gold:50,xp:10} }];
  s.cropInventory = { potato: 2 };
  s.farmJobs = [{ id:'j1', current:1, target:5, rewards:{gold:10,xp:3} }];
  const plan = planClaims(s);
  assert.strictEqual(plan.length, 0);
});

test('planActions prefers demanded crop when available', () => {
  const ecoMulti = {
    potato: { id:'potato', seedId:'potato_seed', cost:3, sell:6, growSeconds:60, xp:1, unlockLevel:1 },
    carrot: { id:'carrot', seedId:'carrot_seed', cost:5, sell:8, growSeconds:90, xp:2, unlockLevel:1 }
  };
  const s = new GameState();
  s.gold = 100; s.inventory = {};
  s.orders = [{ id:'o1', requires:{ carrot:5 }, rewards:{gold:200,xp:50} }];
  s.tiles.set('25,25', { x:25,y:25, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null });
  const plan = planActions(s, ecoMulti, { objective:'gold' });
  const plantAction = plan.find(a => a.kind === 'plant');
  assert.ok(plantAction, 'should have a plant action');
  assert.strictEqual(plantAction.payload.seedId, 'carrot_seed');
});

// --- timeBudgetSeconds tests ---

test('planActions with timeBudgetSeconds excludes long crops', () => {
  const ecoMixed = {
    short: { id:'short', seedId:'short_seed', cost:1, sell:5, growSeconds:60, deathSeconds:30, xp:1, unlockLevel:1 },
    long:  { id:'long',  seedId:'long_seed',  cost:1, sell:50, growSeconds:100000, deathSeconds:100, xp:10, unlockLevel:1 }
  };
  const s = new GameState();
  s.gold = 100; s.inventory = {};
  s.tiles.set('25,25', { x:25, y:25, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null });
  const plan = planActions(s, ecoMixed, { timeBudgetSeconds: 1000 });
  const plantAction = plan.find(a => a.kind === 'plant');
  assert.ok(plantAction, 'should have a plant action');
  assert.strictEqual(plantAction.payload.seedId, 'short_seed');
});

test('planActions with only long crop and tight timeBudget emits no plant', () => {
  const ecoLong = {
    long: { id:'long', seedId:'long_seed', cost:1, sell:50, growSeconds:100000, deathSeconds:100, xp:10, unlockLevel:1 }
  };
  const s = new GameState();
  s.gold = 100; s.inventory = {};
  s.tiles.set('25,25', { x:25, y:25, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null });
  const plan = planActions(s, ecoLong, { timeBudgetSeconds: 1000 });
  const plantAction = plan.find(a => a.kind === 'plant');
  assert.strictEqual(plantAction, undefined, 'should not plant when no crop fits time budget');
});

// --- planStorage tests ---

test('planStorage returns buy when near cap and rich enough', () => {
  const s = new GameState();
  s.inventoryCapacity = 30;
  s.gold = 50000;
  s.inventory = { potato_seed: 20, carrot_seed: 8 }; // sum = 28 >= 25
  const plan = planStorage(s);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].kind, 'buyStorage');
  assert.strictEqual(plan[0].payload.itemId, 'small_storage_crate');
});

test('planStorage returns empty when too poor', () => {
  const s = new GameState();
  s.inventoryCapacity = 30;
  s.gold = 1000;
  s.inventory = { potato_seed: 20, carrot_seed: 8 };
  const plan = planStorage(s);
  assert.strictEqual(plan.length, 0);
});

test('planStorage returns empty when not near cap', () => {
  const s = new GameState();
  s.inventoryCapacity = 30;
  s.gold = 50000;
  s.inventory = { potato_seed: 5 }; // sum = 5, not near 25
  const plan = planStorage(s);
  assert.strictEqual(plan.length, 0);
});

test('planStorage picks next tier above current capacity', () => {
  const s = new GameState();
  s.inventoryCapacity = 75; // already has small_storage_crate
  s.gold = 200000;
  s.inventory = { potato_seed: 40, carrot_seed: 35 }; // sum = 75 >= 70
  const plan = planStorage(s);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].payload.itemId, 'big_storage_crate');
});

test('planActions buys an adjacent plot when farm is full and gold is high', async () => {
  const { GameState } = await import('../src/game/state.js');
  const s = new GameState();
  s.gold = 5000;
  // single owned tile that is planted+growing (not ready) → farm "full"
  s.tiles.set('5,5', { x:5,y:5, ownerState:'owned', groundState:'planted', blocker:'none', cropId:'carrot', readyAt: Date.now()+99999 });
  s.tiles.set('6,5', { x:6,y:5, ownerState:'locked' }); // adjacent
  const eco2 = { carrot:{ id:'carrot', seedId:'carrot_seed', cost:20, sell:40, growSeconds:120, deathSeconds:300, xp:4, unlockLevel:1 } };
  const plan = planActions(s, eco2, { goldReserve: 2000 });
  assert.ok(plan.some(p => p.kind === 'buyPlot' && p.payload.tileX === 6 && p.payload.tileY === 5));
});
