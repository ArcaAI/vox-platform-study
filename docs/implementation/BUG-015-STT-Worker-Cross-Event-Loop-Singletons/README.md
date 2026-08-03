# BUG-015 — STT batch worker: process-wide singletons leak across per-message event loops; jobs stall 300s and connection pools accumulate until Postgres refuses connections

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, during multi-file batch-upload testing (3 files submitted concurrently, 2 appeared to finish) |
| **Severity** | High — batch transcription is intermittently, silently slow (one observed 300s stall on a 2s job) and degrades to total failure on a long-running worker as Postgres `max_connections` is exhausted |
| **Affected apps/packages** | `apps/stt` (`core/database/connection.py`, `core/api_client/gateway.py`, `core/effective_config.py`) |
| **Affected surfaces (symptom only)** | `apps/admin-console` `/playground/live-transcription?tab=batch`, `apps/compat-playground` batch-upload tab |
| **Related tickets** | BUG-011 (worker has no dev start path), BUG-012 (submit-side 400 for global-admin sessions), BUG-013 (internal callbacks 404 for non-default tenants), TASK-603 (compat batch upload). BUG-015 is a DISTINCT defect — it is in the worker's own concurrency model, not in the gateway contract. |

---

## Requirement Analysis

Submitting N files to the batch playground must transcribe all N, each in roughly the
single-file time, with progress and completion surfaced per file. The reported symptom
was "sent 3, got 2 finished".

**The report was a timing artifact, not data loss.** All three jobs completed. The third
(`019fc849-8f6a…`, `test-1.wav`) completed at `15:46:34` — **five minutes** after the
other two. Its SSE stream had long since ended, so the UI never showed it.

---

## Current State Evaluation

### 1. The observation

```
15:41:32.497  [8f6a] Loading pipeline 81000000-…       ← last log line
15:46:32.556  [8f6a] status 200 → Downloading audio    ← resumes
```

**300.06 seconds**, stalled inside `pipeline_reader.get_pipeline()`
(`transcription/workers/transcribe_file.py:182`) — the job's first database access.
It then ran normally and completed. A clean 300s is a timeout expiring, not contention:
the coroutine was blocked on a socket that no longer had a live event loop behind it.

Two other jobs on other worker threads, doing the identical call in the same
millisecond, returned in ~5 ms.

### 2. The mechanism

The Dramatiq worker runs `--threads 4` and each message gets its own `asyncio.run()`
loop. Three process-wide objects outlive those loops while holding loop-bound state:

| Singleton | Loop-bound state |
|---|---|
| `connection._get_or_create_engine` | a SQLAlchemy async engine whose pool holds asyncpg connections bound to the creating loop |
| `gateway.get_api_client` (`@lru_cache`) | ONE `httpx.AsyncClient` shared by every loop in the process |
| `effective_config.get_effective_config_client` (module global) | `asyncio.Lock` + per-tenant override locks |

The worker's own log already recorded two of them failing:

```
stt.effective_config.worker_concurrency_error:
  <asyncio.locks.Lock … [unlocked, waiters:1]> is bound to a different event loop
[8f5c] Cancellation check failed:
  <asyncio.locks.Event …> is bound to a different event loop
```

### 3. Why the DB cache did not protect against this

`connection.py` *tried* to be per-loop — it kept `_engines: dict[int, AsyncEngine]`
keyed by `_get_loop_id() == id(asyncio.get_running_loop())`. **`id()` is a memory
address, and CPython recycles it as soon as a loop is collected.** Measured:

```
distinct loop addresses: 47 over 400 sequential asyncio.run() calls
address REUSES: 353   first at run 38
```

So after a handful of jobs, `loop_id in _engines` is a **false positive** almost every
time, and the job is handed an engine bound to a *closed* loop. `pool_pre_ping` then
blocks on that dead socket until a ~300s timeout, discards it, opens a fresh connection
on the live loop, and the job proceeds — five minutes late. Whether a given job gets a
fast success, a `RuntimeError`, or a 300s stall is luck of the draw, which is why two of
the three files were unaffected.

### 4. Second defect in the same code — engines were never disposed

`_engines` was only ever cleared by `close_database()` (shutdown). Every new loop that
did not hit an address collision added a pool. Reproduced against the live dev database
(`max_connections = 50`):

```
total=24 ok=20 failures=4
  TooManyConnectionsError: sorry, too many clients already
```

24 jobs → 19 engines → connection exhaustion. A long-running worker eventually fails
*every* job, and presents as a database problem rather than a worker leak.

### 5. Also observed (pre-existing, not caused by this)

54 stale messages from earlier test rounds churned through `dramatiq:stt_batch` at
`15:42`, each 404-ing on `/start` for job ids under the default tenant that no longer
resolve. They competed for the same worker threads. The queue has since drained to 0;
no action taken.

---

## Implementation Plan

### Options considered

| Option | Verdict |
|---|---|
| **(a) Per-loop resources, correctly keyed** | **Chosen.** Key on loop IDENTITY rather than address, and prune closed loops. Fixes both the stall and the pool leak; keeps 4-thread concurrency; contained to three factory functions. |
| (b) One persistent loop per worker thread (drop `asyncio.run()` per message) | Structurally cleanest — the singletons become correct by construction — but a much larger change to the actor/worker bootstrap, and riskier to land against a live defect. Remains the better long-term shape. |
| (c) Run the worker single-threaded | Rejected as a fix. A single thread still creates a new loop per message, so neither the dead-loop reuse nor the pool leak goes away; it only reduces the odds. Throughput drops to one file at a time. |

### Design — `stt/core/loop_local.py`

One helper replaces three ad-hoc caching mechanisms:

1. **Identity, not address.** A binding holds a **strong** reference to its loop and is
   reused only when `binding.loop is running_loop`. A recycled address fails that check,
   so a dead loop's value can never be served. The strong reference additionally pins the
   address while the entry lives, so the collision cannot arise in the first place.
2. **Prune on every lookup.** Bindings whose loop has closed are disposed and dropped, so
   the worker holds at most one binding per *live* loop rather than one per job.

`dispose` runs when the owning loop is already gone, so it must not await: for a
SQLAlchemy engine that is `sync_engine.dispose(close=False)`, which abandons the pooled
connections instead of trying to close them on a dead loop. A failing `dispose` is logged
and swallowed — reclaiming a stale binding must never break the job that triggered it.
The registry is guarded by a `threading.Lock` because all four worker threads reach it.

---

## Implementation Summary

| File | Change |
|---|---|
| `apps/stt/src/stt/core/loop_local.py` | **New.** `get_loop_local(namespace, factory, dispose)`, `loop_local_size()`, `reset_loop_locals()`. Loop-identity keying, closed-loop pruning, thread-safe registry. |
| `apps/stt/src/stt/core/database/connection.py` | `_engines`/`_session_factories`/`_get_loop_id` removed; `_get_or_create_engine` now goes through `get_loop_local` with `_dispose_stale` (`sync_engine.dispose(close=False)`). New `engine_cache_size()` for the leak guard. `close_database` awaits `dispose()` for the current loop and `reset_loop_locals` for the rest. |
| `apps/stt/src/stt/core/api_client/gateway.py` | `@lru_cache` dropped from `get_api_client`; bound per loop so each job's `httpx.AsyncClient` stays on its own loop. |
| `apps/stt/src/stt/core/effective_config.py` | Module global `_client` replaced with a per-loop binding, so `_lock` and the per-tenant override locks are never awaited from a foreign loop. `reset_effective_config_client()` delegates to `reset_loop_locals`. |
| `apps/stt/tests/unit/test_loop_local_bug015.py` | **New.** Same-loop reuse, per-loop isolation, namespace independence; a deterministic recycled-address test (a stale binding planted under the running loop's id with a *closed* loop object) proving the dead value is disposed rather than served; pruning bound (`size <= 1` after 5 jobs); `dispose` failure never propagates. |
| `apps/stt/tests/unit/test_worker_singletons_bug015.py` | **New.** All three singletons are per-loop and reused within a loop; `engine_cache_size() <= 1` after 8 jobs (the leak guard); the effective-config `asyncio.Lock` is not shared across loops. |
| `apps/stt/tests/unit/test_database_connection.py` | Updated: the five tests that pinned `_get_loop_id` / `_engines` / `_session_factories` now pin the loop-binding contract and `close_database` behaviour instead. |
| `apps/stt/tests/unit/test_api_client.py` | Updated: `cache_clear()` → `reset_loop_locals`; added a per-loop-distinctness test. |

---

## Verification

TDD: RED captured first (`ModuleNotFoundError: stt.core.loop_local`, then 6 failing
assertions), then implementation.

**Loop-address recycling (the premise), measured:**
```
distinct loop addresses: 47 over 400 runs
address REUSES: 353   first at run 38
```

**Pool leak, same reproduction script before and after** (4 threads × 6 jobs against the
live dev database):
```
before:  total=24 ok=20 failures=4   TooManyConnectionsError: sorry, too many clients already
after:   total=24 ok=24 failures=0
```

**End-to-end, 3 files submitted concurrently as tenant `…0001`:**
```
      id       |  status   | progress | errorCode | secs
---------------+-----------+----------+-----------+------
 019fc85d-d4b1 | COMPLETED |      100 |           | 2.44
 019fc85d-d4ba | COMPLETED |      100 |           | 2.38
 019fc85d-d4cb | COMPLETED |      100 |           | 2.23
```
(previously: 2.4s, 2.4s, **300s**)

**Worker log after the fix:** `0` occurrences of `bound to a different event loop`
(previously present for both the effective-config lock and the cancellation Event).

**Gates:** `apps/stt` pytest **2661 passed**; ruff clean across `apps/stt/src` and
`apps/stt/tests`; mypy clean on all four changed modules.

---

## Follow-ups (not in this ticket)

1. **Option (b) remains the better end state** — one persistent loop per worker thread
   would make every one of these singletons correct by construction and remove the need
   for the registry. Worth doing when the worker bootstrap is next touched.
2. **No timeout on the worker's DB calls.** The 300s stall was survivable only because
   something upstream eventually timed out. A bounded `command_timeout` on the asyncpg
   connect args would turn a future hang into a fast, retryable failure.
3. **Stale queue messages.** Jobs whose rows no longer resolve retry until the Dramatiq
   retry budget is exhausted, burning worker threads. A 404 on `/start` is not
   retryable and should `SkipMessage` immediately.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | **Ticket created, fixed, and runtime-verified in one pass.** Root cause traced from a "3 files sent, 2 finished" report: no job was lost — one stalled exactly 300.06s in its first DB query. Cause is process-wide singletons holding event-loop-bound state in a worker that creates one event loop per message, with the DB cache's `id(loop)` key giving false hits because CPython recycles loop addresses (353 reuses in 400 runs). Second defect found in the same code: engines were never disposed, exhausting Postgres `max_connections` after 24 jobs (reproduced). Fixed with a loop-identity-keyed, self-pruning `loop_local` registry behind all three singletons. TDD RED captured before implementation; unit/ruff/mypy gates green; 3-file concurrent E2E now 2.2–2.4s each with zero cross-loop errors in the worker log. |
