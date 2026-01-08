import fs from 'node:fs/promises';
import path from 'node:path';

import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';

export const DATA_DIR = path.resolve('./data');

export const state = new Map();

export function defaults(){
  return {
    queue: [],
    history: [],
    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
    connection: null,
    nowPlaying: null,
    panel: null,

    volume: 100,
    loop: 'off',
    autoplay: true,
    stayOnline: true,

    // access control
    djOnly: false,

    // timing
    startedAtMs: 0,
    pausedAtMs: 0,
    seekBaseSec: 0,
    pauseHoldMs: 0
  };
}

export function getOrInit(gid){
  if (!state.has(gid)) state.set(gid, defaults());
  return state.get(gid);
}

export async function initDataDir(){
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function saveGuild(gid){
  const s = getOrInit(gid);
  const save = {
    queue: s.queue,
    history: s.history.slice(-20),
    volume: s.volume,
    loop: s.loop,
    autoplay: s.autoplay,
    stayOnline: s.stayOnline,
    djOnly: s.djOnly
  };
  await fs.writeFile(path.join(DATA_DIR, gid + '.json'), JSON.stringify(save, null, 2));
}

export async function loadGuild(gid){
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, gid + '.json'), 'utf8');
    const d = JSON.parse(raw);
    const s = getOrInit(gid);
    s.queue = Array.isArray(d.queue) ? d.queue : [];
    s.history = Array.isArray(d.history) ? d.history : [];
    s.volume = Number.isFinite(d.volume) ? d.volume : 100;
    s.loop = ['off','one','all'].includes(d.loop) ? d.loop : 'off';
    s.autoplay = typeof d.autoplay === 'boolean' ? d.autoplay : true;
    s.stayOnline = d.stayOnline ?? true;
    s.djOnly = typeof d.djOnly === 'boolean' ? d.djOnly : false;
  } catch {
    // ignore missing/invalid state file
  }
}
