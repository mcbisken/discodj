# discodj

Includes:
- YouTube autocomplete in `/play`
- Rich panel with large cover image and “Next up (top 5)”
- Presence shows current track
- Volume removed from panel (use `/volume`)
- Stays in channel; auto-leaves when empty
- Auto-refresh panel when a new track starts
- Spotify **track/album/playlist** support via `spotify-url-info` (no API keys)
- Docker (Alpine) with `ffmpeg`, `yt-dlp`, and native voice deps (`@discordjs/opus` + `@snazzah/davey`)

## Run
1) Copy `.env.example` → `.env` and fill `DISCORD_TOKEN`, `GUILD_ID`
2) `docker compose build --no-cache`
3) `docker compose up -d`
4) `docker compose logs -f`
