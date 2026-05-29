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

# Common docker compose command with explicit env file.
# `--profile vault` opts in to the Vault + vault-init services defined in
# docker-compose.dev.yml (they are profile-gated by design — see the file
# header for the rationale).
DOCKER_COMPOSE="docker compose --env-file $ENV_FILE"
DOCKER_COMPOSE_ALL="$DOCKER_COMPOSE --profile vault -f $COMPOSE_CORE -f $COMPOSE_DEV"

echo "Using environment file: $ENV_FILE"
echo ""

case "${1:-}" in
    --all)
        echo "Starting all infrastructure services (PostgreSQL, Redis, MinIO, Vault, Qdrant)..."
        $DOCKER_COMPOSE_ALL up -d
        echo ""
        echo "Services started:"
        $DOCKER_COMPOSE_ALL ps
        echo ""
        echo "Vault UI:  http://localhost:8200  (root token: \${VAULT_DEV_ROOT_TOKEN:-root})"
        echo "Note: to switch the app onto Vault, set SECRETS_PROVIDER=vault in your env"
        echo "      and follow the AppRole bootstrap in infrastructure/docker/README.md."
        ;;
    --stop)
        echo "Stopping all infrastructure services..."
        $DOCKER_COMPOSE_ALL down
        echo "Services stopped."
        ;;
    --logs)
        $DOCKER_COMPOSE_ALL logs -f
        ;;
    --status)
        $DOCKER_COMPOSE_ALL ps
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (none)     Start core services (PostgreSQL, Redis, MinIO)"
        echo "  --all      Start all services including Vault and Qdrant"
        echo "  --stop     Stop all services (including Vault and Qdrant)"
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
