// One GuildPlayer per server: queue, history, voice connection and the playback engine.
//
// Every track change funnels through _start(), guarded by a generation counter (`gen`): if a newer
// transition starts while an older one is still loading, the older one quietly gives up. That's
// what makes rapid skips, seeks, filter changes and natural track endings race-free.
import {
  AudioPlayerStatus, createAudioPlayer, entersState, getVoiceConnection, joinVoiceChannel,
  NoSubscriberBehavior, VoiceConnectionStatus
} from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { config } from '../config.js';
import { UserError } from '../errors.js';
import { log } from '../logger.js';
import { resolveArtwork } from '../sources/artwork.js';
import { pickAutoplayTrack } from '../sources/autoplay.js';
import { findLyrics } from '../sources/lyrics.js';
import { getMusicSegments } from '../sources/sponsorblock.js';
import { resolveSpotifyPlaceholder } from '../sources/spotify.js';
import { persistTrack, songFingerprint, trackKey, youtubeId } from '../sources/track.js';
import { getStreamInfo, invalidateStreamInfo } from '../sources/ytdlp.js';
import { debounced } from '../store/json.js';
import { defaultSettings, saveGuildDoc } from '../store/guildStore.js';
import { recordPlay } from '../store/stats.js';
import { notice } from '../ui/messages.js';
import { PanelController } from '../ui/panelController.js';
import { createAudio } from './audio.js';
import { buildFilterChain, effectiveAudio, effectiveSpeed, sanitizeFilters, toggleFilter } from './filters.js';

const MAX_HISTORY = 50;
const MAX_FAIL_STREAK = 5;

// Everything that changes how the audio is rendered (and therefore needs a stream restart).
function audioSettingsKey(settings){
  const s = effectiveAudio(settings);
  return JSON.stringify({ filters: s.filters, speed: s.speed, pitch: s.pitch, normalize: s.normalize });
}

function shuffleInPlace(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class GuildPlayer {
  constructor(manager, guildId){
    this.manager = manager;
    this.client = manager.client;
    this.guildId = guildId;
    this.log = log.child({ guildId });

    this.settings = defaultSettings();
    this.queue = [];
    this.history = [];
    this.current = null;    // the track playing — or loading, when this.loading is true
    this.loading = false;
    this.audio = null;      // { resource, kill, info }
    this.seekBase = 0;      // source position (sec) the current stream started at
    this.speedAtStart = 1;  // effective speed of the current stream (filters change it)
    this.gen = 0;
    this.failStreak = 0;
    this.recoveries = 0;
    this.pausedBy = null;   // 'user' | 'alone' | null
    this._pauseOnStart = null; // pause again as soon as the next stream starts (see _onPlayerState)
    this.skipVotes = new Set();
    this.segments = [];     // SponsorBlock segments for the current track
    this.lastSponsorSkip = null;
    this.lyrics = null;     // { trackId, data } — used by live lyrics
    this.artwork = null;    // { trackId, url }
    this.session = null;    // saved session loaded from disk (resume after restart)
    this.timers = {};
    this.shuttingDown = false;
    this.destroyed = false;
    this._attachedConn = null;
    this._streamError = null;
    this._voiceStatusKey = null;

    this.panel = new PanelController(this);
    this.saver = debounced(() => this.saveNow(), 1500);
    this._createAudio = manager.createAudio || createAudio; // swappable in tests

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.player.on('stateChange', (o, n) => this._onPlayerState(o, n));
    this.player.on('error', e => {
      this._streamError = e;
      this.log.warn('player.stream_error', { title: this.current?.title, err: e });
    });
  }

  /* ---------------- getters ---------------- */
  get guild(){ return this.client.guilds.cache.get(this.guildId) || null; }
  get connection(){ return getVoiceConnection(this.guildId) || null; }
  get voiceChannelId(){ return this.guild?.members.me?.voice?.channelId || this.connection?.joinConfig.channelId || null; }
  get voiceChannel(){ const id = this.voiceChannelId; return id ? this.guild?.channels.cache.get(id) || null : null; }
  get isPaused(){ const s = this.player.state.status; return s === AudioPlayerStatus.Paused || s === AudioPlayerStatus.AutoPaused; }
  get isActive(){ return !!this.current || this.loading; }

  listeners(){
    const ch = this.voiceChannel;
    if (!ch?.members) return [];
    return [...ch.members.values()].filter(m => !m.user.bot);
  }

  // Current position in the *source* (accounts for seeks and speed-changing filters).
  elapsed(){
    if (!this.current) return 0;
    const r = this.audio?.resource;
    if (!r) return this.seekBase;
    return this.seekBase + (r.playbackDuration / 1000) * this.speedAtStart;
  }

  // Seconds of real time until queue[index] starts (null if unknown).
  etaFor(index){
    const speed = effectiveSpeed(effectiveAudio(this.settings)) || 1;
    let sec = 0;
    if (this.current){
      if (!this.current.duration || this.current.isLive) return null;
      sec += Math.max(0, this.current.duration - this.elapsed());
    }
    for (let i = 0; i < index; i++){
      const d = this.queue[i]?.duration;
      if (!d) return null;
      sec += d;
    }
    return sec / speed;
  }

  /* ---------------- persistence ---------------- */
  hydrate(doc){
    this.settings = { ...defaultSettings(), ...doc.settings };
    this.queue = doc.queue || [];
    this.history = doc.history || [];
    this.panel.ref = doc.panel || null;
    this.session = doc.session || null;
  }

  serialize(){
    const session = this.current && this.voiceChannelId ? {
      voiceChannelId: this.voiceChannelId,
      current: persistTrack(this.current),
      position: Math.floor(this.elapsed()),
      paused: this.pausedBy === 'user',
      savedAt: Date.now()
    } : null;
    return {
      settings: this.settings,
      queue: this.queue.map(persistTrack),
      history: this.history.slice(-MAX_HISTORY).map(persistTrack),
      panel: this.panel.ref,
      session
    };
  }

  save(){ if (!this.destroyed) this.saver.schedule(); }
  saveNow(){ return saveGuildDoc(this.guildId, this.serialize()); }

  /* ---------------- voice connection ---------------- */
  async connect(channel){
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)){
      throw new UserError(`I don't have permission to join ${channel}.`);
    }
    if (channel.type !== ChannelType.GuildStageVoice && !perms.has(PermissionFlagsBits.Speak)){
      throw new UserError(`I can join ${channel}, but I'm not allowed to speak there.`);
    }
    if (channel.full && this.voiceChannelId !== channel.id && !perms.has(PermissionFlagsBits.MoveMembers)){
      throw new UserError(`${channel} is full.`);
    }

    const existing = this.connection;
    if (existing && existing.joinConfig.channelId === channel.id && existing.state.status === VoiceConnectionStatus.Ready){
      return existing;
    }
    // Moving channels: clear the status we set on the old one (we can't once we've left).
    if (existing && this.voiceChannelId && this.voiceChannelId !== channel.id) await this.setVoiceStatus('').catch(() => {});
    const conn = joinVoiceChannel({ channelId: channel.id, guildId: this.guildId, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    this._attachConnection(conn);
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      try { conn.destroy(); } catch {}
      throw new UserError(`I couldn't connect to ${channel}. Try again in a moment.`);
    }
    if (channel.type === ChannelType.GuildStageVoice){
      await me.voice.setSuppressed(false).catch(() => me.voice.setRequestToSpeak(true).catch(() => {}));
    }
    this._clearTimer('idle');
    if (!this.isActive) this._armIdleTimer();
    this._voiceStatusKey = null;
    this.updateVoiceStatus();
    this.log.info('voice.connected', { channelId: channel.id });
    return conn;
  }

  _attachConnection(conn){
    if (this._attachedConn === conn) return;
    this._attachedConn = conn;
    conn.subscribe(this.player);
    conn.on('error', e => this.log.warn('voice.error', { err: e }));
    conn.on('stateChange', async (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected){
        // Either we were moved (Discord will reconnect us) or kicked (it won't). Give it 5s to tell.
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
          ]);
        } catch {
          if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed){
        if (this._attachedConn === conn) this._attachedConn = null;
        this._onDisconnected();
      }
    });
  }

  async disconnect(){
    await this.setVoiceStatus('').catch(() => {});
    const conn = this.connection;
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  }

  _onDisconnected(){
    for (const name of ['alone', 'aloneDebounce', 'idle', 'sponsor']) this._clearTimer(name);
    if (this.shuttingDown || this.destroyed) return;
    this.log.info('voice.disconnected', { hadTrack: !!this.current });
    // Kicked or timed out mid-song: put the song back so "▶ Play queue" picks up where we were.
    if (this.current) this.queue.unshift(this.current);
    this.gen++;
    this.loading = false;
    this.current = null;
    this.pausedBy = null;
    this._pauseOnStart = null;
    this._killAudio();
    this.player.stop(true);
    this._voiceStatusKey = null;
    this.panel.stopTicker();
    this.panel.refresh({ immediate: true });
    this.manager.updatePresence();
    this.save();
  }

  /* ---------------- player events ---------------- */
  _onPlayerState(oldState, newState){
    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle){
      this._onIdle(oldState.resource);
    } else if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing){
      // A seek/filter change/restore happened while paused: stay paused now that the new stream is live.
      // (AudioPlayer.pause() only works once it's Playing, which is why this waits until here.)
      if (this._pauseOnStart){
        const by = this._pauseOnStart;
        this._pauseOnStart = null;
        if (this.player.pause(true)){ this.pausedBy = by; return; }
      }
      this._scheduleSponsorSkip();
      this.panel.startTicker();
      this.panel.refresh();
      this.manager.updatePresence();
    } else if (newState.status === AudioPlayerStatus.Paused || newState.status === AudioPlayerStatus.AutoPaused){
      this._clearTimer('sponsor');
      this.panel.refresh();
      this.manager.updatePresence();
    }
  }

  _onIdle(endedResource){
    if (this.loading || this.destroyed || !this.current) return;
    if (!this.audio || endedResource !== this.audio.resource) return;
    const track = this.current;
    const pos = this.elapsed();
    const err = this._streamError;
    this._streamError = null;

    // The stream died before the song was over (expired URL, network blip…) → resume where it stopped.
    if (!track.isLive && track.duration && pos < track.duration - 8 && this.recoveries < 2){
      this.recoveries++;
      this.log.warn('player.ended_early', { title: track.title, pos: Math.round(pos), duration: track.duration, err: err?.message });
      invalidateStreamInfo(track.url);
      this._start(track, pos, { recovering: true });
      return;
    }
    this.advance(err ? 'error' : 'ended');
  }

  /* ---------------- core transitions ---------------- */
  // reason: 'start' | 'ended' | 'skip' | 'error' (died mid-song) | 'failed' (never started)
  async advance(reason = 'ended'){
    const prev = this.current;
    this._clearTimer('sponsor');
    if (prev){
      this._recordPlay(prev);
      if (reason === 'ended' && this.settings.loop === 'one') return this._start(prev, 0);
      if (reason !== 'failed'){
        this._pushHistory(prev);
        if (this.settings.loop === 'all') this.queue.push(prev);
      }
    }

    let next = this.queue.shift();
    // After a failure, keep autoplay going only if the failed track was itself an autoplay pick
    // (e.g. an age-restricted Mix entry). failStreak still caps runaway loops.
    const autoplayAllowed = reason !== 'failed' || prev?.requester?.auto;
    if (!next && prev && this.settings.autoplay && autoplayAllowed){
      const gen = ++this.gen;
      this._killAudio();
      this.player.stop(true);
      this.current = null;
      this.loading = true;
      this.panel.refresh();
      const seed = reason === 'failed' ? (this.history.at(-1) || prev) : prev;
      const recent = [...this.history.slice(-30), ...this.queue, prev];
      const pick = await pickAutoplayTrack(seed, recent);
      if (gen !== this.gen) return;
      this.loading = false;
      // Someone may have queued something while we were looking — that wins.
      next = this.queue.shift() || (pick ? { ...pick, requester: { id: this.client.user.id, name: 'Autoplay', auto: true } } : null);
    }
    if (!next) return this._becomeIdle();
    return this._start(next, next.startAt || 0);
  }

  async _start(track, offset = 0, { recovering = false, keepAudio = false, startPaused = null } = {}){
    const gen = ++this.gen;
    const newPlay = this.current !== track || (offset === 0 && !keepAudio && !recovering);
    this.loading = true;
    this.current = track;
    this._pauseOnStart = null;
    // keepAudio (seek/filter change): keep the current pause state, so a paused song stays paused.
    if (!keepAudio) this.pausedBy = startPaused || null;
    if (newPlay){
      this.skipVotes.clear();
      this.segments = [];
      this.lastSponsorSkip = null;
      track._counted = false;
      if (!recovering) this.recoveries = 0;
    }
    if (!keepAudio){
      this._killAudio();
      this.player.stop(true);
      this.seekBase = offset;
    }
    delete track.startAt;
    this._clearTimer('idle');
    this._clearTimer('sponsor');
    this.panel.refresh();

    try {
      if (!track.url && track.query) await resolveSpotifyPlaceholder(track);
      if (gen !== this.gen) return;

      const ytId = youtubeId(track.url);
      const segmentsP = this.settings.sponsorblock && ytId && !track.isLive ? getMusicSegments(ytId) : Promise.resolve([]);
      if (offset === 0 && this.settings.sponsorblock && ytId){
        // If the video opens with a non-music intro, start right after it (don't wait long for the API).
        const segs = await Promise.race([segmentsP, new Promise(r => setTimeout(() => r([]), 1500))]);
        if (segs[0] && segs[0][0] < 1.5){
          offset = segs[0][1];
          this.lastSponsorSkip = { at: Date.now(), sec: segs[0][1] - segs[0][0] };
        }
      }
      if (gen !== this.gen) return;

      // Build the filter chain and the speed used for timing from one snapshot, so they always match.
      const snap = audioSettingsKey(this.settings);
      const audio = await this._createAudio(track, { offset, filterChain: buildFilterChain(effectiveAudio(this.settings)) });
      if (gen !== this.gen){ audio.kill(); return; }

      this._applyInfo(track, audio.info);
      const old = this.audio;
      this.audio = audio;
      this.seekBase = audio.info.isLive ? 0 : offset;
      this.speedAtStart = effectiveSpeed(JSON.parse(snap));
      audio.resource.volume?.setVolume(this.settings.volume / 100);
      // Read the pause intent now, not at the start: the user may have toggled it during the load.
      const pauseWhenLive = this._pauseOnStart || this.pausedBy;
      this.loading = false;
      this.failStreak = 0;
      this.pausedBy = null;
      this._pauseOnStart = pauseWhenLive;
      this.player.play(audio.resource);
      old?.kill();
      // Filters/speed changed while we were loading → apply them now.
      if (audioSettingsKey(this.settings) !== snap) setImmediate(() => { if (gen === this.gen) this.restartCurrent().catch(() => {}); });

      segmentsP.then(segs => {
        if (gen !== this.gen) return;
        this.segments = segs;
        this._scheduleSponsorSkip();
      });
      if (newPlay) this._onNewTrack(track, gen);
      this.panel.refresh({ immediate: true });
      this.panel.startTicker();
      this.manager.updatePresence();
      this.updateVoiceStatus();
      this.save();
      this._schedulePrefetch(4000);
    } catch (e){
      if (gen !== this.gen) return;
      this.loading = false;
      const reason = e instanceof UserError ? e.message : 'playback failed';
      if (keepAudio && this.audio){
        this.log.warn('player.restart_failed', { title: track.title, err: e });
        // The old stream ran out while we were trying, so move on rather than sit there silently.
        if (this.player.state.status === AudioPlayerStatus.Idle) return this.advance('error');
        // Otherwise the song is still playing, so keep it.
        this.notify('warn', `Couldn't jump to that spot: ${reason}`);
        this.panel.refresh();
        return;
      }
      this.failStreak++;
      this.log.warn('player.track_failed', { title: track.title, url: track.url, streak: this.failStreak, err: e });
      if (this.failStreak >= MAX_FAIL_STREAK){
        this.failStreak = 0;
        this.notify('warn', `${MAX_FAIL_STREAK} tracks in a row failed to play, so I stopped. YouTube might be blocking the bot. Check the logs, or try again in a bit.`);
        this.current = null;
        return this._becomeIdle();
      }
      this.notify('warn', `Couldn't play **${track.title.slice(0, 80)}**: ${reason} Skipping it.`);
      return this.advance('failed');
    }
  }

  _applyInfo(track, info){
    if (!info) return;
    if (track.source !== 'spotify' && info.title) track.title = info.title;
    track.duration = info.duration || track.duration;
    track.author = track.author || info.author;
    if (info.thumbnail && !track.spotify) track.thumbnail = info.thumbnail;
    track.isLive = info.isLive;
    if (info.meta) track.meta = info.meta;
  }

  _onNewTrack(track, gen){
    this.panel.bump().catch(() => {});
    resolveArtwork(track).then(url => {
      if (gen !== this.gen || !url) return;
      this.artwork = { trackId: track.id, url };
      this.panel.refresh();
    }).catch(() => {});
    if (this.settings.liveLyrics) this.loadLyrics(track).catch(() => {});
  }

  _becomeIdle(){
    this.gen++;
    this.current = null;
    this.loading = false;
    this.pausedBy = null;
    this._pauseOnStart = null;
    this.seekBase = 0;
    this._killAudio();
    this.player.stop(true);
    this._clearTimer('sponsor');
    this.panel.stopTicker();
    this.panel.refresh({ immediate: true });
    this.manager.updatePresence();
    this.updateVoiceStatus();
    this.save();
    this._armIdleTimer();
  }

  _killAudio(){
    if (this.audio){
      this.audio.kill();
      this.audio = null;
    }
  }

  _pushHistory(track){
    this.history.push(track);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  _recordPlay(track){
    if (track._counted) return;
    const played = this.elapsed();
    const threshold = Math.min(30, (track.duration || 60) * 0.5);
    if (played >= threshold){
      track._counted = true;
      recordPlay(this.guildId, track, played).catch(() => {});
    }
  }

  /* ---------------- public controls ---------------- */
  // Returns { added, truncated, index } — index is the 0-based queue position of the first added track.
  enqueue(tracks, position = 'end'){
    const room = config.maxQueue - this.queue.length;
    if (room <= 0) throw new UserError(`The queue is full (${config.maxQueue} tracks).`);
    const list = tracks.slice(0, room);
    let index;
    if (position === 'next' || position === 'now'){ this.queue.unshift(...list); index = 0; }
    else { index = this.queue.length; this.queue.push(...list); }
    this.save();
    this.panel.refresh();
    this._schedulePrefetch();
    return { added: list.length, truncated: tracks.length - list.length, index };
  }

  async startIfIdle(){
    if (!this.current && !this.loading && this.queue.length) await this.advance('start');
  }

  async skip(){
    if (!this.current && !this.loading) throw new UserError('Nothing is playing.');
    if (!this.current){ this.gen++; this.loading = false; }
    await this.advance('skip');
  }

  async previous(){
    if (this.current && !this.current.isLive && (this.elapsed() > 5 || !this.history.length)) return this.seek(0);
    const prev = this.history.pop();
    if (!prev) throw new UserError('There\'s no previous track.');
    if (this.current){ this._recordPlay(this.current); this.queue.unshift(this.current); }
    await this._start(prev, 0);
  }

  async seek(sec){
    const t = this.current;
    if (!t) throw new UserError('Nothing is playing.');
    if (t.isLive) throw new UserError('You can\'t seek in a live stream.');
    const target = Math.max(0, Math.floor(sec));
    if (t.duration && target >= t.duration - 1) throw new UserError('That\'s past the end of the track.');
    await this._start(t, target, { keepAudio: true });
  }

  async jump(index){
    if (index < 0 || index >= this.queue.length) throw new UserError('There\'s no track at that position.');
    const [item] = this.queue.splice(index, 1);
    this.queue.unshift(item);
    if (this.current) await this.advance('skip');
    else await this.advance('start');
    return item;
  }

  // Re-start the current song at the same spot (used when filters change).
  async restartCurrent(){
    if (this.current && !this.loading && !this.current.isLive) await this._start(this.current, this.elapsed(), { keepAudio: true });
    else if (this.current && this.current.isLive && !this.loading) await this._start(this.current, 0, { keepAudio: true });
  }

  pause(by = 'user'){
    if (!this.current) throw new UserError('Nothing is playing.');
    if (this.loading){
      // Still loading: pause the moment it starts.
      this._pauseOnStart = by;
      this.pausedBy = by;
      return true;
    }
    if (this.player.pause(true)){
      this.pausedBy = by;
      this.save();
      return true;
    }
    return false;
  }

  resume(){
    if (!this.current) throw new UserError('Nothing is playing.');
    this._pauseOnStart = null;
    if (this.player.state.status === AudioPlayerStatus.AutoPaused && !this.connection){
      throw new UserError('I\'m not in a voice channel anymore. Use `/join` or hit ▶ Play queue.');
    }
    const ok = this.player.unpause();
    if (ok || this.loading) this.pausedBy = null;
    return ok;
  }

  togglePause(){
    if (this.isPaused || (this.loading && this.pausedBy)){ this.resume(); return 'resumed'; }
    this.pause('user');
    return 'paused';
  }

  // Someone is about to queue something: restart the idle countdown so we don't leave mid-request.
  touch(){
    if (!this.isActive) this._armIdleTimer();
  }

  stop(){
    if (this.current) this._recordPlay(this.current);
    this.queue = [];
    this._becomeIdle();
  }

  setVolume(v){
    this.settings.volume = Math.max(0, Math.min(200, Math.round(v)));
    this.audio?.resource.volume?.setVolume(this.settings.volume / 100);
    this.save();
    this.panel.refresh();
    return this.settings.volume;
  }

  setLoop(mode){
    this.settings.loop = mode;
    this.save();
    this.panel.refresh();
  }

  cycleLoop(){
    const order = ['off', 'all', 'one'];
    this.setLoop(order[(order.indexOf(this.settings.loop) + 1) % order.length]);
    return this.settings.loop;
  }

  setSetting(key, value){
    this.settings[key] = value;
    if (key === 'liveLyrics'){
      this.panel.restartTicker();
      if (value && this.current) this.loadLyrics(this.current).catch(() => {});
    }
    if (key === 'stay247'){
      if (value){ this._clearTimer('idle'); this._clearTimer('alone'); }
      else { if (!this.isActive) this._armIdleTimer(); this.onVoiceStateChange(); }
    }
    if (key === 'sponsorblock') this._scheduleSponsorSkip();
    this.save();
    this.panel.refresh();
  }

  async setFilters(list){
    this.settings.filters = sanitizeFilters(list);
    this.save();
    this.panel.refresh();
    await this.restartCurrent();
  }

  async toggleFilter(key){
    await this.setFilters(toggleFilter(this.settings.filters, key));
  }

  async setAudioOption(key, value){
    this.settings[key] = value; // speed | pitch | normalize
    this.save();
    this.panel.refresh();
    await this.restartCurrent();
  }

  /* ---------------- queue editing ---------------- */
  _queueChanged(){
    this.save();
    this.panel.refresh();
    this._schedulePrefetch();
  }

  shuffle(){
    if (this.queue.length < 2) throw new UserError('Need at least two songs in the queue to shuffle.');
    shuffleInPlace(this.queue);
    this._queueChanged();
  }

  // 0-based inclusive range
  removeRange(from, to = from){
    if (from < 0 || to >= this.queue.length || from > to) throw new UserError('That position isn\'t in the queue.');
    const removed = this.queue.splice(from, to - from + 1);
    this._queueChanged();
    return removed;
  }

  move(from, to){
    if (from < 0 || from >= this.queue.length) throw new UserError('That position isn\'t in the queue.');
    const dest = Math.max(0, Math.min(this.queue.length - 1, to));
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(dest, 0, item);
    this._queueChanged();
    return { item, to: dest };
  }

  clearQueue(){
    const n = this.queue.length;
    this.queue = [];
    this._queueChanged();
    return n;
  }

  dedupe(){
    const seen = new Set(this.current ? [trackKey(this.current), songFingerprint(this.current)] : []);
    const before = this.queue.length;
    this.queue = this.queue.filter(t => {
      const k = trackKey(t), f = songFingerprint(t);
      if (seen.has(k) || seen.has(f)) return false;
      seen.add(k); seen.add(f);
      return true;
    });
    const removed = before - this.queue.length;
    if (removed) this._queueChanged();
    return removed;
  }

  removeByUser(userId){
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.requester?.id !== userId);
    const removed = before - this.queue.length;
    if (removed) this._queueChanged();
    return removed;
  }

  /* ---------------- vote skip ---------------- */
  // Returns { skipped: true } or { skipped: false, votes, needed }
  async voteSkip(userId){
    const listeners = this.listeners().filter(m => !m.voice.selfDeaf && !m.voice.serverDeaf);
    const ids = new Set(listeners.map(m => m.id));
    for (const id of this.skipVotes) if (!ids.has(id)) this.skipVotes.delete(id);
    this.skipVotes.add(userId);
    const needed = Math.max(1, Math.ceil(listeners.length / 2));
    if (this.skipVotes.size >= needed){
      this.skip().catch(e => this.log.error('skip.failed', { err: e }));
      return { skipped: true };
    }
    return { skipped: false, votes: this.skipVotes.size, needed };
  }

  /* ---------------- lyrics ---------------- */
  async loadLyrics(track){
    if (this.lyrics?.trackId === track.id) return this.lyrics.data;
    if (!track.url && track.query) await resolveSpotifyPlaceholder(track).catch(() => {});
    const data = await findLyrics(track);
    if (this.current?.id === track.id){
      this.lyrics = { trackId: track.id, data };
      this.panel.refresh();
    }
    return data;
  }

  /* ---------------- SponsorBlock ---------------- */
  _scheduleSponsorSkip(){
    this._clearTimer('sponsor');
    if (!this.settings.sponsorblock || !this.segments.length || !this.current || this.loading || this.isPaused) return;
    const pos = this.elapsed();
    const speed = this.speedAtStart || 1;
    const seg = this.segments.find(s => s[1] > pos + 1);
    if (!seg) return;
    const wait = Math.max(0, (seg[0] - pos) / speed) * 1000;
    this.timers.sponsor = setTimeout(() => this._sponsorSkip(seg), wait);
  }

  async _sponsorSkip(seg){
    delete this.timers.sponsor;
    const t = this.current;
    if (!t || this.loading || this.isPaused) return;
    this.lastSponsorSkip = { at: Date.now(), sec: seg[1] - seg[0] };
    this.log.info('sponsorblock.skip', { title: t.title, from: seg[0], to: seg[1] });
    if (t.duration && seg[1] >= t.duration - 2) return this.advance('ended');
    await this._start(t, seg[1], { keepAudio: true }).catch(() => {});
  }

  /* ---------------- prefetch ---------------- */
  _schedulePrefetch(delay = 1500){
    this._clearTimer('prefetch');
    this.timers.prefetch = setTimeout(() => { delete this.timers.prefetch; this._prefetch(); }, delay);
  }

  async _prefetch(){
    const next = this.queue[0];
    if (!next) return;
    try {
      if (!next.url && next.query) await resolveSpotifyPlaceholder(next);
      const info = await getStreamInfo(next.url);
      if (this.queue[0] === next) this._applyInfo(next, info);
      const id = youtubeId(next.url);
      if (id && this.settings.sponsorblock) getMusicSegments(id).catch(() => {});
      resolveArtwork(next).catch(() => {});
      this.panel.refresh();
    } catch (e){
      this.log.debug('prefetch.failed', { title: next.title, err: e });
    }
    // Resolve a couple more Spotify placeholders so the queue shows real durations.
    for (const t of this.queue.slice(1, 3)){
      if (!t.url && t.query) resolveSpotifyPlaceholder(t).then(() => this.panel.refresh()).catch(() => {});
    }
  }

  /* ---------------- presence in voice ---------------- */
  onVoiceStateChange(){
    if (!this.connection || !this.voiceChannel) return;
    if (this.listeners().length === 0){
      if (this.timers.aloneDebounce || this.timers.alone) return;
      // Small debounce so a mobile reconnect doesn't count as leaving.
      this.timers.aloneDebounce = setTimeout(() => {
        delete this.timers.aloneDebounce;
        if (this.listeners().length) return;
        if (this.current && this.loading && !this.pausedBy) this._pauseOnStart = 'alone';
        else if (this.current && !this.loading && !this.isPaused){
          try { this.pause('alone'); } catch {}
        }
        if (!this.settings.stay247 && config.aloneTimeoutSec > 0){
          this.timers.alone = setTimeout(() => {
            delete this.timers.alone;
            if (!this.listeners().length){
              this.log.info('voice.leave_alone');
              this.disconnect();
            }
          }, config.aloneTimeoutSec * 1000);
        }
        this.panel.refresh();
      }, 3000);
    } else {
      this._clearTimer('aloneDebounce');
      this._clearTimer('alone');
      if (this._pauseOnStart === 'alone') this._pauseOnStart = null;
      if (this.pausedBy === 'alone'){
        try { this.resume(); } catch {}
        this.panel.refresh();
      }
    }
  }

  _armIdleTimer(){
    this._clearTimer('idle');
    if (this.settings.stay247 || config.idleTimeoutSec <= 0 || !this.connection) return;
    this.timers.idle = setTimeout(() => {
      delete this.timers.idle;
      if (!this.isActive){
        this.log.info('voice.leave_idle');
        this.disconnect();
      }
    }, config.idleTimeoutSec * 1000);
  }

  _clearTimer(name){
    if (this.timers[name]){
      clearTimeout(this.timers[name]);
      delete this.timers[name];
    }
  }

  /* ---------------- voice channel status ("🎶 Song – Artist" under the channel name) ---------------- */
  updateVoiceStatus(){
    const t = this.current;
    const text = t ? `🎶 ${t.title}`.slice(0, 120) : '';
    this.setVoiceStatus(text).catch(() => {});
  }

  async setVoiceStatus(text){
    if (!config.voiceStatus) return;
    const ch = this.voiceChannel;
    if (!ch || ch.type !== ChannelType.GuildVoice) return;
    const me = this.guild?.members.me;
    if (!me || !ch.permissionsFor(me)?.has(PermissionFlagsBits.SetVoiceChannelStatus)) return;
    const key = `${ch.id}|${text}`;
    if (this._voiceStatusKey === key) return;
    this._voiceStatusKey = key;
    try {
      await this.client.rest.put(`/channels/${ch.id}/voice-status`, { body: { status: text } });
    } catch (e){
      this.log.debug('voice_status.failed', { err: e });
    }
  }

  /* ---------------- notifications ---------------- */
  // Short-lived message in the panel's channel (auto-deletes).
  async notify(kind, text, ttlMs = 20_000){
    try {
      const ch = this.panel.ref ? this.client.channels.cache.get(this.panel.ref.channelId) : null;
      if (!ch?.isTextBased()) return;
      const msg = await ch.send({ ...notice(kind, text), allowedMentions: { parse: [] } });
      setTimeout(() => msg.delete().catch(() => {}), ttlMs).unref?.();
    } catch (e){
      this.log.debug('notify.failed', { err: e });
    }
  }

  /* ---------------- restore after restart ---------------- */
  async restoreSession(){
    const s = this.session;
    this.session = null;
    if (!s?.current) return false;
    const giveBack = () => {
      if (!this.queue.some(t => t.id === s.current.id) && this.current?.id !== s.current.id) this.queue.unshift(s.current);
      this.save();
      this.panel.refresh();
      return false;
    };
    // Someone already started something after the restart — theirs wins; ours goes back in the queue.
    if (this.isActive || this.connection) return giveBack();
    const fresh = Date.now() - (s.savedAt || 0) < 6 * 3600e3;
    const ch = this.guild?.channels.cache.get(s.voiceChannelId);
    const humans = ch?.members ? ch.members.filter(m => !m.user.bot).size : 0;
    if (!fresh || !ch || !humans) return giveBack();
    try {
      await this.connect(ch);
      if (this.isActive) return giveBack();
      await this._start(s.current, s.position || 0, { startPaused: s.paused ? 'user' : null });
      this.log.info('session.restored', { title: s.current.title, position: s.position });
      return true;
    } catch (e){
      this.log.warn('session.restore_failed', { err: e });
      return giveBack();
    }
  }

  async shutdown(){
    this.shuttingDown = true;
    await this.saver.flush().catch(() => {});
    await this.saveNow().catch(() => {});
    this.panel.stopTicker();
    if (this.isActive) await this.panel.showRestarting().catch(() => {});
    this._killAudio();
    for (const name of Object.keys(this.timers)) this._clearTimer(name);
    const conn = this.connection;
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  }

  destroy(){
    this.destroyed = true;
    this.gen++;
    this._killAudio();
    for (const name of Object.keys(this.timers)) this._clearTimer(name);
    this.panel.stopTicker();
    this.player.stop(true);
    const conn = this.connection;
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
  }
}
