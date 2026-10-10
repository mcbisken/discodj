// Autoplay: when the queue runs dry, pick a related song from YouTube's own "Mix" for the last
// track (the same thing YouTube plays next), skipping anything heard recently.
import { log } from '../logger.js';
import { searchYouTube } from './search.js';
import { makeTrack, parseArtistTitle, songFingerprint, youtubeId } from './track.js';
import { flatPlaylist } from './ytdlp.js';

const mixCache = new Map(); // seedId -> { entries, exp }
const MAX_LEN_SEC = 15 * 60;

async function mixFor(seedId){
  const hit = mixCache.get(seedId);
  if (hit && hit.exp > Date.now()) return hit.entries;
  const { entries } = await flatPlaylist(`https://www.youtube.com/watch?v=${seedId}&list=RD${seedId}`, { limit: 30, timeoutMs: 45_000 });
  mixCache.set(seedId, { entries, exp: Date.now() + 3600e3 });
  if (mixCache.size > 200) mixCache.delete(mixCache.keys().next().value);
  return entries;
}

// recent: array of recently played/queued tracks (used to avoid repeats).
export async function pickAutoplayTrack(seed, recent = []){
  try {
    let seedId = youtubeId(seed.url);
    if (!seedId){
      const { artist, title } = parseArtistTitle(seed);
      const [hit] = await searchYouTube([artist, title].filter(Boolean).join(' - '), 1);
      seedId = youtubeId(hit?.url);
    }
    if (!seedId) return null;

    const recentIds = new Set(recent.map(t => youtubeId(t.url)).filter(Boolean));
    recentIds.add(seedId);
    const recentPrints = new Set(recent.map(songFingerprint));
    recentPrints.add(songFingerprint(seed));

    const entries = await mixFor(seedId);
    const fresh = entries.filter(e => {
      if (!e.id || recentIds.has(e.id)) return false;
      if (e.duration && e.duration > MAX_LEN_SEC) return false;
      if (e.isLive) return false;
      return !recentPrints.has(songFingerprint({ title: e.title, author: e.author }));
    });
    if (!fresh.length) return null;
    // A little randomness keeps long sessions from feeling like the same playlist every time.
    const pick = fresh[Math.floor(Math.random() * Math.min(5, fresh.length))];
    return makeTrack({ url: `https://www.youtube.com/watch?v=${pick.id}`, title: pick.title, author: pick.author, duration: pick.duration, thumbnail: pick.thumbnail, source: 'youtube' });
  } catch (e){
    log.warn('autoplay.failed', { seed: seed?.title, err: e });
    return null;
  }
}
