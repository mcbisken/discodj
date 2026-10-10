// The Now Playing panel, built with Discord's Components V2 (containers, media galleries,
// sections). One panel per server; it's edited in place as things change.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, TextDisplayBuilder, ThumbnailBuilder
} from 'discord.js';

import { config } from '../config.js';
import { describeFilters, effectiveAudio, PRESETS, sanitizeFilters } from '../player/filters.js';
import { lineIndexAt } from '../sources/lyrics.js';
import { escapeMd, formatDuration, formatTime, link, plural, progressBar, truncate } from './format.js';
import { COLORS, LOOP_ICON, LOOP_LABEL, SOURCE } from './theme.js';

export const QUEUE_PAGE_SIZE = 8;
const S = ButtonStyle.Secondary;

const btn = (id, label, style = S, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(!!disabled);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const text = content => new TextDisplayBuilder().setContent(content);
const sep = (divider = true) => new SeparatorBuilder().setDivider(divider).setSpacing(SeparatorSpacingSize.Small);
const v2 = container => ({ components: [container], flags: MessageFlags.IsComponentsV2 });

export function statusLine(gp){
  const s = gp.settings;
  const bits = [`🔊 ${s.volume}%`];
  if (s.loop !== 'off') bits.push(`${LOOP_ICON[s.loop]} ${LOOP_LABEL[s.loop]}`);
  if (s.autoplay) bits.push('📻 Autoplay');
  if (s.stay247) bits.push('🌙 24/7');
  if (s.djOnly) bits.push('🎧 DJ only');
  const f = describeFilters(effectiveAudio(s));
  if (f.length) bits.push(f.join(' + '));
  if (gp.lastSponsorSkip && Date.now() - gp.lastSponsorSkip.at < 25_000){
    bits.push(`⏩ Skipped ${formatTime(gp.lastSponsorSkip.sec)} of non-music`);
  }
  return bits.join(' · ');
}

function lyricsBlock(gp){
  const l = gp.lyrics;
  if (!l || l.trackId !== gp.current?.id) return '-# 🎤 Looking for lyrics…';
  if (!l.data) return '-# 🎤 No lyrics found for this song.';
  if (l.data.instrumental) return '-# 🎤 Instrumental';
  const lines = l.data.synced;
  if (!lines?.length) return '-# 🎤 No synced lyrics for this one. Tap **📜 Lyrics** to read them.';
  // Small look-ahead because panel edits land a beat late.
  const i = lineIndexAt(lines, gp.elapsed() + 1.5);
  const show = idx => escapeMd(truncate(lines[idx]?.text || '♪', 120));
  if (i < 0) return `-# ${show(0)}`;
  return [i > 0 ? `-# ${show(i - 1)}` : null, `**🎤 ${show(i)}**`, lines[i + 1] ? `-# ${show(i + 1)}` : null].filter(Boolean).join('\n');
}

export function queueBlock(gp, page = 0){
  const q = gp.queue;
  const totalPages = Math.max(1, Math.ceil(q.length / QUEUE_PAGE_SIZE));
  const p = Math.max(0, Math.min(page, totalPages - 1));
  if (!q.length){
    const hint = gp.settings.autoplay && gp.current ? 'Queue is empty, so 📻 Autoplay will pick the next song.' : 'Queue is empty. Add songs with `/play`.';
    return { text: `-# ${hint}`, totalPages, page: p };
  }
  const totalSec = q.reduce((a, t) => a + (t.duration || 0), 0);
  const unknown = q.some(t => !t.duration && !t.isLive);
  const header = `**Up next** · ${plural(q.length, 'track')} · ${formatDuration(totalSec)}${unknown ? '+' : ''}`;
  const start = p * QUEUE_PAGE_SIZE;
  const lines = q.slice(start, start + QUEUE_PAGE_SIZE).map((t, i) => {
    const idx = start + i;
    const bits = [`\`${String(idx + 1).padStart(2, '0')}\` ${link(t.title, t.url, 58)}`];
    if (t.isLive) bits.push('`LIVE`');
    else if (t.duration) bits.push(`\`${formatTime(t.duration)}\``);
    const eta = gp.current ? gp.etaFor(idx) : null;
    if (eta != null && eta > 0) bits.push(`*in ${formatTime(eta)}*`);
    return bits.join(' · ');
  });
  return { text: [header, ...lines].join('\n'), totalPages, page: p };
}

function pagerRow(page, totalPages){
  return row(
    btn('pl:qprev', '◀', S, page <= 0),
    btn('pl:qpage', `Page ${page + 1} / ${totalPages}`, S, true),
    btn('pl:qnext', '▶', S, page >= totalPages - 1)
  );
}

function filterRow(gp){
  const active = sanitizeFilters(gp.settings.filters);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('pl:filters')
    .setPlaceholder('🎛️ Audio filters: off')
    .setMinValues(0)
    .setMaxValues(Object.keys(PRESETS).length)
    .addOptions(Object.entries(PRESETS).map(([key, p]) => new StringSelectMenuOptionBuilder()
      .setLabel(`${p.emoji} ${p.label}`)
      .setValue(key)
      .setDescription(p.desc)
      .setDefault(active.includes(key))));
  return row(menu);
}

function controlRows(gp, filterMode){
  const s = gp.settings;
  const paused = gp.isPaused;
  const busy = gp.loading;
  const live = !!gp.current?.isLive;
  return [
    row(
      btn('pl:prev', '⏮', S, !gp.history.length && !gp.current),
      btn('pl:toggle', paused ? '▶' : '⏸', paused ? ButtonStyle.Success : ButtonStyle.Primary, busy),
      btn('pl:skip', '⏭'),
      btn('pl:stop', '⏹', ButtonStyle.Danger),
      btn('pl:shuffle', '🔀', S, gp.queue.length < 2)
    ),
    row(
      btn('pl:back', '⏪ 15s', S, live || busy),
      btn('pl:fwd', '15s ⏩', S, live || busy),
      btn('pl:voldown', '🔉', S, s.volume <= 0),
      btn('pl:volup', '🔊', S, s.volume >= 200),
      btn('pl:loop', LOOP_ICON[s.loop], s.loop !== 'off' ? ButtonStyle.Success : S)
    ),
    row(
      btn('pl:autoplay', '📻 Autoplay', s.autoplay ? ButtonStyle.Success : S),
      btn('pl:lyrics', '📜 Lyrics'),
      btn('pl:live', '🎤 Live', s.liveLyrics ? ButtonStyle.Success : S),
      btn('pl:like', '❤️ Like')
    ),
    // AUDIO_FILTERS=commands|off hides the dropdown to keep the panel tidy.
    ...(filterMode === 'on' ? [filterRow(gp)] : [])
  ];
}

function idlePanel(gp, page){
  const c = new ContainerBuilder().setAccentColor(COLORS.idle);
  const title = gp.loading ? '### 📻 Finding something similar…' : '### 💤 Nothing playing';
  const hint = gp.queue.length
    ? `${plural(gp.queue.length, 'track')} waiting. Hit **▶ Play queue** to start.`
    : 'Use `/play` with a song name, or a YouTube, Spotify or SoundCloud link.';
  c.addTextDisplayComponents(text(`${title}\n${hint}`), text(`-# ${statusLine(gp)}`));
  if (gp.queue.length){
    c.addActionRowComponents(row(
      btn('pl:playq', '▶ Play queue', ButtonStyle.Success, gp.loading),
      btn('pl:shuffle', '🔀 Shuffle', S, gp.queue.length < 2),
      btn('pl:clear', '🗑️ Clear', ButtonStyle.Danger)
    ));
    c.addSeparatorComponents(sep());
    const q = queueBlock(gp, page);
    c.addTextDisplayComponents(text(q.text));
    if (q.totalPages > 1) c.addActionRowComponents(pagerRow(q.page, q.totalPages));
  }
  return v2(c);
}

export function buildPanel(gp, { page = 0, filterMode = config.audioFilters } = {}){
  const t = gp.current;
  if (!t) return idlePanel(gp, page);
  const s = gp.settings;
  const paused = gp.isPaused;
  const src = SOURCE[t.source] || SOURCE.other;

  const c = new ContainerBuilder().setAccentColor(paused ? COLORS.paused : (COLORS[t.source] ?? COLORS.other));

  let status = t.isLive ? '🔴 LIVE' : '🎶 NOW PLAYING';
  if (gp.loading) status = '⏳ LOADING';
  else if (paused) status = gp.pausedBy === 'alone' ? '⏸️ PAUSED · everyone left' : '⏸️ PAUSED';
  const header = `-# ${status}  ·  ${src.dot} ${src.label}`;
  const title = `### ${link(t.title, t.url, 120)}`;
  const byline = [
    t.author ? `**${escapeMd(truncate(t.author, 60))}**` : null,
    t.requester ? (t.requester.auto ? '📻 Autoplay pick' : `requested by <@${t.requester.id}>`) : null
  ].filter(Boolean).join(' · ');
  const headText = [header, title, byline].filter(Boolean).join('\n');

  const art = (gp.artwork?.trackId === t.id ? gp.artwork.url : null) || t.thumbnail;
  if (art && s.panelStyle === 'big'){
    c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(art).setDescription(truncate(t.title, 200))));
    c.addTextDisplayComponents(text(headText));
  } else if (art){
    c.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(text(headText))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(art)));
  } else {
    c.addTextDisplayComponents(text(headText));
  }

  const el = gp.elapsed();
  let prog;
  if (t.isLive) prog = '`🔴 LIVE`';
  else if (t.duration) prog = `\`${formatTime(el)}\`  ${progressBar(el, t.duration)}  \`${formatTime(t.duration)}\``;
  else prog = `\`${formatTime(el)}\``;
  c.addTextDisplayComponents(text(`${prog}\n-# ${statusLine(gp)}`));
  if (s.liveLyrics) c.addTextDisplayComponents(text(lyricsBlock(gp)));

  c.addSeparatorComponents(sep());
  c.addActionRowComponents(...controlRows(gp, filterMode));
  c.addSeparatorComponents(sep());

  const q = queueBlock(gp, page);
  c.addTextDisplayComponents(text(q.text));
  if (q.totalPages > 1) c.addActionRowComponents(pagerRow(q.page, q.totalPages));
  return v2(c);
}

export function restartingPanel(){
  const c = new ContainerBuilder().setAccentColor(COLORS.paused)
    .addTextDisplayComponents(text('### 🔄 Restarting…\nBe right back. I\'ll pick up the song where we left off.'));
  return v2(c);
}
