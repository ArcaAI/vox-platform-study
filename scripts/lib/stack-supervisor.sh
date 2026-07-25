#!/bin/bash
# ============================================================================
# TASK-557 — Shared process supervisor for the dev and test app stacks
# ============================================================================
# Extracted verbatim from the TASK-346/555 dev-stack supervisor so that
# scripts/dev-stack.sh and scripts/test-stack.sh cannot drift apart. This file
# is a LIBRARY: source it, do not execute it.
#
# CONTRACT — the sourcing script must set, before calling anything here:
#   STACK_NAME      "dev" | "test"  — namespaces the state/pid/log directories
#                                     so `dev down` can never kill test services
#   SCRIPT_DIR      absolute path to scripts/
#   REPO_ROOT       absolute path to the repo root
# and must define:
#   set_command_for <service>   sets the global CMD array for that service
#   port_for <service>          echoes the TCP port, or "" for portless workers
#
# State layout (chmod 700, symlinks refused — dev logs can contain PHI, CWE-377):
#   ${HOPE_DEV_STATE_DIR:-$XDG_STATE_HOME/hope-dev}/
#     logs/<stack>/<service>.log
#     pids/<stack>/<service>.pid     (line 1: pid, line 2: process start time)
# ============================================================================

# ---------------------------------------------------------------------------
# Colors (only define if the sourcing script has not already)
# ---------------------------------------------------------------------------
: "${RED:=\033[0;31m}"
: "${GREEN:=\033[0;32m}"
: "${YELLOW:=\033[1;33m}"
: "${CYAN:=\033[0;36m}"
: "${NC:=\033[0m}"

STATE_DIR="${HOPE_DEV_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hope-dev}"
LOG_DIR="${HOPE_DEV_LOG_DIR:-$STATE_DIR/logs}/$STACK_NAME"
PID_DIR="$STATE_DIR/pids/$STACK_NAME"

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

# ---------------------------------------------------------------------------
# down — stop process trees recorded in pidfiles (and only those)
# ---------------------------------------------------------------------------
supervisor_down() {
    if [ ! -d "$PID_DIR" ]; then
        echo "$STACK_NAME stack down: nothing to stop (no pid dir at $PID_DIR)."
        return 0
    fi
    local victims=() pf svc pid recorded current p
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
        echo "$STACK_NAME stack down: nothing to stop."
        return 0
    fi
    sleep 2
    for pid in "${victims[@]}"; do
        # escalate to SIGKILL for whole trees that ignored SIGTERM
        for p in $(pgrep -P "$pid" 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
        kill -9 "$pid" 2>/dev/null || true
    done
    echo -e "${GREEN}$STACK_NAME stack down: stopped ${#victims[@]} recorded service(s).${NC}"
}

# ---------------------------------------------------------------------------
# Preflight — refuse to start onto bound ports / a second harness worker
# supervisor_preflight <service>...
# ---------------------------------------------------------------------------
supervisor_preflight() {
    local conflicts=() svc port pids
    for svc in "$@"; do
        port="$(port_for "$svc")"
        if [ -n "$port" ]; then
            pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)"
            if [ -n "${pids// /}" ]; then
                conflicts+=("$svc (port $port busy — pid(s): ${pids})")
            fi
        elif [ "$svc" = "worker" ]; then
            if pgrep -f 'harness\.temporal\.worker' >/dev/null 2>&1; then
                conflicts+=("worker (a harness.temporal.worker process is already running)")
            fi
        fi
    done

    if [ "${#conflicts[@]}" -gt 0 ]; then
        echo -e "${RED}Refusing to start — already running:${NC}" >&2
        printf '  - %s\n' "${conflicts[@]}" >&2
        echo "Inspect the live stack with 'pnpm stack:$STACK_NAME:doctor', or stop the listed processes first." >&2
        echo "NOTE: the dev and test stacks share application ports — only one may run at a time." >&2
        return 1
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Spawn + supervise
# supervisor_run <service>...
# Blocks tailing logs until interrupted; Ctrl-C stops every spawned tree.
# ---------------------------------------------------------------------------
SUPERVISOR_PIDS=()
SUPERVISOR_SPAWNED=()
SUPERVISOR_CLEANED=0

supervisor_cleanup() {
    [ "$SUPERVISOR_CLEANED" = "1" ] && return
    SUPERVISOR_CLEANED=1
    # bash 3.2 + set -u: expanding an empty array errors — nothing to stop anyway
    [ "${#SUPERVISOR_PIDS[@]}" -gt 0 ] || return 0
    echo ""
    echo -e "${YELLOW}Stopping $STACK_NAME stack...${NC}"
    local i p svc
    for i in "${!SUPERVISOR_PIDS[@]}"; do
        kill_tree "${SUPERVISOR_PIDS[$i]}"
    done
    sleep 2
    for i in "${!SUPERVISOR_PIDS[@]}"; do
        # escalate to SIGKILL for whole trees that ignored SIGTERM
        for p in $(pgrep -P "${SUPERVISOR_PIDS[$i]}" 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
        kill -9 "${SUPERVISOR_PIDS[$i]}" 2>/dev/null || true
    done
    # everything recorded is stopped — make a later `down` a clean no-op
    for svc in "${SUPERVISOR_SPAWNED[@]}"; do
        rm -f "$PID_DIR/$svc.pid"
    done
    echo -e "${GREEN}All spawned services stopped.${NC} Logs kept in $LOG_DIR"
}

supervisor_run() {
    local services=("$@")

    ensure_private_dir "$STATE_DIR"
    ensure_private_dir "$LOG_DIR"
    ensure_private_dir "$PID_DIR"

    trap supervisor_cleanup EXIT INT TERM

    echo -e "${CYAN}Starting $STACK_NAME stack:${NC} ${services[*]}"
    local svc log pidfile pid
    for svc in "${services[@]}"; do
        log="$LOG_DIR/$svc.log"
        pidfile="$PID_DIR/$svc.pid"
        refuse_symlink_file "$log"
        refuse_symlink_file "$pidfile"
        : > "$log"
        set_command_for "$svc"
        "${CMD[@]}" >>"$log" 2>&1 &
        pid=$!
        SUPERVISOR_PIDS+=("$pid")
        SUPERVISOR_SPAWNED+=("$svc")
        printf '%s\n%s\n' "$pid" "$(proc_start_time "$pid")" > "$pidfile"
        echo -e "  ${GREEN}spawned${NC} $svc (pid $pid) → $log"
    done

    # Catch instant deaths (bad env, missing conda env, ...) before tailing.
    sleep 3
    local i
    for i in "${!SUPERVISOR_PIDS[@]}"; do
        if ! kill -0 "${SUPERVISOR_PIDS[$i]}" 2>/dev/null; then
            echo -e "${RED}Service '${SUPERVISOR_SPAWNED[$i]}' exited immediately — last log lines:${NC}" >&2
            tail -n 20 "$LOG_DIR/${SUPERVISOR_SPAWNED[$i]}.log" >&2 || true
            exit 1
        fi
    done

    echo ""
    echo -e "${CYAN}All services spawned. Tailing logs (Ctrl-C stops everything)...${NC}"
    local logs=()
    for svc in "${services[@]}"; do logs+=("$LOG_DIR/$svc.log"); done
    tail -n +1 -f "${logs[@]}"
}
