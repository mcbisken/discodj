// yt-dlp wrapper: metadata extraction (cached + de-duplicated), flat playlist expansion,
// search fallback and self-updating.
import { spawn } from 'node:child_process';

import { config } from '../config.js';
import { UserError } from '../errors.js';
import { log } from '../logger.js';

const INFO_TTL_MS = 150 * 60 * 1000; // stream URLs from YouTube expire after ~6h; stay well below
const MAX_INFO_CACHE = 300;

const features = { jsRuntimes: false, checked: false };

export function ytdlpBaseArgs(){
  const a = [];
  if (config.ytdlp.cookies) a.push('--cookies', config.ytdlp.cookies);
  if (config.ytdlp.jsRuntime && features.jsRuntimes) a.push('--js-runtimes', config.ytdlp.jsRuntime);
  a.push(...config.ytdlp.extraArgs);
  return a;
}

export function runYtdlp(args, { timeoutMs = 60_000, input } = {}){
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(config.ytdlp.path, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e){
      return reject(e);
    }
    const out = [];
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; if (err.length > 20_000) err = err.slice(-10_000); });
    p.on('error', e => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('yt-dlp is not installed or not in PATH') : e); });
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: err }); });
    if (input){
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    }
  });
}

// Turns yt-dlp's stderr into something a Discord user can understand.
export function friendlyYtdlpError(stderr){
  const lines = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find(l => l.startsWith('ERROR:')) || lines.at(-1) || 'unknown error';
  const msg = errLine.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '');
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(msg)) return 'That video is age-restricted, so I can\'t play it.';
  if (/not a bot|confirm you'?re not/i.test(msg)) return 'YouTube is asking the bot to sign in (bot check). The server owner can fix this with a cookies file. See the README.';
  if (/private video/i.test(msg)) return 'That video is private.';
  if (/video unavailable|not available|has been removed|does not exist|404/i.test(msg)) return 'That video is unavailable (removed or region-locked).';
  if (/members[- ]only|join this channel/i.test(msg)) return 'That video is for channel members only.';
  if (/premiere|live event will begin|is upcoming/i.test(msg)) return 'That stream hasn\'t started yet.';
  if (/unsupported url/i.test(msg)) return 'I don\'t know how to play that link.';
  if (/drm/i.test(msg)) return 'That content is DRM-protected, so I can\'t play it.';
  return msg.length > 180 ? msg.slice(0, 177) + '…' : msg;
}

export async function ytdlpJson(args, { timeoutMs = 60_000, retries = 1 } = {}){
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++){
    const { code, stdout, stderr } = await runYtdlp(args, { timeoutMs });
    if (code === 0 && stdout.trim()){
      try { return JSON.parse(stdout); }
      catch (e){ lastErr = e; }
    } else {
      const friendly = friendlyYtdlpError(stderr);
      lastErr = new UserError(friendly);
      lastErr.detail = stderr.slice(-800);
      // Permanent failures (private, removed, age-gated…) won't fix themselves on retry.
      if (/age-restricted|private|unavailable|members|DRM|don't know how/i.test(friendly)) break;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr;
}

/* ---- stream info (metadata + the exact audio format to download) ---- */
const infoCache = new Map(); // url -> { promise, exp }

const DROP_KEYS = ['requested_formats', 'automatic_captions', 'subtitles', 'heatmap', 'thumbnails', 'description', 'tags', 'categories', 'chapters', 'requested_subtitles', '_format_sort_fields'];

export function toStreamInfo(info, url){
  const fmt = (info.formats || []).find(f => f.format_id === info.format_id)
    || { format_id: info.format_id, url: info.url, protocol: info.protocol, http_headers: info.http_headers, ext: info.ext };
  const trimmed = { ...info, formats: [fmt] };
  for (const k of DROP_KEYS) delete trimmed[k];
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails.filter(t => t?.url) : [];
  return {
    id: info.id,
    title: info.track && info.artist ? `${info.artist} - ${info.track}` : (info.title || url),
    author: info.uploader || info.channel || info.artist || info.creator || null,
    duration: Number(info.duration) || null,
    isLive: !!info.is_live,
    thumbnail: info.thumbnail || thumbs.at(-1)?.url || null,
    webpageUrl: info.webpage_url || url,
    extractor: info.extractor_key || info.extractor || null,
    meta: info.track ? { artist: info.artist || null, track: info.track, album: info.album || null } : null,
    format: { id: fmt.format_id, url: fmt.url, protocol: fmt.protocol || 'https', headers: fmt.http_headers || info.http_headers || {} },
    rawJson: JSON.stringify(trimmed)
  };
}

export function getStreamInfo(url, { force = false } = {}){
  const hit = infoCache.get(url);
  if (!force && hit && hit.exp > Date.now()) return hit.promise;
  const promise = ytdlpJson(['-J', '--no-playlist', '--no-warnings', '-f', 'bestaudio/best', ...ytdlpBaseArgs(), '--', url], { timeoutMs: 75_000 })
    .then(info => toStreamInfo(info, url));
  infoCache.set(url, { promise, exp: Date.now() + INFO_TTL_MS });
  promise.catch(() => { if (infoCache.get(url)?.promise === promise) infoCache.delete(url); });
  if (infoCache.size > MAX_INFO_CACHE){
    const now = Date.now();
    for (const [k, v] of infoCache) if (v.exp < now || infoCache.size > MAX_INFO_CACHE) infoCache.delete(k);
  }
  return promise;
}

export function invalidateStreamInfo(url){
  infoCache.delete(url);
}

/* ---- playlists & search ---- */
function entryUrl(e){
  if (e.webpage_url) return e.webpage_url;
  if (e.url && /^https?:\/\//.test(e.url)) return e.url;
  if (e.id && (!e.ie_key || /youtube/i.test(e.ie_key))) return `https://www.youtube.com/watch?v=${e.id}`;
  return e.url || null;
}

// Flat SoundCloud entries have no title, so show "city-ports" as "City Ports" until the real
// metadata loads.
export function titleFromSlug(url){
  try {
    const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    const words = slug.replace(/[-_]+/g, ' ').trim();
    return words ? words.replace(/\b\p{L}/gu, c => c.toUpperCase()) : null;
  } catch {
    return null;
  }
}

export async function flatPlaylist(url, { limit = 100, timeoutMs = 90_000 } = {}){
  const info = await ytdlpJson(['-J', '--flat-playlist', '--no-warnings', '--playlist-end', String(limit), ...ytdlpBaseArgs(), '--', url], { timeoutMs });
  const entries = (info.entries || []).filter(Boolean).map(e => ({
    id: e.id,
    url: entryUrl(e),
    title: e.title || titleFromSlug(entryUrl(e)),
    author: e.channel || e.uploader || e.album_artist || e.artist || null,
    duration: Number(e.duration) || null,
    thumbnail: Array.isArray(e.thumbnails) && e.thumbnails.length ? e.thumbnails.at(-1).url : null,
    isLive: e.live_status === 'is_live'
  })).filter(e => e.url && e.title !== '[Private video]' && e.title !== '[Deleted video]');
  return { title: info.title || null, entries, single: !info.entries ? info : null };
}

export async function ytdlpSearch(query, limit = 5){
  const { entries } = await flatPlaylist(`ytsearch${limit}:${query}`, { limit, timeoutMs: 30_000 });
  return entries;
}

/* ---- maintenance ---- */
export async function detectFeatures(){
  try {
    const [{ stdout: help }, { stdout: version }] = await Promise.all([
      runYtdlp(['--help'], { timeoutMs: 20_000 }),
      runYtdlp(['--version'], { timeoutMs: 20_000 })
    ]);
    features.jsRuntimes = help.includes('--js-runtimes');
    features.checked = true;
    log.info('ytdlp.detected', { version: version.trim(), jsRuntimes: features.jsRuntimes ? config.ytdlp.jsRuntime || 'auto' : 'unsupported' });
    return { version: version.trim() };
  } catch (e){
    log.error('ytdlp.missing', { err: e });
    return null;
  }
}

export async function selfUpdate(){
  const channel = config.ytdlp.updateChannel;
  const args = channel && channel !== 'stable' ? ['--update-to', channel] : ['-U'];
  try {
    const { code, stdout, stderr } = await runYtdlp([...args, '--no-color'], { timeoutMs: 180_000 });
    const out = (stdout + '\n' + stderr).trim();
    const summary = out.split('\n').filter(Boolean).pop() || '';
    if (/up to date|up-to-date/i.test(out)) log.info('ytdlp.up_to_date', { summary });
    else if (code === 0){ log.info('ytdlp.updated', { summary }); await detectFeatures(); }
    else if (/package manager|pip|setup\.py|cannot update|not supported/i.test(out)) log.warn('ytdlp.cannot_self_update', { summary, hint: 'Install the official yt-dlp release binary (the Docker image does this) or update it with your package manager.' });
    else log.warn('ytdlp.update_failed', { code, summary });
  } catch (e){
    log.warn('ytdlp.update_failed', { err: e });
  }
}
