import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planActions } from '../src/game/brain.js';
import { GameState } from '../src/game/state.js';

const eco = {
  potato: { id:'potato', seedId:'potato_seed', cost:3, sell:6, growSeconds:60, deathSeconds:120, xp:1, unlockLevel:1 },
  carrot: { id:'carrot', seedId:'carrot_seed', cost:5, sell:30, growSeconds:90, deathSeconds:200, xp:2, unlockLevel:1 },
  corn:   { id:'corn',   seedId:'corn_seed',   cost:8, sell:20, growSeconds:120, deathSeconds:300, xp:3, unlockLevel:1 },
};

function tilled(s, n) {
  for (let i = 0; i < n; i++) s.tiles.set(`${i},0`, { x:i, y:0, ownerState:'owned', groundState:'tilled', blocker:'none', cropId:null });
}

test('satisfies multiple order crops first, then fills the rest', () => {
  const s = new GameState();
  s.gold = 10000; s.inventory = {};
  s.orders = [
    { id:'o1', requires:{ carrot:2 }, rewards:{gold:200,xp:50} },
    { id:'o2', requires:{ corn:3 },   rewards:{gold:300,xp:80} },
  ];
  tilled(s, 8);
  const seeds = planActions(s, eco, { objective:'gold' })
    .filter(a => a.kind === 'plant').map(a => a.payload.seedId);
  const count = (id) => seeds.filter(x => x === id).length;
  assert.ok(count('carrot_seed') >= 2, 'covers the 2 carrots an order needs');
  assert.ok(count('corn_seed') >= 3, 'covers the 3 corn an order needs');
  assert.equal(seeds.length, 8, 'all tilled tiles planted');
  assert.ok(new Set(seeds).size >= 2, 'more than one crop planted');
});

test('70/30 split on filler tiles: ~70% top crop, ~30% variety', () => {
  const s = new GameState();
  s.gold = 100000; s.inventory = {};   // no orders → all tiles are "filler"
  tilled(s, 20);
  const seeds = planActions(s, eco, { objective:'gold', maxPlantsPerTick: 20 })
    .filter(a => a.kind === 'plant').map(a => a.payload.seedId);
  assert.equal(seeds.length, 20);
  const top = seeds.filter(x => x === 'carrot_seed').length;   // carrot = highest profit/hr
  const variety = 20 - top;
  assert.equal(top, 14, '70% → top profit crop');
  assert.equal(variety, 6, '30% → variety');
  // variety is rotated across the OTHER growable crops, not just one
  const varietySeeds = new Set(seeds.filter(x => x !== 'carrot_seed'));
  assert.ok(varietySeeds.has('corn_seed') && varietySeeds.has('potato_seed'), 'variety spans multiple crops');
});

test('demand matching is case-insensitive (server "Carrot" vs eco "carrot")', () => {
  const s = new GameState();
  s.gold = 10000; s.inventory = {};
  s.orders = [{ id:'o1', requires:{ Carrot:3 }, rewards:{gold:200,xp:50} }];
  tilled(s, 3);
  const seeds = planActions(s, eco, { objective:'gold' })
    .filter(a => a.kind === 'plant').map(a => a.payload.seedId);
  assert.equal(seeds.filter(x => x === 'carrot_seed').length, 3);
});

test('nets demand against basket + already-growing so it does not over-plant one crop', () => {
  const s = new GameState();
  s.gold = 10000; s.inventory = {};
  s.orders = [{ id:'o1', requires:{ corn:5 }, rewards:{gold:300,xp:80} }];
  s.cropInventory = { corn: 2 };                 // 2 already harvested
  // 1 corn already growing
  s.tiles.set('99,0', { x:99, y:0, ownerState:'owned', groundState:'planted', blocker:'none', cropId:'corn', readyAt: Date.now()+99999 });
  tilled(s, 6);
  const seeds = planActions(s, eco, { objective:'gold' })
    .filter(a => a.kind === 'plant').map(a => a.payload.seedId);
  // need = 5 - 2 basket - 1 growing = 2 more corn; rest filler
  assert.equal(seeds.filter(x => x === 'corn_seed').length, 2);
});

test('buys the right number of each seed when short', () => {
  const s = new GameState();
  s.gold = 10000; s.inventory = { carrot_seed: 1 }; // have 1 carrot already
  s.orders = [{ id:'o1', requires:{ carrot:3 }, rewards:{gold:200,xp:50} }];
  tilled(s, 3);
  const buys = planActions(s, eco, { objective:'gold' })
    .filter(a => a.kind === 'buySeed').map(a => a.payload.seedId);
  // 3 carrots needed, 1 in stock → buy 2
  assert.equal(buys.filter(x => x === 'carrot_seed').length, 2);
});
