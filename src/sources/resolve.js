// Turns whatever the user typed (URL or search text) into a list of tracks.
import { config } from '../config.js';
import { UserError } from '../errors.js';
import { searchYouTube } from './search.js';
import { parseSpotifyUrl, resolveSpotify } from './spotify.js';
import { detectSource, hostOf, makeTrack, youtubeId } from './track.js';
import { flatPlaylist, getStreamInfo } from './ytdlp.js';

const URL_RE = /^https?:\/\/\S+$/i;

// Discord users often wrap links in <> to suppress embeds.
export function cleanInput(input){
  return String(input || '').trim().replace(/^<(.+)>$/, '$1').trim();
}

export function youtubePlaylistId(url){
  try {
    const list = new URL(url).searchParams.get('list');
    if (!list) return null;
    // Mixes/radio (RD…) are endless, Watch Later/Liked need login — treat those links as single videos.
    if (/^RD/.test(list) || list === 'WL' || list === 'LL') return null;
    return list;
  } catch {
    return null;
  }
}

export function canonicalYouTubeUrl(url){
  const id = youtubeId(url);
  if (!id) return url;
  let t = null;
  try { t = new URL(url).searchParams.get('t'); } catch {}
  return `https://www.youtube.com/watch?v=${id}` + (t ? `&t=${encodeURIComponent(t)}` : '');
}

export function parseStartTime(url){
  try {
    const t = new URL(url).searchParams.get('t') || new URL(url).searchParams.get('start');
    if (!t) return 0;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return m ? (parseInt(m[1] || 0) * 3600 + parseInt(m[2] || 0) * 60 + parseInt(m[3] || 0)) : 0;
  } catch {
    return 0;
  }
}

function fromInfo(info, url, source){
  return makeTrack({
    url: info.webpageUrl || url,
    title: info.title,
    author: info.author,
    duration: info.duration,
    thumbnail: info.thumbnail,
    isLive: info.isLive,
    meta: info.meta,
    source: source || detectSource(info.webpageUrl || url)
  });
}

function fromEntries(entries, source){
  return entries.slice(0, config.maxPlaylistSize).map(e => makeTrack({ url: e.url, title: e.title, author: e.author, duration: e.duration, thumbnail: e.thumbnail, isLive: e.isLive, source: source || detectSource(e.url) }));
}

// spotify.link / *.app.link share links redirect to open.spotify.com.
async function expandShortLink(url){
  const host = hostOf(url);
  if (host !== 'spotify.link' && !host.endsWith('.app.link')) return url;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000) });
    return res.url || url;
  } catch {
    return url;
  }
}

// Returns { tracks, playlistTitle, kind: 'search'|'single'|'playlist' }
export async function resolveInput(rawInput){
  const input = await expandShortLink(cleanInput(rawInput));
  if (!input) throw new UserError('Give me a song name or a link.');

  if (parseSpotifyUrl(input)){
    const { tracks, title } = await resolveSpotify(input);
    return { tracks, playlistTitle: title, kind: tracks.length > 1 || title ? 'playlist' : 'single' };
  }

  if (URL_RE.test(input)){
    const source = detectSource(input);

    if (source === 'youtube'){
      const listId = youtubePlaylistId(input);
      if (listId){
        const { title, entries } = await flatPlaylist(`https://www.youtube.com/playlist?list=${listId}`, { limit: config.maxPlaylistSize });
        if (entries.length) return { tracks: fromEntries(entries, 'youtube'), playlistTitle: title, kind: 'playlist' };
      }
      if (!youtubeId(input) && /\/(@|channel\/|c\/|user\/)/.test(input)){
        throw new UserError('That\'s a channel link — send me a video or playlist instead.');
      }
      const url = canonicalYouTubeUrl(input);
      const info = await getStreamInfo(url.replace(/&t=.*$/, ''));
      const track = fromInfo(info, url, 'youtube');
      track.startAt = parseStartTime(input) || 0;
      return { tracks: [track], playlistTitle: null, kind: 'single' };
    }

    // SoundCloud sets/profiles, Bandcamp albums, etc. → flat expansion; single tracks → full info.
    const looksLikeList = /soundcloud\.com\/[^/]+\/(sets|likes|tracks|albums)|soundcloud\.com\/[^/]+\/?$|bandcamp\.com\/album/i.test(input);
    if (looksLikeList){
      const { title, entries } = await flatPlaylist(input, { limit: config.maxPlaylistSize });
      if (entries.length) return { tracks: fromEntries(entries, source), playlistTitle: title, kind: 'playlist' };
    }
    try {
      const info = await getStreamInfo(input);
      return { tracks: [fromInfo(info, input, source)], playlistTitle: null, kind: 'single' };
    } catch (e){
      // Could still be a playlist on a site we didn't pattern-match.
      const { title, entries } = await flatPlaylist(input, { limit: config.maxPlaylistSize }).catch(() => ({ entries: [] }));
      if (entries.length > 1) return { tracks: fromEntries(entries, source), playlistTitle: title, kind: 'playlist' };
      throw e;
    }
  }

  const [hit] = await searchYouTube(input, 1);
  if (!hit) throw new UserError(`No results for **${input.slice(0, 80)}**. Try different words or paste a link.`);
  return { tracks: [makeTrack({ ...hit, source: 'youtube' })], playlistTitle: null, kind: 'search' };
}
