# TASK-1010 — vLLM Whisper with continuous batching for 25 concurrent streams (spike)

**Status:** In Progress
**Type:** infrastructure (measurement spike → go/no-go)
**Branch:** `dev-2.2`
**Sibling:** TASK-1009 (faster-whisper arm). Pass bar and ladder are shared — see TASK-1009.

## Requirement Analysis

Same target and pass bar as TASK-1009: **≥ 25 concurrent realtime streams**, commit p99 ≤ 15 s,
ml-en accuracy no worse than the current whisper.cpp model, VRAM within the OD-1 budget, no STT
restarts. The current engine is serial per model (TASK-1007; `whisper_cpp_asr.py:133-136`).

This ticket evaluates **vLLM** serving the ml-en Whisper fine-tune, relying on vLLM's
**continuous batching across requests** — the only low-effort engine found with native
cross-stream batching.

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

Research findings (2026-09-29, docs/issues — not measured):

- Supported architecture `WhisperForConditionalGeneration` (whisper-small … large-v3-turbo);
  no LoRA, no pipeline parallelism.
- `/v1/audio/transcriptions` supports `language`, `prompt`, `verbose_json` segment timestamps;
  a realtime PCM16 16 kHz API is listed in the docs. Beam search is inefficient for enc-dec.
- Limits that matter to us:
  - 30 s max clip (vllm-project/vllm#15012) — our ~7 s windows fit.
  - **Silent audio drop when the decoder stops early inside a chunk (vllm-project/vllm#53144)** —
    must be tested explicitly on the ml-en fixtures.
- Quantisation: nothing Whisper-specific documented. Generic `--quantization fp8` (Ada has FP8)
  is untested for Whisper; treat as a stretch arm.
- Custom checkpoint: an HF-format fine-tune of the same architecture should load with
  `vllm serve <dir>` (inferred, verify).
- No published concurrent-stream numbers for vLLM Whisper.
- Integration shape to decide: STT keeps sessions/segmentation and calls vLLM as a decode
  backend (a new engine behind the agent spec), vs. vLLM's own realtime API.
- The cluster already runs a `vllm` workload profile (`base/vllm.yaml` in the deployment repo);
  GPU slices are fully allocated (6/6), so a vLLM ASR pod needs a slice given back or a card.

## Open Decisions (owner)

| # | Question |
|---|---|
| OD-1 | GPU budget: dedicated card, or a time-slice (shared with LM Studio)? (same as TASK-1009 OD-1) |
| OD-2 | Accept FP8 if WER holds, or fp16 only? |
| OD-3 | Integration: vLLM as a decode backend called by STT (keeps our session/metering/lexicon path), or vLLM's realtime API directly? |
| OD-4 | Spike deployment: local-only bench first, or a temporary cluster pod (deployment repo change)? |

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

**Decisions (owner go, 2026-09-29):** **OD-3 resolved — vLLM runs as a NEW service** (`apps/asr-vllm`, package `asr_vllm`, port 8867), called by STT as a decode backend; STT adapter comes after the direct bench. OD-1/OD-2/OD-4 stay open until the GPU run.

## Implementation Plan (draft — pending OD round)

1. Serve the ml-en HF checkpoint with vLLM (fp16) on the cluster GPU; smoke `/v1/audio/transcriptions`.
2. Offline accuracy on the TASK-994 fixtures vs whisper.cpp baseline; explicit check for #53144
   (truncated output on windows with early EOS).
3. Concurrency bench: 25 streams' windows submitted concurrently to vLLM directly (no STT) —
   per-window latency, throughput, VRAM, SM activity.
4. If step 3 passes: thin STT engine adapter (vLLM decode backend) and the full
   `stream_ladder.py` run 1…32.
5. Stretch: `--quantization fp8`, re-check WER.
6. Scale-out probe: 2 vLLM replicas behind a router if hardware allows; streams/GPU, linearity, cold start.
7. Go/no-go write-up against the pass bar AND the 1,000-stream projection (GPUs needed, cost/stream), side by side with TASK-1009.

## Implementation Summary

_Not started._

## Change History

- 2026-09-29 — Owner: 25 streams is milestone 1, design target 1,000; added scale-out criteria.
- 2026-09-29 — Ticket opened from the TASK-1007 follow-up research (whisper.cpp batching limits,
  faster-whisper/vLLM survey).
