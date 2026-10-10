// Command registry + dispatcher. Each command module exports an array of:
//   { data, execute(ctx), autocomplete?(ctx), ephemeral?: bool (default true),
//     dj?: bool (blocked for non-DJs when DJ-only mode is on), djAlways?: bool,
//     voice?: 'join' (bot joins your channel) | 'same' (you must be in the bot's channel)
//            | 'play' (join if disconnected, else same) }
import { InteractionContextType, MessageFlags } from 'discord.js';

import { isUnknownInteraction, UserError } from '../errors.js';
import { createContext } from '../interactions/context.js';
import { log } from '../logger.js';
import { err } from '../ui/messages.js';
import { joinUser, requireSameChannel } from '../util/voice.js';
import context from './context.js';
import info from './info.js';
import playback from './playback.js';
import playlist from './playlist.js';
import queue from './queue.js';
import settings from './settings.js';

export const commands = [...playback, ...queue, ...playlist, ...settings, ...info, ...context];
const byName = new Map(commands.map(c => [c.data.name, c]));

export function commandPayload(){
  return commands.map(c => {
    if (typeof c.data.setContexts === 'function') c.data.setContexts(InteractionContextType.Guild);
    return c.data.toJSON();
  });
}

export async function replyError(ctx, e, where){
  if (isUnknownInteraction(e)) return;
  const friendly = e instanceof UserError;
  if (!friendly) log.error('interaction.failed', { where, guildId: ctx.interaction.guildId, userId: ctx.user?.id, err: e, detail: e.detail });
  const message = friendly ? e.message : 'Something went wrong on my end. Try again, and if it keeps happening, check the bot logs.';
  try {
    await ctx.replyPrivate(err(message));
  } catch (e2){
    if (!isUnknownInteraction(e2)) log.debug('interaction.error_reply_failed', { err: e2 });
  }
}

async function gate(ctx, cmd){
  if (cmd.djAlways && !ctx.isDJ) throw new UserError('Only DJs can change that.');
  if (cmd.dj && ctx.gp.settings.djOnly && !ctx.isDJ) throw new UserError('DJ-only mode is on, so only DJs can do that.');
  if (cmd.voice === 'join') await joinUser(ctx);
  else if (cmd.voice === 'same') requireSameChannel(ctx);
  else if (cmd.voice === 'play'){
    // Starts playback: join if we're not connected, otherwise you must be with the bot.
    if (!ctx.gp.connection) await joinUser(ctx);
    else requireSameChannel(ctx);
  }
}

export async function handleCommand(interaction, manager){
  const cmd = byName.get(interaction.commandName);
  if (!cmd) return;
  if (!interaction.inGuild()){
    return interaction.reply({ ...err('I only work inside servers.'), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }).catch(() => {});
  }
  const ephemeral = cmd.ephemeral !== false;
  try {
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  } catch (e){
    if (isUnknownInteraction(e)) return; // took >3s to reach us (rare, usually a laggy host)
    throw e;
  }
  const ctx = await createContext(interaction, manager, { ephemeral });
  try {
    await gate(ctx, cmd);
    const result = await cmd.execute(ctx);
    if (result && !ctx.replied) await ctx.reply(result);
    else if (!ctx.replied) await interaction.deleteReply().catch(() => {});
  } catch (e){
    await replyError(ctx, e, `/${interaction.commandName}`);
  }
}

export async function handleAutocomplete(interaction, manager){
  const cmd = byName.get(interaction.commandName);
  if (!cmd?.autocomplete || !interaction.inGuild()) return interaction.respond([]).catch(() => {});
  try {
    const gp = await manager.get(interaction.guildId);
    const choices = await cmd.autocomplete({ interaction, gp, focused: interaction.options.getFocused(true) });
    await interaction.respond((choices || []).slice(0, 25));
  } catch (e){
    if (!isUnknownInteraction(e)) log.debug('autocomplete.failed', { command: interaction.commandName, err: e });
    await interaction.respond([]).catch(() => {});
  }
}
