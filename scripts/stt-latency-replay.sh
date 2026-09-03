#!/bin/bash
# ============================================================================
# STT streaming latency replay harness (AC-11 evidence)
# ============================================================================
# Replays reference audio into a RUNNING stt over the real Redis Streams
# wire protocol at realtime pace and reports TTFW, partial cadence, and
# final lag (speech-end -> final publish) against the 800 ms/chunk SLA.
#
# PREREQUISITES
#   - Redis + Postgres up (pnpm infra:dev:up) and stt running on :8861
#     (pnpm stack:dev -- stt, or the GPU host deployment).
#   - conda env `arcaenv` with the stt dev deps installed.
#
# USAGE
#   ./scripts/stt-latency-replay.sh                 # synthetic fixture
#   LATENCY_WAV_PATH=apps/stt/tests/e2e/fixtures/20260205_52886591770282917_ml.wav \
#     ./scripts/stt-latency-replay.sh               # real Malayalam speech
#
# ENVIRONMENT VARIABLES (all optional)
#   STT_BASE_URL           stt HTTP base             (default http://localhost:8861)
#   REDIS_URL              Redis URL                 (default: stt's own settings,
#                                                     apps/stt/.env -> redis://localhost:6379/0)
#   DATABASE_URL           Postgres for read-only pipeline discovery
#                                                    (default: stt's own settings)
#   LATENCY_PIPELINE_ID    explicit pipeline UUID    (skips DB discovery)
#   LATENCY_TENANT_ID      explicit tenant ID        (pairs with LATENCY_PIPELINE_ID)
#   LATENCY_PIPELINE_SLUG  preferred slug for discovery (default best-practice-realtime)
#   LATENCY_WAV_PATH       real-speech 16-bit PCM WAV; overrides synthetic fixture
#   LATENCY_MAX_SECONDS    cap on replayed WAV duration (default 60; <=0 = full)
#   LATENCY_FRAME_MS       audio frame size in ms    (default 80)
#   LATENCY_TIMEOUT_S      post-feed wait for finals + close (default 90)
#   LATENCY_SLA_MS         SLA threshold in ms       (default 800)
#   LATENCY_REPORT_PATH    JSON report output        (default ./stt-latency-report.json)
#
# BEHAVIOUR
#   - Skips cleanly (exit 0) when Redis / stt / a usable pipeline is
#     unreachable, so it is safe to wire into any pipeline.
#   - Extra arguments are passed through to pytest.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v conda >/dev/null 2>&1; then
    echo "ERROR: conda not found on PATH (the harness runs inside the 'arcaenv' env)" >&2
    exit 1
fi

REPORT_PATH="${LATENCY_REPORT_PATH:-./stt-latency-report.json}"

echo "==> STT latency replay harness (P2-5)"
echo "    target:  ${STT_BASE_URL:-http://localhost:8861}"
echo "    fixture: ${LATENCY_WAV_PATH:-<synthetic speech-like signal>}"
echo "    report:  ${REPORT_PATH}"
echo

set +e
conda run -n arcaenv --no-capture-output pytest \
    apps/stt/tests/integration/test_streaming_latency_harness.py -v -s "$@"
EXIT_CODE=$?
set -e

echo
if [ -f "$REPORT_PATH" ]; then
    echo "==> JSON report: $(cd "$(dirname "$REPORT_PATH")" && pwd)/$(basename "$REPORT_PATH")"
else
    echo "==> No report written (run skipped or failed before feeding audio)"
fi

exit $EXIT_CODE
