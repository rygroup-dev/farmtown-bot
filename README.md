# FarmTown Sentinel 🌾

> **A RY GROUP project** — a headless, 24/7 automation engine for
> **[play.farmtown.online](https://play.farmtown.online)**.

Farms gold/XP, completes orders/jobs/quests, auto-expands land, earns withdrawable
**$FARM** (Token-2022) from the Farmer's Pool, and runs **up to 1000+ accounts at once** —
all from one **Telegram** bot. Built for resilience: anti-ban timing, anti-cheat-safe serial
actions, auto-reconnect, self-refreshing sessions, and a degraded-server/maintenance detector.

### ✨ Highlights
- 🧠 **Smart farming brain** — order-demand-aware planting, **50 / 30 / 20** sacrifice/variety/profit
  crop mix (starfruit + crystal berry for pool power), dead-crop recovery, land expansion, storage upgrades.
- 🌟 **Falling star auto-collector** — detects server-spawned stars on your farm and
  auto-claims them before they expire. **Free stars from gameplay** — no purchase needed.
- 💎 **Farmer's Pool ($FARM)** — pool-timing-aware (countdown, early bird +10% bonus),
  auto-contributes free farm-points repeatedly; optional surplus-gold and **level-sacrifice**
  strategies (with hard guardrails). Crop sacrifice tracking ready for when the server enables it.
- 👥 **Multi-account** — 1 main + up to 1000 auto-generated sub-wallets, each its own
  farm/session, with **captcha auto-login** (no per-account browser paste) and
  auto-sweep of all $FARM to your main wallet. Controlled via `MULTI_ACCOUNT_LIMIT` in `.env`.
- 📱 **Telegram control** — 40+ commands: status, balances, manual actions, multi-account
  monitoring, star purchases, live re-login, and proactive alerts.
- 🛡️ **Resilient & quiet** — gaussian human timing, active-hours sleep, zombie-connection
  watchdog, low auth churn, and clear server-degraded/recovered notifications.

> ⚠️ **Use burner Solana wallets, never your main one.** This automates a live game —
> run it at your own risk. Secrets live only in your `.env` / `data/` (both git-ignored);
> never share or commit them.

---

## ⚡ One-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/farmtown-bot/main/install.sh)
```

The installer checks prerequisites, clones the repo, installs dependencies, then
**interactively asks** for your wallet key, Supabase anon key and Telegram token
(secrets are typed silently, written to a `chmod 600` `.env`, never printed or
committed), optionally sets up a 24/7 `systemd` service, and prints the login tutorial.

<details>
<summary>Prefer to do it manually?</summary>

```bash
git clone https://github.com/rygroup-dev/farmtown-bot.git
cd farmtown-bot
npm install
cp .env.example .env      # then fill it in (see Configuration below)
npm run bot               # run in the foreground
```
</details>

---

## 🔑 Logging in (one-time, ~30 seconds)

FarmTown's signup is protected by Cloudflare **Turnstile**, which blocks headless
servers. So instead of signing up, you hand the bot **one fresh browser session** —
after that it refreshes the token itself, indefinitely, with no captcha ever again.

1. Open **https://play.farmtown.online** in your browser and log in / connect your wallet.
2. Press **F12 → Console** and run this (it copies the session straight to your clipboard):
   ```js
   copy(localStorage.getItem(Object.keys(localStorage).find(k=>k.includes('auth-token'))))
   ```
3. Hand it to the bot, either way:
   - **Telegram (easiest):** send `/auth ` then paste (`Ctrl/Cmd+V`) and send.
   - **Manually:** paste it into `data/session.json`.

The bot binds your wallet, joins your farm, and starts working. If the session ever
truly dies it will message you on Telegram with the same one-liner to re-paste.

---

## ⚙️ Configuration (`.env`)

| Variable | Required | Description |
|---|:---:|---|
| `SOLANA_SECRET_KEY` | ✅ | Burner wallet secret — Phantom base58 export **or** 64-byte JSON array. |
| `SUPABASE_ANON_KEY` | ✅ | FarmTown's public client key. F12 → Network → any `*.supabase.co` request → copy the `apikey` header. |
| `TELEGRAM_BOT_TOKEN` | ➖ | From [@BotFather](https://t.me/BotFather). Without it, remote control is disabled. |
| `TELEGRAM_CHAT_ID` | ➖ | Your chat id (from [@userinfobot](https://t.me/userinfobot)). Locks the bot to you. |
| `DISPLAY_NAME` | ➖ | In-game name. Default `Farmer`. |
| `ACTIVE_HOURS` | ➖ | Anti-ban sleep window, `HH:MM-HH:MM` or `24h`. Default `06:00-23:30`. |
| `WITHDRAW_ADDRESS` | ➖ | Your main wallet to withdraw earned `$FARM` to. Blank = withdraw disabled. |
| `SOLANA_RPC` | ➖ | RPC for `/wallet` balance + withdraw. Default is the public (rate-limited) endpoint. |
| `FARMER_POOL` | ➖ | `off` to disable Farmer's Pool earning. Default on. |
| `POOL_BURN_GOLD` | ➖ | `on` to also burn surplus gold into the pool (default: only free farm-points). |
| `POOL_BURN_LEVELS` | ➖ | `on` to **sacrifice levels** into the pool for claim power (advanced). Default off. |
| `POOL_LEVEL_FLOOR` | ➖ | Never sacrifice below this level. Default `10` (recommended `13` to keep mid crops). |
| `POOL_SACRIFICE_AT` | ➖ | Only sacrifice once an account reaches this level. Default `0` (always); use `30` (max) to only burn wasted post-cap XP. |
| `MULTI_ACCOUNT` | ➖ | `on` to run sub-accounts concurrently (see Multi-account). Default off. |
| `MULTI_ACCOUNT_LIMIT` | ➖ | Cap how many generated subs actually run (`0` = all). Stage the rollout. |
| `CAPTCHA_API_KEY` | ➖ | 2Captcha/Anti-Captcha/CapMonster key → auto-mints a session per sub (no paste). |
| `CAPTCHA_ENDPOINT` | ➖ | Override the solver host (default `https://api.2captcha.com`). |

---

## 🧠 The farming brain

Each tick the planner runs, in order: **collect falling stars** → **harvest** ripe crops →
**clear dead crops** → **clear blockers** (pickaxe for rock/stone, axe for trees/weeds) →
**hoe** → **plant** → **buy seeds** → **claim** starter tasks, orders & farm jobs →
**auto-expand** adjacent plots → **upgrade storage**.

Crop choice is **order-demand-aware**: it sows exactly what your open orders need first
(case-insensitive, netted against your basket and what's already growing), then fills the
rest with a **50 / 30 / 20 split**:

| Slot | % | What gets planted |
|------|---|-------------------|
| **Sacrifice** | 50% | Starfruit (2 pool power) + Crystal Berry (1 pool power) — rotated |
| **Variety** | 30% | All other unlocked crops — seeds future orders, mastery, quests |
| **Top profit** | 20% | Best profit/hr crop (usually Crystal Berry at L25+) |

When pool earning is disabled (`FARMER_POOL=off`), the sacrifice slots fold back into the
classic 70/30 profit/variety split. Expansion uses a **farm-size-scaled gold reserve**
(250 gold × owned plots) so a big farm never starves its own re-planting.

---

## 🤖 Telegram commands

**Info** — `/status` `/balance` `/farm` `/inventory` `/basket` `/orders` `/jobs`
`/quests` `/mastery` `/stats` `/pool` `/economy` `/wallet`

**Control** — `/start` `/stop` `/pause` `/resume` `/autopilot on|off` `/objective gold|xp|balanced`
`/setcrop <crop>` `/reserve <gold>` `/sethours <window>` `/poolburn on|off`

**Actions** — `/harvest` `/plant <crop>` `/plantall <crop>` `/buyplot` `/buyseed <crop> [qty]`
`/upgradestorage` `/claimpool` `/auth <paste>` `/reconnect` `/restart`

**Stars & fund** — `/starmain <bundle>` `/starsub <bundle>` `/sendfarm <amount>` `/sendfee <SOL>` `/retrystar`

**Multi-account** — `/accounts` `/subacc` `/genwallets <n>` `/mintsession` `/sweep`

**Diagnostics** — `/log [n]` `/ping` `/help`

The bot also **pushes alerts**: 🟢 joined (labelled per account, with real level/gold),
🔴 disconnected, 🟠 **server degraded / maintenance** (with "safe to /stop now, /start
later" guidance), ✅ **server recovered**, ⚠️ **session expired** (with the re-paste
one-liner), ⭐ **falling star collected**, 🏊 **pool countdown/open/early bird**, and
⚠️ **star gate not met**.

---

## 💎 Farmer's Pool & Stars

The bot auto-earns **$FARM tokens** from the Farmer's Pool. Requirements to enter:
- Level 30+ ✅
- Hold 2,500+ $FARM in wallet ✅
- Buy or collect 3+ Stars this event (star gate)

**Stars** can be earned two ways:
- 🌟 **Falling stars** — spawned randomly on your farm, auto-collected by the bot (free!)
- 💰 **Purchase** — buy with $FARM via `/starmain starter` (3⭐ for ~$5 in $FARM)

**Pool contribution** runs every ~10 min (5 min during early bird +10% bonus window):
- Always burns free **farm points** (zero cost)
- Optionally burns surplus **gold** (`/poolburn on`)
- Optionally **sacrifices levels** for 3× power each (advanced, opt-in via `.env`)

The bot tracks pool timing (`opensAt`, `closesAt`, early bird window) and auto-contributes
the moment the pool opens. `/pool` shows full status including countdown, gates, and
estimated payout.

**$FARM uses Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), not the legacy
SPL Token program — all on-chain operations handle this automatically.

---

## 🛡️ Anti-ban / anti-cheat design

- **Serial action queue** — ≤1 pending action, waits for each `game:actionResult`,
  backs off on `ACTION_BACKPRESSURE`. Zero invalid actions (acts only on server-confirmed state).
- **Human timing** — gaussian-jitter delays, realistic walk-to-tile movement, random
  breaks, and an active-hours "sleep" window.
- **Low auth churn** — reuses the 30-minute wallet session across reconnects and only
  refreshes the Supabase token near expiry (no repeated re-verify, no captcha).
- **Resilient reconnect** — exponential backoff, zombie-connection watchdog, and a clear
  degraded-server signal so you always know what's happening.

---

## 🏗️ Architecture

| Layer | Module | Responsibility |
|---|---|---|
| Config | `src/config.js`, `src/logger.js` | env + constants, logging |
| Auth | `src/auth/session.js` | refresh Supabase token, parse pasted session, keepalive |
| | `src/auth/wallet.js` | ed25519 challenge → verify → `gameplayAllowed` |
| | `src/auth/bootstrap.js` | optional Playwright signup (Turnstile) |
| Net | `src/net/rest.js` | `/api/*` + Supabase HTTP, retry/backoff/timeout, cookie jar |
| | `src/net/socket.js` | socket.io: queue gate, ping, reconnect, event bus |
| Game | `src/game/economy.js` | per-crop economics + profit/xp ranking |
| | `src/game/state.js` | in-memory mirror of farm state + falling stars (server = truth) |
| | `src/game/actions.js` | serial executor: backpressure-safe, walk-then-act |
| | `src/game/brain.js` | planner: stars→harvest→clear→hoe→plant→buy→claim→expand |
| | `src/game/farmerpool.js` | $FARM earning (pool timing, sacrifice, early bird) |
| | `src/game/wallet_info.js` | on-chain balance, withdraw, star purchase, Token-2022 |
| Safety | `src/safety/humanizer.js` | gaussian delays, walk realism, active-hours |
| Control | `src/telegram/bot.js` | command router + push notifications |
| Core | `src/core/orchestrator.js`, `src/index.js` | lifecycle, reconnect, tick loop |

Deep dives: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) (wire-protocol reference),
[`docs/GAME_MECHANICS.md`](docs/GAME_MECHANICS.md) (economy, orders, pool).

---

## 👥 Multi-account (opt-in)

Run **1 main + up to 1000 sub-wallets** at once, all from one Telegram bot, with every
sub's earned `$FARM` auto-swept to your main wallet. Control how many actually run with
`MULTI_ACCOUNT_LIMIT` in `.env`.

A server constraint shapes the design: **one Supabase session authorizes only one wallet
at a time**, and anonymous sign-up is captcha-gated — so *each account needs its own
session*. With a `CAPTCHA_API_KEY` the bot **auto-mints** a session per sub (no browser
paste); you only fund each sub a little SOL for gas.

**Setup**
```
/genwallets 10         # generate 10 sub-wallets (data/wallets.json, chmod 600)
/mintsession           # verify your CAPTCHA_API_KEY works (mints a throwaway session)
/accounts              # list every wallet + on-chain SOL/$FARM + live level/gold
# in .env:  MULTI_ACCOUNT=on   MULTI_ACCOUNT_LIMIT=5   →  systemctl restart
/accounts              # watch subs mint sessions, join, and grind starter tasks
/sweep                 # collect all sub $FARM → main (also automatic ~every 1.5h)
```

- **`MULTI_ACCOUNT_LIMIT`** stages the rollout — start at 5, verify, then raise.
- Sub-accounts farm with **0 SOL**; they only need a little SOL when they *sweep* $FARM
  to main (auto-skipped until funded).
- **Level-sacrifice** (`POOL_BURN_LEVELS=on`, `POOL_LEVEL_FLOOR=13`, `POOL_SACRIFICE_AT=30`)
  pairs well here: at max level, accounts convert otherwise-wasted XP into pool claim power.
- Gated behind `MULTI_ACCOUNT=off` by default — the single-account path is untouched.

> ⚠️ **Ban risk:** many accounts farming 24/7 from a single IP is a detectable pattern.
> Scale gradually and consider per-account proxies. `/accounts` + `/sweep` work regardless.

## 🖥️ Running 24/7 (systemd)

The installer can do this for you. Manually:

```bash
sudo cp farmtown-bot.service /etc/systemd/system/
sudo sed -i "s#/root/farmtown-bot#$(pwd)#g" /etc/systemd/system/farmtown-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now farmtown-bot.service
tail -f data/service.log
```

---

## 🧪 Tests

```bash
npm test     # node --test — 107 tests (planner, economy, pool, stars, auth, telegram, …)
```

---

## 🔒 Security

`.env`, `data/` (session, logs), `*.har`, cookies and any `*secret*`/`*key*` files are
**git-ignored** and never leave your machine. The repo ships only source, docs, tests
and public game data (`data/economy.json`). If you fork or redeploy, keep it that way.

## License

MIT — see [`LICENSE`](LICENSE). Provided as-is, for educational purposes. You are
responsible for complying with FarmTown's terms.
