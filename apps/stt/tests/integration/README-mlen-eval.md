# Malayalam-English STT quality gate (TASK-594; per-model profiles TASK-934/M)

A regression gate for the whisper.cpp ml-en code-switch adapter path. It runs the
shipped adapter over a labeled clip set and asserts CER has not regressed past the
committed baseline for the SELECTED model.

## PHI/PII — fixtures live OUTSIDE git

The eval clips are **real clinical audio** (some contain real names) and their
reference transcripts. **Do NOT commit them.** They live in an external, private
directory and are pointed at via env vars. Only the harness and a **metrics-only**
baseline (`mlen_scorecard_baseline.json` — per-model, per-window CER map, no
transcript text) are in git. The gate SELF-SKIPS when the fixtures/model/slug are
absent (so CI and other devs are never blocked), exactly like
`test_streaming_quality_scorecard`.

## Fixture layout

In `$STT_MLEN_EVAL_DIR`, one pair per clip (id = the first integer in the filename):

```
<id>.wav              16 kHz mono
<id>-label.txt        reference transcript   (a *-label.wav text sidecar also works)
```

## Baseline shape — `mlen_scorecard_baseline.json` (schema_version 2)

A map keyed `"<model slug>@<window_s>"`, one entry per registered fine-tune × decode
window profiled:

```json
{
  "schema_version": 2,
  "_comment": "…",
  "arcaai-whisper-large-ml-en-gguf-q8_0@7": {
    "model_slug": "arcaai-whisper-large-ml-en-gguf-q8_0",
    "gguf_file": "ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin",
    "window_s": 7,
    "mean_cer": 0.3809,
    "mean_cer_ceiling": 0.45,
    "per_clip_tolerance": 0.08,
    "prompt": "off",
    "captured_at": "2026-09-09",
    "clips": { "0": 0.9105, "1": 0.4251, "…": "…" }
  }
}
```

`window_s` is not decorative: the gate passes it to `WhisperCppAsrAdapter` as
`InferenceConfig.max_decode_window_sec` — the exact field a live row's
`_metadata.asr.maxDecodeWindowSec` reaches (TASK-880) — so an edited profile changes
what the gate measures instead of being silently ignored. `prompt` records whether a
priming prompt was applied during THIS capture (`"off"` for both entries seeded
2026-09-09 — `pair_priming_prompt`/`single_priming_prompt` were both `false` in the
raw run); OD-11 (per-model `initialPrompt`) is still open, so a future capture that
turns the prompt on needs a decision on how to key it (a distinct entry, since
`window_s` alone would not distinguish the two).

## Run the gate

`WHISPER_MLEN_MODEL_SLUG` is REQUIRED — there is no default model. Unset or unknown
skips cleanly with a reason naming the known entries (never silently picks one).

```bash
STT_MLEN_EVAL_DIR=/path/to/ml-test \
WHISPER_MLEN_GGUF=/path/to/ggml-whisper-turbo-ml-en-codeswitch-q8_0.bin \
WHISPER_MLEN_MODEL_SLUG=arcaai-whisper-large-ml-en-gguf-q8_0 \
  pnpm py:stt:test:integration -- -k mlen_quality_gate
```

The pure self-checks (`test_baseline_schema_is_v2_keyed_map`,
`test_select_baseline_entry_*`) run unconditionally, with no fixtures — they are
part of `pnpm stt:test`, not just the live gate.

## Regenerate one entry (after an intended model/adapter change)

`mlen_scorecard.py` measures ONE model + window per run and writes a FLAT scorecard
(`model`, `max_audio_seconds`, `mean_cer`, `clips` — where each clip carries the full
`ref`/`hyp` transcript text). That raw shape is PHI and must never be committed
as-is, and it does not match this file's per-model map — so regenerating is a
two-step, not a straight `--out` onto this file:

```bash
# 1. Measure one model at its profiled window, to a SCRATCH path (never --out
#    straight onto mlen_scorecard_baseline.json — the raw output carries ref/hyp
#    transcript text).
python apps/stt/scripts/mlen_scorecard.py \
  --clips-dir "$STT_MLEN_EVAL_DIR" --gguf "$WHISPER_MLEN_GGUF" \
  --max-audio-seconds 7 --out /tmp/mlen-scratch.json

# 2. Copy ONLY mean_cer and the id→cer clips map (drop ref/hyp) into the matching
#    "<model_slug>@<window_s>" key of mlen_scorecard_baseline.json, keeping/updating
#    model_slug, gguf_file (basename), window_s, prompt, captured_at, and hand-editing
#    mean_cer_ceiling / per_clip_tolerance only if the new baseline is the intended one.
```

The model is deterministic (greedy), so re-runs are stable.

## Caveat — this is a MODEL-quality gate, not a streaming-path test

The scorecard decodes each clip as ONE utterance (adapter chunks internally at the
profiled window). That isolates model/adapter quality but is NOT the real streaming
loop (which VAD-segments and re-decodes). For streaming-path measurement use the
offline preprocessor+adapter harness. See
`docs/implementation/TASK-594-*/findings-and-best-practices.md` §8.
