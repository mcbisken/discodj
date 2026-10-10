// End-to-end check of the audio pipeline without Discord: resolve → extract → stream → encode.
// Handy when "nothing plays":
//   docker compose exec discodj node scripts/smoke-audio.js "never gonna give you up"
//   npm run smoke -- https://soundcloud.com/...
import { spawnSync } from 'node:child_process';

import { config } from '../src/config.js';
import { createAudio } from '../src/player/audio.js';
import { buildFilterChain, PRESETS } from '../src/player/filters.js';
import { resolveInput } from '../src/sources/resolve.js';
import { resolveSpotifyPlaceholder } from '../src/sources/spotify.js';
import { detectFeatures } from '../src/sources/ytdlp.js';

const query = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SECONDS = 3;
let failed = false;

function ok(msg){ console.log(`  ✅ ${msg}`); }
function bad(msg){ console.log(`  ❌ ${msg}`); failed = true; }

// Reads a few seconds of Opus packets straight from the resource (faster than real time).
async function pull(audio){
  const stream = audio.resource.playStream;
  let packets = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no audio within 30s')), 30_000);
    stream.on('data', () => {
      if (++packets >= SECONDS * 50){ clearTimeout(timer); resolve(); }
    });
    stream.on('end', () => { clearTimeout(timer); resolve(); });
    stream.on('error', e => { clearTimeout(timer); reject(e); });
  });
  audio.kill();
  return packets;
}

console.log('🔧 Tools');
await detectFeatures();
const ff = spawnSync(config.ffmpegPath, ['-version'], { encoding: 'utf8' });
ff.status === 0 ? ok(ff.stdout.split('\n')[0]) : bad('ffmpeg not found');

console.log('🎛️  Filters (each preset through ffmpeg)');
for (const key of Object.keys(PRESETS)){
  const chain = buildFilterChain({ filters: [key], normalize: true, speed: 1.1, pitch: 0.95 });
  const r = spawnSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', chain, '-f', 'null', '-'], { encoding: 'utf8' });
  r.status === 0 ? ok(key) : bad(`${key}: ${r.stderr.trim().split('\n').pop()}`);
}

console.log(`🔎 Resolving: ${query}`);
const t0 = Date.now();
const { tracks, playlistTitle } = await resolveInput(query);
const track = tracks[0];
if (!track.url && track.query) await resolveSpotifyPlaceholder(track);
ok(`${tracks.length} track(s)${playlistTitle ? ` from "${playlistTitle}"` : ''} in ${Date.now() - t0}ms → ${track.title} (${track.url})`);

const cases = [
  ['from the start (yt-dlp pipe)', 0, ''],
  ['seek to 0:45 (direct range request)', 45, ''],
  ['bass boost + nightcore + normalize', 0, buildFilterChain({ filters: ['bassboost', 'nightcore'], normalize: true })]
];
for (const [label, offset, filterChain] of cases){
  console.log(`▶️  ${label}`);
  try {
    const started = Date.now();
    const audio = await createAudio(track, { offset, filterChain });
    const firstAudioMs = Date.now() - started;
    const packets = await pull(audio);
    packets >= SECONDS * 50 ? ok(`${packets} packets (${(packets / 50).toFixed(1)}s) · first audio after ${firstAudioMs}ms · mode=${audio.mode}`) : bad(`only ${packets} packets`);
  } catch (e){
    bad(e.message);
  }
}

console.log(failed ? '\n❌ Something is broken. See above.' : '\n🎉 Audio pipeline works.');
process.exit(failed ? 1 : 0);
