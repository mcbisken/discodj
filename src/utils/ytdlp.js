import { spawn } from 'node:child_process';

const infoCache = new Map(); // url -> { value, exp }

function cacheGet(key){
  const v = infoCache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp){
    infoCache.delete(key);
    return null;
  }
  return v.value;
}
function cacheSet(key, value, ttlMs){
  infoCache.set(key, { value, exp: Date.now() + ttlMs });
}

function spawnWithTimeout(cmd, args, timeoutMs){
  const p = spawn(cmd, args);
  const t = setTimeout(() => {
    try { p.kill('SIGKILL'); } catch {}
  }, timeoutMs);
  p.on('close', () => clearTimeout(t));
  p.on('error', () => clearTimeout(t));
  return p;
}

async function retry(fn, { retries = 1, baseDelayMs = 500 } = {}){
  let last;
  for (let i = 0; i <= retries; i++){
    try{ return await fn(); }
    catch (e){
      last = e;
      if (i < retries){
        const d = baseDelayMs * Math.pow(2, i);
        await new Promise(r => setTimeout(r, d));
      }
    }
  }
  throw last;
}

export async function ytdlpJSON(args, { timeoutMs = 30_000, retries = 1 } = {}){
  return retry(() => new Promise((resolve, reject) => {
    const p = spawnWithTimeout('yt-dlp', args, timeoutMs);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', c => {
      if (c === 0){
        try{ resolve(JSON.parse(out)); }
        catch (e){ reject(e); }
      } else {
        reject(new Error('yt-dlp failed (' + c + '): ' + err));
      }
    });
  }), { retries });
}

export async function ytSingleInfo(url, { ttlMs = 10 * 60 * 1000 } = {}){
  const cached = cacheGet('single:' + url);
  if (cached) return cached;
  const meta = await ytdlpJSON(['-J','--no-playlist',url]).catch(() => null);
  if (!meta) return null;
  const obj = {
    url,
    title: meta.title || url,
    thumbnail: (meta.thumbnails && meta.thumbnails.length ? meta.thumbnails.at(-1).url : undefined),
    durationSec: Number(meta.duration) || undefined,
    source: 'yt'
  };
  cacheSet('single:' + url, obj, ttlMs);
  return obj;
}

export function guessThumbFromUrl(url){
  try{
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return v ? ('https://i.ytimg.com/vi/' + v + '/hqdefault.jpg') : undefined;
  } catch {
    return undefined;
  }
}

export async function ytPlaylistExpand(url, requester, { ttlMs = 5 * 60 * 1000 } = {}){
  const cached = cacheGet('pl:' + url);
  if (cached) return cached.map(t => ({ ...t, requestedById: requester.id, requestedByTag: requester.tag }));
  const meta = await ytdlpJSON(['-J', url]).catch(() => null);
  if (!meta || !meta.entries || !meta.entries.length) return [];
  const items = [];
  for (const e of meta.entries){
    if (!e) continue;
    const videoUrl = e.webpage_url || (e.url && String(e.url).startsWith('http') ? e.url : ('https://www.youtube.com/watch?v=' + e.id));
    const thumb = (e.thumbnails && e.thumbnails.length ? e.thumbnails.at(-1).url : undefined) || guessThumbFromUrl(videoUrl);
    items.push({
      url: videoUrl,
      title: e.title || videoUrl,
      thumbnail: thumb,
      durationSec: Number(e.duration) || undefined,
      requestedById: requester.id,
      requestedByTag: requester.tag,
      source: 'yt'
    });
  }
  cacheSet('pl:' + url, items, ttlMs);
  return items;
}
