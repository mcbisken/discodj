// Right-click a message → Apps → "Add to queue".
import { ApplicationCommandType, ContextMenuCommandBuilder } from 'discord.js';

import { UserError } from '../errors.js';
import { detectSource } from '../sources/track.js';
import { playCore } from './playback.js';

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

// Best playable thing in a message: a music link, then an audio/video attachment, then any link,
// then (for short messages) the text itself as a search.
export function extractPlayable(message){
  const urls = [
    ...(message.content?.match(URL_RE) || []),
    ...message.embeds.map(e => e.url).filter(Boolean)
  ].map(u => u.replace(/[)>.,!?]+$/, ''));
  const music = urls.find(u => detectSource(u) !== 'other');
  if (music) return music;
  const media = [...message.attachments.values()].find(a => /^(audio|video)\//.test(a.contentType || ''));
  if (media) return media.url;
  if (urls[0]) return urls[0];
  const textContent = String(message.content || '').trim();
  if (textContent && textContent.length <= 120 && !textContent.includes('\n')) return textContent;
  return null;
}

export default [
  {
    data: new ContextMenuCommandBuilder().setName('Add to queue').setType(ApplicationCommandType.Message),
    ephemeral: false,
    dj: true,
    voice: 'join',
    execute(ctx){
      const query = extractPlayable(ctx.interaction.targetMessage);
      if (!query) throw new UserError('That message has no link or song name I can play.');
      return playCore(ctx, query);
    }
  }
];
