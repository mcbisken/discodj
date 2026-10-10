import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractPlayable } from '../src/commands/context.js';
import { lineIndexAt, parseLrc } from '../src/sources/lyrics.js';
import { canonicalYouTubeUrl, cleanInput, parseStartTime, youtubePlaylistId } from '../src/sources/resolve.js';
import { parseClock } from '../src/sources/search.js';
import { mergeSegments } from '../src/sources/sponsorblock.js';
import { parseSpotifyUrl, scoreCandidate } from '../src/sources/spotify.js';
import { cleanTitle, detectSource, normalizeTrack, parseArtistTitle, songFingerprint, trackKey, youtubeId } from '../src/sources/track.js';
import { friendlyYtdlpError, titleFromSlug, toStreamInfo } from '../src/sources/ytdlp.js';

test('youtubeId handles every URL shape', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ'
  ]) assert.equal(youtubeId(url), 'dQw4w9WgXcQ', url);
  assert.equal(youtubeId('https://example.com/watch?v=x'), null);
});

test('detectSource', () => {
  assert.equal(detectSource('https://youtu.be/x'), 'youtube');
  assert.equal(detectSource('https://soundcloud.com/a/b'), 'soundcloud');
  assert.equal(detectSource('https://open.spotify.com/track/x'), 'spotify');
  assert.equal(detectSource('https://bandcamp.com/x'), 'other');
});

test('playlist links: real playlists expand, mixes and private lists do not', () => {
  assert.equal(youtubePlaylistId('https://www.youtube.com/playlist?list=PLabc'), 'PLabc');
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=x&list=RDx'), null);
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=x&list=WL'), null);
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=x'), null);
});

test('canonical URLs and start times', () => {
  assert.equal(canonicalYouTubeUrl('https://youtu.be/abcdefghijk?t=42'), 'https://www.youtube.com/watch?v=abcdefghijk&t=42');
  assert.equal(parseStartTime('https://youtu.be/x?t=1m30s'), 90);
  assert.equal(parseStartTime('https://youtu.be/x?t=95'), 95);
  assert.equal(parseStartTime('https://youtu.be/x'), 0);
  assert.equal(cleanInput('<https://youtu.be/x>'), 'https://youtu.be/x');
});

test('Spotify URL parsing incl. intl and URI forms', () => {
  assert.deepEqual(parseSpotifyUrl('https://open.spotify.com/intl-de/track/abc123?si=x'), { type: 'track', id: 'abc123', url: 'https://open.spotify.com/track/abc123' });
  assert.equal(parseSpotifyUrl('spotify:album:xyz').type, 'album');
  assert.equal(parseSpotifyUrl('https://example.com'), null);
});

test('Spotify matching prefers the official upload over covers/remixes', () => {
  const want = { title: 'Get Lucky', artist: 'Daft Punk', durationMs: 248000 };
  const official = scoreCandidate({ title: 'Get Lucky', author: 'Daft Punk - Topic', duration: 249 }, want);
  const cover = scoreCandidate({ title: 'Get Lucky (Piano Cover)', author: 'Some Pianist', duration: 250 }, want);
  const extended = scoreCandidate({ title: 'Daft Punk - Get Lucky (10 hours)', author: 'Loops', duration: 36000 }, want);
  assert.ok(official > cover && official > extended);
});

test('title cleaning + artist/title parsing', () => {
  assert.equal(cleanTitle('Daft Punk - Get Lucky (Official Video) [HD]'), 'Daft Punk - Get Lucky');
  assert.equal(cleanTitle('Song (Remix)'), 'Song (Remix)');
  assert.deepEqual(parseArtistTitle({ title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams' }), { artist: 'Daft Punk', title: 'Get Lucky' });
  assert.deepEqual(parseArtistTitle({ title: 'Blinding Lights', author: 'The Weeknd - Topic' }), { artist: 'The Weeknd', title: 'Blinding Lights' });
  assert.deepEqual(parseArtistTitle({ title: 'x', spotify: { title: 'Levitating (feat. DaBaby)', artist: 'Dua Lipa' } }), { artist: 'Dua Lipa', title: 'Levitating' });
  assert.equal(songFingerprint({ title: 'Daft Punk - Get Lucky (Official Video)' }), songFingerprint({ title: 'Daft Punk - Get Lucky [Lyrics]' }));
});

test('v2 tracks migrate to the v3 shape', () => {
  const t = normalizeTrack({ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Song', durationSec: 200, requestedById: '1', requestedByTag: 'bob#0', source: 'yt' });
  assert.equal(t.duration, 200);
  assert.equal(t.source, 'youtube');
  assert.deepEqual(t.requester, { id: '1', name: 'bob' });
  const sp = normalizeTrack({ url: null, _spotifyQuery: 'Daft Punk Get Lucky', title: 'Daft Punk Get Lucky', source: 'sp' });
  assert.equal(sp.query, 'Daft Punk Get Lucky');
  assert.equal(sp.source, 'spotify');
  assert.equal(normalizeTrack({ title: 'no url or query' }), null);
  assert.equal(trackKey(t), 'yt:abcdefghijk');
});

test('LRC parsing and line lookup', () => {
  const lines = parseLrc('[00:01.00] first\n[00:05.50]second\n[00:03.00][00:09.00] repeated\n[ar:meta]\n[00:12.00]');
  assert.deepEqual(lines.map(l => l.t), [1, 3, 5.5, 9, 12]);
  assert.equal(lines[1].text, 'repeated');
  assert.equal(lineIndexAt(lines, 0.5), -1);
  assert.equal(lineIndexAt(lines, 4), 1);
  assert.equal(lineIndexAt(lines, 100), 4);
});

test('SponsorBlock segments merge and drop tiny ones', () => {
  assert.deepEqual(mergeSegments([[10, 20], [0, 5], [19.5, 30], [50, 50.5]]), [[0, 5], [10, 30]]);
});

test('search durations', () => {
  assert.equal(parseClock('4:09'), 249);
  assert.equal(parseClock('1:00:00'), 3600);
  assert.equal(parseClock(undefined), null);
});

test('yt-dlp errors become friendly messages', () => {
  assert.match(friendlyYtdlpError('ERROR: [youtube] abc: Sign in to confirm you\'re not a bot'), /cookies/);
  assert.match(friendlyYtdlpError('ERROR: [youtube] abc: Video unavailable'), /unavailable/);
  assert.match(friendlyYtdlpError('ERROR: [youtube] abc: Sign in to confirm your age'), /age-restricted/);
});

test('SoundCloud slugs become readable placeholder titles', () => {
  assert.equal(titleFromSlug('https://soundcloud.com/forss/city-ports'), 'City Ports');
  assert.equal(titleFromSlug('https://soundcloud.com/a/b_side-mix?in=x'), 'B Side Mix');
  assert.equal(titleFromSlug('not a url'), null);
});

test('toStreamInfo keeps only the chosen format and trims heavy fields', () => {
  const info = toStreamInfo({
    id: 'x', title: 'T', uploader: 'U', duration: 100, format_id: '251',
    formats: [{ format_id: '140', url: 'a' }, { format_id: '251', url: 'b', protocol: 'https', http_headers: { 'User-Agent': 'ua' } }],
    automatic_captions: { en: [1, 2, 3] }, thumbnails: [{ url: 't1' }, { url: 't2' }]
  }, 'https://youtu.be/x');
  assert.equal(info.format.url, 'b');
  assert.equal(info.format.headers['User-Agent'], 'ua');
  assert.equal(info.thumbnail, 't2');
  const raw = JSON.parse(info.rawJson);
  assert.equal(raw.formats.length, 1);
  assert.equal(raw.automatic_captions, undefined);
});

test('context menu picks the best playable thing in a message', () => {
  const msg = (content, { embeds = [], attachments = [] } = {}) => ({ content, embeds, attachments: new Map(attachments.map((a, i) => [String(i), a])) });
  assert.equal(extractPlayable(msg('check this https://example.com and https://youtu.be/abc!')), 'https://youtu.be/abc');
  assert.equal(extractPlayable(msg('', { attachments: [{ contentType: 'audio/mpeg', url: 'https://cdn/x.mp3' }] })), 'https://cdn/x.mp3');
  assert.equal(extractPlayable(msg('never gonna give you up')), 'never gonna give you up');
  assert.equal(extractPlayable(msg('')), null);
});
