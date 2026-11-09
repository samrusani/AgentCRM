#!/bin/bash
# Starts AgentCRM for daily use: the dev server (API on port 4720, which the browser
# extension talks to, and the web app on 5173) when it is not already running, then the
# desktop app on the repository database. Run it from anywhere; paths resolve from the
# script's own location. Server output goes to data/logs/dev-server.log.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/logs

healthy() {
  curl -sf --max-time 2 http://127.0.0.1:4720/api/health >/dev/null 2>&1
}

if ! healthy; then
  echo "Starting the dev server (API on 4720, web on 5173)..."
  nohup npm run dev >>data/logs/dev-server.log 2>&1 </dev/null &
  disown
  for _ in $(seq 1 60); do
    healthy && break
    sleep 1
  done
  if ! healthy; then
    echo "The server did not answer on port 4720 within a minute. See data/logs/dev-server.log." >&2
    exit 1
  fi
fi

echo "Opening the desktop app..."
exec npm run desktop:repo
