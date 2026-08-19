#!/usr/bin/env bash
# ============================================================================
# One-command local development bootstrap
# ============================================================================
# Brings a freshly-cloned (or freshly-reset) checkout to a state where
# `pnpm api:dev` boots cleanly against Vault with dynamic Postgres creds.
#
# Sequence:
#   0. Create/overwrite .env.dev from .env.sample
#   1. Start infrastructure (core + vault + temporal + rag; optional -o/-e)
#   2. Wait for Postgres + Vault (and the vault-init AppRole bootstrap) to be ready
#   3. Apply Prisma migrations + seed                            (pnpm db:all)
#   4. Refresh Vault AppRole creds in .env.dev (so the app can authenticate)
#   5. Bootstrap Vault dynamic DB credentials    (vault_admin + DB engine)
#   6. Finalize the env — build the settings registry and reconcile Vault
#      kv-v2 secrets with .env.dev (scripts/vault-seed-secrets.sh), so a
#      service booted with SECRETS_PROVIDER=vault reads the SAME values
#      .env.dev has. Without this, dev-init.sh's hardcoded placeholder seed
#      (e.g. MINIO_ACCESS_KEY=minio_admin) silently diverges from whatever
#      .env.dev actually carries (e.g. a freshly generated MINIO_ACCESS_KEY),
#      and only the service that happens to read Vault notices — at request
#      time, not setup time.
#
# USAGE:
#   pnpm setup:dev          # base: core + vault + temporal + rag
#   pnpm setup:dev:observability        # base + Prometheus/Grafana
#   pnpm setup:dev:inference        # base + inference engines
#   ./scripts/dev-setup.sh [-o|--observability] [-e|--inference]
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
  local key="$1" def="${2:-}" line value
  if [ -f "$REPO_ROOT/.env.dev" ]; then
    line=$(grep -E "^${key}=" "$REPO_ROOT/.env.dev" | tail -n1 || true)
  fi
  value="$(printf '%s' "${line#*=}" | tr -d '\r')"
  if [ -z "$value" ]; then printf '%s' "$def"; else printf '%s' "$value"; fi
}

# Profile flags for dev-infra.sh.
INFRA_FLAGS=()
for arg in "$@"; do
  [ "$arg" = "--" ] && continue
  case "$arg" in
    -o|--observability) INFRA_FLAGS+=(--observability) ;;
    -e|--inference) INFRA_FLAGS+=(--inference) ;;
    *)
      red "Unknown flag: $arg (known: -o/--observability, -e/--inference)"
      exit 2
      ;;
  esac
done

TIER_LABEL="core + vault + temporal + rag"
for f in "${INFRA_FLAGS[@]+"${INFRA_FLAGS[@]}"}"; do
  case "$f" in
    --observability) TIER_LABEL="$TIER_LABEL + observability" ;;
    --inference) TIER_LABEL="$TIER_LABEL + inference" ;;
  esac
done

bold "── Step 0/6: ensuring .env.dev exists ────────────────────────────────"
# shellcheck source=./generate-env-file.sh
source "$SCRIPT_DIR/generate-env-file.sh"
ensure_env_file "$REPO_ROOT/.env.dev" dev

ROOT_TOKEN="$(read_env VAULT_DEV_ROOT_TOKEN root)"
PG_SUPERUSER="$(read_env POSTGRES_USER postgres)"

bold "── Step 1/6: starting infrastructure ($TIER_LABEL) ──────"
# Use the full dev-infra wrapper so Temporal + rag (and optional -o/-e) come up
# alongside core + vault.
# SKIP_VAULT_RECONCILE: dev-infra.sh reconciles Vault itself (so `stack:dev` /
# `infra:dev:up` are self-sufficient); here steps 4 and 6 do it after the DB work.
SKIP_VAULT_RECONCILE=1 "$SCRIPT_DIR/dev-infra.sh" up "${INFRA_FLAGS[@]+"${INFRA_FLAGS[@]}"}"

bold "── Step 2/6: waiting for Postgres + Vault to be ready ───────────────"
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

bold "── Step 3/6: applying migrations + seed (pnpm db:all) ───────────────"
# Seeding is opt-in and defaults to RUN_SEED=none — this local dev
# bootstrap wants the full demo fixture set (incl. the super_admin login), so
# it opts in explicitly. NODE_ENV=development satisfies seed-mode.ts's guard
# that RUN_SEED=all is refused unless the environment is explicitly stated.
RUN_SEED=all NODE_ENV=development pnpm db:all

bold "── Step 4/6: refreshing Vault AppRole creds in .env.dev ─────────────"
"$SCRIPT_DIR/refresh-vault-creds.sh"

bold "── Step 5/6: bootstrapping Vault dynamic DB credentials ─────────────"
"$SCRIPT_DIR/setup-dev-vault-db.sh"

bold "── Step 6/6: finalizing the env (syncing Vault kv-v2 secrets) ───────"
# vault-seed-secrets.sh derives its key list from the built settings registry
# (no hardcoded fallback list — that's the drift this script exists to remove), so the
# registry must be compiled before it can run.
pnpm --filter @arcaai/applications build
"$SCRIPT_DIR/vault-seed-secrets.sh" --env-file "$REPO_ROOT/.env.dev"

green ""
green "✔ Local dev environment is ready."
yellow "Start the stack:  pnpm stack:dev   (or pnpm api:dev for API only)"
