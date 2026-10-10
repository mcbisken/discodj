// Picks the best artwork URL that actually exists. YouTube's maxres thumbnail is missing for
// many older videos, and a missing image would show up as a broken box in the panel.
import { youtubeId } from './track.js';

const cache = new Map(); // videoId -> url

async function exists(url){
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveArtwork(track){
  const id = youtubeId(track.url);
  if (!id) return track.thumbnail || null;
  if (cache.has(id)) return cache.get(id);
  let best = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  for (const name of ['maxresdefault', 'hq720', 'sddefault']){
    const url = `https://i.ytimg.com/vi/${id}/${name}.jpg`;
    if (await exists(url)){ best = url; break; }
  }
  cache.set(id, best);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return best;
}
