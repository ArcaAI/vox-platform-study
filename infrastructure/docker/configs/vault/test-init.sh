#!/usr/bin/env sh
# Isolated TEST Vault dev-mode bootstrap.
#
# Trimmed twin of dev-init.sh, run inside the `vault-init-test` sidecar
# (tests/docker-compose.test.yml) against the standalone `hope-vault-test`
# container. Unlike dev, test only needs kv-v2 + transit + AppRole:
#   - no `database` engine (test uses PG_DYNAMIC_CREDS=false, static creds)
#   - no audit device (.env.test's VAULT_AUDIT_LOG_PATH is a host placeholder
#     file ensure-test-vault-creds.sh touches to stop VaultRotationWorker
#     ENOENT-ing — it was never wired to a real audit log for test)
#   - no KV placeholder seeding or k8s/CI policy-parity files (dev-only;
#     vault-seed-secrets.sh syncs real values from .env.test afterward)
#
# ORDERING DIFFERS FROM dev-init.sh ON PURPOSE: transit keys are created
# BEFORE the AppRole role here, so "can I read auth/approle/role/hope-app/role-id"
# is a true full-readiness signal. In dev-init.sh the role is created first and
# transit keys last, which only "works" because of incidental timing — test
# needs a real gate since ensure-test-vault-creds.sh polls exactly that field.
#
# Idempotent: each `vault ... || true` line tolerates a re-run.
set -eu

export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
export VAULT_TOKEN="${VAULT_DEV_ROOT_TOKEN:-root}"

echo "[vault-init-test] waiting for Vault to be ready"
until vault status >/dev/null 2>&1; do sleep 1; done

echo "[vault-init-test] ensuring kv-v2 at path 'secret'"
vault secrets enable -path=secret -version=2 kv-v2 2>/dev/null || true
vault kv enable-versioning secret/ 2>/dev/null || true

echo "[vault-init-test] enabling transit at path 'transit'"
vault secrets enable -path=transit transit 2>/dev/null || true

echo "[vault-init-test] creating transit key 'hope-globalsetting'"
vault write -f transit/keys/hope-globalsetting 2>/dev/null || true
vault write transit/keys/hope-globalsetting/config \
  min_decryption_version=1 \
  deletion_allowed=false \
  exportable=false 2>/dev/null || true

echo "[vault-init-test] creating transit key 'hope-phi'"
vault write -f transit/keys/hope-phi 2>/dev/null || true
vault write transit/keys/hope-phi/config \
  min_decryption_version=1 \
  deletion_allowed=false \
  exportable=false 2>/dev/null || true

echo "[vault-init-test] enabling AppRole auth"
vault auth enable approle 2>/dev/null || true

echo "[vault-init-test] writing hope-app policy"
vault policy write hope-app /vault/init/policies/hope-app.hcl

echo "[vault-init-test] creating hope-app role"
# Same dev-mode ergonomics as dev-init.sh (see that file for rationale).
# DO NOT copy these settings to any production AppRole role.
vault write auth/approle/role/hope-app \
  token_policies="hope-app" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=720h \
  secret_id_num_uses=0

echo "[vault-init-test] role_id (committable):"
vault read -field=role_id auth/approle/role/hope-app/role-id

echo "[vault-init-test] OK"
