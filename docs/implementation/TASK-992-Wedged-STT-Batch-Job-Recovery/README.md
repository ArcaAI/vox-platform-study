# TASK-992 — Wedged STT Batch Job Recovery

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-19 |
| **Surfaces** | `packages/database`, `packages/domains`, `packages/exceptions`, `packages/applications`, `apps/api`, `apps/stt` |
| **Rules read** | `01-development-workflow.md`, `02-database-prisma.md`, `03-domain-layer.md`, `04-application-services.md`, `05-nestjs-api.md`, `06-python-services.md`, `09-infrastructure-devops.md` (§Configuration Tiers) |

---

## 1. Requirement Analysis

A transcription job whose worker dies mid-flight is permanently unrecoverable. Observed live on
`dev-2.2` (2026-09-19), job `01a0b94c-637e-78c0-a279-3a83cf8df46b`, and confirmed in the database at
planning time:

```
id          01a0b94c-637e-78c0-a279-3a83cf8df46b
tenantId    01a0b940-6566-7265-88d8-a6b55576a20a
status      PROCESSING     progress 75      workerId worker-59400
retryCount  0 / 3          completedAt NULL  _version 1
queuedAt    2026-09-19T03:53:06Z
startedAt   2026-09-19T03:54:07Z
updatedAt   2026-09-19T03:54:16Z   ← last progress write; silent ever since
```

The observed sequence, from `stt-worker.log` + `stt-worker2.log`:

1. `worker-59400` picked the job up, reached *"Running speaker diarization…"*, then died with
   `concurrent.futures._base.CancelledError` out of
   [`worker_loop.py:131`](../../../apps/stt/src/stt/core/worker_loop.py) (`run_on_worker_loop`) — the
   worker process was restarted.
2. Dramatiq redelivered the message to `worker-62315`, which called
   `PATCH /api/v1/internal/stt/jobs/{id}/start`.
3. The gateway answered **500** `"Cannot start job in PROCESSING status"` —
   [`TranscriptionJobEntity.startProcessing`](../../../packages/domains/src/entities/generated/core/TranscriptionJobEntity.ts)
   throws `BusinessException` for ANY non-`QUEUED` status.
4. [`gateway.py` `_is_terminal_state_error`](../../../apps/stt/src/stt/core/api_client/gateway.py)
   matches on the SUBSTRING `"Cannot start job in"`, so `PROCESSING` — which is not terminal — is
   classified terminal and raised as `JobTerminalError`.
5. [`transcribe_file.py`](../../../apps/stt/src/stt/transcription/workers/transcribe_file.py) catches
   `JobTerminalError`, logs *"Job already in terminal state, skipping duplicate delivery"* and
   `return`s — **ACKing** the message.

Net effect: the job is orphaned in `PROCESSING`, `retryCount` never increments, nothing ever fails it,
and the only thing that ends the client's wait is its own timeout
(`AgentsResource.waitForTranscription` threw `TranscriptionJobTimeoutError` after 300 s).

### 1.1 Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | A `/start` refused because the job's status forbids the transition answers **409**, not 500, and carries a machine-readable `code` plus the current status — no substring parsing required. |
| AC-2 | A redelivery of a job stuck in `PROCESSING` under a DIFFERENT worker **reclaims** it: the job keeps running under the new worker and reaches a terminal state. |
| AC-3 | A redelivery under the SAME worker is idempotent (200, no state change). |
| AC-4 | Reclaims are bounded; past the bound the job is marked `DEAD` and the worker ACKs, rather than looping forever. |
| AC-5 | A Dramatiq retry after a `_fail_job` actually re-attempts the job (see §2.2), bounded by the existing `retryCount`/`maxRetries`. |
| AC-6 | A `PROCESSING` job that is never redelivered at all reaches a terminal state on its own (reaper). |
| AC-7 | Python regression: a 500 (legacy) or 409 (new) `"Cannot start job in PROCESSING status"` is NOT treated as terminal. |
| AC-8 | Gateway regression: the entity, the service and the HTTP status/shape are pinned by tests. |

### 1.2 Owner decisions taken at planning (2026-09-19)

| # | Decision |
|---|---|
| **OD-1** | **Fix the `FAILED` path in the same ticket.** It is the same defect on a different status (§2.2), and leaving it turns the actor's `max_retries=3` into decoration. |
| **OD-2** | **Bound reclaims with a NEW `reclaimCount` column**, not by reusing `retryCount`. A crash-reclaim and a genuine transcription failure are different events and must not share a budget: a worker OOM should not spend the retry allowance a bad audio file needs. |
| **OD-3** | **Ship the reaper.** Reclaim only helps when the broker redelivers; a lost message still strands the row. Gateway-side sweep modelled on `ConsultationTimeoutSweepService`. |

---

## 2. Current State Evaluation

### 2.1 The refusal is structurally unreadable

`BusinessException` extends `BaseDomainException` → `BaseException`, and
[`ExceptionInterceptor`](../../../apps/api/src/interceptors/exception.interceptor.ts) has a specific
branch for OCC, `DataNotFound`, quota, consent, spend-limit and `ArgumentInvalid` — but a plain
`BusinessException` falls through to the generic branch:

```ts
if (err instanceof BaseException) {
  return throwError(() => new HttpException(unifiedDomainBody(err, 500), 500));
}
```

so the body is `{ statusCode: 500, code: 'DOMAIN.BUSINESS', message: 'Cannot start job in PROCESSING status', … }`.
`DOMAIN.BUSINESS` is shared by every business-rule refusal in the platform, which is exactly why the
Python client had nothing better than the message text to key on.

### 2.2 The same defect silently disables every retry on the FAILED path

Not named in the report, found while tracing. In `transcribe_file`:

```python
except TranscriptionError as e:
    await _fail_job(...)   # row → FAILED
    raise                  # "Let Dramatiq handle retry"
```

The retry re-enters the actor at the top and calls `/start`. The row is now `FAILED`,
`startProcessing` refuses it, the substring match classifies it terminal, and the worker returns and
ACKs. **`max_retries=3` / `min_backoff=10 s` on the `transcribe_file` actor has never produced a
successful re-attempt.** Same mechanism, different status — fixing only `PROCESSING` would leave it.

### 2.3 `workerId` is not unique, so "a different worker" is not currently a sound signal

[`transcribe_file.py:175`](../../../apps/stt/src/stt/transcription/workers/transcribe_file.py) —
`worker_id = f"worker-{os.getpid()}"`. PIDs collide across pods, so two different workers can present
the same id and a genuine reclaim would be misread as an idempotent re-`/start`. Any reclaim rule
depends on fixing this first.

### 2.4 Why a staleness window is the WRONG gate for reclaim (and the right one for the reaper)

The redelivered worker calls `/start` immediately. The actor's backoff is 10 s → 300 s over 3 tries
(≈70 s of wall clock), so any staleness window long enough to be safe against a live worker — the job
died *in diarization*, a phase that emits no progress for minutes — is longer than the worker can
possibly wait for. Gating reclaim on wall clock would therefore convert this bug into a slower version
of itself.

The sound signal for reclaim is **a different worker is holding the same message**: Dramatiq's Redis
broker only requeues after it has declared the prior consumer dead, and `time_limit=600 s`
(`transcription_timeout_seconds`) hard-bounds any attempt that is somehow still alive. Wall-clock
staleness is reserved for the reaper, whose whole job is the case where no redelivery ever arrives.

### 2.5 Assets already in place

| Asset | Where | Use |
|---|---|---|
| `ConsultationTimeoutSweepService` | `packages/applications/src/services/consultation/timeout-sweep/` | Exact precedent for the reaper: self-scheduling `CronJob` via `SchedulerRegistry`, re-synced on `app-settings.cache-refreshed`, cross-tenant read + per-row `clsService.run()` write. |
| `findProcessingJobs(tenantId?)` | `TranscriptionJobRepository` | Cross-tenant `PROCESSING` query already exists ("for worker health monitoring"); needs a staleness predicate + `take`. |
| `ResourceType.TranscriptionJob` | `packages/domains/src/enums/generated/ResourceType.ts:35` | Already present — **no enum parity work and no `ADD VALUE` migration needed.** |
| `@Optional()`-trailing-param convention | `SttInternalService` constructor | Lets `IAppSettingsService` be added without breaking positional unit fixtures. |

### 2.6 Scale of the problem in the dev database

`PROCESSING: 2` — the reported job, plus the **seeded lifecycle fixture**
`98000000-0000-0000-0000-000000000002` (`workerId: asr-worker-02`, `startedAt` 2026-02-20), written by
[`seed/09-consultation.ts:1307`](../../../packages/database/src/prisma/db_main/seed/09-consultation.ts).
Nothing in `apps/**`, `packages/**` or `tests/**` asserts that row's status — see §3.7 for how the
reaper treats it.

---

## 3. Implementation Plan

Layer order per `01-development-workflow.md`: **Database → Domain → Services → API**, then Python, then
the seed. TDD throughout — failing test first, and the RED must actually be observed.

### 3.1 Database — `packages/database`

Add ONE counter column and ONE index to `TranscriptionJob` (`src/prisma/db_main/stt.prisma`):

```prisma
  // Error handling
  retryCount   Int @default(0)
  maxRetries   Int @default(3)
  // TASK-992 — crash-reclaims are counted SEPARATELY from retries (OD-2): a
  // worker that died mid-flight must not spend the retry budget a genuinely
  // failing transcription needs. Bound lives in `stt.batch.maxReclaims`
  // (global-kv), not in a sibling column — it is a platform threshold, not a
  // per-row property.
  reclaimCount Int @default(0)
  …
  @@index([status, updatedAt], name: "TranscriptionJob_status_updated_idx")   // the reaper's access path
```

Migration authored against a throwaway shadow DB per `02-database-prisma.md` §Migration Workflow
(`hope_shadow`, `db:migrate:deploy` to replay, `db:migrate:create -n task_992_transcription_job_reclaim_count`
at the **package** level so `-n` is not swallowed, re-deploy, then prove
`prisma migrate diff --from-config-datasource --to-schema … --script` prints
`-- This is an empty migration.`), then `unset DATABASE_URL DIRECT_URL && pnpm db:push` on the real dev
DB and drop the shadow.

No allow-list changes: `TranscriptionJob` is an existing model, already tenant-scoped, and already in
`MODELS_WITHOUT_SOFT_DELETE` (it carries no `resourceStatus` fields).

### 3.2 Exceptions — `packages/exceptions`

New `InvalidStateTransitionException extends BaseDomainException`, code
`DOMAIN.INVALID_STATE_TRANSITION`, metadata:

```ts
{ entity: string; entityId: string; currentStatus: string; attempted: string; terminal: boolean }
```

`terminal` is the load-bearing field: the gateway owns the state machine and therefore knows whether
the current status admits any future transition. Shipping that as a boolean means the worker never
has to re-derive terminality from a status string it may not know — which is the class of coupling
that produced this bug.

### 3.3 Domain — `packages/domains`

`TranscriptionJobEntity` (hand-authored; `gen:mapper` is destructive and must never be run —
`03-domain-layer.md`):

| Method | Rule |
|---|---|
| `startProcessing(workerId)` | Unchanged semantics (`QUEUED` only); throws the new exception instead of `BusinessException`. |
| `reclaimProcessing(workerId, maxReclaims)` **new** | Requires `isProcessing`, `workerId !== this._workerId`, `reclaimCount < maxReclaims`. Bumps `reclaimCount`, sets `workerId`, `startedAt = now`, `progress = 0`. |
| `reattemptAfterFailure(workerId)` **new** | Requires `isFailed` and `retryCount < maxRetries`. Bumps `retryCount`, status → `PROCESSING`, clears `completedAt`/`errorMessage`/`errorCode`, sets `workerId`, `startedAt = now`, `progress = 0`. |
| `complete` / `fail` / `cancel` | Switched to the new exception — same class of refusal on the same entity. Deliberately NOT a platform-wide `BusinessException` sweep; that is scope creep. |
| `reclaimCount` | New tracked property; all writes through `setProperty` for change tracking. |

Every transition stays on the entity, where this state machine already lives. All writes go through
`setProperty` so `repository.update` persists only `entity.changes`.

`TranscriptionJobRepository`: `findStaleProcessingJobs(staleBefore: Date, limit: number)` — cross-tenant,
`status: PROCESSING AND updatedAt < staleBefore`, `orderBy updatedAt asc`, `take limit`.

Then `pnpm gen:model`, hand-edit entity/factory/mapper/repository, and `gen:entity` + `gen:factory`
(`:check` variants) to reconcile barrels and prove schema coverage.

### 3.4 Application services — `packages/applications`

**`SttInternalService.startJob` becomes a CLAIM, not a start:**

| Current status | Behaviour |
|---|---|
| `QUEUED` | `startProcessing` — today's path, unchanged |
| `PROCESSING`, same `workerId` | idempotent — return the current row, no write (AC-3) |
| `PROCESSING`, different `workerId`, budget left | `reclaimProcessing` → 200 (AC-2) |
| `FAILED`, retries left | `reattemptAfterFailure` → 200 (AC-5) |
| `PROCESSING`/`FAILED`, budget exhausted | **persist `markAsDead()` first**, then throw `terminal: true` → 409 (AC-4) |
| `COMPLETED` / `CANCELLED` / `DEAD` | throw `terminal: true` → 409 |

Marking `DEAD` before throwing matters: there is no transaction around this handler, so the write must
land before the throw or the job stays stuck in exactly the state this ticket exists to remove.

`broadcastSysEvent(ResourceUpdated)` on every mutating branch, carrying `reclaimedFrom` on a reclaim so
the previous owner is recoverable from the audit trail (the row only keeps the current `workerId`).

**New `SttJobReaperService`** (`services/stt/job/reaper/`), modelled on `ConsultationTimeoutSweepService`:
self-scheduling `CronJob` via `SchedulerRegistry`, re-synced on `@OnEvent('app-settings.cache-refreshed')`,
cross-tenant eligibility read with no CLS context, per-row write wrapped in `clsService.run()` bound to
that row's `tenantId` so the sys-event is attributed correctly. Each eligible row:
`job.fail(<reason>, 'WORKER_LOST')` → `repository.update` → `ResourceUpdated`.

**Three `global-kv` settings** (`settings-registry/descriptors/`), per
`09-infrastructure-devops.md` §Configuration Tiers — a threshold is never a literal and never an env var:

| Key | Default | Why that default |
|---|---|---|
| `stt.batch.maxReclaims` | `3` | Matches the existing `maxRetries` shape; bounds a crash-loop. |
| `stt.batch.staleProcessingMinutes` | `20` | 2× the actor's `time_limit` (`transcription_timeout_seconds = 600 s`), so the reaper can never fire while an attempt could legitimately still be running. |
| `stt.batch.reaper.cron` | every 5 min | Matches the sweep cadence precedent. |

All three `failMode: 'open-to-default'` — they are tuning knobs, not selections.

### 3.5 API gateway — `apps/api`

- `ExceptionInterceptor`: new branch mapping `InvalidStateTransitionException` → **409 Conflict**,
  placed **before** the generic `BaseException` branch (same ordering constraint the OCC / quota /
  consent branches already document — the generic branch would otherwise claim it as a 500).
- `@ApiResponse({ status: 409 })` on `PATCH internal/stt/jobs/:id/start`.
- Register `SttJobReaperServiceModule` in `app.module.ts`.
- Regenerate **all five** artifacts together per `05-nestjs-api.md`:
  `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`,
  then the three `:check` gates.

### 3.6 Python — `apps/stt`

- **Unique worker identity**: `worker_id = f"{socket.gethostname()}-{os.getpid()}"` (§2.3). Without
  this, the reclaim rule is unsound across pods.
- **`gateway.py`**: `_is_terminal_state_error` → `_classify_state_conflict(error) -> "terminal" | "conflict" | None`:
  - `code == 'DOMAIN.INVALID_STATE_TRANSITION'` → read `metadata.terminal`. Accepts **409 and 500**.
  - **Legacy fallback**, kept for the mixed-version window during a rolling update: parse the status
    token out of `"Cannot start job in <STATUS> status"` and treat it as terminal only for
    `COMPLETED / FAILED / CANCELLED / DEAD`. `PROCESSING` → `conflict`. This deliberately keeps
    `FAILED` terminal on the legacy branch: against an OLD gateway a `FAILED` re-attempt can never
    succeed, and classifying it retryable would spin the worker instead of fixing anything.
    Register the fallback in `docs/operations/deprecation-register.md` for removal in R4.
- **New `JobConflictError(JobError)`**, `error_code = "JOB_CONFLICT"` — deliberately NOT added to
  `NON_RETRYABLE_EXCEPTIONS`, so Dramatiq retries it with backoff.
- **`transcribe_file.py`**: new `except JobConflictError` → log and `raise` (let the broker retry).
  No `_fail_job` on that branch — the job is legitimately owned by someone else, and failing it would
  clobber a live attempt.

### 3.7 Seed — `packages/database`

The seeded lifecycle fixture `98000000-0000-0000-0000-000000000002` is a permanently-`PROCESSING` row,
so the reaper will transition it to `FAILED (WORKER_LOST)` ~20 minutes after each `db:seed`.

> ⚠️ **Deviation from the answer given at planning, flagged for approval.** The chosen option said
> "I'll adjust the seed fixture so it isn't reaped". Having looked at it, every way to exempt it is
> worse than the churn: a `seedFixture` marker in `_metadata` puts fixture-awareness into a production
> code path, and a status/threshold carve-out makes the reaper's rule untrue. Nothing in
> `apps/**`, `packages/**` or `tests/**` asserts that row's status (§2.6), so the only cost is a dev
> demo row changing colour after 20 minutes — which is, in fact, the new behaviour being correct.
>
> **Plan of record: leave the seed unchanged and document it here.** Say the word and I will instead
> repoint the fixture (e.g. convert it to `DEAD` and add a short-lived `PROCESSING` row) — it is a
> ten-minute change either way.

### 3.8 Test list (TDD — written first, RED observed)

**Python** — `apps/stt/tests/unit/test_gateway_job_claim_task992.py`:

| # | Test |
|---|---|
| P-1 | 500 + `"Cannot start job in PROCESSING status"` (legacy body) → **not** terminal → `JobConflictError` (**the regression the report asks for**) |
| P-2 | 409 + `code: DOMAIN.INVALID_STATE_TRANSITION`, `metadata.terminal = false` → `JobConflictError` |
| P-3 | 409 + `metadata.terminal = true` → `JobTerminalError` |
| P-4 | 500 + `"Cannot start job in COMPLETED status"` → `JobTerminalError` (legacy terminal preserved) |
| P-5 | 500 + `"Cannot start job in FAILED status"` → `JobTerminalError` on the legacy branch (§3.6) |
| P-6 | An unrelated 500 → plain `APIGatewayError`, neither subclass |
| P-7 | `worker_id` is unique per host+pid, and two hosts with the same pid differ |
| P-8 | `transcribe_file` on `JobConflictError` re-raises (Dramatiq retries) and does **not** call `fail_job` |

**Domain** — `TranscriptionJobEntity.test.ts`: reclaim happy path; reclaim refused for same worker;
reclaim refused past `maxReclaims`; `reattemptAfterFailure` clears error fields and bumps `retryCount`;
each refusal throws `InvalidStateTransitionException` with the right `currentStatus` / `terminal`.

**Application** — `sttInternal.service.test.ts`: the six rows of the §3.4 table, including that the
budget-exhausted branch **persists `DEAD` before throwing**; `reclaimedFrom` on the sys-event.
`SttJobReaperService` tests: eligibility window, per-row CLS tenant binding, `WORKER_LOST` error code,
a fresh `PROCESSING` row is left alone.

**API** — `exception.interceptor` test: `InvalidStateTransitionException` → 409 with
`code: 'DOMAIN.INVALID_STATE_TRANSITION'`, and it is not shadowed by the generic `BaseException` branch.

### 3.9 Verification gates

```
pnpm --filter @arcaai/database test
pnpm --filter @arcaai/domains  build test
pnpm --filter @arcaai/applications build test
pnpm api:build && pnpm test:unit
pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin
pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check
pnpm gen:model:check && pnpm gen:entity:check && pnpm gen:factory:check
pnpm stt:test && pnpm stt:lint && pnpm stt:typecheck
pnpm lint
```

Plus a **boot smoke** (`/health` on a started gateway) — a new module + a new interceptor branch is
exactly the change class that unit suites never exercise, because they do not boot `main.ts`.

**Live proof** (the point of the ticket): re-run a batch transcription, kill the worker mid-flight,
and show the redelivery reclaiming the job through to `COMPLETED`. Then leave a `PROCESSING` row with
no redelivery and show the reaper closing it.

### 3.10 Out of scope

- The platform-wide `BusinessException` → 500 mapping. Only the `TranscriptionJob` state machine moves
  to the new exception; a general sweep is a separate ticket.
- Re-enqueuing a Dramatiq message for a row an admin flips back to `QUEUED` via `retryJob` — a
  pre-existing gap (the row changes, nothing publishes a message). Noted for a follow-up.
- Streaming sessions. This ticket is the batch (`stt_batch`) path only.

---

## 4. Implementation Summary

`PATCH /internal/stt/jobs/:id/start` is now a **claim**, not a start. The worker calls it on every
delivery and the gateway decides what that means for the row it finds.

| Current status | Outcome | HTTP |
|---|---|---|
| `QUEUED` | start (unchanged) | 200 |
| `PROCESSING`, same `workerId` | idempotent — no write, no event | 200 |
| `PROCESSING`, different `workerId`, budget left | **reclaim** (`reclaimCount++`) | 200 |
| `FAILED`, retries left | **re-attempt** (`retryCount++`, error fields cleared) | 200 |
| either budget spent | marked `DEAD` **and persisted**, then refused | 409 `terminal: true` |
| `COMPLETED` / `CANCELLED` / `DEAD` | refused, nothing written | 409 `terminal: true` |

### 4.1 Files changed

| Layer | Change |
|---|---|
| `packages/database` | `TranscriptionJob.reclaimCount Int @default(0)` + `TranscriptionJob_status_updated_idx` (the reaper's access path). Migration `20260919120314_task_992_transcription_job_reclaim_count`, authored against a throwaway `hope_shadow`, drift-proved empty, then `db:push` to dev. |
| `packages/exceptions` | New `InvalidStateTransitionException` / `DOMAIN.INVALID_STATE_TRANSITION`, metadata `{ entity, entityId, currentStatus, attempted, terminal }`. |
| `packages/domains` | `TranscriptionJobEntity`: new `reclaimProcessing` / `reattemptAfterFailure`, one `refuseTransition` helper behind `startProcessing` / `complete` / `fail` / `cancel`, and the private `isClaimTerminal` (narrower than `isTerminal`, because a `FAILED` job with retries left is re-attemptable). `TranscriptionJobRepository.findStaleProcessingJobs`. Factory + model carry `reclaimCount`. |
| `packages/applications` | `SttInternalService.startJob` rewritten as the table above, plus `retireExhaustedClaim`. New `SttJobReaperService` (+ module, barrel, `stt-job-reaper` worker-session kind). Three `global-kv` descriptors in a new `STT_BATCH_DEFAULTS` map. `reclaimCount` on the response DTO + mapper. |
| `apps/api` | `ExceptionInterceptor` branch → **409**, placed before the generic `BaseException` branch. `@ApiOperation`/`@ApiResponse` on the claim route. `SttJobReaperServiceModule` registered. |
| `apps/stt` | `_classify_state_conflict` replaces `_is_terminal_state_error`; new `JobConflictError`; worker identity is now `{hostname}-{pid}`; the refusal branch re-raises for the broker instead of ending the job. |

### 4.2 Configuration added (all `global-kv`, `globalOnly`, `open-to-default`)

| Key | Default | Why |
|---|---|---|
| `stt.batch.maxReclaims` | `3` | Bounds a crash-loop; past it the job is `DEAD`. |
| `stt.batch.staleProcessingMinutes` | `20` | 2x the actor's `time_limit` (600 s), so the reaper can never fire while an attempt could still be running. |
| `stt.batch.reaper.cron` | `*/5 * * * *` | Sweep cadence. |

`STT_BATCH_DEFAULTS` is deliberately a SEPARATE map from `STT_GATEWAY_DEFAULTS`:
`SttWsGateway.resolveBudget` indexes the latter generically (`keyof typeof`) while promising a
`number`, so a cron string in it breaks the gateway's build.

### 4.3 ⚠️ This SUPERSEDES the TASK-991 W2-4 fix (owner decision, 2026-09-19)

Mid-implementation, commit `efbeaee81` (TASK-991 lane W2-B) landed a Python-only fix for the same
defect: it read the status back over a second HTTP call and ended a `PROCESSING` job **FAILED**, on
the reasoning that *"nothing can resume it: the previous attempt's audio, models and partial results
went with its process."*

That reasoning did not hold — the audio is in object storage and `transcribe_file` re-downloads it
on every delivery, so a recoverable transcription was being discarded — and, seeing only a status,
it could not tell another worker's claim from its own, so a retried `/start` could end a healthy
job. The owner chose to supersede it. **W2-2 and W2-3 of that commit are untouched.** Every scenario
its 14 tests pinned is still pinned in a rewritten
`apps/stt/tests/unit/test_task991_orphaned_job_recovery.py`, with the `PROCESSING` verdict inverted.
`JobNotResumableError` and `_observed_job_status` are gone; `JobConflictError` replaces the former.

### 4.4 Evidence

Gates (all run, 2026-09-19):

```
gen:model:check     no drift — 181 generated file(s) match
gen:entity:check    no drift — 103 files; Schema coverage OK (101 artifacts, 105 models)
gen:factory:check   no drift — 103 files; Schema coverage OK
@arcaai/exceptions    Test Files 3 passed    Tests 11 passed
@arcaai/domains       Test Files 173 passed  Tests 2031 passed | 2 skipped | 9 todo
@arcaai/applications  Test Files 908 passed  Tests 14561 passed | 10 skipped
pnpm test:unit        Test Files 1775 passed Tests 27569 passed | 4 skipped | 9 todo
pnpm stt:test (unit)  3815 passed
stt:lint              All checks passed!
stt:typecheck         Success: no issues found in 140 source files
pnpm lint             exit 0 — 40 successful, 40 total
api:openapi:check / api:portal:check / vox-node gen:admin:check   no drift
boot smoke            GET /api/v1/health -> 200; "STT stranded-job reaper scheduled" cron=*/5 * * * *
```

Three failures are PRE-EXISTING and out of scope; each is in a file this ticket does not touch
(verified `git status` clean for both paths):

| Failure | Cause |
|---|---|
| `test_task799_env_surface.py::test_minio_credentials_default_to_empty` | reads a real MinIO key from the dev env; `settings.py` untouched |
| `env.schema.test.ts::PRISMA_PG_MAX` expects 5, gets 15 | host env overrides both env files (TASK-558 precedence); `apps/api/src/config/` untouched |
| `membership-bounded-sync.integration.test.ts` | Prisma `$connect()` to the live test DB (port 5433 is held by unrelated containers) |

**Live proof — the full claim state machine over real HTTP** (gateway on :8869 against the dev DB,
so as not to disturb the shared stack on :8868):

```
── AC-5  FAILED + retries left -> re-attempt ──
  PATCH /start  workerId=hostA-1001   HTTP 200  status=PROCESSING  worker=hostA-1001  retry=1 reclaim=0
── AC-3  the SAME worker re-sends its claim ──
  PATCH /start  workerId=hostA-1001   HTTP 200  status=PROCESSING  worker=hostA-1001  retry=1 reclaim=0
── AC-2  a DIFFERENT worker claims it -> reclaim ──
  PATCH /start  workerId=hostB-2002   HTTP 200  status=PROCESSING  worker=hostB-2002  retry=1 reclaim=1
  PATCH /start  workerId=hostC-3003   HTTP 200  status=PROCESSING  worker=hostC-3003  retry=1 reclaim=2
  PATCH /start  workerId=hostD-4004   HTTP 200  status=PROCESSING  worker=hostD-4004  retry=1 reclaim=3
── AC-4  budget spent -> marked DEAD, then refused ──
  PATCH /start  workerId=hostE-5005   HTTP 409  code=DOMAIN.INVALID_STATE_TRANSITION  currentStatus=DEAD terminal=True attempted=reclaimProcessing
── AC-1  genuinely terminal now ──
  PATCH /start  workerId=hostF-6006   HTTP 409  code=DOMAIN.INVALID_STATE_TRANSITION  currentStatus=DEAD terminal=True attempted=startProcessing
── the ordinary path is unregressed ──
  QUEUED -> start                     HTTP 200  status=PROCESSING  worker=hostQ-7777  retry=0 reclaim=0
```

**Live proof — the reaper, on the incident row itself (AC-6).** The reaper's first tick after its
code reached `packages/applications/dist` found and ended both stranded rows:

```
01a0b94c-637e-78c0-a279-3a83cf8df46b  FAILED  WORKER_LOST
  "Worker worker-59400 stopped reporting progress for more than 20 minutes;
   the job was never redelivered."
98000000-0000-0000-0000-000000000002  FAILED  WORKER_LOST
  "Worker asr-worker-02 stopped reporting progress for more than 20 minutes;
   the job was never redelivered."
```

The first is the exact job from the report. The second is the seeded lifecycle fixture — reaped as
§3.7 predicted.

### 4.5 Dev-database state left behind (deliberate, needs a reseed)

The live proof mutated seed/test rows in the DEV database. None is production data and none is
asserted by any test, but a `pnpm db:seed` restores them:

| Row | Left as |
|---|---|
| `98000000-0000-0000-0000-000000000002` (seeded PROCESSING fixture) | `FAILED / WORKER_LOST` — reaped |
| `98000000-0000-0000-0001-000000000002` (seeded QUEUED fixture) | `PROCESSING` under `hostQ-7777`; the reaper will fail it ~20 min later |
| `01a0b949-…`, `01a0b94a-…`, `01a0b944-…` (already-FAILED jobs from the incident) | `DEAD`, driven through the claim walk |

### 4.6 Follow-ups, deliberately NOT done here

| # | Item |
|---|---|
| ~~FU-1~~ | ~~`retryJob` flips a row back to `QUEUED` but nothing re-publishes a Dramatiq message, so an admin "retry" produces a job no worker will ever pick up.~~ **DONE — see §6.** |
| FU-2 | The platform-wide `BusinessException` → 500 mapping. Only the `TranscriptionJob` state machine moved to the new exception; a general sweep is its own ticket. |
| FU-3 | `/internal/stt/*` is `@ApiExcludeController`, so the documented 409 never reaches `openapi.json`. Pre-existing for the whole internal plane. |

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-19 | Ticket opened. Exploration complete; wedged row confirmed live in the dev DB; second defect found on the `FAILED` path (§2.2). Owner decisions OD-1…OD-3 taken. Plan written, approved. |
| 2026-09-19 | Implemented across all six layers, TDD with RED observed per layer (the reaper suite additionally mutation-checked, since its tests and code were written together). All gates green; three pre-existing failures triaged in §4.4. |
| 2026-09-19 | **Superseded the TASK-991 W2-4 fix** (`efbeaee81`) on owner decision — see §4.3. TASK-991's README and `docs/operations/deprecation-register.md` both updated. |
| 2026-09-19 | Live-proved the whole claim state machine over HTTP, and the reaper on the original incident row. `reclaimCount` added to the response DTO after the live run showed it was not observable. |
| 2026-09-19 | **FU-1 closed** (§6): a retry now re-publishes the job's Dramatiq message instead of only flipping its status. New `TranscriptionJob.dispatchEnvelope` column + migration, `retryAndDispatch` on the realtime service, retry route rewired, 409/503 refusals for rows that cannot be made runnable. Regenerating the API artifacts also swept in `reclaimCount`, which the earlier TASK-992 commit had left undone — see §6.6. |

---

## 6. FU-1 — a retry that actually re-publishes

### 6.1 The defect, confirmed

`TranscriptionJobService.retryJob` called `job.incrementRetry()` (status → `QUEUED`, `startedAt` /
`completedAt` / `workerId` cleared, progress reset), persisted, and broadcast `ResourceUpdated`.
Nothing published a Dramatiq message.

The batch plane is driven **entirely** by the `stt_batch` queue, and `transcribe_file` is enqueued in
exactly ONE place — `TranscriptionRealtimeService.dispatchDramatiqJob` — reached from three gateway
call sites (the upload route, `harness-internal`'s `stt/batch-jobs`, and `agent.controller`'s
`transcribe`). None of them is on the retry path. A row merely flipped back to `QUEUED` therefore has
no message behind it and no worker ever claims it: the caller gets a 200 and a job that sits at
`QUEUED` forever, which from the outside is indistinguishable from a backed-up queue.

TASK-992's own `/start`-as-a-claim work does not help here. That fixed recovery on the DELIVERY path —
a redelivered message reclaiming a dead worker's job, or re-attempting a `FAILED` one. FU-1's problem
is that **no delivery ever happens**.

### 6.2 The row did not carry enough to rebuild the message

| Dispatch argument | On the row before this change? |
|---|---|
| `jobId`, `tenantId`, `consultationId`, `mediaId` | yes |
| `pipelineId` (runtime key) | yes — `resolvedSpec.runtimeKey`, else the deprecated `pipelineId` |
| `resolvedSpec` | yes (TASK-861 snapshot) |
| **`audioUri`** | **no — and not derivable** |
| `audioBucketName`, `language` | no |
| `userId` (dispatch owner) | no — `createdBy` holds the system-user default for a machine caller (the TASK-991 W2-1 known gap) while dispatch uses the RESOLVED clinician |
| `storage` | no — and it must never be persisted: `StorageDescriptor` carries `secret_access_key` / `account_key` / `connection_string` |

`audioUri` is the one that decides the design. The upload route builds it from the request filename
plus the job's own id (`transcription-job.controller.ts`), so it is gone the moment the request ends,
and that path's `mediaId` is a bare `uuidv7()` with no media row behind it. It is reconstructable from
nothing. **Something had to be persisted**, and at DISPATCH rather than at create — the URI contains
the job id, so it does not exist when the row is inserted.

`_metadata` was considered as a migration-free home and rejected: `IBaseEntity` declares `metaData`
but `BaseEntity` has no backing field or accessor, so it costs the same hand-authoring while putting
load-bearing operational state in an untyped grab-bag.

### 6.3 What was built

| Layer | Change |
|---|---|
| `packages/database` | `TranscriptionJob.dispatchEnvelope Json? @db.JsonB`, sibling to `resolvedSpec`. Migration `20260919140318_task_992_transcription_job_dispatch_envelope` (one additive nullable column). |
| `packages/domains` | `TranscriptionJobEntity`: field, accessors and `recordDispatch(envelope)`. Deliberately unguarded by status — it states a fact about a message already enqueued, not a lifecycle transition. `incrementRetry` does not clear it (pinned by a test). |
| `packages/applications` | `BatchDispatchEnvelope` DTO; `TranscriptionJobService.recordDispatchEnvelope` / `.getDispatchContextForOwner`; `dispatchDramatiqJob` snapshots what it published; new `TranscriptionRealtimeService.retryAndDispatch`. |
| `apps/api` | `POST audio/transcription-jobs/:id/retry` routes through `retryAndDispatch`, and documents its 409/503. |
| `packages/tools` | `FACTORY_OMITTED_SCALARS_BY_MODEL.TranscriptionJob` gains `dispatchEnvelope`. `gen:factory:check` caught the omission and demanded it be recorded — the column cannot be a creation input even in principle, since the `audioUri` it carries contains the job's own id. The ENTITY does surface it, so `gen:entity:check` passed untouched. |

**Where the re-enqueue lives, and why.** In the realtime service, beside `dispatchDramatiqJob` — the
one place a batch message is constructed. Putting it anywhere else means one method builds the message
and another rebuilds it, so a kwarg added to the first is silently missing from the second. It also
cannot live in the job service: the realtime service already depends on that, so the edge only goes
one way.

**What the envelope deliberately omits.** `resolvedSpec` stays on the row — it is already the
authoritative TASK-861 snapshot, and a second multi-KB copy would only give the two a way to disagree.
`storage` is never stored, because the descriptor carries credentials; only `hadStorageDescriptor` and
the bucket NAME are kept, and the descriptor is re-resolved live on every dispatch — which is also
what makes a credential rotation between attempts a non-event.

**Ordering, and the two refusals.** Everything fallible that does not touch the row runs first
(envelope read, storage re-resolution), so a refusal leaves the job exactly as it was — still `FAILED`,
still retryable once the cause is fixed. Only then is the status flipped and the message published; if
the publish fails, the job is failed back with `RETRY_DISPATCH_ERROR` rather than left `QUEUED` with
nothing behind it, the same compensation the create path already performs.

- **409 `RETRY_ENVELOPE_MISSING`** — a row dispatched before this shipped. Its `audioUri` exists
  nowhere, so answering 200 would recreate the exact defect. (Owner decision, this ticket.)
- **503 `RETRY_STORAGE_UNRESOLVED`** — a per-tenant backend was in play and cannot be resolved now.
  Dispatching without the descriptor sends the worker to its env-default backend, where the object is
  not.

The snapshot write is **after** the enqueue and **non-fatal**. Dispatch has never needed the database,
and turning a transient write failure into a failed-but-already-queued job would be a worse bug than
the one this closes. The cost of losing that write is a job that cannot be retried later — which §6.2's
refusal states plainly rather than papering over.

### 6.4 A known, bounded duplicate-delivery window

`canRetry` is `FAILED` only, but a row is also briefly `FAILED` between a worker failing it and the
broker redelivering its message. An operator retrying inside that window produces two deliveries. The
outcome is bounded and still one transcript: the redelivered message's `/start` finds a `QUEUED` row and
starts it, and the new message's `/start` then arrives from a different worker and is a RECLAIM, capped
by `stt.batch.maxReclaims` (TASK-992 OD-2). Deduplication was not built — it would need a broker-side
message registry per job, which is a larger design than the window justifies.

### 6.5 Evidence

TDD, RED observed per layer:

| Layer | RED |
|---|---|
| domain | 3 failures, `entity.recordDispatch is not a function` |
| applications | 8 of 9 failing, `service.retryAndDispatch is not a function` |
| api | `mockRealtimeService.retryAndDispatch` never called — the route still went to the bare status flip |

```
pnpm test:unit        Test Files 1787 passed | 2 skipped   Tests 27673 passed | 4 skipped | 9 todo   exit 0
pnpm lint             exit 0 — 40 successful, 40 total
pnpm api:build        12 successful, 12 total
api:openapi:check / api:portal:check / vox-node gen:admin:check   no drift
migration replay      full ledger onto a fresh DB; dispatchEnvelope | jsonb | nullable
drift check           prisma migrate diff --from-config-datasource → "This is an empty migration."
boot smoke            Nest application successfully started; GET /api/v1/health → 200; POST :id/retry → 401 unauthenticated (mounted + gated)
```

`membership-bounded-sync.integration.test.ts` fails under `pnpm --filter @arcaai/applications test`
for the pre-existing reason already triaged in §4.4 (it needs the live test DB, whose port is held by
unrelated containers). It is excluded from `pnpm test:unit`, is in a package this change does not
touch, and fails with `DATABASE_URL environment variable is not set`.

**Live proof — over real HTTP, against the dev database and the dev Redis** (gateway on :8869 so as
not to disturb the shared stack; two throwaway `FAILED` rows, both deleted afterwards):

```
queue depth BEFORE: 0
── retry a row WITH an envelope ──
  POST …/0fa10000-…-00000000000a/retry   HTTP 201   status=QUEUED  retryCount=1
queue depth AFTER:  1

the message that landed on dramatiq:stt_batch
  actor_name  transcribe_file
  args        ["0fa10000-…-00000000000a", "50000000-…", "agent-v-1",
               "s3://hope-audio/2026/09/jobs/0fa10000-…/raw/visit.wav",
               null, "media-fu1", "en", null, "hope-audio", "70000000-…-000000000010"]
  kwargs      {"resolved_spec": {…}}        ← read from the ROW, not the envelope

── retry a row with NO envelope (the pre-FU-1 shape) ──
  POST …/0fa10000-…-00000000000b/retry   HTTP 409   code=RETRY_ENVELOPE_MISSING
  row afterwards: status=FAILED  retryCount=0      ← untouched, exactly as §6.3 requires

── the write half, proven by the same run ──
  the retry's own dispatch re-wrote the envelope on row A:
  {"userId":"70000000-…-000000000010","mediaId":"media-fu1",
   "audioUri":"s3://hope-audio/2026/09/jobs/0fa10000-…/raw/visit.wav","language":"en",
   "pipelineId":"agent-v-1","audioBucketName":"hope-audio","hadStorageDescriptor":false}
```

Between `LLEN` returning 1 and the read of the queue list, a live STT worker had already `BRPOP`'d the
message — which is the point of the whole change, observed directly.

### 6.6 Side-finding — the earlier TASK-992 commit left the API artifacts unregenerated

Regenerating the five artifacts for this change swept in a diff that is NOT from FU-1:
`reclaimCount`, the column added by TASK-992 itself, was absent from `openapi.json` on `715bfe795`
(`git show HEAD:apps/api/openapi.json | grep -c reclaimCount` → `0`) and therefore also from
`openapi.admin.json`, `openapi.business.json` and `packages/vox-node/src/resources/admin/schemas.ts`.

`route-manifest.json` was current, so the authz gates were fine, but `api:openapi:check`,
`api:portal:check` and `generate-vox-node-admin-check` would all have been RED on `dev-2.2`. The
generators emit whole files, so the correction cannot be separated from this change; it is included
here deliberately rather than left for CI to surface.

