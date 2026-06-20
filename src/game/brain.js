import { rankCrops } from './economy.js';

export function planActions(state, eco, { objective = 'gold', maxPlantsPerTick = 12, goldReserve = 150 } = {}) {
  const plan = [];
  for (const t of state.readyToHarvest())
    plan.push({ kind:'harvest', event:'crop:harvest/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'harvest', tool:'hoe' } });
  for (const t of state.blocked())
    plan.push({ kind:'clear', event:'tile:clear/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'clear', tool:'axe' } });
  for (const t of state.grassEmpty())
    plan.push({ kind:'hoe', event:'tile:hoe/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'hoe', tool:'hoe' } });

  const demand = state.cropDemand();
  const ranked = rankCrops(eco, { gold: state.gold, level: state.level, objective });
  const demanded = ranked.find(c => demand[c.id] > 0);
  const best = demanded || ranked[0];

  if (best) {
    let planted = 0;
    for (const t of state.tilledEmpty()) {
      if (planted >= maxPlantsPerTick) break;
      const have = state.inventory[best.seedId] || 0;
      if (have <= planted) {
        plan.push({ kind:'buySeed', event:'store:buySeed/request', payload:{ seedId: best.seedId, quantity: 1 }, meta:null });
      }
      plan.push({ kind:'plant', event:'crop:plant/request', payload:{ tileX:t.x, tileY:t.y, seedId: best.seedId }, meta:{ action:'plant', tool:'seed_bag', seedId: best.seedId } });
      planted++;
    }
  }

  // Auto-expand: unlock ONE adjacent buyable plot when we have spare gold and the
  // farm is fully worked (no empty/grass tiles left). Grows capacity = more profit.
  const buyable = state.buyableTiles().filter(t => t.ownerState === 'buyable');
  const farmFull = state.grassEmpty().length === 0 && state.tilledEmpty().length === 0;
  if (buyable.length && state.gold >= goldReserve && (farmFull || state.gold >= goldReserve * 4)) {
    const t = buyable[0];
    plan.push({ kind:'buyPlot', event:'plot:buy/request', payload:{ tileX:t.x, tileY:t.y }, meta:null });
  }
  return plan;
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
