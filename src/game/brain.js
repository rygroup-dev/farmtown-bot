import { rankCrops } from './economy.js';

// Normalize any crop/seed key to a bare lowercase crop id ("Carrot"/"carrot_seed" → "carrot").
const cropKey = (s) => String(s).toLowerCase().replace(/_seed$/, '');

export function planActions(state, eco, { objective = 'gold', maxPlantsPerTick = 12, goldReserve = 150, timeBudgetSeconds = Infinity, varietyRatio = 0.3 } = {}) {
  const plan = [];
  for (const t of state.readyToHarvest())
    plan.push({ kind:'harvest', event:'crop:harvest/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'harvest', tool:'hoe' } });
  for (const t of state.blocked())
    // Rocks/stone need the Pickaxe; trees/bushes/weeds/sticks use the Axe.
    plan.push({ kind:'clear', event:'tile:clear/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'clear', tool: (t.blocker === 'stone' || t.blocker === 'rock') ? 'pickaxe' : 'axe' } });
  for (const t of state.hoeable())
    plan.push({ kind:'hoe', event:'tile:hoe/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'hoe', tool:'hoe' } });

  // Crops we can actually grow now (unlocked + affordable + fit the downtime budget),
  // ranked by the active objective. candidates[0] is the best profit/xp "filler".
  const candidates = rankCrops(eco, { gold: state.gold, level: state.level, objective })
    .filter(c => c.growSeconds + (c.deathSeconds || 0) <= timeBudgetSeconds);

  if (candidates.length) {
    const growable = new Set(candidates.map(c => cropKey(c.id)));
    // Outstanding ORDER demand, mapped to growable crops and netted against what we
    // already have (basket + currently growing) — so orders actually get fulfilled
    // instead of monoculture. Case-insensitive: server may key requires as "Carrot".
    const basket = {}; for (const [k, v] of Object.entries(state.cropInventory || {})) basket[cropKey(k)] = (basket[cropKey(k)] || 0) + (v || 0);
    const growing = state.growingCounts ? state.growingCounts() : {};
    const remainById = {};
    for (const [name, qty] of Object.entries(state.cropDemand())) {
      const id = cropKey(name);
      if (!growable.has(id)) continue; // can't grow it yet (locked/unaffordable) — skip
      const r = (qty || 0) - (basket[id] || 0) - (growing[id] || 0);
      if (r > 0) remainById[id] = (remainById[id] || 0) + r;
    }
    // Build a tile→crop queue: sow demanded crops first (most valuable demanded crop
    // first, since `candidates` is rank-sorted). Remaining tiles are then filled by a
    // 70/30 split — ~70% the single best profit/xp crop (steady income), ~30% "variety"
    // rotated across the other unlocked+affordable crops (seeds future orders, crop
    // mastery, and quest chapters; avoids brittle monoculture). Tunable via varietyRatio.
    const queue = [];
    for (const c of candidates) { let r = remainById[cropKey(c.id)] || 0; while (r-- > 0) queue.push(c); }
    const top = candidates[0];
    const varietyPool = candidates.slice(1); // other growable crops, rank-sorted
    // Deterministic 70/30 over a window of 10: the last `round(varietyRatio*10)` go to variety.
    const varietyPerWindow = Math.max(0, Math.min(10, Math.round(varietyRatio * 10)));
    const isVarietySlot = (i) => varietyPool.length > 0 && (i % 10) >= (10 - varietyPerWindow);
    let varietyTurn = 0;
    const fillerFor = (i) => isVarietySlot(i) ? varietyPool[varietyTurn++ % varietyPool.length] : top;

    const plantedSeed = {}; // per-seed count queued THIS tick, for buy decisions
    let planted = 0;
    for (const t of state.tilledEmpty()) {
      if (planted >= maxPlantsPerTick) break;
      const crop = queue[planted] || fillerFor(planted - queue.length);
      const sid = crop.seedId;
      const need = (plantedSeed[sid] || 0) + 1;
      if ((state.inventory[sid] || 0) < need) {
        plan.push({ kind:'buySeed', event:'store:buySeed/request', payload:{ seedId: sid, quantity: 1 }, meta:null });
      }
      plan.push({ kind:'plant', event:'crop:plant/request', payload:{ tileX:t.x, tileY:t.y, seedId: sid }, meta:{ action:'plant', tool:'seed_bag', seedId: sid } });
      plantedSeed[sid] = need;
      planted++;
    }
  }

  // Auto-expand CONSERVATIVELY: buy an adjacent locked plot only when (a) the farm has
  // very little unworked backlog, and (b) we still hold a reserve big enough to KEEP THE
  // WHOLE FARM SEEDED — the reserve scales with farm size (~250 gold/owned tile) so a
  // large farm never starves its own replanting (the old flat 2k reserve drained gold,
  // causing "Not enough gold" + idle). New plots arrive wild → cleared → hoed → planted.
  const expandable = state.expandableTiles();
  const ownedCount = state.ownedTiles().length;
  const expandReserve = Math.max(goldReserve, ownedCount * 250);
  const unworked = state.blocked().length + state.hoeable().length + state.tilledEmpty().length;
  if (expandable.length && state.gold >= expandReserve && unworked < 4) {
    const t = expandable[0];
    plan.push({ kind:'buyPlot', event:'plot:buy/request', payload:{ tileX:t.x, tileY:t.y }, meta:null });
  }
  return plan;
}

const STORAGE_TIERS = [
  { itemId: 'small_storage_crate', cap: 75, cost: 25000 },
  { itemId: 'big_storage_crate', cap: 125, cost: 100000 },
  { itemId: 'farm_storage_chest', cap: 200, cost: 500000 },
];

export function planStorage(state, { goldReserve = 5000 } = {}) {
  const next = STORAGE_TIERS.find(t => t.cap > state.inventoryCapacity);
  if (!next) return [];
  if (state.gold - next.cost < goldReserve) return [];
  if (state.seedCount() < state.inventoryCapacity - 5) return [];
  return [{ kind: 'buyStorage', event: 'store:buyItem/request', payload: { itemId: next.itemId }, meta: null }];
}

export function planClaims(state) {
  const plan = [];
  if (state.starterTasks?.currentTaskId)
    plan.push({ kind:'starter', event:'starter:complete/request', payload:{ taskId: state.starterTasks.currentTaskId }, meta:null });
  for (const o of state.completableOrders())
    plan.push({ kind:'order', event:'order:complete/request', payload:{ orderId: o.id }, meta:null });
  for (const j of state.claimableJobs())
    plan.push({ kind:'job', event:'farmJob:claim/request', payload:{ jobId: j.id }, meta:null });
  return plan;
}
