#!/bin/bash
# ============================================================================
# Single-service dev launcher (Python services + workers)
# ============================================================================
# Starts one HOPE Python service. This script owns PROCESS SHAPE only — bind
# address, port, conda env, the uvicorn/worker command. It is NOT a config
# source.
#
# Application configuration comes from the service itself: every Python
# service now calls the shared loader `hope_env.load_env()`, which
# reads the SAME NODE_ENV-selected root file the TypeScript gateway reads
# (.env.dev / .env.test), with host env always winning. Defaults that merely
# restated an env-file declaration or a pydantic field default were removed
# from this script — they were a fourth, invisible configuration layer.
#
# The few `: "${VAR:=default}"` lines that remain are the ones with no home in
# an env file and a DIFFERENT value than the pydantic default (the LM Studio
# model pairing below); anything you export in your shell still wins.
#
# USAGE:
#   ./scripts/dev-service.sh <stt|stt-worker|text|nlp|guardrail|harness|tts|worker> [--watch] [--print]
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
#   STT_PORT (8861), TEXT_PORT (8862), GUARDRAIL_PORT (8863), NLP_PORT (8864),
#   HARNESS_PORT (8866), TTS_PORT (8865)
#
# BIND ADDRESS:
#   Services bind 127.0.0.1 by default — these are PHI-processing dev
#   services and must not listen on the LAN by accident. To expose one
#   deliberately (e.g. testing from a phone), export HOST=0.0.0.0.
#
# WORKERS (no port, no --watch — a reload would cancel the model warm-up):
#   stt-worker   STT batch transcription: the Dramatiq consumer of the
#                `dramatiq:stt_batch` queue. Without it, batch jobs are accepted
#                and persisted as QUEUED but never executed (BUG-011). Mirrors
#                the container command (apps/stt/docker/Dockerfile stage
#                `worker`), scaled down to one process for a laptop.
#   worker       harness Temporal worker on task queue `harness-task-queue`.
#
# MACHINE-SPECIFIC MODEL:
#   LM_STUDIO_MODEL (default: gemma-4-e2b-it-qat — the catalogue's platform default) feeds both the TEXT default
#   model and the harness worker's HARNESS_TEXT_MODEL. Export it in your shell
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
    sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ----------------------------------------------------------------------------
# STT key preflight. A placeholder line whose inline comment was parsed AS the
# value once caused every internal call to 401, so the value is sanity-checked
# before launch. The check resolves the key through EXACTLY the resolution the
# service performs — the shared loader (host env > root .env.<env>) and then
# apps/stt/.env, which pydantic-settings ranks below both — instead of the
# hand-rolled `sed` of apps/stt/.env this used to carry. Never prints the value.
# ----------------------------------------------------------------------------
check_stt_key() {
    check_conda_env

    # The verdict is computed in Python (one `VERDICT|source-or-reason` line on
    # stdout, always exit 0) and rendered here, so conda's own wrapper never
    # decides the exit status and never adds noise to `dev-doctor` output.
    local verdict payload
    verdict="$(conda run -n "$CONDA_ENV" --no-capture-output python - <<'PY'
import os
from pathlib import Path

from dotenv import dotenv_values
from hope_env import load_env

from_host = "API_GATEWAY_KEY" in os.environ  # must be sampled BEFORE loading
result = load_env()
source = "environment" if from_host else str(result.env_file)
value = os.environ.get("API_GATEWAY_KEY", "")

overlay = Path("apps/stt/.env")
if not value and overlay.is_file():
    value = dotenv_values(overlay).get("API_GATEWAY_KEY") or ""
    source = str(overlay)

placeholders = ("REQUIRED", "SECRET", "PLACEHOLDER", "CHANGEME", "YOUR-", "YOUR_", "<", ">")
if not value:
    print("FAIL|API_GATEWAY_KEY is empty or missing")
elif "#" in value:
    print("FAIL|API_GATEWAY_KEY contains '#' — an inline comment was parsed as the value")
elif any(token in value.upper() for token in placeholders):
    print("FAIL|API_GATEWAY_KEY looks like a placeholder")
elif len(value) < 20:
    print(f"FAIL|API_GATEWAY_KEY is suspiciously short ({len(value)} chars)")
else:
    print(f"OK|{source}")
PY
)" || { echo -e "${RED}STT key preflight could not run.${NC}" >&2; return 1; }

    payload="${verdict#*|}"
    if [ "${verdict%%|*}" != "OK" ]; then
        echo -e "${RED}STT key preflight FAILED: ${payload}.${NC}" >&2
        echo "Fix: declare API_GATEWAY_KEY in .env.dev or apps/stt/.env, or export it." >&2
        echo "The committed dev-seed service-account key lives in" >&2
        echo "  packages/database/src/prisma/db_main/seed/00-constants.ts (API_KEYS.SERVICE_ACCOUNT)" >&2
        echo "or generate one with: pnpm gen:api-key" >&2
        return 1
    fi
    echo -e "${GREEN}STT key preflight OK${NC} (source: ${payload}, value not shown)"
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
        stt|stt-worker|text|nlp|guardrail|harness|tts|worker) SERVICE="$arg" ;;
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
: "${LM_STUDIO_MODEL:=gemma-4-e2b-it-qat}"
# Loopback by default; export HOST=0.0.0.0 to expose on the LAN (deliberate
# opt-in — PHI-processing dev services must not be LAN-reachable by accident).
: "${HOST:=127.0.0.1}"

ENV_REPORT=()   # KEY=VALUE lines for --print (non-secret only)
CMD=()
RELOAD_DIR=""
SERVICE_DIR=""  # whose pyproject declares this target's source roots

# The LM Studio pairing is the ONE application default this script still
# supplies. It is machine-specific (whichever model your LM Studio has loaded)
# and it differs from the pydantic defaults — TEXT's is `google/gemma-4-e4b`,
# harness's `text_provider`/`text_model` are None. Removed from here it would
# silently change which model dev requests, and it has no declaration in the
# root env files yet. When those env files are generated, this moves to
# .env.dev and these functions disappear.
#
# Everything else this script used to export is gone: TEXT_OPENAI_COMPAT_ENABLED
# (read by NOTHING — TEXT has no `enabled` field; a provider is available iff its
# connection config is present), TEXT_OPENAI_COMPAT_BASE_URL,
# TEXT_EXTERNAL_GUARDRAIL_ENABLED, HARNESS_{TEXT,NLP,API}_BASE_URL and
# HARNESS_RETRIEVAL_ENABLED (all identical to the pydantic field default), and
# HARNESS_SERVICE_TOKEN (the harness API *and* the worker now read .env.dev
# themselves through hope_env.load_env(), which is what the hand-rolled `sed`
# of .env.dev was standing in for).
apply_text_env() {
    : "${TEXT_OPENAI_COMPAT_DEFAULT_MODEL:=${LM_STUDIO_MODEL}}"
    export TEXT_OPENAI_COMPAT_DEFAULT_MODEL
    ENV_REPORT+=("TEXT_OPENAI_COMPAT_DEFAULT_MODEL=$TEXT_OPENAI_COMPAT_DEFAULT_MODEL")
}

apply_harness_env() {
    : "${HARNESS_TEXT_PROVIDER:=lm-studio}"
    : "${HARNESS_TEXT_MODEL:=${LM_STUDIO_MODEL}}"
    export HARNESS_TEXT_PROVIDER HARNESS_TEXT_MODEL
    ENV_REPORT+=(
        "HARNESS_TEXT_PROVIDER=$HARNESS_TEXT_PROVIDER"
        "HARNESS_TEXT_MODEL=$HARNESS_TEXT_MODEL"
    )
}

case "$SERVICE" in
    stt)
        SERVICE_DIR="apps/stt"
        : "${STT_PORT:=8861}"
        ENV_REPORT+=("HOST=$HOST" "STT_PORT=$STT_PORT")
        CMD=(uvicorn stt.main:app --host "$HOST" --port "$STT_PORT" --app-dir apps/stt/src)
        RELOAD_DIR="apps/stt/src"
        ;;
    stt-worker)
        SERVICE_DIR="apps/stt"
        # Dramatiq batch consumer. No port, no reload. `dramatiq` has no
        # equivalent of uvicorn's --app-dir; the source-provenance block below
        # puts apps/stt/src on PYTHONPATH (absolute) for every target, which
        # supersedes the relative one this arm used to set for itself.
        # --processes 1 (the container uses 2) keeps one copy of the
        # VAD/ASR/diarization models resident on a laptop.
        CMD=(python -m dramatiq stt.worker --processes 1 --threads 4)
        if [ "$WATCH" = "1" ]; then
            echo -e "${YELLOW}--watch is not supported for the STT batch worker; ignoring.${NC}" >&2
            WATCH=0
        fi
        ;;
    text)
        SERVICE_DIR="apps/text"
        : "${TEXT_PORT:=8862}"
        apply_text_env
        ENV_REPORT+=("HOST=$HOST" "TEXT_PORT=$TEXT_PORT")
        CMD=(uvicorn text.main:app --host "$HOST" --port "$TEXT_PORT" --app-dir apps/text/src)
        RELOAD_DIR="apps/text/src"
        ;;
    nlp)
        SERVICE_DIR="apps/nlp"
        : "${NLP_PORT:=8864}"
        ENV_REPORT+=("HOST=$HOST" "NLP_PORT=$NLP_PORT")
        CMD=(uvicorn --factory nlp.app:get_app --host "$HOST" --port "$NLP_PORT" --app-dir apps/nlp/src)
        RELOAD_DIR="apps/nlp/src"
        ;;
    guardrail)
        SERVICE_DIR="apps/guardrail"
        : "${GUARDRAIL_PORT:=8863}"
        ENV_REPORT+=("HOST=$HOST" "GUARDRAIL_PORT=$GUARDRAIL_PORT")
        CMD=(uvicorn guardrail.main:app --host "$HOST" --port "$GUARDRAIL_PORT" --app-dir apps/guardrail/src)
        RELOAD_DIR="apps/guardrail/src"
        ;;
    harness)
        SERVICE_DIR="apps/harness"
        : "${HARNESS_PORT:=8866}"
        apply_harness_env
        ENV_REPORT+=("HOST=$HOST" "HARNESS_PORT=$HARNESS_PORT")
        CMD=(uvicorn harness.main:app --host "$HOST" --port "$HARNESS_PORT" --app-dir apps/harness/src)
        RELOAD_DIR="apps/harness/src"
        ;;
    tts)
        SERVICE_DIR="apps/tts"
        : "${TTS_PORT:=8865}"
        ENV_REPORT+=("HOST=$HOST" "TTS_PORT=$TTS_PORT")
        CMD=(uvicorn tts.main:app --host "$HOST" --port "$TTS_PORT" --app-dir apps/tts/src)
        RELOAD_DIR="apps/tts/src"
        ;;
    worker)
        SERVICE_DIR="apps/harness"
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

# ----------------------------------------------------------------------------
# Source provenance (rule 14 section 4). The conda env's editable installs put
# ABSOLUTE paths into the PRIMARY checkout on sys.path, so a process launched
# from a linked working tree will happily run source from a tree you are not
# editing. Measured 2026-09-02: `worker` resolved `harness` AND all four shared
# `hope_*` packages out of the primary checkout, and the uvicorn targets — whose
# --app-dir rescues only the service package — resolved every shared package
# there too.
#
# pytest closes this with `pythonpath` + assert_source_tree(). The two steps
# below are the same fix for the launcher, through the SAME module, reading the
# SAME `[tool.pytest.ini_options] pythonpath` declaration, so the launcher and
# the test run can never disagree about which directories are this tree's source.
# ----------------------------------------------------------------------------
GUARD="$REPO_ROOT/scripts/pytest-support/hope_worktree_guard.py"

TREE_PYTHONPATH="$(conda run -n "$CONDA_ENV" --no-capture-output \
    python "$GUARD" --print-pythonpath "$SERVICE_DIR" | tail -n 1 | tr -d '\r')" || {
    echo -e "${RED}Could not resolve ${SERVICE_DIR} source roots.${NC}" >&2
    exit 1
}
export PYTHONPATH="${TREE_PYTHONPATH}${PYTHONPATH:+:$PYTHONPATH}"
ENV_REPORT+=("PYTHONPATH=$PYTHONPATH")

FULL_CMD=(conda run -n "$CONDA_ENV" --no-capture-output "${CMD[@]}")

# ----------------------------------------------------------------------------
# Print / preflight / launch
# ----------------------------------------------------------------------------
if [ "$PRINT" = "1" ]; then
    echo "service: $SERVICE"
    echo "process shape (user env > these defaults); everything else comes from"
    echo "the service's own loader: host env > .env.<NODE_ENV> > pydantic default"
    if [ "${#ENV_REPORT[@]}" -gt 0 ]; then
        printf '  %s\n' "${ENV_REPORT[@]}"
    fi
    if [ "$SERVICE" = "stt" ] || [ "$SERVICE" = "stt-worker" ]; then
        if [ -n "${API_GATEWAY_KEY:-}" ]; then
            echo "  API_GATEWAY_KEY=<masked> (from environment)"
        else
            echo "  API_GATEWAY_KEY=<masked> (from .env.dev or apps/stt/.env — run --check-stt-key)"
        fi
    fi
    echo "command:"
    printf '  %s\n' "${FULL_CMD[*]}"
    exit 0
fi

# Both STT processes call back into the gateway with API_GATEWAY_KEY.
if [ "$SERVICE" = "stt" ] || [ "$SERVICE" = "stt-worker" ]; then
    check_stt_key
fi

check_conda_env

# Abort — loudly, non-zero, before the process starts — if any package still
# resolves outside this tree. A warning would be useless: the whole failure mode
# is that a wrong-source run looks exactly like a right one.
if ! conda run -n "$CONDA_ENV" --no-capture-output python -m hope_worktree_guard \
        --assert "$SERVICE_DIR"; then
    echo -e "${RED}Refusing to start ${SERVICE} against another checkout source.${NC}" >&2
    exit 1
fi

echo -e "${GREEN}Starting ${SERVICE} →${NC} ${FULL_CMD[*]}"
exec "${FULL_CMD[@]}"
