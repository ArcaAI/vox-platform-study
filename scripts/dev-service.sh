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
#   ./scripts/dev-service.sh <stt|smr|nlp|guardrail|harness|worker> [--watch] [--print]
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
#   HARNESS_PORT (8866)
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
# STT key preflight — apps/stt-v2 reads API_GATEWAY_KEY from the environment
# or from gitignored apps/stt-v2/.env. A placeholder line whose inline
# comment was parsed AS the value once caused every internal call to 401.
# Never prints the value.
# ----------------------------------------------------------------------------
check_stt_key() {
    local val="" src=""
    if [ -n "${API_GATEWAY_KEY:-}" ]; then
        val="$API_GATEWAY_KEY"
        src="environment"
    elif [ -f "apps/stt-v2/.env" ]; then
        val="$(sed -n 's/^[[:space:]]*API_GATEWAY_KEY[[:space:]]*=//p' apps/stt-v2/.env | tail -n1)"
        src="apps/stt-v2/.env"
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
        echo "Fix: set a real key in apps/stt-v2/.env (API_GATEWAY_KEY=...) or export API_GATEWAY_KEY." >&2
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
        echo -e "${RED}Error: conda environment '$CONDA_ENV' not found.${NC} Set it up with: pnpm py:setup" >&2
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
        stt|smr|nlp|guardrail|harness|worker) SERVICE="$arg" ;;
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
    : "${SMR_V2_OPENAI_COMPAT_ENABLED:=true}"
    : "${SMR_V2_OPENAI_COMPAT_BASE_URL:=http://localhost:1234/v1}"
    : "${SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL:=${LM_STUDIO_MODEL}}"
    : "${SMR_V2_EXTERNAL_GUARDRAIL_ENABLED:=false}"
    export SMR_V2_OPENAI_COMPAT_ENABLED SMR_V2_OPENAI_COMPAT_BASE_URL \
        SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL SMR_V2_EXTERNAL_GUARDRAIL_ENABLED
    ENV_REPORT+=(
        "SMR_V2_OPENAI_COMPAT_ENABLED=$SMR_V2_OPENAI_COMPAT_ENABLED"
        "SMR_V2_OPENAI_COMPAT_BASE_URL=$SMR_V2_OPENAI_COMPAT_BASE_URL"
        "SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL=$SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL"
        "SMR_V2_EXTERNAL_GUARDRAIL_ENABLED=$SMR_V2_EXTERNAL_GUARDRAIL_ENABLED"
    )
}

apply_harness_env() {
    : "${HARNESS_SMR_BASE_URL:=http://localhost:8862}"
    : "${HARNESS_NLP_BASE_URL:=http://localhost:8864}"
    : "${HARNESS_API_BASE_URL:=http://localhost:8868}"
    : "${HARNESS_SMR_PROVIDER:=lm-studio}"
    : "${HARNESS_SMR_MODEL:=${LM_STUDIO_MODEL}}"
    : "${HARNESS_RETRIEVAL_ENABLED:=false}"
    export HARNESS_SMR_BASE_URL HARNESS_NLP_BASE_URL HARNESS_API_BASE_URL \
        HARNESS_SMR_PROVIDER HARNESS_SMR_MODEL HARNESS_RETRIEVAL_ENABLED
    ENV_REPORT+=(
        "HARNESS_SMR_BASE_URL=$HARNESS_SMR_BASE_URL"
        "HARNESS_NLP_BASE_URL=$HARNESS_NLP_BASE_URL"
        "HARNESS_API_BASE_URL=$HARNESS_API_BASE_URL"
        "HARNESS_SMR_PROVIDER=$HARNESS_SMR_PROVIDER"
        "HARNESS_SMR_MODEL=$HARNESS_SMR_MODEL"
        "HARNESS_RETRIEVAL_ENABLED=$HARNESS_RETRIEVAL_ENABLED"
    )
}

case "$SERVICE" in
    stt)
        : "${STT_PORT:=8861}"
        ENV_REPORT+=("HOST=$HOST" "STT_PORT=$STT_PORT")
        CMD=(uvicorn stt_v2.main:app --host "$HOST" --port "$STT_PORT" --app-dir apps/stt-v2/src)
        RELOAD_DIR="apps/stt-v2/src"
        ;;
    smr)
        : "${SMR_PORT:=8862}"
        apply_smr_env
        ENV_REPORT+=("HOST=$HOST" "SMR_PORT=$SMR_PORT")
        CMD=(uvicorn smr_v2.main:app --host "$HOST" --port "$SMR_PORT" --app-dir apps/smr/src)
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
        CMD=(uvicorn tts_v2.main:app --host "$HOST" --port "$TTS_PORT" --app-dir apps/tts-v2/src)
        RELOAD_DIR="apps/tts-v2/src"
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
            echo "  API_GATEWAY_KEY=<masked> (expected in apps/stt-v2/.env — run --check-stt-key)"
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
