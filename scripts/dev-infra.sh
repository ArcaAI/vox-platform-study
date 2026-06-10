#!/bin/bash
# ============================================================================
# TASK-346 — Docker infra wrapper (core + vault + temporal profiles)
# ============================================================================
# The clinical-workspace stack needs Temporal, but the pre-existing
# `docker:dev:up:all` (scripts/start-infra.sh --all) only activates the
# `vault` profile. This wrapper brings up/down the full dev infra in one
# command: postgres, redis, minio, qdrant, vault (+init) AND the Temporal
# stack (temporal-postgresql, temporal, temporal-ui).
#
# USAGE:
#   pnpm infra:up              # up -d with vault+temporal profiles
#   pnpm infra:up -- --rag     # additionally start the hope-reranker (rag profile)
#   pnpm infra:down            # down (same profile set, so nothing lingers)
#   pnpm infra:status          # compose ps
#   pnpm infra:logs            # compose logs -f
#   ./scripts/dev-infra.sh up --print   # print the compose command only
#
# The pre-existing docker:dev:* scripts are untouched and keep working.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_CORE="infrastructure/docker/docker-compose.yml"
COMPOSE_DEV="infrastructure/docker/docker-compose.dev.yml"
ENV_FILE="$REPO_ROOT/.env"

# Same convention as scripts/start-infra.sh: docker compose loads the root .env.
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$REPO_ROOT/.env.example" ]; then
        echo "No .env found — creating from .env.example (update values as needed)."
        cp "$REPO_ROOT/.env.example" "$ENV_FILE"
    else
        echo "Error: $ENV_FILE not found and no .env.example to copy." >&2
        exit 1
    fi
fi

ACTION="${1:-}"
shift || true

PROFILES=(--profile vault --profile temporal)
PRINT=0
for arg in "$@"; do
    case "$arg" in
        --rag) PROFILES+=(--profile rag) ;;
        --print) PRINT=1 ;;
        *) echo "Unknown flag: $arg (known: --rag, --print)" >&2; exit 2 ;;
    esac
done

COMPOSE=(docker compose --env-file "$ENV_FILE" "${PROFILES[@]}" -f "$COMPOSE_CORE" -f "$COMPOSE_DEV")

run() {
    if [ "$PRINT" = "1" ]; then
        echo "${COMPOSE[*]} $*"
        return 0
    fi
    "${COMPOSE[@]}" "$@"
}

case "$ACTION" in
    up)
        run up -d
        if [ "$PRINT" != "1" ]; then
            echo ""
            run ps
            echo ""
            echo "Temporal UI: http://localhost:\${TEMPORAL_UI_PORT:-8233}   gRPC: localhost:\${TEMPORAL_PORT:-7233}"
            echo "Vault UI:    http://localhost:8200"
        fi
        ;;
    down)
        run down
        ;;
    status)
        run ps
        ;;
    logs)
        run logs -f
        ;;
    *)
        echo "Usage: $0 <up|down|status|logs> [--rag] [--print]" >&2
        exit 2
        ;;
esac
