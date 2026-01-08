import 'dotenv/config';
import { spawn } from 'node:child_process';

import { createLogger } from './logger.js';
import { runExclusive } from './locks.js';
import { DATA_DIR, getOrInit, initDataDir, loadGuild, saveGuild, state } from './state.js';
import { ytdlpJSON, ytSingleInfo, ytPlaylistExpand, guessThumbFromUrl } from './utils/ytdlp.js';

const log = createLogger({ service: 'discodj' });


// === Preflight: check external binaries ===
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
preflightBinaries().catch(()=>{});

// === embed edit single-flight + payload de-dupe (non-visual changes) ===
const editLocks = new Map();
const lastPayloadHash = new Map();
function composePanel(gid){
  const s = getOrInit(gid);
  const isPaused = s.player?.state?.status === AudioPlayerStatus.Paused;
  return { embeds:[buildEmbed(gid)], components:[buildControls(isPaused)] };
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
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';



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

import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, NoSubscriberBehavior, demuxProbe, StreamType
} from '@discordjs/voice';

import yts from 'youtube-search-api';
import spotifyUrlInfo from 'spotify-url-info';

/* ---- Setup ---- */
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
if (!TOKEN || !GUILD_ID) { console.error('Missing DISCORD_TOKEN or GUILD_ID'); process.exit(1); }

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
const YT_PL_REGEX = /[?&]list=([a-zA-Z0-9_-]+)/;
const SPOTIFY_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/(track|album|playlist)\/([A-Za-z0-9]+)(\?.*)?$/i;

// State, persistence and yt-dlp helpers are in ./state.js and ./utils/ytdlp.js
async function searchYoutubeFirst(q){
  const res = await yts.GetListByKeyword(q, false, 6);
  const item = res && res.items ? res.items.find(i => i.type==='video' || (i.id && i.id.kind==='youtube#video')) : null;
  if (!item) return null;
  const id = item.id || (item.id && item.id.videoId);
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
      return hit ? [await (async () => { const m = await ytSingleInfo(hit.url).catch(()=>null); const obj = { url: (m?.url || hit.url), title: (m?.title || hit.title || q), thumbnail: (m?.thumbnail || hit.thumbnail), durationSec: (m?.durationSec) }; return asTrackFromUrlTitle(obj, requester, 'sp'); })()] : [];
    }
    if (data && (data.type === 'album' || data.type === 'playlist')) {
      const trs = await getTracks(url);
      const out = [];
      for (const t of (trs||[]).slice(0,100)){
        const title = t && t.name ? t.name : '';
        const artists = Array.isArray(t && t.artists) ? t.artists.map(a=>a.name).filter(Boolean) : [];
        const q = [title, artists.join(' ')].filter(Boolean).join(' ');
        if (!q) continue;
        const hit = await searchYoutubeFirst(q);
        if (hit) out.push(await (async () => { const m = await ytSingleInfo(hit.url).catch(()=>null); const obj = { url: (m?.url || hit.url), title: (m?.title || hit.title || q), thumbnail: (m?.thumbnail || hit.thumbnail), durationSec: (m?.durationSec) }; return asTrackFromUrlTitle(obj, requester, 'sp'); })());
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
  if (YT_REGEX.test(q) && YT_PL_REGEX.test(q)) return await ytPlaylistExpand(q, requester);
  if (YT_REGEX.test(q)) { const info = await ytSingleInfo(q); return info? [{...info, requestedById: requester.id, requestedByTag: requester.tag}] : []; }
  if (SPOTIFY_REGEX.test(q)) return await resolveSpotifyToTracks(q, requester);
  const hit = await searchYoutubeFirst(q);
  return hit? [asTrackFromUrlTitle(hit, requester, 'yt')] : [];
}

/* ---- Audio ---- */
const directUrlCache = new Map(); // ytUrl -> { value, exp }
async function getDirectAudioUrl(ytUrl){
  const cached = directUrlCache.get(ytUrl);
  if (cached && Date.now() < cached.exp) return cached.value;

  const runOnce = () => new Promise((resolve,reject)=>{
    const p = spawn('yt-dlp',['-f','bestaudio/best','-g',ytUrl]);
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
      directUrlCache.set(ytUrl, { value: url, exp: Date.now() + 5*60*1000 });
      return url;
    } catch (e){
      last = e;
      if (i===0) await new Promise(r=>setTimeout(r, 500));
    }
  }
  throw last;
}
function ffmpegOggOpusStream(mediaUrl, offsetSec){
  const ss = Math.max(0, Math.floor(offsetSec||0));
  const args = (ss?['-ss',String(ss)]:[]).concat(['-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',mediaUrl,'-vn','-ac','2','-ar','48000','-c:a','libopus','-b:a','160k','-f','ogg','pipe:1']);
  const ff = spawn('ffmpeg', args, { stdio: ['ignore','pipe','ignore'] });
  return ff.stdout;
}
async function makeResourceFromTrack(track, offsetSec){
  const direct = await getDirectAudioUrl(track.url);
  const opusOgg = ffmpegOggOpusStream(direct, offsetSec||0);
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
    new ButtonBuilder().setCustomId('music:prev').setStyle(ButtonStyle.Secondary).setLabel('Prev'),
    new ButtonBuilder().setCustomId('music:toggle').setStyle(ButtonStyle.Primary).setLabel(isPaused?'Resume':'Pause'),
    new ButtonBuilder().setCustomId('music:skip').setStyle(ButtonStyle.Secondary).setLabel('Skip'),
    new ButtonBuilder().setCustomId('music:stop').setStyle(ButtonStyle.Danger).setLabel('Stop')
  );
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
function buildNextUpPreview(s){
const up = (s.queue || []).slice(0, 5);
  if (!up.length) return '— empty —';
  const lines = [];
  for (let i = 0; i < up.length; i++) {
    const t = up[i] || {};
    const safeTitle = t.title || 'Unknown';
    const safeUrl = t.url || '';
    const dur = (typeof t.durationSec === 'number' && Number.isFinite(t.durationSec)) ? ` • ${formatTime(t.durationSec)}` : '';
    lines.push(`${i + 1}. [${safeTitle}](${safeUrl})${dur}`);
  }
  return lines.join('\n');

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

function buildEmbed(gid){
  const __prog = getProgressObj(gid);
  const __elapsed = __prog.elapsed;
  const __total = __prog.total;

  const s = getOrInit(gid);
  const np = s.nowPlaying;
  const emb = new EmbedBuilder().setColor(0x5865F2).setTitle(np ? '🎵   Now playing:' : 'Nothing playing').setTimestamp(new Date());
  if (np){
    if (np.thumbnail) emb.setThumbnail(np.thumbnail);
    emb.addFields({ name: '\u200B', value: '['+np.title+']('+np.url+')' });
    const prog = buildProgressBar(__elapsed, __total, 10);
    if (prog) emb.addFields({ name: 'Progress', value: prog });
    emb.addFields(
      { name: 'Requested by', value: '<@'+np.requestedById+'>', inline: true },
      { name: 'Duration', value: (Number.isFinite(np?.durationSec) ? formatTime(np.durationSec) : 'Unknown'), inline: true },
      { name: 'Autoplay', value: (s.autoplay ? 'On' : 'Off'), inline: true }
    );
  }
  emb.addFields({ name: 'Up next: (top 5)', value: buildNextUpPreview(s) });
  return emb;
}
async function upsertPanel(channel, gid){
  const s = getOrInit(gid);
  const isPaused = s.player.state.status === AudioPlayerStatus.Paused;
  const embed = buildEmbed(gid);
  const components = [buildControls(isPaused)];
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
      const rel = await ytdlpJSON(['-J','--flat-playlist','--skip-download','--', finished.url]);
      const entries = rel && rel.entries ? rel.entries : [];
      const related = entries.find(e=>e.id && e.url && e.url.indexOf('watch')>=0);
      if (related){
        s.queue.push({ url: related.url, title: related.title || ('Video '+related.id), thumbnail: guessThumbFromUrl(related.url), durationSec: undefined, requestedById: client.user.id, requestedByTag: client.user.tag, source:'yt' });
      }
    }catch{}
  }
  await playNext(gid);
}
async function playNext(gid, channelForPanel, seekOffset){
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
    const res = await makeResourceFromTrack(next, seekOffset || 0);
    if (res.volume) res.volume.setVolume(Math.max(0, Math.min(200, s.volume))/100);

    s.nowPlaying = next;
    s.player.play(res);

    onTrackStartTiming(gid, seekOffset || 0);
    queueRefresh(gid, { immediate:true });
    startProgressTimer(gid);
    setPresencePlaying(next.title);

    const ch = channelForPanel || (s.panel && s.panel.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : null);
    if (ch && ch.isTextBased()) await upsertPanel(ch, gid);

    await saveGuild(gid);
  }catch(e){
    console.error('Playback error:', e);
    await playNext(gid, channelForPanel);
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
  new SlashCommandBuilder().setName('remove').setDescription('Remove a queued song by position').addIntegerOption(o=>o.setName('index').setDescription('1-based queue position').setRequired(true)),
  new SlashCommandBuilder().setName('move').setDescription('Move a queued song').addIntegerOption(o=>o.setName('from').setDescription('1-based position').setRequired(true)).addIntegerOption(o=>o.setName('to').setDescription('1-based position').setRequired(true)),
  new SlashCommandBuilder().setName('jump').setDescription('Jump to a queued song now').addIntegerOption(o=>o.setName('index').setDescription('1-based queue position').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the upcoming queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing track'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o=>o.setName('mode').setDescription('off | one | all').addChoices({name:'off', value:'off'},{name:'one', value:'one'},{name:'all', value:'all'}).setRequired(true)),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle radio when queue ends').addBooleanOption(o=>o.setName('on').setDescription('true/false').setRequired(true)),
  new SlashCommandBuilder().setName('djonly').setDescription('Restrict controls to DJs/Admins').addBooleanOption(o=>o.setName('on').setDescription('true/false').setRequired(true)),
].map(c=>c.toJSON());

// discord.js v14+ deprecates 'ready' in favor of 'clientReady'
client.once('clientReady', async () => {
  log.info('startup.ready', { userTag: client.user?.tag });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  log.info('startup.commands_registered', { guildId: GUILD_ID });
  clearPresence();
  await loadGuild(GUILD_ID).catch(()=>{});
});

/* ---- Events ---- */
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild; if (!guild) return;
  const s = getOrInit(guild.id);
  const conn = getVoiceConnection(guild.id); if (!conn) return;
  const me = guild.members.me; const channelId = me && me.voice ? me.voice.channelId : null; if (!channelId) return;
  const channel = guild.channels.cache.get(channelId); if (!channel || !('members' in channel)) return;
  const humans = channel.members.filter(m => !m.user.bot).size;
  if (humans === 0) { try { conn.destroy(); } catch {}; s.connection = null; stopProgressTimer(guild.id); clearPresence(); }
});

client.on('interactionCreate', async (interaction) => {
  try {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      const q = String(interaction.options.getFocused() || '').trim();
      if (!q || /^https?:\/\//i.test(q)) return interaction.respond([]);
      try {
        const res = await yts.GetListByKeyword(q, false, 6);
        const videos = (res && res.items ? res.items : []).filter(i => i.type === 'video').slice(0, 5);
        const choices = videos.map(v => {
          const id = v.id || (v.id && v.id.videoId);
          const url = v.url || (id ? ('https://www.youtube.com/watch?v='+id) : null);
          const name = (v.title || 'Unknown title').slice(0, 100);
          return { name, value: url || name };
        });
        return interaction.respond(choices);
      } catch { return interaction.respond([]); }
    }
    return;
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
        const embed = buildEmbed(interaction.guildId);
        return interaction.update({ embeds:[embed], components:[buildControls(s.player.state.status === AudioPlayerStatus.Paused)] });
      }

      if (id === 'music:skip') { s.player.stop(true); await safeDeferUpdate(interaction); return; }

      if (id === 'music:stop') {
        s.queue=[]; s.player.stop(true); s.nowPlaying=null; onTrackStartTiming(interaction.guildId, 0); stopProgressTimer(interaction.guildId); clearPresence();
        await saveGuild(interaction.guildId);
        const embed = buildEmbed(interaction.guildId);
        return interaction.update({ embeds:[embed], components:[buildControls(false)] });
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
    const position = interaction.options.getString('position') || 'end';
    if (position === 'next' || position === 'top') s.queue.splice(0, 0, ...tracks);
    else s.queue.push(...tracks);
    await saveGuild(interaction.guildId);
    await upsertPanel(interaction.channel, interaction.guildId);
    if (s.player.state.status !== AudioPlayerStatus.Playing) {
      const __playingMsg = await interaction.followUp('▶️ Playing: **'+tracks[0].title+'**'+(tracks.length>1?(' (+'+(tracks.length-1)+' more from playlist)') : ''));
setTimeout(async () => {
  try {
    if (!__playingMsg?.flags?.has?.(MessageFlags.Ephemeral)) { await __playingMsg.delete().catch(() => {}); }
  } catch {}
}, 10_000);
      log.info('play.start', { guildId: interaction.guildId, userId: interaction.user.id, count: tracks.length, position });
      await playNext(interaction.guildId, interaction.channel);
    } else {
      const __queuedMsg = await interaction.followUp('➕ Queued: **'+tracks[0].title+'**'+(tracks.length>1?(' (+'+(tracks.length-1)+' more)') : ''));
setTimeout(async () => {
  try {
    if (!__queuedMsg?.flags?.has?.(MessageFlags.Ephemeral)) { await __queuedMsg.delete().catch(() => {}); }
  } catch {}
}, 10_000);
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
    const idx = (interaction.options.getInteger('index', true) || 0) - 1;
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
    const from = (interaction.options.getInteger('from', true) || 0) - 1;
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
    const idx = (interaction.options.getInteger('index', true) || 0) - 1;
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
