# TASK-722 — Exposure Plane v1 (REST invoke + status + SSE)

| | |
|---|---|
| **Status** | Blocked (Task 1 of 11 shipped; Tasks 3/5/6/7/8/9/10 blocked on TASK-715 Phase B–F, evidence in §6/§7) |
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

- [ ] Exactly **one** route family `/api/v1/workflows/:slug/…` — no per-workflow generated routes
      anywhere in the diff (S-1).
- [ ] `workflow:definition:read` / `workflow:run:read` / `workflow:run:write` / `workflow:*` exist in
      `API_KEY_SCOPE_REGISTRY` and every route carries `@RequiredScopes(...)` **and** an
      authorization decorator.
- [ ] All five routes are in `SDK_DAY1_SCOPED_ROUTES`; **the audit has been seen to throw** when a
      decorator is removed (paste both outputs).
- [ ] TASK-708's exit criterion is cited in the Implementation Summary as satisfied before this
      surface is enabled (S-2).
- [ ] `tenantId` is never read from the request body or a caller-controlled header (S-3) — proven by
      a unit test.
- [ ] `assertMeterQuota` runs on every invoke and `assertQuantityQuota('maxWorkflowDefinitions', …)`
      on definition create; both kill-switch-gated (S-4).
- [ ] SSE uses TASK-717's envelope and its resume-token convention — or, if 717 has not landed, SMR's
      shape with exactly **one** `TODO(TASK-717)` at the mapping point (S-5).
- [ ] SSE is opened with a single-use `workflow_run:<runId>` stream ticket; the route carries
      `@StreamScope`; **no JWT ever appears in a URL** (S-6). Reused ticket ⇒ 401.
- [ ] `Idempotency-Key` header support: a repeat invoke returns the prior response and starts no
      second run.
- [ ] Slug is unique per tenant (`@@unique([tenantId, slug], map: "…")` — `map:`, not `name:`),
      immutable after first publish, collision ⇒ 409, reserved words denied.
- [ ] **Cross-tenant slug or run ⇒ 404. Scope violation ⇒ 403.** Both covered by e2e.
- [ ] Invalid invoke body ⇒ 400 with per-field problems, validated against the definition's declared
      input schema.
- [ ] Upstream error bodies are never forwarded to the caller.
- [ ] One audit row + one sys-event per successful invocation; zero for a rejected one;
      `ResourceType` parity green in **both** enums.
- [ ] `@Throttle` tier chosen deliberately for invoke and documented; per-key `ApiKey.rateLimit`
      posture noted (plan tiers do not reach API-key traffic).
- [ ] Cancel is an allow-listed action, **not** a signal-name pass-through.
- [ ] `WorkflowDefinition` and `WorkflowRun` subjects are **seeded** into the tenant-admin policy
      set; an e2e proves a tenant-admin principal (not only a global admin) can invoke.
- [ ] **Layer gates, with pasted output:** `pnpm --filter @arcaai/database test`,
      `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/applications build test`,
      `pnpm api:build`, `pnpm test:unit`, `pnpm test:up:api` + `pnpm test:e2e`, `pnpm lint`
      (hard errors in `apps/api`), `pnpm lint:all`, `pnpm typecheck:all`.
- [ ] Migration folder named `<timestamp>_task_722_<desc>`, authored against a shadow DB, drift check
      printing `-- This is an empty migration.`
- [ ] New env vars in `turbo.json#globalEnv` + `.env.dev` + `apps/api/.env.sample`.
- [ ] **Evidence rule:** paste actual command output for every gate before claiming done.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **HUMAN-GATED — this surface must not be enabled before TASK-708 lands.** Design.md makes it an explicit precondition; `unified-auth.guard.ts:220-222` makes a missing decorator mean *unrestricted*. | Ship behind a kill-switch (`redis-flag` tier, **defaults OFF** — rule 09 §Configuration Tiers) and require an explicit flip after 708's evidence is recorded. |
| R-2 | **HUMAN-GATED — Temporal is not production-ready.** Unmanaged VM, dead in-cluster copy, harness + worker absent from the k3s base, no staging/prod namespaces (assessment README §5). Exposing a public product on it is an availability decision, not an engineering one. | TASK-730 closes it. Until then, the surface should be dev/staging-only. Record the decision. |
| R-3 | **Plan rate limits do not apply to API-key traffic** (`tiered-throttler.guard.ts:169-171`). A public invoke surface reached only by API keys therefore has **no per-tenant** throttle. | Per-key `ApiKey.rateLimit` (`apikey.prisma:42`) is the control that does apply. Set a conservative default for workflow keys and note the gap. **Consider a follow-on** teaching the throttler to resolve the tenant from `request['apiKey']` (set at `unified-auth.guard.ts:192`) — out of scope here, but the fix is small and the gap is real. |
| R-4 | **`POST /auth/stream-ticket` carries no per-endpoint `@Throttle`** (confirmed by `throttle-decorators.test.ts:105-109`). A fourth namespace raises its value as a target. | Flag for a follow-on; do not change auth throttling as a side effect of this ticket. |
| R-5 | **TASK-717's envelope may not exist when this starts.** | Adopt SMR's shape with exactly one `TODO(TASK-717)`. The backlog notes 717 *"is a design ticket — its envelope must exist before 722/727 build on it"*; if it is late, this is the contained fallback. |
| R-6 | **Entitlement gating needs a migration**, not config — entitlements are column-per-key (`IEntitlementsService.ts:12-18`). | Task 4 owns it. If TASK-720's R-6/R-7 already added a column, reconcile rather than duplicate. |
| R-7 | **Slug immutability may frustrate tenants.** | Deliberate: a slug is a public URL. Offer "create a new definition and deprecate the old" in the Studio; do not add a rename. |
| R-8 | **Cloud-provider selection through a public workflow.** `smr.` task keys are tenant-admin configurable by design (`ai-task-default/constants.ts:85-90`), so a publicly-invoked workflow could route to a cloud LLM. | **HUMAN-GATED** — mirrors TASK-720 R-4. Decide whether the exposure plane pins to local providers or inherits the tenant's selection. Record the decision before enabling R-1's flag. |
| R-9 | **`workflows` as a top-level path segment could collide** with a future admin surface (`harness-admin` already uses `workflows/:id` under its own prefix). | Distinct prefixes today; the reserved-word deny-list (Task 3) prevents a slug shadowing a path segment. Verify no route conflict at boot. |
| R-10 | **NEW (2026-08-16 execution) — TASK-715 is NOT wave-1-complete the way this ticket's plan assumed.** TASK-715's own README states its status verbatim: *"In Progress (Phase A — Database — done; Phases B–F not started)"*. Verified against the tree: `packages/database/src/prisma/db_main/workflow-definition.prisma` exists (with `slug`, the `@@unique([tenantId, slug, versionNumber])`, and `isActive`) and `packages/domains/src/models/generated/core/WorkflowDefinitionModel.ts` exists (the ONE generated layer), but there is **no** `WorkflowDefinitionEntity`, `WorkflowDefinitionFactory`, `WorkflowDefinitionEntityMapper`, or `WorkflowDefinitionRepository` anywhere in `packages/domains/src` (`grep -rl "WorkflowDefinitionRepository\|WorkflowDefinitionEntity\|WorkflowDefinitionFactory\|WorkflowDefinitionEntityMapper" packages` — zero hits), and no application service for authoring/looking up definitions exists in `packages/applications/src/services` either. Sibling tickets TASK-723 (`workflow-run`) and TASK-721 (`workflow-test-fixture`) both worked around the gap by storing DENORMALIZED `workflowSlug`/`definitionName`/etc. directly on their own tables rather than joining to a `WorkflowDefinition` repository — `packages/applications/src/services/workflow-run/dto/record-run.input.ts` even says so in its own docstring: *"The write contract TASK-718's dispatcher (or **a future gateway controller**) calls... nothing calls this yet."* This ticket IS that future gateway controller, and it needs `findPublishedBySlug(tenantId, slug) → { id, slug, versionNumber, name, compiledConfig, … }` to resolve an invoke — which requires the missing repository. | **Did not build TASK-715's entity/factory/mapper/repository trio under this ticket.** Rule 03's hand-authored trio (`XxxEntity.ts`/`XxxFactory.ts`/`XxxEntityMapper.ts`/`XxxRepository.ts`) plus the barrel/`CoreDatabaseModule` registrations it requires are TASK-715's committed deliverable, not this ticket's — and per the run rules, "sibling agents share this tree" with **no commit-based conflict detection** (this execution never commits), so creating those exact files while TASK-715 shows `Status: In Progress` risks silently clobbering concurrent work rather than safely extending it. **Recommendation: land TASK-715 Phases B–D (entity/factory/mapper/repository + `findPublishedBySlug`) first, then resume TASK-722 Tasks 3/5/6/7/8/9/10.** Task 3's *DB-layer* half (slug column + its unique constraint) is already satisfied by TASK-715 Phase A — nothing further needed there. |

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
| 2026-08-16 | Executed Task 1 only (API-key scope registry, TDD RED→GREEN, evidence in §7). Discovered and documented (§6 R-10) that TASK-715 is Phase-A-only — no `WorkflowDefinition` domain entity/factory/mapper/repository exists — which blocks Tasks 3/5/6/7/8/9/10 (the invoke/status/stream/cancel mechanism itself). Declined to build TASK-715's domain trio under this ticket to avoid clobbering concurrent sibling work with no commit-based conflict detection. Declined Task 4 (entitlement columns) as high-blast-radius with no wiring target while Task 5 is blocked. Status set to Blocked pending either TASK-715 Phases B–D landing or explicit orchestrator direction. Neither human gate (R-1/R-8) was touched; no kill-switch exists to flip. | TASK-722 execution agent |
