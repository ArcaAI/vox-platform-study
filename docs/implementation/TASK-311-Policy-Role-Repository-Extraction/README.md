# TASK-311 — Policy / Role / RolePolicy repository extraction (close §H-9 fully)

| Field | Value |
|---|---|
| **Ticket** | TASK-311-Policy-Role-Repository-Extraction |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `In Progress` |
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

### 4.1 Phase 1 — Inventory of direct Prisma access (verified 2026-05-28)

`rg "databaseService\.client\.(policy|role|rolePolicy)\b" packages/applications/src/services/rbac/` against the worktree base commit `a6a19797`:

#### `policy.service.ts` — 8 callsites (one model: `policy`)

| Line | Method | Prisma call | Purpose |
|---|---|---|---|
| 144–150 | `findAll` | `policy.findMany` + `policy.count` | Paginated listing with optional search/scope filter |
| 157 | `findOne` | `policy.findUnique({ where: { id } })` | Lookup by id |
| 168–178 | `create` | `policy.create({ data })` | Persist; stamps `createdBy` from CLS |
| 206–216 | `update` | `policy.update({ where, data })` | Full update; stamps `updatedBy` |
| 235 | `patch` | `policy.findUnique({ where: { id } })` | Existence check before patching |
| 248–263 | `patch` | `policy.update({ where, data })` | Partial update with optional `resourceStatus` stamping |
| 283–286 | `softDelete` | `policy.findUnique({ where, select: { name: true } })` | Lookup name for the audit event |
| 293–300 | `softDelete` | `policy.update({ where, data: { resourceStatus: DELETED, … } })` | **Already soft-delete** — flips `resourceStatus` |

#### `role.service.ts` — 13 callsites (two models: `role`, `rolePolicy`)

| Line | Method | Prisma call | Purpose |
|---|---|---|---|
| 86–93 | `findAll` | `role.findMany` + `role.count` | Paginated listing; includes `RolePolicies` |
| 100–103 | `findOne` | `role.findUnique({ where, include: RolePolicies })` | Lookup with RolePolicies join |
| 113–124 | `create` | `role.create({ data })` | Persist; stamps `createdBy` |
| 142–145 | `update` | `role.findUnique({ where, select: { isSystemRole, name } })` | Existence + system-role guard |
| 162–173 | `update` | `role.update({ where, data, include: RolePolicies })` | Full update |
| 193–196 | `patch` | `role.findUnique({ where, select })` | Existence + system-role guard |
| 213–229 | `patch` | `role.update({ where, data, include })` | Partial update with optional `resourceStatus` stamping |
| 249–252 | `softDelete` | `role.findUnique({ where, select })` | System-role guard + name lookup |
| 263–270 | `softDelete` | `role.update({ where, data: { resourceStatus: DELETED, … } })` | **Already soft-delete** |
| 292–294 | `assignPolicy` | `rolePolicy.findFirst({ where: { roleId, policyId } })` | Pre-check for existing assignment |
| 297–303 | `assignPolicy` | `rolePolicy.update({ where: { id }, data })` | Re-enable + re-prioritise existing assignment |
| 306–314 | `assignPolicy` | `rolePolicy.create({ data })` | Create new assignment |
| 336–343 | `removePolicy` | `rolePolicy.updateMany({ where: { roleId, policyId }, data: { resourceStatus: DELETED, … } })` | **Already soft-delete** of the join row |
| 375–378 | `validateParentRole` (private helper) | `role.findUnique({ where, select: { id, parentRoleId } })` | Parent existence check |
| 393–396 | `validateParentRole` (private helper) | `role.findUnique({ where, select: { parentRoleId } })` | Cycle detection walk |

**Raw SQL**: zero callsites. **Hard deletes**: zero callsites (all deletes are soft via `update({ resourceStatus: DELETED, … })`). **Tenant scope**: zero callsites (Policy/Role/RolePolicy are RBAC primitives, not tenant-scoped — they live in `core` schema and are global; the `tenantScope` Prisma extension is a no-op for these models).

### 4.2 Phase 2 — Delete-semantics audit (AC-6 conditional)

Confirmed: **all three existing `*.softDelete` paths already use `update({ data: { resourceStatus: DELETED, resourceStatusUpdatedAt, resourceStatusUpdatedBy }, … })`** — i.e. they are soft deletes, not hard deletes. AC-6 ("delete operations call `repository.softDelete(id)`, not `client.delete()`") is therefore a **pure encapsulation change**, not a behaviour change. The only observable diff after migrating to the base-class `Repository.softDelete(id, updatedBy)` is that it also bumps `_version` (TASK-302 Stream D Phase B B.8) — this is an intentional correctness improvement that closes a stale-CAS-after-delete window and is **not** a regression. No user approval needed.

### 4.3 Design decisions

The README §3.1 plan called for three repositories under `packages/domains/src/repositories/` with "factory + mapper matching the `UserRepository` pattern". Below are the design choices made during execution, recorded here for reviewer context.

#### D-1. Naming: `RbacRoleRepository`/`RbacRoleEntity`/`RbacRoleFactory`/`RbacRoleEntityMapper`

The existing `repositories/generated/core/RoleRepository.ts`, `entities/generated/core/RoleEntity.ts`, `factories/generated/core/RoleFactory.ts`, `mappers/generated/core/RoleEntityMapper.ts` are **stale** (they model an older schema where the RBAC primitive was named `Permission`/`RolePermission`, not `Policy`/`RolePolicy`), and the stale `RoleRepository` is still imported by `apps/api/src/modules/auth/auth.controller.ts:12` and registered in `packages/domains/src/common/databaseServices/core/core.database.module.ts:28` — both of which are **outside this ticket's scope** (TASK-308 owns `auth.controller.ts`; the core database module sits outside the per-ticket allow-list).

Renaming or replacing the stale generated files in place is therefore not possible without breaking that constraint. The new RBAC-side Role repository is therefore named `RbacRoleRepository` (and its companion `RbacRoleEntity`/`RbacRoleFactory`/`RbacRoleEntityMapper`) to follow the **W6 `RbacRoleService` precedent** (TASK-307 W6.3 introduced `RbacRoleService` to disambiguate from the legacy `services/security/role/RoleService`). The new `PolicyRepository` and `RolePolicyRepository` have no name conflict and keep their AC-1 names verbatim.

This is a literal deviation from AC-1 ("three new repositories … `PolicyRepository`, `RoleRepository`, `RolePolicyRepository`") that has been folded into D-1; everything else about AC-1 — count, location under `packages/domains/src/repositories/`, separate factory + mapper per repo — is satisfied.

#### D-2. Co-located DDD layers per repository

Per the hard-constraint ("DO NOT modify files outside `packages/domains/src/repositories/**`, `packages/applications/src/services/rbac/**`, `packages/config-eslint/base.js`, and the ticket README"), the new entity classes, factories, and mappers cannot be added under the canonical `entities/`/`factories/`/`mappers/` trees. They are co-located beside their repository in a per-aggregate subfolder under `repositories/`:

```
packages/domains/src/repositories/
├── policy/
│   ├── PolicyEntity.ts
│   ├── PolicyFactory.ts
│   ├── PolicyEntityMapper.ts
│   ├── PolicyRepository.ts
│   ├── index.ts
│   └── __tests__/PolicyRepository.test.ts
├── role/
│   ├── RbacRoleEntity.ts
│   ├── RbacRoleFactory.ts
│   ├── RbacRoleEntityMapper.ts
│   ├── RbacRoleRepository.ts
│   ├── index.ts
│   └── __tests__/RbacRoleRepository.test.ts
└── role-policy/
    ├── RolePolicyEntity.ts
    ├── RolePolicyFactory.ts
    ├── RolePolicyEntityMapper.ts
    ├── RolePolicyRepository.ts
    ├── index.ts
    └── __tests__/RolePolicyRepository.test.ts
```

Each `<Aggregate>EntityMapper` extends `BaseMapper<DomainEntity, DataModel>` directly and implements `toPersistence`/`toDomainEntity` with explicit field assignments (skipping `AutoClassMapper`/`AutoEntityChangeMapper` because no local `Models.Policy`/`Models.RolePolicy` class exists — those would need to live in `packages/domains/src/models/`, which is outside scope). The mapper output is a Prisma-shaped plain object (`Prisma.PolicyCreateInput`-compatible for `toPersistence`; `Prisma.PolicyGetPayload<{}>`-compatible for `toDomainEntity`).

#### D-3. DI registration in service modules (not `CoreDatabaseModule`)

`packages/domains/src/common/databaseServices/core/core.database.module.ts` is outside the per-ticket allow-list. The three new repositories are registered as NestJS providers in `PolicyServiceModule` and `RbacRoleServiceModule` instead, which both already import `CoreDatabaseModule` (and therefore have access to `CoreUnitOfWorkService`).

#### D-4. `ResourceType.Permission` SysEvent string preserved (AC-5)

`rg 'resourceType.*Permission' apps/ packages/ --type ts -c` before refactor:

```
packages/domains/src/entities/generated/core/PermissionEntity.ts:3
packages/domains/src/factories/generated/core/PermissionFactory.ts:1
packages/applications/src/services/security/permission/__tests__/permission.dto.mapper.test.ts:1
packages/applications/src/services/rbac/policy/policy.service.ts:1
packages/applications/src/services/rbac/policy/__tests__/policy.service.task307.test.ts:4
packages/applications/src/services/rbac/role/role.service.ts:2
packages/applications/src/services/rbac/role/__tests__/role.service.task307.test.ts:2
```

The first three lines (8 matches) are in the **stale** `Permission`/`RolePermission` codepath that this ticket does not touch. The remaining four (7 matches) are inside this ticket's scope (`packages/applications/src/services/rbac/`) and **must be preserved verbatim** — `PolicyService` extends `BaseService` with `ResourceType.Permission` (not `Policy`) per W7.A.16, and `RbacRoleService.assignPolicy/removePolicy` emits events with `resourceType: ResourceType.RolePermission` (not `RolePolicy`) per W7.A.15 carryover. The acceptance-criterion check after refactor is `rg ... -c` == identical baseline.

---

## 5. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferral W7.A.15 (closes the partial §H-9 closure from W6) | — |
| 2026-05-28 | Phase 1 inventory + Phase 2 delete-semantics audit recorded inline in §4.1/§4.2. Phase-3 design decisions (D-1 naming, D-2 layout, D-3 DI, D-4 SysEvent preservation) recorded in §4.3. Status → `In Progress`. | `docs/implementation/TASK-311-Policy-Role-Repository-Extraction/README.md` |
