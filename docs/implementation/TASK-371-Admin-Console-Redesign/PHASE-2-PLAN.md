# TASK-371 — Admin Console Redesign · PHASE 2 PLAN

| | |
|---|---|
| **Ticket** | TASK-371 (Phase 2 planning) |
| **Type** | Planning (design-first) |
| **Created** | 2026-06-28 |
| **Status** | Proposed — awaiting approval |
| **Scope** | Plans only. No feature code, no Figma edits, no commits. |
| **Figma file** | `HOPE-Admin-Console` |
| **Tokens** | [`theme.css`](./theme.css) (Tailwind v4 `@theme` + shadcn, light/dark) |

> This document plans **three workstreams** for the next build phase. It is the
> companion to `README.md` (which another agent owns) — do not duplicate the
> README's Figma build log here. Everything below is grounded in the **real**
> codebase: `@arcaai/ui` (`packages/ui`), `apps/admin`, the `@arcaai/vox` SDK
> (`packages/agentic-sdk-v2`), and the tenant domain (`packages/database`,
> `packages/applications`, `apps/api`).

## How this plan was grounded (exploration summary)

- **`@arcaai/ui` already ships a canonical TASK-372 layer** we must reuse, not
  rebuild: `VirtualizedDataGrid` (`packages/ui/src/components/data-grid/*`),
  `HistoryTimelineList` (`packages/ui/src/components/timeline/*`),
  `LiveTranscript`, the shared contracts in `packages/ui/src/lib/shared/*`
  (`Density`, `DENSITY_ROW_HEIGHT`, `AsyncStateProps`, `BaseSurfaceProps`,
  pagination/query-state), the canonical semantic `StatusBadge`
  (`packages/ui/src/components/shared/status-badge.tsx`), the shadcn `chart`
  shell (`packages/ui/src/components/shadcn/chart.tsx`) wrapping `recharts@2.15.4`,
  `Card`, `Sheet`, `Dialog`, `Drawer`, `MasterDetailLayout`, `Accordion`,
  `Collapsible`, `Item`, `Empty`, `Skeleton`, `Tooltip`, and the RHF+zod `Form` stack.
- **`apps/admin`** is a TanStack file-router app (port 5174). It has **no
  dashboard and no monitoring screen** yet — `routes/index.tsx` redirects to
  `/tenants`, and `routes/_authenticated/system-health.tsx` is the only
  observability surface (card grid, **no charts**). Data flows entirely through
  `@arcaai/vox` hooks (no TanStack Query, **no chart lib installed in the app**).
  Tenant CRUD is already a **Sheet "blade"** flow
  (`features/tenants/tenant-form-sheet.tsx` + `tenant-detail-sheet.tsx`).
- **Tenant domain reality** (correct field names matter):
  - `Tenant` (`packages/database/src/prisma/db_main/tenant.prisma`): `id` (uuid v7),
    `name`, `key` (`@unique`), `description?`, `resourceStatus`
    (`ResourceStatusType { ENABLED, DISABLED, ARCHIVED, DELETED }`), `tags[]`,
    `version` (`_version`, OCC), `metaData` (`_metadata`). **No status enum, no
    `plan`/tier field, no `deletedAt`** — soft-delete = `resourceStatus`.
  - **There is no `AgentInstruction` model.** "Agent instructions" = `PromptTemplate`
    (`prompt-template.prisma`: `scope` ∈ `TENANT_DEFAULT|DEPARTMENT_DEFAULT|USER_PERSONAL`,
    `category` ∈ `SYSTEM|SUMMARY|DNA_ANALYSIS|CUSTOM`, `status` ∈ `DRAFT|PUBLISHED`,
    `content`, `variables`, `departmentId?`) + `Department` prompt-config columns
    (`preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId`, `promptConfig`).
  - User↔department = `UserDepartment` join (`userId`, `departmentId`, `tenantId`,
    `isPrimary`, unique `(tenantId, userId, departmentId)`). `User` is **not**
    tenant-scoped (no `tenantId`); membership derives from `UserRoleAssignment.tenantId`
    + `UserDepartment.tenantId`.
  - Storage: `TenantBucket` (`slug`, `name`, `bucketType SYSTEM|CUSTOM`, `purpose
    AUDIO|ATTACHMENTS|MISC|CUSTOM`), `StorageAccessKey`, `TenantStorageConfig`,
    `Media`. **No quota/usage columns.**
  - Permissions are CASL: super-admin = roles `SUPER_ADMIN`/`GLOBAL_ADMIN`
    (`packages/applications/src/common/tenant-guards.ts` → `ELEVATED_ROLES`,
    `isSuperAdmin()`); tenant-admin = tenant-scoped ability with `tenantId` CASL
    condition. `POST`/`DELETE /admin/tenants` are `@CanManage('Tenant')` (super-admin
    only); mutations require `@RequiresIfMatch()` (OCC). Isolation is **404-over-403**.
- **SDK hooks available** (`packages/agentic-sdk-v2/src/hooks/`) cover every flow
  below: `useTenants`, `useUsers`, `useDepartments`, `useUserDepartments`
  (`list/assign/setPrimary/unassign`), `usePrompts` (`create/list/get/update/remove/
  assignToDepartment/activateVersion/test/...`), `useTenantBuckets`,
  `useTenantStorageConfig`, `useStorageKeys`, `useTenantFrontendConfig`,
  `useGlobalSettings`, `useRoles`, `usePolicies`, `useApiKeys`, `useMonitoring`
  (`uptime: ServiceUptime[]`, `sessions: SessionCounts`), `useHealthCheck`
  (`status`, `services{}`, `startPolling`).

---

## #3 — Shared Reporting / Status / Chart Component System

**Goal.** A small, semantic-token-driven primitive set in `@arcaai/ui` that the
**Dashboard (frame 10)** and **Service Monitoring (frame 11)** screens compose
from. Every primitive honors the Realism Checklist, WCAG 2.2 AA, the two density
modes, and the `AsyncStateProps` loading/empty/error contract already used by the
TASK-372 components.

**Where it lives.** New folder `packages/ui/src/components/metrics/` (canonical,
barrel-exported from `packages/ui/src/index.ts`), reusing
`packages/ui/src/lib/shared/*` and the existing shadcn `chart`/`card`/`table`/
`badge`/`select`/`popover`/`calendar`/`command` primitives. Charts pull
`recharts@2.15.4` (already a `packages/ui` dep) via the shadcn `ChartContainer`.

### 3.1 Primitive inventory (both screens)

| # | Component | Reuse vs build | Appears in |
|---|---|---|---|
| 3.1 | `StatCard` (KPI/stat) | **Build** (canonical, semantic) | 10 KPIs, 11 KPIs |
| 3.2 | `StatusDot` (atom) | **Build** (none exists) | 10 + 11 service bar, lists |
| 3.3 | `ServiceStatusItem` + `ServiceStatusBar` | **Build** | 11 (bar on 10/all shells) |
| 3.4 | `MetricChart` (bar/line/area) | **Build** (wrap shadcn `chart` + recharts) | 10 consultations, 11 volume |
| 3.5 | `DateRangeSelector` | **Build** (compose `calendar`+`popover`+`toggle-group`) | 10 + 11 toolbars |
| 3.6 | `TenantFilter` | **Build** (compose `command`+`popover`) | 10 + 11 toolbars (super-admin) |
| 3.7 | `MetricTable` | **Build** thin wrapper over shadcn `Table` (not `VirtualizedDataGrid`) | 11 per-service metrics |
| 3.8 | `RunningTasksList` / `ModelsList` | **Build** on the #4a Item-List foundation | 10 recent activity, 11 tasks |

> **Decision — `StatCard` is a build, not a reuse.** The two existing stat cards
> are unsuitable as the canonical primitive: the registry
> `packages/ui/src/components/registries/manifest/stat-card.tsx` is a *grid of
> stats* with **hardcoded `text-green-600`/`text-red-600`** (violates the
> "semantic tokens only" rule), and the one in
> `apps/admin/src/routes/_authenticated/system-health.tsx` (lines 56-68) is a
> local ad-hoc. We build one semantic `StatCard` and migrate `system-health` onto it.

### 3.2 Component specs

#### 3.1 `StatCard` — KPI / stat tile
- **Path**: `packages/ui/src/components/metrics/stat-card.tsx`
- **Props**:
  ```ts
  interface StatCardProps extends BaseSurfaceProps, AsyncStateProps {
    label: string;
    value: React.ReactNode;            // tabular-nums rendered
    delta?: { value: number; direction?: 'up' | 'down' | 'neutral'; label?: string };
    deltaIntent?: 'auto' | 'positive' | 'negative' | 'neutral'; // up≠always good (e.g. error rate)
    icon?: LucideIcon;
    hint?: string;
    accent?: 'default' | 'primary' | 'ai' | 'success' | 'warning' | 'destructive';
    footer?: React.ReactNode;          // e.g. a sparkline slot
  }
  ```
- **Variants (cva)**: `accent` → left-border/icon-chip tint using `--primary`,
  `--ai`, `--success`, `--warning`, `--destructive`; `density` via `data-density`.
- **Tokens**: `bg-card`, `text-card-foreground`, `text-muted-foreground` (label/hint),
  delta uses `text-success`/`text-destructive`/`text-muted-foreground` resolved by
  `deltaIntent` (NOT raw green/red). `tabular-nums` for value + delta.
- **States**: loading → `Skeleton` matching the value+label layout; empty →
  em-dash `—` value + hint; error → muted `errorState`.
- **a11y**: `delta` direction is **never color-only** — pair `TrendingUp/Down/Minus`
  icon + sign; `aria-label` includes value and delta phrasing; one decorative icon
  only; 4.5:1 text contrast.
- **Responsive**: full-width tile; consumers grid them (`grid sm:grid-cols-2
  lg:grid-cols-4`).

#### 3.2 `StatusDot` — semantic status atom
- **Path**: `packages/ui/src/components/metrics/status-dot.tsx`
- **Props**: `{ colorRole: StatusColorRole; pulse?: boolean; size?: 'sm'|'md'; label?: string; 'aria-label'?: string }`
  reusing `StatusColorRole` from `packages/ui/src/components/shared/status-badge.tsx`
  (`primary|success|warning|destructive|ai|info|hope|neutral`).
- **Tokens**: `bg-success|bg-warning|bg-destructive|…`; `pulse` uses the brand
  "breathing" animation (README Pillar 5) gated by `motion-safe:` /
  `prefers-reduced-motion`.
- **a11y**: decorative by default (`aria-hidden`) when next to a text label;
  standalone usage requires `aria-label`. Never the only status signal.

#### 3.3 `ServiceStatusItem` + `ServiceStatusBar`
- **Path**: `packages/ui/src/components/metrics/service-status.tsx`
- `ServiceStatusItem` props:
  ```ts
  interface ServiceStatusItemProps {
    name: string;                       // useHealthCheck().services[k].service
    status: 'healthy' | 'degraded' | 'unhealthy' | 'checking' | 'unknown';
    p95Ms?: number;                     // P95 latency (see data gap below)
    uptimeSeconds?: number;             // useMonitoring().uptime[].uptimeSeconds
    version?: string;
    error?: string;
    density?: Density;
  }
  ```
- `ServiceStatusBar` props: `{ services: ServiceStatusItemProps[]; activeSessions?: number; processingJobs?: number; env?: string; onRefresh?: () => void; isLoading?: boolean; fixed?: boolean }`.
- **Tokens**: `StatusDot` + `StatusBadge` colors; `font-mono` for version; `tabular-nums`
  for P95/uptime; `bg-card`/`border-t` for the fixed bar.
- **Data mapping**: status from `useHealthCheck().services` (`status/version/uptime_seconds/error`);
  uptime cross-filled from `useMonitoring().uptime` (`service`, `uptimeSeconds`);
  `activeSessions`/`processingJobs` from `useMonitoring().sessions`
  (`activeSessions`, `processingJobs`, `total`). **Data gap:** P95 latency is not
  in `useMonitoring`/`useHealthCheck` today — make `p95Ms` optional and hide the
  cell when absent (open question Q3).
- **a11y**: `role="status"`/`aria-live="polite"` on the bar; each item is a labelled
  group (dot + name + badge); refresh is a real `<button>` ≥44px.
- **Responsive**: desktop = horizontal fixed bar; tablet/mobile = wrap to 2 rows or
  collapse to a single "6/7 healthy" summary chip that expands in a `Popover`.

#### 3.4 `MetricChart` — bar / line / area
- **Path**: `packages/ui/src/components/metrics/metric-chart.tsx`
- **Props**:
  ```ts
  interface MetricChartProps extends BaseSurfaceProps, AsyncStateProps {
    kind: 'bar' | 'line' | 'area';
    data: Record<string, number | string>[];
    xKey: string;
    series: { key: string; label: string; colorVar?: string }[]; // default --chart-1..5
    config?: ChartConfig;              // shadcn ChartConfig
    height?: number;                   // default 240
    valueFormatter?: (v: number) => string;
    showLegend?: boolean; showGrid?: boolean;
    'aria-label'?: string;
  }
  ```
- **Reuse**: wraps `ChartContainer`/`ChartTooltip`/`ChartTooltipContent`/
  `ChartLegend`/`ChartLegendContent` from `packages/ui/src/components/shadcn/chart.tsx`;
  renders recharts `BarChart`/`LineChart`/`AreaChart` by `kind`.
- **Tokens**: series default to `--chart-1..5` (already in `theme.css` + `index.css`);
  axis/grid use `--border`/`--muted-foreground`; tooltip uses `--popover`.
- **States**: loading → `Skeleton` block at `height`; empty → centered `Empty`
  (icon+title+desc); error → `errorState` + `onRetry`.
- **a11y**: `role="img"` + descriptive `aria-label` summarizing the series and range;
  provide an offscreen data table fallback (sr-only) for screen readers;
  `prefers-reduced-motion` disables entry animation.
- **Responsive**: `ResponsiveContainer` (full width); legend wraps; x-axis tick
  thinning on narrow widths.

#### 3.5 `DateRangeSelector`
- **Path**: `packages/ui/src/components/metrics/date-range-selector.tsx`
- **Props**:
  ```ts
  type RangePreset = 'week' | 'month' | 'year' | 'custom';
  interface DateRangeSelectorProps {
    value: { from: Date; to: Date; preset: RangePreset };
    onChange: (next: { from: Date; to: Date; preset: RangePreset }) => void;
    presets?: RangePreset[];           // default ['week','month','year','custom']
    align?: 'start' | 'end';
  }
  ```
- **Reuse**: `ToggleGroup` for presets + `Popover` + `Calendar` (range mode) for
  custom; `date-fns` (already a dep) for `startOfWeek/Month/Year`.
- **Tokens**: shadcn defaults; active preset = `bg-accent text-accent-foreground`.
- **a11y**: presets are a labelled radio-style `ToggleGroup` (arrow-key nav);
  calendar is keyboard-navigable (Radix/shadcn); selected range announced.
- **Responsive**: presets collapse into the popover trigger label on mobile.

#### 3.6 `TenantFilter`
- **Path**: `packages/ui/src/components/metrics/tenant-filter.tsx`
- **Props**:
  ```ts
  interface TenantOption { id: string; name: string; key: string }
  interface TenantFilterProps {
    tenants: TenantOption[];
    value: string | null;             // null = "All tenants" (cross-tenant)
    onChange: (tenantId: string | null) => void;
    allowAll?: boolean;               // super-admin only
    disabled?: boolean;               // tenant-admin: locked to own tenant
    isLoading?: boolean;
  }
  ```
- **Reuse**: `Command` (searchable list) inside `Popover` (combobox), mirroring the
  Figma working-tenant switcher (foundation frame 06). `font-mono` for `key`.
- **Permissions**: super-admin sees "All tenants" + full list; tenant-admin gets a
  disabled control pinned to its own tenant (matches 404-over-403 isolation).
- **a11y**: combobox `role`, `aria-expanded`, type-ahead, current selection ✓;
  ≥44px trigger.

#### 3.7 `MetricTable`
- **Path**: `packages/ui/src/components/metrics/metric-table.tsx`
- **Decision**: a **thin** wrapper over shadcn `Table` primitives — NOT
  `VirtualizedDataGrid` (small, fixed metric rows don't need virtualization/DnD).
- **Props**: `{ columns: { key; label; align?; format? }[]; rows: Record<string, React.ReactNode>[]; density?; isLoading?; emptyState? }`.
- **Tokens**: `tabular-nums` right-aligned numerics; status cells via `StatusBadge`;
  zebra optional via `--muted`.
- **a11y**: real `<th scope="col">`, caption, `aria-sort` if sortable; loading →
  skeleton rows.

#### 3.8 `RunningTasksList` / `ModelsList`
- **Decision**: compose the **#4a Item-List foundation** (§4a.2) — these are
  "ordered records with status" lists. Each row: `StatusDot` + name + `font-mono`
  id + `Progress` (for running tasks) + relative timestamp (`date-fns
  formatDistanceToNow`). Models list adds a `StatusBadge` (loaded/loading/error)
  and size/version columns.
- **Path**: `packages/ui/src/components/metrics/running-tasks-list.tsx`
  (and `models-list.tsx`), or expressed as presets of the Item-List foundation.

### 3.3 Mapping to Figma frames 10 & 11

| Frame | Section | Components used |
|---|---|---|
| **10 · Dashboard** (`69:1265`) | Toolbar | `DateRangeSelector`, `TenantFilter` (super-admin) |
| | KPI row | 4× `StatCard` (Active tenants / Live sessions / Jobs processing / Services healthy) |
| | Consultations chart | `MetricChart kind="bar"` (weekly), `--chart-1` |
| | Recent activity | `RunningTasksList` (Item-List foundation) |
| | Fixed footer | `ServiceStatusBar` (+ `StatusDot` per service) |
| **11 · Monitoring** (`70:1692`) | Toolbar | `DateRangeSelector`, `TenantFilter` |
| | KPI row | 4× `StatCard` (Requests/min / Error rate `deltaIntent="negative"` / P95 / Uptime) |
| | 24h volume chart | `MetricChart kind="line"` or `area`, hourly x-axis |
| | Per-service metrics | `MetricTable` (name · `StatusBadge` · P95 · uptime · version) |
| | Incidents feed | `RunningTasksList` variant (incident rows) |
| | Fixed footer | `ServiceStatusBar` |

### 3.4 Build order

1. `StatusDot` (atom, no deps) → 2. `StatCard` → 3. `MetricChart` (depends on shadcn
`chart`) → 4. `ServiceStatusItem`/`ServiceStatusBar` (depends on `StatusDot`/`StatusBadge`)
→ 5. `DateRangeSelector` → 6. `TenantFilter` → 7. `MetricTable` → 8. `RunningTasksList`/
`ModelsList` (depends on #4a Item-List). 9. Barrel-export from
`packages/ui/src/index.ts`. 10. (Separate, app ticket) migrate `system-health.tsx`
onto `StatCard`/`ServiceStatusBar`.

### 3.5 Vitest test list (`packages/ui/src/components/metrics/__tests__/*.vitest.tsx`, happy-dom + testing-library + vitest-axe)

- `StatCard`: renders value/label/hint; delta up/down/neutral icon+sign (color-blind safe); `deltaIntent="negative"` flips success/destructive mapping; loading→skeleton, empty→`—`, error→errorState; `data-density` attr; axe pass.
- `StatusDot`: role/aria per color; `pulse` respects `prefers-reduced-motion`; decorative vs labelled.
- `ServiceStatusBar`: maps healthy/degraded/unhealthy → correct dot+badge; hides P95 cell when `p95Ms` undefined; `aria-live` region; refresh fires `onRefresh`; collapses on narrow width; axe pass.
- `MetricChart`: renders bar/line/area for given series; uses `--chart-*` vars; empty/loading/error states; sr-only data-table fallback present; axe pass.
- `DateRangeSelector`: preset click emits correct `{from,to,preset}` (week/month/year via date-fns); custom range via calendar; keyboard nav.
- `TenantFilter`: search filters list; "All tenants" only when `allowAll`; disabled state locks selection; current ✓.
- `MetricTable`: header scopes/caption; numeric right-align tabular-nums; loading skeleton rows; empty state.
- `RunningTasksList`: status dot + progress + relative time; empty/loading.

---

## #4a — New Foundation Interfaces (00–09 band)

Three new **foundation** (reference) interfaces, each with density modes,
responsive behavior, and latest UX-UI. Per `.cursor/rules/12-design-workflow.mdc`,
foundations are **references only** — every product tier reuses them.

> **Frame-numbering decision (open for confirmation — Q1).** The foundation band
> `00–09` currently holds **00–07** (per README §5.5). Two slots remain (`08`, `09`)
> but we have three foundations. Because the **Timeline is literally an "ordered
> item-list"** (the user's own framing), we recommend:
> - **`08 · Card-Grid`** (collection-of-cards foundation)
> - **`09 · Lists — Item-List & Timeline`** (one frame, two stacked patterns: the
>   expandable item-list and its ordered/scroll-spy timeline specialization).
>
> The `@arcaai/ui` code stays as **three** distinct components regardless of how
> the Figma frames are grouped. If the team prefers a dedicated timeline frame,
> the alternative is to renumber (costly) — we recommend the consolidation.

All three share `packages/ui/src/lib/shared/*` (`Density`, `DENSITY_ROW_HEIGHT`
`{ comfortable: 48, compact: 36 }`, `DENSITY_PADDING_Y`, `AsyncStateProps`,
`BaseSurfaceProps`) and live under `packages/ui/src/components/collection/`
(new) except the timeline which extends `packages/ui/src/components/timeline/`.

### 4a.1 Card-Grid foundation

**(a) Figma frame spec — `08 · Card-Grid`**
- **Layout**: page header (`PageHeader`) + toolbar (search + density toggle + view
  switch) over a responsive auto-fit grid: `repeat(auto-fill, minmax(280px, 1fr))`,
  24px gutters; comfortable = 3–4 cols @1440, compact = 4–5 cols.
- **Node structure**: `page-title`, `grid-root`, `card-0…card-n`
  (each: `card-icon`, `card-title`, `card-meta`, `card-status` badge, `card-actions`),
  `state-skeleton`, `state-empty`, `state-selected`.
- **Real example content** (Realism Checklist): a **Departments** card grid —
  "Cardiology · CARD", "Radiology · RAD", "General Medicine · GEN (system)",
  "Emergency · EMRG" — each card showing the department `code` (mono), a member
  count ("18 clinicians"), assigned-prompt chips ("New patient", "Revisit"), and
  an `Enabled`/`Disabled` `StatusBadge`. Include one **selected**, one **hover**,
  one **skeleton**, and an **empty** state ("No departments yet — Create the first
  department").

**(b) `@arcaai/ui` component plan — `CardGrid` + `EntityCard`**
- **Path**: `packages/ui/src/components/collection/card-grid.tsx`,
  `entity-card.tsx`.
- **API**:
  ```ts
  interface CardGridProps<T> extends BaseSurfaceProps, AsyncStateProps {
    items: T[];
    getItemId: (item: T) => string;
    renderCard: (item: T, state: { selected: boolean }) => React.ReactNode;
    minColumnWidth?: number;          // default 280
    selectedId?: string;
    onSelect?: (id: string) => void;
    'aria-label'?: string;
  }
  interface EntityCardProps {
    title: React.ReactNode; icon?: LucideIcon;
    meta?: React.ReactNode; status?: { label: string; colorRole: StatusColorRole };
    actions?: React.ReactNode; selected?: boolean; onClick?: () => void;
    density?: Density;
  }
  ```
- **Variants (cva)**: `EntityCard` selected/hover/default via `data-state`;
  density via `data-density` (comfortable = `p-4`, compact = `p-3`).
- **Tokens**: `bg-card`, `border-border`, selected = `ring-2 ring-ring`/`bg-accent`,
  hover = `bg-accent/40`; resting shadow only (Pillar 4 "border-first").
- **States**: skeleton grid (same column count), `Empty` (icon+title+desc), hover,
  selected; reuse `Skeleton`, `Empty`.
- **Reuse vs build**: **build** the grid wrapper; **reuse** shadcn `Card`,
  `StatusBadge`, `Skeleton`, `Empty`.

**(c) Responsive + a11y**: CSS `auto-fill` grid collapses 4→2→1 columns
(desktop/tablet/mobile); cards are `role="button"`/`<button>` when selectable with
visible focus ring; ≥44px hit area; keyboard: Tab between cards, Enter/Space selects;
`aria-selected` on the grid item.

**(d) Vitest** (`card-grid.vitest.tsx`): renders N cards; selection via click +
keyboard (Enter/Space); `aria-selected` reflects `selectedId`; loading→skeleton,
empty→`Empty`; `data-density`; column-width style applied; axe pass.

### 4a.2 Item-List foundation (expandable rows)

**(a) Figma frame spec — `09 · Lists` (top half: Item-List)**
- **Layout**: header + toolbar; full-width rows with a leading affordance
  (chevron/disclosure), primary text, trailing meta + status; an **expanded row**
  reveals a detail panel beneath (key/value grid, actions).
- **Node structure**: `list-root`, `row-0…row-n` (`row-disclosure`, `row-title`,
  `row-meta`, `row-status`, `row-detail` when expanded), `state-skeleton`,
  `state-empty`.
- **Real example content**: a **Running tasks / Agent jobs** list — rows like
  "Summarization · job_01J… · Running 62%", "Medical NER · job_01J… · Queued",
  "Guardrail check · job_01J… · Failed — timeout" — with one row **expanded**
  showing job detail (department, model `gpt-4o-mini`, started 2m ago, correlationId
  mono). Show density comparison (comfortable 48px / compact 36px rows).

**(b) `@arcaai/ui` component plan — `ItemList`**
- **Path**: `packages/ui/src/components/collection/item-list.tsx`.
- **API**:
  ```ts
  interface ItemListProps<T> extends BaseSurfaceProps, AsyncStateProps {
    items: T[];
    getItemId: (item: T) => string;
    renderRow: (item: T) => React.ReactNode;          // collapsed row content
    renderDetail?: (item: T) => React.ReactNode;       // expandable panel
    expansion?: { value?: string[]; onChange?: (ids: string[]) => void; mode?: 'single' | 'multiple' };
    onRowClick?: (id: string) => void;
    virtualized?: boolean;                              // opt-in for large lists
    height?: number | string;
    'aria-label'?: string;
  }
  ```
- **Reuse**: the **expansion controller logic already exists** in
  `packages/ui/src/components/timeline/use-timeline.ts` (`isExpanded/toggle/
  setExpanded`, single/multiple mode) — extract a shared `useExpansion` hook into
  `lib/shared` so both `ItemList` and `HistoryTimelineList` use it. Optional
  virtualization via `@tanstack/react-virtual` (already used by the grid/timeline).
  Reuse `Collapsible`/`Accordion` semantics for the disclosure, `Skeleton`, `Empty`.
- **Tokens**: row `border-b border-border`, hover `bg-accent/40`, focus ring;
  `DENSITY_ROW_HEIGHT`/`DENSITY_PADDING_Y` for density; detail panel `bg-muted/40`.
- **States**: skeleton rows, empty, expanded/collapsed, hover, keyboard-focus.

**(c) Responsive + a11y**: rows are a `role="list"`/`listitem`; disclosure is a
real `<button aria-expanded>` controlling the detail region (`aria-controls`);
roving-tabindex keyboard nav (↑/↓ move, Enter/Space/→ expand, ← collapse, Home/End);
on mobile the trailing meta wraps below the title.

**(d) Vitest** (`item-list.vitest.tsx`): expand/collapse via click + keyboard;
single vs multiple mode; `aria-expanded`/`aria-controls` wiring; loading/empty;
`data-density`; (if `virtualized`) DOM node bound on 1000 items; axe pass. Plus
`use-expansion.vitest.ts` for the extracted hook.

### 4a.3 Timeline (scroll-spy) foundation — ordered item-list

The changelog-style vertical timeline from the attached screenshots: a **left rail**
with version markers (`v1.3.0`, `v1.2.0`, `v1.1.0`) + dates, **milestone dots**,
and per-entry expandable **New / Updates / Bug Fixes** sections with code/image
blocks. The **milestone indicator sticks/scrolls with the cursor (scroll-spy)** —
as you scroll, the active milestone marker stays pinned and highlights the entry
currently in view.

> **Reuse decision.** This is a **new component** — the existing
> `HistoryTimelineList` (`packages/ui/src/components/timeline/*`) is a *virtualized
> reverse-chronological feed with no connector line, no dots, no sticky scroll-spy*
> (confirmed in `history-timeline-list.tsx`/`timeline-item.tsx`). We **extend the
> folder** (`packages/ui/src/components/timeline/`) with a sibling
> `ScrollSpyTimeline`, **reusing** the `TimelineContent` renderer registry
> (`renderers/` — markdown/pdf/image/audio/file/mixed/custom) and the extracted
> `useExpansion` hook, but adding the **rail + markers + scroll-spy**. The diceui
> registry `TimelineItem` (visual line/dot) is a reference but not a drop-in.

**(a) Figma frame spec — `09 · Lists` (bottom half: Timeline)**
- **Layout** (mirrors the screenshots): a two-column grid — **left rail** (sticky
  marker column ~160px: version pill `v1.3.0` on a dark chip + date `November 7,
  2025` + connector line + dot) and **right content** (entry title, intro copy,
  bullet list, optional image/code block, and collapsible `New` (open) / `Updates`
  / `Bug Fixes` sections each with a chevron).
- **Node structure**: `rail`, `marker-0…n` (`marker-version`, `marker-date`,
  `marker-dot`, `rail-line`), `entry-0…n` (`entry-title`, `entry-intro`,
  `entry-media`, `section-new/updates/bugfixes` with `section-toggle`), `sticky-cursor`.
- **Real example content** (Realism — make it HOPE, not the shadcn changelog): a
  **HOPE platform release timeline** — e.g. `v2.4.0 · Ambient diarization GA`
  (New: "Speaker-tagged transcripts in Live Session", "Per-department prompt
  rollback"; Bug Fixes: "STT reconnect on network blips"); `v2.3.0 · Tenant config
  v2`; `v2.2.0 · Audit-log keyset pagination`. Include a code block
  (`PipelinePolicy` JSON) and an image block (a UI screenshot) to exercise the
  renderers, plus density + mobile variants.

**(b) `@arcaai/ui` component plan — `ScrollSpyTimeline`**
- **Path**: `packages/ui/src/components/timeline/scroll-spy-timeline.tsx`
  (+ `use-scroll-spy.ts`).
- **API**:
  ```ts
  interface TimelineMilestone {
    id: string;
    version?: string;                 // "v2.4.0"
    date: string | Date;
    title: React.ReactNode;
    intro?: React.ReactNode;
    sections?: { id: string; label: string; defaultOpen?: boolean; content: TimelineContent }[];
    media?: TimelineContent;          // reuse existing renderer registry
  }
  interface ScrollSpyTimelineProps extends BaseSurfaceProps, AsyncStateProps {
    milestones: TimelineMilestone[];
    order?: 'desc' | 'asc';
    stickyOffset?: number;            // px from top for the sticky marker
    onActiveChange?: (id: string) => void;
    renderers?: Partial<Record<TimelineContentVariant, TimelineRenderer>>;
    'aria-label'?: string;
  }
  ```
- **Scroll-spy / sticky-marker interaction**: a `useScrollSpy` hook uses an
  `IntersectionObserver` over each `entry-i` (rootMargin tuned to the
  `stickyOffset`) to compute the **active milestone**; the rail's active marker
  gets `position: sticky; top: stickyOffset` (CSS-first, no scroll listeners on the
  hot path) and the active dot/version pill is emphasized (`bg-primary`,
  scale/breathing pulse gated by `prefers-reduced-motion`). On scroll, the active
  marker visually "travels" the rail while inactive markers remain in flow.
- **Reuse**: the `TimelineContent` discriminated union + `DEFAULT_RENDERERS`/
  `resolveRenderer` from `packages/ui/src/components/timeline/renderers/`; the
  `useExpansion` hook for the New/Updates/Bug-Fixes collapsibles; `Badge`/`Card`.
- **Tokens**: rail line `border-border`, dot `bg-primary` (active) /
  `bg-muted-foreground` (inactive), version pill `bg-foreground text-background`
  (matches screenshot dark chip) mapped to tokens, date `text-muted-foreground`,
  section chevrons; `--chart`/code block uses existing `CodeBlock` from prompt-kit.
- **States**: loading (rail + skeleton entries), empty, error+retry; per-section
  expanded/collapsed.

**(c) Responsive + a11y**: desktop = two-column rail+content; **tablet/mobile** =
rail collapses to a thin left gutter with dots only (version/date move inline above
each entry title), sticky offset accounts for the mobile app bar. a11y: rail is
decorative (`aria-hidden`) with an accessible `<ol>` of milestones underneath;
each milestone is a labelled region; section toggles are `<button aria-expanded
aria-controls>`; `onActiveChange` does not steal focus; respects
`prefers-reduced-motion` (no travel animation, instant marker swap).

**(d) Vitest** (`scroll-spy-timeline.vitest.tsx`): renders rail markers in
desc/asc order; section expand/collapse (reusing `useExpansion`); active-milestone
computation via mocked `IntersectionObserver` → `onActiveChange` fires with the
in-view id; sticky marker has `position:sticky`; renderer registry resolves
markdown/image/code; `prefers-reduced-motion` disables travel animation;
loading/empty/error; axe pass. Plus `use-scroll-spy.vitest.ts` (observer mock,
active-index math, offset handling).

---

## #4b — Tenant Management via Blade Interface (builds on foundation `05 · Blades`)

Extends the **existing** blade flow in `apps/admin` — tenant CRUD is already
Sheet-based (`features/tenants/tenant-form-sheet.tsx`,
`tenant-detail-sheet.tsx`, opened from row-click in
`routes/_authenticated/tenants.tsx`). This plan deepens it into a full
**master grid → detail blade → nested blades** model for managing a tenant's
**users, configuration & settings, storage, and departments** (incl. user→department
assignment and agent-instruction/prompt creation).

### 4b.1 Blade navigation model

```
13 · Tenants (master grid, VirtualizedDataGrid)        [super-admin tier 10–19]
   └─ row click → Tenant Detail BLADE (Sheet, right, wide override)   [10–19 overview / 20–29 config]
        ├─ Overview      (KPIs via #3 StatCard + usage stats)
        ├─ Users tab     → nested "Tenant User" blade  → nested "Assign department" blade  [20–29]
        ├─ Config tab    (KV settings, feature flags, ASR/engine)                          [20–29]
        ├─ Storage tab   (buckets/objects, provider config, access keys)                   [30–49]
        └─ Departments tab → nested "Department" blade
                               ├─ "Add users to department" blade (department-side)        [30–49]
                               └─ "Create agent instruction" blade (PromptTemplate)        [30–49]
   └─ toolbar "New tenant" → Add Tenant BLADE                                              [10–19]
```

- **Master**: keep `VirtualizedDataGrid<Tenant>` in `tenants.tsx`. Columns from
  **real** fields: `name`, `key` (mono), `resourceStatus` (`StatusBadge`),
  `updatedAt`. **Remove or re-source the "Plan" column** shown in Figma frame 13 —
  there is **no `plan` field** on `Tenant` (Realism fix; see Q4).
- **Detail blade**: a right `Sheet` widened beyond the default `sm:max-w-sm`
  (override `className="w-full sm:max-w-2xl lg:max-w-3xl"` per
  `11-ux-ui-principles.mdc`), with `Tabs` for the four sections. Reuses the
  `05 · Blades` foundation (master→detail) and `MasterDetailLayout` where a
  two-column in-blade layout helps (e.g. Departments list + detail).
- **Nested blades**: stack additional `Sheet`s (or push within the same blade via a
  back affordance) for drill-downs — "Tenant User", "Assign department", "Department",
  "Create agent instruction". Keep one scroll container per blade (no nested scroll).

### 4b.2 Flows grounded in real schema/services/hooks

**A) Add tenant** (`Add Tenant` blade — extend `TenantFormSheet`)
- **Fields** (real `Tenant` + `CreateTenantRequest`): `name` (required), `key`
  (required, immutable after create, lowercase slug, **case-insensitive uniqueness**
  — fixes `DEF-ADM-001`), `description?`, `tags?`.
- **Create**: `useTenants().create({ name, key, description })`. Server provisions
  system buckets, GlobalSetting clones, default `GEN` department, AI-model + ASR
  catalogs (per `TenantService.create`).
- **Validation**: inline uniqueness against the loaded tenant keys (already done in
  `tenant-form-sheet.tsx`) + zod schema; key pattern; required markers.
- **States**: saving (spinner in submit, disabled form), success toast + grid
  refetch, error (server validation → inline; 409 → conflict notice).

**B) Tenant Overview** (Detail blade · Overview tab)
- KPIs via #3 `StatCard`: `totalUsers`, `totalDepartments`, `totalPromptTemplates`,
  `totalPipelines` from `useTenants()` usage stats (`TenantService.getUsageStats`,
  `GET /admin/tenants/:id/usage`). Header shows `name`, `key` (mono),
  `resourceStatus` `StatusBadge`, created/updated. Actions: Edit, Enable/Disable
  (`resourceStatus` toggle, OCC), and **system-tenant protection** — for the
  `__GLOBAL__`/SYSTEM_TENANT, Edit/Disable are **disabled + explained** (X4; already
  partially in `tenant-detail-sheet.tsx`).

**C) Tenant Users** (Detail blade · Users tab)
- **List**: users in this tenant via `useUsers()` → `GET /admin/users/tenant/:tenantId`
  (server-paginated `VirtualizedDataGrid`, compact density). Columns: `username`,
  `isServiceAccount` (User/Service badge), role badges (`UserRoleAssignment`),
  `resourceStatus`.
- **Nested "Tenant User" blade**: opens on row-click — profile + role assignments +
  **department assignments** section.
- **User→department assignment** (nested "Assign department" blade): uses
  `useUserDepartments()`:
  - `list(userId)` → current `UserDepartmentAssignment[]` (`isPrimary`, `version`),
  - `assign(userId, { departmentId, isPrimary })` → `POST /admin/users/:id/departments`,
  - `setPrimary(userId, assignmentId, isPrimary, version)` → OCC `If-Match` PATCH,
  - `unassign(userId, assignmentId)` → soft delete.
  Department options from `useDepartments()` filtered to the tenant & unassigned;
  first assignment auto-primary (mirrors `UserDepartmentService.assign`).
  **Improvement over `ui-playground`**: this was buried in a 2400-line user dialog;
  here it is a focused nested blade, and we ALSO expose the **department-side**
  "Add users to department" (below) which the old console lacked.

**D) Configuration & Settings** (Detail blade · Config tab)
- **Tenant configs (KV / feature flags)**: `useTenants().getConfigs(id)` /
  `updateTenantConfigs` → `GET|PATCH /admin/tenants/configs/:identifier` with OCC
  (`@RequiresIfMatch()`, `expectedVersion`). Render as a settings list (reuse the
  `settings.tsx` pattern + `Form`); mask locked values for non-super-admin.
- **ASR / engine pipeline defaults**: `useTenantFrontendConfig()` →
  `TenantFrontendConfig` fields (`asrModel`, `noiseCancel`, `vad`, `diarization`,
  `voiceEnrollment`, `captureRawAudio`, `transcriptionMode`, `transcriptionModeLocked`,
  `captureMode`) as `Switch`/`Select` controls.
- **"Acting on: «Tenant»" banner** (OBS-ADM-001) shown above every mutation in this
  tab for super-admins acting cross-tenant.

**E) Storage** (Detail blade · Storage tab)
- **Buckets/objects**: `useTenantBuckets()` (`list`, `tree(id, prefix)`,
  `presignedUrl`, `create`, `remove`, `deleteObject`, `provision`). Render a
  bucket list (`bucketType SYSTEM|CUSTOM`, `purpose`) → object browser
  (Item-List foundation, lazy "load more"). System buckets: delete disabled +
  explained.
- **Provider config**: `useTenantStorageConfig()` (`provider MINIO|AWS_S3|AZURE_BLOB`,
  `topology SHARED|DEDICATED`, endpoint/region/etc.).
- **Access keys**: `useStorageKeys()` (`permissions[]`, `bucketIds[]`, secret shown
  once — X8).
- **Data gap**: **no quota/usage** columns in schema → don't fabricate a quota gauge
  (Realism); show counts/sizes from listed objects only, or flag a backend follow-up (Q5).

**F) Departments** (Detail blade · Departments tab)
- **List/detail**: `useDepartments()` (`list`, `getById`, `create`, `update`
  (OCC), `updatePromptConfig` (OCC), `remove`). Reuse **Card-Grid** (#4a) or
  `MasterDetailLayout` for the department list + nested **Department blade**.
  Fields: `code`, `name`, `description`, `parentDepartmentId` (hierarchy, exclude
  self/cycles), `defaultSummaryTemplate`, prompt-config (`preSummaryPromptId`,
  `newPatientPromptId`, `revisitPromptId`).
- **Add users to department** (department-side, nested blade): pick users (from
  tenant users) → `useUserDepartments().assign(userId, { departmentId })` per user
  (batch in the UI). This is the **bulk, department-first** flow the old console
  did NOT have.
- **Create agent instruction** (nested blade = `PromptTemplate`): `usePrompts()`:
  - `create({ name, description?, content, category: 'SYSTEM'|'SUMMARY'|'DNA_ANALYSIS'|'CUSTOM', status: 'DRAFT'|'PUBLISHED', variables?, departmentId })`
    — `scope` resolves to `DEPARTMENT_DEFAULT` when `departmentId` is set;
  - then `assignToDepartment({ departmentId, newPatientPromptId?, revisitPromptId?, expectedVersion })`
    or `updatePromptConfig` to wire it as the department's new-patient/revisit/
    pre-summary prompt.
  - Optional: `getVersions`, `activateVersion` (rollback), `test` (SMR quality score).
  **Naming note**: surface this as **"Agent Instruction"** in the UI (per the
  taxonomy) while persisting as `PromptTemplate` — keep one mental model
  (the old console fragmented it across Prompts + Department prompt-config + Harness).

### 4b.3 Components reused / built

- **Reuse**: `VirtualizedDataGrid` (tenants + tenant-users), `Sheet` (blades),
  `Tabs`, `Form`+zod+RHF, `StatusBadge`, `StatCard` (#3), `Card-Grid`/`Item-List`
  (#4a), `MasterDetailLayout`, `ConfirmDelete` (`features/common/confirm-delete.tsx`),
  the grid persistence adapter (`features/data-grid/*`), `useTenants`/`useUsers`/
  `useDepartments`/`useUserDepartments`/`usePrompts`/`useTenantBuckets`/
  `useTenantStorageConfig`/`useStorageKeys`/`useTenantFrontendConfig`.
- **Build (app-level, `apps/admin/src/features/tenants/`)**: `TenantDetailBlade`
  (tabbed), `TenantUserBlade`, `AssignDepartmentBlade`, `DepartmentBlade`,
  `AddUsersToDepartmentBlade`, `AgentInstructionFormBlade`, plus pure helpers
  (query/draft mappers, OCC-conflict reducer, key-uniqueness validator).

### 4b.4 Permissions (super-admin vs tenant-admin)

- **Super-admin** (`SUPER_ADMIN`/`GLOBAL_ADMIN`): create/archive tenants
  (`@CanManage('Tenant')`), cross-tenant view, must **select a working tenant** to
  manage departments/storage/agent-instructions (NoTenant empty state, GAP-ADM-001);
  "Acting on: «Tenant»" banner on mutations.
- **Tenant-admin**: confined to own tenant (404-over-403); no tenant create/delete;
  manages users/config/storage/departments within scope. Menu visibility is
  default-deny + RBAC-driven (X5).
- Enforce client-side guards mirroring the server (`isSuperAdmin`, `@CanManage`/
  `@RequiresIfMatch`); never the only line of defense.

### 4b.5 States

- **Loading**: skeleton grid + skeleton blade sections (`Skeleton`, never spinners).
- **Empty**: NoTenant (super-admin, GAP-ADM-001), no-users, no-departments,
  empty-bucket — all icon+title+desc.
- **Error**: inline form errors; blade-level error + retry; **OCC 409** → toast
  "changed since you loaded — refresh", refetch `version`, re-apply.
- **Saving**: disabled form + inline spinner in submit; success toast + invalidate.

### 4b.6 Figma frame plan + screen list (place in correct tier)

| Frame | Tier | Screen | Built from |
|---|---|---|---|
| `13 · Tenant Management` | 10–19 | Master grid (exists, drop Plan col) | `04 · Full-Screen Table` |
| `17 · Add Tenant Blade` | 10–19 | Create-tenant Sheet | `05 · Blades` |
| `18 · Tenant Detail — Overview` | 10–19 | KPIs + actions + protection state | `05 · Blades` + #3 `StatCard` |
| `20 · Tenant Users` | 20–29 | Users tab grid + Tenant User blade | `05` + `VirtualizedDataGrid` |
| `21 · Assign Department Blade` | 20–29 | User→dept membership | `05` nested blade |
| `22 · Tenant Configuration` | 20–29 | KV/flags/ASR settings + Acting-on banner | `05` + settings pattern |
| `34 · Department Management` | 30–49 | Dept Card-Grid + Department blade | `08 · Card-Grid` + `05` |
| `35 · Add Users to Department` | 30–49 | Department-side bulk assign | `05` nested blade |
| `36 · Agent Instructions` | 30–49 | PromptTemplate list + create/edit blade | `05` + `09` lists |
| `37 · Tenant Storage` | 30–49 | Buckets/objects + provider + keys | `05` + `09 · Item-List` |

(Numbers are suggestions within each tier band; confirm against the live Figma file
when persisted — README §5.5 notes the file is unsaved and renumbers on reconnect.)

### 4b.7 Referenced from `ui-playground` (and how this improves)

| `ui-playground` reference | Weakness | This design |
|---|---|---|
| `features/admin/tenants/index.tsx` (~2400-line monolith) | Mixes 6+ concerns; 180px list column; Card-in-pane create | Blade master→detail→nested; DataGrid master; consistent Sheet forms |
| Two parallel department UIs (standalone + tenant tab) | Duplicated schemas/dialogs | One `DepartmentBlade` reused in both entry points |
| `DepartmentAssignmentsSection` buried in user dialog | No bulk; user-only direction | Focused user-side blade **+ new** department-side "Add users" bulk flow |
| Prompts + Department prompt-config + Harness policy fragmented | No single "agent instruction" model | One "Agent Instruction" surface (persists as `PromptTemplate`, wires `Department` prompt-config) |
| Storage browser, no quota | Quota implied but absent | Honest: show real counts; flag quota as backend follow-up (Q5) |
| Flat ~17-item nav, scope-gated by disabled tooltip | No tiering, no NoTenant/Acting-on | Role-tier nav + NoTenant empty state + "Acting on: «Tenant»" banner |

### 4b.8 Vitest test list

- **`apps/admin`** (pure-logic; `src/**/*.test.ts`, `@arcaai/ui`+`@arcaai/vox` stubbed):
  tenant key case-insensitive uniqueness validator; tenant-user list query builder
  (page/sort/filter → `UserListQuery`); department draft↔`CreateDepartmentRequest`
  mapper; agent-instruction draft→`CreatePromptInput` (scope/category derivation);
  OCC-conflict reducer (409 → refetch version → retry); permission gate
  (`isSuperAdmin` → can-create-tenant, system-tenant protection).
- **`packages/ui`** (only for any reusable blade primitive added there, e.g. a
  widened-`Sheet` blade size variant): size variant renders; nested-blade back nav;
  axe pass.

---

## Proposed Ticket Breakdown (for confirmation)

Each ticket follows the 5-phase workflow with the **design-first gate**
(`12-design-workflow.mdc`): Figma frames designed/UXU-reviewed/approved → then code.

### TASK-377 — Shared reporting / metrics / chart component system (`@arcaai/ui`)
- **Scope**: workstream #3 — `StatusDot`, `StatCard`, `MetricChart`,
  `ServiceStatusItem`/`ServiceStatusBar`, `DateRangeSelector`, `TenantFilter`,
  `MetricTable`, `RunningTasksList`/`ModelsList` under
  `packages/ui/src/components/metrics/`; barrel export; Storybook + Vitest (§3.5).
- **Out of scope**: building the Dashboard/Monitoring *app routes* (separate app
  ticket) — TASK-377 ships the reusable primitives only.
- **Depends on**: `recharts`/shadcn `chart` (present in `@arcaai/ui`); Figma frames
  10 & 11 (exist); the Item-List foundation from **TASK-378** for
  `RunningTasksList` (soft dependency — can stub then swap).
- **Blocks**: the future Dashboard + Monitoring app screens; migrating
  `apps/admin` `system-health.tsx` onto canonical `StatCard`/`ServiceStatusBar`.

### TASK-378 — Collection foundations: Card-Grid, Item-List, Scroll-Spy Timeline (`@arcaai/ui`)
- **Scope**: workstream #4a — `CardGrid`/`EntityCard`, `ItemList` + extracted
  `useExpansion` (refactor shared with `HistoryTimelineList`), `ScrollSpyTimeline` +
  `useScrollSpy`; Figma foundation frames `08` + `09`; Storybook + Vitest (§4a).
- **Depends on**: `lib/shared` contracts (exist); `@tanstack/react-virtual` (exists);
  the timeline renderer registry (exists). Figma foundation band slot decision (Q1).
- **Blocks**: `RunningTasksList`/`ModelsList` in TASK-377; the Departments /
  agent-instruction / storage lists in TASK-379.

### TASK-379 — Tenant management blade interface (`apps/admin`)
- **Scope**: workstream #4b — deepen the tenant blade flow: master grid → tabbed
  detail blade → nested blades for users (incl. user→department assignment), config
  & settings, storage, departments (incl. department-side add-users + agent-instruction
  creation); product-tier Figma frames (§4b.6); app-level Vitest (§4b.8).
- **Depends on**: **TASK-378** (Card-Grid / Item-List for dept & object lists),
  optionally **TASK-377** (`StatCard` for the overview KPIs); existing SDK hooks
  (all present); foundation `05 · Blades`. Backend follow-ups Q4 (no `plan` field)
  and Q5 (no storage quota) should be resolved or scoped out first.
- **Blocks**: nothing downstream in this phase.

```
TASK-378 ──┬─→ TASK-377 (RunningTasksList/ModelsList)
           └─→ TASK-379 (dept/object/agent-instruction lists)
TASK-377 ····→ TASK-379 (StatCard for overview KPIs, soft)
```

Suggested order: **TASK-378 → TASK-377 → TASK-379** (foundations first, then
reporting primitives, then the app feature that consumes both).

## Assumptions

1. The `@arcaai/ui` TASK-372 layer is the canonical base; new primitives extend it
   and use semantic tokens only (no hardcoded colors like the manifest `StatCard`).
2. Charts render via the shadcn `chart` shell + `recharts@2.15.4` already in
   `packages/ui`; `apps/admin` consumes the built `MetricChart` (no chart lib added
   to the app). `--chart-1..5` tokens already exist in `apps/admin/src/index.css`.
3. The Dashboard (10) and Monitoring (11) Figma frames already exist (README
   §5.6–5.7); #3 maps onto them without redrawing the shells.
4. Tenant management keeps the **blade (Sheet)** paradigm already shipped in
   `apps/admin` — no modal/page rewrite.
5. "Agent instruction" is a **UI label** over the real `PromptTemplate` entity
   (`scope=DEPARTMENT_DEFAULT`, `departmentId` set) + `Department` prompt-config —
   no new backend model is introduced.
6. All mutations honor OCC (`expectedVersion`/`If-Match`) and 404-over-403 isolation,
   per the existing controllers.

## Open Questions

- **Q1 (frame numbering)**: confirm folding the three #4a foundations into `08 ·
  Card-Grid` + `09 · Lists (Item-List & Timeline)`, vs. renumbering to give the
  timeline its own frame. Recommendation: the `08/09` consolidation.
- **Q2 (Dashboard route)**: should `apps/admin` get a real `/dashboard` route + a
  new `NAV_SECTIONS` "Overview" entry (today `/` redirects to `/tenants`)? This is
  an app ticket beyond #3's primitives — confirm whether to include it now.
- **Q3 (P95 / metrics data)**: `useMonitoring`/`useHealthCheck` expose status,
  uptime, and session counts but **not P95 latency / requests-per-min / error-rate**
  shown in the Monitoring frame. Confirm a backend metrics endpoint or treat those
  KPIs as optional/hidden until available (`ServiceStatusItem.p95Ms` is already
  optional).
- **Q4 (tenant "plan")**: Figma frame 13 shows Enterprise/Pro/Trial/Starter plans,
  but `Tenant` has **no `plan` field**. Drop the column, or back it with
  `tags`/`metaData`/a tenant config key? (Realism Checklist requires real data.)
- **Q5 (storage quota)**: the schema has no quota/usage columns. Confirm we omit a
  quota gauge for now (show real object counts/sizes only) or schedule a backend
  follow-up.
- **Q6 (super-admin "manage a tenant")**: when a super-admin drills into a tenant's
  departments/storage (tier 30–49), do they set a **working tenant** (NoTenant gate
  + Acting-on banner) or use lightweight impersonation? Recommendation: working-tenant
  switch (already designed in foundation `06`), not impersonation.
