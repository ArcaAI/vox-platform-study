#!/usr/bin/env bash
# ============================================================================
# TASK-583 — Auto-create local .env.dev / .env.test from .env.sample
# ============================================================================
# Shared by scripts/dev-setup.sh and scripts/test-setup.sh (source this file
# to get `ensure_env_file`), and runnable standalone:
#   ./scripts/generate-env-file.sh .env.dev dev
#   ./scripts/generate-env-file.sh .env.test test
#
# `ensure_env_file <target> <mode>`:
#   - No-op if <target> already exists — NEVER overwrites a developer's real
#     local config (Vault creds, API keys they've filled in). This is the
#     one invariant that matters: re-running setup must be safe.
#   - Otherwise copies the consolidated `.env.sample` (repo root) to
#     <target>, then for mode=test applies the known dev->test overrides
#     (DEV+100 ports per TASK-557, isolated test-infra endpoints, test-only
#     fake secrets) — the same delta the old hand-maintained .env.test
#     encoded, now applied programmatically. mode=dev applies no overrides;
#     .env.sample's own values are already dev-shaped.
#
# Vault AppRole credentials are NOT set here for either mode — that stays
# scripts/refresh-vault-creds.sh's job (.env.dev) and scripts/test-setup.sh's
# own Step 2 (.env.test), both of which mint real local-dev-Vault creds and
# upsert them into the file AFTER it exists. Keeping that logic where it
# already lives avoids duplicating Vault-provisioning code here.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SAMPLE_FILE="$REPO_ROOT/.env.sample"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# Upsert KEY=VALUE in a file: drop any existing line for KEY, append fresh.
# Robust against values containing sed-special chars (URLs, base64) — no sed.
_set_env() {
  local file="$1" key="$2" val="$3"
  grep -vE "^${key}=" "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

# The dev -> test delta (TASK-557 DEV+100 port scheme + isolated test infra +
# test-only fake secrets). Matches the pre-TASK-583 hand-maintained .env.test
# baseline, minus the Vault block (that's test-setup.sh's own job, below).
_apply_test_overrides() {
  local file="$1"
  _set_env "$file" NODE_ENV test
  _set_env "$file" CI false
  _set_env "$file" DATABASE_URL "postgresql://test:test@localhost:5433/hope_test?schema=public"
  _set_env "$file" DIRECT_URL "postgresql://test:test@localhost:5433/hope_test?schema=public"
  _set_env "$file" REDIS_HOST localhost
  _set_env "$file" REDIS_PORT 6380
  _set_env "$file" REDIS_PASS test_redis_pass
  _set_env "$file" REDIS_URL "redis://:test_redis_pass@localhost:6380"
  _set_env "$file" MINIO_ENDPOINT localhost:9002
  _set_env "$file" MINIO_ACCESS_KEY test
  _set_env "$file" MINIO_SECRET_KEY testpassword
  _set_env "$file" MINIO_USE_SSL false
  _set_env "$file" S3_ENDPOINT "http://localhost:9002"
  _set_env "$file" S3_REGION us-east-1
  _set_env "$file" S3_ACCESS_KEY test
  _set_env "$file" S3_SECRET_KEY testpassword
  _set_env "$file" PORT 8968
  _set_env "$file" API_PORT 8968
  _set_env "$file" API_URL "http://localhost:8968"
  _set_env "$file" ADMIN_PORT 5276
  _set_env "$file" API_INSPECT_HOSTPORT "127.0.0.1:9329"
  _set_env "$file" JWT_SECRET_KEY "test-jwt-secret-key-for-e2e-only-not-for-production-aaaa"
  _set_env "$file" SECRETS_TTL_SEC 86400
  _set_env "$file" SESSION_SECRET_KEY "test-session-secret"
  _set_env "$file" API_KEY_PEPPER "test-pepper-for-testing-only-do-not-use-in-production"
  _set_env "$file" API_KEY_ALLOW_QUERY_PARAM true
  _set_env "$file" API_KEY_MAX_LIFETIME_DAYS 90
  _set_env "$file" RATE_LIMIT_ENABLED false
  _set_env "$file" STT_PORT 8961
  _set_env "$file" STT_URL "http://localhost:8961"
  _set_env "$file" SMR_PORT 8962
  _set_env "$file" SMR_URL "http://localhost:8962"
  _set_env "$file" GUARDRAIL_PORT 8963
  _set_env "$file" GUARDRAIL_URL "http://localhost:8963"
  _set_env "$file" NLP_PORT 8964
  _set_env "$file" NLP_URL "http://localhost:8964"
  _set_env "$file" TTS_PORT 8965
  _set_env "$file" TTS_URL "http://localhost:8965"
  _set_env "$file" HARNESS_PORT 8966
  _set_env "$file" HARNESS_URL "http://localhost:8966"
  _set_env "$file" LOG_LEVEL error
  _set_env "$file" LOG_FILE_ENABLED false
  _set_env "$file" LOG_FILE_PATH "./logs"
  _set_env "$file" OTEL_EXPORTER_OTLP_ENDPOINT ""
  _set_env "$file" OTEL_TRACES_ENABLED false
  _set_env "$file" OTEL_METRICS_ENABLED false
}

# ensure_env_file <target-path> <mode: dev|test>
ensure_env_file() {
  local target="$1" mode="$2"

  if [ -f "$target" ]; then
    green "→ $(basename "$target") already exists — leaving it as-is."
    return 0
  fi

  if [ ! -f "$SAMPLE_FILE" ]; then
    red "ERROR: .env.sample not found at $SAMPLE_FILE"
    exit 1
  fi

  cp "$SAMPLE_FILE" "$target"
  yellow "→ Created $(basename "$target") from .env.sample."

  case "$mode" in
    dev) ;; # .env.sample values are already dev-shaped — nothing to override.
    test)
      _apply_test_overrides "$target"
      yellow "→ Applied test-environment overrides (DEV+100 ports, isolated test infra)."
      ;;
    *)
      red "ERROR: ensure_env_file: unknown mode '$mode' (expected dev|test)"
      exit 1
      ;;
  esac
  green "✔ $(basename "$target") ready."
}

# Runnable standalone: ./scripts/generate-env-file.sh <target> <mode>
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ $# -ne 2 ]; then
    red "Usage: $0 <target-env-file> <dev|test>"
    exit 2
  fi
  ensure_env_file "$1" "$2"
fi
