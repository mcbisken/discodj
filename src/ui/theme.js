// Colors and labels shared by every message the bot sends.
export const COLORS = {
  youtube: 0xFF0033,
  spotify: 0x1DB954,
  soundcloud: 0xFF5500,
  other: 0x5865F2,
  paused: 0x80848E,
  idle: 0x2B2D31,
  ok: 0x57F287,
  err: 0xED4245,
  warn: 0xFEE75C,
  info: 0x5865F2,
  brand: 0xA855F7
};

export const SOURCE = {
  youtube: { label: 'YouTube', dot: '🔴' },
  spotify: { label: 'Spotify', dot: '🟢' },
  soundcloud: { label: 'SoundCloud', dot: '🟠' },
  other: { label: 'Web', dot: '🌐' }
};

export const LOOP_LABEL = { off: 'Loop off', one: 'Looping song', all: 'Looping queue' };
export const LOOP_ICON = { off: '🔁', one: '🔂', all: '🔁' };
