# @arcaai/admin-console

HOPE administration console — Next.js 16 (App Router, Turbopack) BFF in front of the API gateway. Built under TASK-415 Phase 3 (scaffold + foundation); feature screens are blocked behind the Figma design gate and land per `docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md`.

Follows `.cursor/rules/13-nextjs-apps.mdc`: BFF-mandatory auth (tokens never client-readable), `@arcaai/ui` primitives with semantic tokens only, `proxy.ts` (not `middleware.ts`), TanStack Query for server state.

## Commands

| Command | Effect |
|---|---|
| `pnpm dev` (root: `pnpm dev:admin`) | Dev server on port 5176 |
| `pnpm build` / `pnpm start` | Production build (standalone) / serve on port 3000 |
| `pnpm test` / `pnpm test:watch` | Vitest (node project for `*.test.ts`, happy-dom for `*.test.tsx`) |
| `pnpm test:e2e` | Playwright smoke + axe a11y (`tests/e2e/`); requires the dev server (`pnpm dev`) and API :8868 running — specs skip with instructions otherwise. `ADMIN_CONSOLE_URL`/`E2E_ADMIN_USERNAME`/`E2E_ADMIN_PASSWORD` override the defaults (seeded `super_admin`) |
| `pnpm lint` / `pnpm check-types` | ESLint (0 warnings) / `tsc --noEmit` |

## Environment

Development loads the monorepo-root `.env.dev` (host env wins); CI/production use host env only.

| Variable | Purpose |
|---|---|
| `API_URL` | Gateway origin for the BFF (default `http://localhost:8868`) |
| `ADMIN_SESSION_SECRET` | Session-cookie encryption secret, min 32 chars (AES key derived via SHA-256) |
| `NEXT_PUBLIC_API_HOST` | Gateway origin the browser connects to directly for SSE/WS streams |

## Architecture

- `src/server/` — server-only modules (`session.ts` jose-encrypted `hope_admin_session` cookie, `hope-proxy.ts`, `refresh.ts` single-flight rotation, `gateway.ts`, `safe-user.ts`).
- `src/app/api/auth/*` — login, logout, session, refresh, working-tenant, stream-ticket, impersonate, revoke-impersonation route handlers.
- `src/app/api/hope/[...path]` — catch-all proxy to `${API_URL}/api/v1/<path>`: attaches the bearer (impersonation token when active) and `X-Tenant-Id` (elevated users with a working tenant), passes `If-Match`/`ETag` through, recovers from 401 with one refresh + retry.
- `src/proxy.ts` — Next 16 request proxy: session-cookie presence gate (pages redirect to `/login?from=…`, APIs get 401).
- `src/shared/auth/` — `useSession`/`usePermissions` hooks, CASL-mirror `can`/`canAny`/`isElevated`, `<RequirePermission>`.
- `src/shared/navigation/nav-config.ts` — the full 29-route map from the capabilities matrix (2026-07-04 review) with `implemented` flags; the sidebar renders implemented entries the caller's ability grants.
- `src/shared/api/` — client HTTP core for the typed data layer: `request()` through the BFF proxy, `Paginated`/`CursorPaginated` envelopes, `GatewayError` (401 / 404-over-403 / 412 drift / 428 missing-precondition), ETag capture + `versionFromEtag()` for the If-Match **and** body-`expectedVersion` OCC contract, FormData uploads, `getBlob()` exports.
- `src/features/<domain>/api/` — typed endpoint clients + TanStack Query v5 hooks + query-key factories per capability domain (tiers 10–29, pre-built ahead of the design gate): `platform`, `monitoring`, `tenants`, `entitlements`, `storage`, `ai-models`, `rate-limits`, `queues`, `audit-logs`, `pstudio`, `users`, `rbac`, `api-keys`, `settings`, `account`. Convention per domain: `types.ts` (wire DTOs), `client.ts` (endpoint functions), `keys.ts` (key factory rooted at `[domain]`), `hooks.ts` (`'use client'` queries/mutations; mutations invalidate the domain root), tests in `__tests__/`. Envelope deviations are encoded where the gateway deviates (ai-models `{data,total,totalPages}`, queue jobs `{items,total}`, RBAC `{data,total,page,pageSize}`). Impersonation calls the BFF's own `/api/auth/impersonate` (never the proxy) so the act-as token lands in the session.
- `src/config/` — zod-validated env.
- `tests/e2e/` — Playwright specs (`auth-smoke`, `login-a11y` with `@axe-core/playwright`, helpers in `helpers/stack.ts` that probe app/API availability and skip cleanly).

Streams (SSE/WS) do NOT traverse the BFF: mint a ticket via `POST /api/auth/stream-ticket`, then connect the browser directly to `NEXT_PUBLIC_API_HOST`.

## Deployment

`Dockerfile` (multi-stage pnpm + turbo build, `next build` standalone output, node:22-alpine, non-root `console` user, port 3000, `/login` healthcheck; `NEXT_PUBLIC_API_HOST` is a build arg — it is inlined into the client bundle at image build time). k3s: `deployment/k3s/base/admin-console.yaml` (Deployment + Service nodePort 30081 + Ingress `admin.hope.local`; dev overlay host `admin-dev.hope.local`), env from `hope-config` (`API_URL`, `NEXT_PUBLIC_API_HOST`) and `hope-secrets` (`ADMIN_SESSION_SECRET`). CI: `build-admin-console` in `.gitlab/ci/build.yml`.
