#!/usr/bin/env sh
# Phase 1A Task 1.2 (TASK-302 Stream B) - Vault dev-mode bootstrap.
#
# Mounts the kv-v2, transit, database secrets engines plus a file audit device
# on the local dev Vault container. Run inside the `vault-init` sidecar
# (added in Task 1.3) which connects to the `hope-vault` container.
#
# Idempotent: each `vault secrets enable ... || true` line tolerates a re-run.
set -eu

export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

echo "[vault-init] waiting for Vault to be ready"
until vault status >/dev/null 2>&1; do sleep 1; done

echo "[vault-init] enabling kv-v2 at path 'secret'"
vault secrets enable -path=secret -version=2 kv-v2 2>/dev/null || true

echo "[vault-init] enabling transit at path 'transit'"
vault secrets enable -path=transit transit 2>/dev/null || true

echo "[vault-init] enabling database at path 'database'"
vault secrets enable -path=database database 2>/dev/null || true

echo "[vault-init] enabling file audit device"
mkdir -p /vault/audit
vault audit enable file file_path=/vault/audit/vault-audit.log 2>/dev/null || true

echo "[vault-init] OK"
