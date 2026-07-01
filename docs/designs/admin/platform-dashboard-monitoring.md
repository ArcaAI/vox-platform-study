> _Relocated from `docs/implementation/TASK-383-Platform-Dashboard-Monitoring/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-383 — Design Spec (Platform Dashboard + Monitoring)

> **Scope.** Desktop / Tablet / Mobile interface spec for the two super-admin **platform**
> surfaces shipped in TASK-383: **`10 · Dashboard`** (`/dashboard`) and **`11 · Monitoring`**
> (built in place on `/system-health`). Grounds every choice in the documented Figma node ids
> (the live Figma bridge has **no file connected this session** — no live reads/writes), the
> TASK-384 responsive model, the canonical theme tokens, and the design-system rules.
>
> **This is a documentation pass over already-shipped code** — it describes the built behavior of
> [`dashboard.tsx`](../../../apps/admin/src/routes/_authenticated/dashboard.tsx) and
> [`system-health.tsx`](../../../apps/admin/src/routes/_authenticated/system-health.tsx), flags
> where the build is grounded vs TARGET, and lists the responsive frames still to draw in Figma.

| | |
|---|---|
| **Ticket** | TASK-383 |
| **Frames** | `10 · Dashboard` (`69:1265`) · `11 · Monitoring` (`70:1692`) — `HOPE-Admin-Console` |
| **Tier** | `10–19` Global / **Super-admin only** (cross-tenant; never requires a selected tenant) — `12-design-workflow.mdc` §3 |
| **Design refs** | TASK-371 [README §5.9](../../implementation/TASK-371-Admin-Console-Redesign/README.md) (Pass 9) · screenshots `admin-10-dashboard.png`, `admin-11-monitoring.png` |
| **Foundations** | `02 · DataGrid` `60:745` · `07 · Responsive` `62:1082` · TASK-377 metrics primitives (`StatCard`, `MetricChart`, `MetricTable`, `StatusDot`, `DateRangeSelector`, `TenantFilter`) |

---

## 1. Shared foundations

### 1.1 Responsive model (from TASK-384 / foundation `07 · Responsive`)

| Tier | Range | Playwright project | Shell (app-shell.tsx) |
|---|---|---|---|
| **Desktop** | `≥ lg` (≥ 1024) | `desktop` 1280×800 | Full `w-64` sidebar (icon + label) + topbar |
| **Tablet** | `md..lg` (768–1023) | `tablet` 834×1112 | **Icon-rail** `w-16` sidebar + topbar |
| **Mobile** | `< md` (< 768) | `mobile` 390×844 | App-bar + hamburger → modal nav drawer |

Both surfaces are **content** screens — the shell chrome (sidebar/rail/drawer, tenant switcher) is
owned by `app-shell.tsx` (TASK-384) and is **out of this ticket's file set**. This spec covers the
**page body** only: KPI grids, charts, and metric tables and how they reflow inside the content
column the shell hands them.

### 1.2 Token usage (semantic only — `theme.css`)

Never hardcode color/spacing. The surfaces use only semantic tokens:

| Token | Use on these surfaces |
|---|---|
| `--primary` | KPI accent for scale counts (Active tenants, Total users) |
| `--success` | healthy `StatusDot`, "Live sessions" accent, "All operational" footer |
| `--warning` | **degraded** `StatusDot` + "Degraded services" accent (SMR) |
| `--destructive` | unhealthy `StatusDot`, error-variant icon/badge (`bg-destructive/10`) |
| `--muted-foreground` | secondary captions, TARGET em-dash cells, hints |
| `--chart-1` / `--chart-2` | consultation chart series (new-visits / re-visits via `CHART_SERIES`) |
| `--radius` | card/skeleton corners (`Card`, `StatCard`, `Skeleton`) |

### 1.3 Breakpoint reality of the built grids (precise)

The KPI rows and table grids use **Tailwind** breakpoints, which differ slightly from the
mobile/tablet/desktop *tiers* above. Documented exactly so the responsive frames + E2E reflow
assertions are grounded:

| Block | Class (shipped) | < 640 | 640–1279 | ≥ 1280 |
|---|---|---|---|---|
| KPI rows (both surfaces) | `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` | **1-up** | **2-up** | **4-up** |
| Services + Models tables | `grid-cols-1 lg:grid-cols-2` | 1-up (stacked) | 1-up < 1024, **2-up** ≥ 1024 | 2-up |
| Chart controls row | `flex flex-wrap … justify-between` | wraps below title | inline | inline |

> **Note (4-up tier = `xl` 1280, not `lg` 1024).** The "KPI 1→2→4 reflow" the brief calls for is
> the `sm`/`xl` ladder above. The Playwright `desktop` project is exactly 1280 wide → 4-up; `tablet`
> 834 → 2-up; `mobile` 390 → 1-up. So the three viewport projects each land on a distinct KPI column
> count, which the frontend E2E asserts.

### 1.4 Loading / empty / error (design-system contract — `10-skeleton-loading.mdc`, `11-ux-ui-principles.mdc` §4)

- **Loading** — never spinners. `StatCard isLoading` and `MetricChart isLoading` / `MetricTable
  isLoading` render `Skeleton` shapes that match the loaded layout (`skeletonRows={6}` on both tables).
- **Empty** — icon + title + description (`Empty` primitive); never a blank area.
- **Error** — a centered retry `Card` with `role="alert"`, a `--destructive` medallion, a human
  message, a **Retry** button (re-runs the fan-out), and the raw `error.message` in `font-mono`.

---

## 2. `10 · Dashboard` (`69:1265`) — `/dashboard`

**Purpose (Pass 9).** A cross-tenant operator overview answering *"is the whole platform healthy &
busy right now?"* — super-admin only. Composes TASK-377 primitives over a `Promise.allSettled`
SDK fan-out (`listTenants` · `listPaginated` users · `listConsultations` · `refreshMonitoring` ·
`check`).

**Vertical rhythm (all tiers):** `space-y-5` — PageHeader → headline KPI row → secondary KPI row →
focal chart card.

### 2.1 Desktop (≥ 1024; 4-up at ≥ 1280)

- **Layout & grid.** Single content column. `PageHeader` (`h2` "Platform Dashboard" + description)
  with right-aligned actions. **Headline KPI row** (4× `StatCard`, `xl:grid-cols-4`): Active tenants
  (`--primary`) · Live sessions (`--success`) · Processing jobs · **Degraded services** (`--warning`
  when > 0, footer = `StatusDot` dot+label of degraded names, else "All operational"). **Secondary
  KPI row** (4× `StatCard`): Total users (`--primary`, REAL) · Transcription min · 24h · Summaries ·
  24h · Storage used — the last three TARGET (em-dash + "… · Target" hint).
- **Navigation.** Reached from sidebar **Overview → Dashboard** (`requireSuperAdmin`); breadcrumb
  `Home / Platform / Dashboard` (route `staticData.crumb`). The chart's `TenantFilter` is a
  **cross-link**: picking a tenant navigates to that tenant's `…/overview` (TASK-380), the
  tenant-scoped sibling.
- **Primary actions.** `New tenant` (primary) opens the reused `TenantFormDialog` (real create →
  toast → reload). `Export` is a flagged placeholder (info toast — TARGET).
- **Data display.** Full-width focal `MetricChart` (`kind="bar"`, height 300) of consultation
  sessions/day via `bucketConsultations` + `CHART_SERIES` (new-visits + re-visits, `--chart-1/2`),
  legend on. Controls top-right of the card: super-admin `TenantFilter` (All tenants) + 3-preset
  `DateRangeSelector` (Week/Month/Year). Footer caption: "N sessions · {range}".
- **Touch targets.** Desktop pointer; buttons are shadcn default `h-9`.

### 2.2 Tablet (768–1023)

- **Layout & grid.** Shell is the icon-rail; content column widens. KPI rows are **2-up**
  (`sm:grid-cols-2`, `xl` not yet active) — headline = 2 rows of 2, secondary = 2 rows of 2. Chart
  card stays full-width; the controls row may wrap the `TenantFilter`/`DateRangeSelector` beneath the
  title via `flex-wrap`.
- **Navigation / actions.** Header actions remain inline (they fit at this width); breadcrumb
  unchanged.
- **Data display.** Chart unchanged (responsive width, fixed height 300). `TenantFilter` keeps its
  `w-44`.

### 2.3 Mobile (< 768; 1-up at < 640)

- **Layout & grid.** Single column. KPI rows **stack 1-up** below 640 (`grid-cols-1`) — eight
  full-width `StatCard`s in source order (headline four, then secondary four). At 390 wide the chart
  is full-bleed inside its `Card` (`p-5`), height fixed at 300, width responsive.
- **Navigation.** Shell becomes app-bar + hamburger drawer (TASK-384). The page body is unchanged
  except for reflow.
- **Primary actions.** `New tenant` + `Export` sit in the wrapped `PageHeader` actions row
  (`flex-wrap`). The `TenantFormDialog` goes near-full-screen on mobile via TASK-384's
  `MOBILE_DIALOG_CONTENT` (≥ 44px footer actions) — owned by that ticket; this surface just opens it.
- **Data display.** Chart controls wrap under the title (`flex-wrap`); `DateRangeSelector` popover and
  `TenantFilter` select are tap-friendly.
- **Touch targets.** Dialog footer actions are ≥ 44px (TASK-384 dialog fragment); the page's own
  `Button`s are the default size — see §5 (mobile-target follow-up is TASK-384's backlog).

### 2.4 State variants (Dashboard)

| State | Trigger | Render |
|---|---|---|
| **Loading** | initial `load()` in flight | every `StatCard isLoading` + `MetricChart isLoading` show `Skeleton`s matching the loaded grid |
| **Empty** | `!loading && !error && tenants 0 && users 0 && consultations 0` | `Empty` (Building2 icon) "No platform activity yet" + **New tenant** CTA |
| **Error** | focal `listConsultations` rejected | centered retry `Card` (`role="alert"`, `--destructive` medallion, **Retry** → `load()`, mono `error.message`) |

> **Degrade-independently note.** Each fan-out source settles independently; only a **focal
> consultations** failure drives the error variant. A failed tenants/users/monitoring call leaves its
> KPI as an em-dash rather than blanking the page.

---

## 3. `11 · Monitoring` (`70:1692`) — `/system-health`

**Purpose (Pass 9).** Real-time health, latency & throughput across all microservices — the
Service-Health redesign, super-admin only. Polls every **30 s** (`startPolling`).

**Vertical rhythm (all tiers):** `space-y-5` — PageHeader → throughput KPI row → request-volume chart
→ Services + Models tables.

### 3.1 Desktop (≥ 1024; 4-up KPIs at ≥ 1280)

- **Layout & grid.** `PageHeader` ("Service Monitoring" + description) with `Export` + `Configure
  alerts` actions (both flagged TARGET → info toast). **Throughput KPI row** (4× `StatCard`,
  `xl:grid-cols-4`): Requests/min · Error rate · Sockets/min · Total sockets — **all TARGET**
  (em-dash + "… · Target"; no metrics endpoint). **Request-volume `MetricChart`** (bar, height 260)
  with the same Week/Month/Year `DateRangeSelector` + `TenantFilter` controls — data is TARGET, so it
  renders a custom **"Request-volume telemetry not instrumented"** `Empty` (Activity icon). **Tables
  row** (`lg:grid-cols-2`): **Services** + **Models & running tasks** side-by-side.
- **Navigation.** Sidebar **Observability → Monitoring** (relabel of "System Health"; path kept at
  `/system-health`); breadcrumb `Home / Platform / Monitoring`.
- **Data display — Services table** (`MetricTable`, `aria-label="Service health"`): columns **Service
  · Status · P95 · Uptime**. One row per canonical microservice in fixed order **API · STT · SMR ·
  NLP · Guardrail · Harness** (`SERVICE_ORDER`, `buildServiceRows`). **Status** = REAL `StatusDot`
  dot+label (`healthy→success`, `degraded→warning`, `unhealthy→destructive`, `checking→info`,
  `unknown→neutral`); **SMR surfaces Degraded** when reported. **Uptime** = REAL duration
  (`formatUptime`, monitoring `uptimeSeconds` → health `uptime_seconds` fallback). **P95** = TARGET
  em-dash.
- **Data display — Models table** (`MetricTable`, `aria-label="Models and running tasks"`): columns
  **Model · Service · Running · Avg latency**. Six grounded rows (`PLATFORM_MODELS`):
  `whisper-large-v3-turbo` + `silero-vad-v5` (STT), `gemma-4-e4b` (SMR), `granite-guardian-4.1-8b`
  (Guardrail), `Medical-NER` + `symps-disease-bert` (NLP). **Model + Service REAL identity** (mono
  model id); **Running + Avg latency TARGET** em-dash.
- **Primary actions.** `Export`, `Configure alerts` — both TARGET placeholders.

### 3.2 Tablet (768–1023)

- **Layout & grid.** Icon-rail shell. KPI row **2-up**. Chart full-width (height 260). **Tables stack
  1-up** below 1024 (`lg:grid-cols-2` not yet active) — Services above Models, each full-width.
- **Data display.** `MetricTable` keeps four columns; the shared shadcn `Table` already wraps in
  `overflow-x-auto` (TASK-384 finding), so a four-column table that exceeds the card width scrolls
  horizontally rather than clipping. Headers + dot+label status remain legible.

### 3.3 Mobile (< 768)

- **Layout & grid.** Single column, everything full-width. KPI row **1-up** (< 640). Chart full-bleed
  in its `Card`. Services then Models tables stacked.
- **Data display — MetricTable horizontal-scroll vs stack.** The four-column metric tables are the
  tightest fit at 390 wide. As shipped they rely on the shadcn `Table`'s built-in
  `overflow-x-auto` wrapper → **horizontal scroll within the card** (no clipping, no nested page
  scroll). A dedicated **card-list / stacked** mobile variant (one stacked block per service/model)
  is **not yet built** — see §5 + TASK-384 backlog ("MetricTable card-list").
- **Navigation / actions.** App-bar + drawer (shell). `Export` / `Configure alerts` wrap in the
  header actions row.
- **Touch targets.** Status dots are presentational; the only interactive controls (date range,
  tenant filter, header buttons) keep default sizing — mobile ≥ 44px bump is TASK-384 backlog.

### 3.4 State variants (Monitoring)

| State | Trigger | Render |
|---|---|---|
| **Loading** | `isLoading && serviceCount === 0` (first load) | KPI `StatCard`s, chart, and both `MetricTable`s show `Skeleton`s (`skeletonRows={6}`) |
| **Empty (services)** | health map empty, not loading | Services table `emptyState="No service health reported."`; Models table still lists the static inventory |
| **Empty (chart)** | always (TARGET) | custom `Empty` "Request-volume telemetry not instrumented" (Activity icon) |
| **Error** | `error && serviceCount === 0 && !isLoading` (health unreachable on first load) | centered retry `Card` (`role="alert"`, **Retry** → `refreshAll()`, mono `error.message`) |

> **Polling note.** After the first successful load, transient poll failures do **not** flip the page
> to the error variant (guarded by `serviceCount === 0`) — the last-good rows stay on screen, matching
> the design's "real-time, resilient" intent.

---

## 4. Super-admin-only gating (tier `10–19`)

Both surfaces are **cross-tenant** and never require a selected tenant (`12-design-workflow.mdc`
§ tier rules). Gating today is **two-layered**:

1. **Nav visibility** — **both** the **Dashboard** and **Monitoring** items are `requireSuperAdmin` in
   `nav.ts` (hidden from tenant-admins; `getNavSections` filters them for non-super-admins), and the
   dashboard chart's `TenantFilter` is rendered only when `isSuperAdmin(roles)`. **Finding F-NAV1
   RESOLVED (2026-06-30):** the **Monitoring** item (`/system-health`) gained `requireSuperAdmin: true`
   (`nav.ts:58`), so it is now hidden like Dashboard — the earlier IA inconsistency is closed. A
   **route-level** guard remains the open follow-up (see traceability **R1**).
2. **Backend authorization (the real boundary)** — every cross-tenant data source the surfaces read
   is `@Authorize(['manage','all'])` (super-admin) at the controller: `MonitoringController`
   (`monitoring.controller.ts:14`) and `/health/services` (`health.controller.ts:182`). A
   tenant-scoped caller (e.g. `doctor` or a tenant-admin) is **403** on `sessions` / `uptime` /
   `services` — so even via a direct deep-link to `/system-health`, **no cross-tenant data leaks**.

> **Known gap (documented, not fixed here).** There is **no route-level guard** on `/dashboard` or
> `/system-health` — the router context carries only `isAuthenticated` (no roles). A tenant-admin who
> deep-links to `/dashboard` sees the shell + the page chrome, but the cross-tenant data calls 403 at
> the API, so no cross-tenant data leaks. A role-aware route guard / redirect is a TASK-384 / shell
> follow-up (the ticket explicitly kept the default landing at `/tenants`). Captured as **risk R1** in
> the traceability matrix.

---

## 5. Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames for **both** surfaces, grounded in the desktop `10 · Dashboard 69:1265` and `11 · Monitoring 70:1692`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-383 · 10a Platform Dashboard — Tablet` | Tablet (834) | `194:356` |
| `TASK-383 · 10b Platform Dashboard — Mobile` | Mobile (390) | `194:357` |
| `TASK-383 · 11a Monitoring — Tablet` | Tablet (834) | `194:358` |
| `TASK-383 · 11b Monitoring — Mobile` | Mobile (390) | `194:359` |

These cover the headline + secondary KPI `4 → 2 → 1` reflow, focal chart full-width/full-bleed, the request-volume "telemetry not instrumented" Empty, Services + Models tables stacked 1-up (tablet) → MetricTable **card-list** (mobile), and the `— · Target` em-dash posture for TARGET tiles. The **state** frames (`10c`/`11c`) and the **TARGET annotations** frame remain deferred below.

### Still deferred

Deferred to a serialized Figma pass once a file is connected (screenshots / visual alignment come
later). Today only the **desktop** frames `10 · Dashboard 69:1265` and `11 · Monitoring 70:1692`
exist; the responsive variants and the state frames are documented above but **not yet drawn**:

1. **`10a · Dashboard — Tablet`** — KPI rows 2-up; chart controls wrapping; icon-rail context.
2. **`10b · Dashboard — Mobile`** — KPI rows 1-up (8 stacked cards); chart full-bleed; wrapped header
   actions; `TenantFormDialog` near-full-screen.
3. **`10c · Dashboard — States`** — loading (skeleton grid) · empty ("No platform activity yet") ·
   error (retry card). *(Built in code; no frame.)*
4. **`11a · Monitoring — Tablet`** — KPI 2-up; tables stacked 1-up.
5. **`11b · Monitoring — Mobile`** — KPI 1-up; **MetricTable card-list / stacked variant** (the
   horizontal-scroll fallback shipped today is the interim; the card-list is the target — pairs with
   TASK-384's "MetricTable card-list" backlog).
6. **`11c · Monitoring — States`** — loading · services-empty · chart "telemetry not instrumented" ·
   health-unreachable error. *(Built in code; no frame.)*
7. **`10/11 · TARGET annotations`** — a frame documenting which tiles/columns are TARGET (em-dash +
   "Target") vs REAL, so the design file mirrors the build's "never fabricate" posture.

> When the TARGET backends land (transcription-min / summaries / storage roll-ups; requests-min /
> error-rate / sockets / P95; per-model running + latency; request-volume time-series — see
> traceability backlog row T1), redraw the affected tiles/columns/chart with real values and drop the
> "Target" hint.
