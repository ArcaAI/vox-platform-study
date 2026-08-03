# BUG-012 — Batch audio upload 400s for GLOBAL_ADMIN sessions using a working tenant

| Field | Value |
|---|---|
| **Status** | `Review` — code fixed + unit-verified; live 400 → 201 confirmation deferred (needs an API restart) |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-03, live E2E of the live-transcription playground batch-upload tab |
| **Severity** | High — the feature is 100% unusable for the console's primary audience |
| **Affected app** | `apps/api` (NestJS gateway) — `TranscriptionJobController` |
| **Affected surface** | `apps/admin-console` `/playground/live-transcription?tab=batch` (symptom only) |
| **Not at fault** | `apps/admin-console/src/server/hope-proxy.ts`, `packages/agentic-sdk-v2` |
| **Related** | BUG-005 (impersonation effective identity), TASK-532 (global-admin working-tenant IA), TASK-603 (compat batch upload) |

---

## Requirement Analysis

A GLOBAL_ADMIN who has selected a working tenant in the admin console must be able to use every
tier 30–49 tenant-scoped screen against that tenant's data. Per
`.claude/rules/13-nextjs-apps.md` §Routing, "a global-admin-only screen over per-tenant data" is an
explicitly sanctioned pattern: the audience tier answers *who may open the screen*, and the
working-tenant gate answers *which tenant's rows it reads*. The BFF proxy expresses that selection
as an `X-Tenant-Id` header, and the gateway is expected to honour it for the whole request.

The live-transcription playground's batch-upload tab violates that contract: it rejects every
global-admin upload with a 400, regardless of working tenant, while the same session's other reads
on the same screen succeed. The requirement is that
`POST /api/v1/audio/transcription-jobs/transcribe` resolve the caller's active tenant using the
same canonical rule the rest of the gateway uses.

**In scope**: the tenant resolution used by `TranscriptionJobController`.
**Out of scope**: changing the BFF proxy's header policy, the impersonation token shape, or the
STT batch worker (that is BUG-011).

---

## Current State Evaluation

### 1. Observed evidence (all CONFIRMED — supplied from live browser sessions, 2026-08-03)

Screen: `/playground/live-transcription?tab=batch` on `http://localhost:5176`.

**Session A — `super_admin` (GLOBAL_ADMIN), working tenant = ArcaAI, WITH impersonation of
`arcaai_doctor_bren`.** All three requests issued from the same page, same session cookie, same BFF
proxy, within seconds of each other:

| Request | Result |
|---|---|
| `GET /api/hope/audio/transcription-jobs` | **200** `{"data":[],"total":0,"page":1,"limit":20,"totalPages":0}` |
| `GET /api/hope/audio/pipelines` | **200**, 27375 bytes, ArcaAI-scoped pipeline list |
| `POST /api/hope/audio/transcription-jobs/transcribe` (multipart `file` + `pipelineId`) | **400** `Tenant context is required. Ensure you are authenticated with a tenant-scoped user.` — `correlationId 019fc7fe-7110-7206-9213-aed66ae683a0` |

**Session B — same `super_admin`, impersonation revoked, working tenant still ArcaAI.** Identical
multipart POST → **400**, same message, `correlationId 019fc7ff-7d07-7809-a1f4-4c20fe00c8ee`.
⇒ Impersonation is *incidental, not causal*.

**Session C — control experiment.** Logged out; logged in as `arcaai_admin` / `ARCAAI`
(roles `["TENANT_ADMIN"]`, `tenantId 50000000-0000-0000-0000-000000000001`, `isElevated false`,
`workingTenantId null`). Identical multipart body, identical proxy path →
**201 Created**, job `019fc802-3b92-7fe0-93b1-05c64719a4ff`, `audioUri
s3://hope-recordings-arcaai/2026/08/jobs/…/raw/test-1.wav`.
⇒ The gateway endpoint, the multipart handling, and the BFF body forwarding are all **fine**.

**Session D — contrast path.** The compat playground uploads to the same gateway route
(`POST http://localhost:8868/api/v1/audio/transcription-jobs/transcribe`) with an `x-api-key`
header, bypassing the BFF entirely. Jobs were created and completed successfully in the same
window.

The discriminator is therefore **caller identity**, not HTTP method and not multipart:
a principal whose own credential carries a tenant succeeds; a GLOBAL_ADMIN relying on the
working-tenant header fails.

### 2. Root cause — CONFIRMED

`apps/api/src/modules/streaming/transcription-job.controller.ts:113-119`

```ts
private getTenantId(): string {
  const user = this.cls.get('user');
  if (!user?.tenantId) {
    throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
  }
  return user.tenantId;
}
```

This reads **only** the JWT-derived identity (`cls.user.tenantId`) and ignores the CLS `tenantId`
key, which is where a global admin's working tenant lives.

The supporting chain, all read in code:

1. **A global admin has no tenant of its own.**
   `apps/api/src/interceptors/resolve-active-tenant.ts:8` — *"A global-admin authenticates with an
   EMPTY CLS `tenantId` (their JWT carries `tenantId: ''`)."*
   Corroborated in the console's own session type,
   `apps/admin-console/src/server/session.ts:16-21` — `tenantId` is *"Home tenant of a tenant-bound
   user (absent for unscoped global admins)"*.
   `packages/applications/src/services/auth/jwt.strategy.ts:57` copies `payload.tenantId` verbatim
   into the CLS user, so an empty claim stays empty.

2. **The working tenant is elevated into a DIFFERENT CLS key.**
   `apps/api/src/interceptors/context.interceptor.ts:89-101` — on an `x-tenant-id` header from a
   global admin with an empty JWT tenant, `resolveActiveTenant` returns `elevate` and the
   interceptor does `this.tryClsSet('tenantId', decision.tenantId)` (line 94). It **never** mutates
   `cls.user.tenantId`. The accompanying log line is
   `"global-admin elevated active tenant from x-tenant-id header"`.

3. **The canonical read is `tenantId` first, `user.tenantId` second.**
   `apps/api/src/database/tenant-context.provider.ts:59`:
   ```ts
   const resolved = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
   return resolved && resolved.length > 0 ? resolved : undefined;
   ```
   Two sibling controllers already use exactly this order:
   `apps/api/src/modules/agentic-admin/agentic-admin.controller.ts:76` and
   `apps/api/src/modules/harness-admin/harness-admin.controller.ts:586`
   (`this.cls.get('tenantId') ?? user?.tenantId ?? undefined`).
   `apps/api/src/shared/tenant-scope.ts:29-45` encodes the same posture as the shared helper.
   `TranscriptionJobController` is the **only** module controller that reads `user?.tenantId`
   in isolation for this purpose (verified by grep across `apps/api/src/modules/**`).

**Therefore**: GLOBAL_ADMIN + working tenant ⇒ `cls.tenantId = <ArcaAI>` but `cls.user.tenantId = ''`
⇒ line 115 is truthy-false ⇒ 400. TENANT_ADMIN ⇒ `cls.user.tenantId` is populated by the JWT ⇒ 201.

### 3. Why the other calls on the same screen succeed — CONFIRMED

| Call | Tenant source it actually uses | Outcome |
|---|---|---|
| `GET audio/transcription-jobs` | `getUserId()` → `cls.user.id` (`transcription-job.controller.ts:127-133`, called at :685). Never touches `tenantId`. | 200 |
| `GET audio/pipelines` | `AudioPipelinePublicController.fetchAll()` (`apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts`) reads no CLS tenant at all; scoping happens in the Prisma `tenantScopeFilter` extension, which resolves via `ClsTenantContextProvider.getTenantId()` — the **correct** `tenantId`-first read. | 200, ArcaAI-scoped |
| `POST audio/transcription-jobs/transcribe` | `getTenantId()` → `cls.user.tenantId` only | **400** |

This is also why the symptom *looks* like "GETs work, POSTs don't": the two GETs exercised happen
not to call `getTenantId()`. The method is not the variable — the helper is.

### 4. The API-key contrast — CONFIRMED

`packages/applications/src/authorization/unified-auth.guard.ts:193-199`: on the API-key branch the
guard sets the CLS user directly from the key entity, `{ id: apiKeyEntity.userId, tenantId:
apiKeyEntity.tenantId }`. An API key is always tenant-bound, so `cls.user.tenantId` is always
populated and `getTenantId()` never throws. That is precisely why the compat playground's upload of
the same file to the same route works.

### 5. Explicit refutation: the BFF proxy is NOT at fault — CONFIRMED

The hypothesis "the multipart/streaming-body branch skips the tenant header" was tested against the
code and is **false**. `apps/admin-console/src/server/hope-proxy.ts` has exactly one header builder
and no method-conditional header logic:

- `buildHeaders(request, session)` — lines **20-38**. It forwards the
  `FORWARDED_REQUEST_HEADERS` allowlist (line 11: `content-type`, `if-match`, `idempotency-key`,
  `user-agent`), sets `authorization` (line 27), and sets `x-tenant-id` at **lines 34-36** gated
  purely on session state (`!session.impersonation && session.workingTenantId &&
  isElevated(session.user)`) — never on `request.method` or content type.
- `sendToGateway(...)` — lines **54-62** — calls `buildHeaders` unconditionally at line 57 for every
  method.
- The **only** method-conditional line in the file is the body buffering at line **87**
  (`BODYLESS_METHODS.has(request.method) ? null : await request.arrayBuffer()`), which touches the
  body and never the headers. There is no `req.formData()` call, no header reconstruction, and no
  early return before `buildHeaders`.
- The client is equally uniform: `apps/admin-console/src/shared/api/http.ts:133-144` — `request()`
  builds one `Headers` object, only *skipping* the JSON `content-type` when the body is `FormData`
  (line 136), and posts to the same `/api/hope/` mount (line 112, 115). `uploadBatchAudio`
  (`apps/admin-console/src/features/playground-live-transcription/api/client.ts:57-63`) goes through
  that same `request()` core as every GET helper in the file.
- Existing proxy tests already lock the header policy as session-scoped, not method-scoped:
  `apps/admin-console/src/server/__tests__/hope-proxy.test.ts:125-141`.

Corroborating runtime proof: the multipart POST reached the *controller body* — it passed
`UnifiedAuthGuard`, passed the file/mime/size validation at lines 220-228, and only then threw at
line 230. If the multipart body or the auth header had been mangled by the proxy the failure would
have been `401` or `Audio file is required`, not the tenant message.

### 6. The impersonated repro (Session A) — INFERRED, not proven

Under the confirmed root cause, Session A *should* have succeeded: while impersonating, the proxy
suppresses `x-tenant-id` (hope-proxy.ts:34) and sends the act-as JWT, which carries the target's
tenant — `apps/api/src/modules/auth/admin-impersonation.controller.ts:200` puts
`tenantId: resolvedTenantId` in the token payload, and lines 173-175 refuse to mint a token at all
for a target with no tenant assignment. So `cls.user.tenantId` should have been ArcaAI.

The most probable explanation, ranked:

1. **(most likely) The impersonation token was dead, and the proxy's recovery path degraded the
   request into the global-admin case.** `ImpersonationState.accessToken` is documented as
   short-lived (`session.ts:26-27`; the gateway default is 30m,
   `admin-impersonation.controller.ts:185`) and is non-refreshable. On a gateway 401 the proxy takes
   `hope-proxy.ts:98-105`: it rebuilds the session with the **original admin** token and
   `impersonation: undefined`, persists it (line 105), and retries at line 111. That retry's
   `buildHeaders` now sees no impersonation + a working tenant + an elevated user, so it **does**
   send `x-tenant-id` with the global-admin bearer — i.e. exactly the confirmed failing shape. It
   also explains why the banner subsequently showed a non-impersonating session.
   *Discriminating evidence*: a gateway `401` log for that correlation window, or the
   `ContextInterceptor` line `"global-admin elevated active tenant from x-tenant-id header"`
   carrying `superAdminId = super_admin` on correlation `019fc7fe-…`.
2. **The impersonation had already been revoked** before that attempt, leaving a stale banner.
   *Discriminating evidence*: the audit row for `USER_IMPERSONATION_ENDED` vs the request timestamp.
3. **The act-as JWT genuinely lacked a tenant claim.** Considered and largely refuted by
   `admin-impersonation.controller.ts:163-175` (mint refuses without a resolved tenant), but not
   observable without decoding the actual token.

Causes 1 and 2 both reduce Session A to the same confirmed root cause, so this open question does
**not** block the fix — it only affects whether an additional impersonation-expiry UX ticket is
warranted.

### 7. Blast radius beyond batch upload — CONFIRMED in code, NOT observed at runtime

`getTenantId()` is called from four handlers in the same controller, so all four are expected to
400 for a GLOBAL_ADMIN with a working tenant:

| Line | Handler | Route |
|---|---|---|
| 230 | `transcribeFile` | `POST audio/transcription-jobs/transcribe` — **observed failing** |
| 367 | `createStreamSession` | `POST audio/transcription-jobs/stream/session` — live transcription start |
| 528 | `refreshStreamTicket` | `POST …/stream/session/:id/refresh-ticket` |
| 560 | `switchStreamSessionToFallback` | `POST …/stream/session/:id/switch-to-fallback` |

Line 367 is the significant one: **live streaming transcription should be equally broken for a
global admin**, which is a cheap falsifier for this diagnosis. If live streaming is observed to work
for a global admin with a working tenant, this analysis is wrong and must be revisited.

### 8. User-visible symptom

The UI surfaces the raw gateway message as a bare error toast — *"Tenant context is required. Ensure
you are authenticated with a tenant-scoped user."* There is no indication that the operator's
identity is the problem, no suggestion that a tenant-scoped account would succeed, and no link to
the tenant switcher. An operator reasonably reads it as "my working tenant isn't set", re-picks the
same tenant, and fails again.

### 9. Impact

- Batch upload in the live-transcription playground is **completely unusable** for GLOBAL_ADMIN
  sessions — the console's primary audience for working-tenant screens.
- Live streaming session creation is expected to be broken for the same audience (§7, unverified).
- Tenant-bound users (TENANT_ADMIN, DOCTOR) and API-key/compat callers are **unaffected**
  (§1 Session C confirmed for TENANT_ADMIN; DOCTOR is *inferred* from the identical
  `cls.user.tenantId`-populated code path, not observed).
- No data-integrity or tenant-isolation risk: this is a fail-closed rejection, never a cross-tenant
  leak. The fix must preserve that — the elevation at `context.interceptor.ts:89-101` is already
  gated to global admins and audited.

---

## Implementation Plan

TDD per `.claude/rules/01-development-workflow.md` — the failing test lands first and must be seen
RED before the one-line behaviour change.

### Step 1 (RED) — regression tests

File: `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts`

The existing CLS mock at line 44 is `get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' })`
— it returns the same object for *every* key, so it cannot express the global-admin shape. Replace
it with a key-aware mock in the new cases:

```ts
const clsFor = (store: Record<string, unknown>) => ({ get: vi.fn((key: string) => store[key]) });
```

Add three cases:

1. **global admin with an elevated working tenant** — store
   `{ user: { id: 'admin-1', tenantId: '', roles: ['GLOBAL_ADMIN'] }, tenantId: 'tenant-1' }`.
   `transcribeFile` must resolve `tenant-1` and dispatch the batch job with it — currently throws
   `BadRequestException`. **This is the RED test.**
2. **tenant-bound caller, no CLS `tenantId`** — store `{ user: { id: 'u', tenantId: 'tenant-1' } }`.
   Must still resolve `tenant-1` (guards the regression in the other direction).
3. **neither present** — store `{ user: { id: 'u', tenantId: '' } }`. Must still throw the 400
   (fail-closed posture preserved; an empty string must not be forwarded as a tenant).

Add the same first case for `createStreamSession` (line 367), since it shares the helper.

Run: `pnpm --filter @arcaai/api test -- transcription-job.controller` — capture the RED output.

### Step 2 (GREEN) — the fix

File: `apps/api/src/modules/streaming/transcription-job.controller.ts`, lines **113-119**.

```ts
  private getTenantId(): string {
    // Canonical resolution order, matching ClsTenantContextProvider.getTenantId()
    // (apps/api/src/database/tenant-context.provider.ts:59) and the sibling admin
    // controllers: the CLS `tenantId` FIRST — that is where ContextInterceptor
    // elevates a global-admin's working tenant from `x-tenant-id` — then the
    // JWT-derived identity. An empty string means "no tenant", never a tenant.
    const active = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
    if (!active || active.length === 0) {
      throw new BadRequestException('Tenant context is required. Ensure you are authenticated with a tenant-scoped user.');
    }
    return active;
  }
```

Notes on the shape:
- `??` (not `||`) on the first read matches `tenant-context.provider.ts:59` exactly; the explicit
  `length === 0` check is what stops an empty-string global-admin claim leaking through — the same
  reasoning documented in that file's lines 53-58.
- `ClsService<IActiveUserContext>` already types the `tenantId` key (it is set by
  `jwt.strategy.ts:73` and `context.interceptor.ts:94`), so no type widening is needed.
- **Security posture is unchanged.** The only way `cls.tenantId` diverges from
  `cls.user.tenantId` is the audited global-admin elevation, which `resolveActiveTenant`
  (`resolve-active-tenant.ts:28-43`) already restricts to `isSuperAdmin` callers with an empty JWT
  tenant and a well-formed UUID; a forged header from a tenant-bound caller is rejected as 400 at
  `context.interceptor.ts:73-80` before the handler runs. No new trust is granted here.
- Cross-tenant safety downstream is unaffected: `assertPipelineOwnership` (line 141) still runs
  before any I/O and still 404s a pipeline outside the resolved tenant.

### Step 3 (REFACTOR, optional, same ticket)

Extract the helper so a fifth copy cannot drift — the same argument
`apps/api/src/shared/tenant-scope.ts:5-14` makes for its own existence. Suggested: add
`resolveActiveTenantId(user, callerTenantId): string` to that module and have
`TranscriptionJobController.getTenantId()` become a one-line wrapper feeding
`this.cls.get('user')` / `this.cls.get('tenantId')`, matching the pattern already used by
`agentic-admin.controller.ts:76` and `harness-admin.controller.ts:586`. Keep the existing message
string so the new controller test and any e2e assertions stay valid.

### Step 4 — verification

1. `pnpm --filter @arcaai/api test -- transcription-job` — all green, RED case now passes.
2. `pnpm api:build` and `pnpm lint` (hard errors in `apps/api`).
3. Runtime, in the running stack (owner-driven; do **not** restart services as part of diagnosis):
   as `super_admin` with working tenant ArcaAI, upload a `.wav` on
   `/playground/live-transcription?tab=batch` → expect **201** and a job row whose `audioUri`
   targets the ArcaAI bucket (compare with the Session C control:
   `s3://hope-recordings-arcaai/...`).
4. Re-run the Session C control as `arcaai_admin` → still 201 (no regression for tenant-bound
   users).
5. Negative check: with **no** working tenant selected, the upload must still 400 (fail-closed).
6. Check §7's prediction: live streaming session start as a global admin with a working tenant
   should go from failing to working. If it was *already* working before the fix, reopen §2.

### Step 5 — UX follow-up (separate ticket, not this one)

The bare 400 toast is unactionable (§8). Once the gateway is fixed the message becomes rare, but the
console should still map a `Tenant context is required` 400 to "Select a working tenant to run this
action" with a link to the tenant switcher. Recommend filing separately rather than expanding this
bugfix.

---

## Implementation Summary

**Implemented 2026-08-03** following the plan above (Steps 1, 2 and 4). Step 3 (the shared-helper
refactor) was **not** taken — see "Deviations" below. Two files changed; nothing staged or committed.

### Files changed

**1. `apps/api/src/modules/streaming/transcription-job.controller.ts`** — `getTenantId()` (was lines
113-119). The body now reads the canonical order

```ts
const active = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
if (!active || active.length === 0) { throw new BadRequestException(/* unchanged message */); }
return active;
```

matching `ClsTenantContextProvider.getTenantId()` (`apps/api/src/database/tenant-context.provider.ts:59`)
exactly — `??` on the first read, plus the explicit `length === 0` check so a global admin's empty
`tenantId: ''` claim cannot leak through as a tenant. The 400 and its message string are unchanged,
so the fail-closed posture and any e2e assertions on that text still hold. A doc comment was added
recording the resolution order, why the CLS key comes first, and why no new trust is granted (the
only divergence between the two keys is the already-audited, `isSuperAdmin`-gated elevation in
`ContextInterceptor`; a forged header from a tenant-bound caller is still rejected as a 400 before
the handler runs).

This is the single change needed for all four affected routes: verified by grep over the file that
`transcribeFile` (:250), `createStreamSession` (:387), `refreshStreamTicket` (:548) and
`switchStreamSessionToFallback` (:580) are the only tenant reads and all four go through this one
helper. The remaining `this.cls.get('user')` reads in the file (:148, :310, :388, :549) resolve
`user.id` only, never a tenant, and were left alone.

**2. `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts`** — the shared
CLS mock plus four new tests.

The existing mock (`get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' })`) returned
the *same object for every key*, so it could neither express the global-admin shape nor survive the
fix (`cls.get('tenantId')` would have returned the user object). It is now key-aware via a new
`clsFor(store)` helper; the default store is a tenant-bound caller with the same tenant in **both**
`user.tenantId` and the CLS `tenantId` key, which is what `JwtStrategy.validate` actually writes.
This mock change alone is behaviour-neutral — all 58 pre-existing tests in the file stayed green
against the *unfixed* controller, so the RED below is attributable to the defect and not to the mock.

New `describe('BUG-012 — active tenant resolution (global-admin working tenant)')` with four tests:

| Test | Locks |
|---|---|
| `transcribeFile resolves the elevated CLS working tenant for a GLOBAL_ADMIN with an empty JWT tenant` | **the RED test** — the reported defect |
| `createStreamSession resolves the elevated CLS working tenant for a GLOBAL_ADMIN` | **also RED** — confirms §7's predicted blast radius in code |
| `transcribeFile falls back to the JWT user tenant when no CLS tenantId is set` | no regression for tenant-bound callers (Session C) |
| `transcribeFile still rejects when neither the CLS tenantId nor the JWT tenant is present` | fail-closed: an empty string is never forwarded as a tenant |

### Deviations from the plan

- **Step 3 (extract into `apps/api/src/shared/tenant-scope.ts`) was NOT done.** Open question 3 is
  still unanswered by the owner, and the ticket scopes it as optional; doing it would also have
  widened the diff into a file a concurrent BUG-013 workstream is adjacent to. The behavioural fix is
  complete without it. Recommend deciding it separately.
- Nothing else in the plan was changed.

### Verification evidence (2026-08-03)

**RED** — `npx vitest run src/modules/streaming/__tests__/transcription-job.controller.test.ts
src/modules/streaming/__tests__/transcription-job.stt-fallback.controller.test.ts`, tests written,
controller untouched:

```
 ❯ src/modules/streaming/__tests__/transcription-job.controller.test.ts (60 tests | 2 failed) 38ms
       × transcribeFile resolves the elevated CLS working tenant for a GLOBAL_ADMIN with an empty JWT tenant 3ms
       × createStreamSession resolves the elevated CLS working tenant for a GLOBAL_ADMIN 2ms

BadRequestException: Tenant context is required. Ensure you are authenticated with a tenant-scoped user.
 ❯ TranscriptionJobController.getTenantId src/modules/streaming/transcription-job.controller.ts:116:13
    114|     const user = this.cls.get('user');
    115|     if (!user?.tenantId) {
    116|       throw new BadRequestException('Tenant context is required. Ensur…
 ❯ TranscriptionJobController.transcribeFile src/modules/streaming/transcription-job.controller.ts:230:27

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 73 passed (75)
```

The failure lands on the exact line named in §2, through the exact helper — the test reproduces the
diagnosed defect, not a proxy for it.

**GREEN** — same command after the fix, widened to the whole module:

```
 Test Files  8 passed (8)
      Tests  245 passed (245)
```

**Build** — `pnpm api:build`:

```
 Tasks:    8 successful, 8 total
  Time:    21.949s
```

**Lint** — `eslint` over both changed files: `0 errors`. The one warning on
`transcription-job.controller.ts:228` (`eslint-comments/require-description`) is pre-existing — it is
the `no-explicit-any` disable in `getByStatus`, which this change only shifted downward by 20 lines.
The app-wide `apps/api` lint run reports 4 errors, all `prettier/prettier` in
`src/modules/smr-compat/summary-schemas.ts`, a file that is **unmodified in the working tree**
(`git status --porcelain apps/api/src/modules/smr-compat/` → empty) and therefore pre-existing on
`dev-2.1` HEAD, unrelated to this ticket.

**Full `apps/api` suite** — 0 failures in `src/modules/streaming/**`. Four files fail overall and
none is attributable here: 13 failures in `src/modules/internal/__tests__/stt-internal.controller.test.ts`
are a concurrent BUG-013 workstream's in-flight RED tests, and `src/__tests__/cors.config.test.ts`
plus the two `smr-compat` failures were already failing before this change.

### Runtime verification — DEFERRED (owner action required)

Step 4 items 3-6 are **not** done. `api`, `stt` and `smr` are running and were deliberately not
restarted, so the gateway is still executing the pre-fix build; the live 400 → 201 transition cannot
be observed until the owner restarts the API. Until then this fix is verified by unit test, build and
lint only. On restart, run Step 4 items 3-6 as written — in particular item 6, the §7 falsifier: a
global admin's live streaming session start should go from failing to working.

Files read during the original investigation (no writes):

- `apps/api/src/modules/streaming/transcription-job.controller.ts`
- `apps/api/src/interceptors/context.interceptor.ts`
- `apps/api/src/interceptors/resolve-active-tenant.ts`
- `apps/api/src/database/tenant-context.provider.ts`
- `apps/api/src/shared/tenant-scope.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/auth/admin-impersonation.controller.ts`
- `apps/api/src/modules/pipeline/audio-pipeline-public.controller.ts`
- `packages/applications/src/authorization/unified-auth.guard.ts`
- `packages/applications/src/services/auth/jwt.strategy.ts`
- `apps/admin-console/src/app/api/hope/[...path]/route.ts`
- `apps/admin-console/src/server/hope-proxy.ts`
- `apps/admin-console/src/server/session.ts`
- `apps/admin-console/src/app/api/auth/impersonate/route.ts`
- `apps/admin-console/src/shared/api/http.ts`
- `apps/admin-console/src/features/playground-live-transcription/api/client.ts`
- `packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts`

### Open questions for the owner

1. Confirm §6 — was the impersonation token expired or already revoked at
   `correlationId 019fc7fe-7110-7206-9213-aed66ae683a0`? Gateway logs would settle it. If it was a
   live token, §2 does not explain Session A and the analysis must be reopened.
2. Confirm §7 — does live streaming session creation currently fail for a global admin with a
   working tenant? A "no" falsifies this diagnosis.
3. Approve or decline the Step 3 refactor (extract into `shared/tenant-scope.ts`) as part of this
   ticket. **Still open** — the fix shipped without it (see Deviations).
4. **New, blocking closure**: restart `apps/api` and run Step 4 items 3-6. The services were running
   during implementation and were deliberately not restarted, so the live repro has not been
   re-tested against the fixed build.

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-03 | implementation agent | **Fix implemented (TDD).** Tests first: made the shared CLS mock in `transcription-job.controller.test.ts` key-aware (the old one returned one object for every key and could not express the global-admin shape) and added four `BUG-012` cases. Saw RED — the two global-admin cases (`transcribeFile`, `createStreamSession`) failed with `BadRequestException` raised at `transcription-job.controller.ts:116`, the exact line diagnosed in §2. Then applied the minimal fix to `getTenantId()`: the canonical `this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId` order with an explicit empty-string check, matching `tenant-context.provider.ts:59`; the 400 and its message are unchanged. GREEN: 245/245 in `src/modules/streaming/__tests__/`. `pnpm api:build` 8/8 successful; lint 0 errors on both changed files (the 4 `apps/api` lint errors are pre-existing prettier violations in the unmodified `smr-compat/summary-schemas.ts`). One helper fixes all four routes in §7 — verified no other tenant read in the file bypasses it. Step 3 refactor declined for now (open question 3 unanswered; keeps the diff minimal). **Runtime verification deferred**: `api`/`stt`/`smr` were left running per instruction, so the live 400 → 201 is unconfirmed until the owner restarts the API. Status `Pending` → `Review`. Nothing staged or committed. |
| 2026-08-03 | debugger agent | Ticket created. Defect discovered during live-transcription playground batch-upload E2E testing on `dev-2.1`. Root-cause analysis completed read-only: `TranscriptionJobController.getTenantId()` (`transcription-job.controller.ts:113-119`) reads only `cls.user.tenantId` and ignores the CLS `tenantId` key into which `ContextInterceptor` (`context.interceptor.ts:89-101`) elevates a global admin's working tenant, so every GLOBAL_ADMIN caller is rejected with a 400 while tenant-bound and API-key callers succeed. The initial hypothesis that the BFF proxy drops `X-Tenant-Id` on the multipart branch was tested and **refuted** — `hope-proxy.ts` `buildHeaders` (lines 20-38) is method-agnostic and its only method-conditional line is the body buffer at line 87. Status `Pending`; no code changed. |
</content>
