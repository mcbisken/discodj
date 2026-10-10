# discodj 🎶

**discodj** is a self-hosted Discord music bot with a slick, button-driven player panel. Paste a YouTube, Spotify or SoundCloud link (or just type a song name) and it plays. It also handles synced lyrics, stackable audio filters, smart autoplay and playlists, and picks up where it left off after a restart.

Built on **discord.js v14** (Components V2), **@discordjs/voice**, **yt-dlp** and **ffmpeg**. Runs great in Docker.

---

## ✨ What's new in v3

- **Brand-new player panel** built with Discord's Components V2: big album art, color-coded by source, a live progress bar, one-tap controls, a filter dropdown and a paged queue with ETAs
- **🎤 Synced lyrics** via LRCLIB, including a karaoke line live on the panel
- **📻 Smarter autoplay** using YouTube's own "Mix" recommendations, without repeats
- **🎛️ Stackable filters**, plus `/speed` and `/pitch`, and 5 new presets
- **📏 Volume normalization**, so no more one song blasting and the next whispering
- **🔁 Resumes after restarts**: it rejoins and continues the song from the same second
- **⚡ Near-instant track changes**: the next song is loaded while the current one plays
- **⏩ SponsorBlock** skips the talking and skits in music videos
- **❤️ Likes and personal playlists**, `/search` picker, `/history`, `/stats`, vote-skip, 24/7 mode, a right-click "Add to queue" and voice channel status
- **Rock-solid playback**: race-free skip/seek/filter changes, automatic recovery when a stream drops mid-song, reconnects when moved, and errors never take the bot down
- Faster playlist loading, a smaller Docker image that runs as a non-root user, a self-updating yt-dlp, a health check, tests and CI

---

## 🎛️ The player panel

One panel per server, edited in place (no spam). If chat buries it, it jumps back to the bottom when the next song starts.

| Row | Controls |
|---|---|
| Transport | ⏮ previous · ⏸/▶ pause/resume · ⏭ skip (or vote) · ⏹ stop · 🔀 shuffle |
| Tweaks | ⏪ −15s · ⏩ +15s · 🔉 / 🔊 volume ±10 · 🔁/🔂 loop off → queue → song |
| Extras | 📻 Autoplay · 📜 Lyrics · 🎤 Live lyrics · ❤️ Like |
| Filters | Dropdown: pick any combination of filters |
| Queue | ◀ ▶ page through what's up next, with when each song will play |

Switch between big artwork and a compact layout with `/settings panel`. Want a tidier panel? `AUDIO_FILTERS=commands` (or `off`) in `.env` removes the filter dropdown.

---

## 🎵 Sources

- **YouTube / YouTube Music**: videos, Shorts, playlists, `?t=` timestamps and live streams. Mixes (`list=RD…`) play just the video.
- **Spotify**: tracks, albums and playlists (incl. `spotify.link` share links). Each song is matched to the best YouTube upload by title, artist and length, which filters out covers, remixes and "10 hours" loops.
- **SoundCloud**: tracks, sets and profiles
- **1000+ other sites** that yt-dlp supports (Bandcamp, Vimeo, Twitch VODs, direct MP3 links, Discord attachments…)
- **Search**: type anything. `/play` autocompletes as you type, and `/search` lets you pick from 10 results.

---

## 🚀 Quick start (Docker, recommended)

```bash
git clone https://github.com/mcbisken/discodj.git && cd discodj
cp .env.example .env          # put your DISCORD_TOKEN in it
docker compose up -d --build
docker compose logs -f
```

To skip building, use the prebuilt image (amd64 + arm64, so it works on a Raspberry Pi too): in `docker-compose.yml`, replace `build: .` with `image: ghcr.io/mcbisken/discodj:latest`.

### Running without Docker

You need **Node.js 22.12+** (24 recommended), plus **ffmpeg** and **yt-dlp** on your `PATH`.

```bash
npm install
cp .env.example .env
npm start            # or: npm run dev  (auto-restarts on code changes)
```

> Install yt-dlp from its [official releases](https://github.com/yt-dlp/yt-dlp#installation) rather than a distro package. That way the bot can keep it up to date automatically.

---

## 🤖 Discord setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications), then go to **Bot**, **Reset Token**, and put the token in `.env`.
2. No privileged intents are needed.
3. Invite the bot (replace `YOUR_CLIENT_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=281479274908672
   ```
   That grants: View Channel, Send Messages, Embed Links, Read Message History, Connect, Speak, Request to Speak (stages) and **Set Voice Channel Status** (optional; shows "🎶 Song" under the voice channel name).

Slash commands register at startup. Set `GUILD_ID` for instant registration in specific servers. Without it, commands register globally (can take a few minutes the first time).

---

## ⚙️ Configuration (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Your bot token |
| `GUILD_ID` | *(global)* | Comma-separated server IDs for instant command registration |
| `DJ_ROLE_ID` | — | Comma-separated role IDs that count as DJ |
| `DEFAULT_VOLUME` | `100` | Starting volume for new servers (0–200) |
| `IDLE_TIMEOUT` | `300` | Seconds before leaving when nothing is playing (`0` = never) |
| `ALONE_TIMEOUT` | `120` | Seconds before leaving once everyone else has left (`0` = never). Music pauses as soon as the channel empties and resumes when someone comes back. |
| `MAX_QUEUE` | `1000` | Queue size limit |
| `MAX_PLAYLIST_SIZE` | `500` | Max tracks taken from one playlist/album link |
| `VOICE_STATUS` | `true` | Show the current song as the voice channel status |
| `AUDIO_FILTERS` | `on` | `commands` hides the filter dropdown on the panel (keeps `/filter`, `/speed`, `/pitch`). `off` removes filters completely: commands, panel menu and any active filters. |
| `YTDLP_AUTO_UPDATE` | `true` | Update yt-dlp at startup and every 24h |
| `YTDLP_UPDATE_CHANNEL` | `stable` | `nightly` gets YouTube fixes days earlier |
| `YTDLP_COOKIES` | — | Path to a cookies.txt (see troubleshooting) |
| `YTDLP_JS_RUNTIME` | `node` | JavaScript runtime yt-dlp uses to solve YouTube's challenges |
| `YTDLP_EXTRA_ARGS` | — | Extra yt-dlp flags, e.g. `--proxy socks5://…` |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `LOG_FORMAT` | `json` | `pretty` for human-friendly local logs |

---

## 🕹️ Commands

### Playback
| Command | |
|---|---|
| `/play <query> [position]` | Song name or link. `position`: end (default), next, or now |
| `/search <query>` | Pick from the top 10 YouTube results |
| `/pause` · `/resume` · `/stop` | |
| `/skip` | Skips for DJs, the song's requester, or when ≤2 people are listening. Everyone else votes (50%). |
| `/prev` | Previous song (or restart the current one if you're more than 5s in) |
| `/seek <time>` | `1:23`, `83`, `1m30s`, or relative: `+30`, `-15` |
| `/nowplaying` · `/lyrics [song]` | |
| `/join` · `/leave` | |
| *Right-click a message → Apps → **Add to queue*** | Plays the link, attachment or song name in that message |

### Queue
| Command | |
|---|---|
| `/queue` | Bring the player panel to this channel |
| `/remove <n or 3-7>` · `/move` · `/jump` | All with autocomplete |
| `/shuffle` · `/clear` · `/dedupe` · `/removeuser <user>` | |
| `/history` | Recently played, with a replay picker |

### Playlists
| Command | |
|---|---|
| `/playlist save <name> [scope]` | Save the queue (with the current song). Scope: 🏠 server (default) or ⭐ personal |
| `/playlist load <name> [shuffle]` | Autocomplete shows your playlists, server playlists and ❤️ Liked Songs |
| `/playlist import <name> <url>` | Make a playlist straight from a YouTube/Spotify/SoundCloud link |
| `/playlist show` · `delete` · `list` | Only the creator or a DJ can overwrite/delete a server playlist |

### Sound & settings
| Command | |
|---|---|
| `/volume <0-200>` · `/loop` · `/autoplay` | |
| `/filter <name>` | Toggles a filter: Bass Boost, Nightcore, Vaporwave, Slowed + Reverb, Chipmunk, Deep Voice, Lo-fi, 8D, Echo, Karaoke, Treble, Vibrato. They stack! |
| `/speed <0.5-2>` · `/pitch <0.5-2>` | Independent of each other |
| `/settings view` | Everything at a glance |
| `/settings 247` · `normalize` · `sponsorblock` · `voteskip` · `livelyrics` · `panel` | |
| `/djonly <on/off>` | Only DJs can control playback (others can still vote-skip) |
| `/stats` · `/help` | Top songs, top DJs and listening time |

**Who's a DJ?** Admins, anyone with Manage Server or Manage Channels, anyone with a `DJ_ROLE_ID` role, or anyone with a role literally named **DJ**. When the bot is in a voice channel, non-DJs need to be in that channel to control it.

---

## 🔍 Troubleshooting

| Problem | Fix |
|---|---|
| **Check if audio works at all** | `docker compose exec discodj node scripts/smoke-audio.js "some song"` tests yt-dlp, ffmpeg, every filter, streaming and seeking without Discord. |
| **"YouTube is asking the bot to sign in"** | YouTube sometimes blocks server/datacenter IPs. Export cookies from a logged-in browser (e.g. the "Get cookies.txt LOCALLY" extension), save them as `data/cookies.txt`, and set `YTDLP_COOKIES=/app/data/cookies.txt`. A throwaway Google account is a good idea. |
| **Random YouTube failures** | yt-dlp updates itself daily; check the logs for `ytdlp.updated`. Try `YTDLP_UPDATE_CHANNEL=nightly` for faster fixes. |
| **Slash commands missing** | Make sure you invited it with the `applications.commands` scope. Set `GUILD_ID` for instant registration. |
| **No voice channel status** | Give the bot the *Set Voice Channel Status* permission (or set `VOICE_STATUS=false`). |
| **Spotify picked the wrong version** | Matching is by title, artist and length. Use `/search` to pick the exact upload, or paste the YouTube link. |
| **Bot left the channel** | It leaves after `IDLE_TIMEOUT` with nothing playing, or `ALONE_TIMEOUT` once everyone's gone. Use `/settings 247 on` to keep it. |
| **More detail** | `LOG_LEVEL=debug` and `docker compose logs -f`. |

---

## ⬆️ Upgrading from v2

Your data carries over automatically: settings, queues and saved playlists in `data/` are migrated on first start.

- The compose service was renamed from `musicbot` to **`discodj`**. Run `docker compose up -d --build --remove-orphans` once to replace the old container.
- `/play`'s option is now `query`, and `position` is end/next/now.
- `/filter` now **toggles** filters (they stack). Use `/filter off` to clear them all.
- The container runs as a non-root user. Existing root-owned files in `data/` are fixed automatically at startup.

---

## 🗂️ Project structure

```
src/
├── index.js              # Boot checks, Discord client, events, graceful shutdown
├── config.js             # All env settings in one place
├── commands/             # Slash + context-menu commands and the dispatcher
├── interactions/         # Buttons/selects, reply helpers, shared flows
├── player/
│   ├── GuildPlayer.js    # Per-server queue + race-free playback state machine
│   ├── audio.js          # yt-dlp → ffmpeg → Discord pipeline (pipe + direct-seek modes)
│   ├── filters.js        # Filter presets → ffmpeg filter chain
│   └── manager.js        # All players + bot presence
├── sources/              # YouTube/Spotify/SoundCloud resolving, search, lyrics, autoplay, SponsorBlock
├── store/                # Crash-safe JSON persistence: guild state, playlists, likes, stats
└── ui/                   # Components V2 panel + message templates
scripts/smoke-audio.js    # End-to-end audio check (no Discord needed)
test/                     # node:test suite, incl. the playback state machine
```

## 🧪 Development

```bash
npm run dev      # run with auto-restart
npm test         # unit + playback engine tests
npm run lint
npm run smoke -- "song or url"
```

GitHub Actions lints, tests, smoke-checks the image, and publishes `ghcr.io/mcbisken/discodj` (amd64 + arm64) on every push to `main` and every `v*` tag.

---

## 📄 License

MIT © discodj contributors
