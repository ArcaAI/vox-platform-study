# TASK-388 — Users Backend Backlog (§3a Group C)

| | |
|---|---|
| **Ticket** | TASK-388 |
| **Title** | Reset-password · server-side bulk user actions · Excel/PDF export · admin-edit another user's prefs · per-user prompt scope · cross-user DNA |
| **Created** | 2026-07-01 |
| **Updated** | 2026-07-01 |
| **Status** | Completed (backend + SDK + tests; FE wiring is a documented follow-up) |
| **Depends on** | TASK-386 (Platform Metrics Backend), TASK-387 (Tenant Data-Model Backlog) — both uncommitted, built on top of |
| **Unblocks** | TASK-381 (Users Management) TARGET capabilities; TASK-379 (Tenant Detail → Users tab); TASK-382 (Agents → per-user prompts) FE surfaces |

---

## 1. Requirement Analysis

Implements **§3a backlog Group C** (the "users cluster") from `docs/admin-console-open-items-review.md` — the six User-surface items that currently have no backend (or no SDK wiring) and are therefore drawn disabled / TARGET in the Admin Console. Six items:

| # | Item | Review ref | Layer surface |
|---|---|---|---|
| 8 | Reset-password: emailed reset link **and** admin-set temporary password | U5 | applications service + API (2 controllers) + SDK |
| 9 | Server-side bulk user actions (replace client `Promise.allSettled`) | U6 | API controller + DTO + SDK |
| 10 | User export **Excel + PDF** (CSV already exists client-side) | U7 | applications service + API + deps + SDK |
| 11 | Admin edit **another** user's preferences | U8 | SDK-only (backend already exists) |
| 12 | Per-user prompt scope `USER_PERSONAL` / `ownerUserId` | U9 | applications service + DTO + API + SDK (schema already exists) |
| 13 | Cross-user DNA reports / versions / generate (today self-only) | U10 / U12 | applications (small) + API + SDK — **PHI-sensitive** |

### Acceptance criteria

- **#8** — An admin can (a) set a target user's temporary password (returned so it can be conveyed) and (b) trigger an emailed reset link. A public completion endpoint consumes a single-use, expiring token to set the new password. New passwords are bcrypt-hashed (login-compatible). Tenant-scoped + CASL-gated for admin flows.
- **#9** — One endpoint `POST /admin/users/bulk-actions` performs `enable | disable | delete | assign-departments` across N users, returning per-item `{ action, total, succeeded, failed, results:[{id,success,error?}] }`. Each item is tenant-scoped (`assertUserInScope`). (`assign-role` deferred — see decision #6.)
- **#10** — `GET /admin/users/export?format=xlsx|pdf|csv` streams a file with the same tenant scoping as the Users list; columns mirror the client CSV (username, email, type, status, departments, id).
- **#11** — The SDK can GET/PATCH a **target** user's settings via the existing admin routes (accept a `userId`), so a future admin FE can edit another user's preferences.
- **#12** — An admin can create/read/list `USER_PERSONAL`-scoped prompt templates owned by an in-tenant user (`ownerUserId`), CASL-gated; end-users remain able to manage only their **own** personal prompts.
- **#13** — A super-admin / tenant-admin with `manage:DnaWritingStyleReport` may read/generate DNA reports + versions for **another in-tenant** user; regular users stay self-only (403 for others). **Even SUPER_ADMIN cannot cross tenants** on this PHI-derived artifact.

---

## 2. Current State Evaluation

- **#8 Reset-password** — **No endpoint exists.** Login uses `bcrypt.compare(plaintext, user.password)` (`auth.controller.ts`); the seed hashes with `bcryptjs.hash(pw, 10)`. **There is NO password hashing anywhere in `apps/api/src/modules/user/**` or `UserService.create` / `UserFactory.CreateUser`** — passwords are passed through as-is (latent gap for admin-created users; out of scope to fix here, but the reset path MUST hash correctly). Email infra: `MicrosoftGraphIntegration.sendEmail` exists in `packages/applications/.../integrations/microsoftGraph/` but is **not DI-provided anywhere** (dormant). JWT signing helper `createJwt` + `jsonwebtoken` + `SecretsService.getSecretSync('JWT_SECRET_KEY')` are the reusable token primitives.
- **#9 Bulk actions** — Only `DELETE /admin/users/bulk` (`bulkDelete`) exists with per-item semantics. The admin FE bulk bar (`apps/admin/.../users-bulk-bar.tsx`) currently does `disable` + `assignDepartment` client-side via `Promise.allSettled`; `enable`/`delete` are natural counterparts; reset-password/export are drawn TARGET.
- **#10 Export** — Client-side **CSV only** (`apps/admin/.../users/user-export.ts` → `UserExportRow`). No server export. No xlsx/pdf lib in the API deps.
- **#11 Admin-edit another user's prefs** — **Backend already exists**: `GET /admin/users/:id/settings` + `PATCH /admin/users/:id/settings/:namespace/:key` (`user.controller.ts`, `assertUserInScope`, TASK-245). The SDK `useUserSettings` only targets self (`/user/me/settings`). "Preferences" is the typed aggregation over the `arcaai-sdk` settings namespace.
- **#12 Per-user prompt scope** — **Schema already complete**: `prompt-template.prisma` has `enum PromptTemplateScope { … USER_PERSONAL }` + `ownerUserId String?`. `PromptManagementService` has end-user `createPersonal` / `listMyPersonalForDepartment` (caller-scoped). Gaps: admin `createPromptTemplate` defaults `scope=TENANT_DEFAULT` / `ownerUserId=null` with no way to set them; `getPromptTemplate` blocks reading another owner's `USER_PERSONAL`; `listPromptTemplates(Paginated)` `where` has no `scope`/`ownerUserId` filter; the admin `CreatePromptTemplateRequest` DTO lacks the fields.
- **#13 Cross-user DNA** — **Largely already built + PHI-gated.** `DnaWritingStyleAdminController` has `generateForDoctor(doctorId)` and `getVersions(reportId)`; `DnaWritingStyleService` enforces `assertUserBelongsToTenant` / `assertReportInScope` (super-admin does **not** bypass — cross-tenant PHI reads throw). Gaps: the admin `list` handler doesn't thread the `doctorId` filter that `listReportsPaginated({doctorId})` already supports; there is no admin "get latest report for a doctor" route; the SDK `useDnaStyle` has no admin cross-user methods.

**Net: zero database migrations required** (prompt scope schema pre-exists; reset uses a stateless signed token).

---

## 3. Product / PHI decisions (made + FLAGGED)

> Reasonable, documented defaults so implementation is not blocked. Flagged for product / security review.

1. **#13 DNA cross-user access policy (PHI — RATIFIED — user, 2026-07-01).** Chosen option = **keep current** (the existing code reality), now documented + tested:
   - `manage:DnaWritingStyleReport` (SUPER_ADMIN via `manage:all`; TENANT_ADMIN tenant-scoped) MAY **read + generate** DNA reports/versions for a user **in the caller's tenant**.
   - **Even SUPER_ADMIN cannot cross tenants** — `assertUserBelongsToTenant` throws for a doctor outside the (CLS) tenant. A super-admin must select the tenant first.
   - Regular users (DOCTOR) remain **self-only**; requesting another doctor's report is 403/404.
   - **RATIFIED (user, 2026-07-01):** Keep current — super-admin + tenant-admin may **read + generate** DNA reports/versions for in-tenant users; regular users remain **self-only**; **no cross-tenant** access (even SUPER_ADMIN). The considered alternatives (restrict to generation-only, or require an explicit break-glass audit reason) were declined.
2. **#8 Reset token = stateless signed JWT (no new table).** A single-use, expiring (`1h`) `HS256` token signed with `JWT_SECRET_KEY`, carrying `{ sub, purpose:'password_reset', pv }` where `pv` = a short prefix of the user's **current** password hash. Completing a reset changes the hash → the old token's `pv` no longer matches → **single-use** without persistence. **FLAG:** if a revocable, audited, DB-backed reset-token table is required, that is an additive follow-up.
3. **#8 Admin-initiated reset returns the reset link/token in the API response.** An admin with `manage:User` can already set a temporary password directly, so returning a reset link is **strictly less powerful** (the user still chooses the new password). This makes the flow usable + testable when email is unconfigured. **FLAG:** a future **self-service** "forgot password" (public, unauthenticated) flow MUST NOT return the token — email only.
4. **#8 Email delivery is best-effort + graceful-degrade.** The dormant `MicrosoftGraphIntegration` is wrapped behind a small `IPasswordResetMailer`; when MS Graph secrets are absent (dev/test) it logs and returns `sent:false` (never throws, never blocks the reset). **FLAG:** productionizing real delivery requires provisioning MS Graph secrets; delivery is unverified in the automated E2E.
5. **#8 Password policy = minimum length 8.** Minimal, non-controversial. **FLAG:** stronger complexity/rotation policy is a follow-up.
6. **#9 Bulk action set (FLAG — as-shipped).** Implemented set = **`enable | disable | delete | assign-departments`**. This mirrors the two real client `Promise.allSettled` loops on the admin Users surface (bulk disable + bulk assign-department) plus their trivial siblings (`enable` = inverse of `disable`; `delete` already existed as `bulkDelete`). **`assign-role` was intentionally DEFERRED** — it is not exercised by the FE bulk bar and single-user role assignment already exists via `POST /admin/users/:id/roles`; adding it later is additive (a new enum value + one `switch` arm). `assign-departments` applies the **same** department set to every listed user. Per-item partial-failure semantics mirror the existing `bulkDelete` (per-id try/catch, no `$transaction`, no mid-batch throw).
7. **#10 Export library choice (RATIFIED — user, 2026-07-01: accept `pdfkit`).** **`exceljs`** for `.xlsx` and **`pdfkit`** for `.pdf` (NOT `pdfmake`, the earlier draft). Both are actively maintained, pure-JS (no native build, no headless browser). **Deviation rationale:** server-side `pdfmake` requires vendoring TrueType font files into the repo (its default fonts are browser-loaded), whereas `pdfkit` ships the standard PDF fonts (Helvetica) and works out of the box in Node. Added at latest via pnpm to `apps/api` (`exceljs@^4.4.0`, `pdfkit@^0.19.1`, dev `@types/pdfkit@^0.17.6`). CSV is also served server-side for parity.
8. **#10 Export columns + department names.** Columns mirror the client CSV: `username, email, type (service account / user), status, departments, id`. Department **names** are resolved read-only via the department service when cheaply available; otherwise department ids are emitted and name-enrichment is a flagged follow-up. Export reuses the **same tenant scoping** as the Users list (tenant-admin pinned to CLS tenant; super-admin cross-tenant only when no tenant selected).
9. **#11 "Preferences" == the `arcaai-sdk` settings namespace.** The admin edits another user's **settings** through the pre-existing `/admin/users/:id/settings` routes (the typed "preferences" object is a FE aggregation over that namespace). No new backend; SDK gains `userId`-targeted methods. **FLAG:** if a typed `/admin/users/:id/preferences` surface is later wanted, it is an additive follow-up.
10. **#12 Personal-prompt defaults + gating.** `scope` defaults to `TENANT_DEFAULT`; `USER_PERSONAL` requires an explicit `scope` **and** `ownerUserId`, and the owner must be a user in the caller's tenant (`assertUserBelongsToTenant`). Admin `manage:PromptTemplate` (tenant-scoped) may create/read/list any in-tenant user's personal prompts; the end-user `available`/personal path stays self-only. **FLAG:** whether tenant-admins should see clinicians' personal prompt **content** (vs. metadata only) is a product call — default here is full manage, consistent with `manage:PromptTemplate`.

---

## 4. Implementation Plan (STRICT layer chain + TDD)

**Database → Domain → Applications → API → SDK**, failing test first per behavior. No DB/Domain changes needed (schema pre-exists; reset is stateless).

- **#12 (prompt)** — DTO `CreatePromptTemplateRequest` += `scope?`, `ownerUserId?`; `PromptManagementService.createPromptTemplate` honors + validates them; `getPromptTemplate` allows admin cross-owner read; `listPromptTemplates(Paginated)` += `scope`/`ownerUserId` filters; controller `create`/`list`/`get` pass-through; SDK `usePrompts` create/list gain `scope`/`ownerUserId`.
- **#13 (dna)** — admin `list` threads `?doctorId=`; new `GET /admin/dna-writing-styles/doctor/:doctorId` (latest report, PHI/tenant-gated) + admin versions passthrough; SDK `useDnaStyle` admin cross-user methods. Tests assert cross-tenant is refused even for super-admin.
- **#11 (sdk)** — `ADMIN_USER_SETTINGS_ENDPOINTS`; `useUserSettings.listForUser(userId)` / `updateForUser(userId, ns, key, value)`.
- **#8 (reset)** — `UserPasswordService` (applications): `setTemporaryPassword`, `createResetLink`, `completeReset` + `IPasswordResetMailer` (Graph wrapper, graceful). API: `POST /admin/users/:id/reset-password` (on `UserController`) + new `@Public() POST /users/password-reset/complete` controller. SDK `useUsers.resetPassword` + public complete helper.
- **#9 (bulk)** — `BulkUserActionRequest` / `BulkUserActionResponse` DTOs; `POST /admin/users/bulk-actions` on `UserController` (per-item try/catch, `assertUserInScope`); SDK `useUsers.bulkAction`.
- **#10 (export)** — `UserExportService` (`toXlsx`/`toPdf`/`toCsv` → Buffer); `GET /admin/users/export` streams via `StreamableFile`; deps `exceljs` + `pdfkit` (see decision #7 for the pdfmake→pdfkit deviation); SDK `useUsers.exportUsers` (binary via `AgenticClient.getBlob`).
- **Tests** — unit in `packages/**/__tests__/` + `apps/api/**/__tests__/`; backend E2E `apps/api/tests/e2e/task-388-*.spec.ts` run live against the TEST DB.

---

## 5. Implementation Summary

**Migrations: none.** Zero DB/Domain changes — the prompt `USER_PERSONAL` scope enum + nullable `ownerUserId` FK pre-existed, and the reset token is a stateless signed JWT (no table). `pnpm db:generate` was re-run to keep the client current; no schema drift.

### Endpoints (new / changed)

| Item | Method + path | Auth | Notes |
|---|---|---|---|
| #8 | `POST /admin/users/:id/reset-password` | `manage:User` (class) + `assertUserInScope` | body `{ mode?: 'temporary'\|'link', temporaryPassword? }`; returns temp password (temporary) or `{ token, resetPath, expiresInSeconds, emailSent }` (link) |
| #8 | `POST /users/password-reset/complete` | **`@Public()`** | body `{ token, newPassword }`; single-use (pv-bound); 400 on invalid/expired/spent |
| #9 | `POST /admin/users/bulk-actions` | `manage:User` | body `{ action, ids[], departmentIds?, primaryDepartmentId? }`; returns `{ action, total, succeeded, failed, results[] }` |
| #10 | `GET /admin/users/export?format=csv\|xlsx\|pdf` | `manage:User` | `StreamableFile` attachment; same tenant scope/filters/sort as the list; capped at 10 000 rows (FLAG) |
| #11 | `GET/PATCH /admin/users/:id/settings[/:ns/:key]` | `manage:User` | **pre-existing** (TASK-245); SDK now targets a `userId` |
| #12 | `POST /admin/prompt-templates` (`scope`,`ownerUserId`), `GET /admin/prompt-templates?scope=&ownerUserId=` | `manage`/`create:PromptTemplate` | admin per-user prompts |
| #12 | `POST/PATCH/DELETE /prompt-templates[...]`, `GET /prompt-templates/available` | `read:PromptTemplate` | clinician self-owned personal (pre-existing TASK-356; unchanged) |
| #13 | `GET /admin/dna-writing-styles?doctorId=`, `GET /admin/dna-writing-styles/doctor/:doctorId`, `POST /admin/dna-writing-styles/generate/:doctorId`, `GET /admin/dna-writing-styles/:reportId/versions` | `manage:DnaWritingStyleReport` | cross-user, **tenant-scoped PHI gate** (`assertUserBelongsToTenant`) — even SUPER_ADMIN cannot cross tenants |

### Files by layer

**#8 Reset-password** — Applications: `services/user/userPassword/{userPassword.service.ts, IPasswordResetMailer.ts, userPassword.service.module.ts, index.ts}` + `dto/{reset-password.request,reset-password.response,complete-password-reset.request,complete-password-reset.response}.ts` + `__tests__/userPassword.service.test.ts`; `services/user/index.ts` (barrel). API: `user.controller.ts` (`resetPassword`), `controllers/password-reset.controller.ts` (new, `@Public`), `user.module.ts` (register module + controller), `__tests__/user.controller.test.ts`. SDK: `hooks/useUsers.ts` (`resetPassword`, `completePasswordReset`), `core/constants.ts` (`RESET_PASSWORD`, `PASSWORD_RESET_COMPLETE`), `hooks/__tests__/useUsers.task388.test.ts`.

**#9 Bulk actions** — API: `user/dto/{bulk-action.request,bulk-action.response}.ts` + `dto/index.ts` (barrel), `user.controller.ts` (`bulkActions` + `applyBulkAction`). SDK: `useUsers.ts` (`bulkAction`), `constants.ts` (`BULK_ACTIONS`).

**#10 Export** — API: `user/user-export.service.ts` (new, `exceljs`+`pdfkit`), `user/dto/export-users.query.ts`, `user.controller.ts` (`exportUsers`+`collectExportRows`+`toExportRow`, `StreamableFile`), `user.module.ts` (provide service), `__tests__/user-export.service.test.ts`. Deps: `apps/api/package.json` (`exceljs`, `pdfkit`, `@types/pdfkit`). SDK: `core/AgenticClient.ts` (`getBlob`), `useUsers.ts` (`exportUsers`), `constants.ts` (`EXPORT`).

**#11 Admin-for-other settings (SDK only)** — SDK: `hooks/useUserSettings.ts` (`listForUser(userId)`, `updateForUser(userId, ns, key, value)`), `core/constants.ts` (`ADMIN_USER_SETTINGS_ENDPOINTS`). Backend routes pre-existed.

**#12 Per-user prompt scope** — Applications: `prompt-management/dto/create-prompt-template.request.ts` (`scope?`, `ownerUserId?`), `prompt-management.service.ts` (`createPromptTemplate` honors+validates scope/owner; `getPromptTemplate` admin cross-owner read; `listPromptTemplates(Paginated)` scope/owner filters; `listAvailableForCaller` unchanged self-only), `prompt-template.response.ts` (`scope` surfaced). API: `prompt-management.controller.ts` (`list` threads `scope`/`ownerUserId`), `__tests__/prompt-template.controller.test.ts`. SDK: `hooks/usePrompts.ts` (`scope`/`ownerUserId`).

**#13 Cross-user DNA** — Applications: `dna-writing-style.service.ts` (`listReportsPaginated({doctorId})`, `getDnaReport(doctorId)` PHI/tenant gate). API: `dna-writing-style-admin.controller.ts` (`list` threads `?doctorId`, new `GET doctor/:doctorId`, `generate/:doctorId`, `:reportId/versions`), `__tests__/dna-writing-style-admin.controller.test.ts`. SDK: `hooks/useDnaStyle.ts` (admin cross-user methods), `hooks/__tests__/useDnaStyle.task388.test.ts`.

**E2E** — `apps/api/tests/e2e/task-388-users-backend-backlog.spec.ts` (new, 19 tests).

### Deviations from plan
- **#10 PDF lib pdfmake → pdfkit** (decision #7) — pdfmake needs vendored fonts server-side; pdfkit ships Helvetica.
- **#9 `assign-role` deferred** (decision #6) — not used by the FE bulk bar; single-user route already exists.
- **#10 export enrichment (FLAG/follow-up)** — `UserResponse` does not carry `email`/department **names**, so those columns render blank today (id-only). Server-side enrichment (avoiding an N+1 across profile/department services) is a flagged follow-up; the export contract + columns are in place.
- **SDK build fix** — the `AgenticClient.getBlob` JSDoc originally contained a literal `*/` sequence (inside `'*/*'`) which prematurely closed the block comment and crashed the esbuild/tsup bundle; reworded to a wildcard-`Accept` phrasing. No runtime change.

### Verification evidence

- **Unit — Applications** (earlier full run): `pnpm --filter @arcaai/applications test:unit` → **green** (incl. `userPassword.service`, prompt-management, dna-writing-style suites).
- **Unit — API** (`pnpm --filter @arcaai/api exec vitest run`): **105 files passed, 2 skipped · 1850 tests passed, 4 skipped** — no regressions from the `UserController` constructor/DI additions.
- **Unit — SDK** (touched hooks + core): `useUsers` (+ `task388`, listPaginated, task225), `useUserSettings`, `usePrompts`, `useDnaStyle` (+ `task388`), `AgenticClient` → **10 files, 181 tests passed**.
- **Build** — `pnpm build:api` clean; `pnpm db:generate` clean (Prisma Client 7.5.0 + index regenerated); `pnpm --filter @arcaai/vox build` **clean** (all ESM/CJS entries `Build success`). Typecheck: `AgenticClient.ts` clean; 2 remaining `tsc` errors are **pre-existing** in unrelated test files (`bundle-externals.task364.test.ts`, `SttWebSocketClient.test.ts`).
- **Backend E2E (live)** — restarted `dev:api:test` (:8868 health → 200), ran `SKIP_DB_PRECHECK=true pnpm test:e2e task-388-users-backend-backlog` → **19/19 passed** (all six items, incl. temporary-password login proof, link completion + single-use replay-400, csv/xlsx/pdf magic bytes, bulk per-item envelope + out-of-scope failure, admin-for-other settings round-trip, admin USER_PERSONAL create+filter + clinician personal CRUD, admin cross-user DNA list/read/generate + doctor-403 PHI gate). Ran against the already-seeded TEST DB with **no destructive reset** (no schema change ⇒ `SKIP_DB_PRECHECK` skips the `test:db:reset` force-reset).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-01 | Ticket created; requirement analysis, current-state, product/PHI decisions, plan. | this README |
| 2026-07-01 | Implemented #8–#13 across Applications→API→SDK + unit tests; added live backend E2E (`task-388-users-backend-backlog.spec.ts`, 19/19). Corrected decisions #6 (`assign-role` deferred) and #7 (pdfmake→**pdfkit**) to as-shipped; filled §5 (files, endpoints, deviations, evidence); Status → Completed. | see §5 files |
| 2026-07-01 | **Product decisions RATIFIED (user).** §3 decision 1 (**#13 DNA/PHI**) → keep current: super-admin + tenant-admin read/generate for in-tenant users, regular users self-only, no cross-tenant (even SUPER_ADMIN). §3 decision 7 (**#10 PDF lib**) → accept `pdfkit`. Flag wording changed to RATIFIED for these two; no other flags touched; no code/behaviour change. | this README |
