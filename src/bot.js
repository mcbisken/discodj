import 'dotenv/config';
import { spawn } from 'node:child_process';

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, demuxProbe, StreamType } from '@discordjs/voice';
import yts from 'youtube-search-api';
import spotifyUrlInfo from 'spotify-url-info';

import { createLogger } from './logger.js';
import { runExclusive } from './locks.js';
import { DATA_DIR, getOrInit, initDataDir, loadGuild, saveGuild, state } from './state.js';
import { ytdlpJSON, ytSingleInfo, ytPlaylistExpand, guessThumbFromUrl } from './utils/ytdlp.js';
import { listPlaylists, savePlaylist, loadPlaylist, deletePlaylist } from './playlists.js';

const log = createLogger({ service: 'discodj' });


// === Preflight: check external binaries + auto-update yt-dlp ===
async function preflightBinaries(){
  const checks = [
    { cmd: 'yt-dlp', args: ['--version'], name: 'yt-dlp' },
    { cmd: 'ffmpeg', args: ['-version'], name: 'ffmpeg' }
  ];
  for (const c of checks){
    try{
      await new Promise((resolve, reject) => {
        const p = spawn(c.cmd, c.args);
        p.on('error', reject);
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(c.name + ' exit ' + code))));
      });
    } catch(e){
      log.error('startup.dependency_missing', { dep: c.name, err: e?.message || String(e) });
    }
  }
}

async function autoUpdateYtdlp(){
  log.info('ytdlp.update_check');
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['-U', '--no-color']);
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('error', (e) => { log.warn('ytdlp.update_failed', { err: e?.message }); resolve(); });
    p.on('close', (code) => {
      const summary = out.trim().split('\n').pop() || '';
      if (summary.includes('up-to-date') || summary.includes('up to date')) {
        log.info('ytdlp.already_up_to_date', { summary });
      } else if (code === 0) {
        log.info('ytdlp.updated', { summary });
      } else {
        log.warn('ytdlp.update_failed', { code, summary });
      }
      resolve();
    });
  });
}

preflightBinaries().then(() => autoUpdateYtdlp()).catch(()=>{});

// Schedule daily yt-dlp update (every 24 hours)
setInterval(() => { autoUpdateYtdlp().catch(()=>{}); }, 24 * 60 * 60 * 1000);

// === embed edit single-flight + payload de-dupe (non-visual changes) ===
const editLocks = new Map();
const lastPayloadHash = new Map();
function composePanel(gid){
  const s = getOrInit(gid);
  const isPaused = s.player?.state?.status === AudioPlayerStatus.Paused;
  const page = s.queuePage || 0;
  const embed = buildEmbed(gid, page);
  const totalPages = embed._queueTotalPages || 1;
  const components = [buildControls(isPaused)];
  if (totalPages > 1) components.push(buildQueueControls(page, totalPages));
  return { embeds:[embed], components };
}
async function queueRefresh(gid, { immediate = false } = {}) {
  try{
    const s = getOrInit(gid);
    if (!s.panel || !s.panel.channelId) return;

    // Bump a per-guild edit version so older, in-flight edits can be skipped
    if (typeof s.editVer !== 'number') s.editVer = 0;
    const myVer = ++s.editVer;

    const prog = getProgressObj(gid);
    const hash = JSON.stringify({
      n: s.nowPlaying?.url || null,
      e: [Math.floor(prog.elapsed||0), Math.floor(prog.total||0)],
      p: s.player?.state?.status || null,
      q: s.queue?.length || 0
    });
    if (!immediate && lastPayloadHash.get(gid) === hash) return;
    lastPayloadHash.set(gid, hash);

    const payload = composePanel(gid);
    const doEdit = async () => {
      // If a newer refresh has been scheduled, skip this one
      const cur = getOrInit(gid);
      if (typeof cur.editVer === 'number' && cur.editVer !== myVer) return;

      const ch = await client.channels.fetch(cur.panel.channelId).catch(()=>null);
      if (!ch || !ch.isTextBased()) return;
      let msg = null;
      if (cur.panel?.messageId){
        msg = await ch.messages.fetch(cur.panel.messageId).catch(()=>null);
      }
      if (msg) await msg.edit(payload).catch(()=>{});
      else {
        msg = await ch.send(payload).catch(()=>null);
        if (msg) cur.panel = { channelId: ch.id, messageId: msg.id };
      }
    };

    const prev = editLocks.get(gid) || Promise.resolve();
    const next = prev.then(doEdit, doEdit);
    editLocks.set(gid, next);
    await next.catch(()=>{});
  } catch {}
}


// === discodj: exact timing helpers ===
function initTimingState(gid){
  const s = getOrInit(gid);
  if (s.startedAtMs == null) s.startedAtMs = 0;
  if (s.seekBaseSec == null) s.seekBaseSec = 0;
  if (s.pausedAtMs == null) s.pausedAtMs = 0;
  if (s.pauseHoldMs == null) s.pauseHoldMs = 0;
  return s;
}
function onTrackStartTiming(gid, seekBaseSec = 0){
  const s = initTimingState(gid);
  s.startedAtMs = Date.now();
  s.seekBaseSec = Number(seekBaseSec) || 0;
  s.pausedAtMs  = 0;
  s.pauseHoldMs = 0;
}
function onPauseTiming(gid){
  const s = initTimingState(gid);
  if (!s.pausedAtMs) s.pausedAtMs = Date.now();
}
function onResumeTiming(gid){
  const s = initTimingState(gid);
  if (s.pausedAtMs){
    s.pauseHoldMs += Date.now() - s.pausedAtMs;
    s.pausedAtMs = 0;
  }
}
function onSeekTiming(gid, newPosSec){
  const s = initTimingState(gid);
  s.seekBaseSec = Number(newPosSec) || 0;
  s.startedAtMs = Date.now();
  s.pausedAtMs  = 0;
  s.pauseHoldMs = 0;
}
function getAccurateElapsedSec(gid){
  const s = initTimingState(gid);
  const playDurMs = s.resource?.playbackDuration;
  if (Number.isFinite(playDurMs) && playDurMs >= 0){
    return (playDurMs / 1000) + (Number(s.seekBaseSec) || 0);
  }
  const now = Date.now();
  const paused = s.pausedAtMs ? (now - s.pausedAtMs) : 0;
  const effective = (now - s.startedAtMs) - (s.pauseHoldMs + paused);
  return Math.max(0, (Number(s.seekBaseSec) || 0) + (effective / 1000));
}
function getProgressObj(gid){
  const s = getOrInit(gid);
  const total = Number(s.nowPlaying?.durationSec);
  let elapsed = getAccurateElapsedSec(gid);
  if (Number.isFinite(total) && total > 0){
    if (elapsed > total) elapsed = total;
  }
  return { elapsed, total: Number.isFinite(total) && total > 0 ? total : NaN };
}
// === end exact timing helpers ===


/* ---- Setup ---- */
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null;
if (!TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

/* ---- Interaction safety helpers ---- */
function isUnknownInteraction(err){
  return !!(err && (err.code === 10062 || String(err.message || '').includes('Unknown interaction')));
}

function normalizeResponseOptions(options){
  if (!options) return undefined;
  // discord.js is deprecating ephemeral:boolean in favor of flags.
  // Keep backward compatibility by mapping ephemeral -> flags.
  if (Object.prototype.hasOwnProperty.call(options, 'ephemeral')){
    const { ephemeral, ...rest } = options;
    if (ephemeral){
      return { ...rest, flags: (rest.flags ?? 0) | MessageFlags.Ephemeral };
    }
    return rest;
  }
  return options;
}

async function safeDeferReply(interaction, options){
  try{
    await interaction.deferReply(normalizeResponseOptions(options));
    return true;
  }catch(e){
    if (isUnknownInteraction(e)) return false;
    throw e;
  }
}

async function safeDeferUpdate(interaction){
  try{
    await interaction.deferUpdate();
    return true;
  }catch(e){
    if (isUnknownInteraction(e)) return false;
    throw e;
  }
}

function isDJ(interaction){
  try {
    // Administrator / ManageGuild / ManageChannels are treated as DJ capabilities.
    const perms = interaction.memberPermissions;
    if (perms?.has?.('Administrator') || perms?.has?.('ManageGuild') || perms?.has?.('ManageChannels')) return true;
    const roleId = process.env.DJ_ROLE_ID;
    if (roleId && interaction.member?.roles?.cache?.has?.(roleId)) return true;
  } catch {}
  return false;
}

await initDataDir();

/* ---- Patterns ---- */
const YT_REGEX  = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i;
const SC_REGEX  = /^(https?:\/\/)?(www\.)?soundcloud\.com\//i;
const YT_PL_REGEX = /[?&]list=([a-zA-Z0-9_-]+)/;
const SPOTIFY_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/(track|album|playlist)\/([A-Za-z0-9]+)(\?.*)?$/i;

function normalizeYouTubeVideoUrl(input){
  // Converts youtu.be/<id>?list=... to https://www.youtube.com/watch?v=<id>
  // Strips playlist-ish parameters that can trigger yt-dlp playlist mode.
  try{
    const u = new URL(/^https?:\/\//i.test(input) ? input : ('https://' + input));
    const host = u.hostname.replace(/^www\./,'');
    let id = null;
    let t = u.searchParams.get('t') || u.searchParams.get('start');

    if (host === 'youtu.be'){
      id = u.pathname.replace(/^\//,'');
    } else if (host.endsWith('youtube.com')){
      id = u.searchParams.get('v');
      // Support /shorts/<id>
      if (!id){
        const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
        if (m) id = m[1];
      }
      // Support /embed/<id>
      if (!id){
        const m = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,})/);
        if (m) id = m[1];
      }
    }
    if (!id) return input;
    const out = new URL('https://www.youtube.com/watch');
    out.searchParams.set('v', id);
    if (t) out.searchParams.set('t', t);
    return out.toString();
  } catch {
    return input;
  }
}

function isYouTubePlaylistWorthExpanding(url){
  // Expand normal finite playlists (PL/OLAK5uy/UU/FL...) but NOT mixes/radio (RD*).
  try{
    const u = new URL(/^https?:\/\//i.test(url) ? url : ('https://' + url));
    const list = u.searchParams.get('list');
    if (!list) return false;
    if (list.startsWith('RD')) return false; // YouTube Mix/Radio is often huge/"infinite"
    if (list === 'WL' || list === 'LL') return false; // Watch Later / Liked
    return true;
  } catch {
    return false;
  }
}

// State, persistence and yt-dlp helpers are in ./state.js and ./utils/ytdlp.js
async function searchYoutubeFirst(q){
  const res = await yts.GetListByKeyword(q, false, 6);
  const item = res && res.items ? res.items.find(i => i.type==='video' || (i.id && i.id.kind==='youtube#video')) : null;
  if (!item) return null;
  const id = typeof item.id === 'string' ? item.id : item.id?.videoId;
  const url = item.url || (id ? ('https://www.youtube.com/watch?v='+id) : null);
  return url ? { url, title: item.title || (item.snippet ? item.snippet.title : 'Unknown'), thumbnail: (item.thumbnail && item.thumbnail.thumbnails && item.thumbnail.thumbnails[0] ? item.thumbnail.thumbnails[0].url : guessThumbFromUrl(url)) } : null;
}
function asTrackFromUrlTitle(obj, requester, source){
  return { url: obj.url, title: obj.title, thumbnail: obj.thumbnail, durationSec: obj.durationSec, requestedById: requester.id, requestedByTag: requester.tag, source: source || 'yt' };
}
async function resolveSpotifyToTracks(url, requester){
  try {
    const { getData, getTracks } = spotifyUrlInfo(fetch);
    const data = await getData(url);
    if (data && data.type === 'track') {
      const title = data.name || data.title || '';
      const artists = Array.isArray(data.artists) ? data.artists.map(a => a.name).filter(Boolean) : [];
      const q = [title, artists.join(' ')].filter(Boolean).join(' ');
      const hit = await searchYoutubeFirst(q);
      if (!hit) return [];
      const m = await ytSingleInfo(hit.url).catch(()=>null);
      return [asTrackFromUrlTitle({ url: m?.url || hit.url, title: m?.title || hit.title || q, thumbnail: m?.thumbnail || hit.thumbnail, durationSec: m?.durationSec }, requester, 'sp')];
    }
    if (data && (data.type === 'album' || data.type === 'playlist')) {
      const trs = await getTracks(url);
      const out = [];
      for (const t of (trs||[]).slice(0,100)){
        const title = t?.name || '';
        const artists = Array.isArray(t?.artists) ? t.artists.map(a=>a.name).filter(Boolean) : [];
        const q = [title, artists.join(' ')].filter(Boolean).join(' ');
        if (!q) continue;
        // Queue a lazy placeholder — the YouTube URL is resolved just before playback in makeResourceFromTrack
        out.push({ url: null, _spotifyQuery: q, title: q, thumbnail: undefined, durationSec: undefined, requestedById: requester.id, requestedByTag: requester.tag, source: 'sp' });
      }
      return out;
    }
    const title = data && (data.name || data.title);
    if (title) {
      const hit = await searchYoutubeFirst(title);
      return hit ? [asTrackFromUrlTitle(hit, requester, 'sp')] : [];
    }
  } catch {}
  return [];
}
async function buildTracksFromInput(q, requester){
  if (YT_REGEX.test(q)) {
    // If the user pastes a video-in-a-mix URL (list=RD...), treat as a single video.
    if (isYouTubePlaylistWorthExpanding(q) && YT_PL_REGEX.test(q)) return await ytPlaylistExpand(q, requester);
    const cleaned = normalizeYouTubeVideoUrl(q);
    const info = await ytSingleInfo(cleaned);
    return info? [{...info, requestedById: requester.id, requestedByTag: requester.tag}] : [];
  }
  if (SPOTIFY_REGEX.test(q)) return await resolveSpotifyToTracks(q, requester);
  if (SC_REGEX.test(q)) {
    // SoundCloud — yt-dlp handles SC URLs natively (tracks, sets, artists)
    const info = await ytSingleInfo(q).catch(()=>null);
    if (info) return [{ ...info, requestedById: requester.id, requestedByTag: requester.tag, source: 'sc' }];
    // Might be a playlist/set — try expanding
    const expanded = await ytPlaylistExpand(q, requester).catch(()=>[]);
    return expanded.length ? expanded : [];
  }
  const hit = await searchYoutubeFirst(q);
  return hit? [asTrackFromUrlTitle(hit, requester, 'yt')] : [];
}

/* ---- Audio ---- */
const directUrlCache = new Map(); // ytUrl -> { value, exp }
async function getDirectAudioUrl(ytUrl){
  // Only normalise YouTube URLs; SoundCloud and other URLs pass through unchanged
  const cleaned = SC_REGEX.test(ytUrl) ? ytUrl : normalizeYouTubeVideoUrl(ytUrl);
  const cached = directUrlCache.get(cleaned);
  if (cached && Date.now() < cached.exp) return cached.value;

  const runOnce = () => new Promise((resolve,reject)=>{
    // --no-playlist is critical: URLs like ?list=RD... can trigger playlist mode otherwise.
    const p = spawn('yt-dlp',['--no-playlist','-f','bestaudio/best','-g',cleaned]);
    const t = setTimeout(()=>{ try{ p.kill('SIGKILL'); } catch {} }, 30_000);
    let out='',err=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    p.on('error', (e)=>{ clearTimeout(t); reject(e); });
    p.on('close',c=>{
      clearTimeout(t);
      if (c===0 && out.trim()) resolve(out.trim().split('\n').pop());
      else reject(new Error('yt-dlp -g failed ('+c+'): '+err));
    });
  });

  let last;
  for (let i=0;i<2;i++){
    try{
      const url = await runOnce();
      directUrlCache.set(cleaned, { value: url, exp: Date.now() + 90*60*1000 });
      return url;
    } catch (e){
      last = e;
      if (i===0) await new Promise(r=>setTimeout(r, 500));
    }
  }
  throw last;
}
/* ---- Audio Filters ---- */
const AUDIO_FILTERS = {
  bassboost: 'equalizer=f=40:width_type=o:width=2:g=5',
  nightcore: 'aresample=48000,asetrate=48000*1.25',
  vaporwave: 'aresample=48000,asetrate=48000*0.8',
  '8d':      'apulsator=hz=0.08',
  echo:      'aecho=0.8:0.9:1000:0.3',
  karaoke:   'stereotools=mlev=0.015625',
  treble:    'equalizer=f=3000:width_type=h:width=2000:g=5',
};

function ffmpegOggOpusStream(mediaUrl, offsetSec, filterKey){
  const ss = Math.max(0, Math.floor(offsetSec||0));
  const filterStr = filterKey && AUDIO_FILTERS[filterKey] ? AUDIO_FILTERS[filterKey] : null;
  const args = [
    ...(ss ? ['-ss', String(ss)] : []),
    '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5',
    '-i', mediaUrl, '-vn','-ac','2','-ar','48000',
    ...(filterStr ? ['-af', filterStr] : []),
    '-c:a','libopus','-b:a','160k','-f','ogg','pipe:1'
  ];
  const ff = spawn('ffmpeg', args, { stdio: ['ignore','pipe','ignore'] });
  return ff.stdout;
}
async function makeResourceFromTrack(track, offsetSec, filterKey){
  // Lazy resolution for Spotify placeholder tracks (queued without a YouTube URL)
  if (!track.url && track._spotifyQuery) {
    const hit = await searchYoutubeFirst(track._spotifyQuery);
    if (!hit) throw new Error('No YouTube match found for: ' + track._spotifyQuery);
    const m = await ytSingleInfo(hit.url).catch(()=>null);
    track.url = m?.url || hit.url;
    track.title = m?.title || hit.title || track._spotifyQuery;
    track.thumbnail = m?.thumbnail || hit.thumbnail;
    track.durationSec = m?.durationSec;
  }
  const direct = await getDirectAudioUrl(track.url);
  const opusOgg = ffmpegOggOpusStream(direct, offsetSec||0, filterKey);
  try{
    const probed = await demuxProbe(opusOgg);
    return createAudioResource(probed.stream, { inputType: probed.type || StreamType.OggOpus, inlineVolume: true, metadata: track });
  } catch (e){
    console.warn('demuxProbe failed, falling back to arbitrary stream type:', e && e.message ? e.message : e);
    return createAudioResource(opusOgg, { inputType: StreamType.Arbitrary, inlineVolume: true, metadata: track });
  }
}

/* ---- Presence ---- */
function setPresencePlaying(title){ try { client.user?.setPresence({ activities: [{ name: title, type: 2 }], status: 'online' }); } catch {} }
function clearPresence(){ try { client.user?.setPresence({ activities: [], status: 'online' }); } catch {} }

/* ---- UI ---- */
function buildControls(isPaused){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:prev').setStyle(ButtonStyle.Secondary).setLabel('⏮ Prev'),
    new ButtonBuilder().setCustomId('music:toggle').setStyle(ButtonStyle.Primary).setLabel(isPaused ? '▶ Resume' : '⏸ Pause'),
    new ButtonBuilder().setCustomId('music:skip').setStyle(ButtonStyle.Secondary).setLabel('⏭ Skip'),
    new ButtonBuilder().setCustomId('music:stop').setStyle(ButtonStyle.Danger).setLabel('⏹ Stop')
  );
}

function buildQueueControls(page, totalPages){
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('queue:prev').setStyle(ButtonStyle.Secondary).setLabel('◀ Prev').setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('queue:page').setStyle(ButtonStyle.Secondary).setLabel(`Page ${page+1} / ${totalPages}`).setDisabled(true),
    new ButtonBuilder().setCustomId('queue:next').setStyle(ButtonStyle.Secondary).setLabel('Next ▶').setDisabled(page >= totalPages - 1)
  );
  return row;
}
function formatTime(sec){
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  const mm = h ? String(m).padStart(2,'0') : String(m); const ss = String(s).padStart(2,'0');
  return h ? (h+':'+mm+':'+ss) : (m+':'+ss);
}
function buildProgressBar(elapsed, total, slots){
  if (!Number.isFinite(total) || total <= 0) return null;
  const n = slots || 10;
  const pos = Math.max(0, Math.min(n, Math.round((elapsed/total)*n)));
  let bar = '';
  for (let i=0;i<n;i++){ bar += (i===pos? '🔘' : '▬'); }
  return formatTime(elapsed)+' / '+formatTime(total)+'\n'+bar;
}
const QUEUE_PAGE_SIZE = 8;

function getQueueETA(s, upToIndex){
  // Returns seconds until track at upToIndex starts playing
  const prog = getProgressObj(s._gid || '');
  let remaining = 0;
  if (s.nowPlaying && Number.isFinite(prog.total) && Number.isFinite(prog.elapsed)){
    remaining = Math.max(0, prog.total - prog.elapsed);
  }
  for (let i = 0; i < Math.min(upToIndex, s.queue.length); i++){
    const dur = s.queue[i]?.durationSec;
    if (Number.isFinite(dur)) remaining += dur;
  }
  return remaining;
}

function buildQueuePage(s, page){
  const queue = s.queue || [];
  const totalPages = Math.max(1, Math.ceil(queue.length / QUEUE_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * QUEUE_PAGE_SIZE;
  const slice = queue.slice(start, start + QUEUE_PAGE_SIZE);

  if (!slice.length && !queue.length) return { text: '— queue is empty —', totalPages, page: 0 };

  const lines = [];
  for (let i = 0; i < slice.length; i++){
    const globalIdx = start + i;
    const t = slice[i] || {};
    const safeTitle = t.title || 'Unknown';
    const safeUrl = t.url || '';
    const dur = (typeof t.durationSec === 'number' && Number.isFinite(t.durationSec)) ? ` • ${formatTime(t.durationSec)}` : '';
    const eta = getQueueETA(s, globalIdx);
    const etaStr = eta > 0 ? ` *(in ${formatTime(eta)})*` : '';
    const titleStr = safeUrl ? `[${safeTitle}](${safeUrl})` : safeTitle;
    lines.push(`\`${globalIdx+1}.\` ${titleStr}${dur}${etaStr}`);
  }
  return { text: lines.join('\n'), totalPages, page: safePage };
}
/* progress auto-refresh */
const progressTimers = new Map();
function startProgressTimer(gid){
  if (progressTimers.has(gid)) { clearInterval(progressTimers.get(gid)); progressTimers.delete(gid); }
  const id = setInterval(() => { try { queueRefresh(gid); } catch {} }, 10000);
  progressTimers.set(gid, id);
}
function stopProgressTimer(gid){
  if (progressTimers.has(gid)) { clearInterval(progressTimers.get(gid)); progressTimers.delete(gid); }
}

function buildEmbed(gid, queuePage = 0){
  const __prog = getProgressObj(gid);
  const __elapsed = __prog.elapsed;
  const __total = __prog.total;

  const s = getOrInit(gid);
  s._gid = gid; // pass gid to ETA helper
  const np = s.nowPlaying;
  const filterLabel = s.filter ? ` • 🎛 ${s.filter}` : '';
  const emb = new EmbedBuilder().setColor(0x5865F2)
    .setTitle(np ? '🎵  Now playing:' : '⏸  Nothing playing')
    .setTimestamp(new Date());

  if (np){
    if (np.thumbnail) emb.setThumbnail(np.thumbnail);
    emb.addFields({ name: '\u200B', value: '['+np.title+']('+np.url+')' });
    const prog = buildProgressBar(__elapsed, __total, 12);
    if (prog) emb.addFields({ name: 'Progress', value: prog });
    emb.addFields(
      { name: 'Requested by', value: '<@'+np.requestedById+'>', inline: true },
      { name: 'Duration', value: (Number.isFinite(np?.durationSec) ? formatTime(np.durationSec) : 'Unknown'), inline: true },
      { name: 'Volume', value: (s.volume ?? 100) + '%' + filterLabel, inline: true },
      { name: 'Loop', value: s.loop || 'off', inline: true },
      { name: 'Autoplay', value: s.autoplay ? 'On' : 'Off', inline: true },
      { name: 'Queue', value: s.queue.length + ' track' + (s.queue.length !== 1 ? 's' : ''), inline: true }
    );
  }

  const { text: queueText, totalPages, page } = buildQueuePage(s, queuePage);
  const queueTitle = s.queue.length > 0
    ? `Up next (${s.queue.length} tracks)`
    : 'Up next';
  emb.addFields({ name: queueTitle, value: queueText.slice(0, 1024) });
  emb._queuePage = page;
  emb._queueTotalPages = totalPages;
  return emb;
}

async function upsertPanel(channel, gid, queuePage = 0){
  const s = getOrInit(gid);
  const isPaused = s.player.state.status === AudioPlayerStatus.Paused;
  const embed = buildEmbed(gid, queuePage);
  const totalPages = embed._queueTotalPages || 1;
  const page = embed._queuePage || 0;
  const components = [buildControls(isPaused)];
  if (totalPages > 1) components.push(buildQueueControls(page, totalPages));
  if (s.panel && s.panel.messageId){
    try { const msg = await channel.messages.fetch(s.panel.messageId); await msg.edit({ embeds:[embed], components }); return msg; } catch {}
  }
  const msg = await channel.send({ embeds:[embed], components });
  s.panel = { channelId: channel.id, messageId: msg.id };
  return msg;
}
async function refreshPanel(gid){
  await queueRefresh(gid, { immediate:true });
}

/* ---- Playback ---- */
async function ensureConnection(interaction){
  const voice = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
  if (!voice) return null;
  const s = getOrInit(interaction.guildId);
  const conn = getVoiceConnection(interaction.guildId) || joinVoiceChannel({
    channelId: voice.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true
  });
  if (s.connection !== conn){
    s.connection = conn; conn.subscribe(s.player);
    s.player.removeAllListeners();
    s.player.on(AudioPlayerStatus.Playing, () => { queueRefresh(interaction.guildId, { immediate:true }); startProgressTimer(interaction.guildId); });
    s.player.on(AudioPlayerStatus.Paused,  () => queueRefresh(interaction.guildId, { immediate:true }));
    s.player.on(AudioPlayerStatus.AutoPaused,  () => queueRefresh(interaction.guildId, { immediate:true }));
    s.player.on(AudioPlayerStatus.Idle,    () => handleTrackEnd(interaction.guildId).catch(console.error));
  }
  return conn;
}
async function handleTrackEnd(gid){
  const s = getOrInit(gid);
  const finished = s.nowPlaying;
  if (finished){
    s.history.push(finished);
    if (s.loop==='one') s.queue.unshift(finished);
    else if (s.loop==='all') s.queue.push(finished);
  }
  s.nowPlaying = null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(gid); await saveGuild(gid);
  if (!s.queue.length && s.autoplay && finished){
    try{
      // Search for a related video using the finished track's title as the seed query.
      // yt-dlp's --flat-playlist doesn't work on single video URLs, so we use ytsearch2
      // and pick the second result (first is usually the same video).
      const searchQuery = 'ytsearch2:' + (finished.title || '');
      const rel = await ytdlpJSON(['-J', '--flat-playlist', '--no-warnings', '--', searchQuery]).catch(()=>null);
      const entries = rel && Array.isArray(rel.entries) ? rel.entries : [];
      // Skip the first result (likely the same song), take the second
      const pick = entries.find(e => e && e.id && e.id !== finished.url?.match(/v=([^&]+)/)?.[1]);
      if (pick){
        const videoUrl = pick.webpage_url || ('https://www.youtube.com/watch?v=' + pick.id);
        s.queue.push({ url: videoUrl, title: pick.title || ('Video ' + pick.id), thumbnail: guessThumbFromUrl(videoUrl), durationSec: pick.duration || undefined, requestedById: client.user.id, requestedByTag: client.user.tag, source:'yt' });
      }
    }catch{}
  }
  await playNext(gid);
}
async function playNext(gid, channelForPanel, seekOffset, _failCount = 0){
  const s = getOrInit(gid);
  const next = s.queue.shift();
  if (!next){
    clearPresence();
    stopProgressTimer(gid);
    // Keep the panel up to date if it exists
    if (s.panel && s.panel.channelId){
      const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null);
      if (ch && ch.isTextBased()) await upsertPanel(ch, gid);
    }
    await saveGuild(gid);
    return;
  }

  try{
    const res = await makeResourceFromTrack(next, seekOffset || 0, s.filter || null);
    if (res.volume) res.volume.setVolume(Math.max(0, Math.min(200, s.volume))/100);

    s.nowPlaying = next;
    s.resource = res;
    s.player.play(res);

    onTrackStartTiming(gid, seekOffset || 0);
    queueRefresh(gid, { immediate:true });
    startProgressTimer(gid);
    setPresencePlaying(next.title);

    const ch = channelForPanel || (s.panel && s.panel.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : null);
    if (ch && ch.isTextBased()) await upsertPanel(ch, gid);

    await saveGuild(gid);
  }catch(e){
    log.error('play.track_failed', { guildId: gid, title: next?.title, err: e?.message || String(e) });
    if (_failCount >= 4) {
      // Too many consecutive failures — stop trying to prevent an infinite loop
      log.error('play.too_many_failures', { guildId: gid, count: _failCount + 1 });
      const ch = channelForPanel || (s.panel && s.panel.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : null);
      if (ch && ch.isTextBased()) ch.send('⚠️ Skipped 5 tracks in a row due to playback errors. Stopping.').catch(()=>{});
      clearPresence(); stopProgressTimer(gid);
      return;
    }
    await playNext(gid, channelForPanel, undefined, _failCount + 1);
  }
}

/* ---- Commands ---- */
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song/playlist by URL, Spotify, or search query')
    .addStringOption(o=>o.setName('q').setDescription('URL or search query').setRequired(true).setAutocomplete(true))
    .addStringOption(o=>o.setName('position').setDescription('Where to insert in the queue').addChoices(
      { name: 'end', value: 'end' },
      { name: 'next', value: 'next' },
      { name: 'top', value: 'top' }
    ).setRequired(false)),
  new SlashCommandBuilder().setName('queue').setDescription('Show/refresh the player panel'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('prev').setDescription('Play previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (0–200%)').addIntegerOption(o=>o.setName('percent').setDescription('0–200').setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Seek to timestamp (e.g., 1:23 or 83)').addStringOption(o=>o.setName('time').setDescription('mm:ss or seconds').setRequired(true)),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a queued song by position')
    .addStringOption(o=>o.setName('index').setDescription('Queue position or song title').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('move').setDescription('Move a queued song')
    .addStringOption(o=>o.setName('from').setDescription('Song to move').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o=>o.setName('to').setDescription('New 1-based position').setRequired(true)),
  new SlashCommandBuilder().setName('jump').setDescription('Jump to a queued song now')
    .addStringOption(o=>o.setName('index').setDescription('Queue position or song title').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the upcoming queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o=>o.setName('mode').setDescription('off | one | all').addChoices({name:'off', value:'off'},{name:'one', value:'one'},{name:'all', value:'all'}).setRequired(true)),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle radio when queue ends').addBooleanOption(o=>o.setName('on').setDescription('true/false').setRequired(true)),
  new SlashCommandBuilder().setName('djonly').setDescription('Restrict controls to DJs/Admins').addBooleanOption(o=>o.setName('on').setDescription('true/false').setRequired(true)),
  new SlashCommandBuilder().setName('playlist')
    .setDescription('Save, load, or manage saved playlists')
    .addSubcommand(sub => sub.setName('save').setDescription('Save the current queue as a named playlist')
      .addStringOption(o=>o.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand(sub => sub.setName('load').setDescription('Load a saved playlist into the queue')
      .addStringOption(o=>o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub.setName('delete').setDescription('Delete a saved playlist')
      .addStringOption(o=>o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Show all saved playlists')),
  new SlashCommandBuilder().setName('filter').setDescription('Apply an audio filter (takes effect on next track or after seek)')
    .addStringOption(o=>o.setName('name').setDescription('Filter to apply').setRequired(true).addChoices(
      { name: 'off', value: 'off' },
      { name: '🔊 Bass Boost', value: 'bassboost' },
      { name: '⚡ Nightcore', value: 'nightcore' },
      { name: '🌊 Vaporwave', value: 'vaporwave' },
      { name: '🎧 8D Audio', value: '8d' },
      { name: '🔁 Echo', value: 'echo' },
      { name: '🎤 Karaoke (vocal remover)', value: 'karaoke' },
      { name: '🎸 Treble Boost', value: 'treble' }
    )),
].map(c=>c.toJSON());

// discord.js v14+ deprecates 'ready' in favor of 'clientReady'
client.once('clientReady', async () => {
  log.info('startup.ready', { userTag: client.user?.tag });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    log.info('startup.commands_registered', { guildId: GUILD_ID });
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    log.info('startup.commands_registered_global');
  }
  clearPresence();
  await loadGuild(GUILD_ID).catch(()=>{});
});

/* ---- Events ---- */
/* ---- Auto-leave debounce ---- */
const leaveTimers = new Map();

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild; if (!guild) return;
  const s = getOrInit(guild.id);
  const conn = getVoiceConnection(guild.id); if (!conn) return;
  const me = guild.members.me; const channelId = me && me.voice ? me.voice.channelId : null; if (!channelId) return;
  const channel = guild.channels.cache.get(channelId); if (!channel || !('members' in channel)) return;
  const humans = channel.members.filter(m => !m.user.bot).size;

  if (humans === 0) {
    // Debounce: wait 3s before leaving in case someone is reconnecting
    if (leaveTimers.has(guild.id)) return;
    const timer = setTimeout(async () => {
      leaveTimers.delete(guild.id);
      // Re-check humans after debounce period
      const ch = guild.channels.cache.get(channelId);
      const stillEmpty = !ch || !('members' in ch) || ch.members.filter(m => !m.user.bot).size === 0;
      if (stillEmpty) {
        try { conn.destroy(); } catch {}
        s.connection = null; stopProgressTimer(guild.id); clearPresence();
      }
    }, 3000);
    leaveTimers.set(guild.id, timer);
  } else {
    // Someone joined — cancel any pending leave
    if (leaveTimers.has(guild.id)) {
      clearTimeout(leaveTimers.get(guild.id));
      leaveTimers.delete(guild.id);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
  if (interaction.isAutocomplete()) {
    const focused = String(interaction.options.getFocused() || '').trim();
    const cmd = interaction.commandName;

    // /play — search YouTube
    if (cmd === 'play') {
      if (!focused || /^https?:\/\//i.test(focused)) return interaction.respond([]);
      try {
        const res = await yts.GetListByKeyword(focused, false, 6);
        const videos = (res && res.items ? res.items : []).filter(i => i.type === 'video').slice(0, 5);
        const choices = videos.map(v => {
          const id = typeof v.id === 'string' ? v.id : v.id?.videoId;
          const url = v.url || (id ? ('https://www.youtube.com/watch?v='+id) : null);
          const name = (v.title || 'Unknown title').slice(0, 100);
          return { name, value: url || name };
        });
        return interaction.respond(choices);
      } catch { return interaction.respond([]); }
    }

    // /jump, /remove, /move — autocomplete from queue
    if (cmd === 'jump' || cmd === 'remove' || (cmd === 'move' && interaction.options.getFocusedOption()?.name === 'from')) {
      const s = getOrInit(interaction.guildId);
      const q = focused.toLowerCase();
      const choices = (s.queue || [])
        .map((t, i) => ({ name: `${i+1}. ${(t.title || 'Unknown').slice(0, 90)}`, value: String(i+1) }))
        .filter(c => !q || c.name.toLowerCase().includes(q))
        .slice(0, 25);
      return interaction.respond(choices);
    }

    // /playlist load and delete — autocomplete from saved playlists
    if (cmd === 'playlist') {
      const focusedOpt = interaction.options.getFocusedOption()?.name;
      if (focusedOpt === 'name') {
        const all = await listPlaylists(interaction.guildId).catch(() => ({}));
        const choices = Object.values(all)
          .filter(p => !focused || p.name.toLowerCase().includes(focused.toLowerCase()))
          .slice(0, 25)
          .map(p => ({ name: `${p.name} (${p.count} tracks)`, value: p.name }));
        return interaction.respond(choices);
      }
    }

    return interaction.respond([]);
  }

  if (interaction.isButton()) {
    return runExclusive(interaction.guildId, async () => {
      const s = getOrInit(interaction.guildId);
      const id = interaction.customId;
      if (!s.panel || interaction.message.id !== s.panel.messageId) { await safeDeferUpdate(interaction); return; }

      // DJ-only gate (optional)
      if (s.djOnly && !isDJ(interaction)) {
        try {
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'DJ-only controls are enabled for this server.', flags: MessageFlags.Ephemeral });
          } else {
            await interaction.followUp({ content: 'DJ-only controls are enabled for this server.', flags: MessageFlags.Ephemeral }).catch(()=>{});
          }
        } catch {}
        return;
      }

      if (id === 'music:prev') {
        if (!s.history.length) { await safeDeferUpdate(interaction); return; }
        if (s.nowPlaying) s.queue.unshift(s.nowPlaying);
        const prev = s.history.pop();
        s.queue.unshift(prev);
        s.player.stop(true);
        await saveGuild(interaction.guildId);
        await safeDeferUpdate(interaction);
        return;
      }

      if (id === 'music:toggle') {
        if (s.player.state.status === AudioPlayerStatus.Playing) {
          s.player.pause(true);
          onPauseTiming(interaction.guildId);
          stopProgressTimer(interaction.guildId);
          clearPresence();
        } else {
          s.player.unpause();
          onResumeTiming(interaction.guildId);
          startProgressTimer(interaction.guildId);
          if (s.nowPlaying) setPresencePlaying(s.nowPlaying.title);
        }
        return interaction.update(composePanel(interaction.guildId));
      }

      if (id === 'music:skip') { s.player.stop(true); await safeDeferUpdate(interaction); return; }

      if (id === 'music:stop') {
        s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.queuePage=0;
        onTrackStartTiming(interaction.guildId, 0); stopProgressTimer(interaction.guildId); clearPresence();
        await saveGuild(interaction.guildId);
        return interaction.update(composePanel(interaction.guildId));
      }

      // Queue pagination buttons (no DJ gate — view-only)
      if (id === 'queue:prev' || id === 'queue:next') {
        const page = s.queuePage || 0;
        const totalPages = Math.max(1, Math.ceil((s.queue||[]).length / QUEUE_PAGE_SIZE));
        s.queuePage = id === 'queue:prev' ? Math.max(0, page - 1) : Math.min(totalPages - 1, page + 1);
        return interaction.update(composePanel(interaction.guildId));
      }

      // Dedup confirm/cancel buttons
      if (id === 'dedup:cancel') {
        return interaction.update({ content: '❌ Cancelled.', components: [] });
      }
      if (id.startsWith('dedup:confirm:')) {
        const originalQuery = decodeURIComponent(id.slice('dedup:confirm:'.length));
        await interaction.update({ content: '➕ Adding duplicate...', components: [] });
        const requestedBy = { id: interaction.user.id, tag: interaction.user.username + '#' + interaction.user.discriminator };
        const tracks = await buildTracksFromInput(originalQuery, requestedBy).catch(()=>[]);
        if (!tracks.length) { await interaction.editReply('No results found.'); return; }
        s.queue.push(...tracks);
        await saveGuild(interaction.guildId);
        await interaction.editReply('➕ Queued: **' + tracks[0].title + '**');
        if (s.player.state.status !== AudioPlayerStatus.Playing) {
          await playNext(interaction.guildId, interaction.channel);
        } else {
          const ch = s.panel?.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : interaction.channel;
          if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId);
        }
        return;
      }
    });
  }

  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  return runExclusive(interaction.guildId, async () => {

  // DJ-only gate (optional): applies to queue/transport mutations.
  const s0 = getOrInit(interaction.guildId);
  const protectedCmds = new Set(['play','skip','prev','stop','leave','volume','seek','shuffle','remove','move','jump','clear','loop','autoplay']);
  if (s0.djOnly && protectedCmds.has(name) && !isDJ(interaction)) {
    if (!(await safeDeferReply(interaction, { flags: MessageFlags.Ephemeral }))) return;
    return interaction.followUp({ content: 'DJ-only controls are enabled for this server.', flags: MessageFlags.Ephemeral });
  }

  if (name === 'join') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const conn = await ensureConnection(interaction);
    return interaction.followUp({ content: conn ? 'Joined your voice channel. 👋' : 'You must be in a voice channel.', ephemeral: true });
  }
  if (name === 'play') {
    if (!(await safeDeferReply(interaction))) return;
    const conn = await ensureConnection(interaction);
    if (!conn) return interaction.followUp('You must be in a voice channel.');
    const q = interaction.options.getString('q', true);
    const requestedBy = { id: interaction.user.id, tag: interaction.user.username + '#' + interaction.user.discriminator };
    let tracks = await buildTracksFromInput(q, requestedBy);
    if (!tracks.length) return interaction.followUp('No results. Try another query or a different URL.');
    const s = getOrInit(interaction.guildId);

    // Deduplication check — warn if any track URL is already in the queue or now playing
    const queueUrls = new Set([
      ...(s.queue || []).map(t => t.url).filter(Boolean),
      s.nowPlaying?.url
    ].filter(Boolean));
    const dupes = tracks.filter(t => t.url && queueUrls.has(t.url));
    if (dupes.length === 1 && tracks.length === 1) {
      // Single dupe — ask for confirmation via a button
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dedup:confirm:' + encodeURIComponent(q)).setLabel('Add anyway').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('dedup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      return interaction.followUp({ content: `⚠️ **${dupes[0].title}** is already in the queue. Add it again?`, components: [confirmRow] });
    }
    if (dupes.length > 0 && dupes.length < tracks.length) {
      // Partial dupes in a playlist — just note it
      await interaction.followUp({ content: `ℹ️ ${dupes.length} track(s) already in queue were skipped.`, flags: MessageFlags.Ephemeral }).catch(()=>{});
      tracks = tracks.filter(t => !t.url || !queueUrls.has(t.url));
      if (!tracks.length) return;
    }

    const position = interaction.options.getString('position') || 'end';
    if (position === 'next' || position === 'top') s.queue.splice(0, 0, ...tracks);
    else s.queue.push(...tracks);
    await saveGuild(interaction.guildId);
    await upsertPanel(interaction.channel, interaction.guildId);
    if (s.player.state.status !== AudioPlayerStatus.Playing) {
      const __playingMsg = await interaction.followUp('▶️ Playing: **'+tracks[0].title+'**'+(tracks.length>1?(' (+'+(tracks.length-1)+' more from playlist)') : ''));
      setTimeout(async () => { try { if (!__playingMsg?.flags?.has?.(MessageFlags.Ephemeral)) await __playingMsg.delete().catch(()=>{}); } catch {} }, 10_000);
      log.info('play.start', { guildId: interaction.guildId, userId: interaction.user.id, count: tracks.length, position });
      await playNext(interaction.guildId, interaction.channel);
    } else {
      const __queuedMsg = await interaction.followUp('➕ Queued: **'+tracks[0].title+'**'+(tracks.length>1?(' (+'+(tracks.length-1)+' more)') : ''));
      setTimeout(async () => { try { if (!__queuedMsg?.flags?.has?.(MessageFlags.Ephemeral)) await __queuedMsg.delete().catch(()=>{}); } catch {} }, 10_000);
      await upsertPanel(interaction.channel, interaction.guildId);
    }
  }

  if (name === 'queue') {
    if (!(await safeDeferReply(interaction))) return;
    await upsertPanel(interaction.channel, interaction.guildId);
    return interaction.followUp('Player panel updated ↓');
  }

  if (name === 'nowplaying') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    if (!s.nowPlaying) return interaction.followUp('Nothing is playing.');
    const e = new EmbedBuilder()
      .setTitle('Now Playing')
      .setDescription('**' + s.nowPlaying.title + '**')
      .setURL(s.nowPlaying.url)
      .setFooter({ text: 'Requested by ' + (s.nowPlaying.requestedByTag || 'Unknown') });
    if (s.nowPlaying.thumbnail) e.setThumbnail(s.nowPlaying.thumbnail);
    const prog = getProgressObj(interaction.guildId);
    if (Number.isFinite(prog.elapsed) && Number.isFinite(prog.total)) {
      e.addFields({ name: 'Progress', value: fmtTime(prog.elapsed) + ' / ' + fmtTime(prog.total), inline: true });
    }
    return interaction.followUp({ embeds: [e] });
  }
  if (name === 'skip') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    if (s.player.state.status !== AudioPlayerStatus.Playing) return interaction.followUp('Nothing is playing.');
    s.player.stop(true); return interaction.followUp('⏭️ Skipped.');
  }
  if (name === 'prev') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    if (!s.history.length && !s.nowPlaying) return interaction.followUp('No previous track.');
    if (s.nowPlaying) s.queue.unshift(s.nowPlaying); const prev = s.history.pop(); s.queue.unshift(prev); s.player.stop(true); await saveGuild(interaction.guildId);
    return interaction.followUp('⏮️ Previous track.');
  }
  if (name === 'stop') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(interaction.guildId); clearPresence(); await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp('⏹️ Stopped and cleared the queue.');
  }
  if (name === 'leave') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId); const conn = getVoiceConnection(interaction.guildId);
    s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(interaction.guildId); clearPresence();
    if (conn) conn.destroy(); s.connection=null;
    await saveGuild(interaction.guildId);
    return interaction.followUp('👋 Left the channel.');
  }

  if (name === 'clear') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    s.queue = [];
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){
      const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null);
      if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId);
    }
    return interaction.followUp('🧹 Queue cleared.');
  }

  if (name === 'remove') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    const idx = (parseInt(interaction.options.getString('index', true), 10) || 0) - 1;
    if (idx < 0 || idx >= s.queue.length) return interaction.followUp('Invalid index. Use `/queue` to view positions.');
    const [removed] = s.queue.splice(idx, 1);
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){
      const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null);
      if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId);
    }
    return interaction.followUp('🗑️ Removed: **' + (removed?.title || 'Unknown') + '**');
  }

  if (name === 'move') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    const from = (parseInt(interaction.options.getString('from', true), 10) || 0) - 1;
    const to = (interaction.options.getInteger('to', true) || 0) - 1;
    if (from < 0 || from >= s.queue.length || to < 0 || to >= s.queue.length) return interaction.followUp('Invalid positions.');
    const [item] = s.queue.splice(from, 1);
    s.queue.splice(to, 0, item);
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){
      const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null);
      if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId);
    }
    return interaction.followUp('↕️ Moved **' + (item?.title || 'Unknown') + '** to position **' + (to+1) + '**');
  }

  if (name === 'jump') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    const idx = (parseInt(interaction.options.getString('index', true), 10) || 0) - 1;
    if (idx < 0 || idx >= s.queue.length) return interaction.followUp('Invalid index.');
    const [item] = s.queue.splice(idx, 1);
    s.queue.splice(0, 0, item);
    await saveGuild(interaction.guildId);
    s.player.stop(true);
    return interaction.followUp('⏭️ Jumping to: **' + (item?.title || 'Unknown') + '**');
  }
  if (name === 'volume') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const s = getOrInit(interaction.guildId);
    const percent = Math.max(0, Math.min(200, interaction.options.getInteger('percent', true)));
    s.volume = percent; if (s.player.state.status === AudioPlayerStatus.Playing && s.player.state.resource && s.player.state.resource.volume) s.player.state.resource.volume.setVolume(percent/100);
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'🔊 Volume set to **'+percent+'%**', ephemeral:true });
  }
  if (name === 'seek') {
    if (!(await safeDeferReply(interaction))) return;
    const s = getOrInit(interaction.guildId);
    if (!s.nowPlaying) return interaction.followUp('Nothing is playing.');
    const t = interaction.options.getString('time', true).trim();
    const parts = t.split(':').map(n=>parseInt(n,10)).filter(n=>!isNaN(n));
    const seconds = parts.length===1? parts[0] : (parts.length===2? (parts[0]*60+parts[1]) : (parts[0]*3600+parts[1]*60+parts[2]));
    if (!Number.isFinite(seconds) || seconds<0) return interaction.followUp('Invalid time. Use `mm:ss` or seconds.');
    s.queue.unshift(s.nowPlaying); s.player.stop(true); await interaction.followUp('⏩ Seeking to **'+seconds+'**s...');
    setTimeout(()=> playNext(interaction.guildId, null, seconds).catch((e)=>log.error('seek.playNext_failed', { guildId: interaction.guildId, err: e?.message || String(e) })), 50);
  }
  if (name === 'shuffle') {
    if (!(await safeDeferReply(interaction))) return; const s = getOrInit(interaction.guildId);
    if (s.queue.length<2) return interaction.followUp('Not enough items to shuffle.');
    for (let i=s.queue.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const tmp=s.queue[i]; s.queue[i]=s.queue[j]; s.queue[j]=tmp; }
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp('🔀 Shuffled the queue.');
  }
  if (name === 'loop') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const s = getOrInit(interaction.guildId);
    const mode = interaction.options.getString('mode', true);
    s.loop = mode; await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'🔁 Loop set to **'+mode+'**', ephemeral:true });
  }
  if (name === 'autoplay') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const s = getOrInit(interaction.guildId);
    s.autoplay = interaction.options.getBoolean('on', true); await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'📻 Autoplay is **'+(s.autoplay?'On':'Off')+'**', ephemeral:true });
  }

  if (name === 'djonly') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    if (!isDJ(interaction)) return interaction.followUp({ content: 'You must have Manage Server/Channels (or the configured DJ role) to change this.', ephemeral: true });
    const s = getOrInit(interaction.guildId);
    s.djOnly = interaction.options.getBoolean('on', true);
    await saveGuild(interaction.guildId);
    return interaction.followUp({ content: '🎛️ DJ-only controls are **' + (s.djOnly ? 'On' : 'Off') + '**', ephemeral: true });
  }

  if (name === 'playlist') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const sub = interaction.options.getSubcommand();
    const s = getOrInit(interaction.guildId);

    if (sub === 'save') {
      const plName = interaction.options.getString('name', true).trim().slice(0, 50);
      if (!plName) return interaction.followUp({ content: 'Please provide a valid playlist name.', ephemeral: true });
      const queue = [...(s.nowPlaying ? [s.nowPlaying] : []), ...s.queue];
      if (!queue.length) return interaction.followUp({ content: 'Nothing in the queue to save!', ephemeral: true });
      // Strip runtime-only fields before saving (resource, lazy spotify placeholders resolved at play time are fine to keep)
      const toSave = queue.map(t => ({ url: t.url, title: t.title, thumbnail: t.thumbnail, durationSec: t.durationSec, source: t.source, _spotifyQuery: t._spotifyQuery }));
      await savePlaylist(interaction.guildId, plName, toSave);
      return interaction.followUp({ content: `💾 Saved **${plName}** with **${toSave.length}** track(s).`, ephemeral: true });
    }

    if (sub === 'load') {
      const plName = interaction.options.getString('name', true).trim();
      const pl = await loadPlaylist(interaction.guildId, plName);
      if (!pl) return interaction.followUp({ content: `No playlist named **${plName}** found. Use \`/playlist list\` to see saved playlists.`, ephemeral: true });
      const conn = await ensureConnection(interaction);
      if (!conn) return interaction.followUp({ content: 'You must be in a voice channel to load a playlist.', ephemeral: true });
      const requestedBy = { id: interaction.user.id, tag: interaction.user.username + '#' + interaction.user.discriminator };
      const tracks = pl.tracks.map(t => ({ ...t, requestedById: requestedBy.id, requestedByTag: requestedBy.tag }));
      s.queue.push(...tracks);
      await saveGuild(interaction.guildId);
      await interaction.followUp({ content: `📂 Loaded **${plName}** — **${tracks.length}** track(s) added to queue.`, ephemeral: true });
      const ch = s.panel?.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : interaction.channel;
      if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId);
      if (s.player.state.status !== AudioPlayerStatus.Playing) await playNext(interaction.guildId, interaction.channel);
      return;
    }

    if (sub === 'delete') {
      const plName = interaction.options.getString('name', true).trim();
      const deleted = await deletePlaylist(interaction.guildId, plName);
      return interaction.followUp({ content: deleted ? `🗑️ Deleted playlist **${plName}**.` : `No playlist named **${plName}** found.`, ephemeral: true });
    }

    if (sub === 'list') {
      const all = await listPlaylists(interaction.guildId);
      const entries = Object.values(all);
      if (!entries.length) return interaction.followUp({ content: 'No saved playlists. Use `/playlist save <name>` to create one.', ephemeral: true });
      const lines = entries.map(p => {
        const date = new Date(p.savedAt).toLocaleDateString();
        return `📋 **${p.name}** — ${p.count} tracks (saved ${date})`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('💾 Saved Playlists')
        .setDescription(lines.join('\n').slice(0, 4000));
      return interaction.followUp({ embeds: [embed], ephemeral: true });
    }
  }

  if (name === 'filter') {
    if (!(await safeDeferReply(interaction, { ephemeral: true }))) return;
    const s = getOrInit(interaction.guildId);
    const filterName = interaction.options.getString('name', true);
    s.filter = filterName === 'off' ? null : filterName;
    await saveGuild(interaction.guildId);
    // Re-start current track from current position with new filter applied
    if (s.nowPlaying && s.player.state.status === AudioPlayerStatus.Playing) {
      const currentPos = Math.floor(getAccurateElapsedSec(interaction.guildId));
      s.queue.unshift(s.nowPlaying);
      s.player.stop(true);
      setTimeout(() => playNext(interaction.guildId, null, currentPos).catch(() => {}), 50);
      const label = s.filter ? ('🎛 **' + s.filter + '**') : '**off**';
      return interaction.followUp({ content: `Filter set to ${label} — restarting track at current position.`, ephemeral: true });
    }
    const label = s.filter ? ('🎛 **' + s.filter + '**') : '**off**';
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content: `Filter set to ${label}. Will apply to the next track.`, ephemeral: true });
  }

  }); // runExclusive

  } catch (e) {
    log.error('interaction.unhandled', { err: e?.message || String(e), stack: e?.stack });
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An error occurred while handling this interaction.', ephemeral: true });
      }
    } catch {}
  }
});

async function gracefulShutdown(reason, err){
  try { log.warn('shutdown.start', { reason, err: err?.message || String(err || '') }); } catch {}
  try {
    for (const [gid] of state.entries()){
      await saveGuild(gid).catch(()=>{});
      const conn = getVoiceConnection(gid);
      if (conn) { try { conn.destroy(); } catch {} }
    }
  } catch {}
  try { await client.destroy(); } catch {}
  process.exit(err ? 1 : 0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (e) => gracefulShutdown('unhandledRejection', e));
process.on('uncaughtException', (e) => gracefulShutdown('uncaughtException', e));

client.login(TOKEN);
