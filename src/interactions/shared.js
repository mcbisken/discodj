// Logic shared between slash commands, panel buttons and pickers.
import { UserError } from '../errors.js';
import { log } from '../logger.js';
import { findLyrics } from '../sources/lyrics.js';
import { parseArtistTitle, trackKey, withRequester } from '../sources/track.js';
import { info, lyricsPages, lyricsView } from '../ui/messages.js';
import { putPending } from './pending.js';

export function findDuplicates(gp, tracks){
  const keys = new Set([...gp.queue, gp.current].filter(Boolean).map(trackKey));
  return tracks.filter(t => keys.has(trackKey(t)));
}

// Queues tracks for the requester, starts playback if idle, and makes sure the panel is visible.
export async function enqueueAndPlay(ctx, tracks, { position = 'end', playlistTitle = null } = {}){
  const gp = ctx.gp;
  const list = tracks.map(t => withRequester(t, ctx.requester));
  const wasActive = gp.isActive;
  const res = gp.enqueue(list, position);
  let startedNow = false;
  if (!wasActive){
    startedNow = true;
    gp.startIfIdle().catch(e => log.error('play.start_failed', { guildId: gp.guildId, err: e }));
  } else if (position === 'now'){
    startedNow = true;
    gp.skip().catch(e => log.error('play.skip_failed', { guildId: gp.guildId, err: e }));
  }
  if (ctx.channel?.isTextBased?.()) await gp.panel.ensure(ctx.channel);
  return { ...res, startedNow, tracks: list.slice(0, res.added), playlistTitle };
}

// Skip for DJs/requesters/small rooms; vote-skip for everyone else.
export async function skipOrVote(ctx){
  const gp = ctx.gp;
  if (!gp.current && !gp.loading) throw new UserError('Nothing is playing.');
  const title = gp.current?.title || 'this song';
  const s = gp.settings;
  const isRequester = gp.current?.requester?.id === ctx.user.id;
  const canForce = ctx.isDJ || isRequester || gp.listeners().length <= 2 || (!s.voteSkip && !s.djOnly);
  if (canForce){
    // The transition happens synchronously; don't make the user wait for the next song to load.
    gp.skip().catch(e => log.error('skip.failed', { guildId: gp.guildId, err: e }));
    return { skipped: true, title };
  }
  if (!s.voteSkip) throw new UserError('DJ-only mode is on, so only DJs can skip.');
  return { ...(await gp.voteSkip(ctx.user.id)), title };
}

export async function lyricsPayload(gp, { track = null, query = null }){
  const subject = track || { title: query, author: null };
  const { artist, title } = parseArtistTitle(subject);
  const data = track && gp.current?.id === track.id ? await gp.loadLyrics(track) : await findLyrics(subject);
  if (!data) throw new UserError(`I couldn't find lyrics for **${title || query}**.`);
  if (data.instrumental || !data.plain) return info('🎻 That one\'s an instrumental, so there are no lyrics.');
  const pages = lyricsPages(data.plain);
  const view = { title: data.trackName || title, artist: data.artistName || artist, pages, thumbnail: track?.thumbnail || null };
  const token = putPending(view);
  return lyricsView({ ...view, page: 0, token });
}
