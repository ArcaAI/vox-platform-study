#!/bin/sh
# Idempotent Temporal SQL schema setup/upgrade for the shared hope-postgres
# instance. Replaces temporalio/auto-setup (deprecated; no 1.30/1.31 tags).
#
# Fresh DBs: create → setup-schema 0.0 → update-schema.
# Existing DBs (e.g. auto-setup 1.29.x): create/setup-schema are no-ops;
# update-schema applies versioned migrations in place (no DROP / no volume wipe).
#
# 1.31.0 requires PostgreSQL core schema v1.19 and visibility v1.14.
set -eu

: "${POSTGRES_SEEDS:?ERROR: POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?ERROR: POSTGRES_USER is required}"
: "${POSTGRES_PWD:?ERROR: POSTGRES_PWD is required}"

DB_PORT="${DB_PORT:-5432}"
DBNAME="${DBNAME:-temporal}"
VISIBILITY_DBNAME="${VISIBILITY_DBNAME:-temporal_visibility}"
export SQL_PASSWORD="${SQL_PASSWORD:-$POSTGRES_PWD}"
export PGPASSWORD="${PGPASSWORD:-$POSTGRES_PWD}"

tool() {
  temporal-sql-tool \
    --plugin postgres12 \
    --ep "${POSTGRES_SEEDS}" \
    -u "${POSTGRES_USER}" \
    --pw "${POSTGRES_PWD}" \
    -p "${DB_PORT}" \
    "$@"
}

ensure_db() {
  db="$1"
  schema_dir="$2"

  echo "Ensuring database '${db}' exists..."
  tool --db "${db}" create || true

  echo "Initializing schema for '${db}' if empty..."
  tool --db "${db}" setup-schema -v 0.0 || true

  echo "Updating schema for '${db}'..."
  tool --db "${db}" update-schema -d "${schema_dir}"
}

echo "Starting PostgreSQL schema setup/upgrade..."
echo "Waiting for PostgreSQL at ${POSTGRES_SEEDS}:${DB_PORT}..."
nc -z -w 10 "${POSTGRES_SEEDS}" "${DB_PORT}"
echo "PostgreSQL port is available"

ensure_db "${DBNAME}" /etc/temporal/schema/postgresql/v12/temporal/versioned
ensure_db "${VISIBILITY_DBNAME}" /etc/temporal/schema/postgresql/v12/visibility/versioned

echo "PostgreSQL schema setup/upgrade complete"
