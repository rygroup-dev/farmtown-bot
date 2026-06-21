# FarmTown Game Mechanics

A reference for the complete game model the bot reasons about — economy, tiles, crops,
orders, jobs, the Farmer Pool, and progression.

## 1. The money layer — $FARM token + Stars (the real "profit")

- **$FARM**: Solana SPL token (pump.fun), mint `yMJPZbnhoHib3ib8n8PfiVcp9yauk1vnaGKLx7epump`,
  symbol `FARM`, 6 decimals. Treasury `3zRmPF29gQHVLuEWhabuZsJuKQwGX8YUpKeBHGTC9m2Q`. Network mainnet-beta.
- **Stars** = in-game premium currency, **bought with real money / $FARM** (buying burns FARM → deflationary; 2.8M FARM burned so far). Bundles: Starter $5→3⭐, Small $20→20⭐, Medium $50→65⭐, Large $100→160⭐, Degen $250→425⭐. Endpoints: `/api/token/stars/{bundles,quote,confirm,balance,ledger,burn-stats,payment-config,dev-credit}`. **The bot never buys stars (no real spend).**
- **Farmer's Pool = how you EARN $FARM (withdrawable!)** — `/api/rewards/farmer-pool/{status,claim}`:
  - Config: `enabled`, `minLevel:10` (must be ≥L10 to participate), `goldPerPower:250000` (250k gold = 1 claim power), `farmPointsPerPower:100` (100 farm points = 1 power), `claimPowerPerBurnedLevel:3` (burn a level above 10 → 3 power).
  - Daily pool: ~**4,400,000 FARM allocated per day**, split across ~2100 participants by each one's contributed **claim power** (`estimatedShareBps` → `estimatedPayoutRaw` in FARM base units). Pool has status `active|paused|closed` (daily; was `paused` during capture).
  - Player fields: `level, xp, gold, earnedFarmPoints, availableFarmPoints, burnableLevels, contributedClaimPowerToday, estimatedShareBps, estimatedPayoutRaw, unlocked`.
  - **Profit loop**: farm gold/xp → reach **level 10** → accumulate claim power (gold ÷250k + farmPoints ÷100 + burned levels ×3) → contribute to the daily pool via farmer-pool/claim → receive $FARM to the wallet. This is the bot's true endgame KPI once L10 is reached.

## 2. Crops (authoritative — `data/economy.json`)

19 crops. `harvesting adds the crop to the Harvest Basket (cropInventory); it does NOT pay gold directly` — gold is realized by completing **orders** that consume basket crops. `deathWindowMinutes`: after `readyAt`, the crop dies if not harvested within this window (lost).

| crop | lvl | cost | grow | death | rewardGold | xp | profit/hr* |
|---|--|--|--|--|--|--|--|
| potato | 1 | 5 | 45s | 2m | 8 | 1 | 240 |
| carrot | 1 | 20 | 2m | 5m | 40 | 4 | 600 |
| corn | 1 | 45 | 5m | 12m | 95 | 8 | 600 |
| tomato | 5 | 90 | 8m | 6m | 200 | 14 | 825 |
| onion | 5 | 140 | 12m | 8m | 330 | 22 | 950 |
| wheat | 5 | 220 | 18m | 12m | 560 | 32 | 1133 |
| pumpkin | 10 | 400 | 30m | 20m | 1050 | 55 | 1300 |
| melon | 10 | 650 | 45m | 30m | 1800 | 80 | 1533 |
| cucumber | 10 | 850 | 60m | 45m | 2400 | 105 | 1550 |
| pepper | 15 | 1300 | 90m | 60m | 4000 | 150 | 1800 |
| strawberry | 15 | 1900 | 120m | 45m | 6200 | 210 | 2150 |
| blueberry | 15 | 2600 | 180m | 60m | 8800 | 280 | 2067 |
| grape | 20 | 4000 | 240m | 75m | 9500 | 220 | 1375 |
| eggplant | 20 | 5500 | 300m | 90m | 13000 | 280 | 1500 |
| watermelon | 20 | 7500 | 360m | 120m | 18000 | 360 | 1750 |
| dragonfruit | 25 | 12000 | 480m | 150m | 28000 | 500 | 2000 |
| pineapple | 25 | 18000 | 600m | 180m | 42000 | 700 | 2400 |
| crystal_berry | 25 | 25000 | 720m | 180m | 60000 | 900 | 2917 |
| starfruit | 30 | 50000 | 1080m | 60m | 100000 | 1200 | 2778 |

*profit/hr = (rewardGold−cost)/growHours, a heuristic; realized value depends on order demand.

## 3. Leveling — XP curve (`xpRequired` cumulative)

L1:0 L2:25 L3:60 L4:120 L5:220 L6:340 L7:480 L8:650 L9:850 **L10:1100** L11:1400 L12:1750 L13:2150 L14:2600 L15:3100 L16:3700 L17:4400 L18:5200 L19:6100 L20:7100 L21:8300 L22:9700 L23:11300 L24:13100 L25:15100 L26:17400 L27:~20k L28:~23k L29:26500 L30:30500. Crop tiers unlock at L1/5/10/15/20/25/30. **L10 unlocks Farmer's Pool.**

## 4. Storage / inventory

Seed inventory capacity (`inventoryCapacity`, base 30). Upgrades bought in Store > Items:
Small Storage Crate (cap 75, 25,000g), Big Storage Crate (cap 125, 100,000g), Farm Storage Chest (cap 200, 500,000g).

## 5. Tasks / progression systems

- **starterTasks** (onboarding, `starter:complete/request`): join → open_store → buy_seed → select_seed → hoe_tile → plant_crop → harvest_crop → buy_plot → clear_plot (Pickaxe) → buy_chest (Upgrade Seed Storage) → complete_order … each gives gold/xp. `{currentTaskId, completed[], starterSeedsGranted}`.
- **orders** (`order:complete/request`): `{id, requires:{crop:qty}, rewards:{gold,xp}}`. Complete when basket covers requires → gold+xp, consumes crops, **new order auto-added**. Main gold source.
- **farmJobs** (`farmJob:claim/request`): `{id, progressType, current, target, rewards:{gold,xp}}` e.g. "Earn 250 Gold". Claim at current≥target → **new job auto-added**.
- **questChapters** (auto-progress, NO claim action): chapters with tasks like "reach level 5", "plant Tomato", "complete a level 5 order", "earn 1,000 gold". Advancing chapters is passive.
- **Crop Mastery** (`MasteryPanel`): harvesting the same crop repeatedly builds mastery (has a "Max mastery" cap) — bonus per crop. Tracked in `cropMastery`.
- **Achievements** (`AchievementsPanel`), **farmValue / farmRank / farmPoints** (TopFarmers metrics: farmRank, farmValue, ordersCompleted, jobsClaimed, landOwned, cropMastery, starfruitHarvests).

## 6. Land / plots

Tiles: `ownerState: locked|buyable|owned`, `groundState: grass|tilled|planted`, `blocker: none|weed|rock|tree`. `plot:buy/request {tileX,tileY}` unlocks a buyable plot (price scales with `ownedPlots`; clearing blockers needs the Pickaxe/axe). Player metric `landOwned`.

## 7. Social

`/api/friends*` (request/respond/remove/cancel), `/api/friends/farms`, `VisitPanel` (visit/share other farms via farmSlug, `/api/farms/by-slug`), `/api/chat` + `/api/broadcast` chat, `TopFarmersPanel` leaderboard (`/api/leaderboard`).

## 8. Transport — socket primary, REST fallback

Primary = socket.io (see `docs/PROTOCOL.md`). The client also has a REST mirror: `/api/game/action`, `/api/move`, `/api/snapshot`, `/api/join`, `/api/heartbeat`, `/api/game/snapshot`. Bot uses socket; REST mirror is a fallback option if socket is ever blocked.

## 9. Bot strategy implications

1. **Early (L1–10):** rush XP+gold — plant best affordable crop, fulfill orders/jobs/starter, auto-expand plots, upgrade storage. Target L10 fast.
2. **L10+:** unlock Farmer's Pool → maximize daily **claim power** (gold ÷250k + farmPoints ÷100), contribute, claim $FARM. This is the withdrawable profit.
3. **Crop choice:** prefer crops demanded by open orders; else highest profit/hr that's unlocked+affordable; respect `deathSeconds` (don't plant a long crop you can't harvest in time across active-hours/downtime).
4. **Never spend real money** (stars). Mastery + achievements + farm value accrue passively from playing.
5. **TODO features:** auto-contribute/claim farmer-pool at L10, storage upgrades, mastery-aware crop rotation, friend/visit bonuses.
