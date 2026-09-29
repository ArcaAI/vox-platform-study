# TASK-1009 — faster-whisper (CTranslate2) batched ASR for 25 concurrent streams (spike)

**Status:** In Progress
**Type:** infrastructure (measurement spike → go/no-go)
**Branch:** `dev-2.2`
**Sibling:** TASK-1010 (vLLM arm of the same comparison). Both share the pass bar and ladder below.

## Requirement Analysis

Target: **≥ 25 concurrent realtime STT streams** per deployment. TASK-1007 measured the current
engine (whisper.cpp, ml-en large-v3 f16 GGUF): realtime-grade to N≈10 on one cluster GPU slice,
functional to N=24, collapses at N=32. Root cause: one shared whisper.cpp context per model behind
one lock (`apps/stt/src/stt/streaming/whisper_cpp_asr.py:133-136, 220-226`) — decodes are strictly
serial, and whisper.cpp has no cross-request batching (upstream `examples/server` also serialises
behind a mutex; multi-state decode on CUDA has a thread-safety report, ggml-org/whisper.cpp#1814).

This ticket evaluates **faster-whisper / CTranslate2** with **cross-stream batching** and
**int8 quantisation** as the replacement decode lane.

### Pass bar (shared with TASK-1010)

| Metric | Bar |
|---|---|
| Concurrency | 25 streams, 60 s fixture each, real time (`tests/load/streams/stream_ladder.py`) |
| Latency | commit p99 ≤ 15 s, first partial p50 ≤ 3 s, all sessions `closed && coverage ≥ 0.9` |
| Accuracy | ml-en WER/CER no worse than current whisper.cpp model on the TASK-994 fixtures |
| VRAM | fits the GPU budget decided in OD-1 without disturbing LM Studio |
| Stability | no STT restarts during the run (D-2/D-3 from TASK-1007 fixed or excluded) |

### Scale target (owner, 2026-09-29)

**25 concurrent streams is milestone 1; the design target is 1,000 concurrent streams.** The
spike therefore judges an engine on how it scales out, not only on whether one GPU reaches 25:

| Question the spike must answer | Why it matters at 1,000 |
|---|---|
| **Streams per GPU** at the pass bar (fp16 and quantised) | sets the fleet size: 1,000 / streams-per-GPU = GPUs needed (e.g. 40/GPU → 25 GPUs, 100/GPU → 10) |
| **Cost per stream** (GPU-hours per stream-hour) | the number the owner decides hardware on |
| Can the decode tier run as a **separate, horizontally scaled service** (N replicas, any node) with the STT session tier routing windows to it? | the current single-process, single-node shape cannot reach 1,000 |
| Does throughput scale **linearly with replicas** (2 replicas ≈ 2×)? | verify with at least 2 replicas / 2 GPUs if hardware allows |
| **Autoscaling signal** (queue depth / batch wait) and cold-start time of a new replica (model load) | scale-out must add capacity, not restarts (TASK-1007 F-5) |

Out of scope here, but recorded so it is not lost — 1,000 streams also needs, independent of the
engine: a multi-node GPU cluster (today one k3s node, 6 time-sliced slices); STT session tier
horizontally scaled with sticky WS routing; Redis sized for ~2 blocking reads per stream
(TASK-1007 D-3 → ~2,000+ connections); gateway WS fan-in across replicas; the Cloudflare tunnel
burst limits (TASK-1007 F-6); liveness decoupled from decode (D-2); metering that survives
restarts (M-3). These belong to a separate scale-out architecture ticket after the engine choice.

## Current State Evaluation

- `apps/stt/src/stt/models/faster_whisper_loader.py` already exists — a partial engine path; audit
  what it covers (format enum, spec resolution, streaming adapter?) before writing anything.
- Research findings (2026-09-29, docs — not measured):
  - `BatchedInferencePipeline` batches chunks of ONE file; it does **not** batch independent
    requests. Cross-stream batching needs our own batch builder over CT2
    `ctranslate2.models.Whisper.generate` (accepts a batch of features).
  - CT2 releases the GIL; one model can serve concurrent callers; `inter_threads` gives
    weight-sharing workers on separate CUDA streams (docs caveat: may not raise throughput).
  - Quantisation on GPU: `float16`, `int8_float16` (≈ half weight VRAM); `bfloat16`
    variants on Ampere+ (unverified).
  - Fine-tune conversion: `ct2-transformers-converter --model <hf_dir> --copy_files tokenizer.json
    preprocessor_config.json --quantization int8_float16` — large-v3 needs the 128-mel
    preprocessor config; verify ml/en language tokens survive.
  - Streaming servers on it (WhisperLiveKit, WhisperLive) share one model but decode serially.

## Open Decisions (owner)

| # | Question |
|---|---|
| OD-1 | GPU budget for the spike/target: dedicated card for ASR, or keep the shared time-slice with LM Studio? |
| OD-2 | Quantisation floor acceptable if WER holds: `int8_float16`, or fp16 only? |
| OD-3 | Spike runs outside the product first (standalone bench script), or directly as an STT engine behind the agent spec? |

### Facts established 2026-09-29 (orchestrator)

- The ml-en fine-tune is **Whisper large-v3-TURBO** based (4 decoder layers), not full large-v3.
  Three published forms (seed `packages/database/src/prisma/db_main/seed/ai-models/audio.ts`):
  HF safetensor fp16 `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16`
  (slug `arcaai-whisper-large-ml-en`), CTranslate2 `…-2607.29.1-ct2` (slug
  `arcaai-whisper-large-ml-en-ct2`), and the GGUF the cluster serves today. Private HF repos.
- `apps/stt/src/stt/streaming/faster_whisper_asr.py` + `models/faster_whisper_loader.py` already
  exist (per-window adapter over `WhisperModel` / `BatchedInferencePipeline`).
- No NVIDIA GPU is available locally (Mac, MPS). Lane work = code + unit tests + CPU functional
  checks; the GPU ladder waits for the GPU-budget decision (multi-GPU discussion deferred by owner).

**Decisions (owner go, 2026-09-29):** work starts now in a worktree lane. OD-3 default taken: the batcher is built INSIDE `apps/stt` behind a flag (off by default); OD-1/OD-2 stay open until the GPU run.

## Implementation Plan (draft — pending OD round)

1. Audit `faster_whisper_loader.py` + engine enum; list what's missing for streaming.
2. Convert the ml-en HF checkpoint to CT2 (fp16 and int8_float16); check tokenizer/lang tokens.
3. Offline accuracy: run the TASK-994 fixtures through both conversions vs whisper.cpp baseline.
4. Batch builder: collect ready ~7 s windows across sessions, `generate` in one batch
   (max batch / max wait ms as settings), fan results back per session.
5. Ladder on the cluster GPU (1…32) for fp16 and int8_float16; record VRAM, GPU SM activity,
   commit latency.
6. Scale-out probe: decode tier as its own service, 2 replicas if hardware allows; streams/GPU, linearity, cold start.
7. Go/no-go write-up against the pass bar AND the 1,000-stream projection (GPUs needed, cost/stream), side by side with TASK-1010.

## Implementation Summary

### Lane W-1 (2026-09-29) — cross-stream batching in `apps/stt`, OFF by default

Worktree `hope-v2-task-1009`, branch `task-1009/faster-whisper-batch` (cut from `dev-2.2` @
`4e9fbeb33`). Code + unit tests + a CPU functional bench; the GPU ladder is still open.

#### Audit (what exists, what the live path actually does)

| Finding | Evidence |
|---|---|
| The engine path is complete end to end. A `FASTER_WHISPER` `AiModel` row reaches stt through `ResolvedAsrSpec` (`pipeline/spec.py` maps `format` → `AiModelFormat` → `ModelCache` → `FasterWhisperLoader`); the seed carries `arcaai-whisper-large-ml-en-ct2` (format `FASTER_WHISPER`, HF id `…-2607.29.1-ct2`), but **no seeded agent binds it**. | `seed/ai-models/audio.ts:325-333` |
| Each session wraps the shared `LoadedModel` in its own `FasterWhisperAsrAdapter`; the async callable runs every window with `asyncio.to_thread(adapter, …)`. No Python lock (unlike whisper.cpp); CTranslate2 with its default single worker queues concurrent calls internally — so decodes are serial per model all the same. | `session_manager.py:_make_faster_whisper_callable` |
| The loader ALWAYS builds a `BatchedInferencePipeline`, so every live decode goes through `BatchedInferencePipeline.transcribe` — which batches the chunks of ONE call, never independent calls. | `faster_whisper_loader.py:_load_sync` |
| **That path honours fewer knobs than the adapter declares.** It decodes at the first temperature only (no fallback ladder), forces `condition_on_previous_text` off, and never applies the compression-ratio / log-prob / no-speech gates; `unsupported_decode_knobs` reports only `entropyThreshold`. Pre-existing; batching inherits exactly the same semantics, neither adding nor removing any. | faster-whisper 1.2.1 `transcribe.py:254-575` |
| Per-call knobs the streaming path sends: `task`, `language` (pinned, or `None` = LID), `word_timestamps=True`, `beam_size`, `temperature`, the three gates, `condition_on_previous_text`, `no_repeat_ngram_size`, `vad_filter` (spec default off), `initial_prompt` (priming + carry-forward on finals only). No `pass_kind`, no decode window. | `faster_whisper_asr.py`, `inference.py:_compose_bounded_prompt` |
| Pre-existing race: concurrent sessions share one `BatchedInferencePipeline` whose `last_speech_timestamp` is instance state mutated per call. | `transcribe.py:159-168, 616` |
| **CTranslate2 refuses a batch whose `<|startoftranscript|>` positions differ** (`ValueError … same position in all batches`), i.e. prompts of different length cannot share one `generate`. | probe on the converted model |
| **The ml-en fine-tune is English-only to CTranslate2.** Its vocabulary is pruned to 25,211 tokens (stock multilingual Whisper: 51,865+), and CTranslate2 reports `is_multilingual = False` for it (observed; CT2 infers it from the vocabulary): a pinned `ml` is coerced to `en` with a warning and the prompt carries no language/task tokens. The model still emits Malayalam script, but accuracy on this path is unmeasured against the whisper.cpp baseline. | converted locally; `is_multilingual False`, `sot_sequence [23603]` |

#### Design

* `streaming/cross_stream_batcher.py` — engine-agnostic `CrossStreamBatcher`, one per loaded model
  (stored on `LoadedModel.extra`, closed by `FasterWhisperLoader.unload`). One flusher thread
  groups requests by key, flushes a group at `maxBatchSize` or when its oldest request has waited
  `maxWaitMs`, runs one decode with the lock released, fans results back to per-caller
  `concurrent.futures.Future`s. Batches run one at a time per model (one device). Per-item
  exceptions fail only their caller; a batch that raises (or returns the wrong count) is re-decoded
  item by item so one bad window cannot fail its batch-mates. Bounded queue → `BatchQueueFullError`
  immediately; cancelled requests (session gone) are skipped.
* `streaming/faster_whisper_batch_decoder.py` — `FasterWhisperBatchDecoder` replays
  `BatchedInferencePipeline`'s single-window path for N windows: mel features → optional batched
  LID (same `-1.5` pad frame the per-call detector uses) → ONE encoder pass per flush →
  `generate` sub-grouped by `<|startoftranscript|>` position (encoder output copied to CPU and
  sliced only when there is more than one group) → timestamp split → alignment once per language
  partition, with `last_speech_timestamp = 0` per window → the library's own restore step. The
  faster-whisper helpers and the per-call defaults are read from the installed library (lazy
  `ops` namespace), so an upgrade moves both paths together and CI (no `ml` extra) imports it.
* **Grouping key** (`FwBatchKey`) = task + language (pinned value or `None`) + every decode knob
  the adapter sends. Two sessions whose agent config differs in anything never share a decode.
* **Preserved vs serial:** text, language, per-session prompt, per-session language (auto-LID
  partitions), segment/word shape, the restore step, all semantics of the live per-call path.
  **Not guaranteed:** bit-identical numerics — batch composition moves some word boundaries by
  one alignment frame (see bench). **Bypass** (per-call path, unchanged): engine-side
  `vad_filter`, windows ≥ the model's chunk length (30 s), empty windows.
* `SessionManager._make_faster_whisper_callable` reads the settings once per session; when on,
  it awaits the batch with `asyncio.wrap_future` so a session waiting for batch-mates holds no
  worker thread (at 25–1,000 streams, `to_thread` + a blocking wait would exhaust the default
  executor). Off → `asyncio.to_thread(adapter, …)` exactly as before.

#### Settings (control plane; `global-kv`, platform scope, `open-to-default`, env path closed)

| Key | Settings field | Default |
|---|---|---|
| `stt.fasterWhisper.batch.enabled` | `faster_whisper_batch_enabled` | `false` |
| `stt.fasterWhisper.batch.maxBatchSize` | `faster_whisper_batch_max_batch_size` | `8` |
| `stt.fasterWhisper.batch.maxWaitMs` | `faster_whisper_batch_max_wait_ms` | `25` |
| `stt.fasterWhisper.batch.maxQueue` | `faster_whisper_batch_max_queue` | `256` |

`maxQueue` is a fourth key beyond the three first proposed: the queue bound is required and is
configuration, so it is not a literal. A non-positive served limit turns batching OFF for the
session with a warning (`stt.asr_batch.invalid_limits_batching_off`) rather than failing it.
Applies to sessions started after a change; limits changes reconfigure the shared batcher.

#### Metrics (label `model`)

`stt_asr_batch_size` (histogram), `stt_asr_batch_queue_wait_seconds` (per window),
`stt_asr_batch_decode_seconds` (per batch), `stt_asr_batch_queue_depth` (gauge — the
scale-out signal).

#### CPU bench (Mac, relative only)

`apps/stt/scripts/bench_fw_cross_stream_batch.py`, Apple M3 Max, CTranslate2 4.8.1 on CPU,
`compute_type=int8`, `cpu_threads=4`, greedy (`beam_size=1`, `temperature=0`), `language=ml`,
N windows of 7.0 s taken from N different TASK-994 Woodman clips (0001…0008). Serial = the shipped
per-call path one window after another; batched = N adapters sharing one batcher, one flush.

**Model: the REAL ml-en fine-tune, converted locally** — the published
`taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-ct2` could not be fetched (the local HF
token returns 401), so the cached HF checkpoint
`taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1` (same fine-tune, fp32 safetensors) was
converted with `ct2-transformers-converter --quantization int8 --copy_files tokenizer.json
preprocessor_config.json` into the scratchpad (752 MB). Not byte-identical to the published CT2
artefact; same weights.

Prompts `none` (every window unprompted → one `generate`):

| N | serial (s) | batched (s) | speed-up | serial RTF | batched RTF | text identical | windows with identical word timings | identical word timings |
|---|---|---|---|---|---|---|---|---|
| 1 | 5.43 | 5.50 | 0.99× | 0.78 | 0.79 | 1/1 | 1/1 | 100 % |
| 2 | 10.79 | 10.46 | 1.03× | 0.77 | 0.75 | 2/2 | 2/2 | 100 % |
| 4 | 22.17 | 20.34 | 1.09× | 0.79 | 0.73 | 4/4 | 3/4 | 97.4 % |
| 8 | 44.34 | 40.02 | 1.11× | 0.79 | 0.72 | 8/8 | 4/8 | 91.7 % |

Prompts `mixed` (every other window carries a carry-forward prompt → two `generate` groups per
flush, encoder still shared, encoder output copied to CPU and sliced):

| N | serial (s) | batched (s) | speed-up | serial RTF | batched RTF | text identical | windows with identical word timings | identical word timings |
|---|---|---|---|---|---|---|---|---|
| 2 | 10.61 | 10.67 | 0.99× | 0.76 | 0.76 | 2/2 | 1/2 | 90.9 % |
| 4 | 21.37 | 19.93 | 1.07× | 0.76 | 0.71 | 4/4 | 3/4 | 92.9 % |
| 8 | 42.66 | 41.13 | 1.04× | 0.76 | 0.73 | 8/8 | 4/8 | 89.1 % |

Total bench wall time ≈ 5 min (166 s + ~150 s), four CPU threads.

Reading: **correctness holds** — batched text equals serial text on every window; word timings
differ only by alignment-frame jitter (≤ 20 ms on the words that moved, probed on N=3) from
batch-dependent numerics. **Throughput on CPU barely moves (≤ 1.11×)**, as expected: a CPU GEMM
at four threads is already compute-bound at batch 1, so a batch only saves per-call overhead.
These numbers are relative and say nothing about a GPU, where the encoder is latency-bound at
batch 1 and batching is the whole point.

#### What the GPU run must still prove

1. **The speed-up itself.** CPU cannot show it (see bench); the claim rests on the GPU encoder
   amortising a batch. Ladder 1…32 streams with batching on, fp16 and `int8_float16`, against the
   TASK-1007 pass bar; tune `maxBatchSize` / `maxWaitMs` there.
2. **VRAM per batch.** Every window is a full 30 s encoder input (Whisper pads), so batch memory
   scales with `maxBatchSize`, not with window length.
3. **Accuracy of this model on this engine** (the English-only coercion above) against the
   whisper.cpp baseline on the TASK-994 fixtures — this can fail the spike independently of
   throughput. Check first whether the published `…-ct2` repo has the same pruned vocabulary.
4. Share of finals that split `generate` because their carry-forward lengths differ (the encoder
   is still shared; the 4-layer turbo decoder is the cheap half) — read it off
   `stt_asr_batch_decode_seconds` vs batch size.
5. Queue-depth behaviour under overload (the `maxQueue` refusal path) and whether one flusher per
   model leaves the GPU idle during CPU feature extraction (a pipelining follow-up if so).

## Change History

- 2026-09-29 — Lane W-1 (`task-1009/faster-whisper-batch`): audit; `CrossStreamBatcher` +
  `FasterWhisperBatchDecoder`; wired into the faster-whisper adapter behind
  `stt.fasterWhisper.batch.*` (off by default); four batch metrics; CPU bench script
  `apps/stt/scripts/bench_fw_cross_stream_batch.py` and relative CPU numbers. Post-merge
  (orchestrator, out of lane scope): `pnpm env:python-surface && pnpm env:sync` for the four new
  `__MOVED_TO_CONTROL_PLANE` aliases (touches `turbo.json` and the generated env files).
- 2026-09-29 — Owner: 25 streams is milestone 1, design target 1,000; added scale-out criteria.
- 2026-09-29 — Ticket opened from the TASK-1007 follow-up research (whisper.cpp batching limits,
  faster-whisper/vLLM survey).
