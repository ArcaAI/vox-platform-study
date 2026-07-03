# TASK-410 — Closeout: Prettier Hygiene + Consolidated Program Verification

| | |
|---|---|
| **Ticket** | TASK-410 |
| **Type** | Infrastructure / Hygiene / Verification |
| **Created** | 2026-07-03 |
| **Updated** | 2026-07-03 |
| **Status** | Completed |
| **Owner** | Closeout worker (solo) |
| **Source** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` items **P2-3** + **P2-4**, plus the TASK-386→409 program-wide consolidated verification gate |

## 1. Requirement Analysis

Three work streams, executed as the closeout of the TASK-386→409 program (all of which sits uncommitted on this tree):

1. **P2-3 — `apps/admin` Prettier one-shot.** Run the repo prettier config (`.prettierrc.js` → `@arcaai/config-eslint/prettier-base`, `tabWidth: 2`) across `apps/admin` only. Formatting-only; `react-hooks/exhaustive-deps` warnings are intentionally NOT auto-fixed (dependency-array changes alter behavior). Gate: `type-check` + `build` + full admin unit suite green; report before/after ESLint warning counts.
2. **P2-4 — TASK-372 deferred hygiene** (from TASK-372 §4.5 deviations + backlog): `.js` dynamic-import specifiers (+ casts), the pdf-worker `@ts-expect-error`, the 4 off-barrel component names, the 2 `@deprecated` components (remove only with grep-proof of zero usages), and the D10 wording fix.
3. **Consolidated verification** — full unit suites (domains, applications, vox SDK, ui, api, admin), builds (SDK, admin, api with stop→build→restart→health protocol), the deferred TASK-406 E2E (after the TASK-376 upsert-only media seed), the full API E2E suite, and the full admin FE E2E suite across configured viewports.

**Constraints:** no commits/pushes; no DELETE/DROP/TRUNCATE/db-reset; no feature/schema changes; no `docs/qa/**` edits. End state: `:8868` healthy, entitlements enforcement OFF, rate limiting OFF, `:5174` serving.

## 2. Current State Evaluation

- `:8868` serving (built `apps/api/dist/main` via `dev:api:test`, `.env.test`), `:5174` = admin Vite dev server, `hope-*-test` containers healthy.
- `apps/admin` lints via legacy config (`.eslintrc.cjs`, `ESLINT_USE_FLAT_CONFIG=false`); warnings dominated by `prettier/prettier` (4-space code vs 2-space repo config) + `react-hooks/exhaustive-deps`.
- TASK-372 deviations live in `packages/ui`: `pdf-renderer.tsx` / `transcript-segment.tsx` (`.js` lazy-import specifiers + casts), `timeline/renderers/pdf-document.tsx` (`@ts-expect-error` on the worker `import.meta.url` line), root barrel omissions (shared `StatusBadge`, `TranscriptSegment`/`TranscriptWord` components, `TimelineItem`), deprecated tool-ui `DataTable` + `custom/TranscriptViewer`.
- D10 wording: reconciled 2026-07-01 per TASK-372 Change History (to re-verify by grep).

## 3. Implementation Plan

1. Baseline admin ESLint JSON report (count errors/warnings by rule).
2. `prettier --write` over `apps/admin` (repo config); then lint (after-counts), `type-check`, `build`, unit suite.
3. P2-4, each item: attempt → verify (`@arcaai/ui` build incl. dts, consumer type-checks) → keep or revert + document.
4. Consolidated verification matrix (units → builds → seed → deferred E2E → full API E2E → full FE E2E), restart-only recovery for test containers, single retry in isolation for suspected contention flakes.
5. Record results here; restore end-state stack.

## 4. Implementation Summary

### 4.1 P2-3 — `apps/admin` Prettier one-shot ✅

- **Command**: `pnpm exec prettier --write "src/**/*.{ts,tsx}" "e2e/**/*.ts" "*.ts"` from `apps/admin` (repo config: `.prettierrc.js` → `@arcaai/config-eslint/prettier-base`, `tabWidth: 2`). **253 files reformatted.** `routeTree.gen.ts` (generated, "do NOT format" header) was re-generated via `pnpm --filter @arcaai/admin generate-routes` to restore generator-controlled formatting.
- **ESLint before**: 211 files scanned — **16,804 warnings** (16,754 `prettier/prettier`, 43 `react-hooks/exhaustive-deps`, 7 `@typescript-eslint/no-unused-vars`) + 34 pre-existing parsing errors (e2e specs + `playwright.config.ts` outside the tsconfig project — unrelated to formatting).
- **ESLint after**: **50 warnings** (0 `prettier/prettier`, 43 `exhaustive-deps` — intentionally NOT auto-fixed per scope, 7 `no-unused-vars`); same 34 pre-existing parsing errors.
- **Gates**: `type-check` ✅ · `build` ✅ (8.83s) · admin unit suite **403 passed / 52 files** ✅ · `:5174` still serving ✅.

### 4.2 P2-4 — TASK-372 deferred hygiene

| Item | Outcome |
|---|---|
| `.js` dynamic-import specifiers + `as unknown as` casts (`pdf-renderer.tsx`, `transcript-segment.tsx`) | **Kept (proven still required)** — removal attempts fail `check-types`: TS2835 (NodeNext requires explicit extension) + TS2322 (CJS interop wraps namespace, `default` not inferred). Comments updated to record the tsc 5.9 re-verification. |
| `@ts-expect-error` pdf-worker (`pdf-document.tsx`) | **Kept (proven still required)** — removal fails with TS1470 (`import.meta` not allowed in CJS dts output). Comment updated. |
| Off-barrel component names | **`StatusBadge` promoted to root barrel** (`StatusBadge`, `StatusBadgeProps`, `StatusColorRole`) — collision freed by DataTable removal. `TranscriptSegment`/`TranscriptWord` (collide with `use-transcript-viewer` type exports) and `TimelineItem` (collides with diceui `TimelineItem`) stay off-barrel, documented. |
| `@deprecated` `custom/TranscriptViewer` | **Removed** — grep across `apps/` + `packages/` proved zero external consumers. Deleted component + test + fixtures + story + root-barrel export. |
| `@deprecated` `tool-ui/DataTable` | **Removed** — same proof standard. Deleted entire `registries/tool-ui/data-table/` folder (component, formatters, schema, types, utils, adapter) + test + story + `tool-ui/index.ts` export. |
| D10 wording fix | **Already done** — reconciled 2026-07-01 per TASK-372 Change History; grep confirms no stale phrasing. |

**Gates**: `@arcaai/ui` build ✅ · ui unit suite **564 passed / 235 files** ✅ · `check-types` = 34 pre-existing errors, none in touched files · scoped lint clean · admin `type-check` + `build` re-verified ✅. TASK-372 README updated with change-history entry.

### 4.3 Consolidated verification matrix

| Suite / Gate | Result |
|---|---|
| `@arcaai/domains` units | ✅ 1288 passed, 2 skipped (103 files) |
| `@arcaai/applications` units | ✅ 5788 passed, 4 skipped (268 files) |
| SDK `@arcaai/vox` units | ✅ 3494 passed (196 files) |
| `@arcaai/ui` units | ✅ 564 passed (235 files) |
| `apps/api` units | ✅ 1931 passed, 4 skipped (112 files) |
| `apps/admin` units | ✅ 403 passed (52 files) |
| SDK dist build (`pnpm build:sdk`) | ✅ 6 tasks successful |
| Admin build | ✅ |
| API build (stop `dev:api:test` → `pnpm build:api` → restart → poll health) | ✅ 8 tasks successful; `:8868/api/v1/health` → 200 |
| TASK-376 media seed (upsert-only) | ✅ |
| Deferred TASK-406 E2E (`task-406-backend-residuals` + `task-375-admin-features`, live) | ✅ 17 passed |
| Full API E2E (`apps/api/tests/e2e/`, live) | **514 passed, 17 skipped, 4 failed** — all 4 diagnosed pre-existing (below) |
| Full admin FE E2E (`apps/admin/e2e/`, all viewports, `SKIP_DB_PRECHECK=true`) | **357 passed, 20 skipped, 4 failed** — all 4 diagnosed pre-existing (below) |

### 4.4 E2E failure diagnoses (all pre-existing, none attributable to closeout)

> **2026-07-03 follow-up:** the three spec defects below (items 1, 2, 4) were fixed **test-side only** — see the Change History entry of the same date. Items 3 and 5 remain known contention flakes (pass in isolation).

1. **`auth-advanced.spec.ts` — "Super admin impersonation of super admin"** (API): expects `Cannot impersonate a super administrator`, receives `You cannot impersonate yourself` (status 400 as expected). TASK-401's new self-impersonation guard fires before the super-admin target check, and the seed has only one super admin so the spec impersonates itself. Test-design defect from TASK-401.
2. **`task-380-tenant-dashboard.spec.ts` TD2/TD5** (API): expects 403 for `tenant_admin` on `/monitoring/sessions` + `/health/services`, receives 200. TASK-386 intentionally granted `TENANT_ADMIN` the `read:TenantTelemetry` policy (confirmed in DB seed). Stale spec — spec drift, not a regression.
3. **`authorization.spec.ts` — cache behavior** (API): failed in full run, **passed in isolation retry** → contention flake.
4. **`task-400-password-reset.spec.ts`** (FE, desktop+tablet+mobile): fixture creates a throwaway user with `password: 'x'`; TASK-402 now enforces the strict password policy on `POST /admin/users` (400: min 12 chars, upper, digit, special). Cross-ticket spec defect from TASK-402.
5. **`task-380-tenant-dashboard.spec.ts`** (FE, mobile only): failed in full run, **passed in isolation retry** → known contention flake.

### 4.5 End state (verified)

- `:8868/api/v1/health` → **HTTP 200**; `:5174` → **HTTP 200** (serving rebuilt app).
- **Entitlements enforcement OFF** — every `entitlements.enabled` row = `false`.
- **Rate limiting OFF** — effective policy `enabled: false`; the seeded platform row was already `false`, and two stray `rate-limit.enabled=true` rows (created by earlier E2E runs, shadowed duplicates) were PATCHed to `false` via `PATCH /api/v1/admin/settings/:id` (no deletes).
- `hope-{postgres,redis,minio,qdrant}-test` containers all healthy; no data resets performed; no commits/pushes made.

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-07-03 | Ticket created; execution started (P2-3 baseline lint capture kicked off). | `README.md` |
| 2026-07-03 | P2-3 + P2-4 executed; consolidated verification completed; end state restored (rate-limit OFF, entitlements OFF). Status → Completed. | `apps/admin/**` (formatting), `packages/ui/src/index.ts`, `packages/ui/src/components/registries/tool-ui/index.ts`, deleted `custom/transcript-viewer.*` + `tool-ui/data-table/**` (+tests/stories/fixtures), comment updates in `pdf-renderer.tsx`/`pdf-document.tsx`/`transcript-segment.tsx`, `docs/implementation/TASK-372-Shared-Component-System/README.md` |
| 2026-07-03 | **Test-debt fix (test-side ONLY, zero product-code changes)** — resolved the 3 pre-existing spec defects diagnosed in §4.4: **(1)** `auth-advanced.spec.ts` "impersonate another super admin" now creates a throwaway user, grants it the seeded `SUPER_ADMIN` role, asserts the 400 `Cannot impersonate a super administrator` target rejection (original intent), then removes the grant + soft-deletes the user via the API (the old form targeted the caller itself, so TASK-401's earlier self-guard fired). **(2)** `task-380-tenant-dashboard.spec.ts` TD2/TD5 updated to the TASK-386 (#21) contract: tenant_admin (own tenant, `read:TenantTelemetry`) → **200** on `/monitoring/sessions` + `/health/services` with shape assertions; doctor 403 kept on TD2 and added on TD5; TD7 cross-tenant isolation (403) unchanged. **(3)** FE `task-400-password-reset.spec.ts` fixture password `'x'` → policy-compliant `INITIAL_PW` (12+, U/l/d/special; distinct from `STRONG_PW`), flow assertions untouched. **Live re-run evidence:** API `auth-advanced` + `task-380-tenant-dashboard` + `task-401-impersonation` (collateral check) → **43 passed** (15.5s, `SKIP_DB_PRECHECK=true`, non-destructive); FE `task-400` all 3 viewports → **12 passed**; FE `task-401` → 19/20 passed in the shared run with 1 desktop contention flake that **passed in isolation** (3/3, matching the §4.4 flake pattern). Cleanup verified via API (0 `authadv_sa2*` users; role-assignment soft-delete audit row present). End state re-verified: `:8868` health 200, `:5174` 200, `entitlements.enabled=false`, `rate-limit.enabled=false`. | `apps/api/tests/e2e/auth-advanced.spec.ts`, `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts`, `apps/admin/e2e/task-400-password-reset.spec.ts`, `README.md` |
