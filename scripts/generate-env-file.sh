#!/usr/bin/env bash
# ============================================================================
# Auto-create local .env.dev / .env.test from .env.sample
# ============================================================================
# Shared by scripts/dev-setup.sh and scripts/test-setup.sh (source this file
# to get `ensure_env_file`), and runnable standalone:
#   ./scripts/generate-env-file.sh .env.dev dev
#   ./scripts/generate-env-file.sh .env.test test
#
# `ensure_env_file <target> <mode>`:
#   - ALWAYS (re)builds <target> from the consolidated `.env.sample` (repo root)
#     on every run, so sample changes and newly-added keys propagate — a stale
#     <target> can never silently miss a key again. For mode=test it then applies
#     the known dev->test overrides (DEV+100 ports, isolated
#     test-infra endpoints, test-only fake secrets); mode=dev applies none
#     (.env.sample's own values are already dev-shaped).
#   - Overwrite is NON-DESTRUCTIVE to secrets: before rebuilding it snapshots the
#     existing file and CARRIES FORWARD every secret/credential value (generated
#     ones AND provider keys you pasted in), so re-running never rotates a secret
#     or loses a filled-in key. Only NON-secret config resets to the sample — the
#     whole point of overwriting. First run generates fresh secrets; later runs
#     keep them. Set FRESH_SECRETS=1 to force true rotation (drops the carry).
#
# Vault AppRole credentials are NOT minted here for either mode — that stays
# scripts/refresh-vault-creds.sh's job (.env.dev) and scripts/test-setup.sh's
# own Step 2 (.env.test), both of which upsert real local-dev-Vault creds AFTER
# this runs. They ARE carried forward across a rebuild so a standalone re-run
# doesn't blank them; the mint step overwrites them again when it runs.
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

# Current value of KEY in a file (empty string if absent).
_current_val() {
  local file="$1" key="$2" line
  line="$(grep -E "^${key}=" "$file" | tail -n1 || true)"
  printf '%s' "${line#*=}"
}

# A URL-safe random hex secret (default 32 bytes → 64 hex chars). openssl on
# every dev box; /dev/urandom fallback keeps it working without it.
_rand_hex() {
  local n="${1:-32}"
  openssl rand -hex "$n" 2>/dev/null || head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Replace a KEY only if it is STILL the literal CHANGE_ME placeholder — never
# clobber a value a mode-override or a developer already set to something real.
_fill_secret() {
  local file="$1" key="$2" val="$3"
  if [ "$(_current_val "$file" "$key")" = "CHANGE_ME" ]; then
    _set_env "$file" "$key" "$val"
  fi
}

# External credentials we CANNOT synthesize — a developer must paste a real key
# to exercise that provider. Left as CHANGE_ME on purpose and reported at the
# end so it's obvious what remains. (Provider SELECTION is fail-closed, so an
# unfilled one simply means "that provider is off", never a silent bad default.)
_EXTERNAL_SECRET_KEYS=(
  OIDC_CLIENT_SECRET
  AZURE_SPEECH_KEY AZURE_FOUNDRY_API_KEY
  TEXT_AZURE_API_KEY TEXT_OPENAI_API_KEY TEXT_ANTHROPIC_API_KEY
  TTS_SARVAM_API_KEY GUARDRAIL_VLLM_API_KEY HARNESS_JUDGE_OPENAI_COMPAT_API_KEY
  AZURE_STORAGE_CONNECTION_STRING AZURE_STORAGE_ACCOUNT_KEY
)

# Secrets a LATER setup step mints — not external, not generated here. Listing them makes the
# closing report honest: without this they were reported as "paste a real value if you use that
# provider", which is wrong advice for a credential `refresh-vault-creds.sh` is about to write.
_MINTED_LATER_KEYS=(
  VAULT_SECRET_ID VAULT_WRAPPED_SECRET_ID
)

# Fill every locally-generatable CHANGE_ME secret with a fresh random value.
# Runs AFTER the mode overrides, so anything a mode already pinned (e.g. test's
# fixed JWT/MinIO creds) is preserved and only the leftovers are generated.
# Vault AppRole creds (VAULT_SECRET_ID / VAULT_WRAPPED_SECRET_ID) are NOT touched
# here — refresh-vault-creds.sh (dev) / test-setup.sh Step 2 (test) mint those.
_fill_generated_secrets() {
  local file="$1" k

  # Independent local secrets: HMAC signing keys, hash peppers, the Vault DB
  # engine admin password, and the shared X-Service-Token per Python service.
  # INTERNAL_ACCESS_TOKEN leads the list deliberately: it is THE canonical internal
  # credential (owner decision D-D) and every per-service token below is only its
  # backward-compatibility fallback. It was absent here while all six legacy tokens were
  # generated, so a fresh dev box got a real value for each fallback and `CHANGE_ME` for the
  # one that supersedes them — which every service then PRESENTED on every internal hop.
  # WEBHOOK_SECRET_PEPPER was missing for no reason at all: it is a local hash pepper, exactly
  # like API_KEY_PEPPER and STORAGE_ACCESS_KEY_PEPPER on the line below it.
  for k in INTERNAL_ACCESS_TOKEN \
           JWT_SECRET_KEY SESSION_SECRET_KEY ADMIN_SESSION_SECRET \
           API_KEY_PEPPER STORAGE_ACCESS_KEY_PEPPER WEBHOOK_SECRET_PEPPER \
           VAULT_DB_ADMIN_PASS REDIS_PASS MQTT_PASS \
           TEXT_SERVICE_TOKEN NLP_SERVICE_TOKEN GUARDRAIL_SERVICE_TOKEN \
           HARNESS_SERVICE_TOKEN TTS_SERVICE_TOKEN HARNESS_INTERNAL_SERVICE_TOKEN \
           API_GATEWAY_KEY; do
    _fill_secret "$file" "$k" "$(_rand_hex 32)"
  done

  # Object-storage credential group. HOPE speaks S3 to the SAME local MinIO, so
  # the MinIO container creds, the S3 alias, the harness claim-check store and
  # the platform-default JSON must all carry ONE access/secret pair. Seed the
  # pair from whatever MINIO_* currently holds (a mode override may have pinned
  # it), else generate, then propagate to every still-placeholder sibling.
  local access secret
  access="$(_current_val "$file" MINIO_ACCESS_KEY)"
  secret="$(_current_val "$file" MINIO_SECRET_KEY)"
  [ "$access" = "CHANGE_ME" ] || [ -z "$access" ] && access="hope$(_rand_hex 8)"
  [ "$secret" = "CHANGE_ME" ] || [ -z "$secret" ] && secret="$(_rand_hex 20)"
  for k in MINIO_ACCESS_KEY S3_ACCESS_KEY HARNESS_CLAIM_CHECK_ACCESS_KEY; do
    _fill_secret "$file" "$k" "$access"
  done
  for k in MINIO_SECRET_KEY S3_SECRET_KEY HARNESS_CLAIM_CHECK_SECRET_KEY; do
    _fill_secret "$file" "$k" "$secret"
  done
  _fill_secret "$file" STORAGE_PLATFORM_DEFAULT_CREDENTIALS \
    "{\"accessKeyId\":\"${access}\",\"secretAccessKey\":\"${secret}\"}"
  # MINIO_ROOT_USER/PASSWORD are compose-interpolation-only (docker-compose.yml,
  # not app config — dev-infra.sh forwards only vars present in this file) but
  # MUST always equal the access/secret pair above: they set the actual login
  # the MinIO container enforces, and every app-side client authenticates with
  # MINIO_ACCESS_KEY/SECRET_KEY. Force-set (not _fill_secret) so a rebuild can
  # never let them drift apart even if a stale value was carried forward.
  _set_env "$file" MINIO_ROOT_USER "$access"
  _set_env "$file" MINIO_ROOT_PASSWORD "$secret"
}

# Report any CHANGE_ME the developer must still fill in by hand.
_report_remaining_placeholders() {
  local file="$1" remaining k external minted unexpected
  remaining="$(grep -E '=CHANGE_ME' "$file" | cut -d= -f1 | sort || true)"
  [ -n "$remaining" ] || { green "→ Generated all local secrets; no CHANGE_ME placeholders remain."; return; }

  external=""; minted=""; unexpected=""
  for k in $remaining; do
    case " ${_EXTERNAL_SECRET_KEYS[*]} " in *" $k "*) external="$external $k"; continue ;; esac
    case " ${_MINTED_LATER_KEYS[*]} "     in *" $k "*) minted="$minted $k";     continue ;; esac
    unexpected="$unexpected $k"
  done

  if [ -n "$external" ]; then
    yellow "→ Paste a real value only if you use that provider (selection is fail-closed,"
    yellow "  so an unfilled one simply means that provider is off):"
    printf '     %s\n' $external >&2
  fi
  if [ -n "$minted" ]; then
    yellow "→ Minted by a later setup step, not by this script — leave them alone:"
    printf '     %s\n' $minted >&2
  fi
  # A secret in NEITHER list is a gap in this script, not a task for the developer. Saying so
  # is the whole point: INTERNAL_ACCESS_TOKEN sat here unnoticed, mis-reported as an optional
  # provider key, while every service shipped it as a live credential.
  if [ -n "$unexpected" ]; then
    red "→ UNCLASSIFIED secret(s) left as CHANGE_ME. These are neither generated here nor"
    red "  declared external — that is a bug in generate-env-file.sh, not something to paste:"
    printf '     %s\n' $unexpected >&2
  fi
}

# The dev -> test delta (DEV+100 port scheme + isolated test infra +
# test-only fake secrets). Matches the previously hand-maintained .env.test
# baseline, minus the Vault block (that's test-setup.sh's own job, below).
_apply_test_overrides() {
  local file="$1"
  _set_env "$file" NODE_ENV test
  _set_env "$file" CI false
  # NOTE: SECRETS_PROVIDER is deliberately NOT overridden here — .env.test keeps
  # the sample's `vault` value because the PHI ciphertext seed, the test API and
  # the e2e/integration suites use real Vault Transit (see test-setup.sh Step 3/6).
  # The unit vitest suites need the SOFT (`!= vault`) no-op path instead; they get
  # it from a project-scoped `env: { SECRETS_PROVIDER: 'env' }` in vitest.config.ts
  # (workspace project), so the unit run is correct regardless of this file.
  #
  # VAULT_ADDR IS overridden: test has its own isolated Vault
  # (hope-vault-test, tests/docker-compose.test.yml) on a different port than
  # dev's shared hope-vault, so the two can never cross-talk.
  _set_env "$file" VAULT_ADDR "http://localhost:8201"
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
  _set_env "$file" TEXT_PORT 8962
  _set_env "$file" TEXT_URL "http://localhost:8962"
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
  # TASK-722 R-1: the public workflow-exposure surface is OFF everywhere by
  # default (`.env.sample`/`.env.dev` keep the platform default `false`) — but
  # the e2e suite (`task-722-workflow-exposure.spec.ts`) needs it ON to
  # exercise the real routes rather than only their kill-switch 404. This is a
  # TEST-ONLY override, same shape as RATE_LIMIT_ENABLED above; it does not
  # change the dev/prod default. WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS
  # stays at the sample's `false` — no e2e case selects a cloud provider.
  _set_env "$file" WORKFLOW_EXPOSURE_ENABLED true
}

# Secret/credential keys preserved across an overwrite. Rebuilding from the
# sample must never rotate a generated secret or drop a provider key you pasted
# in — only NON-secret config resets to the sample. Superset of the generated
# secrets, the storage/infra creds, the external provider keys, the Vault creds
# and ADMIN_SESSION_SECRET.
_CARRY_FORWARD_KEYS=(
  JWT_SECRET_KEY SESSION_SECRET_KEY ADMIN_SESSION_SECRET
  API_KEY_PEPPER STORAGE_ACCESS_KEY_PEPPER
  VAULT_DB_ADMIN_PASS REDIS_PASS MQTT_PASS
  TEXT_SERVICE_TOKEN NLP_SERVICE_TOKEN GUARDRAIL_SERVICE_TOKEN
  HARNESS_SERVICE_TOKEN TTS_SERVICE_TOKEN HARNESS_INTERNAL_SERVICE_TOKEN
  API_GATEWAY_KEY
  MINIO_ACCESS_KEY MINIO_SECRET_KEY S3_ACCESS_KEY S3_SECRET_KEY
  HARNESS_CLAIM_CHECK_ACCESS_KEY HARNESS_CLAIM_CHECK_SECRET_KEY
  STORAGE_PLATFORM_DEFAULT_CREDENTIALS
  VAULT_SECRET_ID VAULT_WRAPPED_SECRET_ID
  "${_EXTERNAL_SECRET_KEYS[@]}"
)

# Copy each still-set, non-placeholder secret from the pre-rebuild snapshot into
# the freshly-rebuilt file. FRESH_SECRETS=1 skips this to force a clean rotation.
_carry_forward_secrets() {
  local newfile="$1" snapshot="$2" k oldval kept=0
  [ -f "$snapshot" ] || return 0
  if [ "${FRESH_SECRETS:-0}" = 1 ]; then
    yellow "→ FRESH_SECRETS=1 — NOT carrying forward prior secrets (rotating all)."
    return 0
  fi
  for k in "${_CARRY_FORWARD_KEYS[@]}"; do
    oldval="$(_current_val "$snapshot" "$k")"
    if [ -n "$oldval" ] && [ "$oldval" != "CHANGE_ME" ]; then
      _set_env "$newfile" "$k" "$oldval"
      kept=$((kept + 1))
    fi
  done
  [ "$kept" -gt 0 ] && green "→ Carried forward $kept existing secret/credential value(s)."
  return 0
}

# ensure_env_file <target-path> <mode: dev|test>
# ALWAYS rebuilds <target> from .env.sample; carries forward existing secrets.
ensure_env_file() {
  local target="$1" mode="$2" snapshot=""

  if [ ! -f "$SAMPLE_FILE" ]; then
    red "ERROR: .env.sample not found at $SAMPLE_FILE"
    exit 1
  fi

  if [ -f "$target" ]; then
    snapshot="$(mktemp)"
    cp "$target" "$snapshot"
    yellow "→ $(basename "$target") exists — rebuilding from .env.sample (secrets preserved)."
  else
    yellow "→ Creating $(basename "$target") from .env.sample."
  fi

  cp "$SAMPLE_FILE" "$target"

  # Restore preserved secrets BEFORE the mode overrides, so deterministic test
  # values (fixed JWT/MinIO/etc.) still win for the keys they pin.
  [ -n "$snapshot" ] && _carry_forward_secrets "$target" "$snapshot"

  case "$mode" in
    dev) ;; # .env.sample values are already dev-shaped — nothing to override.
    test)
      _apply_test_overrides "$target"
      yellow "→ Applied test-environment overrides (DEV+100 ports, isolated test infra)."
      ;;
    *)
      red "ERROR: ensure_env_file: unknown mode '$mode' (expected dev|test)"
      [ -n "$snapshot" ] && rm -f "$snapshot"
      exit 1
      ;;
  esac

  _fill_generated_secrets "$target"
  _report_remaining_placeholders "$target"
  [ -n "$snapshot" ] && rm -f "$snapshot"
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
