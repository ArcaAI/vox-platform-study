# TASK-409 — Policy Break-Glass (P2-11): `isProtected` hardening + step-up second confirmation

- **Ticket**: TASK-409
- **Short name**: Policy-Break-Glass
- **Created**: 2026-07-02
- **Updated**: 2026-07-02
- **Status**: Completed
- **Type**: feature (security vertical — AUTH-SENSITIVE)
- **Source**: approved backlog item **P2-11**; refines TASK-390 #22 (policy anti-lockout guard) per the residual notes ratified 2026-07-01 (name-fragility + break-glass follow-up).
- **Owner scope**: policy/role modules across layers, the `Policy` Prisma model (+ migration + seed touch), SDK policy/role hook additions, `apps/admin/src/features/roles/**` additions, `task-409-*` specs, this doc, the `:8868` stack.

> **Ticket-number check:** `docs/implementation/` highest existing is **TASK-408**; **TASK-409** is the next free number (confirmed by directory listing 2026-07-02).

---

## 1. Requirement Analysis

TASK-390 shipped the policy **anti-lockout guard**: the two seeded, system-critical GLOBAL
policies (`system-full-access`, `rbac-system-manage`) cannot be deleted, disabled,
re-scoped, or have their load-bearing rules stripped — by anyone, ever (**RATIFIED**:
absolute, no override). Two residuals were flagged:

1. the protected set is identified **by name** → rename-fragile;
2. dangerous-but-*allowed* RBAC mutations happen with a single click — a
   "second-confirmation / break-glass" flow was approved as the refinement.

### Acceptance criteria

1. **Protected-set hardening** — `Policy` gains an additive `isProtected Boolean
   @default(false)`. The guard treats a policy as protected when `isProtected === true`
   **OR** the legacy name matches (defense in depth). The seed marks the two system
   policies `isProtected: true` (upsert). The API refuses any attempt to unset
   `isProtected` via update (server-side strip; explicit attempt → 400).
2. **Break-glass second confirmation** for dangerous-but-allowed mutations — policy
   **DELETE**, **detach-from-role**, **rule-edits of policies attached to >1 role**, and
   **role deletion**: the caller must re-enter their **current password** (verified
   server-side via `ICryptoService`, TASK-396 pattern) **and** type a `confirmationName`
   exactly matching the policy/role name. Missing confirmation → **428**; wrong password
   → **401**; wrong name → **400**. The two absolutely-protected policies remain
   absolutely blocked — break-glass does **NOT** override them (standing decision).
3. **Audit** — forced audit rows (TASK-396 `forceAuditLog` pattern) on every
   break-glass-confirmed mutation AND every rejected attempt (actor, target, action,
   outcome; **never** the password).
4. **FE** — dangerous actions in `apps/admin` roles feature open a break-glass dialog
   (type the exact name + password, destructive-styled confirm), reusing the TASK-396
   `RevealSecretDialog` step-up UX. Protected policies keep the existing
   disabled/`Protected` affordance (no break-glass path offered).
5. **Docs** — this README documents the deployment constraint (what the guard protects,
   why `isProtected` + name fallback, seed requirements).

---

## 2. Current State Evaluation

- **Guard (TASK-390)**: `PolicyService.PROTECTED_SYSTEM_POLICIES` (name-keyed map →
  load-bearing rule tuples) + `assertProtectedDeletionAllowed` /
  `assertProtectedMutationAllowed` wired into `update`/`patch`/`softDelete`.
  Name-only classification (the flagged fragility).
- **Schema**: `Policy` (packages/database/src/prisma/db_main/rbac.prisma) has no
  protected marker. Precedent for a boolean flag: `Role.isSystemRole Boolean
  @default(false)` (no `@map`, no index).
- **Domain layer** (TASK-311 thin facades): `PolicyRepository` (pass-through delegate),
  `PolicyFactory` (create/update input builders — field-picked, never forwards unknown
  keys), `PolicyEntityMapper.PolicyRecord`, generated `models/generated/core/PolicyModel`.
  `RolePolicyRepository` has no count surface (needed for the ">1 role" trigger).
- **Step-up precedent (TASK-396)**: password re-verified against the caller's own bcrypt
  hash (`UserRepository.findById` + `ICryptoService.verify`); missing password → 401 in
  that flow; audit via a **direct** `ResourceViewed` emit with `forceAuditLog: true`
  (the only SysEvent handler honouring the flag) and non-null tenant attribution
  (`AuditLogProcessor` fail-closes on a null tenant).
- **OCC precedent**: missing `If-Match` → **428** (`PreconditionRequiredException`) —
  the "428-style" convention this ticket reuses for a missing break-glass confirmation.
- **API**: `PoliciesController` / `RolesController` (`/admin/rbac/*`) — bare `DELETE`
  routes, `UpdatePolicyDto` (whitelisted; `forbidNonWhitelisted: true` globally).
- **SDK**: `AgenticClient.delete` has **no body support**; `usePolicies.remove`,
  `useRoles.deleteRole/removePolicy` send bare DELETEs.
- **FE**: `/roles` route + `features/roles/**` — TASK-395 master-detail browser
  (inheritance tree, effective abilities, permission matrix — PRESERVE) with
  `ConfirmDelete` popovers for role/policy delete and instant detach in
  `RolePoliciesSheet`; `protected-policies.ts` mirrors the protected set by name.
- **E2E surfaces relying on the old contract**: `task-390-super-admin-backend.spec.ts`
  (bare policy DELETE → 204), `rbac.spec.ts` (bare detach → 2xx/404; system-role delete
  → 400), shared helpers `deleteTestPolicy`/`deleteTestRole` (bare DELETEs used by
  many suites' cleanup).

---

## 3. Design Decisions

### D1 — `isProtected` column (additive only)
`isProtected Boolean @default(false)` on `Policy`, placed with the business fields
(mirrors `Role.isSystemRole` — no `@map`, no index: the flag is read on by-id rows,
never used as a query filter; the model's business columns are unmapped by convention).
Exposed read-only through `PolicyRecord` → `PolicyResponse` → SDK `Policy` so the
console renders protection server-authoritatively.

### D2 — Guard classification = `isProtected` OR legacy name (defense in depth)
A policy is protected when `isProtected === true` **or** its name is in the legacy
`PROTECTED_SYSTEM_POLICIES` map. Load-bearing-rule requirements stay keyed by name
(the only rows whose rule shape is known); a hypothetical `isProtected`-only row gets
delete/disable/rescope protection with no rule constraints. Rename a seeded policy →
the flag still protects it (fixes the fragility); wipe the flag in the DB → the name
match still protects it (fallback).

### D3 — `isProtected` is API-immutable
Create/Update DTOs do **not** whitelist `isProtected` → the global `ValidationPipe`
(`whitelist` + `forbidNonWhitelisted`) rejects any request carrying it with **400**
(the "explicitly attempted" case). Defense in depth: `PolicyService.update/patch`
re-checks at runtime (service-level callers) and throws `BadRequestException`;
`PolicyFactory.buildUpdateInput` field-picks and can never forward it (the strip).
Only the seed writes the flag.

### D4 — Break-glass mechanics (reuses TASK-396 step-up + OCC 428 convention)
`BreakGlassConfirmation { password, confirmationName }`, verified by a shared
`BreakGlassVerifier` (applications/rbac):

| Case | Result |
|---|---|
| `password` or `confirmationName` missing | **428** `PreconditionRequiredException` — clear message naming both requirements |
| password wrong (bcrypt verify vs caller's own hash) | **401** `UnauthorizedException` |
| `confirmationName` ≠ exact target name | **400** `BadRequestException` |
| valid | mutation proceeds |

Required on: policy `softDelete` (always); role `softDelete` (always — evaluated **after**
the existing system-role 400 block, which break-glass does not override); detach
(`removePolicy`, always — `confirmationName` = the **policy** name being detached);
policy `update`/`patch` **only when** `rules` change AND the policy is attached to
**>1 ENABLED role** (blast-radius trigger; counted via `RolePolicyRepository`).

**Precedence:** the absolute anti-lockout block (403) is asserted **before** break-glass
evaluation — a protected policy is 403 even with a valid password+name (break-glass
never overrides; also never leaks whether the password was right).

### D5 — Audit (TASK-396 `forceAuditLog` pattern, tenant-safe) — *as built*
Every break-glass evaluation emits a **direct** `SysEventType.ResourceViewed` with
`forceAuditLog: true` and a flat data payload
`{ action: 'RBAC_BREAK_GLASS', operation, outcome, targetId, targetName, targetType }`,
actor (`responsibleEntityId`), correlation id — **never the password**. Operations:
`policy-delete`, `policy-edit` (protected-block on update/patch), `policy-rule-edit`
(>1-role trigger), `role-delete`, `role-policy-detach`; outcomes: `confirmed`,
`rejected-missing-credentials` (428), `rejected-unauthenticated`,
`rejected-wrong-password` (401), `rejected-wrong-name` (400),
`rejected-protected` (absolute-block attempts are audited too). Tenant attribution:
`this.tenantId ?? SYSTEM_TENANT_ID` — policies/roles are platform-wide rows and the
reserved system tenant (`00000000-0000-0000-0000-000000000000`) is their documented
home; a null tenant would be silently dropped by `AuditLogProcessor` (fail-closed).
The confirmed mutation additionally emits its normal `ResourceUpdated/Deleted` event
(unchanged TASK-311 wiring).

### D6 — Transport — *as built*
A `BreakGlassDto { password?, confirmationName? }` body on the three DELETE routes
(policy delete, role delete, detach) and a nested optional `breakGlass?: BreakGlassDto`
field on `UpdatePolicyDto` (rule edits ride the normal update body). `AgenticClient.delete`
gains optional `options.data` (additive); `usePolicies.remove(id, breakGlass?)`,
`UpdatePolicyInput.breakGlass`, `useRoles.deleteRole(id, breakGlass?)` /
`removePolicy(roleId, policyId, breakGlass?)` carry the confirmation
(`BreakGlassCredentials` exported from the SDK root). DTO fields are optional —
**presence is enforced in the service** (so the 428 convention, not a DTO 400,
reports a missing confirmation).

### D7 — FE UX
New `features/roles/break-glass-dialog.tsx` (RevealSecretDialog-patterned): states the
blast radius, requires typing the **exact name** (confirm disabled until it matches) +
current password, destructive-styled confirm, inline error on 401/400, wiped on close.
Wired in the `/roles` route: policy delete + role delete + detach open it directly
(the old one-click `ConfirmDelete` popovers are replaced by the dialog — it IS the
destructive confirmation); rule-edits open it **reactively** when the server answers
428 (the FE doesn't pre-compute attachment counts). Protected policies keep the
disabled/`Protected` affordance — no break-glass path is offered (server would 403).
`protected-policies.ts` now prefers the server `isProtected` marker (name fallback kept).

### D8 — Existing-spec alignment (contract change is intentional)
Bare DELETEs on policies/detach now 428 by design, so: `task-390-super-admin-backend.spec.ts`
(throwaway delete + cleanup), `rbac.spec.ts` (detach test), and the shared
`deleteTestPolicy`/`deleteTestRole` helpers (used by many suites' cleanup) are updated
to send break-glass credentials (seeded super-admin password; name fetched by id when
not known). System-role delete assertions stay valid (400 precedes break-glass).

---

## 4. Implementation Plan (STRICT layer chain + TDD)

1. **Database** — `rbac.prisma` +`isProtected`; authored migration
   `20260702150000_task_409_policy_is_protected` (single additive `ALTER TABLE … ADD
   COLUMN`); seed `01-policy.ts` marks the two system policies (create + update paths);
   seed unit tests extended (RED→GREEN).
   **Application protocol (both `hope_test`@5433 and `hope`@5432 — db-push-built, no
   `_prisma_migrations` baseline, so `migrate deploy` is NOT usable):** per DB, run
   `prisma migrate diff --from-url <db> --to-schema-datamodel` and verify a 100%
   additive delta (zero destructive statements) → plain non-force `prisma db push` →
   seed upsert (`UPDATE … SET "isProtected" = true WHERE name IN (…)`) → verify. STOP
   if anything destructive appears. `db:generate` after.
2. **Domains** — `PolicyModel` +`isProtected` (generator-shape hand edit);
   `PolicyEntityMapper` (`PolicyRecord`/`PolicyRowLike` + mapping);
   `RolePolicyRepository.countEnabledByPolicy(policyId)`.
3. **Applications (RED first)** — new `rbac/break-glass/` (`BreakGlassConfirmation`,
   `BreakGlassVerifier`, module exports); `PolicyService`: isProtected-OR-name guard,
   `isProtected`-unset 400, break-glass on softDelete + >1-role rule edits, audit
   emits; `RbacRoleService`: break-glass on softDelete + removePolicy, audit emits.
   Unit matrix: protected absolute-block incl. with break-glass attempted; unprotected +
   correct step-up passes; wrong password 401 / wrong name 400 / missing 428; audit
   emission per outcome (no password in payload); isProtected-unset rejected; >1-role
   trigger on/off; existing TASK-390/307 suites stay green (constructor updates only).
4. **API** — `BreakGlassDto`; `UpdatePolicyDto` +`password`/`confirmationName`;
   `PolicyResponse.isProtected`; controllers pass confirmations through (DELETE bodies);
   controller unit tests.
5. **SDK** — `AgenticClient.delete(endpoint, { data })`; `usePolicies.remove(id, conf?)`
   + `UpdatePolicyInput` fields + `Policy.isProtected?`; `useRoles.deleteRole(id, conf?)`
   / `removePolicy(roleId, policyId, conf?)`; hook unit tests; dist rebuild.
6. **FE** — `break-glass-dialog.tsx`; route wiring (delete/detach/rule-edit-428-retry);
   `roles-browser.tsx` delete affordance swapped to the dialog trigger (tree/matrix
   preserved); `protected-policies.ts` prefers `isProtected`; unit tests.
7. **E2E** — `apps/api/tests/e2e/task-409-break-glass.spec.ts` (full matrix on
   throwaway rows + protected 403 + audit rows + isProtected exposure/immutability);
   `apps/admin/e2e/task-409-break-glass.spec.ts` (dialog flow on a throwaway policy;
   wrong password inline; protected policy shows no break-glass path; all viewports);
   D8 alignment edits; re-run task-390 (API), rbac (API), task-391/395/396 (FE).
8. **Verify** — rebuild protocol (stop `dev:api:test` → `pnpm build:api` → restart →
   health 200); SDK dist + `:5174` restart; FE `type-check` + `build`; stack end-state
   (entitlements OFF, rate-limiting OFF).

---

## 5. Deployment constraint (what the guard protects & what a deployment MUST keep true)

- **What is absolutely protected:** the seeded GLOBAL policies `system-full-access`
  (`manage:all` — the super-admin grant) and `rbac-system-manage`
  (`manage:Role/Policy/RolePolicy/UserRoleAssignment` — RBAC administration). Deleting,
  disabling, re-scoping, or stripping their load-bearing rules would lock every
  super-admin out platform-wide. The block is **absolute**: no caller, no break-glass,
  no override (ratified 2026-07-01).
- **How protection is identified (two independent markers):**
  1. `Policy.isProtected = true` (DB column, seeded; survives renames);
  2. the legacy name match (`system-full-access`, `rbac-system-manage`; survives a
     lost/never-applied flag).
  Both must agree with the deployment's seed: **a deployment that renames the seeded
  policies keeps protection via the flag; a deployment that re-creates them (fresh DB)
  gets the flag from the seed.** Do not clear `isProtected` on these rows.
- **Seed requirements:** `packages/database/.../seed/01-policy.ts` marks exactly these
  two policies `isProtected: true` and re-asserts it on every seed run (upsert path).
  For databases provisioned before this ticket, the one-time upsert
  (`UPDATE "core"."Policy" SET "isProtected" = true WHERE name IN
  ('system-full-access','rbac-system-manage')`) is part of the rollout (applied to
  `hope_test`@5433 and `hope`@5432 — see §7 evidence).
- **Schema application on db-push-built databases:** both standing DBs have **no
  `_prisma_migrations` baseline** — `prisma migrate deploy` will NOT work there. The
  sanctioned path is: authored migration file (for migration-tracked environments) +
  `prisma migrate diff` pre-check proving a strictly additive delta + plain non-force
  `prisma db push` + the seed upsert. Any destructive statement in the diff = STOP.
- **API immutability:** `isProtected` is not writable through any endpoint (400 on
  explicit attempts; stripped from every write path). Only the seed/DBA path sets it.
- **Break-glass does not weaken the guard:** it adds a second confirmation to
  *allowed* dangerous mutations (policy delete, detach, wide rule edits, role delete);
  it grants nothing that was refused before.

---

## 6. Implementation Summary

All eight plan steps landed. Deviations from the plan (all naming/shape, no scope
change): the verifier is a plain async helper `checkBreakGlass(...)` in
`services/rbac/breakGlass.ts` (no class/module — it is called by the two services,
which already own the injected `UserRepository` + `ICryptoService`); transport uses a
nested `breakGlass` object on `UpdatePolicyDto` (D6 as-built); audit uses a single
action constant `RBAC_BREAK_GLASS` with an `operation` discriminator (D5 as-built);
the 428 is raised as `HttpException` with an object payload
(`code: 'HTTP.PRECONDITION_REQUIRED'`, matching the OCC decorator) because the
context interceptor mutates the response object. The FE additionally hardens
`RolePoliciesSheet`: detach buttons for protected policies are disabled with the
`Protected` reason (previously detach was offered and the server was the only stop).

### Files changed / added

**Database** (`packages/database`)
- `src/prisma/db_main/rbac.prisma` — **M**: `Policy.isProtected Boolean @default(false)`.
- `src/prisma/db_main/migrations/20260702150000_task_409_policy_is_protected/migration.sql` — **NEW** (single additive ALTER).
- `src/prisma/db_main/seed/01-policy.ts` — **M**: the two system policies carry
  `isProtected: true`; create + update seed paths persist it.
- `src/__tests__/seed.test.ts` — **M**: isProtected seed assertions.

**Domains** (`packages/domains`)
- `src/models/generated/core/PolicyModel.ts` — **M**: `isProtected` (generator shape).
- `src/repositories/policy/PolicyEntityMapper.ts` — **M**: record/row `isProtected`
  (defaulted `false` for legacy rows).
- `src/repositories/policy/__tests__/PolicyRepository.test.ts` — **M**.
- `src/repositories/role-policy/RolePolicyRepository.ts` — **M**: `countEnabledByPolicy`.
- `src/repositories/role-policy/__tests__/RolePolicyRepository.test.ts` — **M**.

**Applications** (`packages/applications`)
- `src/services/rbac/breakGlass.ts` — **NEW**: `BreakGlassCredentials`,
  `BreakGlassOutcome`, `RBAC_BREAK_GLASS_AUDIT_ACTION`, `checkBreakGlass`
  (428 missing / 401 wrong password via `ICryptoService` / 400 wrong name).
- `src/services/rbac/index.ts` — **M**: barrel.
- `src/services/rbac/policy/policy.service.ts` — **M**: flag-OR-name guard
  (`isProtectedPolicy`), `SYSTEM_CRITICAL_RULES` for flag-only rows,
  isProtected-unset 400 (`rejectExplicitIsProtectedWrite`), break-glass on softDelete +
  >1-ENABLED-role rule edits (`requireRuleEditBreakGlass`), forced audits.
- `src/services/rbac/policy/IPolicyService.ts` — **M**: `PolicyRecord.isProtected`,
  `UpdatePolicyRequest.breakGlass`, `softDelete(id, breakGlass?)`.
- `src/services/rbac/policy/policy.service.module.ts` — **M**: +RolePolicyRepository,
  +UserRepository wiring, +CryptoServiceModule.
- `src/services/rbac/role/role.service.ts` — **M**: break-glass on softDelete (after the
  system-role 400) + removePolicy (protected detach 403 first), forced audits.
- `src/services/rbac/role/IRoleService.ts` — **M**: `softDelete(id, breakGlass?)`,
  `removePolicy(roleId, policyId, breakGlass?)`.
- `src/services/rbac/role/role.service.module.ts` — **M**: +PolicyRepository,
  +UserRepository wiring, +CryptoServiceModule.
- `src/services/rbac/policy/__tests__/policy.service.break-glass.task409.test.ts` — **NEW** (guard matrix + audits).
- `src/services/rbac/role/__tests__/role.service.break-glass.task409.test.ts` — **NEW**.
- `src/services/rbac/policy/__tests__/policy.service.system-guard.test.ts` — **M** (ctor + step-up on delete path).
- `src/services/rbac/policy/__tests__/policy.service.task307.test.ts` — **M** (ctor + credentials on happy-path delete).
- `src/services/rbac/role/__tests__/role.service.task307.test.ts` — **M** (ctor + credentials on delete/detach).

**API** (`apps/api`)
- `src/modules/rbac/dto/policy.dto.ts` — **M**: `BreakGlassDto`,
  `UpdatePolicyDto.breakGlass`, `PolicyResponse.isProtected`.
- `src/modules/rbac/policies.controller.ts` — **M**: DELETE accepts `BreakGlassDto`
  body; update/patch forward `dto.breakGlass`; `toResponse` maps `isProtected`
  (whitelist strip means `isProtected` can never reach the service; explicit attempts
  are 400 by `forbidNonWhitelisted`).
- `src/modules/rbac/roles.controller.ts` — **M**: role DELETE + detach DELETE accept
  `BreakGlassDto` bodies.
- `src/modules/rbac/__tests__/break-glass.task409.test.ts` — **NEW** (passthrough +
  strip + response mapping).

**SDK** (`packages/agentic-sdk-v2`)
- `src/core/AgenticClient.ts` — **M**: `delete(endpoint, { signal?, data? })` (additive).
- `src/hooks/usePolicies.ts` — **M**: `Policy.isProtected`, `BreakGlassCredentials`,
  `UpdatePolicyInput.breakGlass`, `remove(id, breakGlass?)`.
- `src/hooks/useRoles.ts` — **M**: `deleteRole(id, breakGlass?)`,
  `removePolicy(roleId, policyId, breakGlass?)`.
- `src/hooks/index.ts` + `src/core.ts` — **M**: `BreakGlassCredentials` exported from
  the package root.
- `src/hooks/__tests__/usePolicies.test.ts` / `useRoles.test.ts` — **M** (delete-with-body).
- dist rebuilt (tsup) — consumed by `:5174`.

**FE** (`apps/admin`)
- `src/features/roles/break-glass-dialog.tsx` — **NEW**: RevealSecretDialog-patterned
  step-up dialog (exact-name gate disables confirm; destructive confirm; inline
  401/400 errors; state wiped on close) + `breakGlassStatus`/`isBreakGlassRequired`
  SDK-error helpers.
- `src/features/roles/protected-policies.ts` — **M**: `isProtectedSystemPolicy` prefers
  the server `isProtected` marker (name fallback kept).
- `src/features/roles/roles-browser.tsx` — **M**: role delete affordance triggers the
  dialog via `onDelete(role)` (TASK-395 tree/matrix untouched).
- `src/features/roles/role-policies-sheet.tsx` — **M**: protected policies' detach
  button disabled with reason (server 403 backstop).
- `src/routes/_authenticated/roles.tsx` — **M**: dialog wiring — policy delete, role
  delete, detach open it directly; rule-edit escalates reactively on 428.
- `src/features/roles/__tests__/protected-policies.test.ts` — **M** (flag precedence).
- `src/features/roles/__tests__/break-glass.test.ts` — **NEW** (error helpers).

**E2E**
- `apps/api/tests/e2e/task-409-break-glass.spec.ts` — **NEW** (full matrix on
  throwaway rows; audit-row polling assertions; isProtected exposure/immutability).
- `apps/admin/e2e/task-409-break-glass.spec.ts` — **NEW** (dialog flows, all viewports).
- `apps/api/tests/e2e/task-390-super-admin-backend.spec.ts` — **M** (throwaway deletes
  carry credentials; protected 403 assertions unchanged).
- `apps/api/tests/e2e/rbac.spec.ts` — **M** (detach: bare → 428, with credentials → 2xx).
- `tests/helpers/e2e.helper.ts` — **M**: `deleteTestPolicy`/`deleteTestRole` are
  break-glass-aware (fetch name by id when unknown; seeded super-admin password) so
  every suite's cleanup keeps working.

> Migration name: `20260702150000_task_409_policy_is_protected` (additive only).

## 7. Verification evidence (2026-07-02)

**Schema application — `hope_test` @5433** (db-push-built, no `_prisma_migrations`):
- Pre-check `NODE_ENV=test npx prisma migrate diff --from-config-datasource
  prisma.config.ts --to-schema src/prisma/db_main --script` → exactly one statement:
  `ALTER TABLE "core"."Policy" ADD COLUMN "isProtected" BOOLEAN NOT NULL DEFAULT false;`
  — zero destructive statements.
- `NODE_ENV=test npx prisma db push` (plain, non-force) →
  `Your database is now in sync with your Prisma schema. Done in 199ms`.
- Seed upsert via `pnpm test:db:seed` (idempotent full seed; update path re-asserts the
  flag) → `system-full-access|t`, `rbac-system-manage|t`, all other policies `f`.

**Schema application — `hope` @5432** (same protocol):
- Same diff pre-check with `NODE_ENV=development` → the single additive ALTER, nothing
  destructive.
- `NODE_ENV=development npx prisma db push` → `Your database is now in sync … Done in 168ms`.
- Targeted seed-equivalent upsert (no full reseed of the dev DB):
  `UPDATE "core"."Policy" SET "isProtected" = true WHERE name IN
  ('system-full-access','rbac-system-manage')` → `UPDATE 2`; verified only those two
  rows are `true`.
- Post-apply drift check on **both** DBs: `prisma migrate diff` → `No difference
  detected.` (re-confirmed at wrap-up).

**Unit suites (Vitest)**
- `@arcaai/database` `seed.test.ts`: **328 passed** (incl. the new isProtected seed
  assertion).
- `@arcaai/domains` policy + role-policy repos: **24 passed** (mapper flag + legacy
  default, `countEnabledByPolicy`).
- `@arcaai/applications` `src/services/rbac`: **5 files, 67 passed** — the TASK-409
  matrix (protected absolute-block incl. with valid break-glass → 403 + audited;
  unprotected + correct step-up → proceeds + `confirmed` audit; wrong password → 401;
  wrong name → 400; missing → 428; isProtected-unset → 400; >1-role trigger on/off;
  no password in any audit payload) + the pre-existing TASK-390/TASK-307 suites green
  with the new constructors.
- `apps/api` `break-glass.task409.test.ts`: **7 passed** (DELETE body passthrough,
  update forward, whitelist strip, `isProtected` in responses).
- SDK hooks (`usePolicies`/`useRoles`): **59 passed** (delete-with-body assertions).
- FE units (`protected-policies`, `break-glass`, `abilities`, `policy-rules`):
  **39 passed** across 4 files.

**Rebuild protocol** — stopped `dev:api:test` → `pnpm build:api` (clean) → restarted →
`GET /api/v1/health` **200**; SDK dist rebuilt → `:5174` restarted (Vite up, `/login` 200).

**Live API E2E** (`CI=true API_URL=http://localhost:8868`, repo-root config, real
stack, throwaway rows) — final combined run `task-409-break-glass.spec.ts` +
`task-390-super-admin-backend.spec.ts` + `rbac.spec.ts` → **64 passed (13.5s)**:
- `task-409-break-glass.spec.ts` (**11 tests**): isProtected surfaced + immutable
  (400 on explicit write), policy-delete matrix (428/401/400/204), rule-edit gating
  (>1 role 428 → with credentials 200; ≤1 role no step-up), detach matrix, role-delete
  matrix, protected policies 403 even with valid credentials (both by-flag and by-name),
  doctor 403 (RBAC unchanged), forced audit rows for rejected AND confirmed outcomes
  (actor + target + operation + outcome asserted; password absent from payloads).
- Regression green: `task-390-super-admin-backend.spec.ts` (guard absolutes intact;
  throwaway cleanup on the new delete contract) + `rbac.spec.ts` (detach test updated:
  bare → 428, credentialed → success; system-role 400 unchanged).
  (TASK-396 has no API-side spec; its step-up surface is covered by the FE
  `task-396-secret-reveal.spec.ts` re-run below.)

**Live FE E2E** (`SKIP_DB_PRECHECK=true`, desktop+tablet+mobile) — final combined run
`task-409` + `task-391-roles-policies` + `task-395-roles-abilities` +
`task-396-secret-reveal` → **41/42 passed**; the single miss (`task-396` mobile route
guard) was parallel-contention flake and passes **3/3 in isolation**:
- `task-409-break-glass.spec.ts` → **12 passed** (4 scenarios × 3 viewports): delete
  dialog walk (name gate → wrong password inline error → success), protected policy
  shows badge + disabled delete (no break-glass path), multi-role rule edit escalates
  to the confirm-rule-change dialog, role delete completes with credentials.
- Regression: `task-391-roles-policies.spec.ts`, `task-395-roles-abilities.spec.ts`,
  `task-396-secret-reveal.spec.ts` → **green** after the final `:5174` restart.

**FE quality gates** — `pnpm --filter @arcaai/admin type-check` → clean;
`pnpm --filter @arcaai/admin build` → `✓ built` (pre-existing chunk-size warning only).

**Stack end-state** — `:8868` health **200**; entitlements kill-switch
`GET /admin/entitlements/enabled` → `{"enabled":false}` (OFF); rate-limiting OFF
(`RATE_LIMIT_ENABLED=false` in `.env.test`, no throttling headers); `:5174` serving.

## 8. Change History

- 2026-07-02 — Ticket created; requirement analysis, current state, design decisions
  (D1–D8), plan, deployment-constraint section authored.
- 2026-07-02 — Implemented across all layers (DB → domains → applications → API → SDK
  → FE → E2E); schema applied to both standing DBs via the additive-diff + db-push +
  seed-upsert protocol; full unit + live API/FE E2E verification captured (§7);
  status → **Completed**.
