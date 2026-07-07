#!/bin/bash
# ============================================================================
# TASK-346 — Aggregate dev-stack supervisor (clinical workspace)
# ============================================================================
# Starts the full local clinical-workspace stack in one command:
#   api (8868), stt (8861), smr (8862), guardrail (8863), nlp (8864),
#   harness (8866), worker (Temporal task queue), ui (5176)
# Guardrail is part of the default stack (the admin console monitors it);
# start a subset to leave it out.
#
# USAGE:
#   pnpm dev:stack                     # full stack
#   pnpm dev:stack -- smr worker       # subset
#   pnpm dev:stack -- guardrail        # single service
#   pnpm dev:stack down                # stop services spawned by this script
#   DRY_RUN=1 pnpm dev:stack           # print the plan, start nothing
#
# BEHAVIOUR:
#   - REFUSES to start if any requested port is already bound (protects an
#     already-running stack; run `pnpm dev:doctor` to see what is up).
#   - REFUSES to start a second harness worker (it would consume from the
#     same Temporal task queue).
#   - Docker infra (postgres/redis/temporal/...) is NOT started here — run
#     `pnpm infra:up` first if needed; `pnpm dev:doctor` verifies it.
#   - State dir: ${HOPE_DEV_STATE_DIR:-$XDG_STATE_HOME/hope-dev} (default
#     ~/.local/state/hope-dev), created chmod 700. Logs are one file per
#     service under <state>/logs (override: HOPE_DEV_LOG_DIR); pidfiles are
#     written to <state>/pids at spawn. Symlinked dirs/files are refused
#     (dev logs can contain PHI — keep them user-private, CWE-377).
#   - All logs are tailed in the foreground. Ctrl-C stops every spawned
#     service (whole process trees, conda wrappers included).
#   - `down` stops ONLY pids recorded in the pidfiles (e.g. orphans left by
#     a SIGKILLed supervisor), verifying via process start time that the pid
#     was not reused. On an empty/missing state dir it is a clean no-op.
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

STATE_DIR="${HOPE_DEV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hope-dev}"
LOG_DIR="${HOPE_DEV_LOG_DIR:-$STATE_DIR/logs}"
PID_DIR="$STATE_DIR/pids"
DEFAULT_SERVICES=(api stt smr guardrail nlp harness worker admin)
ALL_SERVICES=(api stt smr nlp harness worker ui guardrail)

port_for() {
    case "$1" in
        api) echo "${API_PORT:-8868}" ;;
        stt) echo "${STT_PORT:-8861}" ;;
        smr) echo "${SMR_PORT:-8862}" ;;
        nlp) echo "${NLP_PORT:-8864}" ;;
        harness) echo "${HARNESS_PORT:-8866}" ;;
        admin) echo "${ADMIN_PORT:-5176}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8863}" ;;
        worker) echo "" ;;
    esac
}

# Sets the global CMD array for a service (no word-splitting involved).
CMD=()
set_command_for() {
    case "$1" in
        api) CMD=(pnpm dev:api) ;;
        admin) CMD=(pnpm dev:admin) ;;
        *) CMD=("$SCRIPT_DIR/dev-service.sh" "$1") ;;
    esac
}

# Refuse to operate on symlinked dirs/files (log-truncation / PHI redirection
# vector when the path is predictable), and keep state user-private.
ensure_private_dir() {
    local dir="$1"
    if [ -L "$dir" ]; then
        echo -e "${RED}Refusing to use '$dir': it is a symlink.${NC}" >&2
        exit 1
    fi
    mkdir -p "$dir"
    chmod 700 "$dir"
}

refuse_symlink_file() {
    if [ -L "$1" ]; then
        echo -e "${RED}Refusing to write through symlink '$1'.${NC}" >&2
        exit 1
    fi
}

# Trimmed process start time — used as a pid-reuse fingerprint.
proc_start_time() {
    ps -o lstart= -p "$1" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true
}

kill_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

# ----------------------------------------------------------------------------
# down — stop process trees recorded in pidfiles (and only those)
# ----------------------------------------------------------------------------
do_down() {
    if [ ! -d "$PID_DIR" ]; then
        echo "dev:stack down: nothing to stop (no pid dir at $PID_DIR)."
        return 0
    fi
    local victims=() pf svc pid recorded current
    for pf in "$PID_DIR"/*.pid; do
        if [ -L "$pf" ]; then
            echo -e "  ${YELLOW}skip${NC} $(basename "$pf"): symlinked pidfile — removing" >&2
            rm -f "$pf"
            continue
        fi
        [ -e "$pf" ] || continue   # unmatched glob
        svc="$(basename "$pf" .pid)"
        pid="$(sed -n '1p' "$pf" 2>/dev/null || true)"
        recorded="$(sed -n '2p' "$pf" 2>/dev/null || true)"
        case "$pid" in
            ''|*[!0-9]*)
                echo -e "  ${YELLOW}skip${NC} $svc: malformed pidfile — removing"
                rm -f "$pf"
                continue ;;
        esac
        current="$(proc_start_time "$pid")"
        if [ -z "$current" ]; then
            echo -e "  ${YELLOW}gone${NC} $svc (pid $pid no longer running) — removing pidfile"
            rm -f "$pf"
            continue
        fi
        if [ -n "$recorded" ] && [ "$current" != "$recorded" ]; then
            echo -e "  ${YELLOW}skip${NC} $svc: pid $pid was reused by another process — removing pidfile"
            rm -f "$pf"
            continue
        fi
        echo -e "  ${GREEN}stopping${NC} $svc (pid $pid)"
        kill_tree "$pid"
        victims+=("$pid")
        rm -f "$pf"
    done
    if [ "${#victims[@]}" -eq 0 ]; then
        echo "dev:stack down: nothing to stop."
        return 0
    fi
    sleep 2
    local p
    for pid in "${victims[@]}"; do
        # escalate to SIGKILL for whole trees that ignored SIGTERM
        for p in $(pgrep -P "$pid" 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
        kill -9 "$pid" 2>/dev/null || true
    done
    echo -e "${GREEN}dev:stack down: stopped ${#victims[@]} recorded service(s).${NC}"
}

# ----------------------------------------------------------------------------
# Resolve requested services / subcommand
# ----------------------------------------------------------------------------
ARGS=()
for arg in "$@"; do
    # pnpm forwards the literal `--` separator (pnpm dev:stack -- smr)
    [ "$arg" = "--" ] && continue
    ARGS+=("$arg")
done

if [ "${#ARGS[@]}" -gt 0 ] && [ "${ARGS[0]}" = "down" ]; then
    if [ "${#ARGS[@]}" -gt 1 ]; then
        echo -e "${RED}dev:stack down takes no further arguments.${NC}" >&2
        exit 2
    fi
    do_down
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

# ----------------------------------------------------------------------------
# Dry run — print the plan (starts nothing, so no refusal logic)
# ----------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "dev:stack plan (DRY_RUN=1 — nothing started):"
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
ensure_private_dir "$STATE_DIR"
ensure_private_dir "$LOG_DIR"
ensure_private_dir "$PID_DIR"

PIDS=()
SPAWNED=()

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
    # everything recorded is stopped — make a later `down` a clean no-op
    for svc in "${SPAWNED[@]}"; do
        rm -f "$PID_DIR/$svc.pid"
    done
    echo -e "${GREEN}All spawned services stopped.${NC} Logs kept in $LOG_DIR"
}
trap cleanup EXIT INT TERM

echo -e "${CYAN}Starting dev stack:${NC} ${SERVICES[*]}"
for svc in "${SERVICES[@]}"; do
    log="$LOG_DIR/$svc.log"
    pidfile="$PID_DIR/$svc.pid"
    refuse_symlink_file "$log"
    refuse_symlink_file "$pidfile"
    : > "$log"
    set_command_for "$svc"
    "${CMD[@]}" >>"$log" 2>&1 &
    pid=$!
    PIDS+=("$pid")
    SPAWNED+=("$svc")
    printf '%s\n%s\n' "$pid" "$(proc_start_time "$pid")" > "$pidfile"
    echo -e "  ${GREEN}spawned${NC} $svc (pid $pid) → $log"
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
