# Admin Console — Manual E2E Test Suite

> **Audience**: QA / QC engineers
> **Surface under test**: HOPE Admin Console
> **Test type**: End-to-end, manual, black-box (UI-driven)
> **Derived from**: Business requirements only (see [Requirement Sources](#requirement-sources)) — **not** from implementation/code.

---

## 1. Purpose & Scope

This suite gives QA/QC engineers repeatable, requirement-traceable manual test cases for two admin-console capability areas:

| Area | File | Capabilities covered |
|------|------|----------------------|
| **A. Multi-Tenancy Management** | [`01-multi-tenancy-management.md`](./01-multi-tenancy-management.md) | Listing, Create, Update, Destroy, Monitor, Tenant Config Management, Select working tenant (super/global admin) |
| **B. User & Access Control (per tenant)** | [`02-user-access-control.md`](./02-user-access-control.md) | Create, Update, Role management, Activate/Deactivate, Destroy |

### Out of scope (validated by other suites)
Consultation/clinical workflow, audio/STT/summary generation, prompt-template & department content authoring, SDK developer surfaces, API-key lifecycle deep-dive (covered only where it intersects user management), and automated tests (Vitest/Playwright/pytest).

> **Important — requirements vs. current build.** These cases are written against *what the platform is required to do*. Some required surfaces may not yet exist or may be partial in the current build. **You do not "fail" a test because a feature is missing** — instead, record the requirement's availability in each suite's **Requirement available at current stage?** box, and mark dependent cases `N/A` or `Blocked`. This is the "manual check & confirm the requirements at current stage" step.

---

## 2. Requirement Sources

All cases trace to these business-requirement documents (no implementation files were used to author the steps):

| Ref | Document | Used for |
|-----|----------|----------|
| **US** | `knowledge/06_USER_STORIES.md` | Primary acceptance source (story numbers cited per suite) |
| **AC** | `knowledge/04_ACCESS_CONTROL.md` | RBAC model, system roles, tenant isolation, soft-delete & security principles |
| **PB** | `knowledge/01_PROJECT_BRIEF_AND_REQUIREMENTS.md` | Multi-tenancy NFR, compliance, audit, success criteria |
| **NAV** | `knowledge/UXUI/08-Layout-Navigation.md` | Admin console shell / navigation expectations |

---

## 3. How To Use This Suite

### 3.1 Workflow per suite
1. Read the suite's **Requirement** statement and tick **Requirement available at current stage?** (`Yes` / `Partial` / `No`) with a note.
2. Satisfy **Prerequisites**, **Preconditions/Conditions**, and **Dependencies**.
3. Execute each **Test case** top-to-bottom; record a **Status** and **Notes/Evidence** (screenshot, audit-log id, request id).
4. Log any defect with the **TC ID** (e.g., `MT-02.3`) so it is traceable to a requirement.

### 3.2 Test case ID scheme
`<SUITE>-<NN>.<n>` → e.g. `MT-02.3` = Multi-Tenancy suite 02, case 3. Suites: `MT-xx` (Area A), `UAC-xx` (Area B).

### 3.3 Status legend
| Mark | Meaning |
|------|---------|
| `P` | Pass — actual matches expected |
| `F` | Fail — actual differs from expected (raise defect) |
| `B` | Blocked — cannot run (dependency/precondition unmet) |
| `NA` | Not Applicable — requirement not present at current stage |
| `—` | Not Run yet |

### 3.4 Case type tags
`Positive`, `Negative`, `Validation`, `RBAC` (authorization), `Isolation` (tenant boundary), `Audit`, `Edge`.

---

## 4. Environment Prerequisites (apply to every suite)

| # | Prerequisite | Detail |
|---|--------------|--------|
| E1 | Admin Console reachable | Default local dev: `http://localhost:5175` (`pnpm dev:ui-playground`). Confirm the correct URL for your environment. |
| E2 | API Gateway healthy | Backend reachable (default `http://localhost:8868/api/v1`); header **connection/health badge shows healthy** before testing. |
| E3 | Supporting services up | PostgreSQL, Redis available (needed for auth, RBAC cache, audit/event pipeline). |
| E4 | Database seeded | Standard seed data loaded (accounts/roles/tenants in §5). Use a **non-production** environment. |
| E5 | Two browsers/profiles | A clean profile (or incognito) available to test a second role/tenant session in parallel for isolation cases. |
| E6 | Audit visibility | Ability to view audit logs (Audit Log surface, or DB/Studio) to verify logging-related expectations. |
| E7 | Clock & timezone | Note tester timezone; several expectations involve timestamps/`updatedAt`. |

---

## 5. Personas & Seed Test Accounts

Default password for all seeded users: **`password123`**. Sign in via the **Admin Login (JWT)** tab of the login screen.

| Persona (use in cases) | Username | Role | Tenant scope | Why it matters |
|------------------------|----------|------|--------------|----------------|
| **Global Admin** | `super_admin` | `SUPER_ADMIN` | Global (`tenantId = null`, cross-tenant) | Tenant CRUD, working-tenant selection, cross-tenant monitoring, impersonation |
| **Tenant Admin (Default)** | `tenant_admin` | `TENANT_ADMIN` | Default/Global tenant | Per-tenant user & access-control management; must be confined to own tenant |
| **Tenant Admin (ArcaAI)** | `arcaai_admin` | `TENANT_ADMIN` | `ArcaAI` tenant | Second-tenant admin for isolation tests |
| **Doctor** | `doctor` (John Smith) | `DOCTOR` | Default tenant | Non-admin negative/RBAC cases; impersonation target |
| **Doctor 2** | `doctor2` (Jane Doe) | `DOCTOR` | Default tenant | Secondary clinical user |
| **Department Head** | `department_head` | `DEPARTMENT_HEAD` (inherits DOCTOR) | Default tenant | Delegated role-assignment cases |
| **Nurse** | `nurse` (Sarah Williams) | `NURSE` | Default tenant | Read-only negative cases |
| **Service Account** | `service_account` | `SERVICE_ACCOUNT` | Default tenant | Non-interactive role behavior |

### Seeded tenants
| Key | Name | Notes |
|-----|------|-------|
| `__GLOBAL__` | Global | Platform/global default tenant |
| `ARCAAI` | ArcaAI | Single seeded customer tenant |

> **Data constraint:** the standard seed ships **only one customer tenant (`ArcaAI`)**. Several isolation/listing cases need **≥2 customer tenants**. Create an extra disposable tenant via suite **MT-02** (e.g. `QA_TENANT_A`) before running those cases. Never reuse production names.

### Seeded roles available for assignment
System (non-deletable): `SUPER_ADMIN`, `TENANT_ADMIN`, `DOCTOR`, `NURSE`, `SERVICE_ACCOUNT`.
Tenant-extendable (inherit a parent): `DEPARTMENT_HEAD` (→ DOCTOR), `SENIOR_NURSE` (→ NURSE).

---

## 6. Cross-Cutting Acceptance Principles

These hold across **all** suites (source: **AC** unless noted). Treat a violation as a defect even if a positive case "passes".

| ID | Principle | Source |
|----|-----------|--------|
| X1 | **Tenant isolation** — a user never sees or mutates another tenant's data; inaccessible resources return *not found*, not *forbidden* (404-over-403, no enumeration). | AC; US 91 |
| X2 | **Soft-delete only** — "destroy" archives/deactivates; records are not hard-deleted ("Users cannot be deleted, only archived"). | AC |
| X3 | **No privilege escalation** — a user cannot grant a role/permission above their own level; custom roles cannot exceed their parent. | AC; US 39 |
| X4 | **System-role protection** — built-in/system roles cannot be edited or deleted. | AC; US 40 |
| X5 | **Default deny** — no access unless a policy explicitly grants it. | AC |
| X6 | **Auditability** — every create/update/deactivate/delete and every permission change is recorded (actor, IP, timestamp, before/after) for HIPAA compliance. | AC; US 42, 89 |
| X7 | **Confirmation on destructive actions** — deactivate/delete require an explicit confirmation step. | US 29 |
| X8 | **Secrets shown once** — any generated secret (e.g., API key) is shown once at creation only. | US 92 |

---

## 7. Master Requirements Traceability & Confirmation Matrix

Fill the **Available now?** column once during a test cycle; it gates the dependent suite.

### Area A — Multi-Tenancy Management
| Suite | Requirement summary | Source | Available now? (Y/P/N) | Notes |
|-------|---------------------|--------|------------------------|-------|
| MT-01 | List/browse all tenants | US 63, 94 | ☐ | |
| MT-02 | Create tenant (name, key, description) | US 63 | ☐ | |
| MT-03 | Update tenant attributes | US 63 | ☐ | |
| MT-04 | Destroy (archive/soft-delete) tenant | US 63; AC | ☐ | |
| MT-05 | Monitor (service status, uptime, sessions/jobs, usage, consult status) | US 53–56, 58, 103 | ☐ | |
| MT-06 | Tenant config mgmt (global settings KV, feature flags, ASR pipeline, engine select, load-by-id) | US 57, 61, 62, 66 | ☐ | |
| MT-07 | Select working tenant for super/global admin | AC; US 57 | ☐ | |

### Area B — User & Access Control (per tenant)
| Suite | Requirement summary | Source | Available now? (Y/P/N) | Notes |
|-------|---------------------|--------|------------------------|-------|
| UAC-01 | Create user (username + password) | US 26 | ☐ | |
| UAC-02 | Update user (profile, department) | US 27, 111 | ☐ | |
| UAC-03 | Role management (assign, custom roles, policies, hierarchy, tenant-scoped, no-escalation, system-protect) | US 27, 36–42; AC | ☐ | |
| UAC-04 | Activate / Deactivate user | US 29; AC | ☐ | |
| UAC-05 | Destroy (archive/soft-delete) user | US 29; AC | ☐ | |

---

## 8. Defect Reporting Template (copy per defect)

```
Defect ID:           QA-ADM-____
Test case:           <e.g., MT-02.3>
Requirement source:  <e.g., US 63>
Environment:         <url / build / date>
Account used:        <persona / username / role / tenant>
Preconditions:       <state before steps>
Steps to reproduce:  1) ... 2) ... 3) ...
Expected:            <from the case>
Actual:              <what happened>
Evidence:            <screenshot / audit-log id / request id>
Severity:            Critical | Major | Minor
Cross-cutting flag:  <X1..X8 if a principle was violated, else none>
```
