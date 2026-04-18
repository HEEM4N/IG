# 📸 Instagram Account Monitor — Discord Bot (v2)

Monitor Instagram accounts for **bans** and **recoveries** — all with a single `/monitor add` command. The bot auto-detects whether an account is live or banned and watches accordingly.

---

## 🗄️ Two Databases

| Database | File | Purpose |
|---|---|---|
| **Monitoring Base** | `monitoring_base.json` | Up to **200 active slots** — accounts currently being tracked |
| **Old Clients** | `old_clients.json` | Permanent archive — all completed/removed accounts with history |

---

## 🚀 Quick Setup

### 1. Prerequisites
- [Node.js](https://nodejs.org) v18 or later
- A Discord account + server where you have Admin permissions

### 2. Install dependencies
```bash
npm install
```

### 3. Create your Discord Bot
1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Add Bot**
4. Under **Token** → click **Reset Token** → copy it
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Mention Everyone`
6. Copy the generated URL and invite the bot to your server

### 4. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
```
DISCORD_TOKEN=your_bot_token
DISCORD_CHANNEL_ID=your_channel_id
DISCORD_GUILD_ID=your_server_id
```

### 5. Run the bot
```bash
node bot.js
```

---

## 💬 Commands

| Command | Who Can Use | Description |
|---|---|---|
| `/monitor add <username>` | Anyone | Add an account — bot auto-detects if it's live or banned |
| `/monitor status <username>` | Anyone | Check the current live status of a monitored account |
| `/monitor remove <username>` | Anyone | Remove from Monitoring Base and archive to Old Clients |
| `/monitor list` | **Owner + permitted users only** | Full report of all accounts across both databases |
| `/monitor grant @user` | **Owner only** | Give a Discord user access to `/monitor list` |
| `/monitor revoke @user` | **Owner only** | Remove a Discord user's access to `/monitor list` |

### Setting up the Owner
The **first person** to run `/monitor grant @someone` becomes the permanent **owner**.
Only the owner can use `/monitor grant` and `/monitor revoke`.

---

## 🔔 How `/monitor add` Works

The bot checks the account immediately when you add it:

### If the account is **LIVE** right now:
> 🟢 **@username IS LIVE** — The bot confirms it's accessible and starts watching. You'll be notified the moment it gets **banned or deleted**.

**Notification when it gets banned:**
> Hey @YourName! Your target **@username** has just gone **BANNED / DELETED** from Instagram.
> 🕐 Banned At: [time] | ⏱️ Time Taken to Ban: 2h 34m

### If the account is **BANNED** right now:
> 🔴 **@username IS BANNED RIGHT NOW** — The bot confirms it's inaccessible and starts watching. You'll be notified the moment it gets **un-banned or recovered**.

**Notification when it gets unbanned:**
> Hey @YourName! Your client's account **@username** is now **UN-BANNED** and back on Instagram! 🎉
> 🕐 Unbanned At: [time] | ⏱️ Time Taken to Unban: 14h 22m

---

## 📋 `/monitor list` Output

Shows everything across both databases:

```
📋 Full Monitoring Report
Monitoring Base: 5/200 slots used | Old Clients Archive: 12 records

🟢 LIVE — Watching for Ban
  🟢 @username1 — added by user#1234 — 450 checks — added 2 hours ago

🔴 BANNED — Watching for Unban
  🔴 @username2 — added by user#5678 — 1200 checks — added 1 day ago

⚫ OLD CLIENTS — BANNED IN PAST
  ⚫ @olduser1 — banned on 14 Apr 2026 — took 3h 12m — by user#1234

🟢 OLD CLIENTS — RECOVERED IN PAST
  🟢 @olduser2 — recovered on 10 Apr 2026 — took 22h 45m — by user#5678

🗑️ OLD CLIENTS — MANUALLY REMOVED
  🗑️ @olduser3 — removed on 8 Apr 2026 — by user#1234
```

---

## ⚠️ Limitations

| Feature | Reality |
|---|---|
| "When will it unban?" timer | ❌ Instagram provides **no** public unban ETA — bot detects the moment it happens |
| Ban reason | ❌ Not available publicly |
| Private accounts | ✅ Can detect when a private account becomes accessible again |
| Accuracy | ~95% — Instagram occasionally shows ambiguous pages |

---

## 🛡️ Safety & Anti-Detection

1. **No login required** — checks only the public profile URL
2. **User-agent rotation** — cycles through realistic browser signatures
3. **Jittered intervals** — checks happen every 9–15 seconds (randomized)
4. **Rate-limit backoff** — auto backs off 60 seconds if Instagram throttles

---

## 📁 File Structure

```
instagram-monitor/
├── bot.js                ← Main Discord bot (redesigned)
├── instagramChecker.js   ← Instagram profile checker (no login)
├── store.js              ← Dual database logic
├── monitoring_base.json  ← Auto-created: active monitoring slots (200 max)
├── old_clients.json      ← Auto-created: archived accounts history
├── permissions.json      ← Auto-created: owner + permitted users for /list
├── .env                  ← Your secrets (NEVER share this!)
├── .env.example          ← Template
└── README.md
```

---

## 🔒 Security

- **Never share your `.env` file** or bot token
- Add `.env` to `.gitignore`:
  ```
  echo ".env" >> .gitignore
  ```
- If your token leaks, immediately **Reset Token** in the Discord Developer Portal
