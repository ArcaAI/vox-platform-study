#!/bin/bash
# ============================================================================
# Start a Service with Test Environment Configuration
# ============================================================================
# Shared script that starts any HOPE service with .env.test configuration.
# Called by individual service scripts (start-test-api.sh, start-test-stt.sh, etc.)
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
        # In non-interactive contexts (CI, nohup, IDE task runners without TTY) `read`
        # returns immediately with empty input; falling through silently leads to a
        # confusing DB-connection failure later. Fail fast with a clear directive.
        if [ ! -t 0 ]; then
            echo -e "${RED}Error: stdin is not a TTY; cannot prompt to start containers.${NC}"
            echo "Run 'pnpm docker:test:up' first, then retry."
            exit 1
        fi
        read -p "Would you like to start the test containers now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${GREEN}Starting test containers...${NC}"
            # --wait returns non-zero when one-shot init containers (minio-createbuckets,
            # qdrant-init-test) finish their work and exit. Compose flags this as
            # "exited prematurely" even though exit 0 is the intended outcome. Mirrors
            # the handling in start-test-infra.sh; we re-validate below to catch real
            # failures of the long-running services.
            docker compose -f "$PROJECT_ROOT/tests/docker-compose.test.yml" up -d --wait || true
            if ! docker compose -f "$PROJECT_ROOT/tests/docker-compose.test.yml" ps --status running 2>/dev/null | grep -q "hope-postgres-test"; then
                echo -e "${RED}Error: postgres-test failed to start. Inspect with 'pnpm docker:test:logs'.${NC}"
                exit 1
            fi
        else
            echo -e "${YELLOW}Proceeding without containers. Service may fail to start.${NC}"
        fi
    fi
}

check_conda_env() {
    local env_name="${1:-arcaenv}"
    # Match only the env-name column (first whitespace-separated field) so that
    # similarly-prefixed envs like "arcaenv-dev" don't satisfy a request for "arcaenv".
    if ! conda env list 2>/dev/null | awk 'NF && $1 !~ /^#/ {print $1}' | grep -qx "$env_name"; then
        echo -e "${RED}Error: conda environment '$env_name' not found.${NC}"
        echo "Set it up with: pnpm py:setup"
        exit 1
    fi
}

handle_build_flag() {
    for arg in "$@"; do
        if [ "$arg" = "--build" ]; then
            echo -e "${GREEN}Building packages first...${NC}"
            cd "$PROJECT_ROOT"
            pnpm db:generate
            pnpm build:packages
            pnpm build:modules
            echo -e "${GREEN}Build complete.${NC}"
            return
        fi
    done
}

load_env_test() {
    set -a
    source "$PROJECT_ROOT/.env.test"
    set +a
}

# Fail fast with an actionable message when the service port is already bound.
# dev:api and test:api:up share port 8868 (and the Node inspector on 9229), so a
# running dev API — or a stale prior test:api:up — otherwise surfaces as an
# unhandled EADDRINUSE crash deep in the Nest bootstrap.
check_port_available() {
    local port="$1"
    local pids
    if ! command -v lsof >/dev/null 2>&1; then
        return 0
    fi
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        echo -e "${RED}Error: port $port is already in use (PID(s): $(echo "$pids" | tr '\n' ' ')).${NC}"
        echo "The test API shares port $port with 'pnpm dev:api'. Stop the conflicting"
        echo "process first, e.g.:  kill $(echo "$pids" | tr '\n' ' ')"
        exit 1
    fi
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
