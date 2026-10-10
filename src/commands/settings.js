import { SlashCommandBuilder } from 'discord.js';

import { UserError } from '../errors.js';
import { describeFilters, PRESETS } from '../player/filters.js';
import { LOOP_LABEL } from '../ui/theme.js';
import { say, settingsView } from '../ui/messages.js';

const onOff = v => (v ? '**on**' : '**off**');
const boolOpt = (o, desc) => o.setName('on').setDescription(desc).setRequired(true);

export default [
  {
    data: new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Set the volume')
      .addIntegerOption(o => o.setName('percent').setDescription('0–200 (100 = normal)').setRequired(true).setMinValue(0).setMaxValue(200)),
    dj: true,
    voice: 'same',
    execute(ctx){
      const v = ctx.gp.setVolume(ctx.interaction.options.getInteger('percent', true));
      return say('ok', `${v === 0 ? '🔇' : v < 50 ? '🔈' : v < 120 ? '🔉' : '🔊'} Volume set to **${v}%**.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('loop')
      .setDescription('Loop the song or the whole queue')
      .addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true).addChoices(
        { name: 'Off', value: 'off' }, { name: 'This song', value: 'one' }, { name: 'Whole queue', value: 'all' }
      )),
    dj: true,
    voice: 'same',
    execute(ctx){
      const mode = ctx.interaction.options.getString('mode', true);
      ctx.gp.setLoop(mode);
      return say('ok', `${mode === 'one' ? '🔂' : '🔁'} ${LOOP_LABEL[mode]}.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('autoplay')
      .setDescription('Keep playing similar songs when the queue ends')
      .addBooleanOption(o => o.setName('on').setDescription('Leave empty to toggle')),
    dj: true,
    execute(ctx){
      const v = ctx.interaction.options.getBoolean('on') ?? !ctx.gp.settings.autoplay;
      ctx.gp.setSetting('autoplay', v);
      return say('ok', `📻 Autoplay is ${onOff(v)}.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('filter')
      .setDescription('Toggle an audio filter (they stack!)')
      .addStringOption(o => o.setName('name').setDescription('Filter to toggle').setRequired(true).addChoices(
        { name: '❌ Turn all filters off', value: 'off' },
        ...Object.entries(PRESETS).map(([value, p]) => ({ name: `${p.emoji} ${p.label}: ${p.desc}`.slice(0, 100), value }))
      )),
    dj: true,
    voice: 'same',
    async execute(ctx){
      const name = ctx.interaction.options.getString('name', true);
      if (name === 'off') await ctx.gp.setFilters([]);
      else await ctx.gp.toggleFilter(name);
      const now = describeFilters(ctx.gp.settings);
      return say('ok', `🎛️ Filters: ${now.length ? now.join(' + ') : '**off**'}`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('speed')
      .setDescription('Change playback speed without changing pitch')
      .addNumberOption(o => o.setName('value').setDescription('0.5–2.0 (1 = normal)').setRequired(true).setMinValue(0.5).setMaxValue(2)),
    dj: true,
    voice: 'same',
    async execute(ctx){
      const v = Math.round(ctx.interaction.options.getNumber('value', true) * 100) / 100;
      await ctx.gp.setAudioOption('speed', v);
      return say('ok', `⏩ Speed set to **${v}x**.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('pitch')
      .setDescription('Change pitch without changing speed')
      .addNumberOption(o => o.setName('value').setDescription('0.5–2.0 (1 = normal)').setRequired(true).setMinValue(0.5).setMaxValue(2)),
    dj: true,
    voice: 'same',
    async execute(ctx){
      const v = Math.round(ctx.interaction.options.getNumber('value', true) * 100) / 100;
      await ctx.gp.setAudioOption('pitch', v);
      return say('ok', `🎼 Pitch set to **${v}x**.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('djonly')
      .setDescription('Only let DJs control the music')
      .addBooleanOption(o => boolOpt(o, 'On or off')),
    djAlways: true,
    execute(ctx){
      const v = ctx.interaction.options.getBoolean('on', true);
      ctx.gp.setSetting('djOnly', v);
      return say('ok', `🎧 DJ-only mode is ${onOff(v)}.`);
    }
  },
  {
    data: new SlashCommandBuilder()
      .setName('settings')
      .setDescription('View or change server settings')
      .addSubcommand(s => s.setName('view').setDescription('Show all settings'))
      .addSubcommand(s => s.setName('247').setDescription('Stay in the voice channel 24/7').addBooleanOption(o => boolOpt(o, 'On or off')))
      .addSubcommand(s => s.setName('normalize').setDescription('Even out loud and quiet songs').addBooleanOption(o => boolOpt(o, 'On or off')))
      .addSubcommand(s => s.setName('sponsorblock').setDescription('Skip non-music parts of music videos').addBooleanOption(o => boolOpt(o, 'On or off')))
      .addSubcommand(s => s.setName('voteskip').setDescription('Non-DJs vote to skip when others are listening').addBooleanOption(o => boolOpt(o, 'On or off')))
      .addSubcommand(s => s.setName('livelyrics').setDescription('Show the current lyric line on the panel').addBooleanOption(o => boolOpt(o, 'On or off')))
      .addSubcommand(s => s.setName('panel').setDescription('Panel look').addStringOption(o => o.setName('style').setDescription('Big artwork or compact').setRequired(true).addChoices(
        { name: '🖼️ Big artwork', value: 'big' }, { name: '📏 Compact', value: 'compact' }
      ))),
    async execute(ctx){
      const sub = ctx.interaction.options.getSubcommand();
      const gp = ctx.gp;
      if (sub === 'view') return settingsView(gp);

      // 24/7 and vote-skip affect everyone, so they're always DJ-only. The rest follow DJ-only mode.
      if ((sub === '247' || sub === 'voteskip') && !ctx.isDJ) throw new UserError('Only DJs can change that.');
      if (gp.settings.djOnly && !ctx.isDJ) throw new UserError('DJ-only mode is on, so only DJs can change settings.');

      if (sub === 'panel'){
        const style = ctx.interaction.options.getString('style', true);
        gp.setSetting('panelStyle', style);
        return say('ok', `🖼️ Panel style: **${style}**.`);
      }
      const v = ctx.interaction.options.getBoolean('on', true);
      switch (sub){
        case '247': gp.setSetting('stay247', v); return say('ok', `🌙 24/7 mode is ${onOff(v)}.${v ? ' I\'ll stay in the channel.' : ''}`);
        case 'normalize': await gp.setAudioOption('normalize', v); return say('ok', `📏 Volume normalization is ${onOff(v)}.`);
        case 'sponsorblock': gp.setSetting('sponsorblock', v); return say('ok', `⏩ SponsorBlock is ${onOff(v)}.`);
        case 'voteskip': gp.setSetting('voteSkip', v); return say('ok', `🗳️ Vote skip is ${onOff(v)}.`);
        case 'livelyrics': gp.setSetting('liveLyrics', v); return say('ok', `🎤 Live lyrics are ${onOff(v)}.`);
      }
    }
  }
];
