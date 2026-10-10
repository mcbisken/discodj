// discodj entrypoint: boot checks, Discord client, event wiring and graceful shutdown.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';

import { generateDependencyReport } from '@discordjs/voice';
import { Client, Events, GatewayIntentBits, Routes } from 'discord.js';

import { commandPayload, handleAutocomplete, handleCommand } from './commands/index.js';
import { config } from './config.js';
import { handleComponent } from './interactions/components.js';
import { log } from './logger.js';
import { PlayerManager } from './player/manager.js';
import { detectFeatures, selfUpdate } from './sources/ytdlp.js';
import { flushWrites } from './store/json.js';
import { flushStats } from './store/stats.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!config.token){
  log.error('startup.missing_token', { hint: 'Set DISCORD_TOKEN in your .env file (see .env.example).' });
  process.exit(1);
}

log.info('startup.begin', { version: pkg.version, node: process.version });
log.debug('voice.dependency_report', { report: generateDependencyReport() });
await fs.mkdir(config.dataDir, { recursive: true });

/* ---- external tools ---- */
function checkFfmpeg(){
  return new Promise(resolve => {
    const p = spawn(config.ffmpegPath, ['-version'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', code => resolve(code === 0 ? out.split('\n')[0] : null));
  });
}

const ffmpegVersion = await checkFfmpeg();
if (ffmpegVersion) log.info('ffmpeg.detected', { version: ffmpegVersion.replace(/^ffmpeg version\s*/, '').split(' ')[0] });
else log.error('ffmpeg.missing', { hint: 'Install ffmpeg and make sure it\'s in PATH (or set FFMPEG_PATH). Nothing will play without it.' });

await detectFeatures();
if (config.ytdlp.autoUpdate){
  // Stale yt-dlp is the #1 cause of YouTube playback failures, so update at boot and daily.
  selfUpdate();
  setInterval(selfUpdate, 24 * 3600e3).unref();
}

/* ---- Discord ---- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const manager = new PlayerManager(client);

async function registerCommands(c){
  const body = commandPayload();
  try {
    if (config.guildIds.length){
      for (const gid of config.guildIds) await c.rest.put(Routes.applicationGuildCommands(c.user.id, gid), { body });
      log.info('commands.registered', { scope: 'guild', guilds: config.guildIds, count: body.length });
    } else {
      await c.rest.put(Routes.applicationCommands(c.user.id), { body });
      log.info('commands.registered', { scope: 'global', count: body.length, note: 'global commands can take a few minutes to appear' });
    }
  } catch (e){
    log.error('commands.register_failed', { err: e, detail: JSON.stringify(e.rawError?.errors || {}).slice(0, 2000) });
  }
}

function startHeartbeat(){
  if (!config.healthFile) return;
  const beat = () => { if (client.isReady()) fs.writeFile(config.healthFile, String(Date.now())).catch(() => {}); };
  beat();
  setInterval(beat, 30_000).unref();
}

client.once(Events.ClientReady, async c => {
  log.info('startup.ready', { user: c.user.tag, guilds: c.guilds.cache.size });
  await registerCommands(c);
  await manager.loadAll(c.guilds.cache.keys());
  manager.updatePresence();
  // Panels left over from before the restart: show the real (idle) state instead of a frozen one.
  for (const gp of manager.players.values()) if (gp.panel.ref && !gp.session) gp.panel.refresh({ immediate: true });
  await manager.restoreSessions();
  startHeartbeat();
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction, manager);
    if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand()) return await handleCommand(interaction, manager);
    if (interaction.isButton() || interaction.isStringSelectMenu()) return await handleComponent(interaction, manager);
  } catch (e){
    log.error('interaction.unhandled', { err: e });
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const gp = manager.peek(newState.guild.id);
  if (!gp) return;
  if (newState.id === client.user.id){
    // We were moved: refresh the channel status and re-check who's listening.
    if (oldState.channelId !== newState.channelId && newState.channelId){
      gp.updateVoiceStatus();
      gp.onVoiceStateChange();
      gp.panel.refresh();
    }
    return;
  }
  const botChannel = gp.voiceChannelId;
  if (botChannel && (oldState.channelId === botChannel || newState.channelId === botChannel)) gp.onVoiceStateChange();
});

client.on(Events.GuildCreate, g => { manager.get(g.id).catch(() => {}); });
client.on(Events.GuildDelete, g => manager.remove(g.id));
client.on(Events.Error, e => log.error('client.error', { err: e }));
client.on(Events.Warn, m => log.warn('client.warn', { message: m }));
client.on(Events.ShardDisconnect, (ev, id) => log.warn('gateway.disconnected', { shard: id, code: ev?.code }));
client.on(Events.ShardResume, id => log.info('gateway.resumed', { shard: id }));

/* ---- lifecycle ---- */
let shuttingDown = false;
async function shutdown(reason, code = 0){
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn('shutdown.start', { reason });
  setTimeout(() => process.exit(code), 9000).unref(); // never hang (Docker sends SIGKILL at 10s)
  try { await manager.shutdown(); } catch (e){ log.error('shutdown.players_failed', { err: e }); }
  try { await flushStats(); await flushWrites(); } catch {}
  try { await client.destroy(); } catch {}
  log.info('shutdown.done');
  process.exit(code);
}

// Stream hiccups that are safe to shrug off. Anything else means the process state is suspect:
// save everything and exit, and Docker restarts us and resumes the music.
const BENIGN = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => log.error('process.unhandled_rejection', { err: e }));
process.on('uncaughtException', e => {
  if (BENIGN.has(e?.code)){ log.warn('process.benign_exception', { err: e }); return; }
  log.error('process.uncaught_exception', { err: e });
  shutdown('uncaughtException', 1);
});

try {
  await client.login(config.token);
} catch (e){
  const hint = /TokenInvalid|invalid token/i.test(`${e.code} ${e.message}`)
    ? 'DISCORD_TOKEN is wrong. Copy it again from the Developer Portal (Bot → Reset Token).'
    : /disallowed intents/i.test(e.message) ? 'The bot is asking for intents it isn\'t allowed. Check the Developer Portal.' : undefined;
  log.error('startup.login_failed', { err: e, hint });
  process.exit(1);
}
