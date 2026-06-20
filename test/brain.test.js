import { test } from 'node:test';
import assert from 'node:assert';
import { planActions } from '../src/game/brain.js';
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
