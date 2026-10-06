#!/bin/bash
# Shell test for the restart loop in scripts/lib/stack-supervisor.sh (TASK-1047 C9).
#   bash scripts/lib/stack-supervisor.test.sh        # exits non-zero on the first failed case
# Spawns throwaway `sleep`/`sh` children only; state goes to a temp dir.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
export HOPE_DEV_STATE_DIR="$TMP/state"
export SUPERVISOR_BACKOFF_MIN_S=1 SUPERVISOR_BACKOFF_MAX_S=2 SUPERVISOR_HEALTHY_S=60 SUPERVISOR_STARTUP_GRACE_S=2
STACK_NAME="dev"
SCRIPT_DIR="$(dirname "$HERE")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
port_for() { echo ""; }
CMD=()
set_command_for() { CMD=("${TEST_CMD[@]}"); }
# shellcheck source=scripts/lib/stack-supervisor.sh
source "$HERE/stack-supervisor.sh"
ensure_private_dir "$STATE_DIR"; ensure_private_dir "$LOG_DIR"; ensure_private_dir "$PID_DIR"

FAILS=0
ok()   { echo "  ok   - $*"; }
fail() { echo "  FAIL - $*"; FAILS=$((FAILS + 1)); }
wait_for() { # wait_for <seconds> <cmd...>
    local n="$1"; shift
    local i=0
    while [ "$i" -lt $((n * 10)) ]; do "$@" && return 0; sleep 0.1; i=$((i + 1)); done
    return 1
}
child_of() { cat "$PID_DIR/$1.child" 2>/dev/null || true; }
start() { # start <svc> <cmd...>
    local svc="$1"; shift
    TEST_CMD=("$@"); : > "$LOG_DIR/$svc.log"; set_command_for "$svc"
    supervisor_spawn_one "$svc" "$LOG_DIR/$svc.log"
    printf '%s\n%s\n' "$SUPERVISOR_LAST_PID" "$(proc_start_time "$SUPERVISOR_LAST_PID")" > "$PID_DIR/$svc.pid"
}
changed() { [ -n "$(child_of "$1")" ] && [ "$(child_of "$1")" != "$2" ]; }
alive() { kill -0 "$1" 2>/dev/null; }
cleanup() { supervisor_down >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "case 1: a SIGKILLed child is restarted and the signal is logged"
start svc1 sleep 300
wait_for 3 test -n "$(child_of svc1)" || fail "child pid never recorded"
c1="$(child_of svc1)"; sleep 2.5   # past the startup grace
kill -9 "$c1"
if wait_for 6 changed svc1 "$c1"; then ok "restarted (new pid $(child_of svc1))"; else fail "no restart"; fi
grep -q "SIGKILL" "$LOG_DIR/svc1.log" && ok "exit signal logged" || fail "no SIGKILL line in log: $(cat "$LOG_DIR/svc1.log")"
alive "$(child_of svc1)" && ok "new child is alive" || fail "new child not alive"

echo "case 2: down stops loop and child, and nothing is restarted afterwards"
loop1="$(sed -n 1p "$PID_DIR/svc1.pid")"; c2="$(child_of svc1)"
supervisor_down >/dev/null
wait_for 5 bash -c "! kill -0 $loop1 2>/dev/null && ! kill -0 $c2 2>/dev/null" && ok "loop and child gone" || fail "survivors after down"
sleep 2.5
[ -z "$(pgrep -f 'sleep 300' || true)" ] && ok "no respawn after down" || fail "a sleep 300 was respawned"

echo "case 3: a first launch that dies at once is NOT retried (config error)"
start svc3 sh -c 'exit 3'
wait_for 5 bash -c "! kill -0 $SUPERVISOR_LAST_PID 2>/dev/null" && ok "loop exited" || fail "loop kept running"
grep -q "failed on first launch" "$LOG_DIR/svc3.log" && ok "failure logged" || fail "no first-launch line"

echo "case 4: a clean exit 0 (uvicorn recycle) is restarted"
start svc4 sh -c 'sleep 2.5; exit 0'
wait_for 10 grep -q "exited cleanly" "$LOG_DIR/svc4.log" && ok "clean exit seen" || fail "no clean-exit line"
c4a="$(child_of svc4)"; wait_for 6 changed svc4 "$c4a" && ok "restarted after clean exit" || fail "not restarted"
supervisor_down >/dev/null

echo
[ "$FAILS" -eq 0 ] && echo "ALL PASSED" || { echo "$FAILS FAILED"; exit 1; }
