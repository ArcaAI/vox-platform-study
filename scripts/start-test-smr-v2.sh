#!/bin/bash
# ============================================================================
# Start SMR-v2 with Test Environment Configuration
# ============================================================================
# Starts the Summary v2 (FastAPI) service with .env.test configuration.
#
# USAGE:
#   ./scripts/start-test-smr-v2.sh           # Start SMR-v2 with test config
#   ./scripts/start-test-smr-v2.sh --build   # Build TS packages first, then start
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - conda environment 'arcaenv' set up (pnpm py:setup)
#
# HEALTH CHECK:
#   curl http://localhost:${SMR_PORT:-8862}/api/v2/health
#
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/start-test-service.sh"

check_env_file
check_docker_containers
check_conda_env "arcaenv"
handle_build_flag "$1"

cd "$PROJECT_ROOT"
load_env_test

SMR_PORT="${SMR_PORT:-8862}"
SMR_URL="${SMR_URL:-http://localhost:$SMR_PORT}"

print_service_header "SMR-v2 (Summary)" "$SMR_URL" "Conda env: arcaenv"

exec npx dotenv -o -e .env.test -- \
    conda run -n arcaenv --no-capture-output \
    uvicorn smr_v2.main:app \
    --host 0.0.0.0 \
    --port "$SMR_PORT" \
    --reload \
    --app-dir apps/smr/src
