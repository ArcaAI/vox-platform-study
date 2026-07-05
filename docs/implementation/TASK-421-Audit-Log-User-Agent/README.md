# TASK-421 — Audit Log Records `userAgent: "node"` for Admin-Console Logins

| | |
|---|---|
| **Status** | In Progress |
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

_(pending)_

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket opened from user bug report; root cause isolated to missing UA forwarding in admin-console BFF. |
