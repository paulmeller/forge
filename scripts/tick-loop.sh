#!/usr/bin/env bash
# Local-dev convenience: production drives the tick engine via Cloud Scheduler
# POSTing /api/tick every 60s. Nothing does that locally, so this loop stands
# in for it.
#
# Requires TICK_ALLOW_UNAUTHENTICATED=true in apps/web/.env.local — the route
# is OIDC-verified in production and will reject an unauthenticated POST
# otherwise.
#
# Usage: ./scripts/tick-loop.sh [interval_seconds]
set -euo pipefail

URL="${FORGE_TICK_URL:-http://localhost:3100/api/tick}"
INTERVAL="${1:-15}"

echo "ticking $URL every ${INTERVAL}s (ctrl-c to stop)"
while true; do
  ts=$(date '+%H:%M:%S')
  code=$(curl -s -X POST "$URL" -o /dev/null -w "%{http_code}" || echo "ERR")
  echo "$ts tick -> $code"
  sleep "$INTERVAL"
done
