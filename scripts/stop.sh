#!/usr/bin/env bash
# Stop the local AlgoLens stack. Default keeps postgres running so its volume
# stays warm between restarts; pass --with-db to stop the container too.
# DB data always persists (named volume) until you `docker compose down -v`.
#
# Usage:
#   bash scripts/stop.sh             # node + grpc, leave postgres up
#   bash scripts/stop.sh --with-db   # node + grpc + postgres
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_DB=0
[[ "${1:-}" == "--with-db" ]] && WITH_DB=1

stop_pid_file() {
  local pidfile="$1" label="$2"
  if [[ -f "$pidfile" ]]; then
    local pid; pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      # Give it a chance to exit cleanly before SIGKILL.
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
      echo "→ $label stopped (pid $pid)"
    else
      echo "→ $label not running (stale pid file)"
    fi
    rm -f "$pidfile"
  else
    echo "→ $label not running"
  fi
}

stop_pid_file .algolens.pid       "node server"
stop_pid_file .algolens-grpc.pid  "go grpc ranker"

if [[ "$WITH_DB" == "1" ]]; then
  echo "→ postgres"
  docker compose down >/dev/null
  echo "  stopped (data preserved in 'algolens_pgdata' volume)"
else
  echo "→ postgres left running (use --with-db to stop)"
fi
