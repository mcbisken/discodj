// Per-guild listening stats (top songs, top requesters). Kept in memory, flushed lazily.
import path from 'node:path';

import { config } from '../config.js';
import { trackKey } from '../sources/track.js';
import { debounced, readJson, writeJson } from './json.js';

const cache = new Map();   // gid -> stats doc
const savers = new Map();  // gid -> debounced saver
const MAX_TRACKS = 1500;

const file = gid => path.join(config.dataDir, `${gid}.stats.json`);

function empty(){
  return { since: Date.now(), totalPlays: 0, totalSec: 0, tracks: {}, users: {} };
}

async function load(gid){
  if (cache.has(gid)) return cache.get(gid);
  const d = await readJson(file(gid), null);
  const doc = d && typeof d === 'object' ? { ...empty(), ...d } : empty();
  cache.set(gid, doc);
  return doc;
}

function saverFor(gid){
  if (!savers.has(gid)) savers.set(gid, debounced(() => writeJson(file(gid), cache.get(gid)), 15_000));
  return savers.get(gid);
}

function prune(doc){
  const entries = Object.entries(doc.tracks);
  if (entries.length <= MAX_TRACKS) return;
  entries.sort((a, b) => (b[1].plays - a[1].plays) || (b[1].lastPlayedAt - a[1].lastPlayedAt));
  doc.tracks = Object.fromEntries(entries.slice(0, Math.floor(MAX_TRACKS * 0.8)));
}

export async function recordPlay(gid, track, playedSec){
  const doc = await load(gid);
  const secs = Math.max(0, Math.round(playedSec || 0));
  doc.totalPlays++;
  doc.totalSec += secs;
  const key = trackKey(track);
  const t = doc.tracks[key] || { title: track.title, url: track.url, plays: 0, lastPlayedAt: 0 };
  t.title = track.title || t.title;
  t.url = track.url || t.url;
  t.plays++;
  t.lastPlayedAt = Date.now();
  doc.tracks[key] = t;
  if (track.requester?.id && !track.requester.auto){
    const u = doc.users[track.requester.id] || { name: track.requester.name, plays: 0, sec: 0 };
    u.name = track.requester.name || u.name;
    u.plays++;
    u.sec += secs;
    doc.users[track.requester.id] = u;
  }
  prune(doc);
  saverFor(gid).schedule();
}

export async function getStats(gid){
  const doc = await load(gid);
  const topTracks = Object.values(doc.tracks).sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt).slice(0, 10);
  const topUsers = Object.entries(doc.users).map(([id, u]) => ({ id, ...u })).sort((a, b) => b.plays - a.plays).slice(0, 5);
  return { since: doc.since, totalPlays: doc.totalPlays, totalSec: doc.totalSec, uniqueTracks: Object.keys(doc.tracks).length, topTracks, topUsers };
}

export async function flushStats(){
  await Promise.allSettled([...savers.values()].map(s => s.flush()));
}
