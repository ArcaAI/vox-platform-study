# BUG-005 — Admin Console: Impersonation shows operator identity & admin-scoped data instead of the impersonated end-user

| | |
|---|---|
| **Status** | Review (Phase 0 + Issues 1-4 implemented, TDD, all unit suites green; runtime/e2e verification pending — see Implementation Summary) |
| **Type** | bugfix (impersonation identity/authorization scoping) |
| **App** | `apps/admin-console` (Next.js 16, port 5176) + `apps/api` gateway + `packages/applications` |
| **Parent tickets** | [TASK-401 Global-Admin Impersonation], [TASK-442 Playground Impersonation Canvas](../TASK-442-Playground-Impersonation-Canvas/README.md), [TASK-390 Super-Admin Tier Backend](../../archive/TASK-390-Super-Admin-Tier-Backend/README.md), [TASK-440 Tenant Settings](../TASK-440-Tenant-Settings-Category-Nav/README.md) |
| **Reported** | 2026-07-12 by the user (manual testing, impersonating `doctor2`) |
| **Credentials used** | admin app `localhost:5176`, `super_admin` / `password123`, impersonating `doctor2` |

## Requirement Analysis

While a `GLOBAL_ADMIN` (`super_admin`) impersonates an end-user (`doctor2`), four shared/console screens still behave as the operator, not the impersonated user. Reported expectations:

1. **API keys** — end-user MUST see only their own API keys (screen currently lists all 7 tenant keys).
2. **Tenant profile** — end-user MUST see only a *basic* tenant profile (tenant name) plus **READ-ONLY** tenant configuration (needed for SDK operation). Plan & usage / limits / meters / entitlements MUST be hidden.
3. **Playground** — MUST NOT ask to "Select a working tenant"; the working tenant MUST be inferred from the impersonated user's own tenant.
4. **/account** — MUST show the impersonated user's identity (basic profile, personalized settings/preferences, and the department they belong to) — currently shows `super_admin`'s identity.

## Current State Evaluation (root cause)

### Unified root cause

Impersonation is modelled as **two disjoint pieces** in the admin-console, and one of them is incomplete:

- **What works** — the gateway mints a genuinely new, fully-scoped act-as JWT for the target. `POST /admin/users/:id/impersonate` builds a token carrying the target's own `id / username / email / roles / permissions / tenantId` plus `impersonatedBy`, and returns `departmentId` too (`apps/api/src/modules/auth/admin-impersonation.controller.ts:194-292`). The BFF proxy correctly swaps the bearer to this token for every `/api/hope/*` call (`apps/admin-console/src/server/hope-proxy.ts:26`). So gateway data calls (`/user/me/*`, `/tenant/me`, CASL `my-permissions`) already resolve to `doctor2`.

- **What's missing** — the admin-console never establishes an **effective client identity**. On impersonation start, the BFF stores only a narrow marker and drops everything else the gateway returned:

  ```ts
  // apps/admin-console/src/app/api/auth/impersonate/route.ts:67-77
  const updated = {
      ...session,                       // session.user stays = super_admin
      impersonation: {
          accessToken: data.token,
          originalAccessToken: session.accessToken,
          originalRefreshToken: session.refreshToken,
          targetUserId: data.user.id,
          targetUsername: data.user.username,
          // DROPPED: data.user.tenantId, email, roles, departmentId
      },
  };
  ```

  `toSafeSession()` then projects `user` and `isElevated` **exclusively from the base `session.user`** (the operator), tagging on only `impersonatingUserId/Username` for the banner (`apps/admin-console/src/server/safe-user.ts:24-34`). Consequently every *client-side* "who am I / what may I see" decision still reflects `super_admin`:

  | Consumer | Reads (base operator) | Should read (effective, while impersonating) |
  |---|---|---|
  | `/account` Identity card + page meta | `session.user.username/email/roles` (`account-screen.tsx:131,156-167`) | impersonated identity |
  | `WorkingTenantGate` | `isElevated && !workingTenantId` (`working-tenant-gate.tsx:43`) | impersonated user is tenant-bound → pass through |
  | Tenant-profile tab gating | *(no gate at all)* (`tenant-profile-screen.tsx:55-59,269-339`) | non-admin → basic view only |
  | Proxy `X-Tenant-Id` | `isElevated(session.user)` + stale `workingTenantId` (`hope-proxy.ts:30-32`) | omit / use impersonated tenant |

Two issues (1, 2) additionally have a **backend/authorization** dimension that would over-expose data to a *real* end-user hitting the same endpoints, independent of impersonation.

### Per-issue root cause

**Issue 1 — API keys list is tenant-wide, never owner-scoped.**
- Frontend: the single API-keys screen always calls tenant-wide `GET admin/api-keys` with no owner filter (`features/api-keys/api/client.ts:7,14-16`, `api/hooks.ts:13-15`); no self-service path exists.
- Gateway: `ApiKeyController.fetchAll` is method-gated `@CanRead('ApiKey')` (overrides the class `@CanManage`) (`apps/api/src/modules/api-key/api-key.controller.ts:54-74`). `doctor2` clears it because `UnifiedAuthGuard` does a **type-level** `ability.can('read','ApiKey')` with a bare-string subject (`unified-auth.guard.ts:287`), so DOCTOR's condition-scoped `api-key-own-manage` policy (`packages/database/.../seed/01-policy.ts:294`) passes as unconditional.
- Service (**primary**): `ApiKeyService.fetchAllByTenantId` / `fetchAll` filter by `tenantId` only — no owner narrowing (`packages/applications/src/services/apiKey/apikey.service.ts:339-408`). The by-id methods **do** have owner-scope via `assertKeyAccess()` + `callerCanManageAllKeys()` (lines 1050-1071), and an owner-scoped `fetchAllByUserId` exists (lines 417-445) but is only reachable through the admin-gated `UserController`. This is a **documented gap** — TASK-390 hardened by-id ops but explicitly left the list endpoints out of scope (`docs/archive/TASK-390-Super-Admin-Tier-Backend/README.md:62,145,154`).

**Issue 2 — Tenant profile renders admin-only tabs to everyone; config is writable by end-users.**
- Frontend (**primary**): `TenantProfileScreen` renders `Organization` (full identity — key, plan, description, tags, timestamps), `Plan & usage` (limits/meters/model & rate-tier & enforcement badges, via `useMyEntitlements`), and `Settings` unconditionally — **no role gate** anywhere in the file (`tenant-profile-screen.tsx:55-59,127-192,269-339`). Comparable screens gate tabs on `isElevated`/`TENANT_ADMIN` (e.g. `harness-policy-screen.tsx:260-283`); this one does not.
- `TenantSettingsTab` is editable for everyone (Save/Cancel bar + live controls) (`tenant-settings-tab.tsx:299-313`).
- Gateway: `/tenant/me` and `/tenant/me/config` (GET) are bare `@Authorize()` (auth-only, self-service by design); `/entitlements/me` is `@Authorize(['read','Tenant'])` — trivially satisfied by the universal `user-profile-own` grant. **`PATCH /tenant/me/config` is also only bare `@Authorize()`** — any authenticated tenant member can write config (`apps/api/src/modules/tenant/my-tenant.controller.ts:22,38,53,83`). The read endpoints are correctly self-service; the missing gate is at the UI (what to show) and the PATCH write (defense-in-depth).
- The correct end-user-safe config surface already exists: `GET /tenant/me/config` (feeds `TenantSettingsTab`) + `GET /tenant/me` (basic name) — both work for any role today.

**Issue 3 — Working-tenant gate blocks the impersonation canvas.**
- `WorkingTenantGate` fires on `session.data.isElevated && !session.data.workingTenantId` (`working-tenant-gate.tsx:43`). While impersonating, `isElevated` is the operator's (always `true`), and `workingTenantId` is null (never set on impersonation start), so all 5 playground screens (and tier 30-49 screens) show "Select a working tenant".
- The impersonated tenant is **already resolved and returned** by the gateway as `data.user.tenantId`, and the BFF's own `GatewayImpersonateResponse` type declares it — but `impersonate/route.ts:67-77` never persists it.
- **Related latent bug (fold in here):** if the operator had a working tenant selected *before* impersonating and it differs from the target's resolved tenant, `hope-proxy.ts:30-32` keeps sending the stale `X-Tenant-Id`; the gateway `ContextInterceptor` then **400s every proxied call** because the header ≠ the impersonation JWT's `tenantId` (`apps/api/src/interceptors/context.interceptor.ts:72-83`). No test covers impersonation + a pre-existing working tenant together (`hope-proxy.test.ts:103-134`).

**Issue 4 — /account is a split-identity screen.**
- Identity card + page meta + header avatar read `session.user` (base operator), never rewritten on impersonation (`account-screen.tsx:131,156-167`; `user-menu.tsx:32-33`). The "My settings" / "Preferences" panels below use `GET /user/me/settings|preferences` via the proxy → resolve to `doctor2` via gateway CLS. So the header says `super_admin` while the content is `doctor2`'s.
- There is **no bare `GET /user/me` identity endpoint** and **no self-service department endpoint** (only admin `GET /admin/users/:id/departments`) — showing "the department they belong to" needs new plumbing.

## Implementation Plan

TDD throughout (RED → GREEN → refactor). Grouped into a shared foundation + four issue tracks. **No code until this plan is approved.**

### Phase 0 — Effective-identity foundation (unblocks issues 3 & 4, enables 1 & 2 gating)

Additive changes to the session model so the client can distinguish *operator* from *effective (impersonated)* identity.

1. **Persist the full target identity on impersonation start.**
   - `server/session.ts` — extend `ImpersonationState` with `targetEmail`, `targetRoles: string[]`, `targetTenantId`, `targetDepartmentId?`.
   - `app/api/auth/impersonate/route.ts` — widen `GatewayImpersonateResponse.user` to include `departmentId`; persist `data.user.{email,roles,tenantId,departmentId}` into `impersonation`.
   - `app/api/auth/revoke-impersonation/route.ts` — symmetric: nothing extra to clear beyond dropping `impersonation` (verify `workingTenantId` is untouched by design so the operator's own scope is restored).
2. **Project effective fields in `toSafeSession` (`server/safe-user.ts`).** Add to `SafeSession`:
   - `effectiveUser: { id, username, email, roles, tenantId, departmentId? }` = impersonation identity when impersonating, else `user`.
   - `effectiveIsElevated: boolean` = `isElevated(effectiveUser.roles)` (false for `doctor2`).
   - `effectiveTenantId: string | null` = impersonating ? `targetTenantId` : `workingTenantId`.
   - Keep `user` / `isElevated` / `impersonatingUser*` as-is (operator chrome: persona-control, site-header switcher, banner "under {admin}" stay correct).
3. **Fix proxy `X-Tenant-Id` during impersonation (`server/hope-proxy.ts`).** When `session.impersonation` is set, do **not** send the operator's stale `workingTenantId`; rely on the act-as JWT's own tenant (or send `impersonation.targetTenantId` explicitly). Removes the latent 400.
4. Tests (RED first): `safe-user` unit (effective projection), `hope-proxy` unit (impersonation + pre-existing workingTenantId → no stale/mismatched `X-Tenant-Id`), impersonate route unit (persists target tenant/roles/dept).

### Issue 1 — API keys owner-scope (backend-primary)

5. **RED** — `apikey.service.test.ts`: `fetchAllByTenantId`/`fetchAll` as an owner-only caller (no `manage:ApiKey` ability) returns only own keys; as a `manage:all`/tenant-admin caller returns all. Gateway/e2e: `GET admin/api-keys` under an owner-only token returns only the owner's keys.
6. **GREEN** — in `ApiKeyService.fetchAll` + `fetchAllByTenantId`, reuse the existing `callerCanManageAllKeys()`; when false, add `userId: this.requestUserId` to the `where` (mirrors `fetchAllByUserId`/`assertKeyAccess`). This owner-scopes the *same* endpoint for non-admins, so impersonating `doctor2` (and any real end-user) sees only their keys — no frontend change strictly required.
7. **Optional UI narrowing** — for `effectiveIsElevated === false`, hide the admin-only "Tenant" column/filter and mutating actions on the API-keys screen (secondary; the data scoping is the fix).

### Issue 2 — Tenant profile end-user view (frontend-primary + write-gate)

8. **RED** — `tenant-profile-screen.test.tsx`: a non-admin/impersonated session renders only basic Organization info + a read-only Settings tab, and **no** "Plan & usage" tab; an admin session is unchanged. `tenant-settings-tab.test.tsx`: read-only mode disables controls and hides the save bar.
9. **GREEN** —
   - `TenantProfileScreen`: gate on `effectiveIsElevated` (or effective `manage/update:Tenant` from `usePermissions()`). Non-admin: show only `tenant.name` (+ status) in Organization; hide the `plan` tab and its `useMyEntitlements` fetch; keep the Settings tab.
   - `TenantSettingsTab`: add a `readOnly` prop (derived from effective role); when set, render controls `disabled` and suppress Save/Cancel.
10. **Defense-in-depth (backend)** — add `@Authorize(['update','Tenant'])` to `PATCH /tenant/me/config` (`my-tenant.controller.ts:83`) so end-users cannot write config even via direct API. (GET routes stay self-service.) RED: controller test asserting a DOCTOR token 403s the PATCH.

### Issue 3 — Playground infers tenant from impersonation (frontend)

11. **RED** — `working-tenant-gate.test.tsx`: an impersonating session passes through (no "Select a working tenant"); a genuine elevated-no-tenant session still gates.
12. **GREEN** — `WorkingTenantGate`: gate on `effectiveIsElevated && !effectiveTenantId` (Phase 0 makes `doctor2` non-elevated with a tenant → passes). Covered end-to-end once Phase 0 §1-3 land.

### Issue 4 — /account effective identity + department (frontend + new self endpoint)

13. **RED** — `account-screen.test.tsx`: while impersonating, the Identity card + page meta show the impersonated username/email/roles; department renders when present.
14. **GREEN (identity)** — point `account-screen.tsx` Identity card + `meta` (and `user-menu.tsx` avatar) at `session.effectiveUser`.
15. **Department (new self endpoint)** — add gateway `GET /user/me/departments` (self-service; resolves the caller's active department(s) from CLS user + tenant, mirroring the admin `user-departments` controller but for `me`). Wire an `account` hook + a "Department" field on the Identity card. Works for normal and impersonated sessions alike (token-scoped). RED: gateway controller test + account render test.

### Cross-cutting verification (Definition of Done)

- `pnpm --filter @arcaai/admin-console build lint test` green; unit tests colocated.
- `pnpm --filter @arcaai/applications build test` + `pnpm build:api` + `pnpm test:unit` (api) green; owner-scope + PATCH-gate covered; add cross-tenant/owner e2e where the `task-307-*` specs live.
- Runtime verification in the running admin app (impersonate `doctor2`): (1) API keys shows only `doctor2`'s keys; (2) Tenant profile shows name + read-only Settings, no Plan & usage; (3) a playground opens without the tenant picker; (4) /account shows `doctor2` identity + department + own settings/preferences. Both themes; axe clean on changed screens.
- Regression: normal (non-impersonated) `super_admin` and `TENANT_ADMIN` flows for all four screens unchanged.

## Implementation Summary

### Phase 0 — Effective-identity foundation (done, 2026-07-12)

TDD (RED confirmed failing, then GREEN) for all four sub-steps:

- `apps/admin-console/src/server/session.ts` — `ImpersonationState` gains `targetEmail?`, `targetRoles?: string[]`, `targetTenantId?`, `targetDepartmentId?` (all optional — sessions sealed before this change lack them; consumers must tolerate `undefined`, same convention as the existing `targetUsername?`).
- `apps/admin-console/src/app/api/auth/impersonate/route.ts` — `GatewayImpersonateResponse.user` widened with `departmentId?`; the four new fields are persisted into `session.impersonation` from the gateway's response.
- `apps/admin-console/src/server/safe-user.ts` — `SafeSession` gains `effectiveUser` (`id/username/email/roles/tenantId/departmentId`), `effectiveIsElevated`, `effectiveTenantId`. Impersonating: projects the target; otherwise: the operator's own `user`/`isElevated`/`workingTenantId`. Existing `user`/`isElevated`/`impersonatingUser*` fields are untouched (operator-only chrome: persona-control, banners).
- `apps/admin-console/src/server/hope-proxy.ts` — `buildHeaders` no longer sends `X-Tenant-Id` while impersonating (`!session.impersonation &&  ...`), closing the latent bug where an operator's pre-impersonation working-tenant pick diverged from the act-as JWT's own tenant and made the gateway 400 every proxied call.
- `apps/admin-console/src/app/api/auth/revoke-impersonation/route.ts` — verified unchanged: it already drops `impersonation` only, leaving `workingTenantId` untouched so the operator's own scope is restored on revoke.

Files added/changed:
- `src/server/__tests__/safe-user.test.ts` (new) — 5 tests: non-impersonating projection, tenant-bound non-elevated user, impersonating projection (incl. ignoring a stale operator `workingTenantId`), legacy-cookie tolerance.
- `src/server/__tests__/hope-proxy.test.ts` — +1 test: no stale/mismatched `X-Tenant-Id` while impersonating.
- `src/app/api/auth/impersonate/__tests__/route.test.ts` (new) — 3 tests: full identity persisted, missing-department tolerance, pre-existing elevated-caller guard unaffected.
- `src/server/session.ts`, `src/server/safe-user.ts`, `src/server/hope-proxy.ts`, `src/app/api/auth/impersonate/route.ts` — implementation.
- `src/features/playground-shared/components/__tests__/persona-control.test.tsx`, `src/features/account/components/__tests__/account-screen.test.tsx` — existing `SafeSession` fixtures updated with the three new required fields (the interface change is additive but non-optional, so these two hand-typed literals needed the fields to keep compiling).

Evidence (2026-07-12):
```
pnpm --filter @arcaai/admin-console exec vitest run
 Test Files  113 passed (113)
      Tests  855 passed (855)

pnpm --filter @arcaai/admin-console build
✓ Compiled successfully in 11.9s
  Finished TypeScript in 8.6s ...
✓ Generating static pages using 15 workers (46/46)

pnpm --filter @arcaai/admin-console lint
(clean — 0 errors, 0 warnings)
```

### Issue 1 — API keys owner-scope (done, 2026-07-12)

- `packages/applications/src/services/apiKey/apikey.service.ts` — `fetchAll` and `fetchAllByTenantId` now narrow to `userId: this.requestUserId` whenever `callerCanManageAllKeys()` is false (mirrors the existing by-id `assertKeyAccess()` gate). Tenant-admins (`manage:ApiKey`) and GLOBAL_ADMIN keep full/cross-tenant scope. No frontend change was required — the fix is server-side, so it also protects a real end-user hitting the endpoint directly, not just the impersonation case.
- Tests: 4 new cases in `packages/applications/src/services/apiKey/__tests__/apikey.service.test.ts` (`fetchAll`/`fetchAllByTenantId` × owner-only/tenant-admin/GLOBAL_ADMIN). All 159 tests in the file pass; full `@arcaai/applications` suite (280 files, 6007 tests) green; `pnpm --filter @arcaai/applications build` clean.

### Issue 2 — Tenant profile end-user view (done, 2026-07-12)

- `apps/admin-console/src/features/account/components/tenant-profile-screen.tsx` — gates on `session.effectiveIsElevated` (via `useSession()`, defaults `false` while loading — safe-by-default, mirrors the `harness-policy-screen` convention). Non-elevated: Organization shows only name + status; the `Plan & usage` tab/trigger and its `useMyEntitlements` fetch don't mount at all; Settings tab renders `<TenantSettingsTab readOnly />`.
- `apps/admin-console/src/features/account/components/tenant-settings-tab.tsx` — new `readOnly?: boolean` prop; when set, every control is `disabled` (even normally-editable rows) and the Save/Cancel bar is suppressed outright (not just inert).
- `apps/admin-console/src/features/account/api/hooks.ts` — `useMyEntitlements` takes an `enabled` boolean (mirrors `useGlobalHarnessPolicy`'s convention) so the entitlements fetch is skippable.
- Backend defense-in-depth: `apps/api/src/modules/tenant/my-tenant.controller.ts` — `PATCH /tenant/me/config` gains `@Authorize(['update','Tenant'])` (previously bare `@Authorize()`, so any authenticated tenant member could write config). GET routes are unchanged (self-service by design).
- **e2e fixed, NOT re-run in this session** (needs live infra): `apps/api/tests/e2e/phase-0-redteam.spec.ts` previously drove its mass-assignment-rejection proof through a `doctor` (DOCTOR-role) token expecting `400`; with the new gate a DOCTOR token now gets `403` before ever reaching the ValidationPipe. Updated the suite to (a) assert the new `403` for a non-admin caller and (b) re-run the original mass-assignment `400` proof through `tenant_admin` (who retains `update:Tenant`) instead. Requires `pnpm test:api:up` + `pnpm test:e2e` against seeded test infra — **please run this before merge**.
- Tests: 4 new in `tenant-profile-screen.test.tsx` (hide Plan tab + no entitlements fetch; basic-only Organization; read-only Settings even after an edit; elevated regression unchanged), 4 new in the new `tenant-settings-tab.test.tsx`, 3 new in the new `my-tenant-config-authorization.controller.test.ts` (metadata-only, mirrors DEF-C3's pattern). All green; `pnpm --filter @arcaai/admin-console build lint test` and `pnpm --filter @arcaai/api build` clean.

### Issue 3 — Playground infers tenant from impersonation (done, 2026-07-12)

- `apps/admin-console/src/shared/tenant-scope/working-tenant-gate.tsx` — gate condition changed from `session.isElevated && !session.workingTenantId` to `session.effectiveIsElevated && !session.effectiveTenantId`. While impersonating, the impersonated (non-elevated, tenant-bound) target now passes straight through instead of hitting "Select a working tenant"; a genuinely elevated operator with no tenant picked still gates.
- **Fallout (expected, fixed):** `WorkingTenantGate` backs ~19 screens. Adding required `effectiveUser`/`effectiveIsElevated`/`effectiveTenantId` fields broke 14 pre-existing screen tests whose hand-rolled session fixtures predated Phase 0 (each asserted the exact same "elevated, no working tenant → gated" scenario the field rename now depends on). Fixed all 14 by making each fixture's effective fields mirror its own isElevated/workingTenantId (2 of the 14 shared one helper — `harness-ops/components/__tests__/fetch-stub.ts` — fixing it covered both).
- Tests: 2 new cases in `working-tenant-gate.test.tsx` (impersonating passes through even with a stale pre-impersonation elevated-no-tenant state; a genuinely elevated no-tenant session still gates). Full `pnpm --filter @arcaai/admin-console build lint test` green (114 files, 868 tests) after the fixture fixes.

### Issue 4 — /account effective identity + department (done, 2026-07-12)

- `apps/admin-console/src/features/account/components/account-screen.tsx` — Identity card (avatar initials, username, email, role badges) and the page-header meta now read `session.effectiveUser` instead of `session.user`.
- New self-service endpoint `GET /user/me/departments` (`apps/api/src/modules/user/controllers/user-departments-me.controller.ts`, registered in `user.module.ts`) — mirrors `UserDepartmentsController.list` (admin, `@CanManage('User')`-gated, by `:id`) but resolves the caller from CLS instead, matching `UserSettingsController.getMySettings`'s self-service convention. Works for a real end-user AND an impersonated session (the act-as JWT carries the target's own id).
- `apps/admin-console/src/features/account/api/{client,hooks,keys}.ts` — `getMyDepartments`/`useMyDepartments`; Identity card renders a "Department:" line for the primary (or first) department when present, nothing when the caller has none.
- Out of scope (per the ticket, optional): the `user-menu.tsx` header avatar still shows the operator while impersonating — flagged but not fixed, the reported issue was `/account` specifically.
- Tests: 3 new in `account-screen.test.tsx` (impersonated identity shown, not the operator; primary department rendered; no department field when the caller has none), 2 new in the new `user-departments-me.controller.test.ts`. All green.

## Cross-cutting verification (evidence, 2026-07-12)

```
pnpm --filter @arcaai/admin-console exec vitest run   → 114 files, 868 tests passed
pnpm --filter @arcaai/admin-console build              → compiled + typechecked clean, 46 routes
pnpm --filter @arcaai/admin-console lint                → 0 errors, 0 warnings

pnpm --filter @arcaai/applications exec vitest run     → 280 files, 6007 tests passed (1 skipped file, pre-existing)
pnpm --filter @arcaai/applications build               → tsc clean
pnpm --filter @arcaai/applications lint                → 0 errors (98 pre-existing prettier warnings, unrelated files, not touched by this ticket)

pnpm --filter @arcaai/api exec vitest run              → 2103 passed / 5 failed — the 5 failures are in
    src/__tests__/env-port-standardization.test.ts, confirmed pre-existing and unrelated
    (reproduced identically on a clean `git stash` of this ticket's changes)
pnpm --filter @arcaai/api build                        → nest build + tsc-alias clean
pnpm --filter @arcaai/api lint                          → 0 errors
```

### Not verified in this session (needs a human / live environment)

- **Runtime verification in the running admin app** (impersonate `doctor2` and click through all four screens) — not done; this session had no browser/dev-server access to the seeded stack.
- **`apps/api/tests/e2e/phase-0-redteam.spec.ts`** — edited to match the new authorization behavior (see Issue 2) but not re-run; needs `pnpm test:api:up` + `pnpm test:e2e` against live seeded infra.
- Both themes / axe scan on the changed screens — not run (no browser available this session).

## Out of scope / noted, not fixed here

- Header avatar (`user-menu.tsx`) showing the operator while impersonating is arguably also wrong; §14 optionally covers it, but the reported issue is `/account`.
- The `UnifiedAuthGuard` type-level `ability.can(action, <bareString>)` pattern (conditions ignored for subject-only checks) is a broader authorization concern beyond API keys — flagged, not addressed here.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | Ticket opened. Root-caused all four issues (parallel investigation of BFF session/proxy, gateway impersonation + api-key/tenant controllers, applications services). Unified root cause: impersonation swaps the proxied bearer token but never establishes an effective client identity; issues 1 & 2 also have backend over-exposure. Plan drafted (Phase 0 foundation + four issue tracks). **Awaiting approval — no code written.** |
| 2026-07-12 | Plan approved. Phase 0 (effective-identity foundation) implemented TDD (RED confirmed, then GREEN): `ImpersonationState` carries the full target identity; `SafeSession` gains `effectiveUser`/`effectiveIsElevated`/`effectiveTenantId`; the BFF proxy no longer leaks a stale pre-impersonation working-tenant header to the gateway. `pnpm --filter @arcaai/admin-console build lint test` green (855 tests). Issues 1-4 not started. |
| 2026-07-12 | Issues 1-4 implemented TDD (RED then GREEN for every change). Issue 1: `ApiKeyService` list methods owner-scoped. Issue 2: tenant-profile screen + settings tab gated on `effectiveIsElevated`; `PATCH /tenant/me/config` gated `@Authorize(['update','Tenant'])` server-side; `phase-0-redteam.spec.ts` e2e updated for the new 403 (not re-run — needs live infra). Issue 3: `WorkingTenantGate` keyed off effective identity; fixed 14 pre-existing screen-test fixtures broken by the new required `SafeSession` fields. Issue 4: `/account` reads `effectiveUser`; new self-service `GET /user/me/departments` + Department field. Evidence: admin-console (114 files/868 tests), applications (280 files/6007 tests), api (2103 passed, 5 pre-existing unrelated failures) all green; all four packages build clean; lint clean (0 new warnings). **Not done this session:** browser/runtime verification and the e2e Playwright suite (no live dev stack available) — recommend running both before merge. |
