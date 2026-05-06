#!/usr/bin/env bash
# Bring up the local AlgoLens stack: postgres (docker), migrations, node server.
# Idempotent — safe to re-run; existing pieces are reused.
#
# Usage:
#   bash scripts/start.sh           # postgres + migrations + node
#   bash scripts/start.sh --grpc    # also start the Go gRPC ranker on :50051
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WITH_GRPC=0
[[ "${1:-}" == "--grpc" ]] && WITH_GRPC=1

# ── 1. Postgres ────────────────────────────────────────────────────────────────
echo "→ postgres"
docker compose up -d >/dev/null
printf "  waiting for postgres "
until docker exec algolens-postgres pg_isready -U algolens -d algolens >/dev/null 2>&1; do
  printf "."
  sleep 1
done
echo " ready (port 5433, data persists in 'algolens_pgdata' volume)"

# ── 2. Env ─────────────────────────────────────────────────────────────────────
# .env is optional for local dev: anything it doesn't define falls back to the
# docker-compose defaults below. Production gets these via Render env, never
# from a checked-in file.
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi
: "${DATABASE_URL:=postgres://algolens:dev@localhost:5433/algolens}"
: "${JWT_SECRET:=local-dev-secret-min-length-ok-not-for-prod}"
export DATABASE_URL JWT_SECRET

# ── 3. Migrations ──────────────────────────────────────────────────────────────
echo "→ migrations"
bash db/run-migrations.sh >/dev/null
echo "  applied"

# ── 4. Optional Go gRPC ranker ─────────────────────────────────────────────────
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

# ── 5. Node server ─────────────────────────────────────────────────────────────
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
