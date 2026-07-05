# TASK-417 — Consolidate SUPER_ADMIN into GLOBAL_ADMIN

- **Status**: Review
- **Type**: refactor — role model cleanup across database seeds, authorization, apps and documentation
- **Created**: 2026-07-04
- **Origin**: TASK-415 capabilities-matrix review (user decision 2026-07-04)

## Requirement Analysis

`SUPER_ADMIN` and `GLOBAL_ADMIN` are treated identically everywhere (`ELEVATED_ROLES` in `packages/applications/src/common/tenant-guards.ts`). Consolidate the two into a single canonical role: **`GLOBAL_ADMIN`**. `SUPER_ADMIN` must not be used anywhere afterward — in implementation or documentation.

## Current State Evaluation

Reference inventory (2026-07-05): ~200 files contain the literal `SUPER_ADMIN`; ~40 more carry "super admin / super-admin" prose only. Categories:

- **Elevated-set definitions**: `ELEVATED_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN']` in `packages/applications/src/common/tenant-guards.ts`; local mirror in `apps/api/src/database/tenant-context.provider.ts`; console mirror `apps/admin-console/src/shared/auth/ability.ts` (+ `src/server/session.ts` doc), transitional dual-accept per TASK-415 Decision 5.
- **Exported role constant**: `SUPER_ADMIN_ROLE = 'SUPER_ADMIN'` in `packages/applications/src/services/tenant/constants.ts`, imported by 7 services (`apiKey`, `auditLog`, `audit`, `notification`, `resourceSubscription`, `tenant`, `userRoleAssignment`, `webhook`) and by the API tenant-context provider. **Gap**: these per-service `isSuperAdmin()` checks accept ONLY `SUPER_ADMIN`, so a `GLOBAL_ADMIN` login does not currently get those service-level bypasses — the consolidation fixes this by definition.
- **Local literals**: `auth.controller.ts` (login tenant-optional path — same gap as above), `admin-impersonation.controller.ts` (`SUPER_ADMIN_TIER_ROLES`), `smr-proxy.controller.ts`, `dna-writing-style.controller.ts`, `globalSetting.service.ts`, `tenant-frontend-config.service.ts`, `dna-writing-style.service.ts`, SDK `useAuth.ts` (`IMPERSONATION_ROLES`), ui-playground `auth-store.ts`, `packages/tools/src/gen-dev-token/users.ts`, `tests/cross-tenant/fixtures.ts`.
- **Seeds**: `03-role.ts` seeds the `SUPER_ADMIN` role (id `00000000-0000-0000-0000-000000000001`) with policies `system-full-access`, `rbac-system-manage`, `global-settings-manage`; `GLOBAL_ADMIN` (id `…0003`) already carries the same three. `91-user.ts` seeds user `super_admin` (id `70000000-…-0001`, SYSTEM tenant) with role `SUPER_ADMIN` and `global_admin` (id `70000000-…-0006`) with `GLOBAL_ADMIN`.
- **Dev DB** (inspected 2026-07-05): `SUPER_ADMIN` role ENABLED with **1** assignment (`super_admin` user, SYSTEM tenant) + 3 role-policies; `GLOBAL_ADMIN` ENABLED with 2 assignments (`global_admin`, `qa_user_02`) + the same 3 role-policies. The dev DB was provisioned via `db:push` — `_prisma_migrations` does not reflect the 33 committed migrations, so `prisma migrate dev` MUST NOT be run against it (drift → destructive reset prompt). Migration SQL will be applied to the dev DB directly via `psql` inside a transaction; the committed migration file services production `migrate deploy`.
- **Tests**: ~90 test files use `SUPER_ADMIN` as a fixture role string; a handful assert dual-accept semantics (`tenant-guards.test.ts`, console `ability.test.ts` / `session.test.ts`) or SUPER_ADMIN-specific messages (`tenant.service` locked-row messages, `userRoleAssignment` grant guard).
- **Docs/rules**: `docs/architecture/overview.md` (persona "Platform super-admin"), `data-and-domain-model.md`, `development-patterns-and-standards.md`, `docs/traceability-matrix.md`, TASK-415 capabilities-matrix ("until TASK-417 ships…"), package READMEs (`applications`, `globalSetting`, `gen-dev-token`, `tests/README.md`), `.cursor/rules/13-nextjs-apps.mdc` ("super-admin working tenant"). Rules 04/05/12 carry no role-string references after the TASK-418 re-roll (04 references the `isSuperAdmin` helper by name only).

## Implementation Plan (detailed, TDD)

Layer order: Database → Domains → Applications → API → Console → periphery → docs.

1. **Database (seeds + data migration)**
   - RED: new structural test `packages/database/src/__tests__/task-417-role-consolidation-migration.test.ts` (mirrors the Phase-F migration test): migration exists, no `DELETE`/`DROP`/`TRUNCATE`, inserts are `ON CONFLICT … DO NOTHING`, updates only touch SUPER_ADMIN-scoped rows and only set soft-delete columns. Update `seed.test.ts`: no `SUPER_ADMIN` anywhere in `DEFAULT_ROLES`; `SYSTEM_ROLES.length === 4`; `GLOBAL_ADMIN` carries the three system policies; seed user `super_admin` carries `GLOBAL_ADMIN`.
   - GREEN: remove the `SUPER_ADMIN` role from `03-role.ts` (keep `GLOBAL_ADMIN` in `GLOBAL_ROLES` with the same three policies); `91-user.ts` reassigns user `super_admin` to `roleNames: ['GLOBAL_ADMIN']`; retire `SEED_ROLE_IDS.SUPER_ADMIN` (comment documents the reserved retired id).
   - Migration `20260705000000_task_417_consolidate_super_admin_into_global_admin` (manually created folder — see Dev DB note above), UPDATE/INSERT only:
     1. Ensure `GLOBAL_ADMIN` role row exists when a `SUPER_ADMIN` row exists (INSERT … WHERE EXISTS/NOT EXISTS).
     2. Copy every non-DELETED `RolePolicy` from `SUPER_ADMIN` to `GLOBAL_ADMIN` (`ON CONFLICT (roleId, policyId) DO NOTHING`).
     3. INSERT a `GLOBAL_ADMIN` `UserRoleAssignment` for every ENABLED `SUPER_ADMIN` assignment lacking one (`ON CONFLICT (userId, roleId, tenantId) DO NOTHING`).
     4. Soft-delete all non-DELETED `SUPER_ADMIN` assignments (UPDATE `resourceStatus='DELETED'` + status/audit columns + `_version` bump).
     5. Soft-delete the `SUPER_ADMIN` role row (same UPDATE pattern).
     Idempotent by construction (re-run: every step no-ops). Apply to dev DB via `psql` in a transaction; verify with before/after counts.
2. **Domains**: comment/fixture sweep (`ConsultationRepository` hand-written section, entity/repo tests) → `pnpm --filter @arcaai/domains test` + build.
3. **Applications**
   - RED: flip `tenant-guards.test.ts` (a `SUPER_ADMIN`-only user is NO LONGER elevated; `GLOBAL_ADMIN` is), `userRoleAssignment.service.test.ts` (grant guard now protects `GLOBAL_ADMIN`), locked-row message tests.
   - GREEN: `services/tenant/constants.ts` renames the export to `GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN'`; `tenant-guards.ts` collapses `ELEVATED_ROLES` to `['GLOBAL_ADMIN']` (the `isSuperAdmin` helper NAME stays — it is API surface used across layers); update the 7 importing services + `globalSetting.service.ts` local literal + inline `'SUPER_ADMIN' || 'GLOBAL_ADMIN'` checks; sweep remaining fixtures/comments. Build + test.
4. **API**: `auth.controller.ts` (login elevation via `GLOBAL_ADMIN_ROLE`; impersonation checks collapse), `admin-impersonation.controller.ts` (tier set → `['GLOBAL_ADMIN']`), `smr-proxy.controller.ts`, `dna-writing-style.controller.ts`, `tenant-context.provider.ts` (import rename, set collapse), controller comment sweep, unit-test fixture sweep. Audit **denied-reason wire codes** (`TARGET_IS_SUPER_ADMIN`, `CALLER_NOT_SUPER_ADMIN`) are intentionally KEPT — they are persisted audit vocabulary; renaming would break existing audit rows/alerting. `pnpm test:unit` + `pnpm build:api`.
5. **Console** (ONLY after the dev-DB migration is applied): `ability.ts` `ELEVATED_ROLES = ['GLOBAL_ADMIN']`, `session.ts` doc, `ability.test.ts`/`session.test.ts` flipped, fixture sweep. `pnpm --filter @arcaai/admin-console test lint build`.
6. **Periphery**: `@arcaai/vox` (`useAuth` impersonation set, hook comments, test fixtures), ui-playground (deprecated app — role-string sweep only), `gen-dev-token` (`users.ts` + README), `tests/cross-tenant/fixtures.ts` (fixture `superAdmin` property KEEPS its name — identifier, not role string; its role value becomes `GLOBAL_ADMIN`), api e2e spec role strings.
7. **Docs & rules**: architecture docs, dev-patterns, traceability, capabilities-matrix (drop "until TASK-417" transitional language), package READMEs, `13-nextjs-apps.mdc`, rules README changelog. Historical change-history entries and research snapshots are NOT rewritten.
8. **Verify**: `pnpm --filter @arcaai/domains test`, `pnpm --filter @arcaai/applications test` + builds, `pnpm test:unit`, console `test lint build`; functional proof — start a local API against the migrated dev DB, log in as `global_admin` AND as `super_admin` (both now `GLOBAL_ADMIN`), hit an elevated route (e.g. `/api/v1/admin/tenants`); at the END `pnpm test:integration` + api e2e if the isolated test infra is free.

### Intentionally out of scope

- Seeded **usernames** `super_admin` / user id keys (`SEED_USER_IDS.SUPER_ADMIN`, audit-log seed ids): login identifiers / data identity, not role strings; dozens of e2e helpers and the user's own dev login depend on them.
- `isSuperAdmin` **function names** (tenant-guards export, `TenantContextProvider.isSuperAdmin()` DB-extension contract, per-service private helpers): cross-package API surface; renaming is cosmetic churn with regression risk.
- Impersonation denied-reason **wire codes** (`TARGET_IS_SUPER_ADMIN`, `CALLER_NOT_SUPER_ADMIN`): persisted audit vocabulary.
- Historical texts: ticket change-history entries, `docs/research/**` snapshots, committed migration SQL (Phase-F backfill mentions SUPER_ADMIN as an exemption — historical, must not be edited), e2e spec FILENAME `task-390-super-admin-backend.spec.ts` (named after its ticket).
- ~~`GroupsEnum` (`packages/applications/src/common/groups.enum.ts`)~~ — plan originally deferred this dead-code enum, but since it has zero importers the `SUPER_ADMIN = 'super_admin'` key was safely renamed to `GLOBAL_ADMIN = 'global_admin'` during implementation (satisfies the "no SUPER_ADMIN anywhere" mandate with no runtime impact).
- TASK-419's new controllers/policies (concurrent work): policy seed DEFINITIONS and controller guard decorators are not touched by this ticket.

## Implementation Summary

Consolidation is complete: `GLOBAL_ADMIN` is the single elevated cross-tenant role platform-wide. The retired `SUPER_ADMIN` literal survives only as (a) intentional negative-test fixtures proving it no longer elevates, (b) retained audit wire codes (`TARGET_IS_SUPER_ADMIN` / `CALLER_NOT_SUPER_ADMIN`), (c) data-identity keys (`SEED_USER_IDS.SUPER_ADMIN` = the `super_admin` username's stable user id), (d) the migration + its structural test, and (e) historical texts (change histories, `docs/archive/**`, `docs/research/**`).

### Database

- **Seeds**: `03-role.ts` no longer creates `SUPER_ADMIN` (`SYSTEM_ROLES` = 4 roles); `GLOBAL_ADMIN` keeps `system-full-access`, `rbac-system-manage`, `global-settings-manage`; `91-user.ts` assigns user `super_admin` → `GLOBAL_ADMIN`; `SEED_ROLE_IDS.SUPER_ADMIN` retired (UUID `…0001` reserved forever, documented in `00-constants.ts`).
- **Migration** `20260705000000_task_417_consolidate_super_admin_into_global_admin` (UPDATE/INSERT only — zero `DELETE`/`DROP`/`TRUNCATE`, verified by the structural test `task-417-role-consolidation-migration.test.ts`): ensures the `GLOBAL_ADMIN` role row, copies `RolePolicy` attachments (`ON CONFLICT DO NOTHING`), inserts replacement `UserRoleAssignment` rows preserving `tenantId`/`scopeOverrides`, then soft-deletes `SUPER_ADMIN` assignments and the role row (`resourceStatus='DELETED'`, `_version` bump).
- **Applied to the dev DB** (`hope` on :5432) via `psql` in a transaction (first attempt rolled back cleanly on an ambiguous `_version` reference; fixed to `ura."_version" + 1` and re-applied). Effect: 1 `SUPER_ADMIN` assignment (`super_admin` user) reassigned; `RolePolicy` copies no-oped (GLOBAL_ADMIN already carried all 3); role + old assignment soft-deleted.
- **Idempotency proof** (re-run on the migrated dev DB, 2026-07-05): `INSERT 0 0` ×3, `UPDATE 0` ×2 — full no-op.
- Post-state (dev DB): `GLOBAL_ADMIN | ENABLED | 3 ENABLED assignments`; `SUPER_ADMIN | DELETED | 1 DELETED assignment`; policies `global-settings-manage`/`rbac-system-manage`/`system-full-access` all `ENABLED` on `GLOBAL_ADMIN`.

### Code (by area)

- **`packages/applications`**: `ELEVATED_ROLES` → `['GLOBAL_ADMIN']` (`tenant-guards.ts`); export renamed `SUPER_ADMIN_ROLE` → `GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN'` (`services/tenant/constants.ts`) — this also closes the pre-existing gap where 7 services' `isSuperAdmin()` checks accepted only the literal `SUPER_ADMIN` (a `GLOBAL_ADMIN` login previously missed those bypasses); dual `'SUPER_ADMIN' || 'GLOBAL_ADMIN'` checks collapsed (`dna-writing-style`, `tenant-frontend-config`, `globalSetting` local constant); `GroupsEnum` dead key renamed; ~35 service/test files swept.
- **`apps/api`**: `auth.controller.ts` (tenantKey-less login + impersonation guards now `GLOBAL_ADMIN`; denial message → "global administrator"), `admin-impersonation.controller.ts` (`ELEVATED_TIER_ROLES = ['GLOBAL_ADMIN']`), `smr-proxy.controller.ts` (`__GLOBAL__` tenantKey gate + debug-access set), `dna-writing-style.controller.ts` (`DNA_ADMIN_ROLES`), `tenant-context.provider.ts` (import + `ELEVATED_ROLES` collapse); `impersonation-events.ts` documents the KEPT wire codes; ~40 unit-test files swept with new negative tests (retired literal ⇒ 401/false/400).
- **`apps/admin-console`**: `ability.ts` `ELEVATED_ROLES = ['GLOBAL_ADMIN']`, `session.ts` doc, tests flipped with explicit `isElevated(['SUPER_ADMIN']) === false` negatives; fixture sweep.
- **Periphery**: `@arcaai/vox` (`IMPERSONATION_ROLES`, ~10 test/doc files + prose sweep), ui-playground (deprecated; `auth-store` predicates, `admin-route-guard`, `use-doctor-context`, UI strings "Super Admin"→"Global Admin", ~40 files incl. tests with negative cases), `gen-dev-token/users.ts`, `tests/cross-tenant/fixtures.ts` + pinning test, `tests/helpers/e2e.helper.ts` prose.
- **API e2e specs**: functional role-lookups re-pointed (`phase-0-redteam`, `task-398` `findRoleId('GLOBAL_ADMIN')` + tier-guard message, `auth-advanced` throwaway-target grant + "global administrator" message, `task-401` E3 message), comment/title sweep across 11 more specs.
- **Docs/rules**: `docs/architecture/overview.md` (persona), `data-and-domain-model.md`, `development-patterns-and-standards.md`, TASK-415 README + capabilities-matrix (transitional "until TASK-417" language resolved to "shipped"), TASK-420 verification notes, `tests/README.md`, package READMEs, `.cursor/rules/13-nextjs-apps.mdc`, rules README changelog v6.3.2. Historical texts untouched.

### Verification evidence (all 2026-07-05)

| Gate | Result |
|---|---|
| `@arcaai/database` test | 804/806 — **2 pre-existing failures unrelated to this ticket** (see below) |
| `@arcaai/domains` test + build | **1299 passed** (105 files, 2 skipped, 9 todo); `tsc` clean |
| `@arcaai/applications` test + build | **5801 passed** (268 files); `tsc` clean |
| `pnpm test:unit` (root) | **15107 passed**, 4 failed — the same 2 database pre-existing + admin-console suites that only fail under the ROOT runner (`server-only` import / `@/` alias unresolved — root-config gap; the app's own runner passes) |
| `apps/api` build + lint | `nest build` clean; eslint clean |
| `@arcaai/admin-console` test / lint / build | **498 passed** (73 files); eslint 0 warnings; `next build` clean |
| `@arcaai/vox` (SDK) test | **3494 passed** (196 files) |
| ui-playground test | **1262 passed**; 1 pre-existing env failure (`DOMMatrix is not defined` from pdfjs in `processing-config-panel.test.tsx` — audio feature, untouched) |
| `pnpm test:integration` | **102 passed** (6 files) |
| API e2e (full, isolated test env) | **539 passed, 0 failed, 17 skipped** (first run had 2 fails: a stale "super administrator" message assertion — fixed — and a leaked-fixture ordering flake in `task-381` that passed on rerun and in the final full run) |

Pre-existing failures NOT caused by this ticket (verified against HEAD): `seed-global-settings.test.ts` expects 58 setting ids but HEAD already has 59; `tenant-scope.test.ts` drift test names `TenantEntitlement`/`TenantUsageMeter` as missing from `TENANT_SCOPED_MODELS` on HEAD too (its own comment tracks it as a pending F2/F3 fix).

### Functional proof (migrated dev DB, API started locally against `.env.dev`)

- `POST /api/v1/auth/login` `{username: "super_admin"}` (no tenantKey) → 200, `roles: ["GLOBAL_ADMIN"]`, token issued (elevated tenantKey-less path).
- With that token: `GET /api/v1/admin/tenants` → **200, 7 tenants** (cross-tenant); `GET /api/v1/monitoring/sessions` (`manage:all`-gated) → **200**.
- `GET /api/v1/admin/rbac/roles` → `SUPER_ADMIN` **absent**, `GLOBAL_ADMIN` present.

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review decision. |
| 2026-07-05 | Exploration complete (inventory ~200 files); detailed TDD plan written; status → In Progress. |
| 2026-07-05 | Implementation complete across DB/applications/API/console/SDK/ui-playground/tests/docs/rules; dev DB migrated + idempotency re-run proven; all gates green (pre-existing failures documented); status → Review. |
