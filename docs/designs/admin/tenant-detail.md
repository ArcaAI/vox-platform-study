> _Relocated from `docs/implementation/TASK-379-Tenant-Detail-Pages/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-379 — Design Spec (Desktop / Tablet / Mobile)

> **What this is:** the interface specification for the page-based Tenant Detail surface
> and the app-shell upgrades shipped in TASK-379. One section per design frame (exact
> name + node id from the ticket README §5.12/§5.13). Each surface is specced at three
> breakpoints, grounded in the documented Figma node ids, the **TASK-384 responsive model**,
> the design-system rules, and **semantic theme tokens only**.

| | |
|---|---|
| **Ticket** | TASK-379 — Page-based Tenant Detail + App-Shell Upgrades |
| **Status** | Review (implementation shipped; this spec documents the as-built + the design intent) |
| **Design source** | `HOPE-Admin-Console` (Figma) frames §5.12/§5.13; tokens `docs/implementation/TASK-371-Admin-Console-Redesign/theme.css` |
| **Figma bridge** | **No file connected this session** — grounded in documented node ids only; no live Figma reads/writes |
| **Design rules** | `.cursor/rules/11-ux-ui-principles.mdc`, `.cursor/rules/10-skeleton-loading.mdc`, `.cursor/rules/12-design-workflow.mdc` |

## Responsive model (TASK-384, authoritative)

| Breakpoint | Range | Shell | Tables / grids | Detail tabs | Cards |
|---|---|---|---|---|---|
| **Mobile** | `< md` (< 768) | App-bar + hamburger → modal nav drawer (scrim, bottom tenant switcher) | **Card-list** (tap-through + trailing chevron) + **FAB** | **`Select`** | 1-up |
| **Tablet** | `md..lg` (768–1023) | **Icon-rail** sidebar (icons only) + topbar; switcher → avatar | **Condensed** table (low-priority columns hidden) | Scrollable / segmented underline tabs | 2-up |
| **Desktop** | `≥ lg` (≥ 1024) | Full sidebar (icon + label) + topbar | Full `VirtualizedDataGrid` | Horizontal underline tabs | 4-up |

Cross-cutting: ≥ 44px touch targets on mobile, WCAG 2.2 AA, full-screen dialogs on mobile,
semantic theme tokens only (`--background`, `--foreground`, `--primary` (teal-600),
`--muted-foreground`, `--border`, `--card`, `--sidebar`, `--accent`, `--success`, `--warning`,
`--destructive`, `--ring`). The active tab/sub-tab is teal — `--primary` (design `#0e626e`).

**Skeleton rule (`10-skeleton-loading.mdc`):** every data-fetching state uses `<Skeleton/>`
shaped to the loaded layout — never a spinner or "Loading…" text. Empty states are
icon + title + description (`Empty`/`EmptyHeader`/`EmptyMedia`). Errors are an alert card
with a retry. These three states are specified once here and referenced per surface.

---

## 0 · Shell & cross-cutting chrome — `06 · Multi-Tenancy & Impersonation 61:985`

The app-shell upgrades (role-tiered nav, working-tenant switcher, "Acting on" banner,
NoTenant state, breadcrumb) are the cross-cutting frame for this ticket. As-built:
`components/layout/app-shell.tsx`, `components/layout/breadcrumbs.tsx`,
`features/tenants/working-tenant-switcher.tsx`, `features/tenants/tenant-context.tsx`,
`lib/nav.ts`.

### Desktop (≥ lg)
- **Layout & grid:** fixed two-pane — `w-64` sidebar (`--sidebar`, right border `--sidebar-border`) + a `min-w-0` content column; topbar `h-14` (`--card/60` + backdrop blur); main content `max-w-[1400px]` centered, padding `p-6`.
- **Navigation:** role-tiered `SidebarNav` from `getNavSections(roles)`. Tiers mirror the design taxonomy (`12-design-workflow.mdc`): **Overview** (Dashboard 🔒), **Platform** (Tenants 🔒), **Identity & Access** (Users · Roles · API Keys), **Clinical Operations**, **Observability**, **Settings**. Default-deny (X5): `requireSuperAdmin` items hide for tenant-admins; empty tiers drop out. Active item = `--sidebar-accent` fill via `data-[status=active]`.
- **Primary actions / footer:** sidebar footer holds the **WorkingTenantSwitcher** (full variant: avatar + name + "Working tenant" / "All tenants · Cross-tenant view" + chevron). Topbar trailing cluster: theme toggle, density toggle, account menu.
- **Breadcrumb:** topbar-leading, built from `useMatches()` + each route's `staticData.crumb` + the tenant-detail store. Renders `Home / Platform / Tenants / «Tenant»` exactly; the active in-page tab is **not** appended. `Home` is a house glyph linking `/`.
- **"Acting on" banner:** `ActingOnBanner` (info, `--primary/5` bg, `--primary/20` border) on every tenant-scoped mutation surface for a super-admin, naming the tenant so cross-tenant blast radius is explicit.
- **Empty / loading / error:** NoTenant empty state (`NoTenantState`) renders on top-level `/users` + `/departments` when a super-admin has no working tenant — "Select a tenant to continue" + a "View all tenants" escape hatch (GAP-ADM-001).
- **Touch targets:** desktop pointer; header buttons `size-9` (≥ 32px hover target).

### Tablet (md..lg)
- Sidebar collapses to a **`w-16` icon-rail** — `BrandMark`/`SidebarNav` take `rail`: labels + tier titles hidden, icons centered, each item exposes `aria-label`+`title` so the icon-only rail stays accessible.
- Working-tenant switcher → **collapsed (avatar-only) pill** (interactive popover for super-admins; static avatar chip for tenant-admins) with the tenant name in `title`.
- Breadcrumb + topbar action cluster unchanged (breadcrumb truncates via `min-w-0` + `truncate`).

### Mobile (< md)
- Sidebar is **hidden**; topbar becomes an app-bar with a **hamburger** (`size-11` = 44px) opening a **modal nav drawer** (`Sheet`, `w-[86vw] max-w-80`, scrim) that renders the full nav + the **bottom working-tenant switcher**.
- Header actions (theme / density / account) grow to **`size-11` (44px)** via `max-md:size-11`.
- Breadcrumb still renders (flex-1, truncates); on the narrowest widths only the trailing crumbs remain visible.

---

## 1 · Tenant Detail — Overview — `18p · Overview 95:6164`

As-built: `routes/_authenticated/tenants/$tenantId/route.tsx` (detail **layout**: header + tab nav + `<Outlet/>`) and `…/$tenantId/overview.tsx` (the Overview body; upgraded to the operational dashboard per TASK-383, see Plan Review §B). Frame: `18p` (+ `18d · Tenant Dashboard 120:8843` for the operational build-out).

### Desktop (≥ lg)
- **Layout & grid:** page header row (avatar `size-12`, tenant name `h1`, status `StatusBadge` dot+label, `System` badge when protected, mono key) with right-aligned **Edit tenant** + **Disable/Enable** actions. Below: a horizontal underline **tab nav** (Overview · Users · Configuration · Storage · Departments). Body: 4-up KPI `StatCard` grid (`xl:grid-cols-4`), a 5-up secondary KPI row (`xl:grid-cols-5`), a 2/3 + 1/3 split (consultation `MetricChart` + recent-activity `ItemList`), and a full-width audio-pipeline strip.
- **Navigation:** tab nav uses TanStack `<Link activeProps>` → active tab gets `--primary` underline + `--foreground` text; breadcrumb shows `… / «Tenant»`.
- **Primary actions:** Edit tenant (dialog), Disable (AlertDialog) / Enable (direct) — gated by `canModifyTenant` (super-admin & not system tenant). Chart carries a tenant `TenantFilter` (super-admin) + `DateRangeSelector` (week/month/year).
- **Data display:** KPI tiles (cards, not a table); chart = bar (new vs re-visit); recent activity = `ItemList` (dot + title + actor·relative-time + mono code). **TARGET** tiles drawn em-dash: Open sockets, Consumption, per-model streams.
- **Empty / loading / error:** loading → KPI + chart skeletons (`isLoading` on `StatCard`/`MetricChart`/`ItemList`); empty → zeroed KPIs + `Empty` ("No activity in this tenant yet" + Invite/Create CTAs); error → alert card ("Couldn't load tenant metrics") + Retry + status-page link.
- **Touch targets:** desktop pointer.

### Tablet (md..lg)
- KPI grids reflow `sm:grid-cols-2` (4-up → 2-up); chart + activity stack from the `lg:grid-cols-3` split to single column below `lg`. Tab nav scrolls horizontally (`overflow-x-auto`). Header actions stay inline.

### Mobile (< md)
- Tab nav → **`Select`** (`h-11`) labelled "Tenant section" (renders in place of the underline tabs via `md:hidden` / `hidden md:flex`).
- KPI grid → 1-up (`grid-cols-1`); chart full-width fixed height; activity list stacks beneath.
- Header actions (Edit / Disable) wrap (`flex-wrap`); the banner + cards span full width.
- ≥ 44px: the section `Select` trigger is `h-11`.

---

## 2 · Tenant Detail — Users — `20p · Users 97:6529`

As-built: `…/$tenantId/users/index.tsx` (the members grid; `users/route.tsx` is a pathless layout, `users/$userId.tsx` is the TASK-380 user detail). Frame: `20p`; dialog `Dlg · Assign Departments 110:7981`.

### Desktop (≥ lg)
- **Layout & grid:** toolbar (Export ▾ + **New user**) above a server-paginated `ResponsiveDataGrid` (wraps `VirtualizedDataGrid`): Member (avatar + name + email) · Role badges · Departments · Status dot+label · Type · row actions (⋯). Footer pager; faceted filters; column visibility; layout persisted to the user profile.
- **Navigation:** row / name click → `…/users/$userId` (user detail). Breadcrumb stays `… / «Tenant»` (the Users tab is not appended).
- **Primary actions:** New user (dialog), Export ▾ (CSV live; Excel/PDF **TARGET**, disabled), per-row ⋯ (View · Reset password **TARGET** · Disable/Enable), bulk bar (Assign departments, Disable, Export CSV) when rows selected. Assign Departments opens the generic `CheckboxPickerDialog`. "Add member" create is gated by `canManage`.
- **Data display:** table (desktop). 0-based grid page → 1-based backend (`buildTenantUserListQuery`/`toUserListQuery`). Tenant scope is the `X-Tenant-Id` header, not a query param.
- **Empty / loading / error:** grid renders skeleton rows while loading; empty + error states handled by `ResponsiveDataGrid` (`onRetry={fetchPage}`).
- **Touch targets:** desktop pointer; row ⋯ is `size-8`.

### Tablet (md..lg)
- **Condensed** table via `condensedColumnIds={['username','roleId','resourceStatus','actions']}` — Departments + Type columns drop; the rest keep order.

### Mobile (< md)
- Grid → **card-list** via `mobileCard` (avatar + username + email + role meta + status badge + trailing chevron, tap → detail; per-row ⋯ preserved through the shared `renderUserActions`).
- Desktop "New user" button hidden (`max-md:hidden`); primary action moves to a **FAB** (`mobilePrimaryAction`, ≥ 44px icon target). Search is a mobile search field (`mobileSearchPlaceholder`).
- Assign Departments dialog → full-screen on mobile (`MOBILE_DIALOG_CONTENT`).

---

## 3 · Tenant Detail — Configuration — `22p · Configuration 109:6768`

As-built: `…/$tenantId/configuration.tsx`. SDK: `useTenantFrontendConfig` get/save with **OCC**.

### Desktop (≥ lg)
- **Layout & grid:** stacked section cards — **General** (`Switch` rows: noise-cancel, VAD, diarization, voice-enrollment, raw-audio-capture with a platform-capability gate) and **Speech-to-text (ASR)** (`Select` ASR model + default language + transcription mode + a "lock mode for clinicians" toggle, a `sm:grid-cols-2` grid). A dirty-state footer (last-saved caption + Discard / Save changes).
- **Navigation:** part of the tenant tab set; breadcrumb `… / «Tenant»`.
- **Primary actions:** Save / Discard (enabled only when `dirty`). On save: echo `expectedVersion` (OCC); a 409/412 routes through `reduceOccConflict` → toast + refetch. First-time create omits the version.
- **Data display:** form (Labels always visible, `Switch`/`Select` controls). No table.
- **Empty / loading / error:** loading → two stacked `Skeleton` cards; error → alert card + Retry; **system-tenant lock** → an amber `--warning` notice and all controls disabled (`canEdit=false`).
- **Touch targets:** desktop pointer; controls default `h-9`.

### Tablet (md..lg)
- ASR grid stays `sm:grid-cols-2`; section cards full width. Icon-rail shell.

### Mobile (< md)
- ASR `sm:grid-cols-2` → single column; switch rows keep label-left / control-right.
- Footer Discard/Save wraps; buttons are comfortable tap targets. The lock/notice banners span full width.

---

## 4 · Tenant Detail — Storage — `37p · Storage 110:6976`

As-built: `…/$tenantId/storage.tsx`. SDK: `useTenantBuckets.list`. Many cells are **TARGET**.

### Desktop (≥ lg)
- **Layout & grid:** a **Usage** card (explicit TARGET placeholder — "Quota & usage roll-ups are a target metric"), then a **Buckets** card with a table (Bucket mono name + provider·region · Objects · Size · Status dot+label) and a footer with disabled **Rotate keys** / **Manage provider** (TARGET, `title="Not yet available"`).
- **Navigation:** tenant tab; breadcrumb `… / «Tenant»`.
- **Primary actions:** none live beyond list/retry (provision/rotate/manage are TARGET, drawn disabled). An "Acting on … (TARGET surface)" banner makes the gap explicit.
- **Data display:** table for buckets. Objects + Size columns render em-dash (`—`) — **not modeled on `TenantBucket`** (never fabricated). The quota bar from the frame is intentionally **not** wired (no quota field).
- **Empty / loading / error:** loading → 3 row `Skeleton`s; empty → `Empty` ("No buckets"); error → alert + Retry.
- **Touch targets:** desktop pointer; footer buttons `size-sm` (disabled).

### Tablet (md..lg)
- The bucket table sits inside the shadcn `Table` overflow wrapper (`overflow-x-auto`) — horizontal scroll on narrow widths; usage card full width.

### Mobile (< md)
- Bucket table relies on the shadcn `Table` horizontal-scroll fallback (a dedicated mobile card-list for this low-traffic TARGET surface is deferred — see Figma frames to create later). Cards/banners span full width.

---

## 5 · Tenant Detail — Departments — `34p · Departments 110:7195`

As-built: `…/$tenantId/departments/index.tsx` (`departments/route.tsx` is a pathless layout). Foundation `08 · Card-Grid`.

### Desktop (≥ lg)
- **Layout & grid:** toolbar (count + search + **New department**) above a **`CardGrid`** of `EntityCard`s (auto-fit, `minColumnWidth={320}` → multi-column): name + `FolderTree` icon + status dot+label + mono code + a "Manage →" action. Member/instruction counts + lead are **TARGET** ("not yet available").
- **Navigation:** card "Manage →" → `…/departments/$departmentId`. Breadcrumb `… / «Tenant»` (the Departments tab is not appended; the `Departments` crumb is contributed only by the detail route).
- **Primary actions:** New department (dialog, `canManage`-gated); client-side search by name/code.
- **Data display:** card grid (not a table — the design's literal card-grid surface).
- **Empty / loading / error:** loading → skeleton cards in the same grid; empty/error handled by `CardGrid`.
- **Touch targets:** desktop pointer.

### Tablet (md..lg)
- `CardGrid` auto-fit reflows to ~2-up at this width (already responsive — no JS switch needed).

### Mobile (< md)
- `CardGrid` auto-fit → 1-up. Search + New-department wrap. New-department dialog → full-screen (`MOBILE_DIALOG_CONTENT`).

---

## 6 · Department Detail — `36p · Department Detail 110:7414`

As-built: `…/$tenantId/departments/$departmentId/route.tsx` (detail **layout** — fetches the dept, publishes to the store for the breadcrumb) + `…/$departmentId/index.tsx` (Members). The Agent-instructions sub-tab + editor live under `…/$departmentId/agents/**` and `DepartmentDetailShell` (sibling tickets TASK-381/382, see Plan Review §B). Dialogs: `Dlg · Add Members 110:8201`, `Dlg · New Agent Instruction 110:8440`.

### Desktop (≥ lg)
- **Layout & grid:** `DepartmentDetailShell` renders a dept header (name · status · actions) + sub-tab nav (**Members** · **Agent instructions**). Members body is a `VirtualizedDataGrid` (Member avatar+name+email · Status · Primary-dept badge). Breadcrumb extends to `… / «Tenant» / Departments / «Dept»`.
- **Navigation:** sub-tabs switch Members ↔ Agent instructions; active sub-tab = `--primary` underline.
- **Primary actions:** **Add members** (`CheckboxPickerDialog` → `useUserDepartments.assign`), New Agent Instruction (`usePrompts.create`, scope **locked** to DEPARTMENT_DEFAULT). `canManage`-gated.
- **Data display:** table for members. Membership is **derived** by listing the first `{100}` tenant users and filtering on `departmentIds`/`primaryDepartmentId` — no list-by-department SDK method (noted inline). Role-in-department + join date are **TARGET** (not modeled on `UserDepartment`).
- **Empty / loading / error:** loading → header + grid skeleton (in the layout); not-found → `Empty` ("Department not found") + back link; member grid has its own retry.
- **Touch targets:** desktop pointer.

### Tablet (md..lg)
- Sub-tab nav scrolls; member grid condenses via the shared grid wrapper. Icon-rail shell.

### Mobile (< md)
- Sub-tab nav → scrollable/segmented (defers to `DepartmentDetailShell`); member grid falls back to the shadcn `Table` horizontal-scroll. Add-members dialog → full-screen.

---

## 7 · Dialogs (transient overlays — page stays behind the scrim)

All five replace the superseded nested blades. Per `11-ux-ui-principles.mdc`: visible `<Label>`s,
inline validation (`text-destructive`), `toast.success/error` on every action, destructive
actions confirmed. On **mobile** the high-traffic mutation dialogs go (near-)full-screen
(`MOBILE_DIALOG_CONTENT`, `max-sm:h-dvh w-full max-w-none rounded-none`) with `h-11` footer
actions (TASK-384 `lib/responsive.ts`).

### 7.1 `Dlg · Add Tenant 110:7669` — `features/tenants/tenant-form-dialog.tsx`
- **Desktop/Tablet:** centered modal — Name · **key** (mono, inline `validateTenantKey` uniqueness + `● Available`/taken state, case-insensitive) · Domain/Description. **Create** primary. On **edit**, the **key is immutable** (disabled) and uniqueness check is skipped.
- **Mobile:** full-screen; `h-11` footer (Cancel / Create or Save).
- **States:** disabled submit while saving; inline key error; `Tags` + segmented initial-status from the frame are **TARGET** (no backend field) and not shipped as live controls.

### 7.2 `Dlg · Assign Departments 110:7981` — `features/common/checkbox-picker-dialog.tsx`
- **Desktop/Tablet:** searchable multi-select checklist; "N selected" + **Save assignments**. Invoked per-user or bulk from the Users grid → `useUsers.assignDepartments`. Preserves the current primary dept when still selected.
- **Mobile:** full-screen list; ≥ 44px rows/footer.
- **States:** empty ("No departments yet."), saving (disabled confirm).

### 7.3 `Dlg · Add Members 110:8201` — same `CheckboxPickerDialog`
- **Desktop/Tablet:** candidate checklist (tenant users not already in the dept) → bulk `useUserDepartments.assign({ departmentId })`. "Add N members".
- **Mobile:** full-screen.
- **States:** empty ("Everyone is already a member."), per-row settle (`Promise.allSettled` → partial-failure toast).

### 7.4 `Dlg · New Agent Instruction 110:8440` — `features/tenants/agent-instruction-dialog.tsx`
- **Desktop/Tablet:** Name · Service (SMR/DNA/…) · **Scope `DEPARTMENT_DEFAULT · Locked`** · Prompt textarea → `usePrompts.create` (`serviceToCategory` derives category; status `PUBLISHED`). Textarea grows (`flex-1 min-h-0`).
- **Mobile:** full-screen; textarea fills the viewport.
- **States:** disabled create while saving; required name/content.

### 7.5 `Dlg · Disable Tenant 110:8662` — `features/common/confirm-delete.tsx` (AlertDialog)
- **Desktop/Tablet:** AlertDialog (X7) — amber warn, "Disable «Tenant»?", **recoverable-archive** copy (suspends users/depts, ends sessions), Cancel / **Disable tenant** (destructive). Enable is a direct (non-confirmed) action.
- **Mobile:** centered AlertDialog (kept centered per shadcn AlertDialog default; full-screen treatment deferred — see backlog).
- **States:** confirm disabled while mutating; system tenant cannot reach this (protected).

---

## Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames grounded in the desktop `18p · Tenant Detail — Overview 95:6164`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-379 · 18p Tenant Detail Overview — Tablet` | Tablet (834) | `194:66` |
| `TASK-379 · 18p Tenant Detail Overview — Mobile` | Mobile (390) | `194:67` |

The Overview page is representative of the shared page-shell + tab/Select reflow; the other tenant sub-pages (`20p`/`22p`/`37p`/`34p`/`36p`) remain code-only at tablet/mobile (still deferred below).

### Still deferred

These are deferred to a serialized Figma pass once a file is connected (no live bridge this
session; screenshots/visual alignment come later). They are **net-new variants** the §5.12/§5.13
frames don't contain, or surfaces that the as-built ships via a graceful fallback rather than a
bespoke design:

1. **Dedicated Tablet variants** of `18p`/`20p`/`22p`/`37p`/`34p`/`36p` — the §5.12/§5.13 frames are desktop; tablet (icon-rail + condensed columns + 2-up cards) is currently realized in code via Tailwind/`ResponsiveDataGrid`, not as Figma frames.
2. **Dedicated Mobile variants** — tab→`Select`, grid→card-list, FAB, full-screen dialogs (mobile drawer + bottom switcher) realized in code per TASK-384; no mobile frames exist.
3. **`37p · Storage` mobile card-list** — Storage buckets fall back to the shadcn `Table` horizontal scroll on mobile; a card-list variant (parity with Users/Tenants) is not yet drawn/built (TASK-384 backlog).
4. **`Dlg · Disable Tenant` mobile full-screen** — the AlertDialog stays centered on mobile; a full-screen mobile confirm frame is not drawn.
5. **`Dlg · Add Tenant` — Tags + Initial-status** — drawn in the frame but **TARGET** (no backend `tags`/extra status); a future frame should reflect the live (no-tags) form or wait for the backend.
6. **Tenant Overview empty / error / loading frames at tablet & mobile** — only the desktop `18d` states (`120:10826/10998/11169/11341`) exist; the responsive reflows of those states are code-only today.
