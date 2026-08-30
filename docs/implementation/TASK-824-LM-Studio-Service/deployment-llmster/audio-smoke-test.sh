#!/usr/bin/env bash
# =============================================================================
# TASK-824 — LM Studio AUDIO smoke test (ticket §0 risk A-1)
# =============================================================================
# ⚠️ THIS SCRIPT HAS NOT BEEN RUN. It could not be: this lane had no GPU and no
# Gemma 4 weights, and the owner directive forbids local image builds. It is
# delivered as an EXECUTABLE TEST, not as a result. Do not cite it as evidence
# that audio works. See AUDIO_VERDICT in README.md for exactly what is and is
# not known.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# Risk A-1 is the one the owner is explicitly carrying: LM Studio audio support
# is UNVERIFIED-NEGATIVE, and Gemma 4 E2B/E4B projectors carry BOTH a vision and
# an audio encoder (verified in TASK-831 by parsing the GGUF headers:
# clip.has_vision_encoder = True, clip.has_audio_encoder = True, gemma4v +
# gemma4a, BF16).
#
# A model that serves text and vision but silently NOT audio is precisely the
# failure A-1 flags, and it is silent — a request with an audio part may be
# accepted and answered from the text alone, producing a plausible, wrong
# answer with no error. In a clinical setting that is a patient-safety issue,
# not a config gap. Hence a KNOWN-ANSWER test: the model must report something
# only an actual listener could know.
#
# ── EVIDENCE GATHERED WITHOUT RUNNING IT (all NEGATIVE or ABSENT) ───────────
#  1. LM Studio's docs describe "Chat Completions (text and images)" — audio is
#     not mentioned.
#  2. Its per-model metadata carries `capabilities{vision, trained_for_tool_use,
#     reasoning}` (§8.1). There is NO audio capability flag in the schema, so
#     the API cannot advertise audio support even if the engine had it.
#  3. MEASURED on llmster 0.0.23-1: `/api/v1/models` returned no `capabilities`
#     key at all for a non-vision model, so absence there proves nothing on its
#     own — but combined with (2) there is no positive signal anywhere.
#  4. For contrast, llama.cpp DOES activate the audio encoder (GET /props ->
#     modalities {vision,video,audio}) while warning at load:
#     "W init_audio: audio input is in experimental stage".
#
# None of that is proof of absence. Only this script is.
#
# ── PREREQUISITES ───────────────────────────────────────────────────────────
#   * A Gemma 4 E2B or E4B model loaded, WITH its projector active. Whether LM
#     Studio auto-pairs `*-mmproj.gguf` from the same <publisher>/<model>/
#     directory is UNVERIFIED — this is open item OI-1. If it does not, audio
#     and vision are BOTH unavailable and this test fails for a reason that has
#     nothing to do with audio support. Run the VISION control first; it
#     distinguishes the two causes.
#   * A known-transcript audio clip. Google's model card constrains audio to
#     30 SECONDS MAX, and modality order matters: IMAGE BEFORE TEXT, AUDIO
#     AFTER TEXT (TASK-831 §4.1). Both are honoured below.
#
# Usage:
#   ./audio-smoke-test.sh <base-url> <model-key> <audio.wav> "<expected words>"
# e.g. from inside the namespace:
#   kubectl -n hope-v2-dev exec deploy/hope-lmstudio -- \
#     /bin/sh -c 'curl ...'      # or port-forward and run this locally
# =============================================================================
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:1234}"
MODEL="${2:-gemma-4-e2b-it-qat}"
AUDIO="${3:-}"
EXPECT="${4:-}"

fail() { printf '\n[FAIL] %s\n' "$*" >&2; exit 1; }
note() { printf '\n== %s ==\n' "$*"; }

command -v jq >/dev/null || fail "jq is required"

# -----------------------------------------------------------------------------
# STEP 0 — is the model actually loaded, WITH a projector?
# -----------------------------------------------------------------------------
note "STEP 0: model state"
models_json="$(curl -fsS "${BASE_URL}/api/v1/models")" \
  || fail "cannot reach ${BASE_URL}/api/v1/models"

printf '%s' "${models_json}" | jq -e --arg k "${MODEL}" \
  '.models[] | select(.key == $k) | select(.loaded_instances | length > 0)' >/dev/null \
  || fail "model '${MODEL}' is not loaded (empty loaded_instances[]). Load it first:
           lms load ${MODEL} -y --gpu max"

echo "loaded. reported capabilities (note: there is no 'audio' flag in this schema):"
printf '%s' "${models_json}" | jq --arg k "${MODEL}" \
  '.models[] | select(.key == $k) | {key, format, capabilities, max_context_length}'

# -----------------------------------------------------------------------------
# STEP 1 — VISION CONTROL. Run this FIRST and do not skip it.
# -----------------------------------------------------------------------------
# This is what makes a STEP 2 failure interpretable. If vision also fails, the
# projector is not active at all (OI-1) and the audio result says nothing about
# LM Studio's audio support. If vision passes and audio fails, that IS the A-1
# finding.
note "STEP 1: vision control (known answer: a solid red image)"
# A 1x1 red PNG, inlined so the test needs no fixture file.
RED_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

vision_body=$(jq -n --arg m "${MODEL}" --arg img "data:image/png;base64,${RED_PNG_B64}" '
{
  model: $m,
  temperature: 0,
  max_tokens: 24,
  messages: [{
    role: "user",
    content: [
      # IMAGE BEFORE TEXT — Google model-card ordering.
      { type: "image_url", image_url: { url: $img } },
      { type: "text", text: "What colour fills this image? Answer with one word." }
    ]
  }]
}')

vision_resp="$(curl -fsS "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "${vision_body}")" \
  || fail "vision request was REJECTED. The projector is probably not active (OI-1).
           Audio cannot be assessed until this passes."

# Gemma 4 emits its reasoning into message.reasoning_content, leaving content
# empty (TASK-831). Check BOTH or a correct answer looks like an empty one.
vision_out="$(printf '%s' "${vision_resp}" \
  | jq -r '.choices[0].message.content // "", .choices[0].message.reasoning_content // ""')"
echo "vision output: ${vision_out}"
printf '%s' "${vision_out}" | grep -qi 'red' \
  || fail "vision control did NOT return 'red'. The projector is not working
           (OI-1), so STEP 2 would be uninterpretable. Fix this first."
echo "[PASS] vision control — the projector IS active."

# -----------------------------------------------------------------------------
# STEP 2 — AUDIO. The actual A-1 test.
# -----------------------------------------------------------------------------
note "STEP 2: audio (the A-1 test)"
[ -n "${AUDIO}" ] || fail "no audio file given.
  usage: $0 <base-url> <model-key> <audio.wav> \"<expected words>\"
  Constraints: <= 30s (Google model card), known transcript."
[ -f "${AUDIO}" ] || fail "audio file not found: ${AUDIO}"
[ -n "${EXPECT}" ] || fail "no expected words given — a smoke test without a
  known answer cannot distinguish listening from guessing."

dur_note="(duration unchecked — ffprobe absent)"
if command -v ffprobe >/dev/null; then
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${AUDIO}" | cut -d. -f1)
  [ "${dur:-0}" -le 30 ] || fail "clip is ${dur}s; Google's card caps audio at 30s."
  dur_note="(${dur}s, within the 30s cap)"
fi
echo "clip: ${AUDIO} ${dur_note}"

fmt="${AUDIO##*.}"
audio_b64="$(base64 < "${AUDIO}" | tr -d '\n')"

audio_body=$(jq -n --arg m "${MODEL}" --arg d "${audio_b64}" --arg f "${fmt}" '
{
  model: $m,
  temperature: 0,
  max_tokens: 128,
  messages: [{
    role: "user",
    content: [
      # AUDIO AFTER TEXT — Google model-card ordering (the opposite of images).
      { type: "text", text: "Transcribe the speech in this audio exactly. Output only the transcript." },
      { type: "input_audio", input_audio: { data: $d, format: $f } }
    ]
  }]
}')

set +e
audio_resp="$(curl -sS -w '\n%{http_code}' "${BASE_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' -d "${audio_body}")"
set -e
audio_code="$(printf '%s' "${audio_resp}" | tail -n1)"
audio_json="$(printf '%s' "${audio_resp}" | sed '$d')"

echo "HTTP ${audio_code}"
echo "${audio_json}" | head -c 1200; echo

# ── Three distinct outcomes, and the third is the dangerous one ─────────────
if [ "${audio_code}" != "200" ]; then
  echo
  echo "RESULT: A-1 CONFIRMED NEGATIVE (explicit rejection)."
  echo "LM Studio rejected an input_audio content part outright. This is the"
  echo "GOOD failure: it is loud. Audio is unavailable on this engine, and any"
  echo "clinical capability depending on it must not be routed here."
  exit 2
fi

audio_out="$(printf '%s' "${audio_json}" \
  | jq -r '.choices[0].message.content // "", .choices[0].message.reasoning_content // ""')"
echo "audio output: ${audio_out}"

matched=0
# EXPECT is deliberately UNQUOTED in both places below: word-splitting is the
# mechanism — each expected word becomes its own loop iteration / printf line.
# Quoting would make it one blob and the count would always be 1.
# shellcheck disable=SC2086
for w in ${EXPECT}; do
  printf '%s' "${audio_out}" | grep -qi -- "${w}" && matched=$((matched+1))
done
# shellcheck disable=SC2086
total=$(printf '%s\n' ${EXPECT} | wc -l | tr -d ' ')
echo "matched ${matched}/${total} expected words"

if [ "${matched}" -ge $(( (total + 1) / 2 )) ]; then
  echo
  echo "RESULT: A-1 REFUTED — the model transcribed content it could only know"
  echo "by processing the audio. Audio works on this deployment."
  echo "Still required before clinical traffic: diff against the HF Transformers"
  echo "reference (TASK-831 §8), not just this keyword check."
  exit 0
fi

echo
echo "RESULT: ⚠️ THE DANGEROUS OUTCOME — accepted (HTTP 200) but did NOT"
echo "transcribe. The audio part was ignored and the model answered from the"
echo "text prompt alone. This is A-1's silent-failure mode: it looks like a"
echo "working multimodal endpoint and is not one."
echo "DO NOT route audio-dependent clinical work here. Treat as CONFIRMED"
echo "NEGATIVE until proven otherwise."
exit 3
