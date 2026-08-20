#!/bin/bash
# ============================================================================
# DEV app-stack supervisor
# ============================================================================
# Starts the full local clinical-workspace stack in one command:
#   api (8868), stt (8861), stt-worker (Dramatiq batch queue), text (8862),
#   guardrail (8863), nlp (8864), harness (8866),
#   worker (Temporal task queue), admin (5176)
# Guardrail is part of the default stack (the admin console monitors it);
# start a subset to leave it out.
#
# USAGE:
#   pnpm stack:dev                     # ensure base Docker infra, then full app stack
#   pnpm stack:dev:observability       # base + Prometheus/Grafana, then apps
#   pnpm stack:dev:inference           # base + inference engines, then apps
#   pnpm stack:dev -- text worker      # subset
#   pnpm stack:dev -- -o text          # observability tier + subset
#   pnpm stack:dev:down                # stop services spawned by this script
#   DRY_RUN=1 pnpm stack:dev           # print the plan, start nothing
#
# BEHAVIOUR:
#   - Ensures Docker infra is up first via `dev-infra.sh up` (idempotent):
#     core + vault + temporal + rag; optional -o/--observability, -e/--inference.
#   - REFUSES to start if any requested port is already bound (protects an
#     already-running stack; run `pnpm stack:dev:doctor` to see what is up).
#     The test stack uses its own ports (dev + 100), so a test
#     stack may run alongside this one.
#   - REFUSES to start a second harness worker (it would consume from the
#     same Temporal task queue). There is deliberately NO such guard for
#     stt-worker: several Dramatiq consumers on `dramatiq:stt_batch` are
#     legitimate (that is how the queue scales). If you already started one by
#     hand, start a subset without it (BUG-011).
#   - All logs are tailed in the foreground. Ctrl-C stops every spawned
#     service (whole process trees, conda wrappers included).
#   - `down` stops ONLY pids recorded in this stack's pidfiles.
#     Docker infra is left running (use `pnpm infra:dev:down` to tear it down).
#
# The supervisor itself (state dirs, pidfiles, kill trees, log tailing) lives in
# scripts/lib/stack-supervisor.sh and is shared with scripts/test-stack.sh.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

DEFAULT_SERVICES=(api stt stt-worker text guardrail nlp harness worker admin)
ALL_SERVICES=(api stt stt-worker text nlp harness worker admin guardrail tts)

port_for() {
    case "$1" in
        api) echo "${API_PORT:-8868}" ;;
        stt) echo "${STT_PORT:-8861}" ;;
        stt-worker) echo "" ;;
        text) echo "${TEXT_PORT:-8862}" ;;
        nlp) echo "${NLP_PORT:-8864}" ;;
        harness) echo "${HARNESS_PORT:-8866}" ;;
        admin) echo "${ADMIN_PORT:-5176}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8863}" ;;
        tts) echo "${TTS_PORT:-8865}" ;;
        worker) echo "" ;;
    esac
}

# Sets the global CMD array for a service (no word-splitting involved).
CMD=()
set_command_for() {
    case "$1" in
        api) CMD=(pnpm api:dev) ;;
        admin) CMD=(pnpm admin:dev) ;;
        *) CMD=("$SCRIPT_DIR/dev-service.sh" "$1") ;;
    esac
}

STACK_NAME="dev"
# shellcheck source=scripts/lib/stack-supervisor.sh
source "$SCRIPT_DIR/lib/stack-supervisor.sh"

# ----------------------------------------------------------------------------
# Resolve requested services / subcommand / infra tier flags
# ----------------------------------------------------------------------------
ARGS=()
INFRA_FLAGS=()
for arg in "$@"; do
    # pnpm forwards the literal `--` separator (pnpm stack:dev -- text)
    [ "$arg" = "--" ] && continue
    case "$arg" in
        -o|--observability) INFRA_FLAGS+=(--observability); continue ;;
        -e|--inference) INFRA_FLAGS+=(--inference); continue ;;
    esac
    ARGS+=("$arg")
done

if [ "${#ARGS[@]}" -gt 0 ] && [ "${ARGS[0]}" = "down" ]; then
    if [ "${#ARGS[@]}" -gt 1 ]; then
        echo -e "${RED}stack:dev down takes no further arguments.${NC}" >&2
        exit 2
    fi
    supervisor_down
    exit 0
fi

SERVICES=()
if [ "${#ARGS[@]}" -eq 0 ]; then
    SERVICES=("${DEFAULT_SERVICES[@]}")
else
    for arg in "${ARGS[@]}"; do
        ok=0
        for s in "${ALL_SERVICES[@]}"; do
            [ "$arg" = "$s" ] && ok=1
        done
        if [ "$ok" != "1" ]; then
            echo -e "${RED}Unknown service '$arg'.${NC} Known: ${ALL_SERVICES[*]} (or 'down')" >&2
            echo "Infra tier flags: -o/--observability, -e/--inference" >&2
            exit 2
        fi
        SERVICES+=("$arg")
    done
fi

# ----------------------------------------------------------------------------
# Dry run — print the plan (starts nothing, so no refusal logic)
# ----------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "stack:dev plan (DRY_RUN=1 — nothing started):"
    echo "  infra: ./scripts/dev-infra.sh up ${INFRA_FLAGS[*]+${INFRA_FLAGS[*]}}"
    for svc in "${SERVICES[@]}"; do
        port="$(port_for "$svc")"
        set_command_for "$svc"
        printf '  %-10s %-6s %s\n' "$svc" "${port:-—}" "${CMD[*]}"
    done
    echo "logs would go to: $LOG_DIR/<service>.log"
    echo "pidfiles would go to: $PID_DIR/<service>.pid"
    exit 0
fi

# ----------------------------------------------------------------------------
# Ensure Docker infra is up (idempotent)
# ----------------------------------------------------------------------------
echo -e "${CYAN}Ensuring Docker infra...${NC}"
"$SCRIPT_DIR/dev-infra.sh" up "${INFRA_FLAGS[@]+"${INFRA_FLAGS[@]}"}"

# ----------------------------------------------------------------------------
# Preflight: ports free, no second worker, STT key usable
# ----------------------------------------------------------------------------
supervisor_preflight "${SERVICES[@]}"

for svc in "${SERVICES[@]}"; do
    if [ "$svc" = "stt" ]; then
        "$SCRIPT_DIR/dev-service.sh" --check-stt-key
    fi
done

supervisor_run "${SERVICES[@]}"
