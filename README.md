# crpush

A self-hosted Cloudflare Workers app that monitors [chess-results.com](https://chess-results.com) tournaments and sends real-time [Pushover](https://pushover.net) notifications for pairings, results, and tournament completion.

Built with **Hono** + **Cloudflare D1** + **Drizzle ORM** + **server-rendered HTML** (Tailwind CDN). No frontend build step.

## Features

- Monitor multiple players across multiple tournaments simultaneously
- Pushover notifications for: new pairings, match results, tournament completion
- Per-player rating tracking and Elo estimate
- Clean HTML dashboard — no React, no Vite, no build step
- Quiet hours: skip polling during configured night hours
- Runs on Cloudflare's free tier (Workers + D1)

## Prerequisites

- Node.js 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (free)
- A [Pushover](https://pushover.net) account and application

## Setup

### 1. Clone and install

```bash
git clone git@github.com:rathnakaragn/crpush.git
cd crpush
npm install
```

### 2. Create the D1 database

```bash
wrangler d1 create crpush
```

Copy the `database_id` from the output and replace `YOUR_D1_DATABASE_ID` in `wrangler.json`.

### 3. Run migrations

```bash
wrangler d1 execute crpush --remote --file=schema.sql
```

### 4. Deploy

```bash
npm run deploy
```

Your app is live at `https://crpush.<your-subdomain>.workers.dev`.

Log in with your `AUTH_PASSWORD` (set via `wrangler secret put AUTH_PASSWORD`).

### 5. Configure Pushover

1. Create an account at [pushover.net](https://pushover.net)
2. Note your **User Key** from the account dashboard
3. Create a new **Application** — note the **App Token**
4. Go to **Settings** in the crpush dashboard
5. Enter your App Token and User Key, then click **Save Settings**
6. Click **Send Test Notification** to verify everything works

## Defaults

| Setting | Default | Change via |
|---------|---------|-----------|
| Timezone | `Asia/Kolkata` | Settings page |
| Quiet hours | 23:00–06:00 | Settings page |
| Cron interval | every 5 minutes | `wrangler.json` → `triggers.crons` |

## Commands

```bash
npm run dev        # wrangler dev (local Worker)
npm run deploy     # wrangler deploy (to Cloudflare)
npm test           # vitest run
npm run test:watch # vitest watch
npx tsc --noEmit   # type-check
```

## License

MIT
