> _Relocated from `docs/implementation/TASK-380-Tenant-Dashboard/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-380 — Tenant Dashboard (frame 18d) · Manual E2E

> **Surface under test:** the tenant **Overview** tab upgraded into the `18d` Tenant Dashboard
> (`/tenants/{id}/overview`). Manual, black-box (UI-driven), FE→BE.
>
> Read the central [`docs/qa/manual-tests/README.md`](./README.md) first for
> environment prerequisites (§4), personas/accounts (§5), cross-cutting principles (§6), the
> status legend (§3.3), and the defect template (§8). This per-ticket suite follows the same
> case style as [`docs/qa/manual-tests/01-multi-tenancy-management.md`](./01-multi-tenancy-management.md)
> and **cross-references** its `MT-05 Monitor` cases where they overlap.

**Suite index:** TDB-01 Headline KPIs · TDB-02 Secondary KPIs · TDB-03 Consultation chart + range/tenant filter · TDB-04 Recent activity (audit) · TDB-05 Audio-pipeline strip · TDB-06 State variants · TDB-07 Tenant-admin scope & isolation

**Primary persona:** `super_admin` (cross-tenant operator) unless a case says otherwise.
**Requirement basis:** business requirements (US 42, 53–58, 89, 103) + TASK-371 README §5.14 design + TASK-380 README §1.

## Status legend (per central §3.3)

| Mark | Meaning |
|---|---|
| `P` | Pass — actual matches expected |
| `F` | Fail — actual differs (raise a defect, central §8) |
| `B` | Blocked — dependency/precondition unmet |
| `NA` | Not Applicable — requirement not present at current stage |
| `—` | Not Run yet |

> The tenant-dashboard **surface is Completed** (build; see [TASK-380 README](../../implementation/TASK-380-Tenant-Dashboard/README.md)).
> These **manual UI cases** are **authored, Not Run (`—`)** — to be executed against a seeded stack. A
> backend contract finding (**TD3-400**) surfaced by the live E2E run — now **RESOLVED by TASK-386** — is recorded under **Defects & observations** below.

## Case-type tags & cross-cutting flags

Types: `Positive`, `Negative`, `Validation`, `RBAC`, `Isolation`, `Audit`, `Edge`.
Cross-cutting (central §6): **X1** tenant isolation (404-over-403) · **X6** auditability · others as noted. The dashboard is **read-only** (no mutations), so X2/X7 do not apply here; X6 is verified *indirectly* (TDB-04 reads the audit trail produced by mutations made elsewhere).

## REAL vs TARGET (do not fail TARGET tiles)

Per TASK-380 README §2 / §3, these tiles are **drawn but unbacked (TARGET)** — they correctly show an em-dash and a "· Target" hint; treat a populated value as the anomaly, not the em-dash:
**Open sockets** · **Consumption** · per-model audio-stream counts · server-side range aggregation (the chart buckets the most-recent consultations page client-side).

🔒 **Super-admin-only telemetry:** `running sessions`, `processing jobs`, and `service health` come from `GET /monitoring/sessions` + `GET /health/services`, which are gated to SUPER_ADMIN (`manage all`). For a **tenant-admin** these calls 403, so those KPIs **degrade to em-dash / `Unknown`** — this is expected (TDB-07), not a defect.

---

## TDB-01 — Headline KPIs

**Requirement.** The operator sees at a glance whether a tenant is healthy & busy: active users, departments, running sessions, and overall service health. *(US 53–58, 103.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No — Notes: built (TASK-380); `running sessions` + `services healthy` source from super-admin-only telemetry.

**Roles under test:** `SUPER_ADMIN` (positive); `TENANT_ADMIN` (TDB-07 degrade).
**Prerequisites:** E1–E4; signed in as `super_admin`; a tenant with seeded data (`Global`/`__GLOBAL__`).
**Preconditions:** view a tenant via Tenants → row → Overview (this makes it the working tenant).
**Dependencies:** MT-01 (open a tenant). Cross-ref `MT-05.4` (active sessions/jobs).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-01.1 | Headline row renders 4 tiles | 1) Open a tenant's Overview | A 4-tile KPI row: **Active users**, **Departments**, **Running sessions**, **Services healthy** — values use `tabular-nums` | Positive | — | |
| TDB-01.2 | Active users + Departments are REAL | 1) Note the values<br>2) Cross-check `GET /admin/tenants/:id/usage` (or Users/Departments tabs) | Counts match the tenant's actual users/departments (non-fabricated) | Positive | — | Backed by `getUsageStats`. |
| TDB-01.3 | Running sessions is live | 1) Observe the tile hint | Shows a live count with a `live · synced {relative}` hint (or em-dash if telemetry is unavailable) | Positive | — | Cross-ref `MT-05.4`. |
| TDB-01.4 | Services healthy `n/total` + degraded | 1) Observe the tile + footer dot | Shows `healthy/total` with a dot+label; a degraded service (e.g. SMR) is named in the hint; accent reflects health | Positive | — | Dot+label, never color-only. Cross-ref `MT-05.1`. |
| TDB-01.5 | Empty-tenant zeroes | 1) Open a brand-new tenant with no data | Tiles show `0` with helpful hints (e.g. "Invite the first user") — see TDB-06.2 | Edge | — | |

---

## TDB-02 — Secondary KPIs

**Requirement.** Secondary operational counters: open sockets, processing jobs, consultations today (new vs re-visit), pending review, consumption. *(US 53–58, 103.)*

**Requirement available at current stage?**  ☐ Yes ☑ Partial ☐ No — Notes: Processing jobs / Consultations today / Pending review are REAL; **Open sockets** and **Consumption** are **TARGET** (em-dash).

**Roles under test:** `SUPER_ADMIN`.
**Prerequisites:** as TDB-01, with ≥1 seeded consultation today (some seeds may not be "today" — see TDB-02.3 note).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-02.1 | Secondary row renders 5 tiles | 1) Open Overview | Tiles: **Open sockets**, **Processing jobs**, **Consultations today**, **Pending review**, **Consumption** | Positive | — | |
| TDB-02.2 | Open sockets + Consumption are TARGET | 1) Inspect both tiles | Both show an em-dash (`—`) with a "· Target" hint; **no fabricated number** | Validation | — | Failing = a populated value (regression). |
| TDB-02.3 | Consultations today = new vs re-visit | 1) Inspect the tile hint | Total today with `{n} new · {m} re-visit`; split matches `parentConsultationId` (null = new) | Positive | — | If no consultation is dated today, `0` is correct. |
| TDB-02.4 | Pending review counts unsigned notes | 1) Inspect the tile | Counts PENDING_REVIEW / DRAFT_PENDING_SENSORS; accent turns `warning` when > 0 | Positive | — | |
| TDB-02.5 | Processing jobs is live | 1) Inspect the tile | Shows the STT/SMR queue depth from monitoring (or em-dash if unavailable) | Positive | — | Cross-ref `MT-05.4`. |

---

## TDB-03 — Consultation chart + Date-range + Tenant filter

**Requirement.** A focal chart of consultation volume per day (new vs re-visit), scoped by a Week/Month/Year range and (super-admin) by tenant. *(US 58, 103.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No — Notes: client-side bucketing of the most-recent page; **full server-side range aggregation is TARGET**.

**Roles under test:** `SUPER_ADMIN` (filter); `TENANT_ADMIN` (no filter — TDB-07).
**Prerequisites:** as TDB-01; ≥2 tenants for the switcher (create one via `MT-02` if needed).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-03.1 | Chart renders new vs re-visit | 1) Open Overview | A bar chart "Consultation sessions" with two legend series (**New**, **Re-visit**); footer reads `{total} session(s) · {caption}` | Positive | — | Tokens `--chart-1`/`--chart-2`. |
| TDB-03.2 | Range presets switch | 1) Click **Week** → **Month** → **Year** | The chart re-buckets (daily for week/month, monthly for year); caption + footer update; no crash | Positive | — | |
| TDB-03.3 | Tenant filter (super-admin) | 1) Open the tenant switcher on the chart<br>2) Select another tenant | The dashboard re-navigates to that tenant's Overview; every source re-scopes (X1) | Positive/Isolation | — | Filter present only for super-admin. |
| TDB-03.4 | Long range under-counts beyond the page | 1) Pick **Year** on a busy tenant | Only consultations within the most-recent fetched page are bucketed (documented TARGET limitation) | Edge | — | Not a defect; flagged in README §3. |
| TDB-03.5 | Range control is keyboard reachable | 1) Tab to the preset group<br>2) Arrow/Enter to switch | Focus rings visible; presets operable by keyboard (WCAG 2.2 AA) | Positive | — | |

---

## TDB-04 — Recent activity (audit feed) · X6

**Requirement.** A recent-activity feed surfaces the tenant's latest audited events (actor, action, time). *(US 42, 89; principle X6.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No — Notes: reads `GET /admin/audit-logs` via `ItemList`.

**Roles under test:** `SUPER_ADMIN`; `TENANT_ADMIN` (own-tenant only).
**Prerequisites:** E1–E4, E6 (audit visibility); perform a mutation elsewhere (e.g. create a user / edit the tenant) to generate a fresh audit entry.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-04.1 | Activity feed renders | 1) Open Overview | A "Recent activity" card lists recent entries: dot + title + `{actor} · {relative time}` + mono action code | Positive | — | |
| TDB-04.2 | Mutation appears in the feed (X6) | 1) In another tab, create/edit a resource in this tenant<br>2) Reload Overview | The new action appears with the correct actor and a destructive-intent action (delete/disable) shows a `warning` dot | Audit (X6) | — | Verifies the audit trail end-to-end. |
| TDB-04.3 | "View all" deep-links to Audit Log | 1) Click **View all →** | Navigates to `/audit-log` | Positive | — | |
| TDB-04.4 | Feed is tenant-scoped (X1) | 1) As `super_admin`, switch tenants (TDB-03.3)<br>2) Compare feeds | Each feed shows only that tenant's events; no cross-tenant leakage | Isolation (X1) | — | Cross-ref `audit-log.spec.ts`. |

---

## TDB-05 — Audio-pipeline strip

**Requirement.** A pipeline strip shows the live health of STT · VAD · SMR · Guardrail · NLP. *(US 53.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No — Notes: REAL per-service health (super-admin); **per-model running counts are TARGET**; VAD is derived from STT.

**Roles under test:** `SUPER_ADMIN`; `TENANT_ADMIN` (degrades — TDB-07).
**Prerequisites:** as TDB-01; for TDB-05.3, stop one Python service to observe a degraded state.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-05.1 | Strip renders 5 stages | 1) Open Overview | A strip with STT, VAD, SMR, Guardrail, NLP; each a dot+label status + model version | Positive | — | Cross-ref `MT-05.1`. |
| TDB-05.2 | SMR degraded reflected | 1) With SMR degraded (or seeded degraded) | SMR shows a `warning` dot + "Degraded"; others unaffected; "Services healthy" hint names SMR | Positive | — | Cross-ref `MT-05.7`. |
| TDB-05.3 | Service down handled | 1) Stop a service (e.g. NLP)<br>2) Reload | That stage shows `Unhealthy`/`Unknown`; UI does not crash; em-dash where data is absent | Edge | — | |
| TDB-05.4 | Per-model counts are TARGET | 1) Inspect the strip footer | "Per-model streams · Target" — no fabricated per-model numbers | Validation | — | |

---

## TDB-06 — State variants

**Requirement.** The dashboard handles loading, empty, and error states gracefully. *(UX principles `11`/`10`.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No.

**Roles under test:** `SUPER_ADMIN`.
**Prerequisites:** a brand-new empty tenant (TDB-06.2); ability to throttle/kill the API briefly (TDB-06.3).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-06.1 | Loading skeletons | 1) Open Overview on a slow connection (throttle) | KPI tiles, chart and activity show **skeletons** matching the loaded layout — no spinners, no "Loading…" text, no blank space | Positive | — | Rule `10-skeleton-loading`. |
| TDB-06.2 | Empty state | 1) Open a tenant with no users/depts/consultations/activity | Zeroed KPI row + an `Empty` card: icon + "No activity in this tenant yet" + **Invite users** / **Create department** CTAs | Positive | — | Frame `120:10998`. |
| TDB-06.3 | Error + retry | 1) Kill the API (or block consultations)<br>2) Open Overview | An alert card "Couldn't load tenant metrics" with the error message, a **Retry** button, and a **View status page** link; **Retry** recovers when the API returns | Negative/Edge | — | Frame `120:11169`. Driven by the consultations source. |
| TDB-06.4 | Partial-source failure degrades | 1) Block only monitoring/health (not consultations) | The chart/activity still render; only the affected KPIs em-dash — the page does **not** show the full error variant | Edge | — | `Promise.allSettled` per-source degrade. |

---

## TDB-07 — Tenant-admin scope & isolation · X1

**Requirement.** A tenant-admin sees a **read-only** dashboard scoped to its own tenant, with **no** cross-tenant controls; super-admin-only telemetry degrades rather than erroring. *(AC — Multi-Tenancy; principle X1.)*

**Requirement available at current stage?**  ☑ Yes ☐ Partial ☐ No.

**Roles under test:** `TENANT_ADMIN` (`tenant_admin` / `arcaai_admin`); `DOCTOR` (negative).
**Prerequisites:** E5 (second browser/profile); signed in as `tenant_admin` (own tenant) and, for isolation, `arcaai_admin`.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| TDB-07.1 | Read-only banner | 1) As `tenant_admin`, open own Overview | A `status` banner: "Tenant admin · {name}" + "Read-only metrics view scoped to your organization…" (not the super-admin "Acting on" banner) | Positive | — | Frame `120:11341`. |
| TDB-07.2 | No cross-tenant filter | 1) Inspect the chart header | The **TenantFilter is absent**; only the Date-range control is shown | RBAC/Isolation (X1) | — | |
| TDB-07.3 | Telemetry degrades (not error) | 1) Observe Running sessions / Services healthy / Audio pipeline | These show em-dash / `Unknown` (monitoring + health are super-admin-only → 403), while Users/Departments/Consultations/Activity populate normally; **no** error variant | RBAC | — | Expected per README §2. |
| TDB-07.4 | Cannot view another tenant (X1) | 1) As `arcaai_admin`, navigate to a different tenant's Overview URL directly | Blocked — "Tenant not found" (404-over-403); never another tenant's metrics | Isolation (X1) | — | `assertTenantInScope`. Cross-ref `MT-03.5`. |
| TDB-07.5 | Non-admin cannot reach the dashboard | 1) As `doctor`, attempt to open a tenant Overview (UI link + direct URL) | No access; the admin tenant surface is unavailable to a doctor | RBAC | — | Doctor lacks `manage:Consultation` / tenant admin scope. |
| TDB-07.6 | Activity feed scoped to own tenant | 1) As `tenant_admin`, inspect Recent activity | Only own-tenant events; no cross-tenant rows | Isolation (X1) | — | Cross-ref TDB-04.4. |

---

## Cross-references

- Central monitoring cases: [`01-multi-tenancy-management.md`](./01-multi-tenancy-management.md) **MT-05** (service status / uptime / sessions / usage / per-tenant scoping).
- Audit trail (X6) automated coverage: `apps/api/tests/e2e/audit-log.spec.ts`; this ticket's backend contract: `apps/api/tests/e2e/task-380-tenant-dashboard.spec.ts`.
- Frontend render/controls/reflow: `apps/admin/e2e/task-380-tenant-dashboard.spec.ts`.
- Row-level design→API→test map: [`TRACEABILITY-MATRIX.md`](../traceability/tenant-dashboard.md).

## Defects & observations

**Resolved (surfaced by the live backend E2E run 2026-06-30 → fixed by TASK-386, 2026-07-01):**

- **TD3-400 — RESOLVED by [TASK-386](../../implementation/TASK-386-Platform-Metrics-Backend/README.md) (cross-tenant contract).** `GET /admin/consultations` for a **super_admin with no tenant scope** previously returned **400** (`listConsultationsForTenant` required a tenant). TASK-386 changed that path to return **cross-tenant** data (tenant-admins stay pinned), so **TDB-03** (consultation chart) now runs as a bare super_admin without a working-tenant context. Regression covered by `task-386-platform-metrics.spec.ts` `PM7`. Cross-ref [TASK-380 README §7](../../implementation/TASK-380-Tenant-Dashboard/README.md) + [traceability TD3](../traceability/tenant-dashboard.md). *(Originally a contract nuance, not a product bug — no dashboard product change was needed.)*

Otherwise none recorded yet (manual UI suite authored, Not Run). Log new defects with the central template ([`docs/qa/manual-tests/README.md`](./README.md) §8), referencing the `TDB-xx.y` TC id and any X1–X8 flag.
