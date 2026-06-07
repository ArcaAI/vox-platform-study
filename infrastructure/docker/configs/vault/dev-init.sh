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

# Audit device writes from the *vault server* process. TASK-312 A.4 moves
# the file to /vault/audit, which docker-compose.dev.yml bind-mounts from the
# host (/tmp/hope-vault-audit). This makes the audit log readable by the API
# process running on the HOST (`pnpm dev:api`), which the VaultRotationWorker
# tails for cluster-wide cache invalidation. A named volume (the old
# /vault/file location) is not host-readable at a stable path.
# Dev-mode Vault state is in-memory, so this re-enables fresh on every
# `start-infra.sh --all`; no volume reset is needed to pick up the new path.
echo "[vault-init] enabling file audit device at /vault/audit (host bind-mount)"
vault audit enable file file_path=/vault/audit/vault-audit.log 2>/dev/null || true

echo "[vault-init] enabling AppRole auth"
vault auth enable approle 2>/dev/null || true

echo "[vault-init] writing hope-app policy"
vault policy write hope-app /vault/init/policies/hope-app.hcl

echo "[vault-init] creating hope-app role"
# TASK-312 Phase A.1 — DEV-MODE config. Production overlay (Phase D)
# tightens to secret_id_num_uses=1, secret_id_ttl=24h. Dev posture below
# trades single-use for daily-iteration ergonomics (laptop threat model):
#   secret_id_ttl=720h        — one wrapped secret_id lasts 30 days
#   secret_id_num_uses=0      — unlimited reuse within that window
#   token_ttl=1h              — short access tokens (Phase B adds renewal)
#   token_max_ttl=24h         — cap; renewal loop keeps long-running pods alive
# DO NOT copy these settings to any production AppRole role.
vault write auth/approle/role/hope-app \
  token_policies="hope-app" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=720h \
  secret_id_num_uses=0

echo "[vault-init] role_id (committable):"
vault read -field=role_id auth/approle/role/hope-app/role-id

echo "[vault-init] seeding dev placeholder secrets"
# TASK-312 Phase A.2 — full COMMON_SERVICE_WARMUP_KEYS coverage (11/11).
# S3_* aliases MINIO_* in dev (HOPE talks S3 protocol to MinIO).
# MQTT_PASS / REDIS_PASS use dev placeholders instead of empty strings so the
# warmup pre-fetch lands a real value into the LRU cache (empty values pass
# through but trigger needless re-fetches under stale-while-revalidate).
for kv in \
  "JWT_SECRET_KEY=dev-jwt-secret-not-for-prod" \
  "SESSION_SECRET_KEY=dev-session-secret-not-for-prod" \
  "API_KEY_PEPPER=dev-api-key-pepper-not-for-prod" \
  "OIDC_CLIENT_SECRET=dev-oidc-client-secret-not-for-prod" \
  "MINIO_ACCESS_KEY=minio_admin" \
  "MINIO_SECRET_KEY=minio_admin" \
  "S3_ACCESS_KEY=minio_admin" \
  "S3_SECRET_KEY=minio_admin" \
  "SMR_SERVICE_TOKEN=dev-smr-service-token-not-for-prod" \
  "MQTT_PASS=dev-mqtt-pass-not-for-prod" \
  "REDIS_PASS=dev-redis-pass-not-for-prod"; do
  k=${kv%%=*}
  v=${kv#*=}
  vault kv put "secret/hope/${k}" value="${v}" >/dev/null
done

# TASK-330 Phase 6 — apps/api <-> apps/harness shared service token. Unlike the
# warmup keys above it is fetched on-demand (HarnessOpsClient / HarnessGatewayService /
# HarnessServiceTokenGuard via SecretsService.getSecretOptional), so it lives outside
# the warmup loop. The value MUST equal apps/harness/.env's HARNESS_SERVICE_TOKEN, or
# apps/harness rejects apps/api's outbound /api/v1/internal/harness/* calls with 401.
vault kv put secret/hope/HARNESS_SERVICE_TOKEN value="dev-harness-service-token-change-me" >/dev/null

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
# TASK-312 review: dev default is `hope` (the local dev DB created by
# `pnpm db:all`). The old `hope_main` default never matched any dev DB, so the
# engine connection test silently failed until setup-dev-vault-db.sh re-applied
# it. Production sets VAULT_DB_NAME explicitly.
VAULT_DB_NAME="${VAULT_DB_NAME:-hope}"
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
  revocation_statements="REVOKE ALL PRIVILEGES ON DATABASE ${VAULT_DB_NAME} FROM \"{{name}}\"; REASSIGN OWNED BY \"{{name}}\" TO hope_app_template; DROP OWNED BY \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h" \
  max_open_connections=50 2>/dev/null || true

echo "[vault-init] OK"
