#!/bin/bash
# ============================================================================
# DEV app-stack supervisor
# ============================================================================
# Starts the full local clinical-workspace stack in one command:
#   api (8868), stt (8861), stt-worker (Dramatiq batch queue), text (8862),
#   guardrail (8863), nlp (8864), harness (8866),
#   worker (Temporal task queue), admin (5176)
# Guardrail is part of the default stack (the admin console monitors it);
# start a subset to leave it out.
#
# USAGE:
#   pnpm stack:dev                     # ensure base Docker infra, then full app stack
#   pnpm stack:dev:observability       # base + Prometheus/Grafana, then apps
#   pnpm stack:dev:inference           # base + inference engines, then apps
#   pnpm stack:dev -- text worker      # subset
#   pnpm stack:dev -- -o text          # observability tier + subset
#   pnpm stack:dev:down                # stop services spawned by this script
#   DRY_RUN=1 pnpm stack:dev           # print the plan, start nothing
#
# BEHAVIOUR:
#   - Loads the LM Studio text model with a 16k context when the `lms` CLI is
#     present (LM_STUDIO_MODEL / LM_STUDIO_CONTEXT_LENGTH / LM_STUDIO_PARALLEL /
#     LM_STUDIO_TTL_S; same contract as the cluster's LMS_* env). Skipped when
#     LM Studio is not installed or not running.
#   - Ensures Docker infra is up first via `dev-infra.sh up` (idempotent):
#     core + vault + temporal + rag; optional -o/--observability, -e/--inference.
#   - REFUSES to start if any requested port is already bound (protects an
#     already-running stack; run `pnpm stack:dev:doctor` to see what is up).
#     The test stack uses its own ports (dev + 100), so a test
#     stack may run alongside this one.
#   - REFUSES to start a second harness worker (it would consume from the
#     same Temporal task queue). There is deliberately NO such guard for
#     stt-worker: several Dramatiq consumers on `dramatiq:stt_batch` are
#     legitimate (that is how the queue scales). If you already started one by
#     hand, start a subset without it (BUG-011).
#   - All logs are tailed in the foreground. Ctrl-C stops every spawned
#     service (whole process trees, conda wrappers included).
#   - `down` stops ONLY pids recorded in this stack's pidfiles.
#     Docker infra is left running (use `pnpm infra:dev:down` to tear it down).
#
# The supervisor itself (state dirs, pidfiles, kill trees, log tailing) lives in
# scripts/lib/stack-supervisor.sh and is shared with scripts/test-stack.sh.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

DEFAULT_SERVICES=(api stt stt-worker text guardrail nlp harness worker admin)
ALL_SERVICES=(api stt stt-worker text nlp harness worker admin guardrail tts)

port_for() {
    case "$1" in
        api) echo "${API_PORT:-8868}" ;;
        stt) echo "${STT_PORT:-8861}" ;;
        stt-worker) echo "" ;;
        text) echo "${TEXT_PORT:-8862}" ;;
        nlp) echo "${NLP_PORT:-8864}" ;;
        harness) echo "${HARNESS_PORT:-8866}" ;;
        admin) echo "${ADMIN_PORT:-5176}" ;;
        guardrail) echo "${GUARDRAIL_PORT:-8863}" ;;
        tts) echo "${TTS_PORT:-8865}" ;;
        worker) echo "" ;;
    esac
}

# Sets the global CMD array for a service (no word-splitting involved).
CMD=()
set_command_for() {
    case "$1" in
        api) CMD=(pnpm api:dev) ;;
        admin) CMD=(pnpm admin:dev) ;;
        *) CMD=("$SCRIPT_DIR/dev-service.sh" "$1") ;;
    esac
}

STACK_NAME="dev"
# shellcheck source=scripts/lib/stack-supervisor.sh
source "$SCRIPT_DIR/lib/stack-supervisor.sh"

# ----------------------------------------------------------------------------
# Resolve requested services / subcommand / infra tier flags
# ----------------------------------------------------------------------------
ARGS=()
INFRA_FLAGS=()
for arg in "$@"; do
    # pnpm forwards the literal `--` separator (pnpm stack:dev -- text)
    [ "$arg" = "--" ] && continue
    case "$arg" in
        -o|--observability) INFRA_FLAGS+=(--observability); continue ;;
        -e|--inference) INFRA_FLAGS+=(--inference); continue ;;
    esac
    ARGS+=("$arg")
done

if [ "${#ARGS[@]}" -gt 0 ] && [ "${ARGS[0]}" = "down" ]; then
    if [ "${#ARGS[@]}" -gt 1 ]; then
        echo -e "${RED}stack:dev down takes no further arguments.${NC}" >&2
        exit 2
    fi
    supervisor_down
    exit 0
fi

SERVICES=()
if [ "${#ARGS[@]}" -eq 0 ]; then
    SERVICES=("${DEFAULT_SERVICES[@]}")
else
    for arg in "${ARGS[@]}"; do
        ok=0
        for s in "${ALL_SERVICES[@]}"; do
            [ "$arg" = "$s" ] && ok=1
        done
        if [ "$ok" != "1" ]; then
            echo -e "${RED}Unknown service '$arg'.${NC} Known: ${ALL_SERVICES[*]} (or 'down')" >&2
            echo "Infra tier flags: -o/--observability, -e/--inference" >&2
            exit 2
        fi
        SERVICES+=("$arg")
    done
fi

# ----------------------------------------------------------------------------
# Dry run — print the plan (starts nothing, so no refusal logic)
# ----------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "stack:dev plan (DRY_RUN=1 — nothing started):"
    echo "  infra: ./scripts/dev-infra.sh up ${INFRA_FLAGS[*]+${INFRA_FLAGS[*]}}"
    echo "  lmstudio: load ${LM_STUDIO_MODEL:-gemma-4-e2b-it-qat} --context-length ${LM_STUDIO_CONTEXT_LENGTH:-16384} --parallel ${LM_STUDIO_PARALLEL:-4} --ttl ${LM_STUDIO_TTL_S:-3600} (if lms is available)"
    for svc in "${SERVICES[@]}"; do
        port="$(port_for "$svc")"
        set_command_for "$svc"
        printf '  %-10s %-6s %s\n' "$svc" "${port:-—}" "${CMD[*]}"
    done
    echo "logs would go to: $LOG_DIR/<service>.log"
    echo "pidfiles would go to: $PID_DIR/<service>.pid"
    exit 0
fi

# ----------------------------------------------------------------------------
# Ensure Docker infra is up (idempotent)
# ----------------------------------------------------------------------------
echo -e "${CYAN}Ensuring Docker infra...${NC}"
"$SCRIPT_DIR/dev-infra.sh" up "${INFRA_FLAGS[@]+"${INFRA_FLAGS[@]}"}"

# ----------------------------------------------------------------------------
# LM Studio: make sure the text model is LOADED with the context the ArcaAI
# prompts need. Mirrors the cluster contract in hope-v2-deployment
# base/lmstudio.yaml (LMS_LOAD / LMS_CONTEXT=16384 / LMS_PARALLEL=4 /
# LMS_IDENTIFIER = the model key the catalogue sends on the wire). A JIT load
# uses LM Studio's per-model default (8192 here), and the ArcaAI live-summary
# prompt alone is ~8.7k tokens, so every flush then fails with
# `exceed_context_size_error` and the run ends CLOSED_INCOMPLETE (BUG-019 A).
# Skipped quietly when the `lms` CLI or the LM Studio server is not around.
# ----------------------------------------------------------------------------
: "${LM_STUDIO_MODEL:=gemma-4-e2b-it-qat}"
: "${LM_STUDIO_CONTEXT_LENGTH:=16384}"
: "${LM_STUDIO_PARALLEL:=4}"
: "${LM_STUDIO_TTL_S:=3600}"
ensure_lmstudio_model() {
    local lms="${LMS_BIN:-$HOME/.lmstudio/bin/lms}"
    if [ ! -x "$lms" ]; then lms="$(command -v lms 2>/dev/null || true)"; fi
    if [ -z "$lms" ]; then
        echo -e "${YELLOW}LM Studio: 'lms' CLI not found — skipping model preload (JIT load will use LM Studio's default context)${NC}"
        return 0
    fi
    local loaded
    if ! loaded="$("$lms" ps --json 2>/dev/null)"; then
        echo -e "${YELLOW}LM Studio: server not reachable — skipping model preload${NC}"
        return 0
    fi
    # `lms ps --json` is a list of loaded models; find ours and its context length.
    local current
    current="$(printf '%s' "$loaded" | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            let list = []; try { list = JSON.parse(s || "[]"); } catch {}
            const want = process.argv[1];
            const hit = (Array.isArray(list) ? list : []).find(m =>
                [m.identifier, m.modelKey, m.path, m.model].some(v => typeof v === "string" && (v === want || v.endsWith("/" + want))));
            if (!hit) { process.stdout.write("absent"); return; }
            // The LOADED context, not `maxContextLength` (what the weights could take).
            const loadedCtx = typeof hit.contextLength === "number" ? hit.contextLength : 0;
            process.stdout.write(String(loadedCtx));
        });' "$LM_STUDIO_MODEL")"
    if [ "$current" != "absent" ] && [ "${current:-0}" -ge "$LM_STUDIO_CONTEXT_LENGTH" ] 2>/dev/null; then
        echo -e "${GREEN}LM Studio: ${LM_STUDIO_MODEL} already loaded with a ${current}-token context${NC}"
        return 0
    fi
    if [ "$current" != "absent" ]; then
        echo -e "${CYAN}LM Studio: ${LM_STUDIO_MODEL} is loaded with a ${current}-token context; reloading at ${LM_STUDIO_CONTEXT_LENGTH}${NC}"
        "$lms" unload "$LM_STUDIO_MODEL" >/dev/null 2>&1 || true
    fi
    echo -e "${CYAN}LM Studio: loading ${LM_STUDIO_MODEL} (context ${LM_STUDIO_CONTEXT_LENGTH}, parallel ${LM_STUDIO_PARALLEL}, ttl ${LM_STUDIO_TTL_S}s)...${NC}"
    if ! "$lms" load "$LM_STUDIO_MODEL" --context-length "$LM_STUDIO_CONTEXT_LENGTH" --parallel "$LM_STUDIO_PARALLEL" --ttl "$LM_STUDIO_TTL_S" --identifier "$LM_STUDIO_MODEL" -y >/dev/null 2>&1; then
        echo -e "${YELLOW}LM Studio: load failed — continuing; generations will JIT-load with the default context${NC}"
    fi
}
ensure_lmstudio_model

# ----------------------------------------------------------------------------
# Preflight: ports free, no second worker, STT key usable
# ----------------------------------------------------------------------------
supervisor_preflight "${SERVICES[@]}"

for svc in "${SERVICES[@]}"; do
    if [ "$svc" = "stt" ]; then
        "$SCRIPT_DIR/dev-service.sh" --check-stt-key
    fi
done

supervisor_run "${SERVICES[@]}"
