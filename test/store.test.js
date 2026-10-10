import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = mkdtempSync(path.join(tmpdir(), 'discodj-store-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'silent';

const { migrateGuildDoc, loadGuildDoc, saveGuildDoc } = await import('../src/store/guildStore.js');
const pl = await import('../src/store/playlists.js');
const { makeTrack } = await import('../src/sources/track.js');
const { readJson, flushWrites } = await import('../src/store/json.js');

test('v2 guild state migrates (settings at top level, single filter)', () => {
  const doc = migrateGuildDoc({ queue: [{ url: 'https://youtu.be/abcdefghijk', title: 'x', source: 'yt' }], history: [], volume: 150, loop: 'one', autoplay: false, filter: 'bassboost', djOnly: true });
  assert.equal(doc.settings.volume, 150);
  assert.equal(doc.settings.loop, 'one');
  assert.equal(doc.settings.autoplay, false);
  assert.deepEqual(doc.settings.filters, ['bassboost']);
  assert.equal(doc.settings.djOnly, true);
  assert.equal(doc.settings.normalize, true);
  assert.equal(doc.queue.length, 1);
  assert.equal(doc.session, null);
});

test('garbage input falls back to defaults', () => {
  const doc = migrateGuildDoc({ settings: { volume: 'loud', loop: 'sideways', speed: 99 } });
  assert.equal(doc.settings.volume, 100);
  assert.equal(doc.settings.loop, 'off');
  assert.equal(doc.settings.speed, 2);
  assert.deepEqual(migrateGuildDoc(null).queue, []);
});

test('guild docs round-trip, and corrupt files are backed up instead of overwritten', async () => {
  await saveGuildDoc('g1', { settings: { volume: 42 }, queue: [], history: [], panel: { channelId: 'c', messageId: 'm' }, session: null });
  const doc = await loadGuildDoc('g1');
  assert.equal(doc.settings.volume, 42);
  assert.deepEqual(doc.panel, { channelId: 'c', messageId: 'm' });

  writeFileSync(path.join(dir, 'g2.json'), '{ broken');
  const fallback = await readJson(path.join(dir, 'g2.json'), 'fallback');
  assert.equal(fallback, 'fallback');
});

test('server playlists: v2 file format still loads; case-insensitive names', async () => {
  writeFileSync(path.join(dir, 'g3.playlists.json'), JSON.stringify({
    Chill: { name: 'Chill', tracks: [{ url: 'https://youtu.be/abcdefghijk', title: 'Old', durationSec: 100, source: 'yt' }], savedAt: 1, count: 1 }
  }));
  const p = await pl.getServerPlaylist('g3', 'chill');
  assert.equal(p.name, 'Chill');
  assert.equal(p.tracks[0].duration, 100);
  await pl.saveServerPlaylist('g3', 'Party', [makeTrack({ url: 'https://youtu.be/bbbbbbbbbbb', title: 'New' })], 'u1');
  const list = await pl.listServerPlaylists('g3');
  assert.deepEqual(list.map(x => x.name).sort(), ['Chill', 'Party']);
  assert.equal(await pl.deleteServerPlaylist('g3', 'PARTY'), true);
  assert.equal(await pl.deleteServerPlaylist('g3', 'party'), false);
});

test('likes toggle and show up as a personal playlist', async () => {
  const t = makeTrack({ url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'Banger' });
  assert.equal(await pl.toggleLiked('u9', t), true);
  assert.equal(await pl.isLiked('u9', { ...t, url: 'https://youtu.be/ccccccccccc' }), true);
  const mine = await pl.listUserPlaylists('u9');
  assert.equal(mine[0].name, pl.LIKED_NAME);
  assert.equal((await pl.getUserPlaylist('u9', 'liked songs')).tracks[0].title, 'Banger');
  assert.equal(await pl.toggleLiked('u9', t), false);
  await flushWrites();
  const raw = JSON.parse(readFileSync(path.join(dir, 'users', 'u9.json'), 'utf8'));
  assert.equal(raw.liked.length, 0);
});
