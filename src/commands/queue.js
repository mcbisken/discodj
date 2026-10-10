import { SlashCommandBuilder } from 'discord.js';

import { UserError } from '../errors.js';
import { putPending } from '../interactions/pending.js';
import { escapeMd, parseRange, plural, truncate } from '../ui/format.js';
import { historyView, say } from '../ui/messages.js';

const title = t => `**${escapeMd(truncate(t, 80))}**`;

export function queueChoices(gp, value){
  const q = String(value || '').toLowerCase().trim();
  return gp.queue
    .map((t, i) => ({ name: truncate(`${i + 1}. ${t.title}`, 100), value: String(i + 1) }))
    .filter(c => !q || c.name.toLowerCase().includes(q))
    .slice(0, 25);
}

// Accepts "3", "3-7" or (if the user ignored the suggestions) part of a title.
export function resolvePositions(gp, input){
  const range = parseRange(input);
  if (range) return range;
  const needle = String(input || '').toLowerCase().trim();
  const idx = needle ? gp.queue.findIndex(t => t.title.toLowerCase().includes(needle)) : -1;
  if (idx >= 0) return [idx, idx];
  throw new UserError('I couldn\'t find that in the queue. Pick one of the suggestions, or use a number like `3` or `3-7`.');
}

const positionAutocomplete = ({ gp, focused }) => queueChoices(gp, focused.value);

export default [
  {
    data: new SlashCommandBuilder().setName('queue').setDescription('Show the player panel here (moves it to the bottom)'),
    async execute(ctx){
      if (!ctx.channel?.isTextBased()) throw new UserError('I can\'t post in this channel.');
      await ctx.gp.panel.show(ctx.channel);
      return say('ok', '🎛️ Here\'s the player ↓');
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('remove')
      .setDescription('Remove a song, or a range like 3-7, from the queue')
      .addStringOption(o => o.setName('position').setDescription('Queue number, a range like 3-7, or a title').setRequired(true).setAutocomplete(true)),
    dj: true,
    voice: 'same',
    autocomplete: positionAutocomplete,
    execute(ctx){
      const [a, b] = resolvePositions(ctx.gp, ctx.interaction.options.getString('position', true));
      const removed = ctx.gp.removeRange(a, b);
      return say('ok', removed.length === 1 ? `🗑️ Removed ${title(removed[0].title)}.` : `🗑️ Removed ${plural(removed.length, 'song')} (#${a + 1}–${b + 1}).`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('move')
      .setDescription('Move a song to another spot in the queue')
      .addStringOption(o => o.setName('song').setDescription('The song to move').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('to').setDescription('New position (1 = next up)').setRequired(true).setMinValue(1)),
    dj: true,
    voice: 'same',
    autocomplete: positionAutocomplete,
    execute(ctx){
      const [from] = resolvePositions(ctx.gp, ctx.interaction.options.getString('song', true));
      const { item, to } = ctx.gp.move(from, ctx.interaction.options.getInteger('to', true) - 1);
      return say('ok', `↕️ Moved ${title(item.title)} to **#${to + 1}**.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('jump')
      .setDescription('Skip straight to a song in the queue')
      .addStringOption(o => o.setName('song').setDescription('The song to play now').setRequired(true).setAutocomplete(true)),
    dj: true,
    voice: 'play',
    autocomplete: positionAutocomplete,
    async execute(ctx){
      const [idx] = resolvePositions(ctx.gp, ctx.interaction.options.getString('song', true));
      const item = await ctx.gp.jump(idx);
      return say('ok', `⏭️ Jumping to ${title(item.title)}.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
    dj: true,
    voice: 'same',
    execute(ctx){
      ctx.gp.shuffle();
      return say('ok', `🔀 Shuffled ${plural(ctx.gp.queue.length, 'song')}.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (keeps the current song playing)'),
    dj: true,
    voice: 'same',
    execute(ctx){
      const n = ctx.gp.clearQueue();
      return say('ok', n ? `🧹 Cleared ${plural(n, 'song')} from the queue.` : '🧹 The queue was already empty.');
    }
  },
  {
    data: new SlashCommandBuilder().setName('dedupe').setDescription('Remove duplicate songs from the queue'),
    dj: true,
    voice: 'same',
    execute(ctx){
      const n = ctx.gp.dedupe();
      return say('ok', n ? `🧽 Removed ${plural(n, 'duplicate')}.` : '🧽 No duplicates found.');
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('removeuser')
      .setDescription('Remove every queued song added by someone')
      .addUserOption(o => o.setName('user').setDescription('Whose songs to remove').setRequired(true)),
    dj: true,
    voice: 'same',
    execute(ctx){
      const user = ctx.interaction.options.getUser('user', true);
      if (user.id !== ctx.user.id && !ctx.isDJ) throw new UserError('Only DJs can remove other people\'s songs.');
      const n = ctx.gp.removeByUser(user.id);
      return say('ok', n ? `🗑️ Removed ${plural(n, 'song')} added by ${user}.` : `${user} has nothing in the queue.`);
    }
  },
  {
    data: new SlashCommandBuilder().setName('history').setDescription('Recently played songs, with replay'),
    execute(ctx){
      const items = ctx.gp.history.slice(-20).reverse();
      const token = putPending({ tracks: items });
      return historyView(ctx.gp, token);
    }
  }
];
