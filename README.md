# FarmTown Sentinel 🌾

A headless, 24/7 automation bot for **[play.farmtown.online](https://play.farmtown.online)**.
It farms gold/XP, completes orders, jobs and quests, auto-expands your land, earns
**$FARM** from the Farmer's Pool, and is fully controllable from **Telegram** — built
for resilience with anti-ban timing, anti-cheat-safe serial actions, auto-reconnect,
and automatic session refresh.

> ⚠️ **Use a burner Solana wallet, not your main one.** This is automation against a
> live game — run it at your own risk. Never share or commit your `.env`.

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
| `DISPLAY_NAME` | ➖ | In-game name. Default `ohmaygawd`. |
| `ACTIVE_HOURS` | ➖ | Anti-ban sleep window, `HH:MM-HH:MM` or `24h`. Default `06:00-23:30`. |
| `WITHDRAW_ADDRESS` | ➖ | Your main wallet to withdraw earned `$FARM` to. Blank = withdraw disabled. |
| `SOLANA_RPC` | ➖ | RPC for `/wallet` balance + withdraw. Default is the public (rate-limited) endpoint. |
| `FARMER_POOL` | ➖ | `off` to disable Farmer's Pool earning. Default on. |
| `POOL_BURN_GOLD` | ➖ | `on` to also burn gold into the pool (default: only free farm-points). |

---

## 🤖 Telegram commands

**Info** — `/status` `/balance` `/farm` `/inventory` `/basket` `/orders` `/jobs`
`/quests` `/mastery` `/stats` `/pool` `/economy` `/wallet`

**Control** — `/start` `/stop` `/pause` `/resume` `/autopilot on|off` `/objective gold|xp|balanced`
`/setcrop <crop>` `/reserve <gold>` `/sethours <window>` `/poolburn on|off`

**Actions** — `/harvest` `/plant <crop>` `/plantall <crop>` `/buyplot` `/buyseed <crop> [qty]`
`/upgradestorage` `/claimpool` `/auth <paste>` `/reconnect` `/restart`

**Diagnostics** — `/log [n]` `/ping` `/help`

The bot also **pushes alerts**: 🟢 joined, 🔴 disconnected, 🟠 **server degraded /
maintenance** (with "safe to /stop now, /start later" guidance), ✅ **server recovered**,
and ⚠️ **session expired** (with the re-paste one-liner).

---

## 🧠 How it farms (the brain)

Each tick the planner runs, in order: **harvest** ready crops → **clear** blockers
(pickaxe for rock/stone, axe for trees/weeds) → **hoe** → **plant** → **buy seeds** →
**claim** starter tasks, orders and jobs → **auto-expand** adjacent plots → **upgrade
storage**.

Crop selection is **order-demand-aware**: it first sows exactly what your open orders
need (case-insensitive, netted against your basket and what's already growing — orders
are the main gold source), then fills the rest of your tiles with a **70 / 30 split**:
~70 % your highest profit/hr crop, ~30 % rotated variety (seeds future orders, crop
mastery and quest chapters — no brittle monoculture).

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
| | `src/game/state.js` | in-memory mirror of farm state (server = truth) |
| | `src/game/actions.js` | serial executor: backpressure-safe, walk-then-act |
| | `src/game/brain.js` | planner: harvest→clear→hoe→plant→buy→claim→expand |
| | `src/game/farmerpool.js` | $FARM earning (poll → decide → claim) |
| Safety | `src/safety/humanizer.js` | gaussian delays, walk realism, active-hours |
| Control | `src/telegram/bot.js` | command router + push notifications |
| Core | `src/core/orchestrator.js`, `src/index.js` | lifecycle, reconnect, tick loop |

Deep dives: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) (reverse-engineered wire protocol),
[`docs/GAME_MECHANICS.md`](docs/GAME_MECHANICS.md) (economy, orders, pool).

---

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
npm test     # node --test — pure-logic units (planner, economy, auth parsing, …)
```

---

## 🔒 Security

`.env`, `data/` (session, logs), `*.har`, cookies and any `*secret*`/`*key*` files are
**git-ignored** and never leave your machine. The repo ships only source, docs, tests
and public game data (`data/economy.json`). If you fork or redeploy, keep it that way.

## License

MIT — see [`LICENSE`](LICENSE). Provided as-is, for educational purposes. You are
responsible for complying with FarmTown's terms.
