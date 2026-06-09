# UnifiedAuthGuard Cleanup: Diagnosable Errors + Single Idempotent Enforcement

| | |
|---|---|
| **Ticket** | TASK-343 |
| **Name** | UnifiedAuthGuard Cleanup (single global enforcement point, idempotent per request, diagnosable auth failures) |
| **Created** | 2026-06-09 |
| **Updated** | 2026-06-09 |
| **Status** | Completed (live SSE 200/401 spot-check deferred — needs a running API + Redis; see §4) |
| **Classification** | refactor |
| **Cross-ref** | TASK-307 W4b (registered `UnifiedAuthGuard` as the global `APP_GUARD`), TASK-263 W0-1 / TASK-295 SEC-A5-6 (`JwtAuthGuard` stream-ticket path), TASK-319 F6 (admin route audit), TASK-340 (SSE debugging that surfaced the swallowed-error symptom) |
| **Plan** | `.cursor/plans/auth_guard_cleanup_8859769f.plan.md` (source of truth — not edited) |

> This is a **surgical refactor** of the authorization layer. The global `APP_GUARD` becomes the single auth/authorization enforcement point: idempotent per request and diagnosable on failure. No new auth mechanisms, no route contract changes — every route keeps exactly the same `@Public()` / `@Authorize()` semantics it has today.

---

## 1. Requirement Analysis

### Description
`UnifiedAuthGuard` is registered as the global `APP_GUARD` (`apps/api/src/app.module.ts`), yet `@Authorize()` / `@AuthorizeAny()` *also* re-apply it via `@UseGuards(UnifiedAuthGuard)` (`packages/applications/src/authorization/decorators.ts`). Two concrete problems:

1. **Swallowed errors** — the `catch {}` at `unified-auth.guard.ts:100` discards the real JWT/ticket failure and replaces it with a generic 401, which hid the root cause during recent SSE debugging.
2. **Redundant work** — every `@Authorize()` route runs the guard at least twice (global + decorator), doing an extra CASL `buildAbility` + Redis round-trips. `SmrProxyController` is worse: a class-level `@UseGuards(JwtAuthGuard)` on top of method `@Authorize()` makes `text/*` routes run the JWT path three times.

### Business context
Auth runs on every request. Double/triple execution wastes CASL builds + Redis round-trips on the hot path, and the swallowed error made a production SSE auth bug effectively undiagnosable. Centralizing enforcement on the single global guard, memoizing the success path, and logging the underlying failure restore both performance and observability without changing the security contract.

### Acceptance criteria
- Underlying JWT/ticket failures are logged (debug/warn) server-side; the client still receives a generic 401.
- `UnifiedAuthGuard` authenticates and builds the CASL ability **at most once** per request.
- `@Authorize()` / `@CanXxx()` no longer attach a route-level guard; no controller re-applies an auth guard already covered by the global `APP_GUARD`.
- All unit/integration/e2e auth tests pass; boot audit passes; **403 (permission denied) stays distinct from 401 (unauthenticated)**.

### Critical behavioral subtlety to preserve
At `unified-auth.guard.ts`, `handleJwtPostAuth(...)` is `return`ed **un-awaited** inside the `try`, so a permission-denied `ForbiddenException` (403) escapes the `try` instead of being masked by the JWT `catch`. Only the awaited `jwtAuthGuard.canActivate` rejection is swallowed → generic 401. The cleanup MUST NOT start awaiting `handleJwtPostAuth` inside the `try`, or 403s would be downgraded to 401s.

### Out of scope (per plan)
- Removing the `JwtAuthGuard` `CONSUMED_STREAM_TICKET` memoization (kept as the innermost single-use-ticket safety net).
- Changing the `HarnessServiceTokenGuard` service-token mechanism (a *distinct* auth path, intentionally left as-is).
- Any route contract / permission changes.

---

## 2. Current State Evaluation

- **`packages/applications/src/authorization/unified-auth.guard.ts`** — `canActivate` (lines 58-113) authenticates (API key → JWT → 401) and runs CASL post-auth. The JWT `catch {}` (line 100) is empty; `return this.handleJwtPostAuth(...)` (line 98) is intentionally un-awaited. No per-request memoization → re-runs fully on a 2nd pass.
- **`packages/applications/src/authorization/decorators.ts`** — `Authorize` (line 62) and `AuthorizeAny` (line 89) apply `@UseGuards(UnifiedAuthGuard)` on top of the global guard, causing the double execution. `Public`, `SetPermissions`, `SetPermissionMode`, and all `CanXxx` aliases are already metadata-only / delegate to `Authorize`.
- **`apps/api/src/guards/jwtauth.guard.ts`** — holds the `CONSUMED_STREAM_TICKET` request-scoped memo so a single-use stream ticket survives the (currently double) guard pass. This stays as the innermost safety net.
- **`apps/api/src/modules/streaming/smr-proxy.controller.ts`** — class-level `@UseGuards(JwtAuthGuard)` (line 123) + every method already carries `@Authorize()`. The class-level guard is redundant given the global `APP_GUARD`.
- **`apps/api/src/modules/consultation/harness-internal.controller.ts`** — `@Public()` + `@UseGuards(HarnessServiceTokenGuard)`. The `@Public()` label exempts it from the global guard; the service-token guard is the real auth. Distinct mechanism — leave as-is.
- **Tests** — `decorators.test.ts` asserts `@Authorize()`/`@AuthorizeAny()` attach `UnifiedAuthGuard` (will be inverted). `admin-route-permission-audit.test.ts` `.overrideGuard(UnifiedAuthGuard)` becomes a no-op (audit reads metadata, not guards). `unified-auth.guard.test.ts` + `jwtauth.guard.test.ts` cover the guards. `auth-coverage.spec.ts` (W4a static + W4b synthetic) + `full-route-walk.spec.ts` (`.skip`) read metadata only.
- **Boot audit** — `apps/api/src/bootstrap/admin-route-permission-audit.ts` walks all routes and requires `@Public()` or `REQUIRED_PERMISSIONS_KEY`. It reads **metadata**, not guards, so removing the decorator guard does not affect it.

---

## 3. Implementation Plan (sequential: code → tests → verify)

Tightly-coupled single refactor in `packages/applications/src/authorization/` + one controller sweep + tests.

1. **Log the swallowed error** — replace `catch {}` in `unified-auth.guard.ts` with a level-split log: `UnauthorizedException` → `debug` (expected noise), anything else → `warn`. Keep the generic 401 to the client; keep the un-awaited `return this.handleJwtPostAuth(...)`.
2. **Make the guard idempotent per request** — add a request-scoped `UNIFIED_AUTH_RESULT` symbol memo; extract the existing `canActivate` body into a private `authenticate(context)`; the new `canActivate` short-circuits `true` on a 2nd pass and only memoizes the success path (a thrown 401/403 stops the pipeline first).
3. **Decorators metadata-only** — drop `@UseGuards(UnifiedAuthGuard)` from `Authorize` + `AuthorizeAny`; keep `SetMetadata(...)` + `ApiBearerAuth()`; remove the now-unused `UseGuards` / `UnifiedAuthGuard` imports.
4. **Sweep direct guard re-applications** — remove class-level `@UseGuards(JwtAuthGuard)` from `SmrProxyController` (methods already carry `@Authorize()`); drop the unused `JwtAuthGuard` / `UseGuards` imports. Verify `HarnessInternalController` is `@Public()` and leave its `HarnessServiceTokenGuard` as-is (documented intentional).
5. **Tests** — invert the two decorator "should apply UnifiedAuthGuard" assertions to "attaches no `__guards__`"; update the stale `.overrideGuard` comment in the audit test; add `unified-auth.guard` unit tests for (a) idempotency, (b) level-split logging, (c) **403 stays distinct from 401**.
6. **Verify** — `pnpm test:unit --filter @arcaai/applications`, the api guard tests + runnable auth integration specs, `pnpm build --filter @arcaai/applications` + `pnpm build:api`; confirm the boot audit logic still holds.

### Tests to write/update (TDD list)
- `decorators.test.ts` — `Authorize` attaches no `__guards__` (was: contains `UnifiedAuthGuard`).
- `decorators.test.ts` — `AuthorizeAny` attaches no `__guards__` (was: contains `UnifiedAuthGuard`).
- `unified-auth.guard.test.ts` — idempotency: two `canActivate` on one request → `buildAbility` once, `true` twice.
- `unified-auth.guard.test.ts` — logging: swallowed `UnauthorizedException` logged at `debug`, client still gets generic 401.
- `unified-auth.guard.test.ts` — logging: unexpected (non-`UnauthorizedException`) JWT error logged at `warn`.
- `unified-auth.guard.test.ts` — 403 vs 401: CASL-denied success path throws `ForbiddenException` (status 403, NOT `UnauthorizedException`); unauthenticated path throws `UnauthorizedException` (status 401).
- `admin-route-permission-audit.test.ts` — stale `.overrideGuard` comment updated; suite stays green.
- `jwtauth.guard.test.ts` — unchanged (regression; `CONSUMED_STREAM_TICKET` memo retained).

---

## 4. Implementation Summary

### What was built
The global `UnifiedAuthGuard` (`APP_GUARD`) is now the single auth/authorization enforcement point: **idempotent per request** and **diagnosable** on failure. Route decorators became metadata-only and the redundant controller-level guard was removed. The 403/401 distinction and the single-use stream-ticket safety net are both preserved.

1. **Diagnosable JWT failures** — the empty `catch {}` in `unified-auth.guard.ts` is now a level-split log: an `UnauthorizedException` (expected: bad/expired token, consumed ticket) logs at `debug`; anything else logs at `warn`. The client still receives the generic 401. The `return this.handleJwtPostAuth(...)` stays **un-awaited**, so a permission-denied 403 still escapes the `try` instead of being masked.
2. **Idempotent per request** — a request-scoped `UNIFIED_AUTH_RESULT` symbol memo was added. `canActivate` now short-circuits `true` on a repeat pass; the original body was extracted into a private `authenticate(context)`. Only the **success** path is memoised (a thrown 401/403 stops the pipeline first), so CASL `buildAbility` + Redis run at most once per request.
3. **Decorators metadata-only** — `@Authorize()` / `@AuthorizeAny()` no longer apply `@UseGuards(UnifiedAuthGuard)`; they keep `SetMetadata(...)` + `@ApiBearerAuth()`. Unused `UseGuards` / `UnifiedAuthGuard` imports dropped.
4. **Controller sweep** — `SmrProxyController`'s class-level `@UseGuards(JwtAuthGuard)` was removed (every method already carries `@Authorize()`; the global guard authenticates). Unused `JwtAuthGuard` / `UseGuards` imports dropped.

### Files changed
| File | Purpose |
|---|---|
| `docs/implementation/TASK-343-Auth-Guard-Cleanup/README.md` | **(new)** Ticket doc — planning + this summary. |
| `packages/applications/src/authorization/unified-auth.guard.ts` | Added `UNIFIED_AUTH_RESULT` memo + idempotent `canActivate` wrapper delegating to private `authenticate()`; level-split (debug/warn) logging in the JWT `catch`; preserved the un-awaited `handleJwtPostAuth` (403 ≠ 401). |
| `packages/applications/src/authorization/decorators.ts` | `Authorize` + `AuthorizeAny` are now metadata-only (removed `@UseGuards(UnifiedAuthGuard)`); dropped unused `UseGuards` / `UnifiedAuthGuard` imports. |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Removed redundant class-level `@UseGuards(JwtAuthGuard)`; dropped unused `JwtAuthGuard` / `UseGuards` imports. |
| `packages/applications/src/authorization/__tests__/unified-auth.guard.test.ts` | Added unit tests: idempotency (×2), swallowed-error debug/warn logging (×2), 403-vs-401 distinction (×2). |
| `packages/applications/src/authorization/__tests__/decorators.test.ts` | Inverted the two "should apply UnifiedAuthGuard" assertions to "attaches no `__guards__`"; removed the now-unused `UnifiedAuthGuard` import. |
| `apps/api/src/bootstrap/__tests__/admin-route-permission-audit.test.ts` | Updated the stale `.overrideGuard(UnifiedAuthGuard)` comment (decorators are now metadata-only → defensive no-op). |

### Verified intentional — NOT changed
- `apps/api/src/modules/consultation/harness-internal.controller.ts` — confirmed `@Public()` + `@UseGuards(HarnessServiceTokenGuard)`. The `@Public()` label exempts it from the global guard so the distinct service-token mechanism is reachable. Left as-is (intentional, documented in the controller).
- `apps/api/src/guards/jwtauth.guard.ts` — the `CONSUMED_STREAM_TICKET` per-request memo is retained as the innermost single-use-ticket safety net.

### Verification evidence (actual output)
- **`pnpm --filter @arcaai/applications test:unit`** → `Test Files 209 passed | 1 skipped (210)`, `Tests 4926 passed | 4 skipped (4930)`, exit 0. (Command-form note below.)
- **Focused guard + decorators** (`vitest run unified-auth.guard.test.ts decorators.test.ts`) → `Test Files 2 passed (2)`, `Tests 64 passed (64)`, exit 0. The new `DEBUG [UnifiedAuthGuard] { message: 'JWT/ticket auth failed; falling through to 401', reason: 'bad token' }` line is emitted, confirming the previously-swallowed error is now logged.
- **API guard + audit + integration** (`vitest run jwtauth.guard.test.ts admin-route-permission-audit.test.ts auth-coverage.spec.ts full-route-walk.spec.ts`) → `Test Files 3 passed | 1 skipped (4)`, `Tests 35 passed | 3 skipped (38)`, exit 0. `auth-coverage.spec.ts` ran without external services (W4a static AppModule walk + W4b synthetic runtime walk both green). `full-route-walk.spec.ts` is `describe.skip` (deferred since TASK-309; needs `createTestApp()` which hangs on infra boot).
- **`pnpm build --filter @arcaai/applications`** → `Tasks: 7 successful, 7 total`, exit 0 (run twice; stable).
- **`pnpm build:api`** → `Tasks: 8 successful, 8 total`, exit 0.
- **`ReadLints`** on all 7 changed files → no linter errors.
- **Boot audit logic** — the audit reads `SKIP_AUTH_KEY` / `REQUIRED_PERMISSIONS_KEY` **metadata**, not guards. The decorators still set that metadata, so every route keeps its label. The test-side mirror — `auth-coverage.spec.ts`'s W4a static walk over the real `AppModule` ("every route declares `@Public()` OR `REQUIRED_PERMISSIONS_KEY`") — is green, confirming the boot audit still passes.

### Deviations / notes
- **Command form**: the plan/workflow gate is written `pnpm test:unit --filter @arcaai/applications`. That literal form runs the **root** `test:unit` (which is `vitest run` and has no `--filter` flag) so the filter would be misapplied. The equivalent, unambiguous pnpm form `pnpm --filter @arcaai/applications test:unit` was used instead — same intent (the `@arcaai/applications` unit suite), green.
- **Transient build flake (not from this change)**: the **first** `pnpm build:api` failed with `sttInternal.service.ts(57,19): error TS2339: Property 'createStreamingTranscript' does not exist on type 'SttInternalService'` — an STT file untouched by this ticket whose method demonstrably exists (defined at line 119). It did not reproduce on re-run (build green) and the standalone applications build passed before and after, so it was a transient turbo/tsc artifact. Flagged for awareness; **out of scope** for TASK-343.
- **Live SSE spot-check deferred**: the "200 with a fresh ticket / 401 on reuse" check needs a running API + Redis (not available here). The unit-level guarantee — `jwtauth.guard.test.ts`'s "memoises the consumed ticket per request" test (single-use semantics) — passes.

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-09 | Ticket created; planning sections drafted from the approved plan. | `docs/implementation/TASK-343-Auth-Guard-Cleanup/README.md` |
| 2026-06-09 | Implemented Option C + sweep: idempotent + diagnosable `UnifiedAuthGuard`, metadata-only decorators, removed redundant `SmrProxyController` class guard; added/updated tests; verified (builds + unit/integration auth tests green). | `unified-auth.guard.ts`, `decorators.ts`, `smr-proxy.controller.ts`, `unified-auth.guard.test.ts`, `decorators.test.ts`, `admin-route-permission-audit.test.ts` |
