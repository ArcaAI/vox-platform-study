# TASK-421 — Prisma Studio 401 through the Admin-Console BFF Embed

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Reported** | 2026-07-05 — "when accessing Prisma Studio using global admin user: `{"message":"Authentication required. Provide a valid JWT (Authorization: Bearer) or API key (X-API-Key).","error":"Unauthorized","statusCode":401}`" |
| **Affected surfaces** | `apps/api/src/modules/pstudio/pstudio.html.ts` (served studio shell), `apps/admin-console` Frame 19 `/pstudio`, `apps/admin-console/src/server/hope-proxy.ts` |
| **Related tickets** | TASK-038 (embedded studio), TASK-307 W5.2, TASK-326 X1, TASK-336 OB-11 (fragment-token design), TASK-403 (status probe), TASK-415 Frame 19, TASK-419 item 4 |

## Requirement Analysis

A GLOBAL_ADMIN with the seeded `manage:PrismaStudio` permission opens the console's Prisma Studio screen (`/pstudio`, iframe on `/api/hope/admin/pstudio`). The studio UI loads but every query fails with the gateway's `UnifiedAuthGuard` 401. Expected: studio queries execute through the session-guarded BFF chain with no client-readable token.

## Current State Evaluation (Root Cause — confirmed)

**Evidence (API dev log, 2026-07-05 22:57):**

```
22:57:08.581 INFO  GET  /api/v1/admin/pstudio/status → 200
22:57:08.644 INFO  GET  /api/v1/admin/pstudio        → 200   ← shell HTML served fine
22:57:10.701 WARN [UnifiedAuthGuard] Authentication failed, reason: no_valid_credentials, POST /api/v1/admin/pstudio  (×4)
```

**Failure chain:**

1. The console screen embeds `<iframe src="/api/hope/admin/pstudio">` (no `#token=` fragment — and none is possible: per the TASK-415 BFF architecture the JWT lives in an encrypted httpOnly cookie and is never client-readable).
2. `GET /api/hope/admin/pstudio` → Next.js BFF proxy attaches `Authorization: Bearer <JWT>` server-side → gateway 200 → studio shell HTML served. This is why the GET succeeds.
3. The shell (TASK-336 OB-11 design, built for the ui-playground era where the browser held a JWT in Zustand) reads its bearer token from the URL fragment. No fragment → empty token → BFF client configured with `Authorization: Bearer ` (empty).
4. The shell POSTs queries to `studioEndpointUrl` — an **absolute URL computed server-side from the Host header the gateway saw** (`http://localhost:8868/api/v1/admin/pstudio`, the internal `API_URL` the proxy dialed). POSTs therefore go **directly to the gateway, bypassing the authenticating console proxy**.
5. `UnifiedAuthGuard` finds no valid credential → 401 with exactly the reported message, which studio-core surfaces verbatim in its UI.

**Why it shipped:** TASK-419 item 4 asserted "Console pstudio screen keeps working unchanged" but validated only the `/status` probe; the Frame 19 e2e spec (`pstudio.spec.ts`) asserts the iframe `src` and never drives a query round-trip. The fragment-token mechanism has **no working consumer**: ui-playground bundles Studio directly (own token store), and the console cannot supply a fragment token by design.

**Secondary defect (same surface):** the gateway marks the shell `Cache-Control: no-store` (TASK-336 OB-11), but the console proxy's response-header allowlist (`content-type`, `etag`) drops it, silently voiding that posture on the only supported access path.

## Implementation Plan (TDD)

1. **RED** — `apps/api/src/modules/pstudio/__tests__/pstudio.controller.test.ts`: served HTML must configure the studio BFF client with the **same path that served the shell** (`window.location.pathname`), must NOT embed a Host-derived absolute endpoint, must NOT reference a `#token` fragment.
2. **GREEN** — `pstudio.html.ts`: BFF client `url: window.location.pathname` (same-origin POST → session cookie → console proxy injects JWT → gateway). Remove `readAndScrubToken()` + missing-token banner + `customHeaders`. `getStudioHtml()` loses its parameter; `serveStudio` drops the Host/X-Forwarded-Proto computation (also removes a header-trust surface).
3. **RED→GREEN** — `apps/admin-console/src/server/__tests__/hope-proxy.test.ts` + `hope-proxy.ts`: forward `cache-control` in the response allowlist so `no-store` survives the proxy.
4. **E2E** — `apps/admin-console/tests/e2e/pstudio.spec.ts`: authed in-page `POST /api/hope/admin/pstudio` with a studio query (`{ query: { sql: 'select 1 as ok', parameters: [] } }`) must return 200 and a `[null, rows]` tuple (regression for this bug, CDN-independent).
5. **Verify** — unit tests, `pnpm build:api`, console tests, lint, e2e; manual reload of `/pstudio`.

Fix option chosen: same-origin relative endpoint (cookie-authenticated through the proxy) over minting fragment tokens — zero tokens in the browser, aligned with rule 13 BFF posture ("tokens never client-readable", "never put JWTs in URLs"). Direct gateway access remains possible for header-injecting clients (they authenticate GET and POST alike); enablement + `manage:PrismaStudio` gates are untouched.

## Implementation Summary

The served studio shell now posts its queries back to the **same path it was served from** (`window.location.pathname`). The same-origin POST carries the console session cookie, the BFF proxy injects the operator's bearer server-side (identically to the GET that served the shell), and `UnifiedAuthGuard` passes. No token ever reaches the browser; the unsatisfiable `#token=` fragment hand-off and the Host-derived absolute endpoint (an X-Forwarded-Proto/Host trust surface) are removed. Enablement (`ENABLE_PRISMA_STUDIO`), the `manage:PrismaStudio` guard, per-query audit logging, and the `defaultSchema: 'core'` override are all unchanged.

### Files changed

| File | Change |
|---|---|
| `apps/api/src/modules/pstudio/pstudio.html.ts` | Shell BFF client `url: window.location.pathname`; removed `readAndScrubToken()`, missing-token banner, `customHeaders`, and the `studioEndpointUrl` parameter |
| `apps/api/src/modules/pstudio/pstudio.controller.ts` | `serveStudio(@Res())` only — dropped the `x-forwarded-proto`/Host endpoint computation |
| `apps/api/src/modules/pstudio/__tests__/pstudio.html.test.ts` | Retuned to the TASK-421 contract (posts to serving path; no credential/fragment plumbing; arity 0; BR-02 kept) |
| `apps/api/src/modules/pstudio/__tests__/pstudio.controller.test.ts` | OB-11 block merged with new TASK-421 assertions (no `Authorization`/`Bearer`/`#token`, no absolute BFF URL, `window.location.pathname` present, no-store kept) |
| `apps/api/src/__tests__/controller-route-renames.test.ts` | Two stale W5.2 guards asserting the `studioEndpointUrl` construction replaced by "constructs no Host-derived endpoint at all" |
| `apps/admin-console/src/server/hope-proxy.ts` | `cache-control` added to the response-header allowlist (gateway `no-store` was silently dropped) |
| `apps/admin-console/src/server/__tests__/hope-proxy.test.ts` | New test: gateway `Cache-Control` forwarded to the browser |
| `apps/admin-console/tests/e2e/pstudio.spec.ts` | New regression test: in-page shell GET (200, `text/html`, `no-store`) + studio query POST (`select 1 as ok` → 200, `[null, [{ ok: 1 }]]`) through the session-guarded proxy |

No console screen changes (iframe `src` stays `/api/hope/admin/pstudio`), no DB/domain/applications changes, no migrations, no API route changes.

### Verification evidence (2026-07-05)

| Check | Result |
|---|---|
| TDD RED | New shell-contract test failed against the old HTML (`expected … not to contain "admin.example.test"`); proxy cache-control test failed (`expected null to be 'no-store'`) |
| `pnpm vitest run src/modules/pstudio src/__tests__/controller-route-renames.test.ts` (apps/api) | 4 files, 74 tests passed |
| `pnpm --filter @arcaai/api test` (full suite) | 117 files passed, 2 skipped — 1989 tests passed, 4 skipped |
| `pnpm --filter @arcaai/admin-console test` (vitest) | 75 files, 503 tests passed |
| `pnpm exec playwright test pstudio.spec.ts` (live stack) | 4 passed (incl. new "executes a studio query through the session-guarded proxy"); an earlier run tripped the `auth.login` throttle (5/min) — reran after cooldown |
| `pnpm build:api` | 8 tasks successful |
| ESLint (`apps/api` pstudio module, `apps/admin-console` src) | 0 errors, 0 warnings |
| Manual browser pass | `/pstudio` renders the embedded studio with the `core`-schema table list and row data; gateway log shows `GET /api/v1/admin/pstudio → 200` followed by `POST /api/v1/admin/pstudio → 200` (previously `WARN [UnifiedAuthGuard] … no_valid_credentials` ×4) |

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket created; root cause confirmed from gateway auth logs + code trace (fragment-token shell incompatible with BFF cookie session; POSTs bypass proxy with empty bearer). |
| 2026-07-05 | Fix landed (shell posts to serving path; proxy forwards `cache-control`); unit + e2e regression coverage added; verified in-browser. Status → Completed. |
