// Owns every GuildPlayer and the bot's presence ("Listening to …").
import { ActivityType } from 'discord.js';

import { log } from '../logger.js';
import { loadGuildDoc } from '../store/guildStore.js';
import { GuildPlayer } from './GuildPlayer.js';

export class PlayerManager {
  constructor(client){
    this.client = client;
    this.players = new Map();
    this._pending = new Map(); // guildId -> Promise<GuildPlayer> while its state loads
    this._presenceTimer = null;
    this._presenceKey = null;
  }

  // Loads saved state the first time a guild is touched. Concurrent callers share one load,
  // so nobody gets a half-hydrated player.
  async get(guildId){
    const ready = this.players.get(guildId);
    if (ready) return ready;
    if (this._pending.has(guildId)) return this._pending.get(guildId);
    const p = (async () => {
      const gp = new GuildPlayer(this, guildId);
      gp.hydrate(await loadGuildDoc(guildId));
      this.players.set(guildId, gp);
      return gp;
    })().finally(() => this._pending.delete(guildId));
    this._pending.set(guildId, p);
    return p;
  }

  peek(guildId){
    return this.players.get(guildId) || null;
  }

  async loadAll(guildIds){
    await Promise.all([...guildIds].map(id => this.get(id).catch(e => log.error('guild.load_failed', { guildId: id, err: e }))));
    log.info('guilds.loaded', { count: this.players.size });
  }

  async restoreSessions(){
    let restored = 0;
    for (const gp of this.players.values()){
      if (gp.session && await gp.restoreSession()) restored++;
    }
    if (restored) log.info('sessions.restored', { count: restored });
  }

  remove(guildId){
    const gp = this.players.get(guildId);
    if (gp){ gp.destroy(); this.players.delete(guildId); }
  }

  updatePresence(){
    clearTimeout(this._presenceTimer);
    this._presenceTimer = setTimeout(() => this._applyPresence(), 2000);
  }

  _applyPresence(){
    const user = this.client.user;
    if (!user) return;
    const playing = [...this.players.values()].filter(p => p.current && !p.loading && !p.isPaused);
    let activity;
    if (playing.length === 1) activity = { name: playing[0].current.title.slice(0, 120), type: ActivityType.Listening };
    else if (playing.length > 1) activity = { name: `music in ${playing.length} servers`, type: ActivityType.Listening };
    else activity = { name: 'idle', type: ActivityType.Custom, state: '🎧 /play to start the party' };
    const key = JSON.stringify(activity);
    if (key === this._presenceKey) return;
    this._presenceKey = key;
    try { user.setPresence({ activities: [activity], status: 'online' }); } catch {}
  }

  async shutdown(){
    await Promise.allSettled([...this.players.values()].map(gp => gp.shutdown()));
  }
}
