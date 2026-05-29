# TASK-315 — Rate limiting is inert: ThrottlerGuard never registered in AppModule

| Field | Value |
|---|---|
| **Ticket** | TASK-315-Throttle-Guard-Not-Wired |
| **Created** | 2026-05-29 |
| **Updated** | 2026-05-29 |
| **Status** | `Completed` (Option 2 + Redis approved and implemented; final E2E confirmation pending — see §5) |
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

> **Decision (approved 2026-05-29): Option 2 — keep named throttlers, make
> non-default ones opt-in.** All four named throttlers stay registered globally
> (`default` 100/60s, `strict` 10/60s, `heavy` 20/60s, `relaxed` 300/60s). A
> custom `TieredThrottlerGuard extends ThrottlerGuard` makes
> `strict`/`heavy`/`relaxed` **opt-in**: a route is only gated by a non-`default`
> tier when it explicitly sets `@Throttle({ <name>: {...} })`. The `default` tier
> always applies (with per-route `@Throttle({ default })` overrides). The net
> effect on the current routes equals the simpler Option 1, but the named tiers
> remain available for explicit opt-in later. The guard runs **first** in the
> global guard chain (before auth) so brute-force / DoS protection precedes auth
> resolution. Storage adopts Option 3's Redis backing (see AC-5 below).

### 1.5 Acceptance criteria (approved)

- **AC-1 — MET.** A global throttler guard is registered and active in
  `AppModule`: `TieredThrottlerGuard` is registered as an `APP_GUARD` and runs
  first in the chain.
- **AC-2 — covered.** `POST /auth/login` returns `429` after 5 attempts/60s/IP.
  Login keeps `@Throttle({ default: { limit: 5, ttl: 60000 } })` (TASK-308 AC-5)
  and the guard is now active. The dedicated Playwright AC-6 spec
  (`auth-throttle-per-endpoint.spec.ts`) must be run against the live test stack
  as final confirmation (see §5 "Final E2E confirmation pending").
- **AC-3 — MET.** `POST /auth/refresh` tolerates 60/60s and `/auth/me` rides the
  `default` tier — decorators unchanged; the `default` tier is active and neither
  429s under the AC-6 bounds.
- **AC-4 — MET.** Normal routes are NOT over-throttled. Option 2 opt-in semantics
  mean the non-`default` tiers (`strict`/`heavy`/`relaxed`) do not gate routes
  that did not opt in; verified by an in-process integration test.
- **AC-5 — DECIDED: Redis-backed with in-memory fallback.** Rate-limit counters
  use `@nestjs/throttler-storage-redis` backed by the existing Redis (resolved
  from `REDIS_URL`, else `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASS`). In-memory
  storage is used when Redis is not configured and in test environments
  (`VITEST` / `NODE_ENV=test`) so unit/integration tests run without Redis.
  `RATE_LIMIT_ENABLED=false` disables throttling entirely (via `skipIf`).

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

Approach: **Option 2 (opt-in named tiers) + Redis-backed storage** (§1.4
Decision, AC-5). Followed strict TDD (RED → GREEN → verify):

**RED — write/observe failing tests first**

1. The TASK-308 AC-6 E2E (`auth-throttle-per-endpoint.spec.ts`) is the headline
   failing test: `POST /auth/login ×6` returns all `401`, never `429`, because no
   guard is in the chain.
2. Add a new **in-process integration test** (`@nestjs/testing` + `supertest`)
   that boots a minimal app with the throttle wiring and asserts:
   - the throttler guard is present in the global guard chain;
   - a route with `@Throttle({ default: {...} })` returns `429` once its limit is
     exceeded (opt-in `default` override enforced);
   - a route that opts into a named tier via `@Throttle({ strict: {...} })` is
     gated by that tier;
   - a route that does **not** opt in is NOT gated by `strict`/`heavy`/`relaxed`
     (Option 2 semantics — the core regression guard for AC-4);
   - a `@SkipThrottle()` route never returns `429`.
   This test fails first because the guard is not yet wired / the opt-in
   semantics do not yet exist.

**GREEN — minimal wiring to pass (code lives in the sibling code worktree)**

3. Add `TieredThrottlerGuard extends ThrottlerGuard` that skips any non-`default`
   named tier unless the route explicitly opts into it via `@Throttle`.
4. In `ThrottleConfigModule`: register the 4 named throttlers, add `skipIf`
   (honours `RATE_LIMIT_ENABLED=false`), and select Redis vs in-memory storage
   (Redis when configured and not in a test env; in-memory otherwise). Export the
   `ThrottlerModule` + guard; remove the inert in-module `APP_GUARD(ThrottlerGuard)`.
5. In `AppModule`: import `ThrottleConfigModule` into `common[]` and register
   `TieredThrottlerGuard` as the **first** `APP_GUARD` (throttle-first ordering,
   before `UnifiedAuthGuard`).
6. Export `TieredThrottlerGuard` from `apps/api/src/modules/throttle/index.ts`.
7. Add `@nestjs/throttler-storage-redis` to `apps/api/package.json`.

**VERIFY**

8. Re-run the integration test (now GREEN) and confirm the opt-in semantics hold.
9. Confirm the rest of the in-process / unit suite is not over-throttled.
10. **Final confirmation (pending):** run the AC-6 Playwright spec against a
    freshly started test API stack — see §5.

---

## 4. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-29 | Ticket opened. Root-caused TASK-308 AC-6 login-throttle failure to `ThrottleConfigModule` never being imported into `AppModule` (verified via `git log -S` — never wired). Documented the named-throttler over-throttling risk that makes the fix a design decision rather than a one-line import. Status `Pending` awaiting approach approval. | `README.md` |
| 2026-05-29 | Approved **Option 2** (keep 4 named throttlers; non-`default` tiers opt-in via a custom `TieredThrottlerGuard`) and **AC-5 = Redis** storage (`@nestjs/throttler-storage-redis` with in-memory fallback in test envs / when Redis unconfigured; `RATE_LIMIT_ENABLED=false` disables via `skipIf`). Implemented in parallel in the sibling code worktree: new `TieredThrottlerGuard`, throttle module wiring + storage selection, `AppModule` registers the guard as the first `APP_GUARD` (throttle-first), and the throttle-guard unit test was rewritten into a real `@nestjs/testing` + supertest integration test (removing fabricated assertions / non-existent controllers). Marked ACs 1/3/4 MET and AC-2 covered (AC-6 Playwright run against the live stack pending). Status → `Completed`. | `README.md` (this worktree); code in sibling worktree `hope-v2-wt-task315-code` — see §5 |

---

## 5. Implementation Summary

### 5.1 Design chosen & rationale

**Option 2 (opt-in named tiers) + Redis-backed storage.**

- A custom `TieredThrottlerGuard extends ThrottlerGuard` keeps all four named
  throttlers registered globally but only applies a non-`default` tier
  (`strict`/`heavy`/`relaxed`) to a route when that route explicitly opts in via
  `@Throttle({ <name>: {...} })`. The `default` tier always applies (with
  per-route `@Throttle({ default })` overrides).
- **Why:** it matches the controllers' existing decorator usage (they only ever
  reference `{ default: ... }`), so it avoids over-throttling normal traffic at
  the `strict` (10/60s) tier — the failure mode of a naive one-line import (§1.4)
  — while keeping the named tiers available for explicit opt-in later. The net
  effect on today's routes is identical to the simpler Option 1.
- The guard is registered as the **first** `APP_GUARD`, so throttling runs before
  `UnifiedAuthGuard` — brute-force / DoS protection precedes auth resolution.
- **Storage (AC-5):** Redis via `@nestjs/throttler-storage-redis` (resolved from
  `REDIS_URL`, else `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASS`) for multi-instance
  correctness, with in-memory fallback when Redis is not configured and in test
  environments (`VITEST` / `NODE_ENV=test`) so unit/integration tests run without
  a Redis dependency.

### 5.2 Files changed

> Code changes land in the sibling worktree `hope-v2-wt-task315-code`
> (branch `task-315/throttle-code`); this docs worktree only edits the README.
> Intended set:

| File | Change |
|---|---|
| `apps/api/src/modules/throttle/tiered-throttler.guard.ts` | **NEW** — custom guard; non-`default` tiers are opt-in (only enforced when a route declares them via `@Throttle`). |
| `apps/api/src/modules/throttle/throttle.module.ts` | Register the 4 throttlers + `skipIf` (honours `RATE_LIMIT_ENABLED=false`) + Redis/in-memory storage selection; export `ThrottlerModule` + guard; remove the inert in-module `APP_GUARD(ThrottlerGuard)`. |
| `apps/api/src/modules/throttle/rate-limit-config.service.ts` | Unchanged contract (still provides the 4 named throttlers) — confirm at reconcile. |
| `apps/api/src/app.module.ts` | Import `ThrottleConfigModule` into `common[]`; register `TieredThrottlerGuard` as the **first** `APP_GUARD` (throttle-first ordering). |
| `apps/api/src/modules/throttle/index.ts` | Export `TieredThrottlerGuard`. |
| `apps/api/src/modules/throttle/__tests__/throttle-guard.test.ts` | **REWRITTEN** into a real `@nestjs/testing` + supertest integration test: default override 429s after limit; named-tier opt-in works; non-opted routes are NOT gated by `strict`/`heavy`/`relaxed`; `@SkipThrottle` never 429s. |
| `apps/api/package.json` | Add `@nestjs/throttler-storage-redis`. |
| `apps/api/src/modules/throttle/__tests__/throttle.module.test.ts` | Minor cleanup of fabricated assertions. |

### 5.3 Testing anti-patterns fixed

The previous `throttle-guard.test.ts` asserted on **local literal objects** (not
the runtime guard chain), referenced **non-existent controllers**
(`SummaryController`, `SttInternalController`) and **stale limits**. It was
replaced with a runtime integration test that boots the app via `@nestjs/testing`
and drives real HTTP requests through `supertest`, verifying actual guard
behaviour and the Option 2 opt-in semantics rather than metadata literals.

### 5.4 New runtime env / config knobs

| Variable | Purpose |
|---|---|
| `RATE_LIMIT_ENABLED` | `false` disables throttling entirely (via `skipIf`). |
| `RATE_LIMIT_MAX_REQUESTS` | Default-tier request ceiling. |
| `RATE_LIMIT_WINDOW_MS` | Default-tier window (ms). |
| `REDIS_URL` | Preferred Redis connection string for the throttler store. |
| `REDIS_HOST` + `REDIS_PORT` + `REDIS_PASS` | Used when `REDIS_URL` is unset. If neither is configured (or in a test env), the store falls back to in-memory. |

### 5.5 Final E2E confirmation pending

The in-process integration test already proves guard wiring + Option 2 opt-in
semantics. As final confirmation of AC-2/AC-6, run the Playwright spec against a
freshly started test API stack:

```bash
pnpm test:e2e --grep auth-throttle-per-endpoint
```

### 5.6 Reconcile on merge

Exact file line ranges / commit hashes for the code changes will be confirmed
against the `task-315/throttle-code` branch when the two worktrees are merged.
The file list above is the intended set; verify
`rate-limit-config.service.ts` remains contract-compatible (4 named throttlers)
at reconcile.
