# TASK-373 — Generic Cursor Pagination DTO (Backend)

| | |
|---|---|
| **Ticket** | TASK-373 |
| **Type** | Infrastructure / Backend (DTO contract) |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
| **Status** | Pending |
| **Owner** | Backend / Platform |
| **Spawned by** | [TASK-372 — Shared Component System](../TASK-372-Shared-Component-System/README.md) (decision D7) |

> **Stub ticket.** Created to capture a dependency surfaced while planning TASK-372's `VirtualizedDataGrid`. Not yet scoped for implementation — Requirement Analysis only. Do **not** start work until prioritized.

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

---

## 2. Implementation Plan

> _Not yet scoped. To be authored when prioritized._

## 3. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Stub created from TASK-372 decision D7 (generic cursor pagination dependency). Status = Pending. | `README.md` |
