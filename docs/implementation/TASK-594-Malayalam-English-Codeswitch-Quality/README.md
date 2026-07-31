# TASK-594 — Malayalam-English Code-Switch Transcription Quality

**Status:** In Progress (Phase 1 — correctness)
**Type:** bugfix / quality
**Branch:** dev-2.1

## Requirement Analysis

The whisper.cpp streaming path — default STT pipeline `arcaai-whisper-large-ml-en-gguf`
(`language: "ml-en"`, the in-house ml-en code-switch GGUF fine-tune) — produces
transcripts that are "completely wrong," emit `final:false` partials that churn for
a long time, and are slow to finalize. Goal: high-quality Malayalam+English
code-switch clinical transcription, following best practices.

Delivered in phases (user decision: correctness-first, then iterate):
- **Phase 1 (this pass):** fix the Malayalam text corruption + reconcile the prompt.
- **Phase 2 (deferred):** streaming buffer / endpointing (low-latency profile).
- **Phase 3 (deferred):** ml-en evaluation harness (user provides labeled audio).

## Current State Evaluation

- Default engine `arcaai-whisper-large-ml-en-gguf` → HF `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF` (f16), format `WHISPER_CPP`, `isDefault: true` for SYSTEM + both platform tenants (verified in live DB).
- **Root cause of "completely wrong" (Malayalam):** `WhisperCppAsrAdapter._build_result`
  forces `max_len=1, split_on_word=True` and rebuilds text with
  `" ".join(word.strip())`. `max_len` is segmentation-only, but space-joining the
  forced word/sub-token segments injects spurious spaces and splits Malayalam
  grapheme clusters (agglutinative, few inter-word spaces). The default pipeline sets
  `word_timestamps: false`, so `inference.py:427-432` discards the timestamps — the
  text is corrupted to produce data that is thrown away.
- **`language="ml"` pin is correct** (fine-tune trained to emit both scripts under
  the `ml` token; auto/None is worse in streaming). Left unchanged.
- **Prompt contradiction:** `WHISPER_CPP_PRIMING_PROMPT_ENABLED = False` disables the
  mode-resolution priming prompt, yet the adapter unconditionally injects its own
  consultation `initial_prompt`. Un-toggleable, unmeasured.
- Research basis: whisper_streaming (Macháček 2023, arXiv 2307.14743), Adapting
  Whisper for Code-Switching (2412.16507), Malayalam tokenization (Thottingal),
  OpenAI Whisper prompting guide, CS-ASR metrics (2211.16319).

## Implementation Plan (Phase 1)

1. `whisper_cpp_asr.py::_build_result` — reconstruct `text` by native concatenation
   of raw `seg.text` (preserves whisper's own leading-space spacing), whitespace-
   normalized; decouple authoritative text from the per-word timestamp join.
   `word_timestamps` still derived from segments for pipelines that request them.
2. `whisper_cpp_asr.py::__init__` + `settings.py` — gate the always-on consultation
   `initial_prompt` behind `whisper_cpp_consultation_prompt_enabled` (default True;
   removes the silent contradiction, A/B-togglable in Phase 3).
3. TDD unit tests in `tests/unit/test_whisper_cpp_asr.py` (Malayalam native concat,
   English spacing preserved, prompt flag on/off), preserving concurrency + Metal-
   poison recovery tests.

## Real-audio findings (labeled ml-en clips, `/Users/taphuynh/Downloads/ml-test/`)

Verified against 3 labeled clinical ml-en clips (16 kHz mono) via a matrix sweep,
a prefix sweep, and the real VAD-segmented streaming path. The original "text
corruption" theory was **secondary**; the real drivers, in order:

1. **whisper.cpp temperature FALLBACK spirals into sampled garbage** on this
   fine-tune (default `temperature_inc=0.2`). Pure greedy (`temperature=0`,
   `temperature_inc=0`) fixed clip-1 from **CER 0.778 → 0.025**. Biggest single win.
2. **`language="ml"` pin is WORSE than auto (None)** for the code-switch pair
   (0.148 vs 0.049); pinning over-biases toward Malayalam script.
3. **The consultation `initial_prompt` injects garbage tokens** (`baş)!�`) and
   breaks grapheme clusters — disable it.
4. **The fine-tune truncates/garbles on long audio (>~6 s)**; short (~3–5 s)
   utterances are near-perfect. **VAD does NOT segment continuous clinical speech**
   (no ≥700 ms pauses → one 5–11 s utterance), so length-bounding is required.
5. Text reconstruction: with a clean (non-`max_len=1`) decode, native `"".join`
   is correct; with `max_len=1` word-split, `" ".join` is correct (mode-aware).

Verified end-to-end through the real `StreamingPreprocessor` (Silero VAD, default
thresholds) + fixed adapter:

| clip | before | after (greedy + None + no-prompt + clean text) |
|---|---|---|
| test_1 (5.3 s) | 0.778 (garbage) | **0.025** ✓ |
| test-2 (11 s) | 0.944 (garbage) | 0.573 (first ~6 s correct, tail truncated) |
| test-3 (11 s) | 0.553 | 0.477 (first 2 sentences correct, tail truncated) |

Residual loss on the 11 s clips is truncation on long continuous audio. Naive
≤5 s energy-split chunking is NOT a safe fix — it recovered clip-2 (0.57→0.17) but
regressed clip-1 (0.025→0.63) and sent clip-3 into a greedy repetition loop. So
length-bounding/windowing needs measured, eval-driven tuning (Phase 3 harness with
the user's labeled data), not a blind change.

## Implementation Summary (this pass — the unambiguous wins)

Changed files:
- `apps/stt/src/stt/streaming/whisper_cpp_asr.py` —
  (1) greedy decode `temperature=0, temperature_inc=0` (kills the fallback garbage);
  (2) code-switch PAIR → `language=None` (auto) via the language-mode catalog, single
  language still pinned; (3) mode-aware reconstruction: clean sentence decode +
  native `"".join` by default, `max_len=1` word-split + `" ".join` only when word
  timestamps are requested (`want_word_timestamps`); (4) consultation `initial_prompt`
  gated behind the new setting (default OFF); prompt parts joined non-empty.
- `apps/stt/src/stt/streaming/session_manager.py` — stash
  `_pending_want_word_timestamps` from `pipeline_config.postprocessing.timestamps`
  in `_load_asr_pipeline`; pass it into the adapter in `_make_whisper_cpp_callable`.
- `apps/stt/src/stt/core/config/settings.py` — `whisper_cpp_consultation_prompt_enabled`
  (default **False**, env `WHISPER_CPP_CONSULTATION_PROMPT_ENABLED`).
- `apps/stt/src/stt/pipeline/language_modes.py` — reverted the concurrent
  `WHISPER_CPP_PRIMING_PROMPT_ENABLED = True` back to `False` (owner-approved; that flip
  re-enabled the degrading instruction prompt and left 2 tests red).
- `apps/stt/tests/unit/test_whisper_cpp_asr.py` — rewritten to the new contract
  (pinning single vs unpinned pair, prompt off-by-default + opt-in, clean vs
  word-timestamp decode + reconstruction).

Evidence (arcaenv python):
- `pytest test_whisper_cpp_asr.py` → **22 passed**.
- `test_session_manager_model_wiring.py` + `streaming/` + `test_whisper_cpp_loader.py`
  → **450 passed**. `language_modes` prompt-disabled tests green again after the revert.
- ruff clean; mypy clean.
- Real-audio verification via the offline VAD harness — see table above.

## Open / follow-up
- **Phase 3 (now the priority): length-bounding / windowing, eval-driven.** Build the
  ml-en scorecard (transliteration-normalized CER/MER) over the user's labeled clips,
  then tune a "chunk only when the utterance exceeds the fine-tune's stable window,
  split at silence troughs, with a repetition-loop guard" strategy against it. Do NOT
  ship blind chunking (regresses short clips; can loop).
- The fine-tune (f16) is the platform default but is fragile on long continuous audio;
  the eval harness should also compare q8_0 and the non-GGUF transformer variant.

## Change History

- 2026-07-31 — TASK-594 opened; investigation + best-practice research; Phase 1
  plan approved.
- 2026-07-31 — Phase 1 implemented (native-concat text fix + prompt-gate setting +
  3 TDD tests). Gates green for changed files. Noted concurrent `e5d2e967` priming-flag
  flip + its 2 unrelated red tests.
