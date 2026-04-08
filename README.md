<p align="center">
  <img src="logo.jpg" alt="VoilaBot Logo" width="160" />
</p><h1 align="center">VoilaBot</h1>
<p align="center"><b>Real-time claim intelligence + auto-execution for Pump.fun — directly in Telegram</b></p><p align="center">
  <img src="https://img.shields.io/badge/platform-Telegram-2CA5E0?logo=telegram" />
  <img src="https://img.shields.io/badge/chain-Solana-9945FF?logo=solana" />
  <img src="https://img.shields.io/badge/built_with-Node.js-339933?logo=nodedotjs" />
</p>---

⚡ What is VoilaBot?

VoilaBot is a real-time claim intelligence tool built for Pump.fun traders.

It detects the exact moment a creator claims fees and instantly delivers that signal to your phone — along with the ability to act on it automatically.

No dashboards. No refreshing. No missed entries.

Send CA → Get signal → Take action

---

🧠 Why VoilaBot Exists

Many traders miss high-quality opportunities because:

- claim events happen unexpectedly
- existing tools are delayed
- constant manual checking isn’t realistic

VoilaBot solves this by turning on-chain events into instant, actionable signals.

---

📱 Built for Mobile-First Trading

Most on-chain tools assume you’re on desktop.

VoilaBot flips that.

- Runs entirely inside Telegram
- No browser or wallet extension needed
- Works anywhere — even on low-end devices
- Push-based alerts instead of manual tracking

👉 Designed for how traders actually operate today.

---

🔥 Features

📡 Real-Time Fee Claim Detection

- Detects all claim instruction types
- WebSocket listener + polling fallback (zero missed events)
- Shows claim size, market cap, volume, age, and socials
- Claim strength tiers:
  - 🚨 Strong (5+ SOL)
  - ⚠️ Medium (2–5 SOL)
  - 💤 Weak (<2 SOL)

---

⚙️ Auto-Buy on Claim

- Optional automated execution on claim detection
- 15-second countdown with cancel button
- Executes via Jupiter v6 (best routing on Solana)
- First-claim-only strategy support
- No duplicate execution

---

🔐 Trading Wallet System

- Dedicated wallet generated inside bot
- Encrypted using user-defined PIN
- Session-based unlock for execution
- Private key export with auto-delete

---

🛡 Safety Controls

- 4-digit PIN required before trades
- Session auto-lock
- Spending limits per token
- Minimum claim threshold filtering
- Kill switch for instant shutdown

---

📊 Token Intelligence

- Market cap & volume (DexScreener)
- Socials & metadata (Pump.fun + Helius DAS)
- Bundle % tracking (GMGN)
- DEX paid status
- Token age

---

🛠 Commands

Command| Description
"/track <CA>"| Track a Pump.fun token
"/list"| View tracked tokens
"/wallet"| Create/manage trading wallet
"/export"| Export private key securely
"/unlock"| Unlock session for auto-buy
"/autobuy"| Configure auto-buy
"/killswitch"| Disable auto-buy instantly
"/help"| Full instructions

You can also paste any Pump.fun CA directly to start tracking.

---

⚙️ How Auto-Buy Works

1. /wallet  →  Create trading wallet → Fund with SOL
2. /unlock  →  Enter PIN → Session unlocked
3. /autobuy →  Select token → Enable + set config
4. Claim detected → 15s countdown (cancel anytime)
5. Execution → Jupiter swap
6. Result → Success or failure notification

---

⚠️ Important

- This bot uses a trading wallet only
- Do NOT store large funds
- Always verify settings before enabling auto-buy

---

⚙️ Setup (Self-Hosting)

Requirements

- Node.js 18+
- Telegram Bot Token from @BotFather
- Helius API Key

Install

git clone https://github.com/TIZDEVS/VoilaBot.git
cd VoilaBot
npm install
cp .env.example .env
node bot.js

Environment Variables

BOT_TOKEN=your_telegram_bot_token
HELIUS_KEY=your_helius_api_key

Never commit ".env".

---

🔐 Data & Privacy

- "data.json" stores user configs (gitignored)
- Private keys encrypted (AES-256-GCM)
- No plaintext key storage
- Only external services used: Helius, DexScreener, Pump.fun, Jupiter

---

🧠 Vision

VoilaBot is not just a claim tracker.

The long-term goal is to evolve into an intelligent on-chain assistant that:

- analyzes developer behavior
- detects patterns and rugs
- evaluates market sentiment
- helps users form conviction instantly

---

🚀 Status

V1 live. Actively evolving.

---

📜 License

MIT

---

<p align="center">
Built by <b>TIZDEVS</b>
</p>