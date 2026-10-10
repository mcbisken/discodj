// Saved playlists. Two scopes:
//   server   → data/<guildId>.playlists.json (same file/format as v2, so old playlists keep working)
//   personal → data/users/<userId>.json, which also holds the user's ❤️ Liked songs
import path from 'node:path';

import { config } from '../config.js';
import { runExclusive } from '../locks.js';
import { normalizeTrack, serializeTrack, trackKey } from '../sources/track.js';
import { readJson, writeJson } from './json.js';

export const LIKED_NAME = 'Liked Songs';
const MAX_LIKED = 2000;

const serverFile = gid => path.join(config.dataDir, `${gid}.playlists.json`);
const userFile = uid => path.join(config.dataDir, 'users', `${uid}.json`);

const findKey = (obj, name) => Object.keys(obj).find(k => k.toLowerCase() === String(name).trim().toLowerCase());

function toEntry(p){
  if (!p) return null;
  const tracks = (p.tracks || []).map(normalizeTrack).filter(Boolean);
  return { name: p.name, tracks, count: tracks.length, savedAt: p.savedAt || 0, createdBy: p.createdBy || null };
}

/* ---- server scope ---- */
export async function listServerPlaylists(gid){
  const all = await readJson(serverFile(gid), {});
  return Object.values(all).map(p => ({ name: p.name, count: p.count ?? (p.tracks || []).length, savedAt: p.savedAt || 0, createdBy: p.createdBy || null }));
}

export async function getServerPlaylist(gid, name){
  const all = await readJson(serverFile(gid), {});
  const key = findKey(all, name);
  return key ? toEntry(all[key]) : null;
}

export function saveServerPlaylist(gid, name, tracks, createdBy){
  return runExclusive('pl:' + gid, async () => {
    const all = await readJson(serverFile(gid), {});
    const key = findKey(all, name);
    if (key && key !== name) delete all[key];
    const saved = tracks.slice(0, config.maxPlaylistSize).map(serializeTrack);
    all[name] = { name, tracks: saved, count: saved.length, savedAt: Date.now(), createdBy: createdBy || all[key]?.createdBy || null };
    await writeJson(serverFile(gid), all);
    return toEntry(all[name]);
  });
}

export function deleteServerPlaylist(gid, name){
  return runExclusive('pl:' + gid, async () => {
    const all = await readJson(serverFile(gid), {});
    const key = findKey(all, name);
    if (!key) return false;
    delete all[key];
    await writeJson(serverFile(gid), all);
    return true;
  });
}

/* ---- personal scope ---- */
async function readUser(uid){
  const d = await readJson(userFile(uid), {});
  return { liked: Array.isArray(d.liked) ? d.liked : [], playlists: d.playlists && typeof d.playlists === 'object' ? d.playlists : {} };
}

export async function listUserPlaylists(uid){
  const d = await readUser(uid);
  const out = Object.values(d.playlists).map(p => ({ name: p.name, count: (p.tracks || []).length, savedAt: p.savedAt || 0 }));
  if (d.liked.length) out.unshift({ name: LIKED_NAME, count: d.liked.length, savedAt: 0, liked: true });
  return out;
}

export async function getUserPlaylist(uid, name){
  const d = await readUser(uid);
  if (String(name).trim().toLowerCase() === LIKED_NAME.toLowerCase()){
    return toEntry({ name: LIKED_NAME, tracks: d.liked });
  }
  const key = findKey(d.playlists, name);
  return key ? toEntry(d.playlists[key]) : null;
}

export function saveUserPlaylist(uid, name, tracks){
  return runExclusive('user:' + uid, async () => {
    const d = await readUser(uid);
    const key = findKey(d.playlists, name);
    if (key) delete d.playlists[key];
    const saved = tracks.slice(0, config.maxPlaylistSize).map(serializeTrack);
    d.playlists[name] = { name, tracks: saved, savedAt: Date.now() };
    await writeJson(userFile(uid), d);
    return toEntry(d.playlists[name]);
  });
}

export function deleteUserPlaylist(uid, name){
  return runExclusive('user:' + uid, async () => {
    const d = await readUser(uid);
    if (String(name).trim().toLowerCase() === LIKED_NAME.toLowerCase()){
      if (!d.liked.length) return false;
      d.liked = [];
    } else {
      const key = findKey(d.playlists, name);
      if (!key) return false;
      delete d.playlists[key];
    }
    await writeJson(userFile(uid), d);
    return true;
  });
}

/* ---- likes ---- */
export async function isLiked(uid, track){
  const d = await readUser(uid);
  const key = trackKey(track);
  return d.liked.some(t => trackKey(normalizeTrack(t)) === key);
}

// Returns true when the track is now liked, false when it was un-liked.
export function toggleLiked(uid, track){
  return runExclusive('user:' + uid, async () => {
    const d = await readUser(uid);
    const key = trackKey(track);
    const idx = d.liked.findIndex(t => trackKey(normalizeTrack(t)) === key);
    let liked;
    if (idx >= 0){ d.liked.splice(idx, 1); liked = false; }
    else { d.liked.unshift(serializeTrack(track)); d.liked = d.liked.slice(0, MAX_LIKED); liked = true; }
    await writeJson(userFile(uid), d);
    return liked;
  });
}
