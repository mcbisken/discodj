// Central config, parsed once from environment variables.
// Every knob is optional except DISCORD_TOKEN. See .env.example for docs.
import path from 'node:path';

function bool(v, d){
  if (v == null || String(v).trim() === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function int(v, d, min = -Infinity, max = Infinity){
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}
function list(v){
  return String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
// AUDIO_FILTERS: on (default) | commands (no dropdown on the panel) | off (no filters at all).
// Also accepts true/false-style values.
function filterMode(v){
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'on';
  if (['on', 'commands', 'off'].includes(s)) return s;
  return /^(0|false|no|disabled?)$/.test(s) ? 'off' : 'on';
}

// Splits a string of CLI args, honouring simple "double quoted" segments.
function splitArgs(v){
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(v || '')))) out.push(m[1] ?? m[2]);
  return out;
}

export const config = Object.freeze({
  token: process.env.DISCORD_TOKEN || '',
  // Comma-separated list. When set, commands register instantly to these guilds only.
  guildIds: list(process.env.GUILD_ID),
  djRoleIds: list(process.env.DJ_ROLE_ID),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),

  defaultVolume: int(process.env.DEFAULT_VOLUME, 100, 0, 200),
  // Seconds before leaving when nothing is playing (0 = never).
  idleTimeoutSec: int(process.env.IDLE_TIMEOUT, 300, 0),
  // Seconds before leaving when everyone else has left the voice channel (0 = never).
  aloneTimeoutSec: int(process.env.ALONE_TIMEOUT, 120, 0),
  maxQueue: int(process.env.MAX_QUEUE, 1000, 1),
  maxPlaylistSize: int(process.env.MAX_PLAYLIST_SIZE, 500, 1),
  voiceStatus: bool(process.env.VOICE_STATUS, true),
  audioFilters: filterMode(process.env.AUDIO_FILTERS),
  healthFile: process.env.HEALTH_FILE || '',

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlp: Object.freeze({
    path: process.env.YTDLP_PATH || 'yt-dlp',
    cookies: process.env.YTDLP_COOKIES || '',
    // yt-dlp needs a JavaScript runtime for YouTube. Node is always available, so default to it.
    jsRuntime: process.env.YTDLP_JS_RUNTIME ?? 'node',
    extraArgs: splitArgs(process.env.YTDLP_EXTRA_ARGS),
    autoUpdate: bool(process.env.YTDLP_AUTO_UPDATE, true),
    // "stable" (default) or "nightly" — nightly gets YouTube fixes faster.
    updateChannel: process.env.YTDLP_UPDATE_CHANNEL || 'stable'
  })
});

export const _test = { bool, int, list, splitArgs, filterMode };
