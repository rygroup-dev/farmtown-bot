import { test } from 'node:test';
import assert from 'node:assert';
import { planActions, planClaims } from '../src/game/brain.js';
import { GameState } from '../src/game/state.js';

const eco = { potato: { id:'potato', seedId:'potato_seed', cost:3, sell:6, growSeconds:60, xp:1, unlockLevel:1 } };

test('plans harvest before plant', () => {
  const s = new GameState();
  s.gold = 100; s.inventory.potato_seed = 5;
  s.tiles.set('25,24', { x:25,y:24, ownerState:'owned', groundState:'planted', cropId:'potato', readyAt: Date.now()-1 });
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
