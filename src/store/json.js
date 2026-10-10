// Crash-safe JSON persistence: writes go to a temp file and are renamed into place,
// so a crash mid-write can never leave a half-written (corrupt) file behind.
import fs from 'node:fs/promises';
import path from 'node:path';

import { log } from '../logger.js';

const writeChains = new Map();

export async function readJson(file, fallback){
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e){
    if (e.code !== 'ENOENT') log.warn('store.read_failed', { file, err: e });
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e){
    // Keep the broken file around instead of silently overwriting it later.
    const backup = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, backup).catch(() => {});
    log.error('store.corrupt_file', { file, backup, err: e });
    return fallback;
  }
}

export function writeJson(file, data){
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  });
  writeChains.set(file, next);
  next.catch(e => log.error('store.write_failed', { file, err: e }))
    .finally(() => { if (writeChains.get(file) === next) writeChains.delete(file); });
  return next;
}

// Wait for every pending write (used at shutdown).
export async function flushWrites(){
  await Promise.allSettled([...writeChains.values()]);
}

// Coalesces frequent save requests into one write after `delayMs` of quiet.
export function debounced(fn, delayMs){
  let timer = null;
  let running = null;
  const run = async () => {
    timer = null;
    running = Promise.resolve().then(fn).catch(e => log.error('store.debounced_failed', { err: e }));
    await running;
    running = null;
  };
  return {
    schedule(){
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
      timer.unref?.(); // shutdown flushes explicitly, so never keep the process alive for this
    },
    async flush(){
      if (timer){ clearTimeout(timer); await run(); }
      else if (running) await running;
    }
  };
}
