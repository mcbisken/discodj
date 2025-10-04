# Discord Music Bot

A clean, Docker-ready Discord music bot built on **discord.js v14** and **@discordjs/voice**, using **ffmpeg** + **yt-dlp** for audio. It supports YouTube search/links, Spotify URLs (track/album/playlist → mapped to YouTube), a rich Now Playing panel, and a simple, reliable queue.

> **Tested Node version:** `>= 22.12.0` (see `package.json` engines)

---

## ✨ Features

- Slash commands: `/play`, `/queue`, `/skip`, `/prev`, `/stop`, `/seek`, `/shuffle`, `/volume`, `/join`, `/leave`, `/autoplay`, `/pause`, `/resume`
- **YouTube**: search via `youtube-search-api`, streaming via `yt-dlp` + `ffmpeg`
- **Spotify**: resolves Spotify track/album/playlist URLs to matching YouTube videos; fetches accurate durations
- **Now Playing panel**:
  - Large **thumbnail**
  - Progress bar + elapsed/total time
  - **Up next:** top 5 upcoming, with titles and durations (no requester ID/tag shown)
  - Shows **Autoplay** status (Loop field is hidden)
- **UX niceties**:
  - `/play` autocompletes YouTube
  - Transient messages auto-delete: “➕ Queued: …” and “▶️ Playing: …” after 10 seconds
  - Stays in channel; auto-leaves when empty
  - Presence shows current track
- **Docker** image with `ffmpeg`, `yt-dlp`, and native voice deps preinstalled

---

## 🧩 Requirements

- **Discord application & bot token**
  - Create at <https://discord.com/developers/applications>
  - Add a **Bot** to the application and copy the **Token**
  - Invite the bot to your server with permissions listed below
- **Permissions needed in the target server/channel**
  - `Send Messages`, `Embed Links`, `Read Message History`
  - **Voice:** `Connect`, `Speak`
- **System tools (when not using Docker)**
  - `ffmpeg` (must be on PATH)
  - `yt-dlp` (must be on PATH)
  - Build tools for native modules (if needed): Python 3, `make`, `g++`

> If you use the provided Docker setup, `ffmpeg` and `yt-dlp` are already installed in the image.

---

## 🔧 Configuration

Create a `.env` in the project root (see `.env.example`):

```
DISCORD_TOKEN=your-bot-token
# Optional: fast dev registration (guild commands). Leave empty to register GLOBAL commands.
GUILD_ID=your-guild-id
```

- If `GUILD_ID` is set, commands are **guild-scoped** (instant).  
- If `GUILD_ID` is **omitted/empty**, commands are registered **globally** (Discord may take up to ~1 hour to propagate).

---

## ▶️ Quick Start (Docker)

1. Copy `.env.example` → `.env` and fill `DISCORD_TOKEN` (and `GUILD_ID` for fast dev if desired)
2. Build:
   ```bash
   docker compose build --no-cache
   ```
3. Run:
   ```bash
   docker compose up -d
   ```
4. Logs:
   ```bash
   docker compose logs -f
   ```

The bot will register slash commands and become available after Discord propagates them (instant with guild commands).

---

## ▶️ Quick Start (Local, without Docker)

1. Install **Node >= 22.12.0**
2. Install system deps: `ffmpeg` and `yt-dlp` must be installed and available on PATH
3. Install NPM deps:
   ```bash
   npm install
   ```
4. Create `.env` and set `DISCORD_TOKEN` (and optionally `GUILD_ID`)
5. Start the bot:
   ```bash
   npm start
   ```

---

## 🕹️ Commands

| Command     | Description                                          |
|-------------|------------------------------------------------------|
| `/play q:`  | Play a URL (YouTube/Spotify) or search keywords.     |
| `/queue`    | Show queue.                                          |
| `/skip`     | Skip current track.                                  |
| `/prev`     | Play previous track (if available).                  |
| `/stop`     | Stop and clear queue.                                |
| `/seek t:`  | Seek to time (e.g., `1:23`).                         |
| `/shuffle`  | Shuffle queue.                                       |
| `/volume n` | Set volume (0–200).                                  |
| `/join`     | Join your current voice channel.                     |
| `/leave`    | Leave the voice channel.                             |
| `/autoplay` | Toggle autoplay on/off.                              |
| `/pause`    | Pause current track.                                 |
| `/resume`   | Resume playback.                                     |

**Notes**

- `/play` supports YouTube **and** Spotify URLs. Spotify items are resolved to matching YouTube videos; the bot fetches YouTube metadata to display accurate durations.
- The bot auto-deletes “Queued” and “Playing” messages after **10 seconds** to keep channels tidy.

---

## 🔍 Troubleshooting

- **Slash commands don’t show up**
  - Ensure the bot is online and has `applications.commands` scope during invite
  - Check `.env` — correct `DISCORD_TOKEN` and `GUILD_ID` (or empty to go global)
  - For global commands, Discord propagation can take **up to ~1 hour**
- **No audio / can’t join/speak**
  - Confirm channel permissions: `Connect` and `Speak`
  - Check server region and voice availability
- **Errors about `ffmpeg` or `yt-dlp` (local run)**
  - Ensure both are installed and available on PATH: `ffmpeg -version`, `yt-dlp --version`
- **Audio cuts or stalls**
  - Network hiccups from sources happen; the bot includes basic retry for `yt-dlp` spawn
- **Durations/progress bar missing**
  - For Spotify URLs, the bot probes YouTube metadata to get real `durationSec`. If still missing, verify that `yt-dlp -J` works from the container/host.

---

## 🧪 Development

- Code is ESM (`type: "module"`). Main entry: `src/bot.js`.
- The bot registers commands on startup (guild or global depending on `.env`).
- Hot-reload is not configured; stop/start the container or process to reload changes.

---

## 📄 License

MIT © 2025
