// Spotify links → YouTube. Spotify doesn't let bots stream audio, so each track is matched to
// the best YouTube upload. Singles resolve immediately; albums/playlists queue instantly as lazy
// placeholders that are matched just before they play (or while the previous song is playing).
import spotifyUrlInfo from 'spotify-url-info';

import { config } from '../config.js';
import { UserError } from '../errors.js';
import { log } from '../logger.js';
import { searchYouTube } from './search.js';
import { makeTrack } from './track.js';

const { getData, getTracks, getPreview } = spotifyUrlInfo(fetch);

export const SPOTIFY_REGEX = /^(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)|^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/i;

export function parseSpotifyUrl(input){
  const m = String(input || '').trim().match(SPOTIFY_REGEX);
  if (!m) return null;
  const type = (m[1] || m[3]).toLowerCase();
  const id = m[2] || m[4];
  return { type, id, url: `https://open.spotify.com/${type}/${id}` };
}

const SUSPICIOUS = ['live', 'cover', 'remix', 'karaoke', 'instrumental', '8d', 'sped up', 'slowed', 'nightcore', 'reverb', 'acoustic', 'piano', 'reaction', 'tutorial', 'lesson', 'bass boosted', 'mashup', '1 hour', '10 hours'];

// Scores a YouTube search hit against the Spotify track it should represent.
export function scoreCandidate(c, { title, artist, durationMs }){
  const ct = String(c.title || '').toLowerCase();
  const ca = String(c.author || '').toLowerCase();
  const wantTitle = String(title || '').toLowerCase();
  const wantArtist = String(artist || '').toLowerCase().split(/,\s*/)[0];
  let score = 0;
  if (durationMs && c.duration){
    const diff = Math.abs(c.duration - durationMs / 1000);
    score -= diff <= 3 ? 0 : diff <= 15 ? diff : 15 + diff * 2;
  }
  const core = wantTitle.replace(/\s*[([].*$/, '').trim();
  if (core && ct.includes(core)) score += 20;
  if (wantArtist && (ca.includes(wantArtist) || ct.includes(wantArtist))) score += 12;
  if (/ - topic$/.test(ca)) score += 15;
  if (/official audio/.test(ct)) score += 6;
  else if (/official/.test(ct)) score += 3;
  for (const w of SUSPICIOUS){
    if (ct.includes(w) && !wantTitle.includes(w)) score -= 25;
  }
  return score;
}

const stripFeat = s => String(s || '').replace(/\s*[([]\s*(feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '').trim();

export async function matchOnYouTube(sp){
  // "Daft Punk - Get Lucky" searches far better than every artist plus "(feat. …)".
  const query = [sp.artist, stripFeat(sp.title)].filter(Boolean).join(' - ');
  const results = await searchYouTube(query, 6);
  if (!results.length) return null;
  let best = results[0];
  let bestScore = -Infinity;
  for (const c of results){
    const s = scoreCandidate(c, sp);
    if (s > bestScore){ best = c; bestScore = s; }
  }
  return best;
}

// Fills in url/title/etc. on a lazy Spotify placeholder. Safe to call repeatedly.
export async function resolveSpotifyPlaceholder(track){
  if (track.url || !track.query) return track;
  if (!track._matching){
    const sp = track.spotify || { title: track.query, artist: '' };
    track._matching = matchOnYouTube(sp).finally(() => { delete track._matching; });
  }
  const hit = await track._matching;
  if (!hit) throw new UserError(`Couldn't find "${track.query}" on YouTube.`);
  if (!track.url){
    track.url = hit.url;
    track.duration = hit.duration || track.duration;
    track.thumbnail = hit.thumbnail || track.thumbnail;
  }
  return track;
}

function placeholder(t, image){
  // Playlist items give `artist` as a string ("A, B"); single tracks give an `artists` array.
  const artists = Array.isArray(t.artists) ? t.artists.map(a => a.name).filter(Boolean) : String(t.artist || '').split(/,\s*/).filter(Boolean);
  const artist = artists[0] || '';
  const title = t.name || t.title || '';
  if (!title) return null;
  return makeTrack({
    url: null,
    query: [artist, stripFeat(title)].filter(Boolean).join(' - '),
    title: artist ? `${artist} - ${title}` : title,
    author: artists.join(', ') || null,
    duration: t.duration ? Math.round(t.duration / 1000) : null,
    thumbnail: image || null,
    source: 'spotify',
    spotify: { title, artist, durationMs: t.duration || null }
  });
}

// Returns { tracks, title }
export async function resolveSpotify(input){
  const parsed = parseSpotifyUrl(input);
  if (!parsed) throw new UserError('That doesn\'t look like a Spotify track, album or playlist link.');
  try {
    if (parsed.type === 'track'){
      const data = await getData(parsed.url);
      const image = data?.visualIdentity?.image?.at?.(-1)?.url || null;
      const t = placeholder({ name: data.name || data.title, artists: data.artists, duration: data.duration }, image);
      if (!t) return { tracks: [], title: null };
      await resolveSpotifyPlaceholder(t);
      return { tracks: [t], title: null };
    }
    const [preview, items] = await Promise.all([getPreview(parsed.url).catch(() => null), getTracks(parsed.url)]);
    const tracks = (items || []).slice(0, config.maxPlaylistSize).map(t => placeholder(t, null)).filter(Boolean);
    return { tracks, title: preview?.title || null, image: preview?.image || null };
  } catch (e){
    if (e instanceof UserError) throw e;
    log.warn('spotify.failed', { url: parsed.url, err: e });
    throw new UserError('Spotify didn\'t give me that link. Make sure it\'s public, then try again.');
  }
}
