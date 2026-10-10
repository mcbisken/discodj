import { SlashCommandBuilder } from 'discord.js';

import { UserError } from '../errors.js';
import { putPending } from '../interactions/pending.js';
import { enqueueAndPlay, findDuplicates, lyricsPayload, skipOrVote } from '../interactions/shared.js';
import { resolveInput } from '../sources/resolve.js';
import { searchYouTube } from '../sources/search.js';
import { makeTrack, trackKey } from '../sources/track.js';
import { escapeMd, formatTime, parseTimeInput, truncate } from '../ui/format.js';
import { addedCard, dupPrompt, nowPlayingCard, say, searchView, voteView } from '../ui/messages.js';

const title = t => `**${escapeMd(truncate(t, 80))}**`;

export async function playCore(ctx, query, position = 'end'){
  const { tracks, playlistTitle } = await resolveInput(query);
  if (!tracks.length) throw new UserError('No results. Try other words or a different link.');

  const dupes = findDuplicates(ctx.gp, tracks);
  if (tracks.length === 1 && dupes.length === 1){
    const token = putPending({ tracks, position, playlistTitle });
    return ctx.replyPrivate(dupPrompt(tracks[0], token));
  }
  let list = tracks;
  let skipped = 0;
  if (tracks.length > 1 && dupes.length){
    const keys = new Set(dupes.map(trackKey));
    list = tracks.filter(t => !keys.has(trackKey(t)));
    skipped = tracks.length - list.length;
    if (!list.length) throw new UserError('Everything in that playlist is already in the queue.');
  }
  const res = await enqueueAndPlay(ctx, list, { position, playlistTitle });
  return ctx.reply(addedCard(ctx.gp, { ...res, skipped }), { autoDeleteMs: 20_000 });
}

export default [
  {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song, playlist or album: a search or a YouTube/Spotify/SoundCloud link')
      .addStringOption(o => o.setName('query').setDescription('Song name or link').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('position').setDescription('Where it goes in the queue').addChoices(
        { name: 'End of the queue', value: 'end' },
        { name: 'Play next', value: 'next' },
        { name: 'Play right now', value: 'now' }
      )),
    ephemeral: false,
    dj: true,
    voice: 'join',
    execute: ctx => playCore(ctx, ctx.interaction.options.getString('query', true), ctx.interaction.options.getString('position') || 'end'),
    async autocomplete({ focused }){
      const value = String(focused.value || '').trim();
      if (value.length < 2 || /^<?https?:\/\//i.test(value)) return [];
      const results = await searchYouTube(value, 7, { timeoutMs: 2200, fallback: false });
      return results.map(r => ({
        name: truncate([r.title, r.isLive ? 'LIVE' : r.duration ? formatTime(r.duration) : null, r.author].filter(Boolean).join(' · '), 100),
        value: r.url.slice(0, 100)
      }));
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search YouTube and pick which results to queue')
      .addStringOption(o => o.setName('query').setDescription('What to search for').setRequired(true)),
    dj: true,
    async execute(ctx){
      const query = ctx.interaction.options.getString('query', true);
      const results = await searchYouTube(query, 10);
      if (!results.length) throw new UserError(`No results for ${title(query)}.`);
      const token = putPending({ tracks: results.map(r => makeTrack({ ...r, source: 'youtube' })) });
      return searchView(query, results, token);
    }
  },
  {
    data: new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
    dj: true,
    voice: 'same',
    execute(ctx){
      if (ctx.gp.isPaused) throw new UserError('Already paused. `/resume` to continue.');
      ctx.gp.pause('user');
      return say('ok', '⏸️ Paused.');
    }
  },
  {
    data: new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
    dj: true,
    voice: 'same',
    execute(ctx){
      if (!ctx.gp.isPaused) throw new UserError(ctx.gp.current ? 'It\'s already playing.' : 'Nothing is playing.');
      ctx.gp.resume();
      return say('ok', '▶️ Resumed.');
    }
  },
  {
    data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song (or vote to skip)'),
    ephemeral: false,
    voice: 'same',
    async execute(ctx){
      const r = await skipOrVote(ctx);
      if (r.skipped) return ctx.reply(say('ok', `⏭️ Skipped ${title(r.title)}`), { autoDeleteMs: 8000 });
      return ctx.reply(voteView(r.votes, r.needed, r.title), { autoDeleteMs: 30_000 });
    }
  },
  {
    data: new SlashCommandBuilder().setName('prev').setDescription('Go back to the previous song (or restart this one)'),
    dj: true,
    voice: 'play',
    async execute(ctx){
      await ctx.gp.previous();
      return say('ok', '⏮️ Going back.');
    }
  },
  {
    data: new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue'),
    dj: true,
    voice: 'same',
    execute(ctx){
      ctx.gp.stop();
      return say('ok', '⏹️ Stopped and cleared the queue.');
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('seek')
      .setDescription('Jump to a time in the song')
      .addStringOption(o => o.setName('time').setDescription('e.g. 1:23, 83, 1m30s, +30 or -15').setRequired(true)),
    dj: true,
    voice: 'same',
    async execute(ctx){
      const parsed = parseTimeInput(ctx.interaction.options.getString('time', true));
      if (!parsed) throw new UserError('Use a time like `1:23`, `83`, `+30` or `-15`.');
      const target = Math.max(0, parsed.relative ? ctx.gp.elapsed() + parsed.seconds : parsed.seconds);
      await ctx.gp.seek(target);
      return say('ok', `⏩ Jumped to **${formatTime(target)}**.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show what\'s playing'),
    ephemeral: false,
    execute(ctx){
      if (!ctx.gp.current) throw new UserError('Nothing is playing.');
      return nowPlayingCard(ctx.gp);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('lyrics')
      .setDescription('Lyrics for the current song, or any song')
      .addStringOption(o => o.setName('song').setDescription('Leave empty for the current song, or type "Artist - Title"')),
    async execute(ctx){
      const query = ctx.interaction.options.getString('song');
      if (!query && !ctx.gp.current) throw new UserError('Nothing is playing. Tell me which song: `/lyrics song:Artist - Title`.');
      return lyricsPayload(ctx.gp, query ? { query } : { track: ctx.gp.current });
    }
  },
  {
    data: new SlashCommandBuilder().setName('join').setDescription('Bring the bot to your voice channel'),
    voice: 'join',
    async execute(ctx){
      if (ctx.channel?.isTextBased()) await ctx.gp.panel.ensure(ctx.channel);
      return say('ok', `👋 Joined ${ctx.member.voice.channel}.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel and clear the queue'),
    dj: true,
    voice: 'same',
    async execute(ctx){
      if (!ctx.gp.connection) throw new UserError('I\'m not in a voice channel.');
      ctx.gp.stop();
      await ctx.gp.disconnect();
      return say('ok', '👋 See you next time!');
    }
  }
];
