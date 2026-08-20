#!/bin/bash
# ============================================================================
# Managed test run (infra → services → suite → report → teardown)
# ============================================================================
# Runs a test suite end to end without leaving anything behind:
#
#   1. Check the isolated TEST infrastructure. Start it if it is down.
#   2. Check the schema is pushed/seeded. Push + seed if it is not.
#   3. Start whatever app services the suite needs, and WAIT for their health
#      endpoints (a suite that races the boot fails for the wrong reason).
#   4. Run the suite.
#   5. Print the result — BEFORE any teardown, so the summary is the last thing
#      on screen and survives a slow docker down.
#   6. Tear down ONLY what this script started. Infra that was already up when
#      the script began is left exactly as it was found.
#
# USAGE:
#   ./scripts/test-run.sh <suite> [service...] [--keep] [--no-teardown-infra]
#
# SUITES:
#   unit          Vitest unit suites            (infra: yes, services: none)
#   integration   Vitest integration suites     (infra: yes, services: none)
#   e2e           Playwright API e2e            (infra: yes, services: full stack)
#   py            every Python pytest suite     (infra: yes, services: none)
#   <service>     one Python service's pytest   (stt|text|nlp|guardrail|harness|tts)
#
# Extra positional args override the service list, e.g.:
#   ./scripts/test-run.sh integration api harness
#
# FLAGS:
#   --keep                 leave services AND infra running after the run
#   --no-teardown-infra    stop services, but leave the infra up (fast re-runs)
#
# EXIT CODE: the suite's exit code (teardown failures never mask it).
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 240s ceiling: the e2e full-stack default boots six services CONCURRENTLY, each
# through its own `conda run`; STT and guardrail import heavy ML stacks and, under
# that contention, routinely need well past the old 120s (measured individually on
# an idle machine: ~40s and ~55s — the concurrent run is what blows the budget).
# This only bounds the wait when a service is NOT yet healthy — a fast boot
# still exits the health loop the moment it reports ready, so success is unaffected.
READY_TIMEOUT="${TEST_RUN_TIMEOUT:-240}"
KEEP=false
TEARDOWN_INFRA=true

PY_SERVICES=(stt text nlp guardrail harness tts)

SUITE=""
SERVICES=()
for arg in "$@"; do
    [ "$arg" = "--" ] && continue
    case "$arg" in
        --keep) KEEP=true ;;
        --no-teardown-infra) TEARDOWN_INFRA=false ;;
        --help|-h) sed -n '2,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo -e "${RED}Unknown flag '$arg'.${NC}" >&2; exit 2 ;;
        *)
            if [ -z "$SUITE" ]; then SUITE="$arg"; else SERVICES+=("$arg"); fi ;;
    esac
done

if [ -z "$SUITE" ]; then
    echo -e "${RED}No suite given.${NC} One of: unit integration e2e py ${PY_SERVICES[*]}" >&2
    exit 2
fi
if [ "${#SERVICES[@]}" -gt 0 ]; then
    remapped=()
    for s in "${SERVICES[@]}"; do
        remapped+=("$s")
    done
    SERVICES=("${remapped[@]}")
fi

# ----------------------------------------------------------------------------
# Suite → command + default services
# ----------------------------------------------------------------------------
SUITE_CMD=()
DEFAULT_SERVICES=()
case "$SUITE" in
    unit)
        SUITE_CMD=(pnpm test:unit)
        DEFAULT_SERVICES=() ;;
    integration)
        SUITE_CMD=(pnpm test:integration)
        DEFAULT_SERVICES=() ;;
    e2e)
        SUITE_CMD=(pnpm test:e2e)
        # Full stack minus the Temporal worker: the isolated test infra
        # (tests/docker-compose.test.yml) has no Temporal, so the worker cannot
        # connect. The harness FastAPI app itself boots fine without it.
        # Override ad-hoc by passing services, e.g. `test:e2e:managed -- api text`.
        DEFAULT_SERVICES=(api stt text guardrail nlp harness) ;;
    py)
        SUITE_CMD=(pnpm test:py)
        DEFAULT_SERVICES=() ;;
    stt|text|nlp|guardrail|harness|tts)
        SUITE_CMD=(pnpm "${SUITE}:test")
        DEFAULT_SERVICES=() ;;
    *)
        echo -e "${RED}Unknown suite '$SUITE'.${NC} One of: unit integration e2e py ${PY_SERVICES[*]}" >&2
        exit 2 ;;
esac

if [ "${#SERVICES[@]}" -eq 0 ]; then
    SERVICES=("${DEFAULT_SERVICES[@]+"${DEFAULT_SERVICES[@]}"}")
fi

# ----------------------------------------------------------------------------
# Track what WE started, so teardown never stops something the user had running
# ----------------------------------------------------------------------------
STARTED_INFRA=false
STARTED_SERVICES=()
SERVICE_PIDS=()
LOG_DIR="${HOPE_DEV_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hope-dev/logs}/test-run"
SUITE_EXIT=1
TORN_DOWN=false

step() { echo -e "${CYAN}── $1 ${NC}"; }

kill_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
    kill "$pid" 2>/dev/null || true
}

teardown() {
    $TORN_DOWN && return 0
    TORN_DOWN=true

    if $KEEP; then
        echo ""
        echo -e "${YELLOW}--keep given: leaving services and infra running.${NC}"
        [ "${#STARTED_SERVICES[@]}" -gt 0 ] && echo "  services: ${STARTED_SERVICES[*]}  (logs in $LOG_DIR)"
        $STARTED_INFRA && echo "  infra:    started by this run — stop with 'pnpm infra:test:down'"
        return 0
    fi

    if [ "${#SERVICE_PIDS[@]}" -gt 0 ]; then
        step "Stopping services started by this run: ${STARTED_SERVICES[*]}"
        local i p
        for i in "${!SERVICE_PIDS[@]}"; do kill_tree "${SERVICE_PIDS[$i]}"; done
        sleep 2
        for i in "${!SERVICE_PIDS[@]}"; do
            for p in $(pgrep -P "${SERVICE_PIDS[$i]}" 2>/dev/null || true); do kill -9 "$p" 2>/dev/null || true; done
            kill -9 "${SERVICE_PIDS[$i]}" 2>/dev/null || true
        done
        echo -e "  ${GREEN}stopped${NC} ${#SERVICE_PIDS[@]} service(s)"
    fi

    if $STARTED_INFRA; then
        if $TEARDOWN_INFRA; then
            step "Stopping test infrastructure started by this run"
            "$SCRIPT_DIR/start-test-infra.sh" --stop >/dev/null 2>&1 \
                && echo -e "  ${GREEN}stopped${NC} test infra" \
                || echo -e "  ${YELLOW}warn${NC} could not stop test infra cleanly"
        else
            echo -e "${YELLOW}Leaving test infra up (--no-teardown-infra).${NC}"
        fi
    fi
}
# Teardown must run on Ctrl-C too, or a cancelled run leaks a stack.
trap 'teardown; exit 130' INT TERM

echo -e "${CYAN}━━ managed test run: ${BOLD}$SUITE${NC}${CYAN} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  command:  ${SUITE_CMD[*]}"
echo "  services: ${SERVICES[*]:-none}"
echo ""

# ----------------------------------------------------------------------------
# Step 1 — infrastructure
# ----------------------------------------------------------------------------
step "Step 1/5: checking test infrastructure"
if "$SCRIPT_DIR/test-doctor.sh" --infra-only >/dev/null 2>&1; then
    echo -e "  ${GREEN}already up${NC} — leaving it as found"
else
    echo "  not ready — starting test infrastructure"
    if ! "$SCRIPT_DIR/start-test-infra.sh" >/dev/null; then
        echo -e "${RED}Failed to start test infrastructure.${NC}" >&2
        exit 1
    fi
    STARTED_INFRA=true

    # Schema/seed may still be missing on a freshly created volume.
    if ! "$SCRIPT_DIR/test-doctor.sh" --infra-only >/dev/null 2>&1; then
        echo "  schema missing — running test:db:reset"
        # The PHI-ciphertext seed (packages/database/.../seed/phi-encryption.ts)
        # calls Vault Transit under .env.test's SECRETS_PROVIDER=vault, so Vault
        # (hope-vault-test) must be provisioned BEFORE the seed runs —
        # not just before app services start (Step 2 below), which never fires
        # for suites with no services (unit/integration/py/single Python
        # services). No-op when .env.test doesn't select the Vault provider.
        if ! "$SCRIPT_DIR/ensure-test-vault-creds.sh"; then
            echo -e "${RED}Failed to provision Vault credentials for the test env.${NC}" >&2
            teardown
            exit 1
        fi
        # Seeding is opt-in and defaults to RUN_SEED=none — managed
        # test runs need the full demo fixture set (media-seed.ts depends on
        # the seeded doctor row), so opt in explicitly, matching test-setup.sh.
        if ! RUN_SEED=all NODE_ENV=test pnpm test:db:reset; then
            echo -e "${RED}Failed to prepare the test database.${NC}" >&2
            teardown
            exit 1
        fi
    fi
    echo -e "  ${GREEN}infrastructure ready${NC}"
fi

# ----------------------------------------------------------------------------
# Step 2 — services
# ----------------------------------------------------------------------------
# Ports come from .env.test (test = dev + 100), never hardcoded to the dev values.
env_val() { grep -E "^$1=" "$REPO_ROOT/.env.test" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
port_for() {
    local v
    case "$1" in
        api)       v="$(env_val API_PORT)";       echo "${v:-8968}" ;;
        admin)     v="$(env_val ADMIN_PORT)";     echo "${v:-5276}" ;;
        stt)       v="$(env_val STT_PORT)";       echo "${v:-8961}" ;;
        text)      v="$(env_val TEXT_PORT)";       echo "${v:-8962}" ;;
        guardrail) v="$(env_val GUARDRAIL_PORT)"; echo "${v:-8963}" ;;
        nlp)       v="$(env_val NLP_PORT)";       echo "${v:-8964}" ;;
        tts)       v="$(env_val TTS_PORT)";       echo "${v:-8965}" ;;
        harness)   v="$(env_val HARNESS_PORT)";   echo "${v:-8966}" ;;
        worker)    echo "" ;;
    esac
}
health_path_for() {
    case "$1" in guardrail) echo "/api/health" ;; worker) echo "" ;; *) echo "/api/v1/health" ;; esac
}

if [ "${#SERVICES[@]}" -eq 0 ]; then
    step "Step 2/5: no app services required for this suite"
else
    # Services run SECRETS_PROVIDER=vault and fail closed if .env.test's AppRole
    # creds are stale (e.g. hope-vault-test was recreated → new role_id). Auto-mint
    # fresh creds so the API boots — nobody re-provisions role_id/secret_id by
    # hand. No-op when .env.test does not select the Vault provider. Idempotent
    # with the Step 1 call above (cheap re-run, harmless if both fire).
    step "Step 2/5: ensuring Vault creds + starting services (${SERVICES[*]})"
    if ! "$SCRIPT_DIR/ensure-test-vault-creds.sh"; then
        echo -e "${RED}Failed to provision Vault credentials for the test env.${NC}" >&2
        teardown
        exit 1
    fi
    mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
    for svc in "${SERVICES[@]}"; do
        port="$(port_for "$svc")"
        if [ -n "$port" ] && lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${RED}  port $port is already bound — refusing to start '$svc'.${NC}" >&2
            echo "  This is a TEST port (dev runs 100 lower); something already owns it —" >&2
            echo "  most likely an earlier test run. Clear it with 'pnpm stack:test:down'." >&2
            teardown
            exit 1
        fi
        log="$LOG_DIR/$svc.log"
        : > "$log"
        "$SCRIPT_DIR/start-test-app.sh" "$svc" >>"$log" 2>&1 &
        SERVICE_PIDS+=("$!")
        STARTED_SERVICES+=("$svc")
        echo "  spawned $svc (pid $!) → $log"
    done

    step "Step 3/5: waiting for services to become healthy (timeout ${READY_TIMEOUT}s)"
    deadline=$(( SECONDS + READY_TIMEOUT ))
    pending=("${STARTED_SERVICES[@]}")
    while [ "${#pending[@]}" -gt 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
        still=()
        for svc in "${pending[@]}"; do
            port="$(port_for "$svc")"; path="$(health_path_for "$svc")"
            if [ -z "$port" ] || [ -z "$path" ]; then continue; fi
            code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
                "http://localhost:$port$path" 2>/dev/null)" || code="000"
            if [ "${code:0:1}" = "2" ] || [ "${code:0:1}" = "3" ]; then
                echo -e "  ${GREEN}ready${NC} $svc (http://localhost:$port$path → $code)"
            else
                still+=("$svc")
            fi
        done
        pending=("${still[@]+"${still[@]}"}")
        [ "${#pending[@]}" -gt 0 ] && sleep 3
    done
    if [ "${#pending[@]}" -gt 0 ]; then
        echo -e "${RED}  services never became healthy: ${pending[*]}${NC}" >&2
        for svc in "${pending[@]}"; do
            echo -e "${YELLOW}  --- last 20 lines of $svc ---${NC}" >&2
            tail -n 20 "$LOG_DIR/$svc.log" >&2 || true
        done
        teardown
        exit 1
    fi
fi

# ----------------------------------------------------------------------------
# Step 4 — run the suite
# ----------------------------------------------------------------------------
step "Step 4/5: running suite — ${SUITE_CMD[*]}"
echo ""
"${SUITE_CMD[@]}"
SUITE_EXIT=$?
echo ""

# ----------------------------------------------------------------------------
# Step 5 — report BEFORE teardown
# ----------------------------------------------------------------------------
echo -e "${CYAN}━━ result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
printf '  %-14s %s\n' "suite:" "$SUITE"
printf '  %-14s %s\n' "command:" "${SUITE_CMD[*]}"
printf '  %-14s %s\n' "services:" "${STARTED_SERVICES[*]:-none}"
printf '  %-14s %s\n' "infra:" "$($STARTED_INFRA && echo 'started by this run' || echo 'pre-existing, untouched')"
if [ "$SUITE_EXIT" -eq 0 ]; then
    printf "  %-14s ${GREEN}PASSED${NC} (exit 0)\n" "outcome:"
else
    printf "  %-14s ${RED}FAILED${NC} (exit %s)\n" "outcome:" "$SUITE_EXIT"
    [ "${#STARTED_SERVICES[@]}" -gt 0 ] && printf '  %-14s %s\n' "logs:" "$LOG_DIR"
fi
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

step "Step 5/5: teardown"
teardown

exit "$SUITE_EXIT"
