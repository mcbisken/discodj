// A small wrapper around an interaction with the guild's player and consistent reply helpers.
import { MessageFlags } from 'discord.js';

import { isDJ } from '../util/permissions.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PINGS = { parse: [] };

export async function createContext(interaction, manager, { ephemeral = true } = {}){
  const gp = await manager.get(interaction.guildId);
  const member = interaction.member;
  const isComponent = interaction.isMessageComponent();

  const ctx = {
    interaction,
    manager,
    gp,
    member,
    client: interaction.client,
    guild: interaction.guild,
    channel: interaction.channel,
    user: interaction.user,
    isDJ: isDJ(interaction),
    requester: { id: interaction.user.id, name: member?.displayName || interaction.user.globalName || interaction.user.username },
    ephemeral,
    replied: false,
    // Components normally acknowledge with deferUpdate() (which targets the panel message), so
    // editReply is only safe after an explicit deferPrivate().
    deferredReply: !isComponent,

    async deferPrivate(){
      await interaction.deferReply({ flags: EPHEMERAL });
      ctx.deferredReply = true;
      ctx.ephemeral = true;
    },

    // Main reply. For deferred slash commands this fills in the "thinking…" message.
    async reply(payload, { autoDeleteMs } = {}){
      const body = { ...payload, allowedMentions: NO_PINGS };
      let msg;
      if (interaction.deferred && ctx.deferredReply && !ctx.replied){
        msg = await interaction.editReply(body);
      } else {
        const flagged = { ...body, flags: (body.flags || 0) | (ctx.ephemeral ? EPHEMERAL : 0) };
        msg = !interaction.deferred && !interaction.replied
          ? await interaction.reply({ ...flagged, withResponse: true }).then(r => r.resource?.message)
          : await interaction.followUp(flagged);
      }
      ctx.replied = true;
      if (autoDeleteMs && !ctx.ephemeral && msg){
        setTimeout(() => msg.delete().catch(() => {}), autoDeleteMs).unref?.();
      }
      return msg;
    },

    // Reply only the user can see, even if the command was deferred publicly.
    async replyPrivate(payload){
      const body = { ...payload, allowedMentions: NO_PINGS, flags: (payload.flags || 0) | EPHEMERAL };
      if (interaction.deferred && ctx.deferredReply && !ctx.replied){
        if (ctx.ephemeral){
          ctx.replied = true;
          return interaction.editReply({ ...payload, allowedMentions: NO_PINGS });
        }
        await interaction.deleteReply().catch(() => {});
      }
      ctx.replied = true;
      if (!interaction.deferred && !interaction.replied) return interaction.reply(body);
      return interaction.followUp(body);
    }
  };
  return ctx;
}
