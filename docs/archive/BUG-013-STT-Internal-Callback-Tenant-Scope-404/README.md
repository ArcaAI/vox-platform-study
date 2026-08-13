# BUG-013 — STT worker internal job-lifecycle callbacks 404 for every non-default tenant; jobs strand in QUEUED

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, during batch-upload E2E testing (TASK-603), with a manually-started Dramatiq worker |
| **Severity** | Critical — batch transcription is 100% non-functional for every tenant except the platform default, in every client, and fails **silently** (no FAILED row, no error surfaced) |
| **Affected apps/packages** | `apps/api` (`SttInternalController`), `packages/applications` (`SttInternalService`), `apps/stt` (`APIGatewayClient`, `transcribe_file` actor), `packages/database` (tenant-scope extension — behaving as designed), `packages/domains` (`Repository.findById`) |
| **Affected surfaces (symptom only)** | `apps/admin-console` `/playground/live-transcription?tab=batch`, `apps/compat-playground` batch-upload tab |
| **Related tickets** | BUG-011 (worker has no dev start path — must be fixed first for this to be reachable), BUG-012 (batch upload 400s for global-admin sessions — the *submit* side of the same feature), TASK-603 (compat batch upload), TASK-567 (the `getProviderOverrides` CLS-pinning precedent this fix reuses) |

> **Scope note (original diagnosis pass, 2026-08-03):** the *Current State Evaluation* below was
> written as **diagnosis only** — no source code was modified, no service restarted, no database
> reset, and all database access was read-only `SELECT`s. The fix landed in a second pass the same
> day; see *Implementation Summary*. That pass also touched no service and no database row: the
> API, STT and SMR processes were left running with the OLD code, so **nothing here is
> runtime-verified end to end** (see *Owner actions required*).

---

## Requirement Analysis

Batch transcription is a two-process design (see BUG-011 §Requirement Analysis): the gateway
persists a `TranscriptionJob` row and hand-writes a Dramatiq message; a separate STT worker
consumes it, runs ASR, and drives the job through its lifecycle by calling back into the gateway on
`/api/v1/internal/stt/jobs/:id/{start,progress,complete,fail}` and polling
`/api/v1/internal/stt/jobs/:id/status` for cancellation.

Stated plainly, the requirement is: **the worker's lifecycle callbacks must resolve the job they
were dispatched for, regardless of which tenant owns it.** The worker is a single platform-wide
process; it services every tenant's queue from one credential. It therefore must be able to address
a job in tenant *X* while holding a credential that is not itself bound to tenant *X* — without
that becoming a cross-tenant escalation lever.

Two derived requirements follow, and both are currently unmet:

- **R1 — Addressability.** A lifecycle callback for a job owned by tenant *X* must resolve that job.
  Today it resolves only jobs owned by the tenant that happens to own the worker's API-key row.
- **R2 — Failure visibility.** When a lifecycle callback cannot be honoured, the job must not be
  left indistinguishable from "not started yet". Today the `/fail` callback fails by the *same*
  mechanism as `/start`, so a job that can never run also can never be marked failed.

**In scope:** how the worker addresses a tenant on the internal callback hop, and how the gateway
establishes tenant context for these service-to-service routes.
**Out of scope:** starting the worker (BUG-011), the submit-side tenant resolution (BUG-012), the
tenant-scope Prisma extension itself (it is behaving exactly as specified).

---

## Current State Evaluation

### 1. Observed evidence (CONFIRMED)

Worker log, job `019fc802-3b92-7fe0-93b1-05c64719a4ff` (tenant `50000000-0000-0000-0000-000000000001`
= **ArcaAI**, pipeline `81000000-0000-0000-0001-000000000117`, audio in `s3://hope-recordings-arcaai/…`),
worker started manually as `dramatiq stt.worker --processes 1 --threads 4`:

```
PATCH http://localhost:8868/api/v1/internal/stt/jobs/019fc802-3b92-7fe0-93b1-05c64719a4ff/start
  -> 404 {"statusCode":404,"message":"Resource not found"}
[019fc802-...] Unexpected error: API Gateway request failed: 404
PATCH .../fail -> 404 {"statusCode":404,"message":"Resource not found"}
[019fc802-...] Failed to update job status: API Gateway request failed: 404
Retry decision retries_so_far=3 max_retries=3 will_retry=false
Retries exceeded for message '019fc802-3bbc-763c-b1a2-b561af1ad5e1'.
```

Identical `/start` 404 observed for job `019fc7db-a92e-7118-b8a5-bdcb00ba584c`, also tenant `…0001`.

### 2. The tenant correlation is exact (CONFIRMED — read-only query, 2026-08-03)

```sql
SELECT id, "tenantId", status, "workerId", "startedAt", "createdAt", "errorMessage"
FROM core."TranscriptionJob" WHERE "createdAt" > now() - interval '3 hours' ORDER BY "createdAt";
```

Ignoring the six seed fixtures (ids `98000000-…`, all created in the same millisecond cluster at
`06:10:50.6xx` and carrying fabricated `workerId = asr-worker-0X` with `startedAt` months in the
past), every **real** job is a uuidv7 row:

| Real job id | tenantId | status | workerId | startedAt |
|---|---|---|---|---|
| `019fc7c8-e49e-…` | `…0000` | FAILED (HF 401, unrelated) | `worker-33830` | set |
| `019fc7c9-d906-…` | `…0000` | COMPLETED | `worker-33830` | set |
| `019fc7d0-7e69-…` | `…0000` | COMPLETED | `worker-33830` | set |
| `019fc7d0-7e6a-…` | `…0000` | COMPLETED | `worker-42468` | set |
| `019fc7eb-7357-…` | `…0000` | CANCELLED | null | null |
| `019fc7eb-7358-…` | `…0000` | COMPLETED | `worker-42468` | set |
| `019fc7f4-de96-…` | `…0000` | COMPLETED | `worker-42468` | set |
| `019fc7fb-a1b5-…` | `…0000` | COMPLETED | `worker-42468` | set |
| **`019fc7db-a92e-…`** | **`…0001`** | **QUEUED** | **null** | **null** |
| **`019fc802-3b92-…`** | **`…0001`** | **QUEUED** | **null** | **null** |

Every real job that a live worker ever touched belongs to tenant `…0000`. Every real job for tenant
`…0001` is QUEUED with `workerId = NULL`, `startedAt = NULL` **and `errorMessage = NULL`**. The
single COMPLETED `…0001` row is seed fixture `98000000-0000-0000-0001-000000000001`, not a worker run.

The worker demonstrably transcribed real audio (Malayalam transcripts persisted, `encryptedResultText`
populated) for `…0000` jobs, so the worker process, the model, MinIO download and the Redis queue are
all healthy. Only the gateway callback fails, and only for the non-default tenant.

### 3. Root cause — the exact failing lookup (CONFIRMED, every step read from code)

**Step 1 — the worker HAS the tenant id and never sends it.**
The Dramatiq message carries `tenantId` as positional `args[1]`
(`packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts:329-340`, with
`params.tenantId` at line 331), and the actor signature binds it:
`apps/stt/src/stt/transcription/workers/transcribe_file.py:39-52` (`tenant_id: str` at line 41).
It is used locally for storage routing (`transcribe_file.py:146-149`, `:192`) and is passed on the
transcript-create call (`:341`, `:352`, `:365`).

It is **not** passed on any of the five job-lifecycle calls:

| Worker call site | Gateway client method | Payload sent |
|---|---|---|
| `transcribe_file.py:157` | `get_job_status` (`gateway.py:205+`) | path only |
| `transcribe_file.py:174` | `start_job` (`gateway.py:99-118`) | `{"workerId": …}` |
| `transcribe_file.py:235` | `update_job_progress` (`gateway.py:141-155`) | `{"progress": …}` |
| `transcribe_file.py:386` | `complete_job` (`gateway.py:157-177`) | `{"resultText", "resultMetadata"}` |
| `transcribe_file.py:450` | `fail_job` (`gateway.py:179-199`) | `{"errorMessage", "errorCode"}` |

The **complete** header set on every one of these requests is fixed at client construction
(`gateway.py:35-42`):

```python
headers={
    "X-Internal-Service-Key": self.api_key,
    "Content-Type": "application/json",
}
```

No `X-Tenant-Id`, no `tenantId` body field, no query parameter. The tenant is dropped on the wire.

**Step 2 — the gateway derives the tenant from the API-key row instead.**
`SttInternalController` (`apps/api/src/modules/internal/stt-internal.controller.ts:38`) is **not**
`@Public()`; it carries a bare `@Authorize()` (line 37), which sets an *empty* required-permission
list (`packages/applications/src/authorization/decorators.ts:57-64`). So the global `UnifiedAuthGuard`
authenticates it. `X-Internal-Service-Key` is one of the four headers treated as an API key
(`packages/applications/src/services/apiKey/apiKey.service.ts:946-950`), so the request goes down the
API-key path (`unified-auth.guard.ts:103-106` → `handleApiKeyAuth` at `:164`), which ends with:

```ts
// packages/applications/src/authorization/unified-auth.guard.ts:193-202
if (apiKeyEntity.userId) { this.cls.set('user', { id: …, tenantId: apiKeyEntity.tenantId } as any); }
if (apiKeyEntity.tenantId && !this.cls.get('tenantId')) { this.cls.set('tenantId', apiKeyEntity.tenantId); }
```

**Step 3 — that API-key row is bound to the platform default tenant.** (CONFIRMED — read-only query)

```sql
SELECT id, "keyName", "keyType", "tenantId", "userId", "keyPrefix" FROM core."ApiKey";
```

| id | keyName | keyType | tenantId | userId | keyPrefix |
|---|---|---|---|---|---|
| `60000000-0000-0000-0000-0000000000ff` | **Internal Gateway Key (STT worker callbacks)** | `SERVICE_ACCOUNT` | **`50000000-0000-0000-0000-000000000000`** | **`null`** | **`4b03c083e3ab`** |

`keyPrefix = 4b03c083e3ab` matches the first twelve characters of `API_GATEWAY_KEY` in `.env.dev`
(line 2244) — the very secret the STT settings field `api_gateway_key` reads
(`apps/stt/src/stt/core/config/settings.py:148-151`) and the client presents. This row is the
worker's identity, and it is the only ApiKey row with a non-null `lastUsedAt` matching the failing
window (`2026-08-03T07:25:27Z`).

So CLS `tenantId` becomes `50000000-0000-0000-0000-000000000000`, and because `userId` is `null`,
**no CLS `user` is set at all** (guard line 193 is skipped).

**Step 4 — the tenant-scope extension injects that tenant into the job lookup.**
`ClsTenantContextProvider` (`apps/api/src/database/tenant-context.provider.ts:51-61`) returns that
tenant id; `isSuperAdmin()` (`:63-66`) returns **false**, because CLS *is* active and there is no
`user` with elevated roles (`this.cls.get('user')?.roles?.some(…) ?? false`). So the extension's
"no tenant + elevated = pass-through" escape (`packages/database/src/extensions/tenant-scope.ts:414-416`)
does not apply.

`TranscriptionJob` is in `TENANT_SCOPED_MODELS` (`tenant-scope.ts:80`) and — correctly, by explicit
design note at `:229-230` — is **absent** from `SYSTEM_SHARED_READ_MODELS` (`:232-318`). The read
handler therefore takes the narrow branch (`:420-424`) and `mergeTenantIntoWhere` (`:531-543`) rewrites
the query to `where: { id, tenantId: '50000000-…-000000000000' }`.

**Step 5 — the row is filtered out and the response is a generic 404.**
`SttInternalService.startJob` (`packages/applications/src/services/stt/internal/sttInternal.service.ts:429-433`)
calls `this.jobRepository.findById(jobId)`. `Repository.findById`
(`packages/domains/src/common/repository.ts:101-110`) does **not** return `null` — it throws
`DataNotFoundException` when `findUnique` yields nothing. `DataNotFoundFilter`
(`apps/api/src/filters/data-not-found.filter.ts:64`) renders exactly
`{ statusCode: 404, message: 'Resource not found' }` — **byte-identical to the worker log**, and
distinct from the service's own `NotFoundException(\`Job ${jobId} not found\`)` at line 432 which
would have echoed the id. That confirms the failure is the *repository lookup*, not the service's
own guard.

**Why `…0000` passes and `…0001` does not (CONFIRMED):** not a fallback and not a default —
it is an exact match. The worker's API-key row is itself owned by
`50000000-0000-0000-0000-000000000000`, which is the platform default tenant, so the injected filter
coincides with the owner of those jobs. Any other tenant's job is invisible to that filter. Had the
key been provisioned under ArcaAI, the failure would be mirrored — the default tenant would break
instead.

### 4. The compounding failure (CONFIRMED)

`failJob` (`sttInternal.service.ts:491-495`), `updateProgress` (`:450-454`), `completeJob`
(`:465-469`) and `getJobStatus` (`:512-516`) all begin with the identical
`this.jobRepository.findById(jobId)`. They therefore fail by the *same* mechanism. The consequences:

- The worker's cancellation poll (`transcribe_file.py:157`) 404s.
- `/start` 404s → the actor raises.
- The error handler calls `/fail` (`:450`) → **also 404s** → the job is never marked FAILED.
- Dramatiq exhausts `max_retries=3` (`transcribe_file.py:34`) and dead-letters the message.
- The row remains `QUEUED`, `startedAt = NULL`, `workerId = NULL`, `errorMessage = NULL` **forever**,
  which is indistinguishable from "waiting for a worker" — the exact state BUG-011 describes for a
  worker that is not running. The UI shows a permanently pending job with no error, and an operator
  triaging it is actively misled toward BUG-011.

**INFERRED (never reached at runtime, but provable from code):** even if only `/start` were fixed,
the transcript-create call would fail next. `create_transcript` *does* send `tenantId` in the body
(`gateway.py:315-316`), and `SttInternalService.createTranscript` passes it into a tenant-scoped
`ContextItem` create (`sttInternal.service.ts:386-400`). Under CLS tenant `…0000` with a record
`tenantId` of `…0001`, `applyTenantToRecord` (`tenant-scope.ts:575-585`) throws
`TenantScope: tenantId mismatch …` — a 500, not a 404. The fix must therefore establish tenant
context for the *whole* callback surface, not just the by-id lookups.

### 5. Blast radius (CONFIRMED)

The defect is entirely server-side and client-agnostic. It sits on the worker → gateway hop, below
every client, so it breaks batch transcription for **every tenant whose id is not the tenant that
owns the internal gateway API-key row** — in the admin console, in the compat playground, and in any
future SDK consumer alike.

The compat playground appeared to work only because its jobs were submitted with the seeded
`SDK Test API Key` (`60000000-…-000000000001`, tenant `50000000-…-000000000000`), so the jobs it
created happened to be owned by the same tenant as the worker's key. Confirmed from the ApiKey table
above plus the job table in §2: every job the worker successfully completed is `…0000`. Jobs
submitted with the `ArcaAI Tenant SDK Key` (`60000000-…-000000000005`, tenant `…0001`) or from an
ArcaAI console session are the ones that strand. This is coincidence, not correctness.

Secondary observation (CONFIRMED, worth its own follow-up): the row
`60000000-0000-0000-0000-0000000000ff` is **not created by any file in this repository** — a
repo-wide grep for `Internal Gateway Key`, `STT worker callbacks` and `0000000000ff` finds only
unrelated test fixtures. It was provisioned out-of-band. Its tenant binding — the thing this whole
defect hinges on — is therefore an undocumented operational artefact that will differ between
environments.

### 6. Security context that constrains the fix (CONFIRMED)

`ensureInternalApiKey` (`stt-internal.controller.ts:55-59`) checks only that `request.apiKey` is
truthy — i.e. **any active API key** passes, including a tenant's own SDK key. No
`API_KEY_REQUIRED_SCOPES` metadata is set on this controller
(`unified-auth.guard.ts:217-235` is a no-op without it), and `@Authorize()` carries zero permissions.

**Consequence:** the tenant-scope injection is presently the *only* control preventing a holder of
any tenant SDK key from driving another tenant's transcription job by id. Any fix that removes or
weakens that injection must replace it with an equivalent control.

---

## Implementation Plan

### Fix options considered

| Option | Verdict |
|---|---|
| **(a) Worker forwards `X-Tenant-Id`, gateway unchanged** | **Insufficient on its own — CONFIRMED no-op.** `ContextInterceptor` (`apps/api/src/interceptors/context.interceptor.ts:69-102`) only elevates CLS from `x-tenant-id` via `resolveActiveTenant` (`apps/api/src/interceptors/resolve-active-tenant.ts:28-43`), which returns `none` unless the CLS `user` is a global admin with an empty tenant. The internal key sets **no** CLS `user` (§3 step 2), so the decision is `none` and CLS `tenantId` stays `…0000`. ~~The divergence guard (`:73-80`) also never fires (it needs a `jwtTenantId`), so there is not even a 400 — the header is silently ignored.~~ **CORRECTION (2026-08-03, runtime run):** that last sentence was WRONG. `UnifiedAuthGuard:193-198` sets CLS `user` whenever the API-key row carries a `userId`, and the live internal key (the seeded `SERVICE_ACCOUNT` row) does. So `jwtTenantId` IS populated, the divergence guard DOES fire, and an `x-tenant-id` naming any other tenant is rejected **400 before the controller is reached**. The fix therefore had to move the pin onto a distinct internal-only header — see the Change History. |
| **(b) `SttInternalService` uses the unscoped/base client for the by-id lookup** | **Rejected.** It deletes the only control described in §6, turning every internal route into a cross-tenant job-manipulation primitive for any API-key holder. It also requires `getPlatformAdminPrismaClient_Unscoped`, which `.claude/rules/02-database-prisma.md` restricts by ESLint to seeds, back-fill scripts and test fixtures — none of which this is. |
| **(c) `ClsTenantContextProvider` resolves a tenant for service-token calls** | **Rejected.** The provider is generic and stateless; it cannot know which tenant a given `:id` belongs to. Any "resolve" it could perform would either be a pass-through (option b in disguise) or a second lookup that has the same chicken-and-egg problem. |

### Recommended fix — (a′): worker forwards the tenant, controller pins CLS to it

This is **the pattern already present in this very file.** `getProviderOverrides`
(`stt-internal.controller.ts:145-160`) faces the identical problem — a service-to-service call with
no user/tenant CLS reading a tenant-scoped model — and solves it at lines 155-159 by re-establishing
CLS pinned to the requested tenant:

```ts
return this.cls.run(async () => {
  this.cls!.set('tenantId', scopedTenantId);
  return this.sttConfig!.resolveProviderOverrides(scopedTenantId);
});
```

`HarnessInternalController` uses the same shape (`apps/api/src/modules/consultation/harness-internal.controller.ts:209-212`,
`:388`), with an explicit comment naming this exact recurrence class.

**Why this and not (b):** the tenant-scope extension stays **on**. The lookup still filters by
`tenantId`, so a callback that names the wrong tenant gets a 404, not someone else's row — the
404-over-403 posture (`.claude/rules/05-nestjs-api.md`) is preserved rather than bypassed, and no
lint-restricted client is introduced.

**Required companion hardening (same change, not a follow-up).** Pinning CLS from a caller-supplied
value turns the header into a tenant selector. Combined with §6 (any API key passes), that would be
a cross-tenant escalation. These routes must therefore be restricted to the internal credential
before the pin is honoured. Two acceptable forms:

1. `SetMetadata(API_KEY_REQUIRED_SCOPES, ['stt:internal'])` at the controller class level, with that
   scope added to `ApiKey 60000000-…-0000000000ff` only (enforced at `unified-auth.guard.ts:217-235`); or
2. move `SttInternalController` behind `InternalServiceTokenGuard`
   (`apps/api/src/modules/internal/internal-service-token.guard.ts`), which already maps
   `stt → API_GATEWAY_KEY` (line 40) and already accepts the `x-internal-service-key` header for
   `service=stt` (lines 92-95). Note it currently requires a `?service=` query parameter (line 54-57),
   so this form needs that made optional or supplied by the worker.

Form 1 is the smaller change and matches the controller's existing API-key posture; form 2 is the
stronger boundary. **Recommendation: form 1 now, form 2 tracked as hardening.** Note the same
pinning weakness already exists on `getProviderOverrides` (line 147) — hardening fixes both at once.

### Files to change (with lines)

| File | Change |
|---|---|
| `apps/stt/src/stt/core/api_client/gateway.py` | Add a `tenant_id: str` parameter to `start_job` (`:99`), `update_job_progress` (`:141`), `complete_job` (`:157`), `fail_job` (`:179`), `get_job_status` (`:205`); pass `headers={"X-Tenant-Id": tenant_id}` through the existing `_request` `headers` parameter (`:57`, `:69`) — the same mechanism `create_transcript` already uses for `Idempotency-Key` (`:327`). Do **not** change the client-level headers at `:38-42`. |
| `apps/stt/src/stt/transcription/workers/transcribe_file.py` | Pass `tenant_id` at the five call sites: `:157`, `:174`, `:235`, `:386`, `:450`. The variable is already in scope (bound at `:41`/`:114`). |
| `apps/api/src/modules/internal/stt-internal.controller.ts` | Read `@Headers('x-tenant-id') tenantId?: string` on `startJob` (`:76-82`), `updateProgress` (`:84-90`), `completeJob` (`:92-98`), `failJob` (`:100-106`), `getJobStatus` (`:108-114`) and — when present — wrap the service call in `this.cls.run(() => { this.cls.set('tenantId', tenantId); … })`, mirroring `:155-159`. When the header is **absent**, keep today's behaviour unchanged so the change is backward-compatible with an un-upgraded worker. Add the class-level `API_KEY_REQUIRED_SCOPES` metadata per the hardening note. Consider promoting `cls` from `@Optional()` (`:48`) for these routes. |
| `apps/api/src/modules/internal/stt-internal.controller.ts` (`createTranscript`, `:61-74`) | Same treatment, so the §4 INFERRED `TenantScope: tenantId mismatch` 500 cannot land once `/start` succeeds. `dto.tenantId` is already on the wire (`gateway.py:315-316`), so no worker change is needed here — pin CLS from it. |

`SttInternalService` and the tenant-scope extension need **no** change. The extension is doing
exactly what it is specified to do.

**Alternative transport considered:** carrying `tenantId` in the request body instead of a header.
Rejected for uniformity — `get_job_status` is a `GET` and would need a query parameter, splitting the
convention across five sibling routes. A header applies identically to all five and does not collide
with the console's `x-tenant-id` semantics, which are inert here (no CLS `user` ⇒
`resolveActiveTenant` → `none`, proven in the options table above).

### TDD test list (RED first — `.claude/rules/01-development-workflow.md` §TDD)

1. **`apps/api/src/modules/internal/__tests__/stt-internal.controller.test.ts`** (exists — extend)
   - `startJob` with `x-tenant-id: T` runs the service inside `cls.run` with `tenantId` set to `T`
     (assert on a mocked `ClsService`). Repeat for `progress`, `complete`, `fail`, `status`,
     `createTranscript`.
   - Without the header, the service is called exactly as today (no `cls.run`) — backward compatibility.
   - A request with no API key still 401s (`ensureInternalApiKey`, `:55-59`) — unchanged.
   - **Hardening:** a key lacking the `stt:internal` scope is rejected before any tenant pin.
2. **`packages/applications/src/services/stt/internal/__tests__/sttInternal.service.test.ts`**
   (exists — `describe('startJob')` at line 508) — no behavioural change expected; add a regression
   assertion that `startJob` still surfaces a not-found job rather than swallowing it.
3. **`apps/stt/tests/`** (new, e.g. `test_gateway_tenant_header.py`) — assert each of the five
   lifecycle methods sends `X-Tenant-Id` equal to the tenant passed, and that `transcribe_file`
   forwards the actor's `tenant_id` argument to all five. A stubbed `httpx` transport capturing
   request headers is sufficient; no live gateway needed.
4. **`apps/api/tests/e2e/bug-013-internal-stt-callbacks-cross-tenant.spec.ts`** (new) — **the
   end-to-end proof required for this ticket:**
   - Create a `TranscriptionJob` owned by a **non-default** tenant (`…0001`).
   - `PATCH /internal/stt/jobs/:id/start` with `X-Internal-Service-Key` + `X-Tenant-Id: …0001`
     → **200**, and the row reaches `PROCESSING` with `startedAt` and `workerId` set.
   - Then `/progress`, then `/complete` → **200**, row reaches `COMPLETED`.
     *This is the "a non-default-tenant job completes end to end" test.*
   - **Negative (isolation must hold):** same job id with `X-Tenant-Id: …0000` → **404**
     (`Resource not found`), never 403 and never someone else's row — locks the 404-over-403 contract.
   - **Negative (default tenant unaffected):** the `…0000` path still works, with and without the header.

### Verification criteria

| Gate | Command |
|---|---|
| Applications unit | `pnpm --filter @arcaai/applications test` |
| Gateway unit | `pnpm test:unit` |
| STT Python | `pnpm stt:test` · `pnpm py:stt:lint` · `pnpm py:stt:typecheck` |
| API E2E | `pnpm test:up:api` (terminal 1) then `pnpm test:e2e` |
| Lint | `pnpm lint` (hard errors in `apps/api`) |
| Live confirmation (owner) | With the worker running (BUG-011), submit a batch upload as an ArcaAI-tenant caller and observe the row go `QUEUED → PROCESSING → COMPLETED` with a non-null `workerId`. |

### Sequencing

BUG-011 (worker start path) must be resolved first — without a running worker this defect is not
observable. BUG-012 (submit-side 400 for global-admin sessions) is independent, but both must land
before a global admin can exercise batch upload against a working tenant end to end.

---

## Implementation Summary

Implemented 2026-08-03 as recommended option **(a′)** — the worker forwards the tenant, the
controller pins CLS to it — plus the mandatory companion hardening, in a **different form** than the
plan proposed (justified below). TDD both sides: RED captured before any implementation.

Confidence labels used in *Current State Evaluation*: **CONFIRMED** = proven from code read in this
repository or from the read-only query output reproduced there; **INFERRED** = derived from code but
not observed at runtime (used exactly twice, both explicitly marked, in §4).

### Files changed

| File | Change |
|---|---|
| `apps/stt/src/stt/core/api_client/gateway.py` | New `_tenant_headers(tenant_id)` static helper returning `{"X-Tenant-Id": …}` or `None`. Added `tenant_id: str \| None = None` to `start_job`, `update_job_progress`, `complete_job`, `fail_job`, `get_job_status`, each passing the header through the existing `_request(headers=…)` seam. `create_transcript` now merges the tenant header with the existing `Idempotency-Key` (the batch path resolves the job by id, so it 404s by the same mechanism). Client-level headers at construction are unchanged. Omitting the tenant omits the header, so the request shape is byte-identical for un-upgraded callers. |
| `apps/stt/src/stt/transcription/workers/transcribe_file.py` | The actor's `tenant_id` is now threaded to all five lifecycle calls (`:157` status poll, `:174` start, `:235` progress, `:389` complete) and to `create_transcript` (`:370`). `_fail_job` gained a `tenant_id` parameter, passed at all three error call sites — this is what turns a fatal job into a FAILED row instead of a silent QUEUED strand. |
| `apps/api/src/modules/internal/stt-internal.controller.ts` | `@Headers('x-tenant-id')` read on `startJob`, `updateProgress`, `completeJob`, `failJob`, `getJobStatus` and `createTranscript`; each delegates through a new private `runTenantPinned(request, tenantId, work)` which — when a tenant is supplied — verifies the platform internal credential and then runs the service call inside `cls.run()` with `tenantId` set, mirroring `getProviderOverrides` (`:155-159`). No header ⇒ the service is called exactly as before. New private `assertPlatformInternalCredential` + module-local constant-time `safeEqual`; `SecretsService` injected `@Optional()` as a 4th constructor argument. |
| `apps/stt/tests/unit/test_gateway_tenant_header_bug013.py` | **New.** Wire-level `httpx.MockTransport` assertions that each of the five lifecycle calls and `create_transcript` send `X-Tenant-Id` (and still present `X-Internal-Service-Key`); that omitting the tenant omits the header; and two actor-level tests driving `_transcribe_file_async` against a stubbed collaborator set — a happy path proving start/status/progress/complete/transcript all carry the actor's tenant, and a failure path proving `/fail` does too. |
| `apps/api/src/modules/internal/__tests__/stt-internal.controller.test.ts` | Extended with a `tenant pinning (BUG-013)` block: for each of the six routes, (1) pin honoured with the internal credential, (2) untouched CLS without the header, (3) `ForbiddenException` for a non-internal caller — plus fail-closed on an unresolvable secret and the unchanged "no API key ⇒ 401" precedence. |
| `apps/stt/tests/unit/{test_gateway_client_lifecycle,test_api_client,test_workers,test_transcribe_file_pubsub}.py` | Test doubles updated for the widened signatures (`capture_request(..., headers=None)`, `capture_failure/capture_call(..., tenant_id=None)`, one `assert_awaited_once_with` gains `tenant_id=None`). No behavioural expectation was relaxed. |

`SttInternalService`, `packages/domains`, the tenant-scope extension and the database schema are
**unchanged** — the extension is doing exactly what it is specified to do, which is the point of
choosing (a′) over (b).

### Companion hardening — landed, in a stronger form than plan form 1

The plan called for `API_KEY_REQUIRED_SCOPES = ['stt:internal']` at the class level ("form 1 now,
form 2 tracked"). **Deviated deliberately.** Two problems with form 1 as written:

1. It is enforced against a *mutable DB column*. A read-only `SELECT` (2026-08-03) shows the live
   internal row `60000000-…-0000000000ff` carries
   `["stt:transcription:read","stt:transcription:write","stt:stream:write"]` — no `stt:internal`.
   Landing form 1 would therefore **403 the running worker for every tenant**, including the default
   tenant that works today, until someone mutates that row — and §5 established the row is created by
   **no file in this repository**, so there is no seed to run. A hardening step that requires an
   out-of-band DB write to avoid a regression is not a safe same-change companion.
2. Even once granted, the scope is a *label*: any future key granted `stt:internal` (or the seeded
   wildcard `*` key, `60000000-…-000000000004`) would inherit tenant-selection power.

What landed instead binds the pin to the **actual platform credential**: `X-Tenant-Id` is honoured
only when the request presents `X-Internal-Service-Key` equal to the `API_GATEWAY_KEY` secret,
compared in constant time via `SecretsService.getSecretOptional`. That is the same secret/header
pairing `InternalServiceTokenGuard.SERVICE_SECRETS.stt` (`:40`, `:92-95`) already maps for STT — i.e.
plan form 2's trust boundary, applied surgically to the one new privilege rather than to all nine
routes, so it needs no `?service=` parameter, no DB row, and no seed. It fails **closed**: an
unresolvable secret rejects the pin. **No seed or migration change is required by this fix.**

### Trust boundary, stated explicitly

- **Who may select a tenant:** only a caller holding `API_GATEWAY_KEY`. A tenant SDK key that asserts
  `X-Tenant-Id` gets **403** — a privilege boundary, deliberately *not* the 404-over-403 posture.
- **What selecting a tenant buys:** nothing beyond addressing. The tenant-scope Prisma extension stays
  **on**, so the lookup still filters by `tenantId`; a callback naming the wrong tenant gets the
  ordinary **404** (`Resource not found`), never another tenant's row. No lint-restricted unscoped
  client is introduced.
- **Unchanged (pre-existing, now the residual gap):** without a tenant header these routes still
  accept *any* active API key and operate under that key's own tenant — so a tenant SDK-key holder can
  still drive **its own** tenant's transcription jobs through the internal surface. This defect is not
  widened by this change; closing it is plan **form 2** (move the whole controller behind
  `InternalServiceTokenGuard`, making `?service=` optional), still recommended as follow-up hardening.
  The same pre-existing weakness on `getProviderOverrides` (`:147`) is likewise untouched.

### Verification evidence (2026-08-03)

RED first, both languages, before any implementation:

```
# Python — pytest apps/stt/tests/unit/test_gateway_tenant_header_bug013.py
E   TypeError: APIGatewayClient.start_job() got an unexpected keyword argument 'tenant_id'
E   TypeError: APIGatewayClient.update_job_progress() got an unexpected keyword argument 'tenant_id'
E   TypeError: APIGatewayClient.complete_job() got an unexpected keyword argument 'tenant_id'
E   TypeError: APIGatewayClient.fail_job() got an unexpected keyword argument 'tenant_id'
E   TypeError: APIGatewayClient.get_job_status() got an unexpected keyword argument 'tenant_id'
E   KeyError: 'x-tenant-id'                       # create_transcript
E   AssertionError: assert None == '50000000-0000-0000-0000-000000000001'   # actor drops tenant on /start and /fail
8 failed, 1 passed in 0.54s

# TypeScript — vitest apps/api/src/modules/internal/__tests__/stt-internal.controller.test.ts
AssertionError: promise resolved "{ id: 'job-1', status: 'PROCESSING' }" instead of rejecting
Tests  13 failed | 16 passed (29)
```

GREEN + gates after implementation:

```
pytest apps/stt/tests/unit/test_gateway_tenant_header_bug013.py   → 9 passed in 0.53s
pytest apps/stt/tests/unit                                        → 2648 passed, 12 warnings in 25.14s
pytest apps/stt/tests (full)                                      → 1 failed, 2857 passed, 76 skipped, 3 xfailed  (see note)
pnpm stt:lint      (ruff)                                         → All checks passed!
pnpm stt:typecheck (mypy)                                         → Success: no issues found in 131 source files
vitest apps/api/src/modules/internal/__tests__/stt-internal…      → 29 passed (29)
vitest apps/api/src/modules/internal + src/interceptors           → 9 files, 140 passed (140)
pnpm api:build                                                    → Tasks: 8 successful, 8 total
eslint apps/api/src/modules/internal                              → clean (0 problems)
```

**Note on the one failure:** `tests/integration/test_streaming_quality_scorecard.py` fails on
`commit_latency_p50/p99` vs committed thresholds (observed 10641.7 ms). It is a live **streaming**
latency gate on a loaded developer machine; this change touches only the batch job-lifecycle HTTP
callbacks and adds one request header. Unrelated and pre-existing. `pnpm --filter @arcaai/api lint`
also reports 4 prettier errors — all in `src/modules/smr-compat/summary-schemas.ts`, an unrelated
file from other uncommitted work in this tree, not touched here.

**Not run:** the API E2E spec from the TDD list (item 4). It requires restarting the gateway, which
was explicitly out of bounds for this pass — the running API still carries the pre-fix code, so the
spec could only produce a misleading red. It remains the right end-to-end proof; see below.

---

## Owner actions required

1. **Restart the API gateway** (`pnpm api:dev` / your usual supervisor) so the rebuilt
   `SttInternalController` is live. Until then the fix is inert.
2. **Restart the STT Dramatiq worker** (`dramatiq stt.worker …`, per BUG-011) so the actor forwards
   `X-Tenant-Id`. Order does not matter: an old worker against a new gateway behaves exactly as today
   (no header ⇒ no pin), and a new worker against an old gateway is likewise unchanged (the header is
   inert without the controller change — proven in the options table above).
3. **No seed, migration or database change is required.** Nothing was seeded, migrated or reset while
   implementing this. Confirm `API_GATEWAY_KEY` is present in the gateway's environment (it is in
   `.env.dev`, line 2244) — the tenant pin fails closed without it.
4. **Re-run the live confirmation:** submit a batch upload as an **ArcaAI-tenant** caller (tenant
   `50000000-…-0001`, e.g. the `ArcaAI Tenant SDK Key` or an ArcaAI console session, once BUG-012 is
   in) and confirm the `TranscriptionJob` row goes `QUEUED → PROCESSING → COMPLETED` with a non-null
   `workerId` and `startedAt`. Also confirm a deliberately failing job now reaches `FAILED` with an
   `errorMessage` instead of stranding at `QUEUED`.
5. **Optional, recommended:** add the cross-tenant E2E spec
   (`apps/api/tests/e2e/bug-013-internal-stt-callbacks-cross-tenant.spec.ts`, TDD list item 4) once a
   restarted API is available — in particular the negative case that the same job id with the *wrong*
   `X-Tenant-Id` returns **404**, locking the 404-over-403 contract.
6. **Follow-up hardening (separate ticket):** move `SttInternalController` behind
   `InternalServiceTokenGuard` (plan form 2) to close the residual "any API key reaches the internal
   surface for its own tenant" gap, which this change leaves exactly as it found it.
7. **Follow-up (separate ticket, from §5):** the internal gateway `ApiKey` row
   `60000000-…-0000000000ff` is provisioned out-of-band by no file in this repo. Its existence — and
   now only its existence, no longer its tenant binding — is load-bearing; it should be reproducible
   from the repo.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | **Runtime-verified, and two follow-on defects fixed — the original fix was inert as shipped.** The first live batch run after the fix failed with `INTERNAL_ERROR: API Gateway request failed: 401`, then (once auth was restored) `400 x-tenant-id header does not match the authenticated tenant`. Two distinct causes, both now fixed: **(1) credential drift** — `API_GATEWAY_KEY` in `.env.dev` and Vault had been regenerated as a random 64-hex secret alongside the `*_SERVICE_TOKEN` values, but it is not a free-form shared secret: STT presents it on `X-Internal-Service-Key`, which the GLOBAL `UnifiedAuthGuard` resolves through `ApiKeyService.extractApiKeyFromRequest` (`apikey.service.ts:950`), so it must be the RAW value of a registered ACTIVE `SERVICE_ACCOUNT` ApiKey row. No such row existed for `4b03c083…`, so **every** `/internal/stt/*` callback 401'd. Restored to the seeded fixture (`SEED_API_KEY_RAW.SERVICE_ACCOUNT`) in `.env.dev` + Vault `secret/hope/API_GATEWAY_KEY`; `apps/stt/.env:81` already held it but is out-ranked by the root env file (`hope_env.build_hope_sources`). **(2) wrong pin header** — the plan's analysis that `x-tenant-id` is "silently ignored" for this caller was wrong (corrected inline in *Fix options considered*): the seeded key carries a `userId`, so CLS *does* hold a user and `ContextInterceptor:69-80` rejects the divergent header with 400 before the controller runs. The pin moved to an internal-only `X-Internal-Tenant-Id` header (worker `_tenant_headers`, controller `@Headers('x-internal-tenant-id')` on all six routes), leaving the console's `x-tenant-id` semantics and their divergence guard untouched. `assertPlatformInternalCredential` is unchanged and still the only gate that admits a pin. **Evidence (live, `localhost:8868`):** pin + platform credential → **200** `{"status":"QUEUED"}`; wrong tenant → **404** (isolation held); tenant SDK key attempting the pin → **403**. Full E2E batch upload as tenant `…0001` (`019fc843-fc82-74b3-b3fa-0eb4bd478a9a`): `/start`, `/status`, `/progress`, `/complete` all 200, job **COMPLETED**, progress 100, 558-char transcript persisted. Gates: `apps/stt` pytest 2648 passed; `apps/api` vitest 142 passed (internal + interceptors, incl. a new source-level pin on the header name); ruff, mypy, eslint, tsc clean. |
| 2026-08-03 | **Fix implemented; status → `Review`.** Recommended option (a′) landed: the worker forwards `X-Tenant-Id` on all five job-lifecycle callbacks **and** on the batch transcript create; `SttInternalController` pins CLS to it via `cls.run`, reusing the `getProviderOverrides` precedent. Companion hardening landed in a **stronger form than plan form 1** — the pin is honoured only for a caller presenting `X-Internal-Service-Key` === `API_GATEWAY_KEY` (constant-time, fail-closed), because form 1's `stt:internal` scope would have 403'd the live worker key for *every* tenant until an out-of-band DB write, and the live row (read-only `SELECT`) does not carry that scope. Consequence: **no seed, migration or DB change is needed**. TDD RED captured both languages before implementation; unit/lint/typecheck/build gates green. Not runtime-verified — the API, STT and SMR processes were deliberately left running on the old code. Residual gap (pre-existing, unchanged): without a tenant header these routes still admit any API key for its own tenant — plan form 2 remains the follow-up. |
| 2026-08-03 | Ticket created. Root cause traced end to end during batch-upload E2E testing (TASK-603), with the STT Dramatiq worker started manually per BUG-011. Third distinct defect in the batch-upload path after BUG-011 (worker not running) and BUG-012 (submit-side 400 for global-admin sessions). Recommended fix: worker forwards `X-Tenant-Id` on all five job-lifecycle callbacks + `SttInternalController` pins CLS to it via `cls.run`, reusing the `getProviderOverrides` precedent in the same file, with an API-key scope restriction as mandatory companion hardening. |
