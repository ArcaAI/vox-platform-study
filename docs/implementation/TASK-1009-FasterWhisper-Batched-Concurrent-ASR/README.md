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

_Not started._

## Change History

- 2026-09-29 — Owner: 25 streams is milestone 1, design target 1,000; added scale-out criteria.
- 2026-09-29 — Ticket opened from the TASK-1007 follow-up research (whisper.cpp batching limits,
  faster-whisper/vLLM survey).
