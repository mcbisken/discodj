// Per-guild state document: settings, queue, history, panel location and the live session
// (used to resume playback after a restart). File name is unchanged from v2 (data/<guildId>.json)
// so existing settings and queues carry over.
import path from 'node:path';

import { config } from '../config.js';
import { normalizeTrack } from '../sources/track.js';
import { readJson, writeJson } from './json.js';

const LOOP_MODES = ['off', 'one', 'all'];

export function defaultSettings(){
  return {
    volume: config.defaultVolume,
    loop: 'off',
    autoplay: true,
    filters: [],
    speed: 1,
    pitch: 1,
    normalize: true,
    djOnly: false,
    stay247: false,
    sponsorblock: true,
    voteSkip: true,
    panelStyle: 'big',
    liveLyrics: false
  };
}

function guildFile(gid){
  return path.join(config.dataDir, `${gid}.json`);
}

function num(v, d, min, max){
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

// Accepts both the v2 format and the current one.
export function migrateGuildDoc(d){
  const def = defaultSettings();
  const src = d && typeof d === 'object' ? d : {};
  const s = src.settings && typeof src.settings === 'object' ? src.settings : src; // v2 kept settings at top level
  const legacyFilter = typeof s.filter === 'string' && s.filter ? [s.filter] : [];

  const settings = {
    volume: num(s.volume, def.volume, 0, 200),
    loop: LOOP_MODES.includes(s.loop) ? s.loop : def.loop,
    autoplay: typeof s.autoplay === 'boolean' ? s.autoplay : def.autoplay,
    filters: Array.isArray(s.filters) ? s.filters.filter(f => typeof f === 'string') : legacyFilter,
    speed: num(s.speed, 1, 0.5, 2),
    pitch: num(s.pitch, 1, 0.5, 2),
    normalize: typeof s.normalize === 'boolean' ? s.normalize : def.normalize,
    djOnly: typeof s.djOnly === 'boolean' ? s.djOnly : def.djOnly,
    stay247: typeof s.stay247 === 'boolean' ? s.stay247 : def.stay247,
    sponsorblock: typeof s.sponsorblock === 'boolean' ? s.sponsorblock : def.sponsorblock,
    voteSkip: typeof s.voteSkip === 'boolean' ? s.voteSkip : def.voteSkip,
    panelStyle: ['big', 'compact'].includes(s.panelStyle) ? s.panelStyle : def.panelStyle,
    liveLyrics: typeof s.liveLyrics === 'boolean' ? s.liveLyrics : def.liveLyrics
  };

  const tracks = arr => (Array.isArray(arr) ? arr.map(normalizeTrack).filter(Boolean) : []);
  const session = src.session && typeof src.session === 'object' && src.session.voiceChannelId ? {
    voiceChannelId: String(src.session.voiceChannelId),
    current: src.session.current ? normalizeTrack(src.session.current) : null,
    position: num(src.session.position, 0, 0, 1e7),
    paused: !!src.session.paused,
    savedAt: Number(src.session.savedAt) || 0
  } : null;
  const panel = src.panel && src.panel.channelId ? { channelId: String(src.panel.channelId), messageId: src.panel.messageId ? String(src.panel.messageId) : null } : null;

  return { settings, queue: tracks(src.queue), history: tracks(src.history), session, panel };
}

export async function loadGuildDoc(gid){
  const raw = await readJson(guildFile(gid), null);
  return migrateGuildDoc(raw);
}

export function saveGuildDoc(gid, doc){
  return writeJson(guildFile(gid), { version: 3, ...doc });
}
