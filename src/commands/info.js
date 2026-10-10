import { SlashCommandBuilder } from 'discord.js';

import { getStats } from '../store/stats.js';
import { helpView, statsView } from '../ui/messages.js';

export default [
  {
    data: new SlashCommandBuilder().setName('help').setDescription('Everything discodj can do'),
    execute: () => helpView()
  },
  {
    data: new SlashCommandBuilder().setName('stats').setDescription('Top songs and top DJs in this server'),
    ephemeral: false,
    async execute(ctx){
      return statsView(await getStats(ctx.guild.id), ctx.guild.name);
    }
  }
];
