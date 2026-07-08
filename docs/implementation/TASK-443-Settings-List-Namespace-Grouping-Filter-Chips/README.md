# TASK-443 — Settings List: Namespace Grouping + Filter Chips

- **Status**: Review
- **Type**: feature (shared data-grid capability + gateway faceting + admin-console wiring)
- **Owner**: admin-console + `@arcaai/ui` (data-grid) + apps/api (gateway)
- **Related**: **follow-up from TASK-439** (Settings & Secrets redesign — deferred these two list affordances); TASK-437 (redesign foundation); TASK-423 (data-grid standardization / URL query-state + bracket filter grammar); TASK-430 (cross-tenant settings listing + the proven `tenantId` faceted filter).

## Requirement Analysis

The redesigned `/settings` list (TASK-439, spec §5) called for two list affordances that shipped **deferred** because each needs a shared/backend change out of the settings feature's lane:

1. **Namespace group-header rows** inside the data grid — the list should read as sections (`general`, `secrets`, `smr`, …) with a namespace label + row count header ahead of each group's rows, instead of a flat table with a `namespace` column.
2. **Faceted filter chips** on the toolbar — **Namespace** (multi-select over the known namespaces), **Type** (`dataType`), and a **Secrets-only** toggle chip — each narrowing the server-driven result set (not a client-side view filter over the current page).

Both must survive the grid's server-driven contract: the list is paginated/sorted/filtered on the gateway (`AdminDataGrid manual={{ sorting, filtering, pagination }}`), so grouping and faceting can only reflect the rows on the current page unless the gateway participates.

### Acceptance criteria

- [x] The grid renders namespace group-header rows (label + count) without forking `VirtualizedDataGrid`; keyboard/AT semantics and virtualization preserved. (`groupBy` capability; `grouped-rows.vitest.tsx`; live e2e)
- [x] Namespace, Type, and Secrets-only filter chips are present on the settings toolbar and drive the gateway query (result-set changes reset to page 1, per the existing `useAdminGridParams` contract). (chips ride the grid query state; live e2e)
- [x] Server-side faceting on `namespace`, `dataType`, and the derived secret predicate is verified against the gateway (contract test) — not a client-only filter over one page. (`task-443-settings-list-faceting.spec.ts` — 4/4 against the live gateway)
- [x] axe 0 violations on the grouped grid + chips; both themes. (settings e2e WCAG light+dark green after fixing the pre-existing header drag-handle target-size/offset)
- [x] Existing settings behavior (row → `DetailDrawer` via `?setting=`, Tenant column/filter from TASK-430, delete) is unchanged. (all 15 settings-screen unit tests + drawer/create e2e green)

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

Implemented 2026-07-08, TDD (RED → GREEN per layer; all evidence from real runs).

### 1. Gateway faceting (`packages/applications` + `apps/api`, list path only)

- **`GLOBAL_SETTING_FILTER_FIELD_TYPES`** registered in `packages/applications/src/common/modelFilterTypes.ts` (TASK-406 pattern): `dataType` = member-validated `enumFilterSpec(ValueType)` (invalid member → clear 400, never a Prisma 500), plus `locked`/`version`/`keyVersion`/dates/`resourceStatus`/`metaData`. `namespace` is a plain String column and rides the grammar untouched (`namespace[in]:a|b` → Prisma `in` list).
- **`secretsOnly` predicate** — `isSecret` is derived, not a column, so the facet is a bespoke query flag:
  - `buildSecretSettingFilter()` (exported from `globalSetting.dto.mapper.ts`) is the ONE shared definition: `OR [encryptedValue != null, namespace = 'secrets' (insensitive), key contains <marker> (insensitive)]`. The key markers (`SECRET_KEY_MARKERS`, the old regex's optional groups expanded to literals) now also DERIVE the mapper's `SECRET_KEY_PATTERN`, so the list facet and the response mask can never diverge (locked by a parity unit test).
  - `GlobalSettingService.fetchAll/fetchAllByTenantId` accept `secretsOnly?: boolean` (`true` = secrets, `false` = non-secrets via `NOT`, omitted = unchanged) and resolve it to a `where: { AND: [...] }` fragment (AND-wrapped because `formatFindAllProps` merges a bare top-level `OR` lossily; the tenant clause moves inside the AND group on the tenant path). Both now pass `'GlobalSetting'` to `withFormatted*Props` for model-aware coercion.
  - New `ListGlobalSettingQuery` DTO (extends `PaginatedQuery`, `@Transform`ed boolean, junk → 400) — required because the global ValidationPipe is `forbidNonWhitelisted`; the list route (`GlobalSettingController.fetchAll`) now takes it and documents `secretsOnly` in Swagger.
- e2e contract: `apps/api/tests/e2e/task-443-settings-list-faceting.spec.ts` (serial; throwaway rows with explicit `tenantId` — elevated callers bypass the tenant-scope create injection) proves namespace/dataType/secretsOnly narrow server-side and invalid inputs 400.

### 2. Shared grid (`packages/ui/src/components/data-grid`) — two generic capabilities

- **`groupBy?: GroupByConfig<TData>`** on `VirtualizedDataGrid` (`{ accessor, renderHeader?, fallbackLabel? }`): display-layer grouping only — `buildDisplayRows` (`group-rows.ts`, pure + exported) interleaves header entries between CONTIGUOUS runs of the accessor value in page order; the virtualizer counts display entries; group rows render as non-interactive `role="row"` + full-width `role="rowheader"` (`aria-colspan`, sr-only "group, N items", `bg-muted/50` token), participate in `aria-rowcount`, and are NOT clickable/selectable. The table row model (sort/filter/selection/pagination) is untouched; omitting `groupBy` is a byte-for-byte no-op. Decision vs the ticket's open item 1: headers are virtualized in-flow rows (not sticky) — sticky group headers inside a translateY-virtualized body would need pinned-row machinery disproportionate to the affordance.
- **`meta.filterOnly`** (ColumnMeta): a filter-only virtual column — feeds a toolbar faceted chip via the existing `variant`/`options` machinery but is force-hidden (visibility overlay in `use-data-grid`), excluded from the column-visibility list and the last-visible-column guard. This lets a derived server predicate ("Secrets") appear as a first-class chip with URL/`f`-param/clear-filters/page-reset behavior identical to real column filters.
- Story `Custom/DataGrid → GroupedRows`; tests in `__tests__/grouped-rows.vitest.tsx` (pure grouping, rendered headers/counts, non-interactivity, custom renderHeader, no-op without groupBy, filterOnly chip/visibility, axe 0 violations).

### 3. admin-console (`features/settings` + thin shared pass-through)

- `settings-screen.tsx`: implicit sort is now `namespace:asc,key:asc` (groups contiguous per server page); `namespace` column becomes a real `accessorKey` with a `multiSelect` facet; the Type column id changes `type` → `dataType` (the token must carry the real column name) with the full `ValueType` member list as options; a `filterOnly` `isSecret` boolean column adds the **Secrets** chip (Secrets only / Non-secrets); `groupBy={{ accessor: row => row.namespace }}` renders the namespace sections. Row→drawer, Tenant column/filter (TASK-430) and delete are untouched.
- **`secretsOnly` remap**: the screen recomputes `ListParams` from the grid query state — the `isSecret` rule is stripped from the bracket serialization and re-emitted as `secretsOnly=true|false` (an extra `ListParams` key; option (a) of ticket open item 2). Page-reset and URL sharing keep working because the rule still lives in the grid's query state.
- **Namespace chip options** (ticket open item 3/decision): a light client-side distinct read — `useSettingNamespaces()` (new, `api/hooks.ts` + `settingKeys.namespaces()`) derives sorted distinct namespaces from one cached wide page (`limit 500`, 60s staleTime; same tradeoff as the tenant catalog), merged with URL-selected values so shared links always render their chips. No new gateway endpoint.
- `AdminDataGrid` gains an optional `groupBy` pass-through (additive).
- e2e (`tests/e2e/settings.spec.ts`): group headers + three chips visible; Secrets-only chip drives `secretsOnly=true` with no `filters` token; the drawer row-click test now targets `[data-slot="data-grid-row"]` (group headers are rows too).

### Verification evidence (real output)

- `pnpm --filter @arcaai/ui build lint test` → build clean, eslint `--max-warnings 0` clean, **242 files / 655 tests passed** (incl. new grouped-rows suite + axe).
- `pnpm --filter @arcaai/applications build test` → tsc clean, **272 files / 5873 tests passed** (2 transient failures in an earlier run were parallel-agent churn from TASK-445; clean re-run green).
- `pnpm build:api` → 8/8 tasks successful; `vitest run src/modules/global-setting` → **18 tests passed**.
- `pnpm --filter @arcaai/admin-console lint test` → eslint clean, **106 files / 816 tests passed** (settings-screen suite now 15 tests incl. grouping/chips/secretsOnly).
- Live gateway (dev, 8868): `secretsOnly=true` → 200; `filters=dataType[equals]:NotAType` → 400.
- `task-443-settings-list-faceting.spec.ts` (api e2e, serial): **4 passed** — namespace[in] narrows, dataType narrows + invalid member 400s, secretsOnly=true/false resolves the derived predicate (row `isSecret` as oracle), junk secretsOnly 400s.
- Console e2e (`settings.spec.ts`, live app 5176 + gateway 8868): grouping + chips test and the Secrets-only network-contract test **passed**; full serial run **5/7 passed with both WCAG light/dark gates green** — the other 2 are the same tests, green in isolation, tripping only the seeded login rate-limiter when the whole file logs in 7× in a burst (environment throttle, not product code).

### Incidental a11y fix (in-scope, data-grid)

The screen-level axe gate surfaced a PRE-EXISTING `VirtualizedDataGrid` violation (every grid screen): the column-header drag-reorder handle was an icon-sized (~14px) button (`target-size`), and the adjacent "column options" trigger overlapped it via `-ml-1.5` (`target-offset`). Fixed in the grid (my scope): the handle now has a 24px hit box (WCAG 2.5.8 floor) and the options trigger only pulls left when no drag handle sits beside it. Settings axe e2e went red → green on this change; all 655 `@arcaai/ui` tests still pass.

### Files changed

- `packages/applications`: `common/modelFilterTypes.ts`, `services/globalSetting/{globalSetting.dto.mapper.ts, globalSetting.service.ts, IGlobalSettingService.ts, dto/listGlobalSetting.query.ts (new), dto/index.ts, __tests__/globalSetting.service.list.test.ts (new)}`
- `apps/api`: `modules/global-setting/{global-setting.controller.ts, __tests__/global-setting.controller.test.ts}`, `tests/e2e/task-443-settings-list-faceting.spec.ts` (new)
- `packages/ui`: `components/data-grid/{group-rows.ts (new), types.ts, use-data-grid.ts, virtualized-data-grid.tsx, data-grid-toolbar.tsx, data-grid-column-header.tsx (a11y fix), index.ts, __tests__/grouped-rows.vitest.tsx (new)}`, `types/data-table.ts`, `components/__stories__/custom/data-grid.stories.tsx`
- `apps/admin-console`: `features/settings/{components/settings-screen.tsx, components/__tests__/settings-screen.test.tsx, api/hooks.ts, api/keys.ts}`, `shared/data/admin-data-grid.tsx`, `tests/e2e/settings.spec.ts`

## Change History

| Date | Change |
|---|---|
| 2026-07-08 | **Implemented (TDD, all layers) — status → Review.** (1) Gateway: `GlobalSetting` filter-field registry (`dataType` enum member-validated → 400), `secretsOnly` facet (`ListGlobalSettingQuery` DTO + `buildSecretSettingFilter()` shared with `isSecretEntity` via one marker list) on `fetchAll`/`fetchAllByTenantId`; api e2e contract spec added. (2) `@arcaai/ui` data-grid: generic `groupBy` (virtualized, non-interactive group-header rows, a11y semantics) + `meta.filterOnly` (filter-only virtual columns); story + tests. (3) Console: namespace-first implicit sort, namespace grouping, Namespace/Type multiSelect chips (`dataType` column id fixed to the real field), Secrets chip remapped to `secretsOnly`, `useSettingNamespaces()` catalog; screen tests + e2e extended. Incidental in-scope a11y fix: grid header drag-handle 24px target + options-trigger overlap removed (axe target-size/offset, pre-existing on every grid screen). Evidence in Implementation Summary. |
| 2026-07-08 | Ticket created as follow-up from TASK-439; the deferred namespace group-header rows + Namespace/Type/Secrets-only filter chips are scoped here. Current-state map captured: the grid has no grouped-row variant (`virtualized-data-grid.tsx` — no `groupBy`), the faceted-filter transport already exists and is proven for `tenantId` (TASK-430), `namespace`/`dataType` are real filterable columns, but **`isSecret` is a derived predicate (`isSecretEntity`, not a column)** so Secrets-only faceting needs a dedicated gateway predicate. Status: Pending (awaiting plan approval). |
</content>
</invoke>
