# OpenCRBot

A self-hosted Cloudflare Workers app that monitors [chess-results.com](https://chess-results.com) tournaments and sends real-time [Pushover](https://pushover.net) notifications for pairings, results, and tournament completion.

Built with **Hono** + **Cloudflare D1** + **server-rendered HTML** (Tailwind CDN). No frontend build step.

## Features

- Monitor multiple players across multiple tournaments simultaneously
- Pushover notifications for: new pairings, match results, tournament completion
- Per-player rating tracking and local Elo estimate
- Clean HTML dashboard — no React, no Vite, no build step
- Quiet hours: skip polling during configured night hours
- Runs on Cloudflare's free tier (Workers + D1)

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account (free)
- A [Pushover](https://pushover.net) account and application

## Setup

### 1. Clone and install

```bash
git clone <your-fork-url>
cd opencrbot
npm install
```

### 2. Create the D1 database

```bash
wrangler d1 create opencrbot
```

Copy the `database_id` from the output and replace `YOUR_D1_DATABASE_ID` in `wrangler.json`.

### 3. Run migrations

```bash
wrangler d1 execute opencrbot --remote --file=schema.sql
```

### 4. Deploy

```bash
npm run deploy
```

Your app is live at `https://opencrbot.<your-subdomain>.workers.dev`.

Log in with `admin` / `admin`. You will be prompted to change these on first login.

### 5. Configure Pushover

1. Create an account at [pushover.net](https://pushover.net)
2. Note your **User Key** from the account dashboard
3. Create a new **Application** — note the **App Token**
4. Go to **Settings** in the OpenCRBot dashboard
5. Enter your App Token and User Key, then click **Save Settings**
6. Click **Send Test Notification** to verify everything works

## Local Development

```bash
npm run dev
```

## Running Tests

```bash
npm test
```

## License

MIT
