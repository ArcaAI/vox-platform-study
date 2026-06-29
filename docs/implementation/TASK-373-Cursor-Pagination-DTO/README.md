# TASK-373 — Generic Cursor Pagination DTO (Backend)

| | |
|---|---|
| **Ticket** | TASK-373 |
| **Type** | Infrastructure / Backend (DTO contract) |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Status** | Completed |
| **Owner** | Backend / Platform |
| **Spawned by** | [TASK-372 — Shared Component System](../TASK-372-Shared-Component-System/README.md) (decision D7) |

> **Scoped & implemented 2026-06-27.** A generic, opt-in **cursor (keyset) pagination** contract now ships server-side, with the **Audit Log** admin list as the reference consumer (`GET /admin/audit-logs/cursor`). The offset contract is untouched (backward compatible). A second, clearly-labelled change registers the **`ui.data-grid`** user-settings namespace in support of TASK-372 D8 — see [§5](#5-related-backend-change-uidata-grid-settings-namespace-supports-task-372-d8). **No schema migration was required** (see [§1.6](#16-current-state-evaluation--migration-decision)).

---

## 1. Requirement Analysis

### 1.1 Description

The HOPE backend currently exposes **offset-only** pagination. Every list endpoint returns the envelope `{ data: T[]; count: number; page: number; limit: number }` — via the abstract `PaginatedResponse<T>` (`packages/applications/src/common/dto/paginated.response.ts`) or bespoke standalone classes (`PaginatedContextItemResponse`, `PaginatedConsultationResponse`). The request contract is `PaginatedQuery` (`packages/applications/src/common/dto/paginated.query.ts`): `page` (0-based), `limit`, `search`, `searchFields`, `filters`, `sort`.

**There is no cursor-based pagination anywhere** — verified during TASK-372 (no `nextCursor` / `hasNextPage` / `endCursor` / `cursor` field in any DTO). For very large, append-mostly datasets (Audit Log; potentially consultation/context-item history) offset pagination degrades (deep-offset `OFFSET n` scans, drift when rows are inserted between page fetches). A generic, opt-in **cursor pagination contract** would let `VirtualizedDataGrid` and `HistoryTimelineList` use stable forward-only "load more" against large tables.

### 1.2 Business context

TASK-372's `VirtualizedDataGrid` is being built with a `pageMode: 'offset' | 'cursor'` API, but its cursor mode is **inert** today because no endpoint emits a cursor. This ticket would make cursor mode real for the high-volume surfaces (Audit Log first).

### 1.3 Proposed contract (to be refined)

- **Request:** extend or complement `PaginatedQuery` with `cursor?: string` + `limit` (keep `filters`/`sort`/`search`); when `cursor` is present, ignore `page`.
- **Response:** a generic `CursorPaginatedResponse<T>` — e.g. `{ data: T[]; nextCursor: string | null; hasMore: boolean; limit: number }`. The cursor is an opaque, signed/encoded keyset token (e.g. base64 of `{ sortKey, id }`), **not** a raw offset.
- **Keyset basis:** order by a stable, indexed tuple (e.g. `createdAt DESC, id DESC`) so the cursor is deterministic under concurrent inserts.
- **Alignment:** the client side already models this — `@arcaai/ui` `lib/shared/pagination.ts` defines `CursorPageRequest { mode: 'cursor'; cursor; limit }` and `PageResult<T> { …, nextCursor }` (TASK-372 §3.1.4). This ticket implements the matching server half.

### 1.4 Acceptance criteria (draft)

1. A reusable `CursorPaginatedResponse<T>` DTO in `packages/applications/src/common/dto/`.
2. A reusable cursor request mixin/field compatible with existing `PaginatedQuery` consumers.
3. Opaque, tamper-resistant cursor encoding (no raw offsets/PII leaked).
4. At least one real consumer migrated as the reference implementation (**recommended: Audit Log** — `/admin/audit-logs`).
5. SDK support: `@arcaai/vox` normalizer (`extractPaginated` sibling, e.g. `extractCursorPaginated`) maps the response to the client `PageResult<T>` cursor shape.
6. Backward compatible — offset endpoints unchanged; cursor is opt-in per endpoint.

### 1.5 Dependencies & links

- **Consumer:** [TASK-372 §3.1.4 / §3.4 / §3.7](../TASK-372-Shared-Component-System/README.md) — `VirtualizedDataGrid` cursor mode + `lib/shared/pagination.ts`.
- **Touch points:** `packages/applications/src/common/dto/`, the chosen consumer service (Audit Log), `packages/agentic-sdk-v2/src/utils/responseUtils.ts` (+ `urlUtils.ts`).

### 1.6 Current State Evaluation & migration decision

Grounded by direct reads of the offset stack and the audit-log slice.

| Area | Finding |
|---|---|
| Offset request | `PaginatedQuery` (`packages/applications/src/common/dto/paginated.query.ts`) — `page`(0-based)/`limit`/`search`/`searchFields`/`filters`/`sort`. |
| Offset response | `Paginated<T>` + abstract `PaginatedResponse<T>` (`…/common/dto/paginated.response.ts`) — `{ data, count, page, limit }`. |
| Offset helpers | `withFormattedPaginatedProps` / `withFormattedCountProps` (`…/common/paginatedQueryParamConverters.ts`) → `IFindAllProps`; `FetchResponse<T>` service envelope. |
| Repository | Base `Repository.findAll(props: IFindAllProps)` already accepts `where` + `sort` + `limit` + `page`; `formatFindAllProps` (`packages/domains/src/common/repository.helpers.ts`) turns those into Prisma `{ skip, take, where, orderBy }`. Soft-delete is filtered by the extended Prisma client; tenant scope is applied by each service's `where` builder. |
| Audit slice | `AuditLogService.fetchAllFiltered` (`…/services/auditLog/auditLog.service.ts`) builds `where = buildTenantWhere(buildAuditFilterWhere(props))`, runs `findAll` + `count` in parallel, and resolves `responsibleUserId → label` once per page (no N+1). Controller `GET /admin/audit-logs` (`apps/api/src/modules/audit-log/audit-log.controller.ts`) maps via `AuditLogDtoMapper.ToPaginatedResponse`. |
| **AuditLog table** | `id String @id @default(uuid(7))` (**time-ordered** uuid v7), `createdAt DateTime @default(now())`, and indexes `@@index([createdAt])` **and `@@index([tenantId, createdAt])`** already exist (`packages/database/src/prisma/db_main/audit.prisma`). |

**→ Migration decision: NONE required.** Keyset pagination orders by the stable, already-indexed tuple **`(createdAt DESC, id DESC)`**. Because `id` is uuid v7 (lexicographically time-ordered), `(createdAt, id)` is monotonic and deterministic under concurrent inserts, and the existing `[tenantId, createdAt]` index serves the tenant-scoped keyset. This is a **query-level** change only — no new column, no new index, no `prisma migrate`. (Per the task constraint, no destructive/DB-migration command was run.)

**Layering note:** the base `Repository` already supports everything keyset needs (`where`/`sort`/`limit`), and project rule [`03-domain-layer`](../../../.cursor/rules/03-domain-layer.mdc) forbids editing `packages/domains/src/common/` base classes without review. So the cursor machinery is the symmetric counterpart of the **application** offset helpers and lives beside them (`packages/applications/src/common/`); the keyset query flows through the existing repository `findAll`. The domain package is rebuilt to prove no regression, but needs no source change.

---

## 2. Implementation Plan

### 2.1 Design — generic cursor (keyset) contract

- **Request:** `CursorQuery` (`cursor?: string`, `limit?: number`) — the symmetric counterpart of `PaginatedQuery`. When `cursor` is present `page` is irrelevant (the endpoint doesn't accept it).
- **Response:** generic `CursorPaginatedResponse<T>` → **`{ data: T[]; nextCursor: string | null; hasMore: boolean; limit: number }`** (matches §1.3 and the client `PageResult` `nextCursor`/`hasMore` half; the backend keeps `data` as the array key, exactly like `PaginatedResponse<T>`).
- **Cursor token:** opaque, tamper-evident **base64url(JSON `{ k, id }`)** where `k` = the sort-key value (here `createdAt` ISO) and `id` = the uuid tiebreaker. Decoding validates the shape and returns `null` on any malformed/garbage token → the service raises `BadRequestException('Invalid cursor')`. No raw offsets or PII are encoded.
- **Keyset predicate** (DESC): `OR[ { createdAt: { lt: k } }, { AND[ { createdAt: k }, { id: { lt: id } } ] } ]`, fetch `limit + 1` rows to detect `hasMore`, `nextCursor` = encode of the last returned row.

### 2.2 Generic engine (`packages/applications/src/common/cursorPagination.ts`)

- `encodeCursor` / `decodeCursor` (base64url JSON, shape-validated).
- `clampCursorLimit(limit)` → default `DEFAULT_CURSOR_LIMIT` (10, aligned with `DEFAULT_PAGE_SIZE`), max `MAX_CURSOR_LIMIT` (100).
- `buildCursorFindAllProps(cursor, limit, { where, sortKey='createdAt', direction='desc' })` → `IFindAllProps` with `page:1` (skip 0), `limit+1`, `sort:[{sortKey:dir},{id:dir}]`, and the keyset `where` (composed with the caller's tenant/filter `where` via `AND`).
- `toCursorPage(rows, limit, getSortKey)` → slices to `limit`, computes `hasMore`, builds `nextCursor`; returns the `CursorPage<T>` envelope (`{ data, nextCursor, hasMore, limit }`).

### 2.3 Reference consumer — Audit Log (Domain → Application → API)

- **Application:** `AuditLogService.fetchPageByCursor(props: CursorQuery & AuditLogFilters)` reuses `buildTenantWhere` + `buildAuditFilterWhere` (so tenant scoping / SUPER_ADMIN bypass / filters are identical to the offset path), runs `findAll(buildCursorFindAllProps(...))`, maps via `toCursorPage`, and resolves responsible users for the returned page. `IAuditLogService` gains the method + `CursorFilteredAuditLogResult`. `AuditLogDtoMapper.ToCursorResponse(...)` → `CursorPaginatedAuditLogResponse`.
- **API:** new `GET /admin/audit-logs/cursor` (declared before `/:id`), same `@CanRead('AuditLog')` + tenant-context guard as `fetchAll`, accepts `AuditLogCursorQuery` (`CursorQuery` + the A8 filters), returns `CursorPaginatedAuditLogResponse`. The existing offset routes are untouched (cursor is opt-in per endpoint).

### 2.4 TDD test list

- **Engine** (`common/__tests__/cursorPagination.test.ts`): encode→decode round-trip; tampered/garbage token → `null`; `buildCursorFindAllProps` emits `limit+1`, the `(createdAt,id)` sort tuple, and the keyset `OR` only when a cursor is supplied (first page omits it); `toCursorPage` → `hasMore` + sliced `data` + `nextCursor` when over-fetched, and `nextCursor:null`/`hasMore:false` on the last page; `clampCursorLimit` default + max clamp.
- **Service** (`services/auditLog/__tests__/auditLog.service.cursor.test.ts`): over-fetch (`limit+1` rows) → `hasMore:true` + non-null `nextCursor`; exact/under page → `hasMore:false` + `nextCursor:null`; tenant `where` applied (non-super-admin scoped, missing tenant throws); invalid cursor → `BadRequestException`; `responsibleUsers` resolved for the page.
- **Mapper**: `ToCursorResponse` maps entities → `AuditLogResponse[]` and preserves `nextCursor`/`hasMore`/`limit` (covered in the service/mapper suite).
- **API** (`apps/api/.../audit-log.controller.test.ts`): cursor route forwards `cursor`/`limit`/filters to `fetchPageByCursor`; rejects non-super-admin without tenant context; super-admin without tenant allowed.

### 2.5 Files

**New (application):** `common/cursorPagination.ts`, `common/dto/cursor.query.ts`, `common/dto/cursorPaginated.response.ts`, `services/auditLog/dto/cursorPaginatedAuditLog.response.ts`, `services/auditLog/dto/auditLogCursor.query.ts` + the two test files above.
**Modified (application):** `common/index.ts`, `common/dto/index.ts`, `services/auditLog/dto/index.ts`, `services/auditLog/IAuditLogService.ts`, `services/auditLog/auditLog.service.ts`, `services/auditLog/auditLog.dto.mapper.ts`.
**Modified (api):** `modules/audit-log/audit-log.controller.ts` (+ controller test).
**Change #2:** see [§5](#5-related-backend-change-uidata-grid-settings-namespace-supports-task-372-d8).

---

## 3. Implementation Summary

Built TDD (RED→GREEN) in layer order **Application → API** (the Domain layer needed **no source change** — see [§1.6](#16-current-state-evaluation--migration-decision)).

### 3.1 What shipped

1. **Generic cursor (keyset) engine** — `packages/applications/src/common/cursorPagination.ts`. Transport-agnostic primitives: `encodeCursor`/`decodeCursor` (opaque, shape-validated base64url JSON `{ k, id }`), `clampCursorLimit` (`DEFAULT_CURSOR_LIMIT=10`, `MAX_CURSOR_LIMIT=100`), `buildCursorFindAllProps` (emits an `IFindAllProps` over-fetching `limit+1`, sorting `(createdAt, id)` and composing the keyset predicate with the caller's `where` via `AND`), and `toCursorPage` (slices, derives `hasMore`, encodes `nextCursor`).
2. **Generic DTOs** — `CursorQuery` (`cursor?`, `limit?`) and the abstract `CursorPaginatedResponse<T>` (`{ data, nextCursor, hasMore, limit }`), the symmetric counterparts of `PaginatedQuery` / `PaginatedResponse<T>`.
3. **Reference consumer — Audit Log:**
   - `AuditLogService.fetchPageByCursor(props: CursorQuery & AuditLogFilters)` reuses the **same** `buildTenantWhere(buildAuditFilterWhere(...))` scope+filter builder as the offset path (identical tenant isolation, SUPER_ADMIN bypass, A8 filters), then keyset-orders, over-fetches, and resolves the page's responsible users in one batch (no N+1). Count-free by design.
   - `AuditLogDtoMapper.ToCursorResponse(...)` → `CursorPaginatedAuditLogResponse`; `AuditLogCursorQuery` carries the A8 filters on top of `CursorQuery`.
   - **API:** `GET /admin/audit-logs/cursor` — declared before `/:id`, same `@CanRead('AuditLog')` + tenant-context guard as the offset list. Offset routes untouched (cursor is opt-in per endpoint).

### 3.2 Endpoints

| Method | Path | Query | Response | Notes |
|---|---|---|---|---|
| GET | `/admin/audit-logs/cursor` | `cursor?`, `limit?` (1–100, clamped), `from`/`to`/`action`/`resourceType`/`userId`, **`filters?` (CSV, added 2026-06-27 — see [§6](#6-change-history))** | `CursorPaginatedAuditLogResponse` (`data`, `nextCursor`, `hasMore`, `limit`) | New. Keyset `(createdAt,id)` DESC. `400` on malformed cursor; `403` when a non-super-admin has no tenant context. CSV `filters` are model-aware coerced (`'AuditLog'`), identical to the offset list. |
| GET | `/admin/audit-logs` | *(unchanged)* | `PaginatedAuditLogResponse` | Offset path left intact (backward compatible). |

### 3.3 Migration

**None.** Pure query-level change reusing the existing `(createdAt)` / `(tenantId, createdAt)` indexes and the uuid-v7 `id` tiebreaker. **No `prisma migrate`, and no DELETE/DROP/TRUNCATE or any destructive DB command was run** (per the task constraint).

### 3.4 Deviations

- **No Domain-layer change.** The base `Repository.findAll` already accepts `where`/`sort`/`limit`, so the keyset query flows through it unchanged; the cursor machinery lives beside the offset helpers in the **application** common layer (consistent with the layering rule that forbids editing domain base classes without review).
- **SDK client normalizer deferred.** Draft AC-5 (`@arcaai/vox` `extractCursorPaginated`) is **out of scope for this backend ticket** — the server half now exists and matches the client `PageResult` `nextCursor`/`hasMore` shape; wiring the SDK consumer belongs with the TASK-372 client work. Tracked as a follow-up.
- **Separate endpoint** (`/cursor`) rather than overloading the offset route, so the two contracts stay unambiguous and the offset response is never broken.

---

## 4. Verification (evidence)

All commands run with `zsh` from the repo root on 2026-06-27.

### 4.1 Unit tests (TDD)

New suites (RED first, then GREEN):

| Suite | File | Result |
|---|---|---|
| Cursor engine | `packages/applications/src/common/__tests__/cursorPagination.test.ts` | **11 passed** |
| Audit-log cursor service | `packages/applications/src/services/auditLog/__tests__/auditLog.service.cursor.test.ts` | **10 passed** |
| Settings namespace registry | `packages/applications/src/services/user/userSettings/__tests__/userSettings.namespaces.test.ts` | **3 passed** |
| Audit-log controller (cursor) | `apps/api/src/modules/audit-log/__tests__/audit-log.controller.test.ts` | **18 passed** (4 new + 14 existing) |
| User-settings controller (`ui.data-grid`) | `apps/api/src/modules/user/controllers/__tests__/user-settings.controller.test.ts` | **8 passed** (3 new + 5 existing) |

Full package suites (regression):

```
@arcaai/applications  Test Files 239 passed | 1 skipped (240)   Tests 5352 passed | 4 skipped (5356)
@arcaai/api           Test Files 102 passed | 2 skipped (104)   Tests 1815 passed | 4 skipped (1819)
```

### 4.2 Builds

```
pnpm --filter @arcaai/domains build        # tsc — OK
pnpm --filter @arcaai/applications build    # rimraf dist && tsc — OK
pnpm build:api                              # turbo … @arcaai/api^...  → 8 successful, 8 total (incl. nest build + tsc-alias)
```

### 4.3 Lint

`ReadLints` on every created/modified `.ts` file (engine, DTOs, service, mapper, interface, both controllers, and all new test files) → **No linter errors found.**

---

## 5. Related backend change — `ui.data-grid` settings namespace (supports TASK-372 D8)

A small, **independent** change so the new `VirtualizedDataGrid` can persist per-user layout (column order/size/visibility/pinning/density) through the **existing** user-settings endpoints — kept here (out of TASK-372) to avoid doc collisions with parallel workers.

### 5.1 Finding (premise correction)

The task brief assumed "the settings service currently **restricts** allowed namespaces." **It does not.** `PATCH /user/me/settings/:namespace/:key` is **open** to any namespace — the controller only special-validates the *value* of `arcaai-sdk:selectedPipelineId`, and the SDK `useUserSettings` hook lets clients pass arbitrary namespaces. So `ui.data-grid` already round-trips today, and adding a **strict rejecting allow-list would be a breaking change** for existing clients (`arcaai-sdk`, `arcaai-admin`, and any undocumented client namespaces).

### 5.2 What shipped (non-breaking)

1. **Namespace registry** — `packages/applications/src/services/user/userSettings/userSettings.namespaces.ts`: `USER_SETTINGS_NAMESPACES` (`SDK='arcaai-sdk'`, `ADMIN='arcaai-admin'`, `UI_DATA_GRID='ui.data-grid'`), `KNOWN_USER_SETTINGS_NAMESPACES`, `isKnownUserSettingsNamespace()`, and `UI_DATA_GRID_MAX_BYTES` (16 KiB). This is a single source of truth (recognition registry), **not** a rejecting allow-list — the endpoint stays open.
2. **Targeted value validation** — `UserSettingsController.validateSettingValue` now guards the `ui.data-grid` namespace: the value must be **valid JSON** and within `UI_DATA_GRID_MAX_BYTES` (respects "existing validation/limits"). Other namespaces are unchanged; `arcaai-sdk:selectedPipelineId` validation is preserved.

### 5.3 Round-trip & limits (verified)

- `PATCH /user/me/settings/ui.data-grid/:key` with a valid JSON layout → persists via `upsertByUserKeyNamespace` (the pipeline validator does **not** fire). `GET /user/me/settings` returns it via the existing list path.
- Non-JSON value → `400 BadRequestException`; oversized value (> 16 KiB) → `400`. Service never invoked in either rejection.

### 5.4 Files

**New:** `packages/applications/src/services/user/userSettings/userSettings.namespaces.ts` (+ `__tests__/userSettings.namespaces.test.ts`).
**Modified:** `packages/applications/src/services/user/userSettings/index.ts` (barrel), `apps/api/src/modules/user/controllers/user-settings.controller.ts` (+ controller test).
**Schema:** none.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Stub created from TASK-372 decision D7 (generic cursor pagination dependency). Status = Pending. | `README.md` |
| 2026-06-27 | Implemented generic cursor (keyset) engine + DTOs; wired `GET /admin/audit-logs/cursor` reference endpoint; registered `ui.data-grid` settings namespace with value validation (D8). TDD; full builds + suites green; no migration. Status = Completed. | engine/DTOs/service/mapper/controller + tests (see §2.5, §5.4) |
| 2026-06-27 | **Cursor-path filter coercion parity (resolves TASK-375 §8 follow-up (3)).** Added optional `filters?: string` (CSV) to `CursorQuery` (symmetric with `PaginatedQuery.filters`); `AuditLogService.fetchPageByCursor` now threads it through `deserializeFilterString(props.filters, 'AuditLog')` and passes the coerced map as a **separate** `filters` prop, so `Repository.findAll` AND-composes it with the keyset/tenant `where` — boolean/number/date/**enum** now coerce identically to the offset path. Back-compatible: no `filters` ⇒ `filters` prop `undefined` (unchanged). No schema change / no destructive DB op. Verified: changed-layer **72 passed (4 files)**, full `@arcaai/applications` **5406 passed \| 4 skipped**, `pnpm build:api` **8/8**, `ReadLints` clean. See [TASK-375 §8 Change History](../TASK-375-Admin-Backend-Enhancements/README.md#8-change-history). | `common/dto/cursor.query.ts`, `services/auditLog/auditLog.service.ts`, `common/modelFilterTypes.ts`, `common/paginatedQueryParamConverters.ts` + cursor-service & converter tests |
