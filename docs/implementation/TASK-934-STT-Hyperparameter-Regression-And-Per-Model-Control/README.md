# TASK-934 — STT hyper-parameter regression: review, re-measure, and platform-admin control of transcription-agent parameters per assigned model

| | |
|---|---|
| **Status** | `Pending` — review done, measurements taken, plan and owner decisions (§4) ready; no code written. Ticket number TASK-934 assigned by the highest-existing-number rule (TASK-933 is the highest in `docs/implementation` and `docs/archive`) — confirm (OD-9). |
| **Branch** | `dev-2.2` |
| **Classification** | `bugfix` (regression) + `feature` (per-model control surface) + `refactor` (measurement harness) |
| **Owner request** | 2026-09-09 — "recently we changed the STT hyper parameters and it caused the performance to degrade; review; perform measurement again as we need best practices for fine-tuned models; make sure the platform admin can control transcription agent hyper parameters and configuration for a specific assigned model" |
| **Related** | TASK-861 (`ResolvedAsrSpec`), TASK-865 (agent selection, `pipelineId` deprecated), TASK-872/877/880/887 (platform `stt.*` keys moved onto the agent/model rows), TASK-891 (A4/A5/W1 — `wordTimestamps: false`, decode window 7 → 30 on the f16 row, language routing), TASK-930 (agent catalogue rewrite — primary ASR model swapped to `q8_0`), TASK-594 (Malayalam-English CER gate), TASK-799 (STT env → control plane) |

---

## 1. Requirement Analysis

| Id | Owner's words (condensed) | Kind |
|---|---|---|
| R-1 | "we changed the STT hyper parameters and it caused the performance to degrade — review" | regression review, root cause with evidence |
| R-2 | "perform measurement again" | repeatable before/after measurement with the repo's own harnesses |
| R-3 | "we need best practices for fine-tuned models" | a per-MODEL recommended-parameter profile that travels with the registered fine-tune, chosen by measurement, not by whoever last edited an agent |
| R-4 | "make sure the platform admin can control transcription agent hyper parameters and configuration for a specific assigned model" | every knob that decides transcription quality is settable by a platform admin, per agent AND per assigned model, through the API and the console — nothing left as a Python literal |

## 2. Current State Evaluation (verified 2026-09-09 on `dev-2.2` at `963597f1c`; dev DB reseeded on the wave-3 tree)

### 2.1 Where a transcription parameter can come from today

| Layer | Where | Carries | Who can change it |
|---|---|---|---|
| Agent (`realtime-transcription`, SPEECH_TO_TEXT; SYSTEM + Global + ArcaAI rows) | `seed/25-agents.ts:179-186` (`ASR_PARAMETERS`); schema `packages/workflow-contract/src/agent-schemas.ts` (`SPEECH_TO_TEXT_PARAMETERS`, range-validated) | `audioFrontEnd.vad{threshold 0.5, minSpeechMs 250, minSilenceMs 500}`, `diarization`, `decoding{languageMode ml-en, codeSwitching, wordTimestamps false, beamSize 5, temperature 0}`, `postProcessing{punctuation cadence-punctuation, disfluency, stabilizer}`, `streaming{partialIntervalMs 500, endpointing semantic, maxUtteranceSec 60}`, `fallback{switchAfterConsecutiveFailures 3}`; `instruction.initialPrompt` ("Clinical consultation between a clinician and a patient. English and Malayalam medical terminology.") | Platform/tenant admin — agent editor (`features/agents/components/parameters-form.tsx`, structured form + raw JSON) → `PATCH admin/agents/:id` (draft versions) |
| Model row (`AiModel`, ASR) | `seed/ai-models/audio.ts` | `computeType` (`f16` / `q8_0` / `int8_float16` …), `_metadata.asr.{maxDecodeWindowSec, partialWindowSec}` | `computeType`: `PATCH admin/ai-models/:id` (`UpdateModelRequest.computeType`). **`_metadata`: nobody** — absent from `UpdateModelRequest`, `CreateModelRequest`, `RegisterDiscoveredModelRequest`; seed/DB-write only |
| Agent → model binding | `Agent.modelId` + `AgentModelFallback` (priority-ordered) | primary + fallback chain | Agent editor (`modelSlug` select from `GET admin/ai-models/catalogue`) |
| Gateway resolver | `services/stt/agent-resolver/asr-agent-resolver.service.ts` → `build-resolved-asr-spec.ts` (`specModelMetadata` reads `metaData.asr`; `decoding()` folds the agent block) → `packages/types/src/asr-spec.ts` (`ResolvedAsrSpec`); parity fixture `tests/contracts/resolved-asr-spec.fixture.json` | the whole spec | derived — not a control surface |
| STT consumer | `apps/stt/src/stt/pipeline/spec.py` (`AsrSpecDecoding`: `beam_size`, `temperature`, `vad_filter`, `chunk_length_sec`, `stride_length_sec`) → engine dataclasses; `models.asr.metadata.maxDecodeWindowSec` → `InferenceConfig.max_decode_window_sec` → `WhisperCppAsrAdapter._max_audio_seconds` (**set once per pinned pipeline — a row change reaches it only after the STT process restarts**); `partialWindowSec` → `StreamingConfig.partial_window_s` (per session) | `None` = the agent said nothing → the dataclass default stands | derived |
| Engine defaults (`apps/stt/src/stt/pipeline/dto.py`) | `InferenceConfig` (`:753-799`), `VadConfig` (`:584-603`) | `compression_ratio_threshold 2.4`, `logprob_threshold -1.0`, `no_speech_threshold 0.6`, `no_repeat_ngram_size 3`, `condition_on_prev_tokens False`, `prev_text_context_words 50`, `enable_prev_text_context True`, `hotwords []`, VAD `threshold 0.6 / min_speech 100 / min_silence 100 / padding 200`; whisper.cpp call fixes `temperature 0.0`, `temperature_inc 0.0`, `language` from the mode, `no_context` (pywhispercpp default `True`) | **Nobody.** No wire field, no agent schema key, no global-kv descriptor — a Python literal for every agent, every tenant. `best_of` / `patience` are not implemented at all |
| Platform-wide ops knobs | `settings-registry/descriptors/stt-runtime.descriptors.ts` (`global-kv`, `maxScope: system`) | threads, timeouts, streaming plumbing (~68 keys) — deliberately NO decoding hyper-parameter | Platform admin, platform-wide only |

### 2.2 The regression — what the measurements say (not what the commits suggested)

**The suspect from the commit history is real but is not the accuracy regression.** On 2026-09-07 `2ffa4d601` (TASK-891 A5) raised `arcaai-whisper-large-ml-en-gguf` (f16) from `{maxDecodeWindowSec 7, partialWindowSec 6}` to `{30, 30}` after measuring 65–80 % word loss on long utterances; on 2026-09-08 `916cdc85d` (TASK-930) made `arcaai-whisper-large-ml-en-gguf-q8_0` the seeded agent's primary and demoted f16 to first fallback — the q8_0 row still carries `{7, 6}` (`audio.ts:173`; dev DB and all three `realtime-transcription` rows confirmed; `isPlatformDefaultFor` still on f16). That is seed drift and it is fixed in lane D. But measured on the live stack it does **not** move accuracy:

| Streaming scorecard (WS gateway, agent cascade, q8_0) | cardiology WER / keyterm | discharge WER / keyterm / deletions | medication WER / keyterm | commit p50 (3 clips) |
|---|---|---|---|---|
| **before** — row `{7, 6}`, adapter window 7 s | 0.033 / 1.0 | **0.274 / 0.5 / 14** | 0.197 / 0.75 | 2.9 / 2.8 / 4.3 s |
| row `{30, 30}` without STT restart (adapter still 7 s, partial window 30 s) | 0.033 / 1.0 | 0.274 / 0.5 / 14 | 0.197 / 0.75 | 4.8 / 5.2 / 5.8 s |
| row `{30, 30}` **with** STT restart (adapter 30 s) | 0.033 / 1.0 | 0.258 / 0.5 / 14 | 0.197 / 0.75 | 2.5 / 3.1 / 3.5 s |

Same words lost with a 7 s and a 30 s decode window; the window only moves latency. And on the Malayalam-English CER set (24 clips, `~/Downloads/ml-test`, `scripts/mlen_scorecard.py`) the 30 s window is **harmful**:

| ml-en CER (lower is better) | window 7 s | window 30 s | whole clip |
|---|---|---|---|
| `…-q8_0` (served primary) | **0.381** | 0.645 | 0.647 |
| `…` f16 (fallback; the committed gate baseline `0.325` is this model) | 0.386 | 0.6455 | 0.6472 |

So A5's `{30, 30}` on the f16 row doubled that model's Malayalam CER while fixing the long-English-utterance loss it was measured on; the two languages want different decode geometry, which is exactly why the profile must be per model and gated by both measurements (§3). Quantisation costs nothing here (q8_0 0.381 vs f16 0.386 at 7 s). The committed baseline `0.325` was captured with the priming prompt OFF (TASK-891 W1's own note), so the agent's `initialPrompt` costs roughly 0.06 CER on Malayalam — a third knob the profile must state per model (OD-11).

**What degraded for the user is the streaming partial lane.** Dumping every frame of one live session (discharge clip, served agent, `languageMode ml-en`, `partialWindowSec 6`):

```
2.36s partial t=0.00-0.77 stable=0 :: ൽ
3.57s partial t=0.00-2.37 stable=1 :: ൽ
5.17s partial t=0.00-3.90 stable=0 :: Jest. This is a discharge summary for a patient admitted with community-acquired
6.39s partial t=0.00-5.47 stable=0 :: യൽ, Dr
8.02s partial t=0.51-6.50 stable=3 :: യൽ, a discharge summary for a patient admitted with community-acquired pneumonia, the patient was treated …
9.03s partial t=2.05-8.03 stable=0 :: Jest, the patient was treated with intravenous sephotrioxone in transition
10.84s partial t=3.10-9.09 stable=46 :: Jest. The patient was treated with intravenous septrioxone and transitioned to oral imoxysm
12.50s partial t=5.25-11.23 stable=0 :: ekt was treated with intravenous septrioxone and transitioned to oral imoxicillin. oxygen saturation improved
14.05s … 21.81s partial (6 frames) :: Dr | Dr | ൽ കക്കും | ൽ കക്കും | ൽ, Dr | Dr
30.69s final t=0.00-24.32 :: this is a discharge summary for a patient admitted with community-acquired pneumonia. The patient was treated …
```

Ten of fourteen partials are garbage (Malayalam fragments, "Jest", "Dr"), the LocalAgreement commit never settles (`stable` mostly 0; `committed_revision_rate 0.05` against the 0.02 gate), and the clinician sees the transcript only when the whole-buffer final lands. Offline, on the same clip, the garbage rate is a function of the partial window: **31 % of 6 s windows, 10 % of 10 s windows, 0 % of 15 s windows** (sliding every 1.5 s, same prompt, same model). Explicit `language=en` produced byte-identical output to auto-detect on this fine-tune, so the TASK-891 W1 language routing (`ml-en` → `language=None`) is not the lever; the window is.

**The candidate profile was tried live and did not take effect.** With the q8_0 row at `{ maxDecodeWindowSec 7, partialWindowSec 15 }` and the stack restarted, the frame dump still showed 6 s partial windows (`t=0.06-6.05`, `1.12-7.10`, …, `18.02-24.00`) — `apps/stt/src/stt/streaming/preprocessor.py:86` `_DEFAULT_PARTIAL_WINDOW_S = 6.0` was what ran, so the value is lost somewhere between `specModelMetadata` (gateway), `pipeline_spec_from_resolved` (`spec.py:538`, `StreamingConfig.partial_window_s`) and the preprocessor kwargs (`session_manager.py:438`). Finals were unchanged (0.033 / 0.258 / 0.197), `committed_revision_rate` 0.14 / 0.11 / 0.21. Lane S owns finding and pinning that break; the 15 s window's benefit (0 % garbage offline) is therefore still an offline number, not a live one.

**One open item.** In two of three live runs the whole-buffer final of the discharge clip lost its opening sentence (14 deletions, "The patient was treated …" as the first words); in the third and in ten offline decodes of the session's own recorded audio it was present. Not the window (both tested), not the prompt (the agent's prompt decodes fully offline; only feeding the sentence itself back as prior text reproduces the loss, and the worker does not do that for a first final), not the audio (the session's raw and processed recordings decode fully). Non-deterministic; recorded in §4 OD-10 rather than guessed.

Two further findings, neither a cause: `resolve_engine_binding` (`apps/stt/src/stt/processors/binding.py:49-80`) logs `compute q4_k` for ANY GGUF model on `mps` (its vocabulary never matches whisper.cpp's; unchanged since 2026-07-25; the loaded weights are chosen strictly by the row's `computeType`); and the agent seed's `vad.minSpeechMs: 250` re-imposes the value the engine author retired in favour of 100 (`dto.py:589-593`).

### 2.3 What the platform admin cannot do today (R-4 gaps)

| # | Gap | Where |
|---|---|---|
| G-1 | `AiModel._metadata.asr.{maxDecodeWindowSec, partialWindowSec}` — the two knobs this ticket measured — have no admin write path (API or console) | `update-model.request.ts` (no `metaData`), `features/ai-models/components/model-form-sheet.tsx` (no ASR section) |
| G-2 | `no_speech_threshold`, `compression_ratio_threshold`, `logprob_threshold`, `condition_on_prev_tokens`, `no_repeat_ngram_size`, `prev_text_context_words`, `hotwords` — Python literals with no wire, no schema key, no descriptor | `dto.py:753-799`, `spec.py:228-249`, `asr-spec.ts:150-167` |
| G-3 | No per-MODEL recommended-parameter profile: a fine-tune's requirements live nowhere except `_metadata.asr`'s two keys, which G-1 makes unreachable | — |
| G-4 | The agent editor cannot show what the ASSIGNED model contributes (the effective value after the profile is applied) | `parameters-form.tsx` |
| G-5 | `AgentModelFallback` is written only through the agent's `fallbackModelSlugs` array; no per-entry enable/priority editing | agent editor |
| G-6 | A model-row change of the decode window is silently ignored by a running STT until restart (adapter-level cache); no operator signal | `whisper_cpp_asr.py:381` |
| G-7 | Global-kv ops knobs are platform-wide only (`maxScope: system`) — no per-model override (acceptable; recorded) | `stt-runtime.descriptors.ts` |

### 2.4 Measurement harnesses — state before this ticket

| Harness | State |
|---|---|
| Streaming quality scorecard (`apps/stt/tests/integration/test_streaming_quality_scorecard.py` + `streaming_thresholds.json`) | Self-skips on the current stack: `_create_session` posts the retired `pipelineId` (`81000000-…-000402`) → 404. Baseline captured 2026-07-12 on the pre-agent pipeline. Today's runs used a scratch pytest plugin that omits `pipelineId` (agent cascade); no repo edit |
| Malayalam-English CER gate (`test_mlen_quality_gate.py`, `mlen_scorecard_baseline.json`, `scripts/mlen_scorecard.py --max-audio-seconds`) | Baseline is f16 only (`mean_cer 0.325`, 23 clips); no q8_0 baseline; the gate's window is the script's argument, not the model row's value, so a row change cannot fail it |
| `apps/stt/scripts/benchmark_pipelines.py`, `scripts/stt-latency-replay.sh` | Reference `AsrPipeline` ids — pre-TASK-861 |
| Diarization DER/JER scaffold | No live baseline (model not staged) |

### 2.5 Measurement log (2026-09-09)

- Streaming scorecard, three runs (`stt-scorecard-before.json`, `…-after-q8_30.json`, `…-after-restart-q8_30.json` in the session scratchpad; per-clip numbers in §2.2). The dev row was set to `{30, 30}` for the experiment and restored to the seeded `{7, 6}`; the running STT still holds the 30 s adapter until its next restart.
- ml-en CER matrix (`mlen-<cell>.json`): q8_0@7 0.3809, q8_0@30 0.6453, f16@30 0.6455, q8_0@whole 0.647, f16@whole 0.6472, f16@7 0.3856.
- Frame dump of one live session (`dump_frames.py`) and the offline partial-window sweep (6/10/15 s) — §2.2.
- Live `{7, 15}` experiment (`stt-scorecard-after-q8_7_15.json` + a second frame dump) — the partial window stayed at the 6 s default (§2.2); f16@7 CER 0.3856. The dev row was restored to `{7, 6}` and the stack restarted afterwards.

## 3. Implementation Plan

Principles: measure first, then data, then the control surface that would have let an admin do this without a ticket. TDD RED→GREEN per lane; one writer per worktree; the orchestrator owns merges, DB, the stack and every restart. Tier per stage: `sonnet` for the seed/DTO/console mechanics, `opus` for the profile contract (P) and for judging the measurements.

### 3.1 Lanes

| Lane | Scope (files it OWNS) | Tests first (RED) | Tier |
|---|---|---|---|
| **M — measurement harness** | `test_streaming_loss_harness.py` (`_create_session` → `agentSlug` from `STREAM_AGENT_SLUG`, else the cascade; `pipelineId` only when `STREAM_PIPELINE_ID` is set explicitly); `streaming_thresholds.json` re-captured on the agent contract with an N-run median (OD-10); `mlen_scorecard_baseline.json` → per-model, per-window entries keyed by slug (`arcaai-whisper-large-ml-en-gguf-q8_0@7`, `…-gguf@7`), `test_mlen_quality_gate.py` selects by `WHISPER_MLEN_MODEL_SLUG` and reads the window from the SEEDED profile so a row change fails the gate; legacy `benchmark_pipelines.py` / `stt-latency-replay.sh` per OD-6 | harness unit test: session body carries `agentSlug` and never `pipelineId` by default; gate test: unknown slug → skip with reason; gate test: window comes from the profile | `sonnet` |
| **D — seed data (profile values)** | `seed/ai-models/audio.ts`: every `WHISPER_CPP` fine-tune row gets the MEASURED profile — candidate `{ maxDecodeWindowSec 7, partialWindowSec 15 }` for the ml-en rows (Malayalam CER 0.381 at 7 s vs 0.645 at 30 s; English partial garbage 31 % at 6 s vs 0 % at 15 s), the f16 row back from `{30, 30}`; `isPlatformDefaultFor` per OD-2; `25-agents.ts` `minSpeechMs` per OD-5; new seed test `task-934-asr-model-geometry.test.ts` | pins: every `AUTOMATIC_SPEECH_RECOGNITION` `WHISPER_CPP` row declares a profile; the platform-default ASR row IS the seeded `realtime-transcription` primary; profile values equal the committed gate baselines' windows | `sonnet` |
| **S — streaming partial quality** | `apps/stt/src/stt/streaming/session_manager.py` + `whisper_cpp_asr.py`: decouple `partialWindowSec` from `maxDecodeWindowSec` explicitly (the A5 comment says they "MUST match"; the measurements say the partial window wants 15 s and the final spans 7 s — the last partial and the final then decode different audio, so the LocalAgreement handover is measured, not assumed); rebuild the adapter's window when the resolved spec changes instead of caching it per pinned pipeline (G-6); **find and pin why `partialWindowSec` from the model row never reached the preprocessor in the live experiment** (the 6 s default ran); log both windows per session | STT unit tests: a spec with `partialWindowSec 15` yields a 15 s preprocessor window (RED today); partial window and decode window independently applied; a spec change is observed without restart | `opus` |
| **P — per-model ASR profile (the R-3 contract)** | `packages/types/src/asr-spec.ts` (`AsrSpecDecoding` gains `noSpeechThreshold`, `compressionRatioThreshold`, `logprobThreshold`, `conditionOnPrevTokens`, `noRepeatNgramSize`, `prevTextContextWords`, `hotwords` — OMITTED when absent, deploy-order-safe), new `AiModelAsrProfile` type + validator (`{ maxDecodeWindowSec, partialWindowSec, decoding?: {…}, initialPrompt? }`), `build-resolved-asr-spec.ts` (precedence per OD-3), `spec.py` mirror + `pipeline_spec_from_resolved` → `InferenceConfig`, the parity fixture, `agent-schemas.ts` (`SPEECH_TO_TEXT_PARAMETERS.decoding` + `streaming.partialWindowSec` with ranges per OD-4) | resolver test: profile fills what the agent left null, agent wins where set; fixture round-trips through both halves; `spec.py` `extra='forbid'` still rejects unknown keys; STT test: `InferenceConfig` receives `no_speech_threshold` from the wire | `opus` |
| **A — admin API + console** | `update-model.request.ts` / `create-model.request.ts` (`asrProfile?: AiModelAsrProfileRequest`, typed; only for `AUTOMATIC_SPEECH_RECOGNITION` rows — 400 otherwise), `aiModel.service.ts` (writes `_metadata.asr`, sys-event, OCC), `model.response.ts` (`asrProfile` on catalogue/inventory rows), console `model-form-sheet.tsx` ("ASR decode profile" section), `parameters-form.tsx` (effective-value hint per assigned model), the five API artifacts | API e2e `task-934-asr-profile.spec.ts`: PATCH → GET echoes; tenant admin → 403 on a SYSTEM row (platform tier, TASK-932 OD-3 posture); non-ASR row → 400; console unit tests for the section and the hint | `sonnet` |
| **O — observability** | `binding.py` (`resolve_engine_binding` prefers the row's declared `compute_type` for GGUF engines) | unit test: a q8_0 GGUF row on `mps` logs `compute q8_0` | `sonnet` |

### 3.2 Order

1. **M** (the ruler), then **S** with a dev-DB experiment under OD-8: q8_0 row `{7, 15}`, STT restarted, scorecard + frame dump + CER gate → the numbers decide D's values.
2. **D** (seed) + reseed; **P** (contract) → **A** (surface); **O** independent.
3. Gates (§5), README, archive-move decision.

### 3.3 Best practices this encodes for fine-tuned models (R-3)

- A registered fine-tune carries its own decode profile on its `AiModel` row — window geometry, the thresholds it was validated with, an optional `initialPrompt` — so the parameters travel with the weights, not with the agent that binds them, and a quantisation swap can never silently change decode geometry again.
- Profile values are MEASURED, per language mode, with the two gates (English streaming scorecard; Malayalam-English CER), and the gates read the window from the profile — a row edit that regresses either gate is red in CI.
- Every quality-deciding knob has a wire path and a range; the engine dataclass keeps defaults only as the last fallback.
- Streaming and final decode geometry are two knobs, not one: partial windows want to be long enough for the language model to settle (15 s here), final spans short enough for the fine-tune not to drift (7 s here).

## 4. Owner decisions — answer before "go" (recommendation first)

| Id | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | Decode geometry for the ml-en fine-tune rows (q8_0 primary, f16 fallback, and the two `whisper-large-en-medical-…-gguf*` rows) | (a) `{7, 15}` everywhere, measured; (b) keep A5's `{30, 30}` on f16 and copy it to q8_0; (c) `{7, 6}` as today | **(a)** — 30 s doubles Malayalam CER on both quantisations; 6 s partials are 31 % garbage on English; the final experiment in §3.2 step 1 confirms before the seed lands |
| OD-2 | `isPlatformDefaultFor: SPEECH_TO_TEXT` | (a) move to q8_0 (the row the seeded agent serves); (b) keep on f16 | **(a)**, plus the seed pin "platform default == seeded primary" |
| OD-3 | Precedence when both the agent and the model profile set a decode knob | (a) agent → model profile → engine default; (b) model profile wins | **(a)** — the tenant-authored agent stays sovereign (rule 2); the agent editor shows the effective value |
| OD-4 | Expose the hidden decode knobs at the AGENT level too, or model-profile only? | (a) both, range-validated; (b) profile only | **(a)** |
| OD-5 | `realtime-transcription` seed `vad.minSpeechMs` | (a) 250 (today); (b) 100 (engine consensus) | **(b)**, subject to keyterm recall not regressing in the M gate |
| OD-6 | Legacy `benchmark_pipelines.py` / `stt-latency-replay.sh` | (a) re-point at agent slugs; (b) delete | **(b)** |
| OD-7 | Register the cached `q5_0` GGUF as a row? | (a) yes; (b) out of scope | **(b)** |
| OD-8 | Dev-DB experiments before the seed lands (`UPDATE core."AiModel" SET _metadata` on the q8_0 row + STT restart), reversible, dev only | (a) yes; (b) wait for the seed | **(a)** — two such experiments were already run today and restored; the `{7, 15}` one is the deciding measurement |
| OD-9 | Ticket number | TASK-934 | confirm |
| OD-11 | The agent's `initialPrompt` on the Malayalam set (≈ +0.06 CER vs the prompt-off baseline) | (a) keep the prompt, re-baseline the gate with it on; (b) drop it from the seeded agent; (c) make it part of the per-model profile and measure both | **(c)** — the prompt is a per-fine-tune property, not an agent-wide truth |
| OD-10 | The non-deterministic opening-sentence loss on the whole-buffer final (2 of 3 live runs) | (a) investigate first (repeat-run study on Metal, `extract_probability`, first-segment entropy); (b) accept as run-to-run variance and gate on an N-run median | **(a) inside lane S, time-boxed to one day**; the gate uses an N-run median either way |

## 5. Verification criteria

- Seed tests green incl. the new profile pins; `pnpm --filter @arcaai/database test`.
- `pnpm --filter @arcaai/applications test` (resolver + DTO), `pnpm stt:test` (spec mirror, `InferenceConfig` mapping, window decoupling, binding log), parity fixture round-trip.
- API e2e `task-934-asr-profile.spec.ts` green; the five API artifacts regenerated together; `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` green.
- Console: `pnpm --filter @arcaai/admin-console build lint test` green; axe 0 on the model sheet.
- **Live proofs:** streaming scorecard through the agent cascade — partial garbage rate under 10 %, `committed_revision_rate` within the re-captured gate, WER and keyterm recall at or better than today's finals, commit p50 not worse than 15 %; ml-en CER gate — per-model baselines at the profiled window committed, both within the ceiling; the TASK-932 microphone journey still green.
- `lint:all`, `typecheck:all`, `env:sync:check` green.

## 6. Implementation Summary

_Pending._

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-09 | Ticket opened after the owner's request. One read-only discovery lane (`sonnet`) mapped the parameter chain, the recent commits, the harnesses and the admin surface; the orchestrator re-verified every load-bearing claim against the seed, the dev DB and today's STT log, then measured: three live scorecard runs (before / `{30,30}` / `{30,30}` + restart), a five-cell Malayalam-English CER matrix, a frame dump of one live session, an offline partial-window sweep, and offline decodes of the session's own recordings. The commit-history suspect (decode window drift between the f16 and q8_0 rows) proved real but latency-only; the user-visible degradation is the 6 s partial window's garbage rate under the ml-en mode, and the 30 s window is harmful on Malayalam. Plan §3, decisions §4. |
