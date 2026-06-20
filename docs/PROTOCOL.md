# FarmTown Protocol Reference (reverse-engineered)

Source: 137MB HAR + live testing, 2026-06-20. Account wallet = `.env` (`di3eko…`).

## Auth (3 stages)
1. **Supabase anon session** (browser, Turnstile-gated): gives `access_token` (ES256 JWT, ~1h) + `refresh_token`. Refresh without captcha: `POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token` with header `apikey: <anon key>`, body `{refresh_token}`.
2. **Wallet bind**: `POST /api/auth/wallet/challenge {walletAddress}` (needs `Authorization: Bearer <access_token>`) → `{challengeId, nonce, message}`. Sign `message` ed25519 (bs58 sig). `POST /api/auth/wallet/verify {challengeId,nonce,walletAddress,message,signature}` → `{gameplayAllowed:true, walletSessionToken, walletAddress, walletSessionExpiresAt}` (30 min).
3. **Wallet session** carried as REST header **`x-farmtown-wallet-session: <walletSessionToken>`** (NOT cookie, NOT bearer). `GET /api/auth/session` with this header → `walletVerified:true, gameplayAllowed:true`. Activity rolls expiry +30m.

## Realtime (socket.io EIO=4, `wss://realtime.farmtown.online/socket.io/`)
Handshake auth (engine.io `40` packet): **`{ accessToken, walletSessionToken, displayName }`** — all three required, else `connect_error: Wallet verification required`.
- Queue gate: `queue:update {position,waiting,capacity,online}` → `queue:ready`. Also `serverNotice` ("Connected…") fires on join readiness.
- Heartbeat: emit `farm:ping {sentAt}` ~4s → `pong {sentAt,serverTime}`.
- Join: emit `farm:join {roomId:"farmtown-dev", name, persistentPlayerId, accessToken}` + `farm:snapshot:request`. Server → `roomJoined {roomId:"farm:<uuid>", localPlayerId}`, `farm:snapshot`, `farm:state/sync {tiles[]}`, `player:farmState/sync {farmState}`. (persistentPlayerId is resolved server-side from the wallet session regardless of what we send.)

## Client → server actions (15)
All game actions include `{ roomId, actionId, clientSentAt }`; tile actions add `tileX, tileY, clientDebug{interactionMode:'farm',networkMode:'socket',intent,selectedTool,selectedSeedId,tile:"x,y"}, action`.
| event | extra payload | notes |
|---|---|---|
| `movementTargetUpdated` | `target{x,y},current{x,y},moveId` | walk; server acks `Move accepted`/`MOVE_ACCEPTED` |
| `player:position` | `target{x,y},current{x,y}` | final position |
| `player:tool/select` | `{tool, seedId}` | before acting when tool/seed changes |
| `tile:hoe/request` | tile | grass→tilled |
| `crop:plant/request` | tile + `seedId` | tilled→planted; consumes 1 seed |
| `crop:harvest/request` | tile | ready→tilled; +1 crop to cropInventory |
| `tile:clear/request` | tile | remove blocker (weed/rock/tree); tool axe |
| `plot:buy/request` | tile | unlock locked tile → owned/grass |
| `store:buySeed/request` | `{seedId, quantity}` | spend gold → seed |
| `order:complete/request` | `{orderId}` | needs cropInventory ≥ requires; +gold+xp, consumes crops, new order added |
| `farmJob:claim/request` | `{jobId}` | needs current≥target; +gold+xp, new job added |
| `starter:complete/request` | `{taskId}` | completes starterTasks.currentTaskId |
| `farm:join` / `farm:snapshot:request` / `farm:ping` | see above | |

## Server → client events (16)
`roomJoined, farm:snapshot, farm:state/sync {tiles[]}, player:farmState/sync {farmState}, tile:update {tile,changedTiles[]}, game:actionResult {actionId,ok,type,message,inventoryDelta,tile}, game:error / farm:error {code,actionId,message}, farm:toast {message}, presence:list, playerList, stats:update {online,capacity,queued}, queue:update, queue:ready, serverNotice, pong`.

actionResult `type` values: `completeStarterTask, buySeed, hoe, plant, harvest, buyPlot, completeOrder, claimFarmJob, clear` (+ untyped move acks). Orders & farm jobs **auto-replenish** on completion.

## farmState shape
`gold, xp, level, premiumBalance{stars}, inventory{<crop>_seed:n} (SEEDS), cropInventory{<crop>:n} (HARVESTED), cropMastery, orders[], farmJobs[], chestOwned, inventoryCapacity, selectedTool, selectedSeedId, starterTasks{currentTaskId,completed[],starterSeedsGranted}, completedOrdersCount, completedFarmJobsCount, farmValue, totalHarvestedCrops, farmRank, farmPoints, achievements, questChapters{currentChapterId,chapters[{id,title,completed,current,total,tasks[{label,completed}]}]}`.

- **order**: `{id, templateId, title, requires:{<crop>:qty}, rewards:{gold,xp}, createdAt}`. Completable when cropInventory covers requires.
- **farmJob**: `{id, templateId, title, description, progressType, current, target, rewards:{gold,xp}, category, createdAt}`. Claimable when current≥target.
- **questChapters**: auto-progress, NO claim action — playing advances them.

## tile shape
`{x, y, ownerState:'owned'|'locked'|'buyable', groundState:'grass'|'tilled'|'planted', blocker:'none'|..., cropId, plantedAt, readyAt, diesAt}`. Pixel center = `tile*32+16`.

## Anti-cheat / resilience
- `ACTION_BACKPRESSURE` if >~3 pending → serialize, await `game:actionResult`, backoff retry.
- Replicate `actionId`/`moveId`/`clientSentAt`/`clientDebug` exactly; walk to tile before acting; `player:tool/select` on tool change.
- Other error codes observed: `ACTION_BACKPRESSURE`, `AUTH_HEADER_MISSING` (REST, no Bearer). Handle unknown codes gracefully (don't crash; log + skip).
