#!/bin/bash
# ============================================================================
# TASK-346 / TASK-555 — Docker infra wrapper (profile tiers)
# ============================================================================
# Brings up/down the full local-dev Docker stack in one command.
#
# Default tier (core + vault + temporal + rag):
#   postgres, redis, minio, qdrant, vault (+init), temporal (+ui), hope-reranker
#
# USAGE:
#   pnpm infra:up                    # base tier (vault+temporal+rag)
#   pnpm infra:up -- -o              # base + Prometheus/Grafana
#   pnpm infra:up -- -e              # base + inference (vLLM, llama.cpp, TEI embed)
#   pnpm infra:up -- -o -e           # combine flags
#   pnpm infra:down                  # tear down ALL known profiles (nothing lingers)
#   pnpm infra:status                # compose ps (all profiles)
#   pnpm infra:logs                  # compose logs -f
#   ./scripts/dev-infra.sh up --print
#
# Flags:
#   -o / --observability   add prometheus profile
#   -e / --inference       add inference profile
#   --rag                  no-op (rag is default since TASK-555; kept for compat)
#   --print                print the compose command only
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

# Apple Silicon: TEI default images are x86_64-only. Prefer the published arm64
# tag when unset. HF docs advertise cpu-arm64-1.9, but GHCR currently publishes
# cpu-arm64-latest (linux/arm64) — override via HOPE_RERANKER_IMAGE /
# HOPE_TEI_EMBED_IMAGE when a pinned arm64 tag appears.
arch="$(uname -m)"
case "$arch" in
    arm64|aarch64)
        if [ -z "${HOPE_RERANKER_IMAGE:-}" ]; then
            export HOPE_RERANKER_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest
        fi
        if [ -z "${HOPE_TEI_EMBED_IMAGE:-}" ]; then
            export HOPE_TEI_EMBED_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-latest
        fi
        ;;
esac

ACTION="${1:-}"
shift || true

WANT_OBS=0
WANT_INF=0
PRINT=0
for arg in "$@"; do
    # pnpm may forward a literal `--` separator (pnpm infra:up -- -o)
    [ "$arg" = "--" ] && continue
    case "$arg" in
        --rag) ;; # no-op: rag is default (TASK-555)
        -o|--observability) WANT_OBS=1 ;;
        -e|--inference) WANT_INF=1 ;;
        --print) PRINT=1 ;;
        *)
            echo "Unknown flag: $arg (known: -o/--observability, -e/--inference, --rag, --print)" >&2
            exit 2
            ;;
    esac
done

# Base tier for `up`. down/status/logs always use the full known set.
UP_PROFILES=(--profile vault --profile temporal --profile rag)
if [ "$WANT_OBS" = "1" ]; then
    UP_PROFILES+=(--profile prometheus)
fi
if [ "$WANT_INF" = "1" ]; then
    UP_PROFILES+=(--profile inference)
fi

# Include both prometheus and observability aliases so neither path leaves
# Grafana/Prometheus behind. inference covers vllm/llama-cpp/tei-embed.
ALL_PROFILES=(
    --profile vault
    --profile temporal
    --profile rag
    --profile prometheus
    --profile observability
    --profile inference
)

warn_inference_preflight() {
    echo ""
    echo "NOTE: inference profile requested."
    echo "  - hope-vllm requires an NVIDIA GPU + NVIDIA Container Toolkit."
    echo "  - llama.cpp needs a pre-staged GGUF under LLAMA_CPP_MODELS_DIR (see docs/operations/inference/README.md)."
    echo "  - TEI embed serves BAAI/bge-m3 on :8871 (CPU arm64 image auto-selected on Apple Silicon)."
    if ! docker info 2>/dev/null | grep -qiE 'Runtimes:.*nvidia|nvidia'; then
        echo "WARNING: NVIDIA container runtime not detected — hope-vllm will likely fail to start."
        echo "  llama-cpp + tei-embed may still come up on CPU."
    fi
    echo ""
}

print_cmd() {
    local mode="$1"
    shift
    if [ "$mode" = "up" ]; then
        echo "docker compose --env-file $ENV_FILE ${UP_PROFILES[*]} -f $COMPOSE_CORE -f $COMPOSE_DEV $*"
    else
        echo "docker compose --env-file $ENV_FILE ${ALL_PROFILES[*]} -f $COMPOSE_CORE -f $COMPOSE_DEV $*"
    fi
}

case "$ACTION" in
    up)
        if [ "$PRINT" = "1" ]; then
            print_cmd up up -d
            exit 0
        fi
        if [ "$WANT_INF" = "1" ]; then
            warn_inference_preflight
        fi
        docker compose --env-file "$ENV_FILE" "${UP_PROFILES[@]}" -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" up -d
        echo ""
        docker compose --env-file "$ENV_FILE" "${ALL_PROFILES[@]}" -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" ps
        echo ""
        echo "Temporal UI:  http://localhost:${TEMPORAL_UI_PORT:-8233}   gRPC: localhost:${TEMPORAL_PORT:-7233}"
        echo "Vault UI:     http://localhost:8200"
        echo "Reranker:     http://localhost:${HOPE_RERANKER_PORT:-8870}"
        if [ "$WANT_OBS" = "1" ]; then
            echo "Prometheus:   http://localhost:${PROMETHEUS_PORT:-9090}"
            echo "Grafana:      http://localhost:${GRAFANA_PORT:-3001}  (admin/admin; anonymous Viewer)"
        fi
        if [ "$WANT_INF" = "1" ]; then
            echo "vLLM:         http://localhost:${SMR_V2_VLLM_PORT:-8000}"
            echo "llama.cpp:    http://localhost:${SMR_V2_LLAMA_CPP_PORT:-8080}"
            echo "TEI embed:    http://localhost:${HOPE_TEI_EMBED_PORT:-8871}"
        fi
        ;;
    down)
        # Tear down EVERY declared local-dev service.
        # Two compose project names exist:
        #   hope-infra-dev — combined core+dev files (pnpm infra:up / dev:setup / dev:stack)
        #   hope-infra     — core file alone (pnpm docker:dev:up / start-infra.sh without --all)
        # Both must be stopped or containers linger under the other project.
        if [ "$PRINT" = "1" ]; then
            echo "docker compose --env-file $ENV_FILE ${ALL_PROFILES[*]} -f $COMPOSE_CORE -f $COMPOSE_DEV down --remove-orphans"
            echo "docker compose --env-file $ENV_FILE -f $COMPOSE_CORE down --remove-orphans"
            exit 0
        fi
        echo "Stopping hope-infra-dev (core + all profiles)..."
        docker compose --env-file "$ENV_FILE" "${ALL_PROFILES[@]}" \
            -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" down --remove-orphans
        echo "Stopping hope-infra (core-only project, if any)..."
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_CORE" down --remove-orphans
        leftover="$(
            docker ps -a --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null \
                | awk -F'\t' '$2 == "hope-infra" || $2 == "hope-infra-dev" { print $1 }' || true
        )"
        if [ -n "$leftover" ]; then
            echo "WARNING: containers still present in hope-infra / hope-infra-dev:" >&2
            echo "$leftover" | sed 's/^/  /' >&2
            echo "Remove manually if orphaned: docker rm -f <name>" >&2
            exit 1
        fi
        echo "All local-dev infra containers stopped (volumes kept)."
        ;;
    status)
        if [ "$PRINT" = "1" ]; then
            print_cmd all ps
            exit 0
        fi
        docker compose --env-file "$ENV_FILE" "${ALL_PROFILES[@]}" -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" ps
        ;;
    logs)
        if [ "$PRINT" = "1" ]; then
            print_cmd all logs -f
            exit 0
        fi
        docker compose --env-file "$ENV_FILE" "${ALL_PROFILES[@]}" -f "$COMPOSE_CORE" -f "$COMPOSE_DEV" logs -f
        ;;
    *)
        echo "Usage: $0 <up|down|status|logs> [-o|--observability] [-e|--inference] [--rag] [--print]" >&2
        exit 2
        ;;
esac
