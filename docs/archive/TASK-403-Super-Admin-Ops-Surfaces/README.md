# TASK-403 — Super-Admin Ops Surfaces (Rate Limits · Queues & Jobs · Prisma Studio)

| | |
|---|---|
| **Ticket** | TASK-403 |
| **Type** | feature (frontend surfaces + thin additive backend) |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |
| **Design source** | [`docs/designs/admin/unbuilt-super-admin-surfaces.md`](../../designs/admin/unbuilt-super-admin-surfaces.md) §5.3 (`14 · Rate Limits`, node `167:13055`), §5.4 (`15 · Queues & Jobs`, node `168:13329`), §2 nav contract (`OPERATIONS` tier) |
| **Backlog** | `docs/admin-console-open-items-review.md` §3b — "Rate Limits (14), Queues & Jobs (15), Prisma Studio (16)" |

## 1. Requirement Analysis

Build the three unbuilt super-admin **OPERATIONS** surfaces in `apps/admin` (the design's §2 sidebar contract: `OPERATIONS` → Rate Limits · Queues & Jobs · Prisma Studio), wired to the real backend:

1. **Rate Limits (`/rate-limits`)** — live, DB-backed throttle config (TASK-316/390/392 substrate): global kill-switch, 4 tier baselines (editable), read-only route-overrides effective-state table with `db`/`code`/`default` provenance.
2. **Queues & Jobs (`/queues`)** — BullMQ introspection (TASK-250/336 substrate): Redis-health strip, 15-queue overview with counts + state, per-queue jobs table (status filter + pagination), job detail (stacktrace/opts), **retry-failed** (single + bulk). **No destructive actions** (clean/drain/obliterate/remove/pause rendered disabled with tooltip — see §6 deviations).
3. **Prisma Studio (`/prisma-studio`)** — link-out/status card only. Studio itself remains the dev-only API-served shell (`GET /api/v1/admin/pstudio`, TASK-307/326/336); the card reports availability via a new status probe and opens the shell in a new tab with the bearer passed in the URL fragment (the existing OB-11 flow). **No DB proxying added.**

All three: SUPER_ADMIN-only (`@Authorize(['manage','all'])` posture server-side; `requireSuperAdmin` `beforeLoad` guard + nav-hide client-side), SDK hooks in `@arcaai/vox`, nav entries in `apps/admin/src/lib/nav.ts` (+ one `Components → /components` entry for a sibling worker's route).

### Acceptance criteria

- Super-admin sees the three new nav entries + pages render live data; tenant-admin/doctor: nav hidden, direct URL bounced (FE), API 403 (BE).
- Rate Limits: kill-switch round-trips against `PUT /admin/rate-limit/enabled` (**left OFF at hand-off**); tier edit round-trips; routes table shows effective state + sources.
- Queues: queue listing reflects a real enqueued job; retry transitions a real failed job; Redis health renders.
- Prisma Studio: status endpoint reports enabled/disabled truthfully per environment; card renders both states; link-out only in enabled state.
- Unit + live API E2E + live FE E2E (3 viewports) green; FE type-check + build green; TASK-391 nav-visibility spec still green.

## 2. Current State Evaluation

**The backend substrate already exists — this ticket is FE-led with two thin additive endpoints.**

| Surface | Existing backend (reused, unchanged) | Gap this ticket fills |
|---|---|---|
| Rate Limits | `apps/api/src/modules/admin-rate-limit/` — `GET /admin/rate-limit`, `PUT /admin/rate-limit/enabled`, `PUT /admin/rate-limit/tiers/:tier`, `PUT /admin/rate-limit/routes/:routeId` (`RateLimitAdminService` over `rate-limit.*` GlobalSettings, TASK-316) | none (FE + SDK only) |
| Queues & Jobs | `apps/api/src/modules/queue-admin/` — `GET /admin/queues`, `GET /admin/queues/:q`, jobs list/detail/retry/promote/remove/bulk, pause/resume/clean (TASK-250/336) | `RedisHealthInfo` (in `@arcaai/domains` `queueAdminTypes.ts`) has **no service method/route** → add `GET /admin/queues/health/redis` |
| Prisma Studio | `apps/api/src/modules/pstudio/` — dev-only (`NODE_ENV=development` + `ENABLE_PRISMA_STUDIO=true`) module serving the Studio shell + audited BFF | module is conditionally registered, so its availability is **unobservable** when off → add always-on `GET /admin/pstudio/status` |

Frontend/SDK: no `rate-limit`/`queues`/`pstudio` hooks or admin routes exist. Nav (`lib/nav.ts`) has no OPERATIONS section. Legacy `apps/ui-playground` embeds Studio directly (`studio-page.tsx`) — intentionally **not** replicated (link-out only, per the brief).

## 3. Implementation Plan (TDD)

Layer order: Services → API → SDK → FE. No DB/domain changes (RedisHealthInfo type already exists in domains).

| # | Step | Test first | Then |
|---|---|---|---|
| 1 | `QueueAdminService.getRedisHealth()` | `packages/applications/.../queue-admin/__tests__/queue-admin.service.test.ts` (+ redis-health describe) | impl via BullMQ `queue.client` ping + `INFO` parse; `IQueueAdminService` + barrel |
| 2 | `GET /admin/queues/health/redis` | `apps/api/.../queue-admin/__tests__/queue-admin.controller.test.ts` (+ route + gate) | controller method + `RedisHealthInfoResponse` DTO |
| 3 | `GET /admin/pstudio/status` (always-on) | new `apps/api/.../pstudio/__tests__/pstudio-status.controller.test.ts` | `PrismaStudioStatusController` + module, registered unconditionally; reuses `shouldEnablePrismaStudio` |
| 4 | SDK types/endpoints/hooks (`useRateLimits`, `useQueueAdmin`, `usePrismaStudio`) | new hook tests in `packages/agentic-sdk-v2/src/hooks/__tests__/` | types `types/ops-admin.ts`, `*_ENDPOINTS` in `core/constants.ts`, hooks, `core.ts`/barrels |
| 5 | FE pure logic (`queue-format`, `rate-limit-format`, `studio-url`) | `apps/admin/src/features/{queues,rate-limits,prisma-studio}/__tests__/` | helpers |
| 6 | FE pages + nav | (covered by FE E2E) | `routes/_authenticated/{rate-limits,queues,prisma-studio}.tsx`, feature components, `nav.ts` OPERATIONS + Developer→Components |
| 7 | Rebuild protocol | — | stop `dev:api:test` → `pnpm build:api` → restart → health 200; SDK dist rebuild + `:5174` restart |
| 8 | Live API E2E | `apps/api/tests/e2e/task-403-ops-surfaces.spec.ts` | CASL denial matrix (doctor/tenant-admin/unauth) + happy paths |
| 9 | Live FE E2E | `apps/admin/e2e/task-403-ops-surfaces.spec.ts` (3 viewports) + re-run `task-391-nav-visibility` | non-destructive UI assertions |

E2E happy-path mechanics (non-destructive):
- *Queue listing reflects a real enqueued job* — the synthetic fixture job (below) IS the real enqueued job: after it fails, the `failed`-status jobs listing contains its id and `GET /admin/queues/IngestKnowledgeDocument` shows `counts.failed ≥ 1`.
- *Retry transitions a failed job* — enqueue one synthetic `IngestKnowledgeDocument` job **directly via BullMQ** (test Redis `localhost:6380`) with a missing `tenantId` + `attempts:1`; the processor's fail-closed guard fails it deterministically **before any DB/harness access**; `POST .../retry` then observably re-runs it (`attemptsMade 1→2` polled via job detail). The synthetic job stays in the bounded failed set (`removeOnFail: 200`), never removed (no destructive ops).
- *Rate-limit round-trip* — `PUT enabled:true` → verify (`enabledSource: db`) → `PUT enabled:false` → verify **ends OFF**. Env gate `RATE_LIMIT_ENABLED=false` in `.env.test` keeps the live throttler inert throughout.

## 4. Implementation Summary

_Completed 2026-07-02. All planned steps landed; deviations in §6._

### Backend (2 thin additive endpoints; existing endpoints reused unchanged)

- `GET /api/v1/admin/queues/health/redis` — `QueueAdminService.getRedisHealth()` (BullMQ `queue.client` → `PING` latency + `INFO` parse; `healthy <250ms / degraded ≥250ms / unhealthy on error`, never throws). Gated by the class-level `@Authorize(['manage','all'])`.
- `GET /api/v1/admin/pstudio/status` — new **always-registered** `PrismaStudioStatusModule` (`{ enabled }` from the same `shouldEnablePrismaStudio` env signals), `@Authorize(['manage','all'])`. Truthfully reports `enabled:false` in non-dev environments where the Studio module itself is absent (404).

### SDK (`@arcaai/vox`)

- `types/ops-admin.ts` — `RateLimitPolicy`/tier/route types, `QueueStats`/`JobSummary`/`JobDetail`/`PaginatedJobs`/`RedisHealth`/`BulkJobActionResult`, `PrismaStudioStatus`.
- `core/constants.ts` — `RATE_LIMIT_ADMIN_ENDPOINTS`, `QUEUE_ADMIN_ENDPOINTS`, `PSTUDIO_ENDPOINTS`.
- Hooks: `useRateLimits` (`refresh`/`setEnabled`/`setTier`/`setRoute`), `useQueueAdmin` (`refresh`/`refreshRedisHealth`/`listJobs`/`getJob`/`retryJob`/`bulkRetry` — **destructive ops intentionally absent from the SDK**), `usePrismaStudio` (`refreshStatus`). Exported via `hooks/index.ts`, `types/index.ts`, `core.ts`.

### Frontend (`apps/admin`)

- `features/rate-limits/` — `rate-limit-format.ts` (+tests), `tier-edit-dialog.tsx`; route `routes/_authenticated/rate-limits.tsx` (kill-switch `Switch` + OFF warning banner + 4 tier cards with `db`/`default` provenance + strict "auth-critical" highlight + read-only route-overrides table + TARGET note for live counters).
- `features/queues/` — `queue-format.ts` (+tests: Running/Backlogged/Failing/Paused derivation, depth bar, ms/bytes labels), `jobs-panel.tsx` (jobs table + status filter + pagination + selectable rows + bulk retry + job-detail dialog with stacktrace/opts + per-job retry); route `routes/_authenticated/queues.tsx` (Redis-health strip card + 15-queue table with per-queue depth viz + `Retry failed` + disabled Pause/Clean affordances with tooltips).
- `features/prisma-studio/` — `studio-url.ts` (+tests, fragment-token URL builder); route `routes/_authenticated/prisma-studio.tsx` (status card: Available→"Open Prisma Studio" link-out / Disabled→env explanation; audit + super-admin notes; no embedding).
- All three routes: `beforeLoad: requireSuperAdmin` (TASK-394 `lib/route-guards.ts`).
- `lib/nav.ts` — new **Operations** section (Rate Limits · Queues & Jobs · Prisma Studio, all `requireSuperAdmin`) placed after Platform per the design §2 order, and a **Developer** section with `Components → /components` (sibling worker owns the route file).

### Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/queue-admin/queue-admin.service.ts` | + `getRedisHealth()` |
| `packages/applications/src/services/queue-admin/IQueueAdminService.ts` | + interface method |
| `packages/applications/src/services/queue-admin/__tests__/queue-admin.service.test.ts` | + redis-health unit tests (5) |
| `apps/api/src/modules/queue-admin/queue-admin.controller.ts` | + `GET health/redis` route |
| `apps/api/src/modules/queue-admin/dto/queue-admin.dto.ts` | + `RedisHealthInfoResponse` |
| `apps/api/src/modules/queue-admin/__tests__/queue-admin.controller.test.ts` | + route test |
| `apps/api/src/modules/pstudio/pstudio-status.controller.ts` | new |
| `apps/api/src/modules/pstudio/pstudio-status.module.ts` | new |
| `apps/api/src/modules/pstudio/__tests__/pstudio-status.controller.test.ts` | new (4 tests) |
| `apps/api/src/app.module.ts` | + `PrismaStudioStatusModule` (always-on) |
| `packages/agentic-sdk-v2/src/types/ops-admin.ts` | new |
| `packages/agentic-sdk-v2/src/types/index.ts` | + barrel |
| `packages/agentic-sdk-v2/src/core/constants.ts` | + 3 endpoint groups |
| `packages/agentic-sdk-v2/src/hooks/useRateLimits.ts` | new |
| `packages/agentic-sdk-v2/src/hooks/useQueueAdmin.ts` | new |
| `packages/agentic-sdk-v2/src/hooks/usePrismaStudio.ts` | new |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useRateLimits.test.ts` | new (6 tests) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useQueueAdmin.test.ts` | new (7 tests) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/usePrismaStudio.test.ts` | new (3 tests) |
| `packages/agentic-sdk-v2/src/hooks/index.ts`, `src/core.ts` | + exports |
| `apps/admin/src/features/rate-limits/{rate-limit-format.ts,tier-edit-dialog.tsx,__tests__/rate-limit-format.test.ts}` | new |
| `apps/admin/src/features/queues/{queue-format.ts,jobs-panel.tsx,__tests__/queue-format.test.ts}` | new |
| `apps/admin/src/features/prisma-studio/{studio-url.ts,__tests__/studio-url.test.ts}` | new |
| `apps/admin/src/routes/_authenticated/{rate-limits,queues,prisma-studio}.tsx` | new |
| `apps/admin/src/lib/nav.ts` | + Operations section (3) + Developer→Components |
| `apps/api/tests/e2e/task-403-ops-surfaces.spec.ts` | new live API E2E |
| `apps/admin/e2e/task-403-ops-surfaces.spec.ts` | new live FE E2E |
| `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts` | **fix** — cache populate loop: platform (`__GLOBAL__`-tenant) row now always wins over tenant clones (see §7) |
| `packages/applications/src/services/baseServices/_meta/appSettings/__tests__/appSettings.service.task403.test.ts` | new (4 tests) — pins the deterministic-winner behavior |
| `apps/admin/e2e/fixtures/auth.ts` | **fix** — `doctor` persona now carries `tenantKey: '__GLOBAL__'` (the API rejects non-admin logins without one; the entry was previously unusable — no other spec logs in as doctor) |

### Verification evidence (2026-07-02, actual outputs)

- **Unit (TDD, red→green observed for every new suite)** —
  - applications `queue-admin` + `rate-limit` + `_meta` (incl. appSettings): `26 files passed | 1 skipped · 375 tests passed | 4 skipped`;
  - new `appSettings.service.task403.test.ts` alone: 4 passed (RED first: 1 failed pre-fix, pinning the tenant-clone shadowing);
  - API modules `queue-admin` + `pstudio` + `admin-rate-limit`: `7 files · 39 tests passed`;
  - SDK hook suites (`useRateLimits`/`useQueueAdmin`/`usePrismaStudio`) + endpoint drift-guard: `4 files · 127 tests passed`;
  - admin feature helpers (`queues`/`rate-limits`/`prisma-studio`): `3 files · 18 tests passed`.
- **Builds** — `pnpm build:api` green (turbo 8/8); `@arcaai/vox` dist rebuilt green (turbo 6/6); applications dist rebuilt green (turbo 7/7); admin `tsc -b --force` exit 0 + `turbo build` green (8/8, `vite build` included).
- **Live API E2E** — `pnpm test:e2e -- task-403`: **15/15 passed** against the rebuilt `:8868`. Coverage: denial matrix (401 unauth / 403 tenant_admin / 403 doctor on all 5 read endpoints + 3 mutations), policy shape (4 tiers + `auth.login` route), kill-switch round-trip ends OFF (`enabledSource: db`, independent read-back), strict-tier limit bump→restore (`limitSource: db`), queue listing (≥10 queues, full counts shape), Redis health (`healthy`, real version/uptime, `queuesRegistered ≥ 10`), synthetic failed `IngestKnowledgeDocument` job visible in failed listing + queue counts, retry re-runs it (`attemptsMade 1→2` polled), retry of a nonexistent job → 404, pstudio status `{enabled:false}` + shell genuinely 404 in test env.
- **Live FE E2E** — `task-403-ops-surfaces.spec.ts` across desktop/tablet/mobile: **23 passed | 4 skipped** (the two single-viewport interaction tests — kill-switch UI round-trip, jobs-drawer open — run desktop-only by design). Coverage: nav visibility (super-admin sees Operations ×3 + Components; doctor sees none), `requireSuperAdmin` bounce on direct URLs, Rate Limits render (switch/tier cards/route rows/OFF-warning), kill-switch UI ON→OFF round-trip (ends OFF), Queues render (Redis `healthy` strip, queue rows, Pause/Clean disabled), jobs drawer + PII-redaction caption, Prisma Studio Disabled card without link-out.
- **TASK-391 nav-visibility re-run** — **6/6 passed**, no expectation changes needed (it asserts specific link names, not counts).
- **Hand-off state (verified post-run)** — `:8868` health 200; `:5174` 200; `rate-limit.enabled = false` in the platform GlobalSetting row (psql) + env `RATE_LIMIT_ENABLED=false`; `entitlements.enabled = false` (psql); test containers (`hope-*-test`) healthy.

## 5. Change History

| Date | Change |
|---|---|
| 2026-07-02 | Ticket created; plan per parent brief (design-first, backend-reuse audit). |
| 2026-07-02 | Implemented backend probes, SDK hooks, 3 FE surfaces, nav; all unit + live API/FE E2E green; stack handed off healthy. |
| 2026-07-02 | **Defect found & fixed via the live E2E** (§7): AppSettings cache non-determinism made `PUT /admin/rate-limit/enabled` 404 — platform row now always wins the cache; TDD'd in `appSettings.service.task403.test.ts`. |
| 2026-07-02 | FE E2E fixture fix: `doctor` persona gained the required `tenantKey` (API rejects non-admin logins without one; entry was previously unused/unusable). |

## 6. Deviations from the design doc (flagged per brief)

1. **Queues actions** — design frame `15` (v1) listed Pause/Resume · Clean · per-job Remove/Promote; the v2 rework kept only `Retry failed`. Per the brief ("NO destructive actions"), the FE wires **retry only** (single/bulk); Pause · Clean affordances render **disabled with explanatory tooltips**; Remove/Promote are not rendered. The SDK deliberately omits destructive methods so the console cannot invoke them (server endpoints untouched).
2. **Rate Limits route overrides** — design §5.3 shows a route-override edit state; the brief scopes the FE to a **read-only effective-state display**, so the routes table is read-only (the SDK's `setRoute` mirrors the server for future use). Live "requests-in-window" counters stay TARGET (no backend), marked with a TARGET note as the design requires.
3. **Prisma Studio** — no §5 design spec exists (nav taxonomy only), so the surface follows the brief: a minimal status card + link-out to the existing dev-only API-served shell (OB-11 fragment-token flow), plus the new status probe. No Studio embedding in `apps/admin` (the ui-playground embed pattern was intentionally not replicated).
4. **`SysEvent`/`UserActivity` queues** in the live stack accumulate `waiting` jobs (no worker in the API process) — the queues table truthfully shows non-zero waiting counts; flagged here so operators aren't surprised.
5. **E2E failed-job fixture** — created by direct BullMQ enqueue against the test Redis (no HTTP producer exists for a deterministically-failing job); it remains in the bounded failed set afterwards (constraint: no remove/clean).

## 7. Defect uncovered by the live E2E (fixed here)

**Symptom** — `PUT /api/v1/admin/rate-limit/enabled` returned `404 Resource not found` for a valid super-admin request, while `GET /admin/rate-limit` reported `enabledSource: db` with a value that didn't match the platform row.

**Root cause** — `AppSettingsService.cacheAppSettings()` populated its flat `Map<key>` cache **last-row-wins across ALL tenants**. Tenant provisioning (`TenantService.provisionTenantConfigs`) clones every `__GLOBAL__` setting — including platform-only namespaces like `rate-limit.*` — into each new tenant (the test DB had two TASK-387 E2E tenants carrying `rate-limit.enabled` clones). The TASK-302 P0-5 boot invariant only guards duplicates *within* the platform tenant, so a tenant clone silently shadowed the platform row. `RateLimitAdminService.writeSetting()` then resolved the *clone's* id from the cache, and the tenant-scoped `GlobalSettingService.update()` (CLS pass-through) couldn't see that other tenant's row → repository `404`. Reads misreported for the same reason.

**Fix** (surgical, in the populate loop only): when a key already has the **platform** (`50000000-…` `GLOBAL_TENANT_ID`) row cached, a non-platform row can no longer replace it. Keys that exist only on customer tenants cache exactly as before. Pinned by 4 unit tests (both orderings, tenant-only key, two-clones-no-platform-row last-wins preserved). This also hardens every other platform-namespace consumer of the cache (`entitlements.enabled`, `dna-regen.*`, scheduler settings…) against the same shadowing.
