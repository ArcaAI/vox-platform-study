# admin-console — HOPE administration console (Next.js BFF)

`@arcaai/admin-console`, package name `@arcaai/admin-console`. Next.js 16 App Router app
(Turbopack) that fronts the API gateway as a BFF: it terminates the session, proxies data calls
through `/api/hope/[...path]`, and renders the super-admin / tenant-admin / playground surfaces.
Dev server on port 5176; the production server (`next start`) listens on port 3000. Follows
`.claude/rules/13-nextjs-apps.md`.

## Layout

| Path | What it holds |
|---|---|
| `src/app/(console)/(global)`, `(shared)`, `(tenant)`, `playground` | Route groups mirroring the capability tiers (10-19, 20-29, 30-49, 50-59); each non-playground group has its own tier-guard `layout.tsx` |
| `src/server/` | Server-only BFF modules: `session.ts` (encrypted session cookie), `hope-proxy.ts` (the proxy core), `refresh.ts` (single-flight token rotation), `gateway.ts`, `safe-user.ts`, `api-docs/` |
| `src/app/api/auth/*` | Route handlers: `login`, `logout`, `session`, `refresh`, `register`, `forgot-password`, `reset-password`, `sso`, `working-tenant`, `stream-ticket`, `impersonate`, `revoke-impersonation` |
| `src/app/api/hope/[...path]/route.ts` | The catch-all BFF proxy to `${API_URL}/api/v1/<path>` |
| `src/proxy.ts` | The Next 16 request proxy (replaces the old `middleware.ts`) — session-cookie presence gate only |
| `src/shared/navigation/nav-config.ts` | The authoritative route inventory: 58 entries in `NAV_ENTRIES` + 3 in `USER_MENU_ENTRIES` across the four tiers |
| `src/shared/auth/` | `useSession`/`usePermissions` hooks, CASL-mirror `can`/`canAny`/`isElevated`, `<RequirePermission>` |
| `src/shared/api/` | The typed HTTP client core: `request()` through the BFF proxy, `Paginated`/`CursorPaginated` envelopes, `GatewayError`, ETag/`versionFromEtag()` OCC plumbing |
| `src/shared/streams/` | `useEventStream` — SSE client that mints a single-use ticket via the BFF then connects directly to the gateway |
| `src/shared/page/`, `src/shared/data/` | `ScreenTemplate` (the standard page frame) and `AdminDataGrid`/`VirtualizedDataGrid` (the standard data grid) |
| `src/features/<domain>/` | 56 feature-domain directories (components/api/hooks per capability); features never import each other |
| `src/config/` | zod-validated env access |
| `tests/e2e/` | Playwright specs — 54 `.spec.ts` files, one per screen plus auth/a11y smoke, each running an axe scan |

## Commands

| Command | Effect |
|---|---|
| `pnpm admin:dev` (in-package: `pnpm dev`) | `next dev -p 5176` |
| `pnpm admin:build` | `next build` (standalone output) |
| `pnpm admin:start` (in-package: `pnpm start`) | `next start -p 3000` |
| `pnpm admin:test` / `admin:test:watch` / `admin:test:cov` | Vitest |
| `pnpm admin:test:e2e` | Playwright specs in `tests/e2e/` — needs the dev server and API gateway (:8868) running; specs skip with instructions otherwise |
| `pnpm admin:lint` / `admin:lint:fix` | ESLint, `--max-warnings 0` |
| `pnpm admin:typecheck` | `tsc --noEmit` |
| `pnpm admin:format` / `admin:format:check` | Prettier over `apps/admin-console/src/**/*.{ts,tsx}` |
| `pnpm admin:clean` | Remove `.next` and the TS build-info cache |

## Environment

Development loads the monorepo-root `.env.dev` (host env wins); CI/production use host env only.

| Variable | Purpose |
|---|---|
| `API_URL` | Gateway origin the BFF proxies to (default `http://localhost:8868`) |
| `ADMIN_SESSION_SECRET` | Session-cookie encryption secret |
| `NEXT_PUBLIC_API_HOST` | Gateway origin the browser connects to directly for SSE streams |

## How it works

**Auth is BFF-mandatory.** Tokens never reach a client-readable store. `src/server/session.ts`
seals the gateway JWT + refresh token into an encrypted httpOnly cookie; `src/proxy.ts` (the
Next 16 replacement for `middleware.ts`) checks only for the cookie's presence and redirects to
`/login?from=...` for pages or answers 401 for API routes. `hope-proxy.ts` attaches the bearer
token (the impersonation token while impersonating) and `X-Tenant-Id` for elevated users with a
working tenant, passes `If-Match`/`ETag` through untouched, and recovers a stale access token with
one single-flight refresh + retry.

**Tier guards 404, never 403.** `(global)/layout.tsx` and `(tenant)/layout.tsx` each call
`notFound()` for a session that does not meet the tier's role requirement, judged on the
*effective* identity (the impersonated target while impersonating) — matching the gateway's
404-over-403 posture rather than exposing a 403 that would confirm a route exists.
`(shared)` screens render for both elevated and tenant-scoped sessions. Playground (tier 50-59)
has no route group of its own: its five screens nest under `(tenant)/playground/*` and are gated
at the nav layer by an empty `required: []` ability list, not by a group layout.

**Streams bypass the BFF.** SSE/WS connections never proxy through `/api/hope/*`: the client
mints a single-use ticket via `POST /api/auth/stream-ticket` (scope `<namespace>:<resourceId>`)
and then opens the stream directly against `NEXT_PUBLIC_API_HOST` — a gateway JWT never appears
in a URL.

**Data layer.** Each `src/features/<domain>/api/` directory follows the same convention:
`types.ts` (wire DTOs), `client.ts` (endpoint functions calling the BFF proxy), `keys.ts`
(TanStack Query key factory rooted at `[domain]`), `hooks.ts` (`'use client'` queries/mutations).
Server state is TanStack Query only — no data fetching in `useEffect`.

**Styling and components.** `@arcaai/ui` primitives with semantic tokens only; `transpilePackages:
['@arcaai/ui']` and `output: 'standalone'` are both set in `next.config.ts` because the package
ships raw TSX through its `./*` export (see `.claude/rules/13-nextjs-apps.md`).

## Gotchas

- `next.config.ts` force-includes `@swc/helpers/**` via `outputFileTracingIncludes` — Next's
  static tracer cannot follow the wildcard subpath export those helpers load through, and without
  the override the standalone build boots and immediately crashes on a missing
  `@swc/helpers/esm/_interop_require_default.js`. Do not narrow that glob to the whole `.pnpm`
  entry — that pulls in a sibling `tslib` symlink Turbopack cannot read as a file and fails the
  build outright.
- `proxyClientMaxBodySize: '1gb'` in `next.config.ts` is deliberately matched to the gateway's own
  upload ceiling. Next's default body-buffering limit for a proxied request is 10 MB; past that it
  silently forwards only the first 10 MB rather than failing, which corrupts a large multipart
  upload's closing boundary. Do not lower this without checking the gateway's own ceiling first.
- Deployment is NOT `deployment/k3s/` in this repository — that tree was deleted. The
  admin-console's cluster manifests live in the separate `arca/hope-v2-deployment` repository; see
  `.claude/rules/09-infrastructure-devops.md`.
- The original TASK-415 capabilities-matrix ticket doc this app's screens were designed against
  now lives in the archived-tickets area, which is off-limits this sprint; the live, maintained
  route/frame inventory is `docs/architecture/admin-console-capabilities-matrix.md` and
  `src/shared/navigation/nav-config.ts` itself — the nav config, not any ticket doc, is
  authoritative for what routes exist today.

## Related

- `.claude/rules/13-nextjs-apps.md` — Next.js App Router structure, BFF auth, quality gates
- `.claude/rules/07-react-ui.md`, `.claude/rules/10-skeleton-loading.md`, `.claude/rules/11-ux-ui-principles.md` — component/UX standards this app follows
- `.claude/rules/12-design-workflow.md` — the audience-tier taxonomy the route groups mirror
- `docs/architecture/admin-console-capabilities-matrix.md` — the live route/frame inventory
- `apps/api/README.md` — the gateway this app proxies to
