// Simple per-key async mutex using a promise chain.

const chains = new Map();

export async function runExclusive(key, fn){
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  chains.set(key, prev.then(() => next, () => next));

  try{
    await prev;
    return await fn();
  } finally {
    release();
    // Best-effort cleanup when nothing else is queued.
    if (chains.get(key) === next) chains.delete(key);
  }
}
