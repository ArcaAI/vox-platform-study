# TASK-400 — Password Security Hardening

| | |
|---|---|
| **Ticket** | TASK-400 |
| **Title** | Revocable DB-backed reset tokens · password complexity + rotation policy · public self-service forgot-password (MS-Graph email) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Depends on** | TASK-388 #8 (admin reset, stateless JWT — replaced here), TASK-394 P0-1 (`/reset-password` completion page + admin dialog) |
| **Classification** | feature (security hardening) |

---

## 1. Requirement Analysis

Implements the three **approved password-security decisions** (user, 2026-07-02):

1. **Revocable DB-backed reset tokens** — replace the TASK-388 stateless JWT (`pv`-claim) with a `PasswordResetToken` table: hashed at rest, single-use (`usedAt`), TTL-bound (`expiresAt`), revocable (`revokedAt` — issuing a new token revokes prior active ones; revocation is UPDATE-based, never DELETE). Both the admin-initiated flow and the new public flow ride this table.
2. **Password complexity + rotation policy** — configurable complexity validation enforced on all set/change/reset paths owned by the password module, with clear 400 messages; rotation tracked via a new `User.passwordChangedAt` column and a configurable max-age check surfaced (not blocking) at login.
3. **Public self-service forgot-password** — `POST /api/v1/auth/forgot-password`, unauthenticated, always **202** (no user-existence leak), rate-limited, audited; the completion link is delivered **by email only** (the API never returns the token). Real MS-Graph transport implemented; dev/file transport used when Graph credentials are absent.

### Acceptance criteria

- **A1** Issuing a reset link (admin or self-service) revokes the user's prior ACTIVE tokens (UPDATE `revokedAt`).
- **A2** A completion token is single-use (`usedAt` stamped; replay → 400) and expires after its TTL (→ 400).
- **A3** Only a token **hash** (SHA-256) is stored; comparison is constant-time; raw token never persisted or logged by the API.
- **B1** Weak passwords are rejected with actionable 400 messages on: admin temporary-password, reset completion (admin link + self-service).
- **B2** `passwordChangedAt` is stamped on every password set through the password module; login surfaces `passwordExpired: true` when the configured max-age (default **off**) is exceeded — no lockout by default.
- **C1** `POST /auth/forgot-password` returns 202 with an identical body for existing and unknown emails; the token/link never appears in any API response for this flow.
- **C2** Delivery goes through `IPasswordResetMailer`: MS-Graph transport when `MSGRAPH_*` env is present; dev outbox (JSONL file + log) otherwise.
- **C3** Admin flow (TASK-388 contract: token returned in the admin response) still works — BC preserved; TASK-388 E2E stays green.
- **FE** Login page shows a "Forgot password?" link → public request page (email input → generic success). `/reset-password` validates the new complexity rules inline.

---

## 2. Current State Evaluation

- **Reset flow (TASK-388 #8)** — `packages/applications/src/services/user/userPassword/userPassword.service.ts`: stateless JWT with `pv` (password-version) claim; `MIN_PASSWORD_LENGTH = 8`; 1 h TTL. Controllers: `POST /admin/users/:id/reset-password` (`user.controller.ts`), `@Public() POST /users/password-reset/complete` (`controllers/password-reset.controller.ts`). Mailer boundary `IPasswordResetMailer` with a logging no-op default; `MicrosoftGraphIntegration` exists (`services/baseServices/integrations/microsoftGraph/`) but is **not DI-provided** anywhere and its config (clientId/secret/tenant/scopes) is constructor-injected plain strings.
- **FE (TASK-394)** — `apps/admin/src/routes/reset-password.tsx` (public completion page, MIN_LENGTH 8), `features/users/reset-password-dialog.tsx` (admin dialog; link+token copy fields). Login page has **no** forgot-password link.
- **SDK** — `useUsers.resetPassword` / `completePasswordReset`; `USER_ENDPOINTS.PASSWORD_RESET_COMPLETE`. No self-service request method.
- **Login** — `auth.controller.ts` `POST /auth/login` (`@Throttle 5/min`), bcrypt compare; no rotation awareness.
- **Config plumbing** — `AppSettingsService` caches platform-tenant `GlobalSetting` rows; `getValueWithDefault(key, default)` is the O(1) read; `EntitlementsService` (`entitlements.enabled`) is the kill-switch precedent. Password-policy keys fit naturally here.
- **Schema** — `User` has no `passwordChangedAt`; no reset-token table. Migrations end at `20260701010001_task_387_tenant_plan_and_dept_dna`; the TASK-392 entitlement tables were applied to live DBs via **additive `db push`** (no migration folder) — so `_prisma_migrations` state on live DBs may not match the folder set (checked at apply time, see §5).
- **Env** — **No MS-Graph credentials** exist in `.env.dev` / `.env.test` / `.env.production` (checked: no `MSGRAPH_*`/`GRAPH_*`/mail keys). Real-send verification is therefore NOT possible in this environment; the dev transport is used for E2E and the exact env-var list is flagged (§3.6).

### Known pre-existing gap (out of scope, FLAGGED)

`UserService.create` / `UserFactory.CreateUser` store the admin-supplied password **without hashing** (TASK-388 §2 finding; `user.service.ts` is currently being modified by TASK-398 and is not owned by this ticket). Complexity enforcement here covers the password-module paths (temporary password, completion); wiring create-path hashing+complexity is a follow-up on that module's owner.

---

## 3. Decisions (proposed defaults — safe, documented)

1. **Token shape** — raw token = `randomBytes(32).toString('base64url')` (~43 chars, 256-bit); stored as SHA-256 hex in `PasswordResetToken.tokenHash` (`@unique`). Lookup by hash + `crypto.timingSafeEqual` re-check (constant-time).
2. **TTL = 60 minutes** for both admin-initiated and self-service tokens (approved 30–60 range; matches the previously advertised admin-dialog copy).
3. **Complexity default** — min **12** chars, max 128, require upper + lower + digit + special. Configurable via platform GlobalSettings (`security.password.*` keys, read through `AppSettingsService`): `minLength`, `requireUppercase`, `requireLowercase`, `requireDigit`, `requireSpecial`. Defaults apply when keys are unseeded — **no seed required**.
4. **Rotation default = OFF** (`security.password.maxAgeDays` default `0`). When > 0, login computes age from `passwordChangedAt` and returns `passwordExpired: true` (+ the user still logs in — warn-surface, no lockout). `passwordChangedAt = null` (legacy users) is treated as "unknown → never expired" so nobody is locked out or nagged by default. Blocking enforcement is a deliberate follow-up switch.
5. **Forgot-password matching** — matches `UserProfile.email` (case-insensitive) across ENABLED users; a token+email is issued per matching user (bounded at 3 accounts). No match → same 202, nothing issued. SysEvent audit carries the outcome (no token, no plaintext email in the event payload — a SHA-256 prefix identifies the address).
6. **MS-Graph transport env contract** (FLAG — credentials not present in any env file today): `MSGRAPH_CLIENT_ID`, `MSGRAPH_CLIENT_SECRET`, `MSGRAPH_TENANT_ID`, `MSGRAPH_SENDER` (mailbox userId/UPN the mail is sent from), optional `PASSWORD_RESET_LINK_BASE_URL` (absolute FE origin for the emailed link, e.g. `https://admin.example.com`; the path alone is used when unset). When all four `MSGRAPH_*` are present the module provides the Graph mailer; otherwise the **dev outbox transport** (logs + appends JSONL to `PASSWORD_RESET_DEV_MAIL_FILE`, default `<tmpdir>/hope-password-reset-outbox.jsonl`) so E2E can read the raw token from the outbox — never from the API.
7. **BC** — the admin reset response keeps returning `{ token, resetPath, expiresInSeconds, emailSent }` (TASK-388 decision #3: strictly-less-powerful than the temp-password the same admin can already set). The public flow NEVER returns the token. SDK signatures unchanged; one method added.

---

## 4. Implementation Plan (layer chain, TDD per layer)

1. **Database** — new `password-reset-token.prisma` model + `User.passwordChangedAt DateTime?` + relation; additive migration `20260702000000_task_400_password_reset_tokens`; apply to TEST DB (status-checked; `migrate deploy` if migration-tracked, else the TASK-392 additive-push pattern with a `migrate diff` pre-check); `db:generate`.
2. **Domain** — `PasswordResetTokenEntity` (+ `isActive()` behavior), Factory, Model, Mapper, Repository (`findByTokenHash`, `findActiveForUser`) + `CoreDatabaseModule` + barrels. RED→GREEN entity/factory tests.
3. **Applications** —
   - `password-policy.ts` (pure): `validatePasswordComplexity(pw, policy) → string[]` + `resolvePasswordPolicy(appSettings)` + `isPasswordExpired(changedAt, maxAgeDays, now)`.
   - `UserPasswordService`: DB-backed `createResetLink` (revoke-then-issue), `completeReset` (hash lookup, constant-time, single-use, TTL, complexity, `passwordChangedAt`, revoke-remaining), `setTemporaryPassword` (complexity + `passwordChangedAt` + revoke-active), new `requestSelfServiceReset(email)` (never leaks), all SysEvent-audited.
   - Mailers: `MsGraphPasswordResetMailer` (wraps `MicrosoftGraphIntegration.sendEmail`, never throws), `DevOutboxPasswordResetMailer`; module factory selects by env.
4. **API** — `POST /auth/forgot-password` (`@Public`, `@Throttle 5/min`, 202 always) in the auth module; `LoginResponse.passwordExpired?` surfaced in `auth.controller.login`.
5. **SDK** — `AUTH_ENDPOINTS.FORGOT_PASSWORD`; `useUsers.requestPasswordReset(email)`; `LoginResult.passwordExpired?` type; rebuild dist.
6. **FE (apps/admin)** — `routes/forgot-password.tsx` (email → generic success), login-page link, `/reset-password` complexity checklist inline (12 + classes) with server-message fallback.
7. **E2E** — `apps/api/tests/e2e/task-400-password-security.spec.ts` (202 parity, single-use, revoke-on-reissue, expiry via direct DB UPDATE of `expiresAt`, complexity 400, token-never-in-response, admin flow BC) + re-run `task-388-users-backend-backlog.spec.ts`; `apps/admin/e2e/task-400-forgot-password.spec.ts` (link → request page → generic success; completion page inline complexity) across desktop/tablet/mobile.
8. **Dev DB (optional, after green)** — `migrate diff` additive pre-check → non-force `db push`; skip+flag if any destructive step appears.

---

## 5. Implementation Summary

All three approved decisions are implemented, unit-tested (TDD RED→GREEN per layer), and proven by LIVE E2E against the test stack (API `:8868` → `hope_test`@5433, admin `:5174`).

### 5.1 Schema / migrations

- New model `core.PasswordResetToken` (`packages/database/src/prisma/db_main/password-reset-token.prisma`): `tokenHash` (unique, SHA-256 hex — plaintext never stored), `purpose`, `expiresAt`, `usedAt?`, `revokedAt?`, `requestedByUserId?`, `requestedVia?` (`admin`/`self-service`), `requestIp?`, standard resource/audit columns, FK → `User` (cascade), indexes on `userId` + `expiresAt`.
- `core.User.passwordChangedAt DateTime?` (additive, nullable — legacy rows stay NULL = "never expired").
- Migration folder `20260702000000_task_400_password_reset_tokens` (additive-only SQL) for migration-tracked environments.
- **Test DB (`hope_test`@5433)**: `migrate status` showed the DB is `db push`-built with NO `_prisma_migrations` baseline (31 "pending" historical migrations — same as TASK-392 found). `migrate deploy` would have replayed history, so the TASK-392 additive-push pattern was used instead: `migrate diff` pre-check proved the delta was **100 % additive (zero drops)** → plain non-force `db push` → applied clean.
- **Dev DB (`hope`@5432)**: same pattern after all tests were green — `migrate diff --from-config-datasource --to-schema` produced ONLY `ADD COLUMN` + `CREATE TABLE/INDEX/FK` statements (zero destructive) → plain `db push` → "database is now in sync" (146 ms).

### 5.2 Complexity + rotation defaults (Decision 2)

| Knob | GlobalSetting key | Default |
|---|---|---|
| Min length | `security.password.minLength` | **12** |
| Max length | — (fixed) | 128 |
| Uppercase required | `security.password.requireUppercase` | true |
| Lowercase required | `security.password.requireLowercase` | true |
| Digit required | `security.password.requireDigit` | true |
| Special required | `security.password.requireSpecial` | true |
| Rotation window (days) | `security.password.maxAgeDays` | **0 = OFF** |

- Enforced in `UserPasswordService` on ALL password-module paths: temporary password, admin-link completion, self-service completion. 400 message lists the exact unmet rules (e.g. `"Password must be at least 12 characters long. Password must contain at least one special character (e.g. !@#$%)"`). The static `@MinLength(8)` DTO decorators were removed from `ResetPasswordRequest`/`CompletePasswordResetRequest` so the configurable policy is the single validation voice (previously the DTO would 400 with a generic "Validation error" first).
- Rotation: every password-module write stamps `passwordChangedAt`; `POST /auth/login` computes `isPasswordExpired(passwordChangedAt, maxAgeDays)` and, when true, adds `passwordExpired: true` to the response — **login still succeeds** (warn-surface; FE shows a toast). NULL stamp or `maxAgeDays<=0` never expires ⇒ enabling the knob can't lock anyone out.

### 5.3 Revocable DB tokens (Decision 1)

- Raw token `randomBytes(32).toString('base64url')`; only its SHA-256 lands in the DB; lookup by hash + `crypto.timingSafeEqual` re-check.
- Issuing (admin `mode=link` OR self-service) first revokes ALL the user's active tokens (`revokedAt = now` — UPDATE, never DELETE), then inserts the new row with provenance (`requestedByUserId`, `requestedVia`, `requestIp`).
- Completion validates: hash found → not used → not revoked → not expired → complexity → bcrypt-hash the new password + stamp `passwordChangedAt` → mark `usedAt` → revoke any other stragglers. Single-use replay and expiry both → 400 `"Reset token is invalid or has expired"`.
- Admin response contract unchanged (TASK-388 BC): `{ mode, token, resetPath, expiresInSeconds, emailSent }`. TTL 60 min.

### 5.4 Public forgot-password + MS-Graph (Decision 3)

- `POST /api/v1/auth/forgot-password` (`ForgotPasswordController`, registered in `UserModule`): `@Public()`, `@Throttle 5/min`, **always 202** `{ success: true, message: "If an account exists…" }` — identical for existing, unknown, and even malformed emails (internal errors are masked + logged). SysEvent audit carries a SHA-256 email digest + issue count, never the address or token.
- Matching: `UserProfile.email` case-insensitive, ENABLED users only, bounded to 3 accounts; each gets a fresh token (prior ones revoked).
- **MS-Graph status: transport implemented, NOT live-verified — no credentials exist in any env file.** `createPasswordResetMailer(env)` selects:
  - all of `MSGRAPH_CLIENT_ID`, `MSGRAPH_CLIENT_SECRET`, `MSGRAPH_TENANT_ID`, `MSGRAPH_SENDER` present → `MsGraphPasswordResetMailer` (wraps the existing `MicrosoftGraphIntegration.sendEmail`, absolute link via `PASSWORD_RESET_LINK_BASE_URL`, never throws into the request path);
  - otherwise, non-production → `DevOutboxPasswordResetMailer` (JSONL append to `PASSWORD_RESET_OUTBOX_FILE`, default `<tmpdir>/hope-password-reset-outbox.jsonl`) — this is what the E2E reads the raw token from (never an API response);
  - otherwise (production, no creds) → logging no-op with a WARN naming the missing vars.
  - **FLAG: set the four `MSGRAPH_*` vars (+ `PASSWORD_RESET_LINK_BASE_URL`) to activate real delivery; then verify a real send to a safe mailbox.**

### 5.5 SDK / FE deltas

- SDK (`@arcaai/vox`, dist rebuilt): `AUTH_ENDPOINTS.FORGOT_PASSWORD`; `useUsers().requestPasswordReset({ email })` → generic ack; `LoginResponse.passwordExpired?: boolean`.
- `apps/admin`:
  - `routes/forgot-password.tsx` — public request page (email → generic `role=status` success, no token ever rendered);
  - `routes/login.tsx` — "Forgot password?" link + non-blocking `toast.warning` when `passwordExpired` comes back;
  - `routes/reset-password.tsx` — inline complexity checklist (`data-testid=password-rules`, unmet rules only, 12+/U/l/d/special), submit gated on policy + confirm match; server 400 text still shown verbatim as the authoritative fallback.

### 5.6 Test evidence

- **Unit (all green)**: `packages/domains` PasswordResetToken factory/entity — 7 passed; `packages/applications` userPassword suite (policy 21, service 17, mailers 11) — 49 passed; `apps/api` forgot-password controller — 3 passed.
- **API E2E** `apps/api/tests/e2e/task-400-password-security.spec.ts` — **13 passed**: A) 202 parity existing vs unknown (identical bodies, no token/link in response, outbox receives the link), completion via outbox token + relogin, B) reissue revokes prior token (400 on old, DB `revokedAt` stamped), single-use replay 400, expiry (direct DB `expiresAt` backdate) 400, C) complexity 400s with explicit unmet-rule text on completion AND admin temporary path + generated temp password passes policy + completion stamps `passwordChangedAt`, D) rotation flag default-off, and `passwordExpired: true` surfaced (login stays 200) with `maxAgeDays=1` + backdated stamp.
- **TASK-388 regression spec** — 19 passed (admin flows BC intact).
- **FE E2E** `apps/admin/e2e/task-400-password-reset.spec.ts` — **12 passed** (desktop + tablet + mobile): login-page link → request page; unknown email → generic success (no token leak); inline checklist shows exactly the unmet rules, progressively clears, gates submit on mismatch; full completion with a real minted link → success state → **new password logs in (200)** → token replay rejected (single-use).
- **FE build**: `pnpm --filter @arcaai/admin build` green (tsc + vite).

### 5.7 Flags / discoveries (pre-existing, not fixed here)

1. **Admin-created user passwords are stored as-received (unhashed)** — `UserService.create` (TASK-388 §2 finding, module owned by TASK-398 work). Consequence: a creation-time password can never log in (login uses `bcrypt.compare`); a user becomes loginable only after a password-module write. The E2E provisions throwaway users through the temporary-password flow for this reason.
2. **AppSettings duplicate-key trap**: `AppSettingsService.cacheAppSettings()` loads `globalSettingRepository.findAll({})` — which INCLUDES soft-DELETED rows — and the TASK-302 P0-5 boot invariant then counts a DELETED+ENABLED pair for the same platform key as a duplicate → every 45 s cache refresh fails silently (error-level log only) and a subsequent boot **crashes the API**. Deleting a `GlobalSetting` from the admin console and re-creating the same key therefore bricks settings refresh. Worked around in the E2E by UPSERT-ing the rotation key (flip value `1`↔`0`, never delete); left two junk DELETED rows in `hope_test` under retired unique keys (`security.password.maxAgeDays.probe`, `…retired-1782972708777`). A proper fix (exclude DELETED from the cache query/invariant) belongs to the settings module owner.
3. `security.password.maxAgeDays` now exists in `hope_test` as an ENABLED row with value `0` (rotation off — default posture). The FE/API E2E reuse (UPSERT) it.

### 5.8 Stack hand-off

- `:8868` dev:api:test running fresh dists, `GET /api/v1/health` → 200.
- Entitlements enforcement **OFF** (`entitlements.enabled = "false"`).
- Rate limiting **OFF** (`RATE_LIMIT_ENABLED=false` in `.env.test`; throttle decorators inert).
- Admin `:5174` up (serving `/forgot-password`, `/reset-password`).

### Files created/changed (TASK-400 scope)

| Layer | Files |
|---|---|
| database | `password-reset-token.prisma` (new), `user.prisma` (passwordChangedAt + relation), `migrations/20260702000000_task_400_password_reset_tokens/migration.sql` (new) |
| domains | `entities/…/PasswordResetTokenEntity.ts`, `factories/…/PasswordResetTokenFactory.ts`, `models/…/PasswordResetTokenModel.ts`, `mappers/…/PasswordResetTokenEntityMapper.ts`, `repositories/…/PasswordResetTokenRepository.ts` (all new) + `UserEntity`/`UserModel` (passwordChangedAt) + barrels + `core.database.module.ts` + factory test (new) |
| applications | `userPassword/password-policy.ts` (new), `userPassword.service.ts` (rewritten to DB tokens), `msgraph-mailer.ts` (new), `dev-outbox-mailer.ts` (new), `userPassword.service.module.ts` (mailer factory), DTOs `forgot-password.request/response.ts` (new), `reset-password.request.ts` + `complete-password-reset.request.ts` (MinLength removed), barrels, `common/modelFilterTypes.ts` (User filter field), tests: `password-policy.test.ts`, `userPassword.service.test.ts` (rewritten), `msgraph-mailer.test.ts` (new) |
| api | `modules/user/controllers/forgot-password.controller.ts` (+test, new), `user.module.ts`, `modules/auth/auth.controller.ts` + `dto/login.response.ts` (passwordExpired) |
| sdk | `core/constants.ts` (FORGOT_PASSWORD), `hooks/useUsers.ts` (requestPasswordReset), `types/auth.ts` (passwordExpired), `useUsers.task400.test.ts` (new), dist rebuilt |
| admin FE | `routes/forgot-password.tsx` (new), `routes/login.tsx`, `routes/reset-password.tsx` |
| e2e | `apps/api/tests/e2e/task-400-password-security.spec.ts` (new), `apps/admin/e2e/task-400-password-reset.spec.ts` (new) |

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-02 | Ticket created; requirement analysis, current-state, decisions, plan. | this README |
| 2026-07-02 | Implementation completed across all layers; unit + live API/FE E2E green; test+dev DBs synced additively; doc finalized. | §5 file table |
