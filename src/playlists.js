import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './state.js';

function playlistsPath(gid) {
  return path.join(DATA_DIR, gid + '.playlists.json');
}

export async function listPlaylists(gid) {
  try {
    const raw = await fs.readFile(playlistsPath(gid), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function savePlaylist(gid, name, tracks) {
  const all = await listPlaylists(gid);
  all[name] = { name, tracks, savedAt: Date.now(), count: tracks.length };
  await fs.writeFile(playlistsPath(gid), JSON.stringify(all, null, 2));
  return all[name];
}

export async function loadPlaylist(gid, name) {
  const all = await listPlaylists(gid);
  return all[name] || null;
}

export async function deletePlaylist(gid, name) {
  const all = await listPlaylists(gid);
  if (!all[name]) return false;
  delete all[name];
  await fs.writeFile(playlistsPath(gid), JSON.stringify(all, null, 2));
  return true;
}
