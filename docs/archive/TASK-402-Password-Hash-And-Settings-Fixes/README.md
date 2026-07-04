# TASK-402 — Password-Hash & Settings-Recreate Fixes

| | |
|---|---|
| **Ticket** | TASK-402 |
| **Title** | Fix pre-existing defects flagged by TASK-400 §5.7: (1) admin-created user passwords stored unhashed; (2) GlobalSetting soft-delete + recreate breaks the AppSettings cache / recreation |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Depends on** | TASK-400 (password policy + `passwordChangedAt`), TASK-401 (AppSettingsModule memoization — preserved), TASK-302 P0-5 (boot invariant), TASK-396 (GlobalSettingService reveal — preserved) |
| **Classification** | bugfix (security + reliability) |

---

## 1. Requirement Analysis

Two pre-existing defects surfaced (and flagged, not fixed) during TASK-400 (§5.7 items 1–2):

1. **Defect 1 — admin-created passwords stored UNHASHED (security).** `UserService.create` passes the admin-supplied `password` verbatim into `UserFactory.CreateUser` → `userRepository.create`, so the `core.User.password` column holds plaintext. Login (`auth.controller.ts` → `bcrypt.compare`) can therefore never succeed for a creation-time password; the user only becomes loginable after a password-module write (temporary password / reset completion), which are the paths that hash via `ICryptoService`. The generic `UserService.update` path shares the identical hole through `UpdateUserRequest.password` (plaintext straight onto the entity via `updateEntity`).
2. **Defect 2 — GlobalSetting soft-delete + recreate breaks settings (reliability).** Flagged as: cache refresh counts a DELETED+ENABLED pair for the same platform key as a duplicate → refresh fails every 45 s and the next boot crashes on the TASK-302 P0-5 invariant.

### Acceptance criteria

- **A1** A user created with a policy-compliant password can log in with that password immediately (live 200), and the stored value is bcrypt-format (`$2a$/$2b$/$2y$`).
- **A2** The TASK-400 complexity policy (GlobalSettings-configurable, default 12+/upper/lower/digit/special) is enforced on the create path (and the update-path password) with the same explicit 400 message style.
- **A3** `passwordChangedAt` is stamped when a password is set at creation (rotation parity with the password module).
- **A4** OAuth externals (`createExternalUser`, `password: ''`) keep working — no policy applied to the empty placeholder, nothing hashed.
- **B1** `AppSettingsService.cacheAppSettings()` ignores soft-DELETED rows for BOTH the P0-5 duplicate invariant and the cache map (a DELETED row can never shadow an ENABLED row, and a DELETED+recreated key never counts as a duplicate). Genuine duplicates (2× ENABLED same platform key) still refuse boot.
- **B2** Re-creating a soft-deleted GlobalSetting (same tenantId+name+key) succeeds by REVIVING the deleted row (UPDATE-based restore + field update — never a DELETE), following the `userRoleAssignment.service` restore-on-create precedent.
- **B3** Live: create → soft-delete (service path) → recreate a throwaway key, then restart the API → `/health` 200 with a DELETED+ENABLED same-key pair present in the DB.
- **C1** Existing bad rows: count non-bcrypt `password` values in TEST + DEV DBs (read-only first); backfill by UPDATE-only bcrypt-hashing ONLY if trivially safe seed/dev data.
- **D1** No regression: TASK-400 API spec (13) and TASK-388 spec (19) stay green; full unit suites for touched packages green.

---

## 2. Current State Evaluation (evidence-gathered 2026-07-02)

### Defect 1 — where the password bypasses hashing

- `packages/applications/src/services/user/user/user.service.ts` `create()`: `UserFactory.CreateUser({ ...userRequest, ... })` — `password` flows through untouched (both the plain and the atomic create-with-membership branches). `update()`: `this.updateEntity(user, request)` assigns `request.password` verbatim (the `ChangeFieldHandlers` hook designed for password hashing is unused).
- Working reference paths: `UserPasswordService.setTemporaryPassword` / `completeReset` — `user.password = await this.cryptoService.hash(pw)` + `assertPasswordPolicy(pw, resolvePasswordPolicy(appSettings))` + `passwordChangedAt` stamp. Login: `bcrypt.compare(request.password, user.password)`.
- `CryptoService.hash` = bcryptjs with `crypto.saltRounds` (default 10) — the same primitive everywhere.
- `createExternalUser` passes `password: ''` (OAuth identities — no local credential).
- All API E2E specs that create users already send the policy-compliant `Password123!`; the admin FE create dialog surfaces server 400 text (TASK-400 pattern) — no FE change needed (flagged below).

### Defect 2 — actual mechanism (differs in detail from the TASK-400 flag)

Empirical findings against the live test stack (`hope_test`@5433, API `:8868`):

1. **Recreation is broken by the DB unique index, not the invariant**: `@@unique([tenantId, name, key])` counts DELETED rows, so re-creating the same name+key after a soft-delete → **409 P2002** (reproduced live). Re-creating with a different *name* but same *key* succeeds → leaves a DELETED+ENABLED pair for one key.
2. **The Prisma extended client's soft-delete extension DOES filter DELETED rows from `findAll({})`** (verified with the exact dist the API loads: 166 ENABLED returned, 0 of the 8 DELETED rows) — so with current dists a routine cron refresh does not trip the invariant on a DELETED+ENABLED pair. However, `cacheAppSettings()` itself has **no service-level protection**: any code path that hands repositories an unextended client — notably the CLS transaction client (`coreTransactionClient` from `baseClient.$transaction`, which bypasses ALL extensions and is visible to every repository inside `runInTransaction` windows) — feeds DELETED rows straight into the P0-5 invariant → refresh failure, and at boot → crash. This is the standing trap the TASK-400 session hit; the invariant and the cache map must be robust at the service layer instead of relying on an invisible client extension.
3. `AppSettingsModule` memoization (TASK-401) is untouched by this fix.

### Backfill assessment (read-only counts, 2026-07-02)

| DB | non-bcrypt (non-empty) `password` rows | Verdict |
|---|---|---|
| TEST `hope_test`@5433 | **36 / 99** — all E2E throwaways (`t388*/t398*/t400*/t401*` = 35 rows, soft-DELETED, plaintext `Password123!`; 1 ENABLED probe `probe400_1782973009`, password `x`) | Trivially safe → **backfill executed** (UPDATE-only bcrypt) |
| DEV `hope`@5432 | **0 / 27** | Nothing to do |

---

## 3. Implementation Plan (TDD per layer; approved scope from the dispatch)

1. **Defect 1 RED** — `packages/applications/src/services/user/user/__tests__/user.service.task402.test.ts`: create() hashes (repository receives bcrypt-verifiable, non-plaintext value; both branches), enforces policy (weak → 400 w/ explicit rules), stamps `passwordChangedAt`; `createExternalUser` unchanged (`''`, no hash, no policy); update() hashes + validates when `password` present, leaves other updates alone.
2. **Defect 1 GREEN** — inject `ICryptoService` + `IAppSettingsService` into `UserService`; validate + hash in `create()` before the factory; stamp `passwordChangedAt`; `update()` gets a `password` ChangeFieldHandler (validate + hash). `UserServiceModule` imports `CryptoServiceModule`. Update existing user.service test constructors/payloads (weak fixture passwords → `Password123!`).
3. **Defect 2 RED** — `appSettings.service.task402.test.ts`: DELETED+ENABLED same key → resolves + cache serves the ENABLED row (both orderings); DELETED-only key → not cached; 2× ENABLED same key → still throws. `globalSetting.service.task402.test.ts`: create() with a matching DELETED row revives (restore + field update, ResourceCreated emitted); no DELETED match → plain create.
4. **Defect 2 GREEN** — `cacheAppSettings()` filters `resourceStatus === DELETED` rows before invariant + cache population; `GlobalSettingService.create()` restore-on-recreate (find DELETED by tenantId+name+key → `repository.restore` → apply request fields via `updateEntity`+`update` → ResourceCreated), falling back to plain create.
5. **Backfill** — TEST DB UPDATE-only script (bcrypt-hash the 36 plaintext rows); DEV no-op.
6. **Verify** — unit suites (applications/domains/api); rebuild protocol (stop `dev:api:test` → `pnpm build:api` → restart → `/health` 200); new `apps/api/tests/e2e/task-402-password-hash-settings.spec.ts` (create-with-password → login 200 + bcrypt-at-rest + weak-400; settings delete→recreate revive cycle); boot-cycle proof with a DELETED+ENABLED pair present; re-run task-400 (13) + task-388 (19).

**No schema changes** (the partial-unique-index alternative for Defect 2 was deliberately rejected — revive-on-create needs none).

---

## 4. Implementation Summary

Completed 2026-07-02. All acceptance criteria met with live evidence; see §5 for verification transcript summary.

### Defect 1 — root cause & fix

**Root cause**: `UserService.create` forwarded the admin-supplied plaintext `password` from `CreateUserRequest` through `UserFactory.CreateUser` to `userRepository.create` with no hashing — while login compares with `bcrypt.compare`. The same hole existed in `UserService.update` (`UpdateUserRequest.password` assigned verbatim by `applyChangesToEntity`). The hashing paths that DO work (`UserPasswordService`) were never wired into the user CRUD module.

**Fix** (`packages/applications/src/services/user/user/user.service.ts`):
- `UserService` now injects `ICryptoService` + `IAppSettingsService` (module imports `CryptoServiceModule`; AppSettings is the global module — TASK-401 memoization untouched).
- `create()`: for a non-empty password — `validatePasswordComplexity(pw, resolvePasswordPolicy(appSettings))` (400 listing the exact unmet rules, same voice as TASK-400) → `password = await cryptoService.hash(pw)` → `passwordChangedAt = new Date()` stamped on the new entity. Both the plain and the membership (transactional) branches are covered since hashing happens before the branch.
- `createExternalUser()` (OAuth, `password: ''`): unchanged — empty placeholder is neither validated nor hashed.
- `update()`: `password` now goes through a `ChangeFieldHandlers` handler (the mechanism designed for this): policy-validate → hash → stamp `passwordChangedAt`. Requests without `password` behave exactly as before.

### Defect 2 — root cause & fix

**Root cause** (two coupled halves, refined from the TASK-400 flag by live reproduction):
1. Re-creating a soft-deleted key with the same (tenantId, name, key) 409s on the DB unique index (`GlobalSetting_tenantId_name_key_key` counts DELETED rows) — recreation from the admin console is effectively bricked; re-creating under a different name silently leaves a DELETED+ENABLED pair for the same key.
2. `AppSettingsService.cacheAppSettings()` had no service-level DELETED filtering — the P0-5 duplicate invariant and the `Map<key>` cache relied entirely on the Prisma soft-delete extension. Any unextended client reaching the repository (the CLS `coreTransactionClient` visible inside `runInTransaction` windows bypasses all extensions) feeds DELETED rows in: the DELETED+ENABLED pair then trips the invariant → every 45 s refresh fails, and a boot in that state crashes the API.

**Fix**:
- `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts` — `cacheAppSettings()` now drops `resourceStatus === DELETED` rows up front (`ResourceStatusType.DELETED` from `@arcaai/domains`), so BOTH the invariant and the cache only ever see live rows, independent of which Prisma client variant served the query. A DELETED+recreated key is tolerated by construction; two ENABLED rows for one platform key still refuse boot (TASK-302 P0-5 preserved).
- `packages/applications/src/services/globalSetting/globalSetting.service.ts` — `create()` first looks for a soft-DELETED row with the same `(tenantId ?? CLS tenant, name, key)`; when found it **revives** it: `repository.restore(id)` (UPDATE: ENABLED + version bump — the sanctioned resurrect path) then applies the request's `value/dataType/namespace/description` via `updateEntity` + `update`, emits `ResourceCreated`, returns the revived entity (same row id). No DELETED match → plain create as before. Follows the `userRoleAssignment.service.ts` restore-on-create precedent; UPDATE-only, no schema change.

### Backfill

- **TEST `hope_test`@5433**: 36 non-bcrypt rows (all E2E throwaways, see §2) UPDATE-only bcrypt-hashed in place (script `node`-run with bcryptjs@10 rounds; re-count after: **0** non-bcrypt rows). No DELETE/TRUNCATE; resource statuses untouched.
- **DEV `hope`@5432**: 0 non-bcrypt rows — **no backfill needed**.

### Files created/changed

| Layer | File | Change |
|---|---|---|
| applications | `services/user/user/user.service.ts` | hash + policy + `passwordChangedAt` on create; password ChangeFieldHandler on update |
| applications | `services/user/user/user.service.module.ts` | import `CryptoServiceModule` |
| applications | `services/user/user/__tests__/user.service.task402.test.ts` | NEW — TDD spec for the above |
| applications | `services/user/user/__tests__/user.service.test.ts`, `user.service.task331.test.ts`, `user.service.task398.test.ts` | constructor mocks extended (crypto + appSettings); weak fixture passwords → policy-compliant |
| applications | `services/baseServices/_meta/appSettings/appSettings.service.ts` | DELETED rows excluded from invariant + cache |
| applications | `services/baseServices/_meta/appSettings/__tests__/appSettings.service.task402.test.ts` | NEW — DELETED+recreated tolerance pins |
| applications | `services/globalSetting/globalSetting.service.ts` | revive-on-create for soft-deleted (tenantId,name,key) |
| applications | `services/globalSetting/__tests__/globalSetting.service.task402.test.ts` | NEW — revive-on-create pins |
| api e2e | `apps/api/tests/e2e/task-402-password-hash-settings.spec.ts` | NEW — live proofs (create→login, bcrypt at rest, weak-400, settings delete→recreate revive) |
| docs | this README | NEW |

No schema, domain-layer, SDK, FE, or infrastructure changes. TASK-400 flows, TASK-401 memoization + impersonation, TASK-396 reveal: preserved (regression-proven).

---

## 5. Verification Evidence (2026-07-02)

- **Unit — applications**: `pnpm --filter @arcaai/applications test:unit` → **190 files, 1837 passed | 10 skipped** (includes new task402 suites: user.service 9, appSettings 5, globalSetting 6 — all first run RED, then GREEN).
- **Unit — api**: `pnpm --filter @arcaai/api test` → **72 files, 809 passed | 2 skipped**.
- **Unit — domains**: untouched by the fix; suite `pnpm --filter @arcaai/domains test:unit` → **68 files, 1180 passed** (baseline re-run).
- **Build**: `pnpm build:api` green (applications + domains + api tsc).
- **Rebuild protocol**: old `dev:api:test` stopped → `pnpm build:api` → restarted → `GET /api/v1/health` **200**.
- **Live task-402 spec**: `apps/api/tests/e2e/task-402-password-hash-settings.spec.ts` → **8 passed** — create-with-password → **login 200 immediately**; stored hash `$2b$…` (bcrypt at rest, plaintext absent); weak create password → 400 listing unmet rules; update-path password → hashed + loginable; settings create→soft-delete→recreate(same name+key) → **201-equivalent revive** (same row id, ENABLED, new value) → cache refresh clean.
- **Boot-cycle proof**: with the revived key AND a deliberate DELETED+ENABLED same-key pair (`task402.repro.probe`) present in `hope_test`, API restart → boots clean, `/health` 200, no `duplicate platform key` in the boot log.
- **Regression**: `task-400-password-security.spec.ts` → **13 passed**; `task-388-users-backend-backlog.spec.ts` → **19 passed**.
- **Backfill**: TEST DB post-backfill count of non-bcrypt rows = **0** (was 36); DEV untouched (0 before).
- **Hand-off**: `:8868` healthy (200), entitlements enforcement **OFF** (`entitlements.enabled=false`), rate limiting **OFF** (`RATE_LIMIT_ENABLED=false` in `.env.test`), admin `:5174` up (200).

### Flags / follow-ups (not in scope)

1. **Admin FE create-user dialog** shows the server's 400 policy text verbatim (TASK-400 fallback pattern) but has no inline complexity checklist for the create form (the reset form has one). FE polish belongs to the admin-console owner.
2. `user.toObject()` (audit event payload for ResourceCreated/Updated) carries the password field; it previously leaked **plaintext** into the SysEvent pipeline — now it carries only the bcrypt hash. A field-level redaction sweep of audit payloads is a worthwhile follow-up.
3. The junk soft-DELETED GlobalSetting rows left by earlier sessions (`t390.*`, `security.password.maxAgeDays.probe`, `…retired-*`, `task402.repro.probe` pair) remain in `hope_test` (DELETE is forbidden); they are now harmless by construction.
4. The CLS `coreTransactionClient` handed out by `runInTransaction` bypasses soft-delete + tenant-scope extensions for ALL repositories inside the window — Defect 2's hardening makes AppSettings immune, but other `findAll`-inside-transaction consumers inherit the same class of risk (module owners' follow-up).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; both defects root-caused with live reproduction; plan approved per dispatch. | this README |
| 2026-07-02 | Defect 1 + Defect 2 implemented TDD-first; TEST-DB backfill executed (36 rows); full verification incl. 400/388 regression re-runs. | §4 file table |
