#!/bin/bash
# ============================================================================
# TASK-346 — Aggregate dev-stack supervisor (clinical workspace)
# ============================================================================
# Starts the full local clinical-workspace stack in one command:
#   api (8868), stt (8861), smr (8862), guardrail (8863), nlp (8864),
#   harness (8866), worker (Temporal task queue), ui (5175)
# Guardrail is part of the default stack (the admin console monitors it);
# start a subset to leave it out.
#
# USAGE:
#   pnpm dev:stack                     # full stack
#   pnpm dev:stack -- smr worker       # subset
#   pnpm dev:stack -- guardrail        # single service
#   DRY_RUN=1 pnpm dev:stack           # print the plan, start nothing
#
# BEHAVIOUR:
#   - REFUSES to start if any requested port is already bound (protects an
#     already-running stack; run `pnpm dev:doctor` to see what is up).
#   - REFUSES to start a second harness worker (it would consume from the
#     same Temporal task queue).
#   - Docker infra (postgres/redis/temporal/...) is NOT started here — run
#     `pnpm infra:up` first if needed; `pnpm dev:doctor` verifies it.
#   - Logs: one file per service under ${HOPE_DEV_LOG_DIR:-/tmp/hope-dev-logs};
#     all are tailed in the foreground. Ctrl-C stops every spawned service
#     (whole process trees, conda wrappers included).
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

LOG_DIR="${HOPE_DEV_LOG_DIR:-/tmp/hope-dev-logs}"
DEFAULT_SERVICES=(api stt smr guardrail nlp harness worker ui)
ALL_SERVICES=(api stt smr nlp harness worker ui guardrail)

port_for() {
    case "$1" in
        api) echo "${API_PORT:-8868}" ;;
        stt) echo "${STT_PORT:-8861}" ;;
        smr) echo "${SMR_PORT:-8862}" ;;
        nlp) echo "${NLP_PORT:-8864}" ;;
        harness) echo "${HARNESS_PORT:-8866}" ;;
        ui) echo "${UI_PORT:-5175}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8863}" ;;
        worker) echo "" ;;
    esac
}

command_for() {
    case "$1" in
        api) echo "pnpm dev:api" ;;
        ui) echo "pnpm dev:ui-playground" ;;
        *) echo "$SCRIPT_DIR/dev-service.sh $1" ;;
    esac
}

# ----------------------------------------------------------------------------
# Resolve requested services
# ----------------------------------------------------------------------------
SERVICES=()
if [ "$#" -eq 0 ]; then
    SERVICES=("${DEFAULT_SERVICES[@]}")
else
    for arg in "$@"; do
        # pnpm forwards the literal `--` separator (pnpm dev:stack -- smr)
        [ "$arg" = "--" ] && continue
        ok=0
        for s in "${ALL_SERVICES[@]}"; do
            [ "$arg" = "$s" ] && ok=1
        done
        if [ "$ok" != "1" ]; then
            echo -e "${RED}Unknown service '$arg'.${NC} Known: ${ALL_SERVICES[*]}" >&2
            exit 2
        fi
        SERVICES+=("$arg")
    done
fi
# e.g. a bare `pnpm dev:stack --` → fall back to the full stack
if [ "${#SERVICES[@]}" -eq 0 ]; then
    SERVICES=("${DEFAULT_SERVICES[@]}")
fi

# ----------------------------------------------------------------------------
# Dry run — print the plan (starts nothing, so no refusal logic)
# ----------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "dev:stack plan (DRY_RUN=1 — nothing started):"
    for svc in "${SERVICES[@]}"; do
        port="$(port_for "$svc")"
        printf '  %-10s %-6s %s\n' "$svc" "${port:-—}" "$(command_for "$svc")"
    done
    echo "logs would go to: $LOG_DIR/<service>.log"
    exit 0
fi

# ----------------------------------------------------------------------------
# Preflight: ports must be free, no second worker, STT key must be usable
# ----------------------------------------------------------------------------
CONFLICTS=()
for svc in "${SERVICES[@]}"; do
    port="$(port_for "$svc")"
    if [ -n "$port" ]; then
        pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)"
        if [ -n "${pids// /}" ]; then
            CONFLICTS+=("$svc (port $port busy — pid(s): ${pids})")
        fi
    elif [ "$svc" = "worker" ]; then
        if pgrep -f 'harness\.temporal\.worker' >/dev/null 2>&1; then
            CONFLICTS+=("worker (a harness.temporal.worker process is already running)")
        fi
    fi
done

if [ "${#CONFLICTS[@]}" -gt 0 ]; then
    echo -e "${RED}Refusing to start — already running:${NC}" >&2
    printf '  - %s\n' "${CONFLICTS[@]}" >&2
    echo "Run 'pnpm dev:doctor' to inspect the live stack, or stop the listed processes first." >&2
    exit 1
fi

for svc in "${SERVICES[@]}"; do
    if [ "$svc" = "stt" ]; then
        "$SCRIPT_DIR/dev-service.sh" --check-stt-key
    fi
done

# ----------------------------------------------------------------------------
# Spawn + supervise
# ----------------------------------------------------------------------------
mkdir -p "$LOG_DIR"

PIDS=()
SPAWNED=()

kill_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

CLEANED=0
cleanup() {
    [ "$CLEANED" = "1" ] && return
    CLEANED=1
    # bash 3.2 + set -u: expanding an empty array errors — nothing to stop anyway
    [ "${#PIDS[@]}" -gt 0 ] || return 0
    echo ""
    echo -e "${YELLOW}Stopping dev stack...${NC}"
    local i
    for i in "${!PIDS[@]}"; do
        kill_tree "${PIDS[$i]}"
    done
    sleep 2
    for i in "${!PIDS[@]}"; do
        # escalate to SIGKILL for whole trees that ignored SIGTERM
        for p in $(pgrep -P "${PIDS[$i]}" 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
        kill -9 "${PIDS[$i]}" 2>/dev/null || true
    done
    echo -e "${GREEN}All spawned services stopped.${NC} Logs kept in $LOG_DIR"
}
trap cleanup EXIT INT TERM

echo -e "${CYAN}Starting dev stack:${NC} ${SERVICES[*]}"
for svc in "${SERVICES[@]}"; do
    log="$LOG_DIR/$svc.log"
    : > "$log"
    # shellcheck disable=SC2086 — command_for output is intentionally word-split
    $(command_for "$svc") >>"$log" 2>&1 &
    PIDS+=("$!")
    SPAWNED+=("$svc")
    echo -e "  ${GREEN}spawned${NC} $svc (pid $!) → $log"
done

# Catch instant deaths (bad env, missing conda env, ...) before tailing.
sleep 3
for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
        echo -e "${RED}Service '${SPAWNED[$i]}' exited immediately — last log lines:${NC}" >&2
        tail -n 20 "$LOG_DIR/${SPAWNED[$i]}.log" >&2 || true
        exit 1
    fi
done

echo ""
echo -e "${CYAN}All services spawned. Tailing logs (Ctrl-C stops everything)...${NC}"
LOGS=()
for svc in "${SERVICES[@]}"; do LOGS+=("$LOG_DIR/$svc.log"); done
tail -n +1 -f "${LOGS[@]}"
