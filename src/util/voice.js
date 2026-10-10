// Voice-channel rules shared by commands and panel buttons.
import { UserError } from '../errors.js';

// Makes sure the bot is in the user's voice channel, joining or moving if that's allowed.
export async function joinUser(ctx){
  const userCh = ctx.member?.voice?.channel;
  if (!userCh) throw new UserError('Join a voice channel first, then try again.');
  const gp = ctx.gp;
  const botCh = gp.connection ? gp.voiceChannel : null;
  if (botCh && botCh.id !== userCh.id){
    // Don't yank the bot away from people who are actively listening (DJs can).
    if (gp.isActive && gp.listeners().length > 0 && !ctx.isDJ){
      throw new UserError(`I'm already playing in ${botCh}. Come join!`);
    }
  }
  if (!botCh || botCh.id !== userCh.id || !gp.connection) await gp.connect(userCh);
  // Resolving a big playlist can take a while, so don't let the idle timer kick us out meanwhile.
  gp.touch();
  return userCh;
}

// For controls: if the bot is in a voice channel, you have to be in it too (DJs are exempt).
export function requireSameChannel(ctx){
  const gp = ctx.gp;
  const botCh = gp.connection ? gp.voiceChannel : null;
  if (!botCh || ctx.isDJ) return;
  if (ctx.member?.voice?.channelId !== botCh.id){
    throw new UserError(`You need to be in ${botCh} to control the music.`);
  }
}
