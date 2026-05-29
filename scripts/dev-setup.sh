#!/usr/bin/env bash
# ============================================================================
# TASK-312 A.5 — One-command local development bootstrap
# ============================================================================
# Brings a freshly-cloned (or freshly-reset) checkout to a state where
# `pnpm dev:api` boots cleanly against Vault with dynamic Postgres creds.
#
# Sequence:
#   1. Start infrastructure (Postgres, Redis, MinIO, Vault, Qdrant)
#   2. Wait for Postgres + Vault (and the vault-init AppRole bootstrap)
#   3. Apply Prisma migrations + seed         (pnpm db:all)
#   4. Refresh Vault AppRole creds in .env.dev (so the app can authenticate)
#   5. Bootstrap Vault dynamic DB credentials  (vault_admin + DB engine)
#
# USAGE:
#   pnpm dev:setup        (preferred)
#   ./scripts/dev-setup.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PG_CONTAINER="${PG_CONTAINER:-hope-postgres}"
VAULT_CONTAINER="${VAULT_CONTAINER:-hope-vault}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

read_env() {
  local key="$1" def="${2:-}" line
  if [ -f "$REPO_ROOT/.env.dev" ]; then
    line=$(grep -E "^${key}=" "$REPO_ROOT/.env.dev" | tail -n1 || true)
  fi
  if [ -z "${line:-}" ]; then printf '%s' "$def"; else printf '%s' "${line#*=}" | tr -d '\r'; fi
}

ROOT_TOKEN="$(read_env VAULT_DEV_ROOT_TOKEN root)"
PG_SUPERUSER="$(read_env POSTGRES_USER postgres)"

bold "── Step 1/5: starting infrastructure ───────────────────────────────"
"$SCRIPT_DIR/start-infra.sh" --all

bold "── Step 2/5: waiting for Postgres + Vault to be ready ───────────────"
ready=0
for _ in $(seq 1 90); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_SUPERUSER" >/dev/null 2>&1 \
     && docker exec "$VAULT_CONTAINER" sh -lc \
          "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; vault read -field=role_id auth/approle/role/hope-app/role-id" \
          >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  red "ERROR: Postgres and/or Vault did not become ready in time."
  echo "Check:  docker logs ${VAULT_CONTAINER}-init   and   docker logs ${PG_CONTAINER}"
  exit 1
fi
green "→ Postgres ready; Vault AppRole bootstrap complete."

bold "── Step 3/5: applying migrations + seed (pnpm db:all) ───────────────"
pnpm db:all

bold "── Step 4/5: refreshing Vault AppRole creds in .env.dev ─────────────"
"$SCRIPT_DIR/refresh-vault-creds.sh"

bold "── Step 5/5: bootstrapping Vault dynamic DB credentials ─────────────"
"$SCRIPT_DIR/setup-dev-vault-db.sh"

green ""
green "✔ Local dev environment is ready."
yellow "Start the API:  pnpm dev:api"
