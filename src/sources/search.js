// YouTube search. Uses the fast scraping API first and falls back to yt-dlp if YouTube changes
// its page layout (which happens a few times a year).
import yts from 'youtube-search-api';

import { log } from '../logger.js';
import { ytdlpSearch } from './ytdlp.js';

export function parseClock(text){
  if (!text) return null;
  const parts = String(text).trim().split(':').map(n => parseInt(n, 10));
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) || null;
}

function withTimeout(promise, ms){
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

function fromScrape(item){
  const id = typeof item.id === 'string' ? item.id : item.id?.videoId;
  if (!id) return null;
  const thumbs = item.thumbnail?.thumbnails || [];
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    title: item.title || 'Unknown title',
    author: item.channelTitle || item.shortBylineText?.runs?.[0]?.text || null,
    duration: parseClock(item.length?.simpleText),
    thumbnail: thumbs.at(-1)?.url?.split('?')[0] || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isLive: !!item.isLive
  };
}

// Returns [{ url, title, author, duration, thumbnail, isLive }]
export async function searchYouTube(query, limit = 5, { timeoutMs = 5000, fallback = true } = {}){
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await withTimeout(yts.GetListByKeyword(q, false, Math.max(limit + 3, 8)), timeoutMs);
    const items = (res?.items || []).filter(i => i.type === 'video').map(fromScrape).filter(Boolean);
    if (items.length) return items.slice(0, limit);
  } catch (e){
    log.debug('search.scrape_failed', { query: q, err: e });
  }
  if (!fallback) return [];
  try {
    const entries = await ytdlpSearch(q, limit);
    return entries.map(e => ({ url: e.url, title: e.title || e.url, author: e.author, duration: e.duration, thumbnail: e.thumbnail, isLive: e.isLive }));
  } catch (e){
    log.warn('search.failed', { query: q, err: e });
    return [];
  }
}
