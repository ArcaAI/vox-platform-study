# TASK-371 — HOPE Admin Console Redesign (UX/UI + Design System)

| | |
|---|---|
| **Ticket** | TASK-371 |
| **Type** | Feature / Design |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-29 |
| **Status** | In Progress |
| **Owner** | Design (UX/UI) |
| **Figma file** | `HOPE-Admin-Console` |

> Brand: **Hope** — *"quiet intelligence that helps clinicians care for people."*
> Keywords: Medical Trust · Ambient Listening · AI Intelligence · Compassion & Healing · Hope & Service · India & Christianity.

> **Scope note:** This is a clean redesign. The existing `apps/ui-playground` admin console is **explicitly out of scope** and slated for removal — none of its implementation is treated as a constraint. Requirements are derived from business/requirement docs only.

> **Traceability:** the row-level **use-case → design → backend API → test** map lives in [`TRACEABILITY-MATRIX.md`](../../qa/traceability/README.md) (first section built: **Tenant Management for global/super-admins**). It doubles as a backend/test backlog via explicit gap rows.

---

## 1. Requirement Analysis

### 1.1 Business context

HOPE is a cloud-first, self-hosted, multi-tenant healthcare AI platform (real-time STT, summarization, medical NLP, guardrail, clinical-documentation harness). The Admin Console is the **operator surface** for running that platform: tenancy, identity/access, monitoring, clinical content, audit, and integrations — under HIPAA/GDPR/NDHM compliance and strict tenant isolation.

### 1.2 Operator personas

| Persona | Scope | Primary jobs |
|---|---|---|
| **Global / Super Admin** | Cross-tenant (`tenantId = null`) | Tenant CRUD, working-tenant switch, platform health, cross-tenant monitoring, impersonation |
| **Tenant Admin** | One tenant | Users & access control, departments/prompts, tenant config — confined to own tenant |
| *(secondary)* Department Head | Delegated | Limited role assignment, department views |

### 1.3 Capability map (requirement-traceable)

| Domain | Capabilities | User stories |
|---|---|---|
| Multi-tenancy | List / create / update / archive tenants; working-tenant switcher; per-tenant config (KV, feature flags, ASR pipeline, engine select) | 57, 61–63, 66, 94 |
| Users | Create, update, activate/deactivate, archive; paginated list w/ role badges; impersonation | 26–31, 111 |
| RBAC | Custom roles (inherit parent), CASL policies (action/subject/conditions/fields), priority ordering, hierarchy, system-role protection, no escalation, audit | 36–42 |
| Monitoring | Service status (API/STT/SMR/NLP/Guardrail/Harness), health/live/ready, uptime, active sessions & jobs, usage stats, consultation-status dashboard | 53–58, 103 |
| Clinical content | Departments (cards + prompt assignment), prompt templates (CRUD, versioning, diff, rollback, draft/publish, analytics), DNA writing style | 43–52, 117–126 |
| Audit & compliance | Audit log viewer (actor/resource/correlationId), before→after diffs, authorization audit | 42, 64, 89, 107 |
| API keys | Lifecycle, scopes, IP allowlist, usage, revoke, secret-shown-once | 32–35, 92 |
| Platform | Model registry, storage (MinIO), global settings KV, Prisma Studio embed | 59, 60, 65, 66 |
| Shell | Sidebar + breadcrumb, theme toggle, connection badge, impersonation banner, JWT/API-key login | 77–88 |

### 1.4 Cross-cutting acceptance principles (must be designed-in)

| ID | Principle | Source |
|---|---|---|
| X1 | Tenant isolation; **404-over-403** (never reveal another tenant's data) | AC; US 91 |
| X2 | **Soft-delete only** — "Delete" = Archive | AC |
| X3 | No privilege escalation; custom role ≤ parent | AC; US 39 |
| X4 | System-role / system-tenant protection (disable + explain) | AC; US 40 |
| X5 | Default-deny + RBAC-driven menu visibility | AC |
| X6 | Auditability — actor, IP, timestamp, before/after on every mutation | AC; US 42, 89 |
| X7 | Confirmation on destructive actions | US 29 |
| X8 | Secrets shown once (API keys) | US 92 |

---

## 2. Current State Evaluation

The 2026-06-27 manual QA run (`docs/qa/manual-tests/`) of the *current* build surfaced concrete UX gaps the redesign must close from day one:

| # | Gap | Redesign requirement |
|---|---|---|
| 1 | Tenant detail is read-only (no edit) — `MT-03` N/A | Tenant **edit** flow |
| 2 | Tenant config nav disabled — `MT-06` not implemented | Full tenant **config** surface (KV / flags / ASR / engine) |
| 3 | System/global tenant deletable (text-only warning) — `DEF-ADM-002` | **Protected** state: disabled + explained |
| 4 | No "select a tenant" prompt; shows all 27 users cross-tenant — `GAP-ADM-001` | Deliberate **NoTenant** empty state |
| 5 | Mutation forms don't show the active tenant — `OBS-ADM-001` | **"Acting on: «Tenant»"** context banner |
| 6 | No consultation-status dashboard — `MT-05.6` | Consultation-status **dashboard** (US 103) |
| 7 | No search/filter/pagination on tenant list — `MT-01.4/.7` | Table search + filter + pagination |
| 8 | Duplicate tenant key (case-insensitive) accepted — `DEF-ADM-001` | Inline uniqueness validation pattern |

---

## 3. Design System — 5 Pillars

> Canonical tokens live in [`theme.css`](./theme.css) (Tailwind v4 + shadcn, light/dark). These 5 pillars are exactly the layers exposed as the **end-user-configurable theme template**.

### Pillar 1 — Color & Meaning (Direction A: "Calm Clinical Teal")

| Role | Token | Light | Psychology / brand tie |
|---|---|---|---|
| Primary | `--primary` | `#0f7a8b` | Trust + healing + clinical calm |
| AI accent | `--ai` | `#4f5bd5` | Intelligence; Marian/Christian blue; Indian indigo |
| Hope highlight | `--hope` | `#e8912a` | Hope/dawn light; India saffron; divine light |
| Success / healthy | `--success` | `#1a8259` | Compassion & healing; theological "hope" |
| Warning | `--warning` | `#e0a53b` | Caution / degraded / draft |
| Destructive | `--destructive` | `#c24a4a` | Archive/revoke — calm, not alarmist |
| Canvas / text | `--background` / `--foreground` | `#fbfcfd` / `#0e1a24` | Clinical near-white; warm-slate ink |

Full 50→950 ramps + dark pairs in `theme.css`. **a11y:** WCAG 2.2 AA; status is **never color-only** (icon + label + color), visible 2px focus ring, 44px min targets.

### Pillar 2 — Typography & Voice
- **Inter** (UI workhorse) with **tabular numerals** for metrics, uptime %, counts, timestamps, IDs.
- **JetBrains Mono** for IDs, correlationId/causationId, policy JSON, API keys.
- **Source Serif 4** — login/brand hero only (humane warmth).
- Ramp: Display 30 / H1 24 / H2 20 / H3 16 / Body 14 / Small 13 / Caption 12; body line-height 1.5.

### Pillar 3 — Spacing, Grid & Density
- 8-pt rhythm on a 4-px base: `2,4,8,12,16,20,24,32,40,48,64`.
- Shell: 264px sidebar / 56px header / 1200–1440 content max / 24px gutters.
- **Two densities:** Comfortable (default) + Compact (tables, audit, policies).

### Pillar 4 — Shape, Elevation & Depth
- Base radius **10px** (`--radius: 0.625rem`); buttons 8 / cards-inputs 10 / pills full.
- **Border-first** separation; only 2 soft shadow levels (resting card, overlay). Clean, flat, calm.

### Pillar 5 — Motion, State & Feedback
- Calm timing 150 / 200 / 250ms ease-out; respects `prefers-reduced-motion`.
- **Ambient-listening signature**: gentle "breathing" pulse reserved for live states (recording, listening, healthy heartbeat).
- Built-in state patterns satisfying X1–X8: confirmation dialogs, inline validation, secret-shown-once reveal, before→after diff styling, NoTenant empty state, "Acting on: «Tenant»" banner.

---

## 4. Implementation Plan

### 4.1 Deliverables

| Artifact | Location | Status |
|---|---|---|
| Theme tokens (Tailwind v4 + shadcn) | [`theme.css`](./theme.css) | Done |
| Live design-system preview (Canvas) | `canvases/hope-admin-design-system.canvas.tsx` | Done |
| Ticket doc | this file | Done |
| Figma initial design | `HOPE-Admin-Console` | In progress — Foundations, App Shell–Tenants, Login + **Pass 2:** Users, Consultation History, Live Session + **Pass 3 (foundation page):** Dashboard Shell, Full-Screen Table, Blades, DataGrid anatomy, Theming/Dark + **Pass 4 (foundation page):** Multi-Tenancy & Impersonation, Responsive (tablet/mobile) |
| Figma screenshots | [`screenshots/`](./screenshots/) | foundations, tenants-hero, login, users-grid, history-timeline, live-session, **foundation-10…16** |

### 4.2 Figma layer taxonomy (frame numbering)

> Authoritative structure per [`.cursor/rules/12-design-workflow.mdc`](../../../.cursor/rules/12-design-workflow.mdc). The **number prefix encodes the audience tier**; the admin app's routes, menu visibility, and role guards must mirror these bands. (Supersedes the earlier topic-based page plan.)

| Band | Audience | Screens |
|---|---|---|
| **00–09** | Foundations / UX-UI references | Tokens, theming/dark-mode, DataGrid anatomy, shells (dashboard / full-screen table / blades), multi-tenancy & impersonation patterns, responsive |
| **10–19** | Global / Super-admin only (cross-tenant) | Dashboard, Monitoring, Logs & Audit Logs, Tenant Management, Rate Limits, Queues & Jobs, Prisma Studio |
| **20–29** | Shared (super-admin + tenant-admin) | Users, Roles, API Keys, Tenant configuration/settings |
| **30–49** | Tenant-admin only (super-admin must select a working tenant) | Department management, Store management, Ambience-listening management → Audio processing, Agents instructions, Agent Jobs, Harness |
| **50–59** | Playground | Clinical Consultation, Live Transcription, Voice profile, DNA Writing style, Summarization |

### 4.3 Build order
Foundations → Components → App Shell → Tenants → Users & Access → System Health → Login. Desktop-first (1440), responsive-aware.

---

## 5. Implementation Summary

### 5.1 Figma build — Pass 1 (2026-06-27)

File: `HOPE-Admin-Console` (Cursor Figma bridge). Built directly from `theme.css` tokens at 1× scale; desktop-first 1440-wide artboards laid out left→right / top→bottom on `Page 1`.

| Artboard | Frame | Highlights |
|---|---|---|
| 00 · Foundations | `2:2` (1240×1216) | 6 semantic role cards (token + hex + on-color "Aa" + usage), full Teal/Indigo/Saffron/Green/Slate ramps (50→950), Inter+JetBrains Mono type specimen, radius scale (sm/md/lg/xl), status chips proving **never color-only** (dot + label). |
| 02 · App Shell — Tenants | `2:133` (1440×1024) | Sidebar (logo, grouped nav PLATFORM/OPERATIONS/SETTINGS, active state w/ accent bg + indicator, user footer), header (breadcrumb, global search, Production env pill, Connected badge, theme toggle, avatar), page header + New tenant / Export, search + filter chips, tenants table (6 rows, mono keys + domains, Active/Suspended/Archived status chips, **protected system tenant** row, pagination). |
| 06 · Login | `2:280` (1440×1024) | Split layout: teal gradient brand panel (wordmark, slogan headline, trust points, ambient ring motif) + centered card (email/password, Forgot, Sign in, Continue with SSO, audit-logging note). |

Verification: screenshots captured to [`screenshots/`](./screenshots/) (`foundations-wip.png`, `tenants-hero.png`, `login.png`) and visually reviewed.

Notes / decisions:
- Nav and toolbar icons are rounded-square placeholders (icon set to be swapped to Lucide during component pass).
- Built with absolute positioning + solid/gradient fills, strokes, and 2-level soft shadows — no auto-layout yet (component-ization deferred to the Components pass).
- The Figma file is **unsaved**, so its `fileKey` rotates on reconnect; tooling targets the single connected file without a key.

### 5.2 Figma build — Pass 2 — flagship component surfaces (2026-06-27)

Added the three screens that exercise the gold-standard `@arcaai/ui` components shipped in [TASK-372](../TASK-372-Shared-Component-System/README.md) and wired to real data in [TASK-374](../TASK-374-Admin-App-Integration/README.md). Built in a new column at `x=2940` on `Page 1` (1440×1024 each) from the same `theme.css` tokens. **The shell was reconciled to the as-built `apps/admin` layout** (`AppShell` + `src/lib/nav.ts`): the real **5-pillar** sidebar (Multi-Tenancy / Identity & Access / Clinical Operations / Observability / Platform — 11 items) and the simpler shipped topbar (page title + theme/density toggles + user chip) — i.e. **no** breadcrumb / global-search / env-pill / connected-badge and **no** sidebar user-footer. Those richer elements appear only on the older Pass-1 `02 · App Shell — Tenants` frame, which is now **stale** vs. the build (reconcile pending — §5.5).

| Artboard | Frame | Component | Highlights |
|---|---|---|---|
| 04 · Users | `53:308` | `VirtualizedDataGrid` | Toolbar (search, dashed `+ Status`/`+ Type` faceted filters, density + View/column toggle), 5-col table (Username/Email/Status/Type/ID) with sort affordances + 10 sample rows, color-blind-safe `StatusBadge`s (Enabled/Disabled/Archived = dot + label), Service-account vs User, mono IDs, offset pagination footer ("0 of 248 · Rows per page 20 · Page 1 of 13 · ⏮◀▶⏭"). |
| 07 · Consultation History | `54:459` | `HistoryTimelineList` | Page header + Refresh, consultation `Select`, accordion timeline of 7 content-typed items (first **expanded** → Assessment/Plan markdown + bullets), `AI`/`summary`/`transcript`/`image`/`pdf`/`audio`/`file`/`note` badges. |
| 08 · Live Session | `54:560` | `LiveTranscript` | Page header + destructive **Stop capture** (capturing state) + helper caption, transcript card with ambient "Listening" pulse, 4 speaker-tagged segments (Clinician/Patient chips, mono timestamps, confidence %), word-level teal highlight, italic interim line, floating "Jump to live" pill. |

Verification: screenshots captured to [`screenshots/`](./screenshots/) (`users-grid.png`, `history-timeline.png`, `live-session.png`) and visually reviewed against the as-built screens.

### 5.3 Figma build — Pass 3 — shared layouts & DataGrid system (2026-06-28)

> **Renumbered (see §5.5):** the Pass-3/Pass-4 frames below were later reconciled into the **00–09 foundation band**. The §5.5 map is the current source of truth (Pass-3: 10→03, 11→04, 12→05, 13→02, 14→01; Pass-4: 15→06, 16→07). Node IDs are unchanged.

Captured the **recently shipped shared layout shells and the `VirtualizedDataGrid`** as reusable foundation specs on the **`foundation`** page of `HOPE-Admin-Console`, built directly from `theme.css` tokens (1440-wide, desktop-first). Every status uses **dot + label** (never color-only); spacing follows the 8-pt rhythm; data-grid row heights match `DENSITY_ROW_HEIGHT` from `@arcaai/ui` (comfortable 48 / compact 36).

| Artboard | Frame | Captures |
|---|---|---|
| 10 · Dashboard Shell | `58:2` | Collapsible **sidebar** (5-pillar nav, active indicator, working-tenant footer), **breadcrumb** topbar + global search + avatars, KPI stat cards, weekly consultations chart, recent-activity panel, and the **fixed `ServiceStatusBar`** (per-service health dots incl. an amber *degraded*, active sessions, processing jobs, env pill, refresh). |
| 11 · Full-Screen Table | `59:155` | The data-dense page pattern: **fixed** toolbar (search + faceted `+ Status`/`+ Type` filters + density/View), **sticky** sortable & reorderable header, full-height **scrollable** body (13 rows — avatars, `StatusBadge`s, selected-row highlight + checkbox), and a **fixed** selection + pagination footer ("1 of 13 selected · Rows per page 20 · Page 1 of 13"). |
| 12 · Blades | `60:490` | Master→detail **blades**: searchable master list (session cards, selected teal accent) and a detail **blade** revealed on selection (header + `Completed` status, 4 stat tiles, Summary/Transcript/Timeline tabs, SOAP note, footer `Export`/`Open record`). |
| 13 · DataGrid — Anatomy & States | `60:745` | Full `VirtualizedDataGrid` spec: toolbar parts, **column-header states** (default / sorted asc / sorted desc + header-menu popover), **row states** (default / zebra / hover / selected / keyboard-focus), `StatusBadge` set mapped to theme tokens (`--success`…`--info`), **density** comparison (48 vs 36 px), and async **loading (skeleton) / empty / error** states. |
| 14 · Theming — Tokens & Dark Mode | `60:886` | Configurability proof: a semantic-token legend with **light + dark** swatches & hex (`--background`…`--destructive`) beside the **same components rendered in dark theme** (stat cards, data grid, `StatusBadge`s, buttons) — demonstrating "swap token values → zero component changes." |

Verification: each frame screenshotted to [`screenshots/`](./screenshots/) (`foundation-10-dashboard-shell.png` … `foundation-14-theming.png`) and visually reviewed against the design system.

### 5.4 Figma build — Pass 4 — multi-tenancy, impersonation & responsive (2026-06-28)

Extended the `foundation` page with the **tenant-context / impersonation patterns** and the **responsive breakpoint system** (desktop was proven in §5.1–5.3; here tablet + mobile). Built from `theme.css`; **touch targets ≥ 44px**; status is dot + label; and **impersonation uses the `--ai` indigo as a "mode" signal — never a health-status color**, so it can't be confused with degraded/warning.

| Artboard | Frame | Captures |
|---|---|---|
| 15 · Multi-Tenancy & Impersonation | `61:985` | **Working-tenant switcher** (collapsed sidebar-footer control + expanded popover: search, **All tenants / cross-tenant** option, tenant list w/ current ✓, "Manage tenants"); super-admin **cross-tenant topbar** + the **"Acting on: «Tenant»"** scoped-mutation banner over a Create-user form; **NoTenant empty state** (`GAP-ADM-001`); the **impersonation confirm dialog** (audited, "view as" framing); and the **active impersonation banner** that sits above the topbar app-wide (indigo mode bar — avatar, "viewing as", audit chip, **Exit impersonation**). |
| 16 · Responsive — Tablet & Mobile | `62:1082` | One shell across breakpoints. **Tablet (768):** floating **icon-rail** sidebar + tenant pill in the topbar + condensed users table (zebra rows, status pills, pagination). **Mobile (360):** (a) **app bar + card-list** — table collapses to tappable cards w/ trailing chevron, working-tenant chip, full-width search, **FAB**; (b) **modal nav drawer** — scrim + M3 rounded-trailing panel, 5-pillar nav w/ active state, **bottom working-tenant switcher**; (c) **blade drill-down** — user-detail reached from the list (back nav, profile header, detail rows, **Impersonate user** primary action). |

Requirement trace: tenant isolation/switcher (X1; US 57, 61–63), impersonation (US 31, 111), NoTenant empty state + "Acting on" banner (current-state gaps 4 & 5). Responsive follows current best practices — off-canvas drawer + scrim, table→cards collapse, master/detail → drill-down, persistent tenant + impersonation context at every size.

Verification: `foundation-15-multitenancy.png` and `foundation-16-responsive.png` captured to [`screenshots/`](./screenshots/) and visually reviewed against the design system.

> **File-state note:** `HOPE-Admin-Console` is **unsaved**, so its document/`fileKey` rotates on reconnect; the live `foundation` page currently hosts `00 · Foundations` (`2:2`) plus the Pass-3 frames (`58:2`, `59:155`, `60:490`, `60:745`, `60:886`) and the Pass-4 frames (`61:985`, `62:1082`). The Pass-1/Pass-2 frames documented in §5.1–5.2 belong to an earlier session state and are not in the current file — re-create from those specs + screenshots if a single persisted file is needed.

### 5.5 Figma build — Pass 5 — layer-taxonomy reconciliation (2026-06-28)

Reconciled the `foundation` page to the layer-numbering taxonomy now mandated by [`12-design-workflow.mdc`](../../../.cursor/rules/12-design-workflow.mdc) (§4.2). All eight existing frames are **foundations**, but the page had drifted into two `00` frames and a jumbled `00 / 04 / 05 / 06 / 00 / 01 / 02 / 03` order; they were renumbered into a clean, de-duplicated **00–07** reference sequence. **This map is the source of truth** (it supersedes the 10–16 numbers in §5.3–§5.4; node IDs are unchanged):

| # | Frame | Node | Prev # | Screenshot |
|---|---|---|---|---|
| **00** | Foundations | `2:2` | 00 | `foundations-wip.png` |
| **01** | Theming — Tokens & Dark Mode | `60:886` | 14 | `foundation-14-theming.png` |
| **02** | DataGrid — Anatomy & States | `60:745` | 13 | `foundation-13-datagrid-anatomy.png` |
| **03** | Dashboard Shell | `58:2` | 10 | `foundation-10-dashboard-shell.png` |
| **04** | Full-Screen Table | `59:155` | 11 | `foundation-11-fullscreen-table.png` |
| **05** | Blades | `60:490` | 12 | `foundation-12-blades.png` |
| **06** | Multi-Tenancy & Impersonation | `61:985` | 15 | `foundation-15-multitenancy.png` |
| **07** | Responsive — Tablet & Mobile | `62:1082` | 16 | `foundation-16-responsive.png` |

Ordering rationale: tokens (00) → themeability (01) → flagship component (02) → layout shells (03–05) → cross-cutting patterns (06–07). Screenshot files keep their original `foundation-1N-…` names — the frame **visuals** are unchanged, only the layer number — so they can be renamed on the next persisted save.

**Gap to taxonomy (not yet drawn):** the product tiers remain to be designed —
- **10–19** (super-admin): Dashboard, Monitoring, Logs & Audit Logs, Tenant Management, Rate Limits, Queues & Jobs, Prisma Studio
- **20–29** (shared): Users, Roles, API Keys, Tenant configuration/settings
- **30–49** (tenant-admin): Department, Store, Ambience-listening (Audio processing, Agents instructions, Agent Jobs, Harness)
- **50–59** (playground): Clinical Consultation, Live Transcription, Voice profile, DNA Writing style, Summarization

> **Blocker:** the file is still `unsaved-…` (its fileKey rotates on reconnect). **Save `HOPE-Admin-Console` in Figma before the product-tier build-out** so frames persist — Pass-1/Pass-2 surfaces were already lost to this.

### 5.6 Figma build — Pass 6 — super-admin tier (10–19) [started] (2026-06-28)

Began the **10–19 (Global / Super-admin)** product tier in a **new row at `y=1440`** (below the 00–07 foundation row), reusing the foundation shells via `duplicate_nodes` → reposition → reskin. The foundation frames carry **semantic layer names** (`page-title`, `bc-current`, `kpi-1-value`, `hdr-user`, `st-0`…, `nm-0`…), which makes targeted `set_text_content` reskins predictable.

| # | Frame | Node | Built from | Captures |
|---|---|---|---|---|
| **10** | Dashboard | `69:1265` | 03 · Dashboard Shell | Cross-tenant **platform dashboard**: breadcrumb `Home / Platform / Dashboard`, KPI cards (Active tenants 27 / Live sessions 14 / Jobs processing 3 / **Services healthy 6 / 7 — SMR degraded**), consultations chart, recent-activity, fixed `ServiceStatusBar`, **All tenants / Cross-tenant view** footer, `New tenant` CTA. |
| **13** | Tenant Management | `69:1416` | 04 · Full-Screen Table | **Tenants** data grid: `Multi-Tenancy / Tenants` breadcrumb, search + `Status`/`Plan` facets, columns **Tenant · Status · Plan · Updated**, 13 tenant rows (key·domain, Active/Suspended/Archived badges, Enterprise/Pro/Trial/Starter), pagination, cross-tenant footer, `New tenant` CTA. Addresses current-state gaps 1/2/3/7. |

Screenshots: `admin-10-dashboard.png`, `admin-13-tenant-management.png` (captured + reviewed).

**Tier follow-ups (apply to every 10–19 screen):**
- **Nav reorg** — frames still show the as-built **5-pillar** sidebar (so the active state highlights "Users", and there is no "Dashboard" nav item). The sidebar must be reorganized to the role-tier taxonomy (Dashboard, Monitoring, Logs & Audit, Tenant Mgmt, Rate Limits, Queues & Jobs, Prisma Studio) and the active item corrected per screen.
- **Placeholder squares** for nav/toolbar/avatar icons (Lucide swap pending); row avatars still carry person-style initials.
- **Remaining 10–19 screens:** 11 · Monitoring, 12 · Logs & Audit Logs, 14 · Rate Limits, 15 · Queues & Jobs, 16 · Prisma Studio — then tiers 20–29, 30–49, 50–59.

### 5.7 Figma build — Pass 7 — tier nav reorg + Monitoring & Audit Log (2026-06-28)

Resolved the Pass-6 nav follow-up and extended the super-admin tier to **4/7**.

**Sidebar reorganized to the role-tier taxonomy.** The as-built 5-pillar nav was re-grouped/relabelled in place (text-only; positions unchanged) so a super-admin sees every 10–19 destination and the active item is real per screen:

| Section | Items |
|---|---|
| `OVERVIEW` | Dashboard |
| `PLATFORM` | Tenants · Monitoring · Audit Log |
| `OPERATIONS` | Rate Limits · Queues & Jobs · Prisma Studio |
| `IDENTITY & ACCESS` | Users · Roles & Policies |
| `API & INTEGRATIONS` | API Keys |

The `nav-active-bg` / `nav-active-indicator` rects are repositioned per screen to the live item (e.g. Dashboard `y=98`, Tenants `y=176`, Monitoring `y=216`, Audit Log `y=256`). Applied to **10** and **13**, which now double as the **shell** and **table** templates — new tier screens `duplicate_nodes` from these and inherit the corrected nav.

| # | Frame | Node | Built from | Captures |
|---|---|---|---|---|
| **11** | Monitoring | `70:1692` | 10 · Dashboard (shell) | **Service Monitoring**: `Home / Platform / Monitoring`, KPI cards (Requests/min 1,240 · Error rate 0.42% · P95 318ms · Uptime 99.98%), 24h request-volume chart (hourly axis), **Recent incidents** feed (per-service), `Configure alerts` CTA, fixed `ServiceStatusBar`. |
| **12** | Audit Log | `70:1843` | 13 · Tenants (table) | **Audit Log**: `Home / Platform / Audit Log`, search + `Action`/`Actor` facets, columns **Actor · Result · Action · When**, 13 event rows (actor + role·tenant, **Success/Warning/Info** result badges mapped to the existing green/amber/grey fills, `user.login`…`user.delete` action codes), `Showing 13 of 1,284 events`, `Columns`/`Export`. |

Screenshots: `admin-10-dashboard.png` + `admin-13-tenant-management.png` (re-shot with the new nav), `admin-11-monitoring.png`, `admin-12-audit-log.png` (captured + reviewed).

**Follow-ups:**
- **Remaining 10–19:** 14 · Rate Limits, 15 · Queues & Jobs (table template), 16 · Prisma Studio (shell template).
- **Foundation shells 03/04 still show the legacy 5-pillar nav** — propagate the tier nav to them + re-shoot `foundation-10/11-*.png` (they are the canonical references).
- Lucide icon swap (nav/toolbar/avatar still placeholder squares); `12 · Audit Log` breadcrumb-section now reads `Platform` but `13 · Tenants` was built as `Multi-Tenancy` — align to `Platform`.

### 5.8 Figma build — Pass 8 — UXU realism review & nav-reality fixes (2026-06-28)

Ran the **`/uxu` review loop** (review → fix → verify **in Figma**, before any code) over the foundation band (02–07) and the super-admin tier (10–13), judging each **rendered screenshot by eye** against the Realism Checklist ([`.cursor/skills/uxu/SKILL.md`](../../../.cursor/skills/uxu/SKILL.md)). Content realism from Passes 3–7 holds — real users/service accounts, SOAP notes, tenant orgs, audit events, plausible numbers/timestamps, dot+label status, and async loading/empty/error states. Two **nav-reality** defects were found and fixed; the icon gap is deferred with rationale.

| Frame | Verdict | Finding → fix |
|---|---|---|
| 02 DataGrid · 06 Multi-tenancy · 07 Responsive | ✅ PASS | Spec/pattern frames — real data, correct states, token-built. |
| 10 Dashboard · 11 Monitoring · 12 Audit Log | ✅ PASS | Real content; tier nav + active + breadcrumb all correct. |
| 13 Tenants | 🔴 → ✅ | Breadcrumb section read **`Multi-Tenancy`** (legacy) → **`Platform`**, so breadcrumb = nav section. |
| 03 Shell · 04 Table · 05 Blades | 🟡 → ✅ | Footer is **"Working tenant: Acme Health"** (tenant scope) but the sidebar listed super-admin-only **Tenants** + **System Health** → re-grouped to a real **tenant-admin** taxonomy. |

**Tenant-admin nav** now on 03/04/05 (10 items, text-only relabel in place + active reposition):

| Section | Items |
|---|---|
| `OVERVIEW` | Dashboard |
| `WORKSPACE` | Departments · Stores · Ambience Listening |
| `ACCESS` | Users · Roles & Policies · API Keys |
| `PLAYGROUND` | Clinical Consultation · Live Transcription |
| `SETTINGS` | Settings |

Active item corrected to the live page — 03/04 → **Users** (`ACCESS`), 05 → **Clinical Consultation** (`PLAYGROUND`) — moving the `nav-active-bg`/`nav-active-indicator` rects **and** the teal active-text fill (`#0e626e`), reverting the prior item to muted `#44535e` (an active-text-colour **regression** caught on the first re-shoot and fixed). Breadcrumb sections realigned (`Access` / `Playground`). Re-shot `foundation-10/11/12-*.png` + `admin-13-*.png` and re-reviewed — all pass. **Resolves** the Pass-6/7 follow-ups (foundation-shell legacy nav + `13` breadcrumb).

**Deferred — icon placeholders (with rationale).** Nav/toolbar/topbar icons are still placeholder squares. figma-bridge can only place rasters (`create_image`) or primitive shapes (`create_shape`) — both fixed-colour and **not token-driven** — so swapping ~200 icons in the mock would *trade* one realism gap for a worse one (hardcoded colour, no dark/hover/active adaptation) at high churn. The faithful, token-correct fix is the **native Lucide** icons the app already uses, applied at implementation.

### 5.9 Figma build — Pass 9 — Dashboard + Monitoring redesign + Columns→View consolidation (2026-06-28)

Deepened the two super-admin **platform** screens from thin reskins into real operator surfaces, and made the DataGrid **column-visibility pattern** consistent across every table frame. Ran the `/uxu` loop (edit → re-shoot → read by eye) until both screens pass the Realism Checklist.

**Per-frame audit (before → after):**

| Frame | Before (Pass 7) | After (Pass 9) |
|---|---|---|
| **10 · Dashboard** (`69:1265`) | KPIs *Active tenants 27 · Live sessions 14 · Jobs processing 3 · Services healthy 6/7*; single weekly chart; **Recent activity** panel; no chart controls. | Headline KPIs **Active tenants 27 · Live sessions 14 · Processing jobs 23 · Degraded services 1 (SMR)**; **+ secondary KPI row** (4 cards, below); **Recent activity removed**; chart **widened to full width** + relabelled *Consultation sessions · sessions per day* with a **Week/Month/Year** segmented control + **All tenants** tenant filter. |
| **11 · Monitoring** (`70:1692`) | KPIs *Requests/min 1,240 · Error rate 0.42% · P95 318 ms · Uptime 99.98%*; 24h **hourly**-axis volume chart; **Recent incidents** feed. | Headline KPIs **Requests/min 1,240 · Error rate 0.42% · Sockets/min 86 · Total sockets 312**; request-volume chart with **Week/Month/Year + All tenants** and a **weekday** axis; **Recent incidents removed →** a **Services** status table + a **Models & running tasks** table (below). |
| **12 · Audit Log** (`70:1843`) | Page header had a secondary **"Columns"** button beside **Export**. | **"Columns" button deleted** (`btn-export`/`btn-export-label` `70:1909`/`70:1910`); header = single primary **Export**; column show/hide lives only in the toolbar **View** control (`tbl-view` `70:1950`). |
| **02 · DataGrid — Anatomy** (`60:745`) | Toolbar caption read **"Density · Columns"**. | Relabelled **"Density · View (columns)"** (`60:779`) — documents that column visibility is a function of **View**. |
| **13 · Tenants** (`69:1416`) · **04 · Full-Screen Table** (`59:155`) | — | Audited: already correct (toolbar has **View**, no Columns button) → no structural change. |

**Metrics added to 10 · Dashboard (secondary KPI row) + implementation rationale.** Picked four that cover *scale · the two heaviest AI pipelines · capacity*, each grounded in a countable entity:

| KPI | Value | Grounded in |
|---|---|---|
| **Total users** | 1,847 (▲24 this week) | `User` rows across all tenants (Prisma `user`) — cross-tenant platform scale. |
| **Transcription min · 24h** | 14,208 | STT is the highest-volume pipeline; audio-minutes processed is the core usage/billing signal (`apps/stt`, `whisper-large-v3-turbo`). |
| **Summaries · 24h** | 642 | SMR throughput; `gemma-4-e4b` is the default summarizer (`apps/smr`) — ties compute to clinical output. |
| **Storage used** | 2.4 TB / 5 TB quota | Media + artifacts in MinIO (`media` schema, TASK-376 backfill) — capacity planning vs quota. |

*Headline-KPI rationale:* the four top cards answer **"is the platform healthy & busy right now"** cross-tenant — tenant count, live SSE sessions, in-flight Temporal/harness **jobs**, and **service health** (degraded count + which).

**Monitoring tables + rationale.**
- **Services** (one row per microservice — API, STT, SMR, NLP, Guardrail, Harness) with **dot + label** status, **P95 latency (ms)** and **uptime (%)** — the SRE golden signals. **SMR shown Degraded** (amber), consistent with the `ServiceStatusBar` and the Dashboard "Degraded services 1" KPI.
- **Models & running tasks** — grounds the AI layer in the **real models** each service runs: `whisper-large-v3-turbo` + `silero-vad-v5` (STT), `gemma-4-e4b` (SMR), `granite-guardian-4.1-8b` (Guardrail), `Medical-NER` + `symps-disease-bert` (NLP). *Running* = concurrent inferences (whisper + VAD both show 7, i.e. the 7 active STT streams); *avg latency* per model (ms for fast models, s for LLM summarization).

**Columns → View consolidation (DataGrid pattern fix).** The toolbar must never carry a standalone **Columns** button — column show/hide belongs inside **View** (a popover with per-column checkboxes; per-column *Hide column* / *Pin* also live in the header menu, documented on `02`). Audited all four table frames:

| Frame | Columns button? | Action |
|---|---|---|
| 12 · Audit Log | **Yes** (stray header button) | **Removed** → View owns columns |
| 02 · DataGrid | No (caption only) | Caption **"Density · Columns" → "Density · View (columns)"** |
| 13 · Tenants | No | none (already View-only) |
| 04 · Full-Screen Table | No | none (already View-only) |

→ **Confirmed: no table frame has a separate "Columns" button.**

**Consistency fix.** Aligned the fixed `ServiceStatusBar` **processing** count to the platform truth **"23 processing"** across `11`/`12`/`13`/`04` (matches the Dashboard *Processing jobs 23* KPI; previously read "3").

**Verification.** Re-shot + read-by-eye (all PASS): `admin-10-dashboard.png`, `admin-11-monitoring.png`, `admin-12-audit-log.png`, `admin-13-tenant-management.png`, `foundation-11-fullscreen-table.png`, `foundation-13-datagrid-anatomy.png`. Active nav + breadcrumb = current screen on every frame; real domain data; tabular numerals; dot+label status; new controls present, aligned, legible.

**Deferred:** Lucide icon swap (still placeholder squares — MCP rasters aren't token-driven, fixed at code time); chart bars are illustrative rects (real series wired at implementation). Super-admin tier remains **4/7** (10–13 built; 14 Rate Limits, 15 Queues & Jobs, 16 Prisma Studio pending).

### 5.10 Figma build — Pass 10 — new foundation interfaces (card-grid · item-list · timeline) (2026-06-29)

Built the three remaining **foundation patterns** from `PHASE-2-PLAN.md` §4a, filling the **last two free slots of the 00–09 foundation band** on the `foundation` page (placed in the foundation row at `y=0`, to the right of `07 · Responsive`). Ran the `/uxu` loop (build → screenshot → read-by-eye) until each passed the Realism Checklist.

**Frame-numbering decision.** The foundation band had only **08** and **09** free before colliding with the `10–19` super-admin tier, but the plan called for **three** patterns. Resolved by consolidating the two list patterns under one numbered frame: **`08 · Card-Grid`** and **`09 · Lists — Item-List & Timeline`**, where `09` holds two self-titled sub-regions **`09a · Item-List`** and **`09b · Timeline`** (each screenshot independently). No collision with the `10–19` tier.

| Frame | Node ID | Position | Size |
|---|---|---|---|
| **08 · Card-Grid** | `82:2231` | foundation row · `x=13160` | 1440×1240 |
| **09 · Lists — Item-List & Timeline** | `84:2382` | foundation row · `x=14800` | 1440×1384 (parent) |
| → **09a · Item-List** | `84:2383` | child · `y=0` | 1440×560 |
| → **09b · Timeline** | `84:2384` | child · `y=560` | 1440×824 |

**08 · Card-Grid** (example: tenant **Departments**) — responsive auto-fit grid (`minmax(280px, 1fr)`); **toolbar** (search · density toggle · View · `+ New department`); **comfortable** density (4 × 312px cards: icon chip · name · code + clinician count · status pill `dot+label` · prompt chips) showing **selected** (aria-selected + teal ring), **hover** (bg + elevation shadow), **default**, **disabled** (aria-disabled); **compact** density (5 condensed cards, single-line meta + status dot); **states** — **skeleton** (animate-pulse bars, aria-busy), **keyboard focus** (2px `#0f7a8b` focus-visible ring), **empty/no-results** panel (icon · message · `+ New department`); **responsive** rail (Desktop ≥1280 → 4 col · Tablet 768 → 2 col · Mobile 360 → 1 col); **a11y** strip (role=grid/gridcell · roving tabindex · Enter/Space activate · status dot+label · hit targets ≥44px · prefers-reduced-motion).

**09a · Item-List** (example: consultation **processing jobs**) — **comfortable** list (48px rows) with one **expanded** row revealing a **pipeline stepper** (Recording → Transcription → **Summary (active)** → Guardrail → Signed) + meta (`gpt-4o-mini · 1,284 tokens · queued → running 01:18 · tenant Acme Health`) + **View logs ›**; **collapsed** rows for CS-204xx sessions w/ stage·service, status `dot+label` (Running/Passed/Completed), tabular duration; **compact** list (36px rows, zebra striping) — 8 dense rows across STT/SMR/NLP/Guardrail w/ Running/Passed/Done/Queued/Failed/Review; **keyboard focus** ring on a compact row; row-anatomy + keyboard captions.

**09b · Timeline** (example: **HOPE platform release history**) — a changelog-style **scroll-spy** vertical timeline (per the reference images): version + date markers on a **left rail**, milestone **dots** on a connector. The **comfortable** column renders the realized states requested: the **active marker is sticky/highlighted** (filled teal `v2.4.0` pill + halo dot + "↑ sticks on scroll"), **one milestone expanded** (intro · collapsible **New** w/ 3 bullets · a **code block** · an **image/media block**) with **Updates**/**Bug fixes** sections **collapsed** (count + chevron), plus two further **collapsed** milestones (v2.3.0, v2.2.0) w/ summary chips. The **compact** column is a dense 5-release list (active row highlighted). A **SCROLL-SPY** annotation card explains the sticky behaviour with a mini diagram (scrolled-past · **active · sticky** "v2.4.0 · in view" · upcoming). Footer documents anatomy + keyboard (↑/↓ · Enter expands · Home/End) + status dot+label.

**Verification.** `save_screenshots` (scale 1, clipped) → read-by-eye, all **PASS**: `foundation-card-grid.png` (08), `foundation-item-list.png` (09a), `foundation-timeline.png` (09b). Real HOPE domain data throughout (Departments + clinicians; CS-204xx pipeline jobs; release history grounded in real services/models); built from `theme.css` tokens; status always **dot + label** (never colour-only); tabular numerals; ≥44px touch targets; responsive specified. The **00–09 foundation band is now complete**.

**Deferred:** Lucide icon swap (placeholder square affordances — added at code time); code/image blocks are illustrative (real syntax-highlight + thumbnails at implementation); the timeline foundation extends `packages/ui/src/components/timeline/*` when coded.

### 5.11 Figma build — Pass 11 — tenant-management blades (2026-06-29)

> **⛔ Superseded by Pass 13 (§5.13, 2026-06-29).** After the page-based model (§5.12) was approved, the **nine tenant-management blade frames built in this pass were deleted** from `HOPE-Admin-Console` — the stacked-blade primary navigation (2–4-level at `21`/`35`) is replaced by the page-based Tenant Detail set + dialogs. **Removed node IDs:** `17`=`86:2948` · `18`=`85:2605` · `20`=`87:3320` · `21`=`88:5734` · `22`=`87:3732` · `34`=`87:4483` · `35`=`88:5293` · `36`=`87:4872` · `37`=`87:4102`. **This section is kept as history** — its domain grounding, TARGET-metric flags, permission model and flow coverage carried forward verbatim into the Pass-13 pages/dialogs. The foundation `05 · Blades` (`60:490`) reference is **retained** (blades remain a valid generic master→detail pattern, just not for tenant sub-resource navigation). The original `admin-tenant-*.png` screenshots are kept as a record of the superseded flow.

Built the **tenant-management Blade interface** from [`PHASE-2-PLAN.md` §4b](./PHASE-2-PLAN.md) — the full *master-grid → detail-blade → nested-blade* model for operating a single tenant, opening from `13 · Tenant Management` (`69:1416`). Nine frames across three tier rows, reusing `05 · Blades` (`60:490`) and the `18 · Tenant Detail` shell via `duplicate_nodes` → reskin. Every frame keeps **nav = Tenants**, breadcrumb `Home / Platform / Tenants / Acme Health`, `theme.css` tokens (active teal `#0e626e`, muted `#44535e`), **dot + label** status, tabular numerals, and ≥44px targets. Domain is grounded in the real schema/SDK the plan captured: `Tenant.key`/`resourceStatus`/`tags` (**no `plan`/`deletedAt`**), agent instructions = **`PromptTemplate` (`scope=DEPARTMENT_DEFAULT`)**, user→department = **`UserDepartment`** (`useUserDepartments`), storage = **`TenantBucket`** (`useTenantBuckets`).

| # | Frame | Node ID | Row (x, y) | Built from | Flow / captures |
|---|---|---|---|---|---|
| **17** | Add Tenant | `86:2948` | `6160, 1440` | 18 · Detail | **Add-tenant blade** — real Tenant fields (Name, **key** mono w/ inline uniqueness validation, Domain, Tags, initial `resourceStatus`), helper text, **saving state** on the primary `Create tenant`, footer `0 of 13 row(s) selected` on the dimmed master grid behind. |
| **18** | Tenant Detail — Overview | `85:2605` | 05 · Blades | **Detail blade** over the dimmed Tenants grid — eyebrow `TENANT` · `Acme Health` · `Active` badge, 4 KPI tiles (Users 142 · Departments 9 · Agent instructions 23 · Pipelines 6), section tabs **Overview/Users/Configuration/Storage/Departments**, About (key·domain·tags·created), permission note. |
| **20** | Tenant Users | `87:3320` | `6160, 2540` | 18 · Detail | **Users** tab — member roster (avatars, role, email, dot+label status) + a **nested Tenant User blade** (Dr. Anaya Rao — `ACCESS & ROLE`, role chip `Tenant-admin`, department chips Cardiology/Neurology, recent-activity, footer `Reset password`/`Deactivate`/`Save`). 2-level stack. |
| **21** | Assign Department | `88:5734` | `7700, 2540` | 20 · Users | **user→department assignment (user side)** — **deepest 4-level stack**: master grid → tenant detail (Users) → Tenant User blade → **Assign-Departments picker** (multi-select checklist of all departments w/ member counts; Cardiology/Neurology checked, **Pulmonology checked + highlighted `9 members · adding`**; `3 selected`; footer `1 change` · `Cancel` · `Save assignments`). Saved as `UserDepartment`. |
| **22** | Tenant Configuration | `87:3732` | `9240, 2540` | 18 · Detail | **Configuration & settings** tab — **"Acting on: Acme Health"** scoped-mutation banner, config **KV** rows, **feature-flag** toggles, **ASR pipeline / engine** select. |
| **34** | Department Management | `87:4483` | `6160, 3640` | 18 · Detail | **Departments** tab — responsive **2-col card grid** (6 depts: Cardiology/Neurology/Pulmonology/Endocrinology/Oncology/Pediatrics — each w/ member + agent-instruction counts, **Lead** clinician, dot+label status incl. Pediatrics **Paused** amber, `Manage →`), search, `+ New department`. |
| **35** | Add Users to Department | `88:5293` | `9240, 3640` | 36 · Agent Instr. | **user→department assignment (department side)** — Cardiology **Members** tab (roster) + nested **"Add members" picker**: search + multi-select candidate checklist (Dr. Sofia Reyes / Dr. Omar Haddad / Nadia Hassan RN checked; Dr. Lena Fischer unchecked, flagged *currently Endocrinology*), `3 selected`, footer `Add 3 members`. Bulk `UserDepartment` assign. 3-level stack. |
| **36** | Agent Instructions | `87:4872` | `7700, 3640` | 34 · Departments | **agent-instruction creation** — nested **Department · Cardiology** blade w/ **Agent instructions** tab: list of **`PromptTemplate`s** (Cardiology Intake Summary `SMR·v4`, ECG Findings Extractor `NLP·v2`, Chest-Pain Triage Guardrail `Guardrail·v1` — Active; Discharge Letter `SMR·v3` — **Draft** amber) + inline **"New agent instruction"** create form (Name, Service, **Scope `DEPARTMENT_DEFAULT · locked`**, Prompt) → `Create instruction`. 3-level stack. |
| **37** | Tenant Storage | `87:4102` | `10780, 3640` | 18 · Detail | **Storage** tab — **quota bar at 92%** (amber *approaching quota*), usage breakdown, **buckets table** (4 `TenantBucket` rows across AWS S3 + GCS — mono names, object counts/sizes, region, ● Active), provider/keys, + an explicit **TARGET-surface note** flagging the quota/usage backend gap. |

**Flows covered (plan §4b):** add-tenant ✓ · tenant detail w/ tabbed sections ✓ · users (list + manage, nested user blade) ✓ · configuration & settings ✓ · storage (buckets/usage) ✓ · departments ✓ · **user→department assignment from both the user side (21) and the department side (35)** ✓ · **agent-instruction / `PromptTemplate` creation within a department (36)** ✓.

**States covered:** nested/stacked-blade states at **2, 3, and 4 levels** (dimming scrims + stacked cards + left-shadow); **saving** (17); inline **validation / uniqueness** (17 key); **multi-select w/ live selected-count + pending "adding"** (21, 35); **Draft vs Active** status (36); **Paused** department (34); **approaching-quota** warning (37); focused/selected master rows throughout. (Async skeleton/empty/error remain proven on the `02 · DataGrid` foundation, reused by these grids.)

**Permissions:** the super-admin bands (**17/18** Tenant Management, 10–19) operate cross-tenant; the shared bands (**20/21/22**, 20–29) and tenant-admin bands (**34/35/36/37**, 30–49) operate **within the selected tenant** — `22` carries the **"Acting on: «Tenant»"** banner and `21` shows the **super-admin "acting on Acme Health" vs tenant-admin read-only** note, per the plan's permission model.

**TARGET-metric note (recorded product decision).** Some fields shown are **target UI with no current backend** and must be implemented later — they are drawn realistically (not as placeholders) and flagged here as backend-gap items:
- **Tenant `Plan`** (Enterprise/Pro/Trial/Starter) — `Tenant` has **no `plan` field** (only `key`/`resourceStatus`/`tags`); shown on the grid/detail as target.
- **Storage quota** (e.g. `2.4 TB / 5 TB`, 92% bar on `37`) — **no quota field** on `TenantBucket`; usage %/limit is target.
- Aggregate **counts** (per-tenant Users/Departments/Agent-instructions/Pipelines KPIs; per-department member + instruction counts) are **derived/target** roll-ups pending aggregation endpoints.

**Verification.** Each frame `save_screenshots` (scale 1) → **read-by-eye** against the Realism Checklist ([`.cursor/skills/uxu/SKILL.md`](../../../.cursor/skills/uxu/SKILL.md)), looped until pass: `admin-tenant-add.png`, `admin-tenant-detail.png`, `admin-tenant-users.png`, `admin-tenant-assign-departments.png`, `admin-tenant-config.png`, `admin-tenant-departments.png`, `admin-tenant-add-members.png`, `admin-tenant-agent-instructions.png`, `admin-tenant-storage.png`. Fixes during the loop: `34` footer-helper overlap + dept-count reconciled to the KPI (9); `21` footer-helper overlap (`→ 1 change`). Temporary `_wip-*` probe screenshots removed.

**Deviation from plan:** none material. The plan's tenant-mgmt screen list is honored with its exact frame numbers (17/18 super-admin · 20/21/22 shared · 34/35/36/37 tenant-admin). `21 · Assign Department` is placed in the shared 20–29 row because it stacks directly off the `20 · Users` flow (user-side assignment), complementing the department-side `35`. **Deferred** (consistent with prior passes): Lucide icon swap (placeholder squares — MCP rasters aren't token-driven), and chart/quota bars are illustrative rects (real series at implementation).

### 5.12 Figma build — Pass 12 — page-based Tenant Detail (proposal)

**Status: ✅ approved → built out in Pass 13 (§5.13).** The §5.11 blade frames were **deleted** and the full page set + dialogs are now the canonical tenant-management model (the two proposal frames below were promoted out of "proposal" — `— PROPOSAL` name/eyebrow dropped, teal active tab standardized). Responds to the request: *"instead of so many sheets/blades… can we build the Tenant Detail as a **page**?"* (open `Acme Health` from the list → a Tenant Detail **page**, breadcrumb `Home > Platform > Tenants > Acme Health`). Two new PROPOSAL frames were **added** in a fresh row at `y=4900` (no blade frame touched): **`18p · Tenant Detail — Overview (Page)`** (`95:6164`, `6160, 4900`) and **`20p · Tenant Detail — Users (Page)`** (`97:6529`, `7700, 4900`). Built by `duplicate_nodes` off `18 · Tenant Detail` (shell + breadcrumb + KPI/About inherited) then reskinned to a full-width page; `theme.css` tokens, dot+label status, tabular numerals, ≥44px targets, real domain data carried over from §5.11.

**Recommendation — page, not blades (with overlays for transient actions).** A **full Tenant Detail _page_ with horizontal tab/section sub-navigation backed by nested routes** is the right model for a complex entity that owns many sub-resources (Users · Configuration · Storage · Departments · Agent instructions). It gives **deep-linking, bookmarking, browser back/forward, shareable URLs, and a real breadcrumb for free**, and it scales past the 3–4-level **stacked-sheet anti-pattern** the blades hit at `21`/`35` (master grid → detail blade → nested blade → picker). This is how Stripe/Vercel/AWS/Linear render entity detail. **Keep as overlays only the transient, focused, single-step actions** that don't deserve a URL: **Add/Edit tenant** = Dialog (or a `/tenants/new` route), **Disable/Archive** = `AlertDialog` (X7), **Assign department / Add member / Add users to department** = a **Dialog** multi-select invoked from the page (replacing the nested pickers `21`/`35`), **Agent-instruction create** = Dialog/inline form. *When is a sheet still right?* For exactly those transient one-step tasks and quick previews — the anti-pattern is using **stacked** sheets as primary navigation for an entity's sub-resources.

**Dev-ready route map (TanStack Router, file-based under `apps/admin/src/routes/_authenticated/tenants/`):**

| Route file | URL | Role |
|---|---|---|
| `tenants/index.tsx` | `/tenants` | List (today's `tenants.tsx`, unchanged) — row click → `navigate({ to: '/tenants/$tenantId' })` |
| `tenants/new.tsx` *(or Dialog)* | `/tenants/new` | Add tenant (overlay-friendly; Dialog from the list is fine) |
| `tenants/$tenantId/route.tsx` | `/tenants/$tenantId` | **Detail layout route** — `loader` fetches the tenant; renders the **page header** (identity + Edit/Disable/⋯) + **tab nav** + `<Outlet/>` |
| `tenants/$tenantId/index.tsx` | → | Redirect to `overview` |
| `tenants/$tenantId/overview.tsx` | `…/overview` | KPI tiles + About + recent activity (frame `18p`) |
| `tenants/$tenantId/users.tsx` | `…/users` | Members `VirtualizedDataGrid`; **Add member = Dialog** (frame `20p`) |
| `tenants/$tenantId/configuration.tsx` | `…/configuration` | KV / feature flags / ASR pipeline (+ "Acting on" banner) |
| `tenants/$tenantId/storage.tsx` | `…/storage` | `TenantBucket` table + quota |
| `tenants/$tenantId/departments/route.tsx` + `index.tsx` | `…/departments` | Department card-grid |
| `tenants/$tenantId/departments/$departmentId.tsx` | `…/departments/$departmentId` | Department detail (Members · Agent instructions); pickers = Dialogs |

**Component-reuse map (so engineers scaffold fast).** *Carry over unchanged:* `app-shell.tsx`, `page-header.tsx` (tenant identity + page actions), `VirtualizedDataGrid` (members/departments/buckets), `StatusBadge` (dot+label), the KPI tiles, the **08 card-grid** foundation (Departments tab) and **09 item-list/timeline** (recent activity/audit), `confirm-delete.tsx` (AlertDialog). *Refactor:* `tenant-detail-sheet.tsx` → **`$tenantId/route.tsx`** (header + tab nav layout) **+ one small page component per tab** (its existing tab bodies move almost verbatim into `overview/users/configuration/storage/departments`); `tenant-form-sheet.tsx` → **keep as a Dialog** for Add/Edit (no longer a primary-navigation sheet). *New (small):* a `TenantDetailLayout`/`TenantTabs` using TanStack `<Link>` with `activeProps` for the underline-active token style.

**Breadcrumb model.** Derive from route context, not hardcoded: the `$tenantId` `loader` returns the tenant, and a `useMatches()`-based builder maps each matched route → a crumb (`staticData.crumb` for static labels, loader data for dynamic). `Home` = dashboard · `Platform` = the nav-group label the Tenants area lives under · `Tenants` = `/tenants` · `Acme Health` = `loaderData.tenant.name` → renders **`Home > Platform > Tenants > Acme Health`** exactly. (Tabs don't extend the breadcrumb; the active tab is shown by the in-page tab nav.)

**Responsive.** Tab nav: desktop = horizontal underline tabs → tablet = horizontally scrollable / segmented → mobile = a `Select` (or stacked accordion) to switch sub-sections; page-header actions collapse into the `⋯` menu on mobile; the members grid degrades to the **16 · Responsive** card-list. **Multi-tenancy / impersonation continuity.** Super-admin reaches this cross-tenant via **Platform → Tenants → Acme Health**; the tenant-admin-scoped tabs (Configuration, Users/Department mutations) keep the **"Acting on: «Tenant»"** banner, and the same page component is what a tenant-admin sees scoped to their own tenant (super-admin = full control · tenant-admin = read-write within tenant · System tenant protected). Both proposal frames carry the permission banner conveying this.

| Frame | Node ID | Row (x, y) | Captures | Screenshot |
|---|---|---|---|---|
| **18p** · Tenant Detail — Overview (Page) | `95:6164` | `6160, 4900` | Page shell w/ **Tenants** active · breadcrumb `Home / Platform / Tenants / Acme Health` · page header (avatar `Acme Health`, key·domain, **Active** badge, `Edit tenant`/`Disable`/`⋯`) · in-page tabs **Overview**(active)·Users·Configuration·Storage·Departments · full-width KPI tiles (142·9·23·6) · **About** card · **Recent activity** card · permission banner · fixed `ServiceStatusBar` | `admin-tenant-page-overview.png` |
| **20p** · Tenant Detail — Users (Page) | `97:6529` | `7700, 4900` | Same page shell, **Users** tab active · toolbar (search · `142 members · 6 shown` · **`+ Add member`** primary) · in-page members **`VirtualizedDataGrid`** (6 rows: avatar·name·email·role·departments·dot+label status incl. **Invited**/**Inactive**) · footer `Showing 6 of 142 · Page 1 of 24` · banner explicitly noting **"Add member / Assign department open as a dialog — no nested blade"** | `admin-tenant-page-users.png` |

**Verification.** Both frames `save_screenshots` (scale 1, clip) → **read-by-eye** against the Realism Checklist ([`.cursor/skills/uxu/SKILL.md`](../../../.cursor/skills/uxu/SKILL.md)) — **PASS** (page reads unmistakably as a page: full-width content, no scrim/blade; exact requested breadcrumb; dot+label status; tabular counts; mono tenant ID; token-built). If approved, the full page set (Overview/Users/Configuration/Storage/Departments + department detail) replaces the §5.11 blade primary-navigation; the assignment pickers become Dialogs.

### 5.13 Figma build — Pass 13 — page-based Tenant Detail build-out + blade removal (2026-06-29)

Acted on the approved decision (§5.12): **removed the stacked-blade tenant-management screens and built the full page-based Tenant Detail set plus the dialogs that replace the nested pickers.** Pages continue the `y=4900` row; dialog overlays sit in a new `y=6100` row. All from `theme.css` tokens, **dot+label** status, tabular numerals, ≥44px targets, real `Acme Health` domain data carried from §5.11/§5.12. Sole editor (no parallel writers).

**Blades removed (9 frames deleted; node IDs freed):** `17 · Add Tenant` `86:2948` · `18 · Tenant Detail — Overview` `85:2605` · `20 · Tenant Users` `87:3320` · `21 · Assign Department` `88:5734` · `22 · Tenant Configuration` `87:3732` · `34 · Department Management` `87:4483` · `35 · Add Users to Department` `88:5293` · `36 · Agent Instructions` `87:4872` · `37 · Tenant Storage` `87:4102`. Each identity confirmed via `get_node` name before `delete_nodes`. Foundation `05 · Blades` (`60:490`) and every non-tenant frame left intact.

**KEEP pages finalized.** The two §5.12 proposal frames were promoted: dropped the `— PROPOSAL` name suffix and the `PROPOSAL … PENDING APPROVAL` eyebrow (→ `PAGE-BASED TENANT DETAIL · OVERVIEW` / `· USERS`), standardized the **active tab to teal `#0e626e`** / inactive `#5a6a77`, and re-shot.

**Pages built (`y=4900` row):**

| # | Frame | Node ID | x | Captures | Screenshot |
|---|---|---|---|---|---|
| **18p** | Tenant Detail — Overview (Page) | `95:6164` | 6160 | (finalized from §5.12) KPIs · About · Recent activity | `admin-tenant-page-overview.png` |
| **20p** | Tenant Detail — Users (Page) | `97:6529` | 7700 | (finalized from §5.12) members `VirtualizedDataGrid` | `admin-tenant-page-users.png` |
| **22p** | Tenant Detail — Configuration (Page) | `109:6768` | 9240 | scoped-mutation permission note · **General** feature toggles (Ambient capture / PHI redaction / Auto-summarize / Require sign-off) · **ASR pipeline** selects (engine + language) · Discard/Save w/ last-saved · System-tenant lock note | `admin-tenant-page-configuration.png` |
| **37p** | Tenant Detail — Storage (Page) | `110:6976` | 10780 | **quota bar 92%** amber *approaching quota* · usage breakdown · **`TenantBucket` table** (4 rows AWS S3 + GCS — mono names, objects/size/region, ● Active) · rotate-keys/provider · **TARGET-surface note** | `admin-tenant-page-storage.png` |
| **34p** | Tenant Detail — Departments (Page) | `110:7195` | 12320 | in-page **card grid** (reuses `08 · Card-Grid`): 6 depts (Cardiology/Neurology/Pulmonology/Endocrinology/Oncology/Pediatrics — member + agent-instruction counts, **Lead** clinician, dot+label incl. Pediatrics **Paused** amber, `Manage →`) · search · `+ New department` | `admin-tenant-page-departments.png` |
| **36p** | Department Detail — Cardiology (Page) | `110:7414` | 13860 | department-scoped page · breadcrumb `Home / Platform / Tenants / Acme Health / Departments / Cardiology` · header (Cardiology · Active · `Add members`/`Edit dept`/⋯) · **own sub-tabs Members(active) · Agent instructions** · members **`VirtualizedDataGrid`** (7 rows: avatar·name·email·role·dot+label status incl. **Invited**·joined) | `admin-department-detail.png` |

**Dialogs built (`y=6100` row — each a full 1440×1024 = real page + 55%-opacity scrim + centered modal, so reviewers see true context):**

| Frame | Node ID | x | Over | Captures | Screenshot |
|---|---|---|---|---|---|
| **Dlg · Add Tenant** | `110:7669` | 6160 | `13 · Tenant Management` list | Name · **key** mono w/ inline **● Available** uniqueness check · Domain · **Tags** (chips Enterprise/US-East) · **Initial status** segmented (Active/Trial/Suspended) · Cancel/`Create tenant`. Replaces blade `17`. | `admin-dlg-add-tenant.png` |
| **Dlg · Assign Departments** | `110:7981` | 7700 | Users page | per-user multi-select checklist (Cardiology/Neurology checked · **Pulmonology checked + `Adding`** · Endocrinology/Oncology unchecked · Pediatrics disabled *paused*) · `3 selected` · Cancel/`Save assignments`. Replaces 4-level blade `21`; saved as `UserDepartment`. | `admin-dlg-assign-departments.png` |
| **Dlg · Add Members** | `110:8201` | 9240 | Department Detail · Members | search + candidate checklist (avatars · 3 of 5 checked) · `3 selected` · Cancel/`Add 3 members`. Replaces blade `35`; bulk `UserDepartment`. | `admin-dlg-add-members.png` |
| **Dlg · New Agent Instruction** | `110:8440` | 10780 | Department Detail · **Agent instructions** | Name (Cardiology Intake Summary) · Service (SMR) · **Scope `DEPARTMENT_DEFAULT · Locked`** · Prompt textarea (real clinical prompt) · Cancel/`Create instruction`. Replaces blade `36` inline create; `PromptTemplate scope=DEPARTMENT_DEFAULT`. | `admin-dlg-new-agent-instruction.png` |
| **Dlg · Disable Tenant** | `110:8662` | 12320 | Overview page | **AlertDialog** (X7) — amber warn icon · "Disable Acme Health?" · recoverable-archive copy (suspends 142 users / 9 depts, ends sessions) · Cancel/**Disable tenant** (destructive). | `admin-dlg-disable.png` |

**Overlay-vs-page rationale (recorded).** Sub-resources that own state and deserve a URL are **pages** with horizontal tab/section nav (Overview·Users·Configuration·Storage·Departments; the department detail nests Members·Agent instructions) — deep-linkable, bookmarkable, real breadcrumb, no stacked-sheet anti-pattern. Transient single-step actions are **dialogs** rendered over their true parent page (context stays visible behind the scrim): Add Tenant, Assign Departments, Add Members, New Agent Instruction, and the destructive Disable **AlertDialog**.

**Breadcrumb / tab model.** Tenant pages: `Home / Platform / Tenants / Acme Health` (active section shown by the in-page tab, not appended to the crumb). Department detail extends it: `… / Acme Health / Departments / Cardiology`. Active tab/sub-tab = teal underline + `#0e626e` text token; inactive `#5a6a77`.

**Responsive + multi-tenancy/impersonation** (same model as §5.12): tab nav desktop horizontal underline → tablet scrollable/segmented → mobile `Select`; header actions collapse to ⋯; members/department grids degrade to the `07 · Responsive` card-list. Super-admin reaches this cross-tenant via Platform → Tenants → Acme Health (full control); a tenant-admin sees the same page components scoped to their own tenant (Configuration/mutations carry the **"Acting on: «Tenant»"** intent via the permission banner); the System tenant (`__GLOBAL__`) config is locked.

**TARGET-metric flags retained (unchanged product decision from §5.11):** drawn realistically but backend-gapped — tenant **Plan**; **storage quota/usage** (92% bar, TB limits — no quota field on `TenantBucket`); aggregate **counts** (KPIs, per-department member/instruction roll-ups). The Storage page keeps an explicit TARGET-surface note.

**Verification.** Every new/edited frame `save_screenshots` (scale 1, clip) → **read-by-eye** against the Realism Checklist ([`.cursor/skills/uxu/SKILL.md`](../../../.cursor/skills/uxu/SKILL.md)), looped to PASS: the 4 new pages, the 5 dialogs, and the 2 re-shot KEEP pages. All read as real surfaces — full-width pages (no scrim) vs. dialogs (scrim + centered modal over the true page); exact breadcrumbs; dot+label status (incl. Paused/Invited/degraded); mono keys/scope; segmented/checkbox/locked-field states; tabular numerals; token-built.

**Deferred** (consistent with prior passes): Lucide icon swap (placeholder squares/glyphs — MCP rasters aren't token-driven, fixed at code time); chart/quota bars illustrative; per-screen dark-mode variants. Implementation follows the §5.12 TanStack route map + component-reuse map.

### 5.14 Figma build — Pass 14 — tenant dashboard · users management · agent management (parallel build) (2026-06-29)

Built by **three parallel `ui-ux-designer` agents** working in **disjoint Figma Y-bands** — **A** `[7600, 9400]`, **B** `[9600, 13200]`, **C** `[13400, 15800]` with **200px gutters** — per [`PHASE-3-PLAN.md`](./PHASE-3-PLAN.md) §2. Disjoint Y-ranges guarantee no two agents ever touch the same canvas coordinates or node, which **prevented the duplicate-node conflict** an earlier parallel run hit. Each agent duplicated a KEEP shell **read-only** into its own band and reskinned (A ← `18p · Overview` `95:6164`; B ← `20p · Users` `97:6529` + `36p` `110:7414`; C ← `36p · Department Detail` `110:7414`), then ran the `/uxu` read-by-eye loop per frame. All from `theme.css` tokens, **dot+label** status, tabular numerals, ≥44px targets, real `Acme Health` domain data, fixed `ServiceStatusBar`, and the shared permission banner.

**#1 Tenant Dashboard (Agent A, band y≈7720):**

| Frame | Node ID | Screenshot |
|---|---|---|
| `18d · Tenant Dashboard (Page)` — main | `120:8843` | `admin-tenant-dashboard-overview.png` |
| `18d · Tenant Dashboard — Loading` | `120:10826` | `admin-tenant-dashboard-loading.png` |
| `18d · Tenant Dashboard — Empty` | `120:10998` | `admin-tenant-dashboard-empty.png` |
| `18d · Tenant Dashboard — Error` | `120:11169` | `admin-tenant-dashboard-error.png` |
| `18d · Tenant Dashboard — Tenant-admin` | `120:11341` | `admin-tenant-dashboard-tenant-admin.png` |

Content: headline KPIs (**Active users 142 · Departments 9 · Running sessions 14 · Services healthy 6/7 — SMR degraded**); secondary row (**Open sockets 18 [TARGET] · Processing jobs 23 · Consultations today 87 = 62 new / 25 re-visit · Pending review 11 · Consumption 1.2k [TARGET]**); consultation-sessions chart (**New vs Re-visit**, Week/Month/Year); recent-activity = **audit-log feed**; audio-pipeline strip (STT / VAD / **SMR-degraded** / Guardrail / NLP). States: main / loading / empty / error / tenant-admin. Upgrades the `18p · Overview` tab into an operational tenant dashboard.

**#2 Users management (Agent B, band y[9600,13200]):**

| Frame | Node ID | Screenshot |
|---|---|---|
| `20u · Tenant Users — Data Grid (Page)` | `120:9015` | `admin-users-grid.png` |
| `20u · Users — Bulk Selected` | `120:9913` | `admin-users-grid-bulk.png` |
| `20u · Users — Grid States` | `120:10134` | `admin-users-grid-states.png` |
| `Dlg · Create User` | `120:10354` | `admin-users-dlg-create.png` |
| `38u · User Detail — Dr. Anaya Rao (Page)` | `120:10575` | `admin-users-detail-profile.png` |
| `38u-a · User — Profile (edit)` | `121:11980` | `admin-users-panel-a-profile-edit.png` |
| `38u-b · User — Preferences` | `121:11981` | `admin-users-panel-b-preferences.png` |
| `38u-c · User — Agent Instructions (per dept)` | `121:11982` | `admin-users-panel-c-agent-instructions.png` |
| `38u-d · User — DNA Writing-Style Instructions` | `121:11983` | `admin-users-panel-d-dna-style.png` |
| `38u-e · User — Department Assignment` | `121:11984` | `admin-users-panel-e-departments.png` |
| `38u-f · User — DNA Reports + Versions` | `121:11985` | `admin-users-panel-f-dna-reports.png` |
| `38u-g · User — Activity History` | `121:11986` | `admin-users-panel-g-activity.png` |

Content: datagrid (search · **Status / Role / Department / Type** filters · View/columns · **Export ▾ CSV/Excel/PDF** · **+ New user** · per-row **quick-disable & reset-password** · sort · pagination **1–6 of 142**); **bulk-selected** action bar (Assign department · Reset password · Disable · Export selected · Clear); grid states loading/empty/error; **Create-User dialog**; **7-tab User Detail** + injectable panels **a–g**. Note `38u` expanded **5→7 tabs**; panels a–g built as standalone **injectable content frames**.

**#3 Agent management (Agent C, band y[13400,15800]):**

| Frame | Node ID | Screenshot |
|---|---|---|
| `30 · Agent Management — by Department` | `120:9200` | `admin-agents-30-mgmt.png` |
| `31 · Agent Instruction Editor` | `120:9454` | `admin-agents-31-editor.png` |
| `32 · Version Diff` | `120:9567` | `admin-agents-32-diff.png` |
| `33 · Test Playground` | `120:9681` | `admin-agents-33-playground.png` |

Content: tenant-level **Agent Management organized by department** (dept selector rail) with **4 default-agent slots** (Pre-summary · New-visit · Re-visit · **DNA-style**) + **instruction library**; monospace **editor** (Scope `DEPARTMENT_DEFAULT` locked, variables, draft/publish); side-by-side **version diff** (rollback/activate); **test playground** (sample input → output + **evaluation score 0.92**, faithfulness / coverage / conciseness). Improves on the old prompt UI (department-organized, semantic tokens, full-page editor, real playground).

#### 5.14.1 Consolidated REAL-vs-TARGET (backend gaps for implementation tickets)

TARGET (drawn realistically, **no backend yet**) aggregated across the three areas — these become backend tickets:

| Area | TARGET item (backend gap) |
|---|---|
| **Dashboard** | Open-sockets count; consumption / quota roll-ups; per-model audio-stream metrics. |
| **Users** | **Reset-password — BOTH flows** (emailed reset link [audited] **AND** admin-set temporary password forcing change at next login); **Excel / PDF export**; **bulk-action server endpoint**; admin editing **another user's preferences**. |
| **Agents** | The per-department **DNA writing-style default agent** slot (no `Department` column today — needs a `promptConfig` key or a new column). |

REAL / backed today (no new backend): datagrid CRUD; department assignment; personalized + DNA agent instructions; DNA reports/versions; per-user activity; server **CSV** export; the **3 default agent slots** (`Department.preSummaryPromptId / newPatientPromptId / revisitPromptId`); `PromptTemplate` scope `DEPARTMENT_DEFAULT`; `PromptVersion` / `compareVersions` / `activateVersion`; `usePrompts.test`.

#### 5.14.2 Polish follow-ups (recorded — not yet fixed)

- The **tenant-admin dashboard variant inherits the super-admin sidebar's `Platform › Tenants` active state** (shared-shell chrome) — resolve in the **shared shell** at implementation.
- Dashboard headline reserves its **4th tile for Services healthy**, with the **audio-pipeline as a dedicated strip** and **Open sockets in the secondary row** — **confirm with the user** whether to promote sockets / audio into the headline.

**Verification.** Every frame `save_screenshots` (scale 1, clip) → read-by-eye against the Realism Checklist ([`.cursor/skills/uxu/SKILL.md`](../../../.cursor/skills/uxu/SKILL.md)), looped to PASS. Real domain data throughout (Acme Health · Dr. Anaya Rao · Cardiology/Neurology/…); token-built; dot+label status (incl. degraded/Invited/Draft); tabular numerals; mono IDs/scope; active nav `Tenants` + breadcrumb correct per screen.

**Deferred** (consistent with prior passes): Lucide icon swap (placeholder squares/glyphs — MCP rasters aren't token-driven, fixed at code time); chart/quota bars illustrative; per-screen dark-mode variants.

### 5.15 Figma build — Pass 15 — full-canvas frame re-alignment (2026-06-29)

Housekeeping pass — **no design content, node IDs, sizes, or copy changed; only `x`/`y` of the 46 top-level frames** on the `foundation` page (`0:1`). The canvas had drifted "meshy": the foundations band was **out of numeric order** (`00, 03, 04, 05, 02, 01, 06, 07, 08, 09`), gutters were **inconsistent (100–200px)**, a **~2,400px empty vertical band** sat between the super-admin row and the tenant rows (left behind when the §5.13 blades were deleted), and stale orphan caption texts floated above the wrong frames.

**Target grid:** every row **left-aligned at `x=0`**, **120px** horizontal gutters, **240px** row gaps, numeric/logical order within each row. Verified by re-fetching the document tree and checking **zero intra-row overlaps**.

| Row | `y` | Frames (left→right) |
|---|---|---|
| 1 — Foundations | `0` | `00` `01` `02` `03` `04` `05` `06` `07` `08` `09` |
| 2 — Super-admin (10–19) | `1624` | `10 · Dashboard` · `11 · Monitoring` · `12 · Audit Log` · `13 · Tenant Management` |
| 3 — Tenant Detail (pages) | `2888` | `18p` · `20p` · `22p` · `34p` · `36p` · `37p` |
| 4 — Tenant Dashboard `18d` + states | `4152` | Page · Loading · Empty · Error · Tenant-admin |
| 5 — Tenant Users `20u` + detail | `5416` | Data Grid · Bulk Selected · Grid States · `38u · User Detail` |
| 6 — User Detail sub-tabs | `6680` | `38u-a` … `38u-g` (1180×760, 1300px step) |
| 7 — Agent Management | `7680` | `30` · `31` · `32` · `33` |
| 8 — Dialogs | `8944` | Add Tenant · Assign Departments · Add Members · New Agent Instruction · Disable Tenant · Create User |

**Grouping note:** the §5.12/§5.13 **proposal `p`-frames** (Row 3) and the §5.14 **built `18d`/`20u`/`38u` + agents** (Rows 4–7) are kept in separate rows — both generations retained (this pass does **not** dedupe; flagged for a later decision in §5.16).

**Orphan text nodes (deleted, user-approved):** removed 6 stale captions (`cap-10/11/12` + `-sub` = `59:153/154`, `59:306/307`, `60:743/744` — e.g. `cap-10` read "04 · Dashboard Shell" but floated above the `01` frame; only 3 of 10 foundation frames ever had them) and 1 empty `Text` node at origin (`97:6509`). The frames' own internal titles/subtitles are the single source of truth.

**Verification.** Final `get_document` → **46 children, all `FRAME`, 0 non-frame nodes, 8 rows, 0 intra-row overlaps**; composited a full-board overview from per-frame exports → `screenshots/foundation-board-realigned.png`.

### 5.16 Remaining
- **Persist the file** (save `HOPE-Admin-Console`) so frames stop rotating, then re-create the Pass-1/Pass-2 surfaces alongside the Pass-3/Pass-4 foundation frames in one document.
- Surfaces not yet drawn: `01 · Components` library; Roles & Policies (+ CASL policy builder); API Keys; `05 · System Health`; Settings; remaining super-admin 10–19 (Rate Limits, Queues & Jobs, Prisma Studio); remaining tenant-admin 30–49 (Stores detail, Ambience-listening → Audio processing, Agent Jobs, Harness). *(Tenant detail/create + Configuration/Storage/Departments & department-detail/agent-instructions are drawn as **pages + dialogs** — §5.13 (superseding the §5.11 blades); the **tenant dashboard (Overview)**, **Users management** (data grid + 7-tab user detail + dialogs) and **Agent management** (by department: editor / diff / playground) are drawn — §5.14; Audit Log is drawn — §5.7/§5.9.)*
- **Tenant archive/confirm** destructive flow (X2/X7) — **drawn** in §5.13 as the `Dlg · Disable Tenant` **AlertDialog** (recoverable-archive framing) over the Overview page (the `confirm-delete` component exists in `apps/admin`).
- **Backend gaps to ticket** (from §5.14.1): open-sockets count, consumption/quota & summary roll-ups, per-model audio-stream metrics; user **reset-password** (both flows), **Excel/PDF export**, **bulk-action endpoint**, admin-edit-another-user **preferences**; the per-department **DNA writing-style default-agent** column/`promptConfig` wiring.
- **Lucide** icon swap (nav/toolbar/grid icons are still placeholder squares/glyphs).
- Per-screen **dark-mode** variants (the token system + a dark component proof now exist in `01 · Theming`; extend to each surface).
- Extend the **responsive** specs (`07 · Responsive`) — which cover the shell, full-screen table and blade patterns — to the remaining surfaces (roles/policy builder, system health, settings; the tenant-detail **pages/dialogs** + the §5.14 dashboard/users/agents surfaces carry the §5.12/§5.13 responsive model — horizontal tab → scrollable/segmented → `Select`, grids → card-list).

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Ticket created; requirements/business/implementation review; Direction A design system + `theme.css`; Figma page plan | `README.md`, `theme.css` |
| 2026-06-27 | Figma build Pass 1: Foundations, App Shell — Tenants, and Login built in `HOPE-Admin-Console` from tokens; screenshots captured | `HOPE-Admin-Console` (Figma), `screenshots/*` |
| 2026-06-27 | **Dependency noted (TASK-372 D1):** [TASK-372 — Shared Component System](../TASK-372-Shared-Component-System/README.md) will migrate `@arcaai/ui/styles/globals.css` to this ticket's `theme.css` as the single token source (their build step 0). `theme.css` here remains the canonical token source; coordinate the rollout (breaking visual change for all `@arcaai/ui` consumers). | — (cross-ticket reference) |
| 2026-06-27 | **Figma build Pass 2 — flagship component surfaces.** Added `04 · Users` (`53:308`, `VirtualizedDataGrid`), `07 · Consultation History` (`54:459`, `HistoryTimelineList`), and `08 · Live Session` (`54:560`, `LiveTranscript`) in a new column on `Page 1`, grounded in the **as-built** `apps/admin` screens ([TASK-374](../TASK-374-Admin-App-Integration/README.md)) and reconciled to the shipped **5-pillar** shell (`src/lib/nav.ts`) + simplified topbar. Screenshots captured + reviewed. Pass-1 `02 · App Shell — Tenants` sidebar flagged **stale** vs. the build (reconcile pending — §5.5). | `HOPE-Admin-Console` (Figma), `screenshots/{users-grid,history-timeline,live-session}.png` |
| 2026-06-28 | **Figma build Pass 3 — shared layouts & DataGrid system** (on the `foundation` page). Added `10 · Dashboard Shell` (`58:2`), `11 · Full-Screen Table` (`59:155`), `12 · Blades` (`60:490`), `13 · DataGrid — Anatomy & States` (`60:745`), and `14 · Theming — Tokens & Dark Mode` (`60:886`) — capturing the shared shell (collapsible sidebar + breadcrumb + fixed `ServiceStatusBar`), the full-screen scrollable-table pattern (sticky header + fixed pagination), the master→detail blades pattern, the complete `VirtualizedDataGrid` anatomy/states/density, and a light/dark token legend + dark-theme component proof. All built from `theme.css`; status is dot+label; grid densities match `DENSITY_ROW_HEIGHT` (48/36). Screenshots captured + reviewed (§5.3). Noted the unsaved-file rotation caveat. | `HOPE-Admin-Console` (Figma), `screenshots/foundation-10…14.png`, `README.md` |
| 2026-06-28 | **Figma build Pass 4 — multi-tenancy, impersonation & responsive** (on the `foundation` page). Added `15 · Multi-Tenancy & Impersonation` (`61:985`) — working-tenant switcher (collapsed + popover w/ cross-tenant "All tenants"), cross-tenant topbar + "Acting on: «Tenant»" scoped-mutation banner, NoTenant empty state, audited impersonation confirm dialog, and the app-wide active impersonation banner (indigo "mode" bar w/ Exit) — and `16 · Responsive — Tablet & Mobile` (`62:1082`) — tablet icon-rail + condensed table, mobile app-bar + card-list + FAB, modal nav drawer w/ bottom tenant switcher, and blade drill-down user-detail w/ Impersonate action. Built from `theme.css`; ≥44px touch targets; impersonation uses `--ai` indigo as a non-status "mode" color. Screenshots captured + reviewed (§5.4). | `HOPE-Admin-Console` (Figma), `screenshots/foundation-{15-multitenancy,16-responsive}.png`, `README.md` |
| 2026-06-28 | **Figma build Pass 5 — layer-taxonomy reconciliation.** Renamed the eight `foundation`-page frames into a clean, de-duplicated **00–07** band (fixed two `00` frames + jumbled order) to match the new mandate in `.cursor/rules/12-design-workflow.mdc`: `2:2`→00, `60:886`→01, `60:745`→02, `58:2`→03, `59:155`→04, `60:490`→05, `61:985`→06, `62:1082`→07 (node IDs + visuals unchanged). Updated §4.2 to the role-tier taxonomy, added the §5.5 reconciliation map, and flagged the unsaved-file blocker before the 10–59 product-tier build-out. | `HOPE-Admin-Console` (Figma), `README.md` |
| 2026-06-28 | **Figma build Pass 6 — super-admin tier (10–19) [started].** Opened the 10–19 row at `y=1440` and built the two anchor screens by duplicating + reskinning foundation shells: `10 · Dashboard` (`69:1265`, cross-tenant platform dashboard) and `13 · Tenant Management` (`69:1416`, tenants data grid w/ Active/Suspended/Archived + plan tiers). Captured `admin-10-dashboard.png` + `admin-13-tenant-management.png`. Logged tier follow-ups: sidebar nav must be reorganized to the role-tier taxonomy (active state currently on "Users"), Lucide icon swap, and remaining 10–19 screens (Monitoring, Logs & Audit, Rate Limits, Queues & Jobs, Prisma Studio). | `HOPE-Admin-Console` (Figma), `screenshots/admin-{10-dashboard,13-tenant-management}.png`, `README.md` |
| 2026-06-28 | **Figma build Pass 7 — tier nav reorg + Monitoring & Audit Log.** Reorganized the sidebar to the role-tier taxonomy (`OVERVIEW`/`PLATFORM`/`OPERATIONS`/`IDENTITY & ACCESS`/`API & INTEGRATIONS`; all 7 super-admin destinations present) with per-screen active-highlight positioning, applied to `10` + `13` (now the shell/table **templates**). Built `11 · Monitoring` (`70:1692`, service KPIs + 24h volume + incidents) and `12 · Audit Log` (`70:1843`, Actor/Result/Action/When + 13 event rows w/ colour-correct Success/Warning/Info). Re-shot `admin-10`/`admin-13`, captured `admin-11-monitoring.png` + `admin-12-audit-log.png` (reviewed). Super-admin tier now 4/7. Follow-ups: 14/15/16, propagate nav to foundation shells 03/04, Lucide swap. | `HOPE-Admin-Console` (Figma), `screenshots/admin-{10-dashboard,11-monitoring,12-audit-log,13-tenant-management}.png`, `README.md` |
| 2026-06-28 | **Figma build Pass 8 — UXU realism review & nav-reality fixes.** Ran the `/uxu` loop (review→fix→verify by screenshot) over foundations 02–07 + super-admin tier 10–13. Fixed `13 · Tenants` breadcrumb (`Multi-Tenancy`→`Platform`) and re-grouped the tenant-scoped shells `03`/`04`/`05` from the legacy 5-pillar sidebar to a real **tenant-admin** taxonomy (OVERVIEW/WORKSPACE/ACCESS/PLAYGROUND/SETTINGS) with per-screen active item + teal active-text recoloured (`#0e626e`/`#44535e`) and breadcrumb sections realigned; caught + fixed an active-text-colour regression. Re-shot `foundation-10/11/12` + `admin-13` (all pass). Deferred the Lucide icon swap to implementation (MCP rasters aren't token-driven). | `HOPE-Admin-Console` (Figma), `screenshots/{foundation-10-dashboard-shell,foundation-11-fullscreen-table,foundation-12-blades,admin-13-tenant-management}.png`, `README.md` |
| 2026-06-28 | **Figma build Pass 9 — Dashboard + Monitoring redesign + Columns→View consolidation.** Redesigned `10 · Dashboard` (`69:1265`) — headline KPIs Active tenants/Live sessions/Processing jobs 23/**Degraded services 1 (SMR)**, **removed Recent activity**, full-width chart with **Week/Month/Year + All tenants** controls, **+ secondary KPI row** (Total users 1,847 · Transcription min 14,208 · Summaries 642 · Storage 2.4/5 TB) — and `11 · Monitoring` (`70:1692`) — headline KPIs Requests/min·Error rate·**Sockets/min 86·Total sockets 312**, chart controls + weekday axis, **removed Recent incidents →** a **Services** status table (per-service dot+label · P95 ms · uptime %, SMR Degraded) + a **Models & running tasks** table (whisper-large-v3-turbo, silero-vad-v5, gemma-4-e4b, granite-guardian-4.1-8b, Medical-NER, symps-disease-bert). **Table-pattern fix:** deleted the stray **"Columns"** button on `12 · Audit Log` (`70:1909`/`70:1910`) and relabelled `02 · DataGrid` caption to **"Density · View (columns)"** (`60:779`); audited `13`/`04` (already View-only) — **no table frame has a separate Columns button**. Aligned `ServiceStatusBar` to **"23 processing"** across `11`/`12`/`13`/`04`. Re-shot + reviewed all six frames (PASS). | `HOPE-Admin-Console` (Figma), `screenshots/{admin-10-dashboard,admin-11-monitoring,admin-12-audit-log,admin-13-tenant-management,foundation-11-fullscreen-table,foundation-13-datagrid-anatomy}.png`, `README.md` |
| 2026-06-29 | **Figma build Pass 10 — new foundation interfaces (card-grid · item-list · timeline).** Filled the last two free slots of the **00–09** foundation band: `08 · Card-Grid` (`82:2231`, tenant Departments — auto-fit grid · comfortable/compact density · selected/hover/default/disabled + skeleton/keyboard-focus/empty states · responsive 4→2→1 · a11y strip) and `09 · Lists — Item-List & Timeline` (`84:2382`) with sub-regions `09a · Item-List` (`84:2383`, expandable processing-jobs rows w/ pipeline stepper + dense compact list) and `09b · Timeline` (`84:2384`, scroll-spy HOPE release changelog — sticky active marker · one milestone expanded w/ New bullets + code/media blocks · collapsed Updates/Bug-fixes · compact variant · scroll-spy explainer). **Numbering decision:** consolidated the two list patterns under one frame (`09a`/`09b`) to avoid colliding with the `10–19` super-admin tier. Built from `theme.css`; status dot+label; ≥44px targets; real HOPE data. Screenshots captured + read-by-eye (PASS). | `HOPE-Admin-Console` (Figma), `screenshots/{foundation-card-grid,foundation-item-list,foundation-timeline}.png`, `README.md` |
| 2026-06-29 | **Figma build Pass 11 — tenant-management blades.** Built the full *master-grid → detail-blade → nested-blade* tenant-management flow from `PHASE-2-PLAN.md` §4b: `17 · Add Tenant` (`86:2948`), `18 · Tenant Detail — Overview` (`85:2605`), `20 · Tenant Users` (`87:3320`, nested user blade), `21 · Assign Department` (`88:5734`, **4-level** user→dept picker via `UserDepartment`), `22 · Tenant Configuration` (`87:3732`, Acting-on banner), `34 · Department Management` (`87:4483`, card grid), `35 · Add Users to Department` (`88:5293`, department-side bulk assign), `36 · Agent Instructions` (`87:4872`, `PromptTemplate` `scope=DEPARTMENT_DEFAULT` list + create form), `37 · Tenant Storage` (`87:4102`, `TenantBucket` table + quota). Covers add-tenant/detail/users/config/storage/departments + **user→department assignment (both sides)** + **agent-instruction creation**; states (saving/validation/multi-select+pending/draft/paused/approaching-quota/2–4-level stacks); super-admin vs tenant-admin permission cues. Unbacked **Plan**/**storage-quota**/aggregate-count fields drawn as **TARGET** UI + flagged as backend gaps. Domain grounded in `Tenant.key`/`resourceStatus`/`tags` (no `plan`/`deletedAt`), `PromptTemplate`, `UserDepartment`, `TenantBucket`. Each frame `save_screenshots` (scale 1) + read-by-eye (PASS); `_wip-*` probes cleaned up. | `HOPE-Admin-Console` (Figma), `screenshots/admin-tenant-{add,detail,users,assign-departments,config,departments,add-members,agent-instructions,storage}.png`, `README.md` |
| 2026-06-29 | **Figma build Pass 12 — page-based Tenant Detail (proposal).** Per the request to replace the tenant-management **blades** with a **page**, added two PROPOSAL frames in a fresh `y=4900` row without touching the §5.11 blades: `18p · Tenant Detail — Overview (Page)` (`95:6164`) and `20p · Tenant Detail — Users (Page)` (`97:6529`). Captured the **recommendation** (full page + nested-route tab nav; Add/Edit/Disable + assignment **pickers stay as Dialogs/AlertDialogs**, not nested blades — fixes the 4-level stack at `21`/`35`), a **dev-ready TanStack route map** (`tenants/$tenantId/route.tsx` detail layout + `overview/users/configuration/storage/departments` child routes + `departments/$departmentId`), a **component-reuse map** (`app-shell`/`page-header`/`VirtualizedDataGrid`/`StatusBadge`/08 card-grid/09 list reused; `tenant-detail-sheet.tsx`→layout route + tab pages; `tenant-form-sheet.tsx`→Dialog), the **`useMatches()` breadcrumb model** (`Home > Platform > Tenants > Acme Health` from loader data), and responsive + impersonation continuity notes. Both `save_screenshots` (scale 1, clip) + read-by-eye (**PASS**). **Status: proposal — pending user approval; blade frames retained.** | `HOPE-Admin-Console` (Figma), `screenshots/admin-tenant-page-{overview,users}.png`, `README.md` |
| 2026-06-29 | **Figma build Pass 13 — page-based Tenant Detail build-out + blade removal.** Approved the §5.12 page model and acted on it: **deleted the 9 §5.11 tenant-management blades** (`17`=`86:2948`·`18`=`85:2605`·`20`=`87:3320`·`21`=`88:5734`·`22`=`87:3732`·`34`=`87:4483`·`35`=`88:5293`·`36`=`87:4872`·`37`=`87:4102`; each confirmed by name before delete; foundation `05 · Blades` `60:490` + all non-tenant frames intact). **Finalized** the two proposal pages (dropped `— PROPOSAL`, teal active tab): `18p`(`95:6164`)/`20p`(`97:6529`). **Built 4 new pages** (`y=4900`): `22p · Configuration`(`109:6768`), `37p · Storage`(`110:6976`, quota 92% + `TenantBucket` table + TARGET note), `34p · Departments`(`110:7195`, in-page card-grid · Pediatrics Paused), `36p · Department Detail — Cardiology`(`110:7414`, own Members·Agent-instructions sub-tabs + members grid). **Built 5 dialogs** (`y=6100`, full page + scrim + modal): `Dlg · Add Tenant`(`110:7669`, mono key uniqueness), `Dlg · Assign Departments`(`110:7981`, multi-select + Adding), `Dlg · Add Members`(`110:8201`), `Dlg · New Agent Instruction`(`110:8440`, scope DEPARTMENT_DEFAULT·locked), `Dlg · Disable Tenant`(`110:8662`, AlertDialog). Overlay-vs-page rationale, breadcrumb/tab model, responsive + impersonation, and TARGET-metric flags recorded; every frame `save_screenshots` (scale 1, clip) + read-by-eye looped to PASS. **Status: ✅ built (canonical tenant-management model).** | `HOPE-Admin-Console` (Figma), `screenshots/admin-tenant-page-{overview,users,configuration,storage,departments}.png`, `screenshots/admin-department-detail.png`, `screenshots/admin-dlg-{add-tenant,assign-departments,add-members,new-agent-instruction,disable}.png`, `README.md` |
| 2026-06-29 | **Figma build Pass 14 — tenant dashboard · users management · agent management (3-agent parallel build).** Ran **3 `ui-ux-designer` agents in disjoint Figma Y-bands** (A `[7600,9400]` · B `[9600,13200]` · C `[13400,15800]`, 200px gutters) per `PHASE-3-PLAN.md` §2 — disjoint Y-ranges prevented the earlier duplicate-node conflict. **A · Tenant Dashboard** `18d` (`120:8843`) + loading/empty/error/tenant-admin states — headline KPIs (Active users 142 · Departments 9 · Running sessions 14 · Services healthy 6/7 SMR-degraded) + secondary row (Open sockets 18 **[TARGET]** · Processing jobs 23 · Consultations today 87 = 62 new/25 re-visit · Pending review 11 · Consumption 1.2k **[TARGET]**) + new-vs-revisit chart + audit feed + audio-pipeline strip. **B · Users** `20u` grid (`120:9015`) + bulk-selected/states + `Dlg · Create User` (`120:10354`) + `38u` **7-tab** User Detail (`120:10575`) w/ injectable panels a–g (profile/preferences/agent-instructions/DNA-style/departments/DNA-reports/activity; `38u` expanded 5→7 tabs). **C · Agents** by department `30` (`120:9200`) + editor `31` (`120:9454`) + diff `32` (`120:9567`) + playground `33` (`120:9681`) — 4 default-agent slots (DNA-style = **TARGET**) + instruction library + version diff/rollback + test score 0.92. **TARGET backend gaps consolidated** (§5.14.1: open-sockets, consumption/quota roll-ups, per-model audio metrics; reset-password [both flows], Excel/PDF export, bulk endpoint, admin-edit-other preferences; per-dept DNA-style default slot). Polish follow-ups recorded (§5.14.2: tenant-admin variant inherits `Platform › Tenants` active state; sockets/audio headline placement to confirm). Each frame `save_screenshots` (scale 1) + read-by-eye (PASS). | `HOPE-Admin-Console` (Figma), `screenshots/admin-tenant-dashboard-*`, `admin-users-*`, `admin-agents-*`, `README.md` |
| 2026-06-29 | **Figma build Pass 15 — full-canvas frame re-alignment (§5.15).** Tidied the "meshy" `foundation` page (`0:1`): re-positioned all **46 top-level frames** into a clean **8-row grid** — every row left-aligned at `x=0`, **120px** gutters, **240px** row gaps, numeric/logical order — fixing the out-of-order foundations band (`00,03,04,05,02,01,…`), inconsistent 100–200px gutters, and the **~2,400px empty band** left by the §5.13 blade deletion. **Only `x`/`y` changed** (node IDs, sizes, copy untouched; each move echoed its node name for verification). Final `get_document` → **46 children, all `FRAME`, 0 non-frame, 8 rows, 0 overlaps**; built `screenshots/foundation-board-realigned.png` overview (sharp composite of per-frame exports). Also **deleted 7 orphan text nodes** (6 stale `cap-*` captions + 1 empty `Text`, user-approved); both `p`-proposal and `18d/20u` built generations retained (no dedupe). | `HOPE-Admin-Console` (Figma), `screenshots/foundation-board-realigned.png`, `README.md` |
| 2026-06-29 | **Traceability matrix — Tenant Management (super-admin).** Created [`TRACEABILITY-MATRIX.md`](../../qa/traceability/README.md): a living **use-case → design → backend API → test** map with explicit gap rows (doubles as a backlog). First section = tenant fleet + tenant-detail (overview/users/departments/config/storage/agents/audit) for global/super-admins — **40 use cases** across 8 sub-areas, each with Figma node IDs, exact `/api/v1` routes + `file:line`, and the covering E2E/manual test (or a 🔴/🎯 gap). Backend surface + test coverage gathered by two read-only explore agents and spot-checked against source (`tenant.controller.ts`, `updateTenant.request.ts`, `user.controller.ts`, `main.ts`). Key gaps surfaced: tenant archive-status, tags, user reset-password/export/bulk, prompt `compareVersions`, storage quota, live dashboard metrics; plus a large mutation-side **backend-E2E** test debt. | `TRACEABILITY-MATRIX.md`, `README.md` |
