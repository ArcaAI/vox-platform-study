# BUG-024 — Newly created tenant user gets "Authentication failed" with valid credentials + tenant key

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/24 |
| Reporter / date | JayaramNambiar, 2026-09-30 |
| Labels | bug, Tenancy, Identity & Access |
| Severity | Medium (blocks first login of new tenant users; misleading error, not a security hole) |
| Area | `apps/api` auth (rule 05), `apps/admin-console` login + tenant screens (rule 13) |

## Requirement Analysis

Repro (cluster `admin.taphuynh.dev`, reporter's commit `1071097b8`, 2026-08-13): create tenant → create user
`homeo_doc` → login with username/password + "Tenant key" `01a0ec5b-bb9a-7803-8986-6fbbe05ac3c2`.

- wrong password → 401 `Invalid credentials`
- no tenant key → 400 `Tenant key is required for non-admin users`
- with that "tenant key" → **401 `Authentication failed`**

Expected: session issued for the tenant. The value the reporter typed is a **UUIDv7 — the tenant ID**, not a tenant key.
Tenant keys are slugs generated from the tenant name (`packages/applications/src/services/tenant/tenantKey.ts:24-70`,
e.g. `homeo-clinic`, or `t-<8hex>`).

## Current State Evaluation

- `apps/api/src/modules/auth/auth.controller.ts:276-283` — non-super-admin path calls `resolveTenant(request.tenantKey)`.
- `auth.controller.ts:1514-1528` `resolveTenant` — `tenantRepository.findFirst({ filters: { key, resourceStatus: ENABLED } })`.
  `Repository.findFirst` **throws `DataNotFoundException` on a miss** (the same fact is documented at `:213-220` for the user
  lookup), so the `if (!tenant) throw new BadRequestException('Invalid or disabled tenant')` at `:1522` is dead code.
- `auth.controller.ts:416-419` — the outer catch rethrows only Unauthorized/BadRequest/ServiceUnavailable; the
  `DataNotFoundException` becomes the generic `401 Authentication failed`.
- Membership checks (`:288-307`) return `null` on a miss (`userRoleAssignment.service.ts:80`,
  `user-department.service.ts:52`) and answer the distinct message `User does not have access to the specified tenant` —
  so the reporter's exact message **rules out** the role/department hypothesis in the issue body.
- The issue's hypothesis "create-user dialog writes no role/department" is stale: TASK-983 R6/OD-4
  (`17e53c728`, 2026-09-17) made role + department REQUIRED in `apps/admin-console/src/features/users/components/create-user-dialog.tsx:29-61`.
- The tenant detail screen shows both values side by side — `tenant-detail-screen.tsx:68-75` ("Tenant ID" first with a copy
  button, then "Key") — making the ID easy to copy by mistake. The login label is "Tenant key (optional for super admins)"
  (`login-form.tsx:262`).
- Elsewhere the platform already accepts either identifier: `tenant.service.ts:470`
  (`isUuidIdentifier(identifier) ? { id } : { key }`).

## Root Cause

`resolveTenant` does not normalise the repository's throw-on-miss, so an unknown/disabled tenant key (here: a tenant
**ID** pasted into the key field) surfaces as an opaque `401 Authentication failed` instead of the intended
`400 Invalid or disabled tenant`. Confidence: high for the error path; medium that the reporter's input was the ID
(UUIDv7 shape strongly suggests it — confirm with the tenant row).

## Implementation Plan

TDD (red first), `apps/api/src/modules/auth/__tests__/`:
1. `login with an unknown tenant key → 400 'Invalid or disabled tenant'` (repository mock throws `DataNotFoundException`).
2. `login with a DISABLED tenant's key → same 400`.
3. `login with a repository outage during tenant resolve → 503` (not 401), mirroring `isLookupMiss` for the user lookup.
4. (Only if owner approves OD-1) `login with the tenant ID (UUID) resolves the tenant` and still enforces membership.
5. Super-admin path with a bad optional tenant key → same 400.

Change order:
1. `auth.controller.ts` `resolveTenant` — wrap `findFirst` in try/catch using `this.isLookupMiss` (`:1285`): miss → 400
   `Invalid or disabled tenant` (set `failureReason = 'tenant_not_found'`), other errors → 503. Optional OD-1: accept a UUID id.
2. `apps/admin-console/src/features/auth/components/login-form.tsx` — helper text clarifying "tenant key (e.g. `homeo-clinic`), not the tenant ID"; optionally
   `tenant-detail-screen.tsx` order Key before ID.
3. e2e: extend `apps/api/tests/e2e` login spec with the unknown-key case.

Verification: `pnpm --filter @arcaai/api test -- auth` (own files only per owner rule), `pnpm api:build`, `pnpm lint`;
console: `pnpm --filter @arcaai/admin-console test -- login-form`; live: repeat repro with the ID and the key.

## Risks / Open Questions (owner)

- **OD-1**: Should login accept the tenant ID as well as the key (as `tenant.service.ts:470` does)? Removes the trap; slightly widens the input surface.
- **OD-2**: Is 400 `Invalid or disabled tenant` acceptable as a tenant-existence oracle on a pre-auth route? It fires only
  AFTER a valid password, so it does not enumerate tenants anonymously — but confirm, or keep a uniform 401 with a clearer message.
- Confirm on the cluster DB that `homeo_doc` has an ENABLED role + department in that tenant (else a second, distinct failure follows).

## Implementation Summary

Decisions (owner, 2026-10-11): OD-1 — login accepts the tenant ID as well as the key; OD-2 — an unresolvable tenant after a valid password is `400 Invalid or disabled tenant`, an outage 503.

- `apps/api/src/modules/auth/auth.controller.ts` `resolveTenant` — looks up `{ id }` when the value is a UUID (`isUuidIdentifier` from `@arcaai/applications`, the rule `tenant.service.ts` already uses), else `{ key }`, still `resourceStatus = ENABLED`. `findFirst`'s throw-on-miss is caught: miss (`isLookupMiss`) → audit reason `tenant_not_found` + 400; anything else → logged, audit `tenant_lookup_failed`, 503. Both call sites (super-admin optional key, required key) report the reason back to `login`'s audit. Membership checks unchanged.
- `apps/admin-console/src/features/auth/components/login-form.tsx` — label "Tenant key or ID (optional for super admins)".
- `apps/api/src/modules/auth/__tests__/auth.controller.bug024.test.ts` (new) — unknown key → 400 + `tenant_not_found`; super admin with unknown key → 400; outage → 503 + logged + `tenant_lookup_failed`; UUID resolves by `id` and membership still enforced; key still resolves by `key`.

Evidence:
- RED: 4 of 5 new tests failed (401 "Authentication failed"; lookup by key for a UUID).
- GREEN: `vitest run src/modules/auth/` → 17 files, 257 tests passed.
- `pnpm api:build` exit 0; eslint 0 errors (the 15 `require-description` warnings in `auth.controller.ts` are identical on HEAD); console eslint exit 0.
- Live `POST /api/v1/auth/login` as tenant_admin: tenant ID `50000000-…` → 200; key `__GLOBAL__` → 200; unknown key → 400 Invalid or disabled tenant; unknown UUID (the reporter's value) → 400; wrong password → 401 Invalid credentials. `AuditLog` LOGIN rows carry `tenant_not_found`. Rendered `/login` shows the new label.

Follow-up (not done): the `LoginRequest.tenantKey` `@ApiProperty` description still says "Tenant key"; updating it means regenerating the committed OpenAPI/portal artifacts — left for a quiet tree. The reporter's cluster tenant should still be checked for an enabled role + department for `homeo_doc` (a different, distinct 401).

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from GitHub issue #24 (read-only triage). |
- 2026-10-11 — Fixed (OD-1 key or ID, OD-2 400/503); tests, build, lint, live login checks green. Status Review.
