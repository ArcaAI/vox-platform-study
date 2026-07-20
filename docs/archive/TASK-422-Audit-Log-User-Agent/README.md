# TASK-422 — Audit Log Records `userAgent: "node"` for Admin-Console Logins

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Severity** | Medium — audit-trail fidelity (HIPAA §164.312(b) relevance), no security exposure |
| **Reported** | 2026-07-05 |
| **Affected surface** | `apps/admin-console` (BFF), audit rows written by `apps/api` auth endpoints |

## Requirement Analysis

A LOGIN audit row for a Global admin user shows a wrong user agent:

```json
{
    "method": "POST",
    "timestamp": "2026-07-05T15:40:35.316Z",
    "userAgent": "node"
}
```

The operator logged in from a browser, so the audit trail should record the browser's
`User-Agent` (e.g. `Mozilla/5.0 ...`), not `node`. Audit rows exist precisely to answer
"who did what from where/what client" — recording the BFF's own HTTP client identity
defeats that purpose for every admin-console session.

## Root Cause (systematic-debugging Phases 1–3)

**Reproduction / evidence chain:**

1. The gateway records the user agent verbatim from the request it receives —
   `apps/api/src/modules/auth/auth.controller.ts` (`login`, line ~270):
   `userAgent: req.headers['user-agent'] || 'Unknown'` → emitted via
   `AuthService.trackAuthentication` → persisted by
   `AuditLogService.handleUserAuthenticatedEvent` into the LOGIN row's `data`.
2. The admin console uses the mandatory BFF pattern (rule `13-nextjs-apps.mdc`):
   browser → Next.js route handler `POST /api/auth/login`
   (`apps/admin-console/src/app/api/auth/login/route.ts`) → **server-side `fetch()`**
   → gateway `POST /api/v1/auth/login`.
3. Node's built-in fetch (undici) hardcodes `User-Agent: node` when the caller does not
   set one. Verified empirically on the workspace Node (v24):
   a bare `fetch()` against a local HTTP server logs `UA seen by server: "node"`, and an
   explicit `user-agent` header overrides it.
4. The BFF login fetch sends only `{ 'content-type': 'application/json' }` — the
   browser's `User-Agent` is never forwarded. Hence the gateway sees, and audits, `node`.

**Hypothesis validated:** the bug occurs because the BFF does not forward the original
client's `User-Agent` on gateway calls, so undici's default (`node`) is audited when a
Global admin logs in via the admin console. Present since the console's inception
(commit `d3a04d1b` introduced the route with no UA forwarding) — a day-one gap, not a
regression.

## Current State Evaluation

Every BFF → gateway call site has the same gap. Audit-writing gateway endpoints marked ●:

| BFF call site | Gateway endpoint | Audit row affected |
|---|---|---|
| `src/app/api/auth/login/route.ts` | `POST /auth/login` | ● LOGIN (the reported row) |
| `src/app/api/auth/logout/route.ts` | `POST /auth/logout` | ● LOGIN-shaped logout row |
| `src/app/api/auth/impersonate/route.ts` | `POST /admin/users/:id/impersonate` | ● impersonation START bracket + forced row |
| `src/app/api/auth/revoke-impersonation/route.ts` | `POST /auth/revoke-impersonation` | ● impersonation STOP bracket |
| `src/server/hope-proxy.ts` (catch-all data proxy) | every `/api/v1/*` call | ● per-request `IMPERSONATED_ACTION` rows (`ImpersonationAuditInterceptor`) |
| `src/app/api/auth/stream-ticket/route.ts` | `POST /auth/stream-ticket` | no audit row today; forwarded for consistency |
| `src/server/refresh.ts` | `POST /auth/refresh` | none — endpoint writes no audit row; also runs as a single-flight shared across concurrent requests (no single originating `Request`), so intentionally **out of scope** |

The gateway side needs **no change**: it already prefers the incoming `User-Agent`
header; the BFF simply has to behave like a proper reverse proxy and pass it through.

### Related finding (out of scope, noted for follow-up)

`responsibleIp` on the same rows records the BFF host's IP (`req.ip` at the gateway),
not the operator's. Fixing that requires forwarding `X-Forwarded-For` **and** enabling
Express `trust proxy` on the gateway — a security-sensitive infrastructure decision
(header spoofing risk when the gateway is also directly reachable). Deliberately not
bundled into this bugfix; needs its own ticket if pursued.

## Implementation Plan (TDD)

1. **RED** — failing tests first:
   - `src/app/api/auth/login/__tests__/route.test.ts` (new): login POST with a browser
     `User-Agent` must forward that exact value to the gateway fetch; a UA-less request
     must not invent one.
   - `src/server/__tests__/hope-proxy.test.ts` (extend): proxied requests forward the
     browser `User-Agent`.
2. **GREEN** — minimal fix:
   - `src/server/gateway.ts`: add `clientUserAgentHeader(request)` helper (returns
     `{ 'user-agent': <browser UA> }` or `{}`).
   - Spread the helper into the fetch headers of `login`, `logout`, `impersonate`,
     `revoke-impersonation`, `stream-ticket` route handlers (adding the `request`
     parameter where the handler didn't take one).
   - `src/server/hope-proxy.ts`: add `'user-agent'` to `FORWARDED_REQUEST_HEADERS`.
3. **Verify**: `pnpm --filter @arcaai/admin-console test` and `lint` green; capture output.

## Implementation Summary

All changes are in `apps/admin-console`; the gateway (`apps/api`) is untouched.

| File | Change |
|---|---|
| `src/server/gateway.ts` | New `clientUserAgentHeader(request)` helper — returns `{ 'user-agent': <incoming UA> }`, or `{}` when the caller sent none (never invents a value). |
| `src/server/hope-proxy.ts` | `'user-agent'` added to `FORWARDED_REQUEST_HEADERS` (catch-all data proxy). |
| `src/app/api/auth/login/route.ts` | Helper spread into the gateway fetch headers. |
| `src/app/api/auth/logout/route.ts` | `POST` now takes `request`; helper spread into headers. |
| `src/app/api/auth/impersonate/route.ts` | Helper spread into headers. |
| `src/app/api/auth/revoke-impersonation/route.ts` | `POST` now takes `request`; helper spread into headers. |
| `src/app/api/auth/stream-ticket/route.ts` | Helper spread into headers (consistency; no audit row today). |
| `src/app/api/auth/login/__tests__/route.test.ts` | NEW — regression tests: browser UA forwarded verbatim; no UA invented when absent. |
| `src/server/__tests__/hope-proxy.test.ts` | Extended — proxied requests forward the browser UA. |

`src/server/refresh.ts` intentionally unchanged (see Current State Evaluation).

### Verification Evidence (2026-07-05)

**TDD RED** — both new tests failed before the fix (`received null` for the forwarded UA), 10 pre-existing tests green.

**TDD GREEN** — targeted run after the fix:

```
Test Files  2 passed (2)
     Tests  13 passed (13)
```

**Full suite** — `pnpm --filter @arcaai/admin-console test`: `501 passed | 1 failed (502)`. The single failure, `src/shared/__tests__/providers.test.tsx`, is UNRELATED pre-existing work: it fails identically with this ticket's changes stashed, and belongs to the in-flight next-themes fix (`BUG-001-NextThemes-Script-Tag-Console-Error`) present uncommitted in the same working tree.

**Lint** — `pnpm --filter @arcaai/admin-console lint` (`--max-warnings 0`): clean.

**Live end-to-end** — against the running dev stack (API :8868, console :5176):

1. DB row for the reported incident located (postgres MCP, read-only): LOGIN row for `super_admin` with `data->>'userAgent' = 'node'`, `createdAt` matching the reported `2026-07-05T15:40:35.316Z` payload timestamp to the millisecond.
2. After the fix: `curl http://localhost:5176/api/auth/login -H 'user-agent: TASK-422-Verification-Browser/1.0' ...` → HTTP 200, and the newest LOGIN audit row for `global_admin` records `userAgent: "TASK-422-Verification-Browser/1.0"`.
3. Control: Playwright e2e logins (direct to gateway, no BFF) always recorded their real UA (`Playwright/1.61.1 ...`) — confirming the defect was scoped to BFF-originated calls.

Production `next build` was deliberately not run: the shared working tree carries unrelated in-flight edits from parallel tickets, and a build would also collide with the developer's running `next dev` server; type-safety of the touched files is covered by the TS language service, ESLint, and Vitest, and runtime behavior was verified live through the dev server.

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket opened from user bug report; root cause isolated to missing UA forwarding in admin-console BFF. |
| 2026-07-05 | Fix implemented TDD-first (helper + 6 call sites + proxy allowlist); verified via unit tests, lint, and a live login through the BFF confirming the audit row now records the real client UA. Status → Completed. |
