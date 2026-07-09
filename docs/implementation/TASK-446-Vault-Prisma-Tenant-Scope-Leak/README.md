# TASK-446 — Vault-Mode Prisma Client Missing Tenant-Scope Extension (Cross-Tenant Read Leak)

- **Status**: Completed
- **Type**: bugfix (security — multi-tenant isolation)
- **Owner**: api / database
- **Severity**: High — cross-tenant PII disclosure over HTTP 200 in any Vault-mode deployment (dev + production pods).
- **Related**: surfaced by **TASK-444** (role members endpoint e2e); the fix is a prerequisite for TASK-444's tenancy AC. Touches the same `$extends` composition documented in `docs/architecture/data-and-domain-model.md` and `packages/database/src/client.ts`.

## Requirement Analysis

The extended Prisma client must inject `tenantId` into every read on a tenant-scoped model, in **both** secrets-provider modes:

- **env mode** — `createExtendedPrismaClient()` (`packages/database/src/client.ts:256-263`) composes `applySoftDeleteExtension` **then** `applyTenantScopeExtension` (tenant-scope applied last so its handlers run first, merging `tenantId` into `args.where` before the soft-delete filter).
- **vault mode** (`SECRETS_PROVIDER=vault` + `PG_DYNAMIC_CREDS=true`) — the client is built by `buildVaultPrismaFactory()` in `apps/api/src/vault-prisma.module.ts`.

These two paths MUST produce equivalently-scoped clients. They did not.

## Current State Evaluation

Verified 2026-07-09.

- **Root cause** — `apps/api/src/vault-prisma.module.ts:59` (pre-fix): `const extendedClient = applySoftDeleteExtension(baseClient);` — **soft-delete only**. The tenant-scope extension was never composed. `CoreDatabaseService.client` is bound to this factory's `extendedClient` in vault mode (`@Optional()` inject), so the whole gateway ran with an **unscoped** primary client.
- **Trigger** — `.env.dev` (and Vault-mode prod pods) ship `SECRETS_PROVIDER=vault` + `PG_DYNAMIC_CREDS=true`, so this path is the DEFAULT for local dev and production, not an edge case.
- **Blast radius** — any read that relies on the tenant-scope `$extends` for isolation (rather than an explicit `tenantId` filter or a controller/interceptor tenancy check) returned cross-tenant rows in vault mode. TASK-444's `UserRoleAssignmentService.fetchAllByRoleId` was the first surface proven leaking (its design deliberately delegates scoping to the extension), but the defect was client-wide.
- **Why it hid** — most admin surfaces also carry explicit tenancy checks (controller guards, `assertEqualTenants`, 404-over-403 interceptor) or build explicit `tenantId` filters, which masked the missing extension. The role-members listing was the first path depending on the extension *alone*, so it exposed the gap. The role read's `memberCount` (an explicit CLS-built `_count` filter, independent of the extension) stayed correctly scoped — the two visibly disagreed (e.g. listing 15 vs `memberCount` 14), which is how the e2e caught it.

**Observed leak (pre-fix, running gateway):** `tenant_admin` (tenant `50000000-…`) calling `GET /api/v1/admin/rbac/roles/00000000-…-0010/members?pageSize=50` received **15 rows across two tenants** plus the SYSTEM-tenant GLOBAL_ADMIN holders (usernames + emails), while the role's `memberCount` correctly reported 14.

## Implementation Plan

TDD. One surgical change mirroring the env-mode composition; no schema change, no API change.

1. **RED** — extend `apps/api/src/__tests__/vault-prisma.module.test.ts`: mock `applyTenantScopeExtension` + `resolveTenantContext`; assert the factory's `extendedClient` composes tenant-scope over soft-delete and wires `getTenantId`/`isSuperAdmin` to `resolveTenantContext()`.
2. **GREEN** — in `buildVaultPrismaFactory()` compose `applyTenantScopeExtension(applySoftDeleteExtension(baseClient), { getTenantId, isSuperAdmin })`, reading from `resolveTenantContext()` exactly like `createExtendedPrismaClient`.
3. **Verify** — unit test green; env-mode reference path (`@arcaai/database` suite) unchanged; TASK-444 cross-tenant e2e M3/M4 flip red→green; live curl confirms scoped listing.

## Implementation Summary

Single-file fix (+ its test), strict TDD.

- **`apps/api/src/vault-prisma.module.ts`** — imported `applyTenantScopeExtension` + `resolveTenantContext` from `@arcaai/database` (both already exported from the built dist, index.js:33); replaced the soft-delete-only line with the composed chain:
  ```ts
  const softDeleted = applySoftDeleteExtension(baseClient);
  const extendedClient = applyTenantScopeExtension(softDeleted as ..., {
    getTenantId: () => resolveTenantContext().tenantId,
    isSuperAdmin: () => resolveTenantContext().isSuperAdmin,
  });
  ```
  Same order and CLS wiring as env-mode `createExtendedPrismaClient`. The `disconnect`/`client` surface is unchanged.
- **`apps/api/src/__tests__/vault-prisma.module.test.ts`** — mock now includes `applyTenantScopeExtension` + `resolveTenantContext`; new regression test `composes the tenant-scope extension over soft-delete, wired to resolveTenantContext`; the existing composition-shape assertion updated to the composed shape.

### Evidence (real output)

- Unit: `pnpm --filter @arcaai/api exec vitest run src/__tests__/vault-prisma.module.test.ts` → **7 passed** (was 2 failing at RED).
- `tsc --noEmit` on the module: clean (the 3 remaining api type errors are pre-existing, in unrelated `*.controller.test.ts` files).
- Env-mode reference path unaffected: `pnpm --filter @arcaai/database test` → **807 passed**.
- **TASK-444 cross-tenant e2e** (`task-444-role-members-cross-tenant.spec.ts`) against the running gateway with the fix: **6/6 passed** — M3 (X-Tenant-Id scopes listing + memberCount) and M4 (tenant admin sees only their tenant) now green.
- `task-443-settings-list-faceting.spec.ts` re-run: **4/4** (no regression from the shared-client change).
- **Live leak check** (independent of the spec): `tenant_admin` view of the DOCTOR role → **14 rows, all tenant `50000000-…`** (was 15 across two tenants + SYSTEM admins).

### Follow-up recommended (not in this ticket)

- **Broader audit** — this fix restores the extension client-wide, so all extension-dependent reads are now scoped in vault mode. Still worth an explicit sweep for any `.client` read path that assumed the (buggy) unscoped behavior; none found so far, and env/vault parity is the intended contract.
- **Parity guard** — consider a shared factory or a boot-time assertion that the vault-mode `extendedClient` carries the tenant-scope extension, so the two paths can't drift again.

## Acceptance Criteria

- [x] Vault-mode extended client composes tenant-scope over soft-delete, wired to `resolveTenantContext()` (unit regression).
- [x] env-mode composition unchanged (database suite green).
- [x] Cross-tenant read leak closed — TASK-444 M3/M4 e2e green; live curl scoped.
- [x] No schema/API change; no new lint errors in touched files.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket created + fixed. Root-caused the Vault-mode `buildVaultPrismaFactory` composing soft-delete only (never tenant-scope), leaving `CoreDatabaseService.client` unscoped in vault/prod mode → cross-tenant read leak (surfaced by TASK-444 e2e M3/M4). TDD fix mirrors env-mode `createExtendedPrismaClient`; unit 7/7, database suite 807, TASK-444 e2e 6/6, 443 e2e 4/4, live curl confirms scoped. Status: Completed. |
