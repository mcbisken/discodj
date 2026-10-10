// Components V2 message templates (everything except the main panel).
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SectionBuilder, SeparatorBuilder,
  SeparatorSpacingSize, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextDisplayBuilder, ThumbnailBuilder
} from 'discord.js';

import { describeFilters } from '../player/filters.js';
import { escapeMd, formatDuration, formatTime, link, plural, progressBar, truncate } from './format.js';
import { COLORS, LOOP_LABEL, SOURCE } from './theme.js';

export const V2 = MessageFlags.IsComponentsV2;
const text = c => new TextDisplayBuilder().setContent(c);
const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const payload = (container, extra = {}) => ({ components: [container], flags: V2, ...extra });

function headed(content, thumb){
  if (!thumb) return text(content);
  return new SectionBuilder().addTextDisplayComponents(text(content)).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb));
}
function addBlock(c, block){
  if (block instanceof SectionBuilder) c.addSectionComponents(block);
  else c.addTextDisplayComponents(block);
}

/* ---- simple notices ---- */
const ICON = { ok: '✅', err: '❌', warn: '⚠️', info: 'ℹ️' };
export function notice(kind, content){
  const c = new ContainerBuilder().setAccentColor(COLORS[kind] ?? COLORS.info)
    .addTextDisplayComponents(text(`${ICON[kind] ? ICON[kind] + ' ' : ''}${content}`));
  return payload(c);
}
export const ok = s => notice('ok', s);
export const err = s => notice('err', s);
export const warn = s => notice('warn', s);
export const info = s => notice('info', s);
// Same look, but the text brings its own emoji.
export function say(kind, content){
  return payload(new ContainerBuilder().setAccentColor(COLORS[kind] ?? COLORS.info).addTextDisplayComponents(text(content)));
}

/* ---- added to queue ---- */
export function addedCard(gp, { tracks, playlistTitle, index, startedNow, truncated, skipped }){
  const first = tracks[0];
  const c = new ContainerBuilder().setAccentColor(COLORS[first.source] ?? COLORS.other);
  let content;
  if (tracks.length === 1){
    const head = startedNow ? '-# ▶️ NOW PLAYING' : `-# ✅ ADDED TO QUEUE  ·  #${index + 1}`;
    const bits = [];
    if (first.isLive) bits.push('🔴 Live');
    else if (first.duration) bits.push(`⏱️ ${formatTime(first.duration)}`);
    if (first.author) bits.push(escapeMd(truncate(first.author, 50)));
    const eta = !startedNow ? gp.etaFor(index) : null;
    if (eta != null && eta > 0) bits.push(`plays in ~${formatTime(eta)}`);
    content = `${head}\n**${link(first.title, first.url, 100)}**\n-# ${bits.join(' · ')}`;
  } else {
    const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
    const head = `-# ✅ ADDED ${tracks.length} TRACKS${startedNow ? '  ·  ▶️ STARTING NOW' : ''}`;
    content = `${head}\n**${escapeMd(truncate(playlistTitle || 'Playlist', 100))}**\n-# ${total ? formatDuration(total) + ' · ' : ''}starts with ${link(first.title, first.url, 60)}`;
    if (truncated) content += `\n-# ${truncated} more didn't fit in the queue.`;
  }
  if (skipped) content += `\n-# Skipped ${plural(skipped, 'song')} that ${skipped === 1 ? 'was' : 'were'} already queued.`;
  addBlock(c, headed(content, first.thumbnail));
  return payload(c);
}

/* ---- now playing (standalone card for /nowplaying) ---- */
export function nowPlayingCard(gp){
  const t = gp.current;
  const src = SOURCE[t.source] || SOURCE.other;
  const c = new ContainerBuilder().setAccentColor(gp.isPaused ? COLORS.paused : (COLORS[t.source] ?? COLORS.other));
  const el = gp.elapsed();
  const prog = t.isLive ? '`🔴 LIVE`' : t.duration ? `\`${formatTime(el)}\`  ${progressBar(el, t.duration, 14)}  \`${formatTime(t.duration)}\`` : `\`${formatTime(el)}\``;
  const by = t.requester ? (t.requester.auto ? '📻 Autoplay pick' : `requested by <@${t.requester.id}>`) : '';
  addBlock(c, headed(`-# ${gp.isPaused ? '⏸️ PAUSED' : '🎶 NOW PLAYING'}  ·  ${src.dot} ${src.label}\n### ${link(t.title, t.url, 120)}\n${t.author ? `**${escapeMd(t.author)}** · ` : ''}${by}`, t.thumbnail));
  c.addTextDisplayComponents(text(prog));
  const next = gp.queue[0];
  if (next) c.addTextDisplayComponents(text(`-# Up next: ${link(next.title, next.url, 70)}`));
  return payload(c);
}

/* ---- help ---- */
export function helpView(){
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  c.addTextDisplayComponents(text('## 🎶 discodj\nYouTube, Spotify, SoundCloud and 1000+ sites. Paste a link or just type a song name.'));
  c.addSeparatorComponents(sep());
  const sections = [
    ['▶️ Playback', '`/play` song or link · `/search` pick from results · `/pause` `/resume` `/skip` `/prev` `/stop`\n`/seek 1:23` (or `+30`, `-15`) · `/nowplaying` · `/lyrics` · `/join` `/leave`'],
    ['📋 Queue', '`/queue` show the panel · `/remove 3` or `/remove 3-7` · `/move` · `/jump` · `/shuffle` · `/clear`\n`/dedupe` remove duplicates · `/removeuser` · `/history` replay recent songs'],
    ['💾 Playlists', '`/playlist save|load|show|delete|list|import`, for the server or just for you\n❤️ **Like** on the panel saves to your personal *Liked Songs*'],
    ['🎛️ Sound', '`/volume` · `/filter` (stackable) · `/speed` · `/pitch` · `/loop` · `/autoplay`'],
    ['⚙️ Server', '`/settings` 24/7, normalization, SponsorBlock, vote-skip, panel style, DJ-only · `/stats`'],
    ['🖱️ Tip', 'Right-click any message with a link → **Apps → Add to queue**']
  ];
  c.addTextDisplayComponents(text(sections.map(([h, b]) => `**${h}**\n${b}`).join('\n\n')));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text('-# Most controls live on the player panel. Non-DJs vote to skip when others are listening.'));
  return payload(c);
}

/* ---- lyrics ---- */
export const LYRICS_PAGE_CHARS = 3000;

export function lyricsPages(textBody){
  const lines = String(textBody || '').split('\n');
  const pages = [];
  let cur = '';
  for (const line of lines){
    if ((cur + '\n' + line).length > LYRICS_PAGE_CHARS && cur){ pages.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) pages.push(cur);
  return pages.length ? pages : [''];
}

export function lyricsView({ title, artist, pages, page, token, thumbnail }){
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  addBlock(c, headed(`-# 📜 LYRICS\n### ${escapeMd(truncate(title, 100))}${artist ? `\n**${escapeMd(artist)}**` : ''}`, thumbnail));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(escapeMd(pages[page]) || '*(empty)*'));
  c.addTextDisplayComponents(text('-# Lyrics from LRCLIB'));
  if (pages.length > 1){
    c.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ly:${token}:${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId('ly:noop').setLabel(`${page + 1} / ${pages.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`ly:${token}:${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages.length - 1)
    ));
  }
  return payload(c);
}

/* ---- search picker ---- */
export function searchView(query, results, token){
  const c = new ContainerBuilder().setAccentColor(COLORS.youtube);
  c.addTextDisplayComponents(text(`-# 🔎 SEARCH\n### ${escapeMd(truncate(query, 80))}\nPick one or more songs to queue:`));
  const lines = results.map((r, i) => `\`${i + 1}\` ${link(r.title, r.url, 70)}${r.duration ? ` · \`${formatTime(r.duration)}\`` : r.isLive ? ' · `LIVE`' : ''}${r.author ? `\n-# ${escapeMd(truncate(r.author, 60))}` : ''}`);
  c.addTextDisplayComponents(text(lines.join('\n')));
  const menu = new StringSelectMenuBuilder().setCustomId(`sr:${token}`).setPlaceholder('Choose songs to add…').setMinValues(1).setMaxValues(results.length)
    .addOptions(results.map((r, i) => new StringSelectMenuOptionBuilder()
      .setLabel(truncate(`${i + 1}. ${r.title}`, 100))
      .setDescription(truncate([r.author, r.isLive ? 'LIVE' : r.duration ? formatTime(r.duration) : null].filter(Boolean).join(' · ') || 'YouTube', 100))
      .setValue(String(i))));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  return payload(c);
}

/* ---- history ---- */
export function historyView(gp, token){
  const items = gp.history.slice(-20).reverse();
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  if (!items.length){
    c.addTextDisplayComponents(text('### 🕘 Recently played\nNothing yet. Play something first!'));
    return payload(c);
  }
  const lines = items.map((t, i) => `\`${String(i + 1).padStart(2, '0')}\` ${link(t.title, t.url, 70)}${t.duration ? ` · \`${formatTime(t.duration)}\`` : ''}`);
  c.addTextDisplayComponents(text(`### 🕘 Recently played\n${lines.join('\n')}`));
  const menu = new StringSelectMenuBuilder().setCustomId(`hi:${token}`).setPlaceholder('Replay songs…').setMinValues(1).setMaxValues(items.length)
    .addOptions(items.map((t, i) => new StringSelectMenuOptionBuilder().setLabel(truncate(`${i + 1}. ${t.title}`, 100)).setValue(String(i))));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(menu));
  return payload(c);
}

/* ---- stats ---- */
export function statsView(stats, guildName){
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  const since = Math.floor((stats.since || Date.now()) / 1000);
  c.addTextDisplayComponents(text(`## 📊 ${escapeMd(guildName)} stats\n-# Since <t:${since}:D> · ${plural(stats.totalPlays, 'play')} · ${formatDuration(stats.totalSec)} listened · ${plural(stats.uniqueTracks, 'unique song')}`));
  c.addSeparatorComponents(sep());
  const medal = i => ['🥇', '🥈', '🥉'][i] || `\`${i + 1}.\``;
  const tracks = stats.topTracks.length ? stats.topTracks.map((t, i) => `${medal(i)} ${link(t.title, t.url, 60)} · **${t.plays}**`).join('\n') : '*No plays yet*';
  const users = stats.topUsers.length ? stats.topUsers.map((u, i) => `${medal(i)} <@${u.id}> · **${plural(u.plays, 'song')}** · ${formatDuration(u.sec)}`).join('\n') : '*No one yet*';
  c.addTextDisplayComponents(text(`**🔥 Top songs**\n${tracks}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`**🎧 Top DJs**\n${users}`));
  return payload(c);
}

/* ---- playlists ---- */
export function playlistsView(server, personal){
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  const fmt = p => `${p.liked ? '❤️' : '•'} **${escapeMd(p.name)}** · ${plural(p.count, 'track')}${p.savedAt ? ` · <t:${Math.floor(p.savedAt / 1000)}:R>` : ''}`;
  c.addTextDisplayComponents(text('## 💾 Playlists'));
  c.addTextDisplayComponents(text(`**🏠 Server**\n${server.length ? server.map(fmt).join('\n') : '-# None yet. `/playlist save` creates one.'}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(`**⭐ Yours**\n${personal.length ? personal.map(fmt).join('\n') : '-# None yet. Tap ❤️ **Like** on the panel, or `/playlist save scope:personal`.'}`));
  return payload(c);
}

export function playlistView(pl, scopeLabel){
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  const total = pl.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const lines = pl.tracks.slice(0, 25).map((t, i) => `\`${String(i + 1).padStart(2, '0')}\` ${link(t.title, t.url, 70)}${t.duration ? ` · \`${formatTime(t.duration)}\`` : ''}`);
  if (pl.tracks.length > 25) lines.push(`-# …and ${pl.tracks.length - 25} more`);
  c.addTextDisplayComponents(text(`-# ${scopeLabel}\n## ${escapeMd(pl.name)}\n-# ${plural(pl.count, 'track')}${total ? ' · ' + formatDuration(total) : ''}`));
  c.addSeparatorComponents(sep());
  c.addTextDisplayComponents(text(lines.join('\n') || '*Empty*'));
  return payload(c);
}

/* ---- settings ---- */
export function settingsView(gp){
  const s = gp.settings;
  const on = v => (v ? '`ON`' : '`OFF`');
  const c = new ContainerBuilder().setAccentColor(COLORS.brand);
  c.addTextDisplayComponents(text('## ⚙️ Settings'));
  c.addTextDisplayComponents(text([
    `🔊 **Volume** \`${s.volume}%\``,
    `🔁 **Loop** \`${LOOP_LABEL[s.loop]}\``,
    `📻 **Autoplay** ${on(s.autoplay)}: plays similar songs when the queue ends`,
    `🎛️ **Filters** ${describeFilters(s).join(' + ') || '`none`'}`,
    `📏 **Normalize volume** ${on(s.normalize)}: evens out loud and quiet songs`,
    `⏩ **SponsorBlock** ${on(s.sponsorblock)}: skips non-music parts of music videos`,
    `🗳️ **Vote skip** ${on(s.voteSkip)}: non-DJs vote to skip when others are listening`,
    `🌙 **24/7** ${on(s.stay247)}: never leave the voice channel`,
    `🎤 **Live lyrics** ${on(s.liveLyrics)}: shows the current line on the panel`,
    `🖼️ **Panel style** \`${s.panelStyle}\``,
    `🎧 **DJ only** ${on(s.djOnly)}: only DJs can control playback`
  ].join('\n')));
  c.addTextDisplayComponents(text('-# Change with `/settings <option>`. DJs are admins, Manage Server/Channels, the DJ_ROLE_ID role, or anyone with a role named "DJ".'));
  return payload(c);
}

/* ---- duplicate prompt ---- */
export function dupPrompt(track, token){
  const c = new ContainerBuilder().setAccentColor(COLORS.warn);
  c.addTextDisplayComponents(text(`⚠️ **${link(track.title, track.url, 90)}** is already in the queue. Add it again?`));
  c.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dd:${token}:add`).setLabel('Add anyway').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dd:${token}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  ));
  return payload(c);
}

/* ---- vote skip ---- */
export function voteView(votes, needed, title){
  const c = new ContainerBuilder().setAccentColor(COLORS.warn);
  c.addTextDisplayComponents(text(`🗳️ **Vote to skip** ${link(title, null, 80)}\n${'🟩'.repeat(votes)}${'⬛'.repeat(Math.max(0, needed - votes))}  **${votes} / ${needed}**\n-# Use \`/skip\` or the ⏭ button to vote.`));
  return payload(c);
}
