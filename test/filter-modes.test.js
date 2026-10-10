// AUDIO_FILTERS=on|commands|off. This file runs the whole bot config with filters OFF
// (config is read at import time), and checks the per-mode UI/command helpers directly.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'discodj-filtermodes-'));
process.env.LOG_LEVEL = 'silent';
process.env.AUDIO_FILTERS = 'off';

const { _test, config } = await import('../src/config.js');
const { effectiveAudio, effectiveSpeed } = await import('../src/player/filters.js');
const { buildPanel } = await import('../src/ui/panel.js');
const { helpView } = await import('../src/ui/messages.js');
const { commands, enabledCommands } = await import('../src/commands/index.js');
const { defaultSettings } = await import('../src/store/guildStore.js');
const { makeTrack } = await import('../src/sources/track.js');
const { createAudioResource, StreamType } = await import('@discordjs/voice');
const { GuildPlayer } = await import('../src/player/GuildPlayer.js');

const players = [];
after(() => { for (const gp of players) gp.destroy(); });

test('AUDIO_FILTERS parsing', () => {
  const { filterMode } = _test;
  assert.equal(filterMode(undefined), 'on');
  assert.equal(filterMode(''), 'on');
  assert.equal(filterMode('commands'), 'commands');
  assert.equal(filterMode('OFF'), 'off');
  assert.equal(filterMode('false'), 'off');
  assert.equal(filterMode('0'), 'off');
  assert.equal(filterMode('true'), 'on');
  assert.equal(config.audioFilters, 'off');
});

test('off: saved filters/speed/pitch are ignored, normalization is kept', () => {
  const s = { ...defaultSettings(), filters: ['nightcore'], speed: 1.5, pitch: 1.2, normalize: true };
  const eff = effectiveAudio(s);
  assert.deepEqual(eff.filters, []);
  assert.equal(eff.speed, 1);
  assert.equal(eff.pitch, 1);
  assert.equal(eff.normalize, true);
  assert.equal(effectiveSpeed(eff), 1);
  assert.deepEqual(effectiveAudio(s, 'commands').filters, ['nightcore']);
});

function fakeGp(){
  return {
    current: makeTrack({ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Song', duration: 200 }),
    queue: [], history: [], settings: { ...defaultSettings(), filters: ['bassboost'] },
    isPaused: false, loading: false, pausedBy: null, lyrics: null, artwork: null, lastSponsorSkip: null,
    elapsed: () => 10, etaFor: () => null
  };
}
const panelJson = mode => JSON.stringify(buildPanel(fakeGp(), { filterMode: mode }).components[0].toJSON());

test('the filter dropdown only shows in "on" mode', () => {
  assert.ok(panelJson('on').includes('"pl:filters"'));
  assert.ok(!panelJson('commands').includes('"pl:filters"'));
  assert.ok(!panelJson('off').includes('"pl:filters"'));
  // Off also hides the active-filter label from the status line.
  assert.ok(!panelJson('off').includes('Bass Boost'));
});

test('off removes /filter, /speed and /pitch; commands mode keeps them', () => {
  const names = list => list.map(c => c.data.name);
  assert.ok(!names(commands).some(n => ['filter', 'speed', 'pitch'].includes(n)));
  const all = [{ data: { name: 'filter' }, feature: 'filters' }, { data: { name: 'play' } }];
  assert.deepEqual(names(enabledCommands(all, { filterMode: 'commands' })), ['filter', 'play']);
  assert.deepEqual(names(enabledCommands(all, { filterMode: 'off' })), ['play']);
  assert.ok(!JSON.stringify(helpView({ filterMode: 'off' }).components[0].toJSON()).includes('/filter'));
});

test('off: the engine streams without filters even if some were saved before', async () => {
  const calls = [];
  const manager = {
    client: { user: { id: 'bot' }, guilds: { cache: new Map() }, channels: { cache: new Map() }, rest: { put: async () => {} } },
    updatePresence(){},
    async createAudio(track, { filterChain }){
      calls.push(filterChain);
      const pcm = Readable.from([Buffer.alloc(48000 * 4 * 2)]);
      const resource = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true });
      return { resource, kill(){ resource.playStream.destroy(); }, info: { isLive: false, duration: 2, title: track.title } };
    }
  };
  const gp = new GuildPlayer(manager, 'g-off');
  players.push(gp);
  gp.player.behaviors.noSubscriber = 'play';
  gp.settings = { ...gp.settings, autoplay: false, filters: ['nightcore', 'echo'], speed: 1.5, normalize: true };
  gp.enqueue([makeTrack({ url: 'https://example.com/a.mp3', title: 'A', source: 'other' })]);
  await gp.startIfIdle();
  assert.equal(calls[0], 'loudnorm=I=-16:LRA=11:TP=-1.5');
  assert.equal(gp.speedAtStart, 1);
  gp.stop();
});
