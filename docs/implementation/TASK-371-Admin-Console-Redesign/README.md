# TASK-371 — HOPE Admin Console Redesign (UX/UI + Design System)

| | |
|---|---|
| **Ticket** | TASK-371 |
| **Type** | Feature / Design |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-28 |
| **Status** | In Progress |
| **Owner** | Design (UX/UI) |
| **Figma file** | `HOPE-Admin-Console` |

> Brand: **Hope** — *"quiet intelligence that helps clinicians care for people."*
> Keywords: Medical Trust · Ambient Listening · AI Intelligence · Compassion & Healing · Hope & Service · India & Christianity.

> **Scope note:** This is a clean redesign. The existing `apps/ui-playground` admin console is **explicitly out of scope** and slated for removal — none of its implementation is treated as a constraint. Requirements are derived from business/requirement docs only.

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

### 5.6 Remaining
- **Persist the file** (save `HOPE-Admin-Console`) so frames stop rotating, then re-create the Pass-1/Pass-2 surfaces alongside the Pass-3/Pass-4 foundation frames in one document.
- Surfaces not yet drawn: `01 · Components` library; `03 · Tenants` detail + create/edit + archive-confirm; Roles & Policies (+ CASL policy builder); API Keys; Departments & Prompts; Audit Log; `05 · System Health`; Settings.
- **Lucide** icon swap (nav/toolbar/grid icons are still placeholder squares/glyphs).
- Per-screen **dark-mode** variants (the token system + a dark component proof now exist in `14 · Theming`; extend to each surface).
- Extend the **responsive** specs (`16 · Responsive`) — which cover the shell, full-screen table and blade patterns — to the remaining surfaces (roles/policy builder, system health, settings).

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
