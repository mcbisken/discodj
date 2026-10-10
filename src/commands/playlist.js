import { SlashCommandBuilder } from 'discord.js';

import { UserError } from '../errors.js';
import { enqueueAndPlay } from '../interactions/shared.js';
import { resolveInput } from '../sources/resolve.js';
import {
  deleteServerPlaylist, deleteUserPlaylist, getServerPlaylist, getUserPlaylist, LIKED_NAME, listServerPlaylists,
  listUserPlaylists, saveServerPlaylist, saveUserPlaylist
} from '../store/playlists.js';
import { escapeMd, plural } from '../ui/format.js';
import { addedCard, playlistsView, playlistView, say } from '../ui/messages.js';
import { joinUser } from '../util/voice.js';

const scopeOption = o => o.setName('scope').setDescription('Server playlist (everyone) or personal (just you)').addChoices(
  { name: '🏠 Server', value: 'server' },
  { name: '⭐ Personal', value: 'personal' }
);
const nameOption = (o, autocomplete = true) => o.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(60).setAutocomplete(autocomplete);

// Autocomplete values look like "s|Name" (server) or "u|Name" (personal); typed names have no prefix.
async function findPlaylist(ctx, value){
  const m = String(value).match(/^([su])\|(.+)$/);
  const name = (m ? m[2] : value).trim();
  if (!m || m[1] === 's'){
    const pl = await getServerPlaylist(ctx.guild.id, name);
    if (pl) return { scope: 'server', pl };
  }
  if (!m || m[1] === 'u'){
    const pl = await getUserPlaylist(ctx.user.id, name);
    if (pl) return { scope: 'personal', pl };
  }
  throw new UserError(`No playlist called **${escapeMd(name)}**. \`/playlist list\` shows them all.`);
}

function checkName(raw){
  const name = String(raw || '').trim().replace(/\|/g, '/').slice(0, 60);
  if (!name) throw new UserError('Give the playlist a name.');
  if (name.toLowerCase() === LIKED_NAME.toLowerCase()) throw new UserError(`"${LIKED_NAME}" is reserved for ❤️ likes.`);
  return name;
}

async function saveTo(ctx, scope, name, tracks){
  if (scope === 'personal') return saveUserPlaylist(ctx.user.id, name, tracks);
  const existing = await getServerPlaylist(ctx.guild.id, name);
  if (existing && existing.createdBy && existing.createdBy !== ctx.user.id && !ctx.isDJ){
    throw new UserError(`**${escapeMd(existing.name)}** belongs to <@${existing.createdBy}>. Only they or a DJ can overwrite it.`);
  }
  return saveServerPlaylist(ctx.guild.id, name, tracks, ctx.user.id);
}

export default [
  {
    data: new SlashCommandBuilder()
      .setName('playlist')
      .setDescription('Save, load and manage playlists')
      .addSubcommand(s => s.setName('save').setDescription('Save the queue (including the current song) as a playlist')
        .addStringOption(o => nameOption(o, false)).addStringOption(scopeOption))
      .addSubcommand(s => s.setName('load').setDescription('Add a saved playlist to the queue')
        .addStringOption(o => nameOption(o))
        .addBooleanOption(o => o.setName('shuffle').setDescription('Shuffle it first')))
      .addSubcommand(s => s.setName('show').setDescription('See what\'s in a playlist').addStringOption(o => nameOption(o)))
      .addSubcommand(s => s.setName('delete').setDescription('Delete a playlist').addStringOption(o => nameOption(o)))
      .addSubcommand(s => s.setName('list').setDescription('List server and personal playlists'))
      .addSubcommand(s => s.setName('import').setDescription('Create a playlist from a YouTube, Spotify or SoundCloud link')
        .addStringOption(o => nameOption(o, false))
        .addStringOption(o => o.setName('url').setDescription('Playlist / album link').setRequired(true))
        .addStringOption(scopeOption)),

    async autocomplete({ interaction, focused }){
      const q = String(focused.value || '').toLowerCase();
      const [server, mine] = await Promise.all([listServerPlaylists(interaction.guildId), listUserPlaylists(interaction.user.id)]);
      return [
        ...mine.map(p => ({ name: `${p.liked ? '❤️' : '⭐'} ${p.name} · ${p.count} tracks`, value: `u|${p.name}`, n: p.name })),
        ...server.map(p => ({ name: `🏠 ${p.name} · ${p.count} tracks`, value: `s|${p.name}`, n: p.name }))
      ].filter(c => !q || c.n.toLowerCase().includes(q)).map(({ name, value }) => ({ name: name.slice(0, 100), value: value.slice(0, 100) }));
    },

    async execute(ctx){
      const opts = ctx.interaction.options;
      const sub = opts.getSubcommand();
      const gp = ctx.gp;

      if (sub === 'save'){
        const name = checkName(opts.getString('name', true));
        const scope = opts.getString('scope') || 'server';
        const tracks = [gp.current, ...gp.queue].filter(Boolean);
        if (!tracks.length) throw new UserError('Nothing to save. Queue some songs first.');
        const pl = await saveTo(ctx, scope, name, tracks);
        return say('ok', `💾 Saved ${scope === 'personal' ? 'your' : 'server'} playlist **${escapeMd(pl.name)}** (${plural(pl.count, 'track')}).`);
      }

      if (sub === 'import'){
        const name = checkName(opts.getString('name', true));
        const scope = opts.getString('scope') || 'server';
        const { tracks, playlistTitle } = await resolveInput(opts.getString('url', true));
        if (!tracks.length) throw new UserError('I couldn\'t find any tracks at that link.');
        const pl = await saveTo(ctx, scope, name, tracks);
        return say('ok', `📥 Imported ${playlistTitle ? `**${escapeMd(playlistTitle)}**` : 'that link'} as **${escapeMd(pl.name)}** (${plural(pl.count, 'track')}).`);
      }

      if (sub === 'list'){
        const [server, mine] = await Promise.all([listServerPlaylists(ctx.guild.id), listUserPlaylists(ctx.user.id)]);
        return playlistsView(server, mine);
      }

      if (sub === 'show'){
        const { scope, pl } = await findPlaylist(ctx, opts.getString('name', true));
        return playlistView(pl, scope === 'personal' ? '⭐ YOUR PLAYLIST' : '🏠 SERVER PLAYLIST');
      }

      if (sub === 'delete'){
        const { scope, pl } = await findPlaylist(ctx, opts.getString('name', true));
        if (scope === 'server'){
          if (pl.createdBy && pl.createdBy !== ctx.user.id && !ctx.isDJ) throw new UserError('Only the person who made it or a DJ can delete it.');
          await deleteServerPlaylist(ctx.guild.id, pl.name);
        } else {
          await deleteUserPlaylist(ctx.user.id, pl.name);
        }
        return say('ok', pl.name === LIKED_NAME ? '💔 Cleared your Liked Songs.' : `🗑️ Deleted **${escapeMd(pl.name)}**.`);
      }

      if (sub === 'load'){
        if (gp.settings.djOnly && !ctx.isDJ) throw new UserError('DJ-only mode is on, so only DJs can do that.');
        const { pl } = await findPlaylist(ctx, opts.getString('name', true));
        if (!pl.tracks.length) throw new UserError('That playlist is empty.');
        await joinUser(ctx);
        const tracks = [...pl.tracks];
        if (opts.getBoolean('shuffle')){
          for (let i = tracks.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
        }
        const res = await enqueueAndPlay(ctx, tracks, { playlistTitle: pl.name });
        return addedCard(gp, res);
      }
    }
  }
];
