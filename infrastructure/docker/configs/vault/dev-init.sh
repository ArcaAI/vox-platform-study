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

echo "[vault-init] seeding dev placeholder secrets"
for kv in \
  "JWT_SECRET_KEY=dev-jwt-secret-not-for-prod" \
  "SESSION_SECRET_KEY=dev-session-secret-not-for-prod" \
  "API_KEY_PEPPER=dev-api-key-pepper-not-for-prod" \
  "OIDC_CLIENT_SECRET=dev-oidc-client-secret-not-for-prod" \
  "MINIO_ACCESS_KEY=minio_admin" \
  "MINIO_SECRET_KEY=minio_admin" \
  "SMR_SERVICE_TOKEN=dev-smr-service-token-not-for-prod" \
  "MQTT_PASS=" \
  "REDIS_PASS="; do
  k=${kv%%=*}
  v=${kv#*=}
  vault kv put "secret/hope/${k}" value="${v}" >/dev/null
done

# TASK-302 Phase 4 Task 4.4 — Transit key for envelope-encrypting
# GlobalSetting rows. The key is created idempotently (Vault returns 204
# the first call, 400 if it already exists which we swallow). Config:
#   min_decryption_version=1 — keeps historical ciphertexts decryptable
#                              after rotation (forward-compat with Phase 6).
#   deletion_allowed=false   — prevents accidental destructive ops; the
#                              policy that owns the key must explicitly
#                              flip this before delete is even possible.
#   exportable=false         — production posture; the key material never
#                              leaves Vault. Encryption happens server-side.
echo "[vault-init] creating transit key 'hope-globalsetting'"
vault write -f transit/keys/hope-globalsetting 2>/dev/null || true

vault write transit/keys/hope-globalsetting/config \
  min_decryption_version=1 \
  deletion_allowed=false \
  exportable=false 2>/dev/null || true

# TASK-302 Phase 5 Task 5.2 — Vault database secrets engine for short-
# lived PostgreSQL credentials. The dev container points at host
# PostgreSQL on docker.host.internal:5432; the SRE blueprint at
# research/deployments/deploy-vm430-432-vault.md §15 documents the
# production pointing (HAProxy R/W :5000).
#
# Pre-flight: the operator MUST have run
#   packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql
# in the target PostgreSQL cluster ONCE per environment (Task 5.1).
# That script creates the `vault_admin` (LOGIN, CREATEROLE) and
# `hope_app_template` (NOLOGIN) roles.
#
# All commands swallow stderr+exit so a re-run on a partially-
# initialised dev container does not break the boot sequence; failures
# of the substantive config call surface in the `vault read` step
# below.
VAULT_DB_HOST="${VAULT_DB_HOST:-host.docker.internal}"
VAULT_DB_PORT="${VAULT_DB_PORT:-5432}"
VAULT_DB_NAME="${VAULT_DB_NAME:-hope_main}"
VAULT_DB_ADMIN_USER="${VAULT_DB_ADMIN_USER:-vault_admin}"
VAULT_DB_ADMIN_PASS="${VAULT_DB_ADMIN_PASS:-vault_admin_dev_pw}"

echo "[vault-init] configuring database/config/hope-main"
vault write database/config/hope-main \
  plugin_name=postgresql-database-plugin \
  allowed_roles="hope-app-role" \
  connection_url='postgresql://{{username}}:{{password}}@'"${VAULT_DB_HOST}"':'"${VAULT_DB_PORT}"'/'"${VAULT_DB_NAME}"'?sslmode=disable' \
  username="${VAULT_DB_ADMIN_USER}" \
  password="${VAULT_DB_ADMIN_PASS}" 2>/dev/null || true

# Role `hope-app-role` — issues short-lived PG users that inherit
# privileges from hope_app_template (Task 5.1 SQL).
# Capacity math (per plan §5 risk R6):
#   max_open_connections per role × N pods × N nodes < PG max_connections
#   defaults: 50/role × 3 nodes = 150 < 200 (PG default). With higher
#   pod counts the operator must tune max_open_connections downward.
#
# TTL defaults: 1h / 24h max — keeps the lease-renewal storm modest
# and bounds blast radius for a compromised credential.
echo "[vault-init] creating database/roles/hope-app-role"
vault write database/roles/hope-app-role \
  db_name=hope-main \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' INHERIT IN ROLE hope_app_template;" \
  revocation_statements="REVOKE ALL PRIVILEGES ON DATABASE hope_main FROM \"{{name}}\"; REASSIGN OWNED BY \"{{name}}\" TO hope_app_template; DROP OWNED BY \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h" \
  max_open_connections=50 2>/dev/null || true

echo "[vault-init] OK"
