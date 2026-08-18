# TASK-758 — Business-Plane Auth Model (A1) with a Narrow Exemption List

| | |
|---|---|
| **Status** | Completed |
| **Owner** | Platform / Architecture |
| **Date** | 2026-08-18 |
| **Type** | refactor (auth posture) + docs |
| **Related** | [api-design-conformance-review.md](../../architecture/api-design-conformance-review.md) §2.4, §3.3 · [api-controller-inventory.md](../../architecture/api-controller-inventory.md) · [api-controller-groupings.md](../../architecture/api-controller-groupings.md) · **TASK-757** (A2 — admin plane JWT-only; owns `ConsentGrantController` + `AdminImpersonationController`) · **TASK-759** (plane taxonomy — owns `MonitoringController` + `ApiHealthController` `/services`) · **TASK-756** (privilege ceiling on API-key minting — hard prerequisite) · TASK-708 (API-key scope verification) · TASK-742 (API-key fail-closed default + boot audits) |

---

## Requirement Analysis

### The rule

Policy **A1** (`api-design-conformance-review.md` §0): *non-`admin` (business) routes carry the auth model **JWT + API key***. The point is developer reach — an integrator holding a scoped tenant API key should be able to drive the platform's business capabilities (transcribe, summarize, run a consultation, read their own usage) without a human session.

Its counterpart **A2** (`admin` routes ⇒ JWT only) is TASK-757. The two tickets together define the credential class per plane; neither may be applied without the other, or the platform ends up with a plane that is both admin-shaped and key-reachable.

### What is actually non-conformant

18 controllers / **69 handlers** on the business plane currently declare `@ForbidApiKey()`. Verified derivation: the inventory's summary table has **20** rows whose *API key* column reads `forbidden`; two of them (`ConsentGrantController` 3 handlers, `AdminImpersonationController` 1 handler) sit under an `admin/` prefix and therefore belong to TASK-757's scope. `20 − 2 = 18` controllers, `73 − 4 = 69` handlers — which is exactly the count the conformance scorecard reports.

### The nuance that decides the shape of this ticket

**Applying A1 blanket would open personal and biometric surfaces to long-lived static credentials.** A tenant API key has no MFA, no session expiry, and no revocation-on-logout; §2.2 of the review makes that argument for the admin plane, and it applies with more force to a clinician's voice biometrics and personal writing model than it does to a tenant settings row.

So A1 ships as **default-convert with a narrow, documented exemption list**, and every retained `@ForbidApiKey()` carries an inline justification using the existing `// AUTH-NOTE:` marker convention (`05-nestjs-api.md` §Imperative Privilege Checks). Today's `@ForbidApiKey()` comments are *not* that — see Current State §3.

### The `me` semantics decision (must be documented, not just implemented)

`UnifiedAuthGuard.handleApiKeyAuth` sets the CLS principal from the key's bound user:

```ts
// packages/applications/src/authorization/unified-auth.guard.ts:338-345
request['apiKey'] = apiKeyEntity;
if (apiKeyEntity.userId) {
  this.cls.set('user', { id: apiKeyEntity.userId, tenantId: apiKeyEntity.tenantId } as any);
}
if (apiKeyEntity.tenantId && !this.cls.get('tenantId')) {
  this.cls.set('tenantId', apiKeyEntity.tenantId);
}
```

Therefore **`/user/me/*` under an API key resolves to the KEY'S BOUND USER — not to the tenant, and not to "whoever the integrator meant".** This is correct behaviour and must stay, but today it is undocumented anywhere a caller can see it. The precedent surface proves the gap: `UserPreferencesController` is *already* JWT + API key (`user:preferences:write`) and its Swagger text is the bare `@ApiOperation({ summary: 'Get current user preferences' })` (`user-preferences.controller.ts:23-24`) — "current user" is exactly the ambiguity. The first integrator will read `me` as "my tenant".

**Decision to document in the OpenAPI `description` of every `/user/me/*` route (and the `users/:id/roles` self-check route):** under API-key auth, `me` = the user the key is bound to; an unbound `SERVICE_ACCOUNT` key cannot use these routes at all (`enforceApiKeyAbilities` refuses a key with no `userId` on any permissioned route — `unified-auth.guard.ts:465-476`).

The corollary, which is a *different* resolution and needs its own sentence: the bare "mine" surfaces (`billing`, `usage`, `entitlements`, `tenant`) resolve to the key's **tenant**, via the second CLS assignment above.

### Out of scope

| Excluded | Why | Owner |
|---|---|---|
| `MonitoringController` | administrative capability on a business prefix — not a business route at all | TASK-759 |
| `ApiHealthController` `/services`, `/services/:serviceKey` | ops telemetry behind CASL on a public health prefix | TASK-759 |
| `ConsentGrantController`, `AdminImpersonationController` | `admin/`-prefixed; A2 already forbids keys there | TASK-757 |
| Compat surfaces (`api/stt`, `api/smr/api/v1`) | policy A3 — dedicated deprecation ticket | — |
| The privilege ceiling on `ApiKeyService.create()`/`update()` | prerequisite security fix, not A1 | **TASK-756** / review §3.1 step 1 |

---

## Current State Evaluation

All file:line evidence below was opened and verified on 2026-08-18 against the working tree.

### 1. The 18 business controllers — CONVERT / EXEMPT

Handler counts are decorator recounts of the source files and sum to 69.

| # | Controller | File | Prefix (`api/v1/…`) | Handlers | Action | Reason |
|---|---|---|---|---:|---|---|
| 1 | `DnaWritingStyleController` | `src/modules/dna-writing-style/dna-writing-style.controller.ts:52-63` | `dna-writing-styles` | 14 | **EXEMPT** | Personal clinician writing model. Owner/doctor checks live in the service (`:269`, `:294` carry `AUTH-NOTE`s), so the CASL decorator understates the gate — a static credential would inherit a principal's private model. |
| 2 | `AuthController` | `src/modules/auth/auth.controller.ts:84-91` | `auth` | 7 (5 JWT, 2 `@Public()` at `:151`, `:795`) | **EXEMPT** | Credential-issuing plane. A key authenticating `logout`/`refresh`/`me`/`stream-ticket` is circular, and `stream-ticket` mints the SSE/WS tickets the whole streaming posture rests on. |
| 3 | `ApiHealthController` | `src/modules/health/health.controller.ts:53-63` | `health` | 6 (4 `@Public()`, 2 CASL) | **DEFER → TASK-759** | Not a business surface: 4 public probes + 2 ops-telemetry routes gated `@CanAny(['manage','all'],['read','TenantTelemetry'])` (`:204`, `:244`). |
| 4 | `AiInferenceController` | `src/modules/ai-inference/ai-inference.controller.ts:48-58` | `ai` | 5 | **CONVERT** | Guardrail + NLP proxy — a core AI capability an integrator legitimately calls headlessly. |
| 5 | `PromptTemplateController` | `src/modules/prompt-management/prompt-template.controller.ts:37-47` | `prompt-templates` | 5 | **CONVERT (guarded)** | Clinician plane. Three routes are WRITES declared with `read:PromptTemplate` and ownership enforced in the service (`AUTH-NOTE` at `:90`) — the scope must not widen that; see Plan step 4. |
| 6 | `VoiceProfileController` | `src/modules/voice-profile/voice-profile.controller.ts:30-40` | `voice-profile` | 5 | **EXEMPT** | Voice biometrics. Enrolment audio is a biometric identifier; no static-credential path. |
| 7 | `MonitoringController` | `src/modules/monitoring/monitoring.controller.ts:19-29` | `monitoring` | 4 | **DEFER → TASK-759** | `@CanAny(['manage','all'],['read','TenantTelemetry'])` (`:17`) — administrative, wrong prefix. |
| 8 | `AudioPipelinePublicController` | `src/modules/pipeline/audio-pipeline-public.controller.ts:8-19` | `audio/pipelines` | 3 | **CONVERT** | Read-only ASR pipeline catalog for clinicians; pairs with the already-keyed `stt:*` surfaces. |
| 9 | `ChangelogController` | `src/modules/changelog/changelog.controller.ts:23-34` | `changelog` | 3 | **CONVERT** | Reader plane, `@Authorize()` (any authenticated user). |
| 10 | `MyBillingController` | `src/modules/billing/my-billing.controller.ts:26-36` | `billing` | 3 | **CONVERT** | Tenant self-service invoice reads; `read:Tenant`, 404-over-403 on a foreign invoice. |
| 11 | `MyTenantController` | `src/modules/tenant/my-tenant.controller.ts:21-32` | `tenant` | 3 | **CONVERT** | Tenant self-read + one `update:Tenant` PATCH. |
| 12 | `PermissionCheckController` | `src/modules/rbac/permission-check.controller.ts:17-27` | `rbac/check` | 3 | **CONVERT** | Permission introspection; other-user checks already require `manage:User`. |
| 13 | `MyUsageController` | `src/modules/admin-usage/my-usage.controller.ts:18-28` | `usage` | 2 | **CONVERT** | Usage reads, no `tenantId` override. |
| 14 | `UserSettingsController` | `src/modules/user/controllers/user-settings.controller.ts:29-40` | `user/me/settings` | 2 | **CONVERT** | Direct sibling of the already-keyed `UserPreferencesController` (`user-preferences.controller.ts:12,16`). |
| 15 | `MyEntitlementsController` | `src/modules/entitlements/my-entitlements.controller.ts:18-28` | `entitlements` | 1 | **CONVERT** | Entitlement ceiling read; an integrator needs it to know its own limits. |
| 16 | `MyTenantContextSchemaController` | `src/modules/consultation-context-schema/consultation-context-schema.controller.ts:173-184` | `tenant/me/context-schema` | 1 | **CONVERT** | Schema discovery — without it an integrator cannot build a valid consultation-context payload. |
| 17 | `UserDepartmentsMeController` | `src/modules/user/controllers/user-departments-me.controller.ts:16-27` | `user/me/departments` | 1 | **CONVERT** | `me` surface; carries the `me`-semantics note. |
| 18 | `UserRolesController` | `src/modules/user/controllers/user-roles.controller.ts:23-34` | `users` | 1 | **CONVERT** | `:id` must equal the caller — effectively a `me` route on a plural prefix. |

**Totals:** CONVERT **13 controllers / 33 handlers** · EXEMPT **3 controllers / 26 handlers** · deferred to TASK-759 **2 controllers / 10 handlers**. `33 + 26 + 10 = 69`.

Adjacent, listed for completeness because §3.3 of the review names it in the exemption table:

| Controller | File | Prefix | Handlers | Note |
|---|---|---|---|---:|
| `ConsentGrantController` | `src/modules/consent/consent.controller.ts:23-34` | `admin/consent-grants` | 3 | **EXEMPT — human-only consent decisions (PHI posture).** It is `admin/`-prefixed, so **TASK-757 already forbids keys there**; this ticket only records the *reason*, so the `AUTH-NOTE` survives any future move of the route off `admin/`. |
| `AdminImpersonationController` | `src/modules/auth/admin-impersonation.controller.ts:69-71` | `admin/users` | 1 | TASK-757. Already carries a hand-written rationale block (`:55-68`), not the TASK-742 boilerplate. |

### 2. The mechanism is already in place; only the declarations change

- `@ForbidApiKey()` is evaluated **before** scopes: `handleApiKeyAuth` calls `enforceApiKeyNotForbidden(context)` at `unified-auth.guard.ts:319`, ahead of `enforceApiKeyScopes` at `:336`; the method's own doc at `:366` states *"BEFORE scopes (a forbidden route has no scope that could rescue it)"*.
- Converting is therefore a one-decorator swap per controller: `@ForbidApiKey()` → `@RequiredScopes('<scope>')`, class-level (TASK-708 Task 4 applied scopes coarse-grained per controller — `admin-scope-audit.ts:14-19`).
- The conversion **cannot widen authorization**. `enforceApiKeyAbilities` (`unified-auth.guard.ts:450`) re-evaluates the route's own `@Authorize`/`@CanXxx` metadata against the key's bound user with the same AND/OR mode as the JWT path (`:476-509`); scope and ability are a conjunction. A key with no `userId` is refused outright on any permissioned route (`:465-476`).
- Declaration is boot-enforced: `api-key-surface-audit.ts:1-19` fails boot unless every route is `@Public()`, `@RequiredScopes(...)`, or `@ForbidApiKey()`. So there is no "forgot to declare" failure mode — only a "declared the wrong thing" one, which is what the exemption list and its `AUTH-NOTE`s exist to make reviewable.

### 3. Today's `@ForbidApiKey()` is a placeholder, not a decision — this is the key finding

15 of the 18 (and `ConsentGrantController`) carry a **verbatim, copy-pasted** block, e.g. `voice-profile.controller.ts:31-38`:

```
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: voice enrolment; ownership-checked but with no dedicated scope, and reached today by the browser SDK over JWT.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
```

Two consequences:

1. **The current `@ForbidApiKey()` posture is not evidence of intent.** It is TASK-742's fail-closed default for routes that declared *nothing*. This ticket is the "owner classification" that block explicitly defers to — so A1 is not reversing a decision, it is supplying the missing one.
2. **The marker is `API-KEY-NOTE`, not `AUTH-NOTE`.** Only `AuthController` (`:85-89`) and `AdminImpersonationController` (`:55-68`) carry hand-written reasoning instead of the boilerplate. Consolidating on the `// AUTH-NOTE:` marker (per §3.3 of the review and `05-nestjs-api.md`) is part of this ticket; it also removes the ticket-id prefix, which the pre-release cleanup already stripped from code comments everywhere else.

### 4. Scope vocabulary — what exists and what is missing

`packages/applications/src/services/apiKey/apikey-scopes.registry.ts:6-152`, grammar `<area>:<resource>:<action>`:

- Business families present: `stt:*` (`:8-11`), `tts:*` (`:20-21`), `consultation:*` (`:24-27`), `user:*` — `user:profile:read`, `user:preferences:read`, `user:preferences:write` (`:30-32`), `media:*` (`:35-36`), `workflow:*` (`:138-140`).
- **`user:profile:read` exists and is currently declared by no controller** — an already-registered, unused scope that fits several `me` surfaces.
- No scope exists for: AI inference proxy, prompt templates (clinician plane), pipeline catalog, changelog, billing/usage/entitlements self-reads, tenant self-read, RBAC check, user settings, tenant context schema.
- **Prefix matching is live:** `apikey.service.ts` `hasScope` treats a bare parent as granting all children and `'*'` as granting everything (registry comment at `:135-137`; review §3.1). So an existing key holding `user:*` will *automatically* gain any new `user:…` scope this ticket registers. That is a real reachability change for already-issued keys and belongs in the ticket's consumer-impact note.

### 5. Consumers

- **`apps/admin-console`** reaches these routes through the BFF proxy with `Authorization: Bearer` only, so conversion changes nothing for it. Live callers verified: `shared/data/grid-persistence.ts:56,104` (`GET user/me/settings`, `PATCH user/me/settings/<ns>/<key>`).
- **`@arcaai/vox`** documents an `apiKey` credential path (`packages/agentic-sdk-v2/README.md:68,294`). A1 *widens* what that path reaches; it breaks nothing.
- **`@arcaai/vox-node`** is API-key-only (`X-API-Key`) and is the primary beneficiary — it currently cannot reach any of the 13 CONVERT controllers.
- **No e2e spec asserts a 403 on the CONVERT set.** The `@ForbidApiKey()` assertions in `tests/e2e/task-708-apikey-scope-contract.spec.ts` (half 4) are written against the *default*, so the spec needs a re-point, not a rewrite — see Plan step 7.

### 6. Discrepancies found while verifying

| # | Discrepancy | Where |
|---|---|---|
| D-1 | Review §2.2 cites `unified-auth.guard.ts:365` for the ordering claim and `:448-505` for `enforceApiKeyAbilities`. Verified positions: call sites `:319` / `:336` / `:350`, method definitions `:370` / `:398` / `:450`, ordering comment `:366`. The claims hold; the line numbers have drifted. | `api-design-conformance-review.md` §2.2 |
| D-2 | Review §2.2 cites `apikey-scopes.registry.ts:37-134` for the 56 `admin:*` scopes. Verified: the registry opens at `:6` and the `admin:` entries span `:39`–`:152` (`admin:*` wildcard). The count of 56 is correct. | same |
| D-3 | `conformance/gateway-and-sdk.md` §6.3 states *"the API-key path never evaluates CASL"*. TASK-742 changed that — `enforceApiKeyAbilities` (`unified-auth.guard.ts:450`) now does. The A1 risk analysis must use the post-742 behaviour, not §6.1's. | `docs/architecture/agentic-workflow-platform/conformance/gateway-and-sdk.md:219-227` |
| D-4 | Inventory's per-controller catalog marks `GET /api/v1/health/services` as *"no ForbidApiKey"* while the class carries it at `health.controller.ts:62`. Both are true (the column reports the *method-level* decorator; Nest class metadata still applies), but the phrasing reads as a contradiction of the same file's summary row. | `api-controller-inventory.md:936-937` vs `:112` |
| D-5 | `DnaWritingStyleController`'s SSE handler (`:337`) has no `@StreamScope`, so a `?ticket=` will 401 (noted in the inventory). Irrelevant to A1 only because the controller is EXEMPT — record it so a future un-exemption does not inherit a broken stream. | `dna-writing-style.controller.ts:337` |

---

## Implementation Plan

Ordered. TDD throughout — each step's RED assertion is stated so it is verifiable that the test failed first.

### Step 1 — Prerequisite gate (no code)

Confirm **TASK-756** (privilege ceiling on `ApiKeyService.create()`/`update()` — reject scopes the calling principal does not itself hold) has landed. Without it, every scope this ticket registers is mintable by any holder of `manage:ApiKey`, and A1 becomes a scope-minting surface rather than a reach-widening one. Do not start step 4 until this is green.

### Step 2 — Record the exemption decision (docs only)

Append to this README a signed-off exemption table (the four rows of §3.3 plus `ConsentGrantController`'s cross-reference to TASK-757). Update `api-controller-inventory.md` §1 so the "Human-only (not API-key reachable)" paragraph lists the *reasoned* exemptions rather than describing the TASK-742 default.

### Step 3 — RED: pin the exemption list as a boot-time contract

- **New test:** `apps/api/src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts`
- **RED assertion:** `expect(BUSINESS_PLANE_KEY_FORBIDDEN).toEqual(new Set(['AuthController','VoiceProfileController','DnaWritingStyleController']))` — fails because the constant does not exist.
- **GREEN:** add `BUSINESS_PLANE_KEY_FORBIDDEN` to `apps/api/src/bootstrap/api-key-surface-audit.ts` and a check that fails boot when a **non-`admin/`-prefixed** controller carries `@ForbidApiKey()` without being in the set. This mirrors `RESERVED_INTERNAL_SCOPE_CONTROLLERS` (`api-key-scope-audit.ts:169`) — a policed exemption, not a hole.
- **Second RED in the same file:** `expect(() => audit(appWithUnlistedForbiddenBusinessController)).toThrow(/business-plane .* @ForbidApiKey/)`.

### Step 4 — RED: register the new scopes

- **Test:** extend `packages/applications/src/services/apiKey/__tests__/` (or add `apikey-scopes.registry.test.ts` if absent).
- **RED assertion:** `expect(Object.keys(API_KEY_SCOPE_REGISTRY)).toEqual(expect.arrayContaining([...NEW_SCOPES]))` — fails on every new key.
- **GREEN:** register, following the existing `<area>:<resource>:<action>` grammar and reusing an existing scope wherever one fits (do **not** grow the registry for its own sake — `workflow-sandbox-run.controller.ts:23-26` is the in-repo precedent for reuse):

  | Controller(s) | Scope |
  |---|---|
  | `AiInferenceController` | `ai:inference:write` (new; `ai:*` wildcard) |
  | `PromptTemplateController` | `prompt:template:read` (new) — **read-shaped on purpose**: the three writes are owner-gated in the service, and `enforceApiKeyAbilities` re-checks the declared `read:PromptTemplate`, so the key never gains more than the bound clinician has |
  | `AudioPipelinePublicController` | reuse `stt:model:read` (`registry:11`) — it is the ASR-pipeline catalog |
  | `ChangelogController` | `platform:changelog:read` (new) |
  | `MyBillingController`, `MyUsageController`, `MyEntitlementsController` | `tenant:account:read` (new) — one scope, three read-only self-service surfaces |
  | `MyTenantController` | `tenant:profile:read` + `tenant:profile:write` (new; PATCH is `update:Tenant`) |
  | `MyTenantContextSchemaController` | `tenant:context-schema:read` (new) |
  | `PermissionCheckController` | reuse `user:profile:read` (`registry:30`, currently unused) |
  | `UserSettingsController` | `user:settings:read` + `user:settings:write` (new; sibling of `user:preferences:*`) |
  | `UserDepartmentsMeController`, `UserRolesController` | reuse `user:profile:read` |

  Add the `ai:*` and `tenant:*` wildcards to the Wildcards block for symmetry with `stt:*`/`user:*`.
  **Record in the ticket:** existing keys holding `user:*` or `tenant` gain the new `user:…`/`tenant:…` scopes by prefix match the moment they are registered.

### Step 5 — RED then GREEN: convert the 13 controllers, one at a time

Per controller, in the order of the §1 table (smallest surface first is fine; the order does not matter because they are independent):

- **RED:** in `apps/api/tests/e2e/task-758-business-plane-apikey.spec.ts`, assert a key **holding** the new scope reaches the handler (a downstream 200/404, never the `enforceApiKeyScopes` 403 shape) — fails today with `"This route does not accept API-key authentication"`.
- **RED (companion):** assert a key **without** the scope gets the exact `enforceApiKeyScopes` 403 message shape — reuse the assertion helpers already in `tests/e2e/task-708-apikey-scope-contract.spec.ts`.
- **GREEN:** swap `@ForbidApiKey()` → `@RequiredScopes('<scope>')` at class level, delete the TASK-742 boilerplate block, leave the `@Authorize`/`@CanXxx` decorators untouched.

### Step 6 — RED then GREEN: the three exemptions keep their gate, with a real reason

- **RED:** `apps/api/src/modules/**/__tests__/*.apikey-forbidden.test.ts` (or one consolidated `apps/api/src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts` case) asserting `Reflect.getMetadata(API_KEY_FORBIDDEN, AuthController) === true` for all three — passes immediately, so pair it with the source-text assertion below to get a real RED.
- **RED:** assert each of the three files contains `// AUTH-NOTE:` above `@ForbidApiKey()` — fails today (they carry `TASK-742 API-KEY-NOTE` boilerplate, or in `AuthController`'s case an unmarked `TASK-742:` block).
- **GREEN:** replace each block with a one-marker justification, e.g.

  ```ts
  // AUTH-NOTE: voice biometrics. Enrolment audio is a biometric identifier, so this
  // surface is deliberately excluded from policy A1's JWT + API-key default — a
  // long-lived static credential must never enrol or read a voice profile. JWT only.
  @ForbidApiKey()
  ```

### Step 7 — RED then GREEN: re-point the stale `@ForbidApiKey()` e2e assertion

`tests/e2e/task-708-apikey-scope-contract.spec.ts` half 4 asserts the TASK-742 default against *"an `@ForbidApiKey()` route"*. If that route is one of the 13 CONVERT controllers the spec goes red on step 5.

- **RED:** it already will be, once step 5 lands — that is the signal, not a failure to work around.
- **GREEN:** re-point the assertion at `VoiceProfileController` (a *reasoned* exemption that will not move again) and add a comment naming TASK-758 as the reason the route changed.

### Step 8 — GREEN: the `me` semantics in OpenAPI

Add an `@ApiOperation({ description })` sentence to **every** route on these five controllers — including `UserPreferencesController`, which is already keyed and is the surface that proves the ambiguity:

- `UserPreferencesController` (`user/me/preferences`, 2)
- `UserSettingsController` (`user/me/settings`, 2)
- `UserDepartmentsMeController` (`user/me/departments`, 1)
- `UserRolesController` (`users/:id/roles`, 1)
- `MyTenantContextSchemaController` (`tenant/me/context-schema`, 1)

Standard sentence:

> Under API-key authentication, `me` resolves to the **user the key is bound to** — never to the key's tenant. A `SERVICE_ACCOUNT` key with no linked user cannot call this route (403).

And, on `MyBillingController` / `MyUsageController` / `MyEntitlementsController` / `MyTenantController`:

> Under API-key authentication this resolves to the key's **tenant**.

- **RED:** `apps/admin-console`-style snapshot is not available for the gateway, so use a unit test — `apps/api/src/modules/user/controllers/__tests__/me-semantics-openapi.test.ts` asserting the `swagger/apiOperation` metadata `description` on each handler contains `'bound to'`. Fails on all 7 routes today.

### Step 9 — Documentation

Update `api-controller-inventory.md` (summary table + the per-controller catalog rows for all 13) and `api-controller-groupings.md` in the same commit — they are re-verified snapshots and will otherwise read as drift. Append an Implementation Summary + Change History entry here.

---

## Verification Criteria

- [ ] `pnpm api:build` and `pnpm lint` clean (lint is a hard error in `apps/api`).
- [ ] `pnpm test:unit` green, including the new bootstrap-audit and OpenAPI-metadata tests.
- [ ] `pnpm test:up:api` then `pnpm test:e2e` green, including `task-758-business-plane-apikey.spec.ts` and the re-pointed `task-708-apikey-scope-contract.spec.ts`.
- [ ] API boots. The boot audits are the acceptance gate: `api-key-surface-audit` proves every route is declared, and the new business-plane exemption audit proves no unreasoned `@ForbidApiKey()` survives outside `admin/`.
- [ ] Evidence captured: for one CONVERT controller, paste (a) the pre-change 403 body `"This route does not accept API-key authentication"` and (b) the post-change success — the RED→GREEN pair.
- [ ] Evidence captured: a key **without** the new scope still gets the `enforceApiKeyScopes` 403 — the conversion did not become a blanket grant.
- [ ] Evidence captured: a key bound to user A calling `GET /api/v1/user/me/settings` returns **A's** settings, not a tenant-wide set — the `me` decision, proven rather than asserted.
- [ ] Evidence captured: an unbound `SERVICE_ACCOUNT` key gets 403 on a `/user/me/*` route (`enforceApiKeyAbilities` fail-closed).
- [ ] Cross-tenant posture unchanged: a key from tenant X reading a tenant-Y resource still gets **404**, not 403.
- [ ] `AuthController`, `VoiceProfileController`, `DnaWritingStyleController` still 403 an API key, and each carries exactly one `// AUTH-NOTE:` above `@ForbidApiKey()`.
- [ ] `api-controller-inventory.md` and `api-controller-groupings.md` updated in the same commit; the A1 row of the conformance scorecard re-derived.

---

## Implementation Summary

**Shipped 2026-08-18.** Policy A1 applied as default-convert + a narrow, policed exemption list.
13 controllers / 33 handlers converted; 3 exempt; 2 deferred to TASK-759 and untouched.

### 1. Scope vocabulary (`packages/applications/src/services/apiKey/apikey-scopes.registry.ts`)

9 new scopes + 2 wildcards; 2 surfaces reuse existing scopes rather than growing the registry.
Every entry carries the `implies` field TASK-756 made mandatory, derived by this file's own
documented rule (the CASL pair the scope's controller declares; the resource the plane operates
on where the controller is auth-only).

| Scope | `implies` | Gates |
|---|---|---|
| `ai:inference:write` (new) | `create:Consultation` | `AiInferenceController` |
| `prompt:template:read` (new) | `read:PromptTemplate` | `PromptTemplateController` |
| `platform:changelog:read` (new) | `read:ChangelogEntry` | `ChangelogController` |
| `tenant:account:read` (new) | `read:Tenant` | `MyBillingController`, `MyUsageController`, `MyEntitlementsController` |
| `tenant:profile:read` / `:write` (new) | `read:Tenant` / `update:Tenant` | `MyTenantController` (write is METHOD-level on the PATCH) |
| `tenant:context-schema:read` (new) | `read:ConsultationContextSchema` | `MyTenantContextSchemaController` |
| `user:settings:read` / `:write` (new) | `read:UserSettings` / `update:UserSettings` | `UserSettingsController` (write is METHOD-level on the PATCH) |
| `stt:model:read` (**reused**) | — | `AudioPipelinePublicController` |
| `user:profile:read` (**reused**, previously declared by nothing) | — | `PermissionCheckController`, `UserDepartmentsMeController`, `UserRolesController` |
| `ai:*`, `tenant:*` (new wildcards) | expanded | symmetry with `stt:*` / `user:*` |

**Consumer impact — prefix matching.** `ApiKeyService.hasScope` treats a bare parent as granting
all children, so an already-issued key holding `user:*` (or the bare `user` / `tenant`) gains
`user:settings:*` and the `tenant:*` family the moment they are registered. That is existing
prefix semantics, not new behaviour, but it IS a reachability change for keys minted before this
ticket.

**Minting-side consequence of `platform:changelog:read`.** No seeded policy grants
`read:ChangelogEntry` to a tenant admin (`01-policy.ts` has no `ChangelogEntry` rule at all), so
under TASK-756's ceiling only a super admin can mint that scope today. This is fail-CLOSED and was
chosen over mapping the scope onto an unrelated ability a tenant admin happens to hold; granting
`read:ChangelogEntry` in `tenant-full-access` would fix it and is a one-line policy change, but it
widens a seeded policy and so was left as an owner decision rather than taken here.

### 2. Conversions (13 controllers / 33 handlers)

Each lost the verbatim `// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER
CLASSIFICATION` block — the classification this ticket supplies — and gained a class-level
`@RequiredScopes(...)` plus an `// API-KEY-NOTE` stating the decision. `@Authorize`/`@CanXxx`
untouched everywhere: scope and ability are a conjunction (`enforceApiKeyAbilities` re-evaluates
the route's CASL against the key's BOUND USER), so no conversion widens authorization.

| # | Controller | File | Scope |
|---|---|---|---|
| 1 | `AiInferenceController` | `ai-inference.controller.ts:54` | `ai:inference:write` |
| 2 | `PromptTemplateController` | `prompt-template.controller.ts:43` | `prompt:template:read` |
| 3 | `AudioPipelinePublicController` | `audio-pipeline-public.controller.ts:14` | `stt:model:read` |
| 4 | `ChangelogController` | `changelog.controller.ts:28` | `platform:changelog:read` |
| 5 | `MyBillingController` | `my-billing.controller.ts:39` | `tenant:account:read` |
| 6 | `MyUsageController` | `my-usage.controller.ts:30` | `tenant:account:read` |
| 7 | `MyEntitlementsController` | `my-entitlements.controller.ts:30` | `tenant:account:read` |
| 8 | `MyTenantController` | `my-tenant.controller.ts:35` (+ `:102` method-level write) | `tenant:profile:read` / `tenant:profile:write` |
| 9 | `MyTenantContextSchemaController` | `consultation-context-schema.controller.ts:186` | `tenant:context-schema:read` |
| 10 | `PermissionCheckController` | `permission-check.controller.ts:22` | `user:profile:read` |
| 11 | `UserSettingsController` | `user-settings.controller.ts:48` (+ `:74` method-level write) | `user:settings:read` / `user:settings:write` |
| 12 | `UserDepartmentsMeController` | `user-departments-me.controller.ts:33` | `user:profile:read` |
| 13 | `UserRolesController` | `user-roles.controller.ts:40` | `user:profile:read` |

**Deviation from the plan (deliberate, narrower than proposed).** Step 4 assigned one scope per
controller. `MyTenantController` and `UserSettingsController` each carry a single mutating route,
so declaring both read and write at CLASS level would have let a read-only key satisfy the write
route's scope check (OR semantics). Both instead declare the read at class level and the `:write`
scope on the mutating handler, where `getAllAndOverride([handler, class])` makes the method
declaration REPLACE the class one. Pinned by
`business-plane-apikey-exemptions.test.ts` and by the two e2e "read scope does not reach the write
route" cases.

### 3. Exemptions (3 controllers / 26 handlers) — kept, with a decision

`AuthController` (`auth.controller.ts:84-91`), `VoiceProfileController`
(`voice-profile.controller.ts:30-37`), `DnaWritingStyleController`
(`dna-writing-style.controller.ts:52-63`) keep `@ForbidApiKey()`, each with a real
`// API-KEY-NOTE — REASONED EXEMPTION` naming the reason and the audit that polices it.
`DnaWritingStyleController`'s note also carries D-5 forward: its SSE handler has no `@StreamScope`,
so a future un-exemption would inherit a broken stream.

**Deviation from the plan (owner decision, 2026-08-18).** Step 6 proposed consolidating onto the
`// AUTH-NOTE:` marker. The owner ruled afterwards that `API-KEY-NOTE` and `AUTH-NOTE` stay
DISTINCT with NO migration: `API-KEY-NOTE` = the API-key classification, `AUTH-NOTE` = rule 05's
"the decorator understates the real gate" case. Every retained `@ForbidApiKey()` therefore keeps an
`API-KEY-NOTE`, now carrying prose that states a decision instead of deferring one. The existing
`AUTH-NOTE`s (e.g. on `PromptTemplateController`'s owner-gated writes) were left exactly as they
were.

### 4. The exemption list is a boot contract

`apps/api/src/bootstrap/business-plane-apikey-exemptions-audit.ts` (wired at `main.ts:328`) fails
the boot when a NON-`admin/` route carries `@ForbidApiKey()` without being named in
`BUSINESS_PLANE_KEY_FORBIDDEN`. Mirrors `RESERVED_INTERNAL_SCOPE_CONTROLLERS` — a policed
exemption, not a hole. `BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED` tracks `MonitoringController` and
`ApiHealthController` in a SEPARATE set so "deferred to TASK-759" can never read as "reasoned
exemption"; neither file was touched by this ticket.

### 5. `me` semantics in OpenAPI

Two different resolutions behind the same `me` segment, one sentence each, on 16 routes across 9
controllers (including the already-keyed `UserPreferencesController`, the surface that proves the
ambiguity):

- `/user/me/*` and `users/:id/roles` → *"`me` resolves to the **user the key is bound to** — never
  to the key's tenant. A `SERVICE_ACCOUNT` key with no linked user cannot call this route (403)."*
- `billing` / `usage` / `entitlements` / `tenant` (incl. `tenant/me/context-schema`) → *"Under
  API-key authentication this resolves to the key's **tenant**."*

**Deviation from the plan (spec defect).** Step 8 grouped `MyTenantContextSchemaController` with
the `/user/me/*` bound-user surfaces. It is not one: `getEffectiveBundle` resolves
`requireTenantId()`, i.e. the CLS TENANT. It takes the tenant sentence; documenting it as
bound-user would have told an integrator the opposite of what the service does — the exact harm
this decision exists to prevent.

### 6. Tests

| File | What it pins |
|---|---|
| `apps/api/src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts` (new, 28 cases) | the exemption set, the audit's behaviour (unlisted controller / method-level forbid / admin plane / `@Public()`), the scope VALUE each converted controller declares, the two method-level `:write` narrowings, that the CASL declarations are unchanged, and that the exempt files carry a decision rather than the deferral boilerplate |
| `apps/api/src/modules/user/controllers/__tests__/me-semantics-openapi.test.ts` (new, 17 cases) | the `me` sentence per route, and that neither sentence is ever applied to the other group |
| `packages/applications/src/services/apiKey/__tests__/apikey-scopes.registry.test.ts` (extended) | the 9 new scopes, the 2 wildcards, and the `implies` mapping for the four that gate a tenant-owned resource |
| `apps/api/tests/e2e/task-758-business-plane-apikey.spec.ts` (new) | reach with the scope, the exact `enforceApiKeyScopes` 403 without it, read-scope-cannot-write, `me` = bound user, unbound SERVICE_ACCOUNT 403, exemptions still 403 an API key while a JWT still reaches them, cross-tenant still 404 |
| `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` (re-pointed) | half 4's `@ForbidApiKey()` example moved `/tenant/me` → `/voice-profile`, with the reason in a comment |

### 7. Verification evidence

```
$ pnpm --filter @arcaai/applications exec vitest run src/services/apiKey/__tests__/apikey-scopes.registry.test.ts
  # RED (before registering):  Tests  3 failed | 23 passed (26)
  # GREEN:                     Tests  26 passed (26)

$ pnpm --filter @arcaai/api exec vitest run src/bootstrap/__tests__/business-plane-apikey-exemptions.test.ts
  # RED (audit module absent):        Error: Cannot find module '../business-plane-apikey-exemptions-audit'
  # RED (audit present, unconverted): Tests  4 failed | 9 passed (13)
  # GREEN (after conversion):         Tests  28 passed (28)

$ pnpm --filter @arcaai/api exec vitest run src/modules/user/controllers/__tests__/me-semantics-openapi.test.ts
  # RED:   Tests  16 failed (16)
  # GREEN: Tests  17 passed (17)
```

Full-suite, build and lint (run after every change landed):

```
$ pnpm --filter @arcaai/api test          # apps/api, vitest run
 Test Files  223 passed | 2 skipped (225)
      Tests  3162 passed | 4 skipped (3166)

$ pnpm api:build
 Tasks:    12 successful, 12 total
  Time:    34.561s

$ pnpm --filter @arcaai/api lint
✖ 65 problems (0 errors, 65 warnings)      # all 65 pre-existing eslint-comments/require-description
                                           # warnings; none in any file this ticket touched

$ pnpm --filter @arcaai/applications test
 Test Files  2 failed | 506 passed | 1 skipped (509)
      Tests  2 failed | 9318 passed | 4 skipped (9324)
```

The two `@arcaai/applications` failures are PRE-EXISTING and unrelated to A1 —
`settings-registry/__tests__/fail-mode.governance.test.ts` (`internal.accessToken` descriptor,
introduced by commit `87f894bdb`) and `dna-writing-style/__tests__/dna-writing-style.processor.test.ts`
(SMR `/api/v1/generate` call shape). Neither suite imports `apikey-scopes.registry`, which is the
only non-test file this ticket changed in that package.

**Not executed here:** `pnpm test:e2e`. It needs a running gateway against the seeded test DB
(`pnpm test:up:api`), which was not available in this environment; the spec is authored and the
`task-708` re-point is a mechanical consequence of the `/tenant/me` conversion. The boot audits are
the standing acceptance gate in the meantime.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-18 | Created. Requirement analysis, current-state evaluation (18 controllers / 69 handlers derived and verified against source), CONVERT/EXEMPT classification, `me`-semantics decision, implementation plan and verification criteria. Status: Pending. No code changed. |
| 2026-08-18 | **Implemented.** 9 scopes + 2 wildcards registered (2 surfaces reuse `stt:model:read` / `user:profile:read`); 13 controllers / 33 handlers converted from `@ForbidApiKey()` to `@RequiredScopes(...)`, with `tenant:profile:write` and `user:settings:write` narrowed to the mutating handler; the 3 exemptions rewritten to state a decision under the retained `API-KEY-NOTE` marker (owner ruling: no marker migration); new boot audit `auditBusinessPlaneApiKeyExemptions` wired into `main.ts`; `me` semantics documented on 16 routes; 45 new/extended unit cases + a new e2e spec + the `task-708` re-point; inventory and groupings docs updated. Three deliberate deviations from the plan recorded in the Implementation Summary (method-level write scopes, `API-KEY-NOTE` retained over `AUTH-NOTE`, `tenant/me/context-schema` documented as TENANT-scoped). Status: Completed. |
