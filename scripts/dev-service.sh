#!/bin/bash
# ============================================================================
# TASK-346 — Single-service dev launcher (Python services + harness worker)
# ============================================================================
# Starts one HOPE Python service with the PROVEN-working dev defaults baked
# in. Every default is applied with `: "${VAR:=default}"`, so anything you
# export in your shell wins. Explicit env vars also beat the (gitignored,
# possibly stale) app-level .env files — that is intentional: startup is
# deterministic regardless of local file drift.
#
# USAGE:
#   ./scripts/dev-service.sh <stt|smr|nlp|guardrail|harness|tts|worker> [--watch] [--print]
#   ./scripts/dev-service.sh --check-stt-key      # preflight only (used by dev:doctor)
#
# FLAGS:
#   --watch   uvicorn --reload scoped to the service's own src dir (default is
#             NO reload: the old repo-wide watcher kept cancelling STT's ~4 GB
#             model warm-up on unrelated file churn).
#   --print   print resolved env + the exact command without starting anything
#             (also: DRY_RUN=1). Secrets are never printed.
#
# PORT OVERRIDES (for side-by-side verification etc.):
#   STT_PORT (8861), SMR_PORT (8862), GUARDRAIL_PORT (8863), NLP_PORT (8864),
#   HARNESS_PORT (8866), TTS_PORT (8865)
#
# BIND ADDRESS:
#   Services bind 127.0.0.1 by default — these are PHI-processing dev
#   services and must not listen on the LAN by accident. To expose one
#   deliberately (e.g. testing from a phone), export HOST=0.0.0.0.
#
# MACHINE-SPECIFIC MODEL:
#   LM_STUDIO_MODEL (default: gemma-4-e4b-it-qat) feeds both the SMR default
#   model and the harness worker's HARNESS_SMR_MODEL. Export it in your shell
#   profile if your LM Studio has a different model loaded.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONDA_ENV="${CONDA_ENV:-arcaenv}"

usage() {
    sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ----------------------------------------------------------------------------
# STT key preflight — apps/stt reads API_GATEWAY_KEY from the environment
# or from gitignored apps/stt/.env. A placeholder line whose inline
# comment was parsed AS the value once caused every internal call to 401.
# Never prints the value.
# ----------------------------------------------------------------------------
check_stt_key() {
    local val="" src=""
    if [ -n "${API_GATEWAY_KEY:-}" ]; then
        val="$API_GATEWAY_KEY"
        src="environment"
    elif [ -f "apps/stt/.env" ]; then
        val="$(sed -n 's/^[[:space:]]*API_GATEWAY_KEY[[:space:]]*=//p' apps/stt/.env | tail -n1)"
        src="apps/stt/.env"
    fi
    # trim whitespace and surrounding quotes
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"

    local reason=""
    if [ -z "$val" ]; then
        reason="API_GATEWAY_KEY is empty or missing"
    elif printf '%s' "$val" | grep -q '#'; then
        reason="API_GATEWAY_KEY contains '#' — an inline comment was parsed as the value"
    elif printf '%s' "$val" | grep -qiE 'REQUIRED|SECRET|PLACEHOLDER|CHANGEME|your[-_]|<|>'; then
        reason="API_GATEWAY_KEY looks like a placeholder"
    elif [ "${#val}" -lt 20 ]; then
        reason="API_GATEWAY_KEY is suspiciously short (${#val} chars)"
    fi

    if [ -n "$reason" ]; then
        echo -e "${RED}STT key preflight FAILED: ${reason}.${NC}" >&2
        echo "Fix: set a real key in apps/stt/.env (API_GATEWAY_KEY=...) or export API_GATEWAY_KEY." >&2
        echo "The committed dev-seed service-account key lives in" >&2
        echo "  packages/database/src/prisma/db_main/seed/00-constants.ts (API_KEYS.SERVICE_ACCOUNT)" >&2
        echo "or generate one with: pnpm gen:api-key" >&2
        return 1
    fi
    echo -e "${GREEN}STT key preflight OK${NC} (source: ${src}, value not shown)"
}

check_conda_env() {
    if ! command -v conda >/dev/null 2>&1; then
        echo -e "${RED}Error: conda not found on PATH.${NC}" >&2
        exit 1
    fi
    if ! conda env list 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $1}' | grep -qx "$CONDA_ENV"; then
        echo -e "${RED}Error: conda environment '$CONDA_ENV' not found.${NC} Set it up with: pnpm setup:python" >&2
        exit 1
    fi
}

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------
SERVICE=""
WATCH=0
PRINT="${DRY_RUN:-0}"

for arg in "$@"; do
    case "$arg" in
        --) ;; # pnpm forwards the literal `--` separator
        --check-stt-key) check_stt_key; exit $? ;;
        --watch) WATCH=1 ;;
        --print) PRINT=1 ;;
        --help|-h) usage; exit 0 ;;
        stt|smr|nlp|guardrail|harness|tts|worker) SERVICE="$arg" ;;
        *) echo -e "${RED}Unknown argument: $arg${NC}" >&2; usage >&2; exit 2 ;;
    esac
done

if [ -z "$SERVICE" ]; then
    usage >&2
    exit 2
fi

# ----------------------------------------------------------------------------
# Per-service env defaults (user env always wins) + command
# ----------------------------------------------------------------------------
: "${LM_STUDIO_MODEL:=gemma-4-e4b-it-qat}"
# Loopback by default; export HOST=0.0.0.0 to expose on the LAN (deliberate
# opt-in — PHI-processing dev services must not be LAN-reachable by accident).
: "${HOST:=127.0.0.1}"

ENV_REPORT=()   # KEY=VALUE lines for --print (non-secret only)
CMD=()
RELOAD_DIR=""

apply_smr_env() {
    : "${SMR_OPENAI_COMPAT_ENABLED:=true}"
    : "${SMR_OPENAI_COMPAT_BASE_URL:=http://localhost:1234/v1}"
    : "${SMR_OPENAI_COMPAT_DEFAULT_MODEL:=${LM_STUDIO_MODEL}}"
    : "${SMR_EXTERNAL_GUARDRAIL_ENABLED:=false}"
    export SMR_OPENAI_COMPAT_ENABLED SMR_OPENAI_COMPAT_BASE_URL \
        SMR_OPENAI_COMPAT_DEFAULT_MODEL SMR_EXTERNAL_GUARDRAIL_ENABLED
    ENV_REPORT+=(
        "SMR_OPENAI_COMPAT_ENABLED=$SMR_OPENAI_COMPAT_ENABLED"
        "SMR_OPENAI_COMPAT_BASE_URL=$SMR_OPENAI_COMPAT_BASE_URL"
        "SMR_OPENAI_COMPAT_DEFAULT_MODEL=$SMR_OPENAI_COMPAT_DEFAULT_MODEL"
        "SMR_EXTERNAL_GUARDRAIL_ENABLED=$SMR_EXTERNAL_GUARDRAIL_ENABLED"
    )
}

# Resolve the shared HARNESS_SERVICE_TOKEN the harness API + worker present as the
# outbound `X-Service-Token` to apps/api (and validate their own inbound calls
# with). The gateway's HarnessServiceTokenGuard is FAIL-CLOSED: it compares this
# against the `HARNESS_SERVICE_TOKEN` it resolves from Vault, so an UNSET token here
# makes the worker send an empty header and every outbound call (fetch_policy,
# persist_draft, ...) 401s → the loop silently degrades to reduced assurance. This
# does NOT weaken the gateway guard — it just makes the harness present the token
# the dev Vault bootstrap already seeded. Precedence (ambient wins, then the
# canonical dev sources): shell env → .env.dev → the value seeded by
# infrastructure/docker/configs/vault/dev-init.sh (== .env.example). Never printed.
resolve_harness_service_token() {
    if [ -n "${HARNESS_SERVICE_TOKEN:-}" ]; then
        return 0
    fi
    if [ -f ".env.dev" ]; then
        local from_env
        from_env="$(sed -n 's/^[[:space:]]*HARNESS_SERVICE_TOKEN[[:space:]]*=//p' .env.dev | tail -n1)"
        from_env="$(printf '%s' "$from_env" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
        if [ -n "$from_env" ]; then
            HARNESS_SERVICE_TOKEN="$from_env"
            return 0
        fi
    fi
    # The value seeded into dev Vault by dev-init.sh (kept in lock-step with
    # .env.example). The gateway resolves the SAME value from Vault in dev.
    HARNESS_SERVICE_TOKEN="dev-harness-service-token-change-me"
}

apply_harness_env() {
    : "${HARNESS_SMR_BASE_URL:=http://localhost:8862}"
    : "${HARNESS_NLP_BASE_URL:=http://localhost:8864}"
    : "${HARNESS_API_BASE_URL:=http://localhost:8868}"
    : "${HARNESS_SMR_PROVIDER:=lm-studio}"
    : "${HARNESS_SMR_MODEL:=${LM_STUDIO_MODEL}}"
    : "${HARNESS_RETRIEVAL_ENABLED:=false}"
    resolve_harness_service_token
    export HARNESS_SMR_BASE_URL HARNESS_NLP_BASE_URL HARNESS_API_BASE_URL \
        HARNESS_SMR_PROVIDER HARNESS_SMR_MODEL HARNESS_RETRIEVAL_ENABLED \
        HARNESS_SERVICE_TOKEN
    ENV_REPORT+=(
        "HARNESS_SMR_BASE_URL=$HARNESS_SMR_BASE_URL"
        "HARNESS_NLP_BASE_URL=$HARNESS_NLP_BASE_URL"
        "HARNESS_API_BASE_URL=$HARNESS_API_BASE_URL"
        "HARNESS_SMR_PROVIDER=$HARNESS_SMR_PROVIDER"
        "HARNESS_SMR_MODEL=$HARNESS_SMR_MODEL"
        "HARNESS_RETRIEVAL_ENABLED=$HARNESS_RETRIEVAL_ENABLED"
        # HARNESS_SERVICE_TOKEN deliberately omitted from the report (secret).
        "HARNESS_SERVICE_TOKEN=<set, not shown>"
    )
}

case "$SERVICE" in
    stt)
        : "${STT_PORT:=8861}"
        ENV_REPORT+=("HOST=$HOST" "STT_PORT=$STT_PORT")
        CMD=(uvicorn stt.main:app --host "$HOST" --port "$STT_PORT" --app-dir apps/stt/src)
        RELOAD_DIR="apps/stt/src"
        ;;
    smr)
        : "${SMR_PORT:=8862}"
        apply_smr_env
        ENV_REPORT+=("HOST=$HOST" "SMR_PORT=$SMR_PORT")
        CMD=(uvicorn smr.main:app --host "$HOST" --port "$SMR_PORT" --app-dir apps/smr/src)
        RELOAD_DIR="apps/smr/src"
        ;;
    nlp)
        : "${NLP_PORT:=8864}"
        ENV_REPORT+=("HOST=$HOST" "NLP_PORT=$NLP_PORT")
        CMD=(uvicorn --factory nlp.app:get_app --host "$HOST" --port "$NLP_PORT" --app-dir apps/nlp/src)
        RELOAD_DIR="apps/nlp/src"
        ;;
    guardrail)
        : "${GUARDRAIL_PORT:=8863}"
        ENV_REPORT+=("HOST=$HOST" "GUARDRAIL_PORT=$GUARDRAIL_PORT")
        CMD=(uvicorn guardrail.main:app --host "$HOST" --port "$GUARDRAIL_PORT" --app-dir apps/guardrail/src)
        RELOAD_DIR="apps/guardrail/src"
        ;;
    harness)
        : "${HARNESS_PORT:=8866}"
        apply_harness_env
        ENV_REPORT+=("HOST=$HOST" "HARNESS_PORT=$HARNESS_PORT")
        CMD=(uvicorn harness.main:app --host "$HOST" --port "$HARNESS_PORT" --app-dir apps/harness/src)
        RELOAD_DIR="apps/harness/src"
        ;;
    tts)
        : "${TTS_PORT:=8865}"
        ENV_REPORT+=("HOST=$HOST" "TTS_PORT=$TTS_PORT")
        CMD=(uvicorn tts.main:app --host "$HOST" --port "$TTS_PORT" --app-dir apps/tts/src)
        RELOAD_DIR="apps/tts/src"
        ;;
    worker)
        apply_harness_env
        CMD=(python -m harness.temporal.worker)
        if [ "$WATCH" = "1" ]; then
            echo -e "${YELLOW}--watch is not supported for the Temporal worker; ignoring.${NC}" >&2
            WATCH=0
        fi
        ;;
esac

if [ "$WATCH" = "1" ]; then
    CMD+=(--reload --reload-dir "$RELOAD_DIR")
fi

FULL_CMD=(conda run -n "$CONDA_ENV" --no-capture-output "${CMD[@]}")

# ----------------------------------------------------------------------------
# Print / preflight / launch
# ----------------------------------------------------------------------------
if [ "$PRINT" = "1" ]; then
    echo "service: $SERVICE"
    echo "resolved env (user env > these defaults > app .env files):"
    if [ "${#ENV_REPORT[@]}" -gt 0 ]; then
        printf '  %s\n' "${ENV_REPORT[@]}"
    fi
    if [ "$SERVICE" = "stt" ]; then
        if [ -n "${API_GATEWAY_KEY:-}" ]; then
            echo "  API_GATEWAY_KEY=<masked> (from environment)"
        else
            echo "  API_GATEWAY_KEY=<masked> (expected in apps/stt/.env — run --check-stt-key)"
        fi
    fi
    echo "command:"
    printf '  %s\n' "${FULL_CMD[*]}"
    exit 0
fi

if [ "$SERVICE" = "stt" ]; then
    check_stt_key
fi

check_conda_env

echo -e "${GREEN}Starting ${SERVICE} →${NC} ${FULL_CMD[*]}"
exec "${FULL_CMD[@]}"
