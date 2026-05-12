#!/usr/bin/env bash
# Bring up the local AlgoLens stack: migrations + node server. Postgres lives
# in Neon (hosted), so no docker is needed for dev. If you want the offline
# fallback, `npm run services:start` boots a local pg in docker on :5433 and
# you point DATABASE_URL at it.
#
# Usage:
#   bash scripts/start.sh           # migrations + node
#   bash scripts/start.sh --grpc    # also start the Go gRPC ranker on :50051
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_GRPC=0
[[ "${1:-}" == "--grpc" ]] && WITH_GRPC=1

# ── 1. Env ─────────────────────────────────────────────────────────────────────
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Copy .env.example to .env and fill in your Neon URL." >&2
  exit 1
fi
if [[ -z "${JWT_SECRET:-}" || "${JWT_SECRET}" == "change-me" ]]; then
  echo "JWT_SECRET is not set (or still 'change-me'). Generate one and put it in .env." >&2
  exit 1
fi
export DATABASE_URL JWT_SECRET

# ── 2. Migrations ──────────────────────────────────────────────────────────────
echo "→ migrations"
bash db/run-migrations.sh >/dev/null
echo "  applied"

# ── 3. Optional Go gRPC ranker ─────────────────────────────────────────────────
if [[ "$WITH_GRPC" == "1" ]]; then
  echo "→ go grpc ranker"
  if [[ -f .algolens-grpc.pid ]] && kill -0 "$(cat .algolens-grpc.pid)" 2>/dev/null; then
    echo "  already running (pid $(cat .algolens-grpc.pid))"
  else
    if [[ ! -x go/algolens_server ]]; then
      echo "  building go/algolens_server"
      (cd go && go build -o algolens_server .)
    fi
    (cd go && ./algolens_server -addr 127.0.0.1:50051 -corpus ../data/problemset_llm) \
      > /tmp/algolens-grpc.log 2>&1 &
    echo $! > .algolens-grpc.pid
    sleep 2
    if kill -0 "$(cat .algolens-grpc.pid)" 2>/dev/null; then
      echo "  started (pid $(cat .algolens-grpc.pid)) on 127.0.0.1:50051"
      export GRPC_BM25_ADDR=127.0.0.1:50051
    else
      echo "  ✗ failed to start; see /tmp/algolens-grpc.log" >&2
      rm -f .algolens-grpc.pid
    fi
  fi
fi

# ── 4. Node server ─────────────────────────────────────────────────────────────
echo "→ node server"
if [[ -f .algolens.pid ]] && kill -0 "$(cat .algolens.pid)" 2>/dev/null; then
  echo "  already running (pid $(cat .algolens.pid)) on http://localhost:${PORT:-3000}"
  exit 0
fi

node server/index.js > /tmp/algolens.log 2>&1 &
echo $! > .algolens.pid
sleep 2
if kill -0 "$(cat .algolens.pid)" 2>/dev/null; then
  echo "  started (pid $(cat .algolens.pid)) → http://localhost:${PORT:-3000}"
  echo "  logs: tail -f /tmp/algolens.log"
else
  echo "  ✗ failed; see /tmp/algolens.log" >&2
  rm -f .algolens.pid
  exit 1
fi
