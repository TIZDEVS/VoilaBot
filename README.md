<p align="center">
  <img src="logo.jpg" alt="VoilaBot Logo" width="160" />
</p>

<h1 align="center">VoilaBot</h1>
<p align="center"><b>Real-time Pump.fun fee claim alerts + auto-buy — right in Telegram</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Telegram-2CA5E0?logo=telegram" />
  <img src="https://img.shields.io/badge/chain-Solana-9945FF?logo=solana" />
  <img src="https://img.shields.io/badge/built_with-Node.js-339933?logo=nodedotjs" />
</p>

---

## What is VoilaBot?

VoilaBot is a Telegram bot that watches any Pump.fun token 24/7 and instantly alerts you the moment the creator claims their fees. No charts to refresh, no dashboards to check — the information comes straight to your phone.

It is built mobile-first. Everything happens inside Telegram, meaning any user with a smartphone can access real-time on-chain data without needing a browser, a wallet extension, or any crypto knowledge beyond a token address.

---

## Features

### Fee Claim Alerts
- Detects all three claim instruction types: `CollectCreatorFee`, `Distribute_creator_fees`, `Transfer_Creator_fees_to_pump`
- Real-time WebSocket listener + 20-second polling fallback for zero missed events
- Shows exact SOL amount claimed, claim number, market cap, volume, age, and socials
- Color-coded tiers: 🚨 Strong (5+ SOL) · ⚠️ Medium (2–5 SOL) · 💤 Weak (<2 SOL)
- One-tap links to Axiom, Trojan, Bloom, Photon, OKX, BullX, Padre, and DexScreener

### Auto-Buy on Claim
- Custodial trading wallet — generated inside the bot and encrypted with your 4-digit PIN
- Session unlock required before any trade executes (auto-locks after your chosen time)
- Configurable per token: buy amount, minimum claim threshold, slippage, priority fee
- 15-second countdown with a cancel button before every trade
- Executes swaps via Jupiter v6 — best on-chain routing on Solana
- First-claim-only rule — fires once per token then disables itself
- Duplicate protection via cross-process atomic file locks
- Kill switch command cancels all active countdowns instantly

### Wallet Management
- `/wallet` — create wallet, view your public address
- `/export` — export private key in JSON array format (Phantom, Solflare, Backpack) and Base58 format; auto-deletes after 60 seconds
- `/unlock` — unlock session with PIN to enable auto-buy
- Change PIN without losing your wallet

### Token Intelligence
- Market cap and 24h volume from DexScreener
- Token image, socials (X, Telegram, Website) from Pump.fun + Helius DAS
- Bundle percentage from GMGN
- DEX paid status indicator
- Token age

---

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and quick start |
| `/track <CA>` | Start tracking a Pump.fun token by contract address |
| `/list` | View all your tracked tokens |
| `/wallet` | Create and manage your trading wallet |
| `/export` | Export your private key securely |
| `/unlock` | Unlock session for auto-buy with your PIN |
| `/autobuy` | Configure auto-buy settings per token |
| `/killswitch` | Disable all auto-buy instantly |
| `/help` | Full help and instructions |

You can also paste any Pump.fun contract address directly into the chat to start tracking.

---

## How Auto-Buy Works

```
1. /wallet  →  Create trading wallet  →  Fund it with SOL
2. /unlock  →  Enter your PIN  →  Session unlocked
3. /autobuy →  Select token  →  Enable + set buy amount
4. Claim detected  →  15-second countdown with cancel button
5. Countdown ends  →  Jupiter swap executes automatically
6. Success: Solscan link sent  |  Failure: notified, retry on next claim
```

---

## Why This Helps Mobile Users

Most on-chain tools require a browser with a wallet extension — impossible on mobile. VoilaBot brings the full picture directly into Telegram:

- No browser required — works on any phone with Telegram installed
- Instant push notifications — no need to watch charts
- Auto-buy executes in the background — you do not need to be at a computer
- All wallet operations (create, export, trade) happen inside the chat
- Clean card-style messages with all key data in one view

---

## Setup (Self-Hosting)

### Requirements
- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Helius API key from [helius.dev](https://helius.dev)

### Install

```bash
git clone https://github.com/TIZDEVS/VoilaBot.git
cd VoilaBot
npm install
cp .env.example .env
# Edit .env and fill in your BOT_TOKEN and HELIUS_KEY
node bot.js
```

### Environment Variables

```
BOT_TOKEN=your_telegram_bot_token
HELIUS_KEY=your_helius_api_key
```

Never commit your `.env` file. It is listed in `.gitignore`.

---

## Data & Privacy

- `data.json` — stores tracked tokens and auto-buy config per user (gitignored)
- Private keys are encrypted with AES-256-GCM using a PBKDF2-derived key from your PIN — they are never stored in plaintext
- No data is sent to any third party beyond Helius RPC, DexScreener, Pump.fun, and Jupiter

---

## License

MIT
