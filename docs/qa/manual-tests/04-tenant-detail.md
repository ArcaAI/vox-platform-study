> _Relocated from `docs/implementation/TASK-379-Tenant-Detail-Pages/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-379 — Manual E2E (Page-based Tenant Detail + App-Shell)

> Read [`docs/qa/manual-tests/README.md`](./README.md) first for environment prerequisites (§4),
> personas/accounts (§5), cross-cutting principles X1–X8 (§6), the status legend (§3.3), and the defect template (§8).
>
> **This is an Area-A addendum** scoped to the surfaces TASK-379 shipped: the page-based **Tenant Detail**
> (Overview · Users · Configuration · Storage · Departments) and the **app-shell upgrades** (role-tiered nav,
> working-tenant switcher, "Acting on" banner, NoTenant state, breadcrumb). It is the persona-driven companion to
> the automated specs (`apps/admin/e2e/task-379-tenant-detail.spec.ts`, `apps/api/tests/e2e/task-379-tenant-detail.spec.ts`)
> and to [DESIGN-SPEC.md](../../designs/admin/tenant-detail.md) / [TRACEABILITY-MATRIX.md](../traceability/tenant-detail.md).
>
> **Primary persona:** `super_admin` (Global Admin) unless a case states otherwise.
> **Cross-reference:** [`01-multi-tenancy-management.md`](./01-multi-tenancy-management.md) — TASK-379 **closes/advances** several gaps from that suite's 2026-06-27 run (see "What changed" below).

**Suite index:** TD-01 List→Detail Nav · TD-02 Detail Tabs · TD-03 Edit Tenant · TD-04 Enable/Disable · TD-05 Configuration · TD-06 Storage · TD-07 Departments · TD-08 App-Shell (switcher / banner / NoTenant / responsive)

**Last executed:** — (authored 2026-06-30; run pending a seeded stack) | **Environment:** `http://localhost:5175` (admin)

---

## What changed since the 2026-06-27 Area A run

TASK-379 is the page-based redesign of the tenant surface. Re-test these `MT-xx` items — they should now flip:

| Prior `MT-xx` finding (2026-06-27) | TASK-379 outcome | Re-test here |
|---|---|---|
| **MT-03** "No edit/update functionality … detail is read-only" | Edit-tenant **dialog** shipped (name/description; key immutable; OCC) | **TD-03** |
| **MT-06** "Configurations nav disabled … surface not implemented" | Configuration **page** shipped (feature flags + ASR pipeline; OCC; system-tenant lock) | **TD-05** |
| **GAP-ADM-001 / MT-07.2** "No 'select a tenant' prompt … shows all 27 users" | **NoTenant** empty state on top-level Users/Departments | **TD-08.3** |
| **MT-01.4** "No search/filter in tenant list" | `ResponsiveDataGrid` — search + faceted filter + sort + column ops | **TD-01.4** |
| **DEF-ADM-002 / MT-04.5** "System tenant Delete not disabled" | Detail page **gates by `canModifyTenant`** — system tenant shows "protected", no Disable | **TD-04.4** |
| **MT-01.3** "Open tenant detail (modal/blade)" | Detail is now a **page** with 5 tabs + breadcrumb | **TD-01 / TD-02** |

> **Update 2026-07-01 — most former TARGETs now LANDED (re-test, do not mark NA):**
> - tenant **tags** + **plan** — **LANDED** ([TASK-387](../../implementation/TASK-387-Tenant-Data-Model-Backlog/README.md); plan feeds entitlements, [TASK-392](../../implementation/TASK-392-Plan-Entitlements/README.md), **enforcement OFF by default**) → **TD-03.8**
> - **SUSPENDED / ARCHIVED + restore** archive lifecycle — **LANDED** (TASK-387) → **TD-04.7**
> - storage **quota** (`quotaBytes`) + **usage roll-ups** on Overview — **LANDED** ([TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md)) → **TD-06.2**; object-count/size may still be em-dash pending object stats
> - department **member counts** — now backable via `GET /admin/departments/:id/users` (TASK-387) → **TD-07.7**
>
> **Genuinely still TARGET (draw/flag only — do NOT fail):** storage **object-count / per-object size** and any bucket **rotate/manage** actions. Mark only these `NA` with a "TARGET" note.

---

## TD-01 — Fleet list → page-based tenant detail

**Requirement.** An admin browses all tenants and opens a tenant's detail surface; the list supports search/filter/sort. *(US 63, 94; supersedes MT-01.3/.4.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN`, `DOCTOR` (RBAC/isolation).

**Prerequisites** — E1–E4 met; signed in as `super_admin`; ≥2 tenants (`Global`, `ArcaAI`; add `QA_TENANT_A` via MT-02 for richer checks).

**Dependencies** — none (entry point). Feeds TD-02..TD-07.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-01.1 | Fleet renders | 1) Open **Platform → Tenants** | Tenant grid renders (name · key · description · status · id) without error; seeded tenants present | Positive | — | |
| TD-01.2 | Row → detail (page) | 1) Click a tenant row | Navigates to `/tenants/:id`; the **page** detail opens (header + 5 tabs), not a modal/blade | Positive | — | |
| TD-01.3 | Breadcrumb trail | 1) On a detail page, read the breadcrumb | Shows `Home / Platform / Tenants / «Tenant»`; the in-page tab is **not** appended | Positive | — | SH5 |
| TD-01.4 | Search / filter / sort | 1) Search "Arca"; 2) filter Status; 3) sort Name | List narrows / sorts; clearing restores; layout persists to profile | Positive | — | Closes MT-01.4 |
| TD-01.5 | Tenant-admin scope | 1) Sign in as `arcaai_admin`; 2) open Tenants | Sees own tenant only (or no platform list); **404-over-403** on a foreign `/tenants/:id` ("Tenant not found") | Isolation | — | **X1** |
| TD-01.6 | Non-admin blocked | 1) As `doctor`, hit the Tenants link + direct URL | No access; no tenant data exposed | RBAC | — | **X5** |

---

## TD-02 — Tenant detail header & tab navigation

**Requirement.** The detail surface presents the tenant identity and sub-sections (Overview, Users, Configuration, Storage, Departments) navigable as tabs. *(US 63; NAV.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No

**Roles under test:** `SUPER_ADMIN`; `TENANT_ADMIN` (own tenant).

**Prerequisites** — on a tenant detail page (TD-01.2).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-02.1 | Identity header | 1) Inspect the header | Avatar + name + status badge + mono key; `System` badge on the global tenant | Positive | — | |
| TD-02.2 | Tab set | 1) Read the tab nav | Overview · Users · Configuration · Storage · Departments; active tab is teal-underlined | Positive | — | |
| TD-02.3 | Switch tabs | 1) Click each tab | URL + content change per tab; back/forward works; refresh keeps the tab | Positive | — | |
| TD-02.4 | Desktop ↔ mobile tabs | 1) Desktop: underline tabs; 2) shrink to <768 | Mobile renders a **"Tenant section" `Select`** in place of the underline tabs (≥44px) | Responsive | — | Defer generic to TASK-384 |
| TD-02.5 | Deep-link a tab | 1) Open `/tenants/:id/configuration` directly | Lands on Configuration with the tab active; breadcrumb intact | Edge | — | |

---

## TD-03 — Edit tenant (dialog, OCC) — *closes MT-03*

**Requirement.** An admin edits a tenant's name/description; the **key is immutable**; concurrent edits are safe. *(US 63; MT-03.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No — Notes: edit is a focused **dialog** (was absent in the 2026-06-27 build).

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN` (own tenant); `DOCTOR` (negative).

**Prerequisites** — a disposable tenant (`QA_TENANT_A`); signed in as `super_admin`.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-03.1 | Edit name & description | 1) **Edit tenant**; 2) change name/description; 3) Save | Toast success; values persist after refresh + in the list | Positive | — | |
| TD-03.2 | Key immutable on edit | 1) Open Edit | Key field is **disabled** and labelled "(immutable)" | Validation | — | |
| TD-03.3 | Required-field validation | 1) Clear Name; 2) Save | Submit disabled / inline error; prior value retained | Validation | — | |
| TD-03.4 | Concurrent edit (OCC) | 1) Open the same tenant in two sessions; 2) Save in A; 3) Save stale form in B | B is rejected/warned (toast + refetch via `If-Match`); no silent overwrite | Edge | — | Closes MT-03.7 |
| TD-03.5 | Create-key uniqueness | 1) Open **New tenant**; 2) type an existing key (any case) | Inline "already in use" + blocked submit; available keys show `● Available` | Validation | — | Watch DEF-ADM-001 |
| TD-03.6 | Mobile full-screen | 1) <768, open Edit/New | Dialog is (near-)full-screen with ≥44px footer actions | Responsive | — | |
| TD-03.7 | Non-admin denied | 1) As `doctor`, attempt edit via UI/URL | No Edit affordance; mutation denied | RBAC | — | **X5** |
| TD-03.8 | Tags + plan controls | 1) Inspect the dialog | **LANDED (TASK-387):** live **tags** chips + **plan** selector persist via PATCH; only **domain** may remain a footnote TARGET | Positive | — | Re-test (was TARGET). Plan → entitlements (TASK-392, enforcement OFF) |

---

## TD-04 — Enable / disable tenant (X7) — *advances MT-04*

**Requirement.** An admin can disable (recoverable archive) and re-enable a tenant; destructive actions confirm; the system tenant is protected. *(US 63; AC X2/X7.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No

**Roles under test:** `SUPER_ADMIN`; others negative.

**Prerequisites** — disposable tenant only (never disable `Global`/`ArcaAI`).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-04.1 | Disable confirms | 1) On `QA_TENANT_A`, click **Disable** | AlertDialog appears ("Disable «Tenant»?", recoverable-archive copy); nothing happens until confirmed | Positive | — | **X7** |
| TD-04.2 | Disable succeeds | 1) Confirm | Toast; status badge → DISABLED; action toggles to **Enable** | Positive | — | |
| TD-04.3 | Re-enable | 1) Click **Enable** | Status → ENABLED (direct, no confirm needed) | Positive | — | |
| TD-04.4 | System tenant protected | 1) Open the `Global` tenant detail | **No Edit/Disable** affordance; shows "The system tenant is protected." | Negative | — | **DEF-ADM-002 RESOLVED (TASK-387):** now a **backend guard**, not just FE gating — the server rejects archive/delete of the system/`__GLOBAL__` tenant |
| TD-04.5 | Cancel aborts | 1) Open Disable confirm; Cancel | No change; tenant stays ENABLED | Edge | — | |
| TD-04.6 | Audited | 1) Disable; 2) open Audit Log | UPDATE/status entry with actor·IP·timestamp | Audit | — | **X6** |
| TD-04.7 | Archive lifecycle + restore | 1) Inspect status options / lifecycle menu | **LANDED (TASK-387):** `SUSPENDED` / `ARCHIVED` (recoverable, X2) in addition to ENABLED/DISABLED, plus **restore**; system tenant excluded | Positive | — | Re-test (was TARGET). See lifecycle menu |

---

## TD-05 — Tenant Configuration (OCC) — *closes MT-06*

**Requirement.** An admin manages per-tenant config: feature flags + ASR pipeline (model/language/mode); changes are tenant-isolated and concurrency-safe. *(US 57, 61, 62, 66; MT-06.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No — Notes: shipped as the **Configuration** tab (was a disabled nav item on 2026-06-27).

**Roles under test:** `SUPER_ADMIN` (any tenant via working-tenant); `TENANT_ADMIN` (own tenant only).

**Prerequisites** — a working tenant selected (TD-08.1); a 2nd tenant for isolation.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-05.1 | Config loads | 1) Open **Configuration** | Section cards render: General (switches) + Speech-to-text (selects); current values populated | Positive | — | |
| TD-05.2 | Edit a feature flag | 1) Toggle a switch; 2) Save | Dirty footer enables; toast; value persists after reload | Positive | — | |
| TD-05.3 | Edit ASR pipeline | 1) Change ASR model / language / mode; 2) Save | Persists for this tenant | Positive | — | |
| TD-05.4 | Discard | 1) Change a value; 2) Discard | Reverts to last-saved; footer disables | Edge | — | |
| TD-05.5 | Concurrent/stale save (OCC) | 1) Save in two sessions; stale second | Stale save rejected/warned (`expectedVersion`/`If-Match`); no silent overwrite | Edge | — | Closes MT-06.8 |
| TD-05.6 | Config isolation | 1) Set value for tenant A; 2) switch to B; inspect | B unaffected by A | Isolation | — | **X1** |
| TD-05.7 | System-tenant lock | 1) Open Configuration on `Global` | Amber notice; controls disabled (read-only) | Negative | — | |
| TD-05.8 | Tenant-admin own-scope | 1) As `arcaai_admin`, open Configuration; attempt a foreign tenant | Own config editable; foreign config inaccessible (404-over-403) | RBAC/Isolation | — | **X1/X5** |
| TD-05.9 | Audited | 1) Save a change; 2) Audit Log | UPDATE entry (before/after, actor, tenant) | Audit | — | **X6** |

---

## TD-06 — Storage buckets

**Requirement.** An admin views the tenant's storage buckets. *(US — storage; partial.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No — Notes: bucket **listing** is live; **quota** (`quotaBytes`) + storage-used are now backed by `GET /admin/tenants/:id/usage` (**TASK-386**); **objects/size/rotate/manage** remain **TARGET**.

**Roles under test:** `SUPER_ADMIN`; `TENANT_ADMIN` (own tenant).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-06.1 | Buckets list | 1) Open **Storage** | Buckets table renders (name · provider·region · status); loading uses skeletons | Positive | — | |
| TD-06.2 | Quota + usage backed; objects/size TARGET | 1) Inspect Quota / Usage vs Objects / per-object Size | **Quota (`quotaBytes`) + storage-used are REAL (TASK-386)** and populate the meter; **Objects / per-object Size** remain em-dash + "target metric" note (never fabricated) | Positive · TARGET | — | Re-test quota (was TARGET); objects/size still NA |
| TD-06.3 | Rotate/Manage disabled | 1) Inspect footer actions | Rotate keys / Manage provider are disabled (`title="Not yet available"`) | — | — | **TARGET** (NA) |
| TD-06.4 | Acting-on banner | 1) As `super_admin` with a working tenant | "Acting on «Tenant»" context banner is present | Isolation | — | |
| TD-06.5 | Isolation | 1) As `arcaai_admin`, only own buckets | No cross-tenant buckets | Isolation | — | **X1** |

---

## TD-07 — Departments (card-grid + detail)

**Requirement.** An admin manages a tenant's departments (create, browse, open detail, add members, set a default agent instruction). *(US — departments.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No — Notes: **Update 2026-07-01** — **member counts** are now backable via `GET /admin/departments/:id/users` (**TASK-387** reverse listing); lead/role-in-department may still be TARGET.

**Roles under test:** `SUPER_ADMIN`; `TENANT_ADMIN` (own tenant).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-07.1 | Department card-grid | 1) Open **Departments** | `CardGrid` of department cards (name · status · code · Manage →); search works | Positive | — | |
| TD-07.2 | Create department | 1) **New department**; 2) name/code; 3) Save | Toast; new card appears; isolated to the tenant | Positive | — | X1 |
| TD-07.3 | Open detail | 1) Click **Manage →** | Department detail opens (Members + Agent instructions sub-tabs); breadcrumb extends to `… / Departments / «Dept»` | Positive | — | |
| TD-07.4 | Add members | 1) **Add members**; 2) pick users; 3) Save | Selected users assigned; member list updates; partial-failure toast if any fail | Positive | — | |
| TD-07.5 | New agent instruction | 1) **New instruction**; 2) service + prompt; 3) Create | Created; **scope locked to DEPARTMENT_DEFAULT** | Positive | — | D3 |
| TD-07.6 | Not-found | 1) Open a bad department id | "Department not found" empty state + back link (no existence leak) | Isolation | — | **X1** |
| TD-07.7 | Member counts backed; lead/role TARGET | 1) Inspect member counts vs lead/role-in-dept on cards | **Member counts REAL (TASK-387** `…/departments/:id/users`**)**; lead/role-in-department may still show "not yet available" | Positive · TARGET | — | Re-test member count (was TARGET) |

---

## TD-08 — App-shell: working tenant, banner, NoTenant, responsive

**Requirement.** A global admin selects a working tenant; the shell makes the active tenant explicit, prompts when none is selected, and adapts the nav across viewports. Tenant-admins have no switcher. *(AC — System Roles & Multi-Tenancy; US 57; NAV; supersedes MT-07.)*

**Requirement available at current stage?** ☑ Yes ☐ Partial ☐ No

**Roles under test:** `SUPER_ADMIN` (switcher); `TENANT_ADMIN` (no switcher).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TD-08.1 | Working-tenant switcher | 1) As `super_admin`, open the sidebar switcher | Popover with "Search tenants…", "All tenants", tenant list, "Manage tenants" | Positive | — | SH2 |
| TD-08.2 | Selecting scopes session | 1) Pick `ArcaAI`; 2) open Users | Only `ArcaAI` data; selection persists across nav + refresh | Isolation | — | **X1** |
| TD-08.3 | NoTenant prompt | 1) As `super_admin` with **no** working tenant; 2) open top-level **Users** | "Select a tenant to continue" + "View all tenants" — **not** a blind all-tenant list | Positive | — | Closes GAP-ADM-001 |
| TD-08.4 | Acting-on banner | 1) Select a tenant; 2) open a mutation surface (Config/Users) | "Acting on «Tenant»" banner names the tenant (blast-radius is explicit) | Isolation | — | SH3 |
| TD-08.5 | Role-tiered nav (default-deny) | 1) As `tenant_admin`, inspect nav | `requireSuperAdmin` items (Dashboard/Tenants) hidden; empty tiers drop | RBAC | — | **X5** |
| TD-08.6 | Tenant-admin has no switcher | 1) As `arcaai_admin` | Static workspace chip, no switch control; session fixed to `ArcaAI` | RBAC/Isolation | — | Closes MT-07.7 |
| TD-08.7 | Responsive shell | 1) Desktop (full sidebar); 2) tablet (icon-rail); 3) mobile (hamburger → drawer + bottom switcher) | Shell adapts per tier; ≥44px targets on mobile | Responsive | — | Defer generic to TASK-384 |
| TD-08.8 | Mutations target working tenant | 1) Select `QA_TENANT_A`; 2) create a user | New user lands in `QA_TENANT_A` only | Isolation | — | **X1** |

---

## Defects & Observations (record per [README §8](./README.md))

> Use `QA-ADM-____`, cite the `TD-xx.y` TC + the requirement source, and set the **Cross-cutting flag** (X1–X8) when a principle is violated. Carry forward DEF-ADM-001 (case-insensitive key). **DEF-ADM-002 is now RESOLVED (TASK-387):** the backend guard blocks archive/delete of the system/`__GLOBAL__` tenant (not just FE gating) — TD-04.4 re-tests confirmation that the server `DELETE`/lifecycle change is rejected.

## Results Summary (fill on execution)

| Metric | Count |
|--------|-------|
| Total cases | 49 |
| Executed | — |
| Pass (P) / Fail (F) / Blocked (B) / NA / Not-Run (—) | — |
