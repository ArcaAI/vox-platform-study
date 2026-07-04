# @arcaai/admin-console

HOPE administration console — Next.js 16 (App Router, Turbopack) BFF in front of the API gateway. Built under TASK-315 Phase 3 (scaffold + foundation); feature screens are blocked behind the Figma design gate and land per `docs/implementation/TASK-315-Hope-Admin-Console/capabilities-matrix.md`.

Follows `.cursor/rules/13-nextjs-apps.mdc`: BFF-mandatory auth (tokens never client-readable), `@arcaai/ui` primitives with semantic tokens only, `proxy.ts` (not `middleware.ts`), TanStack Query for server state.

## Commands

| Command | Effect |
|---|---|
| `pnpm dev` (root: `pnpm dev:admin`) | Dev server on port 5176 |
| `pnpm build` / `pnpm start` | Production build (standalone) / serve on port 3000 |
| `pnpm test` / `pnpm test:watch` | Vitest (node project for `*.test.ts`, happy-dom for `*.test.tsx`) |
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
- `src/shared/navigation/nav-config.ts` — the full 30-route map from the capabilities matrix with `implemented` flags; the sidebar renders implemented entries the caller's ability grants.
- `src/features/` — feature modules (only `auth` so far); `src/config/` — zod-validated env.

Streams (SSE/WS) do NOT traverse the BFF: mint a ticket via `POST /api/auth/stream-ticket`, then connect the browser directly to `NEXT_PUBLIC_API_HOST`.
