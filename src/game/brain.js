import { rankCrops } from './economy.js';
import { SACRIFICE_CROPS } from './farmerpool.js';

// Normalize any crop/seed key to a bare lowercase crop id ("Carrot"/"carrot_seed" → "carrot").
const cropKey = (s) => String(s).toLowerCase().replace(/_seed$/, '');

export function planActions(state, eco, { objective = 'gold', maxPlantsPerTick = 12, goldReserve = 150, timeBudgetSeconds = Infinity, varietyRatio = 0.3, sacrificeRatio = 0 } = {}) {
  const plan = [];
  for (const t of state.readyToHarvest())
    plan.push({ kind:'harvest', event:'crop:harvest/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'harvest', tool:'hoe' } });
  // Clear dead crops so the tile re-enters the cycle (dead → cleared → hoe → plant).
  for (const t of state.deadCrops())
    plan.push({ kind:'clearDead', event:'crop:clearDead/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'clearDead', tool:'hoe' } });
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
    // split: sacrificeRatio% sacrifice crops (starfruit/crystal_berry for pool power),
    // then varietyRatio% variety, rest = top profit crop.
    const queue = [];
    for (const c of candidates) { let r = remainById[cropKey(c.id)] || 0; while (r-- > 0) queue.push(c); }
    const top = candidates[0];
    const varietyPool = candidates.slice(1);
    const sacCrops = candidates.filter(c => c.id in SACRIFICE_CROPS);
    const sacPerWindow = Math.max(0, Math.min(10, Math.round(sacrificeRatio * 10)));
    const varietyPerWindow = Math.max(0, Math.min(10 - sacPerWindow, Math.round(varietyRatio * 10)));
    let sacTurn = 0, varietyTurn = 0;
    const fillerFor = (i) => {
      const slot = i % 10;
      if (sacCrops.length > 0 && slot < sacPerWindow) return sacCrops[sacTurn++ % sacCrops.length];
      if (varietyPool.length > 0 && slot >= (10 - varietyPerWindow)) return varietyPool[varietyTurn++ % varietyPool.length];
      return top;
    };

    const plantedSeed = {}; // per-seed count queued THIS tick, for buy decisions
    let planted = 0;
    let goldSpent = 0;
    for (const t of state.tilledEmpty()) {
      if (planted >= maxPlantsPerTick) break;
      const crop = queue[planted] || fillerFor(planted - queue.length);
      const sid = crop.seedId;
      const need = (plantedSeed[sid] || 0) + 1;
      if ((state.inventory[sid] || 0) < need) {
        if (state.gold - goldSpent < (crop.cost || 0)) break;
        plan.push({ kind:'buySeed', event:'store:buySeed/request', payload:{ seedId: sid, quantity: 1 }, meta:null });
        goldSpent += (crop.cost || 0);
      }
      plan.push({ kind:'plant', event:'crop:plant/request', payload:{ tileX:t.x, tileY:t.y, seedId: sid }, meta:{ action:'plant', tool:'seed_bag', seedId: sid } });
      plantedSeed[sid] = need;
      planted++;
    }
  }

  // Auto-expand CONSERVATIVELY: buy an adjacent locked plot only when (a) the farm has
  // very little unworked backlog, and (b) gold covers both the seed reserve and an
  // estimated plot price. FarmTown's plot price scales sharply with owned land; using
  // only a flat reserve causes large farms to spam "Not enough gold" on buyPlot.
  const expandable = state.expandableTiles();
  const ownedCount = state.ownedTiles().length;
  const expandReserve = Math.max(goldReserve, ownedCount * 250);
  const estimatedPlotCost = Math.max(5000, Math.ceil(ownedCount * ownedCount * 5));
  const unworked = state.blocked().length + state.hoeable().length + state.tilledEmpty().length + state.deadCrops().length;
  if (expandable.length && state.gold >= expandReserve + estimatedPlotCost && unworked < 4) {
    const t = expandable[0];
    plan.push({ kind:'buyPlot', event:'plot:buy/request', payload:{ tileX:t.x, tileY:t.y }, meta:null });
  }
  return plan;
}

const STORAGE_TIERS = [
  { itemId: 'small_storage_crate',   cap: 75,  cost: 25000,    unlockLevel: 0  },
  { itemId: 'big_storage_crate',     cap: 125, cost: 100000,   unlockLevel: 0  },
  { itemId: 'farm_storage_chest',    cap: 200, cost: 500000,   unlockLevel: 0  },
  { itemId: 'grand_storage_vault',   cap: 300, cost: 1500000,  unlockLevel: 35 },
  { itemId: 'mega_storage_depot',    cap: 450, cost: 4000000,  unlockLevel: 45 },
];

export function planStorage(state, { goldReserve = 5000 } = {}) {
  const next = STORAGE_TIERS.find(t => t.cap > state.inventoryCapacity && (t.unlockLevel || 0) <= state.level);
  if (!next) return [];
  if (state.gold - next.cost < goldReserve) return [];
  if (state.seedCount() < state.inventoryCapacity - 5) return [];
  return [{ kind: 'buyStorage', event: 'store:buyItem/request', payload: { itemId: next.itemId }, meta: null }];
}

// Animal config matching the game's live data.
const ANIMAL_CONFIG = {
  cow: { id: 'cow', produceId: 'milk', producePerCycle: 10, productionIntervalMs: 10800000, feedCropId: 'wheat', feedAmount: 25 },
};

// Feed hungry animals + collect ready produce. Barn state comes from playerFarmState.barns.
export function planAnimalActions(state) {
  const plan = [];
  const now = Date.now();
  for (const [barnId, barn] of Object.entries(state.barns || {})) {
    const slots = barn.slots || [];
    const feed = barn.feed || {};
    for (let i = 0; i < slots.length; i++) {
      const animalId = slots[i];
      if (!animalId) continue;
      const cfg = ANIMAL_CONFIG[animalId];
      if (!cfg) continue;
      const lastFed = feed[String(i)];
      if (lastFed == null) {
        // Hungry — feed if we have enough crop in inventory
        if ((state.cropInventory[cfg.feedCropId] || 0) >= cfg.feedAmount)
          plan.push({ kind: 'barnFeed', event: 'barn:feed/request', payload: { barnId, slotIndex: i }, meta: null });
      } else if (now >= lastFed + cfg.productionIntervalMs) {
        // Production cycle done — collect
        plan.push({ kind: 'barnCollect', event: 'barn:collect/request', payload: { barnId, slotIndex: i }, meta: null });
      }
    }
  }
  return plan;
}

export function planClaims(state) {
  const plan = [];
  for (const star of state.claimableFallingStars())
    plan.push({ kind:'fallingStar', event:'game:action', payload:{ action: 'claimFallingStar', fallingStarId: star.id, clientDebug: { interactionMode: 'farm', networkMode: 'socket' } }, meta:null });
  if (state.starterTasks?.currentTaskId)
    plan.push({ kind:'starter', event:'starter:complete/request', payload:{ taskId: state.starterTasks.currentTaskId }, meta:null });
  for (const o of state.completableOrders())
    plan.push({ kind:'order', event:'order:complete/request', payload:{ orderId: o.id }, meta:null });
  for (const j of state.claimableJobs())
    plan.push({ kind:'job', event:'farmJob:claim/request', payload:{ jobId: j.id }, meta:null });
  return plan;
}
