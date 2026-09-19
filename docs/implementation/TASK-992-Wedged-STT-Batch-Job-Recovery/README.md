# TASK-992 — Wedged STT Batch Job Recovery

| | |
|---|---|
| **Status** | In Progress |
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

_Pending — filled in after Phase 4._

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-19 | Ticket opened. Exploration complete; wedged row confirmed live in the dev DB; second defect found on the `FAILED` path (§2.2). Owner decisions OD-1…OD-3 taken. Plan written, awaiting approval. |
