# TASK-857 — The bootstrap TENANT_ADMIN can actually log in

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Branch** | `task-857-bootstrap-tenant-login` (worktree `../hope-v2-tenantadmin`, base `dev-2.2` @ `38f97cb43`) |
| **Ticket number** | `docs/implementation/` tops out at TASK-856; `docs/archive/` is NOT readable in this session (the `ls` was refused by the permission layer), so the archive was not consulted. TASK-857 is the next free number against the readable evidence. |

---

## Requirement Analysis

`93-bootstrap-tenant-admin.ts` (TASK-766) exists so that a `RUN_SEED="safe"` deployment comes up
with an administrator for its customer tenant. It creates the `User`, the `UserProfile` and the
tenant-scoped `UserRoleAssignment` — and **no `UserDepartment` row**.

`POST /api/v1/auth/login` requires BOTH halves of tenant membership for every non-super-admin,
non-service-account principal (`apps/api/src/modules/auth/auth.controller.ts:275-297`): an active
role assignment in the tenant **and** an active department membership in the tenant. The second
lookup returns nothing for the bootstrap account, so login answers
`401 "User does not have access to the specified tenant"`.

Net effect: the account the platform provisions specifically so an operator can get in **cannot
get in, in any seed mode**. Day-1 blocker.

Requirement: seed the membership the auth path actually requires, in the seed, without weakening
the auth check.

---

## Current State Evaluation — the four questions, answered against the code

### 1. What exactly does `findActiveDepartmentForUserInTenant` require?

`packages/applications/src/services/user/userDepartment/user-department.service.ts:52-67`:

```ts
const row = await this.databaseService.baseClient.userDepartment.findFirst({
  where: { userId, tenantId, resourceStatus: ResourceStatusType.ENABLED },
  select: { id: true },
});
```

So the requirement is exactly: **one `UserDepartment` row with `userId` = the logging-in user,
`tenantId` = the resolved login tenant, and `resourceStatus = ENABLED`** (the column default —
`packages/database/src/prisma/db_main/user.prisma:312`).

- It reads the **baseClient**, deliberately bypassing the tenant-scope `$extends` (no CLS tenant
  exists pre-auth); the tenant boundary is the explicit `tenantId` predicate.
- `isPrimary` is **not** consulted by the gate.
- The **department row itself is not status-checked**. It must nevertheless exist, because
  `UserDepartment.departmentId` is a real FK (`user.prisma:325-326`) — an invented uuid would fail
  the insert. So: an existing `Department` in the same tenant; its own `resourceStatus` is
  irrelevant to login (we still pick an ENABLED one — a DISABLED department is not a place to put
  a brand-new administrator).

### 2. Which department should the bootstrap tenant admin belong to?

The tenant seed (`04-department.ts`) **does** create a catalog, and it runs before `93`
(`seed/index.ts:138` vs `:245`), in both `all` and `safe`:

- Global customer tenant (`50000000-…`): the platform-generic care-setting catalog
  `OPD, IPD, ER, PERI, RAD, LAB, BEH, PEDS` (`04-department.ts:44-177`).
- ArcaAI (`93`'s default target, key `ARCAAI`): the clinical roster
  `GEN, SURG, RHEUM, NEUR, ORTH, HEME, BREN, DERM, DIET, NEPH, SONC` (`04-department.ts:211-427`).

So **no department needs to be created** — and creating one would be the wrong move: `Department`
is a clinically load-bearing lookup (consultation routing, prompt/agent resolution,
`ConsultationContextSchema` scoping), and injecting a synthetic "Administration" department into a
customer's clinical catalog is exactly the fabricated-data posture that `safe` mode exists to
avoid.

Which existing one? The repo already answers this for the *demo* tenant administrators, in
`91-user.ts:46-85` (`PRIMARY_DEPARTMENT_CODE_BY_USERNAME`):

| account | tenant | department |
|---|---|---|
| `tenant_admin` | Global | `OPD` (the care-setting catalog's front door) |
| `arcaai_admin` | ArcaAI | `GEN` (General Medicine) |

The bootstrap admin follows that established intent rather than inventing a new one: prefer the
tenant's **general / front-door** department by code — `GEN`, then `OPD`, then `ADMIN` — and, for a
tenant whose catalog uses none of those codes, fall back to the alphabetically-first ENABLED
department so the choice is deterministic and re-runnable. The chosen department is **logged**, and
it is trivially reassignable afterwards through the console (`UserDepartmentService.assign`), so the
fallback is a starting point, not a permanent clinical claim. For the two seeded tenants this rule
reproduces the table above exactly (ArcaAI → `GEN`, Global → `OPD`).

If the target tenant has **no** ENABLED department at all, the seed **throws** — matching both
`91-user.ts:917-930` ("fail loudly at seed time instead" of minting an unloggable user) and `93`'s
own posture of refusing to create an account whose grant resolves to nothing.

### 3. Does the SUPER_ADMIN bootstrap account (`92-bootstrap-admin.ts`) have the same problem?

**No, and it is structural rather than nominal.** Verified, not assumed from the name:

- `auth.controller.ts:250-251` — `getUserRoles(user.id)` →
  `userRoleAssignmentService.findActiveRolesForUser(userId)`
  (`userRoleAssignment.service.ts:126-151`), which queries `{ userId, resourceStatus: ENABLED }`
  with **no tenant predicate**; `isSuperAdmin = roles.includes('SUPER_ADMIN')`.
- `92-bootstrap-admin.ts:162,199` assigns the SYSTEM-tenant `SUPER_ADMIN` role, so that
  membership check passes cross-tenant.
- `auth.controller.ts:257-297` — the entire tenant-membership block, **including** the
  `findActiveDepartmentForUserInTenant` call, sits in the `else` branch of `if (isSuperAdmin)`.
  A super admin never reaches it; with `tenantKey` set it resolves the tenant and stops there.

So `92` is unaffected, and the fix does not need to touch it.

### 4. Is `93` even reached in `safe` mode?

**Yes.** `seed-mode.ts`'s `SEED_PHASES_EXCLUDED_FROM_SAFE` is
`['02-apikey', '07f-…', '08-dna-writing-style', '09-consultation', '10-audit-log',
'23-arcaai-workflow-authoring', '91-user']` — `93-bootstrap-tenant-admin` is absent, and
`isPhaseEnabled('93-bootstrap-tenant-admin', 'safe') === true` (already pinned by
`__tests__/bootstrap-tenant-admin.test.ts`).

This makes the bug worse, not better: `91-user` (which *does* seed memberships) is excluded from
`safe`, so in a `safe`-seeded environment `93` is the **only** tenant administrator that exists —
and it is the one that cannot log in.

### One more finding, in scope

`93` is **create-only, keyed by the reserved user id**: an already-provisioned bootstrap admin
returns early and is never touched. A deployment that already ran the broken `93` therefore keeps
its unloggable account forever, because the fix would never execute for it. The repair must
therefore run on **both** paths — create, and already-exists — while still never touching the
password.

---

## Implementation Plan (TDD)

1. **RED** — `__tests__/task-857-bootstrap-tenant-admin-membership.test.ts`, behavioural, over the
   in-memory fake Prisma client precedent (`task-686-loop-defaults-idempotency.test.ts`):
   - a fresh provision writes a `UserDepartment` satisfying the login predicate
     `{ userId, tenantId, resourceStatus: ENABLED }`;
   - the department chosen for ArcaAI is `GEN`, for a Global-shaped catalog `OPD`;
   - re-running the seed adds nothing (idempotent) and does not rewrite the password;
   - an **existing** bootstrap admin with no membership is healed (the upgrade path);
   - a tenant with no ENABLED department throws with an actionable message.
2. **GREEN** — in `93-bootstrap-tenant-admin.ts`: an exported pure
   `chooseBootstrapAdminDepartment()` (the ordering rule) plus an
   `ensureBootstrapTenantAdminMembership()` helper called on both the create path and the
   already-exists path.
3. **Verify** — `pnpm --filter @arcaai/database test`, `pnpm test:unit`.

Not touched: `auth.controller.ts` (the `UserDepartment` requirement is a real tenancy boundary —
the defect is the missing seed row, not the gate), no API routes, no Prisma schema, no migration.

---

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/93-bootstrap-tenant-admin.ts` | Seeds the `UserDepartment` half of tenant membership. Adds the exported ordering rule `BOOTSTRAP_TENANT_ADMIN_DEPARTMENT_CODE_PREFERENCE` + `chooseBootstrapTenantAdminDepartment()`, and the `ensureBootstrapTenantAdminMembership()` helper, called on BOTH the create path and the already-exists path. |
| `packages/database/src/prisma/db_main/seed/__tests__/task-857-bootstrap-tenant-admin-membership.test.ts` | New — 11 behavioural tests over the in-memory fake Prisma client, plus a drift guard on the login-gate predicate. |

Not touched, deliberately: `auth.controller.ts` (the `UserDepartment` requirement is a real
tenancy boundary — the defect was the missing seed row, not the gate), `92-bootstrap-admin.ts`
(structurally unaffected, see Q3), the Prisma schema, and every API route — so no route manifest /
OpenAPI / portal / SDK regeneration applies.

### Behaviour

- **Fresh provision** — creates a `UserDepartment { userId, tenantId, isPrimary: true }`; status
  comes from the column default (`ENABLED`), which is exactly what the login gate reads.
- **Department choice** — `GEN` → `OPD` → `ADMIN`, else the alphabetically-first ENABLED
  department; DISABLED departments are never chosen; the choice is logged.
- **No department in the tenant** — throws with an actionable message rather than minting an
  account that cannot sign in.
- **Idempotent / CREATE-ONLY** — if the user already has ANY `UserDepartment` row in that tenant
  (any status) the seed leaves it alone: it never fights an operator who disabled the membership,
  and never risks a second row on the `(tenantId, userId, departmentId)` unique index (which would
  fail the insert and wedge the Argo sync).
- **Upgrade path** — an account provisioned by the pre-fix phase is healed on the next run. The
  tenant is read off the account's own ENABLED `UserRoleAssignment`, not off the current env, so a
  changed `BOOTSTRAP_TENANT_ADMIN_TENANT_KEY` cannot bind it into a second tenant. The password is
  never touched.

### Evidence

**RED (before the fix)** — `npx vitest run task-857`, `Tests 10 failed | 1 passed (11)`; the first
failure is the point of the ticket:

```
FAIL  …task-857-bootstrap-tenant-admin-membership.test.ts > writes a UserDepartment that the login gate finds
AssertionError: expected null not to be null
    116|     const membership = await loginGateFindsMembership(tables, BOOTSTRA…
    117|     expect(membership).not.toBeNull();
```

The one test that passed in RED is the drift guard — i.e. the predicate the suite asserts against
is verifiably the one the login gate uses today.

**GREEN** — `npx vitest run task-857` → `Test Files 1 passed (1) / Tests 11 passed (11)`.

**Gates**

```
pnpm --filter @arcaai/database test   →  Test Files  75 passed (75)
                                          Tests  1770 passed (1770)      [baseline 1759 + 11 new]

pnpm test:unit                        →  Test Files  1340 passed | 2 skipped (1342)
                                          Tests  22681 passed | 4 skipped | 9 todo (22694)
                                          exit 0                          [baseline 22670 + 11 new]

pnpm --filter @arcaai/database typecheck → clean (tsc --noEmit)
```

Worktree note: both suites first failed on unbuilt workspace packages
(`@arcaai/json-schema-subset`, `@arcaai/workflow-contract`, `@arcaai/domains` — a fresh worktree has
no `dist/`). `pnpm build:packages` fixed it; no test failure was attributable to this change.

**Live proof — real Prisma client, real constraints, throwaway database.** `hope_task857` created
alongside the dev DB (the shadow-database pattern of `02-database-prisma.md`; nothing shared was
reset), `db push`, then the real phase run three times and queried with the login gate's own
predicate. Dropped afterwards.

```
Seeding bootstrap TENANT_ADMIN...
  Joined department "GEN" — the second half of tenant membership, without which login is refused.
  Created TENANT_ADMIN "tenant-admin" <ops@example.test> on tenant "ARCAAI" (50000000-…-000000000001).
LOGIN GATE RESULT (1st seed): {"found":true,"department":"GEN","isPrimary":true,"status":"ENABLED"}
Seeding bootstrap TENANT_ADMIN...
  Bootstrap tenant admin already exists (username "tenant-admin") — leaving the credential untouched.
  Department membership already present — leaving it untouched.
RE-SEED: {"membershipRows":1,"passwordUnchanged":true}
GATE AFTER WIPING MEMBERSHIP (simulates the pre-fix account): {"found":false}
Seeding bootstrap TENANT_ADMIN...
  Bootstrap tenant admin already exists (username "tenant-admin") — leaving the credential untouched.
  Joined department "GEN" — the second half of tenant membership, without which login is refused.
HEALED: {"found":true,"passwordUnchanged":true}
```

### Does a `safe`-seeded environment now have a usable login?

**Yes — provided `BOOTSTRAP_TENANT_ADMIN_EMAIL` + `…_PASSWORD` are set.** In `safe`, `04-department`
and `93-bootstrap-tenant-admin` both run and in that order, so the tenant has a catalog and the
administrator now gets both halves of membership: it authenticates with `tenantKey` = its tenant's
key and reaches a token. Unset variables still mean "not requested" (unchanged, deliberate) — with
neither set, a `safe` environment has a platform SUPER_ADMIN (if `92` was requested) and **no**
tenant administrator at all; that is a configuration choice, not this bug.

Not verified here: a live `POST /api/v1/auth/login` round trip, which needs a running gateway and a
seeded database — a shared surface this worktree deliberately did not touch. The gate query itself
was executed verbatim against real rows (above).

---

## Change History

| Date | Change |
|---|---|
| 2026-09-03 | Ticket opened; four questions answered against the code; plan written before any code. |
| 2026-09-03 | RED (10 failing), then GREEN: membership seeding + department-choice rule + upgrade-path healing in `93`. Gates and a live throwaway-DB proof captured. Status → Review. |
