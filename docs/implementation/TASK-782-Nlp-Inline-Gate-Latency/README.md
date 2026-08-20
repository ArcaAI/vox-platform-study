# TASK-782 — `apps/nlp`: closing the inline-gate latency gap

| Field | Value |
|---|---|
| Status | Review (evidence measured 2026-08-20) |
| Type | performance + infrastructure |
| Opened | 2026-08-20 |
| Affects | `apps/nlp` |
| Depends on | TASK-778 (three-model safety plane, micro-batching, declared backpressure) |
| Explicitly NOT touched | `apps/guardrail` (owned concurrently by a sibling agent) |

---

## 1. Requirement Analysis

TASK-778 measured the nlp safety plane against REAL weights on this Mac (CPU-only,
100 concurrent, batch 16 / linger 8 ms / inflight 2):

| metric | value |
|---|---|
| throughput | 54.1 req/s |
| p50 | 1124 ms |
| **p95** | **1692 ms** |
| p99 | 1836 ms |
| un-batched baseline | sheds 20 % as 503 at the 20 s ceiling |
| calibrated stub (pipeline only) | ~440 req/s |

**Throughput meets the >= 100-concurrent-session target. Latency does not.** A p95 of
~1.7 s is fit for an ASYNCHRONOUS per-utterance redaction pass and unfit for a
SYNCHRONOUS inline gate on a clinician-facing turn. TASK-778 named the bottleneck as
CPU-bound encoder compute and pointed at device placement or replicas.

This ticket must:

1. Investigate and MEASURE MPS/Metal placement for the gliner2 checkpoints on this
   Apple Silicon host. A negative result honestly measured is an acceptable outcome.
2. Separate the two service classes — an async redaction path and a synchronous inline
   gate have different latency budgets and must not share one queue geometry.
3. Measure everything. Real p50/p95/p99, throughput, and the HTTP status histogram for
   every geometry tested. No assertions without numbers.
4. State plainly whether a synchronous inline gate is achievable on this hardware, and
   if not, what the deployment would need.

Constraints carried forward, unchanged:

- Model ids, label taxonomies and thresholds are CONFIG (`AiTaskDefault` x `AiModel`,
  tenant -> SYSTEM, fail closed 503). Never Python literals, never pydantic defaults.
  The repo-grep guard forbidding `fastino/` literals in non-test Python stays green.
- The capability envelope in `AiModel._metadata.capabilities` remains the ONLY gate on
  which model may serve which verb — TASK-778 proved every checkpoint answers every
  verb, so a mis-selection mis-answers confidently instead of failing.
- Device placement is TRANSPORT/topology, not model identity — env-tier bootstrap floor
  plus control-plane override, the same tier as the existing batching geometry.

## 2. Current State Evaluation (verified 2026-08-20 in this worktree, base `87d783b4f`)

| Artifact | State before this ticket |
|---|---|
| `core/batching.py` | `MicroBatcher` with a PRIVATE `asyncio.Semaphore` in-flight bound |
| `services/guard_dispatch.py` | ONE batcher per `(weight slot, verb)`, ONE geometry from `settings.service.inference_batch_*` |
| `services/gliner2_guard.py` | `GLiNER2.from_pretrained(...)` with no device argument — CPU always |
| `core/config.py` | No device setting at all; `use_gpu` exists on the NER/classifier configs and is `torch.cuda`-only |
| `schemas/guard.py` | No way for a caller to declare a service class |
| `tests/load/…_task778.py` | One workload shape (N identical concurrent requests), CPU only |

Two gaps follow, and they are the whole ticket:

- **G-1 — placement was never expressed.** `gliner2`'s `from_pretrained` accepts
  `map_location`, and `Extractor.forward` dispatches off
  `next(self.parameters()).device`, so the runtime has always been able to run
  on an accelerator. Nothing in `apps/nlp` could ask it to.
- **G-2 — one queue for two jobs.** The per-utterance redaction path and a
  synchronous inline gate shared `inference_batch_max_size` /
  `inference_batch_linger_ms` / `inference_queue_max_wait_seconds`. A geometry
  tuned for the first (batch 16, 20 s ceiling) is exactly wrong for the second.

## 3. Implementation Plan

TDD, RED first, in this order.

| Step | Change | Verified by |
|---|---|---|
| P-1 | Measure MPS against the real checkpoints before writing any wiring. Report the result whatever it is. | §5.1–5.2 |
| P-2 | `PriorityGate` — one in-flight permit per weight slot, priority-ordered, FIFO within a priority, no permit leak on cancellation. | `test_priority_gate_task782.py` |
| P-3 | `core/device.py` — device resolution (`auto` degrades, explicit fails closed) + accelerator placement with mandatory CPU islands. | `test_device_placement_task782.py` |
| P-4 | `MicroBatcher` takes an injectable in-flight gate + a priority. | existing batcher suite stays green |
| P-5 | Lane-aware dispatch: two batchers per `(slot, verb)`, per-lane geometry, one shared gate, lane in the batcher name (hence in every metric label). | `test_guard_lanes_task782.py` |
| P-6 | `latency_class` on the guard request; route threads it through; `lane` becomes a third label on the rejection counter. | `test_guard_lanes_task782.py`, `test_guard_backpressure_task778.py` |
| P-7 | Load driver: device selection + a MIXED workload that measures the gate WHILE bulk saturates the model. | §5.3–5.5 |

---

## 4. Implementation Summary

### 4.1 Device placement (`src/nlp/core/device.py`, new)

`inference_device` ∈ `cpu | auto | mps | cuda`, resolved by
`resolve_inference_device` and applied by `apply_device_placement` inside
`Gliner2GuardService.load()`. A device name is **transport/topology** — *where*
the tensors execute — so it is legitimately env-tier with a control-plane
override, exactly like the batching geometry, and unlike a model id.

Three design points, each forced by something measured rather than assumed:

1. **An unsupported op on MPS aborts the PROCESS. It does not raise.** The
   measured failure is
   `MPSNDArray.mm:893: failed assertion ... buffer is not large enough`,
   delivered as SIGABRT. So `try: mps / except: fall back to cpu` is not merely
   discouraged here — there is nothing to catch. Placement is decided from
   configuration before a single tensor executes, and is never discovered.
2. **The CPU relocation is mandatory, not an optimisation.** Forward hooks
   localised the abort to exactly one submodule, `count_embed.gru`
   (`gliner2.layers.CompileSafeGRU`). `apply_device_placement` wraps it in a
   `_CpuIsland` that bounces its arguments to CPU and its result back, so the
   surrounding third-party `forward()` — which never heard of the island — is
   unaffected. Skip the relocation and the first request kills the worker.
   The path list is configuration (`inference_device_cpu_only_modules`) because
   it describes a torch/`gliner2` COMPATIBILITY gap: a torch release that fixes
   the assertion should be answered by emptying the list, not by editing code.
3. **`auto` degrades; an explicit device fails closed.** A latency SLO built on
   an accelerator that silently is not present is a false promise — the operator
   must see the misconfiguration, not discover a 3x regression from a dashboard.

The shipped bootstrap floor is `cpu`, because it is the only placement that is
correct on every host — see §5.6 on why that is not a hedge.

### 4.2 Two service classes (`guard_dispatch.py`, `priority_gate.py`, `batching.py`)

`latency_class` ∈ `interactive | bulk` arrives on the request; absent ⇒ `bulk`,
so an existing caller (guardrail, which does not send it) keeps byte-identical
TASK-778 behaviour. `normalize_lane` maps an unrecognised value to the **slower**
lane on purpose: a typo must never buy priority on a shared resource.

| | `interactive` | `bulk` |
|---|---|---|
| job | synchronous inline gate on a clinician's turn | asynchronous per-utterance redaction |
| batch | 2 | 8 (floor; 16 measured best for throughput) |
| linger | 2 ms | 8 ms |
| queue depth | 64 | 256 |
| **wait ceiling** | **2 s — this IS the declared SLO** | 20 s |

**Separate queues alone would not have worked, and that is the load-bearing
insight of this ticket.** Both lanes drive the SAME tensor graph, so a bulk pass
already in flight is head-of-line blocking for the gate however short the gate's
own queue is. The in-flight bound therefore moved OUT of `MicroBatcher` and onto
a per-slot `PriorityGate` shared by both lanes. It keeps the same ceiling on
concurrent passes against one model (a private semaphore per batcher would have
silently DOUBLED it the moment a second lane appeared) and hands a freed permit
to the interactive lane first.

`PriorityGate` transfers a permit directly to the chosen waiter rather than
decrementing and letting anyone race for it, so a bulk waiter cannot slip in
between a release and an interactive wake-up. A waiter cancelled after being
granted releases on the way out, so a client disconnect cannot permanently
shrink the model's capacity.

**It is deliberately NOT pre-emption**: a bulk pass already executing runs to
completion. The bulk lane's `max_batch_size` is therefore a latency FLOOR for
the gate, and §5.5 measures that coupling instead of asserting it away.

### 4.3 Observability

The lane rides in the batcher NAME (`nlp_guard_pii_interactive`), which is
already the label on the queue-depth, queue-wait and batch-size metrics — so the
two classes became separately observable without touching a metric signature.
`nlp_inference_rejections_total` gained a third label, `lane`, rather than a
suffix on `route`: the interactive ceiling is short on purpose, so its timeouts
are an expected, declared outcome that must be alertable separately from bulk
overload rather than summed into it.

### 4.4 What the capability envelope still governs

Unchanged, and deliberately so. `latency_class` selects a QUEUE, never a model.
Which checkpoint may serve which verb remains `AiModel._metadata.capabilities`
resolved tenant → SYSTEM, and TASK-778 proved that is the ONLY gate — every
checkpoint answers every verb, so a mis-selection mis-answers confidently rather
than failing. Nothing here lets a lane, a device or a geometry reach around it.
`test_no_hardcoded_model_ids_task778.py` is still green: no `fastino/` literal
appears in non-test `apps/nlp` Python, including the new modules.

### 4.5 Not done here, deliberately

- **The caller must opt in.** `apps/guardrail` sends no `latency_class`, so
  every call it makes today lands in the bulk lane. `apps/nlp` is ready; making
  the inline safety check ask for the express lane is a one-field change in
  guardrail's `NlpGuardClient`, and `apps/guardrail` is owned by a sibling agent
  this sprint. Recorded here rather than reached into.
- **`pnpm env:sync` not run.** This worktree has no `node_modules`, so the
  generator cannot execute. The six new keys are declared in
  `scripts/env-sync.mts` (`PYTHON_SERVICE_ENV_SETTINGS`), added to
  `turbo.json#globalEnv` and documented in `apps/nlp/.env.sample`; the
  orchestrator should run `pnpm env:sync` to confirm idempotence.
- **`inference_device` is not yet read from the control plane.** It is an
  env-tier bootstrap value like the batching floors. Wiring it into
  `EffectiveConfigSnapshot` would let a control-plane write move a model onto a
  device MID-PROCESS, which for a knob whose failure mode is SIGABRT deserves
  its own decision rather than a side effect of this ticket.

---

## 5. Verification — measured, not asserted

### 5.0 Measurement conditions, stated first because they matter

**This host was shared with concurrent sibling agents throughout, at 1-minute
load averages between 15 and 138 on 16 cores.** The same configuration measured
minutes apart varied by up to 6x. Every number below therefore carries the load
average at the start of its run, and every comparison is either **interleaved
A/B in one process** or **within a single run** (both lanes measured
simultaneously). Absolute single-run numbers from this host are the weakest
evidence in this document and are labelled as such.

The calibration that makes the rest trustworthy: in the quietest round, the
**CPU** arm reproduced TASK-778's published figures almost exactly —

| | TASK-778 (CPU, batch 16, linger 8 ms, inflight 2) | this ticket, round 3 |
|---|---|---|
| goodput | 54.1 req/s | **54.5 req/s** |
| p50 | 1124 ms | **1123 ms** |
| p95 | 1692 ms | **1699 ms** |

So the driver, the geometry and the host are the same ones TASK-778 measured,
and the deltas below are real deltas rather than a changed baseline.

### 5.1 MPS — the negative result first

`GLiNER2.from_pretrained(repo, map_location="mps")` loads all three checkpoints
onto Metal without complaint (8.6 s for the 1.2 GB privacy filter). **The first
forward pass then kills the process:**

```
device=mps load=8.62s param_device=mps:0
/AppleInternal/.../MetalPerformanceShaders/MPSCore/Types/MPSNDArray.mm:893:
failed assertion `[MPSNDArray, initWithBufferImpl:offset:descriptor:
isForNDArrayAlias:isUserBuffer:] Error: buffer is not large enough.
Must be 15360 bytes'
```

`PYTORCH_ENABLE_MPS_FALLBACK=1` does not help — this is a Metal-layer assertion,
not an unsupported-op dispatch. Registering forward pre/post hooks on every
submodule localised it precisely:

```
<<< EXIT  span_rep
>>> ENTER count_pred      … <<< EXIT count_pred
>>> ENTER count_embed
>>> ENTER count_embed.pos_embedding   <<< EXIT count_embed.pos_embedding
>>> ENTER count_embed.gru
<abort>
```

The DeBERTa encoder and the entire span-representation stack run on MPS fine.
One submodule — `count_embed.gru` — does not. A bare
`microsoft/mdeberta-v3-base` forward confirms the encoder itself is healthy on
Metal (45 ms/pass at batch 4).

### 5.2 MPS with the one submodule relocated — the positive result

Interleaved A/B in ONE process, alternating arms per repetition, 11 repetitions
per batch size, real weights, `fastino/gliner2-privacy-filter-PII-multi`.
Load average 45 → 41 across the run.

| batch | CPU min / median | MPS min / median | speedup (min) |
|---|---|---|---|
| 1 | 164.9 / 219.7 ms | **55.0 / 112.4 ms** | **3.00x** |
| 2 | 219.7 / 314.8 ms | 79.2 / 96.4 ms | 2.77x |
| 4 | 303.2 / 313.8 ms | 144.5 / 173.5 ms | 2.10x |
| 8 | 417.0 / 537.0 ms | 266.5 / 358.5 ms | 1.56x |
| 16 | 406.0 / 455.8 ms | 225.2 / 245.1 ms | 1.80x |

**The gain is largest exactly where the inline gate lives** — at batch 1–2, MPS
is ~3x. Coalescing amortises the fixed per-pass cost the accelerator is best at
removing, so the advantage narrows as the batch grows.

**Numerically identical, not merely close.** Both arms return the same five
spans with the same offsets and confidences:

```
cpu: person ('Jane Roe', 0.9888) · email (…, 1.0) · phone_number ('555-0100', 0.9998)
     · address ('41 Elm Street', 0.9899) · date_of_birth ('1974-03-02', 1.0)
mps: person ('Jane Roe', 0.9888) · email (…, 1.0) · phone_number ('555-0100', 0.9998)
     · address ('41 Elm Street', 0.9899) · date_of_birth ('1974-03-02', 1.0)
```

All three roster checkpoints work on MPS, both verbs, same verdicts as CPU:

| checkpoint | cpu batch-1 | mps batch-1 | spans | `classify_text` |
|---|---|---|---|---|
| `gliner2-privacy-filter-PII-multi` | 137 ms | **44 ms** | 5 = 5 | same |
| `GLiNER2-Guardrails-PII-Multi` | 150 ms | **35 ms** | 5 = 5 | same |
| `gliguard-LLMGuardrails-300M` | 88 ms | **26 ms** | 0 = 0 | same |

(`gliguard` returning zero spans on both devices is the TASK-778 finding, not a
placement artefact.)

**A negative result recorded honestly:** the naive hybrid — bounce the GRU but
leave everything else on MPS *without* the interleaved protocol — first measured
as *slower* than CPU (149 vs 76 ms at batch 1). That comparison was invalid: the
two arms ran minutes apart while the host load moved from 62 to 82. Interleaving
is what turned it into the table above. The first number was wrong about the
world, not about MPS.

### 5.3 Single-lane throughput at 100 concurrent, CPU vs MPS

Alternating runs, `batch=16, linger=8 ms, inflight=2`, real weights, load
average recorded per run.

| round | device | inflight | loadavg | codes | goodput | p50 | p95 |
|---|---|---|---|---|---|---|---|
| 1 | cpu | 2 | 86.0 | all 200 | 16.5 | 3544 | 5417 |
| 1 | mps | 2 | 92.7 | all 200 | 24.6 | 2163 | 3754 |
| 1 | mps | 1 | 73.2 | all 200 | 14.2 | 4710 | 6636 |
| 2 | cpu | 2 | 65.3 | all 200 | 48.3 | 1251 | 1886 |
| 2 | mps | 2 | 53.3 | all 200 | 58.4 | 1068 | 1564 |
| 2 | mps | 1 | 46.9 | all 200 | 46.2 | 1284 | 2014 |
| **3** | **cpu** | **2** | **40.1** | all 200 | **54.5** | **1123** | **1699** |
| **3** | **mps** | **2** | **34.1** | all 200 | **64.5** | **992** | **1425** |
| 3 | mps | 1 | 29.7 | all 200 | 55.4 | 1154 | 1668 |

MPS wins every round at matched inflight (1.19x / 1.21x / 1.18x goodput), and
`inflight=1` loses on both devices — TASK-778's choice of 2 stands. But the
throughput gain is only ~1.2x, far below the 3x of §5.2, **because a 100-way
burst at batch 16 is dominated by queueing, not by pass cost.** That is the
observation that makes the lane split necessary rather than optional: on this
workload, placement alone buys almost nothing for latency.

### 5.4 The inline gate, measured the only honest way

`tests/load/test_guard_throughput_task778.py::test_inline_gate_latency_under_bulk_load`.
A gate latency measured on an idle service is not a latency the platform ever
sees, so: 100 concurrent **bulk** requests saturate the model while 20
**interactive** requests are paced through the burst at 50 ms intervals. Both
classes are reported separately with their own status histogram, in the SAME
run — so the comparison is immune to the host's load drift.

`device=mps, bulk(batch=8, linger=8 ms), gate(batch=2, linger=2 ms), inflight=2`
alternated against the same geometry on CPU, three rounds:

| round | device | loadavg | bulk goodput | bulk p95 | **gate p50** | **gate p95** | gate codes |
|---|---|---|---|---|---|---|---|
| 1 | cpu | 35.7 | 29.6 req/s | 3227 ms | 544 ms | 627 ms | all 200 |
| 1 | **mps** | 30.0 | **50.6 req/s** | 1960 ms | **151 ms** | **358 ms** | all 200 |
| 2 | cpu | 27.4 | 33.7 req/s | 2920 ms | 265 ms | 422 ms | all 200 |
| 2 | **mps** | 44.5 | **46.5 req/s** | 2056 ms | **161 ms** | **407 ms** | all 200 |
| 3 | cpu | 31.6 | 30.8 req/s | 3238 ms | 294 ms | 441 ms | all 200 |
| 3 | **mps** | 24.5 | **45.8 req/s** | 2092 ms | **227 ms** | **426 ms** | all 200 |

Every run separates the two classes by 5–6x on p95 while both are in flight
against one model. That separation is the lane design working; MPS then moves
the gate's absolute p95 from ~420–630 ms to ~360–430 ms and simultaneously
raises bulk goodput by ~1.5x.

For reference, the pre-split TASK-778 behaviour at the same concurrency was a
single class at **p95 1692 ms**. The gate is therefore **~4x faster than the
number this ticket was opened to fix**, and it did not cost the bulk lane its
target.

### 5.5 The bulk batch size is the gate's latency floor — measured

A bulk pass already executing is not pre-empted, so `bulk max_batch_size`
directly bounds the gate. Sweep at `device=mps`, one run each (single runs, so
the weakest evidence here — the ORDERING is the finding, not the digits):

| bulk batch | gate batch | bulk goodput | **gate p50 / p95** |
|---|---|---|---|
| 16 | 4 | 56.8 req/s | 294 / 594 ms |
| 8 | 2 | 51.0 req/s | 183 / 413 ms |
| **4** | **1** | 38.4 req/s | **91 / 232 ms** |
| 4 | 1 | 37.5 req/s | 137 / 258 ms |
| 4 | 1 | 47.8 req/s | 103 / 212 ms |

The trade is monotone and it is a real product decision, not a tuning detail:
**every millisecond taken off the gate is paid in bulk throughput.** A
consultation session issues roughly one redaction call per utterance, order one
every 5–10 s, so 100 sessions need ~10–20 req/s of bulk against 38–51 measured —
2–5x headroom at either setting. `bulk=8 / gate=2` is adopted as the balanced
point; `bulk=4 / gate=1` is the latency-first point and is a supported
configuration, not a code change.

Two runs in the sweep collapsed (bulk 11–15 req/s, gate p95 1.0–2.3 s, and in
one case 4 of 20 gate requests shed with 503 at the declared 2 s ceiling). Those
coincided with load spikes above 90 and are reported rather than dropped — they
are also the only observation of the interactive ceiling firing, which confirms
the declared backpressure contract holds for the new lane exactly as TASK-778
specified it for the old one.

### 5.6 The plain answer

**Is a synchronous inline gate achievable on this hardware? Yes — but only with
BOTH changes, and only on the developer Mac.**

| configuration | gate p95 |
|---|---|
| TASK-778 as shipped (one lane, CPU) | **1692 ms** — not viable |
| lane split, CPU | 422–627 ms — usable on a submit action, marginal |
| **lane split + MPS, `bulk=8 / gate=2`** | **358–426 ms** — viable |
| lane split + MPS, `bulk=4 / gate=1` | 212–258 ms — viable, at ~25 % of bulk goodput |

"Viable" means: fast enough to gate a submitted turn without the clinician
perceiving a stall. It is **not** fast enough for a per-keystroke gate, and
nothing measured here suggests that is reachable on this class of hardware.

**And the honest caveat that outranks the good news: MPS is Apple-silicon only.**
`deployment/` targets k3s on Linux, where `torch.backends.mps.is_available()` is
false and `inference_device=mps` correctly RAISES. So §5.4's best numbers are a
**developer-machine** result. What the deployment would need:

1. **A CUDA GPU on the nlp node** — the same code path (`inference_device=cuda`,
   `map_location`), and the CPU-island list should be EMPTIED there: the
   relocation exists only for the MPS assertion, and paying a device bounce on
   CUDA would be pure overhead. This is the recommended path, and it is a
   configuration change plus a node with a GPU, not further code.
2. **Or CPU replicas, split by service class.** The measurement says the
   coupling to beat is head-of-line blocking, not raw throughput — so two
   deployments of `apps/nlp` (a bulk pool at `bulk=16`, and a gate pool with a
   small batch and no bulk traffic at all) beat one larger pool. A gate-only CPU
   pool with no bulk lane to wait behind should land near its own pass cost
   (~165 ms at batch 1, §5.2) rather than the 422–627 ms measured here with bulk
   contending. That prediction is **not measured** and is stated as a
   prediction.
3. **Not a rewrite.** The un-batched baseline was 4.0 req/s goodput and p50 12.4 s
   (TASK-778 §5.5); the serving pipeline sustains ~440 req/s against a
   calibrated stub. The machinery was never the constraint and still is not.

### 5.7 Suite, lint, types

All run in this worktree against the conda `arcaenv` interpreter with
`PYTHONPATH` pinned to THIS checkout — the env's editable installs point at the
main repo, so `pnpm nlp:test` would silently test the wrong tree.

```
$ PYTHONPATH=$PWD/src python -m pytest -q
356 passed, 3 deselected, 15 warnings in 6.34s
```

(**335 before this ticket**, verified by re-running the suite with the three new
files ignored; +21 new — 4 priority-gate, 8 device-placement, 9 lane — plus the
load driver's third `load`-marked test, which raises the deselected count from
2 to 3. **0 regressions**; the one pre-existing test that changed
(`test_rejections_are_counted_by_reason`) did so because this ticket added the
`lane` label to that counter, and it asserts the same behaviour.)

```
$ python -m ruff check src tests
All checks passed!

$ PYTHONPATH=$PWD/src python -m mypy src/nlp
Success: no issues found in 55 source files
```

The guardrail contract is unchanged and still passes (exercised, never edited —
`apps/guardrail` is owned by a sibling agent this sprint):

```
$ PYTHONPATH=$PWD/src python -m pytest src/guardrail/tests/test_nlp_delegation.py -q
11 passed in 1.85s
```

Reproduce the headline measurement with:

```
HF_HOME=/Volumes/aillusion/huggingface HF_HUB_OFFLINE=1 \
NLP_LOAD_TEST_MODEL=<AiModel.sourceUri> NLP_LOAD_TEST_DEVICE=mps \
NLP_LOAD_TEST_CONCURRENCY=100 NLP_LOAD_TEST_BATCH=8 NLP_LOAD_TEST_LINGER_MS=8 \
NLP_LOAD_TEST_INTERACTIVE_BATCH=2 NLP_LOAD_TEST_INTERACTIVE_LINGER_MS=2 \
NLP_LOAD_TEST_INFLIGHT=2 \
pytest tests/load -m load -s -k inline_gate
```

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-20 | Ticket opened; requirement analysis recorded before any code change. |
| 2026-08-20 | MPS investigated against real weights. Hard abort localised by forward hooks to `gliner2`'s `count_embed.gru`; encoder and span-rep stack confirmed healthy on Metal. |
| 2026-08-20 | First CPU-vs-MPS comparison **withdrawn as invalid** — sequential arms under a host whose load moved 62 → 82. Replaced by an interleaved A/B protocol in one process; MPS then measured 1.6–3.0x faster with byte-identical spans on all three checkpoints. |
| 2026-08-20 | `PriorityGate` + injectable in-flight gate on `MicroBatcher`; the per-model bound moved out of the batcher so two lanes cannot double it and the gate can overtake a queued bulk pass. |
| 2026-08-20 | `core/device.py`: configured placement, `auto` degrades / explicit fails closed, mandatory CPU islands. `inference_device` + `inference_device_cpu_only_modules` declared as env-tier transport. |
| 2026-08-20 | Lane split shipped: `latency_class` on the request, per-lane geometry, lane in the batcher name and as a third label on the rejection counter. Absent ⇒ bulk, so guardrail is unaffected. |
| 2026-08-20 | Load driver extended with device selection and a MIXED bulk+gate workload. CPU arm reproduced TASK-778's published numbers to within 1 %, validating the harness before any claim was made from it. |
| 2026-08-20 | Measured outcome recorded: gate p95 1692 → 358–426 ms (lane split + MPS). MPS is Apple-silicon only, so the deployment needs CUDA or class-split replicas — stated as a requirement, not papered over. |
