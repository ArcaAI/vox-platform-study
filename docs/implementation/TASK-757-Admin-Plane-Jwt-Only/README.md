# TASK-757 — The admin plane becomes JWT-only

| | | | |
|---|---|---|---|
| **Status** | Pending | **Owner** | Platform / Authorization |
| **Date** | 2026-08-18 | **Type** | refactor (security posture) |
| **Related** | `docs/architecture/api-design-conformance-review.md` rule **A2**, §2.2, §2.3, §3.1 step 2, §4 order 4 · `docs/architecture/api-controller-inventory.md` · `docs/architecture/api-controller-groupings.md` (View B) · `docs/architecture/agentic-workflow-platform/conformance/gateway-and-sdk.md` §6.3, §6.4 · **TASK-756** (privilege ceiling — lands first) · **TASK-762** (machine identity — this ticket creates the need for it) · **TASK-758** (A1 business plane) · **TASK-759** (plane taxonomy / prefix moves) · **TASK-761** (API-plane conformance gates) · `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` §6, §7 Task 4, §8 (TASK-742) |

> **Sibling tickets, authored concurrently from the same review (2026-08-18).** TASK-754…762 were
> written in parallel by separate sessions and their numbers follow the review's §4 sequencing table,
> not the order they appeared on disk. Machine identity is **TASK-762**, not 758. Ownership
> boundaries that touch this ticket: **TASK-758** owns rule A1 (business plane) and therefore
> `ConsentGrantController` / `AdminImpersonationController` posture questions; **TASK-759** owns the
> `MonitoringController` and `ApiHealthController` `/services` prefix moves; **TASK-761** owns the
> general API-plane conformance gate family. §4 Step 3 below overlaps TASK-761 deliberately — see the
> note there.

---

## 1. Requirement Analysis

**Policy A2:** `/api/v1/admin/*` is a **JWT-only** plane. API keys are prohibited there.

Today the admin plane is uniformly API-key reachable: **65 controllers / 386 handlers** carry a
class-level `@RequiredScopes(...)`. Only two admin-prefixed controllers already refuse keys —
`AdminImpersonationController` and `ConsentGrantController`.

**What this ticket delivers**

1. Class-level `@ForbidApiKey()` on all 65, replacing their `@RequiredScopes(...)`.
2. The 56 `admin:*` scope strings **marked reserved, not deleted** — refused at grant time, dropped
   from the advertised catalog, kept as vocabulary for TASK-762.
3. The two boot audits inverted so an admin-prefixed controller declaring `@RequiredScopes`
   **fails the boot**.
4. The prior-decision record in TASK-708/742 **appended** (not overwritten).

**Classification:** `refactor` with a security-posture outcome. It removes reach; it adds no feature.

### Why A2, given TASK-742 already made scope+ability a conjunction

Because the residual risk is not a privilege *delta*, it is a **credential class** problem. A key
minted with an admin scope is a long-lived static bearer secret carrying the granting admin's blast
radius, with no MFA, no session expiry, no revocation-on-logout and no impersonation audit trail.
Administration is exactly the surface where those properties are not optional. TASK-756 closes the
escalation path into that credential; this ticket removes the credential class from the plane.

### Non-goals

- The A1 business-plane rollout and its exemption list (conformance §3.3) — **TASK-758**.
- The P1/P2 prefix moves — `MonitoringController` → `admin/monitoring`, `ApiHealthController`
  `/services` → `admin/health/services` (conformance §2.5) — **TASK-759**. When they land, the moved
  controllers inherit A2 and must be added to this ticket's list.
- `/internal/*`, which stays `@Public()` + `X-Service-Token` and is untouched here.
- Building the replacement machine credential — **TASK-762**.

---

## 2. Current State Evaluation

All line numbers verified by opening the files on 2026-08-18 (branch `feat/loop`). Counts
re-derived independently from the inventory's summary table and cross-checked against the tree.

### 2.1 `@ForbidApiKey()` alone is sufficient — verified

`packages/applications/src/authorization/unified-auth.guard.ts`:

| Line | Fact |
|---|---|
| `:319` | `this.enforceApiKeyNotForbidden(context);` — **first** thing after the raw key authenticates |
| `:336` | `this.enforceApiKeyScopes(context, apiKeyEntity);` — the scope check, **17 lines later** |
| `:364-369` | the doc comment: *"checked BEFORE scopes (a forbidden route has no scope that could rescue it)"* |
| `:370-376` | `enforceApiKeyNotForbidden` — reads `API_KEY_FORBIDDEN`, throws `ForbiddenException` unconditionally |

> Conformance §3.1 step 2 cites `unified-auth.guard.ts:365`. `:365` is the first line of that doc
> comment; the quoted sentence is on `:366`, and the load-bearing evidence is the **call ordering**
> at `:319` vs `:336`. Corrected here.

Consequence: applying `@ForbidApiKey()` renders **every** `admin:*` scope inert, **including the
bare `'*'` superadmin wildcard** — no scope string can reach the check. This is not incidental; it
is why TASK-708 built the decorator instead of the reserved-scope trick it originally proposed
(TASK-708 §6, second bullet: a key holding `admin:*` would have satisfied any reserved scope nested
under `admin:`).

Scopes are an API-key-only concept — the JWT path never reads `API_KEY_REQUIRED_SCOPES` — so
removing them changes nothing for a bearer token.

### 2.2 The 65 controllers

Derived from `api-controller-inventory.md` §3: every row whose prefix begins `api/v1/admin/` **and**
whose Auth model is *JWT + API key*. Handler counts sum to **386**, matching the conformance
scorecard exactly.

| # | Controller | Prefix (`api/v1/…`) | Handlers | Current class scope |
|---:|---|---|---:|---|
| 1 | HarnessAdminController | `admin/harness` | 26 | `admin:harness:manage` |
| 2 | UserController | `admin/users` | 21 | `admin:user:write` |
| 3 | PromptManagementController | `admin/prompt-templates` | 16 | `admin:prompt-template:manage` |
| 4 | TenantController | `admin/tenants` | 15 | `admin:tenant:write` |
| 5 | AudioPipelineController | `admin/audio/pipelines` | 14 | `admin:audio-pipeline:manage` |
| 6 | QueueAdminController | `admin/queues` | 12 | `admin:queue:manage` |
| 7 | TenantBucketController | `admin/tenants/storage/buckets` | 12 | `admin:tenant-storage:manage` |
| 8 | EntitlementsAdminController | `admin/entitlements` | 11 | `admin:entitlement:manage` |
| 9 | DepartmentController | `admin/departments` | 10 | `admin:department:manage` |
| 10 | RolesController | `admin/rbac/roles` | 10 | `admin:role:write` |
| 11 | ApiKeyController | `admin/api-keys` | 9 | `admin:apikey:write` |
| 12 | DepartmentAgentController | `admin/department-agents` | 9 | `admin:department-agent:manage` |
| 13 | ConsultationContextSchemaAdminController | `admin/consultation-context-schemas` | 8 | `admin:consultation-context-schema:manage` |
| 14 | DnaWritingStyleAdminController | `admin/dna-writing-styles` | 8 | `admin:dna-writing-style:manage` |
| 15 | GlobalSettingController | `admin/settings` | 8 | `admin:settings:manage` |
| 16 | TenantIdpConfigAdminController | `admin/tenant-idp-config` | 8 | `admin:tenant-idp-config:manage` |
| 17 | TenantSttConfigAdminController | `admin/stt-config` | 8 | `admin:tenant-stt-config:manage` |
| 18 | WorkflowDefinitionController | `admin/workflow-definitions` | 8 | `admin:workflow-definition:manage` |
| 19 | AiModelAdminController | `admin/ai-models` | 7 | `admin:ai-model:manage` |
| 20 | BillingAdminController | `admin/billing/invoices` | 7 | `admin:billing:manage` |
| 21 | PoliciesController | `admin/rbac/policies` | 7 | `admin:rbac-policy:write` |
| 22 | TenantTtsConfigAdminController | `admin/tts-config` | 7 | `admin:tenant-tts-config:manage` |
| 23 | **WebhookController** | `admin/webhooks` | 7 | **`webhook:event:write`** |
| 24 | AuditLogController | `admin/audit-logs` | 6 | `admin:audit:read` |
| 25 | ResourceSubscriptionController | `admin/resource-subscriptions` | 6 | `admin:resource-subscription:manage` |
| 26 | TenantAllowedOriginController | `admin/allowed-origins` | 6 | `admin:allowed-origin:manage` |
| 27 | TenantStorageConfigAdminController | `admin/tenants/storage/config` | 6 | `admin:tenant-storage:manage` |
| 28 | AiRuntimeProfileController | `admin/ai-runtime-profiles` | 5 | `admin:ai-runtime-profile:manage` |
| 29 | **KnowledgeController** | `admin/knowledge/documents` | 5 | `admin:knowledge:manage` |
| 30 | McpAdminController | `admin/mcp-servers` | 5 | `admin:mcp-server:manage` |
| 31 | SchedulerAdminController | `admin/schedulers` | 5 | `admin:scheduler:manage` |
| 32 | WorkflowTestFixtureController | `admin/workflow-test-fixtures` | 5 | `admin:workflow-test-fixture:manage` |
| 33 | AdminUsageController | `admin/usage` | 4 | `admin:usage:manage` |
| 34 | AiProviderConnectionController | `admin/ai-providers` | 4 | `admin:ai-provider:manage` |
| 35 | AiTaskDefaultAdminController | `admin/ai-task-defaults` | 4 | `admin:ai-task-default:manage` |
| 36 | NotificationController | `admin/notifications` | 4 | `admin:notification:manage` |
| 37 | ProviderConnectionController | `admin/providers` | 4 | `admin:ai-provider:manage` |
| 38 | RateLimitAdminController | `admin/rate-limit` | 4 | `admin:rate-limit:manage` |
| 39 | UserDepartmentsController | `admin/users` | 4 | `admin:user:write` |
| 40 | **WorkflowSandboxRunController** | `admin/workflow-definitions/:definitionId/sandbox-runs` | 4 | `admin:workflow-definition:manage` |
| 41 | AdminConsultationController | `admin/consultations` | 3 | `admin:consultation-admin:manage` |
| 42 | AdminReconciliationController | `admin/usage/reconciliation` | 3 | `admin:usage:manage` |
| 43 | AdminTranscriptionJobController | `admin/audio/transcription-jobs` | 3 | `admin:transcription-job:read` |
| 44 | AgentPromotionController | `admin/agent-promotions` | 3 | `admin:agent-promotion:manage` |
| 45 | AgentTrajectoryController | `admin/agent-trajectory` | 3 | `admin:agent-trajectory:read` |
| 46 | AiServiceAdminController | `admin/ai-services` | 3 | `admin:ai-service:manage` |
| 47 | ChangelogAdminController | `admin/changelog` | 3 | `admin:changelog:manage` |
| 48 | PipelinePolicyAdminController | `admin/harness/pipeline-policy` | 3 | `admin:pipeline-policy:manage` |
| 49 | PlatformMetricsController | `admin/platform` | 3 | `admin:platform-metrics:read` |
| 50 | RateCardAdminController | `admin/billing/rate-card` | 3 | `admin:billing:manage` |
| 51 | ServiceReleaseAdminController | `admin/service-releases` | 3 | `admin:service-release:manage` |
| 52 | StorageAccessKeyController | `admin/tenants/storage/keys` | 3 | `admin:storage-key:manage` |
| 53 | WorkflowRunController | `admin/workflow-runs` | 3 | `admin:workflow-run:read` |
| 54 | AiModelDiscoveryController | `admin/ai-models` | 2 | `admin:ai-model:manage` |
| 55 | NlpTaskInstructionsAdminController | `admin/nlp-task-instructions` | 2 | `admin:nlp-task-instructions:manage` |
| 56 | PrismaStudioController | `admin/pstudio` | 2 | `admin:pstudio:manage` |
| 57 | SettingsCatalogController | `admin/settings` | 2 | `admin:settings:manage` |
| 58 | SettingsRegistryWriteController | `admin/settings` | 2 | `admin:settings:manage` |
| 59 | TenantFrontendConfigAdminController | `admin/tenant-frontend-config` | 2 | `admin:tenant-frontend-config:manage` |
| 60 | AgenticAdminController | `admin/agentic` | 1 | `admin:agentic:manage` |
| 61 | DepartmentAgentResyncController | `admin/department-agents` | 1 | `admin:department-agent:manage` |
| 62 | PrismaStudioStatusController | `admin/pstudio/status` | 1 | `admin:pstudio:manage` |
| 63 | TenantPipelineResyncController | `admin/tenants` | 1 | `admin:tenant:write` |
| 64 | TenantProvisionController | `admin/tenants` | 1 | `admin:tenant:write` |
| 65 | WorkflowNodeController | `admin/workflow-nodes` | 1 | `admin:workflow-node:read` |
| | **Total** | | **386** | |

**Already `@ForbidApiKey()`, no change needed:** `AdminImpersonationController`
(`admin/users`, 1 handler) and `ConsentGrantController` (`admin/consent-grants`, 3 handlers —
`apps/api/src/modules/consent/consent.controller.ts:33`).

**Two rows deserve a note:**

- **#23 `WebhookController`** is the only admin controller gated by a **non-`admin:`** scope
  (`webhook:event:write`). Since it is the sole consumer of the `webhook:*` family
  (`apikey-scopes.registry.ts:50-51`, `:153`), that family also goes inert. It must be reserved
  alongside the `admin:*` set.
- **#40 `WorkflowSandboxRunController`** carries a doc comment stating it is *"Session-JWT admin
  console ONLY"* while declaring `@RequiredScopes('admin:workflow-definition:manage')`
  (`apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts:33-34`). Conformance
  §6.3 names it as unenforced drift. **A2 fixes it as a side effect** — no bespoke change needed.

### 2.3 Finding: the boot audit's static list is two controllers short

`apps/api/src/bootstrap/admin-scope-audit.ts:98-163` holds `ADMIN_SCOPED_CONTROLLERS` — **64
entries**, of which one (`AdminImpersonationController`) expects `'FORBID'`. So it polices **63** of
the 65 above. Missing:

| Missing from the audit list | Verified decorator |
|---|---|
| `KnowledgeController` | `apps/api/src/modules/knowledge/knowledge.controller.ts:31` — `@RequiredScopes('admin:knowledge:manage')` |
| `WorkflowSandboxRunController` | `apps/api/src/modules/workflow-sandbox-run/workflow-sandbox-run.controller.ts:33` — `@RequiredScopes('admin:workflow-definition:manage')` |

Both are genuinely API-key reachable today; both are simply absent from the named list. They are
caught by the *coverage* audit (`api-key-surface-audit.ts`, which walks `ModulesContainer` and only
asks that *something* is declared) but not by the *value* audit. `ConsentGrantController` is
likewise absent, though harmless since it is already forbidden. This is a hand-transcription drift
of exactly the kind Step 3 below converts into a mechanical check.

### 2.4 The scope registry — 56 `admin:` strings, and the count's real shape

`packages/applications/src/services/apiKey/apikey-scopes.registry.ts`:

- **55** `admin:`-prefixed entries in the `Admin` category — `:39-47` (the nine pre-TASK-708
  originals) and `:80-134` (the ~45 TASK-708 additions).
- **1** more: `'admin:*'` at `:152`, in the `Wildcard` block.
- **56 total.** Plus `'webhook:event:read'`/`'webhook:event:write'` (`:50-51`) and `'webhook:*'`
  (`:153`).

> Conformance §2.2 cites *"56 `admin:*` scopes (`apikey-scopes.registry.ts:37-134`)"*. The total is
> right; the range is not — only **55** fall inside `:37-134`, and the 56th (`admin:*`) is at `:152`.
> Corrected. A reservation pass that only walked `:37-134` would leave the most dangerous string in
> the family grantable.

Registry totals for orientation: **85** entries overall; `isValidScope` is `scope in
API_KEY_SCOPE_REGISTRY` (`:158-160`); `getScopesByCategory()` (`:169-176`) is what the catalog
endpoint returns.

### 2.5 Where "reserved" has to be enforced, and why it splits in two

`ValidScopesConstraint` (`validators/valid-scopes.validator.ts:6-10`) is a class-validator
constraint wired onto **both** DTOs — `dto/apikey-create.request.ts:22` and
`dto/apikey-update.request.ts:23`. A class-validator constraint **cannot see the stored key**, so it
cannot implement "reject newly-added scopes only". Therefore:

- **create** — a DTO-level constraint is correct and sufficient (every scope is new).
- **update** — the delta check must live in `ApiKeyService.update()`
  (`apikey.service.ts:514`, scopes applied at `:532`), where `apiKey.scopes` is in hand. Leaving the
  membership-only constraint on the update DTO and adding the delta check in the service is the only
  shape that satisfies the requirement.

Without that split, every `PATCH` on a pre-existing key whose stored array contains `admin:*` would
fail validation on a field the caller never touched.

### 2.6 The advertised catalog

`apps/api/src/modules/api-key/api-key.controller.ts:31-37`:

```ts
@Get('scopes')
@CanRead('ApiKey')
getAvailableScopes() {
  return getScopesByCategory();
}
```

The controller calls the registry helper **directly** — there is no service indirection to change.
Reserved entries must be filtered inside `getScopesByCategory()` (and `getAvailableScopes()` at
`:162-167`) so the catalog stops advertising access the platform will always refuse.

### 2.7 Regrowth is stopped by enforcement, not deletion

`@RequiredScopes` takes a **raw string**. An emptied registry would not stop a new admin controller
from declaring `@RequiredScopes('admin:new-thing:manage')` — `enforceApiKeyScopes`
(`unified-auth.guard.ts:398-422`) never consults the registry; it only compares strings via
`hasScope`. The only durable guard is a **boot audit that inverts the current invariant**.

Both audits are already wired in `apps/api/src/main.ts` — `auditAdminScopedControllers()` at `:309`,
`auditEveryApiKeyReachableRouteDeclaresScopes(app)` at `:318` — and the latter already resolves the
controller path (`readControllerPath` — call site `api-key-surface-audit.ts:75`, defined `:120-125`), so the admin-prefix test is a
few lines, not new machinery.

### 2.8 Blast radius — verified, and one correction

| Consumer | Verdict | Evidence |
|---|---|---|
| `apps/admin-console` BFF | **Unaffected** — already JWT-only | `apps/admin-console/src/server/hope-proxy.ts:20-38` (`buildHeaders`): forwards only `content-type`, `if-match`, `idempotency-key`, `user-agent` (`:11`), sets `authorization: Bearer` (`:27`) and conditionally `x-tenant-id` (`:35`). **No API-key header is ever set.** |
| CI / scripts / deployment | **Unaffected** — no automation calls `/admin/*` with a key | conformance §2.2 |
| `@arcaai/vox-node` | **Unaffected** — never touches `/admin/*` | conformance §2.2 |
| `@arcaai/vox` (browser SDK) | **Contract break, no known consumer.** Four admin hooks exist — `useAdminConsultations` (`/admin/consultations`), `useHarnessAdmin` (`/admin/harness/*`), `useQueueAdmin` (`/admin/queues`), `useAdminTranscriptionJobs` (`/admin/audio/transcription-jobs`) — all exported (`packages/agentic-sdk-v2/src/hooks/index.ts:168,188`), and the README documents `credentials: { apiKey: KEY }` (`README.md:68,294`). Under A2 those hooks work with a JWT and fail with a key. |
| Dev-only seeded keys | **Affected, dev/test only.** `packages/database/src/prisma/db_main/seed/02-apikey.ts` — gated by `shouldSeedApiKeys()` (`:17-19`, `development`/`test` only). Exactly one seeded key can reach admin today: `SERVICE_ACCOUNT` with `scopes: ['*']` (`:124-137`). Every other seeded key carries only `stt:*` / `consultation:*` / `user:preferences:*` / `webhook:event:*` scopes. |
| e2e specs | **Two break, not three** — see below |

**Correction to the brief's blast-radius list.** Of the three named specs, only two break:

| Spec | Verdict |
|---|---|
| `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` | **Breaks.** "Half 2" (`:209-260`) asserts `/api/v1/admin/tenants` is reachable with an `admin:tenant:write` key and refused without it; `:294` extends the same wildcard semantics. |
| `apps/api/tests/e2e/api-key-auth.spec.ts` | **Breaks.** It uses `GET /api/v1/admin/tenants` as its generic "protected route" probe for the whole header-variant / revocation / expiry matrix (`:136,146,157,183,226,262`). |
| `apps/api/tests/e2e/api-key-owner-scope.spec.ts` | **Does NOT break.** Every HTTP call in that file uses `headers: bearer(...)` — a JWT. `rawKey` appears only at `:30,43,51` (helper plumbing) and `:87` (`expect(rotated.rawKey).toBeTruthy()`); it is never sent on a request. The spec exercises the owner-scope gate through the JWT path and is unaffected by A2. |

### 2.9 The consequence that must not be buried

After this ticket there is **zero machine path to administration**. `X-Service-Token` is
structurally confined to `/internal/*` — no admin controller uses `InternalServiceTokenGuard`,
`HarnessServiceTokenGuard` or `ServiceReleaseTokenGuard` — and there is no OAuth2
client-credentials flow and no machine JWT (conformance §2.3). Until **TASK-762** lands, the honest
position is: *tenant-facing headless administration is unsupported.*

That gap must be recorded in this README's Verification Criteria and stated in the release notes; it
must not be discovered by an integrator.

---

## 3. Prior decisions — refinement, not reversal

TASK-708 §6 asked whether to close the API-key gap on `/admin/*` and `/internal/*`. The owner
answered:

> *"Lets review, suggest best practices. We cannot mix the `/admin/*` and `/internal/*` routes as
> they was design for different purposes."*

That ruling is about **mixing the two mechanisms**. It says a service token must not be pressed into
service on admin routes, and admin's narrowing mechanism must not be applied to internal routes. It
does **not** say admin must accept API keys. TASK-708's implementation chose scope-narrowing as its
reading of "best practices" (§7 Task 4); **A2 narrows further along the same axis and honours the
non-mixing rule exactly** — `/internal/*` keeps `@Public()` + `X-Service-Token` and is untouched, and
no service token is introduced anywhere under `/admin/*`.

**This is a refinement, not a reversal.** TASK-762's future machine credential must likewise be its
own credential class (`svc:*` namespace, short-lived tokens) — **not** a reuse of the tenant API key
and **not** `X-Service-Token`.

Per the conformance review's own instruction (§3.1, closing line): *"Do not silently overwrite
TASK-708/742's record — append the decision."* TASK-742 has no directory of its own; its record is
§8 of `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md`. Step 6 below appends there.

---

## 4. Implementation Plan

Ordered. **TASK-756 lands first** — it closes the escalation path independently, so if A2 is ever
paused the platform is not left with the original hole.

### Step 1 — Mark the `admin:*` and `webhook:*` families reserved (`packages/applications`)

Add `reserved?: true` to `ScopeDefinition` (`apikey-scopes.registry.ts:1-4`) and set it on all
**56** `admin:`-prefixed entries — `:39-47`, `:80-134`, **and `admin:*` at `:152`** — plus
`webhook:event:read`/`webhook:event:write` (`:50-51`) and `webhook:*` (`:153`).

`'*'` (`:155`) is **not** marked reserved: it is the platform SERVICE_ACCOUNT wildcard for
`/internal/*` (`SttInternalController`) and remains legitimate there. It becomes inert on admin by
`@ForbidApiKey()` alone, which is precisely the property §2.1 establishes.

Filter reserved entries out of `getScopesByCategory()` (`:169-176`) and `getAvailableScopes()`
(`:162-167`). Leave `isValidScope` (`:158-160`) alone — a stored reserved scope must still validate
as a known string, or existing keys become unreadable.

### Step 2 — Refuse reserved scopes at grant time

- **create:** new `NoReservedScopesConstraint` alongside `ValidScopesConstraint` on
  `dto/apikey-create.request.ts:22`. Rejects any reserved scope in the array.
- **update:** keep the membership-only `ValidScopesConstraint` on `dto/apikey-update.request.ts:23`;
  add the **delta** check to `ApiKeyService.update()` (`apikey.service.ts:514`), before
  `this.updateEntity(...)` at `:529` — reject only scopes present in `request.scopes` and absent
  from the stored `apiKey.scopes`. A `PATCH` that omits `scopes` performs no check at all
  (§2.5 explains why this split is forced, not stylistic).

### Step 3 — Invert the two boot audits

- `apps/api/src/bootstrap/admin-scope-audit.ts` — rewrite `ADMIN_SCOPED_CONTROLLERS` (`:98-163`) so
  every entry expects `'FORBID'`, and **add the two missing controllers** from §2.3 plus
  `ConsentGrantController` — **67 entries** (65 changed + `AdminImpersonationController` +
  `ConsentGrantController`). Update the audit's throw message and its TASK-708 doc header.
- `apps/api/src/bootstrap/api-key-surface-audit.ts` — add a second, mechanical rule to the walk in
  `auditEveryApiKeyReachableRouteDeclaresScopes` (`:59-118`): if `readControllerPath(...)` (`:75`)
  starts with `admin/` **and** the route resolves a non-empty `API_KEY_REQUIRED_SCOPES`, push an
  offender and **fail the boot**. This is the guard that survives new controllers, which a static
  list cannot.

Both audits are already wired (`apps/api/src/main.ts:309`, `:318`); no wiring change.

> **Overlap with TASK-761 (deliberate).** TASK-761 owns the general API-plane conformance gate family
> (`admin ⇒ no @RequiredScopes`, `internal ⇒ service-token guard`, `business ⇒ scopes or a justified
> `@ForbidApiKey()`). This step implements the first of those rules because A2 cannot ship without
> it — a 65-controller sweep with no mechanical guard regrows within a sprint. Whichever ticket lands
> first owns the code; the second absorbs the overlap and records it rather than re-implementing.

### Step 4 — Apply `@ForbidApiKey()` to all 65

One class-level swap each: delete `@RequiredScopes('…')`, add `@ForbidApiKey()`. Remove the now-unused
`RequiredScopes` import where it is the last use in the file; leave every `@Authorize`/`@CanXxx`
decorator, every `// AUTH-NOTE:` marker and every service-level imperative gate untouched — a route
must still carry a permission decorator or the deny-by-default boot audit fails
(`admin-route-permission-audit.ts`).

### Step 5 — Repair the two broken e2e specs

- `api-key-auth.spec.ts` — replace the `/api/v1/admin/tenants` probe (`:136,146,157,183,226,262`)
  with a business-plane route that legitimately accepts a seeded key, e.g.
  `GET /api/v1/audio/transcription-jobs` (`stt:transcription:write`) or
  `GET /api/v1/consultations` (`consultation:session:write`). The spec is about header variants,
  revocation and expiry — the probe route is incidental to what it proves.
- `task-708-apikey-scope-contract.spec.ts` — rewrite Half 2 (`:209-260`) from *"the right scope
  reaches `/admin/tenants`"* to *"**no** credential reaches `/admin/tenants`, including `'*'`"*, and
  move the surviving positive scope-narrowing assertion to a business-plane route.
- `api-key-owner-scope.spec.ts` — **no change**; it is JWT-only (§2.8).

### Step 6 — Append the decision record

Append **one** Change History row to
`docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` (the TASK-742 record lives in its
§8). The row must state: A2 supersedes TASK-708 Task 4's scope-narrowing on `/admin/*`; the §6 owner
answer is honoured, not reversed (§3 above); the `admin:*`/`webhook:*` scopes are **reserved, not
deleted**; and there is no machine path to admin until TASK-762. **Do not edit §7 or §8 in place** —
they are the historical record of what was decided when.

### Step 7 — TDD test list

| # | File | RED assertion (must be observed failing first) |
|---|---|---|
| T1 | `packages/applications/src/services/apiKey/__tests__/apikey-scopes.registry.test.ts` *(new or extended)* | Exactly 56 entries carry `reserved: true` in the `admin:` family **including `'admin:*'`**, plus the 3 `webhook:` entries; `'*'` is **not** reserved. RED: the field does not exist. |
| T2 | same file | `getScopesByCategory()` returns no reserved entry and no `Admin` category at all; `isValidScope('admin:tenant:write')` still returns `true`. RED: the catalog still lists all 55 Admin entries. |
| T3 | `packages/applications/src/services/apiKey/__tests__/valid-scopes.validator.test.ts` *(existing)* | `NoReservedScopesConstraint.validate(['admin:tenant:write'])` → `false`; `(['consultation:session:read'])` → `true`. RED: the constraint does not exist. |
| T4 | `packages/applications/src/services/apiKey/__tests__/apikey.service.test.ts` *(existing)* | `update(id, { scopes: [...stored, 'admin:*'] })` rejects; `update(id, { scopes: stored })` (unchanged array, e.g. a rename `PATCH`) **resolves**; `update(id, { keyName: 'x' })` resolves without touching scopes. RED: all three resolve pre-fix — the second and third are the over-tightening guards. |
| T5 | `apps/api/src/bootstrap/__tests__/admin-scope-audit.test.ts` *(existing)* | With the real controller classes, `auditAdminScopedControllers()` throws while any of the 65 still carries `@RequiredScopes`, and passes once all carry `@ForbidApiKey()`. RED: passes today for the wrong reason (it asserts the scopes are present). |
| T6 | `apps/api/src/bootstrap/__tests__/api-key-surface-audit.test.ts` *(existing)* | A synthetic `@Controller('admin/thing')` class carrying `@RequiredScopes('admin:thing:manage')` makes `auditEveryApiKeyReachableRouteDeclaresScopes` **throw**; the same class with `@ForbidApiKey()` passes; a non-admin prefix with `@RequiredScopes` still passes. RED: all three pass today — the first must not. |
| T7 | `apps/api/src/modules/*/__tests__/*.controller.test.ts` | Spot-check the highest-risk classes against the **real** `UnifiedAuthGuard` + `Reflector` (the pattern `stt-internal.controller.scope.test.ts` established): `ApiKeyController`, `RolesController`, `PoliciesController`, `TenantController`, `GlobalSettingController`, `WebhookController` — a key with `'*'` is **denied**. RED: `'*'` is permitted today via `hasScope`'s wildcard. |
| T8 | `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` | New Half: `GET /api/v1/admin/tenants` with the correctly-scoped key → **403**; with the seeded `'*'` SERVICE_ACCOUNT key → **403**; with a tenant-admin JWT → **200**. RED: the first two return 200 pre-fix. |
| T9 | `apps/api/tests/e2e/api-key-auth.spec.ts` | Rewritten probe route still proves header variants / revocation / expiry. Not a RED test — the regression guard that Step 5 did not weaken the spec's actual subject. |

---

## 5. Verification Criteria

- [ ] RED observed and recorded for T1–T8 before implementation.
- [ ] `pnpm --filter @arcaai/applications build test typecheck lint` — green; no NEW lint warnings
      (record the pre-existing count).
- [ ] `pnpm --filter @arcaai/api build test typecheck lint` — green.
- [ ] Compiled-metadata sweep of all 605 routes: **0** `admin/`-prefixed routes resolve a non-empty
      `API_KEY_REQUIRED_SCOPES`; the `@ForbidApiKey()` count rises by 386 handlers.
- [ ] Real boot (`node dist/main.js`) against local dev infra — all boot audits pass (including both
      inverted ones), `GET /api/v1/health` → 200.
- [ ] Live e2e: `pnpm test:up:api` then `pnpm test:e2e` for `task-708-apikey-scope-contract.spec.ts`,
      `api-key-auth.spec.ts` and `api-key-owner-scope.spec.ts` — all green **against a running
      server**. TASK-708 recorded three consecutive executions that claimed completion without this;
      a `playwright test --list` or a type-check is not evidence.
- [ ] `apps/admin-console` smoke pass — every admin screen still loads (it was already JWT-only, so a
      regression here means something other than A2 broke).
- [ ] `packages/agentic-sdk-v2/README.md` updated: the four admin hooks require a JWT; `apiKey`
      credentials no longer reach `/admin/*`.
- [ ] `docs/architecture/api-controller-inventory.md` and `api-controller-groupings.md` updated — 65
      rows move from *JWT + API key* to *JWT only*; the §2 handler-auth split recomputed.
- [ ] TASK-708 README carries the appended Change History row (Step 6), with §7/§8 unedited.
- [ ] **TASK-762 (machine identity) resolved or an explicit owner deferral recorded here** before
      this ticket closes. TASK-762 is currently **Blocked — requires owner decision**; §2.9 must not
      ship as an undocumented surprise.
- [ ] This README's §6 replaced with real command output.

---

## 6. Implementation Summary

**pending** — no code has been written. This document is the plan only.

---

## 7. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-18 | Ticket created. Claims conformance rule **A2** (`api-design-conformance-review.md` §2.2, §3.1 step 2, §4 order 4). Full 65-controller list derived independently from the inventory summary table; handler total **386** reconciles exactly with the conformance scorecard. Evidence re-verified against the live tree; four corrections recorded: (a) the `@ForbidApiKey()`-before-scopes ordering is `unified-auth.guard.ts:319` vs `:336`, not `:365` (§2.1); (b) only 55 of the 56 `admin:` scopes fall in `apikey-scopes.registry.ts:37-134` — `admin:*` is at `:152` and a range-based reservation pass would miss it (§2.4); (c) `ADMIN_SCOPED_CONTROLLERS` polices 63 of 65 — `KnowledgeController` and `WorkflowSandboxRunController` are absent (§2.3); (d) `api-key-owner-scope.spec.ts` is JWT-only and does **not** break, so the breakage set is two specs, not three (§2.8). Also corrected the machine-identity cross-reference: sibling sessions authored TASK-754…762 concurrently from the same review, and machine identity is **TASK-762** (Blocked — owner decision), not TASK-758 (which is A1). Ownership boundaries against TASK-758/759/761 recorded in the header note and §4 Step 3. Status: Pending. | Ticket-authoring agent |
