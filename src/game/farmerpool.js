// Farmer's Pool — the $FARM-token earn mechanism (REST, not socket).
// Reverse-engineered: GET /api/rewards/farmer-pool/status →
//   { config:{enabled,minLevel,goldPerPower,farmPointsPerPower,claimPowerPerBurnedLevel},
//     pool:{status:'active'|'paused'|'closed', poolDate, ...},
//     player:{level,gold,availableFarmPoints,burnableLevels,hasContributionToday,...} }
// POST /api/rewards/farmer-pool/claim
//   body { actionId, goldToBurn, farmPointsToBurn, levelsToBurn }
// Each unit of "claim power" = goldToBurn/goldPerPower + farmPointsToBurn/farmPointsPerPower
//   + levelsToBurn*claimPowerPerBurnedLevel. Pool splits ~4.4M FARM/day by share of power.
import { log } from '../logger.js';

function poolActionId() {
  return `farmer-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function pollFarmerPool(rest) {
  const r = await rest.req('/api/rewards/farmer-pool/status');
  return r.status === 200 ? r.json : null;
}

// Pure decision. Defaults are conservative: spend only farm points (a free byproduct
// of playing); never burn gold (needed for farming) or levels unless explicitly enabled.
export function decideContribution(status, { burnGold = false, goldReserve = 100000, burnLevels = false } = {}) {
  const cfg = status?.config, pool = status?.pool, player = status?.player;
  if (!cfg?.enabled) return null;
  if (!pool || pool.status !== 'active') return null;
  if ((player?.level || 0) < (cfg.minLevel || 10)) return null;
  if (player.hasContributionToday) return null;
  const farmPointsToBurn = Math.max(0, player.availableFarmPoints || 0);
  const goldToBurn = burnGold && player.gold > goldReserve ? player.gold - goldReserve : 0;
  const levelsToBurn = burnLevels ? Math.max(0, player.burnableLevels || 0) : 0;
  if (farmPointsToBurn + goldToBurn + levelsToBurn <= 0) return null;
  return { farmPointsToBurn, goldToBurn, levelsToBurn };
}

export async function claimFarmerPool(rest, contribution) {
  const body = { actionId: poolActionId(), ...contribution };
  return rest.req('/api/rewards/farmer-pool/claim', { method: 'POST', body });
}

// Orchestrator entrypoint: poll → decide → claim. Returns a summary (never throws).
export async function maybeContribute(rest, opts = {}) {
  try {
    const status = await pollFarmerPool(rest);
    if (!status) return { ok: false, reason: 'status-unavailable' };
    const c = decideContribution(status, opts);
    if (!c) return { ok: true, contributed: false, pool: status.pool?.status, level: status.player?.level };
    const r = await claimFarmerPool(rest, c);
    const ok = r.status === 200 && r.json?.ok !== false;
    log.info('FARMPOOL', `claim gold=${c.goldToBurn} points=${c.farmPointsToBurn} levels=${c.levelsToBurn} -> ${ok ? 'OK' : 'FAIL ' + r.status}`);
    return { ok, contributed: ok, result: r.json };
  } catch (e) {
    log.warn('FARMPOOL', e.message);
    return { ok: false, reason: e.message };
  }
}
