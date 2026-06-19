#!/usr/bin/env sh
# Stop the local dev proxy started by `npm run dev` (nodemon index.js).
# Safe to run anytime — it no-ops if nothing is running.
#
#   npm run dev:stop          # stops the watcher + the server on $PORT (default 3000)
#   PORT=4000 npm run dev:stop
#
# Scoped to THIS proxy: the watcher is matched by this repo's path so other
# projects' nodemon processes are left alone; the server is matched by its port.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT="${PORT:-3000}"

# 1) Stop this repo's nodemon first, so it can't respawn the server.
if pkill -f "$ROOT/node_modules/.bin/nodemon" 2>/dev/null; then
  echo "Stopped nodemon watcher."
fi

# 2) Free the port (the running server, if still up).
PIDS=$(lsof -ti "tcp:$PORT" 2>/dev/null)
if [ -n "$PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null
  echo "Stopped server on port $PORT (pids: $PIDS)."
else
  echo "Nothing listening on port $PORT."
fi
