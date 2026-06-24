// Farmer's Pool — the $FARM-token earn mechanism (REST, not socket).
// Reverse-engineered: GET /api/rewards/farmer-pool/status →
//   { config:{enabled,minLevel,goldPerPower,farmPointsPerPower,claimPowerPerBurnedLevel},
//     pool:{status:'active'|'paused'|'closed', poolDate, opensAt, closesAt, ...},
//     player:{level,gold,availableFarmPoints,burnableLevels,hasContributionToday,...},
//     earlyBird:{active,bonus,endsAt} }
// POST /api/rewards/farmer-pool/claim
//   body { actionId, goldToBurn, farmPointsToBurn, levelsToBurn }
// Crop sacrifice (starfruit=2 power, crystal_berry=1 power) — included in claim body.
// Server may ignore if not yet supported; we send it unconditionally.
import { log } from '../logger.js';

export const SACRIFICE_CROPS = { starfruit: 2, crystal_berry: 1 };

function poolActionId() {
  return `farmer-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function pollFarmerPool(rest) {
  const r = await rest.req('/api/rewards/farmer-pool/status', { timeoutMs: 60000, retries: 4 });
  return r.status === 200 ? r.json : null;
}

export function poolTiming(status) {
  const pool = status?.pool;
  if (!pool) return null;
  const now = Date.now();
  const opensAt = pool.opensAt ? Date.parse(pool.opensAt) : null;
  const closesAt = pool.closesAt ? Date.parse(pool.closesAt) : null;
  const eb = status.earlyBird;
  const earlyBirdEndsAt = eb?.endsAt ? Date.parse(eb.endsAt) : null;
  return {
    opensAt, closesAt, earlyBirdEndsAt,
    isOpen: opensAt && closesAt ? (now >= opensAt && now < closesAt) : false,
    isEarlyBird: eb?.active || (earlyBirdEndsAt ? now < earlyBirdEndsAt : false),
    msUntilOpen: opensAt ? Math.max(0, opensAt - now) : null,
    msUntilClose: closesAt ? Math.max(0, closesAt - now) : null,
    msUntilEarlyBirdEnd: earlyBirdEndsAt ? Math.max(0, earlyBirdEndsAt - now) : null,
  };
}

// Pure decision — the bot's pool strategy, encoded.
export function decideContribution(status, { burnGold = false, goldReserve = 100000, burnLevels = false, levelFloor = 10, sacrificeAt = 0, currentLevel = null, cropInventory = null } = {}) {
  const cfg = status?.config, pool = status?.pool, player = status?.player;
  if (!cfg) return null;
  // Server may set config.enabled=false while pool.status is 'active' with valid opensAt/closesAt.
  // Trust pool.status + timing over the config flag.
  if (!pool || pool.status !== 'active') return null;

  const timing = poolTiming(status);
  if (timing?.opensAt && !timing.isOpen) return null;

  const eligible = player?.unlocked === true || (player?.level || 0) >= (cfg.minLevel || 30);
  if (!eligible) return null;
  if (player?.meetsStarGate === false) return null;

  const fpPer = cfg.farmPointsPerPower || 100;
  const goldPer = cfg.goldPerPower || 250000;
  const floorTo = (amount, unit) => Math.max(0, Math.floor(amount / unit) * unit);

  const farmPointsToBurn = floorTo(player.availableFarmPoints || 0, fpPer);
  const goldToBurn = burnGold ? floorTo(Math.max(0, (player.gold || 0) - goldReserve), goldPer) : 0;

  let levelsToBurn = 0;
  if (burnLevels) {
    const lvl = currentLevel ?? player.level ?? 0;
    if (!sacrificeAt || lvl >= sacrificeAt) {
      levelsToBurn = Math.max(0, Math.min(player.burnableLevels || 0, lvl - levelFloor));
    }
  }

  const cropSac = cropInventory ? decideCropSacrifice(cropInventory) : null;
  const cropSacrifices = cropSac ? cropSac.crops : null;

  if (farmPointsToBurn + goldToBurn + levelsToBurn <= 0 && !cropSacrifices) return null;
  return { farmPointsToBurn, goldToBurn, levelsToBurn, ...(cropSacrifices ? { cropSacrifices } : {}) };
}

// Compute how many sacrifice crops the bot should burn for extra pool power.
// Returns { starfruit: N, crystal_berry: N } with total power estimate.
export function decideCropSacrifice(cropInventory = {}, { reservePerCrop = 5 } = {}) {
  const crops = {};
  let totalPower = 0;
  for (const [cropId, powerEach] of Object.entries(SACRIFICE_CROPS)) {
    const have = cropInventory[cropId] || 0;
    const toBurn = Math.max(0, have - reservePerCrop);
    if (toBurn > 0) {
      crops[cropId] = toBurn;
      totalPower += toBurn * powerEach;
    }
  }
  return totalPower > 0 ? { crops, totalPower } : null;
}

export async function claimFarmerPool(rest, contribution) {
  const body = { actionId: poolActionId(), ...contribution };
  return rest.req('/api/rewards/farmer-pool/claim', { method: 'POST', body, timeoutMs: 60000 });
}

// Orchestrator entrypoint: poll → decide → claim. Returns a summary (never throws).
export async function maybeContribute(rest, opts = {}) {
  const tag = opts.tag || '';
  try {
    const status = await pollFarmerPool(rest);
    if (!status) return { ok: false, reason: 'status-unavailable' };

    const timing = poolTiming(status);
    const c = decideContribution(status, opts);
    if (!c) return { ok: true, contributed: false, pool: status.pool?.status, level: status.player?.level, timing };

    const r = await claimFarmerPool(rest, c);
    const ok = r.status === 200 && r.json?.ok !== false;
    const earlyTag = timing?.isEarlyBird ? ' [EARLY BIRD +10%]' : '';
    const cropTag = c.cropSacrifices ? ` crops=${JSON.stringify(c.cropSacrifices)}` : '';
    log.info('FARMPOOL', `${tag}claim gold=${c.goldToBurn} points=${c.farmPointsToBurn} levels=${c.levelsToBurn}${cropTag}${earlyTag} -> ${ok ? 'OK' : 'FAIL ' + r.status}`);
    return { ok, contributed: ok, result: r.json, timing };
  } catch (e) {
    log.warn('FARMPOOL', `${tag}${e.message}`);
    return { ok: false, reason: e.message };
  }
}
