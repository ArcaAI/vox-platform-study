> _Relocated from `docs/implementation/TASK-383-Platform-Dashboard-Monitoring/MANUAL-E2E-TESTS.md` (TASK-385 docs alignment)._

# TASK-383 — Platform Dashboard + Monitoring (Manual E2E)

> Read [`docs/qa/manual-tests/README.md`](./README.md) first for
> environment prerequisites (§4), personas/accounts (§5), cross-cutting principles (§6), and the
> status legend (§3.3). This per-ticket suite follows the same case style as
> [`02-user-access-control.md`](./02-user-access-control.md) to avoid
> collisions in the central suite.
>
> **Scope:** the two super-admin **platform** surfaces (tier `10–19`, cross-tenant): **Platform
> Dashboard** (`/dashboard`, frame `10`) and **Monitoring** (`/system-health`, frame `11`).
> **Primary persona:** `super_admin` (global, cross-tenant). Negative/RBAC personas: `tenant_admin`,
> `arcaai_admin`, `doctor`.
> **Requirement basis:** business requirements (Monitor US 53–56, 58, 103; tenant scale US 63/94) +
> Access-Control principles (X5 default-deny, X1 isolation). Design = TASK-371 §5.9 (Pass 9).

**Suite index:** PDM-01 Platform Dashboard · PDM-02 Monitoring · PDM-03 Super-admin gating & default-deny · PDM-04 REAL-vs-TARGET integrity

### Status legend (mirrors central suite §3.3)
`P` Pass · `F` Fail (raise defect) · `B` Blocked · `NA` Not Applicable (requirement not present) · `—` Not Run.

### Case type tags
`Positive`, `Negative`, `Validation`, `RBAC`, `Isolation`, `Audit`, `Edge`, `Responsive`.

### Cross-cutting flags exercised (central README §6)
- **X5 default-deny** — no access unless a policy grants it (the platform-ops APIs are super-admin-only).
- **X1 tenant isolation** — a tenant-admin never sees cross-tenant platform data.
- **X6 auditability** — the `New tenant` create from the dashboard is audited (X6).
- **X7 confirmation** — destructive/mutating actions confirm (the create dialog).

> **Requirement available at current stage?**  ☐ Yes ☐ Partial ☐ No — Notes: ______________________
> *(Some metrics are intentionally TARGET — see PDM-04; mark those rows `NA`/document, do not `F`.)*

---

## PDM-01 — Platform Dashboard (`/dashboard`, frame 10)

**Requirement.** A global/super-admin sees a cross-tenant overview answering *"is the whole platform
healthy & busy right now?"* — headline KPIs (active tenants, live sessions, processing jobs, degraded
services), a secondary scale/capacity row, and a cross-tenant consultation chart with date-range +
tenant-scope controls. *(Source: US 53–56, 58, 103; tenant scale US 63/94.)*

**Roles under test:** `super_admin` (positive). Negative gating in PDM-03.
**Prerequisites:** seeded stack (central README §4 E1–E7); signed in as `super_admin` (no working
tenant required — this is a cross-tenant tier 10–19 surface). Seed ships ≥ 1 tenant + several users.
**Preconditions:** note the tenant count (Platform → Tenants) and user count (Users) to verify KPIs.
**Dependencies:** overlaps central **MT-05** (Monitor) and **MT-01** (tenant list). Cross-reference there.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| PDM-01.1 | Dashboard reachable | 1) As `super_admin`, open **Overview → Dashboard** | `/dashboard` loads; `h2` "Platform Dashboard"; breadcrumb `Home / Platform / Dashboard` | Positive | ☐ | |
| PDM-01.2 | Headline KPIs are REAL | 1) Read the 4 headline tiles | **Active tenants** = tenant count; **Live sessions**, **Processing jobs** show counts; **Degraded services** shows a count + dot+label | Positive | ☐ | Active-tenants should equal Platform→Tenants count |
| PDM-01.3 | Degraded names surfaced | 1) When ≥ 1 service degraded (e.g. SMR), read the Degraded-services tile footer | Tile is **amber**; footer names the degraded service(s) (e.g. "SMR"); else "All operational" (success) | Positive | ☐ | Matches Monitoring PDM-02.3 |
| PDM-01.4 | Total users is REAL | 1) Read **Total users** in the secondary row | Matches the Users list total (cross-tenant) | Positive | ☐ | |
| PDM-01.5 | Consultation chart renders | 1) Inspect the full-width chart | Bar chart of sessions/day (new-visits + re-visits), legend; caption "N sessions · {range}" | Positive | ☐ | |
| PDM-01.6 | Date-range presets work | 1) Toggle **Week / Month / Year** | Chart + caption update to the chosen range | Positive | ☐ | |
| PDM-01.7 | Tenant-scope cross-link | 1) Open the **All tenants** filter, pick a tenant | Navigates to that tenant's **Overview** (`/tenants/:id/overview`, TASK-380) | Positive | ☐ | Filter visible only to super-admin |
| PDM-01.8 | New tenant from dashboard | 1) Click **New tenant**<br>2) Fill name (+ key)<br>3) Save | Create dialog (X7); success toast; dashboard reloads with the new tenant counted; audit entry (X6) | Positive | ☐ | Overlaps central MT-02 |
| PDM-01.9 | Loading skeletons | 1) Hard-reload `/dashboard`, watch first paint | KPI tiles + chart show **skeletons** (no spinner/"Loading…") | Positive | ☐ | `10-skeleton-loading` |
| PDM-01.10 | Error + retry | 1) Simulate metrics failure (offline API / block `/admin/consultations`)<br>2) Observe | Centered **retry card** (`role=alert`) + **Retry**; clicking retries the fan-out | Edge | ☐ | |
| PDM-01.11 | Empty state | 1) On a freshly-seeded/empty platform (0 tenants/users/consultations) | "No platform activity yet" + **New tenant** CTA | Edge | ☐ | `NA` if seed has data |
| PDM-01.12 | Responsive reflow | 1) Resize to mobile (<768) / tablet (768–1023) / desktop (≥1280) | KPI rows reflow **1 → 2 → 4** columns; chart stays full-width, readable | Responsive | ☐ | Shell chrome = TASK-384 |

---

## PDM-02 — Monitoring (`/system-health`, frame 11)

**Requirement.** A super-admin sees real-time health, latency and throughput across all microservices:
throughput KPIs, a request-volume chart, a per-service **Services** table (dot+label status, P95,
uptime; SMR degraded), and a **Models & running tasks** table. *(Source: US 53–56; Monitor MT-05.)*

**Roles under test:** `super_admin` (positive). Negative gating in PDM-03.
**Prerequisites:** signed in as `super_admin`; downstream services running (or knowingly down, to test
states). **Dependencies:** overlaps central **MT-05** (Monitor).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| PDM-02.1 | Monitoring reachable | 1) Open **Observability → Monitoring** | `/system-health` loads; `h2` "Service Monitoring"; breadcrumb `Home / Platform / Monitoring` | Positive | ☐ | |
| PDM-02.2 | Services table — REAL status | 1) Read the **Services** table | One row per service in order **API · STT · SMR · NLP · Guardrail · Harness**, each a **dot + label** status | Positive | ☐ | |
| PDM-02.3 | SMR degraded surfaces | 1) When SMR reports degraded | SMR row shows **Degraded** (amber dot+label); consistent with Dashboard PDM-01.3 | Positive | ☐ | |
| PDM-02.4 | Uptime REAL, P95 TARGET | 1) Read the **Uptime** and **P95** columns | **Uptime** = a real duration; **P95** = em-dash (TARGET, no metric) | Validation | ☐ | See PDM-04 |
| PDM-02.5 | Models table — REAL identity | 1) Read the **Models & running tasks** table | 6 grounded models with host service: whisper-large-v3-turbo + silero-vad-v5 (STT), gemma-4-e4b (SMR), granite-guardian-4.1-8b (Guardrail), Medical-NER + symps-disease-bert (NLP) | Positive | ☐ | |
| PDM-02.6 | Running/latency TARGET | 1) Read **Running** + **Avg latency** | Both em-dash (TARGET — no per-model telemetry) | Validation | ☐ | See PDM-04 |
| PDM-02.7 | Throughput KPIs TARGET | 1) Read Requests/min · Error rate · Sockets/min · Total sockets | All render em-dash + "Target" hint (no metrics endpoint) | Validation | ☐ | See PDM-04 |
| PDM-02.8 | Request-volume empty-state | 1) Inspect the request-volume chart | Custom empty "Request-volume telemetry not instrumented" (TARGET), not a fabricated series | Validation | ☐ | |
| PDM-02.9 | 30s polling refresh | 1) Leave the page open; toggle a service health upstream | Services table refreshes within ~30 s without manual reload | Positive | ☐ | |
| PDM-02.10 | Error + retry on first-load failure | 1) Make `/health/services` unreachable, load fresh | Centered **retry card** (`role=alert`) + **Retry** | Edge | ☐ | After first success, transient poll fails do NOT flip to error |
| PDM-02.11 | MetricTable on mobile | 1) Resize < 768 | KPI 1-up; tables stack; 4-col tables **scroll horizontally** within their card (no clipping) | Responsive | ☐ | Card-list variant = backlog (TASK-384) |

---

## PDM-03 — Super-admin gating & default-deny (X5 / X1)

**Requirement.** Platform surfaces (tier 10–19) are **cross-tenant, super-admin only**. A
tenant-scoped user must not reach cross-tenant platform data — **default deny** (X5), **no leak** (X1).
*(Source: AC X5/X1; design tier rules `12-design-workflow.mdc`.)*

**Roles under test:** `tenant_admin` / `arcaai_admin` / `doctor` (negative); `super_admin` (positive control).
**Preconditions:** know the seeded personas (central README §5). Use a second browser profile for
parallel sessions (E5).

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| PDM-03.1 | Dashboard nav hidden (non-super) | 1) Sign in as `tenant_admin` | **No Dashboard / Overview** item in the sidebar (`requireSuperAdmin`) | RBAC | ☐ | |
| PDM-03.2 | Dashboard deep-link is default-deny | 1) As `tenant_admin`, navigate directly to `/dashboard` | No cross-tenant data renders: the cross-tenant calls (`/monitoring/*`, `/health/services`) **403** → KPIs error/empty, **no other tenant's data shown** (X5, X1) | RBAC/Isolation | ☐ | **R1**: no route-guard today — page chrome may show, but data is API-denied |
| PDM-03.3 | Monitoring nav hidden + deep-link default-deny | 1) As `tenant_admin`, confirm **no Monitoring item** in the sidebar; then deep-link `/system-health` directly | **No Monitoring nav item** (now `requireSuperAdmin`, hidden like Dashboard — F-NAV1 resolved). On deep-link, service-health calls **403** → page shows its **error/retry** state; **no cross-tenant health leaks** (X5) | RBAC | ☐ | **F-NAV1 RESOLVED** (`nav.ts:58` → `requireSuperAdmin: true`). A **route-level** guard (**R1**) is still deferred, so a deep-link renders the shell but data is API-denied (403). |
| PDM-03.4 | Doctor is denied | 1) As `doctor`, attempt `/dashboard` and `/system-health` | No platform data; cross-tenant APIs **403** | RBAC | ☐ | |
| PDM-03.5 | Super-admin positive control | 1) As `super_admin`, open both surfaces | Both load with cross-tenant data (the same calls that 403 above now 200) | Positive | ☐ | Confirms the gate is on authorization, not a global outage |

---

## PDM-04 — REAL-vs-TARGET integrity ("never fabricate")

**Requirement (design-system pillar).** Un-backed metrics must render as a flagged **TARGET** (em-dash
+ "Target"), never as invented numbers. *(Source: TASK-371 §5.14.1; design-system "never fabricate".)*

**Roles under test:** `super_admin`.

| TC | Title | Steps | Expected result | Type | Status | Notes |
|----|-------|-------|-----------------|------|--------|-------|
| PDM-04.1 | Dashboard TARGET tiles | 1) Read Transcription min · 24h / Summaries · 24h / Storage used | Each = **em-dash** + a "… · Target" hint — **no fabricated value** | Validation | ☐ | T1 backend ticket |
| PDM-04.2 | Monitoring TARGET KPIs | 1) Read the 4 throughput KPIs | All em-dash + "Target" | Validation | ☐ | |
| PDM-04.3 | TARGET columns | 1) Read P95 (Services) + Running/Avg-latency (Models) | All em-dash | Validation | ☐ | |
| PDM-04.4 | No silent zeros | 1) Confirm TARGET cells are **em-dash**, not `0` | A real `0` (e.g. 0 degraded services) is distinct from a TARGET em-dash | Edge | ☐ | Guards against fabrication-as-zero |
| PDM-04.5 | REAL where backed | 1) Confirm Active tenants / Total users / service status / uptime / model identity show real values | These are REAL (not em-dash) when the stack is healthy | Positive | ☐ | |

---

## Findings (raised by this review)

- **F-NAV1 (Minor, IA) — RESOLVED (2026-06-30).** The **Monitoring** nav item (`/system-health`) is now
  `requireSuperAdmin: true` in `lib/nav.ts:58`, so `getNavSections` **hides** it from tenant-admins like the
  Dashboard item. The API boundary was always default-deny (`@Authorize(['manage','all'])` → 403); the nav now
  matches it for this tier-10–19 surface, closing the IA inconsistency. See TRACEABILITY-MATRIX **R1** (the
  **route-level** guard remains the open follow-up).
- **R1 (route guard) — OPEN.** Neither `/dashboard` nor `/system-health` has a **route-level** super-admin
  guard (router context carries only `isAuthenticated`). Mitigated by nav-hide (now **both** Dashboard and
  Monitoring, post-F-NAV1) + API-403 (both). Tracked as a shell / TASK-384 follow-up.

## Defect reporting

Use the central template in [`docs/qa/manual-tests/README.md` §8](./README.md);
cite the `PDM-xx.y` TC id and any `X1–X8` flag violated.
