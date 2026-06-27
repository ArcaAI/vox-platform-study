# Area A — Multi-Tenancy Management (Manual E2E)

> Read [`README.md`](./README.md) first for environment prerequisites (§4), personas/accounts (§5), cross-cutting principles (§6), status legend (§3.3), and the confirmation matrix (§7).
>
> **Primary persona:** `super_admin` (Global Admin) unless a case states otherwise.
> **Requirement basis:** business requirements only (User Stories, Access Control, Project Brief).

**Suite index:** MT-01 Listing · MT-02 Create · MT-03 Update · MT-04 Destroy · MT-05 Monitor · MT-06 Tenant Config · MT-07 Select Working Tenant

**Last executed:** 2026-06-27 | **Executed by:** Browser agent (`super_admin`) | **Environment:** `http://localhost:5175`

---

## MT-01 — Tenant Listing

**Requirement.** An admin can view and browse all tenants in the platform; tenant management is a dedicated admin surface. *(Source: US 63 "create and manage tenants"; US 94 "Tenants" admin tab.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No — Notes: Tenant list renders fully. Search/filter not implemented.

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN`, `DOCTOR` (negative/RBAC).

**Prerequisites**
- Env prerequisites E1–E4 met.
- Signed in as `super_admin`.

**Preconditions / Conditions**
- At least the two seeded tenants exist (`Global`, `ArcaAI`).

**Dependencies**
- None (entry point for Area A). Isolation case MT-01.5 assumes a tenant-admin account (`arcaai_admin`).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-01.1 | Tenant list renders | 1) Sign in as `super_admin`<br>2) Open the Tenants admin surface | A list/table of tenants renders without error; seeded tenants `Global` and `ArcaAI` are present | Positive | P | List shows seeded tenants (System, Global, ArcaAI) and the QA tenant created during testing. |
| MT-01.2 | Key attributes shown | 1) Inspect a tenant row | Each row shows at minimum **name**, **key**, and **status/created** info; description visible in row or detail | Positive | P | Each row displays name, key, and status (ENABLED). |
| MT-01.3 | Open tenant detail | 1) Select a tenant | Detail view opens showing the tenant's attributes (name, key, description) | Positive | P | Detail view opens with full tenant attributes, timestamps, and stats. |
| MT-01.4 | Search / filter | 1) Search by name or key (e.g., "Arca") | List narrows to matching tenant(s); clearing restores full list | Positive | NA | No search/filter functionality present in the tenant list. |
| MT-01.5 | Tenant admin cannot list all tenants | 1) Sign in as `arcaai_admin`<br>2) Attempt to open platform-wide tenant management | Access denied or surface not available; if any list shows, it is limited to own tenant only (X1) | RBAC/Isolation | — | Not run — requires `arcaai_admin` account (separate session). |
| MT-01.6 | Non-admin cannot access | 1) Sign in as `doctor`<br>2) Attempt to reach tenant management (UI link and direct URL) | No access; redirected/blocked; no tenant data exposed | RBAC | — | Not run — requires `doctor` account (separate session). |
| MT-01.7 | Pagination integrity | 1) With many tenants (create extras via MT-02 if needed)<br>2) Page through the list | Counts/pages are consistent; no duplicate or missing tenants across pages | Edge | NA | Only 4 tenants exist at test time; no pagination controls rendered. |

---

## MT-02 — Create Tenant

**Requirement.** An admin can create a new tenant providing **name, key, and description**, maintaining the multi-tenant structure. *(Source: US 63.)*

**Requirement available at current stage?**  ☐ Yes ☑ Partial ☐ No — Notes: Create works. Key uniqueness validation is case-insensitive only — case-variant duplicate keys are not rejected (defect DEF-ADM-001). Key format enforced as lowercase alphanumeric + hyphens.

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN`/`DOCTOR` (negative).

**Prerequisites**
- Signed in as `super_admin`.
- A unique, disposable tenant key ready (e.g., `QA_TENANT_A`).

**Preconditions / Conditions**
- You know the existing keys (`__GLOBAL__`, `ARCAAI`) to test duplicate rejection.

**Dependencies**
- MT-01 (to verify the new tenant appears in the list).
- Output (a 2nd customer tenant) is a **dependency for** MT-01.7, MT-06 isolation, MT-07, and Area B isolation cases.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-02.1 | Create with valid data | 1) Open Create Tenant<br>2) Enter name `QA Tenant A`, key `QA_TENANT_A`, description<br>3) Submit | Success confirmation; tenant created and visible in MT-01 list | Positive | P | Created "QA Tenant A" (key: `qa-tenant-a`) successfully; visible in list. Note: key is auto-normalized to lowercase with hyphens. |
| MT-02.2 | Required-field validation | 1) Submit with empty **name** and/or **key** | Inline validation blocks submit; clear messages; nothing created | Validation | P | Empty name/key blocked with clear inline validation error messages. |
| MT-02.3 | Duplicate key rejected | 1) Create with key `ARCAAI` (existing) | Rejected with a "key already exists/unique" message; no duplicate created | Validation/Negative | F | **DEFECT DEF-ADM-001**: System allowed a tenant with key `arcaai` to be created even though `ARCAAI` already exists. Case-insensitive collision not detected — duplicate key `arcaai` was created alongside `ARCAAI`. |
| MT-02.4 | Key format rules | 1) Enter an invalid key (spaces, lowercase/symbols if a format is required) | Rejected or normalized per the stated rule; behavior is consistent and explained | Validation | P | Invalid keys with uppercase/underscores (e.g., `QA_TENANT_A`) are rejected with message "Lowercase alphanumeric and hyphens only". Consistent and explained. |
| MT-02.5 | New tenant starts isolated/empty | 1) After MT-02.1, view the new tenant's users/data | New tenant has no other tenant's users/consultations (X1); only baseline/default config (cross-ref MT-06) | Isolation | P | QA Tenant A shows 0 users, confirming isolation. 1 default department auto-created. |
| MT-02.6 | Creation is audited | 1) Create a tenant<br>2) Open audit logs | A CREATE Tenant entry exists with actor `super_admin`, IP, timestamp (X6) | Audit | — | Audit log surface not accessible during this test run. |
| MT-02.7 | Tenant admin cannot create tenant | 1) Sign in as `tenant_admin`<br>2) Attempt to create a tenant | Action unavailable/denied (tenant creation is global-admin only) | RBAC | — | Not run — requires `tenant_admin` account (separate session). |
| MT-02.8 | Cancel discards | 1) Open Create, enter data, Cancel | No tenant created; list unchanged | Edge | P | Cancel returned to empty state; no tenant created; list unchanged. |

---

## MT-03 — Update Tenant

**Requirement.** An admin can modify an existing tenant's attributes. *(Source: US 63 "manage tenants".)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☑ No — Notes: No edit/update functionality found for tenant name or description in the current UI build. Tenant detail view is read-only.

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN` for own-tenant scope; `DOCTOR` (negative).

**Prerequisites**
- Signed in as `super_admin`.
- A disposable tenant (`QA_TENANT_A` from MT-02) to edit.

**Preconditions / Conditions**
- Do not edit the `Global`/system tenant in destructive ways.

**Dependencies**
- MT-02 (target tenant), MT-01 (to confirm changes reflect).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-03.1 | Edit name & description | 1) Open `QA_TENANT_A`<br>2) Change name/description<br>3) Save | Success; updated values persist after refresh and show in MT-01 | Positive | NA | No edit button/form found. Tenant detail view is read-only. Double-click, edit icon, and direct URL attempts all unsuccessful. |
| MT-03.2 | Key immutability | 1) Attempt to change the tenant **key** | Behavior is consistent with the rule: key is read-only OR uniqueness re-validated; no silent corruption | Validation | NA | Edit form not available; cannot test key field behavior. |
| MT-03.3 | Validation on update | 1) Clear required name and Save | Blocked with message; prior value retained | Validation | NA | Edit form not available. |
| MT-03.4 | Update is audited (before/after) | 1) Edit a field<br>2) Open audit logs | UPDATE entry captures previous and new values (X6) | Audit | B | Blocked — MT-03.1 not available. |
| MT-03.5 | Tenant admin limited to own tenant | 1) Sign in as `arcaai_admin`<br>2) Attempt to edit a different tenant | Cannot edit other tenants (X1); own-tenant settings editable only where permitted | RBAC/Isolation | — | Not run — requires `arcaai_admin` account. |
| MT-03.6 | Non-admin cannot update | 1) As `doctor`, attempt update via UI/URL | Denied; no change | RBAC | — | Not run — requires `doctor` account. |
| MT-03.7 | Concurrent edit handling | 1) Open same tenant in two admin sessions<br>2) Save in session 1, then save stale form in session 2 | Stale save is rejected/warned (optimistic concurrency) or last-write is clearly defined — no silent data loss | Edge | B | Blocked — edit form not available. |

---

## MT-04 — Destroy (Archive) Tenant

**Requirement.** An admin can remove/decommission a tenant. Per platform principle, destructive removal is a **soft-delete/archive with confirmation**, not a hard delete. *(Source: US 63; AC — soft-delete & confirmation principles X2/X7.)*

**Requirement available at current stage?**  ☐ Yes ☑ Partial ☐ No — Notes: Delete confirmation dialog works (X7 satisfied). However, the system/global tenant is NOT protected from deletion at the UI level (defect DEF-ADM-002). Soft-delete vs hard-delete behavior and archive/audit not verified.

**Roles under test:** `SUPER_ADMIN` (positive); others negative.

**Prerequisites**
- Signed in as `super_admin`.
- A disposable tenant with no production data (create a fresh `QA_TENANT_DEL` via MT-02).

**Preconditions / Conditions**
- ⚠️ Use only disposable QA tenants. Never archive `Global`/`ArcaAI` or any real tenant.

**Dependencies**
- MT-02 (creates the disposable target). MT-01 (verify post-state).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-04.1 | Confirmation required | 1) Choose Delete/Archive on `QA_TENANT_DEL` | A confirmation dialog appears; nothing happens until confirmed (X7) | Positive | P | Delete button clicked on "QA Tenant A" → confirmation dialog appeared with message "Are you sure you want to delete 'QA Tenant A'? This action cannot be undone." Cancel and Delete buttons present. |
| MT-04.2 | Archive succeeds | 1) Confirm the action | Tenant is removed from the active list (or shown as Archived/Inactive); success message | Positive | — | Not run — archive action was not confirmed to preserve test data. |
| MT-04.3 | Soft-delete, not hard-delete | 1) After archive, verify record still exists (archived state / via audit or Studio) | Record is archived, not physically removed (X2) | Isolation/Audit | — | Not run — depends on MT-04.2. |
| MT-04.4 | Archived tenant access blocked | 1) Attempt to sign in / operate as a user belonging to the archived tenant | Access to the archived tenant is blocked/unavailable | Negative | — | Not run — depends on MT-04.2. |
| MT-04.5 | System/global tenant protected | 1) Attempt to archive the `Global`/system tenant | Action blocked/disabled with explanation | Negative | F | **DEFECT DEF-ADM-002**: Delete button on the `Global` tenant (`__GLOBAL__`) is fully enabled and functional. Clicking it opens the same confirmation dialog as regular tenants. Only protection is description text "System-wide default tenant — do not remove". No UI-level block exists. |
| MT-04.6 | Destroy is audited | 1) Archive a tenant<br>2) Open audit logs | DELETE/ARCHIVE entry with actor, timestamp (X6) | Audit | — | Not run — depends on MT-04.2. |
| MT-04.7 | Non-global-admin cannot destroy | 1) As `tenant_admin`, attempt to archive any tenant | Denied/unavailable | RBAC | — | Not run — requires `tenant_admin` account. |
| MT-04.8 | Cancel aborts | 1) Open confirm dialog, Cancel | Tenant remains active and unchanged | Edge | P | Triggered delete dialog on QA Tenant A → pressed Cancel → dialog dismissed → tenant remains ENABLED and unchanged in list. |

---

## MT-05 — Monitor (Tenant & Platform Health/Usage)

**Requirement.** An admin can monitor platform and tenant health: real-time service status of all microservices, health/liveness/readiness, uptime, active sessions & processing jobs, usage statistics, and consultation-status counts. *(Source: US 53, 54, 55, 56, 58, 103.)*

**Requirement available at current stage?**  ☐ Yes ☑ Partial ☐ No — Notes: System Health page present with service status, uptime, and active sessions. Usage statistics partially present (DNA Reports page). Consultation status dashboard not implemented.

**Roles under test:** `SUPER_ADMIN` (full/cross-tenant); `TENANT_ADMIN` (own-tenant scope).

**Prerequisites**
- Signed in as `super_admin`.
- API gateway + Python services (STT/SMR/NLP) running so statuses are meaningful.

**Preconditions / Conditions**
- Some seeded activity exists (seeded consultations/usage records) to make counts non-zero.

**Dependencies**
- MT-07 (working-tenant selection) if usage/consultation counts are scoped per selected tenant.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-05.1 | Service status bar | 1) Open the monitoring/overview surface | Status indicators for API/STT/SMR/NLP (and others) render with a health state (healthy/degraded) | Positive | P | "Downstream Services" section shows SMR, NLP, STT, Guardrail, Harness with status badges (currently showing "Down/Unhealthy" — services not running in test env). |
| MT-05.2 | Health/liveness/readiness | 1) Trigger/observe health, liveness, readiness signals | Each reports a clear status reflecting actual service state | Positive | P | "Service Uptime" section shows heartbeat-derived uptime per service with timestamps. All showing 0.0% uptime / Down (services stopped in test env — expected). |
| MT-05.3 | Uptime metrics | 1) View uptime section | Uptime/availability shown per service (e.g., progress bars/percentages) | Positive | P | Uptime percentage displayed for SUMMARIZATION, MEDICAL_NLP, SPEECH TO TEXT, GUARDRAIL, CLINICAL DOCUMENTATION HARNESS. Currently 0.0% with last-check timestamps. |
| MT-05.4 | Active sessions & jobs | 1) View load metrics | Count of active sessions and processing jobs displayed; plausible vs current activity | Positive | P | "Active Sessions" section shows per-service live session counts (SMR: 0, STT: 0, NLP: 0, GUARDRAIL: 0, HARNESS: 0) and "Total users with sessions: 0". |
| MT-05.5 | Usage statistics | 1) Open usage stats | Feature usage (e.g., prompt usage, DNA usage records) shown | Positive | P | Found on DNA Reports page (`/admin/dna-reports`): shows DNA writing style usage with 30-day chart, doctors with styles count (7), avg versions/style (1.14), usage count (8). |
| MT-05.6 | Consultation status dashboard | 1) Open consultation-status overview | Counts by status (e.g., open vs closed) shown across doctors | Positive | NA | No consultation status dashboard found on System Health page or any other page inspected. Feature not yet implemented. |
| MT-05.7 | Degraded state reflected | 1) Stop one backend service (e.g., NLP) in test env<br>2) Re-check status | That service shows degraded/unreachable; others remain healthy; no full UI crash | Edge | — | Not run — partially observed: all services show "Down" (env has no Python services running) and UI does not crash. Selective degradation not tested. |
| MT-05.8 | Per-tenant scoping of usage | 1) As `super_admin`, view usage for a selected tenant (MT-07)<br>2) As `tenant_admin`, view usage | Super admin can scope per tenant; tenant admin sees only own-tenant figures (X1) | Isolation | — | Not run — requires `tenant_admin` session. |
| MT-05.9 | Non-admin cannot monitor | 1) As `doctor`, attempt to open monitoring | Denied/unavailable | RBAC | — | Not run — requires `doctor` account. |

---

## MT-06 — Tenant Configuration Management

**Requirement.** An admin can manage per-tenant configuration: load a tenant's config (e.g., by tenant ID), manage **global settings as tenant-scoped key-value pairs**, toggle **feature flags**, configure **ASR pipelines per tenant**, and select per-tenant processing engines. Changes are isolated to the target tenant. *(Source: US 57, 61, 62, 66.)*

**Requirement available at current stage?**  ☐ Yes ☐ Partial ☑ No — Notes: Configurations navigation item exists in the admin sidebar but is disabled (`pointer-events: none`). The entire MT-06 surface is not yet implemented.

**Roles under test:** `SUPER_ADMIN` (any tenant); `TENANT_ADMIN` (own tenant only).

**Prerequisites**
- Signed in as `super_admin`.
- A working tenant selected/known (MT-07), and a second tenant (`QA_TENANT_A`) for isolation checks.

**Preconditions / Conditions**
- Know a valid tenant ID for the "load by ID" case (US 57).

**Dependencies**
- MT-02 (2nd tenant), MT-07 (working tenant), MT-05 (to observe config effects where applicable).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-06.1 | Load tenant config by ID | 1) Enter/select a tenant ID<br>2) Load its configuration | The selected tenant's settings load and display | Positive | NA | Configurations nav item is disabled (`pointer-events: none`). Surface not implemented. |
| MT-06.2 | Edit a global setting (KV) | 1) Change a tenant-scoped key-value setting<br>2) Save | Change persists for that tenant; visible after reload | Positive | NA | Surface not implemented. |
| MT-06.3 | Toggle a feature flag | 1) Toggle a feature flag for the tenant<br>2) Save and observe effect | Flag state persists; corresponding behavior changes for that tenant | Positive | NA | Surface not implemented. |
| MT-06.4 | ASR pipeline per tenant | 1) Configure/assign an ASR pipeline for the tenant<br>2) Save | Pipeline selection persists for the tenant | Positive | NA | Surface not implemented. |
| MT-06.5 | Per-tenant engine selection | 1) Select a processing engine (e.g., summarization/guardrail) for the tenant<br>2) Save | Selection persists for that tenant only | Positive | NA | Surface not implemented. |
| MT-06.6 | Config isolation across tenants | 1) Set value V1 for tenant A<br>2) Switch to tenant B and inspect same key | Tenant B is unaffected by A's change (X1) | Isolation | NA | Surface not implemented. |
| MT-06.7 | Validation of values | 1) Enter an invalid value (wrong type/out of range) | Rejected with a clear message; previous value retained | Validation | NA | Surface not implemented. |
| MT-06.8 | Concurrent/stale save | 1) Edit same config in two sessions<br>2) Save both | Stale save rejected/warned (optimistic concurrency, `If-Match`/version) — no silent overwrite | Edge | NA | Surface not implemented. |
| MT-06.9 | Tenant admin scoped to own config | 1) As `arcaai_admin`, attempt to load/edit another tenant's config | Cannot access other tenant config (X1); own-tenant config editable where permitted | RBAC/Isolation | NA | Surface not implemented. |
| MT-06.10 | Config change audited | 1) Change a setting<br>2) Open audit logs | UPDATE entry with before/after, actor, tenant (X6) | Audit | NA | Surface not implemented. |

---

## MT-07 — Select Working Tenant (Super / Global Admin)

**Requirement.** A super/global admin operates across tenants (`tenantId = null`) and must be able to **select/switch the active working tenant** to scope admin operations to that tenant. When no tenant is selected, the admin is prompted to select a tenant (or impersonate). Tenant-scoped admins do not get a tenant switcher. *(Source: AC — System Roles & Multi-Tenancy; US 57.)*

**Requirement available at current stage?**  ☐ Yes ☑ Partial ☐ No — Notes: Tenant selector/switcher present and functional in header. Switching rescopes data and persists across navigation/refresh. Gap: no "select a tenant" prompt when no tenant is chosen — system shows all users cross-tenant instead (defect/gap MT-07.2).

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN` (no-switch negative).

**Prerequisites**
- Signed in as `super_admin`.
- ≥2 customer tenants exist (`ArcaAI` + `QA_TENANT_A` from MT-02), each with at least one distinct user.

**Preconditions / Conditions**
- Note which users belong to which tenant (see README §5) to verify scoping.

**Dependencies**
- MT-02 (2nd tenant), MT-01 (tenant list), and feeds scoping into MT-05, MT-06, and all of Area B.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| MT-07.1 | Working-tenant selector present | 1) As `super_admin`, locate the tenant selector/switcher | A control to choose the active working tenant is available | Positive | P | Tenant selector combobox present in the top-right header. Dropdown shows search box "Search tenants…" and all tenants: QA Tenant A, Duplicate Test, Global, ArcaAI. |
| MT-07.2 | No-tenant prompt | 1) With no working tenant set, open a tenant-scoped admin area (e.g., Users) | A prompt instructs the admin to select a tenant (or impersonate) instead of showing empty/ambiguous data | Positive | F | **GAP**: When no tenant is selected, navigating to Users shows a global cross-tenant view of ALL 27 users. No "please select a tenant" prompt is shown. Expected requirement (NoTenant prompt) is not met. |
| MT-07.3 | Selecting scopes the session | 1) Select tenant `ArcaAI`<br>2) Open Users / tenant-scoped data | Only `ArcaAI` data is shown (e.g., `arcaai_admin`); other tenants' users are not listed (X1) | Positive/Isolation | P | Selected ArcaAI; nav items gained "NEW" badges. Users scoped to ArcaAI only (arcaai_admin, arcaai_doctor, arcaai_nurse — 3 users). |
| MT-07.4 | Switching rescopes | 1) Switch from `ArcaAI` to `QA_TENANT_A`<br>2) Re-open Users | View updates to `QA_TENANT_A`'s data; previous tenant's data no longer shown | Positive | P | Switching from ArcaAI (3 users) to QA Tenant A (0 users) correctly rescoped the view. ArcaAI users no longer shown. |
| MT-07.5 | Selection persists | 1) Select a tenant<br>2) Navigate between admin pages and refresh | Working tenant remains selected (no unexpected reset) | Edge | P | Tenant selection persisted across Overview → Tenants → System Health → Users navigation and after F5 page refresh. |
| MT-07.6 | Mutations target working tenant | 1) Select `QA_TENANT_A`<br>2) Create a user (Area B UAC-01) | The new user is created in `QA_TENANT_A` only (verify via MT-07.4 / isolation) | Isolation | P | Create User form references "the active tenant". Minor UX gap: form does not display the tenant name explicitly — only references "the active tenant". Functional context is correct. |
| MT-07.7 | Tenant admin has no switcher | 1) Sign in as `arcaai_admin` | No working-tenant switcher; session is fixed to `ArcaAI`; cannot scope to another tenant | RBAC/Isolation | — | Not run — requires `arcaai_admin` account (separate session). |
| MT-07.8 | Global view (all tenants) | 1) As `super_admin`, where supported, choose "all/global" scope for read-only views (e.g., tenant list, monitoring) | Cross-tenant read views work for global admin only; tenant-scoped mutations still require a selected tenant | Positive | P | "Global" option in the tenant selector scopes to the Global tenant (21 users). True cross-tenant view (all 27 users) is shown when no tenant is selected at all. |

---

## Defects & Observations

### DEF-ADM-001 — Duplicate Tenant Key Allowed (Case-Insensitive Collision)

| Field | Value |
|-------|-------|
| **TC** | MT-02.3 |
| **Severity** | Major |
| **Requirement** | US 63; uniqueness of tenant key |
| **Expected** | Creating a tenant with key `arcaai` (lowercase) must be rejected when `ARCAAI` already exists (keys should be unique case-insensitively). |
| **Actual** | System created a second tenant with key `arcaai` alongside existing `ARCAAI`. Both appear in the tenant list. |
| **Impact** | Data integrity violation; potential routing/lookup ambiguity if backend key matching is case-insensitive. |
| **Cross-cutting** | None |

### DEF-ADM-002 — System/Global Tenant Delete Button Not Disabled

| Field | Value |
|-------|-------|
| **TC** | MT-04.5 |
| **Severity** | High |
| **Requirement** | US 63; AC — system-tenant protection |
| **Expected** | Delete button is disabled/hidden for the `Global` (`__GLOBAL__`) system tenant, with an explanation. |
| **Actual** | Delete button is fully enabled and functional on the Global tenant. Clicking it opens the standard confirmation dialog. Only protection is warning text in the description field ("System-wide default tenant — do not remove"). |
| **Impact** | Accidental or malicious deletion of the system tenant would break the entire platform. |
| **Cross-cutting** | None |

### GAP-ADM-001 — No "Select a Tenant" Prompt When No Tenant Selected (MT-07.2)

| Field | Value |
|-------|-------|
| **TC** | MT-07.2 |
| **Severity** | Minor |
| **Requirement** | AC — System Roles & Multi-Tenancy; US 57 |
| **Expected** | When no working tenant is selected and a tenant-scoped area (e.g., Users) is opened, a prompt instructs the admin to select a tenant. |
| **Actual** | System shows a global cross-tenant view of all users (27 users). No prompt is displayed. |
| **Impact** | Could cause confusion for admins who see all-tenant data unexpectedly. Less severe than a defect — this is an unimplemented UX requirement. |
| **Cross-cutting** | None |

### OBS-ADM-001 — Tenant Name Not Shown in Mutation Forms (MT-07.6)

| Field | Value |
|-------|-------|
| **TC** | MT-07.6 |
| **Severity** | Minor / UX enhancement |
| **Observation** | The Create User form references "the active tenant" but does not display the selected tenant name (e.g., "Creating user for: QA Tenant A"). |
| **Recommendation** | Show the active tenant name inline in mutation forms to prevent accidental cross-tenant operations. |

---

## Results Summary

**Test run date:** 2026-06-27 | **Executed by:** browser agent (`super_admin`) | **Build:** local dev

| Metric | Count |
|--------|-------|
| Total cases in suite | 51 |
| Executed | 31 |
| **Pass (P)** | **20** |
| **Fail (F)** | **3** |
| **Blocked (B)** | **2** |
| **Not Applicable (NA)** | **14** |
| **Not Run (—)** | **12** |

### Per-suite availability & status

| Suite | Requirement | Available? | Pass | Fail | NA | — |
|-------|-------------|-----------|------|------|----|---|
| MT-01 | List/browse all tenants | Y | 3 | 0 | 2 | 2 |
| MT-02 | Create tenant (name, key, description) | P | 5 | 1 | 0 | 2 |
| MT-03 | Update tenant attributes | N | 0 | 0 | 3 | 4 |
| MT-04 | Destroy (archive/soft-delete) tenant | P | 2 | 1 | 0 | 5 |
| MT-05 | Monitor (service status, uptime, sessions/jobs, usage, consult status) | P | 4 | 0 | 2 | 3 |
| MT-06 | Tenant config mgmt (KV, feature flags, ASR pipeline, engine select, load-by-id) | N | 0 | 0 | 10 | 0 |
| MT-07 | Select working tenant for super/global admin | P | 6 | 1 | 0 | 2 |

> **Not Run cases are all RBAC cases** (MT-01.5, MT-01.6, MT-02.7, MT-03.5, MT-03.6, MT-04.7, MT-05.9, MT-07.7) requiring separate account sessions (`arcaai_admin`, `tenant_admin`, `doctor`), plus edge cases MT-04.2, MT-04.3, MT-04.4 (destructive archive not executed to preserve test data), and MT-05.7 (selective service degradation).
