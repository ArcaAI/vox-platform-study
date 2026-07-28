#!/usr/bin/env bash
# ============================================================================
# One-command local TEST environment bootstrap
# ============================================================================
# Test counterpart to `pnpm setup:dev` (scripts/dev-setup.sh). Brings a fresh
# checkout to a state where `pnpm test:up:api` (and the vitest/playwright suites
# that read .env.test) boot cleanly against the isolated test infrastructure.
#
# Postgres uses STATIC credentials from .env.test
# (DATABASE_URL=postgresql://test:test@localhost:5433/hope_test) — the test env
# does NOT use Vault dynamic DB creds (PG_DYNAMIC_CREDS=false). But the API and
# the PHI-ciphertext seed DO need Vault for secret warming + Transit encryption
# (SECRETS_PROVIDER=vault), so this bootstrap provisions the test env's Vault
# AppRole credentials into .env.test — the test counterpart to dev-setup's
# `refresh-vault-creds.sh` step. Vault itself is the SHARED dev container
# (hope-vault); the test infra does not run its own Vault.
#
# Sequence:
#   1. Start isolated test infrastructure (Postgres:5433, Redis:6380, MinIO:9002,
#      Qdrant:6335) and wait for health
#   2. Provision Vault AppRole creds + config in .env.test (needs hope-vault up)
#   3. Generate the Prisma client
#   4. Push the schema to the test database (test:db:push)
#   5. Seed baseline data                  (test:db:seed)
#
# USAGE:
#   pnpm setup:test        (preferred)
#   ./scripts/test-setup.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env.test"
VAULT_CONTAINER="${VAULT_CONTAINER:-hope-vault}"
ROOT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

# Upsert KEY=VALUE in .env.test: drop any existing line for KEY, append fresh.
# Robust against values containing sed-special chars (URLs, base64) — no sed.
set_env() {
  local key="$1" val="$2"
  grep -vE "^${key}=" "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

vault_exec() {
  docker exec "$VAULT_CONTAINER" sh -lc \
    "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; $*"
}

if [ ! -f "$ENV_FILE" ]; then
  red "ERROR: .env.test not found at $ENV_FILE"
  echo "The test environment requires .env.test. Create it before running this script."
  exit 1
fi

bold "── Step 1/5: starting + validating test infrastructure ─────────────"
# start-test-infra.sh runs 'up -d --wait' and a health validation pass.
"$SCRIPT_DIR/start-test-infra.sh"

bold "── Step 2/5: provisioning Vault AppRole creds in .env.test ─────────"
# The test API (SECRETS_PROVIDER=vault) warms secrets + uses Transit to encrypt
# BYO provider keys, and the PHI seed encrypts ciphertext via Transit. Both need
# valid Vault credentials. Vault is the shared dev container (hope-vault); ensure
# it is up (it is NOT part of the test infra), then mint reusable AppRole creds.
if ! docker ps --format '{{.Names}}' | grep -qx "$VAULT_CONTAINER"; then
  yellow "Vault container '$VAULT_CONTAINER' is not running — starting dev infra to bring it up."
  "$SCRIPT_DIR/dev-infra.sh" up
fi
# Wait for the vault-init sidecar to finish bootstrapping the hope-app AppRole.
vault_ready=0
for _ in $(seq 1 60); do
  if vault_exec "vault read -field=role_id auth/approle/role/hope-app/role-id" >/dev/null 2>&1; then
    vault_ready=1; break
  fi
  sleep 2
done
if [ "$vault_ready" != "1" ]; then
  red "ERROR: Vault AppRole 'hope-app' did not become ready (is hope-vault-init healthy?)."
  echo "Inspect with:  docker logs ${VAULT_CONTAINER}-init"
  exit 1
fi
ROLE_ID="$(vault_exec "vault read -field=role_id auth/approle/role/hope-app/role-id")"
# Raw (reusable) secret_id — secret_id_num_uses=0 + ttl=720h, safe across restarts
# (the same rationale as refresh-vault-creds.sh; watch-mode reloads reuse it).
SECRET_ID="$(vault_exec "vault write -f -field=secret_id auth/approle/role/hope-app/secret-id")"
if [ -z "$ROLE_ID" ] || [ -z "$SECRET_ID" ]; then
  red "ERROR: failed to read/mint hope-app AppRole credentials from Vault."
  exit 1
fi
# The seed prefers VAULT_DEV_ROOT_TOKEN (skips AppRole); the API uses AppRole.
set_env SECRETS_PROVIDER vault
set_env PG_DYNAMIC_CREDS false
set_env VAULT_DEV_ROOT_TOKEN "$ROOT_TOKEN"
set_env VAULT_ADDR "${VAULT_ADDR:-http://localhost:8200}"
set_env VAULT_ROLE_ID "$ROLE_ID"
set_env VAULT_SECRET_ID "$SECRET_ID"
set_env VAULT_WRAPPED_SECRET_ID ""
set_env VAULT_KV_MOUNT "${VAULT_KV_MOUNT:-secret}"
set_env VAULT_KV_PREFIX "${VAULT_KV_PREFIX:-hope}"
set_env VAULT_TRANSIT_MOUNT "${VAULT_TRANSIT_MOUNT:-transit}"
set_env VAULT_TRANSIT_KEY "${VAULT_TRANSIT_KEY:-hope-globalsetting}"
set_env VAULT_REQUEST_TIMEOUT_MS "${VAULT_REQUEST_TIMEOUT_MS:-5000}"
set_env VAULT_AUDIT_LOG_PATH "${VAULT_AUDIT_LOG_PATH:-/tmp/hope-vault-audit-test.log}"
# The Vault rotation worker stat()s the audit-log file on boot; create it so it
# does not crash on ENOENT.
: > "${VAULT_AUDIT_LOG_PATH:-/tmp/hope-vault-audit-test.log}" 2>/dev/null || true
green "→ .env.test Vault config provisioned (role_id ${ROLE_ID:0:8}…, raw reusable secret_id)."

bold "── Step 3/5: generating Prisma client ──────────────────────────────"
pnpm db:generate

bold "── Step 4/5: pushing schema to test database (test:db:push) ─────────"
pnpm test:db:push

bold "── Step 5/5: seeding baseline data (test:db:seed) ──────────────────"
pnpm test:db:seed

green ""
green "✔ Local test environment is ready."
yellow "Start the test API:   pnpm test:up:api    (listens on PORT from .env.test, default 8968)"
yellow "Run the test suites:  pnpm test:unit   |   pnpm test:integration   |   pnpm test:e2e"
