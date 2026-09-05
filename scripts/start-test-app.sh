#!/bin/bash
# ============================================================================
# Start ONE app/service/worker against the TEST environment
# ============================================================================
# Replaces the former per-service start-test-{api,stt,text,nlp}.sh scripts,
# which each re-implemented a uvicorn command that scripts/dev-service.sh
# already owns. Launch logic now lives in exactly one place, so a dev-launcher
# fix can never silently skip the test launcher.
#
# USAGE:
#   ./scripts/start-test-app.sh <target> [--build] [--isolated]
#
# TARGETS:
#   api  admin  stt  text  nlp  guardrail  harness  tts  worker
#
# FLAGS:
#   --build     build the TS packages first (db:generate + core packages + modules)
#   --isolated  (api only, TASK-869) a SECOND gateway on ISOLATED_API_PORT with
#               throttling ON and TEXT_URL pointed at the e2e stub. Two e2e specs
#               need process-wide settings the shared gateway cannot have:
#               `auth-throttle-per-endpoint` needs RATE_LIMIT_ENABLED=true, which
#               would 429 the login helpers of the other ~1150 tests, and
#               `byo-llm-credentials` needs TEXT_URL aimed at a stub, which would
#               break every spec that needs real TEXT. Both are read at BOOT, so
#               they cannot be flipped per-spec — hence a second process.
#
# REQUIREMENTS:
#   - test infrastructure running   (pnpm infra:test:up)
#   - schema pushed + seeded        (pnpm test:db:reset)
#   - conda env 'arcaenv'           (Python targets only; pnpm setup:python)
#
# PORTS: the TEST env owns its own application ports (DEV + 100), so
# a dev stack may keep running alongside. Ports are read from .env.test; a bound
# port is still refused, since that means a second TEST instance.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/start-test-service.sh
source "$SCRIPT_DIR/start-test-service.sh"

TARGET="${1:-}"
shift || true

ISOLATED=false
for arg in "$@"; do
    [ "$arg" = "--isolated" ] && ISOLATED=true
done

PY_TARGETS=(stt text nlp guardrail harness tts worker)
TS_TARGETS=(api admin)

usage() {
    echo "Usage: $0 <${TS_TARGETS[*]} ${PY_TARGETS[*]}> [--build]" >&2
}

if [ -z "$TARGET" ]; then
    echo -e "${RED}No target given.${NC}" >&2
    usage
    exit 2
fi

is_python_target=false
known=false
for t in "${PY_TARGETS[@]}"; do
    if [ "$TARGET" = "$t" ]; then is_python_target=true; known=true; fi
done
for t in "${TS_TARGETS[@]}"; do
    if [ "$TARGET" = "$t" ]; then known=true; fi
done
if [ "$known" != "true" ]; then
    echo -e "${RED}Unknown target '$TARGET'.${NC}" >&2
    usage
    exit 2
fi

check_env_file
check_docker_containers
if $is_python_target; then
    check_conda_env "arcaenv"
fi
handle_build_flag "$@"

cd "$PROJECT_ROOT"
load_env_test

# ----------------------------------------------------------------------------
# Provision Vault BEFORE launching, exactly as scripts/test-run.sh
# does for the managed suites.
#
# WHY THIS IS NOT OPTIONAL. The test env runs SECRETS_PROVIDER=vault, so every
# `vault-kv` platform secret (HARNESS_SERVICE_TOKEN, API_KEY_PEPPER,
# JWT_SECRET_KEY, the storage credentials, …) is resolved by SecretsService from
# `<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>`, NOT from .env.test. The env
# file is only ever the SEED INPUT that ensure-test-vault-creds.sh pushes into
# that path.
#
# HISTORICAL NOTE: dev and test used to share ONE Vault
# (hope-vault) at ONE kv prefix, so a later `pnpm setup:dev` / refresh-vault-
# creds.sh would overwrite those keys with .env.dev's values and .env.test's
# differing values would go silently dead — which is what made
# .env.test's HARNESS_SERVICE_TOKEN look live while answering 401.
# Test now has its own isolated Vault (hope-vault-test,
# tests/docker-compose.test.yml) with its own kv-v2 store, so that specific
# cross-talk is now structurally impossible. The call below is still required
# though: hope-vault-test's kv store starts EMPTY (test-init.sh seeds no
# placeholders) and only gets populated by ensure-test-vault-creds.sh syncing
# FROM .env.test — every launch needs that to have happened at least once
# since the container last (re)started.
#
# Idempotent, and a no-op unless .env.test selects the Vault provider.
# ----------------------------------------------------------------------------
if ! "$SCRIPT_DIR/ensure-test-vault-creds.sh"; then
    echo -e "${RED}Failed to provision Vault credentials/secrets for the test env.${NC}" >&2
    echo "  Services run SECRETS_PROVIDER=vault and fail closed, so starting anyway would" >&2
    echo "  only surface later as 401s on seeded API keys and internal service hops." >&2
    exit 1
fi
# ensure-test-vault-creds.sh rewrites VAULT_ROLE_ID/VAULT_SECRET_ID in .env.test;
# re-read it so this process launches with the freshly minted credentials.
load_env_test

# ----------------------------------------------------------------------------
# Resolve the port this target will bind (worker binds none) and refuse to
# collide with an already-running process.
# ----------------------------------------------------------------------------
port_for() {
    case "$1" in
        api)       echo "${API_PORT:-8968}" ;;
        admin)     echo "${ADMIN_PORT:-5276}" ;;
        stt)       echo "${STT_PORT:-8961}" ;;
        text)      echo "${TEXT_PORT:-8962}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8963}" ;;
        nlp)       echo "${NLP_PORT:-8964}" ;;
        tts)       echo "${TTS_PORT:-8965}" ;;
        harness)   echo "${HARNESS_PORT:-8966}" ;;
        worker)    echo "" ;;
    esac
}

TARGET_PORT="$(port_for "$TARGET")"
if $ISOLATED; then
    if [ "$TARGET" != "api" ]; then
        echo -e "${RED}--isolated is only meaningful for the api target.${NC}" >&2
        exit 2
    fi
    TARGET_PORT="${ISOLATED_API_PORT:-8969}"
fi
if [ -n "$TARGET_PORT" ]; then
    check_port_available "$TARGET_PORT"
elif [ "$TARGET" = "worker" ]; then
    # Two workers on one Temporal task queue steal each other's tasks, which
    # surfaces as nondeterministic test failures rather than an error.
    if pgrep -f 'harness\.temporal\.worker' >/dev/null 2>&1; then
        echo -e "${RED}Error: a harness.temporal.worker process is already running.${NC}" >&2
        echo "Two workers would consume from the same task queue. Stop the other one first." >&2
        exit 1
    fi
fi

# ----------------------------------------------------------------------------
# STT only: drop streaming session state left behind by an earlier test run,
# BEFORE this instance boots.
#
# `SessionManager._recover_sessions` revives, at startup, every `stt:session:*`
# still marked `status: ACTIVE` — claiming a capacity slot and starting an
# ingestion consumer plus inference runtime for each. A spec that creates a
# streaming session without closing it therefore leaks an ACTIVE session that
# the NEXT run's STT resurrects and keeps running until the key's 24h TTL, and
# those zombies compete for ASR throughput with the run that is actually
# executing. Measured: from a clean Redis the suite was fully green and leaked
# 7 keys; the very next run failed `streaming-backpressure-recovery` with
# `transcriptsReceived: 0` after waiting 120s. Same code, opposite results.
#
# It MUST happen here rather than in the Playwright global setup: by the time
# globalSetup runs, this process has already booted and revived them, so
# deleting the keys then leaves the zombies running (observed).
#
# Test-env only, and scoped to the streaming keyspace — never touches app data.
# ----------------------------------------------------------------------------
if [ "$TARGET" = "stt" ]; then
    purged="$(docker exec hope-redis-test sh -c \
        'redis-cli -a "${REDIS_PASSWORD:-test_redis_pass}" --scan --pattern "stt:*" \
         | xargs -r redis-cli -a "${REDIS_PASSWORD:-test_redis_pass}" DEL' 2>/dev/null | tail -1 || true)"
    if [ -n "${purged:-}" ] && [ "${purged:-0}" != "0" ]; then
        echo "  cleared ${purged} leaked stt:* key(s) from the test Redis before boot"
    fi
fi

print_service_header "$TARGET (test env)" "${TARGET_PORT:+http://localhost:$TARGET_PORT}" \
    "$($is_python_target && echo "Conda env: arcaenv" || echo "")"

# ----------------------------------------------------------------------------
# Launch — dev-service.sh owns every Python launch command; TS apps go through
# their own package scripts. `dotenv -o` lets .env.test override the ambient
# environment so a stray dev value cannot leak into a test run.
# ----------------------------------------------------------------------------
case "$TARGET" in
    api)
        if $ISOLATED; then
            # `env` runs AFTER dotenv, so these three win over `.env.test` — the
            # only way to differ from the shared gateway, since `dotenv -o` is
            # what makes .env.test beat the ambient environment for every other
            # variable (and that behaviour is deliberate: a stray dev value must
            # never leak into a test run).
            exec npx dotenv -o -e .env.test -- env \
                "PORT=$TARGET_PORT" \
                "API_PORT=$TARGET_PORT" \
                "RATE_LIMIT_ENABLED=true" \
                "TEXT_URL=${E2E_TEXT_URL:-http://127.0.0.1:8992}" \
                pnpm --filter @arcaai/api dev
        fi
        exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/api dev
        ;;
    admin)
        exec npx dotenv -o -e .env.test -- pnpm --filter @arcaai/admin-console dev
        ;;
    *)
        exec npx dotenv -o -e .env.test -- "$SCRIPT_DIR/dev-service.sh" "$TARGET"
        ;;
esac
