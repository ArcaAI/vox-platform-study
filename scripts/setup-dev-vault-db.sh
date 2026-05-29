#!/usr/bin/env bash
# ============================================================================
# TASK-312 A.5 — Bootstrap Vault dynamic Postgres credentials for LOCAL DEV
# ============================================================================
# Makes `PG_DYNAMIC_CREDS=true` actually work in development by performing the
# three steps the app cannot do for itself at boot:
#
#   1. Create the PG roles Vault needs (vault_admin + hope_app_template) by
#      running the parameterized vault-admin-bootstrap.sql against the dev DB.
#   2. (Re-)configure Vault's database engine (database/config/hope-main +
#      database/roles/hope-app-role) pointing at the REAL dev database. The
#      vault-init sidecar runs at infra-up BEFORE migrations exist and before
#      vault_admin exists, so its connection test silently fails — this script
#      re-applies the config once the prerequisites are in place.
#   3. Smoke-test issuance: `vault read database/creds/hope-app-role`.
#
# IDEMPOTENT: safe to re-run. The SQL guards every CREATE; the Vault writes
# are last-write-wins.
#
# USAGE:
#   ./scripts/setup-dev-vault-db.sh
#
# PREREQUISITES (the script checks all of these and fails loudly):
#   - Docker running with hope-postgres + hope-vault containers up
#       ./scripts/start-infra.sh --all
#   - Schema migrated (the `core` schema must exist)
#       pnpm db:all
#
# Normally invoked for you by `pnpm dev:setup`.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.dev"
SQL_FILE="$REPO_ROOT/packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql"

PG_CONTAINER="${PG_CONTAINER:-hope-postgres}"
VAULT_CONTAINER="${VAULT_CONTAINER:-hope-vault}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# read_env KEY DEFAULT — pull a value from .env.dev (strip trailing CR), else
# fall back to DEFAULT. Avoids `source`-ing the whole file (which would choke
# on values containing spaces / special characters).
read_env() {
  local key="$1" def="${2:-}" line
  if [ -f "$ENV_FILE" ]; then
    line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)
  fi
  if [ -z "${line:-}" ]; then printf '%s' "$def"; else printf '%s' "${line#*=}" | tr -d '\r'; fi
}

ROOT_TOKEN="$(read_env VAULT_DEV_ROOT_TOKEN root)"
PG_SUPERUSER="$(read_env POSTGRES_USER postgres)"
DB_NAME="$(read_env VAULT_DB_NAME hope)"
DB_HOST="$(read_env VAULT_DB_HOST host.docker.internal)"
DB_PORT="$(read_env VAULT_DB_PORT 5432)"
ADMIN_USER="$(read_env VAULT_DB_ADMIN_USER vault_admin)"
ADMIN_PASS="$(read_env VAULT_DB_ADMIN_PASS vault_admin_dev_pw)"
VAULT_ROLE="$(read_env PG_VAULT_ROLE hope-app-role)"

# --- 1. Pre-flight ---------------------------------------------------------

[ -f "$SQL_FILE" ] || { red "ERROR: bootstrap SQL not found at $SQL_FILE"; exit 1; }

for c in "$PG_CONTAINER" "$VAULT_CONTAINER"; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    red "ERROR: container '$c' is not running."
    echo "Start the dev infra first:  ./scripts/start-infra.sh --all"
    exit 1
  fi
done

if ! docker exec "$PG_CONTAINER" pg_isready -U "$PG_SUPERUSER" >/dev/null 2>&1; then
  red "ERROR: Postgres in '$PG_CONTAINER' is not accepting connections yet."
  exit 1
fi

psql_super() { docker exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" "$@"; }

if [ "$(psql_super -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null || true)" != "1" ]; then
  red "ERROR: database '${DB_NAME}' does not exist."
  echo "Create it + run migrations:  pnpm db:all"
  exit 1
fi

if [ "$(psql_super -d "$DB_NAME" -tAc "SELECT 1 FROM information_schema.schemata WHERE schema_name='core'" 2>/dev/null || true)" != "1" ]; then
  red "ERROR: schema 'core' not found in database '${DB_NAME}' (migrations not applied)."
  echo "Run migrations + seed first:  pnpm db:all"
  exit 1
fi

green "→ Prerequisites OK (db='${DB_NAME}', superuser='${PG_SUPERUSER}')"

# --- 2. Create vault_admin + hope_app_template PG roles --------------------

green "→ Running vault-admin-bootstrap.sql (db_name=${DB_NAME})…"
if ! docker exec -i "$PG_CONTAINER" psql \
      -U "$PG_SUPERUSER" -d "$DB_NAME" \
      -v vault_admin_password="$ADMIN_PASS" \
      -v db_name="$DB_NAME" \
      < "$SQL_FILE"; then
  red "ERROR: bootstrap SQL failed. See psql output above."
  exit 1
fi

# --- 3. (Re-)configure Vault's database engine -----------------------------
# Heredoc piped to the container's sh so the {{username}}/{{name}} Vault
# templates survive verbatim while our shell expands the env-derived values.

green "→ Configuring Vault database engine against ${DB_HOST}:${DB_PORT}/${DB_NAME}…"
if ! docker exec -i "$VAULT_CONTAINER" sh -s <<EOF
set -e
export VAULT_ADDR=http://127.0.0.1:8200
export VAULT_TOKEN=${ROOT_TOKEN}
vault write database/config/hope-main \
  plugin_name=postgresql-database-plugin \
  allowed_roles="${VAULT_ROLE}" \
  connection_url="postgresql://{{username}}:{{password}}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=disable" \
  username="${ADMIN_USER}" \
  password="${ADMIN_PASS}"
vault write database/roles/${VAULT_ROLE} \
  db_name=hope-main \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' INHERIT IN ROLE hope_app_template;" \
  revocation_statements="REVOKE ALL PRIVILEGES ON DATABASE ${DB_NAME} FROM \"{{name}}\"; REASSIGN OWNED BY \"{{name}}\" TO hope_app_template; DROP OWNED BY \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h" \
  max_open_connections=50
EOF
then
  red "ERROR: Vault database-engine configuration failed."
  echo "Most common cause: Vault (in-container) cannot reach Postgres at"
  echo "  ${DB_HOST}:${DB_PORT}  — verify host.docker.internal resolves and"
  echo "  that vault_admin can authenticate (password = VAULT_DB_ADMIN_PASS)."
  exit 1
fi

# --- 4. Smoke test: issue a short-lived credential -------------------------

green "→ Smoke-testing credential issuance…"
SMOKE_USER=$(docker exec "$VAULT_CONTAINER" sh -lc \
  "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; vault read -field=username database/creds/${VAULT_ROLE}" 2>/dev/null || true)

if [ -z "$SMOKE_USER" ]; then
  red "ERROR: Vault did not issue a credential from database/creds/${VAULT_ROLE}."
  echo "Inspect with:"
  echo "  docker exec -e VAULT_TOKEN=${ROOT_TOKEN} ${VAULT_CONTAINER} vault read database/creds/${VAULT_ROLE}"
  exit 1
fi

# --- 5. Summary ------------------------------------------------------------

green ""
green "✔ Dynamic Postgres credentials are live for local dev"
echo   "    database         = ${DB_NAME}"
echo   "    vault role       = ${VAULT_ROLE}"
echo   "    issued test user = ${SMOKE_USER}  (auto-expires in 1h)"
echo   ""
yellow "Next step:  pnpm dev:api"
yellow "  • The API now mints a short-lived PG user from Vault on boot."
yellow "  • Re-run this script after a Docker volume reset (down -v)."
