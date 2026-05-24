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

# In Vault dev mode the `secret/` path is auto-mounted as kv v1. We need v2,
# so first try `enable -version=2` (no-op if already v2) and also upgrade in
# place via `kv enable-versioning` (idempotent; works whether the mount is
# already v2 or still v1).
echo "[vault-init] ensuring kv-v2 at path 'secret'"
vault secrets enable -path=secret -version=2 kv-v2 2>/dev/null || true
vault kv enable-versioning secret/ 2>/dev/null || true

echo "[vault-init] enabling transit at path 'transit'"
vault secrets enable -path=transit transit 2>/dev/null || true

echo "[vault-init] enabling database at path 'database'"
vault secrets enable -path=database database 2>/dev/null || true

# Audit device writes from the *vault server* process; the path must be
# writable by the `vault` user inside the hope-vault container. /vault/file
# is the existing dev-mode storage dir owned by vault:vault and persists
# across container restarts via the vault-data volume.
echo "[vault-init] enabling file audit device"
vault audit enable file file_path=/vault/file/vault-audit.log 2>/dev/null || true

echo "[vault-init] enabling AppRole auth"
vault auth enable approle 2>/dev/null || true

echo "[vault-init] writing hope-app policy"
vault policy write hope-app /vault/init/policies/hope-app.hcl

echo "[vault-init] creating hope-app role"
vault write auth/approle/role/hope-app \
  token_policies="hope-app" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=24h \
  secret_id_num_uses=1

echo "[vault-init] role_id (committable):"
vault read -field=role_id auth/approle/role/hope-app/role-id

echo "[vault-init] OK"
