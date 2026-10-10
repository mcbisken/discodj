// Audio filters → one FFmpeg -af chain. Presets stack (Bass Boost + 8D works), except presets in
// the same `group` which replace each other (e.g. Nightcore vs Vaporwave).
//   rate  → changes speed AND pitch together (like a record played faster)
//   pitch → changes pitch only
//   af    → plain FFmpeg filter string

export const PRESETS = {
  bassboost:    { label: 'Bass Boost',      emoji: '🔊', desc: 'Punchier low end', af: 'bass=g=8:f=110:w=0.6' },
  nightcore:    { label: 'Nightcore',       emoji: '⚡', desc: 'Faster and higher', rate: 1.25, group: 'rate' },
  vaporwave:    { label: 'Vaporwave',       emoji: '🌊', desc: 'Slower and lower', rate: 0.8, group: 'rate' },
  slowedreverb: { label: 'Slowed + Reverb', emoji: '🌙', desc: 'Late-night TikTok edit', rate: 0.85, group: 'rate', af: 'aecho=0.8:0.88:60|120:0.35|0.25' },
  chipmunk:     { label: 'Chipmunk',        emoji: '🐭', desc: 'High voice, same speed', pitch: 1.6, group: 'pitch' },
  deep:         { label: 'Deep Voice',      emoji: '🗿', desc: 'Low voice, same speed', pitch: 0.75, group: 'pitch' },
  lofi:         { label: 'Lo-fi',           emoji: '📼', desc: 'Warm, muffled tape vibe', af: 'highpass=f=120,lowpass=f=3600,vibrato=f=0.6:d=0.04,acompressor=threshold=0.125:ratio=3' },
  '8d':         { label: '8D Audio',        emoji: '🎧', desc: 'Sound circles your head', af: 'apulsator=hz=0.08' },
  echo:         { label: 'Echo',            emoji: '📣', desc: 'Big canyon echo', af: 'aecho=0.8:0.9:1000:0.3' },
  karaoke:      { label: 'Karaoke',         emoji: '🎤', desc: 'Tries to remove vocals', af: 'stereotools=mlev=0.015625' },
  treble:       { label: 'Treble Boost',    emoji: '🎸', desc: 'Crisper highs', af: 'treble=g=5' },
  vibrato:      { label: 'Vibrato',         emoji: '🎻', desc: 'Wobbly pitch', af: 'vibrato=f=6.5:d=0.35' }
};

export const LOUDNORM = 'loudnorm=I=-16:LRA=11:TP=-1.5';

export function presetLabel(key){
  const p = PRESETS[key];
  return p ? `${p.emoji} ${p.label}` : key;
}

// Applies a toggle while respecting groups. Returns the new filter list.
export function toggleFilter(active, key){
  if (!PRESETS[key]) return active;
  if (active.includes(key)) return active.filter(k => k !== key);
  const group = PRESETS[key].group;
  return [...active.filter(k => !group || PRESETS[k]?.group !== group), key];
}

// Normalises an arbitrary list (e.g. from the dropdown) so groups stay exclusive (last one wins).
export function sanitizeFilters(list){
  let out = [];
  for (const k of list || []) if (PRESETS[k] && !out.includes(k)) out = toggleFilter(out, k);
  return out;
}

// atempo only accepts 0.5–2.0 per instance on older FFmpeg builds, so chain it.
export function atempoChain(factor){
  const parts = [];
  let f = factor;
  while (f > 2.0){ parts.push('atempo=2'); f /= 2.0; }
  while (f < 0.5){ parts.push('atempo=0.5'); f /= 0.5; }
  if (Math.abs(f - 1) > 1e-3) parts.push(`atempo=${+f.toFixed(5)}`);
  return parts;
}

// How many seconds of the source play per second of real time.
export function effectiveSpeed({ filters = [], speed = 1 } = {}){
  let rate = 1;
  for (const k of filters) rate *= PRESETS[k]?.rate || 1;
  return rate * (speed || 1);
}

export function buildFilterChain({ filters = [], speed = 1, pitch = 1, normalize = false } = {}){
  const active = sanitizeFilters(filters);
  let rate = 1;
  let pitchMul = pitch || 1;
  const effects = [];
  for (const k of active){
    const p = PRESETS[k];
    if (p.rate) rate *= p.rate;
    if (p.pitch) pitchMul *= p.pitch;
    if (p.af) effects.push(p.af);
  }
  const parts = [];
  // Pitch shift = resample to a new rate (changes speed+pitch), then fix the speed with atempo.
  const sampleRateFactor = rate * pitchMul;
  if (Math.abs(sampleRateFactor - 1) > 1e-3){
    parts.push('aresample=48000', `asetrate=${Math.round(48000 * sampleRateFactor)}`, 'aresample=48000');
  }
  parts.push(...atempoChain((speed || 1) / pitchMul));
  parts.push(...effects);
  if (normalize) parts.push(LOUDNORM);
  return parts.join(',');
}

export function describeFilters({ filters = [], speed = 1, pitch = 1 } = {}){
  const bits = sanitizeFilters(filters).map(presetLabel);
  if (speed && speed !== 1) bits.push(`⏩ ${+speed.toFixed(2)}x speed`);
  if (pitch && pitch !== 1) bits.push(`🎼 ${+pitch.toFixed(2)}x pitch`);
  return bits;
}
