#!/usr/bin/env zsh
# scripts/smoke-pgbouncer.sh — Production smoke tests for PgBouncer cutover.
#
# Validates that the pooler is reachable, returns sane stats, and that
# the application path (Prisma) can run real queries through it.
# Matches Phase 1 validation rig assertions but against a real environment.
#
# Required env (or pass on the CLI):
#   POOLED_HOST           pgbouncer host (e.g., 10.10.1.250 or pgbouncer-vip)
#   POOLED_PORT=6432      pgbouncer port
#   ADMIN_USER=hope_admin pgbouncer admin user (must be in admin_users)
#   APP_USER=hope_app     application user
#   DB=hope               application database
#   ADMIN_PG_PASSWORD     admin password (for SHOW POOLS / SHOW STATS)
#   APP_PG_PASSWORD       app password (for runtime queries)
#
# Usage:
#   POOLED_HOST=10.10.1.250 ADMIN_PG_PASSWORD=... APP_PG_PASSWORD=... \
#     ./scripts/smoke-pgbouncer.sh
#
# Exit codes:
#   0  all smoke tests pass
#   1  any precondition or assertion failed
#
# PgBouncer cutover Phase 3 prep (03-pgbouncer-rollout.md).
set -euo pipefail
setopt PIPE_FAIL

POOLED_HOST="${POOLED_HOST:?set POOLED_HOST (e.g., 10.10.1.250 or pgbouncer-vip)}"
POOLED_PORT="${POOLED_PORT:-6432}"
ADMIN_USER="${ADMIN_USER:-hope_admin}"
APP_USER="${APP_USER:-hope_app}"
DB="${DB:-hope}"
SSL_MODE="${SSL_MODE:-require}"

: "${ADMIN_PG_PASSWORD:?set ADMIN_PG_PASSWORD (admin user for SHOW commands)}"
: "${APP_PG_PASSWORD:?set APP_PG_PASSWORD (app user for runtime queries)}"

print_h() {
  print "── $1 ──"
}

fail() {
  print "FAIL: $1" >&2
  exit 1
}

print_h "0. Resolve pgbouncer connectivity"
nc -z -w 5 "$POOLED_HOST" "$POOLED_PORT" \
  || fail "Cannot reach $POOLED_HOST:$POOLED_PORT (TCP). Is pgbouncer running and the VIP routing?"

print_h "1. pgbouncer accepts a connection & authenticates the app user"
PGPASSWORD="$APP_PG_PASSWORD" psql \
  "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=$SSL_MODE" \
  -c 'SELECT version();' >/dev/null \
  || fail "App-user auth to pooler failed"

print_h "2. pgbouncer admin DB returns SHOW POOLS (config is sane)"
SHOW_POOLS=$(
  PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
    "host=$POOLED_HOST port=$POOLED_PORT user=$ADMIN_USER dbname=pgbouncer sslmode=$SSL_MODE" \
    -At -c "SELECT pool_mode FROM pgbouncer.pools WHERE database='$DB' LIMIT 1;"
)
print "  pool_mode for $DB = $SHOW_POOLS"
[[ "$SHOW_POOLS" == "transaction" ]] \
  || fail "Expected pool_mode=transaction for $DB; got '$SHOW_POOLS'"

print_h "3. Prisma can run a real query through the pooler"
pnpm --filter @arcaai/api exec node -e "
const { getPrismaClient } = require('@arcaai/database');
getPrismaClient().tenant.count()
  .then((c) => { console.log('  tenants:', c); process.exit(0); })
  .catch((e) => { console.error('  prisma query failed:', e.message); process.exit(1); });
" || fail "Prisma runtime query through pooler failed"

print_h "4. Transaction-scoped tenant context is observable"
PGPASSWORD="$APP_PG_PASSWORD" psql \
  "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=$SSL_MODE" <<-SQL
	BEGIN;
	  SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true) AS tenant_set;
	  SELECT current_setting('app.current_tenant_id', true) AS tenant_observed;
	COMMIT;
SQL

print_h "5. Tenant context did NOT leak to the next checkout (DISCARD ALL works)"
LEAKED=$(
  PGPASSWORD="$APP_PG_PASSWORD" psql \
    "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=$SSL_MODE" \
    -At -c "SELECT COALESCE(current_setting('app.current_tenant_id', true), '');"
)
[[ -z "$LEAKED" ]] \
  || fail "Tenant context leaked across pooled checkouts (got '$LEAKED'). DISCARD ALL is not firing."

print_h "6. Pool stats look healthy after the smoke run"
PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
  "host=$POOLED_HOST port=$POOLED_PORT user=$ADMIN_USER dbname=pgbouncer sslmode=$SSL_MODE" \
  -c 'SHOW POOLS;'

print "── Smoke tests OK ──"
