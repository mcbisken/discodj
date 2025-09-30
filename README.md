
# DISCODJ - DISCORD MUSIC BOT (Docker) — Detailed Guide

A modern, Dockerized Discord music bot that plays audio from YouTube (via `yt-dlp` + `ffmpeg`) and supports Spotify links (tracks, albums, playlists) by resolving them to YouTube. It features YouTube autocomplete for `/play`, a rich control panel embed, auto-refreshing UI, and smart voice behavior.

---

## ✨ Features

- **/play with YouTube Autocomplete** — type a song name and pick from suggestions.
- **Spotify URLs** — track/album/playlist links are resolved to playable YouTube results (no API keys).
- **Control Panel** — big artwork, “Next up (top 5)”, and buttons (Prev / Pause-Resume / Skip / Stop).
- **Auto-refresh Panel** — updates automatically when a new track starts.
- **Presence** — bot sets its Discord status to the current track title while playing.
- **Voice** — stays in the channel while idle; auto-leaves when **no human users** remain.
- **Persistence** — queue/history/settings saved to `./data` (bind-mounted into the container).
- **Docker-first** — reproducible and portable (Node 22 + Alpine).

---

## 🧰 Requirements

- **Docker Desktop** (Windows/macOS) or **Docker Engine** (Linux).  
- A **Discord account** with permission to add a bot to your server.
- A **Discord Bot Token** and **Guild (Server) ID** (instructions below).

> No external API keys are required for YouTube search or Spotify resolving.

---

## 🧾 Create a Discord Application & Bot

1. Go to the **[Discord Developer Portal](https://discord.com/developers/applications)** → **New Application**.  
2. Name it (e.g., `DJ Discord`) → **Create**.
3. In the left sidebar, **Bot** → **Add Bot** → **Yes, do it!**  
4. Under **TOKEN** click **Reset Token** → copy the token (you’ll need it for `.env`).  
   - Keep it **secret**. Treat like a password.
5. **Privileged Gateway Intents** (on the same Bot page):  
   - **Server Members Intent**: *Not required* for this project.  
   - **Message Content Intent**: *Not required* — we use slash commands.  
6. **Invite the bot to your server**:  
   - Go to **OAuth2 → URL Generator**  
   - **Scopes**: tick `bot` and `applications.commands`  
   - **Bot Permissions**:  
     - General: `Read Messages/View Channels`, `Send Messages`, `Embed Links`, `Use External Emojis` (optional)  
     - Voice: `Connect`, `Speak`  
   - Copy the generated URL and open it in your browser to add the bot to your server.
7. Get your **Guild (Server) ID**:  
   - In Discord → **User Settings** → **Advanced** → enable **Developer Mode**.  
   - Right-click your server’s icon → **Copy Server ID**.

---

## 🔐 Environment Variables

Create a `.env` next to `docker-compose.yml` (copy from `.env.example`):

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_server_id_here
```

- `DISCORD_TOKEN` — the token from the Developer Portal (Bot page).
- `GUILD_ID` — the server where slash commands will be registered.  
  > Commands are registered **per-guild** on startup for fast availability.

---

## 🚀 Quick Start (Docker)

```bash
# from the project folder where docker-compose.yml lives
docker compose build --no-cache
docker compose up -d
docker compose logs -f
```

You should see:
- `Logged in as ...`
- `Slash commands registered.`

If commands don’t appear in Discord:
- Ensure `GUILD_ID` matches the server you’re testing in.
- Fully restart your Discord desktop/mobile client (cached command metadata).

---

## 🎮 Commands

All commands are slash commands:

- **/play** `<q>` — Play a YouTube/Spotify URL, playlist URL, or a **search query** (with autocomplete).  
  - When a playlist (YouTube or Spotify) is provided, up to **100** items are enqueued.
- **/queue** — Show/refresh the player panel (embed with controls & next-up list).
- **/skip** — Skip the current track.
- **/prev** — Play the previous track (re-queues current track first).
- **/stop** — Stop playback and clear the queue.
- **/leave** — Disconnect from the voice channel (cleans up presence too).
- **/volume** `<0–200>` — Set volume (panel UI does **not** display volume).
- **/seek** `<mm:ss | seconds>` — Jump to a timestamp in the current track.
- **/shuffle** — Shuffle upcoming items in the queue.
- **/loop** `<off | one | all>` — Loop modes.
- **/autoplay** `<true|false>` — Radio-like “related” continuation when queue ends.

**Buttons in the panel**
- **Prev**, **Pause/Resume**, **Skip**, **Stop**

---

## 🧠 Behavior Notes

- **Presence**: while a track plays, the bot’s activity shows the track title.
- **Stay & Auto-leave**: the bot remains in the voice channel while idle; if the channel becomes empty (no human users), it disconnects automatically.
- **Big Artwork**: the panel uses the embed image slot for a larger thumbnail.
- **Next up preview**: shows the first 5 items with who requested them (mentions only).

---

## 🎵 Spotify Support

- Handled via `spotify-url-info` — no Spotify API keys needed.
- Supported URL types: **track**, **album**, **playlist**.
- Each item is resolved to a **YouTube search** (`"title artist"`) and enqueued.  
- Large playlists are capped to **100** tracks per request to stay responsive.

---

## 🧱 Tech Stack

- **Node.js 22 (Alpine)** in Docker
- **discord.js v14**
- **@discordjs/voice** + **@discordjs/opus** (+ **@snazzah/davey** for DAVE protocol)
- **yt-dlp** + **ffmpeg** streaming pipeline
- **youtube-search-api** (no API key) for search & autocomplete
- **spotify-url-info** for Spotify metadata resolving
- Data persisted in **./data** (JSON state per guild)

---

## 🔧 Troubleshooting

**1) “Cannot utilize the DAVE protocol … @snazzah/davey not installed.”**  
We include `@snazzah/davey`. If you see this, ensure you rebuilt the image:
```bash
docker compose build --no-cache
docker compose up -d
```

**2) Opus errors (`Cannot find module '@discordjs/opus'`)**  
We install `@discordjs/opus` and `opusscript` and Alpine build tools (`python3 make g++`). Rebuild without cache:
```bash
docker compose build --no-cache
```

**3) Slash commands not showing**  
- Verify `GUILD_ID` is your test server.  
- Restart Discord client to clear cached command list.  
- Check logs for `Slash commands registered.`

**4) No audio / voice timeouts**  
- Ensure the bot has **Connect** and **Speak** permissions in the voice channel.  
- Try a different voice region or reconnect the bot with `/leave` then `/play`.

**5) yt-dlp extraction issues**  
- This build uses Alpine `yt-dlp` from APK; it updates with the container image.  
- If YouTube changes break extractors, rebuild the image to update `yt-dlp`.

**6) Autocomplete not appearing**  
- Only shows for **text queries** (URLs will not produce suggestions).  
- Discord caches command schema; restart the client if needed.

---

## 🔄 Updating

To pull in fresh dependencies (e.g., yt-dlp/discord.js updates), rebuild:
```bash
docker compose build --no-cache
docker compose up -d
```

---

## 🧪 Running without Docker (optional)

If you prefer node locally:
```bash
# Node 22 recommended
npm install
DISCORD_TOKEN=... GUILD_ID=... node src/bot.js
```
**You must have:** `ffmpeg`, `yt-dlp`, and build tools for `@discordjs/opus` available on your system PATH.

---

## 🔒 Security Best Practices

- **Never** commit your `.env` with `DISCORD_TOKEN` to Git.  
- Restrict bot permissions to the minimum required (Connect, Speak, Send Messages, Embed Links).  
- Consider using a **throwaway bot** for development servers.

---

## 📂 Project Layout

```
.
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
├─ .env.example
├─ src/
│  └─ bot.js
└─ data/              # state persistence (bind-mounted)
```

---

## ✅ Done!

Once you see `Logged in as ...` and `Slash commands registered.`, hop into your server and try:
```
/play never gonna give you up
```
Pick a suggestion from the autocomplete dropdown, or paste a YouTube/Spotify URL.
