# Malayalam-English STT quality gate (TASK-594)

A regression gate for the whisper.cpp ml-en code-switch adapter path. It runs the
shipped adapter over a labeled clip set and asserts CER has not regressed past the
committed baseline.

## PHI/PII — fixtures live OUTSIDE git

The eval clips are **real clinical audio** (some contain real names) and their
reference transcripts. **Do NOT commit them.** They live in an external, private
directory and are pointed at via env vars. Only the harness and a **metrics-only**
baseline (`mlen_scorecard_baseline.json` — per-clip CER, no transcript text) are in
git. The gate SELF-SKIPS when the fixtures/model are absent (so CI and other devs
are never blocked), exactly like `test_streaming_quality_scorecard`.

## Fixture layout

In `$STT_MLEN_EVAL_DIR`, one pair per clip (id = the first integer in the filename):

```
<id>.wav              16 kHz mono
<id>-label.txt        reference transcript   (a *-label.wav text sidecar also works)
```

## Run the gate

```bash
STT_MLEN_EVAL_DIR=/path/to/ml-test \
WHISPER_MLEN_GGUF=/path/to/ggml-whisper-turbo-ml-en-codeswitch-f16.bin \
  pnpm py:stt:test:integration -- -k mlen_quality_gate
```

## Regenerate the baseline (after an intended model/adapter change)

```bash
python apps/stt/scripts/mlen_scorecard.py \
  --clips-dir "$STT_MLEN_EVAL_DIR" --gguf "$WHISPER_MLEN_GGUF" \
  --out apps/stt/tests/integration/mlen_scorecard_baseline.json
```

Then hand-edit `mean_cer_ceiling` / `per_clip_tolerance` if the new baseline is the
intended one. The model is deterministic (greedy), so re-runs are stable.

## Caveat — this is a MODEL-quality gate, not a streaming-path test

The scorecard decodes each clip as ONE utterance (adapter chunks internally). That
isolates model/adapter quality but is NOT the real streaming loop (which VAD-segments
and re-decodes). For streaming-path measurement use the offline preprocessor+adapter
harness. See `docs/implementation/TASK-594-*/findings-and-best-practices.md` §8.
