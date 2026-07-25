#!/bin/bash
# ============================================================================
# Start STT with Test Environment Configuration
# ============================================================================
# Starts the Speech-to-Text (FastAPI) service with .env.test configuration.
#
# USAGE:
#   ./scripts/start-test-stt.sh           # Start STT with test config
#   ./scripts/start-test-stt.sh --build   # Build TS packages first, then start
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - conda environment 'arcaenv' set up (pnpm py:setup)
#
# HEALTH CHECK:
#   curl http://localhost:${STT_PORT:-8861}/health
#
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/start-test-service.sh"

check_env_file
check_docker_containers
check_conda_env "arcaenv"
handle_build_flag "$@"

cd "$PROJECT_ROOT"
load_env_test

STT_PORT="${STT_PORT:-8861}"
STT_URL="${STT_URL:-http://localhost:$STT_PORT}"

print_service_header "STT (Speech-to-Text)" "$STT_URL" "Conda env: arcaenv"

exec npx dotenv -o -e .env.test -- \
    conda run -n arcaenv --no-capture-output \
    uvicorn stt.main:app \
    --host 0.0.0.0 \
    --port "$STT_PORT" \
    --reload \
    --app-dir apps/stt/src
