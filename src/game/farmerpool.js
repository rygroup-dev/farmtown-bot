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

// Pure decision — the bot's pool strategy, encoded.
//
// Economics (reverse-engineered): the daily pool (~4.4M FARM) is split by each player's
// share of total "claim power". Power is bought by burning one of three things:
//   • farm points — 100 FP = 1 power. A FREE byproduct of farming → always burn.
//   • gold        — 250k gold = 1 power. Has farming utility → only burn true surplus.
//   • levels      — 1 level = 3 power, but ~$0.06 each and DESTRUCTIVE (drops crop
//                   unlocks → worse income). A trap. NEVER burn unless explicitly opted in.
//
// Two correctness rules baked in:
//   1) Contribute REPEATEDLY (top players do 150-260x/day) — share is the TOTAL power
//      accumulated over the day, so we never stop after the first contribution.
//   2) Burn only in WHOLE-power multiples (exactly like the game UI's power sliders) so
//      no farm points or gold are ever wasted on sub-power rounding; the remainder
//      (<1 power) is kept and accumulates for the next contribution.
export function decideContribution(status, { burnGold = false, goldReserve = 100000, burnLevels = false, levelFloor = 10, sacrificeAt = 0, currentLevel = null } = {}) {
  const cfg = status?.config, pool = status?.pool, player = status?.player;
  if (!cfg?.enabled) return null;
  if (!pool || pool.status !== 'active') return null;
  // Eligibility: trust the server's `unlocked` flag (authoritative). The pool's
  // player.level can be a STALE cached value (observed level 2 while xp says L11),
  // so don't gate on it when the server already reports unlocked.
  const eligible = player?.unlocked === true || (player?.level || 0) >= (cfg.minLevel || 30);
  if (!eligible) return null;
  if (player?.meetsStarGate === false) return null;

  const fpPer = cfg.farmPointsPerPower || 100;
  const goldPer = cfg.goldPerPower || 250000;
  const floorTo = (amount, unit) => Math.max(0, Math.floor(amount / unit) * unit);

  const farmPointsToBurn = floorTo(player.availableFarmPoints || 0, fpPer);
  const goldToBurn = burnGold ? floorTo(Math.max(0, (player.gold || 0) - goldReserve), goldPer) : 0;

  // Level SACRIFICE (opt-in): convert otherwise-wasted post-cap XP into claim power.
  // Hard guardrails — never burn below `levelFloor`, never more than the server allows
  // (burnableLevels), and only once an account has reached `sacrificeAt` (e.g. max L30).
  // Prefer the live `currentLevel` over the pool's sometimes-stale cached player.level.
  let levelsToBurn = 0;
  if (burnLevels) {
    const lvl = currentLevel ?? player.level ?? 0;
    if (!sacrificeAt || lvl >= sacrificeAt) {
      levelsToBurn = Math.max(0, Math.min(player.burnableLevels || 0, lvl - levelFloor));
    }
  }

  if (farmPointsToBurn + goldToBurn + levelsToBurn <= 0) return null; // nothing worth a whole power yet
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
