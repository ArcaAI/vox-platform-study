# TASK-315 — Rate limiting is inert: ThrottlerGuard never registered in AppModule

| Field | Value |
|---|---|
| **Ticket** | TASK-315-Throttle-Guard-Not-Wired |
| **Created** | 2026-05-29 |
| **Updated** | 2026-05-29 |
| **Status** | `Pending` (design decision required before implementation) |
| **Classification** | Bugfix (security — brute-force / DoS protection absent) |
| **Priority** | High — no rate limiting is enforced anywhere in the API; `login` has no brute-force protection. Not a regression (never wired in any commit), so no live behaviour changes — but it is a standing gap. |
| **Source** | Surfaced by executing TASK-308 AC-6 (`auth-throttle-per-endpoint.spec.ts`) against the live test stack during the `/review` of TASK-308–311 |
| **Related** | TASK-308 AC-5/AC-6 (added `@Throttle` decorators + the E2E that caught this) |

---

## 1. Requirement Analysis

### 1.1 Description

`apps/api/src/modules/throttle/throttle.module.ts` (`ThrottleConfigModule`) is the
**only** place that registers `ThrottlerModule.forRootAsync(...)` and the global
`ThrottlerGuard` (`APP_GUARD`). That module is **not imported** by
`apps/api/src/app.module.ts` (or anywhere outside its own tests):

```text
$ git grep -n ThrottleConfigModule -- apps/api/src/app.module.ts   → (no output)
$ git log --oneline -S ThrottleConfigModule -- apps/api/src/app.module.ts → (empty)
$ git log --oneline -S ThrottlerModule     -- apps/api/src/app.module.ts → (empty)
```

Consequently there is **no `ThrottlerGuard` in the guard chain**, and every
`@Throttle(...)` / `@SkipThrottle(...)` decorator across the codebase
(`AuthController`, `HealthController`, `MonitoringController`) is **metadata with
no reader** — i.e. no rate limiting happens at runtime.

### 1.2 Evidence (TASK-308 AC-6, live test stack)

```text
POST /api/v1/auth/login ×6 rapid (invalid creds) → [401, 401, 401, 401, 401, 401]
expected ≥1 of 6 to be 429 → got 0
```

The login throttle (`@Throttle({ default: { limit: 5, ttl: 60000 } })`, TASK-308
AC-5) never fires. `auth.spec.ts` (17/17) is green only because the limit is
inert.

### 1.3 Impact

- **Security:** no brute-force / credential-stuffing protection on `/auth/login`;
  no per-endpoint or default DoS ceiling on any route.
- **Correctness:** TASK-308 AC-5/AC-6 cannot be satisfied at runtime until this
  is fixed; the unit tests there only assert decorator *metadata*, not enforcement.

### 1.4 Why a naive one-line import is NOT the fix (design decision needed)

`RateLimitConfigService.getThrottlers()` registers **four named throttlers**:
`default` (100/60s), `strict` (10/60s), `heavy` (20/60s), `relaxed` (300/60s).

Under `@nestjs/throttler` `^6.5.0`, a global `ThrottlerGuard` applies **every
configured named throttler to every route** unless a route opts out via
`@SkipThrottle({ <name>: true })`. The controllers only ever reference
`{ default: ... }` in their `@Throttle()` overrides — none reference
`strict`/`heavy`/`relaxed`. So simply importing `ThrottleConfigModule` as-is
would subject **all** routes to the **strictest** active throttler
(`strict` = 10/60s), almost certainly over-throttling normal traffic and the
rest of the E2E suite.

Options to resolve (to be decided in planning):

1. **Single default throttler + per-route overrides** — register only the
   `default` throttler globally; keep `strict`/`heavy`/`relaxed` as values that
   routes opt into via `@Throttle({ default: { limit, ttl } })` overrides (which
   is already the controllers' pattern). Simplest; matches existing decorator usage.
2. **Keep named throttlers but make non-default ones opt-in** — register all
   four but ensure routes are not gated by the non-default ones (requires
   `@SkipThrottle` plumbing or a custom guard). More complex.
3. **Custom guard / tracker** — IP/user-aware tracker, Redis-backed shared
   storage for multi-instance correctness (current config uses default
   in-memory storage despite the module's "Redis-backed" docstring).

### 1.5 Acceptance criteria (draft — pending approval)

- **AC-1** A global throttler guard is registered and active in `AppModule`.
- **AC-2** `POST /auth/login` returns `429` after 5 attempts/60s/IP (TASK-308 AC-6
  `auth-throttle-per-endpoint.spec.ts` passes 3/3).
- **AC-3** `POST /auth/refresh` tolerates 60/60s; `/auth/me` rides the default
  tier — neither 429s under the AC-6 bounds.
- **AC-4** Normal routes are NOT over-throttled (the rest of the E2E suite stays
  green); decide the named-throttler semantics (§1.4).
- **AC-5** (decision) in-memory vs Redis-backed storage for multi-instance
  deployments.

### 1.6 Out of scope

- Per-tenant rate limiting (TASK-302 family, already noted in TASK-308 §1.4).

---

## 2. Current State Evaluation

- `apps/api/src/modules/throttle/throttle.module.ts` — `ThrottleConfigModule` (unimported).
- `apps/api/src/modules/throttle/rate-limit-config.service.ts` — 4 named throttlers; `isEnabled()` gated by `RATE_LIMIT_ENABLED !== 'false'`.
- `apps/api/src/app.module.ts` — `common[]` / `featureModules[]` do **not** include `ThrottleConfigModule`; `guards[]` has `UnifiedAuthGuard` + `RequiresIfMatchGuard` only.
- `@Throttle` consumers: `auth.controller.ts`, `health.controller.ts`, `monitoring.controller.ts`.
- Existing tests assert decorator metadata + module shape only (no runtime enforcement test besides the new TASK-308 AC-6 E2E).

---

## 3. Implementation Plan

_To be written after the §1.4 design decision is approved._ Will follow TDD:
RED via the AC-6 E2E (already failing) + a focused integration test that the
guard is in the chain; GREEN by wiring the chosen throttler config; verify the
full E2E suite is not over-throttled.

---

## 4. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-29 | Ticket opened. Root-caused TASK-308 AC-6 login-throttle failure to `ThrottleConfigModule` never being imported into `AppModule` (verified via `git log -S` — never wired). Documented the named-throttler over-throttling risk that makes the fix a design decision rather than a one-line import. Status `Pending` awaiting approach approval. | `README.md` |
