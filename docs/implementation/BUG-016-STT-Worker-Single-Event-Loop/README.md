# BUG-016 — STT batch worker: one event loop per message makes shared async state unusable; concurrent jobs on one pipeline die on `got Future … attached to a different loop`

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, running 3 concurrent files through the batch playground on the local whisper pipeline |
| **Severity** | High — on any pipeline with a shared local model, concurrent batch jobs fail outright (2 of 3, then 1 of 3, observed). Also the root cause behind BUG-015's 300s stall and pool leak. |
| **Affected apps/packages** | `apps/stt` (worker actor, worker-init middleware); root cause surfaced through `packages/py-runtime-models` (`hope_runtime_models.ModelCache`) |
| **Related tickets** | **BUG-015** — same root cause, treated three symptoms singleton-by-singleton; this ticket fixes the cause. BUG-011/012/013, TASK-603 (batch upload path). |

---

## Requirement Analysis

Uploading N files that use the same ASR pipeline must transcribe all N. Observed:
concurrent jobs on the local whisper pipeline failed at `progress 5` with

```
Task <Task pending … _transcribe_file_async() …> got Future
<Future pending cb=[shield.<locals>._outer_done_callback()]> attached to a different loop
```

---

## Current State Evaluation

### 1. The evidence separates the two pipelines cleanly

| batch | pipeline | models | result |
|---|---|---|---|
| 16:03, 16:13 | `…115` Sarvam | cloud ASR handle only — nothing shared | **4/4 COMPLETED** |
| 16:30 | `…117` whisper GGUF | `arcaai-whisper-large-ml-en-gguf` + `silero-vad` | 2 FAILED, 1 COMPLETED |
| 16:33 | `…117` whisper GGUF | same | 1 FAILED, 2 COMPLETED |

Failures occur **only** where concurrent jobs share a model key, **only** under
concurrency, and always at `progress 5` — immediately after `Loading models…`.

### 2. Root cause

`packages/py-runtime-models/src/hope_runtime_models/cache.py` single-flights model
loads so concurrent callers share one load:

```python
self._lock = asyncio.Lock()                          # :487  loop-bound
self._inflight: dict[str, asyncio.Future[T]] = {}    # :489  process-wide
...
future = asyncio.get_running_loop().create_future()  # :509  created on the OWNER's loop
self._inflight[key] = future                         # :510
...
return await asyncio.shield(future)                  # :518  awaited by every waiter
```

The worker called `asyncio.run()` inside the actor (`transcribe_file.py:94`), so
**every message got its own event loop**. Three concurrent jobs wanting the same
model: the first becomes the owner and creates the future on ITS loop; the others
become waiters and hit `:518` from a different loop. That is the reported error
verbatim, including the `shield.<locals>._outer_done_callback` in the message.

The owner completes; every waiter dies.

### 3. Why per-THREAD loops would NOT have fixed it

The obvious remedy — give each Dramatiq worker thread a persistent loop instead
of one per message — leaves four LIVE loops in the process. Four live loops still
cannot share one future. Only a single loop can. This was considered and rejected
before implementation.

### 4. Relationship to BUG-015

Same cause, three symptoms, treated one at a time:

| Symptom | Ticket | Object |
|---|---|---|
| 300s stall on first query | BUG-015 | SQLAlchemy engine keyed by recycled `id(loop)` |
| Postgres `max_connections` exhausted | BUG-015 | engines never disposed |
| shared `httpx.AsyncClient`, effective-config `asyncio.Lock` | BUG-015 | `@lru_cache` / module global |
| **`got Future … attached to a different loop`** | **BUG-016** | `ModelCache._inflight` + `_lock` |

BUG-015 was a correct fix for what it covered, but it was whack-a-mole: the
fourth and fifth loop-bound objects live in a package shared by six services
(`guardrail`, `harness`, `nlp`, `smr`, `stt`, `tts`), and there is no reason to
believe those were the last.

The FastAPI services never saw any of it: they have one process-wide loop, so
every caller is already on the same loop. **The defect is specific to the worker's
per-message-loop design**, which is what this ticket removes.

### 5. A second instance of the same mistake, one layer earlier

`WorkerInitMiddleware.after_process_boot` ran `asyncio.run(initialize_services())`
— so VAD, embedding, punctuation and the model cache were **constructed on a
throwaway loop that was closed before the first job ever ran**. Any asyncio state
they hold was bound to a dead loop from startup. Cleanup had the same shape.

---

## Implementation Plan

### Options considered

| Option | Verdict |
|---|---|
| **(a) One event loop for the whole worker process** | **Chosen.** Actor dispatches onto it with `run_coroutine_threadsafe`. Every shared async object is on one loop by construction, so the entire bug class closes rather than the two objects found so far. |
| (b) One persistent loop per worker thread | **Rejected — does not fix this bug.** Four live loops still cannot share `_inflight`. |
| (c) Per-loop model cache | **Rejected.** Defeats the purpose: each loop would load its own copy of a 1.6 GB model. |
| (d) Make `hope_runtime_models` loop-agnostic (threading primitives) | Rejected for now: rewrites shared-package semantics for six services to work around a defect that exists in exactly one consumer. |
| (e) `--threads 1` | Stopgap only; serialises batch throughput and leaves the design intact. |

### Why a single loop is safe here

The loop never does CPU work. Every blocking step already runs under
`asyncio.to_thread`: model loading (`whisper_cpp_loader`, `faster_whisper_loader`,
`parakeet_cpp_loader`, `huggingface_loader`), ASR inference (`batch_service`, all
adapter paths), weight download/hashing (`source_resolver`). The loop only awaits.

**Job concurrency is unchanged** — it was never the loop that bounded it. The
actor still holds the thread gate (`core/job_concurrency.py`, sized from
`worker_threads`) and `--threads` still caps attempts.

---

## Implementation Summary

| File | Change |
|---|---|
| `apps/stt/src/stt/core/worker_loop.py` | **New.** `get_worker_loop()` starts one daemon thread running `run_forever` (published only once it is consuming callbacks); `run_on_worker_loop(coro, timeout)` submits via `run_coroutine_threadsafe` and blocks, re-raising the ORIGINAL exception type (Dramatiq's retry taxonomy depends on it) and cancelling the submitted coroutine if the calling thread is interrupted; re-entrant calls from the loop thread raise instead of deadlocking; `shutdown_worker_loop()` stops, drains pending tasks, shuts down async gens + the default executor, and joins. |
| `apps/stt/src/stt/transcription/workers/transcribe_file.py` | `asyncio.run(...)` → `run_on_worker_loop(...)` inside the existing job gate. |
| `apps/stt/src/stt/core/messaging/worker_init_middleware.py` | Boot and cleanup run on the SHARED loop; the loop is stopped after cleanup, in a `finally`. |
| `apps/stt/tests/unit/test_worker_loop_bug016.py` | **New, 10 tests.** |

`loop_local.py` from BUG-015 is **kept**: with one loop it degrades to a single
binding, and it still protects any path that legitimately makes its own loop
(FastAPI, CLI, tests). It is now a safety net, not the mechanism.

---

## Verification

TDD: RED first (`ModuleNotFoundError: stt.core.worker_loop`, then the two
middleware tests failing), then implementation.

**The reported error, reproduced as a test** — `TestWitnessOfTheOldModel` drives the
real `hope_runtime_models.ModelCache` from two threads using the OLD
`asyncio.run()`-per-message model and asserts the waiter fails with
`attached to a different loop`. It passes, so the diagnosis is mechanical, not
inferred.

**The fix, against the same real cache** — `TestModelCacheSingleFlightRegression`
runs the identical scenario through `run_on_worker_loop`: no error, both callers
get the same instance, and the factory runs **exactly once**.

**End-to-end, 3 concurrent files on pipeline `…117`** (the batch that was failing):

```
 job  | pipe |  status   | progress | errorCode | secs
------+------+-----------+----------+-----------+-------
 08a4 | 117  | COMPLETED |      100 |           | 34.45
 0ca8 | 117  | COMPLETED |      100 |           | 36.24
 6107 | 117  | COMPLETED |      100 |           | 33.68
```

Worker log for that run:
```
cross-loop errors:                     0
whisper model loads (1.6 GB):          1     ← three jobs, ONE load
worker loops started:                  1
```

That single load is a behavioural gain, not just an absence of errors: with a
loop per message, concurrent jobs could never share a load.

**Gates:** `apps/stt` pytest **2671 passed**; ruff clean across `apps/stt/src` and
`apps/stt/tests`; mypy clean on all three changed modules.

---

## Follow-ups (not in this ticket)

1. **`hope_runtime_models.ModelCache` is still loop-bound** for any future consumer
   that runs multiple loops. Harmless today (stt now has one loop; the five FastAPI
   services always had one), but the class carries an undocumented invariant —
   "all callers must share one event loop". Worth stating in its docstring, or
   removing with option (d).
2. **No `command_timeout` on the worker's DB calls** (carried over from BUG-015).
3. **Stale queue messages** retry until the budget is exhausted; a 404 on `/start`
   is not retryable and should `SkipMessage` immediately (carried over).

---

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | **Ticket created, fixed, and runtime-verified.** Traced `got Future … attached to a different loop` to `hope_runtime_models.ModelCache` single-flight: the in-flight future is created on the owner's loop and awaited by waiters via `asyncio.shield`, which cannot work when every message has its own loop. Evidence separated cleanly by pipeline — the cloud-only pipeline (no shared models) passed 4/4 while the whisper pipeline (shared model + VAD) failed only under concurrency. Rejected per-thread loops (four live loops still cannot share a future) in favour of ONE process-wide loop, safe because all blocking work already runs under `asyncio.to_thread`. Also fixed worker boot/cleanup, which built services on throwaway loops. The old failure is now pinned as a passing witness test. 3-file concurrent E2E on the previously-failing pipeline: 3/3 COMPLETED, 0 cross-loop errors, and the 1.6 GB model loaded once instead of per job. |
