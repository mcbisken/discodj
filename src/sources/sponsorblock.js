// SponsorBlock "music_offtopic" segments: the talking/skits/intros in music videos.
// Uses the privacy-preserving hash-prefix API, so the exact video ID is never sent.
import { createHash } from 'node:crypto';

import { log } from '../logger.js';

const API = 'https://sponsor.ajay.app/api/skipSegments';
const cache = new Map(); // videoId -> { value, exp }

export function mergeSegments(segs){
  const sorted = segs.filter(s => s[1] - s[0] >= 1).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of sorted){
    const last = out.at(-1);
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

// Returns [[startSec, endSec], ...] (possibly empty). Never throws.
export async function getMusicSegments(videoId){
  if (!videoId) return [];
  const hit = cache.get(videoId);
  if (hit && hit.exp > Date.now()) return hit.value;
  let value = [];
  try {
    const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const url = `${API}/${prefix}?categories=${encodeURIComponent('["music_offtopic"]')}&actionType=skip`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'discodj/3' } });
    if (res.ok){
      const list = await res.json();
      const mine = (Array.isArray(list) ? list : []).find(v => v.videoID === videoId);
      value = mergeSegments((mine?.segments || []).map(s => s.segment).filter(s => Array.isArray(s) && s.length === 2));
    } else if (res.status !== 404){
      throw new Error(`SponsorBlock ${res.status}`);
    }
  } catch (e){
    log.debug('sponsorblock.failed', { videoId, err: e });
    return [];
  }
  cache.set(videoId, { value, exp: Date.now() + 6 * 3600e3 });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return value;
}
