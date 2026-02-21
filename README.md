# discodj 🎶

**discodj** is a self-hosted Discord music bot built with **discord.js v14** and **@discordjs/voice**, powered by **yt-dlp**, **ffmpeg**, and **Node.js**. It plays audio from YouTube, SoundCloud, and Spotify, manages paginated queues with ETAs, supports saved playlists, audio filters, and runs cleanly in Docker.

---

## ✨ Features

### 🎵 Audio Sources
- **YouTube** — search by keyword or paste any YouTube URL (videos, playlists, Shorts, embeds, youtu.be links)
- **SoundCloud** — paste any SoundCloud track, set, or artist URL
- **Spotify** — paste track, album, or playlist URLs; the bot maps each item to YouTube and queues lazily (albums/playlists appear instantly without waiting for all lookups to complete)

### 🎛 Audio Filters
Apply FFmpeg filters with `/filter`:

| Filter | Effect |
|--------|--------|
| Bass Boost | Boosts low-end EQ around 40 Hz |
| Nightcore | Speeds up + raises pitch by 1.25× |
| Vaporwave | Slows down + lowers pitch to 0.8× |
| 8D Audio | Rotating stereo panning |
| Echo | Classic echo/delay |
| Karaoke | Attempts to cancel centred vocals |
| Treble Boost | Boosts high frequencies |

Changing a filter while a track is playing immediately restarts it from the same timestamp with the new filter applied. The active filter is displayed in the Now Playing embed.

### 📋 Queue
- Paginated "Up next" embed — 8 tracks per page with **◀ Prev / Next ▶** buttons
- Estimated wait time shown per track (e.g. *in 4:32*)
- Total queue size displayed as an inline field
- Autocomplete on `/jump`, `/remove`, and `/move` — type a number or part of a song title

### 💾 Saved Playlists
- `/playlist save <name>` — snapshot the current queue (including now-playing) as a named playlist
- `/playlist load <name>` — append a saved playlist to the queue; starts playing if idle
- `/playlist delete <name>` — remove a saved playlist
- `/playlist list` — show all saved playlists with track count and save date
- Load/delete have autocomplete — your saved playlists appear as you type

### 💬 Now Playing Panel
- Thumbnail, track title, progress bar (12 slots), elapsed/total time
- Inline fields: Requested by, Duration, Volume (with active filter label), Loop, Autoplay, Queue count
- Button controls: ⏮ Prev · ⏸ Pause/▶ Resume · ⏭ Skip · ⏹ Stop
- Panel auto-refreshes every 10 seconds while playing
- Single panel per guild — edits in place rather than spamming new messages

### 🧠 Smart UX
- **Deduplication warning** — if a track is already in the queue, you get a confirmation prompt ("Add anyway" / "Cancel") before it's queued again
- **Autocomplete on `/play`** — YouTube search results appear as you type
- Auto-deletes transient "Queued" / "Playing" messages after 10 seconds
- Auto-leaves voice when channel is empty (3-second debounce so mobile reconnects don't trigger it)
- Presence shows the currently playing song title

### 🔒 DJ Mode
Enable with `/djonly on`. Restricts play/skip/stop/seek/volume/queue edits to:
- Server admins, Manage Guild, or Manage Channels permission holders
- Optionally: a specific role configured via `DJ_ROLE_ID` in `.env`

### 🔧 Reliability
- **yt-dlp auto-updates** on every startup and again every 24 hours — stale yt-dlp is the #1 cause of playback failures
- YouTube CDN audio URLs cached for 90 minutes
- Per-guild mutex prevents race conditions when commands or buttons fire simultaneously
- Playback error recovery — skips bad tracks and retries up to 5 times before stopping
- Graceful shutdown flushes all guild state on `SIGINT`/`SIGTERM`

### 🐳 Docker
- Lightweight Alpine image with `ffmpeg` and `yt-dlp` preinstalled
- State and playlists persist across container restarts via a named volume
- Structured JSON logs — clean output for `docker compose logs` or any log aggregator

---

## 🧩 Requirements

### For All Setups
- A Discord **bot token** ([Discord Developer Portal](https://discord.com/developers/applications))
- Bot permissions in your server:
  - **Text**: Send Messages, Embed Links, Read Message History
  - **Voice**: Connect, Speak
- OAuth2 scopes: `bot` + `applications.commands`

### For Docker (Recommended)
- Docker Engine and Docker Compose

### For Local (Node.js)
- Node.js **v22.12.0** or higher
- `ffmpeg` and `yt-dlp` installed and available in `PATH`
- Python 3 + build tools (for compiling native Opus bindings)

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_guild_id_here
DJ_ROLE_ID=optional_role_id_for_dj_mode
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | ✅ | Your bot token from the Discord Developer Portal |
| `GUILD_ID` | Optional | Guild ID for instant slash command registration. If omitted, commands register globally (up to 1 hour delay) |
| `DJ_ROLE_ID` | Optional | Role ID that grants DJ access when `/djonly on` is active |

---

## 🚀 Running with Docker (Recommended)

```bash
# 1. Copy and fill in your .env
cp .env.example .env

# 2. Build the image
docker compose build --no-cache

# 3. Start the bot
docker compose up -d

# 4. Follow logs
docker compose logs -f
```

The bot will come online, register slash commands, and check for a yt-dlp update automatically.

---

## 💻 Running Locally (Node.js)

```bash
# 1. Install dependencies
npm install

# 2. Create .env
cp .env.example .env

# 3. Start
npm start
```

Verify your dependencies are available:
```bash
ffmpeg -version
yt-dlp --version
```

---

## 🕹️ Commands

### Playback

| Command | Description |
|---------|-------------|
| `/play <query> [position]` | Play from YouTube, SoundCloud, Spotify, or a search term. `position`: `end` (default), `next`, `top` |
| `/skip` | Skip the current track |
| `/prev` | Play the previous track |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/stop` | Stop playback and clear the queue |
| `/seek <time>` | Seek to a timestamp — `1:23` or `83` (seconds) |
| `/nowplaying` | Show a detailed Now Playing embed |
| `/join` | Join your current voice channel |
| `/leave` | Leave the voice channel and clear the queue |

### Queue

| Command | Description |
|---------|-------------|
| `/queue` | Refresh/show the Now Playing panel |
| `/remove <track>` | Remove a track — autocomplete by number or title |
| `/move <from> <to>` | Move a track to a new position — autocomplete the source track |
| `/jump <track>` | Jump to a track immediately — autocomplete by number or title |
| `/shuffle` | Shuffle the upcoming queue |
| `/clear` | Clear the queue without leaving the channel |

### Playlists

| Command | Description |
|---------|-------------|
| `/playlist save <name>` | Save the current queue (+ now-playing) as a named playlist |
| `/playlist load <name>` | Load a saved playlist into the queue |
| `/playlist delete <name>` | Delete a saved playlist |
| `/playlist list` | Show all saved playlists |

### Settings

| Command | Description |
|---------|-------------|
| `/volume <0–200>` | Set playback volume (100 = normal) |
| `/loop <off\|one\|all>` | Loop mode: off, repeat one, or repeat all |
| `/autoplay <true\|false>` | Toggle autoplay when the queue ends |
| `/filter <name>` | Apply an audio filter (`bassboost`, `nightcore`, `vaporwave`, `8d`, `echo`, `karaoke`, `treble`, `off`) |
| `/djonly <true\|false>` | Restrict controls to admins or the configured DJ role |

---

## 🔍 Troubleshooting

| Problem | Solution |
|---------|----------|
| **Slash commands not appearing** | Ensure `applications.commands` scope is granted. With `GUILD_ID` set, commands register instantly. Without it, global propagation takes up to 1 hour. |
| **Bot doesn't play audio** | Confirm Connect & Speak permissions. Run `ffmpeg -version` and `yt-dlp --version` to verify both are installed. |
| **"yt-dlp failed" errors** | The bot auto-updates yt-dlp on startup and every 24h, but you can also trigger it manually: `docker compose exec discodj yt-dlp -U` |
| **Spotify tracks show wrong song** | Spotify → YouTube mapping is done by title search. Results for remixes or obscure tracks may not be exact — this is a known limitation of not using Spotify's audio API. |
| **SoundCloud track won't play** | Some SoundCloud tracks require authentication or are behind SoundCloud Go+. Try a different track or confirm the URL is public. |
| **Progress bar missing** | Occurs for live streams (no fixed duration) or Spotify placeholder tracks that haven't been resolved yet. |
| **DJ-only message on buttons** | `/djonly on` is active. Use `/djonly off` or ensure the user has the `DJ_ROLE_ID` role or admin permissions. |
| **Bot leaves voice immediately** | The channel was empty. The bot waits 3 seconds before leaving to survive mobile reconnects. |
| **Crash / unhandled error** | Check `docker compose logs` for structured JSON error output. Add `restart: unless-stopped` to `docker-compose.yml` for automatic recovery. |

---

## 🗂️ Project Structure

```
discodj/
├── src/
│   ├── bot.js           # Entrypoint — commands, interactions, playback engine
│   ├── state.js         # Per-guild in-memory state + JSON persistence
│   ├── playlists.js     # Saved playlist read/write helpers
│   ├── locks.js         # Per-guild async mutex
│   ├── logger.js        # Structured JSON logger
│   └── utils/
│       └── ytdlp.js     # yt-dlp spawn helpers (info fetch, playlist expand, retries)
├── data/                # Auto-created at runtime — guild state + playlist JSON files
├── Dockerfile
├── docker-compose.yml
├── package.json
└── .env.example
```

---

## 📦 Keeping Dependencies Up to Date

```bash
# Check for outdated packages
npm outdated

# Apply non-breaking updates
npm update

# Bump all deps including major versions (review changelogs first)
npx npm-check-updates -u
npm install
```

After updating, re-test: `/play`, voice join, skip/prev, panel controls, and filter.

---

## 📄 License

MIT License © 2025 discodj Developers

---

### ❤️ Contributions

Pull requests and feature ideas are welcome! Open an issue or submit a PR.
