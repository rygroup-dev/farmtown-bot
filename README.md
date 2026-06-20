# FarmTown Sentinel 🌾

Headless 24/7 bot for `play.farmtown.online` — auto-farms gold/XP/Stars, completes
quests/orders/jobs, controlled via Telegram. Built for resilience: anti-ban timing,
anti-cheat-safe serial actions, auto-reconnect, session auto-refresh.

> ⚠️ **Security:** never commit `.env`, `cookie`, `*.har`, or `data/`. They are
> gitignored. The repo has no remote by default.

## Architecture

| Layer | Module | Responsibility |
|---|---|---|
| Config | `src/config.js`, `src/logger.js` | env + constants, logging |
| Auth | `src/auth/bootstrap.js` | one-time Playwright signup (solves Turnstile) |
| | `src/auth/session.js` | refresh Supabase token + keepalive (no captcha) |
| | `src/auth/wallet.js` | ed25519 challenge→verify → gameplayAllowed |
| Net | `src/net/rest.js` | `/api/*` + Supabase HTTP, retry/backoff, cookie jar |
| | `src/net/socket.js` | socket.io: queue gate, ping, reconnect, event bus |
| Game | `src/game/economy.js` | per-crop economics + profit/xp ranking |
| | `src/game/state.js` | in-memory mirror of farm state (server = truth) |
| | `src/game/actions.js` | serial executor: backpressure-safe, walk-then-act |
| | `src/game/brain.js` | planner: harvest→clear→hoe→plant→buy→claim |
| Safety | `src/safety/humanizer.js` | gaussian delays, walk realism, active-hours |
| Control | `src/telegram/bot.js` | command router + push notifications |
| Core | `src/core/orchestrator.js`, `src/index.js` | lifecycle + tick loop |

## Setup

```bash
npm install
npx playwright install chromium      # for one-time auth bootstrap
cp .env.example .env                  # then fill SOLANA_SECRET_KEY, SUPABASE_ANON_KEY, TELEGRAM_*
```

### Verify scripts (run under supervision — they hit the live server)

```bash
node scripts/auth-probe.js     # does wallet/challenge need a Supabase session?
node scripts/verify-auth.js    # full auth → expect "gameplayAllowed: true"
node scripts/verify-socket.js  # connect, clear queue, join, dump farmState
node scripts/extract-economy.js # rebuild data/economy.json from HAR/bundle
```

> **Turnstile note:** headless bootstrap is blocked by Cloudflare Turnstile.
> Run the first bootstrap with a display (`headless:false`) or under `xvfb-run`
> on a headless server. Once `data/session.json` exists, the bot refreshes the
> token automatically and never needs the browser again.

## Run

```bash
npm run bot          # foreground
```

## systemd (24/7)

```bash
cp farmtown-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now farmtown-bot.service
systemctl status farmtown-bot.service
tail -f data/service.log
```

## Telegram commands

`/status` `/balance` `/inventory` `/farm` `/stats` `/quests` `/jobs` `/orders`
`/start` `/stop` `/pause` `/resume` `/restart` `/autopilot on|off`
`/harvest` `/sellall` `/buyplot` `/plant <crop>` `/setcrop <crop>` `/log` `/help`

Push notifications: joined/disconnected, refresh failures, etc.

## Tests

```bash
npm test     # node --test, all pure-logic units
```

## Anti-ban / anti-cheat

- Serial action queue, ≤1 pending, waits for `game:actionResult`, backs off on `ACTION_BACKPRESSURE`.
- Gaussian-jitter delays, realistic walk-to-tile, random breaks, active-hours sleep.
- Session reuse (refresh, never re-signup) to avoid repeated captcha.
- Exact `actionId`/`moveId`/`clientSentAt`/`clientDebug` replication of the real client.
- Acts only on server-confirmed state (zero invalid actions).
