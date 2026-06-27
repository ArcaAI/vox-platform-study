# TASK-371 — HOPE Admin Console Redesign (UX/UI + Design System)

| | |
|---|---|
| **Ticket** | TASK-371 |
| **Type** | Feature / Design |
| **Created** | 2026-06-27 |
| **Updated** | 2026-06-27 |
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
| Figma initial design | `HOPE-Admin-Console` | In progress — 3 of 7 surfaces (Foundations, Tenants, Login) |
| Figma screenshots | [`screenshots/`](./screenshots/) | foundations, tenants-hero, login |

### 4.2 Figma page structure

| Page | Contents |
|---|---|
| 00 · Foundations | Color tokens (light/dark), type specimen, spacing, radius, elevation, iconography |
| 01 · Components | Buttons, inputs, table, badges (service/role status), tabs, dialog, sidebar/header, tenant switcher, empty states |
| 02 · App Shell | Sidebar + header + breadcrumb + connection badge + impersonation banner + working-tenant switcher |
| 03 · Tenants | List (search/filter/pagination), detail, create/edit, archive-confirm, monitor, protected-system-tenant |
| 04 · Users & Access | User list (role badges), user detail + role assignment, create user, roles & CASL policy builder |
| 05 · System Health | Service status grid, uptime, sessions/jobs, consultation-status dashboard |
| 06 · Login | JWT + API-key tabs, brand hero |

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

### 5.2 Remaining (Pass 2)
01 · Components library, 03 · Tenant detail + create/edit + archive-confirm, 04 · Users & Access (+ roles/CASL policy builder), 05 · System Health dashboard. Then dark-mode variants and Lucide icon swap.

---

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-27 | Ticket created; requirements/business/implementation review; Direction A design system + `theme.css`; Figma page plan | `README.md`, `theme.css` |
| 2026-06-27 | Figma build Pass 1: Foundations, App Shell — Tenants, and Login built in `HOPE-Admin-Console` from tokens; screenshots captured | `HOPE-Admin-Console` (Figma), `screenshots/*` |
| 2026-06-27 | **Dependency noted (TASK-372 D1):** [TASK-372 — Shared Component System](../TASK-372-Shared-Component-System/README.md) will migrate `@arcaai/ui/styles/globals.css` to this ticket's `theme.css` as the single token source (their build step 0). `theme.css` here remains the canonical token source; coordinate the rollout (breaking visual change for all `@arcaai/ui` consumers). | — (cross-ticket reference) |
