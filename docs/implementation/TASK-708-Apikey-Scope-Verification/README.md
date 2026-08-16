# TASK-708 — API-Key Scope Verification

| | |
|---|---|
| **Status** | Review |
| **Wave** | 0 · **Size** | M |
| **Epic slug** | `apikey-scope-verification` |
| **Depends on** | — |
| **Design refs** | Exposure plane (§Architecture, [design.md](../../architecture/agentic-workflow-platform/design.md)) — *"Precondition (early work item): verify API-key scope enforcement end-to-end before any workflow is publicly exposed."* This ticket IS that precondition; `TASK-722 exposure-v1` depends on it (`708 & 718 & 720 --> 722` in [backlog.md](../../architecture/agentic-workflow-platform/backlog.md)'s dependency graph) |
| **Findings closed** | — (new finding, produced by this ticket itself — see §2) |

## 1. Requirement Analysis

The Exposure plane in [design.md](../../architecture/agentic-workflow-platform/design.md) will
bind published workflow versions to REST/SSE/socket/webhook channels behind "scoped API keys,
tenant-resolved, entitlement-checked." That plan is only sound if API-key scoping actually
restricts what a key can invoke today. This ticket verifies that end-to-end, documents exactly
what is enforced versus decorative, writes contract tests that lock in current behavior (so a
future refactor cannot silently widen the gap further), and produces gap-closure tasks for
anything found decorative — so `exposure-v1` has a true precondition to build on rather than an
assumption.

**The central finding, stated up front because it governs the shape of every task below**:
scope enforcement is **real but extremely narrow**, and the platform's RBAC/CASL machinery is
**entirely bypassed** on the API-key authentication path — not as a bug, but as a documented,
deliberate architectural split that was never generalized past a fixed 14-route list. Concretely:
a valid API key from any tenant reaches every route its authenticated identity's RBAC would permit
**except** the 14 routes explicitly decorated with `@RequiredScopes(...)` — including every
`/admin/*` route in the gateway. This is exactly the shape of gap the design brief asked this
ticket to find and either lock in or close.

**Out of scope**: building the workflow-exposure gateway itself (`exposure-v1`, Wave 2); adding
new scope categories for workflows/channels that don't exist yet (that is `exposure-v1`'s job once
this ticket's contract is solid); redesigning `ApiKeyType`/`ApiKeyStatus` or key rotation (unrelated
to scope enforcement).

## 2. Current State Evaluation

### 2.1 The `ApiKey` model — `scopes` is the only access-control field beyond IP/rate-limit

`packages/database/src/prisma/db_main/apikey.prisma:22-83`. Relevant fields: `tenantId`,
`keyHash`/`keyPrefix`/`keyChecksum`, `keyType` (`ApiKeyType`: SDK/WEBHOOK/INTEGRATION/SERVICE_ACCOUNT),
`keyStatus` (`ApiKeyStatus`: ACTIVE/INACTIVE/REVOKED/EXPIRED), **`scopes Json? @db.JsonB` (`:40`,
"Array of permissions/scopes")**, `allowedIps Json?` (`:41`), `rateLimit Int?` (`:42`), `expiresAt`,
`userId` (FK to `User`), rotation fields. No `allowedRoutes`/`allowedWorkflow`/`allowedChannel`
field exists — `scopes` is the entire access-restriction surface a key can carry beyond the
tenant/user it authenticates as.

### 2.2 `UnifiedAuthGuard`'s API-key branch — authenticates, then (mostly) does not authorize

`packages/applications/src/authorization/unified-auth.guard.ts`, registered globally as
`APP_GUARD` (`apps/api/src/app.module.ts:166-169`).

- `authenticate()` (`:90-160`): extracts a raw key via `apiKeyService.extractApiKeyFromRequest(request)`
  (`:103`); if present, branches to `handleApiKeyAuth` (`:106`) and **never falls through to JWT**.
- `handleApiKeyAuth` (`:164-214`): `authenticateByRawKey(rawKey, ip)` → hash lookup + status/expiry/IP
  checks → optional per-key rate-limit check (`:175-188`, Redis-backed via `IApiKeyRateLimiter`) →
  `enforceApiKeyScopes(context, apiKeyEntity)` (`:190`) → sets `request['apiKey']` and CLS
  `user`/`tenantId` from the key's own `userId`/`tenantId` (`:192-202`) → returns `true`.
- `enforceApiKeyScopes` (`:216-235`), verified verbatim:
  ```ts
  const requiredScopes = this.reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [context.getHandler(), context.getClass()]);
  if (!requiredScopes || requiredScopes.length === 0) {
    return;
  }
  const hasRequiredScope = requiredScopes.some((scope) => this.apiKeyService.hasScope(apiKeyEntity, scope));
  if (!hasRequiredScope) {
    throw new ForbiddenException(`API key does not have required scope(s): ${requiredScopes.join(', ')}`);
  }
  ```
  **No metadata present ⇒ no check at all.** `API_KEY_REQUIRED_SCOPES` metadata is set only by the
  `@RequiredScopes(...)` decorator.

### 2.3 `@RequiredScopes` — real enforcement, on exactly 14 routes, all in one feature area

`packages/applications/src/authorization/decorators.ts:90-134`. Its own doc comment states the
architecture precisely: *"Sets `API_KEY_REQUIRED_SCOPES` metadata... read by
`UnifiedAuthGuard.enforceApiKeyScopes` on the API-key auth path ONLY. It is independent of — and
additive to — `@Authorize()`/`@CanXxx()`, which gate the JWT/CASL path... A JWT-authenticated
caller is unaffected by this decorator; an API-key-authenticated caller must satisfy it."* Fails
closed on a typo — every scope is validated against `API_KEY_SCOPE_REGISTRY` at **decoration
time** (module load), not request time (`:105-118`), so an unknown scope string is a boot/build
failure, not a silent hole.

The full, current list of `@RequiredScopes`-decorated routes —
`apps/api/src/bootstrap/api-key-scope-audit.ts:40-59`, the `SDK_DAY1_SCOPED_ROUTES` constant, 14
entries: `SmrCompatController.{summarySync, presummary}`; `ConsultationController.{generateSummary,
generatePreSummary, generateSummaryAsync, generatePreSummaryAsync, getSummaries,
getLatestSummary, getLatestPreSummary, getById, updateSummary}`; `ConsultationJobController.{getJob,
cancelJob, streamJob}`. This is **the entire set** — repo-wide grep confirms no other controller
uses `@RequiredScopes`. In particular, **no `/admin/*` route has scope enforcement**, despite
`admin:*` scope strings already existing in `API_KEY_SCOPE_REGISTRY`
(`packages/applications/src/services/apiKey/apikey-scopes.registry.ts:29-37` —
e.g. `admin:user:read`, `admin:tenant:write`) and being referenced by no decorator anywhere.

### 2.4 CASL/RBAC is not evaluated at all on the API-key path

`@Authorize()`/`@CanRead`/`@CanManage()` etc. set `REQUIRED_PERMISSIONS_KEY`
(`decorators.ts:59-66`), read **only** inside `handleJwtPostAuth`
(`unified-auth.guard.ts:252`) — the JWT-only branch. `PolicyEngine.buildAbility({userId,
tenantId})` (`policy.engine.ts:119`) is likewise invoked **only** from `handleJwtPostAuth`
(`:266`). For an API-key-authenticated request, no ability is ever built; `request.ability` and CLS
`userAbility` stay unset for the whole request. Independent confirmation:
`ApiKeyService.callerCanManageAllKeys()` (`apikey.service.ts:1124-1128`) reads CLS `userAbility`
and degrades to `false` for API-key callers precisely because it is never populated on that path.

**This means an API key does not "inherit the full ability set of its tenant/user" — it inherits
nothing from CASL at all.** Whatever restricts it comes exclusively from `@RequiredScopes`, which
14 routes have and the rest of the gateway does not.

### 2.5 No route-class-specific restriction exists; this is empirically demonstrated, not just inferred from missing code

Grep across `apps/api/src` for any `request.apiKey`/auth-method conditional found only
identity-resolution reads (`apps/stt-compat/stt-compat.controller.ts:250-251`,
`apps/internal/stt-internal.controller.ts:140`), never a route gate. Two existing e2e specs already
demonstrate the gap in their own assertions:

- `apps/api/tests/e2e/api-key-auth.spec.ts:181-191` — creates a key with default/narrow scopes,
  calls `GET /api/v1/admin/tenants` (a `@CanManage('Tenant')`-gated route,
  `apps/api/src/modules/tenant/tenant.controller.ts:47,99`) with it, and asserts
  `expect([200, 400, 401, 403]).toContain(response.status())` — the test author already tolerates
  `200` as a possible outcome.
- `apps/api/tests/e2e/auth-guard-behavior.spec.ts:21,40-43` uses the same `/admin/tenants` route as
  its generic "is API-key auth alive" probe, asserting only `not.toBe(401)`.

**No test in the repo asserts that a route lacking `@RequiredScopes` denies an out-of-scope API
key** — because today it does not; such an assertion would currently fail.

### 2.6 The boot-time audits — what they do and do not guarantee

Two separate audits run from `apps/api/src/main.ts`:

- `auditAdminRoutePermissions(app)` (`apps/api/src/bootstrap/admin-route-permission-audit.ts:56-123`,
  invoked `main.ts:288`) — refuses boot unless every non-`@Public()` route carries a JWT/CASL
  permission decorator. This guarantees a decorator exists, not that it does anything for an
  API-key caller (§2.4 — it does not).
- `auditApiKeyRequiredScopes()` (`apps/api/src/bootstrap/api-key-scope-audit.ts:61-90`, invoked
  `main.ts:294`) — deliberately narrow by its own docstring (`:14-18`): checks only the fixed
  14-route `SDK_DAY1_SCOPED_ROUTES` list for `@RequiredScopes` presence, and explicitly disclaims
  a gateway-wide policy: *"Widening it into a gateway-wide 'every API-key-reachable route must have
  scopes' policy is out of scope."*

**No boot-time or runtime check today verifies that every API-key-reachable route has an
API-key-specific scope gate.** That is precisely the gap this ticket must either formalize as an
accepted, tested risk or close.

### 2.7 `X-API-Key` header and the SDK contract

`ApiKeyService.extractApiKeyFromRequest` (`apikey.service.ts:949-981`) accepts, in order: `apikey`,
`api-key`, `x-api-key`, `x-internal-service-key` headers, then (gated by a settings flag) a
`?apiKey=` query param. `@arcaai/vox-node`'s `HopeClient` sends `X-API-Key`
(`packages/vox-node/src/core/transport.ts:42-43,103`) — matches the accepted header set, so the
Exposure plane's stated consumer contract (`@arcaai/vox` SDK / `@arcaai/vox-node` clients using
scoped keys) is already wire-compatible; this ticket's findings are entirely about the
authorization side, not the transport.

### 2.8 Rate limiting is real but orthogonal

Per-key rate limiting (`apikeyEntity.rateLimit` via `IApiKeyRateLimiter`,
`unified-auth.guard.ts:175-188`, Redis-backed 60s window) is genuinely enforced per key — but it is
a throughput ceiling, not a route/resource restriction, and does not bear on "can this key invoke
workflow X."

## 3. Knowledge & Best Practices

- `.claude/rules/05-nestjs-api.md` — "Every route has `@Public()` or a permission decorator (boot
  audit enforces)" is already true and unaffected by this ticket; this ticket adds a **second**,
  API-key-specific dimension to that guarantee rather than replacing it.
- `.claude/rules/04-application-services.md` — 404-over-403 cross-tenant posture is a *tenancy*
  rule, separate from the *authorization* gap this ticket investigates; do not conflate the two —
  an API key reaching `/admin/tenants` cross-tenant is a tenancy question already covered
  elsewhere, while an API key reaching `/admin/tenants` **at all** without an admin-scoped key is
  this ticket's question.
- **Pitfall**: do not "fix" this by making `enforceApiKeyScopes` fall back to full CASL ability
  building when no `@RequiredScopes` metadata is present. That would silently grant an API key the
  full ability of whatever user/tenant it's attached to for every currently-unscoped route — the
  opposite direction of the design brief's exit criterion ("a key scoped to workflow X / channel Y
  cannot invoke anything else"). The correct default for an unscoped-but-reachable route is
  **deny for API-key callers**, unless the route is deliberately safe for any valid key (e.g. purely
  informational health/read routes already covered by tenant-scoping) — this determination is the
  gap-closure work in Task 4, not a blanket policy flip.
- `.claude/rules/01-development-workflow.md` §TDD — Task 2's contract tests must be written to
  **pass against current behavior first** (locking in what's real today, including the documented
  gap) before Task 4's gap-closure tests, which then go RED against the still-open gap and GREEN
  once closed — two distinct test generations, not one.

## 4. Implementation Plan

### Task 1 — Findings document (this ticket's own deliverable, formalized)
- **Agent:** T2 · sonnet-5 · low
- **Files:** this README's §2 (already written above) — Task 1 is to review it against the live
  tree one more time immediately before Task 2 begins (confirm no drift since authoring) and paste
  the confirmation into the Implementation Summary.
- **Approach:** Re-run the greps and line citations in §2 verbatim; note any drift.
- **Verify:** Citations match; any drift documented.

### Task 2 — Contract tests locking in CURRENT behavior (both the enforced and the decorative parts)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` (new)
- **Approach:** e2e spec, structured in two halves so a future reader sees the split explicitly:
  1. **"Real enforcement" half** — for a sample of the 14 `SDK_DAY1_SCOPED_ROUTES`
     (`consultation.controller.ts`'s `generateSummary`/`generateSummaryAsync` at minimum), assert a
     key WITHOUT the required scope gets 403 with the exact `enforceApiKeyScopes` message shape,
     and a key WITH the scope succeeds. This extends the existing unit coverage in
     `unified-auth.guard.required-scopes.test.ts` to a real HTTP round-trip.
  2. **"Decorative today" half** — a deliberately-named test, e.g. `'documents the current gap:
     an API key with no admin scope reaches /admin/tenants'`, replacing the loose `[200, 400, 401,
     403]` assertion pattern in `api-key-auth.spec.ts:191` with a precise one: create a key with
     ONLY `consultation:report:write` (no admin scope), call `GET /api/v1/admin/tenants`, assert
     the CURRENT actual status (almost certainly `200`, gated only by whatever tenant-scoping the
     route itself does — confirm and assert the real value, do not guess). This test's name and a
     comment must state plainly that a `403` here in the future is the intended fix (Task 4), not a
     regression — so this spec does not become stale-and-ignored the moment Task 4 lands; update it
     alongside Task 4 rather than leaving a permanently-green "gap exists" assertion.
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e -- task-708-apikey-scope-contract`
  — GREEN against current code (this task documents reality, it does not change it yet).

### Task 3 — Decide and register gap-closure scope: `/admin/*` and beyond
- **Agent:** T3 · sonnet-5 · medium
- **Files:** none (decision + written plan feeding Task 4)
- **Approach:** Using §2's inventory, classify every currently-unscoped-but-API-key-reachable route
  family into one of: (a) genuinely fine for any valid key of the right tenant (e.g. a key's own
  self-describing/health routes), (b) needs a new `@RequiredScopes` category (most `/admin/*`
  routes — decide the scope-string taxonomy, e.g. `admin:tenant:read`/`admin:tenant:write` already
  exist in the registry unused), (c) should never be reachable by an API key at all (routes that
  only make sense for an interactively-authenticated human — e.g. impersonation, break-glass). This
  is a design decision with real blast radius (existing SERVICE_ACCOUNT/INTEGRATION keys in
  production may rely on today's implicit reach) — **HUMAN-GATED**: confirm the classification with
  the product/security owner before Task 4 applies decorators broadly, since narrowing access is a
  breaking change for any caller currently relying on the gap.
- **Verify:** A written classification table covering every controller directory under
  `apps/api/src/modules/` reviewed and bucketed (a)/(b)/(c).

### Task 4 — Close the gap for the routes the Task 3 decision approves
- **Agent:** T3 · sonnet-5 · medium, fan-out one agent per controller group once Task 3's
  classification is approved (e.g. one for `tenant`/`user`/`rbac`, one for `apiKey`/`webhook`/`billing`)
- **Files:** the controllers Task 3 buckets into (b)/(c); `apikey-scopes.registry.ts` if new scope
  strings are needed beyond the already-declared unused `admin:*` entries;
  `api-key-scope-audit.ts` — extend `SDK_DAY1_SCOPED_ROUTES` (or introduce a second, explicitly-named
  list) so the boot audit's regression guard now covers the newly-scoped routes too.
- **Approach:** Add `@RequiredScopes(...)` alongside each route's existing `@Authorize`/`@CanXxx`
  decorator, per the pattern already shown in `decorators.ts`'s own example
  (`@Authorize(['create','Summary']) @RequiredScopes('consultation:report:write')`). For bucket (c)
  routes, add an explicit API-key-reachability block instead (a small guard/decorator checking
  `request.apiKey` is absent, or a scope that no real key is ever granted) — do not invent a new
  mechanism if `@RequiredScopes` with a reserved never-granted scope string achieves the same
  result more simply.
- **Verify:** Task 2's "decorative today" spec is updated to assert the new `403`, per its own
  documented intent; `pnpm test:e2e -- task-708-apikey-scope-contract` GREEN on the new behavior;
  `pnpm test:unit`.

### Task 5 — Extend the boot-time audit's coverage intentionally, not by widening its disclaimer away
- **Agent:** T2 · sonnet-5 · low
- **Files:** `apps/api/src/bootstrap/api-key-scope-audit.ts`
- **Approach:** Per Task 4's actual closed set, either extend `SDK_DAY1_SCOPED_ROUTES` to include
  the newly-scoped routes (keeping the audit's narrow, explicit-list character — the file's own
  docstring already argues against a gateway-wide sweep, and this ticket's Task 3 classification is
  the deliberate substitute for that sweep) or add a second explicitly-named constant if the
  route sets warrant being tracked separately (e.g. `SDK_DAY1_SCOPED_ROUTES` vs an
  `ADMIN_SCOPED_ROUTES` list) — do not silently fold everything into one undifferentiated list that
  loses the "day-1 SDK surface" framing the existing name carries.
- **Verify:** Boot the API locally (`pnpm api:dev`) and confirm the audit passes; deliberately
  remove one `@RequiredScopes` decorator from a covered route and confirm the audit fails boot
  (regression-guard proof), then restore it.

### Task 6 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (verification only)
- **Approach:** Run every layer gate touched.
- **Verify:** `pnpm api:build`, `pnpm test:unit`, `pnpm test:up:api` + `pnpm test:e2e`, `pnpm lint`.

## 5. Acceptance Criteria

- [x] §2's findings section is confirmed current against the live tree at execution time (Task 1)
- [ ] `pnpm test:up:api` then `pnpm test:e2e -- task-708-apikey-scope-contract` passes, with an
      explicit, named test proving the "real enforcement" half (14-route `@RequiredScopes` set) and
      a separate, explicitly-named test documenting (pre-Task-4) or proving-closed (post-Task-4)
      the decorative-today gap — **test written and read-verified against the real handler code
      (§7 Task 2); NOT run live** — blocked by Prisma's AI-safety guard on the DB-seed step, itself
      on this execution's forbidden-commands list. Needs a human/consented run.
- [ ] **HUMAN-GATED** Task 3 classification reviewed and approved before Task 4 narrows any
      existing key's reach — proposal written (§7 Task 3), NOT yet reviewed/approved by a human
- [ ] For every route Task 3/4 classifies as needing closure: a contract test proves an
      out-of-scope API key is denied (403) and an in-scope key succeeds — blocked on Task 4, which
      is blocked on the human approval above
- [x] `api-key-scope-audit.ts`'s regression-guard property is itself tested (removing a decorator
      fails boot) — Task 5 — already satisfied by pre-existing TASK-632 coverage; re-run and
      confirmed passing, no code change needed (see §7 Task 5)
- [x] `pnpm api:build`, `pnpm test:unit`, `pnpm lint` all pass — verified `--filter @arcaai/api`
      (package-scoped, per this execution's concurrency constraints); repo-wide `pnpm lint` reserved
      for the final verification agent
- [ ] The design brief's exit criterion is met and demonstrated: *"a key scoped to workflow X /
      channel Y cannot invoke anything else — proven by tests"* — restated concretely as: a key
      holding only `consultation:report:write` cannot reach any route classified (b)/(c) in Task 3,
      proven by the Task 4 test suite — blocked on Task 4 (human-gated, not executed)
- [x] Ticket README's Implementation Summary and Change History updated with actual command output
      pasted, including the final classification table from Task 3

## 6. Risks & Open Questions

- **HUMAN-GATED (Task 3, restated)**: closing the gap is a breaking change for any existing
  SERVICE_ACCOUNT/INTEGRATION key in a live environment that currently relies on unscoped reach
  (e.g. an internal automation calling an admin route with a narrowly-named key that happened to
  work because no route-level check existed). This must be confirmed with whoever owns existing
  production API keys before Task 4 executes broadly — a phased rollout (scope required but not yet
  enforced / warn-only period) may be the right mitigation and should be decided at Task 3, not
  assumed.
- **Bucket (c) (routes that should never be API-key-reachable) has no existing mechanism** — this
  ticket proposes reusing `@RequiredScopes` with a reserved, never-granted scope string rather than
  building a new decorator, to avoid a second authorization primitive; confirm this is acceptable
  or whether a dedicated `@ForbidApiKey()` decorator is preferred (a five-minute addition either
  way, but a real API surface decision).
- **This ticket's scope stops at today's routes.** `exposure-v1` (Wave 2) will introduce entirely
  new route shapes (`/api/v1/workflows/:slug/...`) that do not exist yet — this ticket cannot test
  those in advance, but its contract tests and the Task 3 classification methodology are exactly
  what `exposure-v1` should reuse when those routes are designed.
- **`API_KEY_SCOPE_REGISTRY` already has unused `admin:*` scopes declared** (§2.3) — worth
  confirming in Task 3 whether their original authors had a specific route mapping in mind that was
  never wired, versus whether the taxonomy needs revisiting now that real usage is being designed.

## 7. Implementation Summary

Executed Tasks 1, 2, 5, 6 (partial) and produced the Task 3 written classification
proposal. **Task 4 was deliberately NOT executed** — it is a breaking change gated on
human approval of the Task 3 classification below, per this ticket's own instructions.

### Task 1 — Findings re-confirmed against the live tree

Re-ran every grep/citation in §2 against the current tree (feat/loop branch, 2026-08-16).
No drift in substance; a few line numbers moved by 1–3 lines from authoring-time citations
(expected — the README itself flags this). Spot-checks performed:

- §2.2/§2.3 `unified-auth.guard.ts` (`enforceApiKeyScopes`, `handleApiKeyAuth`,
  `handleJwtPostAuth`) and `decorators.ts` (`RequiredScopes`, `Authorize`) — verbatim match.
- §2.3 the 14-route `SDK_DAY1_SCOPED_ROUTES` count reconfirmed by grep: exactly 14
  `@RequiredScopes` call sites outside `decorators.ts`'s own doc comment and definition —
  `ConsultationJobController` ×3, `ConsultationController` ×9, `SmrCompatController` ×2.
  No other controller uses the decorator.
- §2.5 `tenant.controller.ts` class-level `@CanAny(['manage','Tenant'],['update','Tenant'])`
  and method-level `@CanManage('Tenant')` on `create` — confirmed present, "204-over-403"
  posture unaffected by this ticket.
- §2.5 the two existing e2e specs (`api-key-auth.spec.ts:191`,
  `auth-guard-behavior.spec.ts:21,40-43`) still tolerate/probe `/admin/tenants` exactly as
  described.
- §2.6 both boot audits (`admin-route-permission-audit.ts`, `api-key-scope-audit.ts`) and
  their `main.ts` call sites confirmed unchanged.
- §2.1/§2.7/§2.8 `apikey.prisma` fields, `API_KEY_SCOPE_REGISTRY` (unused `admin:*` entries
  still present, still unreferenced by any decorator), and
  `ApiKeyService.extractApiKeyFromRequest`'s accepted header set — all confirmed verbatim.

**Additional finding surfaced during re-verification (not in the original §2, worth folding
into it before this doc is archived)**: `apps/api/src/modules/internal/stt-internal.controller.ts`
is NOT `@Public()` — it goes through ordinary `UnifiedAuthGuard` with a bare `@Authorize()`
(auth-required, no CASL permission, and CASL is never evaluated for API-key auth per §2.4
anyway) and no `@RequiredScopes`. Its own code comment (`AUTH-NOTE` above
`assertPlatformInternalCredential`) already documents that **any active API key — including
an ordinary tenant SDK key — reaches these routes**, and that tenant-scope injection plus a
manual constant-time internal-secret check (for the cross-tenant-pin path only) are the sole
compensating controls. This is a live, already-self-documented instance of exactly the gap
this ticket investigates, on a route family the original 14-route/`admin/*` framing didn't
name. Folded into the Task 3 table below (bucket (c), flagged HIGH priority for Task 4).

### Task 2 — Contract tests written; NOT executed live against the test API (see caveat)

**File added**: `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` (new, 7 tests).

Structure, exactly per the plan's two-half split:

- **"Real enforcement" half** (5 tests) — for three of the 14 `SDK_DAY1_SCOPED_ROUTES`
  (`ConsultationController.generateSummary`, `.generateSummaryAsync`,
  `ConsultationJobController.getJob`): an API key WITHOUT the required scope gets exactly
  `403` with `enforceApiKeyScopes`'s message shape
  (`API key does not have required scope(s): <scope>`); a key WITH the scope passes the
  guard, proven by reaching the handler's own `404` for a nonexistent
  consultation/job id (`verifyConsultationOwnership` / `TenantOwnedResourceInterceptor`) —
  never the scope-denial 403. Traced the exact code path for both outcomes by reading
  `consultation.controller.ts` (`verifyConsultationOwnership` calls
  `consultationService.getById` before any CASL/SMR work) and
  `tenant-owned-resource.interceptor.ts` (`assertConsultationJob` throws generic 404 on a
  missing Redis job status) to confirm the "with scope" case is deterministic and requires
  no seeded consultation/job fixture.
- **"Decorative today" half** (1 test) — `GET /api/v1/admin/tenants` with a key holding
  ONLY `consultation:report:write` (no admin scope). Traced `TenantController.fetchAll`
  (`tenant.controller.ts`): it inline-checks `isSuperAdmin(user)`, and the CLS `user` object
  an API key populates carries only `{ id, tenantId }` (`unified-auth.guard.ts` — no
  `roles`), so `isSuperAdmin` is always `false` for API-key callers; the handler then falls
  back to `tenantService.fetchById(user.tenantId)`, returning exactly one row (the key's own
  tenant). Asserted the CURRENT real values: `200`, `body.data.length === 1` — replacing the
  loose `[200, 400, 401, 403]` tolerance pattern with a precise, named assertion, per the
  plan. The test's comment states plainly that a future `403` here is the intended Task 4
  fix, not a regression.

**Verification performed**:

- `pnpm --filter @arcaai/api lint` — **0 errors**, 65 pre-existing warnings unrelated to the
  new file (all `eslint-comments/require-description` on files this ticket did not touch).
  The new spec file produced no lint output at all (clean).
- `pnpm --filter @arcaai/api test` (full unit suite, includes the pre-existing
  `api-key-scope-audit.test.ts` and `unified-auth.guard.required-scopes.test.ts`) —
  **200 files / 2875 tests passed, 2 files / 4 tests skipped, 0 failed.**
- `pnpm --filter @arcaai/api build` — succeeded (`dist/main.js` produced).

**What could NOT be verified — honestly reported, not glossed over**: the ticket's own
Verify step calls for `pnpm test:up:api` + `pnpm test:e2e -- task-708-apikey-scope-contract`
against a live, seeded test API. I brought up the isolated test infra
(`pnpm infra:test:up` — Postgres/Redis/MinIO/Qdrant/Vault on the isolated test ports, all
healthy) and then ran `pnpm test:db:reset`, which failed: Prisma's own AI-safety guard
intercepted `prisma db push --force-reset` with *"Prisma Migrate detected that it was
invoked by Claude Code... you are forbidden from performing this action without explicit
consent and review by the user"* and refused to run. That command (`pnpm db:push` and its
`:force` variant) is also explicitly on this execution's own "never run" list, so I did not
attempt to supply the consent env var or otherwise work around the guard — I tore the test
infra back down (`pnpm infra:test:down`) and left the tree as I found it. **The new contract
test spec has therefore been read-verified line-by-line against the real handler/interceptor
code (traced above) and is lint-clean and type-clean by `eslint`'s type-aware rules, but has
not been run end-to-end against a live server.** A human (or an agent with standing
permission to consent to the Prisma db-push guard) needs to run
`pnpm test:db:reset && pnpm test:up:api` then
`pnpm test:e2e -- task-708-apikey-scope-contract` to get the actual GREEN run this ticket's
acceptance criteria call for.

### Task 3 — Written classification proposal (HUMAN-GATED — NOT approved, NOT applied)

Every controller under `apps/api/src/modules/` (92 controller files, ~60 module
directories) reviewed and bucketed. **(a)** = fine as-is for any valid key of the caller's
own tenant (self-describing/health/already-ownership-scoped reads, or informational
auth-only routes). **(b)** = needs a `@RequiredScopes(...)` gate — most already has a
matching unused string in `API_KEY_SCOPE_REGISTRY`, some need a new one. **(c)** = should
never be reachable by an API key at all (interactive-human-only flows, or routes that
already use a *different* auth primitive and aren't meaningfully "API-key reachable" in the
sense this ticket studies).

| Controller (path) | Bucket | Notes |
|---|---|---|
| `rate-limit-admin` (`/admin/rate-limit`) | (b) | new `admin:rate-limit:*` |
| `admin-reconciliation`, `admin-usage` (`/admin/usage*`) | (b) | new `admin:usage:*` |
| `my-usage` (`/usage`) | (a) | self-service, already tenant/user-scoped |
| `agent-promotion` (`/admin/agent-promotions`) | (b) | new scope |
| `agent-trajectory` (`/admin/agent-trajectory`) | (b) | new scope |
| `agentic-admin` (`/admin/agentic`) | (b) | new scope |
| `ai-inference` (`/ai`) | (b) | functional inference proxy, not self-describing — needs a real scope, not an admin one |
| `ai-model-admin`, `ai-model-discovery` (`/admin/ai-models`) | (b) | new `admin:ai-model:*` |
| `ai-provider-connection` (`/admin/providers`) | (b) | HIGH sensitivity — provider credentials |
| `ai-runtime-profile` (`/admin/ai-runtime-profiles`) | (b) | new scope |
| `ai-service-admin` (`/admin/ai-services`) | (b) | new scope |
| `ai-task-default-admin` (`/admin/ai-task-defaults`) | (b), special | some sub-routes are imperatively GLOBAL_ADMIN-only (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES`, `05-nestjs-api.md`) — a `@RequiredScopes` gate here must not become satisfiable by an ordinary tenant-issued key; needs its own design pass, not a blanket scope |
| `api-key` (`/admin/api-keys`) | (b), special | a key that can mint/rotate OTHER keys is privilege-escalation-shaped; recommend `admin:apikey:write` scoped ONLY to platform-operator keys, and consider whether `create`/`rotate` should instead be bucket (c) for API-key callers entirely |
| `audit-log` (`/admin/audit-logs`) | (b) | `admin:audit:read` already declared, unused |
| `admin-impersonation` (`/admin/users` — impersonation) | (c) | interactive-human-only, explicitly the Risks §6 example |
| `auth-sso`, `auth` (`/auth*`), `register` (`/auth`) | (c) | session lifecycle (login/logout/refresh/register) for interactive humans; nonsensical for a key that IS the credential |
| `billing-admin` (`/admin/billing/invoices`), `rate-card-admin` (`/admin/billing/rate-card`) | (b) | new scope |
| `my-billing` (`/billing`) | (a) | self-service |
| `changelog-admin` (`/admin/changelog`) | (b) | new scope |
| `changelog` (`/changelog`) | (a) | read-only, `@Authorize()` auth-only today |
| `consultation-context-schema` (`/admin/consultation-context-schemas`) | (b) | new scope |
| `admin-consultation` (`/admin/consultations`) | (b) | new scope |
| `consultation-job` (`/consultations/jobs`) | — | already fully scoped (3/3 routes); no gap |
| `consultation` (`/consultations`) | (b) | 9 of ~20 routes already scoped; the REMAINING routes (context items, transcriptions, entity extraction, patient linkage) should get the same `consultation:session:*`/`consultation:report:*` scopes as their scoped siblings |
| `harness-internal` (`/internal/harness`) | N/A | `@Public()` + `HarnessServiceTokenGuard` — a different auth primitive; not "API-key reachable" in this ticket's sense |
| `department-agent`, `department-agent-resync` (`/admin/department-agents`) | (b) | new scope |
| `department` (`/admin/departments`) | (b) | new scope |
| `dna-writing-style-admin` (`/admin/dna-writing-styles`) | (b) | new scope |
| `dna-writing-style` (`/dna-writing-styles`) | (a) | per-caller self-service, `@Authorize()` auth-only today |
| `entitlements-admin` (`/admin/entitlements`) | (b) | new scope |
| `my-entitlements` (`/entitlements`) | (a) | self-service |
| `global-setting` (`/admin/settings`) | (b) | HIGH sensitivity — platform-wide knobs |
| `harness-admin` (`/admin/harness`) | (b) | new scope |
| `health` (`/health`) | (a) | already mostly `@Public()`; any remaining authenticated variant is fine for any key |
| `internal/effective-config` (`/internal/effective-config`) | N/A | `@Public()` + `InternalServiceTokenGuard` — different auth primitive |
| `internal/stt-internal` (`/internal/stt`) | **(c), HIGH PRIORITY** | see the Task 1 "additional finding" above — NOT `@Public()`, reachable by ANY active API key today; the code's own `AUTH-NOTE` already treats this as a known compensating-control gap. Recommend a reserved never-issued-to-tenants scope (or a dedicated internal-worker SERVICE_ACCOUNT-only gate) rather than leaving it open |
| `mcp-admin` (`/admin/mcp-servers`) | (b) | new scope |
| `monitoring` (`/monitoring`) | (b) | `@CanAny(['manage','all'],['read','TenantTelemetry'])` — telemetry export, admin-shaped |
| `notification` (`/admin/notifications`) | (b) | new scope |
| `pipeline-policy-admin` (`/admin/harness/pipeline-policy`) | (b), special | carries the `globalOnly` descriptor lock (`05-nestjs-api.md`) — same caveat as `ai-task-default-admin` |
| `audio-pipeline-public` (`/audio/pipelines`) | (a)/(b) | `@Authorize()` today; likely (a) if read-only discovery, (b) if it exposes mutation — needs a file-level read before Task 4 |
| `audio-pipeline` (`/admin/audio/pipelines`) | (b) | new scope |
| `platform-metrics` (`/admin/platform`) | (b) | new scope |
| `prompt-management` (`/admin/prompt-templates`) | (b) | note the SYSTEM-vs-tenant-owned split gate (OD-3, `05-nestjs-api.md`) — a `@RequiredScopes` gate must compose correctly with that existing two-tier check |
| `prompt-template` (`/prompt-templates`) | (a)/(b) | personal (`USER_PERSONAL`) template self-service is likely (a); needs confirmation before Task 4 |
| `pstudio-status`, `pstudio` (`/admin/pstudio*`) | (b) | new scope |
| `queue-admin` (`/admin/queues`), `scheduler-admin` (`/admin/schedulers`) | (b) | new scope |
| `permission-check` (`/rbac/check`) | (a) | since API-key auth never builds a CASL ability (§2.4), this always reports "no permissions" for a key caller — self-consistent, not a hole, but Task 4 should consider a clearer response than a silently-empty permission set |
| `policies`, `roles` (`/admin/rbac/*`) | (b) | HIGH sensitivity — defines the RBAC model itself |
| `resource-subscription` (`/admin/resource-subscriptions`) | (b) | new scope |
| `service-release-admin` (`/admin/service-releases`) | (b) | new scope |
| `service-release-internal` (`/internal/service-releases`) | N/A | `@Public()` + service-token guard |
| `settings-catalog`, `settings-registry-write` (`/admin/settings`) | (b) | HIGH sensitivity — writes platform config |
| `smr-compat` (`/api/smr/api/v1`) | — | already fully scoped (2/2 routes); no gap |
| `speech-proxy` (`/speech`) | (b) | functional STT proxy; `stt:*` family scopes already declared, unused |
| `storage-access-key` (`/admin/tenants/storage/keys`) | (b) | HIGH sensitivity — storage credentials |
| `storage` (`/storage`) | (b) | `media:file:read`/`media:file:write` already declared, unused — natural fit |
| `admin-transcription-job` (`/admin/audio/transcription-jobs`) | (b) | new scope |
| `smr-proxy` (`/text`) | (b) | streaming SMR surface parallel to the already-scoped `smr-compat`; needs a file-level read to confirm scope mapping before Task 4 |
| `transcription-job` (`/audio/transcription-jobs`) | (b) | functional STT job surface; `stt:transcription:*`/`stt:stream:write` already declared, unused |
| `stt-compat` (`/api/stt`) | (b) | v1-compat STT surface mirroring `smr-compat`'s shape but NOT in the 14-route audited list — same treatment |
| `tenant-allowed-origin` (`/admin/allowed-origins`) | (b) | security-relevant — CORS registry |
| `tenant-bucket` (`/admin/tenants/storage/buckets`) | (b) | new scope |
| `tenant-frontend-config-admin` (`/admin/tenant-frontend-config`) | (b) | new scope |
| `tenant-idp-config-admin` (`/admin/tenant-idp-config`) | (b) | HIGH sensitivity — IdP/SSO config |
| `tenant-storage-config-admin` (`/admin/tenants/storage/config`) | (b) | new scope |
| `tenant-stt-config-admin`, `tenant-tts-config-admin` | (b) | new scope |
| `my-tenant` (`/tenant`) | (a) | self-describing |
| `tenant-pipeline-resync` (`/admin/tenants`) | (b) | new scope |
| `tenant-provision` (`/admin/tenants`) | (b), special | HIGH sensitivity — tenant provisioning/deprovisioning, likely GLOBAL_ADMIN-only imperative-check territory too |
| `tenant.controller` (`/admin/tenants`) | (b) | this ticket's own worked example (§2.5 and the new contract test) |
| `forgot-password` (`/auth`), `password-reset` (`/users/password-reset`) | (c) | human-only credential-recovery flows |
| `user-departments-me` (`/user/me/departments`) | (a) | self-service |
| `user-departments` (`/admin/users`) | (b) | new scope |
| `user-preferences`, `user-settings` (`/user/me/*`) | (a) | self-service, already caller-scoped |
| `user-roles` (`/users`) | (b) | privilege-relevant — role assignment |
| `user.controller` (`/admin/users`) | (b) | new scope |
| `voice-profile` (`/voice-profile`) | (a) | already ownership-checked via `TenantOwnedResource({ modelName: 'UserVoiceProfile' })`; could still get a dedicated scope later |
| `webhook` (`/admin/webhooks`) | (b) | `webhook:event:read`/`webhook:event:write` already declared, unused — natural fit |

**This table is a proposal, not a decision.** Per this ticket's own Task 3 instructions and
the Risks §6 (breaking-change / phased-rollout consideration for existing
SERVICE_ACCOUNT/INTEGRATION keys), it requires product/security owner sign-off — in
particular on: (1) the bucket (c) calls (impersonation, auth lifecycle, and especially the
newly-flagged `stt-internal` gap), (2) whether bucket (a) self-service routes should get
lightweight scopes anyway for defense-in-depth, (3) the `admin:*` scope taxonomy (confirm
the existing unused `admin:*` registry entries map cleanly onto the ~50 `/admin/*` routes
above, or whether finer-grained per-resource scopes are wanted instead), and (4) whether a
phased warn-only rollout is needed before any route starts hard-403ing existing keys.

### Task 4 — NOT EXECUTED (breaking change, human-gated on Task 3)

No `@RequiredScopes(...)` decorators were added to any currently-unscoped route. No
existing route's behavior was changed. This is deliberate: narrowing what an existing
SERVICE_ACCOUNT/INTEGRATION API key can reach is a breaking change for any production
caller relying on today's implicit reach (Risks §6), and this execution's own instructions
require the Task 3 classification to be confirmed by a human before any such change lands.

### Task 5 — Audit regression-guard property: already satisfied, no code change needed

Read `apps/api/src/bootstrap/api-key-scope-audit.ts` and its test file
`apps/api/src/bootstrap/__tests__/api-key-scope-audit.test.ts` (both pre-existing, from
TASK-632). The test file already contains exactly the regression-guard proof Task 5's Verify
step asks for:

- `'throws when a route in the list has no @RequiredScopes(...) metadata'` — proves removing
  the decorator fails the audit.
- `'throws when a route in the list DOES carry @RequiredScopes(...) metadata (sanity...)'`
  and `'passes for the real HOPE Node SDK day-1 surface'` — proves the pass case is not a
  false negative.
- `'throws with a stale-target message when the named method no longer exists'` and
  `'lists every offender in one error when multiple routes drift'` — additional drift
  coverage beyond the ticket's literal ask.

Ran this suite (as part of the full `apps/api` unit run above) — all pass. **No edit to
`api-key-scope-audit.ts` was made**: extending `SDK_DAY1_SCOPED_ROUTES` (or adding a second
named constant, per the plan's own suggestion) only makes sense once Task 4 has an actual
closed route set to extend it with, and Task 4 was correctly not executed per the human
gate. Doing so now would mean inventing routes to audit that no decorator yet protects —
the audit would either be a no-op reconciliation (list routes, add no decorators, defeating
its purpose) or would have to add `@RequiredScopes` itself (which IS Task 4). Re-run this
task once Task 3 is approved and Task 4 lands.

### Task 6 — Verification pass (partial — scoped to what this execution touched)

| Command | Result |
|---|---|
| `pnpm --filter @arcaai/api build` | PASS — `dist/main.js` produced |
| `pnpm --filter @arcaai/api test` | PASS — 200 files / 2875 tests passed, 2 files / 4 tests skipped, 0 failed |
| `pnpm --filter @arcaai/api lint` | PASS — 0 errors, 65 pre-existing warnings (unrelated files, unaffected by this ticket) |
| `pnpm test:up:api` + `pnpm test:e2e -- task-708-apikey-scope-contract` | **NOT RUN** — blocked by Prisma's AI-safety guard on `db push --force-reset`, which is also on this execution's forbidden-commands list; needs a human (or a session with standing consent) to seed the test DB and run this |
| `pnpm lint` (repo-wide) | Not run by this execution (repo-root aggregate — reserved for the final verification agent per the concurrency instructions) |

**Files changed by this execution**: only
`apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` (new) and this README. No
production source file was modified — Task 4 was not executed, so there was nothing to
change in `apps/api/src/**` or `packages/applications/src/**`.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-0 ticket-authoring agent |
| 2026-08-16 | Executed Tasks 1, 2, 5, 6 (partial); produced the Task 3 written classification proposal (HUMAN-GATED, not approved); explicitly did NOT execute Task 4. Added `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts`. `apps/api` build/unit-test/lint all green; live e2e run blocked by Prisma's AI-safety guard on the required `db push --force-reset` DB-seed step (also on this execution's own forbidden-commands list) — flagged as a human follow-up. Status set to Review pending (a) human approval of the Task 3 classification and (b) a human/consented run of the live e2e verification. | T2/T3 execution agent |
| 2026-08-16 | **One route closed ahead of the broader `/admin/*` sweep, with explicit user approval** (the `/admin/*` bucket-(b)/(c) decision from §7 Task 3 is still pending human sign-off and untouched by this entry). Closed the `internal/stt-internal` (c)-HIGH-PRIORITY gap called out in §7 Task 3 and in the Task 1 "additional finding": `SttInternalController` (`apps/api/src/modules/internal/stt-internal.controller.ts`) carried a class-level `@Authorize()` and no `@RequiredScopes`, so any active API key — including an ordinary tenant SDK key — reached every `/api/v1/internal/stt/*` route. Added a new reserved scope `internal:stt:worker` to `API_KEY_SCOPE_REGISTRY` (`packages/applications/src/services/apiKey/apikey-scopes.registry.ts`) — deliberately NOT one of the existing `stt:*`/`consultation:*` scopes, because those are legitimately issued to tenant SDK keys for the tenant-facing STT/consultation surfaces and would have let a tenant key back into the worker-only routes; confirmed no existing scope fit, per the ticket's own recommendation to use "a reserved never-issued-to-tenants scope". Added class-level `@RequiredScopes('internal:stt:worker')` to `SttInternalController`. The STT worker's platform `SERVICE_ACCOUNT` credential (seeded with `scopes: ['*']`, `packages/database/src/prisma/db_main/seed/02-apikey.ts`) satisfies the new gate via the existing wildcard grant in `ApiKeyService.hasScope` — no seed/provisioning change needed, worker behavior unchanged. Updated the AUTH-NOTE above `assertPlatformInternalCredential` to describe the new two-layer gate (class-level `@RequiredScopes` restricts entry to the controller at all; the existing constant-time internal-secret check remains the separate, narrower gate for the cross-tenant `X-Internal-Tenant-Id` pin). TDD: added `apps/api/src/modules/internal/__tests__/stt-internal.controller.scope.test.ts` (real `SttInternalController` class + real `UnifiedAuthGuard`/`Reflector`, mirroring `unified-auth.guard.required-scopes.test.ts`'s pattern) — RED confirmed first (2 of 3 new tests failed: `promise resolved "true" instead of rejecting`, since no scope metadata existed yet), then GREEN after the fix (`apps/api`: 204/206 test files, 2911/2915 tests passed, 0 failed, 2 pre-existing skips; isolated re-run of the two `stt-internal` test files: 2/2 files, 34/34 tests passed). `pnpm --filter @arcaai/applications build` re-run (apps/api resolves `@arcaai/applications` from its built `dist/`, which needed rebuilding after the registry edit for the new scope to be visible). `pnpm --filter @arcaai/api build`, `pnpm --filter @arcaai/api typecheck`, `pnpm --filter @arcaai/applications typecheck` all clean; `pnpm --filter @arcaai/api lint` — 0 errors, 65 pre-existing warnings (same count as this ticket's own earlier run, all `eslint-comments/require-description` on untouched files); `pnpm --filter @arcaai/applications test` — 490/491 files, 9114/9118 tests passed, 0 failed, 1 pre-existing skip; `pnpm --filter @arcaai/applications lint` — 0 errors, 182 pre-existing warnings (same rule, none on the touched registry file). **Not run**: `pnpm test:e2e` (local infra was down for this session; no e2e spec was added or changed by this entry). **Left alone, by design**: every other route in the §7 Task 3 table (all ~50 `/admin/*` routes and the rest of bucket (b)/(c)) — that sweep still awaits the separate human decision. | Gap-closure agent |
