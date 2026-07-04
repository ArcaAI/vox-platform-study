# TASK-365 — Demo-Tenant Seed Cleanup (Remove 4bits + Mumbai)

| | |
|---|---|
| **Ticket** | TASK-365 |
| **Title** | Demo-Tenant Seed Cleanup — remove `4bits` / `Mumbai`, keep `SYSTEM` / `Global` / `ArcaAI` |
| **Type** | refactor (seed-data hygiene) |
| **Created** | 2026-06-17 |
| **Updated** | 2026-06-17 |
| **Status** | Completed |

---

## 1. Requirement Analysis

### Description
Review all seed data and decide which tenants are still needed. Remove the demo
tenants completely and clean up every seed that references them.

### Decision (confirmed with user)
- **Keep `SYSTEM_TENANT`** — architecturally required (see §3).
- **Keep `GLOBAL_TENANT`** — architecturally required (see §3).
- **Remove `4bits` (`FOURBITS`) and `Mumbai` (`MUMBAI_HOSPITAL`) completely.**
- **Keep `ArcaAI` in a minimal capacity** (`keep_arcaai_minimal`) — it is retained as
  the single customer/demo tenant that backs the cross-tenant isolation E2E suite
  (a "second tenant" used to prove 404 / scoping contracts). Removing it would
  break ~8 E2E specs and dev/RAG scripts.

### Acceptance Criteria
- [x] No live `FOURBITS` / `MUMBAI_HOSPITAL` (or `4bits` / `Mumbai`) references remain in any seed **code**.
- [x] `ArcaAI`, `Global`, and `System` seed data is untouched and intact.
- [x] All static seed-coherence tests updated to the new reality and passing.
- [x] `@arcaai/database` typechecks (tsc) and the unit suite is green.
- [x] No dangling references to deleted constants anywhere in the codebase (`.ts/.tsx/.js/.py`).

---

## 2. Why the demo tenants were safe to remove

`FOURBITS` / `MUMBAI_HOSPITAL` appeared **only** in seed files, seed-coherence tests,
and historical ticket docs. They had **zero** runtime/app/service consumers
(verified by a repo-wide code sweep). They existed purely to make multi-tenant
admin demos and impersonation/cross-tenant tests look populated.

---

## 3. Why `SYSTEM_TENANT` and `GLOBAL_TENANT` must stay

These are **not** demo data — they are load-bearing runtime infrastructure:

| Tenant | UUID | Role | Why it cannot be removed |
|---|---|---|---|
| `SYSTEM_TENANT` (`__SYSTEM__`) | `00000000-…-000000000000` | Shared platform-catalog owner | The Prisma `tenant-scope` extension special-cases `SYSTEM_TENANT_ID` so its rows (AI models, default ASR pipelines, default Harness/Pipeline policies) are **shared-read** into every tenant. Holds no customer data. |
| `GLOBAL_TENANT` (`__GLOBAL__`, `SEED_TENANT_ID` / `DEFAULT_TENANT_ID`) | `50000000-…-000000000000` | Default operational tenant | Runtime default for services, rate-limit config (`RATE_LIMIT_TENANT_ID`), pipeline-policy overrides, and the default tenant for initial clinical/demo data. |

`SYSTEM` (shared catalog) and `GLOBAL` (default operational tenant) play distinct,
non-mergeable architectural roles, so neither was touched.

---

## 4. Current State Evaluation (impact map)

Removal touched two categories of files:

- **Seed source** — tenant definitions, per-tenant ID maps, and all per-tenant data rows
  (departments, STT pipelines, prompt templates, DNA styles, consultations, audit logs,
  global settings, users / voice profiles / SDK prefs).
- **Static seed tests** — coherence tests that asserted "every customer tenant (ArcaAI/4bits/Mumbai) has …"
  invariants and per-tenant ID-count assertions.

Markdown under `docs/implementation/TASK-331|338|259/` references the demo tenants but
**documents past tickets** and was intentionally left as a historical record.

---

## 5. Implementation Summary

### Seed source (`packages/database/src/prisma/db_main/seed/`)
| File | Change |
|---|---|
| `00-constants.ts` | Removed all `FOURBITS_*` / `MUMBAI_*` keys from every ID map (tenant, user, department, consultation, context-item, voice-profile, audit-log, global-setting); kept `ARCAAI_*`. Updated UUID-convention comments. |
| `04-department.ts` | Customer GEN + specialty (CARD/ER) dept arrays → ArcaAI only. |
| `05-tenant.ts` | `CUSTOMER_TENANTS` + `TENANT_FRONTEND_CONFIGS` → ArcaAI only. |
| `06-stt.ts` | `CUSTOMER_TENANT_ASR_PIPELINES` (−6 rows) + AI-model / default-pipeline backfill lists → ArcaAI only. |
| `07-prompt-template.ts` | Customer template IDs / templates / versions → ArcaAI only. |
| `08-dna-writing-style.ts` | `CUSTOMER_DNA_CLINICIANS` and derived reports/versions/usage → ArcaAI only. |
| `09-consultation.ts` | Customer consultations + transcripts → ArcaAI NEW + REVISIT only. |
| `10-audit-log.ts` | `CUSTOMER_TENANT_AUDIT_LOGS` → ArcaAI rows only. |
| `11-global-setting.ts` | `ALL_SETTINGS` → removed 4bits/Mumbai `tenantSettings()` blocks. |
| `91-user.ts` | Removed 4bits/Mumbai users, voice profiles, SDK prefs, and dept-map keys. |

### Tests
| File | Change |
|---|---|
| `src/__tests__/seed.test.ts` | Dept count 27→21; per-tenant GEN/specialty/admin assertions → ArcaAI; `customerTenantIds`/`expectedTenantIds` arrays → ArcaAI; backfill-list counts (4→2, ≥4→≥3). |
| `src/__tests__/seed-global-settings.test.ts` | `SETTING_PREFIXES` / `PREFIXES_WITH_GENERAL` / `SEGMENT_MAP` / `TENANT_ID_BY_PREFIX` → `['ARCAAI','GLOBAL']`; `TOTAL_IDS` auto-recomputes (validates the constants removal was numerically consistent). |
| `src/__tests__/seed-smr-provider-models.test.ts` | Prefix arrays → `['GLOBAL','ARCAAI']`; unique count 4→2. |
| `src/__tests__/seed-guardrail-provider-models.test.ts` | Prefix arrays → `['GLOBAL','ARCAAI']`; unique count 4→2. |
| `src/__tests__/seed-impersonation-coverage.test.ts` | `CUSTOMER_TENANTS` → ArcaAI only. |
| `src/prisma/db_main/seed/__tests__/seed.test.ts` | `CUSTOMER_TENANTS` → ArcaAI only. |
| `packages/domains/src/entities/__tests__/TenantEntity.test.ts` | Key-format `it.each` + comment → real remaining seed keys (`__SYSTEM__`, `__GLOBAL__`, `ARCAAI`). |

### Docs
- `knowledge/database/seed-data.md` — Tenants table 4→2 with a TASK-365 note.

---

## 6. Verification (evidence)

```
pnpm --filter @arcaai/database test   → Test Files 21 passed (21) | Tests 771 passed (771)
pnpm --filter @arcaai/database build  → tsc, exit 0 (no type errors)
pnpm --filter @arcaai/domains test src/entities/__tests__/TenantEntity.test.ts → 21 passed (21)
rg "FOURBITS|MUMBAI_HOSPITAL|…"  (*.ts/tsx/js/py, whole repo) → 0 matches
rg "4bits|Mumbai|fourbits|mumbai" (seed dir) → 1 match (intentional TASK-365 note in 00-constants.ts)
```

### Deviations / Notes
- Historical ticket docs (`TASK-331`, `TASK-338`, `TASK-259`) still mention the demo
  tenants by design — they record past implementations and were not rewritten.
- The reserved `__SYSTEM__` tenant is intentionally absent from the `seed-data.md`
  Tenants table (pre-existing convention; it owns the shared catalog, not customer data).

---

## 7. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-17 | Removed `4bits` + `Mumbai` demo tenants from all seed source + tests; kept `SYSTEM`/`Global`/`ArcaAI`. Updated coherence tests and `seed-data.md`. Verified green. | See §5 |
