// Drives the real GuildPlayer + @discordjs/voice AudioPlayer with fake audio (silence),
// to pin down the playback state machine — including the v2 race/loop bugs.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'discodj-player-'));
process.env.LOG_LEVEL = 'silent';

const { createAudioResource, StreamType } = await import('@discordjs/voice');
const { GuildPlayer } = await import('../src/player/GuildPlayer.js');
const { makeTrack } = await import('../src/sources/track.js');

const players = [];
after(() => { for (const gp of players) gp.destroy(); });

function silence(sec){
  const total = Math.max(3840, Math.round(sec * 48000) * 4);
  let sent = 0;
  return new Readable({
    read(){
      if (sent >= total) return this.push(null);
      const n = Math.min(3840 * 5, total - sent);
      sent += n;
      this.push(Buffer.alloc(n));
    }
  });
}

function setup({ fail = [], failSeek = [], durations = {}, delay = 20, seekDelay = 20 } = {}){
  const calls = [];
  const manager = {
    client: { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { cache: new Map() }, rest: { put: async () => {} } },
    updatePresence(){},
    async createAudio(track, { offset, filterChain }){
      calls.push({ title: track.title, offset, filterChain });
      await new Promise(r => setTimeout(r, offset > 0 ? seekDelay : delay));
      if (fail.includes(track.title) || (offset > 0 && failSeek.includes(track.title))) throw new Error('boom');
      const dur = durations[track.title] ?? 0.5;
      const resource = createAudioResource(silence(Math.max(0.1, dur - offset)), { inputType: StreamType.Raw, inlineVolume: true });
      return { resource, kill(){ resource.playStream.destroy(); }, info: { isLive: false, duration: dur, title: track.title } };
    }
  };
  const gp = new GuildPlayer(manager, 'test-guild');
  gp.player.behaviors.noSubscriber = 'play'; // no voice connection in tests
  gp.settings.autoplay = false;
  players.push(gp);
  return { gp, calls };
}

const T = title => makeTrack({ url: `https://example.com/${title}.mp3`, title, source: 'other' });
const titles = list => list.map(t => t.title);

async function waitFor(cond, ms = 5000){
  const start = Date.now();
  while (!cond()){
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 15));
  }
}
const playing = (gp, title) => () => gp.current?.title === title && !gp.loading && gp.player.state.status === 'playing';

test('plays through the queue in order and records history', async () => {
  const { gp } = setup();
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  await waitFor(playing(gp, 'B'));
  await waitFor(() => !gp.current && !gp.loading);
  assert.deepEqual(titles(gp.history), ['A', 'B']);
  assert.equal(gp.queue.length, 0);
});

test('loop "one" replays when a song ends naturally', async () => {
  const { gp, calls } = setup({ durations: { A: 0.3 } });
  gp.settings.loop = 'one';
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(() => calls.filter(c => c.title === 'A').length >= 3);
  assert.deepEqual(titles(gp.queue), ['B']);
  gp.stop();
});

test('skip with loop "one" moves on instead of replaying forever (v2 bug)', async () => {
  const { gp } = setup({ durations: { A: 10, B: 10 } });
  gp.settings.loop = 'one';
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  await gp.skip();
  await waitFor(playing(gp, 'B'));
  assert.deepEqual(titles(gp.history), ['A']);
  gp.stop();
});

test('seek restarts the same song without touching queue or history (v2 bug)', async () => {
  const { gp, calls } = setup({ durations: { A: 10, B: 10 } });
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  await gp.seek(4);
  await waitFor(playing(gp, 'A'));
  assert.deepEqual({ title: calls.at(-1).title, offset: calls.at(-1).offset }, { title: 'A', offset: 4 });
  assert.ok(gp.elapsed() >= 4);
  assert.deepEqual(titles(gp.queue), ['B']);
  assert.deepEqual(gp.history, []);
  gp.stop();
});

test('/play while paused queues instead of replacing the paused song (v2 bug)', async () => {
  const { gp } = setup({ durations: { A: 10 } });
  gp.enqueue([T('A')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  gp.pause('user');
  gp.enqueue([T('C')]);
  await gp.startIfIdle();
  assert.equal(gp.current.title, 'A');
  assert.equal(gp.isPaused, true);
  assert.deepEqual(titles(gp.queue), ['C']);
  gp.stop();
});

test('a track that fails to load is skipped and not added to history', async () => {
  const { gp } = setup({ fail: ['Bad'] });
  gp.notify = async () => {};
  gp.enqueue([T('Bad'), T('Good')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'Good'));
  await waitFor(() => !gp.current);
  assert.deepEqual(titles(gp.history), ['Good']);
});

test('gives up after 5 failures in a row', async () => {
  const names = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
  const { gp, calls } = setup({ fail: names });
  const notes = [];
  gp.notify = async (_kind, text) => { notes.push(text); };
  gp.enqueue(names.map(T));
  await gp.startIfIdle();
  await waitFor(() => !gp.current && !gp.loading);
  assert.equal(calls.length, 5);
  assert.deepEqual(titles(gp.queue), ['F6']);
  assert.match(notes.at(-1), /in a row/);
});

test('loop "all" sends finished songs to the back of the queue', async () => {
  const { gp, calls } = setup({ durations: { A: 0.3, B: 0.3 } });
  gp.settings.loop = 'all';
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(() => calls.length >= 4);
  assert.deepEqual(calls.slice(0, 4).map(c => c.title), ['A', 'B', 'A', 'B']);
  gp.stop();
});

test('previous goes back and puts the current song next', async () => {
  const { gp } = setup({ durations: { A: 0.3, B: 10 } });
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'B'));
  await gp.previous();
  await waitFor(playing(gp, 'A'));
  assert.deepEqual(titles(gp.queue), ['B']);
  assert.deepEqual(titles(gp.history), []);
  gp.stop();
});

test('rapid double skip lands two songs ahead with a clean history', async () => {
  const { gp } = setup({ durations: { A: 10, B: 10, C: 10, D: 10 } });
  gp.enqueue(['A', 'B', 'C', 'D'].map(T));
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  gp.skip();
  gp.skip();
  await waitFor(playing(gp, 'C'));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(gp.current.title, 'C');
  assert.deepEqual(titles(gp.history), ['A', 'B']);
  assert.deepEqual(titles(gp.queue), ['D']);
  gp.stop();
});

test('jump plays the chosen song now', async () => {
  const { gp } = setup({ durations: { A: 10, B: 10, C: 10 } });
  gp.enqueue(['A', 'B', 'C'].map(T));
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  await gp.jump(1);
  await waitFor(playing(gp, 'C'));
  assert.deepEqual(titles(gp.queue), ['B']);
  gp.stop();
});

test('stop clears everything and goes idle', async () => {
  const { gp } = setup({ durations: { A: 10 } });
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  gp.stop();
  assert.equal(gp.current, null);
  assert.equal(gp.queue.length, 0);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(gp.player.state.status, 'idle');
});

test('queue editing: move, remove range, dedupe, remove by user', () => {
  const { gp } = setup();
  const mk = (title, uid) => ({ ...T(title), requester: { id: uid, name: uid } });
  gp.enqueue([mk('A', 'u1'), mk('B', 'u2'), mk('A', 'u2'), mk('C', 'u1'), mk('D', 'u3')]);
  assert.equal(gp.dedupe(), 1);
  assert.deepEqual(titles(gp.queue), ['A', 'B', 'C', 'D']);
  gp.move(3, 0);
  assert.deepEqual(titles(gp.queue), ['D', 'A', 'B', 'C']);
  assert.equal(gp.removeByUser('u1'), 2);
  assert.deepEqual(titles(gp.queue), ['D', 'B']);
  assert.deepEqual(titles(gp.removeRange(0, 1)), ['D', 'B']);
  assert.throws(() => gp.removeRange(0, 0), /isn't in the queue/);
});

test('seeking while paused stays paused', async () => {
  const { gp, calls } = setup({ durations: { A: 10 } });
  gp.enqueue([T('A')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  gp.pause('user');
  await gp.seek(3);
  await waitFor(() => calls.length === 2 && !gp.loading && gp.player.state.status === 'paused');
  assert.equal(gp.pausedBy, 'user');
  gp.resume();
  await waitFor(playing(gp, 'A'));
  gp.stop();
});

test('pressing pause while a song is still loading pauses it once it starts', async () => {
  const { gp } = setup({ durations: { A: 10 }, delay: 150 });
  gp.enqueue([T('A')]);
  gp.startIfIdle();
  await waitFor(() => gp.loading);
  gp.pause('user');
  await waitFor(() => !gp.loading && gp.player.state.status === 'paused');
  assert.equal(gp.pausedBy, 'user');
  gp.stop();
});

test('a filter change made during loading is applied once the song starts', async () => {
  const { gp, calls } = setup({ durations: { A: 10 }, delay: 150 });
  gp.enqueue([T('A')]);
  gp.startIfIdle();
  await waitFor(() => gp.loading);
  await gp.setFilters(['nightcore']);
  await waitFor(() => calls.length === 2 && playing(gp, 'A')());
  assert.equal(calls[0].filterChain.includes('asetrate'), false);
  assert.equal(calls[1].filterChain.includes('asetrate'), true);
  assert.equal(gp.speedAtStart, 1.25);
  gp.stop();
});

test('if a seek fails after the old stream already ended, playback moves on', async () => {
  const { gp } = setup({ durations: { A: 0.4, B: 10 }, failSeek: ['A'], seekDelay: 700 });
  gp.notify = async () => {};
  gp.enqueue([T('A'), T('B')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  gp.seek(0.1).catch(() => {});
  await waitFor(playing(gp, 'B'), 4000);
  gp.stop();
});

test('session restore never overrides something a user already started', async () => {
  const { gp } = setup({ durations: { A: 10 } });
  gp.enqueue([T('A')]);
  await gp.startIfIdle();
  await waitFor(playing(gp, 'A'));
  const saved = T('Saved');
  gp.session = { voiceChannelId: 'vc', current: saved, position: 30, paused: false, savedAt: Date.now() };
  assert.equal(await gp.restoreSession(), false);
  assert.equal(gp.current.title, 'A');
  assert.deepEqual(titles(gp.queue), ['Saved']);
  gp.stop();
});

test('serialize keeps queue + settings; no session without a voice channel', () => {
  const { gp } = setup();
  gp.enqueue([T('A')]);
  gp.setVolume(250);
  const doc = gp.serialize();
  assert.equal(doc.settings.volume, 200);
  assert.equal(doc.queue[0].title, 'A');
  assert.equal(doc.session, null);
});
