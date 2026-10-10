// Every message must satisfy Discord's Components V2 limits, or the API rejects it:
// ≤ 40 components in total (nested ones count) and ≤ 4000 characters of text.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings } from '../src/store/guildStore.js';
import { makeTrack } from '../src/sources/track.js';
import { buildPanel, restartingPanel } from '../src/ui/panel.js';
import {
  addedCard, dupPrompt, helpView, historyView, lyricsPages, lyricsView, notice, nowPlayingCard, playlistsView, playlistView,
  searchView, settingsView, statsView, voteView
} from '../src/ui/messages.js';

function measure(payload){
  let components = 0;
  let chars = 0;
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'number') components++;
    if (node.type === 10) chars += node.content.length;
    for (const child of node.components || []) walk(child);
    if (node.accessory) walk(node.accessory);
  };
  for (const c of payload.components) walk(c.toJSON());
  return { components, chars };
}

function assertValid(payload, label){
  assert.ok(payload.flags & (1 << 15), `${label}: missing IsComponentsV2 flag`);
  const { components, chars } = measure(payload);
  assert.ok(components <= 40, `${label}: ${components} components (max 40)`);
  assert.ok(chars <= 4000, `${label}: ${chars} chars (max 4000)`);
}

const longTitle = 'A Really Long Song Title With [Brackets] *Stars* and (Official Music Video) Remastered 2024 Deluxe Edition'.repeat(2);
const track = (i, extra = {}) => makeTrack({
  url: `https://www.youtube.com/watch?v=${String(i).padStart(11, 'x')}`,
  title: `${longTitle} #${i}`,
  author: 'Some Very Long Channel Name - Topic',
  duration: 200 + i,
  requester: { id: '123456789012345678', name: 'tester' },
  ...extra
});

function fakeGp(overrides = {}){
  const queue = Array.from({ length: 40 }, (_, i) => track(i + 2));
  return {
    current: track(1),
    queue,
    history: Array.from({ length: 30 }, (_, i) => track(i + 100)),
    settings: { ...defaultSettings(), filters: ['bassboost', 'nightcore', 'echo'], speed: 1.25, pitch: 0.9, loop: 'all', stay247: true, djOnly: true, liveLyrics: true },
    isPaused: false,
    loading: false,
    pausedBy: null,
    lyrics: null,
    artwork: null,
    lastSponsorSkip: { at: Date.now(), sec: 23 },
    elapsed: () => 61,
    etaFor: i => 100 + i * 200,
    ...overrides
  };
}

test('full panel (big artwork, live lyrics, pager) fits the limits', () => {
  const gp = fakeGp();
  gp.lyrics = { trackId: gp.current.id, data: { synced: [{ t: 0, text: 'x'.repeat(300) }, { t: 60, text: 'y'.repeat(300) }, { t: 90, text: 'z'.repeat(300) }] } };
  assertValid(buildPanel(gp, { page: 0 }), 'big panel');
  assertValid(buildPanel(gp, { page: 99 }), 'big panel (page clamped)');
});

test('compact panel, paused, loading, live stream', () => {
  assertValid(buildPanel(fakeGp({ settings: { ...defaultSettings(), panelStyle: 'compact' } })), 'compact');
  assertValid(buildPanel(fakeGp({ isPaused: true, pausedBy: 'alone' })), 'paused');
  assertValid(buildPanel(fakeGp({ loading: true })), 'loading');
  const live = fakeGp();
  live.current = track(1, { isLive: true, duration: null });
  assertValid(buildPanel(live), 'live');
});

test('idle panel with and without a queue', () => {
  assertValid(buildPanel(fakeGp({ current: null })), 'idle with queue');
  assertValid(buildPanel(fakeGp({ current: null, queue: [] })), 'idle empty');
  assertValid(buildPanel(fakeGp({ current: null, queue: [], loading: true })), 'autoplay searching');
});

test('panel buttons use the expected custom ids', () => {
  const json = JSON.stringify(buildPanel(fakeGp()).components[0].toJSON());
  for (const id of ['pl:prev', 'pl:toggle', 'pl:skip', 'pl:stop', 'pl:shuffle', 'pl:back', 'pl:fwd', 'pl:voldown', 'pl:volup', 'pl:loop', 'pl:autoplay', 'pl:lyrics', 'pl:live', 'pl:like', 'pl:filters', 'pl:qnext']) {
    assert.ok(json.includes(`"${id}"`), `missing ${id}`);
  }
});

test('all other views fit the limits', () => {
  const gp = fakeGp();
  const many = Array.from({ length: 10 }, (_, i) => track(i));
  assertValid(addedCard(gp, { tracks: [many[0]], index: 3, startedNow: false }), 'added single');
  assertValid(addedCard(gp, { tracks: many, playlistTitle: longTitle, index: 0, startedNow: true, truncated: 5, skipped: 2 }), 'added playlist');
  assertValid(nowPlayingCard(gp), 'now playing');
  assertValid(helpView(), 'help');
  const pages = lyricsPages(Array.from({ length: 300 }, (_, i) => `line ${i} ${'la '.repeat(10)}`).join('\n'));
  assert.ok(pages.length > 1);
  assertValid(lyricsView({ title: longTitle, artist: 'Artist', pages, page: 1, token: 'abc', thumbnail: 'https://i.ytimg.com/x.jpg' }), 'lyrics');
  assertValid(searchView('query', many.map(t => ({ ...t })), 'tok'), 'search');
  assertValid(historyView(gp, 'tok'), 'history');
  assertValid(historyView(fakeGp({ history: [] }), 'tok'), 'history empty');
  assertValid(statsView({ since: Date.now(), totalPlays: 10, totalSec: 3600, uniqueTracks: 5, topTracks: many.map(t => ({ title: t.title, url: t.url, plays: 3 })), topUsers: [{ id: '1', plays: 4, sec: 600 }] }, 'Server'), 'stats');
  const pls = Array.from({ length: 25 }, (_, i) => ({ name: `Playlist ${i}`, count: i, savedAt: Date.now() }));
  assertValid(playlistsView(pls, [{ name: 'Liked Songs', count: 3, liked: true }, ...pls]), 'playlists');
  assertValid(playlistView({ name: 'Mix', count: 60, tracks: Array.from({ length: 60 }, (_, i) => track(i)) }, 'SERVER'), 'playlist');
  assertValid(settingsView(gp), 'settings');
  assertValid(dupPrompt(many[0], 'tok'), 'dup');
  assertValid(voteView(2, 3, longTitle), 'vote');
  assertValid(notice('err', 'x'), 'notice');
  assertValid(restartingPanel(), 'restarting');
});
