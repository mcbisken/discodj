# discodj 🎶

**discodj** is a modern, feature-rich Discord music bot built with **discord.js v14** and **@discordjs/voice**, powered by **yt-dlp**, **ffmpeg**, and **Node.js**.  
It can play songs from **YouTube** and **Spotify** links, manage queues, display rich “Now Playing” embeds, and includes thoughtful UX details like automatic cleanup and persistent data.

---

## ✨ Features

- 🎧 **Slash Commands**: `/play`, `/queue`, `/skip`, `/prev`, `/stop`, `/seek`, `/shuffle`, `/volume`, `/join`, `/leave`, `/autoplay`, `/pause`, `/resume`
- 📦 **YouTube Support**:  
  - Search via `youtube-search-api`
  - Stream via `yt-dlp` and `ffmpeg`
- 🎵 **Spotify Support**:  
  - Supports track, album, and playlist URLs  
  - Automatically maps Spotify items to YouTube equivalents and fetches durations
- 💬 **Rich Embed Panel**:  
  - Thumbnail of the current track  
  - Progress bar with elapsed/total time  
  - “Up next” section (top 5 songs, with durations)  
  - Autoplay status shown (Loop field hidden)
- 🧠 **Smart UX**:  
  - Auto-deletes transient messages (e.g., “Queued” or “Playing”) after 10 seconds  
  - Auto-leaves when channel empty  
  - Automatically refreshes the Now Playing panel  
  - Presence displays currently playing song
- 🐳 **Docker Ready**: lightweight Alpine image with `ffmpeg` and `yt-dlp` preinstalled
- 🔁 **Autoplay Mode** and **Spotify conversion** built in

---

## 🧩 Requirements

### For All Setups
- A Discord **bot token** (create one at [Discord Developer Portal](https://discord.com/developers/applications))
- The bot must have these permissions in your server:
  - **Text**: Send Messages, Embed Links, Read Message History
  - **Voice**: Connect, Speak

### For Local (Non-Docker) Setup
- Node.js **v22.12.0** or higher
- `ffmpeg` and `yt-dlp` installed on your system and available in your PATH
- Python 3 + build tools (for compiling native dependencies like opus)

### For Docker Setup
- Docker Engine and Docker Compose installed  
- The provided `Dockerfile` and `docker-compose.yml` already include all dependencies

---

## ⚙️ Configuration

Create a `.env` file in the project root (based on `.env.example`):

```
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_guild_id_here
```

- `DISCORD_TOKEN`: required — your bot’s token from the Discord Developer Portal  
- `GUILD_ID`: optional — if set, slash commands register instantly for that guild; if omitted, commands register globally (may take up to an hour)

---

## 🚀 Running with Docker (Recommended)

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and fill in your bot token (and guild ID if you want instant command updates).

2. Build the image:
   ```bash
   docker compose build --no-cache
   ```

3. Start the bot container:
   ```bash
   docker compose up -d
   ```

4. View logs:
   ```bash
   docker compose logs -f
   ```

Your bot will appear online and begin registering slash commands automatically.

---

## 💻 Running Locally (Node.js)

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file with your Discord token and optional guild ID.

3. Start the bot:
   ```bash
   npm start
   ```

Make sure `ffmpeg` and `yt-dlp` are installed and available globally (`ffmpeg -version`, `yt-dlp --version`).

---

## 🕹️ Commands Overview

| Command | Description |
|----------|--------------|
| `/play <query>` | Play a YouTube/Spotify link or search term |
| `/queue` | Show current queue |
| `/skip` | Skip the current song |
| `/prev` | Play the previous song |
| `/stop` | Stop and clear the queue |
| `/seek <time>` | Seek to a specific timestamp (e.g. `1:23`) |
| `/shuffle` | Shuffle the queue |
| `/volume <0–200>` | Set playback volume |
| `/join` | Join your current voice channel |
| `/leave` | Leave the voice channel |
| `/autoplay` | Toggle autoplay on/off |
| `/pause` | Pause current song |
| `/resume` | Resume playback |

---

## 🔍 Troubleshooting

| Problem | Solution |
|----------|-----------|
| **Slash commands not appearing** | Ensure the bot has the `applications.commands` scope and correct token; wait up to 1 hour for global command propagation |
| **Bot doesn’t play audio** | Check that it has permission to Connect & Speak, and that ffmpeg is installed |
| **“yt-dlp failed” errors** | Update yt-dlp (`yt-dlp -U`) or check network/firewall settings |
| **Progress bar or duration missing for Spotify** | The bot automatically fetches YouTube metadata, but ensure `yt-dlp` is working correctly in your environment |
| **Crash or unhandled error** | The bot now has global error handlers, but check logs under `docker compose logs` |

---

## 🧪 Development Notes

- **Language:** Node.js (ESM modules)  
- **Main entry:** `src/bot.js`  
- **Voice Engine:** `@discordjs/voice` with Opus & FFmpeg pipeline  
- Commands auto-register on startup (guild or global depending on `.env`)

---

## 📄 License

MIT License © 2025 discodj Developers

---

### ❤️ Contributions

Pull requests and feature ideas are welcome!  
For suggestions, open an issue or share improvements like new audio sources, playlist persistence, or enhanced UI.
