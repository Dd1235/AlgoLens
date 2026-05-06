#!/usr/bin/env bash
# Apply every migration in db/migrations/ in lexical order.
# Idempotent only insofar as each migration is idempotent (CREATE TABLE IF NOT
# EXISTS, etc). For destructive changes, write a new migration; never edit a
# committed one.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in "$DIR/migrations"/*.sql; do
  echo "applying $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "migrations done"
