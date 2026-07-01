> _Relocated from `docs/implementation/TASK-380-Tenant-Dashboard/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-380 — Design Spec · Tenant Dashboard (frame 18d)

> Desktop / Tablet / Mobile interface spec for the tenant **Overview tab** upgraded into
> the operational **`18d · Tenant Dashboard`**. Authored per
> [`docs/qa/E2E-AND-QA-CONVENTIONS.md`](../../qa/E2E-AND-QA-CONVENTIONS.md) §2, grounded in
> the documented Figma node ids (the live Figma bridge has **no file connected this
> session** — no live reads/writes were attempted), the TASK-384 responsive model, the
> semantic tokens in [`../TASK-371-Admin-Console-Redesign/theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css),
> and the design rules [`11-ux-ui-principles.mdc`](../../../.cursor/rules/11-ux-ui-principles.mdc) /
> [`10-skeleton-loading.mdc`](../../../.cursor/rules/10-skeleton-loading.mdc).

| | |
|---|---|
| **Ticket** | TASK-380 |
| **Surface** | Tenant detail → **Overview** tab (`routes/_authenticated/tenants/$tenantId/overview.tsx`) |
| **Figma** | `HOPE-Admin-Console` · `18d · Tenant Dashboard` `120:8843` + states `120:10826` / `120:10998` / `120:11169` / `120:11341` |
| **Tier** | 30–49 design taxonomy is tenant-scoped, but `18d` is the tenant-detail **Overview** (a 20–29 shared drill-in); super-admin reaches it cross-tenant, tenant-admin sees it read-only for its own org. |
| **Refs** | TASK-371 [`README.md`](../../implementation/TASK-371-Admin-Console-Redesign/README.md) §5.14 / §5.14.1 / §5.14.2 · [`TRACEABILITY-MATRIX.md`](../../implementation/TASK-371-Admin-Console-Redesign/TRACEABILITY-MATRIX.md) O1/O2/O3 · TASK-384 [`README.md`](../../implementation/TASK-384-Responsive-Admin-Surfaces/README.md) |

## Responsive model (TASK-384)

| Tier | Width | Tailwind anchor |
|---|---|---|
| **Mobile** | `< 768` | base / `sm` (640) |
| **Tablet** | `768–1023` | `md` |
| **Desktop** | `≥ 1024` | `lg` / `xl` (1280) |

> **Grid-threshold note (grounded in shipped code, not the idealized model).** The KPI rows
> reflow with `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` (headline) and `… xl:grid-cols-5`
> (secondary). So the **full-width 4-up/5-up only engages at `xl` (1280)**, not at `lg`
> (1024); the 1024–1279 band stays 2-up. TASK-384 audited the dashboard as "KPI grids reflow
> OK" and left it unchanged. The 1→2→(4/5) intent below is satisfied; the exact `lg`-vs-`xl`
> breakpoint for the widest tier is flagged as a TASK-384 (responsive-owner) follow-up, not
> changed here.

## Semantic tokens used (no hardcoded colors)

| Role | Token | Where |
|---|---|---|
| Brand / primary KPI accent | `--primary` (teal) | Active-users accent; chart series **New** = `--chart-1` |
| Healthy / live | `--success` (green) | Running-sessions accent; "all systems operational" dot |
| Attention | `--warning` (amber) | Pending-review accent; degraded-service dot/hint |
| Failure | `--destructive` (red) | Error variant; unhealthy dot; failed-audit dot |
| Info / read-only | `--info` (indigo) | Tenant-admin banner dot; chart series **Re-visit** = `--chart-2` |
| Secondary text / TARGET | `--muted-foreground` on `--muted` | hints, captions, em-dash TARGET tiles |

---

# `18d · Tenant Dashboard` — main (`120:8843`)

**Question the surface answers:** *"Is this tenant healthy & busy right now?"* Composition (top→bottom):
headline KPI row → secondary KPI row → focal consultation `MetricChart` (+ `DateRangeSelector` + `TenantFilter`) beside a recent-activity `ItemList` → audio-pipeline strip → permission banner.

### Desktop (`≥ 1024`, full chrome at `xl ≥ 1280`)

- **Layout & grid.** Vertical stack, `space-y-5`, inside the tenant-detail shell (sidebar + topbar + tenant tab-bar owned by `$tenantId/route.tsx`, out of scope here).
  - **Headline KPI row** — 4 `StatCard`s in `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`: **Active users** (accent `primary`), **Departments**, **Running sessions** (accent `success`, `live · synced {relative}`), **Services healthy `n/total`** (accent tracks health; footer `StatusDot` + hint, e.g. `SMR degraded`).
  - **Secondary KPI row** — 5 `StatCard`s in `grid-cols-1 sm:grid-cols-2 xl:grid-cols-5`: **Open sockets [TARGET]** (disabled, em-dash, hint `Concurrent WS · Target`), **Processing jobs**, **Consultations today** (`{new} new · {revisit} re-visit`), **Pending review** (accent `warning` when > 0), **Consumption [TARGET]** (disabled, em-dash, hint `Summaries / 24h · Target`).
  - **Focal row** — `grid-cols-1 lg:grid-cols-3`: the **chart `Card` spans `lg:col-span-2`**; the **recent-activity `Card`** takes the last third.
- **Navigation.** Chart header trailing controls: `TenantFilter` (`w-44`, **super-admin only**, navigates to the chosen tenant's dashboard) + `DateRangeSelector` (`week`/`month`/`year`, `align="end"`). Activity card has a `View all →` link to `/audit-log`. Empty/error CTAs deep-link to the tenant's Users / Departments / `/system-health`.
- **Primary actions.** This is a **read/monitor** surface — no mutations. Interactive controls = range preset, tenant switch (super-admin), and navigational links.
- **Data display.** KPIs = `StatCard` tiles (`tabular-nums`, label/value/hint, optional footer dot). Volume = `MetricChart kind="bar"` (`height={260}`, `showLegend`, two stacked-by-day series **New** `--chart-1` / **Re-visit** `--chart-2`, `xKey="label"`); footer reads `{total} session(s) · {caption}`. Activity = `ItemList<ActivityItem>` rows: leading `StatusDot` (success/destructive/warning/neutral) + title + `{actor} · {relative time}` + trailing mono action `code`. Pipeline = horizontal `ServiceStatusItem` strip (STT/VAD/SMR/Guardrail/NLP, `density="compact"`, dot+label+model version).
- **Dialogs.** None on this surface.
- **Loading / empty / error.** See the dedicated state frames below.
- **Touch targets.** Range/tenant selectors are shadcn triggers; `View all` and CTA buttons are native links/buttons (≥ 44px on touch via the mobile tier).

### Tablet (`768–1023`)

- **Layout & grid.** Headline KPIs **2-up** (`sm:grid-cols-2`), secondary KPIs **2-up**; the focal row **stacks** (chart above activity) because the `lg:grid-cols-3` split only engages at `≥ 1024`. Chart stays **full-width** of its column and re-flows its fixed height with responsive width.
- **Navigation.** Tenant-detail shell shows the **icon-rail** sidebar (TASK-384); the dashboard's own chart controls are unchanged. The chart header `flex-wrap`s, so `TenantFilter` + `DateRangeSelector` wrap under the title when space is tight.
- **Data display.** Same components; the audio-pipeline strip `flex-wrap`s onto 2 rows. `ServiceStatusItem density="compact"` keeps each chip compact.
- **Everything else** matches Desktop.

### Mobile (`< 768`)

- **Layout & grid.** Single column throughout: headline KPIs **1-up** below 640 and **2-up** in the 640–767 band (`sm:grid-cols-2`); secondary KPIs likewise; chart and activity fully stacked. Generous vertical rhythm (`space-y-5`, `gap-4`).
- **Navigation.** Shell becomes the app-bar + hamburger drawer (TASK-384). Chart-header controls wrap to their own line; `DateRangeSelector` + (super-admin) `TenantFilter` remain reachable. `View all →` and CTAs are full-tap rows.
- **Data display.** KPI tiles stack; the chart keeps `height={260}` (horizontally scroll-free, width-responsive); activity `ItemList` is a vertical tap list; the pipeline strip wraps to multiple lines (each chip a self-contained dot+label).
- **Touch targets.** Selector triggers and link/buttons honor the ≥ 44px rule (shell-level `max-md:size-11`; CTA buttons are full-width-friendly in the empty/error cards).

---

# `18d · Tenant Dashboard — Loading` (`120:10826`)

Driven by a single `loading` flag (`Promise.allSettled` across all sources resolves it once).

- **Desktop / Tablet / Mobile.** The **full skeleton mirrors the loaded layout** (rule `10-skeleton-loading.mdc` §3): both KPI grids render their `StatCard`s with `isLoading` (skeleton value bars at the same grid breakpoints), the `MetricChart` renders its built-in `isLoading` bar skeleton at `height={260}`, and the activity `ItemList` renders `isLoading` skeleton rows. **No spinners, no "Loading…" text, no blank space.** The permission banner + card chrome (titles/captions) stay visible so the page does not reflow when data lands.
- **Touch targets.** N/A (non-interactive while loading); controls hydrate in place.

---

# `18d · Tenant Dashboard — Empty` (`120:10998`)

Shown when, after a successful load, the tenant has **no** users, departments, consultations, or audit history (`isEmpty`).

- **Layout & grid.** A **zeroed headline KPI row** (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`): Active users `0` (`Invite the first user`), Departments `0` (`Create a department`), Running sessions `0` (`No live consultations`), Audio pipeline `Idle` (`No active streams`) — so the operator still sees the shape of the dashboard. Below, a single `Empty` card.
- **Data display.** `Empty` block = icon (`CirclePlus`) + title **"No activity in this tenant yet"** + description naming the tenant — satisfies rule §4 ("empty states must have icon + title + description").
- **Primary actions.** Two CTAs in `EmptyContent`: **Invite users** (→ `/tenants/$tenantId/users`) and **Create department** (→ `/tenants/$tenantId/departments`). Permission banner remains beneath.
- **Tablet / Mobile.** KPI tiles reflow 2-up / 1-up; the `Empty` card centers; CTAs `flex-wrap` and grow to ≥ 44px on touch.

---

# `18d · Tenant Dashboard — Error` (`120:11169`)

Shown when the **focal consultations metric** rejects (the error-driving source); other sources degrade silently.

- **Layout & grid.** A single full-width `Card` (`p-10`) with a centered `role="alert"` column: `TriangleAlert` in a `bg-destructive/10` circle, heading **"Couldn't load tenant metrics"**, a muted explanation naming the tenant, and the raw `error.message` in `font-mono text-xs`.
- **Primary actions.** **Retry** (re-runs `load()`) + **View status page** (outline → `/system-health`). Permission banner remains beneath.
- **Color.** `--destructive` for the icon/accent only; body stays on `--foreground` / `--muted-foreground` (no full-red panel).
- **Tablet / Mobile.** Card fills width; the action row `flex-wrap`s; buttons reach ≥ 44px on touch. Per rule §5, the failure is **explicit and recoverable** (never a silent fail).

---

# `18d · Tenant Dashboard — Tenant-admin` (`120:11341`)

Same dashboard, **own-tenant scope**, rendered for a `TENANT_ADMIN` (no cross-tenant reach).

- **Layout & grid.** Identical KPI/chart/activity/pipeline composition.
- **Navigation — the one structural difference.** The chart header **omits the `TenantFilter`** (it renders only when `superAdmin && tenantOptions.length > 0`), so a tenant-admin cannot switch tenants. The `DateRangeSelector` stays.
- **Banner.** Instead of the super-admin `ActingOnBanner` (full-control / `__GLOBAL__`-protection copy), tenant-admins get a `role="status"` **read-only** banner: `--info` dot + "Tenant admin · {name}" + "Read-only metrics view scoped to your organization… contact a super-admin to make tenant-level changes."
- **Backend reality (grounds the variant).** `/monitoring/sessions` and `/health/services` are **super-admin-only** (`@Authorize(['manage','all'])`); a tenant-admin's calls 403. Because the page fans out with `Promise.allSettled`, those KPIs **degrade gracefully** for tenant-admins — **Running sessions** / **Services healthy** show em-dash and the audio-pipeline strip reads `unknown`, while tenant-scoped sources (usage, audit, consultations) populate normally. This is REAL behavior, not an error state.
- **Tablet / Mobile.** Same reflow as the main frame; the read-only banner is full-width.

---

## Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames grounded in the desktop `18d · Tenant Dashboard 120:8843`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-380 · 18d Tenant Dashboard — Tablet` | Tablet (834) | `194:137` |
| `TASK-380 · 18d Tenant Dashboard — Mobile` | Mobile (390) | `194:138` |

These cover the headline reflow (KPI 4-up → 2-up → 1-up, chart full-width/full-bleed, pipeline strip wrap). The dedicated **state** frames (degraded telemetry, partial-failure, control open-states, dark-mode, TARGET legend) remain deferred below.

### Still deferred

Deferred to a serialized Figma pass once a file is connected (visual alignment / screenshots come later — not attempted this session):

1. **`18d · Tenant Dashboard — Tablet` (`md` 768–1023)** — explicit 2-up KPI + stacked chart/activity variant (only the desktop + state frames exist today).
2. **`18d · Tenant Dashboard — Mobile` (`< 768`)** — 1-up KPI stack, wrapped chart-header controls, wrapped pipeline strip, app-bar/drawer chrome.
3. **`18d — Tenant-admin · degraded telemetry`** — a dedicated state showing **Running sessions / Services healthy as em-dash** + **audio-pipeline `unknown`** (the real `403` degrade for tenant-admins), distinct from the generic Error frame.
4. **`18d — Partial-failure (mixed)`** — only some `Promise.allSettled` sources fail (e.g. monitoring down but consultations OK): which tiles em-dash vs render.
5. **`Dlg/Popover · DateRangeSelector` open state** + **`TenantFilter` open list** — the control surfaces aren't captured as frames.
6. **Per-tier dark-mode variants** of all five `18d` frames (token system supports it; not yet drawn — consistent with the TASK-371 deferral list).
7. **TARGET annotations** — a frame legend distinguishing **Open sockets** / **Consumption** / **per-model stream counts** / **server-side range aggregation** as design-only (no backend), so reviewers don't read them as built metrics.
