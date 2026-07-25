#!/bin/bash
# ============================================================================
# TASK-557 — Start ONE app/service/worker against the TEST environment
# ============================================================================
# Replaces the former per-service start-test-{api,stt,smr,nlp}.sh scripts,
# which each re-implemented a uvicorn command that scripts/dev-service.sh
# already owns. Launch logic now lives in exactly one place, so a dev-launcher
# fix can never silently skip the test launcher.
#
# USAGE:
#   ./scripts/start-test-app.sh <target> [--build]
#
# TARGETS:
#   api  admin  stt  smr  nlp  guardrail  harness  tts  worker
#
# FLAGS:
#   --build   build the TS packages first (db:generate + core packages + modules)
#
# REQUIREMENTS:
#   - test infrastructure running   (pnpm infra:test:up)
#   - schema pushed + seeded        (pnpm test:db:reset)
#   - conda env 'arcaenv'           (Python targets only; pnpm setup:python)
#
# PORT OVERLAP: .env.test reuses the DEV application ports, so this refuses to
# start when the port is already bound (usually a dev stack). Stop the dev
# stack first — see 'pnpm stack:test:doctor'.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/start-test-service.sh
source "$SCRIPT_DIR/start-test-service.sh"

TARGET="${1:-}"
shift || true

PY_TARGETS=(stt smr nlp guardrail harness tts worker)
TS_TARGETS=(api admin)

usage() {
    echo "Usage: $0 <${TS_TARGETS[*]} ${PY_TARGETS[*]}> [--build]" >&2
}

if [ -z "$TARGET" ]; then
    echo -e "${RED}No target given.${NC}" >&2
    usage
    exit 2
fi

is_python_target=false
known=false
for t in "${PY_TARGETS[@]}"; do
    if [ "$TARGET" = "$t" ]; then is_python_target=true; known=true; fi
done
for t in "${TS_TARGETS[@]}"; do
    if [ "$TARGET" = "$t" ]; then known=true; fi
done
if [ "$known" != "true" ]; then
    echo -e "${RED}Unknown target '$TARGET'.${NC}" >&2
    usage
    exit 2
fi

check_env_file
check_docker_containers
if $is_python_target; then
    check_conda_env "arcaenv"
fi
handle_build_flag "$@"

cd "$PROJECT_ROOT"
load_env_test

# ----------------------------------------------------------------------------
# Resolve the port this target will bind (worker binds none) and refuse to
# collide with an already-running process.
# ----------------------------------------------------------------------------
port_for() {
    case "$1" in
        api)       echo "${API_PORT:-8868}" ;;
        admin)     echo "${ADMIN_PORT:-5176}" ;;
        stt)       echo "${STT_PORT:-8861}" ;;
        smr)       echo "${SMR_PORT:-8862}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8863}" ;;
        nlp)       echo "${NLP_PORT:-8864}" ;;
        tts)       echo "${TTS_PORT:-8865}" ;;
        harness)   echo "${HARNESS_PORT:-8866}" ;;
        worker)    echo "" ;;
    esac
}

TARGET_PORT="$(port_for "$TARGET")"
if [ -n "$TARGET_PORT" ]; then
    check_port_available "$TARGET_PORT"
elif [ "$TARGET" = "worker" ]; then
    # Two workers on one Temporal task queue steal each other's tasks, which
    # surfaces as nondeterministic test failures rather than an error.
    if pgrep -f 'harness\.temporal\.worker' >/dev/null 2>&1; then
        echo -e "${RED}Error: a harness.temporal.worker process is already running.${NC}" >&2
        echo "Two workers would consume from the same task queue. Stop the other one first." >&2
        exit 1
    fi
fi

print_service_header "$TARGET (test env)" "${TARGET_PORT:+http://localhost:$TARGET_PORT}" \
    "$($is_python_target && echo "Conda env: arcaenv" || echo "")"

# ----------------------------------------------------------------------------
# Launch — dev-service.sh owns every Python launch command; TS apps go through
# their own package scripts. `dotenv -o` lets .env.test override the ambient
# environment so a stray dev value cannot leak into a test run.
# ----------------------------------------------------------------------------
case "$TARGET" in
    api)
        exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/api dev
        ;;
    admin)
        exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/admin-console dev
        ;;
    *)
        exec npx dotenv -o -e .env.test -- "$SCRIPT_DIR/dev-service.sh" "$TARGET"
        ;;
esac
