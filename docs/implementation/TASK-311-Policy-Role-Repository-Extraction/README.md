# TASK-311 — Policy / Role / RolePolicy repository extraction (close §H-9 fully)

| Field | Value |
|---|---|
| **Ticket** | TASK-311-Policy-Role-Repository-Extraction |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `Pending` |
| **Classification** | Refactor (DDD alignment, no behaviour change) |
| **Priority** | Low — pure architectural cleanup; current code is correct |
| **Source** | TASK-307 §10.1 deferral W7.A.15 — closes the partial §H-9 closure from W6 |
| **Audit refs** | `04-api-design-review.md` §H-9 (Strategic improvement #9) — currently marked "RESOLVED in TASK-307 W6 (partial)" pointing at this ticket |
| **Base branch** | `fix/2605-review` (HEAD `2a1ee7be` — TASK-307 closed) |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-307 W6 (merge `77068325`) closed audit C-10 by extracting `PolicyService` + `RbacRoleService` from the controllers — controllers now delegate to services instead of touching Prisma directly. However, both services bypass the domain-layer repository pattern and call `CoreDatabaseService.client` directly. This was a **deliberate** W6 choice for verbatim behaviour preservation (avoid breaking the existing SysEvent `resourceType: 'Permission'` contract, avoid introducing soft-delete drift, avoid touching the entity layer mid-audit-closure).

This ticket finishes the §H-9 closure properly by introducing the three repository facades and migrating the services to use them.

### 1.2 Business context

- The audit's §H-9 specifically called out "the current direct-Prisma pattern dramatically increases the chance of cross-tenant policy leak". W6 closed the **controller**-level pattern; the **service**-level pattern remains.
- The rest of the domain layer (User, Tenant, ConsultationJob, etc.) uses repositories. Policy/Role are the odd-ones-out, which makes future maintenance error-prone.
- Repository extraction unlocks uniform soft-delete, audit hooks, tenant-scoping via the existing Prisma `tenantScope` extension, and `BaseService.broadcastSysEvent` integration.

### 1.3 Acceptance criteria

- **AC-1** Three new repositories under `packages/domains/src/repositories/`:
  - `PolicyRepository` — CRUD on `Policy`, with the Prisma `tenantScope` extension applied where relevant.
  - `RoleRepository` — CRUD on `Role`.
  - `RolePolicyRepository` — the join-table operations (assign/unassign policy to role; list policies by role).
- **AC-2** Each repository has its own factory + mapper, following the pattern set by `UserRepository` (TASK-306).
- **AC-3** `PolicyService` (`packages/applications/src/services/rbac/policy/policy.service.ts`) refactored to inject and use `PolicyRepository` + `RolePolicyRepository`. No direct `CoreDatabaseService` access.
- **AC-4** `RbacRoleService` (`packages/applications/src/services/rbac/role/role.service.ts`) refactored to inject and use `RoleRepository` + `RolePolicyRepository`. No direct `CoreDatabaseService` access.
- **AC-5** `ResourceType.Permission` SysEvent string preserved verbatim — DO NOT migrate to `ResourceType.Policy` (downstream consumers depend on the literal `'Permission'` resourceType per W7.A.16 TSDoc). Confirm via `rg 'resourceType.*Permission' apps/ packages/` before refactoring.
- **AC-6** Soft-delete behaviour aligned with the rest of the domain: `delete` operations call `repository.softDelete(id)`, not `client.delete()`.
- **AC-7** Existing TASK-306 tests for Policy + Role + RolePolicy all continue to pass. New tests for each repository (CRUD + soft-delete + tenant-scope). New tests for the refactored services (no direct-Prisma assertion via `vi.mocked(CoreDatabaseService).client.policy.findUnique).not.toHaveBeenCalled()` pattern).
- **AC-8** ESLint rule from TASK-307 W6 (`no-controller-direct-prisma`) extended or supplemented with a `no-service-direct-prisma` rule that blocks `databaseService.client.*` access from `packages/applications/src/services/**/*.service.ts` with the same allow-list pattern. Add this only after the refactor is clean.

### 1.4 Out of scope

- Migrating to `ResourceType.Policy` — coordinate event-schema change separately (see W7.A.16 TSDoc).
- Other services that may also touch Prisma directly (audit log, etc.) — separate sweep.
- CASL policy engine refactoring.

---

## 2. Current State Evaluation

### 2.1 Existing code

- `packages/applications/src/services/rbac/policy/policy.service.ts` — has 11-line TSDoc explaining the direct-Prisma choice + the W7.A.15 deferral link.
- `packages/applications/src/services/rbac/role/role.service.ts` — same TSDoc pattern.
- `packages/domains/src/repositories/UserRepository.ts` (and siblings) — reference patterns for the new repositories.
- `packages/database/prisma/schema.prisma` — `Policy`, `Role`, `RolePolicy` (or whatever the join entity is named — verify).
- `apps/api/src/modules/policies/policies.controller.ts` + `apps/api/src/modules/rbac/role/role.controller.ts` — already controller-thin after W6.

### 2.2 Dependencies

- Domain layer (`packages/domains`) — primary destination for the new repositories.
- Applications layer (`packages/applications`) — re-wires service injections.
- ESLint base config (`packages/config-eslint/base.js`) — extends W6's rule.

### 2.3 Risk

- **Behaviour drift** during the refactor. Mitigated by AC-7's regression-suite gate.
- **SysEvent `resourceType` regression** — easy to accidentally swap `'Permission'` → `'Policy'` during refactor. AC-5 explicitly pins this.
- **Soft-delete regression** — if existing direct-Prisma `delete` calls were hard-deletes, switching to `softDelete` is a behaviour change. Audit before merging.

---

## 3. Implementation Plan

### 3.1 Phase order

1. Inventory existing Prisma calls in `policy.service.ts` + `role.service.ts`. Categorize: `findUnique`, `findMany`, `create`, `update`, `delete`, raw SQL.
2. Verify the current `delete` semantics — are they hard-deletes or soft? AC-6 is conditional on this.
3. Implement `PolicyRepository` + `RoleRepository` + `RolePolicyRepository` with factory + mapper for each. Unit tests for each.
4. Migrate `PolicyService` to use the new repositories. Run TASK-306 + TASK-307 W6 tests as regression gate.
5. Migrate `RbacRoleService` likewise.
6. Extend the ESLint rule (AC-8).
7. Run the full E2E suite as final anti-regression.

### 3.2 Testing

| Layer | Test |
|---|---|
| Domain | `PolicyRepository.test.ts`, `RoleRepository.test.ts`, `RolePolicyRepository.test.ts` (NEW) |
| Application | `policy.service.test.ts` (extend with no-direct-Prisma assertions) |
| Application | `role.service.test.ts` (extend) |
| API | TASK-307 W6 tests must continue to pass |
| E2E | Existing policy + role + rolePolicy E2E specs |

### 3.3 Estimated scope

- Three repositories + factories + mappers + tests: **L** (~12h)
- Service refactors + test extensions: **M** (~5h)
- ESLint rule extension: **S** (~1h)
- **Total**: **L** (~18h)

---

## 4. Implementation Summary
*(to be filled in at close-out)*

---

## 5. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferral W7.A.15 (closes the partial §H-9 closure from W6) | — |
