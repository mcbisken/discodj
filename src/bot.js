import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';





// === discodj: atomic nowPlaying apply ===
function applyNowPlaying(gid, track, seekSec = 0) {
  const s = getOrInit(gid);
  s.nowPlaying = track || s.nowPlaying || null;
  const curRes = s.player?.state?.resource || null;
  const isNewRes = curRes && curRes !== s._lastResource;
  if (curRes) s.resource = curRes;
  if (isNewRes) {
    s._lastResource = curRes;
    if (typeof __djBumpGen === 'function') s.panelGen = __djBumpGen(gid);
    else s.panelGen = (s.panelGen || 0) + 1;
    if (typeof onTrackStartTiming === 'function') onTrackStartTiming(gid, seekSec || 0);
    else { s.startedAtMs = Date.now(); s.seekBaseSec = seekSec || 0; s.pausedAtMs = 0; s.pauseHoldMs = 0; }
    s._lastHash = null; s._lastBlock = -1;
    try { __djStart && __djStart(gid, s.panelGen); } catch {}
    try { __djSafeRefresh && __djSafeRefresh(gid, s.panelGen); } catch {}
  } else {
    if (typeof onResumeTiming === 'function') onResumeTiming(gid);
    try { __djStart && __djStart(gid, s.panelGen); } catch {}
    try { __djSafeRefresh && __djSafeRefresh(gid, s.panelGen); } catch {}
  }
}
// === end discodj: atomic nowPlaying apply ===

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

const DATA_DIR = path.resolve('./data');
await fs.mkdir(DATA_DIR, { recursive: true });

/* ---- State ---- */
const YT_REGEX  = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i;
const YT_PL_REGEX = /[?&]list=([a-zA-Z0-9_-]+)/;
const SPOTIFY_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/(track|album|playlist)\/([A-Za-z0-9]+)(\?.*)?$/i;

function defaults(){ return {
  queue: [], history: [],
  player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
  connection: null, nowPlaying: null, panel: null,
  volume: 100, loop: 'off', autoplay: true, stayOnline: true,
  startedAtMs: 0, pausedAtMs: 0
};}
const state = new Map();
function getOrInit(gid){ if (!state.has(gid)) state.set(gid, defaults()); return state.get(gid); }

/* ---- Persistence ---- */
async function saveGuild(gid){
  const s = getOrInit(gid);
  const save = { queue: s.queue, history: s.history.slice(-20), volume: s.volume, loop: s.loop, autoplay: s.autoplay, stayOnline: s.stayOnline };
  await fs.writeFile(path.join(DATA_DIR, gid + '.json'), JSON.stringify(save, null, 2));
}
async function loadGuild(gid){
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, gid + '.json'), 'utf8');
    const d = JSON.parse(raw);
    const s = getOrInit(gid);
    s.queue = Array.isArray(d.queue)? d.queue : [];
    s.history = Array.isArray(d.history)? d.history : [];
    s.volume = Number.isFinite(d.volume)? d.volume : 100;
    s.loop = ['off','one','all'].includes(d.loop)? d.loop : 'off';
    s.autoplay = typeof d.autoplay === 'boolean'? d.autoplay : true;
    s.stayOnline = d.stayOnline ?? true;
  } catch {}
}

/* ---- Helpers ---- */
async function ytdlpJSON(args){
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args);
    let out='', err='';
    p.stdout.on('data', d=>out+=d);
    p.stderr.on('data', d=>err+=d);
    p.on('close', c=>{
      if (c===0) { try { resolve(JSON.parse(out)); } catch(e){ reject(e); } }
      else reject(new Error('yt-dlp failed ('+c+'): '+err));
    });
  });
}
async function ytSingleInfo(url){
  const meta = await ytdlpJSON(['-J','--no-playlist',url]).catch(()=>null);
  if (!meta) return null;
  const thumb = (meta && meta.thumbnails && meta.thumbnails.length ? meta.thumbnails.at(-1).url : undefined);
  return { url, title: (meta && meta.title) ? meta.title : url, thumbnail: (meta && meta.thumbnails && meta.thumbnails.length ? meta.thumbnails.at(-1).url : undefined), durationSec: Number(meta && meta.duration) || undefined, source:'yt' };
}
function guessThumbFromUrl(url){
  try { const v = new URL(url).searchParams.get('v'); return v?('https://i.ytimg.com/vi/'+v+'/hqdefault.jpg'):undefined; } catch { return undefined; }
}
async function ytPlaylistExpand(url, requester){
  const meta = await ytdlpJSON(['-J', url]).catch(()=>null);
  if (!meta || !meta.entries || !meta.entries.length) return [];
  const items = [];
  for (const e of meta.entries){
    if (!e) continue;
    const videoUrl = e.webpage_url || (e.url && e.url.startsWith('http') ? e.url : ('https://www.youtube.com/watch?v='+e.id));
    const thumb = (e.thumbnails && e.thumbnails.length ? e.thumbnails.at(-1).url : undefined) || guessThumbFromUrl(videoUrl);
    items.push({ url: videoUrl, title: e.title || e.fulltitle || ('Video '+e.id), thumbnail: thumb, durationSec: Number(e.duration)||undefined, requestedById: requester.id, requestedByTag: requester.tag, source:'yt' });
  }
  return items;
}
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
async function getDirectAudioUrl(ytUrl){
  return new Promise((resolve,reject)=>{
    const p = spawn('yt-dlp',['-f','bestaudio/best','-g',ytUrl]);
    let out='',err=''; p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d);
    p.on('close',c=>{ if (c===0 && out.trim()) resolve(out.trim().split('\n').pop()); else reject(new Error('yt-dlp -g failed ('+c+'): '+err)); });
  });
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
  const probed = await demuxProbe(opusOgg);
  return createAudioResource(probed.stream, { inputType: probed.type || StreamType.OggOpus, inlineVolume: true, metadata: track });
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
function currentElapsedSeconds(s){
  if (!s.nowPlaying) return 0;
  if (s.player.state.status === AudioPlayerStatus.Paused) {
    if (s.pausedAtMs && s.startedAtMs) return Math.max(0, (s.pausedAtMs - s.startedAtMs)/1000);
    if (s.startedAtMs) return Math.max(0, (Date.now() - s.startedAtMs)/1000);
    return 0;
    try { onPauseTiming(gid); } catch {}
  }
  if (s.startedAtMs) return Math.max(0, (Date.now() - s.startedAtMs)/1000);
  return 0;
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
  const id = setInterval(async () => {
    try {
      const s = getOrInit(gid);
      if (!s.nowPlaying || s.player.state.status !== AudioPlayerStatus.Playing) return;
      await refreshPanel(gid);
    } catch {}
  }, 5000);
  progressTimers.set(gid, id);
}
function stopProgressTimer(gid){
  if (progressTimers.has(gid)) { clearInterval(progressTimers.get(gid)); progressTimers.delete(gid); }
}

function buildEmbed(gid){
  const s = getOrInit(gid);
  let __elapsedFromResource = Number.isFinite(s?.resource?.playbackDuration) ? (s.resource.playbackDuration / 1000) + (s.seekBaseSec || 0) : null;
  let __prog_total = Number(s?.nowPlaying?.durationSec);
  if (!Number.isFinite(__prog_total) || __prog_total <= 0) __prog_total = NaN;
  let __elapsed = (__elapsedFromResource != null) ? __elapsedFromResource : (typeof getAccurateElapsedSec==='function' ? getAccurateElapsedSec(gid) : 0);
  if (Number.isFinite(__prog_total) && __elapsed > __prog_total) __elapsed = __prog_total;const np = s.nowPlaying;
  const emb = new EmbedBuilder().setColor(0x5865F2).setTitle(np ? '🎵 Now Playing' : 'Nothing playing').setTimestamp(new Date());
  if (np){
    if (np.thumbnail) emb.setThumbnail(np.thumbnail);
    emb.addFields({ name: 'Song', value: '['+np.title+']('+np.url+')' });
    const prog = buildProgressBar(__elapsed, __prog_total, 10);
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
  try{
    const s = getOrInit(gid);
    if (!s.panel || !s.panel.channelId) return;
    const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null);
    if (ch && ch.isTextBased()) await upsertPanel(ch, gid);
  } catch {}
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
    s.player.on(AudioPlayerStatus.Idle, () => handleTrackEnd(interaction.guildId).catch(console.error));
    s.player.on(AudioPlayerStatus.Playing, () => refreshPanel(interaction.guildId));
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
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, gid); }
    await saveGuild(gid); return;
  }
  try{
    const res = await makeResourceFromTrack(next, seekOffset||0);
    if (res.volume) res.volume.setVolume(Math.max(0, Math.min(200, s.volume))/100);
    s.player.play(res); s.nowPlaying = next; s.startedAtMs = Date.now() - ((seekOffset||0)*1000); s.pausedAtMs = 0; startProgressTimer(gid); setPresencePlaying(next.title);
    const ch = channelForPanel || (s.panel && s.panel.channelId ? await client.channels.fetch(s.panel.channelId).catch(()=>null) : null);
    if (ch && ch.isTextBased()) await upsertPanel(ch, gid);
    await saveGuild(gid);
  }catch(e){ console.error('Playback error:', e); await playNext(gid, channelForPanel); }
}

/* ---- Commands ---- */
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
  new SlashCommandBuilder().setName('play').setDescription('Play a song/playlist by URL, Spotify, or search query').addStringOption(o=>o.setName('q').setDescription('URL or search query').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show/refresh the player panel'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
  new SlashCommandBuilder().setName('prev').setDescription('Play previous song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (0–200%)').addIntegerOption(o=>o.setName('percent').setDescription('0–200').setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Seek to timestamp (e.g., 1:23 or 83)').addStringOption(o=>o.setName('time').setDescription('mm:ss or seconds').setRequired(true)),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming queue'),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode').addStringOption(o=>o.setName('mode').setDescription('off | one | all').addChoices({name:'off', value:'off'},{name:'one', value:'one'},{name:'all', value:'all'}).setRequired(true)),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle radio when queue ends').addBooleanOption(o=>o.setName('on').setDescription('true/false').setRequired(true)),
].map(c=>c.toJSON());

client.once('clientReady', async () => {
  console.log('Logged in as '+client.user.tag);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
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
    const s = getOrInit(interaction.guildId);
    const id = interaction.customId;
    if (!s.panel || interaction.message.id !== s.panel.messageId) return interaction.deferUpdate().catch(()=>{});

    if (id === 'music:prev') {
      if (!s.history.length) return interaction.deferUpdate();
      if (s.nowPlaying) s.queue.unshift(s.nowPlaying);
      const prev = s.history.pop(); s.queue.unshift(prev); s.player.stop(true); await saveGuild(interaction.guildId);
      return interaction.deferUpdate();
    }
    if (id === 'music:toggle') {
      if (s.player.state.status === AudioPlayerStatus.Playing) { s.player.pause(true); s.pausedAtMs=Date.now(); stopProgressTimer(interaction.guildId); clearPresence(); }
      else { s.player.unpause(); if (s.pausedAtMs && s.startedAtMs){ const paused = Date.now() - s.pausedAtMs; s.startedAtMs += paused; s.pausedAtMs=0; } startProgressTimer(interaction.guildId); if (s.nowPlaying) setPresencePlaying(s.nowPlaying.title); }
      const embed = buildEmbed(interaction.guildId);
      return interaction.update({ embeds:[embed], components:[buildControls(s.player.state.status === AudioPlayerStatus.Paused)] });
    try { onTrackStartTiming(gid, 0); } catch {}
    try { onResumeTiming(gid); } catch {}
    try { const s = getOrInit(gid); applyNowPlaying(gid, s.nowPlaying, s.seekBaseSec || 0); } catch {}
    }
    if (id === 'music:skip') { s.player.stop(true); return interaction.deferUpdate(); }
    if (id === 'music:stop') {
      s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(interaction.guildId); clearPresence(); await saveGuild(interaction.guildId);
      const embed = buildEmbed(interaction.guildId);
      return interaction.update({ embeds:[embed], components:[buildControls(false)] });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  if (name === 'join') {
    await interaction.deferReply({ ephemeral: true });
    const conn = await ensureConnection(interaction);
    return interaction.followUp({ content: conn ? 'Joined your voice channel. 👋' : 'You must be in a voice channel.', ephemeral: true });
  }
  if (name === 'play') {
    await interaction.deferReply();
    const conn = await ensureConnection(interaction);
    if (!conn) return interaction.followUp('You must be in a voice channel.');
    const q = interaction.options.getString('q', true);
    const requestedBy = { id: interaction.user.id, tag: interaction.user.username + '#' + interaction.user.discriminator };
    let tracks = await buildTracksFromInput(q, requestedBy);
    if (!tracks.length) return interaction.followUp('No results. Try another query or a different URL.');
    const s = getOrInit(interaction.guildId);
    s.queue.push(...tracks); await saveGuild(interaction.guildId);
    await upsertPanel(interaction.channel, interaction.guildId);
    if (s.player.state.status !== AudioPlayerStatus.Playing) {
      const __playingMsg = await interaction.followUp('▶️ Playing: **'+tracks[0].title+'**'+(tracks.length>1?(' (+'+(tracks.length-1)+' more from playlist)') : ''));
setTimeout(async () => {
  try {
    if (!__playingMsg?.flags?.has?.(MessageFlags.Ephemeral)) { await __playingMsg.delete().catch(() => {}); }
  } catch {}
}, 10_000);
setTimeout(async () => {
  try {
    if (!__playingMsg?.flags?.has?.(MessageFlags.Ephemeral)) { await __playingMsg.delete().catch(() => {}); }
  } catch {}
}, 10_000);
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
    await interaction.deferReply();
    await upsertPanel(interaction.channel, interaction.guildId);
    return interaction.followUp('Player panel updated ↓');
  }
  if (name === 'skip') {
    await interaction.deferReply();
    const s = getOrInit(interaction.guildId);
    if (s.player.state.status !== AudioPlayerStatus.Playing) return interaction.followUp('Nothing is playing.');
    s.player.stop(true); return interaction.followUp('⏭️ Skipped.');
  }
  if (name === 'prev') {
    await interaction.deferReply();
    const s = getOrInit(interaction.guildId);
    if (!s.history.length && !s.nowPlaying) return interaction.followUp('No previous track.');
    if (s.nowPlaying) s.queue.unshift(s.nowPlaying); const prev = s.history.pop(); s.queue.unshift(prev); s.player.stop(true); await saveGuild(interaction.guildId);
    return interaction.followUp('⏮️ Previous track.');
  }
  if (name === 'stop') {
    await interaction.deferReply();
    const s = getOrInit(interaction.guildId);
    s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(interaction.guildId); clearPresence(); await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp('⏹️ Stopped and cleared the queue.');
  }
  if (name === 'leave') {  try {
    const s = getOrInit(interaction?.guildId || guildId || gid);
    if (s?.panel) { await s.panel.delete().catch(()=>{}); s.panel = null; }
  } catch {}

    await interaction.deferReply();
    const s = getOrInit(interaction.guildId); const conn = getVoiceConnection(interaction.guildId);
    s.queue=[]; s.player.stop(true); s.nowPlaying=null; s.startedAtMs=0; s.pausedAtMs=0; stopProgressTimer(interaction.guildId); clearPresence();
    if (conn) conn.destroy(); s.connection=null;
    await saveGuild(interaction.guildId);
    return interaction.followUp('👋 Left the channel.');
  }
  if (name === 'volume') {
    await interaction.deferReply({ ephemeral: true });
    const s = getOrInit(interaction.guildId);
    const percent = Math.max(0, Math.min(200, interaction.options.getInteger('percent', true)));
    s.volume = percent; if (s.player.state.status === AudioPlayerStatus.Playing && s.player.state.resource && s.player.state.resource.volume) s.player.state.resource.volume.setVolume(percent/100);
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'🔊 Volume set to **'+percent+'%**', ephemeral:true });
  }
  if (name === 'seek') {
    await interaction.deferReply();
    const s = getOrInit(interaction.guildId);
    if (!s.nowPlaying) return interaction.followUp('Nothing is playing.');
    const t = interaction.options.getString('time', true).trim();
    const parts = t.split(':').map(n=>parseInt(n,10)).filter(n=>!isNaN(n));
    const seconds = parts.length===1? parts[0] : (parts.length===2? (parts[0]*60+parts[1]) : (parts[0]*3600+parts[1]*60+parts[2]));
    if (!Number.isFinite(seconds) || seconds<0) return interaction.followUp('Invalid time. Use `mm:ss` or seconds.');
    s.queue.unshift(s.nowPlaying); s.player.stop(true); await interaction.followUp('⏩ Seeking to **'+seconds+'**s...');
    setTimeout(()=> playNext(interaction.guildId, null, seconds).catch(console.error), 50);
  }
  if (name === 'shuffle') {
    await interaction.deferReply(); const s = getOrInit(interaction.guildId);
    if (s.queue.length<2) return interaction.followUp('Not enough items to shuffle.');
    for (let i=s.queue.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const tmp=s.queue[i]; s.queue[i]=s.queue[j]; s.queue[j]=tmp; }
    await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp('🔀 Shuffled the queue.');
  }
  if (name === 'loop') {
    await interaction.deferReply({ ephemeral: true });
    const s = getOrInit(interaction.guildId);
    const mode = interaction.options.getString('mode', true);
    s.loop = mode; await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'🔁 Loop set to **'+mode+'**', ephemeral:true });
  }
  if (name === 'autoplay') {
    await interaction.deferReply({ ephemeral: true });
    const s = getOrInit(interaction.guildId);
    s.autoplay = interaction.options.getBoolean('on', true); await saveGuild(interaction.guildId);
    if (s.panel && s.panel.channelId){ const ch = await client.channels.fetch(s.panel.channelId).catch(()=>null); if (ch && ch.isTextBased()) await upsertPanel(ch, interaction.guildId); }
    return interaction.followUp({ content:'📻 Autoplay is **'+(s.autoplay?'On':'Off')+'**', ephemeral:true });
  }
});

client.login(TOKEN);
