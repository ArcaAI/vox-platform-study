#!/usr/bin/env bash
# ============================================================================
# Ensure the test Vault is fully provisioned for .env.test (automatic, idempotent)
#   1. a valid AppRole role_id/secret_id (so VaultSecretsProvider.boot() succeeds)
#   2. the platform kv secrets synced FROM .env.test (so the DB seed's pepper /
#      tokens match what the API reads at runtime — otherwise seeded API keys 401)
# ============================================================================
# The test API/services run SECRETS_PROVIDER=vault (real Vault Transit — see
# scripts/test-setup.sh). VaultSecretsProvider.boot() FAILS CLOSED if the
# AppRole role_id/secret_id in .env.test are stale, so the service never
# becomes healthy. Creds go stale whenever the isolated test Vault
# (hope-vault-test) is recreated or its dev-mode (in-memory) state
# is wiped — the role_id itself changes, invalidating whatever .env.test held.
#
# This is the `.env.test` twin of scripts/refresh-vault-creds.sh (which does
# .env.dev against the SEPARATE shared dev Vault, hope-vault). It is called
# automatically by scripts/test-run.sh — both before the DB seed (which needs
# Vault Transit reachable) and before starting any app service — so
# `pnpm test:unit:managed` / `test:e2e:managed` (and friends) self-provision;
# no one re-mints role_id/secret_id by hand.
#
# Idempotent: reads the CURRENT role_id from hope-vault-test and mints a fresh
# RAW (reusable, ttl 720h — same rationale as refresh-vault-creds.sh)
# secret_id on every call. Safe to run repeatedly; cheap.
#
# No-op unless .env.test actually selects the Vault provider.
#
# USAGE:  ./scripts/ensure-test-vault-creds.sh        (called by test-run.sh)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.test"
CONTAINER="${VAULT_CONTAINER:-hope-vault-test}"
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
# The tmp file is PID-unique: test-run.sh spawns every service in parallel and each
# start-test-app.sh calls this script, so a shared `${ENV_FILE}.tmp` was being created by
# one process and mv'd away by another — the loser died on
# `mv: .env.test.tmp: No such file or directory`, taking its service down with it.
set_env() {
  local key="$1" val="$2" tmp="${ENV_FILE}.tmp.$$"
  grep -vE "^${key}=" "${ENV_FILE}" > "${tmp}" && mv "${tmp}" "${ENV_FILE}"
  printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
}

# Serialize concurrent invocations. Unique tmp files stop the crash, but two runs
# interleaving read-modify-write on ${ENV_FILE} can still drop a key. mkdir is the
# portable atomic mutex (macOS has no flock). The lock is released on any exit.
LOCK_DIR="${ENV_FILE}.lock"
LOCK_HELD=false
for _ in $(seq 1 300); do
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    LOCK_HELD=true
    trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT
    break
  fi
  sleep 1
done
if [ "${LOCK_HELD}" != true ]; then
  red "ERROR: timed out waiting for ${LOCK_DIR}."
  echo  "If a previous run was killed the lock is stale — remove it with:  rmdir ${LOCK_DIR}" >&2
  exit 1
fi

# hope-vault-test is owned by the ISOLATED test infra, not dev —
# bring the test stack up if it is not running.
if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  yellow "→ Vault container '${CONTAINER}' not running — starting test infrastructure to bring it up."
  "${SCRIPT_DIR}/start-test-infra.sh" >/dev/null
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
  red "ERROR: Vault AppRole 'hope-app' did not become ready (is hope-vault-init-test healthy?)."
  echo  "Inspect with:  docker logs hope-vault-init-test" >&2
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
# does not crash on ENOENT (mirrors test-setup.sh Step 3). .env.sample's
# default (./temp/vault.log) is repo-root-relative and the directory does not
# exist yet on a fresh checkout, so mkdir -p the parent first.
AUDIT_PATH="$(grep -E '^VAULT_AUDIT_LOG_PATH=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"')"
AUDIT_PATH="${AUDIT_PATH:-/tmp/hope-vault-audit-test.log}"
mkdir -p "$(dirname "${AUDIT_PATH}")" 2>/dev/null || true
: > "${AUDIT_PATH}" 2>/dev/null || true

# Sync the platform kv secrets (API_KEY_PEPPER, JWT_SECRET_KEY, service tokens,
# storage credentials, …) FROM .env.test INTO Vault kv-v2. This is NOT optional
# housekeeping: the dev Vault bootstrap seeds GENERATED values (e.g. a random
# 64-hex API_KEY_PEPPER), but the test DB seed hashes every API key with the
# .env.test pepper. If the two disagree, the API validates seeded keys against
# the wrong pepper and rejects them all with 401 (the whole `auth-guard-behavior`
# / service-account e2e class), and any other seed↔runtime secret drifts too.
# vault-seed-secrets.sh is idempotent and exits 0 even when some fail-closed
# secrets are deliberately absent from the env file.
if [ -x "${SCRIPT_DIR}/vault-seed-secrets.sh" ]; then
  yellow "→ syncing platform kv secrets from ${ENV_FILE##*/} into Vault…"
  # VAULT_CONTAINER must be exported — vault-seed-secrets.sh is a separate
  # process and otherwise falls back to its own default (hope-vault, the dev
  # container), not this script's ${CONTAINER}.
  if ! VAULT_CONTAINER="${CONTAINER}" "${SCRIPT_DIR}/vault-seed-secrets.sh" --env-file "${ENV_FILE}"; then
    red "ERROR: failed to sync kv secrets into Vault — seeded API keys would be rejected (401)."
    exit 1
  fi
fi

green "→ .env.test Vault provisioned (role_id ${ROLE_ID:0:8}…, fresh raw secret_id, kv secrets synced)."
