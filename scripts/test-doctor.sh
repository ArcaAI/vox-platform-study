#!/bin/bash
# ============================================================================
# TEST-environment doctor (read-only)
# ============================================================================
# Test counterpart of scripts/dev-doctor.sh. Probes the ISOLATED test
# infrastructure (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335) and any
# HOPE services started against .env.test, then reports readiness.
#
# USAGE:
#   pnpm stack:test:doctor
#   ./scripts/test-doctor.sh --infra-only    # skip the app-service probes
#
# EXIT CODE: 1 if any REQUIRED check fails, 0 otherwise.
#   required = test infra (postgres/redis/minio/qdrant) + schema presence
#   optional = the app services (they are only up while a suite is running)
#
# PORTS: the TEST env is fully independent of DEV — application
#   ports are DEV + 100 (api 8968, stt 8961, text 8962, guardrail 8963,
#   nlp 8964, tts 8965, harness 8966, admin 5276), and the infra ports already
#   differed (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, Vault 8201 —
#   isolated Vault too). Both stacks can run side by side. Ports are
#   read from .env.test, never hardcoded.
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
INFRA_ONLY=false

for arg in "$@"; do
    [ "$arg" = "--" ] && continue
    case "$arg" in
        --infra-only) INFRA_ONLY=true ;;
        --help|-h) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo -e "${RED}Unknown argument '$arg'.${NC}" >&2; exit 2 ;;
    esac
done

pass() { printf "${GREEN}%-6s${NC} %-34s %s\n" "PASS" "$1" "${2:-}"; }
fail() { printf "${RED}%-6s${NC} %-34s %s\n" "FAIL" "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }
warn() { printf "${YELLOW}%-6s${NC} %-34s %s\n" "WARN" "$1" "${2:-}"; WARNINGS=$((WARNINGS + 1)); }

if [ ! -f "$REPO_ROOT/.env.test" ]; then
    echo -e "${RED}.env.test not found at $REPO_ROOT/.env.test — the test environment cannot work.${NC}" >&2
    exit 1
fi

# Read the ports the test env actually declares (defaults mirror .env.test).
env_val() { grep -E "^$1=" "$REPO_ROOT/.env.test" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

TEST_PG_PORT=5433
TEST_REDIS_PORT="$(env_val REDIS_PORT)"; TEST_REDIS_PORT="${TEST_REDIS_PORT:-6380}"
TEST_MINIO_PORT=9002
TEST_QDRANT_PORT=6335
TEST_VAULT_PORT=8201
T_API_PORT="$(env_val API_PORT)";  T_API_PORT="${T_API_PORT:-8968}"
T_STT_PORT="$(env_val STT_PORT)";  T_STT_PORT="${T_STT_PORT:-8961}"
T_TEXT_PORT="$(env_val TEXT_PORT)";  T_TEXT_PORT="${T_TEXT_PORT:-8962}"
T_NLP_PORT="$(env_val NLP_PORT)";  T_NLP_PORT="${T_NLP_PORT:-8964}"
T_GUARDRAIL_PORT="$(env_val GUARDRAIL_PORT)"; T_GUARDRAIL_PORT="${T_GUARDRAIL_PORT:-8963}"
T_HARNESS_PORT="$(env_val HARNESS_PORT)";     T_HARNESS_PORT="${T_HARNESS_PORT:-8966}"

docker_check() {
    local req="$1" name="$2" state
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)" || state="absent"
    if [ "$state" = "running" ]; then
        pass "docker:$name" "running"
    elif [ "$req" = "required" ]; then
        fail "docker:$name" "$state — start with 'pnpm infra:test:up'"
    else
        warn "docker:$name" "$state (optional)"
    fi
}

http_check() {
    local req="$1" label="$2" url="$3" hint="${4:-}" code
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "$url" 2>/dev/null)" || code="000"
    if [ "${code:0:1}" = "2" ] || [ "${code:0:1}" = "3" ]; then
        pass "$label" "$url → $code"
    elif [ "$req" = "required" ]; then
        fail "$label" "$url → $code${hint:+ — start with '$hint'}"
    else
        warn "$label" "$url → $code (not running)"
    fi
}

echo -e "${CYAN}━━ HOPE test doctor ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "${CYAN}── Test infrastructure containers ───────────────────────────────${NC}"
docker_check required hope-postgres-test
docker_check required hope-redis-test
docker_check required hope-minio-test
docker_check required hope-qdrant-test
docker_check required hope-vault-test

echo -e "${CYAN}── Test infrastructure health ───────────────────────────────────${NC}"
if docker exec hope-postgres-test pg_isready -U test -d hope_test >/dev/null 2>&1; then
    pass "postgres (test)" "localhost:$TEST_PG_PORT accepting connections"
else
    fail "postgres (test)" "localhost:$TEST_PG_PORT not ready — 'pnpm infra:test:up'"
fi

if docker exec hope-redis-test redis-cli -a test_redis_pass ping 2>/dev/null | grep -q PONG; then
    pass "redis (test)" "localhost:$TEST_REDIS_PORT PONG"
else
    fail "redis (test)" "localhost:$TEST_REDIS_PORT no PONG — 'pnpm infra:test:up'"
fi

if docker exec hope-minio-test curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1; then
    pass "minio (test)" "localhost:$TEST_MINIO_PORT healthy"
else
    fail "minio (test)" "localhost:$TEST_MINIO_PORT unhealthy — 'pnpm infra:test:up'"
fi

if docker exec hope-qdrant-test bash -c "echo > /dev/tcp/localhost/6333" 2>/dev/null; then
    pass "qdrant (test)" "localhost:$TEST_QDRANT_PORT reachable"
    init_status="$(docker inspect hope-qdrant-init-test --format='{{.State.ExitCode}}' 2>/dev/null)"
    if [ "$init_status" = "0" ]; then
        pass "qdrant collections" "initialized"
    else
        warn "qdrant collections" "init container exit=${init_status:-unknown}"
    fi
else
    fail "qdrant (test)" "localhost:$TEST_QDRANT_PORT unreachable — 'pnpm infra:test:up'"
fi

if docker exec hope-vault-test wget -q -O- http://127.0.0.1:8200/v1/sys/health 2>/dev/null | grep -q '"initialized":true'; then
    pass "vault (test)" "localhost:$TEST_VAULT_PORT initialized"
    vault_init_status="$(docker inspect hope-vault-init-test --format='{{.State.ExitCode}}' 2>/dev/null)"
    if [ "$vault_init_status" = "0" ]; then
        pass "vault approle/transit" "initialized"
    else
        warn "vault approle/transit" "init container exit=${vault_init_status:-unknown}"
    fi
else
    fail "vault (test)" "localhost:$TEST_VAULT_PORT unreachable — 'pnpm infra:test:up'"
fi

echo -e "${CYAN}── Test database schema ─────────────────────────────────────────${NC}"
# The suites fail confusingly ("relation does not exist") when the schema was
# never pushed. Probe one core table rather than trusting the container alone.
table_count="$(docker exec hope-postgres-test psql -U test -d hope_test -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='core'" 2>/dev/null | tr -d '[:space:]')"
if [ -n "$table_count" ] && [ "$table_count" -gt 0 ] 2>/dev/null; then
    pass "schema pushed" "$table_count table(s) in schema 'core'"
    tenant_rows="$(docker exec hope-postgres-test psql -U test -d hope_test -tAc \
        'SELECT count(*) FROM core."Tenant"' 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$tenant_rows" ] && [ "$tenant_rows" -gt 0 ] 2>/dev/null; then
        pass "seed data" "$tenant_rows tenant row(s)"
    else
        warn "seed data" "no tenant rows — run 'pnpm test:db:seed'"
    fi
else
    fail "schema pushed" "schema 'core' is empty — run 'pnpm test:db:reset'"
fi

if $INFRA_ONLY; then
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if [ "$FAILURES" -gt 0 ]; then
        echo -e "${RED}$FAILURES required check(s) failed${NC}, $WARNINGS warning(s)."
        exit 1
    fi
    echo -e "${GREEN}Test infrastructure ready${NC} ($WARNINGS warning(s))."
    exit 0
fi

echo -e "${CYAN}── HOPE services on the test env ────────────────────────────────${NC}"
# These are OPTIONAL: they only run while a suite (or `pnpm stack:test`) is up.
http_check optional "api ($T_API_PORT)"       "http://localhost:$T_API_PORT/api/v1/health" "pnpm test:up:api"
http_check optional "stt ($T_STT_PORT)"       "http://localhost:$T_STT_PORT/api/v1/health" "pnpm test:up:stt"
http_check optional "text ($T_TEXT_PORT)"      "http://localhost:$T_TEXT_PORT/api/v1/health" "pnpm test:up:text"
http_check optional "nlp ($T_NLP_PORT)"       "http://localhost:$T_NLP_PORT/api/v1/health" "pnpm test:up:nlp"
http_check optional "guardrail ($T_GUARDRAIL_PORT)" "http://localhost:$T_GUARDRAIL_PORT/api/health"
http_check optional "harness ($T_HARNESS_PORT)"     "http://localhost:$T_HARNESS_PORT/api/v1/health"

echo -e "${CYAN}── Dev/test isolation ───────────────────────────────────────────${NC}"
# The two environments use disjoint ports, so both may run at
# once. What still matters is that .env.test has not drifted back onto a dev
# port — that would silently point a suite at the dev stack.
collisions=""
for pair in "API_PORT:8868" "STT_PORT:8861" "TEXT_PORT:8862" "GUARDRAIL_PORT:8863" \
            "NLP_PORT:8864" "TTS_PORT:8865" "HARNESS_PORT:8866" "ADMIN_PORT:5176"; do
    var="${pair%%:*}"; devport="${pair##*:}"
    testport="$(env_val "$var")"
    if [ -n "$testport" ] && [ "$testport" = "$devport" ]; then
        collisions="$collisions $var=$testport"
    fi
done
if [ -n "$collisions" ]; then
    fail "test ports distinct from dev" "collides on:$collisions — a suite could hit the DEV stack"
else
    pass "test ports distinct from dev" "test = dev + 100; both stacks can run together"
fi

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$FAILURES" -gt 0 ]; then
    echo -e "${RED}$FAILURES required check(s) failed${NC}, $WARNINGS warning(s)."
    echo "Bootstrap the test environment with: pnpm setup:test"
    exit 1
fi
echo -e "${GREEN}All required checks passed${NC} ($WARNINGS warning(s))."
