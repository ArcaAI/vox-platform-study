# TASK-1007 — Stream concurrency stress test & OOM check (local, then cluster)

**Status:** Review
**Type:** infrastructure (measurement)
**Branch:** `dev-2.2`

## Requirement Analysis

Start the services and stress them at **1, 2, 4, 8, 10, 12, 15, 20, 24, 32, 64** concurrent
users/streams — locally first, then on the k3s cluster — while monitoring resource consumption.
The question to answer: **is there any out-of-memory failure**, and where does each deployment
degrade?

Owner decisions (2026-09-28):

| # | Decision |
|---|---|
| OD-1 | Load unit: **both**, STT-only first — (a) one realtime `/ws/stt/stream` session per user, then (b) a full consultation per user |
| OD-2 | Above the STT stream cap, **raise the cap for the test** (`stt.streaming.maxConcurrent` = 64 at the SYSTEM tier), restore afterwards |
| OD-3 | Cluster run is driven **from this Mac through the ingress** (Cloudflare tunnel → Traefik → gateway) |
| OD-4 | Tracked as TASK-1007; driver lives in `tests/load/streams/` |

## Current State Evaluation

- `tests/load/` (TASK-993) generates HTTP load only — its README states no audio, SSE or WS load
  is generated and the STT stream ceiling is untouched.
- `apps/stt/tests/integration/test_streaming_loss_harness.py` drives ONE realtime session through
  the WS gateway; its feed/receive/metrics helpers are reused unchanged.
- STT refuses streams above `CapacityGuard`'s `max_concurrent_streams` (503). Auto-detect gives
  **15** on this Mac (MPS, 48 GB unified), **20** on the A2000 dev profile. The control-plane
  override is read at STT **startup** only, so a raise needs an STT restart.
- On Apple Silicon RSS misses Metal/MPS buffers — the sampler uses `top`'s MEM (physical
  footprint) per process tree.

## Implementation Plan

1. `tests/load/streams/stream_ladder.py` — for each N, open N sessions concurrently, replay a
   60 s 16 kHz WAV in real time per session, collect per-session create status, first-partial and
   commit latency, finals, seq loss; drain (`stt_streaming_sessions_active == 0`) + 20 s cooldown
   between steps. A background thread samples every 2 s: footprint + CPU per supervised service
   process tree, LM Studio, the Docker VM, per-container memory, swap, pressure level, free %.
2. Local ladder (STT-only) → local ladder (full consultation) → cluster ladder (STT-only) →
   cluster ladder (full consultation). Cluster memory via Rancher MCP (`kubernetes_top`, pod
   `lastState.terminated.reason == OOMKilled`, restart counts).
3. Restore `stt.streaming.maxConcurrent` to its prior value on both tiers.

## Implementation Summary

### Verdict

**No service ran out of memory because of the streaming/consultation path at any level
(1 → 64).** STT, gateway, Redis, text, harness and LM Studio all stayed far under their limits
on both deployments. What fails first is **throughput and liveness**, not memory — and the
test surfaced **three real OOM/near-OOM conditions on the cluster** in supporting services:

| # | Where | Finding | Evidence |
|---|---|---|---|
| **O-1** | cluster `tempo` | **OOMKilled ×3 during the test** (4 restarts in 95 min) | limit 512 MiB, working set 503–512 MiB; kills at 16:42, 16:56, 16:58 UTC (consultation N=32 / N=64) |
| **O-2** | cluster `hope-minio-0` | **99 % of its memory limit for the whole run** + liveness/readiness failures (×26/43/46, ×53/76/113) | limit 1 GiB, working set 1,013 MiB flat |
| **O-3** | cluster `hope-nlp` | **OOMKilled before the test** (2026-09-25 10:48Z, exit 137); idles at 3.1–3.2 GiB of a 4 GiB limit (78 %) | `lastState.terminated.reason: OOMKilled` |

### Failure ladder — what breaks first, in order

| # | Ceiling | First seen | Deployment | Mechanism |
|---|---|---|---|---|
| F-1 | **ASR throughput** | N≈4 local / N≈10 cluster | both | one decode device; commit latency grows linearly past it. Mac: Metal has no decode concurrency. Cluster: GPU util 97–98 % from N=8 |
| F-2 | **Realtime quality cliff** (`closed && coverage ≥ 0.9` fails) | N=20 local (0/20) / N=32 cluster (3/32) | both | decode backlog outlasts the stream; no transport loss (zero seq gaps) |
| F-3 | **STT liveness kills** | consultation N=12 on cluster | cluster | `/api/v1/health/live` misses its 5 s timeout under load → kubelet SIGTERM → clean exit 0 (`Completed`). **All 16 historical `hope-stt` restarts are this** ("failed liveness probe, will be restarted" ×16; readiness failed ×245). Restarts at 16:54, 17:17, 17:35 UTC killed live consultations |
| F-4 | **STT Redis connection pool** | between N=32 and N=64 | both | `redis.asyncio` 8.1 defaults `max_connections=100`; `stt/streaming/_runtime.py:102` sets none; each session holds ~2 blocking reads (XREADGROUP + control XREAD). Local N=64: 25 creates → gateway 502 (STT 500). Cluster N=64: 1,956 "Too many connections", **323 "Failed to publish result"** (transcripts dropped), 9 Redis health-check failures |
| F-5 | **NLP autoscaling churn** | consultation N=8+ | cluster | HPA scaled `hope-nlp` 1→3 (10 pods cycled); new replicas are **liveness-killed while lazily loading model weights** on first request, so scale-out adds restarts instead of capacity |
| F-6 | **Cloudflare tunnel** on bursts | N=64 | cluster | 5 (STT) / 12 (consultation) session-creates answered by a Cloudflare HTML 502 — never reached the gateway |

### Local — Mac (M-series, 48 GB unified, MPS), dev stack

STT ladder, 60 s of the Malayalam fixture per stream, real time. Memory is **physical
footprint** (`top` MEM; RSS misses Metal buffers).

| N | good | cov p50 | 1st partial p50 | worst commit p99 | STT | gateway | Docker VM | LM Studio | sys free min | pressure |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 1.00 | 1.2 s | 5.5 s | 2.54 GB | 1.92 GB | 7.8 GB | 2.4 GB | 51 % | normal |
| 2 | 2 | 1.00 | 1.4 s | 6.4 s | 2.54 | 1.88 | 7.8 | 2.4 | 49 % | normal |
| 4 | 4 | 1.00 | 1.6 s | 20.7 s | 2.57 | 1.77 | 7.8 | 2.6 | 48 % | normal |
| 8 | 8 | 1.00 | 2.2 s | 73.9 s | 2.61 | 1.83 | 7.9 | 3.0 | 44 % | normal |
| 10 | 10 | 1.00 | 2.6 s | 66.3 s | 2.60 | 1.84 | 8.0 | 2.8 | 44 % | normal |
| 12 | 12 | 1.00 | 2.6 s | 67.3 s | 2.66 | 1.86 | 8.0 | 2.8 | 51 % | normal |
| 15 | 15 | 1.00 | 2.9 s | 103 s | 2.64 | 1.88 | 8.2 | 2.8 | 50 % | normal |
| 20 | **0** | 0.89 | 4.0 s | 123 s | 2.65 | 1.90 | 8.1 | 2.8 | 55 % | normal |
| 24 | 0 | 0.76 | 4.6 s | 119 s | 2.74 | 1.88 | 8.1 | 2.8 | 51 % | normal |
| 32 | 0 | 0.56 | 5.8 s | 86 s | 2.81 | 1.90 | 8.3 | 2.8 | 46 % | normal |
| 64 | 0 | 0.14 | 74.7 s | 116 s | **3.15** | 1.87 | 8.2 | 2.8 | 47 % | normal |

N=64: 25/64 session creates → 502 (F-4). No process died at any step.

Consultation ladder (stopped by the owner after N=15): every consultation closed
`CLOSED_INCOMPLETE` (defect D-1 below). Memory flat — STT 2.63→2.77 GB, gateway 1.70→1.94 GB,
LM Studio 3.7–4.4 GB, NLP 0.66–0.72 GB, Docker VM 8.4–8.7 GB; **system free dipped to 32–33 %
with pressure "warn"** at N=1 and N=15 (LM Studio loading the note model on a Mac that already
carries ~15 GB swap from other apps).

### Cluster — k3s `dell` (48 vCPU / 62.8 GiB, 2× RTX 2000 Ada 16 GB, time-sliced), via `api-dev.taphuynh.dev`

STT ladder. Pod memory = Prometheus `max_over_time(container_memory_working_set_bytes)` per step
window.

| N | good | cov p50 | 1st partial p50 | worst commit p99 | STT pod | Redis | gateway | GPU FB (card 1) | GPU util | node avail min |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 0.94 | 2.2 s | 1.0 s | 0.80 GB | 55 MB | 528 MB | 3.7 GB | 0 % | 46.8 GB |
| 2 | 2 | 0.94 | 1.6 s | 1.1 s | 0.81 | 55 | 529 | 3.7 | 0 % | 46.7 |
| 4 | 4 | 0.94 | 2.1 s | 3.1 s | 0.82 | 58 | 528 | 3.7 | — | 46.8 |
| 8 | 8 | 0.94 | 2.0 s | 8.0 s | 0.89 | 64 | 536 | 3.7 | 97 % | 46.8 |
| 10 | 10 | 0.94 | 2.2 s | 14.9 s | 0.90 | 66 | 536 | 3.7 | 97 % | 46.7 |
| 12 | 12 | 0.94 | 2.3 s | 22.3 s | 0.95 | 69 | 536 | 3.7 | 84 % | 46.7 |
| 15 | 15 | 0.94 | 2.3 s | 39.4 s | 0.99 | 74 | 536 | 3.7 | 98 % | 46.6 |
| 20 | 20 | 0.94 | 2.6 s | 61.8 s | 1.01 | 80 | 536 | 3.7 | 98 % | 46.5 |
| 24 | 24 | 0.94 | 3.2 s | 80.5 s | 1.04 | 86 | 540 | 3.7 | 98 % | 46.4 |
| 32 | **3** | 0.81 | 2.8 s | 95.4 s | 1.10 | 118 | 544 | 3.7 | 98 % | 46.4 |
| 64 | 0 | 0.52 | — | — | **1.32** | 181 | 559 | 3.7 | 98 % | 45.9 |

(Coverage tops out at 0.94 on this fixture — its trailing silence yields no final.) STT limit is
24 GiB and GPU memory never moved, so the cluster STT has **~18× memory headroom and zero VRAM
pressure at 64 streams**; it is compute-bound from N=8.

Consultation ladder (open → STT → recording start → live-summary SSE → recording stop → poll
note, 300 s budget):

| N | notes | closed incomplete | timed out (300 s) | other | note p50 / max | LM Studio | NLP (orig pod) | STT pod | Redis | gateway | node avail min |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 1 | | | — | 11.5 GiB | 3.15 GiB | 0.95 GiB | 153 MB | 533 MB | 42.7 GB |
| 2 | 2 | | | | 43 / 43 s | 11.7 | 3.13 | 0.97 | 154 | 533 | 42.6 |
| 4 | 4 | | | | 59 / 75 s | 12.0 | 3.13 | 0.93 | 156 | 533 | 41.9 |
| 8 | 8 | | | | 90 / 128 s | 12.1 | 3.15 | 0.95 | 161 | 533 | 41.8 |
| 10 | 8 | 2 | | | 95 / 133 s | 12.3 | 3.15 | 0.95 | 164 | 534 | 41.3 |
| 12 | 4 | 8 | | | 65 / 76 s | 12.4 | 3.10 | 1.00 | 180 | 533 | 40.6 |
| 15 | 8 | 7 | | | 86 / 128 s | 12.4 | 3.15 | 0.97 | 195 | 543 | 40.4 |
| 20 | 10 | | 10 | | 111 / 169 s | 12.6 | 3.10 | 0.95 | 193 | 550 (+2nd replica) | 39.9 |
| 24 | 12 | | 12 | | 128 / 191 s | 12.7 | 3.11 | 0.99 | 223 | 594 | 40.2 |
| 32 | 8 | | 24 | | 128 / 138 s | 12.8 | 3.12 | 1.07 | 233 | 601 (+2nd) | 39.5 |
| 64 | 0 | | 43 | 12 edge-502 · 9 WS 1011 | — | 12.8 | 3.11 | 1.08 | 221 | 658 (+2nd) | 39.8 |

LM Studio limit 20 GiB; GPU FB 6.9 GB (card 1) / 5.6 GB (card 0) of 16 GB, flat. At N=64, 39
sessions produced **zero** finals — STT was down (F-3 restart at 17:35) or refusing.

### Models exercised (evidence, not configuration alone)

Both deployments resolve the Global tenant to the SAME published agents (queried from each DB):

| Capability | Agent (Global tenant) | Model | Engine / host | Local evidence | Cluster evidence (16:00–17:50Z) |
|---|---|---|---|---|---|
| **ASR** | `realtime-transcription` (`9c000000-…-0002-000000000001`) | **`arcaai-whisper-large-ml-en-gguf`** (Whisper large-v3, ml-en fine-tune, f16 GGUF, 1.62 GB on GPU) | whisper.cpp — Metal (`mps`) locally; CUDA build `dev-2-2.bfc3b351` on the cluster | 243 `stt.streaming.fingerprint` — 100 % this model | 371 fingerprints (Loki) — 100 % this model; ledger: 226 sessions metered |
| ASR helpers | — | **none**: no VAD model (`vad_model_loaded: false`, energy segmenter), no diarization, no denoise; lexicon hotword post-processing only | — | `stt.streaming.windows` | same |
| **LLM — live summary / pre-summary / note** | `case-notes-pre-summary`, `general-medicine-summarization`, `casenote-finalization` | **`gemma-4-e2b-it-qat`** (`lms-gemma-4-e2b-it-qat`) | LM Studio | configured; **no gemma completion is evidenced locally** — the only LM Studio chat completions in text's log were the 145 judge calls (generations were blocked by the fail-closed guardrail, D-1) | ledger: `generate.live` 200 calls (279 k in / 20 k out tokens), `harness.step` 191, `workflow.step` 78 (52 k in / 57 k out + 49 k reasoning tokens) |
| **LLM — guardrail judge** | `AiRoutingPolicy` (guardrail task) | **`granite-guardian-4.1-8b`** | LM Studio (via text `/judge`) | 145 `judge.completed` | 318 `judge.completed`; **214 `external_guardrail.exhausted_fail_closed`** |
| **NER** | `medical-ner` | **`medical-ner`** = `blaze999/Medical-NER` (HF token classifier) | nlp, CPU | ~150 token-classification calls | 393 (Loki) |
| TTS | `text-to-speech` → `kokoro` | — | — | not exercised | not exercised |

### Metering defects surfaced by that audit

| # | Defect | Evidence |
|---|---|---|
| M-1 | **Local: no LLM usage metered at all**, and **940 usage outbox rows stuck `PENDING`** (0 attempts; only 70 dispatched) | local `AiUsageOutbox` since 14:30Z: only STT + WORKFLOW events |
| M-2 | **Local STT usage `occurredAt` is 7 h behind** (= the host's UTC+7 offset); workflow events are correct. Invisible on the cluster (pods run UTC) | avg `createdAt − occurredAt` = 7.00 h for all 369 STT events |
| M-3 | Cluster: **226 of 371 ASR sessions metered** — sessions torn down by STT restarts / pool exhaustion are never billed | ledger vs Loki fingerprints |

### Defects found (not memory)

| # | Defect | Where |
|---|---|---|
| D-1 | **Harness `core.output` rejects the run: `result violates the declared output schema: (root): 'case_note' is a required property`** → consultation `CLOSED_INCOMPLETE`, no summary. 100 % locally; intermittent and **load-correlated** on the cluster (0/8 at N=8 → 8/12 at N=12). Locally preceded by `external_guardrail.exhausted_fail_closed` (ReadTimeout) in text | `apps/harness/src/harness/temporal/interpreter/nodes/core.py:2058` — **owner: fix after this report** |
| D-2 | STT liveness probe fails under decode load (F-3) — restarts kill live consultations | STT `/api/v1/health/live` + `base/stt.yaml` probe (5 s timeout, 3×30 s) |
| D-3 | STT streaming Redis client has no pool size (F-4) — pool exhaustion drops transcripts | `apps/stt/src/stt/streaming/_runtime.py:102` |
| D-4 | NLP replicas liveness-killed during lazy model load (F-5) | `apps/nlp` model init + `base/nlp.yaml` probes |
| D-5 | Tenant `maxConcurrentSessions` quota (25 on the seeded plan) not enforced — 32 and 64 sessions accepted locally | entitlements kill-switch; verify intended |

### Recommendations (in priority order; none applied — each is its own change)

1. **MinIO limit 1 GiB → 2 GiB** (O-2) and **Tempo 512 MiB → 1–1.5 GiB or trace sampling** (O-1) — deployment repo, `base/`.
2. **STT liveness (D-2):** make `/health/live` independent of the decode loop (no shared event-loop/GIL-bound work), or raise `timeoutSeconds`/`failureThreshold`; a liveness probe must never fail because the service is *busy*.
3. **STT Redis pool (D-3):** size the pool from the stream cap (≈ 2 × `max_concurrent_streams` + headroom) or use a `BlockingConnectionPool`; then set the cap below the cliff.
4. **Set `stt.streaming.maxConcurrent` per GPU slice from these numbers:** realtime-grade (commit p99 ≤ ~15 s) holds to **N≈10** on the cluster slice; functional (all sessions complete) to **N=24**. A cap of **~12–16** keeps quality; 24 is the hard maximum before F-2.
5. **NLP (O-3/D-4):** raise limit to 6 GiB or cut resident models, and load weights eagerly inside the startup-probe window so scale-out replicas are live before traffic.
6. Fix **D-1** (owner-requested next).

### Configuration left changed

| Where | Setting | Now | Action |
|---|---|---|---|
| cluster | `stt.streaming.maxConcurrent` (SYSTEM) | **restored to 0** (auto), version 2 | the running STT pod still enforces 64 until its next restart |
| local dev DB | `stt.streaming.maxConcurrent` (SYSTEM) | **64** | restore with `PUT admin/settings/registry/stt.streaming.maxConcurrent {"value":0,"scope":"system","expectedVersion":1}` once the stack is up |
| cluster | test data | ~200 consultations with random `patientId`s in the Global tenant (`doctor`) | none needed for dev; left in place |

### Artifacts

- Drivers: `tests/load/streams/stream_ladder.py` (STT ladder + local sampler),
  `tests/load/streams/consultation_ladder.py` (full consultation).
- Raw results (gitignored `results/`): `tests/load/results/streams/ladder-20260928T150600Z.json`,
  `…/consult-ladder-20260928T154102Z.json`, `…/cluster/ladder-20260928T160307Z.json`,
  `…/cluster/consult-ladder-20260928T163250Z.json` — per-session metrics, per-step windows, and
  (local) the 2 s resource samples.

## Change History

- 2026-09-28 — ticket opened; local stack started (api, stt, stt-worker, text, guardrail, nlp,
  harness, worker); `stt.streaming.maxConcurrent` set to 64 (SYSTEM, version 1) and STT
  restarted (`detected 15 → effective 64`); driver written and smoke-tested at N=1.
- 2026-09-28 — local STT ladder, interim: memory flat 1→20 (STT ≈ 2.5–2.7 GB footprint, no
  pressure, no deaths). Degradation is THROUGHPUT: worst commit p99 5.5 s (N=1) → 21 s (N=4) →
  74 s (N=8) → 123 s (N=20). At **N=20 the driver's `ok` flag overstates health** — median
  audio coverage 0.89, worst 0.31, **0/20 sessions closed** within the 90 s post-feed wait (no
  seq gaps: backlog, not transport loss). Reporting criterion tightened to
  `closed && coverage ≥ 0.9`.
- 2026-09-28 — local STT ladder complete; N=64 root-caused to the STT Redis pool (D-3). Local
  consultation ladder stopped by the owner after N=15 (every run `CLOSED_INCOMPLETE`, D-1).
- 2026-09-28 — cluster: cap raised to 64 (SYSTEM v1), STT restarted by `kill 1` in the container
  (no manifest change); first ladder attempt aborted on a 503 during the ~2.5 min STT warm-up.
  STT and consultation ladders run through the ingress; peaks pulled from in-cluster Prometheus.
  Found O-1..O-3, F-3..F-6, D-2..D-5. Cap restored to 0 (SYSTEM v2).
- 2026-09-29 — report written; status Review.
