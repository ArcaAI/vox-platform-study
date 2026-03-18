#!/bin/bash
# ============================================================================
# Start API with Test Environment Configuration
# ============================================================================
# Starts the NestJS API Gateway with .env.test configuration.
#
# USAGE:
#   ./scripts/start-test-api.sh           # Start API with test config
#   ./scripts/start-test-api.sh --build   # Build packages first, then start
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - Database schema pushed (pnpm test:db:push)
#   - Optionally seeded (pnpm test:db:seed)
#
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/start-test-service.sh"

check_env_file
check_docker_containers
handle_build_flag "$1"

cd "$PROJECT_ROOT"
load_env_test

print_service_header "API Gateway" "http://localhost:$PORT"

exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/api dev
