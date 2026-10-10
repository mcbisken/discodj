// Lyrics from LRCLIB (https://lrclib.net) — free, no API key, often with time-synced lines.
import { log } from '../logger.js';
import { parseArtistTitle } from './track.js';

const BASE = 'https://lrclib.net/api';
const UA = 'discodj/3 (https://github.com/mcbisken/discodj)';
const cache = new Map(); // key -> { value, exp }

async function getJson(path, params){
  const url = `${BASE}${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

// "[01:23.45] line" → [{ t: 83.45, text: 'line' }]
export function parseLrc(lrc){
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)){
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) out.push({ t: parseInt(s[1], 10) * 60 + parseFloat(s[2].replace(':', '.')), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Index of the line being sung at `sec` (-1 before the first line).
export function lineIndexAt(lines, sec){
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= sec){ ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function pickBest(results, duration){
  const usable = (results || []).filter(r => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
  if (!usable.length) return null;
  const score = r => (duration && r.duration ? Math.abs(r.duration - duration) : 0) - (r.syncedLyrics ? 5 : 0);
  return usable.sort((a, b) => score(a) - score(b))[0];
}

function shape(r){
  if (!r) return null;
  return {
    trackName: r.trackName || r.name,
    artistName: r.artistName,
    synced: r.syncedLyrics ? parseLrc(r.syncedLyrics) : null,
    plain: r.plainLyrics || (r.syncedLyrics ? parseLrc(r.syncedLyrics).map(l => l.text).join('\n') : null),
    instrumental: !!r.instrumental
  };
}

export async function findLyrics(track){
  const { artist, title } = parseArtistTitle(track);
  const duration = track.duration ? Math.round(track.duration) : null;
  const key = `${artist}|${title}|${duration}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;

  let result = null;
  try {
    if (artist && title){
      const exact = await getJson('/get', { artist_name: artist, track_name: title, duration }).catch(() => null);
      if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) result = exact;
      if (!result) result = pickBest(await getJson('/search', { track_name: title, artist_name: artist }), duration);
    }
    if (!result) result = pickBest(await getJson('/search', { q: [artist, title].filter(Boolean).join(' ') }), duration);
  } catch (e){
    log.warn('lyrics.failed', { artist, title, err: e });
    return null; // don't cache network failures
  }
  const value = shape(result);
  cache.set(key, { value, exp: Date.now() + (value ? 6 * 3600e3 : 30 * 60e3) });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
