#!/usr/bin/env sh
# Vault dev-mode bootstrap.
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

# Audit device writes from the *vault server* process. The file lives
# at /vault/audit, which docker-compose.dev.yml bind-mounts from the
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

# Dev/prod parity.
#
# THE LAYOUT IS THE CONTRACT, THE TRANSPORT IS NOT. In the cluster a Vault Agent
# sidecar renders `secret/data/hope/<NAME>` into a file per secret and the pod
# reads files (see deployment/vault-agent/README.md); in dev the process reads
# the same paths over HTTP through SecretsService. Same mount, same prefix, same
# `value` field, same per-service policies — so a policy bug shows up on a laptop
# instead of in staging.
#
# The per-service policies are loaded here even though dev-mode uses the single
# `hope-app` AppRole: writing them exercises the same files the cluster's
# Kubernetes auth roles bind to, which is the only cheap way to catch a typo in
# a secret name before a pod silently reads nothing.
if [ -d /vault/init/policies/k8s ]; then
  for POLICY in /vault/init/policies/k8s/*.hcl; do
    [ -f "${POLICY}" ] || continue
    NAME="$(basename "${POLICY}" .hcl)"
    echo "[vault-init] writing ${NAME} policy (cluster parity)"
    vault policy write "${NAME}" "${POLICY}"
  done
fi

# CI policies (GitLab OIDC → auth/jwt-gitlab). Dev has no GitLab, so no JWT auth
# mount is enabled here; the policies are still written so `vault policy read`
# is a working reference and a syntax error surfaces locally.
for CI_POLICY in hope-ci hope-ci-deploy; do
  if [ -f "/vault/init/policies/${CI_POLICY}.hcl" ]; then
    echo "[vault-init] writing ${CI_POLICY} policy (CI parity)"
    vault policy write "${CI_POLICY}" "/vault/init/policies/${CI_POLICY}.hcl"
  fi
done

echo "[vault-init] creating hope-app role"
# DEV-MODE config. Production overlay
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
# Full COMMON_SERVICE_WARMUP_KEYS coverage (11/11).
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
  "TEXT_SERVICE_TOKEN=dev-text-service-token-not-for-prod" \
  "MQTT_PASS=dev-mqtt-pass-not-for-prod" \
  "REDIS_PASS=dev-redis-pass-not-for-prod"; do
  k=${kv%%=*}
  v=${kv#*=}
  vault kv put "secret/hope/${k}" value="${v}" >/dev/null
done

# apps/api <-> apps/harness shared service token. Unlike the
# warmup keys above it is fetched on-demand (HarnessOpsClient / HarnessGatewayService /
# HarnessServiceTokenGuard via SecretsService.getSecretOptional), so it lives outside
# the warmup loop. The value MUST equal apps/harness/.env's HARNESS_SERVICE_TOKEN, or
# apps/harness rejects apps/api's outbound /api/v1/internal/harness/* calls with 401.
vault kv put secret/hope/HARNESS_SERVICE_TOKEN value="dev-harness-service-token-change-me" >/dev/null

# InternalServiceTokenGuard's per-service secret map
# (apps/api/src/modules/internal/internal-service-token.guard.ts) — the
# INBOUND tokens text/nlp/guardrail/tts/stt present as `X-Service-Token`
# (stt: `X-Internal-Service-Key`) when THEY poll the gateway's
# `/api/v1/internal/effective-config`. On-demand like HARNESS_SERVICE_TOKEN
# above, not in the warmup loop.
#
# NAMING TRAP — text only: the gateway's OUTBOUND credential to reach TEXT is
# `TEXT_SERVICE_TOKEN` (seeded in the warmup loop above); TEXT's INBOUND token
# for calling back into the gateway is the *differently named*
# `TEXT_SERVICE_TOKEN` (TEXT reads it as `settings.service_token` under the
# `TEXT_` pydantic-settings prefix). The two secret names are distinct but
# MUST hold the same value by convention, or the effective-config poll 401s —
# kept equal to TEXT_SERVICE_TOKEN's value here for exactly that reason.
vault kv put secret/hope/TEXT_SERVICE_TOKEN value="dev-text-service-token-not-for-prod" >/dev/null
vault kv put secret/hope/NLP_SERVICE_TOKEN value="dev-nlp-service-token-not-for-prod" >/dev/null
vault kv put secret/hope/GUARDRAIL_SERVICE_TOKEN value="dev-guardrail-service-token-not-for-prod" >/dev/null
vault kv put secret/hope/TTS_SERVICE_TOKEN value="dev-tts-service-token-not-for-prod" >/dev/null
vault kv put secret/hope/API_GATEWAY_KEY value="dev-api-gateway-key-not-for-prod" >/dev/null

# Remaining SELF-HOSTED vault-kv descriptors, so the dev
# Vault covers every path a cluster Vault Agent will render for guardrail and
# harness (deployment/vault-agent/README.md § Per-service secret sets).
#
# The harness claim-check store is self-hosted by contract (PHI blobs must not
# egress), so in dev it aliases the MinIO credential exactly as S3_* does.
# (guardrail no longer appears here: TASK-735 left it with no vendor credential.)
vault kv put secret/hope/HARNESS_CLAIM_CHECK_ACCESS_KEY value="minio_admin" >/dev/null
vault kv put secret/hope/HARNESS_CLAIM_CHECK_SECRET_KEY value="minio_admin" >/dev/null

# DELIBERATELY NOT SEEDED — the two remaining EXTERNAL provider credentials:
#   AZURE_FOUNDRY_API_KEY  HARNESS_JUDGE_OPENAI_COMPAT_API_KEY
# (AZURE_SPEECH_KEY, TEXT_AZURE_API_KEY and TTS_SARVAM_API_KEY are gone:
#  TASK-602 made them BYOK-only db-secrets delivered per request, so their
#  env/Vault names now match no field at all and seeding one would be inert.)
# A placeholder would make an unconfigured provider look configured and turn a
# clean "not configured" into a remote 401 that costs an afternoon to diagnose.
# Every one is failMode 'closed', so absence is the correct, visible signal —
# the same rule scripts/vault-seed-secrets.sh follows when a value is unset.
# Set them with `vault kv put secret/hope/<NAME> value=...` when you need them.

# Transit key for envelope-encrypting
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

# Data Encryption Initiative Phase 3A — dedicated PHI Transit key for
# field-encrypting free-text clinical content (ContextItem.content and the
# Phase 3C clinical fields). Kept SEPARATE from 'hope-globalsetting' so PHI
# rotation cadence and Transit policy blast radius are independent from the
# secrets-encryption key. Same hardened config as above:
#   min_decryption_version=1 — historical ciphertexts stay decryptable post-rotation.
#   deletion_allowed=false   — destructive key delete must be explicitly enabled first.
#   exportable=false         — key material never leaves Vault (server-side crypto).
echo "[vault-init] creating transit key 'hope-phi'"
vault write -f transit/keys/hope-phi 2>/dev/null || true

vault write transit/keys/hope-phi/config \
  min_decryption_version=1 \
  deletion_allowed=false \
  exportable=false 2>/dev/null || true

# Vault database secrets engine for short-
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
# Dev default is `hope` (the local dev DB created by
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
# Capacity math:
#   max_open_connections per role × N pods × N nodes < PG max_connections
#   defaults: 50/role × 3 nodes = 150 < 200 (PG default). With higher
#   pod counts the operator must tune max_open_connections downward.
#
# TTL defaults (BUG-006 follow-up): default_ttl=1h keeps the lease-renewal
# cadence modest (VaultLeaseRenewer renews every ~30min); max_ttl=168h (7d)
# is the dev rotation ceiling — the underlying PG role is force-rotated
# (DROP+CREATE via wrapper.swap()) only once a week instead of daily.
# Widening max_ttl trades a larger compromised-credential blast-radius
# window for far fewer forced pool-swap events; matches the value in
# scripts/setup-dev-vault-db.sh (must stay in sync — see
# docs/operations/vault/README.md "Dynamic DB credentials").
echo "[vault-init] creating database/roles/hope-app-role"
vault write database/roles/hope-app-role \
  db_name=hope-main \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' INHERIT IN ROLE hope_app_template;" \
  revocation_statements="REVOKE ALL PRIVILEGES ON DATABASE ${VAULT_DB_NAME} FROM \"{{name}}\"; REASSIGN OWNED BY \"{{name}}\" TO hope_app_template; DROP OWNED BY \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="168h" \
  max_open_connections=50 2>/dev/null || true

echo "[vault-init] OK"
