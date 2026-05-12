#!/usr/bin/env bash
# Stop the local AlgoLens stack (node server + optional gRPC ranker). Postgres
# lives in Neon so there's nothing local to stop. If you're on the docker
# fallback, run `npm run services:stop` separately.
#
# Usage:
#   bash scripts/stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
