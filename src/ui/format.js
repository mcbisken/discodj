// Text formatting helpers for Discord markdown.

export function formatTime(sec){
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function formatDuration(sec){
  if (!Number.isFinite(sec) || sec <= 0) return '0m';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}

export function progressBar(elapsed, total, slots = 16){
  if (!Number.isFinite(total) || total <= 0) return '';
  const filled = Math.max(0, Math.min(slots, Math.round((elapsed / total) * slots)));
  return '▰'.repeat(filled) + '▱'.repeat(slots - filled);
}

export function truncate(s, n){
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1).trimEnd() + '…' : str;
}

// Escapes markdown so song titles like "*NSYNC" or "[Live]" render literally.
export function escapeMd(s){
  return String(s ?? '')
    .replace(/([\\*_~`|[\]<>])/g, '\\$1')
    .replace(/^([#>-])/gm, '\\$1')
    .replace(/(https?):\/\//g, '$1\u200b://'); // stop raw URLs inside titles from becoming links
}

export function safeUrl(url){
  return String(url || '').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

export function link(title, url, max = 80){
  const text = escapeMd(truncate(title, max));
  return url ? `[${text}](${safeUrl(url)})` : text;
}

export function plural(n, word, pluralWord = word + 's'){
  return `${n} ${n === 1 ? word : pluralWord}`;
}

// Accepts "1:23", "83", "1m30s", "+15", "-10" → { seconds, relative }
export function parseTimeInput(input){
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;
  const sign = raw[0] === '+' ? 1 : raw[0] === '-' ? -1 : 0;
  const body = sign ? raw.slice(1).trim() : raw;
  let seconds = null;
  if (/^\d+(:\d{1,2}){0,2}$/.test(body)){
    seconds = body.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  } else {
    const m = body.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/);
    if (m && (m[1] || m[2] || m[3])) seconds = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return { seconds: sign ? sign * seconds : seconds, relative: !!sign };
}

// "3" → [2, 2], "3-7" → [2, 6] (0-based, inclusive), or null.
export function parseRange(input){
  const m = String(input || '').trim().match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
  if (!m) return null;
  const a = parseInt(m[1], 10) - 1;
  const b = m[2] ? parseInt(m[2], 10) - 1 : a;
  return a >= 0 && b >= a ? [a, b] : null;
}

export function requesterName(t){
  if (!t?.requester) return null;
  return t.requester.auto ? 'Autoplay' : t.requester.name;
}
