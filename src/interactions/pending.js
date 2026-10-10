// Short-lived server-side state for multi-step interactions (search pickers, lyric pages,
// duplicate prompts). Custom IDs only carry a short token, so long URLs can't overflow
// Discord's 100-character custom_id limit.
import { randomBytes } from 'node:crypto';

const store = new Map(); // token -> { data, exp }

export function putPending(data, ttlMs = 15 * 60e3){
  const token = randomBytes(5).toString('hex');
  store.set(token, { data, exp: Date.now() + ttlMs });
  return token;
}

export function getPending(token){
  const hit = store.get(token);
  if (!hit) return null;
  if (hit.exp < Date.now()){ store.delete(token); return null; }
  return hit.data;
}

export function dropPending(token){
  store.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
}, 60_000).unref();
