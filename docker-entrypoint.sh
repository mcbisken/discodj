#!/bin/sh
set -e
# Starts as root only long enough to make sure the data volume is writable (v2 ran as root,
# so existing files may be root-owned), then runs the bot as the unprivileged "node" user.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
