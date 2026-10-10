// Builds a playable AudioResource for a track.
//
//   from the start:  yt-dlp (re-using the cached, pre-extracted info) ──pipe──▶ ffmpeg ──PCM──▶ Discord
//   seeking:         ffmpeg reads the CDN URL directly with HTTP range requests (instant seeks)
//
// Piping through yt-dlp means its downloader handles YouTube's chunking/throttling quirks, and
// re-using the cached info JSON (--load-info-json) skips a second extraction, so with prefetching
// the next song starts almost instantly.
import { spawn } from 'node:child_process';

import { createAudioResource, StreamType } from '@discordjs/voice';

import { config } from '../config.js';
import { log } from '../logger.js';
import { getStreamInfo, invalidateStreamInfo, ytdlpBaseArgs } from '../sources/ytdlp.js';

const READY_TIMEOUT_MS = 30_000;
const OUTPUT_ARGS = ['-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'];

function headerString(headers){
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
}

function tail(buf, n = 600){
  return buf.length > n ? buf.slice(-n) : buf;
}

function spawnFfmpeg(inputArgs, { offset = 0, outputSeek = false, filterChain = '', stdin = 'ignore' } = {}){
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (stdin === 'pipe') args.pop(); // -nostdin would stop ffmpeg from reading the pipe
  args.push(...inputArgs);
  if (outputSeek && offset > 0) args.push('-ss', String(offset));
  if (filterChain) args.push('-af', filterChain);
  args.push(...OUTPUT_ARGS);
  const ff = spawn(config.ffmpegPath, args, { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
  ff.stderrTail = '';
  ff.stderr.on('data', d => { ff.stderrTail = tail(ff.stderrTail + d); });
  ff.on('error', e => { ff.spawnError = e; });
  return ff;
}

// Resolves once ffmpeg has produced its first audio bytes; rejects if it dies or stalls first.
function waitForAudio(ff, procs){
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.stdout.off('readable', onReadable);
      ff.off('exit', onExit);
      ff.off('error', onExit);
      err ? reject(err) : resolve();
    };
    const onReadable = () => {
      if (ff.stdout.readableLength > 0) done();
    };
    const onExit = () => {
      const why = procs.map(p => p.stderrTail).filter(Boolean).join(' | ').trim();
      done(new Error(ff.spawnError?.code === 'ENOENT' ? 'ffmpeg is not installed or not in PATH' : `no audio produced${why ? ': ' + why.slice(-300) : ''}`));
    };
    const timer = setTimeout(() => done(new Error('timed out waiting for audio')), READY_TIMEOUT_MS);
    ff.stdout.on('readable', onReadable);
    ff.once('exit', onExit);
    ff.once('error', onExit);
  });
}

function startPipe(info, { offset, filterChain }){
  const yt = spawn(config.ytdlp.path, [
    '--load-info-json', '-', '-f', info.format.id, '-o', '-',
    '--quiet', '--no-warnings', '--no-part', '--no-cache-dir',
    ...ytdlpBaseArgs()
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  yt.stderrTail = '';
  yt.stderr.on('data', d => { yt.stderrTail = tail(yt.stderrTail + d); });
  yt.on('error', e => { yt.spawnError = e; });
  yt.stdin.on('error', () => {});
  yt.stdin.end(info.rawJson);

  const ff = spawnFfmpeg(['-i', 'pipe:0'], { offset, outputSeek: true, filterChain, stdin: 'pipe' });
  ff.stdin.on('error', () => {});
  yt.stdout.on('error', () => {});
  yt.stdout.pipe(ff.stdin);
  return { ff, procs: [yt, ff] };
}

function startDirect(info, { offset, filterChain }){
  const ff = spawnFfmpeg([
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
    '-headers', headerString(info.format.headers),
    '-ss', String(offset),
    '-i', info.format.url
  ], { filterChain });
  return { ff, procs: [ff] };
}

async function attempt(track, info, mode, opts){
  const { ff, procs } = mode === 'direct' ? startDirect(info, opts) : startPipe(info, opts);
  const kill = () => { for (const p of procs){ try { if (p.exitCode === null) p.kill('SIGKILL'); } catch {} } };
  ff.stdout.on('error', () => {});
  ff.stdout.once('close', kill);
  try {
    await waitForAudio(ff, procs);
  } catch (e){
    kill();
    throw e;
  }
  const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: { trackId: track.id } });
  return { resource, kill, mode };
}

// Returns { resource, kill, mode }. Throws if the track can't be played.
export async function createAudio(track, { offset = 0, filterChain = '' } = {}){
  if (!track.url) throw new Error('track has no URL');
  let info = await getStreamInfo(track.url);
  const opts = { offset: info.isLive ? 0 : Math.max(0, Math.floor(offset)), filterChain };
  const canDirect = opts.offset > 0 && /^https?$/.test(info.format.protocol || '') && !!info.format.url;

  const plan = canDirect ? ['direct', 'pipe'] : ['pipe'];
  let lastErr;
  for (const mode of plan){
    try {
      return { ...(await attempt(track, info, mode, opts)), info };
    } catch (e){
      lastErr = e;
      log.debug('audio.attempt_failed', { title: track.title, mode, err: e });
    }
  }
  // Stream URLs expire; re-extract once and try again from scratch.
  invalidateStreamInfo(track.url);
  info = await getStreamInfo(track.url, { force: true });
  try {
    return { ...(await attempt(track, info, 'pipe', opts)), info };
  } catch (e){
    log.warn('audio.failed', { title: track.title, url: track.url, err: e, first: lastErr?.message });
    throw e;
  }
}
