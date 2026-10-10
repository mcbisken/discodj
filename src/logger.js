// Minimal structured logger with consistent context fields.
// JSON lines by default (great for `docker compose logs`); LOG_FORMAT=pretty for humans.
// Usage: log.info('player.start', { guildId, title })

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function serialize(data){
  if (!data) return {};
  const out = {};
  for (const [k, v] of Object.entries(data)){
    if (v instanceof Error){
      out[k] = v.message;
      if (v.stack && k === 'err') out.stack = v.stack.split('\n').slice(0, 6).join('\n');
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(base = {}){
  const min = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  const pretty = String(process.env.LOG_FORMAT || '').toLowerCase() === 'pretty';

  function emit(level, event, data){
    if (LEVELS[level] < min) return;
    const fields = serialize(data);
    let line;
    if (pretty){
      const ts = new Date().toISOString().slice(11, 19);
      const { stack, ...rest } = fields;
      const extras = Object.entries({ ...rest }).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
      line = `${COLORS[level]}${ts} ${level.toUpperCase().padEnd(5)}\x1b[0m ${event} ${extras}${stack ? '\n' + stack : ''}`;
    } else {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields });
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (event, data) => emit('debug', event, data),
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    child: (extra) => createLogger({ ...base, ...extra })
  };
}

export const log = createLogger({ service: 'discodj' });
