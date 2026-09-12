#!/bin/bash
# Keeps the game client up for an unattended run: every 30 s, if `game status` reports the client
# exited (a renderer crash, never a loaded world), starts it again against the server in .env.
# Usage: nohup scripts/game-watchdog.sh & ; log in .runtime/logs/watchdog.log; stop it by pid.
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a
log=.runtime/logs/watchdog.log
mkdir -p .runtime/logs
while true; do
  phase=$(node scripts/game.ts status 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('phase'))" 2>/dev/null)
  if [ "$phase" = "exited" ] || [ -z "$phase" ]; then
    echo "$(date -u +%FT%TZ) game ${phase:-unknown}; starting" >> "$log"
    timeout 500 node scripts/game.ts start --server "$VINTAGE_STORY_SERVER" >> "$log" 2>&1
  fi
  sleep 30
done
