#!/bin/bash
# ============================================================================
# TASK-557 — TEST app-stack supervisor
# ============================================================================
# Test counterpart of scripts/dev-stack.sh: brings up the isolated TEST
# infrastructure, then starts HOPE services configured from .env.test so an
# integration/e2e suite has something to run against.
#
# USAGE:
#   pnpm stack:test                      # test infra, then api + python services
#   pnpm stack:test -- api               # subset (e.g. e2e only needs the API)
#   pnpm stack:test:down                 # stop services spawned by this script
#   DRY_RUN=1 pnpm stack:test            # print the plan, start nothing
#   TEST_STACK_WAIT=0 pnpm stack:test    # skip the readiness wait
#
# DEFAULT SERVICES: api  (the suites that need more name them explicitly)
# ALL SERVICES:     api admin stt smr nlp guardrail harness worker tts
#
# BEHAVIOUR:
#   - Ensures the test Docker infra is up and validated (start-test-infra.sh),
#     then verifies the schema is pushed via test-doctor.sh --infra-only.
#   - Every service is launched through scripts/start-test-app.sh, so it gets
#     .env.test with `dotenv -o` (test values override the ambient shell).
#   - REFUSES to start onto a bound port. .env.test reuses the DEV application
#     ports, so a running dev stack must be stopped first — this is the single
#     most common cause of "my test suite hit the dev database".
#   - After spawning, waits for each service's health endpoint (up to
#     TEST_STACK_TIMEOUT seconds, default 90) and reports readiness, so a suite
#     started right after this script does not race the boot.
#
# The supervisor itself is shared with dev-stack.sh (scripts/lib/stack-supervisor.sh).
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

DEFAULT_SERVICES=(api)
ALL_SERVICES=(api admin stt smr nlp guardrail harness worker tts)

TEST_STACK_TIMEOUT="${TEST_STACK_TIMEOUT:-90}"
TEST_STACK_WAIT="${TEST_STACK_WAIT:-1}"

# Ports come from .env.test when it declares them, else the documented defaults.
env_val() { grep -E "^$1=" "$REPO_ROOT/.env.test" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

port_for() {
    local v
    case "$1" in
        api)       v="$(env_val API_PORT)";       echo "${v:-8868}" ;;
        admin)     v="$(env_val ADMIN_PORT)";     echo "${v:-5176}" ;;
        stt)       v="$(env_val STT_PORT)";       echo "${v:-8861}" ;;
        smr)       v="$(env_val SMR_PORT)";       echo "${v:-8862}" ;;
        guardrail) v="$(env_val GUARDRAIL_PORT)"; echo "${v:-8863}" ;;
        nlp)       v="$(env_val NLP_PORT)";       echo "${v:-8864}" ;;
        tts)       v="$(env_val TTS_PORT)";       echo "${v:-8865}" ;;
        harness)   v="$(env_val HARNESS_PORT)";   echo "${v:-8866}" ;;
        worker)    echo "" ;;
    esac
}

# Health path per service (guardrail mounts under /api with no version segment).
health_path_for() {
    case "$1" in
        guardrail) echo "/api/health" ;;
        admin)     echo "/" ;;
        worker)    echo "" ;;
        *)         echo "/api/v1/health" ;;
    esac
}

CMD=()
set_command_for() {
    CMD=("$SCRIPT_DIR/start-test-app.sh" "$1")
}

STACK_NAME="test"
# shellcheck source=scripts/lib/stack-supervisor.sh
source "$SCRIPT_DIR/lib/stack-supervisor.sh"

# ----------------------------------------------------------------------------
# Resolve arguments
# ----------------------------------------------------------------------------
ARGS=()
for arg in "$@"; do
    [ "$arg" = "--" ] && continue
    ARGS+=("$arg")
done

if [ "${#ARGS[@]}" -gt 0 ] && [ "${ARGS[0]}" = "down" ]; then
    if [ "${#ARGS[@]}" -gt 1 ]; then
        echo -e "${RED}stack:test down takes no further arguments.${NC}" >&2
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
            exit 2
        fi
        SERVICES+=("$arg")
    done
fi

if [ ! -f "$REPO_ROOT/.env.test" ]; then
    echo -e "${RED}.env.test not found — the test stack cannot start.${NC}" >&2
    exit 1
fi

# ----------------------------------------------------------------------------
# Dry run
# ----------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "stack:test plan (DRY_RUN=1 — nothing started):"
    echo "  infra: ./scripts/start-test-infra.sh"
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
# Ensure test infra + schema
# ----------------------------------------------------------------------------
echo -e "${CYAN}Ensuring test Docker infra...${NC}"
"$SCRIPT_DIR/start-test-infra.sh" >/dev/null

echo -e "${CYAN}Checking test infrastructure + schema...${NC}"
if ! "$SCRIPT_DIR/test-doctor.sh" --infra-only; then
    echo -e "${RED}Test infrastructure is not ready.${NC} Bootstrap it with: pnpm setup:test" >&2
    exit 1
fi

# ----------------------------------------------------------------------------
# Preflight + spawn
# ----------------------------------------------------------------------------
supervisor_preflight "${SERVICES[@]}"

# supervisor_run tails logs in the foreground and never returns, so the
# readiness wait has to happen in a background watcher that prints once the
# health endpoints answer.
if [ "$TEST_STACK_WAIT" = "1" ]; then
    (
        deadline=$(( SECONDS + TEST_STACK_TIMEOUT ))
        pending=("${SERVICES[@]}")
        while [ "${#pending[@]}" -gt 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
            sleep 3
            still=()
            for svc in "${pending[@]}"; do
                port="$(port_for "$svc")"
                path="$(health_path_for "$svc")"
                if [ -z "$port" ] || [ -z "$path" ]; then
                    # portless worker: readiness is "process still alive", which
                    # the supervisor already asserts. Nothing to poll.
                    continue
                fi
                code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
                    "http://localhost:$port$path" 2>/dev/null)" || code="000"
                if [ "${code:0:1}" = "2" ] || [ "${code:0:1}" = "3" ]; then
                    echo -e "${GREEN}[ready]${NC} $svc → http://localhost:$port$path ($code)"
                else
                    still+=("$svc")
                fi
            done
            pending=("${still[@]+"${still[@]}"}")
        done
        if [ "${#pending[@]}" -gt 0 ]; then
            echo -e "${YELLOW}[timeout]${NC} not ready after ${TEST_STACK_TIMEOUT}s: ${pending[*]}"
            echo -e "${YELLOW}          inspect with 'pnpm stack:test:doctor' or read $LOG_DIR/<service>.log${NC}"
        else
            echo -e "${GREEN}[ready] test stack is up — run your suite in another terminal.${NC}"
        fi
    ) &
fi

supervisor_run "${SERVICES[@]}"
