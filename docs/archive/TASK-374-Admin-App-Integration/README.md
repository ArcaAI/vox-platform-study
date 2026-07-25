# TASK-374 — `apps/admin` App + `@arcaai/ui` Shared-Component Integration

| | |
|---|---|
| **Ticket** | TASK-374 |
| **Type** | Feature / Frontend Integration |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Status** | **Completed** — full operator surface: app shell + auth **with token auto-refresh**, all screens (Tenants **CRUD**, Users, Roles & Policies **(create+edit, visual CASL rule-builder, role↔policy assignment)**, Departments & Prompts **(+ prompt edit/versioning)**, API Keys, Settings, System Health, **Audit-Log cursor grid (now via SDK `listByCursor`)**, History **with storage-resolved media + full-res zoom** (§4.5/§4.6), Live), **Users server-side sort/filter/search**, and **D8** persistence verified. Build/test/lint green (§5.2); **admin `tsc --noEmit` clean** (Round 5, §4.7); **live full-stack E2E verified** — Playwright **7 passed / 1 skipped** + curl (§5.6). |
| **Owner** | Frontend |
| **Implements** | [TASK-372 §4.8](../TASK-372-Shared-Component-System/README.md) decision **D10** — the real consumer of the gold-standard `@arcaai/ui` components |
| **Design source** | [TASK-371 — Admin Console Redesign](../TASK-371-Admin-Console-Redesign/README.md) (Calm Clinical Teal tokens, app-shell, status patterns) |
| **In-flight siblings (do NOT edit their docs)** | [TASK-373 — Cursor Pagination DTO](../TASK-373-Cursor-Pagination-DTO/README.md) (D7, backend), TASK-372 D8 settings-namespace whitelist |

> This ticket builds the standalone **`apps/admin`** (`@arcaai/admin`) application and wires the three flagship `@arcaai/ui` components (`VirtualizedDataGrid`, `HistoryTimelineList`, `LiveTranscript`) to **real** HOPE backend data via the `@arcaai/vox` SDK. It does **not** modify `@arcaai/ui` (TASK-372 owns it) and does **not** copy the `apps/ui-playground` admin UI (slated for removal); `ui-playground`/`apps/api` were consulted only to learn the auth/session/API-client patterns.

---

## 1. Requirement Analysis

### 1.1 Description

Scaffold a clean, production-grade `apps/admin` (React 19 / Vite 7 / Tailwind v4 / TanStack Router, consuming `@arcaai/ui`) and wire three surfaces that exercise the new shared components end-to-end against real endpoints:

1. **Data-grid surface** — `VirtualizedDataGrid` with **offset** pagination (cursor inert per D7/TASK-373), faceted filters / search / column features, and the **server-persisted grid-layout adapter** (`useUserSettings`, `ui.data-grid` namespace, D8).
2. **Consultation-history surface** — `HistoryTimelineList` bound to consultation context-item data (the content types).
3. **Live-session surface** — `LiveTranscript` consuming the `@arcaai/vox` transcript stream, wired via the component's word interface so it works whether word timings arrive via the store (D9 SDK plumbing) or `SttWebSocketClient.onTranscript`.

Plus the **app shell** (sidebar + topbar nav per TASK-371) and **login** wired to real JWT auth/session.

### 1.2 Business context

`apps/admin` is the operator surface for the multi-tenant HOPE platform (tenancy, identity/access, audit, monitoring). It must be token-driven (Calm Clinical Teal), light/dark + Comfortable/Compact density, and WCAG 2.2 AA — enforcing the cross-cutting principles from TASK-371 §1.4 (404-over-403, soft-delete = archive, auditability) which are server-side; the console simply renders them.

### 1.3 Scope

- **In scope:** scaffold `apps/admin`; app shell + login + real auth/session; the three wired surfaces (Tenants + Users grids, consultation history, live session); a server-persisted grid-layout adapter; smoke/unit tests; build/lint verification; this doc.
- **Out of scope (explicit follow-ups, §5.4):** the remaining admin screens (Roles & Policies/CASL builder, System Health dashboard, Departments & Prompts, API keys, Settings, Audit-Log grid, tenant create/edit/config flows); cursor pagination (TASK-373); media-storage resolution for timeline PDF/image/file (**since delivered — §4.5**); SDK store word-timestamp plumbing (D9 Option B).

### 1.4 Acceptance criteria

| ID | Criterion |
|---|---|
| A1 | `apps/admin` (`@arcaai/admin`) exists as a pnpm workspace member, Turborepo-wired, builds via `pnpm build --filter @arcaai/admin`. |
| A2 | App shell (sidebar + topbar) + login render with TASK-371 teal tokens, light/dark, density toggle; login authenticates against the real API. |
| A3 | A `VirtualizedDataGrid` surface is bound to a real endpoint with **offset** pagination, faceted filters/search, column features, and the `useUserSettings`-backed layout adapter (degrades gracefully if the namespace isn't whitelisted). |
| A4 | A `HistoryTimelineList` surface renders real consultation context items via a `mapItem` adapter. |
| A5 | A `LiveTranscript` surface consumes the `@arcaai/vox` transcript stream and accepts word-level data through the component's word interface. |
| A6 | Token-driven (no hardcoded colors); WCAG-minded; no new lint errors in changed files; smoke tests pass. |

---

## 2. Current State Evaluation

- **`apps/admin` does not exist.** `.cursor/rules/07-react-ui.mdc` references it (`@arcaai/admin`, port 5174) but with a **stale stack note** (Ant Design / Jotai). This ticket builds it with **`@arcaai/ui` + shadcn + Tailwind v4** per the explicit TASK-371/372 design direction (the Ant Design note predates the design-system work and is superseded). See **deviation §5.3.1**.
- **`@arcaai/ui` is built & verified** (TASK-372 §4): barrel exports `VirtualizedDataGrid`, `HistoryTimelineList`, `LiveTranscript`, `DensityProvider`, `lib/shared/*` contracts, etc. `globals.css` already carries the teal tokens. Consumed from **source subpaths** at runtime (tree-shake; avoids pulling the 2.2 MB barrel with three.js/maplibre) and from `dist/index.d.ts` for types — mirroring `ui-playground`.
- **`@arcaai/vox` SDK** is the data layer (no react-query/generated SDK). Relevant hooks (verified): `useAuth` (login/logout/getMe), `useTenants.list`, `useUsers.listPaginated` (returns `{data,total,page,limit,totalPages,hasMore}` ← maps to `fromSdkPaginated`), `useAuditLog`, `useUserSettings` (`list` / `updateByKey(ns,key,value)`), `useAdminConsultations.list`, `useArcaSession.loadConsultation` (hydrates `context.items`), `useArcaContext` (`items`, `updateItem`), `useArcaAudio` (`transcriptSegments`, `currentTranscript`, `isCapturing`, `start`/`stop`). `SttWebSocketClient.onTranscript` is exported for the rich (word-level) path.
- **Auth/session pattern (from `ui-playground`, reused not copied):** Zustand auth store (sessionStorage, token + tenant) → `SDKProvider` feeds `AgenticProvider` `config.api.{baseUrl,accessToken,tenantId}` → TanStack Router `_authenticated` guard → Vite dev proxy `/api` → `http://localhost:8868`.

### 2.1 Data-binding map (real sources)

| Surface | Component | Real source (SDK) | Notes |
|---|---|---|---|
| Users | `VirtualizedDataGrid` | `useUsers.listPaginated({page,limit,...})` → `fromSdkPaginated` | **server offset** (`manual` sort/filter/paginate), `rowCount=total`; faceted `resourceStatus`/`isServiceAccount`; layout persisted `ui.data-grid`/`users` (D8). |
| Tenants | `VirtualizedDataGrid` | `useTenants.list()` | **client mode** (tenant list returns no `count`); search/sort/filter/paginate client-side; protected system-tenant badge (TASK-371 X4); layout `ui.data-grid`/`tenants`. |
| History | `HistoryTimelineList` | `useAdminConsultations.list` → pick → `useArca().session.load(id)` → `useArca().context.items` **+ media-enriched `context.getItems()`** | `mapItem`: `ContextItem` → `TimelineItemModel` by `type`/derived `is*`; media (PDF/image/audio/file URLs) now **storage-resolved** via the enriched `/context` endpoint, merged by id (§4.5) → degrades to markdown/file only when `url` is absent. |
| Live | `LiveTranscript` | `useArcaAudio` `transcriptSegments` + `currentTranscript` + `isCapturing` | map `TranscriptSegment` → `LiveTranscriptSegment`; passes through `wordTimestamps` if present (D9 store path) so it "just works" when D9 lands; click-to-seek inert during live (no seekable file — documented). |

---

## 3. Implementation Plan

### 3.1 Scaffold

`apps/admin` mirrors `ui-playground` conventions: Vite 7 + `@vitejs/plugin-react` + `@tailwindcss/vite` + `@tanstack/router-plugin` (file-based, autoCodeSplitting) + an enhanced `resolveArcaUiSubpaths` plugin (adds `<subpath>/index.{ts,tsx}` resolution for the new component folders). `src/index.css` defines the **TASK-371 teal tokens** + `@source "../../../packages/ui/src"` so Tailwind generates utilities for the consumed components. tsconfig maps `@arcaai/ui/*` → `dist/index.d.ts` (types) and `@arcaai/vox` → SDK src. Port **5174**.

### 3.2 Build order (TDD where practical)

```
1. Scaffold (pkg/tsconfig/vite/vitest/html/css)  → verify: pnpm install resolves
2. Auth store + providers (SDK/theme/density)     → verify: app boots, login redirect guard
3. App shell (sidebar/topbar) + login page        → verify: renders, teal tokens
4. Users grid (server offset + persistence)        → verify: unit test maps page/columns
5. Tenants grid (client mode)                       → verify: renders rows + protected badge
6. Consultation history (timeline + mapItem)        → verify: unit test mapItem variants
7. Live session (LiveTranscript + audio bridge)     → verify: unit test segment mapper
8. Build + lint + fix                               → verify: real output pasted (§5.2)
```

### 3.3 State management

**Zustand** auth store (mirrors the proven `ui-playground` bootstrap), **not** react-query (the SDK hooks own loading/error/data; avoids a redundant dependency — Karpathy simplicity). Theme + density via lightweight context providers. (Deviates from rule 07's stale "Jotai" note — §5.3.1.)

---

## 4. Implementation Summary

`apps/admin` (`@arcaai/admin`, port **5174**) is a clean React 19 / Vite 7 / Tailwind v4 / TanStack Router app that consumes `@arcaai/ui` from **source subpaths** (tree-shaken via the `resolveArcaUiSubpaths` Vite plugin) and the `@arcaai/vox` SDK as its data layer.

**Run it:** `pnpm --filter @arcaai/admin dev` (expects the API on `:8868`; the dev server proxies `/api` + `/ws`). Build: `pnpm build --filter @arcaai/admin`.

| Surface | Route | Component | Real source (SDK) | Mode |
|---|---|---|---|---|
| **App shell + login** | `/login`, `/_authenticated` | shadcn primitives + tokens | `useAuth().login` → `POST /auth/login`; Zustand store (sessionStorage) feeds `AgenticProvider` `api.{accessToken,tenantId}` | JWT credentials |
| **Tenants** (+ **CRUD**) | `/tenants` | `VirtualizedDataGrid` + `Sheet` drawers | `useTenants().{list,create,update,enable,disable,getConfigs}` | **client** grid (search/sort/multiSelect `resourceStatus`/paginate); row → **detail drawer** (config JSON, enable/disable); **New/Edit** drawer (client-side key-uniqueness); protected **System** tenant; layout `ui.data-grid`/`tenants` |
| **Users** | `/users` | `VirtualizedDataGrid` | `useUsers().listPaginated({page,limit,sort,filters,search})` | **server offset + server-side sort/filter/search** (`manual` sort+filter+paginate, `rowCount=total`); faceted `resourceStatus`/`isServiceAccount`; layout `ui.data-grid`/`users` |
| **Roles & Policies** | `/roles` | `Tabs`+`Table`+`Dialog`+`Sheet` | `useRoles()` (RBAC) + `usePolicies()` (CASL) | Roles: list/create/**edit**/delete (system-role protected) + **role↔policy assignment drawer** (`assignPolicy`/`removePolicy`). Policies: list/create/**edit**/view/delete with a **visual CASL rule-builder** (action/subject/conditions/fields) + validated-JSON fallback, both hitting server `validate()` (§4.6) |
| **Departments & Prompts** | `/departments` | `Tabs`+`Table`+`Dialog` | `useDepartments()` + `usePrompts()` | Departments: create/edit/delete. Prompt templates: create/**edit** (content/status/description → **new version** via OCC `expectedVersion`; name/category immutable)/view/delete |
| **API Keys** | `/api-keys` | `Table`+`Dialog` | `useApiKeys().{list,create,revoke,remove}` | create (**secret shown once** + copy-to-clipboard), revoke, delete; status/last-used/expiry |
| **Settings** | `/settings` | `Tabs`+`Table`+`Dialog` | `useGlobalSettings()` + `useUserSettings()` | Global: CRUD with **OCC** (get→update, `ConfigConflictError` → refresh). My settings: read-only (surfaces the `ui.data-grid` namespace, D8) |
| **System Health** | `/system-health` | `Card` grid | `useHealthCheck()` + `useMonitoring()` | overall + per-service status, version/uptime, session counters; auto-refresh (30s poll) |
| **Audit Log** | `/audit-log` | `VirtualizedDataGrid` | **`useAuditLog().listByCursor(query)`** (SDK; Round-4 swap from raw `apiClient`) | **cursor / keyset** infinite scroll (`AsyncCollection`); action/resource/user filters; CSV export |
| **Consultation History** | `/history` | `HistoryTimelineList` | `useAdminConsultations().list` → `useArca().session.load(id)` → `useArca().context.items` **merged with media-enriched `context.getItems()`** | `mapContextItem` adapter (`ContextItem` → `TimelineItemModel`) binding **storage-resolved** media (image/pdf/audio/file/**mixed**); image grid `src = thumbnailUrl`, **full-res `zoomSrc = url`** for the lightbox (§4.6); degrades to markdown when absent (§4.5) |
| **Live Session** | `/live` | `LiveTranscript` | `useArca().audio` (`transcriptSegments`/`currentTranscript`/`isCapturing` + `start`/`stop`) | `mapTranscriptSegment` passes `words` → `wordTimestamps` (D9 superset) |

Cross-cutting: light/dark theme + Comfortable/Compact density (topbar toggles, persisted), token-driven styling (TASK-371 teal tokens in `src/index.css`; no hardcoded colors), and the `useUserSettings`-backed `GridLayoutPersistenceAdapter` (D8) which **degrades gracefully** when the namespace isn't whitelisted. Nav is grouped into 5 pillars (Multi-Tenancy / Identity & Access / Clinical Operations / Observability / Platform) in `src/lib/nav.ts`; routes are file-based under `routes/_authenticated/` (auto-discovered by the TanStack router plugin). All write actions toast via `sonner`; deletes route through a shared `ConfirmDelete` (`AlertDialog`) and the secret-once API-key reveal is copy-to-clipboard.

### 4.1 Audit-Log grid — cursor (keyset) infinite scroll

`features/audit-log/use-audit-log-cursor.ts` calls the SDK's **`useAuditLog().listByCursor(query)`** (TASK-375), which owns the cursor endpoint path + query-string assembly and normalizes the server `CursorPaginatedResponse<T>` (`{data,nextCursor,hasMore,limit}` — TASK-373) to a `CursorPageResult` (`{rows,nextCursor,hasMore}`). The hook exposes an **`AsyncCollection<AuditLogEntry>`** (`data`/`hasNextPage`/`fetchNextPage`/`refetch` + `nextCursor`) whose rows **accumulate** across pages. The grid runs in `pageMode="cursor"` with `manual.pagination`; its cursor pager commits the next cursor through `onQueryStateChange` (not `onPaginate`), which the page detects to call `fetchNextPage()`. Filters (action / resource type / user id) reset paging via a stable `auditCursorFilterKey(filters,limit)` (pure, unit-tested) so a new filter set restarts the keyset from the first page; **CSV export** uses `useAuditLog().exportCsv(filters)` (server-side) → Blob download.

> **TASK-375 swap (Round 4):** the previous round used a raw `apiClient.get('/admin/audit-logs/cursor?…')` plus a local endpoint constant (`AUDIT_LOG_CURSOR_ENDPOINT`) and the SDK's `extractCursorPaginated` normalizer, since `useAuditLog` had no cursor method. The SDK now ships **`listByCursor`**, so the raw call **and the dead local constant + query-builder were removed** — the grid consumes the SDK method directly with **identical** `AsyncCollection` / infinite-scroll behavior. `audit-cursor-query.ts` is reduced to the app-level `AuditCursorFilters` type + the `auditCursorFilterKey` reset key.

### 4.2 Users grid — server-side sort / filter / search

The Users grid now runs fully `manual` (`{pagination,sorting,filtering}`). `DataQueryState` → **`toPaginatedQuery`** (the shared `@arcaai/ui` serializer) → **`toUserListQuery`** (`features/users/user-query.ts`, pure + unit-tested) → **`useUsers().listPaginated`**. `listPaginated` forwards the full `UserListQuery` (`page`,`limit`,`sort`,`filters`,`search`) confirmed on the SDK (TASK-375 landed). `onQueryStateChange` resets to page 0 when the result-set shape changes (sort/filter/search/page-size). **Graceful degradation:** if the backend ignores `sort`/`filters`/`search` it still returns the page, so the grid falls back to offset-only behavior with no error.

### 4.3 Token auto-refresh (auth layer)

The SDK keeps its refresh token **in-memory** (lost on hard reload). `apps/admin` disables the SDK auto-wire (`autoWireTokenRefresh:false` in `SDKProvider`) and adds its own: `lib/auth-refresh.ts` (`getTokenExpiryMs`/`isTokenExpired`/`tryRefreshToken` using the **sessionStorage** refresh token → `POST /auth/refresh`) + the `hooks/use-auto-refresh.ts` hook, which registers an `onUnauthorized` handler on the `AgenticClient` (401 → refresh-and-retry) and proactively refreshes before expiry, re-seeding the client's access token. Survives reloads; on refresh failure it clears the store and bounces to `/login`.

### 4.4 D8 — `ui.data-grid` grid-layout persistence (verified)

The adapter is a **pure factory** `createGridLayoutAdapter(settingsClient)` (`features/data-grid/grid-layout-adapter.ts`); `useGridLayoutPersistence` just injects `useUserSettings`. `load` reads `GET /user/me/settings` and matches `namespace==='ui.data-grid'` + grid key; `save` calls `PATCH /user/me/settings/ui.data-grid/:key`. Every grid passes `persistence={{ namespace: GRID_LAYOUT_NAMESPACE, key, adapter }}` so column order/sizing/visibility/pinning/density round-trip to the user's profile. **Verified** by `__tests__/grid-layout-adapter.test.ts` (mocked settings client) proving the **load→save round-trip** under `ui.data-grid`, plus null-on-miss and cross-namespace isolation. Manual full-stack steps in §5.5.

### 4.5 Consultation History — storage-resolved media (TASK-375 frontend half)

The timeline now renders **real media**. The store's `context.items` arrive via the consultation GET and are **not** media-resolved, so `/history` additionally fetches the **media-enriched** list from `GET /consultations/:id/context` (`useArca().context.getItems()` — TASK-375 attaches a presigned `url`, `mimeType`, and image `thumbnailUrl` per attachment) once the consultation is loaded into the store, then **merges those fields onto the store items by `id`** via `mergeResolvedMedia` (pure, order-preserving). `mapContextItem` binds them:

| Variant | Binding |
|---|---|
| **image** | `thumbnailUrl ?? url` → `TimelineImage.src` (grid) **and** full `url` → `TimelineImage.zoomSrc` (zoom lightbox, Round 4 — §4.6) |
| **pdf** | `url` (+ `name`) → react-pdf renderer |
| **audio** | `url` → audio player |
| **file** | `url` + `mimeType` → file card |
| **mixed** | item text (markdown) + **one** image grid + a part per pdf/audio/file, normalized from nested `structuredData.attachments[]` |

Classification uses `mimeType` first, then a URL-extension fallback. The merge keeps the existing store order (no reordering), and items resolve **incrementally**: they render immediately from the store (degraded) and upgrade to media when the enriched fetch returns.

**Graceful degradation:** when no `url` resolves (resolution unavailable, or pre-resolution), the item falls back to its markdown/file card — the pre-TASK-375 behavior. Also fixed a latent call to the non-existent `session.loadConsultation` (the `useArca()` aggregate exposes **`session.load`**).

> **Gaps update (Round 4):** the **separate full-res zoom source** is now **delivered** — `TimelineImage` gained an additive `zoomSrc` field and the `ImageGallery` lightbox swaps to it on open (§4.6, TASK-372 enhancement), so the grid shows the 320px thumbnail and the zoom view is full-resolution. The remaining gap is **backend-only**: real **downscaled** thumbnails (today `thumbnailUrl === url`, so the zoom upgrade is currently a no-op swap until the backend ships true thumbnails — TASK-375 backend half). The presigned-URL wiring is complete.

### 4.6 Round 4 — edit forms, policy rule-builder, role↔policy assignment, full-res zoom

All four Round-4 deliverables landed **without any raw-`apiClient` stopgap** — every needed method already existed on the SDK hooks (no SDK scope was expanded).

**Edit forms (create + edit, mirroring the existing create drawers/dialogs):**

| Resource | Component | SDK methods (`@arcaai/vox`) | Notes |
|---|---|---|---|
| **Roles** | `features/roles/role-form-dialog.tsx` (`RoleFormDialog`, create+edit) | `useRoles().createRole` / **`updateRole`** | parent-role `Select` excludes the role being edited; system roles are edit/delete-protected (assignment still allowed). |
| **Policies** | `features/roles/policy-form-dialog.tsx` (`PolicyFormDialog`, create+edit) | `usePolicies().create` / **`update`** / `validate` | wraps the rule-builder (below); **Validate** button hits the server `validate()` on either editing path. |
| **Prompts** | `routes/_authenticated/departments.tsx` (`PromptFormDialog`, create+edit) | `usePrompts().create` / **`update`** | `name`/`category` are immutable (the SDK `UpdatePromptInput` omits them) so they render read-only in edit; editing content/status creates a **new version** with an optional change reason, echoing the OCC `expectedVersion`. |

**Policy visual rule-builder (`features/roles/policy-rules-editor.tsx` + pure `policy-rules.ts`):** a tabbed editor replacing the raw CASL JSON textarea — **Builder** mode composes rules from `action` × `subject` dropdowns (vocabulary grounded in `knowledge/04_ACCESS_CONTROL.md`: actions `manage/create/read/update/delete/…`, subjects `Patient/Consultation/User/Role/Policy/all/…`), plus free-form `conditions` (key + `{{variable}}`/value, e.g. `tenantId: {{user.tenantId}}`), `fields`, and an **inverted** (`cannot`) toggle. An **Advanced (JSON)** tab is the validated-JSON fallback; switching Builder→JSON serializes the drafts, and JSON→Builder only succeeds when the rules are builder-representable (array actions / nested conditions / extra keys keep you in JSON so nothing is lost). Both paths reach the server `validate()` before save. Pure conversions (`draftToRule`/`ruleToDraft`/`serializeRules`/`parseRulesText`/`isBuilderRepresentable`) are unit-tested (`__tests__/policy-rules.test.ts`).

**Role↔policy assignment (`features/roles/role-policies-sheet.tsx`):** a drawer opened per role from the Roles table (new **Policies** count column + key action). Attached policies read straight off the role object's `policies[]` array (returned by the RBAC roles endpoint; surfaced through the local `RoleWithPolicies` view type since the SDK `Role` only declares `[key:string]: unknown`); attach/detach call **`useRoles().assignPolicy` / `removePolicy`** and re-`listRoles()` so the sheet reflects the new state. Available policies (from `usePolicies().list`) are searchable and exclude already-attached ones.

**Full-res zoom (the one permitted additive `@arcaai/ui` change — §4.5, TASK-372 §change-history):** `TimelineImage` (+ the `ImageGallery` item schema) gained an optional `zoomSrc`; the lightbox swaps the moved `<img>`'s `src` to `zoomSrc` on open and restores the thumbnail on close (synchronized with the existing view-transition). `mapContextItem` binds grid `src = thumbnailUrl ?? url` and `zoomSrc = url`, so the timeline grid stays light (320px thumbnails) while zoom is full-resolution. Falls back to `src` when `zoomSrc` is absent (back-compatible).

### 4.7 Round 5 — `tsc --noEmit` clean (pre-existing typecheck debt resolved)

`apps/admin` always **built** (`vite build` resolves the `@arcaai/ui` *source* barrel), but `tsc --noEmit` failed on debt accumulated across earlier rounds. Round 5 makes the **admin typecheck pass with 0 errors** via surgical, additive fixes (no mass-reformat; new code keeps the surrounding 4-space style).

**(1) `@arcaai/ui` subpath dist-types (`StatusBadge` / `StatusColorRole`) — the headline fix.** These two names are intentionally **kept off the root barrel** (the shared `StatusBadge` collides with the tool-ui formatter `StatusBadge` — TASK-372 §4.5), so admin imports them from the **`@arcaai/ui/components/shared`** subpath (11 files). The package shipped JS for that subpath but **no matching `.d.ts`**, so `tsc` (which reads `dist` types, not source) couldn't resolve them. Fixed by making the subpath a **first-class packaged entry** — additive and back-compatible (root barrel + the `"./*": "./src/*.tsx"` source fallback are untouched):

| Change | File | Effect |
|---|---|---|
| Add `src/components/shared/index.ts` as a second `tsup` entry | `packages/ui/tsup.config.ts` | `tsup` now emits `dist/components/shared/index.{js,mjs,**d.ts,d.mts**}` |
| Add an `"./components/shared"` conditional export (`types`/`import`/`require`) | `packages/ui/package.json` | Node/bundler **and** `tsc` (`moduleResolution: bundler/nodenext`) resolve the subpath to its `.d.ts` |
| Map `@arcaai/ui/components/shared` → `dist/components/shared/index.d.ts` | `apps/admin/tsconfig.json` `paths` | admin's path-mapped resolver finds the shipped subpath types |

Build evidence (Round 5): `DTS dist/components/shared/index.d.ts 1.10 KB` (+ `.d.mts`) are now emitted alongside the root `dist/index.d.ts` (§5.6).

**(2) `audit-log.tsx:100` — optional `fetchNextPage`.** `AsyncCollection.fetchNextPage` is **optional** in the `@arcaai/ui` contract (cursor pagers may omit it), so the unconditional call tripped `TS2722`. Fixed at the call site with an **optional call**: `collection.fetchNextPage?.()` (no `any`, behavior unchanged — a missing pager is simply a no-op).

**(3) `tenants.tsx:118` — TanStack `FilterFn` variance.** The shared `multiSelectFilterFn` is row-type-agnostic (`FilterFn<unknown>`); TanStack's `FilterFn<TData>` is **invariant** in `TData`, so assigning it to a `ColumnDef<TenantRow>.filterFn` failed (`TS2322`). Narrowed at the call site with an explicit, documented assertion — `filterFn: multiSelectFilterFn as FilterFn<TenantRow>` (imported `FilterFn` as a type) — rather than loosening to `any`.

**(4) `login.tsx:15` — `export interface LoginSearch` (`TS4023`).** The generated `routeTree.gen.ts` re-exports `LoginRoute`, whose inferred search type referenced the **local** `LoginSearch` interface; an un-exported name in an exported inferred type triggers `TS4023`. Fixed by **exporting** the interface so the generated tree can name it. (Surfaced only after the subpath fix cleared the noisier errors.)

> Pre-existing, **not** addressed (out of scope, per "don't mass-reformat"): the lone `ReadLints` finding is a Tailwind-version nit (`bg-gradient-to-b` → `bg-linear-to-b`) in `login.tsx:62`, and the repo-wide `prettier/prettier` 4-space-vs-2-space whitespace warnings. Neither is a `tsc` error.

---

## 5. Implementation Summary & Evidence

### 5.1 Files created

```
apps/admin/
├── package.json · tsconfig.json · index.html · .eslintrc.cjs · .gitignore
├── vite.config.ts            # @vitejs/plugin-react + tailwind + tanstackRouter + resolveArcaUiSubpaths
├── vitest.config.ts          # jsdom; stubs @arcaai/ui/*, @arcaai/vox for pure-logic tests
└── src/
    ├── main.tsx              # router bootstrap + hydration gate
    ├── index.css             # TASK-371 teal tokens + @source ../../../packages/ui/src
    ├── vite-env.d.ts
    ├── lib/{constants,nav,utils,auth-refresh}.ts   # +auth-refresh (token refresh); +formatDateTime/formatUptime in utils
    ├── store/auth-store.ts   # Zustand (sessionStorage) JWT/tenant
    ├── hooks/use-auto-refresh.ts   # NEW — 401 retry + proactive refresh; re-seeds AgenticClient
    ├── providers/{theme-provider,density-provider,sdk-provider}.tsx   # sdk-provider: autoWireTokenRefresh:false + mounts auto-refresh
    ├── components/layout/{app-shell,page-header}.tsx
    ├── features/
    │   ├── common/confirm-delete.tsx   # NEW — shared destructive AlertDialog
    │   ├── data-grid/{status.ts, grid-layout-adapter.ts, use-grid-persistence.ts, __tests__/{status,grid-layout-adapter}.test.ts}
    │   ├── users/{user-query.ts, __tests__/user-query.test.ts}   # NEW — DataQueryState→UserListQuery
    │   ├── audit-log/{audit-cursor-query.ts, use-audit-log-cursor.ts, __tests__/audit-cursor-query.test.ts}   # NEW
    │   ├── tenants/{tenant-form-sheet,tenant-detail-sheet}.tsx   # NEW — create/edit drawer + detail view
    │   ├── history/{map-context-item.ts, __tests__/map-context-item.test.ts}
    │   └── live/{map-segment.ts, __tests__/map-segment.test.ts}
    ├── routes/
    │   ├── __root.tsx · index.tsx (redirect) · login.tsx
    │   └── _authenticated/{route.tsx, tenants.tsx, users.tsx, roles.tsx, departments.tsx,
    │                       api-keys.tsx, settings.tsx, system-health.tsx, audit-log.tsx, history.tsx, live.tsx}
    └── __tests__/setup.ts
```

### 5.2 Verification evidence

- **Build (Round 4)** — `pnpm build --filter @arcaai/ui --filter @arcaai/admin` → exit 0, Turbo **`Tasks: 8 successful, 8 total`**, `@arcaai/admin:build ✓ built in 7.70s` (every screen still code-splits; the only warning is the pre-existing generic >500 kB advisory from lazy vendor bundles, not screen code). The additive `@arcaai/ui` `zoomSrc` change builds clean.
- **Unit tests (Round 4)** — `pnpm --filter @arcaai/admin test` → **Test Files 7 passed (7) · Tests 47 passed (47)** (adds **`policy-rules`** — builder↔rule conversions, round-trip, `isBuilderRepresentable`, `serialize`/`parse`; `map-context-item` already covers the `zoomSrc` binding — grid `src=thumbnailUrl`, `zoomSrc=url`, no-thumbnail fallback, and the multi-attachment case). `pnpm --filter @arcaai/ui test timeline` → **Test Files 2 passed (2) · Tests 21 passed (21)** (incl. the new lightbox **zoomSrc swap-on-open / restore-on-close** + `src` fallback tests).
- **Type-check (Round 4)** — `pnpm --filter @arcaai/admin type-check` (`tsc --noEmit`): the 4 errors initially introduced in `roles.tsx` (the `PolicyInput` ↔ SDK `CreatePolicyInput`/`UpdatePolicyInput` index-signature mismatch) were fixed (added `[key:string]: unknown` to `PolicyInput`). **Remaining `tsc` errors are pre-existing and not from Round-4 logic** — `StatusBadge`/`StatusColorRole` subpath-type resolution across **10** files (incl. untouched `app-shell.tsx`, `users.tsx`, `tenants.tsx`; an `@arcaai/ui` `exports`-map dist-types quirk — `vite build` resolves the source barrel and passes), `audit-log.tsx:100` (`AsyncCollection.fetchNextPage?` is optional in `@arcaai/ui`), and `tenants.tsx:116` (TanStack `FilterFn<unknown>` generic variance). None are introduced by this round.
- **Lint (Round 4)** — `ReadLints` on all changed files → **No linter errors found**. `@arcaai/ui` scoped ESLint (`--max-warnings 0`) on the timeline + image-gallery changes → **0 problems**. The admin `lint` script (`eslint . --ext .ts,.tsx`, no `--max-warnings 0`) exits **0** with `0 errors, 4050 warnings` — the warnings are pre-existing repo-wide `prettier/prettier` whitespace (an **untouched** file, `users.tsx`, has 117 of the same; the admin app uses 4-space indent vs the shared config's 2-space). New code matches the surrounding 4-space style intentionally (no reformat, per "match existing style").

### 5.3 Deviations

#### 5.3.1 Stack: `@arcaai/ui`/shadcn/Zustand (not Ant Design/Jotai)
`.cursor/rules/07-react-ui.mdc` lists `apps/admin` as Ant Design + Jotai. That note predates the TASK-371/372 design-system work; this ticket is the explicit D10 realization that `apps/admin` consumes `@arcaai/ui` + the Calm Clinical Teal system. State uses Zustand to match the proven SDK auth bootstrap and avoid a redundant dependency. No `@arcaai/ui` changes.

#### 5.3.2 Public SDK surface: `useArca()` aggregate
The `@arcaai/vox` barrel exports the aggregate `useArca()` (→ `.session` / `.audio` / `.context`) but **not** the focused `useArcaContext` / `useArcaAudio` hooks (they're internal). History + Live consume `useArca()` accordingly.

#### 5.3.3 Offset page base = 0; Users server-side sort/filter/search **now enabled**
The Users grid sends the grid's 0-based `page` straight to `useUsers().listPaginated` to match the backend `PaginatedQuery` contract documented in `@arcaai/ui` `lib/shared/pagination.ts`. **Update:** `listPaginated` now forwards the full `UserListQuery` (`sort`/`filters`/`search`, TASK-375), so the Users grid runs fully server-side via `toPaginatedQuery → toUserListQuery` (§4.2) and **degrades gracefully** (keeps offset behavior) if the backend ignores those params. Tenants remains client-side faceted/search/sort.

#### 5.3.6 Audit-Log cursor — now via the SDK `listByCursor` (local constant removed)
**Resolved in Round 4.** The previous round used a local endpoint-path constant (`AUDIT_LOG_CURSOR_ENDPOINT`) + raw `apiClient` + the SDK `extractCursorPaginated` normalizer, since `useAuditLog` had no cursor method. The SDK now ships **`useAuditLog().listByCursor(query)`**, so the raw call, the dead path constant, and the local query-builder were **deleted**; the grid consumes the SDK method directly (§4.1). `AsyncCollection` / infinite-scroll behavior is byte-for-byte the same.

#### 5.3.8 Round-4 SDK coverage — no raw-`apiClient` stopgaps; one local view type
All Round-4 mutations resolve to **existing** SDK methods (`useRoles().{createRole,updateRole,deleteRole,assignPolicy,removePolicy}`, `usePolicies().{create,update,validate}`, `usePrompts().{create,update}`, `useAuditLog().listByCursor`) — **no raw-`apiClient` stopgap was needed and SDK scope was not expanded**. The one bridge: attached policies are read through a local `RoleWithPolicies` view type (`features/roles/types.ts`) because the RBAC roles endpoint returns a `policies[]` array that the SDK `Role` type only models as `[key:string]: unknown`. A `PolicyInput` index signature (`[key:string]: unknown`) was added to keep the dialog's input assignable to the SDK's indexed `Create/UpdatePolicyInput`.

#### 5.3.7 Token auto-refresh owned by the app (not the SDK)
The SDK's in-memory refresh token can't survive a reload, so `apps/admin` disables `autoWireTokenRefresh` and owns refresh from the sessionStorage token (§4.3) — mirroring `ui-playground`. No `@arcaai/vox` change.

#### 5.3.4 Two density controls
The grid owns its own (persisted) density via its toolbar toggle; the topbar density toggle drives the timeline + live surfaces (which take a `density` prop). Kept separate to avoid making the grid's built-in toggle a no-op.

#### 5.3.5 Vite resolver shim for `@/components/ui/*`
`@arcaai/ui`'s vendored registries (reached transitively via the timeline image renderer) import `@/components/ui/*`, which its own tsconfig aliases to `components/shadcn/*`. The admin `resolveArcaUiSubpaths` plugin replicates that alias for UI-source importers (no `@arcaai/ui` change).

### 5.4 Follow-ups (explicit; not built here)

- **Built since the first round (no longer follow-ups):** Roles & Policies, System Health, Departments & Prompts, API Keys, Settings, **Audit-Log cursor grid**, Tenant create/edit + detail + enable/disable, Users server-side sort/filter/search, token auto-refresh, and **timeline storage-resolved media** (TASK-375 frontend half — §4.5) — all delivered (§4, §6).
- **Built since (Round 4 — no longer follow-ups):** role/policy/prompt **edit** forms; the policy **visual rule-builder** (+ validated-JSON fallback); the **role↔policy assignment** drawer; the **audit cursor SDK swap** (`listByCursor`); and the **full-res timeline zoom** (`TimelineImage.zoomSrc` + mapper binding) — all delivered (§4.6, §6).
- **D8 backend**: whitelist the `ui.data-grid` settings namespace so persistence round-trips end-to-end (adapter already degrades gracefully; unit-verified — manual steps §5.5).
- Timeline media: the presigned-URL wiring **and** the separate full-res zoom source are **done** (§4.5/§4.6); the remaining gap is **backend-only** — real **downscaled** thumbnails (today `thumbnailUrl === url`, so the zoom swap is a no-op until true thumbnails ship).
- **Admin `tsc` subpath dist-types — ✅ RESOLVED (Round 5, §4.7):** `StatusBadge`/`StatusColorRole` now resolve from the packaged `@arcaai/ui/components/shared` subpath (`tsup` entry + `exports` map + admin `tsconfig` path); `audit-log.tsx`/`tenants.tsx`/`login.tsx` call-site fixes landed. `pnpm --filter @arcaai/admin type-check` → **0 errors** (§5.6). The only remaining hygiene item is the repo-wide `prettier/prettier` whitespace (4-space code vs 2-space config) + the lone `bg-gradient-to-b` Tailwind nit — non-blocking, worth a one-shot prettier pass in a separate ticket.
- **Backend defects found during live E2E (§5.6) — all resolved:** `DEFECT-Q1` (`PaginatedQuery` `@IsOptional`) and `DEFECT-D8` (adapter object/string) were fixed in Round 5; **DEFECT-P1** (admin grid 0-based vs backend 1-based `page` → `page = pagination.page + 1` in `toUserListQuery`) and **DEFECT-F1** (boolean-column filter 400 → targeted opt-in string→bool coercion in `deserializeFilterString`, backend in TASK-375) were fixed in **Round 6** (TDD RED→GREEN unit + live E2E — §5.6 / §6). Only `DEFECT-M1` (media not seed-verifiable) remains, a verification blocker with a runbook above.
- **Media seed + thumbnail backfill (Check 3 blocker, DEFECT-M1):** the default seed ships no attachment/media context items and no matching MinIO blobs, so the media flow isn't live-verifiable without created data (runbook §5.6). Add a non-destructive seed (or backfill) that uploads a real image+PDF, generates the `*.thumb.webp` derivative, and attaches them as `ATTACHMENT` items.
- **`sharp` native binary on the deploy image:** real downscaled `*.thumb.webp` generation (`ImageThumbnailService`, TASK-375 backend) depends on the platform `sharp` binary; ensure it's installed in the API container/deploy image, else thumbnail generation degrades to `thumbnailUrl === url` (full-size).
- **D9 Option B**: SDK store plumbing of `wordTimestamps` through `audio.transcriptSegments`.
- Live transcript **inline edits are local** and **click-to-seek is inert** during live capture (no seekable recording).

### 5.5 D8 — manual full-stack verification steps

The round-trip is unit-proven (§4.4). To verify against the live stack (not required for this ticket; assumes API on `:8868` with the `ui.data-grid` namespace whitelisted):

1. `pnpm --filter @arcaai/admin dev` and sign in.
2. Open **Users** (or any grid). Reorder a column, resize one, hide one, toggle density, and (if pinnable) pin a column.
3. In DevTools → Network, confirm a `PATCH /api/user/me/settings/ui.data-grid/users` fires with the layout body (`order`/`sizing`/`visibility`/`pinning`/`density`).
4. Hard-reload the page → the grid restores your layout (driven by `GET /api/user/me/settings` → adapter `load`).
5. Open **Settings → My settings**: a row appears under namespace `ui.data-grid` (key `users`) with the persisted JSON — visual confirmation the layout lives in the whitelisted namespace.
6. Negative path: if the namespace is **not** whitelisted, the `PATCH` 4xxs but the grid keeps working with in-memory layout (graceful degradation) — no console error surfaced to the user.

### 5.6 Live full-stack E2E verification (Round 5)

The full dev stack was brought up and the three shipped features were verified **end-to-end against the live API** (not mocks). A reusable Playwright spec was authored **and executed live**.

**Stack (real `docker ps` + health):**

| Component | Evidence |
|---|---|
| Postgres / Redis / MinIO / Vault | `hope-postgres` (`:5432`), `hope-redis` (`:6379`), `hope-minio` (`:9000-9001`), `hope-vault` (`:8200`) — all **Up (healthy)** |
| NestJS API | `GET http://localhost:8868/api/v1/health` → **200** |
| `apps/admin` | `http://localhost:5174` → **200** (Vite dev) |

**Playwright spec — `apps/api/tests/e2e/task-375-admin-features.spec.ts` (NEW).** A runnable, seed-tolerant regression artifact in the existing API e2e harness (`loginUser`/`SEEDED_USERS`). Run against the **live dev stack** by bypassing the test-DB harness steps:

```bash
# from repo root — does NOT touch the :5433 test DB (SKIP_DB_PRECHECK), serial to dodge the 5/60s login throttle
SKIP_DB_PRECHECK=true API_URL=http://localhost:8868 NODE_ENV=test \
  npx playwright test apps/api/tests/e2e/task-375-admin-features.spec.ts --workers=1 --reporter=list
```

Result — **7 passed, 1 skipped (971 ms)**:

| # | Check | Test | Result |
|---|---|---|---|
| 1 | **D8** | `PATCH ui.data-grid` persists a JSON-**string** layout; `GET /user/me/settings` reflects it | ✅ |
| 1 | **D8** | re-`PATCH` **upserts** the same `(namespace,key)` row (no duplicate) | ✅ |
| 1 | **D8** | an **object** value is **rejected 400** (pins the contract the admin adapter must satisfy — see DEFECT-D8) | ✅ |
| 2 | **Users** | `sort=username:asc\|desc` accepted (**no 400**) + direction honored (`desc === reverse(asc)`) | ✅ |
| 2 | **Users** | `search=doctor` returns only matching usernames | ✅ |
| 2 | **Users** | `filters=username[contains]:doctor` accepted (**no 400**) + narrows the set | ✅ |
| 2 | **Users** | offset paging advances (server is **1-indexed**: `page=2` is the disjoint 2nd slice) | ✅ |
| 3 | **Media** | context attachments expose presigned `url` + `mimeType` (+ `thumbnailUrl` for images) | ⏭️ **skipped** — default seed ships no attachment/media context items (see runbook + DEFECT-M1) |

> The 5 tests do real HTTP round-trips as the seeded `super_admin`. Note: the login route is throttled at **5 req / 60 s** (`auth.controller.ts`), so the spec must run **`--workers=1`** (one shared `beforeAll` login) — a parallel-worker run 429s. The sort assertion is deliberately **collation-agnostic** (asserts `desc === reverse(asc)`, not a JS `localeCompare` re-sort) because Postgres' collation differs from ECMAScript's (it orders `doctor2` after `doctor_surgery`).

**Spot-check curl evidence (live, against `:8868`):** D8 — `PATCH /user/me/settings/ui.data-grid/users` with a JSON-string body → `200`, then `GET /user/me/settings` shows the `ui.data-grid`/`users` row; Users — `GET /admin/users?sort=username:asc&filters=username[contains]:doctor&search=doctor&limit=50` → `200` with narrowed/ordered data.

#### DEFECTS found

| ID | Severity | Symptom | Root cause | Status / fix |
|---|---|---|---|---|
| **DEFECT-Q1** | High (blocked Users sort/filter) | `GET /admin/users?sort=…` / `?filters=…` → **HTTP 400** "property sort/filters should not exist" | `PaginatedQuery.{sort,filters}` lacked `@IsOptional()`, so the strict `forbidNonWhitelisted` `ValidationPipe` rejected them (`search`/`searchFields` had it). | **FIXED** — added `@IsOptional()` to both (`packages/applications/src/common/dto/paginated.query.ts`), rebuilt `@arcaai/applications`, restarted API. Verified live (no 400) + regression-guarded by the spec. |
| **DEFECT-D8** | High (broke D8 from the UI) | Grid-layout save 400 "value must be a string"; on reload the layout didn't restore | The settings `value` is `@IsString()` (validated via `JSON.parse`), but the admin adapter sent the raw `GridLayoutState` **object**, and `load` returned `null` for the string it got back. | **FIXED** — `grid-layout-adapter.ts` now `JSON.stringify`s on `save` and `JSON.parse`s on `load`; unit tests updated to model the string wire-contract. The spec's "object → 400" test pins it so it can't regress. |
| **DEFECT-P1** | Medium | Users grid's 2nd page **duplicates** the 1st; last page unreachable | **Index-base mismatch:** the admin grid sends a **0-based** `page` (§5.3.3) but the backend computes `skip = max(0, (page−1)·limit)` (**1-based**), so grid `page 0` and `page 1` both yield `skip 0`. | **✅ FIXED (Round 6)** — `toUserListQuery` (`features/users/user-query.ts`) translates the **offset** path `page = pagination.page + 1` (Tenants is client-mode, Audit is cursor-based, so only the Users offset path is touched; the grid stays controlled by its own 0-based `queryState`/`rowCount`, so the echoed 1-based `page` is never re-consumed and can't desync the view). **Evidence:** `user-query.test.ts` **5/5** (RED without `+1` → 5 fail showing `page 0` vs `1`); live E2E *“P1: grid pages 0 → 1 map (via +1) to DISTINCT backend slices”* ✅. |
| **DEFECT-F1** | Low / edge | `filters=isServiceAccount[equals]:true` → **HTTP 400** | The filter deserializer keeps values as **strings**; for a boolean column Prisma rejects `"true"` (no string→bool coercion by column type). | **✅ FIXED (Round 6 — backend; authoritative entry in TASK-375 §8)** — targeted, **opt-in** coercion `deserializeFilterString(filters, booleanFields?)`; the Users service declares `isServiceAccount`, so only that column's exact `'true'`/`'false'` → boolean (every other field stays a string — no blind coercion). Generic numeric/date typing flagged as a metadata-driven follow-up. **Evidence:** converter + user-service **51/51** (RED without coercion → 4 fail `"true"`/`"false"` vs `true`/`false`); live E2E *“F1: boolean column filter … returns 200 and narrows”* ✅. |
| **DEFECT-M1** | Verification blocker | Media + thumbnail + zoom not **live**-verifiable | Seed (`09-consultation.ts`) creates **no** `ATTACHMENT`/media context items; the audio `Media` rows point at an `s3://hope-audio/…` bucket that **doesn't exist** in dev MinIO (tenant buckets are empty). | **REPORTED** — runbook below; the spec asserts the contract whenever media exists (`E2E_CONSULTATION_ID`). |

#### Check 3 (Media) — verification runbook + blocker

**Blocker:** the default seed has no image/PDF attachments and no matching MinIO blobs, so the presigned-URL / thumbnail / zoom flow can't be exercised on a fresh DB. The wiring is unit-verified (`map-context-item.test.ts` covers `src=thumbnailUrl`, `zoomSrc=url`, fallback, mixed) and the **contract** is guarded by the spec; only **live data** is missing. To verify live (non-destructive):

1. Log in (`super_admin`) and pick/create a consultation id.
2. Upload an image **and** a PDF via the storage API (presign → PUT → confirm) so a real blob lands in the tenant bucket; the upload path generates the **`*.thumb.webp`** derivative (requires the **`sharp`** native binary — see follow-ups).
3. Attach each upload as an `ATTACHMENT` context item on the consultation (sets `mediaId`/`mimeType`).
4. Run the spec's media check against it: `E2E_CONSULTATION_ID=<id> SKIP_DB_PRECHECK=true API_URL=http://localhost:8868 NODE_ENV=test npx playwright test apps/api/tests/e2e/task-375-admin-features.spec.ts -g "Media" --workers=1`. It asserts every media item has a presigned `url` + `mimeType`, and image items expose `thumbnailUrl`.
5. UI: open **History**, load that consultation — the timeline grid shows the **320px `*.thumb.webp`**; clicking opens the **full-res `url`** in the lightbox; PDFs render via react-pdf and audio via the player (all presigned).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Ticket created; requirement analysis, current-state eval, data-binding map, build order, plan authored. Status = In Progress. | `README.md` |
| 2026-06-27 | Scaffolded `apps/admin`; built app shell + JWT login; wired the 3 flagship surfaces (Tenants/Users grids, consultation history, live session) to real SDK endpoints; added the `useUserSettings` grid-layout adapter; 15 unit tests; build + lint green. Status = Completed (core). | `apps/admin/**` |
| 2026-06-27 | **Round 2 — remaining screens + 2 data features.** Built Roles & Policies (RBAC + CASL `validate`), System Health (health+monitoring, 30s poll), Departments & Prompts, API Keys (secret-once + revoke), Settings (global OCC + read-only user settings), and **Tenant CRUD** (create/edit drawer + detail + enable/disable). Wired the **Audit-Log cursor grid** (`extractCursorPaginated` + `AsyncCollection` infinite scroll on `GET /admin/audit-logs/cursor`; no local adapter needed) and **Users server-side sort/filter/search** (`DataQueryState`→`toPaginatedQuery`→`toUserListQuery`→`listPaginated`, graceful degradation). Added **token auto-refresh** (`lib/auth-refresh` + `use-auto-refresh`, `autoWireTokenRefresh:false`). **D8** verified via `grid-layout-adapter` round-trip test (+ manual steps §5.5). Shared `ConfirmDelete`; nav grouped into 5 pillars. Build `8/8` green, **26 unit tests** pass, lint clean. | `apps/admin/**` (routes `_authenticated/{roles,departments,api-keys,settings,system-health,audit-log}.tsx`, `tenants.tsx`; `features/{common,tenants,users,audit-log,data-grid}`; `hooks/use-auto-refresh.ts`; `lib/{auth-refresh,nav,utils}.ts`; `providers/sdk-provider.tsx`) |
| 2026-06-27 | **Round 3 — timeline storage-resolved media (TASK-375 frontend half, §4.5).** `/history` now fetches the media-enriched `GET /consultations/:id/context` list (`context.getItems()`) once the consultation loads and **merges** the presigned `url`/`mimeType`/`thumbnailUrl` onto the store items by id (`mergeResolvedMedia`, order-preserving). `mapContextItem` binds them into the image grid (`thumbnailUrl ?? url`), react-pdf, audio player, file card, and **mixed** (item text + image grid + pdf/audio/file from nested `structuredData.attachments[]`); degrades to markdown/file when `url` is absent. Fixed a latent `session.loadConsultation` → `session.load` call. **37 unit tests** pass (+11), build `8/8` green, lint clean, no new `tsc` errors in touched files. | `apps/admin/src/features/history/map-context-item.ts`, `apps/admin/src/features/history/__tests__/map-context-item.test.ts`, `apps/admin/src/routes/_authenticated/history.tsx` |
| 2026-06-27 | **Round 5 — admin `tsc --noEmit` clean + live full-stack E2E verification (§4.7, §5.6).** Resolved pre-existing admin typecheck debt with surgical, additive fixes: **packaged the `@arcaai/ui/components/shared` subpath types** (added a `tsup` entry for `src/components/shared/index.ts` → emits `dist/components/shared/index.d.ts`/`.d.mts`; added an `"./components/shared"` conditional `exports` entry; mapped the subpath in admin `tsconfig.paths`) so `StatusBadge`/`StatusColorRole` resolve in 11 files; `audit-log.tsx` `fetchNextPage?.()` (optional call); `tenants.tsx` `multiSelectFilterFn as FilterFn<TenantRow>` (variance, no `any`); `login.tsx` `export interface LoginSearch` (TS4023). **Verified (real output):** `pnpm --filter @arcaai/admin type-check` → **0 errors**; `@arcaai/ui` build ✅ (subpath `.d.ts` 1.10 KB emitted) + **445/445** tests; `pnpm build --filter @arcaai/admin` → Turbo **8/8**, built in 8.83s; `ReadLints` clean (lone pre-existing `bg-gradient-to-b` nit). Brought up the full dev stack and **verified the 3 features live** via a NEW runnable Playwright spec `apps/api/tests/e2e/task-375-admin-features.spec.ts` (**7 passed / 1 skipped** against `:8868`) + curl. Found/recorded **5 defects** (§5.6): fixed **DEFECT-Q1** (`PaginatedQuery.{sort,filters}` missing `@IsOptional`) + **DEFECT-D8** (adapter object/string vs `@IsString` value); reported **DEFECT-P1** (grid 0-based vs backend 1-based page off-by-one), **DEFECT-F1** (boolean-filter 400), **DEFECT-M1** (media not seed-verifiable → runbook). | `packages/ui/{tsup.config.ts,package.json}`, `apps/admin/tsconfig.json`, `apps/admin/src/routes/{login.tsx,_authenticated/{audit-log,tenants}.tsx}`, `apps/admin/src/features/data-grid/{grid-layout-adapter.ts,__tests__/grid-layout-adapter.test.ts}`, `packages/applications/src/common/dto/paginated.query.ts`, `apps/api/tests/e2e/task-375-admin-features.spec.ts` (new) |
| 2026-06-27 | **Round 4 — edit forms + policy rule-builder + role↔policy assignment + audit SDK swap + full-res zoom (§4.6).** Added create+**edit** for **roles** (`RoleFormDialog`/`updateRole`), **policies** (`PolicyFormDialog`/`update`), and **prompts** (`PromptFormDialog`/`update` → new version via OCC). Replaced the policy CASL JSON textarea with a **visual rule-builder** (action/subject/conditions/fields, vocab from `knowledge/04_ACCESS_CONTROL.md`) + validated-JSON fallback, both calling server `validate()`. Added a **role↔policy assignment drawer** (`assignPolicy`/`removePolicy` + `policies[]` via local `RoleWithPolicies`). **Swapped the audit grid to `useAuditLog().listByCursor`** and **deleted** the dead local endpoint constant + query-builder (identical `AsyncCollection` behavior). Added the one permitted **additive `@arcaai/ui`** change — `TimelineImage.zoomSrc` + `ImageGallery` lightbox swap — and bound mapper grid `src=thumbnailUrl`, `zoomSrc=url`. **No raw-`apiClient` stopgaps** (all SDK methods existed). **47 admin tests** (+10) + **21 `@arcaai/ui` timeline tests** pass; build `8/8` green; lint 0 errors; the only new `tsc` errors I introduced (4, in `roles.tsx`) were fixed, remaining `tsc`/prettier noise is pre-existing & app-wide (§5.2). | `apps/admin/src/features/roles/{policy-rules.ts,policy-rules-editor.tsx,policy-form-dialog.tsx,role-form-dialog.tsx,role-policies-sheet.tsx,types.ts,__tests__/policy-rules.test.ts}`, `apps/admin/src/routes/_authenticated/{roles,departments}.tsx`, `apps/admin/src/features/audit-log/{use-audit-log-cursor.ts,audit-cursor-query.ts,__tests__/audit-cursor-query.test.ts}`, `apps/admin/src/features/history/map-context-item.ts`, `packages/ui/src/components/timeline/{types.ts,__tests__/timeline.vitest.tsx}`, `packages/ui/src/components/registries/tool-ui/image-gallery/{schema.ts,context.tsx}` |
| 2026-06-27 | **Round 6 — fixed the two live-E2E defects (DEFECT-P1, DEFECT-F1) TDD RED→GREEN; surgical, no schema change.** **P1 (this ticket / frontend):** `toUserListQuery` now translates the grid's 0-based offset `page` to the backend's 1-based `page` (`page = pagination.page + 1`) — the single Users-only offset path (Tenants client-mode, Audit cursor-based); the grid stays driven by its own 0-based `queryState`/`rowCount`, so the echoed 1-based `page` never desyncs the view (chose the admin mapper over `@arcaai/ui`'s `toPaginatedQuery`, which is a shared 0-based serializer that other consumers rely on). **F1 (backend — authoritative entry in TASK-375 §8):** targeted opt-in `booleanFields` coercion in `deserializeFilterString`, wired via the Users service (`isServiceAccount`). **Evidence (real output):** admin `user-query.test.ts` **5/5** (RED w/o `+1` → 5 fail `page 0` vs `1`); `@arcaai/applications` converter + user-service **51/51** (RED w/o coercion → 4 fail string vs bool); Turbo build **16/16** (applications + admin + api); `ReadLints` clean; live Playwright `task-375-admin-features.spec.ts` **extended** with a **P1** (pages 0→1 distinct) + **F1** (boolean 200 / narrows / true+false partition the set) test → **9 passed / 1 skipped** against `:8868`. DEFECT-P1 & DEFECT-F1 marked **FIXED** (§5.6 DEFECTS). | `apps/admin/src/features/users/{user-query.ts,__tests__/user-query.test.ts}`, `packages/applications/src/common/{paginatedQueryParamConverters.ts,paginatedQueryParamConverters.test.ts}`, `packages/applications/src/services/user/user/{user.service.ts,__tests__/user.service.test.ts}`, `apps/api/tests/e2e/task-375-admin-features.spec.ts` |
