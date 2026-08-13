#!/usr/bin/env bash
# packages/database/tests/pgbouncer-validation/pgbench/run-baseline.sh
#
# Task 1.14 — pgbench baseline (direct vs pooled) for the PgBouncer
# validation rig.
#
# Workload:  TPC-B-like (pgbench's default --builtin=tpcb-like)
# Scale:     10  → ~150K rows in pgbench_accounts, ~1 GB footprint
# Clients:   8   → matches the production app pod count budget
# Duration:  30 s per path
#
# Two passes:
#   1. Direct  (port 5532, DIRECT_URL) — baseline
#   2. Pooled  (port 6532, PgBouncer transaction mode) — comparison
#
# The Phase 1 rubric requires pooled TPS within 15% of direct on the
# same hardware. Output is captured as `direct.out` / `pooled.out` next
# to this script for inclusion in the validation report (Task 1.18).
#
# Logging is briefly muted on the postgres side so the benchmark isn't
# polluted by the rig's log_statement='all' setting (left on for Task 1.11).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PG_CONTAINER="pgbv-postgres"
DIRECT_PORT=5532
POOLED_PORT=6532
DB="hope"
USER="hope_app"
export PGPASSWORD="hope_app_local"

# Defaults match the rubric in 03-pgbouncer-rollout.md:
#   -c 50 -j 4 -T 60 -P 10 -M prepared
# Override via env: PGBENCH_SCALE / PGBENCH_CLIENTS / PGBENCH_DURATION / PGBENCH_JOBS.
SCALE="${PGBENCH_SCALE:-10}"
CLIENTS="${PGBENCH_CLIENTS:-50}"
DURATION="${PGBENCH_DURATION:-60}"
JOBS="${PGBENCH_JOBS:-4}"
PROTOCOL="${PGBENCH_PROTOCOL:-prepared}"
PROGRESS="${PGBENCH_PROGRESS:-10}"

bouncer_exec() {
  PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -p "$POOLED_PORT" -U "$USER" -d pgbouncer -c "$1" 2>&1
}

pg_exec() {
  PGPASSWORD="$PGPASSWORD" psql -h 127.0.0.1 -p "$DIRECT_PORT" -U "$USER" -d "$DB" -c "$1" 2>&1
}

echo "═══════════════════════════════════════════════════════════════"
echo "Task 1.14 — pgbench baseline (scale=$SCALE clients=$CLIENTS dur=${DURATION}s)"
echo "═══════════════════════════════════════════════════════════════"

echo
echo ">> Muting postgres log_statement (will restore after benchmark)…"
pg_exec "ALTER SYSTEM SET log_statement = 'none'" >/dev/null
pg_exec "SELECT pg_reload_conf()" >/dev/null

echo
echo ">> Initialising pgbench tables (scale=$SCALE)…"
docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
  pgbench -h 127.0.0.1 -p 5432 -U "$USER" -d "$DB" -i -s "$SCALE" -I dtgvp 2>&1 | tail -5

echo
echo ">> ── PASS 1: direct (port $DIRECT_PORT, -M $PROTOCOL) ──"
docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
  pgbench -h 127.0.0.1 -p 5432 -U "$USER" -d "$DB" \
    -c "$CLIENTS" -j "$JOBS" -T "$DURATION" -P "$PROGRESS" \
    -M "$PROTOCOL" --no-vacuum --report-per-command \
    | tee "$SCRIPT_DIR/direct.out"

# Brief pause so any in-flight DISCARD ALLs on the bouncer side complete.
sleep 2
echo
echo ">> SHOW POOLS (direct path completed, pooled path next):"
bouncer_exec "SHOW POOLS" | tee "$SCRIPT_DIR/show-pools-after-direct.out"

echo
echo ">> ── PASS 2: pooled (port $POOLED_PORT, -M $PROTOCOL — PgBouncer transaction mode) ──"
docker exec -e PGPASSWORD="$PGPASSWORD" "$PG_CONTAINER" \
  pgbench -h pgbv-pgbouncer -p 6432 -U "$USER" -d "$DB" \
    -c "$CLIENTS" -j "$JOBS" -T "$DURATION" -P "$PROGRESS" \
    -M "$PROTOCOL" --no-vacuum --report-per-command \
    | tee "$SCRIPT_DIR/pooled.out"

sleep 2
echo
echo ">> SHOW POOLS (after pooled run — for Task 1.16 capture):"
bouncer_exec "SHOW POOLS" | tee "$SCRIPT_DIR/show-pools-after-pooled.out"
echo
echo ">> SHOW STATS (after pooled run):"
bouncer_exec "SHOW STATS" | tee "$SCRIPT_DIR/show-stats-after-pooled.out"

echo
echo ">> Restoring postgres log_statement…"
pg_exec "ALTER SYSTEM SET log_statement = 'all'" >/dev/null
pg_exec "SELECT pg_reload_conf()" >/dev/null

echo
echo "═══════════════════════════════════════════════════════════════"
echo "Summary"
echo "═══════════════════════════════════════════════════════════════"
DIRECT_TPS=$(grep -oE 'tps = [0-9.]+' "$SCRIPT_DIR/direct.out" | head -1 | awk '{print $3}')
POOLED_TPS=$(grep -oE 'tps = [0-9.]+' "$SCRIPT_DIR/pooled.out" | head -1 | awk '{print $3}')
DIRECT_LAT=$(grep -oE 'latency average = [0-9.]+ ms' "$SCRIPT_DIR/direct.out" | head -1 | awk '{print $4}')
POOLED_LAT=$(grep -oE 'latency average = [0-9.]+ ms' "$SCRIPT_DIR/pooled.out" | head -1 | awk '{print $4}')
RATIO=$(awk -v p="$POOLED_TPS" -v d="$DIRECT_TPS" 'BEGIN { if (d > 0) printf "%.3f", p/d; else print "n/a" }')
echo "Direct TPS:    $DIRECT_TPS   (avg latency $DIRECT_LAT ms)"
echo "Pooled TPS:    $POOLED_TPS   (avg latency $POOLED_LAT ms)"
echo "Pooled/Direct: $RATIO  (Phase 1 rubric: ≥ 0.85)"
echo
echo "Detailed output written to:"
echo "  $SCRIPT_DIR/direct.out"
echo "  $SCRIPT_DIR/pooled.out"
echo "  $SCRIPT_DIR/show-pools-after-direct.out"
echo "  $SCRIPT_DIR/show-pools-after-pooled.out"
echo "  $SCRIPT_DIR/show-stats-after-pooled.out"
