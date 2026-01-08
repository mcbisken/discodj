// Minimal structured logger with consistent context fields.
// Usage: const log = createLogger({ service: 'discodj' }); log.info('startup', { guildId })

export function createLogger(base = {}){
  function emit(level, event, data){
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...base,
      ...(data || {})
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    debug: (event, data) => {
      if (process.env.LOG_LEVEL === 'debug') emit('debug', event, data);
    }
  };
}
