# TASK-759 — API Plane Taxonomy Corrections (P1/P2/P3)

| | |
|---|---|
| **Status** | Completed (e2e run outstanding — see Verification) |
| **Owner** | Platform / Architecture |
| **Date** | 2026-08-18 |
| **Type** | refactor (route taxonomy) + docs |
| **Related** | [api-design-conformance-review.md](../../architecture/api-design-conformance-review.md) §2.5, §3.2 · [api-controller-inventory.md](../../architecture/api-controller-inventory.md) · [api-controller-groupings.md](../../architecture/api-controller-groupings.md) · [conformance/gateway-and-sdk.md](../../programs/agentic-workflow-platform/conformance/gateway-and-sdk.md) §6.3 · **TASK-757** (A2 — admin plane JWT-only; the destination posture for every route this ticket moves) · **TASK-758** (A1 — business plane; defers `MonitoringController` and `ApiHealthController` `/services` to this ticket) · TASK-708 §6 (the `/admin/*` vs `/internal/*` non-mixing ruling) · TASK-742 (API-key fail-closed + boot audits) · BUG-013 (STT worker credential) |

---

## Requirement Analysis

### The rules

From `api-design-conformance-review.md` §0:

| # | Rule |
|---|---|
| P1 | Standalone features and core business capabilities MUST NOT carry `admin` in the prefix |
| P2 | Administrative features MUST carry `admin` in the prefix |
| P3 | Internal service-to-service endpoints MUST carry `internal` in the prefix |

The prefix is not cosmetic: **it is the load-bearing input to the credential-class decision.** A1 (JWT + API key) and A2 (JWT only) are both keyed off the prefix, so a route filed on the wrong plane gets the wrong credential class by construction. TASK-757 and TASK-758 both assume this ticket has run — otherwise A2's sweep misses two administrative surfaces and A1's sweep tries to open them.

### The four items

Named by the conformance review §2.5, each verified against source before this ticket was written:

| Controller | Now | Issue | Action |
|---|---|---|---|
| `MonitoringController` | `api/v1/monitoring` | requires `manage:all \| read:TenantTelemetry` — an administrative capability on a business prefix; the inventory itself notes *"Not under /admin"* | move to `api/v1/admin/monitoring`, then JWT-only |
| `ApiHealthController` `/services`, `/services/:serviceKey` | `api/v1/health` | ops telemetry behind CASL sitting on a public health prefix | split: keep `/`, `/live`, `/ready`, `/startup` public; move the two `/services` routes to `api/v1/admin/health/services` |
| `SttInternalController` | `api/v1/internal/stt` | prefix correct, but it is the ONLY internal surface on the API-key path (`internal:stt:worker` via `X-Internal-Service-Key`) while the other four internal controllers use `@Public()` + `X-Service-Token` | **decision required:** converge onto the service-token guard, or record the BUG-013 carve-out explicitly in the inventory so it stops reading as drift |
| `WorkflowSandboxRunController` | `api/v1/admin/…` | its own doc comment says *"Session-JWT admin console ONLY"* yet it carries `@RequiredScopes('admin:workflow-definition:manage')` — unenforced drift flagged in `conformance/gateway-and-sdk.md` §6.3 | resolved automatically by TASK-757; note the cross-reference |

### Two things this ticket must state explicitly

1. **Moving a route changes its API-key posture.** A route moving *into* `admin/` loses key access under TASK-757's A2 sweep. That is the intended outcome for both moves here — but it is a reachability change, not a rename, and the consumer impact belongs in the ticket rather than being discovered at cutover. See Current State §5.
2. **The "keep a redirect for one release" convention does not transfer as-is.** It is a Next.js App Router convention (`13-nextjs-apps.md` §Routing: *"Retired or renamed routes keep a `redirect()` page for one release, with a comment naming the release in which it is deleted"*), and `api-design-conformance-review.md` §3.5 restates it for the API plane. Verified: **there is no redirect or deprecation precedent anywhere in `apps/api`** — no `@Redirect`, no 301/308 handler, no `@ApiOperation({ deprecated: true })`. Whether to invent one is a decision this ticket must take rather than assume. See Current State §4.

---

## Current State Evaluation

Every claim below was verified by opening the file on 2026-08-18.

### 1. `MonitoringController` — administrative capability, business prefix

`apps/api/src/modules/monitoring/monitoring.controller.ts`

```
:17   @CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
:18   @Throttle({ default: { limit: 300, ttl: 60000 } })
:19   @Controller('monitoring')
:20   // TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
:21   // Reason: admin-shaped telemetry export; outside TASK-708 s /admin/*-only approval and has no scope of its own.
:28   @ForbidApiKey()
:29   export class MonitoringController {
```

Four handlers, all `@Get`, all inheriting the class CASL gate:

| Route | Method | Line |
|---|---|---|
| `GET /api/v1/monitoring/uptime` | `getUptime` | `:37` |
| `GET /api/v1/monitoring/uptime/:service` | `getServiceUptime` | `:48` |
| `GET /api/v1/monitoring/heartbeats/:service` | `getHeartbeats` | `:68` |
| `GET /api/v1/monitoring/sessions` | `getSessions` | `:81` |

Registered in `src/modules/monitoring/monitoring.module.ts:3,7`. The inventory row (`api-controller-inventory.md:132`) and catalog entry (`:1212-1220`) both carry the note **"Not under /admin"** — the drift was already recorded, never actioned. The class comment at `:21` calls it *"admin-shaped telemetry export"* in its own words.

**Claim verified.** Nothing here is a business capability: the payload is platform-infra status, and the class comment at `:13-16` says so explicitly (*"platform-infra status (no PHI, no per-tenant rows)"*).

### 2. `ApiHealthController` — a genuinely mixed controller that should be two

`apps/api/src/modules/health/health.controller.ts`, `@Controller('health')` at `:53`, class `@ForbidApiKey()` at `:62`, class `@Throttle({ limit: 30, ttl: 60000 })` at `:52`.

| Route | Gate | Line | Plane |
|---|---|---|---|
| `GET /api/v1/health/live` | `@Public()` | `:129-130` | public probe |
| `GET /api/v1/health/ready` | `@Public()` | `:138-139` | public probe |
| `GET /api/v1/health/startup` | `@Public()` | `:153-154` | public probe |
| `GET /api/v1/health` | `@Public()` | `:168-169` | public probe |
| `GET /api/v1/health/services` | `@CanAny(['manage','all'],['read','TenantTelemetry'])` | `:196,204` | **ops telemetry** |
| `GET /api/v1/health/services/:serviceKey` | `@CanAny(['manage','all'],['read','TenantTelemetry'])` | `:241,244` | **ops telemetry** |

**Claim verified**, with one correction: the path parameter is **`:serviceKey`**, not `:key`. The review §2.5 and the inventory summary row (`:112`) both write `/services/:key`; the inventory's own per-controller catalog (`:937`) has it right.

The route's own comment (`:197-202`) already argues the admin case — *"matching the other ops/admin surfaces; this downstream ops health is not for plain doctors"* — and its `@ApiOperation` summary at `:205` literally reads `"…for all downstream microservices (admin only)"`. The prefix is the only thing that disagrees.

Registered in `src/modules/health/health.module.ts:4,8`.

Note the class `@Throttle` at `:52`: it was tuned for **unauthenticated probe reconnaissance** (`:49-51`, *"Kubernetes probe schedules sit well below 30/min"*). The two `/services` routes ride it incidentally. Moving them off this class means deciding their own limit — 30/min is tight for an admin dashboard that polls (`apps/admin-console/src/features/monitoring/api/hooks.ts:8` comments *"/health/services is gateway-throttled at 30/min"*).

### 3. `SttInternalController` — the "decision required" is already decided, in code

`apps/api/src/modules/internal/stt-internal.controller.ts`

```
:41   @Authorize()
:51   @RequiredScopes('internal:stt:worker')
:52   @Controller('internal/stt')
:53   export class SttInternalController {
```

The other four `/internal/*` controllers all use the `@Public()` + service-token-guard shape — verified:

| Controller | File:line |
|---|---|
| `EffectiveConfigController` | `src/modules/internal/effective-config.controller.ts:27-29` — `@Public()` + `@UseGuards(InternalServiceTokenGuard)` |
| `HarnessInternalController` | `src/modules/consultation/harness-internal.controller.ts:205-207` — `@Public()` + `@UseGuards(HarnessServiceTokenGuard)` |
| `ConsentInternalController` | `src/modules/consultation/consent-internal.controller.ts:89-91` — `@Public()` + `@UseGuards(HarnessServiceTokenGuard)` |
| `ServiceReleaseInternalController` | `src/modules/service-release/service-release-internal.controller.ts:17-20` — `@Public()` + `@UseGuards(ServiceReleaseTokenGuard)` |

**Claim verified — and the "decision required" framing is already out of date.** The carve-out exists, is reasoned, and is **policed at boot**:

```
// apps/api/src/bootstrap/api-key-scope-audit.ts:152-169
/**
 * Controllers under `/internal/*` that are deliberately gated by a RESERVED
 * `internal:` API-key scope instead of a service-token guard.
 *
 * There is exactly one, and it is not a style choice: the STT worker
 * authenticates with `X-Internal-Service-Key` carrying `api_gateway_key`, which
 * BUG-013 requires to be the RAW value of a registered ACTIVE SERVICE_ACCOUNT
 * `ApiKey` row … It presents an API KEY, not a service token, so pulling this
 * controller off the API-key surface would break the worker unless `apps/stt`
 * changed in lockstep.
 * …
 * The exemption is POLICED, not a hole: an exempted controller must still carry
 * `@RequiredScopes` with a scope under the reserved `internal:` root …
 */
const RESERVED_INTERNAL_SCOPE_CONTROLLERS: ReadonlySet<string> = new Set(['SttInternalController']);
```

Corroborating evidence on both sides of the decision:

- **The constraint is real.** `apps/stt` presents the raw key on the API-key header: `src/stt/core/api_client/gateway.py:39` (`"X-Internal-Service-Key": self.api_key`) and `src/stt/core/effective_config.py:171,227`. `ApiKeyService.extractApiKeyFromRequest` accepts `x-internal-service-key` as an ordinary API-key header, so this credential authenticates as a key, not a token.
- **Convergence is not blocked at the transport layer.** `InternalServiceTokenGuard.readToken` (`src/modules/internal/internal-service-token.guard.ts:90-96`) *already* accepts `x-internal-service-key` for `service === 'stt'` (`ALT_HEADER_SERVICE = 'stt'`, `:44`), falling back to `x-service-token`. So the header shape is not the blocker; the blocker is BUG-013's requirement that the value be a live `ApiKey` row plus the tenant-pin path below.
- **A second gate depends on the API-key identity.** `assertPlatformInternalCredential` (`stt-internal.controller.ts:137-150`, `AUTH-NOTE` at `:117-136`) constant-time-compares `X-Internal-Service-Key` against `API_GATEWAY_KEY` before honouring a caller-supplied `X-Internal-Tenant-Id`. Its doc explicitly frames this as a 403 privilege boundary, not the 404-over-403 cross-tenant posture.
- **It is a settled owner decision, not an accident.** `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts:30-49` records it as *"the SETTLED design (confirmed against the live tree at close-out; do not re-derive from an aspirational README draft)"*, citing TASK-708 §6's *"we cannot mix the `/admin/*` and `/internal/*` routes"* ruling.

**Therefore the recommended resolution is the documentary one**, not convergence: record the carve-out in `api-controller-inventory.md` so it stops reading as drift. Convergence would require a lockstep change in `apps/stt` (`gateway.py`, `effective_config.py`) plus a rethink of the tenant-pin gate, for zero security gain over a reserved scope no tenant key is ever issued.

One inaccuracy to fix while doing so: the audit comment at `api-key-scope-audit.ts:159` cites `apps/stt/src/stt/worker.py:209` as the sending call site. That line now reads `service_token=settings.api_gateway_key.get_secret_value()` inside **service-release registration**, not the STT internal callback path. The live send sites are `core/api_client/gateway.py:39` and `core/effective_config.py:171,227`.

### 4. `WorkflowSandboxRunController` — verified, and genuinely a no-op for this ticket

`apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts`

```
:20   * Session-JWT admin console ONLY — unlike `WorkflowsController` (TASK-722's exposure plane, …
:23   * runs ANY (DRAFT or published) version … Gated with the SAME `admin:workflow-definition:manage` scope
:26   * surface with no API-key consumer.
:33   @RequiredScopes('admin:workflow-definition:manage')
:34   @Controller('admin/workflow-definitions/:definitionId/sandbox-runs')
```

**Claim verified.** The doc comment asserts a restriction (`:20`) that the decorator at `:33` does not enforce, and the comment at `:24-26` even acknowledges reusing the scope *"for a surface with no API-key consumer"* — an argument for `@ForbidApiKey()`, made while declaring `@RequiredScopes`. `conformance/gateway-and-sdk.md:219-227` (§6.3) names this as *"A second, ungated runtime invoker"*.

**Prefix is already correct** (`admin/…`), so P1/P2 have nothing to do here. TASK-757's class-level `@ForbidApiKey()` sweep across all 65 admin controllers converts `:33` into an inert declaration and makes the doc comment true. This ticket's only action is the cross-reference.

One qualification on §6.3's severity, which was written pre-TASK-742: it argues the drift is dangerous because *"the API-key path never evaluates CASL"*. That is no longer true — `enforceApiKeyAbilities` (`packages/applications/src/authorization/unified-auth.guard.ts:450`) evaluates the route's `@CanCreate('WorkflowRun')` / `@CanRead` / `@CanUpdate` metadata (`:43`, `:54`, `:66`, `:77`) against the key's bound user. The drift is real; the blast radius is smaller than §6.3 states.

### 5. Consumer impact — who calls the routes being moved

The only first-party consumer is `apps/admin-console`, through the BFF proxy:

| File:line | Call |
|---|---|
| `apps/admin-console/src/features/monitoring/api/client.ts:16` | `getJson('health/services')` |
| `…/client.ts:20` | `getJson('health/services/${service}')` |
| `…/client.ts:24` | `getJson('monitoring/uptime')` |
| `…/client.ts:28` | `getJson('monitoring/uptime/${service}')` |
| `…/client.ts:32` | `getJson('monitoring/heartbeats/${service}')` |
| `…/client.ts:36` | `getJson('monitoring/sessions')` |
| `apps/admin-console/src/features/platform/components/platform-dashboard.tsx:237` | UI label `GET /health/services · 30s` |
| `apps/admin-console/src/features/releases/api/client.ts:5-10` | doc comment citing `/health/services` as the reference gate for `admin/service-releases` |

**Auth posture is unaffected for this consumer.** The BFF sends `Authorization: Bearer` only (review §2.2, `hope-proxy.ts:20-35`), so moving into `admin/` costs it nothing. Only the URL strings change.

**API-key posture does change, for everyone else.** Both surfaces are `@ForbidApiKey()` *today* (TASK-742 conservative default), so no key reaches them now and no key will reach them after — but the *reason* changes from "undeclared, so closed" to "admin plane, so closed by A2". That is the outcome to record: **there is no consumer to break**, because there is no key-based consumer to begin with. Verified: no `apps/stt|text|nlp|guardrail|harness|tts` client, no script, no `@arcaai/vox-node` resource calls `/monitoring/*` or `/health/services`.

E2E specs that hard-code the paths and must move in lockstep:

| Spec | Lines |
|---|---|
| `apps/api/tests/e2e/monitoring.spec.ts` | `:52, :58, :67, :73, :80` |
| `apps/api/tests/e2e/platform-dashboard-monitoring.spec.ts` | `:65` (`SUPER_ADMIN_ONLY_PATHS`), `:101, :114, :126` |
| `apps/api/tests/e2e/platform-runtime-metrics.spec.ts` | `:217` |
| `apps/api/tests/e2e/tenant-dashboard-sources.spec.ts` | `:145, :155, :163, :170, :184, :192` |

Admin-console unit tests hard-coding the same URLs: `features/monitoring/api/__tests__/monitoring-api.test.ts:43-48`, `features/monitoring/components/__tests__/monitoring-screen.test.tsx:84-86,165,168`, `features/platform/components/__tests__/platform-dashboard.test.tsx:91`.

Note `tenant-dashboard-sources.spec.ts:155,184` exercises the **TENANT_ADMIN** path (`read:TenantTelemetry`), which is the reason the gate is `@CanAny` and not `manage:all`. Moving under `admin/` must not silently narrow that to SUPER_ADMIN — the CASL decorator moves with the routes unchanged.

### 6. On redirects — there is no API-side precedent to follow

`13-nextjs-apps.md` §Routing's one-release `redirect()` rule is a **Next.js page** convention (`/prompt-studio` → `/agents?tab=governance`, `/pstudio` → `/db-studio` are its cited precedents — both admin-console routes). `api-design-conformance-review.md` §3.5 restates it for the business plane as *"Retired paths keep a redirect for one release, per the existing convention."*

Verified in `apps/api/src/modules/**/*.controller.ts`: **zero** `@Redirect` decorators, zero 301/308 responses, zero `@ApiOperation({ deprecated: true })`. The convention has never been exercised on the gateway.

Two honest options, to be decided before Step 3:

| Option | Shape | Trade-off |
|---|---|---|
| **A — hard move (recommended)** | Change the prefix; update `apps/admin-console` and the e2e specs in the same commit. | Consistent with the pre-production posture (no prod data; ship complete rather than dual-pathed). Zero external consumers exist for either surface. |
| **B — one-release alias** | Keep the old `@Controller('monitoring')` class as a thin deprecated forwarder with `@ApiOperation({ deprecated: true })` and a comment naming the release in which it is deleted. | Honours §3.5 literally. Costs: a second controller that must carry its own `@ForbidApiKey()`/`@RequiredScopes` declaration to pass `api-key-surface-audit`, plus a second CASL gate to keep in sync. Invents a gateway convention for a surface with one first-party caller. |

Recommendation is **A**, with the reasoning recorded here so §3.5 is not silently ignored. If the owner picks B, the alias must be added to whichever boot audit TASK-757 extends, or it becomes an admin-shaped route on a business prefix — the exact defect this ticket exists to remove.

### 7. Discrepancies found while verifying

| # | Discrepancy | Where |
|---|---|---|
| D-1 | Path param is `:serviceKey`, not `:key`. | `api-design-conformance-review.md` §2.5 and `api-controller-inventory.md:112` vs `health.controller.ts:241` |
| D-2 | The `SttInternalController` "decision required" is already decided, reasoned and boot-policed as `RESERVED_INTERNAL_SCOPE_CONTROLLERS`. The open item is documentary (the inventory does not surface the audit's rationale), not a design question. | `api-key-scope-audit.ts:152-169` vs review §2.5, §3.2 |
| D-3 | The audit's own citation `apps/stt/src/stt/worker.py:209` no longer points at the STT internal callback; the live send sites are `core/api_client/gateway.py:39` and `core/effective_config.py:171,227`. | `api-key-scope-audit.ts:159` |
| D-4 | `conformance/gateway-and-sdk.md` §6.3's premise — *"the API-key path never evaluates CASL"* — was true pre-TASK-742 and is now false (`unified-auth.guard.ts:450`). The finding stands; the stated blast radius does not. | `gateway-and-sdk.md:219-227` |
| D-5 | The inventory's per-controller catalog marks the two `/services` routes *"no ForbidApiKey"* while the class carries it (`health.controller.ts:62`). Both statements are about different scopes (method vs class) but read as a contradiction of the same file's summary row `:112`. | `api-controller-inventory.md:936-937` |
| D-6 | No redirect/deprecation precedent exists in `apps/api`, so §3.5's "per the existing convention" has no gateway referent. | `api-design-conformance-review.md` §3.5 |

---

## Implementation Plan

Ordered. The two moves are independent of each other; both depend on TASK-757 for their final auth posture.

### Step 0 — Owner decisions (no code)

1. **Redirect vs hard move** — Current State §6, options A/B. Record the answer in this README's Change History.
2. **Throttle for the moved `/services` routes** — inherit `admin/`'s default, or carry an explicit `@Throttle`? The current 30/min was tuned for unauthenticated probes (`health.controller.ts:49-51`) and the console polls at 30 s (`monitoring/api/hooks.ts:8`).
3. **`SttInternalController`** — confirm "record the carve-out" over "converge onto the service-token guard" (Current State §3).

### Step 1 — RED then GREEN: move `MonitoringController`

- **RED:** `apps/api/tests/e2e/monitoring.spec.ts` — repoint every path (`:52,:58,:67,:73,:80`) to `/api/v1/admin/monitoring/…`. Assert `GET /api/v1/admin/monitoring/sessions` with a SUPER_ADMIN token returns 200. Fails with 404 (route does not exist).
- **RED:** assert the old path is gone: `GET /api/v1/monitoring/sessions` → 404. Fails today with 200.
- **GREEN:** change `@Controller('monitoring')` → `@Controller('admin/monitoring')` (`monitoring.controller.ts:19`). The `@CanAny` at `:17` and the `@Throttle` at `:18` move with it, unchanged.
- **Second RED (tenancy):** in `tenant-dashboard-sources.spec.ts` (`:145,:155,:163`), assert TENANT_ADMIN still reaches `/api/v1/admin/monitoring/sessions` via `read:TenantTelemetry` and DOCTOR still gets 403. This is the regression that a careless "it's under admin now, make it SUPER_ADMIN" would introduce.

### Step 2 — RED then GREEN: split `ApiHealthController`

- **RED:** new `apps/api/src/modules/health/__tests__/admin-health-services.controller.test.ts` — assert `AdminHealthServicesController` exists, is mounted at `admin/health/services`, and carries `@CanAny(['manage','all'],['read','TenantTelemetry'])`. Fails: class does not exist.
- **RED:** `apps/api/tests/e2e/platform-dashboard-monitoring.spec.ts:126` repointed to `/api/v1/admin/health/services` → expect 200 for SUPER_ADMIN. Fails with 404.
- **RED:** assert the public probes are untouched — `GET /api/v1/health`, `/live`, `/ready`, `/startup` all still 200 **unauthenticated** (`health.spec.ts` already covers `/`; extend to all four). This is the guard against the split accidentally dragging `@Public()` routes behind CASL.
- **RED:** assert `GET /api/v1/health/services` (old path) → 404.
- **GREEN:** extract `checkServices` (`:196-236`) and `checkServiceByKey` (`:241-…`) plus the shared `probeService` helper into `src/modules/health/admin-health-services.controller.ts` at `@Controller('admin/health/services')`; register in `health.module.ts` alongside `ApiHealthController` (keeps the shared `downstreamServices` wiring in one module). `ApiHealthController` keeps only the four `@Public()` probes — at which point its class-level `@ForbidApiKey()` (`:62`) covers nothing but public routes and can be dropped, and the class stops being "Mixed" in the inventory.
- **GREEN:** apply the Step 0.2 throttle decision to the new controller.

### Step 3 — GREEN: update consumers in the same commit

- `apps/admin-console/src/features/monitoring/api/client.ts:16,20,24,28,32,36` — repoint to `admin/health/services…` and `admin/monitoring/…`.
- `apps/admin-console/src/features/platform/components/platform-dashboard.tsx:237` — UI label.
- `apps/admin-console/src/features/releases/api/client.ts:8` — doc-comment reference.
- Admin-console tests: `features/monitoring/api/__tests__/monitoring-api.test.ts:43-48`, `features/monitoring/components/__tests__/monitoring-screen.test.tsx:84-86,165,168`, `features/platform/components/__tests__/platform-dashboard.test.tsx:91`.
- Remaining API e2e: `platform-runtime-metrics.spec.ts:217`, `platform-dashboard-monitoring.spec.ts:65,101,114`, `tenant-dashboard-sources.spec.ts:170,184,192`.

### Step 4 — GREEN: hand both moved surfaces to TASK-757

Once they are `admin/`-prefixed, TASK-757's class-level `@ForbidApiKey()` sweep applies. Concretely:

- `MonitoringController` and the new `AdminHealthServicesController` join `ADMIN_SCOPED_CONTROLLERS` (`apps/api/src/bootstrap/admin-scope-audit.ts`) so the boot audit pins their gate.
- Neither declares `@RequiredScopes`, so TASK-757's proposed *"fail boot when an `admin/`-prefixed controller declares `@RequiredScopes`"* rule (review §3.1 step 2) is satisfied without further work.
- If TASK-757 has not landed, they keep their current `@ForbidApiKey()` — which is already the A2 outcome. **This ticket is not blocked on TASK-757**; only the *reason* recorded in the code comment differs.

### Step 5 — GREEN: record the `SttInternalController` carve-out (documentary)

Per Step 0.3, assuming "record" over "converge":

- Add a `// AUTH-NOTE:` block at `stt-internal.controller.ts:51-52` naming BUG-013, the reserved-scope mechanism, and `RESERVED_INTERNAL_SCOPE_CONTROLLERS` as the policing point — so a reader of the controller does not have to find the bootstrap audit to learn the rule.
- Add a paragraph to `api-controller-inventory.md` §1 ("Internal services") stating that this is a **policed carve-out, not drift**, with the BUG-013 rationale and the boot-audit reference. Update the `SttInternalController` catalog note, which currently reads only *"Exception to /internal Public+token pattern"*.
- Fix D-3: correct the `apps/stt/src/stt/worker.py:209` citation at `api-key-scope-audit.ts:159` to `core/api_client/gateway.py:39` + `core/effective_config.py:171,227`.
- **RED for the doc claim:** extend `apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts` with an assertion that removing `SttInternalController` from `RESERVED_INTERNAL_SCOPE_CONTROLLERS` while it lacks a service-token guard fails the audit. Fails only if the policing is weaker than the comment claims — which is exactly the thing worth proving before writing it down as settled.

### Step 6 — GREEN: cross-reference `WorkflowSandboxRunController`

No code change in this ticket. Add to this README's Implementation Summary and to `conformance/gateway-and-sdk.md` §6.3 a note that the drift is closed by TASK-757's admin sweep, and that post-TASK-742 the API-key path does evaluate CASL (D-4), so §6.3's stated blast radius is narrower than written.

### Step 7 — Documentation

Update in the same commit: `api-controller-inventory.md` (summary rows `:112`, `:132`; catalog entries `:923-937`, `:1212-1220`; §1 internal-services paragraph; fix D-1 `:serviceKey`, clarify D-5), `api-controller-groupings.md` (the affected View rows), and the P1/P2 + P3 rows of the conformance scorecard.

---

## Verification Criteria

- [ ] `pnpm api:build` and `pnpm lint` clean (hard errors in `apps/api`).
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green — the URL repoint compiles and its unit tests pass.
- [ ] `pnpm test:unit` green, including the new `admin-health-services.controller.test.ts` and the extended `api-key-scope-audit.test.ts`.
- [ ] `pnpm test:up:api` then `pnpm test:e2e` green: `monitoring.spec.ts`, `platform-dashboard-monitoring.spec.ts`, `platform-runtime-metrics.spec.ts`, `tenant-dashboard-sources.spec.ts`, `health.spec.ts`.
- [ ] API boots — `api-key-surface-audit` (every route declared) and `admin-scope-audit` (named surfaces keep their gate) both pass with the two new/moved admin controllers listed.
- [ ] Evidence: `GET /api/v1/monitoring/sessions` → **404**; `GET /api/v1/admin/monitoring/sessions` (SUPER_ADMIN JWT) → **200**. Same pair for `health/services`.
- [ ] Evidence: the four public probes still answer **unauthenticated** — `GET /api/v1/health`, `/health/live`, `/health/ready`, `/health/startup`. Non-negotiable: k3s liveness/readiness depends on it.
- [ ] Evidence: **TENANT_ADMIN** (holding `read:TenantTelemetry`, not `manage:all`) still reaches both moved surfaces, and **DOCTOR** still gets 403. The move must not narrow the gate to SUPER_ADMIN.
- [ ] Evidence: an API key is refused on both moved surfaces (403), and the refusal reason in the code comment now cites A2, not the TASK-742 conservative default.
- [ ] `SttInternalController` unchanged functionally: the STT worker's `X-Internal-Service-Key` path still authenticates; the carve-out is documented in `api-controller-inventory.md` and marked with an `// AUTH-NOTE:` at the controller.
- [ ] `WorkflowSandboxRunController`: cross-reference recorded; **no decorator changed in this ticket** (TASK-757 owns it).
- [ ] The Step 0.1 redirect decision is recorded in Change History with its reasoning, whichever way it went.
- [ ] `api-controller-inventory.md`, `api-controller-groupings.md` and the conformance scorecard's P1/P2/P3 rows updated in the same commit.

---

## Implementation Summary

Executed 2026-08-18. All four §2.5 items closed: two hard route moves, two documentary records.
No auth decorator was added or removed anywhere — both moved surfaces were **already**
`@ForbidApiKey()` (TASK-742's conservative default), which is exactly the A2 posture the admin
plane requires, so the move is a re-filing rather than a re-authorization.

### Step 0 — decisions taken

| # | Decision | Reasoning |
|---|---|---|
| 0.1 | **Option A — hard move, no alias.** | Current State §6: there is no redirect/deprecation precedent anywhere in `apps/api` (zero `@Redirect`, zero 301/308, zero `deprecated: true`), and the pre-production posture is "ship complete, not dual-pathed". Option B would invent a gateway convention for a surface whose only consumers live in this repo, and would leave an admin-shaped route on a business prefix — the exact defect this ticket removes. Every in-repo consumer moved in the same change; the retired paths are asserted **404** in `monitoring.spec.ts`. |
| 0.2 | **Preserve the existing 30/60s throttle on the moved `/services` routes** (explicit `@Throttle` on the new controller). | The tightness was justified by unauthenticated probe reconnaissance, but the probe itself fans out 6 outbound HTTP calls per request, so it is an SSRF amplifier on any prefix. 30/min sits comfortably above the admin console's 30-second poll (`features/monitoring/api/hooks.ts`, ≈2/min). Changing a rate limit is not a taxonomy decision, so this ticket preserves observable behaviour rather than re-tuning it. |
| 0.3 | **Record the `SttInternalController` carve-out; do not converge.** | Current State §3 — already settled, reasoned and boot-policed. Convergence would need a lockstep `apps/stt` change for zero security gain over a reserved scope no tenant key is ever issued. |

### Step 1 — `MonitoringController` → `admin/monitoring`

- `apps/api/src/modules/monitoring/monitoring.controller.ts:19` — `@Controller('monitoring')` → `@Controller('admin/monitoring')`. `@CanAny` (`:17`, OR mode) and `@Throttle(300/60s)` (`:18`) unchanged.
- Same file, the API-KEY-NOTE block: rewritten from "TASK-742 CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION" to "CLOSED BY PLANE" — the decorator is identical, the *reason* is now A2 rather than a deferral.
- RED first: `apps/api/src/modules/monitoring/__tests__/monitoring.controller.route.test.ts` (new) — 5 metadata assertions, 1 failed on the prefix (`expected 'monitoring' to be 'admin/monitoring'`) and 4 passed, pinning the gate/throttle/handler paths that must NOT change.

### Step 2 — split `ApiHealthController`

- `apps/api/src/modules/health/admin-health-services.controller.ts` (new) — `AdminHealthServicesController` at `@Controller('admin/health/services')`, holding `checkServices` (`@Get()`), `checkServiceByKey` (`@Get(':serviceKey')`), the `downstreamServices` table and the shared `probeService` helper. Carries the same per-handler `@CanAny(['manage','all'],['read','TenantTelemetry'])`, the same class `@ForbidApiKey()` and the same `@Throttle(30/60s)`.
- `apps/api/src/modules/health/health.controller.ts` — reduced to the four `@Public()` probes. `HttpService`, `IConfigService`, `Logger`, the `DownstreamService`/`ServiceProbeResult` interfaces and the `downstreamServices` table went with the handlers (they were orphaned by the split, so they were removed rather than left dangling).
- `apps/api/src/modules/health/health.module.ts` — registers both controllers; `HttpModule` stays (the new controller needs it).
- **Kept** the now-inert class-level `@ForbidApiKey()` on `ApiHealthController` even though the ticket's Step 2 said it "can be dropped": every route on the class is `@Public()`, so it covers nothing at runtime, but dropping it is an auth-posture change owned by TASK-757, and keeping it means a future non-public route added there fails boot instead of arriving undeclared. Recorded in the file's own comment.
- RED first: new `admin-health-services.controller.test.ts` failed to resolve the module; the rewritten `health.controller.test.ts` failed 15/15 on the two-argument constructor and the "handlers are gone" assertions.

### Step 3 — consumers moved in the same change

| File | Change |
|---|---|
| `apps/admin-console/src/features/monitoring/api/client.ts:16,20,24,28,32,36` | all six calls repointed to `admin/health/services…` / `admin/monitoring/…` |
| `…/features/monitoring/api/types.ts`, `…/api/hooks.ts`, `…/features/platform/components/platform-dashboard.tsx:237`, `…/features/releases/api/client.ts:8`, `…/shared/navigation/nav-config.ts:112` | doc comments + the UI label |
| admin-console tests: `monitoring-api.test.ts`, `monitoring-screen.test.tsx`, `platform-dashboard.test.tsx` | asserted URLs |
| **`packages/agentic-sdk-v2/src/core/constants.ts`** | `MONITORING_ENDPOINTS` (4 entries) and `SERVICE_HEALTH_ENDPOINTS.SERVICES` repointed; `isAdminPlanePath`'s doc updated. **This consumer was NOT in the ticket's §5 consumer table** — see "Findings while implementing" below. |
| SDK tests `constants.ws4`, `constants.task210`, `constants.task216`, `AgenticClient.task353`, `useHealthCheck` + its test | asserted paths; `task353` gained a case proving the new paths classify admin-plane through the generic `admin/` branch |
| API e2e `monitoring.spec.ts`, `platform-dashboard-monitoring.spec.ts`, `platform-runtime-metrics.spec.ts`, `tenant-dashboard-sources.spec.ts` | every path; `monitoring.spec.ts` gained a `Retired pre-TASK-759 monitoring paths` block asserting **404** on the three old paths |
| `apps/api/src/__tests__/controller-route-renames.test.ts` | the repo-wide controller-prefix inventory (**not in the ticket's consumer list**; it failed the full run and pinned `monitoring`) |

### Step 4 — handed to the admin plane

`apps/api/src/bootstrap/admin-scope-audit.ts` — `MonitoringController` and `AdminHealthServicesController` added to `ADMIN_SCOPED_CONTROLLERS` as `expect: 'FORBID'` (the `AdminImpersonationController` shape). Neither declares `@RequiredScopes`, so TASK-757's proposed "fail boot when an `admin/` controller declares `@RequiredScopes`" rule is satisfied on arrival. `auditAdminScopedControllers()` runs over the real list in `admin-scope-audit.test.ts` and passes.

`BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED` (`bootstrap/business-plane-apikey-exemptions-audit.ts`) — **deliberately left alone.** It names these two controllers as "TASK-759's to classify" and its own docstring says entries are not policed for staleness precisely so this ticket landing does not fail the boot. It is TASK-758's file and TASK-758 is in flight; the set is now inert (the controller-level `continue` fires before any path check, and both surfaces are admin-prefixed or `@Public()` anyway). **TASK-758 should delete the set and its test assertion when it closes.**

### Step 5 — `SttInternalController` carve-out (documentary; no functional change)

- `apps/api/src/modules/internal/stt-internal.controller.ts` — `// API-KEY-NOTE` block added above `@Controller('internal/stt')`. **Marker deviation, deliberate:** the plan said `// AUTH-NOTE:`, but the 2026-08-18 owner marker convention (recorded in `bootstrap/__tests__/business-plane-apikey-exemptions.test.ts`) assigns `API-KEY-NOTE` to the API-key classification and `AUTH-NOTE` to rule 05's "the decorator understates the real gate". This note is the former; the pre-existing `AUTH-NOTE` on `assertPlatformInternalCredential` is the latter and is untouched.
- `apps/api/src/bootstrap/api-key-scope-audit.ts` — **D-3 fixed**: the `apps/stt/src/stt/worker.py:209` citation replaced with the live send sites `apps/stt/src/stt/core/api_client/gateway.py` (verified: `"X-Internal-Service-Key": self.api_key`) and `core/effective_config.py:171,227`.
- `apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts` — three new cases proving the exemption is POLICED before it is written down as settled: exempted + reserved scope passes; exempted + **no** scope is still an offender; exempted + a registered `admin:` scope is still an offender.
- `docs/architecture/api-controller-inventory.md` — §1 gained a carve-out paragraph; the `SttInternalController` catalog note replaced.

### Step 6 — `WorkflowSandboxRunController`

No decorator changed. `docs/programs/agentic-workflow-platform/conformance/gateway-and-sdk.md` §6.3 gained a status note: the drift is closed by TASK-757's admin sweep, and D-4 is recorded (post-TASK-742 the API-key path DOES evaluate CASL via `enforceApiKeyAbilities`, so the stated blast radius is narrower than written; the finding itself stands).

### Step 7 — documentation

`api-controller-inventory.md` (summary rows, both catalog entries, new `AdminHealthServicesController` entry, headline class count 104 → 105, a TASK-759 handler-split delta, D-1 `:serviceKey` fixed, D-5 resolved by the class no longer being "Mixed"), `api-controller-groupings.md` (View A rows + counts; View B — the two rows were filed under **ENDUSER**, which was the misfiling itself: `ApiHealthController` moved to PUBLIC, `MonitoringController` + `AdminHealthServicesController` to SUPER-CARVE), `api-design-conformance-review.md` (P1/P2 row now 0 non-conformant, P3 row records the policed carve-out, §2.5 rows marked DONE, §4 sequencing row 5 struck), and TASK-708's Change History (correction appended, nothing above rewritten).

### Findings while implementing (not in the ticket as written)

1. **The ticket's §5 consumer table was incomplete.** `packages/agentic-sdk-v2` ships the moved paths as public SDK constants — `MONITORING_ENDPOINTS` (4 entries, consumed by `useMonitoring`) and `SERVICE_HEALTH_ENDPOINTS.SERVICES` (consumed by `useHealthCheck`) — plus `isAdminPlanePath`'s hard-coded non-`admin/` branches. §5's claim that "no `@arcaai/vox-node` resource calls" these was true, but `@arcaai/vox` (browser) does. All updated; the `isAdminPlanePath` legacy branches were KEPT (they cost nothing and still classify a hard-coded pre-move path as admin-plane rather than handing it the impersonation JWT).
2. **A repo-wide prefix pin the ticket did not name:** `apps/api/src/__tests__/controller-route-renames.test.ts` asserts `@Controller` strings for a fixed controller list. It failed the full suite on `monitoring` and was updated (the new controller added to the inventory block; `monitoring` moved out of the "unchanged" block).
3. **`@RequiredScopes` validates against `API_KEY_SCOPE_REGISTRY` at decoration time** — an invented scope string throws before any audit runs, so a negative audit test must use a registered scope to prove anything.
4. **This is a breaking change for any out-of-repo caller.** Six URLs move; no alias. In-repo that is fully absorbed. Outside the repo the only plausible callers are consumers of `@arcaai/vox` ≤ 2.0.7 pinned to the old constants and any operator script/dashboard hitting `/api/v1/health/services` or `/api/v1/monitoring/*` directly — both must move to the `admin/` paths. Auth is unaffected: both surfaces were already `@ForbidApiKey()`, so no API-key integration can have existed, and a JWT caller holding `manage:all` or `read:TenantTelemetry` is unchanged. **The SDK constants change should ship in the next `@arcaai/vox` release note.**

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | **Implemented (Steps 0–7).** Owner decisions recorded: 0.1 **hard move, no alias** (Option A — no redirect precedent exists in `apps/api`, no out-of-repo consumer for either surface, pre-production posture); 0.2 **throttle preserved** at 30/60s on the new controller (an explicit `@Throttle`, so the split changes no observable rate limit); 0.3 **record, do not converge** for `SttInternalController`. `MonitoringController` → `@Controller('admin/monitoring')`; `AdminHealthServicesController` extracted at `admin/health/services` with `ApiHealthController` reduced to its four `@Public()` probes. No auth decorator added or removed. Consumers moved in lockstep: admin-console (6 calls + labels + 3 test files), `@arcaai/vox` endpoint constants + 5 test files (**a consumer §5 missed**), 4 API e2e specs, and `controller-route-renames.test.ts` (**a prefix pin the ticket did not name**). Both moved controllers pinned in `ADMIN_SCOPED_CONTROLLERS` as `FORBID`. `SttInternalController` carve-out recorded at the controller (`// API-KEY-NOTE` — marker deviation from the plan's `AUTH-NOTE`, per the 2026-08-18 marker convention), in the inventory §1, and PROVEN by three new audit cases; D-3 citation corrected. TASK-708's Change History corrected by appending (nothing above rewritten). §6.3 cross-reference + D-4 recorded. Evidence: RED captured before each GREEN; `pnpm --filter @arcaai/api test` **223 files / 3162 tests passed, 0 failed** (2 skipped); `pnpm api:build` 12/12 tasks successful; `eslint {src,tests}/**/*.ts` **0 errors, 64 warnings** (was 65 — all pre-existing `eslint-comments/require-description`, and the one warning the new file initially inherited was given a description); admin-console touched-feature suites 8 files / 61 tests passed; SDK touched suites 5 files / 147 tests passed. **Not run:** the live e2e suite — the shared test API on :8968 belongs to a concurrent session and serves a pre-move build, restarting it would disrupt that session, and re-seeding is a destructive DB operation this ticket is not permitted to run. The four touched specs were compile-verified with `playwright test --list` (49 tests resolve across 4 files). Pre-existing failures observed and NOT caused by this ticket: `constants.ws4.test.ts` expects `DNA_STYLE_ENDPOINTS` to have 16 keys while HEAD already has 18, and 5 admin-console `ai-task-defaults`/`harness-policy` tests. Status: **Completed** pending that e2e run. | TASK-759 implementation agent |
| 2026-08-18 | Created. All four §2.5 claims verified against source (`monitoring.controller.ts:17-29`, `health.controller.ts:53-62,196-244`, `stt-internal.controller.ts:41-52`, `workflow-sandbox-run.controller.ts:20-34`). Six discrepancies recorded (D-1…D-6), including that the `SttInternalController` "decision required" is already settled and boot-policed, and that no redirect convention exists in `apps/api`. Implementation plan and verification criteria written. Status: Pending. No code changed. |
