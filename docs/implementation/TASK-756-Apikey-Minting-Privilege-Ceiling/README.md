# TASK-756 — Privilege ceiling on API-key minting

| | | | |
|---|---|---|---|
| **Status** | Review | **Owner** | Platform / Authorization |
| **Date** | 2026-08-18 | **Type** | bugfix (security) |
| **Related** | `docs/architecture/api-design-conformance-review.md` §2.2, §3.1 step 1, §4 order 2 · `docs/architecture/agentic-workflow-platform/conformance/gateway-and-sdk.md` §6.4, §8 G1 · `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` §8.5 (deferred here, no ticket number assigned at the time) · **TASK-757** (admin plane JWT-only — consumes this ticket's fail-closed behaviour) · **TASK-762** (machine identity) |

> **Sibling tickets, authored concurrently from the same review (2026-08-18).** TASK-754…762 were
> written in parallel by separate sessions; their numbers follow the review's §4 sequencing table,
> not the order they appeared on disk. This ticket is **§4 order 2** and lands before TASK-757.

---

## 1. Requirement Analysis

`POST /api/v1/admin/api-keys` and `PATCH /api/v1/admin/api-keys/:id` accept a `scopes` array and
persist it verbatim. Nothing checks that the **calling principal already holds the ability the
requested scope implies**. A tenant admin — gated by the class-level `@CanManage('ApiKey')` on
`ApiKeyController`, *not* by SUPER_ADMIN — can mint a key carrying `admin:*` or the bare `'*'`
wildcard.

**Requirement:** reject, at mint and at update, any scope whose implied ability the calling
principal does not itself hold. Fail closed when the caller's ability cannot be determined.

**Classification:** `bugfix` (security). It is the escalation path named by two independent
reviews and deferred once already.

### Severity — stated precisely, not inflated

A real mitigation already exists and this ticket must not be written as if it did not.
`UnifiedAuthGuard.enforceApiKeyAbilities()` evaluates the route's CASL metadata against the key's
**bound user** at request time. Scope and ability are a **conjunction, never a fallback**, and an
unbound `SERVICE_ACCOUNT` key is refused outright on any permission-declaring route.

Consequently an over-granted key is **not a raw privilege delta** — a key minted with `admin:*` by
a tenant admin still cannot exceed that tenant admin's own CASL ability at request time. What
over-granting *does* create is a **long-lived static bearer credential carrying the granting
admin's full blast radius**, with none of the properties that make an interactive session
acceptable: no MFA, no session expiry, no revocation-on-logout, no impersonation audit trail, and a
value that survives in CI logs, `.env` files and integrator laptops. That is the risk this ticket
closes; it is also, verbatim, the argument for TASK-757.

### Non-goals

- Method-level read/write scope splitting on admin controllers (TASK-708 §8.5, still deferred).
- Removing API keys from the admin plane — that is **TASK-757**, sequenced after this.
- Any change to `hasScope`'s prefix/wildcard matching semantics at request time.

---

## 2. Current State Evaluation

All line numbers verified by opening the files on 2026-08-18 (branch `feat/loop`).

### 2.1 The gap itself

| Evidence | Fact |
|---|---|
| `packages/applications/src/services/apiKey/apikey.service.ts:238` | `async create(request: CreateApiKeyRequest)` |
| `…/apikey.service.ts:326` | `scopes: request.scopes ?? null` — handed straight to `ApiKeyFactory.CreateApiKey`. **No ability check anywhere above it.** |
| `…/apikey.service.ts:514` | `async update(id, request: UpdateApiKeyRequest)` |
| `…/apikey.service.ts:532` | `...(request.scopes !== undefined && { scopes: request.scopes })` — same, on the update path |

Everything `create()` *does* check is adjacent to, but not, a privilege ceiling:

| Lines | Check |
|---|---|
| `:249-254` | cross-tenant creation requires `isSuperAdmin()` |
| `:271-284` | `assertUserBelongsToTenant` — the creating user has an enabled role assignment in the key's tenant |
| `:290-294` | `maxApiKeys` entitlement quota |
| `:296-312` | max lifetime clamp |

> Conformance §6.4 cites these as `:250-254`, `:259-284`, `:290-294`, `:298-311`. The first, second
> and fourth are off by a few lines against the current tree (the blocks begin at `:249`, `:271`
> and `:296`). Corrected above; the substance is unchanged.

### 2.2 The only validation on `scopes` is membership, not entitlement

`packages/applications/src/services/apiKey/validators/valid-scopes.validator.ts:6-10`:

```ts
validate(scopes: string[], _args: ValidationArguments): boolean {
  if (!Array.isArray(scopes)) return false;
  if (scopes.length === 0) return true;
  return scopes.every((scope) => isValidScope(scope));
}
```

`isValidScope` (`apikey-scopes.registry.ts:158-160`) is `scope in API_KEY_SCOPE_REGISTRY`. The
constraint is wired onto both DTOs — `dto/apikey-create.request.ts:22` and
`dto/apikey-update.request.ts:23`. **A registry member is always accepted, regardless of who is
asking.** `'admin:*'` (`apikey-scopes.registry.ts:152`) and `'*'`
(`:155`) are registry members.

### 2.3 The blast radius the scope buys, at request time

`ApiKeyService.hasScope` (`apikey.service.ts:838-866`): `'*'` returns `true` unconditionally
(`:846-848`); a bare parent grants all children (`:856-858`); `':*'` grants the whole namespace
(`:862-864`). So `admin:*` satisfies every one of the 55 `admin:`-prefixed scopes in the `Admin`
category and the `admin:*` wildcard itself — 56 scope strings in total across the registry.

### 2.4 The mitigation, verified

- `packages/applications/src/authorization/unified-auth.guard.ts:319` —
  `enforceApiKeyNotForbidden(context)`.
- `:336` — `enforceApiKeyScopes(context, apiKeyEntity)`.
- `:350` — `await this.enforceApiKeyAbilities(context, request, apiKeyEntity, method, path)`.
- `:450-508` — `enforceApiKeyAbilities` builds the ability for `apiKeyEntity.userId`
  (`policyEngine.buildAbility`) and runs the **same** `evaluatePermissions(ability, required, mode)`
  the JWT path uses. A key with no `userId` is refused: *"This API key is not linked to a user, so
  the permissions this route requires cannot be evaluated"* (`:478`).

> Conformance §2.2 cites `unified-auth.guard.ts:448-505`. The method spans `:450-508` in the
> current tree. Corrected.

### 2.5 The mechanism a ceiling can use already exists

The compiled CASL ability is pinned to CLS by both guards —
`authorization.guard.ts:156` and `unified-auth.guard.ts:559` (`this.cls.set('userAbility', ability)`)
— and `ApiKeyService` **already reads it**:

`apikey.service.ts:1124-1128`:

```ts
private callerCanManageAllKeys(): boolean {
  if (this.isSuperAdmin()) return true;
  const ability = this.clsService.get('userAbility') as { can?: (action: string, subject: string) => boolean } | undefined;
  return !!ability && typeof ability.can === 'function' && ability.can('manage', 'ApiKey');
}
```

So no new plumbing is needed — the ceiling is the same probe, applied per requested scope.

### 2.6 The one behavioural interlock that must be stated up front

`unified-auth.guard.ts:193-196` records that on the **API-key path** the ability is deliberately
**not** published to `request.ability` / CLS `userAbility`, because several services (this one, and
`PromptManagementService`) read its absence as "not privileged". Therefore a caller who
authenticates *with an API key* and mints another key has **no** `userAbility` in CLS.

A fail-closed ceiling refuses that caller outright. That is the correct posture and it is
**consistent with where TASK-757 takes the platform** (`/admin/api-keys` becomes JWT-only, so a
JWT-issued `userAbility` is always present). It does, however, change behaviour today for exactly
one credential in the tree: the seeded `SERVICE_ACCOUNT` key with `scopes: ['*']`
(`packages/database/src/prisma/db_main/seed/02-apikey.ts:124-137`, dev/test only via
`shouldSeedApiKeys()` at `:17-19`). No production key exists — the platform is pre-launch.

### 2.7 Where this was already written down

- `docs/architecture/agentic-workflow-platform/conformance/gateway-and-sdk.md` §6.4 — named it, with
  evidence, as an open gap.
- `docs/implementation/TASK-708-Apikey-Scope-Verification/README.md` §8.5 — deferred it explicitly:
  *"§6.4's privilege ceiling on API-key minting … warrants its own ticket"* — **without assigning a
  ticket number.** This ticket claims it.
- `docs/architecture/api-design-conformance-review.md` §3.1 step 1 — sequences it **first**, ahead of
  the A2 admin-plane change, because it closes the escalation path regardless of what happens to A2.

---

## 3. Implementation Plan

TDD, RED first at every step. Layer order: registry data → service enforcement → DTO/controller →
e2e.

### Step 1 — Declare the implied ability on every scope (data, `packages/applications`)

Extend `ScopeDefinition` (`apikey-scopes.registry.ts:1-4`) with a required
`implies: RequiredPermission[]` field, and populate it for all 85 registry entries. The implication
is the ability a *holder* of that scope is allowed to exercise — for admin scopes, the CASL
permission its controller already declares (the mapping is a straight read of the controller's
`@Authorize`/`@CanXxx`, and the controller→scope half is already enumerated in
`apps/api/src/bootstrap/admin-scope-audit.ts:99-162`).

Wildcards resolve by expansion, not by a literal permission:

| Scope | Resolution |
|---|---|
| `<ns>:*` (e.g. `admin:*`) | union of `implies` across every registry key starting `<ns>:` |
| `'*'` | union across the whole registry — satisfiable only by `manage:all` |

Rationale for putting this in the registry rather than deriving it from decorators: the registry
lives in `packages/applications`, the decorators in `apps/api`. Deriving would invert the dependency
(rule 04 — services never import from the gateway). The static list is kept honest by a boot audit
already in place (`admin-scope-audit.ts`) plus the new parity test in Step 5.

**Verify:** `pnpm --filter @arcaai/applications test` — the new parity test goes GREEN.

### Step 2 — `assertScopeCeiling` in `ApiKeyService`

New private method, modelled on `callerCanManageAllKeys()` (`:1124-1128`):

1. `if (this.isSuperAdmin()) return;` — `manage:all` would satisfy everything anyway; the fast path
   mirrors the module's existing convention.
2. Read `this.clsService.get('userAbility')`. **Absent or not a CASL ability → throw
   `ForbiddenException`.** Fail closed; do not silently permit.
3. For each requested scope, resolve its implied permissions (§Step 1) and require
   `ability.can(action, subject)` for **every** one.
4. On failure throw `ForbiddenException` naming the offending scope(s) and the missing ability —
   never `NotFoundException`. This is a **privilege boundary (403)**, not the cross-tenant
   404-over-403 posture (rule 05 §Imperative Privilege Checks).

### Step 3 — Wire it into both write paths

| Path | Call | Argument |
|---|---|---|
| `create()` (`:238`) | before `ApiKeyFactory.CreateApiKey` at `:319` | the **whole** `request.scopes` array |
| `update()` (`:514`) | before `this.updateEntity(...)` at `:529` | only the **delta** — scopes present in `request.scopes` and absent from the stored `apiKey.scopes` |

The delta rule on `update` is deliberate: a `PATCH` that renames a key, or that narrows an existing
scope array, must not fail because the key already carries something broad. Only *widening* is
gated. A `PATCH` that omits `scopes` performs no ceiling check at all.

### Step 4 — Route-level `AUTH-NOTE`

Add the standardized marker above `create` (`apps/api/src/modules/api-key/api-key.controller.ts:39-46`)
and `update`, per rule 05: the `@CanCreate('ApiKey')` / `@CanUpdate('ApiKey')` decorator now
**understates** the real gate — the service additionally requires the caller to hold every ability
the requested scopes imply.

### Step 5 — TDD test list

| # | File | RED assertion (must be observed failing first) |
|---|---|---|
| T1 | `packages/applications/src/services/apiKey/__tests__/apikey-scopes.registry.test.ts` *(new)* | Every key in `API_KEY_SCOPE_REGISTRY` has a non-empty `implies`. RED: fails with 85 missing entries before Step 1. |
| T2 | same file | `resolveImpliedPermissions('admin:*')` returns the union over all 55 `admin:`-prefixed entries; `resolveImpliedPermissions('*')` includes `manage:all`. RED: helper does not exist. |
| T3 | `packages/applications/src/services/apiKey/__tests__/apikey.service.scope-ceiling.test.ts` *(new)* | `create({ scopes: ['admin:tenant:write'] })` with a CLS `userAbility` whose `can()` returns `false` for `manage:Tenant` **rejects with `ForbiddenException`**. RED: pre-fix it resolves and calls `apiKeyRepository.create`. |
| T4 | same file | `create({ scopes: ['admin:*'] })` as a caller holding only `manage:ApiKey` rejects. RED: resolves pre-fix. |
| T5 | same file | `create({ scopes: ['*'] })` as a non-SUPER_ADMIN rejects. RED: resolves pre-fix. |
| T6 | same file | `create({ scopes: ['consultation:session:write'] })` as a caller whose ability grants `create:Consultation` **resolves** — the ceiling must not over-block the ordinary SDK-key path. GREEN both before and after; it is the regression guard for over-tightening. |
| T7 | same file | CLS `userAbility` **absent** (the API-key-authenticated minting path, §2.6) → `ForbiddenException`, and `apiKeyRepository.create` is never called. RED: resolves pre-fix. |
| T8 | same file | `isSuperAdmin()` true → any scope array resolves. |
| T9 | same file | `update(id, { scopes: [...stored, 'admin:*'] })` rejects on the ADDED scope; `update(id, { keyName: 'x' })` with no `scopes` key performs **no** ceiling check (assert the resolver is not invoked); `update(id, { scopes: stored.slice(0, 1) })` (a narrowing) resolves. RED: all three resolve indiscriminately pre-fix. |
| T10 | `packages/applications/src/services/apiKey/__tests__/apikey.service.test.ts` *(existing)* | Extend the shared CLS mock (already keyed on `'userAbility'` at `:146-160`, `:1955`, `:1975`, `:1995`) so existing create/update suites present a permissive ability. RED: the whole existing suite fails on `ForbiddenException` until the mock is extended — that failure IS the proof the gate is live. |
| T11 | `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` *(existing, new "Half 5")* | A tenant-admin JWT `POST /api/v1/admin/api-keys` with `scopes: ['admin:*']` → **403**; the same request with `scopes: ['consultation:session:read']` → **201**; a SUPER_ADMIN JWT with `scopes: ['*']` → **201**. RED: the first returns 201 pre-fix. |

---

## 4. Verification Criteria

- [x] RED observed and recorded for T1–T5, T7, T9, T10, T11 before any implementation code landed (§5.4).
      Note T10's premise was wrong — see §5.3 D-3.
- [x] `pnpm --filter @arcaai/applications test` — green apart from the 2 pre-existing, unrelated failures.
- [x] `pnpm --filter @arcaai/applications build` and `typecheck` — clean.
- [x] `pnpm --filter @arcaai/api test` and `typecheck` — clean (3071 passed).
- [x] `pnpm --filter @arcaai/applications lint` — 183 warnings, identical to the recorded baseline.
- [x] Live e2e: `pnpm test:up:api` then the spec against a real server — Half 5 passes (22 passed).
      Run with `RESET_DB=false`; see the caveat in §5.4.
- [x] Real boot still green — the API served `GET /api/v1/health` → 200 on the TEST port, so every
      boot audit passed.
- [x] `apps/api/tests/e2e/api-key-auth.spec.ts` and `api-key-owner-scope.spec.ts` still green
      (18 passed) — a DOCTOR can still mint `stt:transcription:read`.
- [x] This README's §5 replaced with real command output.

---

## 5. Implementation Summary

Implemented TDD, RED-first, in the order of §3. Status: **Review** — every unit-level gate below
is green with pasted output; the live e2e run is recorded in §5.4.

### 5.1 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/apiKey/apikey-scopes.registry.ts:1-46` | New `ImpliedPermission` interface + required `ScopeDefinition.implies`, with the derivation rule documented on the field. |
| `…/apikey-scopes.registry.ts` (all 85 entries) | `implies` populated for all 76 concrete scopes; the 9 wildcards carry `[]` and resolve by expansion. |
| `…/apikey-scopes.registry.ts:220-268` | New `resolveImpliedPermissions(scope)` — expands `'<ns>:*'` and `'*'`, dedupes, throws on an unknown scope. Enumerates **by key**, so `'admin:*'` (which sits outside the contiguous `admin:` block) is never missed. |
| `packages/applications/src/services/apiKey/apikey.service.ts:1129-1201` | New `private assertScopeCeiling(scopes)` — SUPER_ADMIN fast path, fail-closed on an absent/unusable CLS `userAbility`, fail-closed on an unknown scope, `ForbiddenException` (403) naming the offending scope(s) and the missing ability. |
| `…/apikey.service.ts:317` | `create()` — ceiling applied to the whole `request.scopes`, **before** any key material is generated. |
| `…/apikey.service.ts:534-541` | `update()` — ceiling applied to the **widening delta** only (`request.scopes` minus the stored array); a PATCH omitting `scopes` runs no check. |
| `apps/api/src/modules/api-key/api-key.controller.ts:39-49, 105-112` | `AUTH-NOTE` markers on `create` and `update` (rule 05): the `@CanCreate`/`@CanUpdate` decorators now understate the real gate. |
| `packages/applications/src/services/apiKey/__tests__/apikey-scopes.registry.test.ts` | T1/T2 — every concrete scope declares a usable `implies`; every scope (wildcards included) resolves to ≥ 1 permission; wildcard expansion, dedupe, unknown-scope throw. |
| `packages/applications/src/services/apiKey/__tests__/apikey.service.scope-ceiling.test.ts` *(new)* | T3-T9 — 11 tests over `create()` and `update()`. |
| `packages/applications/src/services/apiKey/__tests__/apikey.service.test.ts` | T10 — the three SERVICE_ACCOUNT create cases that stubbed CLS with no `userAbility` now present a permissive one. |
| `apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts` | T11 — new "Half 5" (5 tests) + the three privileged fixtures re-tokened to SUPER_ADMIN (see §5.3). |

### 5.2 How `implies` was derived

One rule, documented on the field itself:

1. the CASL permission the scope's own controller declares (controller→scope half:
   `apps/api/src/bootstrap/admin-scope-audit.ts`);
2. where the class-level decorator is only `@Authorize()` — or exists solely to satisfy the
   deny-by-default boot audit, as `AdminTranscriptionJobController` documents — the method-level
   declarations instead;
3. where a controller declares an OR set (`@CanAny`), the **least-privileged branch** (holding it
   already makes the surface reachable);
4. where one scope gates several controllers, the **union**, checked with AND.

Surfaces gated only by authentication (the consultation/STT/TTS runtime plane) carry the
corresponding `Consultation` ability — the resource the plane operates on, and what every principal
permitted to use it already holds. Wildcards carry no literal at all.

Net effect on the headline case: `'admin:*'` and `'*'` both expand to a union containing
`manage:all` (from `admin:ai-model:manage`, `admin:queue:manage`, `admin:rate-limit:manage`,
`admin:scheduler:manage`, `admin:entitlement:manage`, `admin:ai-service:manage`,
`admin:ai-runtime-profile:manage`), so no non-super-admin can mint either.

### 5.3 Deviations from the plan (all deliberate, none silent)

| # | Plan said | What was done, and why |
|---|---|---|
| D-1 | T1: "every key has a non-empty `implies`" | Split in two. Wildcards legitimately carry `[]` — they resolve by EXPANSION, which is the plan's own §Step 1 wildcard rule; a literal would be a second source of truth. So T1 requires a non-empty `implies` for every **concrete** scope, and a second test requires **every** scope (wildcards included) to resolve to ≥ 1 permission. The fail-open hole T1 exists to catch is still closed. |
| D-2 | T1 file marked *(new)* | `apikey-scopes.registry.test.ts` already existed; the tests were added to it rather than creating a second file for the same module. |
| D-3 | T10: "the whole existing suite fails on `ForbiddenException` until the mock is extended" | **The premise was wrong.** The shared CLS mock at `apikey.service.test.ts:146-160` already returns `{ can: () => true }` for `'userAbility'`, so the main suite never went RED. Only **three** create tests failed — the SERVICE_ACCOUNT cases that install their own CLS stub with no `userAbility` at all (`:514`, `:595`, `:1772`). Those three were the live-gate proof and are the ones extended. |
| D-4 | Step 5 lists only T11 as e2e work | **Half 2 and Half 4 of the same spec break without a change**, which the plan did not anticipate: they mint `admin:tenant:write` and `'*'` fixtures with a **tenant-admin** token (`task-708-apikey-scope-contract.spec.ts:233, 252, 380`), which the ceiling now refuses. Those three now use a SUPER_ADMIN token. Their assertions are unchanged and still hold — including Half 2's "one tenant row only" — because an API-key-authenticated caller is never treated as a super admin by the handler (see §5.5). |
| D-5 | — | `apiKey.scopes` is a Prisma `Json` column (`JsonValue`), so the update-delta narrows with `Array.isArray(...) && typeof s === 'string'` rather than the plan's implicit `apiKey.scopes ?? []`, which does not typecheck. |

### 5.4 Evidence

Baseline before any change (`pnpm --filter @arcaai/applications test`): **2 failed | 9250 passed**,
lint: **183 problems (0 errors, 183 warnings)**. The two failures are pre-existing and unrelated
(`dna-writing-style.processor.test.ts`, `fail-mode.governance.test.ts`).

**RED — registry (T1/T2), before Step 1:**

```
 Test Files  1 failed (1)
      Tests  6 failed | 16 passed (22)

AssertionError: scopes missing a usable `implies`: stt:transcription:read, … (85 scopes)
TypeError: resolveImpliedPermissions is not a function
```

**RED — service ceiling (T3-T9), before Step 2/3:**

```
 × rejects a scope whose implied ability the caller does not hold
 × rejects 'admin:*' for a caller holding only manage:ApiKey
 × rejects the bare '*' for a non-SUPER_ADMIN
 × rejects when no compiled ability is present in CLS (fail closed)
 × rejects a scope that is not in the registry at all (fail closed, never silently allowed)
 × rejects a PATCH that WIDENS the key with a scope the caller does not hold
 Test Files  1 failed (1)
      Tests  6 failed | 5 passed (11)
```

(The 5 that passed pre-fix are the deliberate regression guards: T6 ordinary-SDK-scope,
T8 SUPER_ADMIN, and the three "no scopes touched → no check" cases.)

**RED — T10, after the gate went live:**

```
 × should allow SERVICE_ACCOUNT key creation without userId
 × should allow SERVICE_ACCOUNT key creation without tenant context
 × SERVICE_ACCOUNT keys do not require a UserRoleAssignment lookup
ForbiddenException: Scoped API keys can only be minted by a caller whose permissions can be evaluated
 ❯ ApiKeyService.assertScopeCeiling src/services/apiKey/apikey.service.ts:1187:13
```

**GREEN — the apiKey module:**

```
$ npx vitest run src/services/apiKey/__tests__/
 Test Files  9 passed (9)
      Tests  239 passed (239)
```

**GREEN — the whole package:**

```
$ pnpm --filter @arcaai/applications test
 Test Files  2 failed | 502 passed | 1 skipped (505)
      Tests  2 failed | 9268 passed | 4 skipped (9274)

 FAIL  src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts …
 FAIL  src/services/settings-registry/__tests__/fail-mode.governance.test.ts …
```

Same two pre-existing failures, unchanged; +18 tests, +1 file versus baseline.

**Build / typecheck / lint:**

```
$ pnpm --filter @arcaai/applications build
> rimraf dist tsconfig.tsbuildinfo && tsc
(clean)

$ pnpm --filter @arcaai/api typecheck
> tsc --noEmit
(clean)

$ pnpm --filter @arcaai/applications lint
✖ 183 problems (0 errors, 183 warnings)
```

183 warnings = the recorded baseline. **No new warnings.**

**`apps/api` unit suite:**

```
$ pnpm --filter @arcaai/api test
 Test Files  217 passed | 2 skipped (219)
      Tests  3071 passed | 4 skipped (3075)
```

**Live e2e against a real server** (`pnpm test:up:api`, API healthy on the TEST port 8968 —
so every boot audit, including `auditAdminScopedControllers` and `auditApiKeySurface`, passed):

```
$ npx playwright test apps/api/tests/e2e/task-708-apikey-scope-contract.spec.ts
  ✓ TASK-756 … a tenant admin minting 'admin:*' is refused with 403
  ✓ TASK-756 … a tenant admin minting the bare '*' is refused with 403
  ✓ TASK-756 … the same tenant admin can still mint an ordinary tenant-plane scope
  ✓ TASK-756 … a SUPER_ADMIN can still mint '*' (the platform-operator path is unchanged)
  ✓ TASK-756 … a PATCH that WIDENS an existing key with admin:* is refused, while a rename is not
  22 passed (1.8s)

$ npx playwright test apps/api/tests/e2e/api-key-auth.spec.ts apps/api/tests/e2e/api-key-owner-scope.spec.ts
  18 passed (1.9s)
```

`api-key-owner-scope.spec.ts` is the load-bearing non-regression here: it mints
`['stt:transcription:read']` as a **DOCTOR**, the least-privileged principal that can create a key
at all. It still passes, which is what proves the ceiling did not over-tighten the ordinary path.

> **Caveat on the full-suite run — stated plainly.** The Playwright `globalSetup` runs
> `test:db:reset`, which invokes a destructive Prisma command that is blocked for AI agents without
> the user's explicit consent. The runs above therefore used `RESET_DB=false` against the
> already-seeded test DB. A whole-suite pass under that flag reported **841 passed / 9 failed**;
> all 9 reproduce in isolation or are state-dependent (OCC versions already bumped, an invoice
> already computed, an unreachable SMR), **none of them create an API key** — verified: neither
> `authorization.spec.ts` nor `role-members-cross-tenant.spec.ts` references `admin/api-keys` at
> all. They should be re-confirmed against a freshly reset DB by someone who can authorise the
> reset.

### 5.5 Interaction with the accidental defence in `UnifiedAuthGuard` — untouched

The API-key CLS principal is `{ id, tenantId }` with **no `roles`** (`unified-auth.guard.ts:339-344`),
so `isSuperAdmin()` returns false for every API-key caller. Nothing here changes that, and the
ceiling does not rely on it — it reads CLS `userAbility`, which the guard deliberately never
publishes on the API-key path, and refuses when it is absent. Two consequences worth stating:

- A caller who authenticates **with an API key** can no longer mint a scoped key at all. That is
  the intended fail-closed posture (§2.6) and the direction TASK-757 takes the admin plane.
- Half 2's "an in-scope key still sees only one tenant row" assertion survives re-tokening to
  SUPER_ADMIN precisely **because** of that missing-`roles` behaviour. It is load-bearing for that
  test and is tracked by TASK-757; it was not modified here.

---

## 6. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-18 | Implemented. `ScopeDefinition.implies` + `resolveImpliedPermissions` in the registry; `assertScopeCeiling` in `ApiKeyService`, wired into `create()` (whole array) and `update()` (widening delta only); `AUTH-NOTE` markers on both controller routes; 11 new service tests, 6 new registry tests, e2e "Half 5". Five deliberate deviations recorded in §5.3 — notably T10's premise was wrong (the shared CLS mock was already permissive; only 3 SERVICE_ACCOUNT cases went RED) and Halves 2/4 of the TASK-708 e2e needed re-tokening to SUPER_ADMIN, which the plan did not anticipate. Status: Review. | Implementing agent |
| 2026-08-18 | Ticket created. Claims the privilege-ceiling gap named in `conformance/gateway-and-sdk.md` §6.4 and deferred without a ticket number in TASK-708 §8.5, and sequenced first by `api-design-conformance-review.md` §3.1/§4. Evidence re-verified against the live tree; three stale `file:line` citations in the source reviews corrected (§2.1, §2.4). Status: Pending. | Ticket-authoring agent |
