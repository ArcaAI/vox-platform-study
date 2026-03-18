# Agentic SDK V2 — Pagination

Comprehensive reference for how pagination works across the full stack: SDK types and utilities, API gateway, application services, domain repositories, and React UI integration.

## Table of Contents

- [Overview](#overview)
- [Constants and Defaults](#constants-and-defaults)
- [SDK Types](#sdk-types)
- [SDK Utilities](#sdk-utilities)
- [SDK Hooks](#sdk-hooks)
- [Backend: API Gateway](#backend-api-gateway)
- [Backend: Application Services](#backend-application-services)
- [Backend: Domain Repositories](#backend-domain-repositories)
- [Full-Stack Data Flow](#full-stack-data-flow)
- [React UI Integration](#react-ui-integration)
- [Adding Pagination to a New Hook](#adding-pagination-to-a-new-hook)
- [Known Constraints and Decisions](#known-constraints-and-decisions)

---

## Overview

Pagination in the HOPE stack uses **page-based** (not cursor-based) pagination with a **1-based page number** at the SDK layer. The API supports three page sizes: **10**, **20**, and **50**, with **10** as the default.

The architecture follows **server-side pagination**: the UI tells the server which page and page size it wants, the server returns that slice plus a total count, and the UI renders pagination controls based on the total.

### Key Principles

1. **Server does the slicing** — the UI never fetches all records and paginates in memory.
2. **Total count travels with every response** — enables accurate page count and "Showing X–Y of Z" display.
3. **Constants are defined once** — `DEFAULT_PAGE_SIZE` and `PAGE_SIZE_OPTIONS` are exported from the SDK and reused by both hooks and UI components.

---

## Constants and Defaults

### SDK (`packages/agentic-sdk-v2/src/types/common.ts`)

```typescript
type AllowedPageSize = 10 | 20 | 50;

const PAGE_SIZE_OPTIONS: readonly AllowedPageSize[] = [10, 20, 50] as const;

const DEFAULT_PAGE_SIZE: AllowedPageSize = 10;
```

### Backend (`packages/applications/src/common/paginatedQueryParamConverters.ts`)

```typescript
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
```

### Imports

```typescript
// From the SDK (React apps)
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@arcaai/vox';
import type { AllowedPageSize, PaginationParams, PaginatedResponse } from '@arcaai/vox';
```

---

## SDK Types

### `PaginationParams` — what the caller sends

| Field   | Type                       | Default | Description                    |
|---------|----------------------------|---------|--------------------------------|
| `page`  | `number` (optional)        | —       | 1-based page number            |
| `limit` | `AllowedPageSize \| number` (optional) | `10`    | Items per page |

```typescript
interface PaginationParams {
  page?: number;
  limit?: AllowedPageSize | number;
}
```

### `PaginatedResponse<T>` — what the SDK returns

| Field        | Type      | Description                              |
|--------------|-----------|------------------------------------------|
| `data`       | `T[]`     | Items for the current page               |
| `total`      | `number`  | Total item count across all pages        |
| `page`       | `number`  | Current page number (1-based)            |
| `limit`      | `number`  | Items per page used for this request     |
| `totalPages` | `number`  | `Math.ceil(total / limit)`               |
| `hasMore`    | `boolean` | `page < totalPages`                      |

```typescript
interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}
```

---

## SDK Utilities

### `appendPagination(url, pagination?)` — URL builder

Location: `packages/agentic-sdk-v2/src/utils/urlUtils.ts`

Appends `page` and `limit` query parameters to a URL. When `limit` is omitted, `DEFAULT_PAGE_SIZE` (10) is always applied.

```typescript
appendPagination('/users', { page: 2, limit: 20 })
// → '/users?page=2&limit=20'

appendPagination('/users', { page: 1 })
// → '/users?page=1&limit=10'    (default limit applied)

appendPagination('/users', {})
// → '/users?limit=10'            (default limit applied)

appendPagination('/users')
// → '/users'                     (no pagination object = no params)
```

### `extractArray<T>(raw)` — array-only extraction

Location: `packages/agentic-sdk-v2/src/utils/responseUtils.ts`

Extracts just the data array from an API response, discarding metadata. Use when you only need the items and don't need pagination controls.

Checks in order: raw array → `{ data: T[] }` → `{ items: T[] }` → `{ results: T[] }`.

### `extractPaginated<T>(raw)` — full pagination extraction

Location: `packages/agentic-sdk-v2/src/utils/responseUtils.ts`

Normalises the API response `{ data, count, limit, page }` into the SDK's `PaginatedResponse<T>` shape. Computes `totalPages` and `hasMore` from the raw values.

```typescript
// API returns: { data: [...], count: 47, limit: 10, page: 1 }
const result = extractPaginated<User>(apiResponse);
// → { data: [...], total: 47, page: 1, limit: 10, totalPages: 5, hasMore: true }
```

Field mapping from backend to SDK:

| Backend field | SDK field    | Notes                                  |
|---------------|--------------|----------------------------------------|
| `count`       | `total`      | Falls back to `total` then `data.length` |
| `limit`       | `limit`      | Falls back to `DEFAULT_PAGE_SIZE`      |
| `page`        | `page`       | Falls back to `1`                      |
| —             | `totalPages` | Computed: `Math.ceil(total / limit)`   |
| —             | `hasMore`    | Computed: `page < totalPages`          |

---

## SDK Hooks

### Pattern: `list()` vs `listPaginated()`

Each resource hook provides two list methods:

| Method           | Returns                    | Use Case                                    |
|------------------|----------------------------|---------------------------------------------|
| `list()`         | `Promise<T[]>`             | Simple lists, dropdowns, no pagination UI   |
| `listPaginated()`| `Promise<PaginatedResponse<T>>` | Tables with pagination controls        |

Example from `useUsers`:

```typescript
// Simple — just get the array
const users = await list({ page: 1, limit: 50 });

// Paginated — get total count for pagination controls
const result = await listPaginated({ page: 1, limit: 10 });
// result.data       → User[]
// result.total      → 47
// result.totalPages → 5
// result.hasMore    → true
```

### Hooks with pagination support

| Hook              | `list()` | `listPaginated()` | Resource     |
|-------------------|----------|--------------------|--------------|
| `useUsers`        | Yes      | Yes                | Users        |
| `useTenants`      | Yes      | —                  | Tenants      |
| `useApiKeys`      | Yes      | —                  | API Keys     |
| `useRoles`        | Yes      | —                  | Roles        |
| `usePolicies`     | Yes      | —                  | RBAC Policies|
| `useAuditLog`     | Yes      | —                  | Audit Logs   |
| `usePipelines`    | Yes      | —                  | ASR Pipelines|
| `useAiModels`     | Yes      | —                  | AI Models    |

> **Note:** `listPaginated()` is currently implemented on `useUsers`. Other hooks can be upgraded following the same pattern (see [Adding Pagination to a New Hook](#adding-pagination-to-a-new-hook)).

---

## Backend: API Gateway

### `PaginatedQuery` DTO

Location: `packages/applications/src/common/dto/paginated.query.ts`

The NestJS DTO that validates incoming query parameters:

| Parameter      | Type     | Default | Description                                    |
|----------------|----------|---------|------------------------------------------------|
| `page`         | `number` | `0`     | Page number (0-based at the API layer)         |
| `limit`        | `number` | `10`    | Items per page (10, 20, or 50)                 |
| `search`       | `string` | `''`    | Free-text search query                         |
| `searchFields` | `string` | `''`    | Comma-separated field names to search          |
| `filters`      | `string` | `''`    | Structured filter string                       |
| `sort`         | `string` | `''`    | Comma-separated `field:direction` pairs        |

### `PaginatedResponse<T>` (API response shape)

Location: `packages/applications/src/common/dto/paginated.response.ts`

```json
{
  "data": [ ... ],
  "count": 47,
  "limit": 10,
  "page": 1
}
```

| Field   | Type     | Description                    |
|---------|----------|--------------------------------|
| `data`  | `T[]`    | Items for the current page     |
| `count` | `number` | Total item count               |
| `limit` | `number` | Items per page                 |
| `page`  | `number` | Current page number            |

---

## Backend: Application Services

### Query parameter conversion

Location: `packages/applications/src/common/paginatedQueryParamConverters.ts`

`withFormattedPaginatedProps(query)` converts the API's `PaginatedQuery` into the domain layer's `IFindAllProps`:

```typescript
// Input:  { page: 1, limit: 10, search: 'john', searchFields: 'name,email' }
// Output: { page: 1, limit: 10, search: 'john', searchFields: ['name', 'email'] }
```

Default values applied when fields are missing:
- `page` → `0`
- `limit` → `DEFAULT_PAGE_SIZE` (10)

### Service layer pattern

Every service that supports listing follows this pattern:

```typescript
async fetchAll(props: PaginatedQuery): Promise<FetchResponse<Entity>> {
    const items = await this.repository.findAll(
        withFormattedPaginatedProps(props)
    );
    const count = await this.repository.count(
        withFormattedCountProps(props)
    );
    return new FetchResponse({ data: items, count, limit: props.limit, page: props.page });
}
```

The `FetchResponse` carries `data`, `count`, `limit`, and `page` — which the controller's DTO mapper converts into the API response.

---

## Backend: Domain Repositories

### `formatFindAllProps()` — Prisma query builder

Location: `packages/domains/src/common/repository.helpers.ts`

Converts `IFindAllProps` (page + limit) into Prisma's `skip` + `take`:

```typescript
skip = Math.max(0, (page - 1) * limit)
take = limit
```

The formula uses **1-based** page numbering:
- Page 1 → `skip = 0`, `take = 10`
- Page 2 → `skip = 10`, `take = 10`
- Page 3 → `skip = 20`, `take = 10`

### `repository.findAll(props)`

Location: `packages/domains/src/common/repository.ts`

```typescript
public async findAll(props: IFindAllProps<DatabaseModel>): Promise<DomainEntity[]> {
    const models = await this.db.findMany({
        ...formatFindAllProps(this.applyDefaultSearchFields(props)),
        include: this._includes,
    });
    return models.map((model) => this._mapper.toDomainEntity(model));
}
```

---

## Full-Stack Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  React UI (TanStack Table)                                          │
│  pagination.pageIndex = 0, pagination.pageSize = 10                 │
│  → calls listPaginated({ page: 1, limit: 10 })                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SDK Hook (useUsers.listPaginated)                                  │
│  → appendPagination('/users', { page: 1, limit: 10 })              │
│  → GET /users?page=1&limit=10                                       │
│  → extractPaginated(response)                                       │
│  → returns { data, total, page, limit, totalPages, hasMore }       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API Gateway (NestJS Controller)                                    │
│  @Query() queryParams: PaginatedQuery { page: 1, limit: 10 }       │
│  → calls service.fetchAll(queryParams)                              │
│  → returns { data: UserResponse[], count: 47, limit: 10, page: 1 } │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Application Service                                                │
│  → withFormattedPaginatedProps({ page: 1, limit: 10 })              │
│  → repository.findAll({ page: 1, limit: 10 })                      │
│  → repository.count(...)                                            │
│  → FetchResponse { data, count: 47, limit: 10, page: 1 }           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Domain Repository (Prisma)                                         │
│  → formatFindAllProps: skip = (1-1)*10 = 0, take = 10              │
│  → db.findMany({ skip: 0, take: 10, where: ..., orderBy: ... })   │
└─────────────────────────────────────────────────────────────────────┘
```

### Page numbering by layer

| Layer                  | Page base | Conversion                           |
|------------------------|-----------|--------------------------------------|
| React UI (TanStack)   | 0-based   | `pageIndex + 1` when calling SDK     |
| SDK (`PaginationParams`) | 1-based | Passed as-is to API query string     |
| API Gateway (`PaginatedQuery`) | 1-based | Passed through to service     |
| Domain (`formatFindAllProps`) | 1-based | `skip = (page - 1) * limit`  |

---

## React UI Integration

### Server-side pagination with TanStack Table

The correct pattern for paginated tables uses `manualPagination: true` so TanStack Table delegates page control to the server instead of slicing in memory.

```tsx
import { useUsers, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from '@arcaai/vox';
import type { PaginationState } from '@tanstack/react-table';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';

function UserTable() {
    const { listPaginated, isLoading } = useUsers();

    const [data, setData] = useState([]);
    const [totalRowCount, setTotalRowCount] = useState(0);
    const [pagination, setPagination] = useState<PaginationState>({
        pageIndex: 0,
        pageSize: DEFAULT_PAGE_SIZE,
    });

    // Fetch from server whenever page or pageSize changes
    const fetchPage = useCallback(async () => {
        const result = await listPaginated({
            page: pagination.pageIndex + 1,   // convert 0-based → 1-based
            limit: pagination.pageSize,
        });
        setData(result.data);
        setTotalRowCount(result.total);
    }, [listPaginated, pagination.pageIndex, pagination.pageSize]);

    useEffect(() => { fetchPage(); }, [fetchPage]);

    const table = useReactTable({
        data,
        columns,
        state: { pagination },
        onPaginationChange: setPagination,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,        // ← server-side pagination
        rowCount: totalRowCount,       // ← tells TanStack the real total
    });

    // table.getCanNextPage()     → true if more pages exist
    // table.getCanPreviousPage() → true if not on first page
    // table.getPageCount()       → total number of pages
    // table.nextPage()           → increments pageIndex (triggers re-fetch)
    // table.previousPage()       → decrements pageIndex
    // table.firstPage()          → sets pageIndex to 0
    // table.lastPage()           → sets pageIndex to last page
    // table.setPageSize(n)       → changes pageSize (resets to page 0)
}
```

### Page size selector

```tsx
<Select
    value={String(pagination.pageSize)}
    onValueChange={(v) => table.setPageSize(Number(v))}
>
    <SelectTrigger className="h-8 w-18">
        <SelectValue />
    </SelectTrigger>
    <SelectContent>
        {PAGE_SIZE_OPTIONS.map((size) => (
            <SelectItem key={size} value={String(size)}>
                {size}
            </SelectItem>
        ))}
    </SelectContent>
</Select>
```

### Common mistakes to avoid

| Mistake | Why it breaks | Correct approach |
|---------|---------------|------------------|
| Using `getPaginationRowModel()` with server data | Client-side slicing on an already-sliced page = 1 page | Use `manualPagination: true` |
| Using `extractArray()` for paginated tables | Discards `count` — table can't compute page count | Use `extractPaginated()` / `listPaginated()` |
| Forgetting `rowCount` | TanStack defaults to `data.length` = 1 page | Always pass `rowCount: total` |
| Sending 0-based page to SDK | SDK is 1-based; page 0 → `skip = -limit` → clamped to 0 (duplicate page 1) | `page: pageIndex + 1` |
| Fetching all records then paginating client-side | Defeats the purpose; slow on large datasets | Use server-side pagination |

---

## Adding Pagination to a New Hook

To add `listPaginated()` to an existing hook (e.g., `useTenants`):

### 1. Import the utilities

```typescript
import { extractPaginated } from '../utils/responseUtils';
import type { PaginatedResponse } from '../types/common';
```

### 2. Add the method to the return interface

```typescript
export interface UseTenantsReturn {
  // ... existing fields ...
  list: (pagination?: PaginationParams) => Promise<Tenant[]>;
  listPaginated: (pagination?: PaginationParams) => Promise<PaginatedResponse<Tenant>>;
}
```

### 3. Implement the callback

```typescript
const listPaginated = useCallback(
    (pagination?: PaginationParams) =>
        execute<PaginatedResponse<Tenant>>('listPaginated', async (client) => {
            const raw = await client.get(appendPagination(TENANT_ENDPOINTS.LIST, pagination));
            const result = extractPaginated<Tenant>(raw);
            setTenants(result.data);
            return result;
        }),
    [execute],
);
```

### 4. Add to the return object

```typescript
return {
    // ... existing fields ...
    list, listPaginated,
};
```

No backend changes are needed — the API already returns `{ data, count, limit, page }` for all paginated endpoints.

---

## Known Constraints and Decisions

### Page size is not strictly enforced server-side

The `PaginatedQuery` DTO validates `limit` as `@IsInt() @Min(1)` but does not restrict it to `[10, 20, 50]`. A client could send `limit=999`. The SDK constants serve as the recommended values; strict enforcement can be added with `@IsIn([10, 20, 50])` on the DTO if needed.

### Search bypasses server pagination

The `search()` method on hooks returns a flat array without pagination metadata. When a search query is active, the UI falls back to showing `result.length` as the total. For large result sets, search should be upgraded to return `PaginatedResponse` as well.

### Status filter is client-side

The status filter in `UserList` filters the already-fetched page in memory. This means if you filter by "Enabled" on a page of 10, you might see fewer than 10 rows. For accurate server-side filtering, pass the filter as a query parameter to the API.

### `list()` is kept for backward compatibility

The original `list()` method (returns `T[]`) is preserved so existing consumers that don't need pagination metadata aren't broken. New paginated UIs should always use `listPaginated()`.

---

## File Reference

| File | Purpose |
|------|---------|
| `packages/agentic-sdk-v2/src/types/common.ts` | `PaginationParams`, `PaginatedResponse`, `AllowedPageSize`, `DEFAULT_PAGE_SIZE`, `PAGE_SIZE_OPTIONS` |
| `packages/agentic-sdk-v2/src/utils/urlUtils.ts` | `appendPagination()` — builds query string |
| `packages/agentic-sdk-v2/src/utils/responseUtils.ts` | `extractArray()`, `extractPaginated()` — response normalisation |
| `packages/agentic-sdk-v2/src/hooks/useUsers.ts` | `list()`, `listPaginated()` — reference implementation |
| `packages/applications/src/common/dto/paginated.query.ts` | `PaginatedQuery` — NestJS request DTO |
| `packages/applications/src/common/dto/paginated.response.ts` | `PaginatedResponse` — NestJS response DTO |
| `packages/applications/src/common/paginatedQueryParamConverters.ts` | `withFormattedPaginatedProps()` — DTO → domain conversion |
| `packages/applications/src/common/fetchResponse.ts` | `FetchResponse` — service → controller transport |
| `packages/domains/src/common/repository.helpers.ts` | `formatFindAllProps()` — page/limit → skip/take |
| `packages/domains/src/common/repository.ts` | `findAll()` — Prisma query execution |
| `apps/ui-playground/src/features/playground/overview/components/user-list.tsx` | Reference UI with server-side pagination |
