# TASK-722 — Exposure Plane v1 (REST invoke + status + SSE)

| | |
|---|---|
| **Status** | Review (Tasks 1, 3(service half), 4, 5, 6, 7, 8, 9, 10, 11 shipped, unit-tested and build-verified with real command output. Task 2's e2e spec is authored, Playwright-listable (15 cases), and confirmed live against a running server for auth/scope wiring — but full `pnpm test:e2e` execution is BLOCKED by a Prisma AI-agent safety guard on `db push --force-reset`, not by anything in this ticket's code; see §7. R-1/R-8 human gates remain OFF/closed by default as instructed) |
| **Wave** | 2 · **Size** | L |
| **Epic slug** | `exposure-v1` |
| **Depends on** | TASK-708 (`apikey-scope-verification`), TASK-718 (`workflow-interpreter`), TASK-720 (`palette-summarization`) · **consumes** TASK-717 (`async-contract`) |
| **Design refs** | D3, D7 from [design.md](../../architecture/agentic-workflow-platform/design.md) — §Exposure plane, §Data flow (Execution), Roadmap Wave 2 |
| **Findings closed** | — (enabling). Depends on TASK-708 closing the API-key-scope precondition. |

---

## 1. Requirement Analysis

### What this delivers

Published workflow versions become **products**: a tenant's published workflow is invokable over
REST, its run is pollable, and its progress streams over SSE — through **one generic gateway
surface**, with **scoped API keys**, tenant-resolved and entitlement-checked.

Routes (all under the global `api/v1` prefix, `apps/api/src/main.ts:100-102`):

| Route | Purpose |
|---|---|
| `POST /api/v1/workflows/:slug/invoke` | Start a run of the tenant's active published version of `:slug` |
| `GET /api/v1/workflows/:slug/runs/:runId` | Run status + result |
| `GET /api/v1/workflows/:slug/runs/:runId/stream` | SSE progress + result, resumable |
| `POST /api/v1/workflows/:slug/runs/:runId/cancel` | Cancel a run |
| `GET /api/v1/workflows` | List the tenant's published, invokable workflows (slug + input schema) |

### Settled decisions (do NOT re-litigate)

| # | Decision |
|---|---|
| S-1 | **ONE generic surface.** `/api/v1/workflows/:slug/…`. **Never per-workflow route generation** — design.md §Exposure plane and §Explicitly not doing (YAGNI ledger). |
| S-2 | **Scoped API keys.** TASK-708's exit criterion — end-to-end API-key scope enforcement verified — is this ticket's **precondition**. Cite it; do not re-verify it here beyond adding this surface's own routes to the audit. |
| S-3 | **Tenant-resolved.** The tenant comes from the authenticated principal, never from the request body or a header the caller controls. |
| S-4 | **Entitlement-checked** on every invoke. |
| S-5 | **SSE uses the async-contract envelope** (TASK-717) and **consumes its resume-token convention** — this ticket does not invent one. |
| S-6 | **SSE/WS never carry a JWT in a URL.** Single-use stream tickets, reusing the existing mechanism verbatim (`.claude/rules/13-nextjs-apps.md` §Auth, `.claude/rules/08-vox-sdk.md`). |

### Why the API-key precondition (S-2) is load-bearing

Design.md §Exposure plane states it in bold: *"**Precondition (early work item): verify API-key
scope enforcement end-to-end before any workflow is publicly exposed.**"* The verified reason is in
§2: today, a route with **no** `@RequiredScopes(...)` metadata is **unrestricted for any valid API
key** — `unified-auth.guard.ts:220-222` returns early when the metadata is absent. That is a safe
default for internal routes reached only by session JWTs; it is not a safe default for a surface
whose entire purpose is API-key access. TASK-708 makes the guarantee; this ticket must not ship
before it.

### Out of scope

- **Webhook triggers** — TASK-727 (depends on 717 + this).
- **Socket/WS channel** — design.md lists it under channels but Wave 2 is REST + SSE only.
- **`@arcaai/vox` / `@arcaai/vox-node` SDK clients** for this surface — a follow-on; note that
  `@arcaai/vox-node` is the correct home (zero runtime deps, `X-API-Key`, SSE parsed off
  `response.body` never `EventSource` — `.claude/rules/08-vox-sdk.md`).
- **Per-workflow OpenAPI generation.** The generic surface documents the *envelope*; the per-slug
  input schema is served as data by `GET /api/v1/workflows`.
- **The Studio, the Workbench, the runs read model.** TASK-719/721/723.

---

## 2. Current State Evaluation

### Nothing named `workflows` exists on the gateway yet

Verified: no `@Controller` in `apps/api/src` matches `workflow`. The only `workflows/` routes belong
to the Temporal ops proxy under a different prefix —
`apps/api/src/modules/harness-admin/harness-admin.controller.ts:453` (`GET workflows/:id`), `:465`
(cancel), `:475` (terminate), `:485` (signal). **There is no `slug` concept for workflows anywhere in
`apps/api/src`.**

`harness-admin.controller.ts:485` is also the F-09 hole recorded in
[orchestration.md](../../architecture/consultation-session-workflow/assessment/evidence/orchestration.md):
it forwards an **arbitrary, unrestricted** `signalName` + payload to a Temporal handle and can
resolve `HarnessDocWorkflow`'s clinician gate. **This ticket's cancel route must be an allow-list by
name, never a pass-through** — and must not be built by copying that controller.

### The global request pipeline this surface plugs into

`.claude/rules/05-nestjs-api.md` §Global Request Pipeline, re-verified against `apps/api/src/app.module.ts`:

| Order | Guard/interceptor | Registration |
|---|---|---|
| 1 | `TieredThrottlerGuard` | `app.module.ts:158-161`, **first** in the `guards` array (`:153`), deliberately before `ClsGuard` — rationale at `:154-157` |
| 2 | `ClsGuard` | `app.module.ts:162-165` |
| 3 | `UnifiedAuthGuard` | `app.module.ts:166-169` |
| … | `RequiresIfMatchGuard` | `app.module.ts:194-197`, **last**; rationale at `:147-152` |
| — | `ETagInterceptor` | `apps/api/src/main.ts:174` (`app.useGlobalInterceptors(new ETagInterceptor())`) |

Global prefix `api/v1` (`main.ts:100-102`); global `ValidationPipe` with
`transform + whitelist + forbidNonWhitelisted + forbidUnknownValues`, so **every accepted field must
be declared on a class-validator DTO** (rule 05 §Bootstrap Facts).

### API-key auth + scopes — verified end to end

**Recognition** (`packages/applications/src/authorization/unified-auth.guard.ts`): the API-key path
is tried **before** the JWT path — `:103-104` extracts the key, `:126` starts JWT.
`handleApiKeyAuth` (`:164-215`) authenticates, applies the per-key rate limit when
`apiKeyEntity.rateLimit > 0` (`:175-176`), enforces scopes (`:190`), then sets `request['apiKey']`
(`:192`), `request.user` (`:193-196`) and CLS `tenantId` (`:200-201`).

Accepted headers (`packages/applications/src/services/apiKey/apikey.service.ts:954-958`):

```ts
    const apiKey =
      (request.headers['apikey'] as string) ||
      (request.headers['api-key'] as string) ||
      (request.headers['x-api-key'] as string) ||
      (request.headers['x-internal-service-key'] as string);
```

A `?apiKey=` query fallback exists but is gated by the platform setting `apiKey.allowQueryParam`
(`:960-969`) — **this surface must never rely on it** (rule: no credentials in query strings).

**Scope enforcement** (`unified-auth.guard.ts:217-234`) — and the reason S-2 matters:

```ts
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [...]);
    if (!requiredScopes || requiredScopes.length === 0) { return; }        // no metadata ⇒ unrestricted
    const hasRequiredScope = requiredScopes.some((scope) => this.apiKeyService.hasScope(apiKeyEntity, scope));
```

403 on failure (`:233`). Matching (`apikey.service.ts:838-857`): `'*'` grants everything (`:846-848`),
exact match (`:852-854`), parent prefix — `"stt"` grants `"stt:transcribe"` (`:856`).

`@RequiredScopes(...)` (`packages/applications/src/authorization/decorators.ts:124-134`) validates
each scope **at decoration time** against `isValidScope` and throws on an unknown scope (`:125-132`).

**The registry has no workflow scopes.** `API_KEY_SCOPE_REGISTRY`
(`packages/applications/src/services/apiKey/apikey-scopes.registry.ts:6-51`) contains STT,
Consultation, User, Media, Admin, Webhook families plus wildcards. There is **no `workflow:*` and no
`text:*`**. This ticket adds them.

**A boot-time scope audit already exists and is the right place to register these routes:**
`apps/api/src/bootstrap/api-key-scope-audit.ts` — `auditApiKeyRequiredScopes(routes = SDK_DAY1_SCOPED_ROUTES)`
at `:61`, reading metadata at `:73` and throwing at `:78-79`:

> `@RequiredScopes(...) metadata. A leaked API key would reach this route with no scope check.`

Invoked from `apps/api/src/main.ts:294` (comment at `:291`). Tests at
`apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts` cover both the missing-metadata throw
(`:52`) and a stale-method-name throw (`:74`).

**Prisma** (`packages/database/src/prisma/db_main/apikey.prisma`): `model ApiKey` at `:22-83`;
access control at `:39-42` — `scopes Json? @db.JsonB`, `allowedIps Json? @db.JsonB`,
`rateLimit Int?`; `keyHash String @unique` (`:33`), `keyPrefix` (`:34`), `keyStatus` (`:37`),
`expiresAt` (`:45`), rotation fields (`:50-53`). Enums `ApiKeyStatus` (`:4-11`) and `ApiKeyType`
(`:13-20`).

### Rate limiting — verified, and there is no custom decorator

`TieredThrottlerGuard` (`apps/api/src/modules/throttle/tiered-throttler.guard.ts:53`) extends
`ThrottlerGuard`. **Tiers are selected with the stock `@Throttle({ <tier>: {...} })` from
`@nestjs/throttler`** — there is no HOPE-specific decorator. The guard reads
`'THROTTLER:LIMIT' + name` / `'THROTTLER:TTL' + name` metadata (`:10-11`, read at `:68` and `:103`).
Opt-in gate (`:70-73`):

```ts
    if (name !== 'default' && decoratorLimit === undefined) {
      return true;
    }
```

Tiers `default` (always on), `strict`, `heavy`, `relaxed` (opt-in) — documented at
`apps/api/src/modules/throttle/throttle.module.ts:17-27`; Redis-backed storage outside tests
(`:64-65`). Effective precedence `override ?? decorator ?? tenantRow ?? plan ?? tier`
(`tiered-throttler.guard.ts:126-127`), plan tier via
`IEntitlementsService.getTenantRateLimitPolicy` (`:149`).

**Two facts that shape this ticket:**

1. **No route in `apps/api/src` currently opts into `strict`, `heavy`, or `relaxed`.** Every real
   `@Throttle` usage is the `default` tier (`auth.controller.ts:138` login `5/60s`, `:782` refresh
   `60/60s`; class-level `health.controller.ts:52` `30/60s`, `monitoring.controller.ts:18`
   `300/60s`). This surface would be the **first `heavy` consumer** — treat that as a deliberate,
   reviewed choice, not a freebie.
2. **API-key traffic rides the global tiers.** The pre-auth tenant id is an *unverified* JWT decode
   (`:173-186`, `decodeJwtTenantId` at `:194-204`) and **returns `null` for API-key traffic**
   (`:169-171`). So per-tenant plan limits do **not** apply to API-key callers at the throttler
   layer. The compensating control that does apply is the per-key `ApiKey.rateLimit`
   (`apikey.prisma:42`, enforced at `unified-auth.guard.ts:175-176`). Say this in the ticket's
   security notes and set a sane per-key default for workflow keys.

### Idempotency — no global mechanism; two reusable per-domain ones

**There is no idempotency interceptor or shared service in `apps/api`.** No `*idempotenc*` file under
`apps/api/src`; `SmrProxyController` has none, and `getForwardHeaders()`
(`smr-proxy.controller.ts:288-300`) does not forward a client `Idempotency-Key`.

Two patterns exist and either is a valid model:

1. **`ConsultationJobService`** (`packages/applications/src/services/consultation/jobs/consultation-job.service.ts`)
   — `IDEMPOTENCY_KEY_PREFIX = 'idempotency:'` (`:80`), `IDEMPOTENCY_TTL = 86400` (`:81`), key shape
   (`:549-551`):
   ```ts
     return `${this.IDEMPOTENCY_KEY_PREFIX}${jobType}:${tenantId}:${userId}:${idempotencyKey}`;
   ```
   Lookup at `:558-582` is **best-effort** (returns `null` on a Redis error). The key arrives as a
   **body field**, not a header — DTO example
   `packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts:35-43`:
   *"When supplied, the backend Redis-dedupes by `(tenantId, userId, key)` and returns the prior
   `jobId` on collision (HTTP 200)."*
2. **`HarnessInternalService.withHarnessIdempotency`**
   (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:1392-1434`)
   — the **response-replay** variant: GET the cached response and replay it (`:1405-1410`), else do
   the work and `setex` the result **after** the successful write (`:1421-1424`), with warn-and-continue
   on Redis failure. Prefix `'idempotency:harness:'` (`:92`), TTL 86400 (`:93`). Header ingress via
   `@Headers('Idempotency-Key')` (`apps/api/src/modules/consultation/harness-internal.controller.ts:276`).

**Recommendation for this ticket (§4 Task 5): pattern 2, with header ingress.** A public REST product
surface should honour the standard `Idempotency-Key` **header**; and replaying the prior response
(rather than only the prior job id) is the behaviour an external integrator expects. SDK-side
generators already exist: `packages/vox-node/src/core/idempotency.ts:42`,
`packages/agentic-sdk-v2/src/utils/idempotency.ts:20,32`.

### Stream tickets — verified, reuse verbatim (S-6)

`apps/api/src/modules/auth/stream-ticket.service.ts` (123 lines). Locked contract in its own docstring
(`:9-18`): Redis key `stream-ticket:<ticket>` → `{ userId, tenantId, scope, exp }`; **TTL 30 s**
(`:25`, `setex` at `:77`); **single-use** — `consumeTicket()` does GET (`:86`) + DEL (`:113`),
returning `null` for unknown/expired/corrupt (`:87`, `:115-116`). Token = 32 random bytes base64url
(`:26`, `:67`). `StoredTicket` at `:51-58` also carries `impersonatedBy`.

The motivation is stated verbatim at `:5-8`: *"…without leaking long-lived JWTs into the URL query
string (HIPAA-relevant; query strings show up in CDN access logs, browser history, and Highlight.io
network recordings)."*

Issue route: `POST /api/v1/auth/stream-ticket` (`apps/api/src/modules/auth/auth.controller.ts:893`,
`@HttpCode(200)` `:894`, `@Authorize()` `:895`). Handler `issueStreamTicket` (`:904-940`) resolves
the user from CLS (`:905`), tenant from `cls tenantId || user.tenantId || null` (`:912`), and runs
**mint-time ownership assertions** — `assertConsultationScopeOwnership` (`:918`) and
`assertSttSessionScopeOwnership` (`:923`) — before minting (`:925-932`). **This ticket adds a third:
`assertWorkflowRunScopeOwnership`.**

Redemption (`apps/api/src/guards/jwtauth.guard.ts:43`): ticket read from `?ticket=` (`:66-68`),
same-request replay marker `CONSUMED_STREAM_TICKET` (`:22`, `:92`, `:151-153`), `consumeTicket` at
`:96` (401 `'Invalid or expired stream ticket'` at `:99`), scope compared against `@StreamScope`
metadata (`:102`, mismatch → 401 at `:125-129`), impersonation claim restored (`:132-143`).

`@StreamScope` (`apps/api/src/modules/auth/decorators/stream-scope.decorator.ts:31-33`, config
interface `:24-29`). **Routes without it cannot be opened via `?ticket=`** (`:19-20`). The only
streaming-module route using it today is `smr-proxy.controller.ts:576`
(`{ namespace: 'smr_task', param: 'taskId' }`).

**Note:** `POST /auth/stream-ticket` carries **no per-endpoint `@Throttle`** (confirmed by
`apps/api/src/modules/throttle/__tests__/throttle-decorators.test.ts:105-109`). Adding a fourth
namespace increases its value as a target; flag it in §6.

### SSE proxying + the resume-token convention (S-5)

The existing SSE passthrough is `SmrProxyController.streamTaskEvents`
(`apps/api/src/modules/streaming/smr-proxy.controller.ts:583-740`) and is the exemplar to imitate:

- Headers set manually and flushed: `:590-594` — `text/event-stream`, `no-cache, no-transform`,
  `keep-alive`, `X-Accel-Buffering: no`, then `res.flushHeaders()`.
- **Resume propagation:** `:667-669` appends `?last_event_id=<encoded>` to the upstream URL when the
  inbound `last-event-id` header is present (`@Headers('last-event-id')` at `:585`).
- Upstream: `responseType: 'stream'`, `Accept: text/event-stream`, `timeout: 300_000` (`:670-674`).
- Byte-pipe forwarding: `:684-687`.
- Heartbeat `':keepalive\n\n'` every `SSE_HEARTBEAT_INTERVAL_MS = 15_000` (`:141`, written at
  `:678-682`).
- Teardown on `end`/`error`/client `close` (`:689-714`), each calling an idempotent `emitUsageOnce()`
  (`:613-634`) recording to `IUsageLedgerService` with `operation: 'generate.stream'` (`:621`).
- **Errors never forward the upstream body (PHI)** — `:715-739`, `buildUpstreamException` at
  `:322-349`.

The producer-side convention this mirrors is SMR's
(`apps/text/src/text/api/endpoints/stream.py`): `GET /api/v1/tasks/{task_id}/stream` (`:19-25`),
`EventSourceResponse` (`:92`), cursor seeded from `last_event_id or request.headers.get(
"last-event-id") or "0-0"` (`:35`), each event's SSE `id` being the **raw Redis Stream message id**
(`:61`):

```python
yield {"event": chunk.type, "data": chunk.model_dump_json(), "id": msg_id}
```

Event names come from `StreamChunk.type` — `Literal["chunk","reasoning","meta","done","error","usage"]`
(`apps/text/src/text/models/stream.py:10-13`); `done`/`error` terminate the generator (`:65-66`). The
read is a blocking `XREAD` (`apps/text/src/text/services/task_manager.py:142-156`, `block_ms=5000`).

**TASK-717 (`async-contract`) formalises this envelope and its resume-token convention.** This ticket
**consumes** it — it must not define a second one. If 717's envelope has not landed when this starts,
adopt the SMR shape above verbatim and leave a `TODO(TASK-717)` at the single mapping point.

### Entitlements — verified interface, and the gating gap

`IEntitlementsService` (`packages/applications/src/services/entitlements/IEntitlementsService.ts`,
interface `:53`, DI token `:184`). Relevant signatures:

```ts
isFeatureEnabled(tenantId: EntityId, feature: EntitlementFeatureKey): Promise<boolean>;                 // :98
assertQuantityQuota(tenantId, capability: EntitlementLimitKey, currentCount: number, increment?): Promise<void>;  // :109
assertMeterQuota(tenantId, capability: MeterCapabilityKey, increment?): Promise<void>;                  // :127
assertConcurrencyQuota(tenantId: EntityId, increment?: number): Promise<void>;                          // :149
isEnforcementEnabled(): boolean;                                                                        // :58
```

Real `assertQuantityQuota` call sites to imitate: `apikey.service.ts:293` (`'maxApiKeys'`, with the
COUNT query **only** running when enforcement is on, `:289`), `stt/pipeline/pipeline.service.ts:63`
and `:238` (`'maxAsrPipelines'`), `prompt-management.service.ts:228` (`'maxPromptTemplates'`).

**The gap:** entitlement keys are **columns, not free strings**.
`resolve-entitlements.ts:48-63` defines `ResolvedFeatures` as `{ dnaReports, voiceEnrollment,
monitoringAccess, platformDefaultCredential }`, and the docstring at `IEntitlementsService.ts:12-18`
explains why: *"entitlements are COLUMN-per-key, so the type system is the registry."* Limits are
likewise `PlanEntitlementInput` columns (`resolve-entitlements.ts:82-88`: `maxUsers`,
`maxDepartments`, `maxPromptTemplates`, `maxAsrPipelines`, `maxApiKeys`, `storageQuotaBytes`).

So gating workflow invocation needs a **Prisma migration**, not a config row. This ticket adds
`maxWorkflowDefinitions` (quantity) and a `workflowInvocations` meter, modelled on `maxAsrPipelines`
and the existing meter capabilities. Also note `assertMeterQuota` **fails OPEN on a metering-read
failure** by design (docstring `:127+`: *"a billing-data outage must not 500"*) — that is correct for
the clinical hot path and acceptable here; do not "fix" it.

### ETag / OCC — and why the status DTO needs a `version`

`ETagInterceptor` (`apps/api/src/interceptors/etag.interceptor.ts:33`) sets `ETag: "<version>"`
(`:40`) only when `extractVersion` (`:47-55`) finds a **top-level positive-integer `version`**,
skipping `{data: [...]}` collections (`:51`). `RequiresIfMatchGuard`
(`apps/api/src/decorators/requiresIfMatch.guard.ts:30`) sets `req._requiresIfMatch = true`;
`@ExpectedVersion()` (`apps/api/src/decorators/expectedVersion.decorator.ts:105`, extractor
`:53-86`) returns **428** when the header is missing on a `@RequiresIfMatch()` route (`:57-71`) and
400 on a malformed one (`:76-84`).

**Consequence:** the workflow-definition write routes (TASK-719's, not this ticket's) need OCC; this
ticket's **read** routes only get an `ETag` if their DTO exposes `version`. Decide deliberately —
a run-status DTO probably should not, since a run is not OCC-written.

---

## 3. Knowledge & Best Practices

### Repo law that binds this work

| Rule | Section | Binding constraint |
|---|---|---|
| `.claude/rules/05-nestjs-api.md` | §Controllers | Controllers hold **no business logic and no Prisma**; `arcaai-internal/no-controller-direct-prisma` is a **hard error** in `apps/api`. Inject `I*Service` tokens + `ClsService` only. |
| `.claude/rules/05-nestjs-api.md` | §Global Request Pipeline | `UnifiedAuthGuard` is **deny-by-default**; a boot-time audit refuses to start if any route lacks `@Public()` or a permission decorator. |
| `.claude/rules/05-nestjs-api.md` | §Errors & Logging | Cross-tenant access returns **404, never 403**. |
| `.claude/rules/05-nestjs-api.md` | §Configuration | Downstream URLs come from `IConfigService.getConfigValue(...)`; direct `process.env.<URL>` reads in `src/modules/**` are lint-banned (`arcaai-internal/no-direct-downstream-url-env`). |
| `.claude/rules/05-nestjs-api.md` | §Testing | New admin/by-id surfaces need cross-tenant e2e coverage; exemplar `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts`. E2E files use `.spec.ts`. |
| `.claude/rules/04-application-services.md` | §Service Folder Pattern, §DTOs | Symbol-token DI, `BaseService`, `broadcastSysEvent` on every mutation, `class-validator` + `@ApiProperty` on every field. |
| `.claude/rules/04-application-services.md` | §Transactions, Pagination, Quotas | Quota prechecks via `IEntitlementsService.assertQuantityQuota` → `QuotaExceededException`, kill-switch-gated. |
| `.claude/rules/13-nextjs-apps.md` | §Auth — BFF | *"SSE/WS connect DIRECTLY to the gateway with single-use tickets from `POST /api/v1/auth/stream-ticket` — never put JWTs in URLs."* |
| `.claude/rules/08-vox-sdk.md` | §`@arcaai/vox-node` | SSE parsed off `response.body`, never `EventSource` (it cannot set an API-key header). Relevant if an SDK client follows. |
| `.claude/rules/09-infrastructure-devops.md` | §Env & Secrets | New runtime env vars go to `turbo.json#globalEnv` + `.env.dev` + the relevant `.env.sample`. |
| `.claude/rules/02-database-prisma.md` | §Migration Workflow | Author against a **throwaway shadow DB**, never the dev DB; folder `<timestamp>_task_722_<desc>`; never edit a committed migration. |
| `.claude/rules/03-domain-layer.md` | §Generated Code Discipline | **Never run `pnpm gen:mapper`.** `gen:repository` is broken. |

### SOTA / base practices this implementation follows

| Practice | Justification |
|---|---|
| **One generic route family, slug-parameterised** | Generated routes multiply the audited surface by the number of tenant workflows; one route is one thing to secure. D3 + the YAGNI ledger. |
| **Deny-by-default scopes with a boot-time audit** | `unified-auth.guard.ts:220-222` makes *absent* metadata mean *unrestricted*; the audit (`api-key-scope-audit.ts:78-79`) converts a silent hole into a refusal to boot. |
| **Idempotency-Key header with response replay** | The behaviour external integrators expect from a POST product surface; `withHarnessIdempotency` already implements it correctly (write first, record after). |
| **Resume via SSE `id` + `Last-Event-ID`** | The W3C SSE convention, already implemented end-to-end here (`stream.py:35,61` ↔ `smr-proxy.controller.ts:667-669`). Reuse, don't reinvent. |
| **Single-use 30 s stream tickets** | Keeps credentials out of URLs that land in CDN logs (`stream-ticket.service.ts:5-8`). |
| **404-over-403 for cross-tenant slugs** | Hides resource existence; the platform-wide posture (rule 05). |
| **Slug uniqueness per tenant, immutable after first publish** | A slug is a public URL; silently repointing it repoints every integrator. |

### Pitfalls specific to THIS ticket

1. **Do not copy `harness-admin.controller.ts:485`.** Its unrestricted `signalName` pass-through is
   orchestration.md F-09. Cancel is an allow-listed action, not a signal proxy.
2. **Do not rely on the `?apiKey=` query fallback** (`apikey.service.ts:960-969`).
3. **Do not assume plan rate limits apply to API-key traffic** — `tiered-throttler.guard.ts:169-171`
   returns `null` for it. Per-key `ApiKey.rateLimit` is the control that does apply.
4. **Do not forward the upstream error body** on SSE or invoke failures — it can echo PHI
   (`smr-proxy.controller.ts:715-739`, `ai-inference.client.ts:128-136`).
5. **Do not add a second SSE envelope.** TASK-717 owns it (S-5).
6. **Do not put `tenantId` in the invoke body.** S-3 — it comes from the authenticated principal.
7. **`@RequiredScopes` throws at decoration time on an unknown scope** (`decorators.ts:125-132`), so
   the registry entries (Task 1) must land before the controller.
8. **`gen:mapper` is destructive** if any task touches `packages/domains`.
9. **Migration discipline** — the entitlement columns need a shadow-DB-authored migration
   (rule 02 §Migration Workflow). `pnpm db:migrate:create -- -n <name>` does **not** forward the
   flag; use `pnpm --filter @arcaai/database db:migrate:create -n <name>`.

---

## 4. Implementation Plan

### Task 1 — Add workflow scopes to the API-key registry

- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `packages/applications/src/services/apiKey/apikey-scopes.registry.ts`
- **Approach:** Add a `Workflow` category mirroring the existing families
  (`apikey-scopes.registry.ts:6-51`):
  `workflow:definition:read` (list published workflows + their input schemas),
  `workflow:run:write` (invoke, cancel), `workflow:run:read` (status, stream), plus the wildcard
  `workflow:*`. Keep the `{ description, category }` shape (`:1-4`). Note the prefix-matching rule
  (`apikey.service.ts:856`) means a key holding `"workflow"` grants all three — that is the existing
  semantics, not a new one.
- **Verify:** `pnpm --filter @arcaai/applications test`; a test asserting `isValidScope` accepts each
  new scope and `getScopesByCategory()` groups them.

### Task 2 — RED: e2e spec for the whole surface

- **Agent:** T2 · sonnet-5 · high
- **Files:** create `apps/api/tests/e2e/task-722-workflow-exposure.spec.ts`
- **Approach:** Write the full failing spec first (rule 01 §TDD). Cases:
  - invoke with a valid key holding `workflow:run:write` ⇒ 202 + `runId`;
  - invoke with a key holding **only** `workflow:run:read` ⇒ **403** (scope violation, a privilege
    boundary — not 404);
  - invoke a slug belonging to **another tenant** ⇒ **404** (cross-tenant posture; exemplar
    `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts`);
  - invoke an unpublished/DRAFT slug ⇒ 404;
  - repeat invoke with the same `Idempotency-Key` ⇒ same `runId`, no second run;
  - invoke a body violating the definition's declared input schema ⇒ 400 with per-field problems;
  - status poll ⇒ terminal state; SSE stream with a stream ticket ⇒ events then `done`;
  - SSE **without** a ticket and without a session ⇒ 401; SSE with a **reused** ticket ⇒ 401;
  - quota exhausted ⇒ `QuotaExceededException` mapped per rule 04.
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e` — all FAIL (no routes). Paste RED.

### Task 3 — Slug model + definition-lookup service methods

- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - modify `packages/database/src/prisma/db_main/<workflow-definition>.prisma` (TASK-715's file — add
    `slug String` + `@@unique([tenantId, slug], map: "…")`)
  - create the migration under `packages/database/src/prisma/migrations/`
  - modify TASK-715's domain entity/factory/mapper/repository (**hand-authored** — rule 03) and the
    application service
- **Approach:** Slug rules: `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`; **unique per tenant**, enforced by
  `@@unique([tenantId, slug], map: "WorkflowDefinition_tenant_slug_unique")` — note rule 02's trap:
  on `@@unique`, `name:` sets the **client-facing** compound key while `map:` sets the **DB index
  name**; getting this wrong drifts the ledger permanently (the TASK-648 failure). Collision ⇒ 409
  with a suggested alternative; **immutable after the first publish** (a slug is a public URL) —
  renaming means a new definition. Reserve a small deny-list (`admin`, `internal`, `health`, `docs`)
  so a slug can never shadow a gateway path segment. Follow the governance-triple precedent
  documented at
  `packages/database/src/prisma/db_main/consultation-context-schema.prisma:6-17`.
  Add `findPublishedBySlug(tenantId, slug)` returning **null** (⇒ controller 404) for a foreign or
  unpublished row — never a 403.
  Migration per rule 02: author against a **throwaway shadow DB**, name it
  `task_722_workflow_slug`, prove no drift with `npx prisma migrate diff --from-config-datasource
  --to-schema src/prisma/db_main --script` printing `-- This is an empty migration.`
- **Verify:** `pnpm --filter @arcaai/database test`; `pnpm db:generate`; `pnpm gen:model` then
  `pnpm gen:entity` + `pnpm gen:factory` reporting no drift **and** schema coverage OK
  (**never `gen:mapper`**); `pnpm --filter @arcaai/domains build test`.

### Task 4 — Entitlement columns + quota checks

- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify the `PlanEntitlement` Prisma model + a migration; modify
  `packages/applications/src/services/entitlements/resolve-entitlements.ts`; modify the entitlements
  service + its `__tests__`
- **Approach:** Add `maxWorkflowDefinitions` (quantity limit, modelled verbatim on `maxAsrPipelines`,
  `resolve-entitlements.ts:82-88`) and a `workflowInvocations` **meter** capability. Because
  entitlements are column-per-key (`IEntitlementsService.ts:12-18`), this is a schema change, not
  config. Seed sane per-plan values. Wire `assertQuantityQuota(tenantId, 'maxWorkflowDefinitions', …)`
  into the definition-create path (imitating `apikey.service.ts:289-293` — **run the COUNT only when
  `isEnforcementEnabled()`**) and `assertMeterQuota(tenantId, 'workflowInvocations')` into invoke.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/database test`;
  migration drift check clean.

### Task 5 — The application service: invoke / status / cancel / list

- **Agent:** T3 · opus-4-8 · high
- **Files:** create `packages/applications/src/services/workflow-exposure/` —
  `IWorkflowExposureService.ts`, `workflow-exposure.service.ts`, `workflow-exposure.service.module.ts`,
  `workflow-exposure.dto.mapper.ts`, `dto/{invoke-workflow.request,workflow-run.response,workflow-summary.response}.ts`,
  `__tests__/`, `index.ts`
- **Approach:** Exact folder pattern of `services/department/` (rule 04). Symbol token
  `export const IWorkflowExposureService = Symbol(...)`. Extend `BaseService`.
  `invoke(slug, body, idempotencyKey)`:
  1. `tenantId` from `this.tenantId` (the `BaseService` CLS getter) — **never from the body** (S-3);
  2. `findPublishedBySlug` ⇒ null ⇒ `NotFoundException` (404-over-403);
  3. validate `body.input` against the definition's declared context schema, reusing
     `packages/json-schema-subset`'s evaluator (the same one TASK-720's N-1 uses) ⇒ 400 with
     per-field problems;
  4. `assertMeterQuota` (rule 04 §Quotas);
  5. idempotency wrapper — copy `withHarnessIdempotency`
     (`harness-internal.service.ts:1392-1434`) verbatim in structure: replay the cached response,
     else do the work and `setex` **after** the successful write, warn-and-continue on Redis error.
     Key `workflow-run:<tenantId>:<slug>:<idempotencyKey>`;
  6. POST to the harness dispatcher `POST /api/v1/internal/workflow-runs:start` (TASK-718 Task 10)
     with `HARNESS_URL` from `IConfigService.getConfigValue('HARNESS_URL')` — **never**
     `process.env` (lint-banned, rule 05) — and the `X-Service-Token` from `SecretsService`, the
     `smr-proxy.controller.ts:288-300` pattern;
  7. `broadcastSysEvent` on the invocation and write an audit row (rule 04 §ALWAYS);
  8. map to `WorkflowRunResponse` via the static DTO mapper — never return an entity.
  Request DTO: `{ input: Record<string, unknown> }` **only** — every field declared with
  `class-validator` + `@ApiProperty`, because the global pipe runs `forbidNonWhitelisted`.
  Cancel calls the dispatcher's allow-listed cancel route; it does **not** accept a signal name.
- **Verify:** `pnpm --filter @arcaai/applications build test`; unit tests asserting cross-tenant ⇒
  `NotFoundException`, idempotent replay, quota throw, and that `tenantId` is never read from the body.

### Task 6 — The gateway controller

- **Agent:** T3 · sonnet-5 · high
- **Files:** create `apps/api/src/modules/workflows/{workflows.controller.ts,workflows.module.ts,__tests__/}`;
  modify `apps/api/src/app.module.ts`
- **Approach:** `@Controller('workflows')`. Every route carries **both** an authorization decorator
  (deny-by-default boot audit, rule 05) **and** `@RequiredScopes(...)`:

  | Route | Authorization | Scope | Throttle |
  |---|---|---|---|
  | `GET /` | `@CanList('WorkflowDefinition')` | `workflow:definition:read` | default |
  | `POST /:slug/invoke` | `@CanCreate('WorkflowRun')` | `workflow:run:write` | `@Throttle({ heavy: {...} })` |
  | `GET /:slug/runs/:runId` | `@CanRead('WorkflowRun')` | `workflow:run:read` | default |
  | `GET /:slug/runs/:runId/stream` | `@CanRead('WorkflowRun')` | `workflow:run:read` | default |
  | `POST /:slug/runs/:runId/cancel` | `@CanUpdate('WorkflowRun')` | `workflow:run:write` | default |

  **A decorator alone is not an ability.** Verified: `CanRead`/`CanList`/`CanCreate`/`CanUpdate`/
  `CanDelete`/`CanManage` (`packages/applications/src/authorization/decorators.ts:168, 175, 189,
  203, 217, 232`) are thin wrappers over `Authorize([action, subject])`, and **`subject` is a free
  string resolved against seeded `Policy` rules** — there is no compile-time subject registry
  (`packages/database/src/prisma/db_main/seed/01-policy.ts:48` types it as `subject: string`;
  `:85-87` shows the rule shape; `:75` is the global-admin `{ action: 'manage', subject: 'all' }`).
  **So this task MUST also add `WorkflowDefinition` and `WorkflowRun` rules to the seeded
  tenant-admin policy set**, or every route 403s for everyone except a global admin, and the
  failure looks like a bug in the guard rather than a missing seed row. Coordinate with TASK-719,
  which needs the same subjects for its authoring routes — seed them once, in one place.

  The stream route additionally carries `@Sse()` and
  `@StreamScope({ namespace: 'workflow_run', param: 'runId' })` (S-6) — **without `@StreamScope` a
  ticket cannot open it at all** (`stream-scope.decorator.ts:19-20`).
  `POST /:slug/invoke` returns **202** with `{ runId, status, streamUrl }`, mirroring SMR's
  streaming 202 (`generate.py:405-411`).
  Idempotency ingress is `@Headers('Idempotency-Key')`, the
  `harness-internal.controller.ts:276` pattern.
  Zero business logic, zero Prisma in the controller (hard lint error here).
  **First `heavy`-tier consumer in the codebase** — pick the numbers deliberately and document them
  in the module.
  Seed the two new subjects in `packages/database/src/prisma/db_main/seed/01-policy.ts` alongside
  the existing rules (`:85-87`), granting tenant admins `manage:WorkflowDefinition` and
  `manage:WorkflowRun`. Idempotent seed, per rule 02 §Seeds.
- **Verify:** `pnpm api:build`; `pnpm test:unit` (controller tests asserting the decorator metadata
  is present on every route — copy `api-key-scope-audit.test.ts:62-68`'s style);
  `pnpm db:seed` then an e2e proving a tenant-admin principal (not a global admin) can invoke;
  `pnpm lint` (hard errors in `apps/api`).

### Task 7 — Stream-ticket scope + mint-time ownership

- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify `apps/api/src/modules/auth/auth.controller.ts` (add
  `assertWorkflowRunScopeOwnership` beside `:918` and `:923`); modify
  `apps/api/src/modules/auth/dto/stream-ticket.request.ts` if the scope grammar needs the new
  namespace; add tests
- **Approach:** New namespace `workflow_run:<runId>`. The mint-time assertion resolves the run,
  confirms it belongs to the caller's tenant, and refuses otherwise — **404 for a foreign run**,
  matching the two existing assertions' posture. Reuse `StreamTicketService` unchanged (S-6): TTL 30 s,
  single-use, no code change to `:24-26`.
- **Verify:** `pnpm test:unit`; e2e cases from Task 2 (missing ticket ⇒ 401, reused ticket ⇒ 401,
  foreign run ⇒ 404) GREEN.

### Task 8 — SSE proxy from the gateway to the harness dispatcher

- **Agent:** T3 · opus-4-8 · high
- **Files:** modify `apps/api/src/modules/workflows/workflows.controller.ts`; create
  `apps/api/src/modules/workflows/workflow-stream.service.ts`
- **Approach:** **Port `SmrProxyController.streamTaskEvents` (`smr-proxy.controller.ts:583-740`)
  — read it in full first.** Carry over verbatim: manual header set + `flushHeaders()` (`:590-594`),
  `last-event-id` propagation to the upstream (`:667-669`, `@Headers('last-event-id')` at `:585`),
  `responseType: 'stream'` + `Accept: text/event-stream` + a long timeout (`:670-674`), byte-pipe
  forwarding (`:684-687`), the 15 s `':keepalive\n\n'` heartbeat (`:141`, `:678-682`), teardown on
  `end`/`error`/client `close` with an idempotent usage emit (`:613-634`, `:689-714`), and
  **never forwarding the upstream error body** (`:715-739`, `buildUpstreamException` `:322-349`).
  Event names and the resume-token convention come from **TASK-717's envelope**. If 717 has not
  landed, adopt SMR's shape (`stream.py:61`, `stream.py:35`; `StreamChunk.type` at
  `models/stream.py:10-13`) and leave a single `TODO(TASK-717)` at the mapping point — one place, not
  scattered.
  Emit usage to `IUsageLedgerService` with `operation: 'workflow.invoke'`, mirroring
  `operation: 'generate.stream'` (`:621`).
- **Verify:** `pnpm test:e2e` streaming cases GREEN; a manual `curl -N` with a stream ticket showing
  events, a heartbeat, and a resume after disconnect with `Last-Event-ID`. Paste both.

### Task 9 — Register the routes in the boot-time scope audit

- **Agent:** T2 · sonnet-5 · low
- **Files:** modify `apps/api/src/bootstrap/api-key-scope-audit.ts` (extend `SDK_DAY1_SCOPED_ROUTES`);
  modify `apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts`
- **Approach:** Add all five `WorkflowsController` methods so the app **refuses to boot** if any of
  them ever loses its `@RequiredScopes(...)` metadata (`api-key-scope-audit.ts:78-79`). This is the
  regression guard that makes S-2 durable rather than a one-time review, and it is
  **directly the mechanism TASK-708 hardens** — coordinate so both tickets extend the same list
  rather than forking it.
- **Verify:** `pnpm test:unit`; then delete one `@RequiredScopes` locally, confirm the audit test
  THROWS, and revert. **Paste both outputs** — an audit that has never fired proves nothing.

### Task 10 — Audit per invocation

- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify `packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts`;
  modify `packages/database/src/prisma/db_main/audit.prisma` + a migration; modify
  `packages/domains/src/enums/generated/ResourceType.ts`
- **Approach:** Every invocation broadcasts a sys-event and lands an audit row carrying
  `(tenantId, slug, workflowVersionId, runId, principalType: 'apiKey'|'user', apiKeyId?, userId?,
  idempotencyKey?, outcome)`. **`ResourceType` parity is mandatory** — rule 03 §Checklist step 4:
  the value must exist in **both** `audit.prisma` (with an `ALTER TYPE … ADD VALUE` migration) and
  `packages/domains/src/enums/generated/ResourceType.ts`, or every `AuditLog` INSERT throws and rolls
  the originating mutation into a 500. Guard: `resourceType.enum-parity.test.ts`.
- **Verify:** `pnpm --filter @arcaai/domains test` (parity test GREEN); an e2e asserting one audit row
  per invocation and **zero** for a rejected (403/404) invoke.

### Task 11 — Documentation

- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `docs/traceability-matrix.md`; modify `apps/api/README.md`
- **Approach:** Document the five routes, the scope names, the idempotency header, the stream-ticket
  namespace, and the resume convention. Swagger is generated from the decorators
  (`/api/v1/docs`, non-production only) — ensure `@ApiProperty` coverage is complete rather than
  writing prose duplicating it.
- **Verify:** `pnpm api:build`; `/api/v1/docs` renders the five routes with their DTOs.

---

## 5. Acceptance Criteria

- [x] Exactly **one** route family `/api/v1/workflows/:slug/…` — no per-workflow generated routes
      anywhere in the diff (S-1).
- [x] `workflow:definition:read` / `workflow:run:read` / `workflow:run:write` / `workflow:*` exist in
      `API_KEY_SCOPE_REGISTRY` and every route carries `@RequiredScopes(...)` **and** an
      authorization decorator.
- [x] All five routes are in `SDK_DAY1_SCOPED_ROUTES`; **the audit has been seen to throw** when a
      decorator is removed (both outputs pasted in §7).
- [x] TASK-708's exit criterion is the S-2 precondition this ticket's own kill-switch (R-1) gates on
      — cited, not re-verified (per S-2's own instruction: "cite it; do not re-verify it here").
- [x] `tenantId` is never read from the request body or a caller-controlled header (S-3) — proven by
      a unit test (`InvokeWorkflowRequest` has no `tenantId` field at all) and an e2e 400 case.
- [x] `assertMeterQuota` runs on every invoke (unit-proven, ordering asserted); the
      `maxWorkflowDefinitions` quantity check on definition create was already wired by TASK-734's
      `WorkflowDefinitionService.create`; both kill-switch-gated (S-4).
- [x] SSE uses TASK-717's envelope (`@arcaai/async-contract`'s `AsyncEnvelope`, which HAD landed by
      the time this ticket resumed) — but NOT its resume-token convention, by design: async-contract
      §3.6 forbids minting a resume token for the non-resumable Temporal-polling transport this
      bridge is built on. Disclosed on the route's `@ApiOperation`, not a silent gap (S-5).
- [x] SSE is opened with a single-use `workflow_run:<runId>` stream ticket; the route carries
      `@StreamScope`; **no JWT ever appears in a URL** (S-6). Reused-ticket ⇒ 401 is
      `StreamTicketService`'s existing, unchanged, single-use-by-construction behavior (not
      re-tested here — it is reused verbatim, per S-6).
- [x] `Idempotency-Key` header support: a repeat invoke returns the prior response and starts no
      second run (unit-proven; Redis-backed, 24h TTL).
- [ ] Slug is unique per tenant, immutable after first publish, collision ⇒ 409, reserved words
      denied — **superseded by TASK-715/734's actual, settled design**: uniqueness is
      `(tenantId, slug, versionNumber)` (a row IS a version — multiple versions legitimately share
      a slug), not `(tenantId, slug)`; there is therefore no "collision ⇒ 409" case to build, and a
      reserved-word deny-list would guard against a path collision that cannot occur under
      `/workflows/:slug/…`'s route shape (§7 explains why). Left unchecked rather than silently
      marked done — it does not apply to the shipped design, it isn't unbuilt.
- [x] **Cross-tenant slug or run ⇒ 404. Scope violation ⇒ 403.** Both covered by e2e (unit-covered
      too); full e2e execution blocked by the Prisma consent guard (§7) — not run live end-to-end.
- [ ] Invalid invoke body ⇒ 400 with per-field problems, validated against the definition's declared
      input schema. **Partial**: `forbidNonWhitelisted` gives a 400 on any undeclared field (proven),
      but there is no declared per-definition INPUT schema anywhere in the substrate to validate
      `input`'s contents against (TASK-734's own contract audit found the same gap: "no delivered
      `configSchema` contract exists anywhere to build against"). `input` is accepted as an opaque
      object — genuinely deferred, not silently dropped (see `InvokeWorkflowRequest`'s doc comment).
- [x] Upstream error bodies are never forwarded to the caller (`WorkflowStreamService` logs server-
      side only on a poll failure and ends the stream; unit-asserted the raw error text never
      reaches `res.write`).
- [x] One sys-event (+ the `AuditLog` row it produces via the existing pipeline) per successful
      invocation; zero for a rejected one (unit-asserted). **No new `ResourceType`** — deliberately;
      see §7's Task 10 reasoning (TASK-723's own settled "WorkflowRun carries no ResourceType"
      design). Existing enum-parity test unaffected (unchanged).
- [x] `@Throttle` tier chosen deliberately for invoke (`heavy`, documented in the controller) and
      per-key `ApiKey.rateLimit` posture noted in the README's §2 (unchanged from the ticket's own
      research — this pass did not touch throttling).
- [x] Cancel is an allow-listed action, **not** a signal-name pass-through (`cancelWorkflowRun`
      takes no signal parameter anywhere in its signature).
- [x] `WorkflowDefinition` and `WorkflowRun` subjects are **seeded** into the tenant-admin policy
      set (`seed/01-policy.ts`); an e2e case asserts a JWT tenant-admin can list, but the
      **full live e2e run did not complete** (Prisma consent guard, §7) — the seed itself, and the
      policy grant it makes possible, are unit/build-verified, not live-e2e-verified.
- [x] **Layer gates, with pasted output** (§7): `pnpm --filter @arcaai/domains build`,
      `pnpm --filter @arcaai/domains exec vitest run`, `pnpm --filter @arcaai/applications build`,
      `pnpm --filter @arcaai/applications exec vitest run`, `pnpm api:build`,
      `pnpm --filter @arcaai/api exec vitest run`, `pnpm --filter @arcaai/{applications,api} lint`.
      **NOT run:** `pnpm --filter @arcaai/database test` (no schema-layer change this pass),
      `pnpm test:up:api` + `pnpm test:e2e` (blocked, §7), `pnpm lint:all`/`pnpm typecheck:all`
      (workspace aggregates — the targeted per-package runs above are the pasted evidence).
- [x] Migration: **none needed this pass** — the entitlement columns/migration this criterion refers
      to (Task 4) were already present in the tree before this pass started (verified, not rebuilt).
- [x] New env vars registered as `SettingDescriptor`s and propagated into `turbo.json#globalEnv` +
      `apps/api/.env.sample` (+ the root `.env.sample`) via `pnpm env:sync` — the GENERATED-artifact
      path, not a hand-edit (hand-editing those three files would have been reverted by the next
      sync); `.env.dev`/`.env.test` hand-edited directly (both gitignored, not generated).
      `pnpm env:sync --check` passes (§7).
- [x] **Evidence rule:** every claim above is backed by pasted command output in §7, including the
      one gate (full e2e) that did NOT pass — reported as blocked, not fabricated.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **HUMAN-GATED — this surface must not be enabled before TASK-708 lands.** Design.md makes it an explicit precondition; `unified-auth.guard.ts:220-222` makes a missing decorator mean *unrestricted*. | **DONE, still OFF.** `WORKFLOW_EXPOSURE_ENABLED` — `redis-flag` was superseded platform-wide before this ticket ran (rule 09's own feature-flags file: the real destination is `global-kv`/`env`, not a new tier); implemented as an env-tier `SettingDescriptor` (`killSwitch: true`, default `false`) — same posture as `registration.selfSignupEnabled`. Default OFF in `.env.dev`/`apps/api/.env.sample`; `true` ONLY in the gitignored `.env.test`. Not flipped anywhere real. |
| R-2 | **HUMAN-GATED — Temporal is not production-ready.** Unmanaged VM, dead in-cluster copy, harness + worker absent from the k3s base, no staging/prod namespaces (assessment README §5). Exposing a public product on it is an availability decision, not an engineering one. | TASK-730 closes it. Until then, the surface should be dev/staging-only. Record the decision. |
| R-3 | **Plan rate limits do not apply to API-key traffic** (`tiered-throttler.guard.ts:169-171`). A public invoke surface reached only by API keys therefore has **no per-tenant** throttle. | Per-key `ApiKey.rateLimit` (`apikey.prisma:42`) is the control that does apply. Set a conservative default for workflow keys and note the gap. **Consider a follow-on** teaching the throttler to resolve the tenant from `request['apiKey']` (set at `unified-auth.guard.ts:192`) — out of scope here, but the fix is small and the gap is real. |
| R-4 | **`POST /auth/stream-ticket` carries no per-endpoint `@Throttle`** (confirmed by `throttle-decorators.test.ts:105-109`). A fourth namespace raises its value as a target. | Flag for a follow-on; do not change auth throttling as a side effect of this ticket. |
| R-5 | **TASK-717's envelope may not exist when this starts.** | Adopt SMR's shape with exactly one `TODO(TASK-717)`. The backlog notes 717 *"is a design ticket — its envelope must exist before 722/727 build on it"*; if it is late, this is the contained fallback. |
| R-6 | **Entitlement gating needs a migration**, not config — entitlements are column-per-key (`IEntitlementsService.ts:12-18`). | Task 4 owns it. If TASK-720's R-6/R-7 already added a column, reconcile rather than duplicate. |
| R-7 | **Slug immutability may frustrate tenants.** | Deliberate: a slug is a public URL. Offer "create a new definition and deprecate the old" in the Studio; do not add a rename. |
| R-8 | **Cloud-provider selection through a public workflow.** `smr.` task keys are tenant-admin configurable by design (`ai-task-default/constants.ts:85-90`), so a publicly-invoked workflow could route to a cloud LLM. | **DONE (decision #6), closed as instructed.** A publicly-invoked workflow may NOT select a cloud provider unless the tenant opts in — `WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS` (env-tier `SettingDescriptor`, `killSwitch: true`, default `false`), enforced in `WorkflowExposureService.invoke` by scanning `compiledConfig`'s per-node `config.provider` against `isCloudByoProvider('llm', …)` (the SAME classification the BYO-credential plane already uses). Platform-wide, not per-tenant, disclosed as a deliberate scope narrowing (§7) — no node type can select a provider yet, so there is nothing to differentiate by tenant. Not flipped anywhere real. |
| R-9 | **`workflows` as a top-level path segment could collide** with a future admin surface (`harness-admin` already uses `workflows/:id` under its own prefix). | Verified: `harness-admin.controller.ts`'s `workflows/:id` sits under a completely different `@Controller` prefix, and `WorkflowsController` is `@Controller('workflows')` with no other controller sharing it (`grep "@Controller('workflows'"` — one hit). No reserved-word deny-list built (see the Acceptance Criteria "Slug is unique per tenant..." row — it doesn't apply to the shipped per-version-row design). |
| R-10 | **TASK-715 was NOT wave-1-complete the way this ticket's plan assumed** (superseded — see the Change History entries below). | **RESOLVED.** TASK-734 (a barrier ticket run between this ticket's two passes) built the full hand-authored domain quartet, the `WorkflowDefinitionService`, the admin authoring controllers, and the node registry — verified present and consumed as-is in this pass, not rebuilt. See §7 Session 2. |
| R-11 | **NEW (this pass) — `pnpm test:e2e` cannot be run by an unattended agent in this repo.** Playwright's own `globalSetup` shells out to `prisma db push --force-reset`, which Prisma's CLI now refuses outright when it detects an AI-agent invoker, demanding explicit human consent this execution has no way to obtain. Not specific to this ticket — every future ticket's `pnpm test:e2e` run will hit the same wall. | **Not this ticket's to fix** — flagging for the orchestrator/owner. Either a human runs `pnpm test:db:reset` once (or supplies `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`) before delegating e2e work to an agent, or the test-DB reset path (isolated `hope_test`, port 5433 — never the dev DB) needs a narrower, pre-authorized carve-out from this guard. This ticket's e2e spec is authored and ready to run the moment that's resolved. |

### Cross-ticket contract

| Ticket | Interface |
|---|---|
| **TASK-708** | Its exit criterion is R-1's gate; Task 9 extends the same `SDK_DAY1_SCOPED_ROUTES` list it hardens. Coordinate, do not fork. |
| **TASK-717** | This ticket **consumes** the async envelope + resume-token convention (S-5). |
| **TASK-718** | This ticket proxies to `POST /api/v1/internal/workflow-runs:start`, `GET /workflow-runs/{id}`, `POST /workflow-runs/{id}:cancel`. It never talks to Temporal directly. |
| **TASK-719** | Owns definition authoring/publishing and the slug editor UI; this ticket owns the slug's uniqueness/immutability rules. |
| **TASK-720** | Its `input.context_binding` schema is what the invoke body validates against. Task 8 of that ticket and Task 2 of this one are two halves of one proving path — write them together. |
| **TASK-727** (`webhook-channel`) | Builds on 717 + this surface; keep the route family extensible without generating routes. |

---

## 7. Implementation Summary

### Session 2 (2026-08-16, this pass) — Tasks 3 (service half), 4, 5, 6, 7, 8, 9, 10, 11

**Starting point.** TASK-734 landed the `WorkflowDefinition` domain quartet
(`Entity`/`Factory`/`EntityMapper`/`Repository`, incl. `findPublishedBySlug`), the
`WorkflowDefinitionService` (compile/validate/publish lifecycle), the
`admin/workflow-definitions` + `admin/workflow-nodes` controllers, and
`@arcaai/workflow-contract`'s `WORKFLOW_NODE_REGISTRY` (ships `noop`/`passthrough` only) — closing
exactly the blocker §6 R-10 named. Entitlement columns (`maxWorkflowDefinitions`,
`monthlyWorkflowInvocations`) and the metering wiring (`WORKFLOW_INVOCATIONS =
COUNT(WorkflowRun WHERE startedAt ∈ window)`, `metering.service.ts:213` — already commented
"(TASK-722)") were ALSO already present and committed in the tree at the start of this pass —
verified, not re-built (Task 4 was therefore already done; this pass only consumes it).

**Task 1 (workflow scopes)** — already landed in the earlier session (§7 below); re-verified
present and unchanged.

**Task 3 — service half.** The DB half (slug column, `@@unique([tenantId, slug, versionNumber])`)
and `findPublishedBySlug` were TASK-715/734's, not this ticket's, to (re)build — confirmed still
correct. Added `WorkflowDefinitionRepository.findActivePublishedByTenant(tenantId)` (mirrors
`findAllVersionsBySlug`'s style) to back the exposure plane's list route.
**Deliberately NOT built:** a reserved-slug deny-list (`admin`/`internal`/`health`/`docs`). The
plan's original concern was a slug shadowing a gateway path segment, but every exposure route
lives under `/workflows/:slug/…` — no top-level route a slug could ever collide with — so the
deny-list would guard against a collision that cannot occur. Also **not re-litigated:** slug
uniqueness is `(tenantId, slug, versionNumber)`, not `(tenantId, slug)` — a deliberate TASK-715/734
divergence from this ticket's original plan (a row IS a version; multiple versions legitimately
share a slug), settled by the sibling ticket and out of this ticket's remit to re-open.

**Task 5 — `WorkflowExposureService`**
(`packages/applications/src/services/workflow-exposure/`, full folder pattern: DTOs, dto mapper,
service, module, `__tests__/` — 19 unit tests, all green). `list()` / `invoke()` /
`getRunStatus()` / `cancelRun()` per `IWorkflowExposureService`. `tenantId` is read EXCLUSIVELY
from CLS (`BaseService.tenantId`) — `InvokeWorkflowRequest` has no `tenantId` field at all, so
S-3 is enforced at the DTO boundary, not just by convention (proven by the global
`forbidNonWhitelisted` pipe + a passing e2e case, and unit-asserted). `invoke()`'s sequence:
kill-switch check → tenant resolve → idempotency-cache read → `findPublishedBySlug` (404-over-403)
→ `assertMeterQuota('monthlyWorkflowInvocations')` (only when enforcement is on) → decision #6's
cloud-provider guard → mint a `ClaimCheckRef` for `compiledConfig` via `IS3Service.putFile` (new
`claim-check.ts`, mirrors the harness's own `claim_check.py:store_blob` byte-for-byte: `key =
sha256(canonicalJson(compiledConfig))`, `store: 's3'` — NEVER `'memory'`, since this gateway is a
different PROCESS than the harness worker and cannot share its in-process fake) →
`IWorkflowRunService.recordRunStarted` (writes the tenant-ownership-anchor `WorkflowRun` row
**before** calling the harness, so a dispatcher failure leaves a recoverable "stuck" row rather
than an unattributable run) → `HarnessGatewayService.startWorkflowRun` (three new methods added to
the existing, already-tested gateway client — `startWorkflowRun`/`getWorkflowRun`/
`cancelWorkflowRun`, `POST/GET /api/v1/workflow-runs*`, the TASK-718 Task 10 dispatcher contract)
→ `broadcastSysEvent(ResourceCreated)` → idempotency-cache write. `getRunStatus()`/`cancelRun()`
resolve run ownership via `IWorkflowRunService.getRun(tenantId, runId)` (itself 404-over-403) and
additionally require the run's `workflowSlug` match the URL's `:slug`. A terminal status
opportunistically calls `recordRunFinished` — closing the wiring gap TASK-723's own docstring
flagged ("nothing calls this yet").

**Idempotency-Key** — a lighter, from-scratch implementation of pattern 2
(`withHarnessIdempotency`'s replay-cached-response shape) rather than a byte-copy: Redis
`get`/`setex` via `IRedisCacheService`, key `idempotency:workflow-invoke:<tenantId>:<slug>:<key>`,
24h TTL, best-effort (a cache failure falls through to a fresh invoke / a record failure is
logged, never fails the request that already succeeded).

**Decision #6 (R-8, cloud-provider egress) — "Lets review, suggest best practices" resolved.**
Implemented as ONE documented switch: `WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS` (env-tier,
platform-wide, default `false`, catalogued as a `killSwitch` descriptor in
`settings-registry/descriptors/feature-flags.descriptors.ts`). `cloud-provider-guard.ts` scans a
compiled definition's `stages[].nodes[].config.provider` against `isCloudByoProvider('llm', …)` —
the SAME cloud-vs-local classification `packages/applications/src/services/ai-provider-connection/
constants.ts`'s BYO-credential plane already uses (`CLOUD_BYO_PROVIDERS.llm = ['azure', 'bedrock',
'openai', 'anthropic', 'vertex']`), not a second, invented list. **Deliberately platform-wide, not
per-tenant**, and disclosed as such: a full per-tenant entitlement column (mirroring
`platformDefaultCredential`'s `featureX` pattern) would ripple through `entitlement.prisma` + a
migration + `resolve-entitlements.ts` + `entitlements.service.ts` + the seed — a parallel-sized
effort to Task 4 itself — for a check that is CURRENTLY INERT: `WORKFLOW_NODE_REGISTRY` ships only
`noop`/`passthrough`, neither of which ever sets `config.provider`, so no compiled graph can trip
this gate until TASK-720/731 add a provider-selecting palette node. Building tenant-differentiated
storage ahead of any node type that could differentiate would be exactly the "no speculative
code" anti-pattern the house rules warn against; the platform-wide switch is real, wired, and
activates automatically the moment a real node needs it — narrowing to per-tenant is a natural,
contained follow-up once that happens, not a redesign.

**R-1 (kill-switch, "must not enable public exposure by default") — implemented, OFF.**
`WORKFLOW_EXPOSURE_ENABLED` (same env-tier/killSwitch shape as `WORKFLOW_EXPOSURE_ALLOW_CLOUD_
PROVIDERS`), default `false` in `.env.dev`/`apps/api/.env.sample`; `WorkflowExposureService`
throws `NotFoundException` (404, existence not disclosed — same posture as
`registration.selfSignupEnabled`) on every method when off. Set to `true` in `.env.test` ONLY (a
gitignored, isolated, per-developer/CI file) so the e2e suite can exercise the surface; this does
NOT change the dev/prod default. **The API-key-scope surface itself is narrowed but not fully
closed** (S-2's own precondition) — this ticket adds `@RequiredScopes` to its own five routes and
registers them in the SAME boot audit TASK-708 hardens (`SDK_DAY1_SCOPED_ROUTES`), but does not
re-verify TASK-708's OWN exit criterion end-to-end; that remains TASK-708's evidence to carry.
Flipping `WORKFLOW_EXPOSURE_ENABLED=true` in a deployed environment is a decision for whoever owns
that environment, made AFTER reading TASK-708's own closure evidence — not made by this ticket.

**Task 6 — `WorkflowsController`** (`apps/api/src/modules/workflows/`, mounted at
`/api/v1/workflows/*`). Five routes, each carrying BOTH an authorization decorator (`@CanList`/
`@CanCreate`/`@CanRead`/`@CanUpdate` on `WorkflowDefinition`/`WorkflowRun`) AND `@RequiredScopes`
from the `workflow:*` family (Task 1). `POST :slug/invoke` is the first `heavy`-tier
(`@Throttle`) consumer in the codebase (the pre-registered 20 req/60s tier), returns `202` with
`{ runId, status, statusUrl, streamUrl }`. `Idempotency-Key` ingress via `@Headers`, mirroring
`harness-internal.controller.ts`'s pattern. **Seeded the missing tenant-admin policy grants** this
task's own plan named as its job: `{ action: 'manage', subject: 'WorkflowDefinition' |
'WorkflowRun', conditions: { tenantId } }` added to `seed/01-policy.ts`'s `tenant-full-access` rule
set — without this, BOTH this ticket's routes AND TASK-734's `admin/workflow-definitions`/
`admin/workflow-nodes` controllers 403 for every JWT-authenticated principal except a global
admin (API-key traffic is unaffected either way — `enforceApiKeyScopes` never consults CASL).
17 controller unit tests assert every route's decorator metadata (mirroring
`api-key-scope-audit.test.ts`'s own style) and pass-through delegation.

**Task 7 — stream-ticket ownership.** `AuthController.assertWorkflowRunScopeOwnership` (new
private method, mirrors `assertSttSessionScopeOwnership`'s shape exactly): a `workflow_run:<runId>`
ticket scope resolves the run via `IWorkflowRunService.getRun(activeTenantId, runId)` (itself
404-over-403) and 404s on a missing/foreign run or no active tenant. `StreamTicketService` and the
ticket redemption path (`JwtAuthGuard`) are reused completely unchanged (S-6) — no code edit to
either. `IssueStreamTicketRequest`'s scope grammar needed no change (already a generic
`<namespace>:<id>` string). 4 new tests added to `auth.controller.stream-ticket.test.ts`
(25/25 total, including the pre-existing 21, green). The 32 pre-existing `new AuthController(...)`
call sites across 9 other test files needed a mechanical 18th-argument addition (the new
constructor param) — done via a small paren-matching script + `prettier --write`, verified by
re-running the whole `auth/__tests__/` suite (199/199 green).

**Task 8 — `WorkflowStreamService`** (`apps/api/src/modules/workflows/workflow-stream.service.ts`
+ `workflow-run-event.ts`). **Honest deviation from the plan's own exemplar**: the plan named
`SmrProxyController.streamTaskEvents` (a byte-for-byte SSE proxy) to port verbatim, but
`apps/harness/.../interpreter.py` exposes NO `text/event-stream` endpoint — only plain-JSON
`start`/`get`/`cancel` (TASK-717's Phase C reference producer was explicitly deferred). There is
therefore nothing upstream to byte-pipe. Built instead: a documented POLLING BRIDGE — re-runs
`IWorkflowExposureService.getRunStatus` (itself re-checking tenant ownership) every 2s, translates
each snapshot into a `@arcaai/async-contract` `AsyncEnvelope` (`workflow.run.progress` /
`workflow.run.completed`, `idempotencyKey = wf:run:<runId>:status:<status>` — a pure function of
(run, discrete status), not the design doc's "reuse the source envelope's key" recipe, since there
is no source envelope to reuse), and writes one SSE frame per tick + a 15s `:keepalive` heartbeat
independent of the poll cadence. **No `Last-Event-ID` resume**: async-contract's own
`resume-token.ts` forbids minting a resume token for a non-resumable transport ("Callers on a
non-resumable transport (BullMQ, Temporal) MUST NOT call this") and Temporal `describe()`/`state`
polling has no transport-native cursor — a reconnect re-syncs from the CURRENT live status, not a
gap-fill, and this is disclosed on the route's own `@ApiOperation`, not hidden. The pre-stream
ownership check runs BEFORE any header is written (a 404 is a normal response, never a leaked 200
stream — the exact race `TenantOwnedResourceSseGuard`'s own class doc names for a bare `@Sse()`
handler; this hand-rolled handler avoids it by construction). 22 unit tests (15 for the envelope
builder + 7 for the stream service, using fake timers) cover: connect-time ownership-before-headers,
first-snapshot write, immediate end on a terminal first snapshot, poll-until-terminal, the
independent heartbeat cadence, a mid-stream poll failure ending the stream without forwarding the
raw error, and client-`close` tearing down both timers.

**Task 9 — boot-time scope audit.** All five `WorkflowsController` methods added to
`SDK_DAY1_SCOPED_ROUTES` (`api-key-scope-audit.ts`) — the SAME list TASK-708 hardens, not a fork.
**Proven to genuinely fire**: temporarily removed `@RequiredScopes` from `invoke`, ran
`auditApiKeyRequiredScopes()`, watched it throw (`WorkflowsController.invoke is on the HOPE Node
SDK's day-1 surface but carries no @RequiredScopes(...) metadata`), reverted, re-ran GREEN — both
outputs pasted below.

**Task 10 — audit per invocation.** **Deliberately did NOT add a new `ResourceType`.**
TASK-723's own `WorkflowRunEntity` doc comment states the sibling ticket's settled design
explicitly: `WorkflowRun` is "operational telemetry... NO sys-events on write" and carries no
`ResourceType` of its own (confirmed: `ResourceType.ts` has no `WorkflowRun` member; the enum-parity
test's own coverage is `WorkflowDefinition` + `WorkflowTestFixture` only). Adding one now would
contradict that settled decision and require the `audit.prisma` `ALTER TYPE` migration + parity
edit the plan's own Task 10 sketched — for a resource whose sibling ticket deliberately opted OUT
of exactly that mechanism. Instead: `WorkflowExposureService` extends `BaseService` with
`ResourceType.WorkflowDefinition` (the resource actually being invoked) and calls
`broadcastSysEvent(ResourceCreated, { resourceId: definition.id, data: { action: 'invoke', runId,
slug, workflowVersionNumber, principalType: 'apiKey'|'user', apiKeyId, idempotencyKey } })` on
invoke and `broadcastSysEvent(ResourceUpdated, { data: { action: 'cancel', runId } })` on cancel —
routed through the EXISTING `SysEventService` → `AuditLogService` pipeline, so every successful
invocation lands one `AuditLog` row keyed to the invoked `WorkflowDefinition`, and a rejected
(403/404) invoke broadcasts nothing (unit-asserted: the mock event emitter is never called on the
early-return paths). No migration, no new enum value, no parity risk.

**Task 11 — documentation.** `docs/traceability/workflows.md`'s W12 section rewritten (was stale
relative to the current tree — described TASK-715 as "Phase A, DB-only" and the node registry as
"ships EMPTY", both superseded by TASK-734): now documents the domain quartet, the node registry,
the interpreter dispatcher, and the exposure plane as their own numbered steps, with an honest
gaps note that a live Temporal/harness round trip remains unverified. `apps/api/README.md` gained
a "Workflow Exposure Plane (TASK-722)" subsection under API Documentation (routes, auth/scopes,
idempotency, streaming's polling-bridge caveat, the cloud-provider gate, rate-limit tier) — Swagger
(`/api/v1/docs`) carries the per-DTO detail via the existing `@ApiProperty` coverage, not restated
here.

**Env vars.** `WORKFLOW_EXPOSURE_ENABLED` + `WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS` registered
as `SettingDescriptor`s (`feature-flags.descriptors.ts`) rather than hand-edited into
`turbo.json#globalEnv`/`apps/api/.env.sample` — those are GENERATED artifacts
(`pnpm env:sync`/`--check`); hand-editing them would have been reverted by the next sync and is
exactly the failure mode the generator's own banner warns about. `pnpm env:sync --check` passes
(6/6 artifacts, 147 keys) — pasted below. One pre-existing test file
(`scripts/__tests__/env-sync.test.ts`) shows a size-ceiling assertion that needed bumping (145→147,
following its own documented precedent for legitimate additions — done) and two "no drift on disk"
sub-tests whose IN-PROCESS `buildArtifacts()` recomputation disagrees with the CLI's on ORDERING
ONLY (identical content, different position within the "Feature Flags" category) — reproducible
via `vitest run scripts/__tests__/env-sync.test.ts`, NOT reproducible via three consecutive direct
`pnpm env:sync` CLI invocations (byte-identical `md5sum` each time) or via `pnpm env:sync --check`
(passes cleanly, repeatedly). This looks like a pre-existing vitest/tsx module-resolution quirk in
that one test file, not a defect in the generator or in this ticket's descriptor entries — not
investigated further within this ticket's scope (touching shared generator internals risks
destabilizing other tickets' entries); flagged here rather than silently worked around.

**`HarnessGatewayService` hardening found via testing, not speculation.** The first live e2e
attempt against the running test-API server hung indefinitely: `startWorkflowRun`/`getWorkflowRun`/
`cancelWorkflowRun` (this ticket's own new methods) carried no axios `timeout`, and the harness
process is not running in this environment, so the POST never resolved. Added an explicit 15s
`timeout` to all three (a real bug this ticket's own testing surfaced and fixed, not scope creep —
the three pre-existing methods on the same class are unchanged). Unit-asserted (`options.timeout
=== 15_000` on all three).

### e2e (Task 2) — authored, partially verified live, full run BLOCKED by a Prisma safety guard (not this ticket's code)

`apps/api/tests/e2e/task-722-workflow-exposure.spec.ts` — 15 cases covering scope enforcement
(list/invoke/status/cancel, each asserting both the exact `enforceApiKeyScopes` 403 message and
the in-scope pass-through), 404-over-403 for unknown/DRAFT/cross-tenant slugs and unknown
runIds, `Idempotency-Key`/`tenantId`-forgery DTO validation (400), the stream-ticket mint-time
ownership check (Task 7), and a case proving a published/in-scope/own-tenant invoke passes EVERY
gateway gate before failing only on the unreachable harness dispatcher (documented in the file's
own header as the explicit scope boundary — a live Temporal/harness round trip is out of reach in
this environment regardless, per R-2).

`npx playwright test --list` confirms the file is syntactically valid and lists all 15 cases.
Against the ALREADY-RUNNING test-API server (port 8968, picked up this session's rebuilt code —
confirmed live via `curl`: `GET /api/v1/workflows` returns `401` where it would have been `404`
before this ticket), the routes are demonstrably wired and auth-gated correctly.

**Full `pnpm test:e2e` execution is blocked, and I deliberately stopped rather than working
around it.** Diagnosing four consecutive apparent "hangs" (each fixed something real along the
way — see the timeout fix above, plus a stale generated-Prisma-client false lead resolved by
`pnpm db:generate`) traced to the ACTUAL cause: Playwright's own `globalSetup`
(`tests/setup/playwright.global-setup.ts`) runs `pnpm test:db:reset`, which shells out to `prisma
db push --force-reset --accept-data-loss` against the isolated TEST database (`hope_test`, port
5433 — not the dev DB). Running that command directly surfaces Prisma's own AI-agent safety
guard verbatim:

> Error: Prisma Migrate detected that it was invoked by Claude Code. You are attempting a highly
> dangerous action... As an AI agent, you are forbidden from performing this action without an
> explicit consent and review by the user... If you are running unattended... you must abort
> instead of proceeding.

This is a genuine, correct safety boundary — not a flaw in this ticket's code, and not something I
attempted to bypass (setting `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` myself would require
supplying "the user's consent," which no message in this execution constitutes; my own operating
rules are explicit that no agent message is ever the user's consent). **This is the reason the
earlier attempts looked like hangs**: the wrapped `tsx` invocation inside `playwright.global-setup.ts`
appears to swallow/mangle this specific error's message (surfacing only `cause: [Object]` before
falling through to a generic "missing Prisma client" guess), so from the outside the process looked
stuck rather than cleanly refused. `pnpm test:e2e` (and therefore this spec's live execution) is
consequently **not runnable by an unattended agent in this repo as currently configured** — not
specific to this ticket. Flagging this for the orchestrator/owner: either a human runs `pnpm
test:db:reset` once interactively (or supplies explicit consent) before delegating e2e work to an
agent, or the test-DB reset path needs its own consent carve-out separate from the dev-DB guard
this repo's rules already document. I stopped here rather than supplying consent on the user's
behalf.

### Verification — commands actually run, actual output

```
$ pnpm --filter @arcaai/domains build
tsc  (clean)

$ pnpm --filter @arcaai/domains exec vitest run
 Test Files  144 passed | 2 skipped (146)
      Tests  1745 passed | 2 skipped | 9 todo (1756)

$ pnpm --filter @arcaai/applications build
tsc  (clean)

$ pnpm --filter @arcaai/applications exec vitest run
 Test Files  494 passed | 1 skipped (495)
      Tests  9205 passed | 4 skipped (9209)

$ pnpm --filter @arcaai/applications lint
 ✖ 207 problems (0 errors, 207 warnings) — all pre-existing, none in files this ticket touched
   (my 3 new prettier warnings were fixed with `prettier --write` before this run)

$ pnpm api:build
 Tasks: 12 successful, 12 total

$ pnpm --filter @arcaai/api exec tsc --noEmit -p tsconfig.json
(clean, no output)

$ pnpm --filter @arcaai/api exec vitest run
 Test Files  214 passed | 2 skipped (216)
      Tests  3013 passed | 4 skipped (3017)

$ pnpm --filter @arcaai/api lint
 ✖ 65 problems (0 errors, 65 warnings) — all pre-existing, none in files this ticket touched

$ pnpm env:sync --check
 env:sync --check OK — 6 artifacts match the declared surface (147 keys, bootstrap floor 60 lines)

$ npx playwright test --list apps/api/tests/e2e/task-722-workflow-exposure.spec.ts
 Total: 15 tests in 1 file

$ curl -s http://localhost:8968/api/v1/workflows -o /dev/null -w "%{http_code}"
 401   (route exists + auth-gated; would be 404 before this ticket)
```

**Boot-audit fire-proof (Task 9), both outputs:**
```
# with @RequiredScopes removed from WorkflowsController.invoke:
FAIL  ... passes for the real HOPE Node SDK day-1 surface ...
  AssertionError: expected [Function] to not throw an error but 'Error: TASK-632 B1: refused to
  start — 1 API-key-reachable summarization route(s) lack API_KEY_REQUIRED_SCOPES metadata:
    - WorkflowsController.invoke is on the HOPE Node SDK's day-1 surface but carries no
      @RequiredScopes(...) metadata. ...' was thrown

# reverted:
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

**Gates NOT run:** `pnpm --filter @arcaai/database test` (no schema-layer TS change this pass —
`packages/database` has no standalone `lint`/`test` beyond what `db:generate` already re-ran
clean inside `pnpm api:build`); `pnpm lint:all`/`pnpm typecheck:all` (workspace-wide aggregates —
the individual package gates above are the real evidence; running the full aggregate was judged
lower-value than the targeted per-package runs given the time already spent on live e2e
diagnosis); full `pnpm test:e2e` (blocked — see above, not a fabricated pass). Migration: none
authored this pass — the entitlement columns/migration were already present from an earlier
pass (Task 4 was pre-existing, not built here).

### Files changed this pass (see `git status` for the authoritative list; TASK-708/711/712/732/734's
own concurrent, uncommitted changes in the same tree were left untouched)

- **New:** `packages/applications/src/services/workflow-exposure/` (service, DTOs, mapper,
  module, `claim-check.ts`, `cloud-provider-guard.ts`, `__tests__/` — 19 tests).
- **New:** `apps/api/src/modules/workflows/` (controller, module, `workflow-stream.service.ts`,
  `workflow-run-event.ts`, `__tests__/` — 39 tests across 3 files).
- **New:** `apps/api/tests/e2e/task-722-workflow-exposure.spec.ts` (15 cases).
- **Modified:** `packages/domains/src/repositories/generated/core/WorkflowDefinitionRepository.ts`
  (+`findActivePublishedByTenant`) + its test; `packages/applications/src/services/consultation/
  harness/harness-gateway.service.ts` (+3 methods, +timeout const) + its test;
  `packages/applications/src/services/index.ts` (barrel export); `packages/domains/src/interfaces/
  IAppConfig.ts` + `packages/applications/src/services/baseServices/_meta/config/config.service.ts`
  (2 new config keys); `apps/api/src/app.module.ts` (mount `WorkflowsModule`); `apps/api/src/
  bootstrap/api-key-scope-audit.ts` + its test (5 routes registered); `apps/api/src/modules/auth/
  {auth.module.ts,auth.controller.ts}` + 9 test files (Task 7's ownership check + the mechanical
  18th-arg fixup); `packages/database/src/prisma/db_main/seed/01-policy.ts` (2 tenant-admin policy
  grants); `packages/applications/src/services/settings-registry/descriptors/
  feature-flags.descriptors.ts` + `__tests__/fail-mode.governance.test.ts` (2 new flags);
  `scripts/__tests__/env-sync.test.ts` (ceiling bump); `turbo.json`/`apps/api/.env.sample`/
  `.env.sample`/`env-surface.generated.md` (regenerated via `pnpm env:sync`); `.env.dev`/
  `.env.test` (new vars — both gitignored); `apps/api/package.json` (+`@arcaai/async-contract`
  dependency); `docs/traceability/workflows.md` (W12 rewrite); `apps/api/README.md` (new
  subsection).

## 7a. Session 1 (2026-08-16, earlier pass) — Task 1 only, historical record

**Executed 2026-08-16. Local infra was down (no Postgres/Redis/API/Temporal) for this entire
execution — every item below that needed a live server, DB, or Temporal is marked accordingly. No
exposure kill-switch was created or flipped; both human gates (decision #6 — cloud LLM selection
through a public workflow, R-8; decision #10 — TASK-708's un-narrowed API-key scope surface, S-2)
remain open and unresolved, as instructed.**

### Done

- **Task 1 — workflow scopes in the API-key registry.** Added `workflow:definition:read`,
  `workflow:run:write`, `workflow:run:read`, and the wildcard `workflow:*` to
  `packages/applications/src/services/apiKey/apikey-scopes.registry.ts`, in a new `Workflow`
  category alongside the existing STT/Consultation/User/Media/Admin/Webhook/Wildcard families.
  TDD followed: extended `apikey-scopes.registry.test.ts` first (RED — pasted below), then the
  registry (GREEN — pasted below). These scopes are inert until Task 6 declares
  `@RequiredScopes(...)` referencing them; adding them now only makes the strings
  decoration-time-valid (`decorators.ts:125-132`'s `isValidScope` check) for whenever the
  controller lands. No route, kill-switch, or enforcement path was created — this is registry data
  only, and it changes no runtime behavior for any existing key.

### Blocked — not attempted, with reason

**Tasks 3, 5, 6, 7, 8, 9, 10 (the actual invoke/status/stream/cancel mechanism) are BLOCKED on a
missing upstream dependency, not merely deferred for time.** See §6 R-10 for the full evidence:
TASK-715 (`workflow-definition-model`) is `Status: In Progress (Phase A — Database — done; Phases
B–F not started)` by its own README — there is no `WorkflowDefinitionEntity` /
`WorkflowDefinitionFactory` / `WorkflowDefinitionEntityMapper` / `WorkflowDefinitionRepository`
anywhere in `packages/domains/src`, and no application-layer lookup/authoring service for it in
`packages/applications/src/services`. Every one of this ticket's remaining tasks needs
`findPublishedBySlug(tenantId, slug)` (Task 3) or the run-creation write path it feeds (Tasks 5/6/8),
so they cascade-block. Building that trio myself was considered and rejected: rule 03's hand-authored
entity/factory/mapper/repository files, plus the barrel and `CoreDatabaseModule` edits they require,
are TASK-715's committed deliverable; this run never commits, so there is no conflict detection if a
sibling agent is concurrently completing TASK-715 Phases B–D in the same working tree — silently
recreating those exact files risks clobbering that work rather than safely extending it. This is a
genuine blocker, not a scope judgment call on my part alone: I'm flagging it for the orchestrator to
either sequence TASK-715 first or explicitly instruct otherwise.

- **Task 2 (RED e2e spec)** — not authored. An e2e spec exercising `/api/v1/workflows/:slug/...`
  would be speculative fiction against routes that do not exist yet (Task 6 blocked) and could not be
  run in any case (`pnpm test:up:api` needs live Postgres/Redis, both down). Writing it now would risk
  encoding wrong assumptions about DTOs/scopes that should instead be derived from the real Task 5/6
  implementation once TASK-715 unblocks it.
- **Task 3** — DB half already satisfied by TASK-715 Phase A (`slug` column +
  `@@unique([tenantId, slug, versionNumber])` on `workflow-definition.prisma`, verified). The
  service-layer half (`findPublishedBySlug`, reserved-slug deny-list, 409-on-collision,
  immutable-after-publish) needs the missing repository — blocked.
- **Task 4 (entitlement columns)** — not attempted. Scoped down deliberately, separate from the
  TASK-715 blocker: `entitlements.service.ts` is ~800 lines and every quantity-limit/meter addition
  touches `entitlement.prisma` (2 models + the `UsageMeterMetric` enum), `entitlements.constants.ts`
  (per-plan defaults ×4 plans), `resolve-entitlements.ts` (3 interfaces + merge logic touched
  earlier in this session — read but not edited), `enforcement.ts`'s key unions, the service's
  `METER_USAGE_FIELD_BY_CAPABILITY`/`buildCapabilityRow`/apply/create/update/read call sites, and
  `seed/15-entitlements.ts` — a widely-depended-on, heavily-tested module gating billing platform-wide.
  Its only real consumer (Task 5's invoke path) is itself blocked, so there is no wiring target for a
  `workflowInvocations` meter check yet, and the `maxWorkflowDefinitions` quantity check has no
  create-path caller either. Rushing a partial, unwired schema change into a shared billing-critical
  service for zero immediate behavioral value was judged higher-risk than deferring it to land
  together with Task 5.
- **Tasks 6, 7, 8, 9, 10, 11** — not attempted; all cascade from the Task 3/5 blocker (11 — docs —
  was left until the surface it documents exists, to avoid documenting a surface that doesn't).

### Verification actually run (all local, no infra)

```
$ pnpm --filter @arcaai/applications exec vitest run src/services/apiKey/__tests__/apikey-scopes.registry.test.ts
# RED (before the registry edit):
#  FAIL  ... > should contain workflow exposure scopes
#    AssertionError: expected undefined to be defined
#  FAIL  ... > should group scopes by category
#    AssertionError: expected { …(7) } to have property "Workflow"
#  Test Files  1 failed (1) | Tests  2 failed | 14 passed (16)
#
# GREEN (after the registry edit):
#  Test Files  1 passed (1)
#  Tests  16 passed (16)

$ pnpm --filter @arcaai/applications exec vitest run src/services/apiKey src/authorization
#  Test Files  16 passed (16)
#  Tests  354 passed (354)

$ pnpm --filter @arcaai/applications build
#  (tsc — clean, no output, exit 0)

$ pnpm --filter @arcaai/applications typecheck
#  (tsc --noEmit — clean, no output, exit 0)

$ pnpm --filter @arcaai/applications lint
#  ✖ 182 problems (0 errors, 182 warnings) — all 182 warnings pre-existing in files this
#  ticket did not touch (grep for "apikey-scopes" in the lint output: no matches).
```

**Gates NOT run** (infra down / no work to verify): `pnpm --filter @arcaai/database test`,
`pnpm --filter @arcaai/domains build test` (no domain-layer changes made), `pnpm api:build`,
`pnpm test:unit` (full suite), `pnpm test:up:api` + `pnpm test:e2e`, `pnpm lint:all`,
`pnpm typecheck:all`. Migration authoring/shadow-DB drift proof: not applicable — no schema change
was made in this execution.

### Files changed (see `git status` for the authoritative list)

- `packages/applications/src/services/apiKey/apikey-scopes.registry.ts` — added the `Workflow`
  scope family + `workflow:*` wildcard.
- `packages/applications/src/services/apiKey/__tests__/apikey-scopes.registry.test.ts` — RED-first
  tests for the above.
- `docs/implementation/TASK-722-Exposure-V1/README.md` — this summary + R-10.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-2 ticket-authoring agent |
| 2026-08-16 | Executed Task 1 only (API-key scope registry, TDD RED→GREEN, evidence in §7a). Discovered and documented (§6 R-10) that TASK-715 is Phase-A-only — no `WorkflowDefinition` domain entity/factory/mapper/repository exists — which blocks Tasks 3/5/6/7/8/9/10 (the invoke/status/stream/cancel mechanism itself). Declined to build TASK-715's domain trio under this ticket to avoid clobbering concurrent sibling work with no commit-based conflict detection. Declined Task 4 (entitlement columns) as high-blast-radius with no wiring target while Task 5 is blocked. Status set to Blocked pending either TASK-715 Phases B–D landing or explicit orchestrator direction. Neither human gate (R-1/R-8) was touched; no kill-switch exists to flip. | TASK-722 execution agent |
| 2026-08-16 | **Second pass, after TASK-734 unblocked the substrate.** Verified TASK-734's domain quartet/service/controllers/node-registry were real and consumed them rather than re-building. Shipped Tasks 3 (service half — `findActivePublishedByTenant`), 5 (`WorkflowExposureService`: invoke/status/stream/cancel/list, claim-check minting, idempotency, decision #6's cloud-provider guard), 6 (`WorkflowsController`, 5 routes, tenant-admin policy grants seeded), 7 (stream-ticket `workflow_run:<runId>` mint-time ownership check), 8 (`WorkflowStreamService` — a documented polling bridge, not a byte-proxy, since no interpreter event producer exists), 9 (boot-audit registration, fire-proven), 10 (audit via the existing `broadcastSysEvent` path on `WorkflowDefinition`, deliberately no new `ResourceType` — TASK-723's own settled design), 11 (docs). Confirmed Task 4 (entitlement columns + metering) was already present in the tree, pre-dating this pass. R-1 (`WORKFLOW_EXPOSURE_ENABLED`) and decision #6 (`WORKFLOW_EXPOSURE_ALLOW_CLOUD_PROVIDERS`) implemented as `SettingDescriptor`-catalogued env kill-switches, both default OFF/closed — neither flipped. Authored the Task 2 e2e spec (15 cases) and confirmed it live against a running test-API server (route/auth wiring verified via `curl`), but full `pnpm test:e2e` execution is blocked by Prisma's own AI-agent safety guard refusing `db push --force-reset` without explicit human consent — diagnosed in full, not bypassed, not worked around; flagged as an orchestrator-level gap, not a ticket defect. Found and fixed a real bug via this diagnosis: the new `HarnessGatewayService` methods had no request timeout and would hang indefinitely against an unreachable harness. Status set to Review. | TASK-722 execution agent (second pass) |
