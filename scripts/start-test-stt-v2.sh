#!/bin/bash
# ============================================================================
# Start STT-v2 with Test Environment Configuration
# ============================================================================
# Starts the Speech-to-Text v2 (FastAPI) service with .env.test configuration.
#
# USAGE:
#   ./scripts/start-test-stt-v2.sh           # Start STT-v2 with test config
#   ./scripts/start-test-stt-v2.sh --build   # Build TS packages first, then start
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - conda environment 'arcaenv' set up (pnpm py:setup)
#
# HEALTH CHECK:
#   curl http://localhost:${STT_V2_PORT:-8861}/health
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

STT_V2_PORT="${STT_V2_PORT:-8861}"
STT_V2_URL="${STT_V2_URL:-http://localhost:$STT_V2_PORT}"

print_service_header "STT-v2 (Speech-to-Text)" "$STT_V2_URL" "Conda env: arcaenv"

exec npx dotenv -o -e .env.test -- \
    conda run -n arcaenv --no-capture-output \
    uvicorn stt_v2.main:app \
    --host 0.0.0.0 \
    --port "$STT_V2_PORT" \
    --reload \
    --app-dir apps/stt-v2/src
