#!/bin/bash
# ============================================================================
# Local dev-stack doctor (read-only)
# ============================================================================
# Answers "why is X broken?" in one shot: probes every service port/health
# endpoint, docker infra containers, LM Studio / Ollama, Temporal, the two
# portless worker processes (harness Temporal worker, STT Dramatiq batch
# worker), and runs the STT API-key preflight (placeholder detection — never
# prints the key).
#
# USAGE:
#   pnpm stack:dev:doctor
#
# EXIT CODE: 1 if any REQUIRED check fails (required = clinical-workspace
# services + postgres/redis/temporal/LM Studio), 0 otherwise. Optional
# components (guardrail, ollama, vault, qdrant, minio, temporal-ui,
# reranker) only WARN.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

FAILURES=0
WARNINGS=0

pass() { printf "${GREEN}%-6s${NC} %-34s %s\n" "PASS" "$1" "${2:-}"; }
fail() { printf "${RED}%-6s${NC} %-34s %s\n" "FAIL" "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }
warn() { printf "${YELLOW}%-6s${NC} %-34s %s\n" "WARN" "$1" "${2:-}"; WARNINGS=$((WARNINGS + 1)); }

# http_check <required|optional> <label> <url> [restart-hint]
# restart-hint: printed only on a REQUIRED failure, so a not-listening dev
# service names its own start command instead of leaving a bare → 000 (BUG-009).
http_check() {
    local req="$1" label="$2" url="$3" hint="${4:-}" code
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$url" 2>/dev/null)" || code="000"
    if [ "${code:0:1}" = "2" ] || [ "${code:0:1}" = "3" ]; then
        pass "$label" "$url → $code"
    elif [ "$req" = "required" ]; then
        fail "$label" "$url → $code${hint:+ — start with '$hint'}"
    else
        warn "$label" "$url → $code (optional)"
    fi
}

# tcp_check <required|optional> <label> <host> <port>
tcp_check() {
    local req="$1" label="$2" host="$3" port="$4"
    if nc -z -w 2 "$host" "$port" >/dev/null 2>&1; then
        pass "$label" "$host:$port reachable"
    elif [ "$req" = "required" ]; then
        fail "$label" "$host:$port unreachable"
    else
        warn "$label" "$host:$port unreachable (optional)"
    fi
}

# docker_check <required|optional> <container-name>
docker_check() {
    local req="$1" name="$2" state
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)" || state="absent"
    if [ "$state" = "running" ]; then
        pass "docker:$name" "running"
    elif [ "$req" = "required" ]; then
        fail "docker:$name" "$state"
    else
        warn "docker:$name" "$state (optional)"
    fi
}

echo -e "${CYAN}━━ HOPE dev doctor ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "${CYAN}── Docker infrastructure ────────────────────────────────────────${NC}"
docker_check required hope-postgres
docker_check required hope-redis
docker_check required hope-temporal
docker_check optional hope-temporal-ui
docker_check optional hope-vault
docker_check optional hope-qdrant
docker_check optional hope-minio
docker_check optional hope-reranker

echo -e "${CYAN}── Infrastructure endpoints ─────────────────────────────────────${NC}"
tcp_check required "postgres" localhost "${POSTGRES_PORT:-5432}"
tcp_check required "redis" localhost "${REDIS_PORT:-6379}"
tcp_check required "temporal (gRPC)" localhost "${TEMPORAL_PORT:-7233}"
http_check optional "temporal-ui" "http://localhost:${TEMPORAL_UI_PORT:-8233}/"
http_check optional "vault" "http://localhost:8200/v1/sys/health"
http_check optional "qdrant" "http://localhost:6333/healthz"
http_check optional "minio" "http://localhost:9000/minio/health/live"
http_check optional "reranker" "http://localhost:8870/health"

echo -e "${CYAN}── LLM engines ──────────────────────────────────────────────────${NC}"
http_check required "lm-studio" "http://localhost:1234/v1/models"
http_check optional "ollama" "http://localhost:11434/"

echo -e "${CYAN}── HOPE services ────────────────────────────────────────────────${NC}"
http_check required "api (8868)" "http://localhost:${API_PORT:-8868}/api/v1/health" "pnpm api:dev"
http_check required "stt (8861)" "http://localhost:${STT_PORT:-8861}/api/v1/health" "pnpm stt:dev"
http_check required "text (8862)" "http://localhost:${TEXT_PORT:-8862}/api/v1/health" "pnpm text:dev"
http_check required "nlp (8864)" "http://localhost:${NLP_PORT:-8864}/api/v1/health" "pnpm nlp:dev"
http_check required "harness (8866)" "http://localhost:${HARNESS_PORT:-8866}/api/v1/health" "pnpm harness:dev"
# guardrail mounts its routers under /api (no version segment), unlike the rest
http_check optional "guardrail (8863)" "http://localhost:${GUARDRAIL_PORT:-8863}/api/health"

# text must not just be up — it must have at least one LLM provider registered
# (the silent live-summary killer: text up, zero providers, every generate 404s).
# /api/v1/providers sits behind the X-Service-Token middleware (only /health is
# exempt), so resolve the same token the service reads (host env > .env.dev)
# before probing it — otherwise every call 401s and reads as "zero providers".
# text accepts the ONE shared INTERNAL_ACCESS_TOKEN and nothing else (owner
# decision D-D); the per-service TEXT_SERVICE_TOKEN this probed until TASK-888
# had already stopped authenticating anything, so the check always read
# "zero providers" on a box that set only the shared token.
text_token="${INTERNAL_ACCESS_TOKEN:-}"
if [ -z "$text_token" ] && [ -f .env.dev ]; then
    text_token="$(grep -m1 '^INTERNAL_ACCESS_TOKEN=' .env.dev | cut -d= -f2-)"
fi
providers="$(curl -s --connect-timeout 2 --max-time 5 -H "X-Service-Token: ${text_token}" "http://localhost:${TEXT_PORT:-8862}/api/v1/providers" 2>/dev/null)" || providers=""
if printf '%s' "$providers" | grep -q '"name"'; then
    # top-level provider entries are the ones carrying a display_name
    pass "text providers registered" "$(printf '%s' "$providers" | grep -oE '"name":"[^"]*","display_name"' | cut -d'"' -f4 | sort -u | tr '\n' ' ')"
elif printf '%s' "$providers" | grep -q 'service token'; then
    fail "text providers registered" "INTERNAL_ACCESS_TOKEN mismatch — doctor's .env.dev value doesn't match the running text process's"
else
    fail "text providers registered" "none — start text via 'pnpm text:dev' (registers the LM Studio provider)"
fi

# Harness Temporal worker — no port; it is a worker process polling the task
# queue. conda-run wrapper + python child may both match; >0 means alive.
worker_count="$(pgrep -f 'harness\.temporal\.worker' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${worker_count:-0}" -gt 0 ]; then
    pass "harness worker process" "$worker_count matching process(es)"
else
    fail "harness worker process" "not running — start with 'pnpm worker:dev'"
fi

# STT Dramatiq batch worker — also portless. Nothing else reports its absence:
# with no consumer on `dramatiq:stt_batch` the gateway still accepts uploads and
# every health endpoint stays green while jobs sit QUEUED forever (BUG-011).
stt_worker_count="$(pgrep -f 'dramatiq stt\.worker' 2>/dev/null | wc -l | tr -d ' ')"
if [ "${stt_worker_count:-0}" -gt 0 ]; then
    pass "stt batch worker process" "$stt_worker_count matching process(es)"
else
    fail "stt batch worker process" "not running — start with 'pnpm stt:worker:dev' (batch jobs would stay QUEUED)"
fi

echo -e "${CYAN}── Preflight ────────────────────────────────────────────────────${NC}"
if out="$("$SCRIPT_DIR/dev-service.sh" --check-stt-key 2>&1)"; then
    pass "stt API_GATEWAY_KEY" "$(printf '%s' "$out" | head -n1 | sed 's/\x1b\[[0-9;]*m//g')"
else
    fail "stt API_GATEWAY_KEY" "placeholder/missing — see: ./scripts/dev-service.sh --check-stt-key"
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$FAILURES" -gt 0 ]; then
    echo -e "${RED}$FAILURES required check(s) failed${NC}, $WARNINGS optional warning(s)."
    exit 1
fi
echo -e "${GREEN}All required checks passed${NC} ($WARNINGS optional warning(s))."
