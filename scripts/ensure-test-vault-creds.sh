#!/usr/bin/env bash
# ============================================================================
# Ensure valid Vault AppRole credentials in .env.test (automatic, idempotent)
# ============================================================================
# The test API/services run SECRETS_PROVIDER=vault (real Vault Transit — see
# scripts/test-setup.sh). VaultSecretsProvider.boot() FAILS CLOSED if the
# AppRole role_id/secret_id in .env.test are stale, so the service never
# becomes healthy. Creds go stale whenever the shared dev Vault (hope-vault)
# is recreated or its dev-mode (in-memory) state is wiped — the role_id itself
# changes, invalidating whatever .env.test held.
#
# This is the `.env.test` twin of scripts/refresh-vault-creds.sh (which does
# .env.dev). It is called automatically by scripts/test-run.sh before starting
# any service, so `pnpm test:e2e:managed` (and friends) self-provision — no one
# re-mints role_id/secret_id by hand.
#
# Idempotent: reads the CURRENT role_id from hope-vault and mints a fresh RAW
# (reusable, ttl 720h — same rationale as refresh-vault-creds.sh) secret_id on
# every call. Safe to run repeatedly; cheap.
#
# No-op unless .env.test actually selects the Vault provider.
#
# USAGE:  ./scripts/ensure-test-vault-creds.sh        (called by test-run.sh)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.test"
CONTAINER="${VAULT_CONTAINER:-hope-vault}"
ROOT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

if [ ! -f "${ENV_FILE}" ]; then
  yellow "→ ${ENV_FILE} not found — run 'pnpm setup:test' first. Skipping Vault cred refresh."
  exit 0
fi

# Only relevant when the test env authenticates to Vault.
if ! grep -qE '^SECRETS_PROVIDER=vault$' "${ENV_FILE}"; then
  exit 0
fi

vault_exec() {
  docker exec "${CONTAINER}" sh -lc "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; $*"
}

# Upsert KEY=VALUE (no sed — robust against URL/base64 special chars).
set_env() {
  local key="$1" val="$2"
  grep -vE "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
}

# hope-vault is the SHARED dev container (the test infra runs no Vault of its
# own). Bring dev infra up if it is not running.
if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  yellow "→ Vault container '${CONTAINER}' not running — starting dev infra to bring it up."
  "${SCRIPT_DIR}/dev-infra.sh" up
fi

# Wait for the vault-init sidecar to finish bootstrapping the hope-app AppRole.
ROLE_ID=""
for _ in $(seq 1 60); do
  if ROLE_ID="$(vault_exec 'vault read -field=role_id auth/approle/role/hope-app/role-id' 2>/dev/null)" && [ -n "${ROLE_ID}" ]; then
    break
  fi
  sleep 2
done
if [ -z "${ROLE_ID}" ]; then
  red "ERROR: Vault AppRole 'hope-app' did not become ready (is ${CONTAINER}-init healthy?)."
  echo  "Inspect with:  docker logs ${CONTAINER}-init" >&2
  exit 1
fi

# Raw (reusable) secret_id — secret_id_num_uses=0 + ttl=720h, safe across
# restarts (the same rationale as refresh-vault-creds.sh).
SECRET_ID="$(vault_exec 'vault write -f -field=secret_id auth/approle/role/hope-app/secret-id')"
if [ -z "${SECRET_ID}" ]; then
  red "ERROR: failed to mint a hope-app secret_id from Vault."
  exit 1
fi

set_env VAULT_ROLE_ID "${ROLE_ID}"
set_env VAULT_SECRET_ID "${SECRET_ID}"
set_env VAULT_WRAPPED_SECRET_ID ""   # raw path (blank the prod-only wrapped id)

# The Vault rotation worker stat()s the audit-log file on boot; create it so it
# does not crash on ENOENT (mirrors test-setup.sh Step 3).
AUDIT_PATH="$(grep -E '^VAULT_AUDIT_LOG_PATH=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"')"
: > "${AUDIT_PATH:-/tmp/hope-vault-audit-test.log}" 2>/dev/null || true

green "→ .env.test Vault creds refreshed (role_id ${ROLE_ID:0:8}…, fresh raw secret_id)."
