#!/bin/bash
# ============================================================================
# Start NLP with Test Environment Configuration
# ============================================================================
# Starts the NLP (FastAPI) service with .env.test configuration.
#
# USAGE:
#   ./scripts/start-test-nlp.sh           # Start NLP with test config
#   ./scripts/start-test-nlp.sh --build   # Build TS packages first, then start
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - conda environment 'arcaenv' set up (pnpm py:setup)
#
# HEALTH CHECK:
#   curl http://localhost:${NLP_PORT:-8864}/api/v1/health
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

NLP_PORT="${NLP_PORT:-8864}"
NLP_URL="${NLP_URL:-http://localhost:$NLP_PORT}"

print_service_header "NLP (Natural Language Processing)" "$NLP_URL" "Conda env: arcaenv"

exec npx dotenv -o -e .env.test -- \
    conda run -n arcaenv --no-capture-output \
    uvicorn --factory nlp.app:get_app \
    --host 0.0.0.0 \
    --port "$NLP_PORT" \
    --reload \
    --app-dir apps/nlp/src
