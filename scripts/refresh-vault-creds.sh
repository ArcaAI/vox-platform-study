#!/usr/bin/env bash
# ============================================================================
# TASK-312 Phase A.3/A.7 - Refresh local-dev Vault AppRole credentials
# ============================================================================
# Mints a fresh RAW secret_id for the `hope-app` AppRole and rewrites
# VAULT_ROLE_ID + VAULT_SECRET_ID in .env.dev (and blanks the prod-only
# VAULT_WRAPPED_SECRET_ID so the raw path is taken).
#
# WHY RAW (not response-wrapped) FOR DEV — TASK-312 A.7:
#   A response-wrapping token is SINGLE-USE: VaultSecretsProvider.boot()
#   unwraps it on every process start, so the SECOND boot fails with
#   "wrapping token is not valid". `nest start --watch` restarts the API on
#   every file save, so the wrapped path dies on the first code edit. The
#   raw secret_id, combined with the dev AppRole's secret_id_num_uses=0 +
#   secret_id_ttl=720h (Phase A.1), is reusable across UNLIMITED restarts
#   for ~30 days — which is exactly what a watch-mode dev loop needs.
#   Production keeps the wrapped path (one-shot token injected per pod);
#   see the provider docstring: wrapped = prod, raw = dev.
#
# WHEN TO RUN THIS:
#   - First time setup, after `./scripts/dev-infra.sh up`
#   - After `docker compose down -v` (volumes wiped -> fresh role_id)
#   - After recreating the Vault container (dev-mode state is in-memory)
#   - Once the 30-day secret_id_ttl lapses (rare)
#   You do NOT run this per restart — the raw secret_id is reusable.
#
# USAGE:
#   ./scripts/refresh-vault-creds.sh
#
# REQUIRES:
#   - Docker running with the hope-vault container up
#       ./scripts/dev-infra.sh up
#   - Vault dev-mode root token (read from VAULT_DEV_ROOT_TOKEN or defaults
#     to "root" - the dev-init.sh default).
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.dev"
CONTAINER="${VAULT_CONTAINER:-hope-vault}"
ROOT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# --- 1. Pre-flight checks ---------------------------------------------------

if [ ! -f "${ENV_FILE}" ]; then
  red "ERROR: ${ENV_FILE} not found. Run 'pnpm setup:dev' (creates it from .env.sample), or manually: cp .env.sample .env.dev"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  red "ERROR: container '${CONTAINER}' is not running."
  echo "Start the dev infra first:"
  echo "  ./scripts/dev-infra.sh up"
  exit 1
fi

if ! grep -qE '^VAULT_ROLE_ID=' "${ENV_FILE}" || ! grep -qE '^VAULT_SECRET_ID=' "${ENV_FILE}"; then
  red "ERROR: ${ENV_FILE} is missing VAULT_ROLE_ID or VAULT_SECRET_ID lines."
  echo "Add empty placeholders before running this script:"
  echo "  echo 'VAULT_ROLE_ID=' >> ${ENV_FILE}"
  echo "  echo 'VAULT_SECRET_ID=' >> ${ENV_FILE}"
  exit 1
fi

# --- 2. Mint fresh credentials ---------------------------------------------

green "-> Reading role_id from Vault"
ROLE_ID=$(docker exec "${CONTAINER}" sh -lc \
  "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; vault read -field=role_id auth/approle/role/hope-app/role-id")

if [ -z "${ROLE_ID}" ]; then
  red "ERROR: failed to read role_id. Is the vault-init sidecar healthy?"
  echo "Inspect with:  docker logs hope-vault-init"
  exit 1
fi

green "-> Minting raw secret_id (reusable; secret_id_ttl=720h, num_uses=0)"
SECRET_ID=$(docker exec "${CONTAINER}" sh -lc \
  "export VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${ROOT_TOKEN}; vault write -f -field=secret_id auth/approle/role/hope-app/secret-id")

if [ -z "${SECRET_ID}" ]; then
  red "ERROR: failed to mint secret_id."
  exit 1
fi

# --- 3. Patch .env.dev (idempotent, BSD-sed compatible) --------------------

# `sed -i.bak` works on both BSD (macOS) and GNU (Linux). We delete the
# backup after a successful write so we don't pollute the working tree.
# VAULT_WRAPPED_SECRET_ID is blanked so VaultSecretsProvider takes the raw
# (reusable) secret_id path instead of the one-shot unwrap path.
green "-> Updating ${ENV_FILE}"
sed -i.bak -E "s|^VAULT_ROLE_ID=.*|VAULT_ROLE_ID=${ROLE_ID}|" "${ENV_FILE}"
sed -i.bak -E "s|^VAULT_SECRET_ID=.*|VAULT_SECRET_ID=${SECRET_ID}|" "${ENV_FILE}"
sed -i.bak -E "s|^VAULT_WRAPPED_SECRET_ID=.*|VAULT_WRAPPED_SECRET_ID=|" "${ENV_FILE}"
rm -f "${ENV_FILE}.bak"
# The sed above no-ops if the line is absent (older .env.dev layouts), which
# would leave a stale wrapped token elsewhere taking precedence. Guarantee the
# blank line exists so the raw path is always the one taken.
if ! grep -qE '^VAULT_WRAPPED_SECRET_ID=' "${ENV_FILE}"; then
  printf 'VAULT_WRAPPED_SECRET_ID=\n' >> "${ENV_FILE}"
fi

# --- 4. Summary ------------------------------------------------------------

green ""
green "[OK] .env.dev refreshed"
echo   "    VAULT_ROLE_ID            = ${ROLE_ID}"
echo   "    VAULT_SECRET_ID          = ${SECRET_ID:0:8}...  (raw, reusable ~30 days)"
echo   "    VAULT_WRAPPED_SECRET_ID  = (blanked; raw path active)"
echo   ""
yellow "Next step:  pnpm api:dev"
yellow "  - The raw secret_id is reusable across UNLIMITED restarts (incl. watch reloads)."
yellow "  - Re-run this script only when you reset Docker volumes or recreate Vault,"
yellow "    or once the 30-day secret_id_ttl lapses."
