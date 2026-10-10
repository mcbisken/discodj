// Buttons and select menus: the player panel ("pl:"), duplicate prompts ("dd:"),
// search/history pickers ("sr:", "hi:") and lyric pages ("ly:").
import { replyError } from '../commands/index.js';
import { config } from '../config.js';
import { UserError } from '../errors.js';
import { toggleLiked } from '../store/playlists.js';
import { escapeMd, truncate } from '../ui/format.js';
import { addedCard, lyricsView, say, voteView } from '../ui/messages.js';
import { joinUser, requireSameChannel } from '../util/voice.js';
import { createContext } from './context.js';
import { dropPending, getPending } from './pending.js';
import { enqueueAndPlay, lyricsPayload, skipOrVote } from './shared.js';

const NO_PINGS = { parse: [] };
const VIEW_ONLY = new Set(['qprev', 'qnext', 'qpage', 'lyrics', 'like']);
const title = t => `**${escapeMd(truncate(t, 80))}**`;

function updatePanel(ctx){
  return ctx.interaction.update({ ...ctx.gp.panel.render(), allowedMentions: NO_PINGS });
}

function requireDJMode(ctx){
  if (ctx.gp.settings.djOnly && !ctx.isDJ) throw new UserError('DJ-only mode is on, so only DJs can use the controls.');
}

async function panelAction(ctx, action){
  const { gp, interaction } = ctx;
  if (gp.panel.ref?.messageId !== interaction.message.id){
    throw new UserError('This panel is out of date. Use the newest one, or run `/queue` to bring it here.');
  }
  if (!VIEW_ONLY.has(action)){
    if (action !== 'skip') requireDJMode(ctx); // skip falls back to vote-skip instead
    if (action !== 'playq') requireSameChannel(ctx);
  }

  switch (action){
    case 'toggle':
      gp.togglePause();
      return updatePanel(ctx);
    case 'stop':
      gp.stop();
      return updatePanel(ctx);
    case 'shuffle':
      gp.shuffle();
      return updatePanel(ctx);
    case 'clear':
      gp.clearQueue();
      return updatePanel(ctx);
    case 'voldown':
    case 'volup':
      gp.setVolume(gp.settings.volume + (action === 'volup' ? 10 : -10));
      return updatePanel(ctx);
    case 'loop':
      gp.cycleLoop();
      return updatePanel(ctx);
    case 'autoplay':
      gp.setSetting('autoplay', !gp.settings.autoplay);
      return updatePanel(ctx);
    case 'live':
      gp.setSetting('liveLyrics', !gp.settings.liveLyrics);
      return updatePanel(ctx);
    case 'qprev':
    case 'qnext':
      gp.panel.turnPage(action === 'qnext' ? 1 : -1);
      return updatePanel(ctx);
    case 'qpage':
      return interaction.deferUpdate();

    case 'prev':
      await interaction.deferUpdate();
      if (!gp.connection) await joinUser(ctx); // e.g. after an idle-leave, going back starts playback
      await gp.previous();
      return;
    case 'back':
    case 'fwd': {
      await interaction.deferUpdate();
      const t = gp.current;
      if (!t) throw new UserError('Nothing is playing.');
      const target = gp.elapsed() + (action === 'fwd' ? 15 : -15);
      if (t.duration && target >= t.duration - 1) await gp.skip();
      else await gp.seek(Math.max(0, target));
      return;
    }
    case 'skip': {
      await interaction.deferUpdate();
      const r = await skipOrVote(ctx);
      if (!r.skipped){
        const msg = await interaction.followUp({ ...voteView(r.votes, r.needed, r.title), allowedMentions: NO_PINGS });
        setTimeout(() => msg.delete().catch(() => {}), 30_000).unref?.();
      }
      return;
    }
    case 'playq':
      await interaction.deferUpdate();
      await joinUser(ctx);
      await gp.startIfIdle();
      return;
    case 'filters':
      // Dropdown disabled via AUDIO_FILTERS: just redraw the panel (which drops the stale menu).
      if (config.audioFilters !== 'on') return updatePanel(ctx);
      await interaction.deferUpdate();
      await gp.setFilters(interaction.values);
      return;

    case 'lyrics': {
      if (!gp.current) throw new UserError('Nothing is playing.');
      await ctx.deferPrivate();
      return ctx.reply(await lyricsPayload(gp, { track: gp.current }));
    }
    case 'like': {
      const t = gp.current;
      if (!t) throw new UserError('Nothing is playing.');
      if (!t.url && !t.query) throw new UserError('Give it a second, the song is still loading.');
      const liked = await toggleLiked(ctx.user.id, t);
      return ctx.replyPrivate(say(liked ? 'ok' : 'info', liked
        ? `❤️ Added ${title(t.title)} to your **Liked Songs**. Play them with \`/playlist load\`.`
        : `💔 Removed ${title(t.title)} from your Liked Songs.`));
    }
    default:
      return interaction.deferUpdate();
  }
}

async function dupAction(ctx, token, op){
  const data = getPending(token);
  if (op === 'cancel' || !data){
    dropPending(token);
    return ctx.interaction.update(say('info', data ? 'Okay, I won\'t add it.' : 'This prompt expired. Run `/play` again.'));
  }
  requireDJMode(ctx);
  await ctx.interaction.deferUpdate();
  await joinUser(ctx); // may throw ("join a voice channel"); the prompt stays usable for a retry
  dropPending(token);
  const res = await enqueueAndPlay(ctx, data.tracks, { position: data.position, playlistTitle: data.playlistTitle });
  return ctx.interaction.editReply(addedCard(ctx.gp, res));
}

async function pickTracks(ctx, token, kind){
  const data = getPending(token);
  if (!data) throw new UserError('This menu expired. Run the command again.');
  requireDJMode(ctx);
  const picks = ctx.interaction.values.map(v => data.tracks[Number(v)]).filter(Boolean);
  if (!picks.length) return ctx.interaction.deferUpdate();
  await ctx.interaction.deferUpdate();
  await joinUser(ctx);
  const res = await enqueueAndPlay(ctx, picks, { playlistTitle: kind === 'history' ? 'Replaying from history' : 'Search picks' });
  return ctx.interaction.editReply(addedCard(ctx.gp, res));
}

async function lyricsPage(ctx, token, page){
  if (token === 'noop') return ctx.interaction.deferUpdate();
  const data = getPending(token);
  if (!data) throw new UserError('These lyrics expired. Run `/lyrics` again.');
  const p = Math.max(0, Math.min(data.pages.length - 1, Number(page) || 0));
  return ctx.interaction.update(lyricsView({ ...data, page: p, token }));
}

export async function handleComponent(interaction, manager){
  if (!interaction.inGuild()) return;
  const [ns, a, b] = interaction.customId.split(':');
  const ctx = await createContext(interaction, manager);
  try {
    switch (ns){
      case 'pl': return await panelAction(ctx, a);
      case 'dd': return await dupAction(ctx, a, b);
      case 'sr': return await pickTracks(ctx, a, 'search');
      case 'hi': return await pickTracks(ctx, a, 'history');
      case 'ly': return await lyricsPage(ctx, a, b);
      default: return await interaction.deferUpdate().catch(() => {});
    }
  } catch (e){
    await replyError(ctx, e, `component:${interaction.customId}`);
  }
}
