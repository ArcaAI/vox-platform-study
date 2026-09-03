#!/usr/bin/env bash
# TASK-824 — hope-llama-cpp entrypoint.
#
# Contrast with the llmster entrypoint this replaces (ticket §4.7): that script
# existed because `lms daemon up` FORKS AND EXITS with no --foreground flag, so
# a wrapper had to start a daemon, poll a control socket, start an HTTP server,
# preload a model, and then block on `lms log stream` purely to hold PID 1.
#
# `llama-server` is a normal foreground process that binds and serves. So this
# script does NOT wrap a lifecycle. It does exactly one thing the engine will
# not do for us: ASSERT, at boot, that what we asked for is what we got — and
# then `exec`s, so llama-server is PID 1 and receives SIGTERM directly.
#
# Everything below is a boot ASSERTION, not orchestration. Each one exists
# because its failure mode is SILENT.
set -euo pipefail

PORT="${LLAMA_ARG_PORT:-8080}"
HOST="${LLAMA_ARG_HOST:-0.0.0.0}"

log() { printf '%s hope-entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# ---------------------------------------------------------------------------
# A-1. The weights must actually be there.
# ---------------------------------------------------------------------------
# The sync Job writes /models/.ready ONLY after every sha256 in the manifest has
# been verified (see model-sync.yaml). Starting before that sentinel exists means
# serving from a half-synced volume. §3.2's sharded-GGUF hazard is the sharp
# version of this: "a partial sync that lands shard 2 first is a silent failure".
#
# k8s ALSO gates this with an initContainer, deliberately. Two checks, because
# this one is cheap and the failure is unrecoverable-by-retry.
if [ "${HOPE_REQUIRE_READY_SENTINEL:-1}" = "1" ]; then
  if [ ! -f /models/.ready ]; then
    log "FATAL: /models/.ready is absent — the model volume has not been verified."
    log "       The sync Job writes it only after every sha256 matches the manifest."
    log "       Refusing to serve from a possibly-partial volume."
    exit 78   # EX_CONFIG
  fi
  log "ok: /models/.ready present"
fi

# ---------------------------------------------------------------------------
# A-2. In single-model mode: the projector must be passed EXPLICITLY.
# ---------------------------------------------------------------------------
# TASK-831 §4.1 deployment condition 2: "`-m` does NOT auto-pair the projector;
# only `-hf` does. llama-server -m <weights> without --mmproj is a TEXT-ONLY
# server." It does not warn at boot — you find out when a request carrying an
# image comes back with "image input is not supported".
#
# So: if HOPE_EXPECT_MODALITIES names vision and/or audio, refuse to start
# unless --mmproj (or -mm) is actually in the argument vector. This turns a
# late, per-request failure into an immediate CrashLoopBackOff.
if [ -n "${HOPE_EXPECT_MODALITIES:-}" ]; then
  case " $* " in
    *" --mmproj "*|*" -mm "*|*" --mmproj-url "*|*" -mmu "*)
      log "ok: --mmproj present (expecting: ${HOPE_EXPECT_MODALITIES})" ;;
    *)
      # In router mode the projector lives in the per-model preset, not argv.
      if [ -n "${LLAMA_ARG_MODELS_PRESET:-}" ] || [ -n "${LLAMA_ARG_MODELS_DIR:-}" ]; then
        log "ok: router mode — projector is declared per-model in the preset file"
      else
        log "FATAL: HOPE_EXPECT_MODALITIES=${HOPE_EXPECT_MODALITIES} but no --mmproj was passed."
        log "       -m does NOT auto-pair a projector. This would serve text-only, silently."
        exit 78
      fi ;;
  esac
fi

# ---------------------------------------------------------------------------
# A-3. Post-start verification, in the background.
# ---------------------------------------------------------------------------
# GET /props is the strongest runtime assertion llama-server offers, and it has
# no LM Studio equivalent — §8.4 records that a silent CPU-only LM Studio
# "cannot be detected over HTTP" and needs an exec of `lms runtime survey --json`.
#
# VERIFIED on build b9853, /props carries:
#   build_info  -> "b9853-7af4279f4"      (the build floor, assertable over HTTP)
#   modalities  -> {"vision":b,"audio":b} (whether the projector actually loaded)
#   model_alias -> the served id          (the §7.4 sourceUri trap, observable)
#
# This runs in the background and only LOGS. It must never block or kill the
# server: a failed assertion here is an operator signal, and the real gate is
# the k8s readinessProbe. A boot assertion that can take down a serving pod on
# a transient curl failure is worse than the bug it guards.
(
  for _ in $(seq 1 300); do
    if curl -fsS "http://127.0.0.1:${PORT}/props" -o /tmp/props.json 2>/dev/null; then
      BUILD=$(jq -r '.build_info // "unknown"' /tmp/props.json 2>/dev/null || echo unknown)
      MODAL=$(jq -c '.modalities // {}'        /tmp/props.json 2>/dev/null || echo '{}')
      ALIAS=$(jq -r '.model_alias // ""'       /tmp/props.json 2>/dev/null || echo '')
      ROLE=$(jq  -r '.role // "server"'        /tmp/props.json 2>/dev/null || echo server)
      log "verified: build_info=${BUILD} role=${ROLE} alias=${ALIAS} modalities=${MODAL}"

      # Build-floor assertion. b9383 is the TASK-831 hard floor.
      NUM=$(printf '%s' "$BUILD" | sed -n 's/^b\([0-9][0-9]*\).*/\1/p')
      if [ -n "$NUM" ] && [ "$NUM" -lt 9383 ]; then
        log "WARNING: build ${BUILD} is BELOW the b9383 floor — Gemma 4 vision/audio"
        log "         output is silently WRONG on this build (PR #23822 / #23815)."
      fi

      # Modality assertion, when we said we expected one.
      if [ -n "${HOPE_EXPECT_MODALITIES:-}" ] && [ "$ROLE" != "router" ]; then
        for m in $(printf '%s' "${HOPE_EXPECT_MODALITIES}" | tr ',' ' '); do
          if [ "$(printf '%s' "$MODAL" | jq -r --arg m "$m" '.[$m] // false')" != "true" ]; then
            log "WARNING: expected modality '${m}' is NOT active (modalities=${MODAL})."
            log "         The projector did not load. Multimodal requests will fail."
          fi
        done
      fi
      break
    fi
    sleep 1
  done
) &

log "exec: llama-server $* (host=${HOST} port=${PORT})"
# exec so llama-server becomes PID 1 and gets SIGTERM directly from the kubelet.
# L-5 drain: terminationGracePeriodSeconds + a preStop sleep are set in the
# manifest so the Service drops the endpoint before the signal lands.
exec /app/llama-server "$@"
