#!/bin/bash
# ============================================================================
# Start a Service with Test Environment Configuration
# ============================================================================
# Shared script that starts any HOPE service with .env.test configuration.
# Called by individual service scripts (start-test-api.sh, start-test-stt-v2.sh, etc.)
#
# USAGE (not called directly — use the service-specific scripts):
#   source scripts/start-test-service.sh
#
# REQUIREMENTS:
#   - Docker test containers running (pnpm docker:test:up)
#   - Database schema pushed (pnpm test:db:push)
#   - For Python services: conda environment 'arcaenv' set up
#
# ENVIRONMENT FILE CONVENTION:
#   - .env.dev        → Local development (NODE_ENV=development)
#   - .env.test       → Local testing (all start-test-*.sh scripts use this)
#   - .env.production → Production template (uses host environment)
#
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ============================================================================
# Common Functions
# ============================================================================

check_env_file() {
    if [ ! -f "$PROJECT_ROOT/.env.test" ]; then
        echo -e "${RED}Error: .env.test file not found at $PROJECT_ROOT/.env.test${NC}"
        echo "Please ensure .env.test exists in the project root."
        exit 1
    fi
}

check_docker_containers() {
    if ! docker compose -f "$PROJECT_ROOT/tests/docker-compose.test.yml" ps --status running 2>/dev/null | grep -q "hope-postgres-test"; then
        echo -e "${YELLOW}Warning: Test database container doesn't appear to be running.${NC}"
        echo "Start it with: pnpm docker:test:up"
        echo ""
        read -p "Would you like to start the test containers now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${GREEN}Starting test containers...${NC}"
            docker compose -f "$PROJECT_ROOT/tests/docker-compose.test.yml" up -d --wait
        else
            echo -e "${YELLOW}Proceeding without containers. Service may fail to start.${NC}"
        fi
    fi
}

check_conda_env() {
    local env_name="${1:-arcaenv}"
    if ! conda info --envs 2>/dev/null | grep -q "$env_name"; then
        echo -e "${RED}Error: conda environment '$env_name' not found.${NC}"
        echo "Set it up with: pnpm py:setup"
        exit 1
    fi
}

handle_build_flag() {
    if [ "$1" = "--build" ]; then
        echo -e "${GREEN}Building packages first...${NC}"
        cd "$PROJECT_ROOT"
        pnpm db:generate
        pnpm build:packages
        pnpm build:modules
        echo -e "${GREEN}Build complete.${NC}"
    fi
}

load_env_test() {
    set -a
    source "$PROJECT_ROOT/.env.test"
    set +a
}

print_service_header() {
    local service_name="$1"
    local service_url="$2"
    local extra_info="$3"

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Starting ${service_name} with test configuration${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo "  NODE_ENV:  test"
    echo "  Database:  $DATABASE_URL"
    echo "  Redis:     $REDIS_HOST:$REDIS_PORT"
    echo "  URL:       $service_url"
    if [ -n "$extra_info" ]; then
        echo "  $extra_info"
    fi
    echo ""
}
