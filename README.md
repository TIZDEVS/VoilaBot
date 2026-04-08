<p align="center">
  <img src="logo.jpg" alt="VoilaBot Logo" width="160" />
</p><h1 align="center">VoilaBot</h1><p align="center"><b>Real-time claim intelligence + auto-execution for Pump.fun — directly in Telegram</b></p><p align="center">
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

- Runs entirely inside Telegram
- No browser or wallet extension needed
- Works anywhere
- Push-based alerts

---

🔥 Features

📡 Real-Time Fee Claim Detection

- Detects all claim instruction types
- WebSocket + polling fallback
- Claim tiers: Strong / Medium / Weak

---

⚙️ Auto-Buy on Claim

- 15-second countdown
- Jupiter execution
- First-claim-only support
- No duplicate execution

---

🔐 Trading Wallet System

- Dedicated wallet
- PIN-based encryption
- Session unlock
- Export with auto-delete

---

🛡 Safety Controls

- PIN required
- Spending limits
- Kill switch
- Threshold filters

---

🛠 Commands

Command| Description
"/track <CA>"| Track token
"/list"| View tracked tokens
"/wallet"| Manage wallet
"/export"| Export key
"/unlock"| Unlock session
"/autobuy"| Configure auto-buy
"/killswitch"| Disable auto-buy
"/help"| Instructions

---

⚙️ Setup

git clone https://github.com/TIZDEVS/VoilaBot.git
cd VoilaBot
npm install
cp .env.example .env
node bot.js

---

⚠️ Important

- Use trading wallet only
- Do NOT store large funds

---

🧠 Vision

VoilaBot aims to evolve into an intelligent on-chain assistant analyzing behavior, patterns, and market signals.

---

🚀 Status

V1 live.

---

📜 License

MIT

---

<p align="center">
Built by <b>TIZDEVS</b>
</p>