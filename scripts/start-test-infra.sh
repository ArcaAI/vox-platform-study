#!/bin/bash
# ============================================================================
# Start HOPE Test Infrastructure
# ============================================================================
# This script manages the Docker Compose test infrastructure from the
# monorepo root to ensure the .env.test file is properly loaded.
#
# Usage:
#   pnpm infra:test:up         ./scripts/start-test-infra.sh
#   pnpm infra:test:down       ./scripts/start-test-infra.sh --stop      (removes volumes)
#   pnpm infra:test:restart    ./scripts/start-test-infra.sh --restart   (clean slate)
#   pnpm infra:test:logs       ./scripts/start-test-infra.sh --logs
#   pnpm infra:test:status     ./scripts/start-test-infra.sh --status
#   pnpm infra:test:validate   ./scripts/start-test-infra.sh --validate
#   ./scripts/start-test-infra.sh --help       # Show help
#
# Port Mapping (Test vs Dev):
#   PostgreSQL: 5433 (test) vs 5432 (dev)
#   Redis:      6380 (test) vs 6379 (dev)
#   MinIO:      9002 (test) vs 9000 (dev)
#   Qdrant:     6335 (test) vs 6333 (dev)
#   Vault:      8201 (test) vs 8200 (dev)   — fully isolated
# ============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="tests/docker-compose.test.yml"
DOCKER_COMPOSE="docker compose -f $COMPOSE_FILE"

print_header() {
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  HOPE Test Infrastructure${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

validate_services() {
    local all_ok=true

    echo ""
    echo -e "${CYAN}Validating test infrastructure...${NC}"
    echo ""

    # PostgreSQL
    if docker exec hope-postgres-test pg_isready -U test -d hope_test > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} PostgreSQL (port 5433) - healthy"
    else
        echo -e "  ${RED}✗${NC} PostgreSQL (port 5433) - not ready"
        all_ok=false
    fi

    # Redis (with auth)
    if docker exec hope-redis-test redis-cli -a test_redis_pass ping 2>/dev/null | grep -q PONG; then
        echo -e "  ${GREEN}✓${NC} Redis (port 6380) - healthy"
    else
        echo -e "  ${RED}✗${NC} Redis (port 6380) - not ready"
        all_ok=false
    fi

    # MinIO
    if docker exec hope-minio-test curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} MinIO (port 9002) - healthy"
    else
        echo -e "  ${RED}✗${NC} MinIO (port 9002) - not ready"
        all_ok=false
    fi

    # Qdrant (use bash TCP check since the image has no curl/wget)
    if docker exec hope-qdrant-test bash -c "echo > /dev/tcp/localhost/6333" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Qdrant (port 6335) - healthy"

        # Check if init container finished successfully
        local init_status
        init_status=$(docker inspect hope-qdrant-init-test --format='{{.State.ExitCode}}' 2>/dev/null)
        if [ "$init_status" = "0" ]; then
            echo -e "  ${GREEN}✓${NC} Qdrant collections - initialized"
        else
            echo -e "  ${YELLOW}!${NC} Qdrant collections - init container may still be running"
        fi
    else
        echo -e "  ${RED}✗${NC} Qdrant (port 6335) - not ready"
        all_ok=false
    fi

    # Temporal (TASK-869): the server, then the init container that registers the
    # `default` namespace and the `HarnessTenantId` search attribute. The order
    # matters and is enforced by compose `depends_on`, but it is reported here
    # because a worker started before the namespace exists never recovers — it
    # keeps logging "Namespace default is not found" and polls nothing.
    if nc -z localhost "${TEST_TEMPORAL_PORT:-7333}" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Temporal (port ${TEST_TEMPORAL_PORT:-7333}) - healthy"
        local temporal_init
        temporal_init=$(docker inspect hope-temporal-init-test --format='{{.State.ExitCode}}' 2>/dev/null)
        if [ "$temporal_init" = "0" ]; then
            echo -e "  ${GREEN}✓${NC} Temporal namespace + search attributes - initialized"
        else
            echo -e "  ${YELLOW}!${NC} Temporal init container has not completed (exit=${temporal_init:-missing})"
        fi
    else
        echo -e "  ${RED}✗${NC} Temporal (port ${TEST_TEMPORAL_PORT:-7333}) - not ready"
        all_ok=false
    fi

    # Vault (isolated hope-vault-test, not the shared dev Vault)
    if docker exec hope-vault-test wget -q -O- http://127.0.0.1:8200/v1/sys/health 2>/dev/null | grep -q '"initialized":true'; then
        echo -e "  ${GREEN}✓${NC} Vault (port 8201) - healthy"

        local vault_init_status
        vault_init_status=$(docker inspect hope-vault-init-test --format='{{.State.ExitCode}}' 2>/dev/null)
        if [ "$vault_init_status" = "0" ]; then
            echo -e "  ${GREEN}✓${NC} Vault AppRole/transit - initialized"
        else
            echo -e "  ${YELLOW}!${NC} Vault AppRole/transit - init container may still be running"
        fi
    else
        echo -e "  ${RED}✗${NC} Vault (port 8201) - not ready"
        all_ok=false
    fi

    echo ""
    if [ "$all_ok" = true ]; then
        echo -e "${GREEN}All test infrastructure services are healthy.${NC}"
        return 0
    else
        echo -e "${RED}Some services are not ready. Check logs with: pnpm infra:test:logs${NC}"
        return 1
    fi
}

case "${1:-}" in
    --stop)
        print_header
        echo ""
        echo -e "${YELLOW}Stopping test infrastructure and removing volumes...${NC}"
        $DOCKER_COMPOSE down -v
        echo -e "${GREEN}Test infrastructure stopped.${NC}"
        ;;
    --logs)
        $DOCKER_COMPOSE logs -f
        ;;
    --status)
        print_header
        echo ""
        $DOCKER_COMPOSE ps
        ;;
    --validate)
        print_header
        validate_services
        ;;
    --restart)
        print_header
        echo ""
        # `down -v` REMOVES volumes: a restart of the test infra is meant to be
        # a clean slate, so the schema must be pushed again afterwards.
        echo -e "${YELLOW}Restarting test infrastructure (volumes are removed)...${NC}"
        $DOCKER_COMPOSE down -v
        $DOCKER_COMPOSE up -d --wait || true
        echo ""
        $DOCKER_COMPOSE ps -a
        sleep 3
        validate_services
        echo ""
        echo -e "${YELLOW}Volumes were removed — run 'pnpm test:db:reset' before any suite.${NC}"
        ;;
    --help|-h)
        print_header
        echo ""
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (none)       Start test infrastructure services"
        echo "  --stop       Stop all test services and remove volumes"
        echo "  --restart    Stop (removing volumes) and start again — clean slate"
        echo "  --logs       Follow logs from all test services"
        echo "  --status     Show status of test services"
        echo "  --validate   Verify all services are healthy and initialized"
        echo "  --help       Show this help message"
        echo ""
        echo "Port Mapping (Test vs Dev):"
        echo "  PostgreSQL: 5433 (test) vs 5432 (dev)"
        echo "  Redis:      6380 (test) vs 6379 (dev)"
        echo "  MinIO:      9002 (test) vs 9000 (dev)"
        echo "  Qdrant:     6335 (test) vs 6333 (dev)"
        echo "  Vault:      8201 (test) vs 8200 (dev)"
        echo ""
        echo "Compose file: $COMPOSE_FILE"
        ;;
    *)
        print_header
        echo ""
        echo -e "${GREEN}Starting test infrastructure services...${NC}"
        echo ""
        # --wait may return non-zero when init containers (minio-createbuckets,
        # qdrant-init-test) exit after completing their work. This is expected
        # behavior, so we don't let set -e abort the script here.
        $DOCKER_COMPOSE up -d --wait || true
        echo ""
        echo -e "${GREEN}Services started:${NC}"
        $DOCKER_COMPOSE ps -a
        echo ""
        # Give init containers a moment to finish
        sleep 3
        validate_services
        ;;
esac
