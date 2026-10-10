// Keeps one live panel message per server up to date: coalesced edits, no-op skipping,
// a progress ticker, and re-posting at the bottom when chat buries it.
//
// Posting a new panel and editing the existing one run one at a time (see _serial), so a slow
// edit can never race a re-post and leave two panels behind.
import { isUnknownMessage } from '../errors.js';
import { buildPanel, QUEUE_PAGE_SIZE, restartingPanel } from './panel.js';

const NO_PINGS = { parse: [] };

function hashPayload(p){
  return JSON.stringify(p.components.map(c => c.toJSON()));
}

export class PanelController {
  constructor(gp){
    this.gp = gp;
    this.ref = null;    // { channelId, messageId }
    this.page = 0;
    this._timer = null;
    this._ticker = null;
    this._editing = false;
    this._dirty = false;
    this._lastHash = null;
    this._chain = Promise.resolve();
  }

  _serial(fn){
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  _channel(id = this.ref?.channelId){
    if (!id) return null;
    const ch = this.gp.client.channels.cache.get(id);
    return ch?.isTextBased() ? ch : null;
  }

  _build(){
    const totalPages = Math.max(1, Math.ceil(this.gp.queue.length / QUEUE_PAGE_SIZE));
    this.page = Math.max(0, Math.min(this.page, totalPages - 1));
    return buildPanel(this.gp, { page: this.page });
  }

  // Posts a fresh panel at the bottom of `channel` and removes the old one.
  show(channel){
    return this._serial(() => this._show(channel));
  }

  async _show(channel){
    const old = this.ref;
    const payload = this._build();
    const msg = await channel.send({ ...payload, allowedMentions: NO_PINGS });
    this.ref = { channelId: channel.id, messageId: msg.id };
    this._lastHash = hashPayload(payload);
    if (old?.messageId && old.messageId !== msg.id) this._deleteMessage(old);
    this.gp.save();
    return msg;
  }

  // Makes sure a panel exists in `channel` (moves it there if it lives elsewhere).
  async ensure(channel){
    if (!channel?.isTextBased()) return;
    if (this.ref?.channelId === channel.id && this.ref.messageId){
      this.refresh({ immediate: true });
      return;
    }
    await this.show(channel).catch(e => this.gp.log.debug('panel.show_failed', { err: e }));
  }

  // Payload for interaction.update() on a panel button. Records the hash so we don't re-edit.
  render(){
    const payload = this._build();
    this._lastHash = hashPayload(payload);
    return payload;
  }

  turnPage(delta){
    this.page = Math.max(0, this.page + delta);
  }

  refresh({ immediate = false } = {}){
    if (!this.ref?.messageId) return;
    if (immediate) return void this._flush();
    if (this._timer) return;
    this._timer = setTimeout(() => this._flush(), 350);
  }

  async _flush(){
    clearTimeout(this._timer);
    this._timer = null;
    if (this._editing){ this._dirty = true; return; }
    this._editing = true;
    try {
      do {
        this._dirty = false;
        await this._serial(() => this._editOnce());
      } while (this._dirty);
    } finally {
      this._editing = false;
    }
  }

  async _editOnce(){
    const ref = this.ref;
    if (!ref?.messageId) return;
    const ch = this._channel(ref.channelId);
    if (!ch){ this.ref = null; return; }
    const payload = this._build();
    const hash = hashPayload(payload);
    if (hash === this._lastHash) return;
    try {
      await ch.messages.edit(ref.messageId, { ...payload, allowedMentions: NO_PINGS });
      if (this.ref === ref) this._lastHash = hash;
    } catch (e){
      if (this.ref !== ref) return; // a newer panel replaced this one meanwhile, so nothing to fix
      if (isUnknownMessage(e)){
        // Someone deleted the panel. Bring it back if music is playing.
        this.ref = null;
        if (this.gp.isActive) await this._show(ch).catch(() => {});
      } else if (e.code === 50001 || e.code === 50013 || e.code === 10003){
        this.ref = null; // lost access to the channel
      } else if (e.code === 50035 || /components/i.test(String(e.message))){
        // An old (v2-era) embed panel can't be converted to the new layout, so replace it.
        await this._show(ch).catch(() => {});
      } else {
        this.gp.log.debug('panel.edit_failed', { err: e });
      }
    }
  }

  // If the panel scrolled up out of view, re-post it at the bottom (called on every new song).
  async bump(){
    const ch = this._channel();
    const ref = this.ref;
    if (!ch || !ref?.messageId || ch.lastMessageId === ref.messageId) return;
    const after = await ch.messages.fetch({ after: ref.messageId, limit: 5 }).catch(() => null);
    if (!after || after.size < 4) return;
    await this._serial(async () => {
      if (this.ref === ref) await this._show(ch);
    }).catch(() => {});
  }

  async showRestarting(){
    const ch = this._channel();
    if (!ch || !this.ref?.messageId) return;
    const payload = restartingPanel();
    await Promise.race([
      ch.messages.edit(this.ref.messageId, payload).catch(() => {}),
      new Promise(r => setTimeout(r, 2500))
    ]);
    this._lastHash = null;
  }

  startTicker(){
    if (this._ticker) return;
    const every = this.gp.settings.liveLyrics ? 5000 : 10_000;
    this._ticker = setInterval(() => {
      if (!this.gp.current || this.gp.loading) return;
      this.refresh({ immediate: true });
      if (!this.gp.isPaused) this.gp.save(); // keeps the resume position fresh
    }, every);
  }

  restartTicker(){
    const was = !!this._ticker;
    this.stopTicker();
    if (was || this.gp.current) this.startTicker();
  }

  stopTicker(){
    if (this._ticker){ clearInterval(this._ticker); this._ticker = null; }
  }

  _deleteMessage(ref){
    const ch = this._channel(ref.channelId);
    ch?.messages.delete(ref.messageId).catch(() => {});
  }
}
