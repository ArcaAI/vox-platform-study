> _Relocated from `docs/implementation/TASK-381-Users-Management/DESIGN-SPEC.md` (TASK-385 docs alignment)._

# TASK-381 — Users Management · Design Spec (Desktop / Tablet / Mobile)

> Interface spec for the tenant **Users** surface — the **20u** Users Data Grid
> and the **38u** 7-tab User Detail (panels **a–g**) — per
> [`docs/qa/E2E-AND-QA-CONVENTIONS.md`](../../qa/E2E-AND-QA-CONVENTIONS.md) §2.
> Each frame gets a **Desktop / Tablet / Mobile** subsection.
>
> **Grounding (no fabrication):**
> - Figma node ids are the documented frames from [README §1](../../implementation/TASK-381-Users-Management/README.md) and
>   [TASK-371 README §5.14 / §5.14.1](../../implementation/TASK-371-Admin-Console-Redesign/README.md).
>   The Figma bridge has **no file connected this session** — this is a paper
>   spec keyed to node ids; live reads/writes and screenshots are deferred.
> - Responsive model = **TASK-384**: mobile `< md` (**< 768**), tablet `md..lg`
>   (**768–1023**), desktop `≥ lg` (**≥ 1024**). Playwright viewport projects:
>   desktop `1280`, tablet `834`, mobile `390` ([`apps/admin/playwright.config.ts`](../../../apps/admin/playwright.config.ts)).
> - Tokens = semantic only ([`theme.css`](../../implementation/TASK-371-Admin-Console-Redesign/theme.css)); rules
>   [`11-ux-ui-principles.mdc`](../../../.cursor/rules/11-ux-ui-principles.mdc),
>   [`10-skeleton-loading.mdc`](../../../.cursor/rules/10-skeleton-loading.mdc).
> - Behavior is anchored to the **shipped** code under
>   `apps/admin/src/routes/_authenticated/tenants/$tenantId/users/**` and
>   `apps/admin/src/features/users/**`. REAL / TARGET split is README §2 (authoritative).

---

## 0. Foundations (apply to every frame)

| Concern | Rule |
|---|---|
| **Color** | Semantic tokens only — `--background/--foreground/--muted(-foreground)/--border/--primary/--accent/--destructive/--warning/--success/--info/--ai`. No hardcoded hex. Dark mode inherited from the shell. |
| **Status** | **dot + label**, never color-only. Mapping (`deriveUserStatus`): Active→`success`, Inactive→`warning`, Archived→`neutral`, Invited→`info`, Unknown→`neutral`. Rendered via `StatusBadge`. |
| **Numerals / IDs** | `tabular-nums` for counts/pagination; `font-mono` for `@username` and raw ids. |
| **Touch targets** | ≥ **44px** on mobile (WCAG 2.2 AA 2.5.8): tab `Select` trigger `h-11`, FAB, dialog footer buttons `h-11` (`MOBILE_DIALOG_*`, [`lib/responsive.ts`](../../../apps/admin/src/lib/responsive.ts)). |
| **States** | Every data region has loading (Skeleton matching layout) / empty (icon + title + description) / error (message + Retry). Never a spinner full-page, never bare blank. |
| **Feedback** | Mutations `toast.success` / `toast.error`; destructive actions confirm; disabled controls carry a visible reason (TARGET pill / `title`). |
| **TARGET marking** | Un-backed controls render **disabled** + an inline `Target` pill (`bg-warning/15 text-warning`) or `· Target` menu suffix; they never call a fabricated endpoint (README §2). |
| **Acting-on banner** | A super-admin viewing a tenant sees the `ActingOnBanner` describing read-write scope + which flows are Target (`features/tenants/tenant-context`). |

---

## 1. `20u · Tenant Users — Data Grid` `120:9015`

The Users tab of a tenant: `tenants/$tenantId/users/` `index.tsx` rendering a
`ResponsiveDataGrid<User>` with server-side pagination/sort/filter/search
(`toUserListQuery` → `useUsers.listPaginated`). Columns: **Member** (avatar +
username + email), **Role** (badges; em-dash when the payload omits roles),
**Departments** (resolved names), **Status** (dot+label), **Type** (Human /
Service account), and a trailing **actions** kebab.

### Desktop (≥ 1024)
- **Layout:** full-bleed page under the tenant `route.tsx` header + tab nav. A
  right-aligned toolbar row holds **Export ▾** and **+ New user**; the grid sits
  below at `height={520}` with a sticky header and a pagination footer
  (`pageSizeOptions [10, 20, 50]`, `tabular-nums` "n of total").
- **Filtering:** a faceted-filter row — global **search**, **+ Status**
  (Active/Inactive/Archived → `resourceStatus` enum), **+ Type** (Human / Service
  account → `isServiceAccount`), plus **Role** and **Department** facets fed from
  `useRoles`/`useDepartments`. Facets serialize to the backend CSV `filters`
  param; labels are the design vocabulary, values the REAL enum.
- **View (column toggle):** a **View** menu (`columnVisibility`) toggles optional
  columns — **never** a standalone "Columns" button. `Member` and `actions` are
  `enableHiding:false`.
- **Row actions (kebab):** **View** (→ detail), **Reset password · Target**
  (disabled), and — for managers — **Disable/Enable** (REAL `useUsers` status
  toggle). Whole **Member** cell is a click target to the detail.
- **Primary action:** **+ New user** opens the Create-User dialog (managers only,
  non-System tenant). **Export ▾** → *Export page as CSV* (REAL); *Excel* / *PDF*
  disabled `· Target`.
- **Selection:** row checkboxes (managers only) drive the bulk bar (§3).

### Tablet (768–1023)
- Grid **condenses** to `condensedColumnIds = ['username','roleId','resourceStatus','actions']`
  — Departments and Type drop out of the dense view (still reachable via **View**
  / row detail). Toolbar + facets wrap; pagination footer unchanged.
- Touch spacing preserved; the kebab and checkboxes keep ≥44px hit areas.

### Mobile (< 768)
- Grid → **card-list** (`mobileCard`): each card shows avatar (`size-10`),
  username (title), email (subtitle), roles (meta), and the **Status** badge;
  tapping the card opens the detail; the per-row kebab is reused verbatim.
- **Search** becomes a full-width field (`mobileSearchPlaceholder "Search members…"`).
- **+ New user** collapses to a **FAB** (`mobilePrimaryAction`, ≥44px) — the
  desktop header button is `max-md:hidden`.
- Facets/View live behind the grid's mobile filter affordance; selection + bulk
  bar behave as §3.

---

## 2. `20u · Users — Grid States` `120:10134`

The three required data states of the §1 grid, owned by `ResponsiveDataGrid`.

| State | Trigger | Treatment (all tiers) |
|---|---|---|
| **Loading** | first page in flight (`isLoading && rows.length === 0`) | `<Skeleton>` rows matching the column/card layout (rule `10-skeleton-loading`). No spinner. |
| **Empty** | `200` with `total === 0` | Icon + title + description empty block; **+ New user** remains available to managers (desktop button / mobile FAB). |
| **Error** | `listPaginated` rejects | Inline error with a **Retry** that re-runs `fetchPage()`. Filters/search are preserved across retry. |

- Desktop/Tablet render skeleton **rows**; Mobile renders skeleton **cards** —
  each mirrors its loaded shape.
- Tenant-scope edge: a tenant-admin/cross-tenant operator only ever sees their
  scoped rows (X1); an out-of-scope tenant simply yields the **empty** state, not
  an error.

---

## 3. `20u · Users — Bulk Selected` `120:9913`

When ≥1 row is selected (managers only), the grid's `actionBar` shows
`UsersBulkBar` with a live `tabular-nums` count and: **Disable** · **Assign
department** · **Export** (selected → CSV) · **Clear**.

- **Backend reality:** bulk **Disable** and **Assign department** run as a client
  loop (`Promise.allSettled` over per-id `useUsers.disable` /
  `assignDepartments`) — there is **no** bulk server endpoint (README §2 TARGET).
  Partial failures surface as `toast.error("N of M …")`; **Clear** resets
  selection (`bulkSelectionReducer`).
- **Desktop/Tablet:** the bar pins to the grid's action-bar slot above/over the
  footer; buttons keep label + icon.
- **Mobile:** the bar spans full width with ≥44px buttons; labels may collapse to
  icons + count but **Clear** stays explicit. Assign opens the same
  `CheckboxPickerDialog` as the single-row path (full-screen on mobile via
  `MOBILE_DIALOG_CONTENT`).

> Note (verify on live stack): the bulk **Assign department** path uses
> `useUsers.assignDepartments` → `PATCH /admin/users/:id/departments`, which has
> **no matching backend handler** today (only `POST :id/departments` +
> `PATCH :id/departments/:assignmentId` exist). Tracked in [README §3 plan
> review](../../implementation/TASK-381-Users-Management/README.md) and the [matrix](../../qa/traceability/users-management.md) (U6/U11).

---

## 4. `Dlg · Create User` `120:10354`

Modal launched by **+ New user** (`UserCreateDialog`). Fields: **username**
(required), **email** (required for human accounts), **temporary password**,
**service-account** toggle, **initial department(s)**, **role**. Inline
validation (`validateCreateUserDraft`) + saving state; on save:
`useUsers.create` → then `assignRoleToUser` + `assignDepartments` (best-effort,
each toasts on partial failure).

### Desktop / Tablet
- Centered modal, fixed width, `flex flex-col`; header pinned, body scrolls
  (`min-h-0 overflow-y-auto`), submit `shrink-0` at the bottom (rule
  `11-ux-ui-principles` §1).
- Required fields marked `*`; errors render below the field in `text-destructive`;
  labels always visible. Username is suggested from a display name
  (`suggestUsername`) but fully editable. Service-account toggle relaxes the
  email requirement.

### Mobile (< 640, `max-sm`)
- Dialog goes **full-screen** (`MOBILE_DIALOG_CONTENT`): `h-dvh w-full`,
  no rounded border, body scrolls. Footer buttons grow to `h-11`
  (`MOBILE_DIALOG_FOOTER`).

### States
- **Saving:** submit shows progress + disables; **success** → toast + close +
  grid refresh; **error** → toast, dialog stays open with values intact.

> Note (verify on live stack): `toCreateUserInput` includes `email`, but the
> backend `CreateUserRequest` does **not** whitelist `email` (and the global
> pipe is `forbidNonWhitelisted`) — a human create that sends `email` may `400`.
> Tracked in [README §3](../../implementation/TASK-381-Users-Management/README.md) / [matrix U2](../../qa/traceability/users-management.md).

---

## 5. `38u · User Detail` `120:10575`

Route `tenants/$tenantId/users/$userId.tsx`. **Breadcrumb** `… / «Tenant» /
Users / «username»` (the dynamic label is supplied by the additive `user` arm of
`tenant-detail-store` + `breadcrumbs`). **Header:** avatar, `h1` username +
status dot+label, secondary line `email · @username · roles`. **Header actions**
(managers): **Edit profile**, **Reset password · Target** (disabled), and a ⋯
menu with **Disable/Enable user**. Below the header is the **7-tab** interface:
Profile · Preferences · Agent instructions · DNA Style · Departments · DNA
Reports · Activity.

### Desktop (≥ 1024)
- Header is a single row (avatar + identity left; action cluster right). Tab nav
  is a horizontal **underline** bar (`hidden md:flex`, `data-[status=active]`
  → `border-primary`), `overflow-x-auto` so all 7 fit. Active panel renders below.

### Tablet (768–1023)
- Same underline tab bar; it **scrolls horizontally** when 7 labels exceed the
  width. Header action cluster may wrap under the identity block.

### Mobile (< 768)
- Tab bar → a full-width **`Select`** (`md:hidden`, trigger `h-11`, `aria-label
  "User section"`) listing all 7 sections; the underline bar is hidden. Header
  stacks (avatar + identity, then actions); actions remain ≥44px.

### States
- **Loading:** header + tab + panel **Skeletons** (avatar circle, name/sub lines,
  control bar, body block).
- **Not found / no access:** `Empty` (icon + "User not found" + description) with
  **Back to users** — this is also the tenant-isolation surface (404-over-403:
  an out-of-scope user resolves to *not found*, X1).

---

## 6. `38u` panels a–g

All panels share: a section `h2` + helper text, REAL data from the SDK with
loading (Skeleton) / empty / error states, dot+label badges, `font-mono` ids, and
TARGET controls drawn disabled + flagged. On **Desktop/Tablet** multi-column
cards use `lg:grid-cols-*`; on **Mobile** they collapse to a single column. The
panel body inherits the page scroll (no nested scroll areas).

### 6a · Profile — `38u-a` `121:11980` (`profile-panel.tsx`)
- **REAL:** username (`@mono`), email, **Type** (Human / Service account), role
  badges, status, **member since**. Edit via **Edit profile** → `UserEditDialog`
  (`useUsers.update`: username/email/status/service-account).
- **TARGET (em-dash + `Target`):** Full name, Specialty, Preferred name, Phone,
  About, Last login, MFA — not on the `User` record. **Reset password** disabled
  with the email-link / temp-password explanation.
- **Responsive:** two-column `[1fr_320px]` (details + Account & security card) →
  single column on mobile.

### 6b · Preferences — `38u-b` `121:11981` (`preferences-panel.tsx`)
- **TARGET (whole panel):** the SDK only exposes the caller's own settings; there
  is no admin-for-another-user read in the hook, so the namespace layout
  (Appearance & localization; Notifications & clinical defaults) is drawn with
  **disabled** switches + em-dash values behind a `Target` `Alert`. Users manage
  their own preferences elsewhere.
- **Responsive:** 2-col cards → 1-col on mobile.
- (Backend nuance: `GET/PATCH /admin/users/:id/settings` **do** exist server-side;
  the gap is the SDK hook/UI wiring — see [matrix U8](../../qa/traceability/users-management.md).)

### 6c · Agent instructions — `38u-c` `121:11982` (`instructions-panel.tsx`)
- **REAL:** for each assigned department, the `PromptTemplate` rows
  (`usePrompts.list({ departmentId })`), with name, `v{n} · status` badge,
  category + updated time, and a 3-line content preview; a **Manage** link to the
  department workspace.
- **TARGET (`Alert`):** per-**user** personalization (a personal prompt overriding
  the dept default) — `PromptTemplate` has no per-user scope.
- **Empty:** "No assigned departments" prompt to assign one.
- **Responsive:** stacked dept cards on all tiers (single column).

### 6d · DNA Style — `38u-d` `121:11983` (`dna-style-panel.tsx`)
- **REAL (self-view):** the analyzed writing style (`useDnaStyle.getByDoctor`) —
  style text + trait chips (Formality / Sentence / Terminology / Abbreviations),
  version badge.
- **TARGET:** **Edit** / **New version** disabled (no `USER_PERSONAL`
  `DNA_ANALYSIS` prompt scope).
- **Cross-user nuance:** `getByDoctor` is **self-scoped** server-side (403 for
  another doctor), so for *another* user this panel degrades to the **empty**
  state ("No DNA writing style yet"). See [matrix U10](../../qa/traceability/users-management.md).
- **Responsive:** single card; trait chips wrap.

### 6e · Departments — `38u-e` `121:11984` (`departments-panel.tsx`)
- **REAL:** `useUserDepartments` list / **assign** (`POST`) / **set primary**
  (`PATCH` with **If-Match / OCC**) / **unassign** (`DELETE`) + an Assign-Departments
  `CheckboxPickerDialog`. Primary row can't be removed (promote another first).
  OCC conflict → toast + reload.
- **Data display:** a table (Department · Role[Primary/Member] · Assigned ·
  Actions). The per-assignment "Assigned" date is em-dash (not modeled).
- **States:** Skeleton rows / "isn't assigned to any department yet" / error +
  Retry.
- **Responsive:** the table scrolls horizontally on narrow tiers; mobile keeps
  ≥44px action links; the picker dialog is full-screen on mobile.

### 6f · DNA Reports — `38u-f` `121:11985` (`dna-reports-panel.tsx`)
- **REAL (self-view):** report + version history (`getByDoctor` → `getVersions`),
  master-detail (version rail + selected analysis), and a side-by-side **diff**
  vs the prior version (`getVersionDiff`, composed client-side from `getVersions`).
- **TARGET:** **Create report** is enabled only when `isSelf` (`generate` is
  self/impersonation-scoped server-side); for another clinician it's disabled +
  `Target`. Cross-user **read** also degrades to empty (self-scoped endpoint).
- **States:** Skeleton / "No DNA reports yet" (with self-only Create) / inline
  diff.
- **Responsive:** `[220px_1fr]` rail+detail on desktop → stacked on mobile; diff
  `md:grid-cols-2` → single column.

### 6g · Activity — `38u-g` `121:11986` (`activity-panel.tsx`)
- **REAL:** `useAuditLog.byUser` timeline (humanized title from
  `action`/`resourceType`, semantic dot **+ text label**, time · actor · IP) +
  **Export CSV** (`exportCsv({ userId })`, disabled when empty).
- **States:** Skeleton rows / "No activity yet" / error + Retry.
- **Responsive:** single timeline column on all tiers; export button stays in the
  header cluster.

---

## 7. Figma frames

**Figma frames (created 2026-06-30).** Connected file **HOPE-Admin-Console** (`fileKey unsaved-mr0qkre2-nzazl7ou`). Structural/representative Tablet + Mobile frames grounded in the desktop `20u · Users Data Grid 120:9015`, placed in a dedicated responsive band on the same page:

| Frame name | Platform | Node ID |
|---|---|---|
| `TASK-381 · 20u Tenant Users — Tablet` | Tablet (834) | `194:205` |
| `TASK-381 · 20u Tenant Users — Mobile` | Mobile (390) | `194:206` |

These cover the grid → condensed-grid → card-list + FAB reflow, Export/New-user toolbar, status pills, and bulk-select. The **`38u` User Detail** tablet/mobile variants and the dialog full-screen states remain deferred below.

### Still deferred

Deferred to a serialized Figma pass once a file is connected (visual alignment /
screenshots come then). None block implementation — the surface is shipped.

1. **`20u` — Tablet variant** (`834w`): condensed-column grid (Member · Role ·
   Status · actions) with wrapped toolbar/facets — currently only Desktop +
   Mobile-card states exist as frames.
2. **`20u` — Mobile card-list + FAB** (`390w`): the `mobileCard` row + search
   field + New-user FAB as an explicit frame (today only the desktop grid + bulk
   + states are drawn).
3. **`Dlg · Create User` — Mobile full-screen** (`max-sm` `h-dvh`) variant.
4. **`38u` — Mobile `Select` tab switcher** (`390w`) + stacked header variant;
   and the **Tablet** scrollable underline-tab variant.
5. **`38u` panels a–g — Mobile single-column** variants (esp. `38u-a` two-col →
   one-col, `38u-e` table → stacked, `38u-f` rail+detail → stacked).
6. **`38u-d` / `38u-f` — "other-user" empty state** frame (self-scoped DNA
   endpoints → empty for another clinician), to document the cross-user nuance
   visually.
7. **`Dlg · Assign Departments`** (`CheckboxPickerDialog`) — shared single-row +
   bulk variant, incl. its mobile full-screen state.
