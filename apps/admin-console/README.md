# @arcaai/admin-console

**Owner**: Platform / Console · **Introduced**: TASK-415 · **Last verified**: 2026-07-21

HOPE administration console — Next.js 16 (App Router, Turbopack) BFF in front of the API gateway. Built under TASK-415 (scaffold + foundation, tier 10–29 and tier 30–49 screens) and extended by the TASK-532 **governance-console IA** into the AI/governance surfaces (AI services, AI operations, agentic policy, tools & MCP, database studio, agents governance, per-tenant AI/harness/TTS configuration) plus the tier 50–59 playground. The nav map (`src/shared/navigation/nav-config.ts`) is the authoritative route inventory: 43 routes across four tiers (10–19 Platform · 20–29 Administration · 30–49 Tenant · 50–59 Playground), each design-matched to the approved Figma batches per `docs/archive/TASK-415-Hope-Admin-Console/capabilities-matrix.md`.

Follows `.claude/rules/13-nextjs-apps.md`: BFF-mandatory auth (tokens never client-readable), `@arcaai/ui` primitives with semantic tokens only, `proxy.ts` (not `middleware.ts`), TanStack Query for server state.

## Commands

| Command | Effect |
|---|---|
| `pnpm dev` (root: `pnpm admin:dev`) | Dev server on port 5176 |
| `pnpm build` / `pnpm start` | Production build (standalone) / serve on port 3000 |
| `pnpm test` / `pnpm test:watch` | Vitest (node project for `*.test.ts`, happy-dom for `*.test.tsx`) |
| `pnpm test:e2e` | Playwright smoke + axe a11y (`tests/e2e/`); requires the dev server (`pnpm dev`) and API :8868 running — specs skip with instructions otherwise. `ADMIN_CONSOLE_URL`/`E2E_ADMIN_USERNAME`/`E2E_ADMIN_PASSWORD` override the defaults (seeded `super_admin`) |
| `pnpm lint` / `pnpm typecheck` | ESLint (0 warnings) / `tsc --noEmit` |

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
- `src/app/(console)/(global)` / `(shared)` / `(tenant)` — route groups mirroring the capability tiers (rule 13): the global group's layout 404s non-elevated sessions (404-over-403); shared screens work cross-tenant (elevated + working tenant via `X-Tenant-Id`) and tenant-scoped alike; the tenant group (tier 30–49) admits `TENANT_ADMIN` + elevated sessions only (404 otherwise) — elevated users without a working tenant get the `src/shared/tenant-scope/` `WorkingTenantGate` empty state instead of doomed 400s, except `/consultations` which renders the cross-tenant new/revisit aggregate (matrix row 33 exception). A `(global)` screen may itself wrap `WorkingTenantGate` when it is a global-admin-only view over per-tenant data (tier = who may open it; the gate = which tenant's rows it reads) — e.g. `/ai-operations/runs`, `/ai-operations/metrics`, and the `/ai-services` Instructions tab. **Tier 50–59 (playground)** has no route group of its own: the five screens nest under `(tenant)/playground/*` and are gated at the nav level by a role check (`nav-config.ts`, `required: []`), not by a group layout.
- `src/shared/navigation/nav-config.ts` — the authoritative 43-route governance-console map (TASK-415 base + TASK-532 IA) across the four tiers; the sidebar renders implemented entries the caller's ability grants. TASK-532 added the global AI/governance screens (`/ai-services`, `/ai-operations/runs` + `/ai-operations/metrics`, `/agentic-policy`, `/ai-task-defaults`, `/tools-mcp`, `/schedulers`, `/db-studio`), the tenant AI-config surfaces (`/ai-configuration`, `/ai-model-defaults`, `/identity-providers`, `/tts-config`, `/harness/*` — policy, observability, workflows, pipeline-policy), and folded prompt authoring into the `/agents` **Governance tab** (prompt approval, versions, diffs — elevated only). **One-release redirects** preserve retired routes: `/prompt-studio` → `/agents?tab=governance` and `/pstudio` → `/db-studio` (each deleted the release after the one that ships the fold; see the `redirect()` pages).
- `src/shared/` shell & primitives — topbar breadcrumbs (zustand store for detail-page trailing labels), ⌘K command palette, working-tenant + impersonation banners, the standardized `ScreenTemplate` page frame (pinned header/stats/toolbar/tabs, scroll/fill content, `StatusFooter`; `src/shared/page` + TASK-427), the standardized `AdminDataGrid`/`VirtualizedDataGrid` data grid (per-user server-persisted columns, typed filters, offset/cursor pagination; see `src/shared/data` + TASK-423) with the retained `FilterBar`, loading/empty/error states, confirm + break-glass step-up dialogs, OCC drift alert, formatters.
- `src/features/<domain>/components/` — the screens themselves (frames 10–40): server-component pages with `"use client"` leaves, composition over the domain hooks, per-segment `loading.tsx` skeletons, nuqs URL state for filters/tabs/pagination.
- `src/shared/api/` — client HTTP core for the typed data layer: `request()` through the BFF proxy, `Paginated`/`CursorPaginated` envelopes, `GatewayError` (401 / 404-over-403 / 412 drift / 428 missing-precondition), ETag capture + `versionFromEtag()` for the If-Match **and** body-`expectedVersion` OCC contract, FormData uploads, `getBlob()` exports.
- `src/features/<domain>/api/` — typed endpoint clients + TanStack Query v5 hooks + query-key factories per capability domain, ~40 domains across all tiers: `platform`, `monitoring`, `tenants`, `entitlements`, `storage` (admin plane), `ai-models`, `ai-services`, `ai-operations-runs`, `ai-operations-metrics`, `ai-task-defaults`, `agentic-policy`, `tools-mcp`, `rate-limits`, `queues`, `schedulers`, `audit-logs`, `db-studio`, `users`, `rbac`, `api-keys`, `settings`, `account`, `tenant-profile` (tiers 10–29) + `departments`, `storage-browser` (tenant data plane `/storage/*`), `agents` (prompt templates + governance), `dna-writing-styles`, `audio-pipelines`, `transcription-jobs`, `harness-policy`, `harness-ops`, `pipeline-policy`, `identity-providers`, `tenant-tts-config`, `consultations`, `consultation-review` (tier 30–49) + the `playground-*` domains (tier 50–59). Convention per domain: `types.ts` (wire DTOs), `client.ts` (endpoint functions), `keys.ts` (key factory rooted at `[domain]`), `hooks.ts` (`'use client'` queries/mutations; mutations invalidate the domain root), tests in `__tests__/`. Envelope deviations are encoded where the gateway deviates (ai-models `{data,total,totalPages}`, queue jobs + harness surfaces `{items,total}`, RBAC `{data,total,page,pageSize}`, consultations/DNA/prompts `{data,count,page,limit}`). Impersonation calls the BFF's own `/api/auth/impersonate` (never the proxy) so the act-as token lands in the session.
- `src/shared/streams/` — `useEventStream`, the SSE hook for gateway streams: mints a single-use ticket through the BFF (`POST /api/auth/stream-ticket`, scope `<namespace>:<resourceId>`), opens an `EventSource` directly against `NEXT_PUBLIC_API_HOST` (`?ticket=` — JWTs never in URLs per rule 13), forwards named events, and reconnects with a fresh ticket + exponential backoff. Consumers: DNA generate progress, transcription-job stream panel. Both gateway routes declare `@StreamScope` (TASK-419), so SSE is the primary transport; the consuming screens keep a status poll strictly as the documented error fallback once a stream exhausts its retry budget.
- `src/config/` — zod-validated env.
- `tests/e2e/` — Playwright specs: one per screen plus `auth-smoke`/`login-a11y` (36 spec files total), each with axe scans (`@axe-core/playwright`, 0 WCAG 2.2 AA violations, light + dark). Helpers: `helpers/stack.ts` probes app/API availability so specs skip cleanly when the stack is down; `helpers/auth.ts` (`loginAsAdmin`, `selectWorkingTenant`); `helpers/a11y.ts` (shared axe gate; freezes CSS transitions before scanning). The harness screens additionally expect the harness service on :8866 (`pnpm harness:dev`) for live data — they settle on error states without it.

Streams (SSE/WS) do NOT traverse the BFF: mint a ticket via `POST /api/auth/stream-ticket`, then connect the browser directly to `NEXT_PUBLIC_API_HOST`.

## Deployment

`Dockerfile` (multi-stage pnpm + turbo build, `next build` standalone output, node:22-alpine, non-root `console` user, port 3000, `/login` healthcheck; `NEXT_PUBLIC_API_HOST` is a build arg — it is inlined into the client bundle at image build time). k3s: `deployment/k3s/base/admin-console.yaml` (Deployment + Service nodePort 30081 + Ingress `admin.hope.local`; dev overlay host `admin-dev.hope.local`), env from `hope-config` (`API_URL`, `NEXT_PUBLIC_API_HOST`) and `hope-secrets` (`ADMIN_SESSION_SECRET`). CI: `build-admin-console` in `.gitlab/ci/build.yml`.
