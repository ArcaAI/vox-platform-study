# TASK-371 — Admin Console Redesign · PHASE 3 PLAN

| | |
|---|---|
| **Ticket** | TASK-371 (Phase 3 planning) |
| **Type** | Planning + design review (design-first; `/uxu` review-first contract) |
| **Created** | 2026-06-29 |
| **Status** | Proposed — awaiting approval |
| **Scope** | Plans only. No feature code, no Figma frame mutations (review screenshots only), no commits. |
| **Figma file** | `HOPE-Admin-Console` (UNSAVED → `fileKey` rotates; `list_files` first. Current: `unsaved-mqxk2xog-e3lmjheb`) |
| **Tokens** | [`theme.css`](./theme.css) (Tailwind v4 `@theme` + shadcn, light/dark) |

> This plan makes it **safe to run three `ui-ux-designer` agents IN PARALLEL** over
> three tenant-scoped admin areas — a **Tenant Dashboard (#1)**, **Users management
> (#2)**, and **Agent management (#3)** — without the duplicate-node conflicts a
> prior parallel run hit. It is the companion to `README.md` §5.11–§5.14 (the
> page-based Tenant Detail model) and `PHASE-2-PLAN.md` (component/foundation
> grounding). Everything below is grounded in the **real** Prisma schema
> (`packages/database`), the `@arcaai/vox` SDK hooks (`packages/agentic-sdk-v2`),
> the application services (`packages/applications`), and a read-by-eye review of
> the live baseline frames.

---

## How this plan was grounded (review + exploration summary)

### Baseline frames reviewed (READ-ONLY — screenshots only, no edits)

Screenshotted and read-by-eye (`save_screenshots` scale 1, clip) the canonical
page-based Tenant Detail set. **These are the visual contract the three new areas
must extend** — same app shell, breadcrumb, tab nav, status bar, permission banner:

| Frame | Node | What it establishes |
|---|---|---|
| `18p · Tenant Detail — Overview (Page)` | `95:6164` | Shell + breadcrumb `Home / Platform / Tenants / Acme Health` + page header (avatar · `Acme Health` · `● Active` · `Edit tenant`/`Disable`/`⋯`) + tab nav (Overview·Users·Configuration·Storage·Departments) + 4 KPI tiles + About + Recent activity + permission banner + fixed `ServiceStatusBar`. **The #1 dashboard upgrades THIS Overview tab.** |
| `20p · Tenant Detail — Users (Page)` | `97:6529` | Members toolbar (`Search` · `142 members · 6 shown` · `+ Add member`) + members table (MEMBER avatar+name+email · ROLE · DEPARTMENTS · STATUS dot+label incl. Invited/Inactive) + `Showing 6 of 142 · Page 1 of 24`. **The #2 users area deepens THIS.** |
| `36p · Department Detail — Cardiology (Page)` | `110:7414` | Department-scoped page · breadcrumb `… / Acme Health / Departments / Cardiology` · own sub-tabs **Members · Agent instructions** · members grid. **The #3 agent management expands the "Agent instructions" sub-tab.** |
| `22p · Configuration` `109:6768` · `37p · Storage` `110:6976` · `34p · Departments` `110:7195` | (skim) | Toggle/select settings pattern; quota + `TenantBucket` table + **TARGET-surface note**; department **card-grid** (reuses `08 · Card-Grid`, Pediatrics `Paused` amber). |

Shell details confirmed by eye (carry verbatim): sidebar groups `OVERVIEW`
(Dashboard) · `PLATFORM` (Tenants[active]·Monitoring·Audit Log) · `OPERATIONS`
(Rate Limits·Queues & Jobs·Prisma Studio) · `IDENTITY & ACCESS` (Users·Roles &
Policies) · `API & INTEGRATIONS` (API Keys); footer working-tenant switcher
**"All tenants · Cross-tenant view"**; fixed bottom bar `● System ● API ● STT ●
SMR degraded ● NLP ● Guardrail ● Harness … 14 active sessions · 23 processing ·
Production · Refresh`; active tab teal `#0e626e`, inactive `#5a6a77`.

### Full canvas occupancy (from `get_design_context` depth 1 — every top-level frame)

| Region | Y range | X range | Frames |
|---|---|---|---|
| Foundation band `00–09` | `0 – 1384` | `0 – 16240` | `00`–`09` (Foundations, Theming, DataGrid, Dashboard Shell, Full-Screen Table, Blades, Multi-Tenancy, Responsive, Card-Grid, Lists) |
| Super-admin tier `10–13` | `1440 – 2464` | `0 – 6060` | `10 · Dashboard` · `11 · Monitoring` · `12 · Audit Log` · `13 · Tenant Management` |
| **EMPTY buffer** | **`2464 – 4900`** | all | *(none — leave untouched)* |
| Page-based Tenant Detail | `4900 – 5924` | `6160 – 15300` | `18p · 20p · 22p · 37p · 34p · 36p` |
| Dialog overlays | `6100 – 7124` | `6160 – 13760` | `Dlg · Add Tenant / Assign Departments / Add Members / New Agent Instruction / Disable Tenant` |
| **EMPTY — free for Phase 3** | **`≥ 7124`** | all | *(target build area below)* |

→ The clean, conflict-free build area is the empty band **below `y = 7124`**. The
three agents get **disjoint horizontal Y-bands** there (see §2). Everything at
`y < 7600` is **DO-NOT-TOUCH** for these agents.

### Schema / SDK reality (the source of every REAL vs TARGET flag in §3)

- **`User` is NOT tenant-scoped** (`user.prisma`): no `tenantId`; membership derives
  from `UserRoleAssignment.tenantId` + `UserDepartment.tenantId`. Name/email/phone
  live on **`UserProfile`** (`firstName/lastName/email/phone/avatarId/preferredPromptTemplateId`),
  not on `User`. `User` has `username` (unique), `isServiceAccount`, `lastLoginAt/lastActiveAt`,
  `resourceStatus` (`ENABLED/DISABLED/ARCHIVED/DELETED`), `tags[]`.
- **`UserSettings`** (`key/value/dataType/namespace`, per-user) backs preferences —
  but the SDK only exposes **`/user/me/settings`** (`useUserSettings.list` +
  `updateByKey(namespace,key,value)`). **Admin-editing another user's settings = gap.**
- **`UserDepartment`** join (`tenantId/userId/departmentId/isPrimary/version`) — REAL,
  via `useUserDepartments` (`list/assign/setPrimary[OCC]/unassign`) or
  `useUsers.assignDepartments({ primaryDepartmentId, departmentIds[] })`.
- **`PromptTemplate`** = "agent instruction" (`prompt-template.prisma`): `scope ∈
  TENANT_DEFAULT | DEPARTMENT_DEFAULT | USER_PERSONAL`, `category ∈ SYSTEM | SUMMARY |
  DNA_ANALYSIS | CUSTOM`, `status ∈ DRAFT | PUBLISHED`, `content` (Text), `variables`
  (JSONB), `departmentId?`, `ownerUserId?`, `currentVersionNumber`, `lastTestScore`/
  `lastTestAt`. **`PromptVersion`** (versionNumber, content, variables, changeReason,
  changedBy) → versioning/diff/rollback REAL.
- **`Department`** wires the default agents via **`preSummaryPromptId` (pre-summary),
  `newPatientPromptId` (new-visit), `revisitPromptId` (re-visit)** + `promptConfig`
  JSON + `defaultSummaryTemplate`. **There is NO `dnaWritingStylePromptId` column →
  the per-department "DNA writing-style default agent" slot is a TARGET** (store in
  `promptConfig` or add a column).
- **DNA writing style** (`dna-writing-style.prisma`): per-doctor
  `DnaWritingStyleReport` (+ `DnaWritingStyleVersion`, content Vault-encrypted),
  `isLatest`, `currentVersionNumber`. REAL via `useDnaStyle`
  (`getByDoctor`/`getVersions`/`getVersionDiff`/`generate`/`setDefault`/`getMyReports`).
- **`AuditLog`** (`audit.prisma`): `responsibleUserId`, `resourceType`, `action`
  (`CREATE/UPDATE/DELETE/ARCHIVE/LOGIN/LOGOUT/IMPERSONATED_ACTION`), `success`,
  `data`/`previousData` (before→after), `correlationId`, `createdAt`. REAL via
  `useAuditLog` — incl. **`byUser(userId)`**, filters (`from/to/action/resourceType/userId`),
  cursor pagination, and **server-side `exportCsv`** (CSV only).
- **`Consultation`** (`consultation.prisma`): `status` (`OPEN/RECORDING/
  DRAFT_PENDING_SENSORS/PENDING_REVIEW/SIGNED/CLOSED/REOPENED`) and
  **`parentConsultationId` (NULL = new/initial visit, NOT NULL = re-visit/follow-up)**
  — this is the real "new-visit vs re-visit" discriminator the #3 default agents map to.
  Tenant-wide reads via `useAdminConsultations` (`list`/`get`, filter by doctor/dept).
- **Live signals:** `useMonitoring().sessions` = `{ activeSessions, processingJobs,
  total }`; `useHealthCheck().services` = per-service `{ status, version, uptime_seconds }`
  for `api/stt/smr/nlp/guardrail/harness`. **No explicit "open sockets" field** (only
  `activeSessions`/`processingJobs`) and **no P95/requests-per-min** — flagged TARGET.

### Old prompt-management UI reviewed (ideas only — NOT to copy; `apps/ui-playground/src/features/admin/prompts/`)

3-pane `MultiColumnLayout` (Prompts 240px → Versions 180px → Detail 1fr): create
dialog (Name·Category·Status·Tags·Description·Content mono·VariableEditor `{{var}}`),
inline version-detail edit form (content + changeReason* → "Save as New Version" +
"Activate this version" rollback), `VersionDiffPanel` (2 versions → side-by-side
content+variables diff), `PromptTestPanel` ("Output Check" → Run → score badge +
metrics breakdown + output `pre`), usage-analytics panel, per-row enable/disable
`Switch`. **Improve on it:** (1) it is **NOT organized by department** and never
surfaces the `Department.preSummary/newPatient/revisit` **default-agent slots** — the
#3 surface must; (2) **hardcoded colours** (`CATEGORY_COLORS` violet/blue/emerald,
`scoreTone` emerald/amber/rose) violate the semantic-token rule → use `theme.css`
tokens; (3) cramped 240/180px columns → full page; (4) test panel is a sidecar →
make a real **playground**.

---

## §1 — Per-area design scope

All frames are **1440×1024** (desktop) unless marked *modal*. Every frame ships the
shared **DESIGN CONTRACT** (§2) and the **required states** (default · empty ·
loading-skeleton · error · selected · permission super-admin vs tenant-admin) and a
**responsive** note (desktop/tablet/mobile). Layer numbers are *suggestions within
the tier band* — confirm on the next persisted save (the file is unsaved; numbers
rotate, per README §5.5).

### #1 — Tenant Dashboard (Agent A) — tier 10–19 entry, tenant-scoped content

Upgrades the **Overview tab** (`18p`) into an **operational tenant dashboard**.
Best practice ref: Vercel/Datadog/Linear operational dashboards — a tight headline
KPI row (is it healthy & busy *now*) + a secondary KPI row (scale/throughput) +
one focal chart + an activity feed + a fixed health bar; numbers are tabular,
deltas are never colour-only, every tile has loading/empty/error.

**Frames to build (suggested `18d` family):**

| Frame | Suggested layer | Content (real domain) |
|---|---|---|
| `18d · Tenant Dashboard (Page)` | `18d` | Same shell/breadcrumb/tabs as `18p`, **Overview tab active**. Headline KPI row (4): **Active users**, **Departments**, **Running sessions**, **Audio-pipeline / services healthy**. Secondary KPI row (4): **Open sockets**, **Processing jobs**, **Consultations today (new vs re-visit split)**, **Pending review (unsigned notes)**. Focal chart: **Consultation sessions · per day** (Week/Month/Year segmented + All-tenants filter, reuse `MetricChart`). **Recent activity** card (audit feed: `Configuration updated · STT model`, `3 members added to Cardiology`, `Agent instruction published` …, actor + relative time). **Audio-pipeline status** strip (STT·VAD·SMR·Guardrail dots + active streams). Permission banner. Fixed `ServiceStatusBar`. |
| `18d · states` | — | **loading** (skeleton KPI tiles + chart block + activity rows), **empty** (new tenant: "No activity yet"), **error** (tile/chart `errorState` + retry), **tenant-admin variant** (own-tenant scope; no cross-tenant All-tenants filter). |

Suggested additional metrics (all grounded — see §3): **Summary quality avg**
(`SummaryMeta.qualityScore`), **Agent instructions (count + drafts)**
(`PromptTemplate`), **New vs revisit ratio** (`Consultation.parentConsultationId`),
**Storage used/quota** (TARGET). Reuse `08 · Card-Grid`-adjacent KPI tiles + the
`#3 metrics` primitives (`StatCard`/`MetricChart`/`StatusDot`/`RunningTasksList`)
from `PHASE-2-PLAN`.

### #2 — Users management (Agent B) — tier 20–29 + user-scoped detail

Best practice ref: Okta / WorkOS / Google Admin / Stripe people-tables —
server-driven datagrid with faceted filters, row-select → bulk action bar,
export menu, and a **dedicated user-detail route** (not a cramped dialog) with
left-nav sub-sections; transient create/assign actions are **dialogs**.

**Frames to build (suggested `20u` / `38u` families):**

| Frame | Suggested layer | Content (real domain) |
|---|---|---|
| `20u · Tenant Users — Data Grid (Page)` | `20u` | Deepens `20p`: `VirtualizedDataGrid` (avatar·name·email · role badges · departments · dot+label status incl. **Invited**/**Inactive**), faceted filters (`+ Status`, `+ Role`, `+ Department`, `+ Type` service/user), search, **View** (column show/hide — never a standalone "Columns" button, per §5.9), server pagination footer. Toolbar actions: **`+ Add user`** (primary), **Export ▾** (CSV/Excel/PDF), row kebab (**Reset password**, **Quick-disable**, View). |
| `20u · bulk-selected` | — | Header checkbox + per-row checkboxes → **bulk action bar** ("12 selected · Disable · Assign department · Export · Clear"). |
| `38u · User Detail (Page)` | `38u` | User-scoped page, breadcrumb `… / Acme Health / Users / Dr. Anaya Rao`. Header (avatar · name · role chip · `● Active` · `Edit`/`Reset password`/`⋯`). **Left sub-nav / tabs**: Profile · Preferences · Agent Instructions · DNA Style · Departments · DNA Reports · Activity. |
| `38u-a · Profile & Details` *(injectable panel)* | — | `UserProfile` fields (first/last name, email, phone, avatar), `username` (mono), `isServiceAccount`, `resourceStatus`, role assignments, last login/active. Edit form (RHF). |
| `38u-b · Preferences & Settings` *(injectable)* | — | `UserSettings` grouped by **namespace** (key/value/dataType), toggles/selects. (Self = REAL; admin-for-other = TARGET — see §3.) |
| `38u-c · Personalized Agent Instructions (by dept)` *(injectable)* | — | The user's `PromptTemplate scope=USER_PERSONAL` rows **grouped by assigned department** (Cardiology / Neurology …), each with category + version + Draft/Published; open editor (reuses #3 editor). |
| `38u-d · DNA Writing-Style Instructions` *(injectable)* | — | The user's DNA-analysis instruction(s) (`PromptTemplate category=DNA_ANALYSIS`, USER_PERSONAL) + link to generated style. |
| `38u-e · Department Assignment` *(injectable)* | — | `UserDepartment` list (chips, **primary** star), add/remove → opens **Assign Departments dialog** (multi-select; reuses existing `Dlg · Assign Departments` pattern). |
| `38u-f · DNA Reports & Versions` *(injectable)* | — | `DnaWritingStyleReport` for this doctor + version timeline (`getVersions`/`getVersionDiff` side-by-side), `isLatest`/default badge, **Generate** (job + progress), set-default. |
| `38u-g · Activity History` *(injectable)* | — | `useAuditLog.byUser(userId)` feed (actor self · action · resource · before→after · time), filters, **Export CSV**. |
| `Dlg · Create User` *(modal, 1440×1024 w/ scrim)* | — | Username · email · temp password · service-account toggle · initial department(s) · role. Inline validation; saving state. |

States: each grid/page carries loading-skeleton / empty / error; user-detail tabs
each have empty (e.g. "No personalized instructions yet"). Permission: tenant-admin
sees same components scoped to own tenant; super-admin gets the Acting-on banner.

### #3 — Agent management by department (Agent C) — tier 30–49

Replaces "prompt management" with a **gold-standard, department-organized agent
surface**. Best practice ref: OpenAI Playground / LangSmith / Humanloop / PromptLayer
— a library + a first-class **editor**, **version diff**, and **test playground**,
with explicit "which prompt is the live default for slot X".

**Frames to build (suggested `30–33` family):**

| Frame | Suggested layer | Content (real domain) |
|---|---|---|
| `30 · Agent Management — by Department (Page)` | `30` | Breadcrumb `… / Acme Health / Departments / Cardiology / Agent instructions` (department-scoped; deep-linked from `36p` sub-tab). **Department selector** (rail or breadcrumb switch). **Default-agent slots** card row (4): **Pre-summary** (`preSummaryPromptId`), **New-visit summary** (`newPatientPromptId`), **Re-visit summary** (`revisitPromptId`), **DNA writing-style** *(TARGET slot)* — each shows the wired `PromptTemplate` name · version · Draft/Published · "Change". **Instruction library** list (all department `PromptTemplate`s: name · category · v# · status · last test score). |
| `31 · Agent Instruction Editor` | `31` | Full-height **text editor** (mono `content`, `{{variable}}` chips, `VariableEditor`), metadata (name · category · scope `DEPARTMENT_DEFAULT · locked` · status DRAFT/PUBLISHED · tags), **changeReason\*** → "Save as new version"; version list rail w/ **Activate (rollback)**. |
| `32 · Version Diff` | `32` | Side-by-side two-version diff (content + variables), additions/removals via tokens (`--success`/`--destructive` text, never raw green/red), version headers (v#, date, changedBy, changeReason). |
| `33 · Test Playground` | `33` | Variable inputs → **Run** → **quality-proxy score** badge (token-toned, honest "proxy" framing) + metrics breakdown (length/JSON/variable-coverage) + generated output `pre`; "last run" persistence (`lastTestScore`/`lastTestAt`). |
| `30 · states` + reuse `Dlg · New Agent Instruction` (`110:8440`) | — | loading (skeleton slots + list), empty ("No instructions for Cardiology"), error+retry, selected. Duplicate the existing `Dlg · New Agent Instruction` **read-only** as the create-modal reference. |

States/permission/responsive as contract. Slots use dot+label status; the **DNA
slot is drawn with a small TARGET tag** (no backing column yet).

---

## §2 — Parallel-execution strategy (the core of this plan)

**Exactly three sibling `ui-ux-designer` agents**, each confined to a **disjoint
horizontal Y-band** in the empty area below `y = 7124`. **Disjoint Y-ranges
guarantee no two agents ever touch the same canvas coordinates or node** — which is
exactly what caused the prior duplicate-node conflict. 200 px gutters separate the
bands; nothing may be placed in a gutter.

### Region allocation (verified free against the §"canvas occupancy" table)

| Agent | Area | **Canvas region (hard bounds)** | Frame layout within band |
|---|---|---|---|
| **A** | #1 Tenant Dashboard | **`y ∈ [7600, 9400]`**, `x ≥ 0` | Captions at `y≈7640`; frames row at `y≈7720` (1024 tall). Pitch **x = 0, 1540, 3080, …** |
| *(gutter)* | — | `y ∈ [9400, 9600]` — **no nodes** | — |
| **B** | #2 Users management | **`y ∈ [9600, 13200]`**, `x ≥ 0` (tallest — most frames) | Row 1 `y≈9720`; Row 2 `y≈11040`; Row 3 `y≈12360`. Pitch x = 0, 1540, 3080, … |
| *(gutter)* | — | `y ∈ [13200, 13400]` — **no nodes** | — |
| **C** | #3 Agent management | **`y ∈ [13400, 15800]`**, `x ≥ 0` | Row 1 `y≈13520`; Row 2 `y≈14840`. Pitch x = 0, 1540, 3080, … |

(Bands are generous: A ≈ 1 frame-row, B ≈ 3 rows, C ≈ 2 rows, each with caption +
modal-overlay headroom. If an agent needs more width it grows **rightward (+x)
only**, never beyond its `y` band.)

### Owned-frame lists

- **Agent A owns:** `18d · Tenant Dashboard` + its state variants (loading/empty/
  error/tenant-admin). All within `y ∈ [7600, 9400]`.
- **Agent B owns:** `20u · Users Data Grid` (+ bulk-selected), `38u · User Detail`,
  injectable panels `38u-a … 38u-g`, `Dlg · Create User`, and grid/detail state
  variants. All within `y ∈ [9600, 13200]`.
- **Agent C owns:** `30 · Agent Management`, `31 · Editor`, `32 · Version Diff`,
  `33 · Test Playground`, the create-modal reference, and state variants. All within
  `y ∈ [13400, 15800]`.

### Hard rule (every agent, non-negotiable)

1. **Create/edit ONLY frames inside your own Y-band.** Never place, move, or resize a
   node outside `[y_min, y_max]`; never put a node in a gutter.
2. **Duplicate shared templates READ-ONLY into your region.** Build your shell by
   `duplicate_nodes` from a KEEP page **into your band**, then reskin the copy. Never
   edit the original. Recommended source per agent:
   - A → duplicate `18p · Overview` (`95:6164`)
   - B → duplicate `20p · Users` (`97:6529`); for user-detail, also `36p` (`110:7414`) as a sub-tab-shell reference
   - C → duplicate `36p · Department Detail` (`110:7414`) (has Members·Agent-instructions sub-tabs)
3. **Never edit another agent's frames, any existing frame at `y < 7600`, or any
   shared original.** All frames `00–13`, `18p/20p/22p/34p/36p/37p`, every `Dlg · *`,
   and the `y ∈ [2464, 4900]` buffer are **DO-NOT-TOUCH**.
4. **`list_files` first** every session (rotating `fileKey`); pass `fileKey` on every
   call. On a transient `getaddrinfo ENOTFOUND … cursor.sh`, just retry — edits persist.
5. **Verify before delete.** These agents should not need to delete anything; if a
   probe frame is created, `get_node` to confirm its name/id before `delete_nodes`.

### DESIGN CONTRACT (all three must match — so the outputs read as one product)

- **App shell**: 264 px sidebar (HOPE logo · "Admin Console" · collapse; groups
  `OVERVIEW`/`PLATFORM`/`OPERATIONS`/`IDENTITY & ACCESS`/`API & INTEGRATIONS`) with
  **`Tenants` active** (all three areas are Tenant-Detail sub-pages); working-tenant
  switcher footer **"All tenants · Cross-tenant view"**. Topbar: breadcrumb + global
  search (⌘K) + avatar.
- **Breadcrumb**: `Home > Platform > Tenants > Acme Health > …` (active section shown
  by the in-page tab, not appended). #2 detail: `… > Acme Health > Users > Dr. Anaya
  Rao`. #3: `… > Acme Health > Departments > Cardiology > Agent instructions`.
- **Tab nav**: active = teal underline + `#0e626e` text; inactive `#5a6a77`.
- **Tokens**: `theme.css` semantic tokens ONLY — no hardcoded colours/spacing (do not
  copy the old UI's violet/blue/emerald/rose). Status is **dot + label** (Active green
  · Invited amber · Inactive grey · degraded amber · Draft amber · Published green ·
  Paused amber).
- **Numerals/IDs**: `tabular-nums` for all counts/metrics/timestamps; `font-mono` for
  IDs, keys, correlationIds, tenant/user UUIDs, scope literals.
- **Targets/a11y**: ≥44 px touch targets, visible focus rings, WCAG 2.2 AA; status
  never colour-only.
- **Fixed `ServiceStatusBar`** at the bottom of every page frame (System·API·STT·SMR
  degraded·NLP·Guardrail·Harness … 14 active sessions · 23 processing · Production ·
  Refresh).
- **Permission banner** (muted bg, left teal accent) at page bottom: super-admin
  Acting-on copy + the read-write / tenant-admin / System-tenant-protected explanation
  (mirror the baseline wording).
- **Multi-tenancy / impersonation continuity**: super-admin reaches these cross-tenant
  via Platform → Tenants → Acme Health (full control); a tenant-admin sees the same
  components scoped to their own tenant; mutations carry the "Acting on: «Tenant»"
  intent; the System tenant (`__GLOBAL__`) is protected.
- **Responsive**: desktop horizontal tabs → tablet scrollable/segmented → mobile
  `Select`; header actions collapse to `⋯`; grids degrade to the `07 · Responsive`
  card-list.
- **Real domain data** (no placeholders): tenant **Acme Health**; clinicians **Dr.
  Anaya Rao, Dr. Amara Okafor, Dr. Marcus Chen, Priya Nair, Dr. Sofia Reyes, Liam
  O'Brien**; departments **Cardiology/Neurology/Pulmonology/Endocrinology/Oncology/
  Pediatrics**; services/models **whisper-large-v3-turbo, silero-vad-v5, gemma-4-e4b,
  granite-guardian-4.1-8b, Medical-NER**; agent instructions like **"Cardiology Intake
  Summary · SMR · v4"**.

---

## §3 — Data-reality table (REAL vs TARGET)

> Same convention as prior passes: TARGET fields are drawn **realistically** (never as
> placeholders) and flagged. "REAL" = a Prisma column + an SDK hook/service backs it today.

### #1 Tenant Dashboard KPIs / sections

| Metric / section | Status | Backing |
|---|---|---|
| Active users (count) | **REAL** | `useUsers.listPaginated` total, filter `resourceStatus:ENABLED` (tenant-scoped) |
| Departments (count) | **REAL** | `useDepartments.list` length |
| Running consultation sessions (live) | **REAL** | `useMonitoring().sessions.activeSessions`; cross-check `useAdminConsultations.list` status `OPEN/RECORDING` |
| **Number of open sockets** | **TARGET** | `SessionCounts` has only `activeSessions`/`processingJobs` (+ index passthrough) — no socket field; approximate as activeSessions or add a metrics field |
| Audio-pipeline status | **REAL (partial)** | `useHealthCheck().services.stt` (+ smr/nlp/guardrail/harness) health; **per-model running counts = TARGET** (no metrics endpoint) |
| Recent activities (audit) | **REAL** | `useAuditLog.list({ limit })` tenant-scoped; before→after via `data`/`previousData` |
| Processing jobs | **REAL** | `useMonitoring().sessions.processingJobs` |
| Consultations today · new vs re-visit | **REAL** | `useAdminConsultations` + `Consultation.parentConsultationId` (NULL=new, set=revisit) |
| Pending review / unsigned notes | **REAL** | `Consultation.status = PENDING_REVIEW / DRAFT_PENDING_SENSORS` |
| Agent instructions (count + drafts) | **REAL** | `usePrompts.list` (`PromptTemplate`, `status`) |
| Summary quality avg | **REAL (per-row) / TARGET (aggregate)** | `SummaryMeta.qualityScore` exists per row; no avg endpoint |
| Consumption (summaries/24h, transcription-min) | **TARGET (aggregate)** | derivable from `SummaryMeta.inputTokens/outputTokens/processingTimeMs` + `AudioRecording.duration`, but no roll-up endpoint |
| Storage used / quota | **TARGET** | no quota column on `TenantBucket` (per §5.11/§5.13) |
| Services healthy (6/7, SMR degraded) | **REAL** | `useHealthCheck` |

### #2 User-detail fields / features

| Field / feature | Status | Backing |
|---|---|---|
| Users datagrid (search/filter/sort/paginate) | **REAL** | `useUsers.listPaginated` (CSV `search/filters/sort/searchFields`) |
| Create user | **REAL** | `useUsers.create` (username/email/password/externalId/isServiceAccount) |
| Quick-disable | **REAL** | `useUsers.disable` (`resourceStatus=DISABLED`) |
| **Reset password** | **TARGET** | no reset method (`UpdateUserInput` has no `password`); needs a reset endpoint |
| **Export CSV / Excel / PDF** | **TARGET** | no `/admin/users/export`; client-side CSV from page possible; Excel/PDF need lib/backend (audit log *does* have server CSV `useAuditLog.exportCsv` as a pattern) |
| **Bulk actions (select many)** | **TARGET (UI real / backend loop)** | no bulk endpoint; client loops `disable`/`assignDepartments` |
| Update profile (name/phone/avatar) | **REAL (model) / partial (SDK)** | `UserProfile` columns exist; `useUsers.update` exposes username/email/externalId/status only → profile-field edit endpoint partial |
| Preferences / settings | **REAL (self) / TARGET (admin-other)** | `useUserSettings` is `/user/me/*` only; namespaces real; admin-editing another user = gap |
| Personalized agent instructions (by dept) | **REAL** | `PromptTemplate scope=USER_PERSONAL`, `ownerUserId`, `departmentId`; `usePrompts` |
| DNA writing-style instructions | **REAL** | `PromptTemplate category=DNA_ANALYSIS` (USER_PERSONAL) |
| Department assignment | **REAL** | `useUserDepartments` (list/assign/setPrimary[OCC]/unassign) or `useUsers.assignDepartments` |
| DNA reports + versions (+ diff) | **REAL** | `useDnaStyle.getByDoctor/getVersions/getVersionDiff/generate/setDefault` (content Vault-encrypted) |
| Activity history (per user) | **REAL** | `useAuditLog.byUser(userId)`; server CSV export REAL |
| Role badges | **REAL** | `UserRoleAssignment` (`useRoles`) |

### #3 Agent-management features

| Feature | Status | Backing |
|---|---|---|
| Agent (PromptTemplate) list by department | **REAL** | `usePrompts.list({ departmentId })`, `scope=DEPARTMENT_DEFAULT` |
| Default slots: pre-summary / new-visit / re-visit | **REAL** | `Department.preSummaryPromptId / newPatientPromptId / revisitPromptId`; `usePrompts.assignToDepartment` / `useDepartments.updatePromptConfig` (OCC) |
| **Default slot: DNA writing-style (per dept)** | **TARGET** | no `dnaWritingStylePromptId` column on `Department`; store in `promptConfig` or add column |
| Versions | **REAL** | `PromptVersion`; `usePrompts.getVersions` |
| Diff view | **REAL** | `usePrompts.compareVersions` → `DiffResult` (`computePromptDiff`) |
| Editor (create/update, variables, changeReason) | **REAL** | `usePrompts.create/update`; `content`/`variables`; new version on edit |
| Rollback (activate version) | **REAL** | `usePrompts.activateVersion` |
| Test playground (score + output) | **REAL** | `usePrompts.test` → `{ score, output, testedAt, metrics }` (SMR-scored; honest "quality proxy") |
| Draft / Publish | **REAL** | `PromptTemplate.status` |
| Usage analytics | **REAL** | `usePrompts.analytics`; `PromptUsageRecord` |

---

## §4 — Verification & screenshot naming

Each agent runs the **`/uxu` read-by-eye loop per frame** (`save_screenshots` scale 1,
clip → `Read(png)` → judge against the Realism Checklist → fix in Figma → re-shoot;
delete the stale PNG before re-shooting). A frame is done only when it has **no
placeholders, real domain data + plausible volume, correct dot+label status, the
default/empty/loading/error/selected + permission states the use case implies, token-built,
≥44 px targets, and active nav + breadcrumb = the current screen.**

Save review screenshots under the repo `screenshots/` folder (the MCP server is
sandboxed to `/Users/taphuynh`, so use repo-relative or home-relative absolute paths
that resolve inside it). **Naming conventions (one namespace per agent — prevents
filename collisions too):**

| Agent | Prefix | Examples |
|---|---|---|
| A · Dashboard | `admin-tenant-dashboard-*` | `admin-tenant-dashboard-overview.png`, `-loading.png`, `-empty.png`, `-error.png`, `-tenantadmin.png` |
| B · Users | `admin-users-*` | `admin-users-grid.png`, `-grid-bulk.png`, `-detail-profile.png`, `-detail-preferences.png`, `-detail-agent-instructions.png`, `-detail-dna-style.png`, `-detail-departments.png`, `-detail-dna-reports.png`, `-detail-activity.png`, `-create-modal.png` |
| C · Agents | `admin-agents-*` | `admin-agents-management.png`, `-editor.png`, `-diff.png`, `-playground.png`, `-new-modal.png` |

On completion each agent appends a **README §5.x pass entry** (date · frames · node
IDs · TARGET flags · verification) in the README's Change History style — mirroring
§5.11–§5.13. (One writer per band; README edits are additive log entries.)

---

## §5 — Ready-to-spawn scopes (coordinator pastes these into Task prompts)

> Shared preamble for all three (include verbatim): *"You are a `ui-ux-designer`
> agent on TASK-371. Follow the `/uxu` review→fix→verify loop in Figma
> `HOPE-Admin-Console` (run `list_files` first; the fileKey rotates, currently
> `unsaved-mqxk2xog-e3lmjheb`). Build ONLY inside your assigned Y-band; duplicate the
> named shell template READ-ONLY into your band and reskin the copy; NEVER edit any
> frame outside your band, any shared original, or anything at `y < 7600`. Honor the
> DESIGN CONTRACT (sidebar `Tenants` active · breadcrumb `Home > Platform > Tenants >
> Acme Health > …` · theme.css tokens only · dot+label status · tabular numerals ·
> ≥44px · fixed ServiceStatusBar · permission banner · responsive · real Acme Health
> data). Draw TARGET fields realistically and flag them. Verify each frame by eye and
> save screenshots with your prefix. Plan: `PHASE-3-PLAN.md`."*

**Agent A — Tenant Dashboard (#1)**
- **Region:** `y ∈ [7600, 9400]`, `x ≥ 0` (frames at x = 0, 1540, …). Duplicate shell from `18p · Overview` (`95:6164`).
- **Frames:** `18d · Tenant Dashboard (Page)` + state variants (loading/empty/error/tenant-admin).
- **Content/states:** headline KPIs (Active users · Departments · Running sessions · Services-healthy/audio-pipeline) + secondary KPIs (Open sockets[TARGET] · Processing jobs · Consultations today new/re-visit · Pending review) + consultation-sessions chart (Week/Month/Year + All-tenants) + recent-activity audit feed + audio-pipeline strip; loading-skeleton/empty/error/selected + super-admin vs tenant-admin. Screenshots `admin-tenant-dashboard-*`.

**Agent B — Users management (#2)**
- **Region:** `y ∈ [9600, 13200]`, `x ≥ 0` (3 rows; pitch 1540). Duplicate shell from `20p · Users` (`97:6529`); user-detail sub-tab shell from `36p` (`110:7414`).
- **Frames:** `20u · Users Data Grid` (+ bulk-selected), `38u · User Detail`, injectable panels `38u-a Profile · 38u-b Preferences · 38u-c Personalized Agent Instructions(by dept) · 38u-d DNA-Style Instructions · 38u-e Department Assignment · 38u-f DNA Reports & Versions · 38u-g Activity History`, `Dlg · Create User` (modal).
- **Content/states:** datagrid (faceted filters · search · View column-toggle · server pagination), toolbar `+ Add user` / `Export ▾ (CSV/Excel/PDF — TARGET)` / row kebab (Reset password[TARGET] · Quick-disable · View), bulk action bar; user-detail tabs grounded per §3 (Reset-password/Export/bulk/admin-other-preferences/DNA-dept-default = TARGET, flag them); loading/empty/error/selected + permission. Screenshots `admin-users-*`.

**Agent C — Agent management (#3)**
- **Region:** `y ∈ [13400, 15800]`, `x ≥ 0` (2 rows; pitch 1540). Duplicate shell from `36p · Department Detail` (`110:7414`); reference `Dlg · New Agent Instruction` (`110:8440`) read-only.
- **Frames:** `30 · Agent Management — by Department`, `31 · Instruction Editor`, `32 · Version Diff`, `33 · Test Playground` + state variants.
- **Content/states:** department selector + 4 default-agent slots (Pre-summary · New-visit · Re-visit = REAL; **DNA writing-style = TARGET slot**, flag) + instruction library (PromptTemplate: name·category·v#·Draft/Published·last score); editor (mono content · `{{variables}}` · changeReason* · save-new-version · activate/rollback); side-by-side version diff (token-toned add/remove); playground (variable inputs → Run → quality-proxy score + metrics + output). Improve on the old UI (department-organized, semantic tokens, full-page editor, real playground). Screenshots `admin-agents-*`.

---

## Assumptions

1. The page-based Tenant Detail model (README §5.12–§5.13) is canonical; all three
   areas are **Tenant-Detail sub-surfaces** (sidebar `Tenants` active, shared breadcrumb).
2. "Agent instruction" is a **UI label** over `PromptTemplate` (+ `Department`
   prompt-config) — no new backend model; the per-department **DNA-style default slot**
   is the one new wiring needed (TARGET).
3. The `#3 metrics` primitives + `08/09` foundations from `PHASE-2-PLAN` are reusable
   for #1's KPIs/chart/feed and #2/#3's lists.
4. The three agents run as **siblings with disjoint Y-bands**; the coordinator does not
   let any agent edit outside its band or touch shared originals.
5. TARGET fields (open sockets, reset-password, Excel/PDF export, bulk endpoint,
   admin-edit-other-preferences, consumption/quota roll-ups, per-dept DNA default) are
   drawn realistically and flagged for backend follow-up — not blockers for the design.
6. The file stays UNSAVED (fileKey rotates); layer numbers are suggestions confirmed on
   the next persisted save.

## Open questions (for confirmation before/while spawning)

- **Q1 (frame numbering).** OK to use `18d` (dashboard supersedes the `18p` Overview
  tab), `20u`/`38u` (users + user-detail), `30–33` (agents)? Or fold #1 back into a
  single Overview tab rather than a `18d` sibling?
- **Q2 (#3 scope).** Department-scoped page (under `Departments > Cardiology > Agent
  instructions`, recommended) vs a tenant-level "Agents" page with a department
  selector? Plan designs the department-scoped model with an in-page department switch.
- **Q3 (DNA per-department default).** Confirm we draw the 4th default-agent slot (DNA
  writing-style) as **TARGET** (no `Department` column today) — store in `promptConfig`
  or add a column later.
- **Q4 (export formats).** Server backs **CSV** for audit only. Draw Users **Export ▾**
  with CSV (near-term, client/page) + Excel/PDF (TARGET), or CSV-only for now?
- **Q5 (reset password).** Draw the **Reset password** action as TARGET (needs a backend
  endpoint) — confirm the intended flow (email reset link vs admin-set temp password).
- **Q6 (band sizing).** Agent B has the most frames (3-row band). If it needs more, it
  grows **rightward within `[9600, 13200]`**; confirm that's acceptable vs. widening the band.
