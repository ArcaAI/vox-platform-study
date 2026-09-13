#!/usr/bin/env bash
#
# the SUPPORTED way to run the harness clinical-quality release gate.
#
#   apps/harness/eval/run-gate.sh
#
# Owner decision (2026-08-17,
# this gate is a LOCAL / scheduled quality check, not a per-MR blocking shared-CI
# job — LM Studio is a desktop app with no CI-runnable image. This script is that local
# path, in one command.
#
# It does four things a bare `python -m harness.eval.ci` invocation does not:
#
#   1. PREFLIGHT — fails fast with an actionable message if LM Studio is unreachable
#                    or the judge model is not served, instead of dying mid-run on a
#                    connection error 10 minutes in.
#   2. WARM-LOAD — the trap that cost three prior sessions a completed run. LM Studio
#                    JIT-loads a model on first use; a cold call costs ~20 s while a warm
#                    one costs ~0.1 s. Measuring the COLD call and extrapolating makes the
#                    run look like it needs 20-45 minutes when it actually needs minutes.
#                    This script loads the model first and reports both numbers, so the
#                    per-call cost you see is the real one.
#   3. CTX CHECK — warns when HARNESS_JUDGE_MAX_TOKENS exceeds the model's LOADED
#                    context window (LM Studio answers `400 {'error':'terminated'}`).
#   4. TIMED VERDICT — prints wall-clock and the PASS/FAIL verdict, and exits with the
#                    gate's own exit code so any scheduler/cron surfaces a FAIL loudly.
#
# Env overrides: JUDGE_MODEL, JUDGE_BASE_URL, GOLDEN_SET, OUTPUT, CONDA_ENV.
# Every HARNESS_JUDGE_*/HARNESS_EVAL_* value below is a plain env var, so swapping the
# judge backend (LM Studio -> vLLM -> Azure -> Bedrock) is a CONFIG change, never a code
# edit: `build_judge_client` dispatches on HARNESS_JUDGE_PROVIDER and fails closed on
# missing provider config.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HARNESS_DIR"

JUDGE_BASE_URL="${JUDGE_BASE_URL:-http://localhost:1234/v1}"
GOLDEN_SET="${GOLDEN_SET:-src/harness/eval/golden/fixtures/curated_v2.json}"
OUTPUT="${OUTPUT:-eval-report.json}"
CONDA_ENV="${CONDA_ENV:-arcaenv}"

# Context window the judge is LOADED at, and the generation budget inside it.
#
# MEASURED 2026-08-18 (apps/harness/eval/README.md "Context-length finding"): the
# loaded context window has NO effect on the judge's scores. The same six cases
# scored at 4096 / 8192 / 32768 / 131072 returned BYTE-IDENTICAL PDSQI vectors. The
# only thing a small window changes is TRUNCATION: this judge spends ~1300-2000
# completion tokens on a hidden reasoning pass before the JSON, and at 4096 one case
# hit `finish_reason: length` (prompt 2142 + completion 1954 = 4096 exactly) and
# would have been DROPPED from the run. So the context is pinned for HEADROOM, not
# for calibration. Prompt is ~2100-2400 tokens; 8192 leaves 2x headroom over the
# largest completion observed, loads faster than 131072, and costs no accuracy.
JUDGE_CTX="${JUDGE_CTX:-8192}"
MAX_TOKENS="${HARNESS_JUDGE_MAX_TOKENS:-4096}"
LMS_BIN="${LMS_BIN:-$HOME/.lmstudio/bin/lms}"

# Interpreter selection. The supported path is `conda run -n arcaenv` (matching every
# other `pnpm <svc>:*` script). PYTHON_BIN is an escape hatch for shells where the
# `conda` function is unavailable (sandboxes, CI containers, cron with a bare PATH):
# point it at the SAME env's interpreter, e.g. ~/miniconda3/envs/arcaenv/bin/python.
PYTHON_BIN="${PYTHON_BIN:-}"
run_py() {
  if [ -n "$PYTHON_BIN" ]; then "$PYTHON_BIN" "$@"
  else conda run -n "$CONDA_ENV" --no-capture-output python "$@"; fi
}

# The judge SELECTION is DB-resident and fail-closed (owner decision D-B): it comes
# from the SYSTEM `harness.judge` AiRoutingPolicy default row -> AiModel, exactly as the Temporal
# runtime resolves it. There is deliberately NO hardcoded default here — the gate must
# grade with the judge the platform selects, or refuse to run.
if [ -z "${JUDGE_MODEL:-}" ]; then
  JUDGE_MODEL="$(cd "$HARNESS_DIR" && PYTHONPATH=src run_py -m harness.eval.judge.selection --field model 2>/dev/null | tail -1)"
  if [ -z "$JUDGE_MODEL" ]; then
    echo "FAILED: could not resolve the judge selection from the database." >&2
    echo "        The eval gate fails closed rather than grading with an env-supplied" >&2
    echo "        model id. Check DATABASE_URL and the SYSTEM 'harness.judge'" >&2
    echo "        AiRoutingPolicy default row (enabled, ACTIVE, pointing at an ENABLED AiModel)." >&2
    exit 2
  fi
  echo "judge selection (from DB, SYSTEM harness.judge): $JUDGE_MODEL"
fi

# Normalise GOLDEN_SET to an absolute path up front: step 2 must be handed an
# ABSOLUTE HARNESS_GOLDEN_SET_PATH (promptfoo's tests.py does a bare
# Path(override) and that step runs from eval/promptfoo), and callers may pass
# either form.
case "$GOLDEN_SET" in
  /*) GOLDEN_SET_ABS="$GOLDEN_SET" ;;
  *)  GOLDEN_SET_ABS="$HARNESS_DIR/$GOLDEN_SET" ;;
esac
GOLDEN_SET_ABS="$(cd "$(dirname "$GOLDEN_SET_ABS")" && pwd)/$(basename "$GOLDEN_SET_ABS")"

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }

say "1/5 preflight — judge backend reachability ($JUDGE_BASE_URL)"
if ! curl -sf --max-time 10 "$JUDGE_BASE_URL/models" -o /tmp/hope-judge-models.json; then
  echo "FAILED: no judge backend at $JUDGE_BASE_URL" >&2
  echo "        Start LM Studio and serve '$JUDGE_MODEL' on :1234, or point" >&2
  echo "        JUDGE_BASE_URL at another OpenAI-compatible endpoint." >&2
  exit 2
fi
if ! grep -q "\"$JUDGE_MODEL\"" /tmp/hope-judge-models.json; then
  echo "FAILED: '$JUDGE_MODEL' is not served at $JUDGE_BASE_URL" >&2
  echo "        Served models: $(tr -d ' \n' < /tmp/hope-judge-models.json | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | paste -sd, -)" >&2
  exit 2
fi
echo "OK — $JUDGE_MODEL is served."

say "2/5 warm-load — paying the JIT model-load cost once, up front"
COLD_START=$(date +%s)
curl -sf --max-time 600 "$JUDGE_BASE_URL/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$JUDGE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":8,\"temperature\":0}" \
  > /dev/null
COLD_S=$(( $(date +%s) - COLD_START ))
WARM_START=$(date +%s)
curl -sf --max-time 120 "$JUDGE_BASE_URL/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$JUDGE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":8,\"temperature\":0}" \
  > /dev/null
WARM_S=$(( $(date +%s) - WARM_START ))
echo "first (cold, includes model load): ${COLD_S}s   second (warm): ${WARM_S}s"
echo "NOTE: only the warm number reflects per-call cost. Do not extrapolate the cold one."

say "3/5 context check — the judge must have room for prompt + reasoning + JSON"
loaded_ctx() {
  # LM Studio's own /api/v0/models reports the LOADED context per model. Scoped to
  # this judge's entry (grep -A) so another loaded model can't supply the number.
  curl -sf --max-time 10 "${JUDGE_BASE_URL%/v1}/api/v0/models" 2>/dev/null \
    | grep -A 20 -F "\"id\": \"$JUDGE_MODEL\"" \
    | grep -m1 'loaded_context_length' | grep -o '[0-9]\+' || true
}
LOADED_CTX="$(loaded_ctx)"
# ~2400 tokens of PDSQI prompt (rubric + notes + summary) is the largest observed.
NEEDED=$(( 2400 + MAX_TOKENS ))
if [ -n "$LOADED_CTX" ]; then
  echo "loaded context = $LOADED_CTX, max_tokens = $MAX_TOKENS, needed >= $NEEDED"
  if [ "$NEEDED" -gt "$LOADED_CTX" ] && [ -x "$LMS_BIN" ]; then
    echo "insufficient headroom — reloading $JUDGE_MODEL at $JUDGE_CTX tokens"
    "$LMS_BIN" unload --all >/dev/null 2>&1 || true
    "$LMS_BIN" load "$JUDGE_MODEL" -c "$JUDGE_CTX" -y >/dev/null 2>&1 || true
    LOADED_CTX="$(loaded_ctx)"
    echo "loaded context now = $LOADED_CTX"
  fi
  if [ -n "$LOADED_CTX" ] && [ "$NEEDED" -gt "$LOADED_CTX" ]; then
    echo "WARNING: prompt + max_tokens exceeds the loaded context. Long cases will be" >&2
    echo "         TRUNCATED (finish_reason=length) and DROPPED from the run, silently" >&2
    echo "         shrinking n. Reload with a larger context or lower HARNESS_JUDGE_MAX_TOKENS." >&2
  fi
else
  echo "loaded context unknown (non-LM-Studio endpoint) — skipping check."
fi

say "4/5 release gate step 1/2 — PDSQI-9 / faithfulness / ICC over $(basename "$GOLDEN_SET")"
GATE_START=$(date +%s)
set +e
PYTHONPATH=src \
HARNESS_JUDGE_PROVIDER="${HARNESS_JUDGE_PROVIDER:-openai_compat}" \
HARNESS_JUDGE_OPENAI_COMPAT_BASE_URL="$JUDGE_BASE_URL" \
HARNESS_JUDGE_OPENAI_COMPAT_API_KEY="${HARNESS_JUDGE_OPENAI_COMPAT_API_KEY:-lm-studio}" \
HARNESS_JUDGE_TEMPERATURE="${HARNESS_JUDGE_TEMPERATURE:-0.0}" \
HARNESS_JUDGE_SEED="${HARNESS_JUDGE_SEED:-7}" \
HARNESS_JUDGE_OUTPUT_MODE="${HARNESS_JUDGE_OUTPUT_MODE:-score}" \
HARNESS_JUDGE_ANCHORED="${HARNESS_JUDGE_ANCHORED:-false}" \
HARNESS_JUDGE_SELF_CONSISTENCY="${HARNESS_JUDGE_SELF_CONSISTENCY:-1}" \
HARNESS_JUDGE_MAX_TOKENS="$MAX_TOKENS" \
HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT="${HARNESS_JUDGE_OPENAI_COMPAT_JSON_RESPONSE_FORMAT:-text}" \
HARNESS_JUDGE_TIMEOUT_S="${HARNESS_JUDGE_TIMEOUT_S:-90}" \
HARNESS_EVAL_CASE_CONCURRENCY="${HARNESS_EVAL_CASE_CONCURRENCY:-1}" \
run_py -m harness.eval.ci --golden-set "$GOLDEN_SET_ABS" --output "$OUTPUT"
RC=$?
set -e
GATE_S=$(( $(date +%s) - GATE_START ))
case "$OUTPUT" in /*) REPORT="$OUTPUT" ;; *) REPORT="$HARNESS_DIR/$OUTPUT" ;; esac
echo "step 1 wall clock: ${GATE_S}s   exit=$RC   report=$REPORT"

say "5/5 release gate step 2/2 — promptfoo output-contract check (offline mock provider)"
# HARNESS_GOLDEN_SET_PATH must be ABSOLUTE: promptfoo's tests.py does a bare
# Path(override) and this step runs from eval/promptfoo. Without it, step 2
# silently falls back to the 5-case synthetic_v0 while step 1 scores the
# 18-case curated_v1 — the two halves of the gate grading different sets.
set +e
( cd "$HARNESS_DIR/eval/promptfoo" \
  && PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1 \
     HARNESS_GOLDEN_SET_PATH="$GOLDEN_SET_ABS" \
     PROMPTFOO_PYTHON="${PYTHON_BIN:-$(conda run -n "$CONDA_ENV" which python 2>/dev/null | tr -d '\r\n')}" \
     npx --yes promptfoo@0.121.15 eval -c promptfooconfig.yaml --no-cache --no-table )
RC2=$?
set -e

echo
echo "════ eval gate summary ════"
echo "run at:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "judge:       $JUDGE_MODEL @ $JUDGE_BASE_URL"
echo "golden set:  $(basename "$GOLDEN_SET")"
echo "step 1 (PDSQI/faithfulness/ICC): $([ $RC -eq 0 ] && echo PASS || echo FAIL)  (${GATE_S}s)"
echo "step 2 (promptfoo contract):     $([ $RC2 -eq 0 ] && echo PASS || echo FAIL)"
[ $RC -eq 0 ] && [ $RC2 -eq 0 ] && exit 0
exit 1
