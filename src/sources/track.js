// The Track model plus helpers for identifying, cleaning and (de)serializing tracks.
//
// Track shape:
// { id, url, title, author, duration (sec|null), thumbnail, source, isLive,
//   query (lazy Spotify lookup, resolved right before playback), spotify: { title, artist, durationMs },
//   meta: { artist, track, album } (from yt-dlp when available), requester: { id, name, auto? }, addedAt }
import { randomBytes } from 'node:crypto';

export const SOURCES = {
  youtube: { name: 'YouTube', emoji: '🟥' },
  spotify: { name: 'Spotify', emoji: '🟩' },
  soundcloud: { name: 'SoundCloud', emoji: '🟧' },
  other: { name: 'Web', emoji: '🌐' }
};

const LEGACY_SOURCE = { yt: 'youtube', sp: 'spotify', sc: 'soundcloud' };

export function newId(){
  return randomBytes(4).toString('hex');
}

export function hostOf(url){
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function detectSource(url){
  if (/^spotify:/i.test(String(url || ''))) return 'spotify';
  const host = hostOf(url);
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundcloud';
  if (host === 'spotify.com' || host.endsWith('.spotify.com') || host === 'spotify.link' || host.endsWith('.app.link')) return 'spotify';
  return 'other';
}

export function youtubeId(url){
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (!host.endsWith('youtube.com')) return null;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

export function makeTrack(fields = {}){
  const url = fields.url || null;
  return {
    id: newId(),
    url,
    title: String(fields.title || fields.query || url || 'Unknown track').slice(0, 300),
    author: fields.author ? String(fields.author).slice(0, 200) : null,
    duration: Number.isFinite(Number(fields.duration)) && Number(fields.duration) > 0 ? Number(fields.duration) : null,
    thumbnail: fields.thumbnail || (youtubeId(url) ? `https://i.ytimg.com/vi/${youtubeId(url)}/hqdefault.jpg` : null),
    source: fields.source || (url ? detectSource(url) : 'other'),
    isLive: !!fields.isLive,
    query: fields.query || null,
    spotify: fields.spotify || null,
    meta: fields.meta || null,
    requester: fields.requester || null,
    addedAt: fields.addedAt || Date.now()
  };
}

// Accepts tracks saved by v2 ({ durationSec, requestedById, _spotifyQuery, source: 'yt' ... }) or v3.
export function normalizeTrack(raw){
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || null;
  const query = raw.query || raw._spotifyQuery || null;
  if (!url && !query) return null;
  const requester = raw.requester || (raw.requestedById ? { id: raw.requestedById, name: String(raw.requestedByTag || '').replace(/#0$/, '') || 'someone' } : null);
  return makeTrack({
    url,
    title: raw.title,
    author: raw.author,
    duration: raw.duration ?? raw.durationSec,
    thumbnail: raw.thumbnail,
    source: LEGACY_SOURCE[raw.source] || raw.source || (url ? detectSource(url) : 'spotify'),
    isLive: raw.isLive,
    query,
    spotify: raw.spotify,
    meta: raw.meta,
    requester,
    addedAt: raw.addedAt
  });
}

// What we persist: no runtime ids, no requester (re-applied when loaded).
export function serializeTrack(t){
  const out = { url: t.url, title: t.title, author: t.author, duration: t.duration, thumbnail: t.thumbnail, source: t.source };
  if (t.isLive) out.isLive = true;
  if (t.query) out.query = t.query;
  if (t.spotify) out.spotify = t.spotify;
  if (t.meta) out.meta = t.meta;
  return out;
}

// Like serializeTrack but keeps the requester (for queue/session persistence).
export function persistTrack(t){
  return { ...serializeTrack(t), requester: t.requester || null, addedAt: t.addedAt };
}

export function withRequester(track, requester){
  return { ...track, id: newId(), requester, addedAt: Date.now() };
}

export function trackKey(t){
  if (!t) return '';
  const yt = youtubeId(t.url);
  if (yt) return 'yt:' + yt;
  if (t.url) return t.url.split('#')[0];
  return 'q:' + String(t.query || t.title || '').toLowerCase();
}

const NOISE = /(official|video|audio|lyric|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|\bmv\b|m\/v|remaster|explicit|music video|clip officiel|videoclip|color coded|\bfull\b)/i;

export function cleanTitle(title){
  return String(title || '')
    .replace(/[([【「][^)\]】」]*[)\]】」]/g, m => (NOISE.test(m) ? '' : m))
    .replace(/\s+\|\s+.*$/, '')
    .replace(/["“”]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripFeat(s){
  return String(s || '').replace(/\s*[([]?\s*\b(feat\.?|ft\.?|featuring|prod\.?)\s[^)\]]*[)\]]?/gi, '').trim();
}

function cleanAuthor(a){
  return String(a || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|music)$/i, '').trim();
}

// Best guess at { artist, title } for lyrics lookups and duplicate detection.
export function parseArtistTitle(t){
  if (t?.spotify?.title) return { artist: t.spotify.artist || '', title: stripFeat(t.spotify.title) };
  if (t?.meta?.track) return { artist: t.meta.artist || cleanAuthor(t.author), title: stripFeat(t.meta.track) };
  const cleaned = cleanTitle(t?.title);
  const m = cleaned.match(/^(.+?)\s+[-–—~]\s+(.+)$/);
  if (m) return { artist: stripFeat(m[1]), title: stripFeat(m[2]) };
  return { artist: cleanAuthor(t?.author), title: stripFeat(cleaned) };
}

// Loose fingerprint so "Song (Official Video)" and "Song [Lyrics]" count as the same song.
export function songFingerprint(t){
  const { artist, title } = parseArtistTitle(t);
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
  return norm(artist) + '|' + norm(title);
}
