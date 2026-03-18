#!/bin/bash
# ============================================================================
# Start HOPE Infrastructure
# ============================================================================
# This script starts the Docker Compose infrastructure from the monorepo root
# to ensure the root .env file is properly loaded.
#
# Usage:
#   ./scripts/start-infra.sh          # Start core services
#   ./scripts/start-infra.sh --all    # Start core + extended services
#   ./scripts/start-infra.sh --stop   # Stop all services
#   ./scripts/start-infra.sh --logs   # Show logs
# ============================================================================

set -e

# Ensure we're running from the monorepo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "Warning: .env file not found in $REPO_ROOT"
    echo "Creating .env from .env.example..."
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "Created .env file. Please update it with your configuration."
    else
        echo "Error: .env.example not found!"
        exit 1
    fi
fi

# Docker Compose files
COMPOSE_CORE="infrastructure/docker/docker-compose.yml"
COMPOSE_DEV="infrastructure/docker/docker-compose.dev.yml"
ENV_FILE="$REPO_ROOT/.env"

# Common docker compose command with explicit env file
DOCKER_COMPOSE="docker compose --env-file $ENV_FILE"

echo "Using environment file: $ENV_FILE"
echo ""

case "${1:-}" in
    --all)
        echo "Starting all infrastructure services..."
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" up -d
        echo ""
        echo "Services started:"
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" ps
        ;;
    --stop)
        echo "Stopping all infrastructure services..."
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" down
        echo "Services stopped."
        ;;
    --logs)
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" logs -f
        ;;
    --status)
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" ps
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (none)     Start core services (PostgreSQL, Redis, MinIO)"
        echo "  --all      Start all services including Vault and Qdrant"
        echo "  --stop     Stop all services"
        echo "  --logs     Follow logs from all services"
        echo "  --status   Show status of all services"
        echo "  --help     Show this help message"
        echo ""
        echo "Environment:"
        echo "  Uses .env file from: $ENV_FILE"
        ;;
    *)
        echo "Starting core infrastructure services..."
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" up -d
        echo ""
        echo "Services started:"
        $DOCKER_COMPOSE -f "$COMPOSE_CORE" ps
        echo ""
        echo "To start extended services (Vault, Qdrant), run:"
        echo "  $0 --all"
        ;;
esac
