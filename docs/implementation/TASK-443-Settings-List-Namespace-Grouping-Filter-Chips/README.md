# TASK-443 — Settings List: Namespace Grouping + Filter Chips

- **Status**: Pending
- **Type**: feature (shared data-grid capability + gateway faceting + admin-console wiring)
- **Owner**: admin-console + `@arcaai/ui` (data-grid) + apps/api (gateway)
- **Related**: **follow-up from TASK-439** (Settings & Secrets redesign — deferred these two list affordances); TASK-437 (redesign foundation); TASK-423 (data-grid standardization / URL query-state + bracket filter grammar); TASK-430 (cross-tenant settings listing + the proven `tenantId` faceted filter).

## Requirement Analysis

The redesigned `/settings` list (TASK-439, spec §5) called for two list affordances that shipped **deferred** because each needs a shared/backend change out of the settings feature's lane:

1. **Namespace group-header rows** inside the data grid — the list should read as sections (`general`, `secrets`, `smr`, …) with a namespace label + row count header ahead of each group's rows, instead of a flat table with a `namespace` column.
2. **Faceted filter chips** on the toolbar — **Namespace** (multi-select over the known namespaces), **Type** (`dataType`), and a **Secrets-only** toggle chip — each narrowing the server-driven result set (not a client-side view filter over the current page).

Both must survive the grid's server-driven contract: the list is paginated/sorted/filtered on the gateway (`AdminDataGrid manual={{ sorting, filtering, pagination }}`), so grouping and faceting can only reflect the rows on the current page unless the gateway participates.

### Acceptance criteria

- [ ] The grid renders namespace group-header rows (label + count) without forking `VirtualizedDataGrid`; keyboard/AT semantics and virtualization preserved.
- [ ] Namespace, Type, and Secrets-only filter chips are present on the settings toolbar and drive the gateway query (result-set changes reset to page 1, per the existing `useAdminGridParams` contract).
- [ ] Server-side faceting on `namespace`, `dataType`, and the derived secret predicate is verified against the gateway (contract test) — not a client-only filter over one page.
- [ ] axe 0 violations on the grouped grid + chips; both themes.
- [ ] Existing settings behavior (row → `DetailDrawer` via `?setting=`, Tenant column/filter from TASK-430, delete) is unchanged.

## Current State Evaluation

Verified 2026-07-08.

### Frontend — the grid + settings screen

- **The grid has no grouped-row variant.** `packages/ui/src/components/data-grid/virtualized-data-grid.tsx` renders a flat TanStack virtualizer: a single sticky header `rowgroup` (`virtualized-data-grid.tsx:332`) over one body `rowgroup` (`:353`). There is **no `groupBy` / group-header / rendered-group concept anywhere** in `packages/ui/src/components/data-grid/` (`use-data-grid.ts`, `types.ts`, `use-grid-layout.ts` — grepped clean). Group-header rows therefore require a new grid capability (a grouped-row render path or sticky group-separator rows keyed off a `groupBy` accessor), or a settings-local fork — the latter is disallowed (rule 07: never fork a primitive).
- **The faceted-filter transport already exists and is proven.** `packages/ui/src/components/data-grid/data-grid-faceted-filter.tsx` renders `select`/`multiSelect`/`boolean` chips driven by `column.meta.{variant, options}`; the settings screen already uses it for the **Tenant** `multiSelect` chip (`apps/admin-console/src/features/settings/components/settings-screen.tsx:121`, TASK-430). The chips serialize to the gateway via `AdminDataGrid` → `useAdminGridParams` → `toListParams` in `apps/admin-console/src/shared/data/grid-url-state.ts`, which emits the **bracket grammar** `field[op]:value` (`grid-url-state.ts:241-302`) into `ListParams.filters` (`apps/admin-console/src/shared/api/types.ts:18`). So adding Namespace/Type/Secrets-only chips is mostly column-`meta` wiring — **transport is not the blocker**.
- **Settings columns today** (`settings-screen.tsx:90-179`): `key` (lock icon), `namespace` (plain, `enableSorting: false`, **no filter meta**), `tenant` (TASK-430 multiSelect), `type` (`dataType`, no filter), `value`, `updatedAt`, `actions`. No grouping, no Namespace/Type/Secrets chips.
- **Client-side list API** (`apps/admin-console/src/features/settings/api/{client,types}.ts`): `listGlobalSettings(params)` → `GET admin/settings`; `GlobalSetting.namespace?: string`, `dataType: string`, `isSecret: boolean` (`types.ts:4-17`).

### Backend — the gateway list + the secret predicate

- **`GET /admin/settings` (`fetchAll`)** at `apps/api/src/modules/global-setting/global-setting.controller.ts:71-80` takes a generic `PaginatedQuery` and forwards it to `globalSettingService.fetchAll` / `fetchAllByTenantId`. The gateway's filter grammar (`packages/applications/src/common/paginatedQueryParamConverters.ts`) coerces `field[op]:value` tokens against the **generated Prisma field types** of the target model (numeric/date/**enum**/json handling; `resolveFilterFieldTypes` + `modelFilterTypes`). Enum filters validate the member against the registry allow-list or 400.
- **`namespace` and `dataType` are real columns** on the `GlobalSetting` Prisma model (`packages/database/src/prisma/db_main/globalSetting.prisma`): `namespace String?` and `dataType ValueType @default(String)` (an enum). So **Namespace and Type faceting are viable through the existing grammar** — pending confirmation that (a) the settings model's filter-field-type registry resolves `dataType`'s enum members, and (b) `fetchAll`/`fetchAllByTenantId` actually thread `queryParams.filters` into the repository `findAll` (the controller passes the whole `queryParams` through, so this is a verify-not-build step). A gateway contract/e2e test is the missing evidence — TASK-439 flagged "only `tenantId` filtering is proven today."
- **`isSecret` is NOT a column — it is a derived predicate.** `GlobalSettingDtoMapper.isSecretEntity` (`packages/applications/src/services/globalSetting/globalSetting.dto.mapper.ts:26-31`) computes it as `encryptedValue != null` **OR** `namespace === 'secrets'` **OR** `key` matches `/(secret|password|token|credential|api[_-]?key|private[_-]?key)/i`. There is no `isSecret` boolean on the model, so a **Secrets-only** chip **cannot** ride the field-filter grammar (`isSecret[equals]:true` has no column to bind). Server-side Secrets-only faceting needs a **dedicated computed predicate** — a bespoke query param (e.g. `secretsOnly=true`) resolved in the service to the same tri-condition SQL (`encryptedValue IS NOT NULL OR namespace = 'secrets' OR key ~* pattern`) — reproduced once so the list and the mapper agree.

**Delta summary**: (1) a shared grouped-row capability on `VirtualizedDataGrid` (new, `packages/ui`); (2) Namespace + Type chips = column-`meta` wiring + gateway faceting **verification** (likely already works via the generic grammar); (3) Secrets-only chip = a **new gateway predicate** (`isSecret` is not filterable as a field) + a client `secretsOnly` param that bypasses the bracket codec; (4) settings-screen wiring of all three + grouping. Tenant column/filter, row→drawer, delete all reused unchanged.

### Open items to resolve during the plan

1. **Grouping model.** Prefer a small, generic `VirtualizedDataGrid` capability — a `groupBy?: { accessor, renderHeader }` that injects non-selectable, sticky group-header virtual rows keyed off a stable sort on the group accessor — over a settings-only fork. Server-driven paging means the grid must group **within the current page**; the gateway should therefore sort by `namespace` first so groups are contiguous per page (add `namespace` as the primary implicit sort for the settings list). Alternative if the grid change is rejected in review: ship namespace as a sticky group-separator purely via a CSS/`sort` convention with no new grid API. Decide in review.
2. **Secrets-only transport.** The bracket codec (`grid-url-state.ts`) only emits field tokens; a `secretsOnly` boolean is not a column filter. Either (a) model the Secrets-only chip as a client toggle that adds a `secretsOnly=true` extra param to `ListParams` (which already allows arbitrary extras — `api/types.ts:22`) — cleanest; or (b) extend the codec with a virtual field. Recommend (a).
3. **`dataType` chip options.** Enumerate `ValueType` members for the Type chip's `options`; confirm the gateway enum-filter registry accepts them (else 400). The member list must match `enums.prisma`'s `ValueType`.

## Implementation Plan

TDD; layer order per rule 01: gateway faceting first (it unblocks real verification), then the shared grid capability, then admin-console wiring.

### 1. Gateway — verify + extend settings faceting (`apps/api` + `packages/applications`)

- **Verify** `namespace` + `dataType` filter through `fetchAll`/`fetchAllByTenantId` end to end: add a controller e2e (`apps/api/tests/e2e/`) asserting `GET /admin/settings?filters=namespace[in]:secrets|smr` and `?filters=dataType[equals]:Json` narrow the result set. If the filter-field-type registry doesn't resolve `GlobalSetting.dataType` enum members, register it (TASK-406 pattern) so an invalid member 400s rather than 500s.
- **Add the Secrets-only predicate**: a `secretsOnly` query flag on the settings list (application service) resolving to `encryptedValue IS NOT NULL OR namespace = 'secrets' OR key ~* <pattern>` — the exact tri-condition of `isSecretEntity`. Keep the predicate in ONE place (share a constant/helper with `globalSetting.dto.mapper.ts` so the list and the mask never diverge). Tests: secrets-only returns encrypted rows + convention-named rows; excludes plain rows.
- Cross-tenant posture unchanged (the tenant-scope extension is the backstop).

### 2. Shared grid — grouped-row capability (`packages/ui/src/components/data-grid`)

- Per Open-item 1: add an optional `groupBy` to `VirtualizedDataGridProps` that injects sticky, non-interactive group-header rows (label + count) between contiguous groups, integrated with the virtualizer's `estimateRowHeight`/measurement. No behavior change when `groupBy` is omitted.
- Accessibility: group headers are `role="row"` separators with an accessible name; not selectable, not part of the row tab sequence; sr-only "group, N items".
- Stories + tests (`packages/ui`): grouping renders headers + counts; virtualization intact; axe clean; ungrouped grids unaffected.

### 3. admin-console — wire chips + grouping (`features/settings`)

- Add `meta.{variant:'multiSelect', options}` to the `namespace` and `type` columns; add a **Secrets-only** toggle chip (boolean) mapped to the `secretsOnly` extra param (Open-item 2). Namespace options come from the known namespaces (static list or a light distinct-namespaces read — decide in review); Type options from `ValueType`.
- Pass `groupBy={{ accessor: 'namespace', … }}` to `AdminDataGrid`/`VirtualizedDataGrid`; set the settings list's implicit sort to `namespace` first (extend `SETTING_DEFAULT_SORT`) so groups are contiguous per page.
- Tests (`features/settings/components/__tests__/settings-screen.test.tsx`): group headers render with counts; each chip narrows the query (asserts the emitted `ListParams`); Secrets-only emits `secretsOnly=true`; Tenant filter + row→drawer still work.

### 4. Verification & evidence

- [ ] `pnpm --filter @arcaai/ui build lint test` green (grid capability)
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (settings wiring)
- [ ] `pnpm build:api` + settings faceting e2e green (namespace/type/secrets-only)
- [ ] axe 0 violations (grouped grid + chips); both themes verified via `next-dev-loop`
- [ ] AC checklist all checked with pasted evidence

## Implementation Summary

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | Ticket created as follow-up from TASK-439; the deferred namespace group-header rows + Namespace/Type/Secrets-only filter chips are scoped here. Current-state map captured: the grid has no grouped-row variant (`virtualized-data-grid.tsx` — no `groupBy`), the faceted-filter transport already exists and is proven for `tenantId` (TASK-430), `namespace`/`dataType` are real filterable columns, but **`isSecret` is a derived predicate (`isSecretEntity`, not a column)** so Secrets-only faceting needs a dedicated gateway predicate. Status: Pending (awaiting plan approval). |
</content>
</invoke>
