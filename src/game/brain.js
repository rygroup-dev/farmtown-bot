import { rankCrops } from './economy.js';

export function planActions(state, eco, { objective = 'gold', maxPlantsPerTick = 12 } = {}) {
  const plan = [];
  for (const t of state.readyToHarvest())
    plan.push({ kind:'harvest', event:'crop:harvest/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'harvest', tool:'hoe' } });
  for (const t of state.blocked())
    plan.push({ kind:'clear', event:'tile:clear/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'clear', tool:'axe' } });
  for (const t of state.grassEmpty())
    plan.push({ kind:'hoe', event:'tile:hoe/request', payload:{ tileX:t.x, tileY:t.y }, meta:{ action:'hoe', tool:'hoe' } });
  const ranked = rankCrops(eco, { gold: state.gold, level: state.level, objective });
  const best = ranked[0];
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
  return plan;
}

export function planClaims(state) {
  const plan = [];
  for (const q of state.quests || []) if (q.complete && !q.claimed) plan.push({ kind:'quest', event:'starter:complete/request', payload:{ taskId:q.id }, meta:null });
  for (const j of state.jobs || []) if (j.complete && !j.claimed) plan.push({ kind:'job', event:'farmJob:claim/request', payload:{ jobId:j.id }, meta:null });
  for (const o of state.orders || []) if (o.fulfillable && !o.claimed) plan.push({ kind:'order', event:'order:complete/request', payload:{ orderId:o.id }, meta:null });
  return plan;
}
