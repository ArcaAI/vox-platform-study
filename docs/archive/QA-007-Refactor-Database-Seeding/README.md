# QA-007: Refactor Database Seeding System

**Ticket Number**: QA-007
**Created Date**: 2026-02-25
**Last Updated**: 2026-02-25
**Status**: Pending

---

## Requirement Analysis

### Business Context

The current database seeding system has grown organically across 12 seed files with ~6,000 lines of code. While functional, it has several structural issues that need addressing:

1. **Inconsistent constant sourcing** — Multiple seed files declare local `DEFAULT_TENANT_ID`/`SYSTEM_USER_ID` instead of importing from `00-constants.ts`
2. **Execution order vs FK dependencies** — Departments (step 4) reference prompt template IDs seeded later (step 7)
3. **Incomplete department coverage** — 3 departments (DIET, NEPH, SONC) exist in seed data but lack exported constants
4. **Missing system account** — No dedicated non-interactive system account; `SYSTEM_USER_ID` points to a UUID not backed by a real User record
5. **Incomplete promptConfig structure** — Current `promptConfig` only has `contextVariables`, `preferredSections`, `abbreviationDensity` but lacks the 3 dedicated configuration groups for pre-summarization, new-visit/referral, and revisit
6. **Fragmented pre-summary prompts** — 15 department-specific pre-summary prompts with one-line placeholder content, when the knowledge base defines a single comprehensive template (`pre-summary-template.md`) designed to be the **default for all departments/users within a tenant**, using `{current_department}` variable for department-aware prioritization
7. **Shallow consultation data** — Consultation content uses placeholder text rather than realistic clinical data
7. **No DNA writing style report content** — DNA reports have structural data but lack realistic `styleText` and `reportData`
8. **No historical case notes** — Missing the doctor-authored case notes needed for DNA writing style generation testing
9. **Missing prompt template alignment** — Seed prompt templates don't fully align with the 12 department templates documented in `knowledge/PROMPT_TEMPLATES/`

### Acceptance Criteria

- [ ] System account (non-interactive, `isServiceAccount: true`) exists as a real User record
- [ ] Super admin account exists with global role assignment (`tenantId: null`)
- [ ] Global settings cover all 3 customer tenants with complete configuration
- [ ] Roles and policies include both system/default and custom/extendable variants
- [ ] At least 3 tenants with tenant administrators and full tenant configuration (including STT settings)
- [ ] Departments follow exactly the 12 department templates from `knowledge/PROMPT_TEMPLATES/` plus catch-all
- [ ] Each department has assigned users with appropriate roles and policies
- [ ] `promptConfig` contains 3 dedicated configuration groups: pre-summarization, new-visit/referral, revisit
- [ ] A single unified pre-summary template (from `knowledge/PROMPT_TEMPLATES/pre-summary-template.md`) is seeded as the tenant-level default for all departments
- [ ] API keys are linked to interactive users with specific scopes
- [ ] Prompt templates and versions align with `knowledge/PROMPT_TEMPLATES/` (12 departments × 2 visit types + system + utility)
- [ ] Prompt-department assignments are complete for all 12 template-backed departments
- [ ] Realistic consultation dummy data with proper clinical content
- [ ] Historical case notes by doctors for DNA writing style report generation testing
- [ ] Realistic DNA writing style reports with complete `reportData` and `styleText`
- [ ] All existing tests pass after refactoring
- [ ] Test fixtures updated to use new seed constants
- [ ] `seed.test.ts` updated to validate all new seed data

---

## Current State Evaluation

### Existing Seed Architecture

```
seed/
├── 00-constants.ts          # 408 lines — All shared IDs
├── 01-policy.ts             # 296 lines — 12 CASL policies
├── 02-apikey.ts             # 156 lines — 6 API keys
├── 03-role.ts               # 210 lines — 7 roles
├── 04-department.ts         # 321 lines — 18 departments
├── 05-tenant.ts             # 53 lines  — 4 tenants
├── 06-stt.ts                # 1159 lines — 20 AI models, 7 pipelines, 22 settings
├── 07-prompt-template.ts    # ~2219 lines — 51 templates + versions
├── 08-dna-writing-style.ts  # 431 lines — 6 reports, 7 versions, usage records
├── 09-consultation.ts       # 1037 lines — 10 consultations, 24 context items
├── 10-audit-log.ts          # 294 lines — 10 audit entries
├── 11-global-setting.ts     # 249 lines — 30 settings (10 per tenant)
├── 91-user.ts               # 786 lines — 13 users, profiles, settings
└── index.ts                 # Orchestrator
```

### Identified Issues

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | `SYSTEM_USER_ID` (`60000000-...`) is referenced as `createdBy` everywhere but has no User record | High | System account operations have no traceable actor |
| 2 | `super_admin` has role assignment but no explicit `tenantId: null` for global access | Medium | May not correctly represent cross-tenant access |
| 3 | Departments DIET, NEPH, SONC use inline IDs not exported in `00-constants.ts` | Medium | Tests can't reference these departments |
| 4 | `promptConfig` lacks 3-group structure (pre-summary, new-visit, revisit configs) | High | Doesn't match actual business workflow |
| 4b | 15 department-specific pre-summary prompts are one-line placeholders; knowledge base defines a single unified template with `{current_department}` variable substitution | High | Pre-summarization uses wrong/incomplete prompts |
| 5 | Execution order: Departments (step 4) before Prompt Templates (step 7) | Low | Works via deferred FK but is logically wrong |
| 6 | Multiple files declare local `DEFAULT_TENANT_ID` instead of importing | Medium | Violates single source of truth |
| 7 | Consultation content uses placeholder clinical text | Medium | Not suitable for E2E or integration testing |
| 8 | No historical case notes for DNA generation testing | High | Can't test DNA writing style pipeline |
| 9 | DNA reports have minimal `reportData` | Medium | Can't test DNA style application in summaries |
| 10 | Missing departments from `knowledge/PROMPT_TEMPLATES/` (Dietetics, Nephrology, Surgical Oncology have templates but incomplete seed setup) | Medium | Prompt template system not fully testable |

### Related Components & Dependencies

| Component | Path | Impact |
|-----------|------|--------|
| Seed constants | `packages/database/src/prisma/db_main/seed/00-constants.ts` | Central — all seed files import from here |
| Seed test suite | `packages/database/src/__tests__/seed.test.ts` | 185 tests validating seed data structure |
| Test fixtures | `tests/fixtures/` | Re-exports seed constants for test use |
| SDK hook tests | `packages/agentic-sdk-v2/src/hooks/__tests__/*.test.ts` | Use inline mock data (low impact) |
| Prompt resolution | `packages/applications/src/services/consultation/prompt/` | Consumes `promptConfig`, prompt IDs |
| DNA service | `packages/applications/src/services/dna-writing-style/` | Consumes DNA reports, case notes |

---

## Implementation Plan

### Architecture Decisions

#### 0. Unified Pre-Summary Template (Tenant-Level Default)

**Discovery**: The knowledge base (`knowledge/PROMPT_TEMPLATES/pre-summary-template.md`) defines a **single, comprehensive pre-summary template** that is designed to serve as the default for all departments and users within a tenant. The current seed has 15 fragmented department-specific pre-summary prompts with one-line placeholder content.

**Current state** (15 separate prompts):
```
prompt_pre_summary_general    → "Summarize the following case notes..."
prompt_pre_summary_cardiology → "...Focus on cardiac history, ECG findings..."
prompt_pre_summary_surgery    → "...Focus on surgical history..."
...
```

**New state** (1 unified template + department variable):

The pre-summary template from the knowledge base is a single prompt with these template variables:
- `{current_department}` — Department name (used to prioritize notes from that department)
- `{visit_type}` — Visit type context
- `{safe_age}`, `{safe_dob}`, `{safe_gender}` — Patient demographics
- `{safe_vitals}` — Two most recent vital signs
- `{formatted_test_results}` — Lab/test results
- `{formatted_previous_visits}` — Historical visit data
- `{language_name}` — Output language (with strict localization rules)

**Output format** (5 fixed sections):
```
- Confirmed & Provisional Diagnoses:
- Investigations (Latest Dept Note):
- Diagnostics & Trends:
- Plan of Care (Latest Dept Note):
- Medications Prescribed (Latest Dept Note):
```

**Strategy**:
1. Seed **one** `PromptTemplate` record with the full pre-summary template content from the knowledge base
   - ID: `TEMPLATE_IDS.PRE_SUMMARY_DEFAULT` (new UUID-based ID, e.g., `71000000-0000-0000-0000-000000000040`)
   - Category: `SYSTEM`
   - Name: `Pre-Summary Default Template`
   - Variables: `{ current_department, visit_type, safe_age, safe_dob, safe_gender, safe_vitals, formatted_test_results, formatted_previous_visits, language_name }`
   - Tags: `['system', 'pre-summary', 'default', 'tenant-level']`
   - `departmentId: null` (not department-specific)
   - `tenantId: SEED_TENANT_ID` (global default)

2. **Keep the 15 department-specific pre-summary prompt records** but update their content to be meaningful department-specific overrides (for tenants that want to customize). Mark them with tag `['pre-summary', 'department-override', '<dept>']`.

3. **Update all departments** to point `preSummaryPromptId` to the unified template by default:
   - All departments: `preSummaryPromptId → TEMPLATE_IDS.PRE_SUMMARY_DEFAULT`
   - Department-specific overrides remain available for tenants that customize

4. **Update `promptConfig.preSummarization`** to reference the unified template:
   ```json
   "preSummarization": {
       "promptId": "71000000-0000-0000-0000-000000000040",
       "contextVariables": [
           "current_department", "visit_type",
           "safe_age", "safe_dob", "safe_gender",
           "safe_vitals", "formatted_test_results",
           "formatted_previous_visits", "language_name"
       ],
       "outputSections": [
           "Confirmed & Provisional Diagnoses",
           "Investigations (Latest Dept Note)",
           "Diagnostics & Trends",
           "Plan of Care (Latest Dept Note)",
           "Medications Prescribed (Latest Dept Note)"
       ],
       "maxCaseNotes": 8,
       "lookbackMonths": 12,
       "temperature": 0.2,
       "maxTokens": 800
   }
   ```

**Rationale**:
- The knowledge base template is department-aware via `{current_department}` — it already handles "prioritize notes from {current_department}" internally
- One template is easier to maintain, version, and update across all departments
- Tenant-level default means all departments in a tenant share the same pre-summary behavior unless explicitly overridden
- Department-specific overrides are still possible for specialized needs (e.g., Radiology focusing on imaging, ER on triage)
- The structured output format (5 sections) is consistent regardless of department

#### 1. Enhanced `promptConfig` Structure

The current `promptConfig` is flat:
```json
{
    "contextVariables": [...],
    "preferredSections": [...],
    "abbreviationDensity": "low"
}
```

The new structure will have 3 dedicated configuration groups matching the business workflow:

```json
{
    "preSummarization": {
        "promptId": "71000000-0000-0000-0000-000000000040",
        "contextVariables": [
            "current_department", "visit_type",
            "safe_age", "safe_dob", "safe_gender",
            "safe_vitals", "formatted_test_results",
            "formatted_previous_visits", "language_name"
        ],
        "outputSections": [
            "Confirmed & Provisional Diagnoses",
            "Investigations (Latest Dept Note)",
            "Diagnostics & Trends",
            "Plan of Care (Latest Dept Note)",
            "Medications Prescribed (Latest Dept Note)"
        ],
        "maxCaseNotes": 8,
        "lookbackMonths": 12,
        "temperature": 0.2,
        "maxTokens": 800
    },
    "newVisit": {
        "promptId": "71000000-0000-0000-0000-000000000010",
        "contextVariables": ["PREVIOUS CASE NOTES SUMMARY", "Recent Vitals"],
        "preferredSections": ["presenting_complaints", "history_of_present_illness", ...],
        "abbreviationDensity": "medium",
        "temperature": 0.1,
        "maxTokens": 6000,
        "jsonSchema": { ... }
    },
    "revisit": {
        "promptId": "71000000-0000-0000-0000-000000000011",
        "contextVariables": ["PREVIOUS CASE NOTES SUMMARY", "Recent Vitals", "same_day_prequel_summary"],
        "preferredSections": ["interval_since_last_visit", "review_of_previous_plan", ...],
        "abbreviationDensity": "medium",
        "temperature": 0.1,
        "maxTokens": 6000,
        "jsonSchema": { ... }
    }
}
```

**Rationale**: This structure:
- Maps 1:1 to the 3 prompt types in `PromptResolutionService` (`pre-summary`, `new-patient`, `revisit`)
- Embeds hyperparameters per stage (temperature, maxTokens)
- Includes the JSON output schema per stage for validation
- Preserves backward compatibility — the top-level `preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId` fields remain as the primary FK references; `promptConfig` becomes the extended configuration

#### 2. System Account Strategy

Create a real User record for `SYSTEM_USER_ID` with:
- `username: '__system__'`
- `isServiceAccount: true`
- `password: null` (non-interactive)
- Role: `SERVICE_ACCOUNT`
- No `lastLoginAt` (never logs in)

This makes all `createdBy: SYSTEM_USER_ID` references traceable.

#### 3. Execution Order Fix

New order respecting actual FK dependencies:

```
1.  Policies          (no deps)
2.  Tenants           (no deps)
3.  Roles             (needs policies)
4.  Prompt Templates  (no deps — moved before departments)
5.  Departments       (needs tenants + prompt templates)
6.  STT               (no deps)
7.  Users             (needs roles, tenants, departments)
8.  API Keys          (needs users)
9.  Global Settings   (needs tenants)
10. DNA Writing Style (needs users, departments, prompts)
11. Consultations     (needs users, departments)
12. Audit Log         (needs everything — last)
```

#### 4. Department Alignment with Prompt Templates

The 12 departments from `knowledge/PROMPT_TEMPLATES/` that have full template support:

| # | Code | Department | Template Source |
|---|------|-----------|----------------|
| 1 | `BREN` | Breast & Endocrine | `breast-endocrine/template.md` |
| 2 | `MED` | General Medicine | `medicine/template.md` |
| 3 | `HEME` | Hematology | `hematology/template.md` |
| 4 | `RHEUM` | Rheumatology | `rheumatology/template.md` |
| 5 | `NEUR` | Neurology | `neurology/template.md` |
| 6 | `SURG` | Surgery | `surgery/template.md` |
| 7 | `ORTH` | Orthopedics | `orthopedics/template.md` |
| 8 | `DIET` | Dietetics | `dietetics/template.md` |
| 9 | `DERM` | Dermatology | `dermatology/template.md` |
| 10 | `NEPH` | Nephrology | `nephrology/template.md` |
| 11 | `SONC` | Surgical Oncology | `surgical-oncology/template.md` |
| 12 | `SOAP` | Catch-All (SOAP) | `catchall/template.md` |

Plus 6 departments without full templates (use SOAP fallback): GEN, CARD, RAD, LAB, PSYCH, PEDS, ER.

---

### Task Breakdown

#### Phase 1: Foundation (Constants & Core Entities)

##### Task 1.1: Refactor `00-constants.ts`

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/00-constants.ts`

**Changes**:
1. Add `SYSTEM_ACCOUNT_USER_ID` constant (reuse existing `SYSTEM_USER_ID = 60000000-...`)
2. Add missing department IDs for DIET, NEPH, SONC to `SEED_DEPARTMENT_IDS`
3. Add new prompt template IDs for Dietetics, Nephrology, Surgical Oncology (new-referral + revisit + pre-summary = 6 new IDs)
4. Add new consultation IDs for additional clinical scenarios
5. Add new context item IDs for case notes and DNA testing data
6. Add new DNA report IDs for additional doctors
7. Ensure all ID prefixes follow the documented convention
8. Remove any unused/orphaned constants

**Verification**: All existing imports still resolve; no duplicate IDs.

##### Task 1.2: Refactor `01-policy.ts` — Policies

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/01-policy.ts`

**Changes**:
1. Import `SYSTEM_USER_ID` from `00-constants` (remove any local declaration)
2. Add `prompt-template-manage` policy (TENANT scope) — manage prompt templates within tenant
3. Add `global-settings-manage` policy (GLOBAL scope) — manage global settings
4. Add `audit-log-read` policy (TENANT scope) — read audit logs
5. Verify all 15 policies have correct CASL rules
6. Ensure idempotent upsert pattern

**New policies summary**:

| Policy | Scope | Rules |
|--------|-------|-------|
| `prompt-template-manage` | TENANT | manage PromptTemplate where tenantId matches |
| `global-settings-manage` | GLOBAL | manage GlobalSetting |
| `audit-log-read` | TENANT | read AuditLog where tenantId matches |

##### Task 1.3: Refactor `05-tenant.ts` — Tenants

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/05-tenant.ts`

**Changes**:
1. Import all constants from `00-constants` (remove local declarations)
2. Add tenant descriptions and metadata
3. Ensure each tenant has distinct configuration profile:
   - `__GLOBAL__` — System-wide default, no specific config
   - `ARCAAI` — Full-featured, all features enabled, production-like
   - `4BITS` — Minimal config, some features disabled, testing edge cases
   - `MUMBAI_HOSPITAL` — Multi-department, multi-language (English + Hindi)

##### Task 1.4: Refactor `03-role.ts` — Roles & Policy Assignments

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/03-role.ts`

**Changes**:
1. Import from `00-constants` exclusively
2. Add new policy assignments for the 3 new policies
3. Ensure role hierarchy is complete:
   - `SUPER_ADMIN` → system-full-access, rbac-system-manage, global-settings-manage
   - `TENANT_ADMIN` → tenant-full-access, rbac-tenant-manage, rbac-delegate, user-profile-own, prompt-template-manage, audit-log-read
   - `DOCTOR` → consultation-own-manage, user-profile-own, api-key-own-manage
   - `NURSE` → consultation-read-assigned, user-profile-own
   - `SERVICE_ACCOUNT` → service-integration, federated-learning-access
   - `DEPARTMENT_HEAD` (extends DOCTOR) → + consultation-department-read, rbac-delegate
   - `SENIOR_NURSE` (extends NURSE) → + consultation-department-read

---

#### Phase 2: Prompt Templates & Departments

##### Task 2.1: Refactor `07-prompt-template.ts` — Align with Knowledge Base

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/07-prompt-template.ts`

**Changes**:
1. Import all constants from `00-constants`
2. **Add unified Pre-Summary Default Template** (`PRE_SUMMARY_DEFAULT`):
   - ID: `71000000-0000-0000-0000-000000000040`
   - Content: Full text from `knowledge/PROMPT_TEMPLATES/pre-summary-template.md`
   - Category: `SYSTEM`
   - Variables: `{ current_department, visit_type, safe_age, safe_dob, safe_gender, safe_vitals, formatted_test_results, formatted_previous_visits, language_name }`
   - Tags: `['system', 'pre-summary', 'default', 'tenant-level']`
   - `departmentId: null`, `tenantId: SEED_TENANT_ID`
3. **Update existing 15 department-specific pre-summary prompts**: Replace one-line placeholder content with meaningful department-specific override content. These serve as optional overrides for tenants that want department-customized pre-summaries. Tag them `['pre-summary', 'department-override', '<dept>']`.
4. Ensure all 12 department template pairs exist (new-referral + revisit = 24 department-specific templates)
5. Add system templates: System Default, SMR Base, Emergency, Pediatrics, Cardiology, Psychiatry
6. Add utility templates: JSON Enforcement, Corrective Retry, Previous Visit System, Catch-All SOAP
7. Add DNA Analysis template
8. Each template must have:
   - Correct `category` (SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM)
   - Correct `departmentId` FK where applicable
   - Realistic `content` matching the knowledge base templates
   - `variables` JSON listing expected template variables
   - A v1 `PromptVersion` record

**Template inventory (52 total)**:

| Category | Count | Templates |
|----------|-------|-----------|
| SYSTEM | 9 | System Default, SMR Base, Emergency, Pediatrics, Cardiology, Psychiatry, **Pre-Summary Default (unified)**, Pre-Summary System, Previous Visit System |
| SUMMARY | 17 | SOAP Summary, Catch-All SOAP, **15 department-specific pre-summary overrides** |
| DNA_ANALYSIS | 1 | DNA Writing Style Analysis |
| CUSTOM | 26 | 12 dept × 2 visit types (new + revisit) = 24 dept-specific + 2 utility (JSON Enforcement, Corrective Retry) |

**Pre-Summary Template Hierarchy** (resolution order):
```
1. Department-specific override (if tenant has customized)
   └─ e.g., prompt_pre_summary_cardiology (focuses on ECG, cardiac history)
2. Unified Pre-Summary Default Template (tenant-level default)
   └─ PRE_SUMMARY_DEFAULT — uses {current_department} for department-aware prioritization
3. System fallback
   └─ SYSTEM_DEFAULTS.promptId = "prompt_default"
```

##### Task 2.2: Refactor `04-department.ts` — Enhanced promptConfig + Unified Pre-Summary

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/04-department.ts`

**Changes**:
1. Import all constants from `00-constants` (remove local declarations)
2. Export all 18 departments with IDs from constants
3. **Update all departments' `preSummaryPromptId`** to point to the unified `PRE_SUMMARY_DEFAULT` template (`71000000-0000-0000-0000-000000000040`). This is the tenant-level default that uses `{current_department}` for department-aware prioritization.
4. Implement the new 3-group `promptConfig` structure for each department, with `preSummarization.promptId` pointing to the unified template
5. Ensure all 12 template-backed departments have complete prompt configuration
6. Non-template departments (RAD, LAB, PSYCH, PEDS, ER, GEN, CARD) use SOAP fallback for new-visit/revisit but still use the unified pre-summary template

**Example promptConfig for Surgery (SURG)**:

```json
{
    "preSummarization": {
        "promptId": "71000000-0000-0000-0000-000000000040",
        "contextVariables": [
            "current_department", "visit_type",
            "safe_age", "safe_dob", "safe_gender",
            "safe_vitals", "formatted_test_results",
            "formatted_previous_visits", "language_name"
        ],
        "outputSections": [
            "Confirmed & Provisional Diagnoses",
            "Investigations (Latest Dept Note)",
            "Diagnostics & Trends",
            "Plan of Care (Latest Dept Note)",
            "Medications Prescribed (Latest Dept Note)"
        ],
        "maxCaseNotes": 8,
        "lookbackMonths": 12,
        "temperature": 0.2,
        "maxTokens": 800
    },
    "newVisit": {
        "promptId": "71000000-0000-0000-0000-000000000010",
        "contextVariables": ["PREVIOUS CASE NOTES SUMMARY", "Recent Vitals"],
        "preferredSections": [
            "patient_demographics", "risk_factors_and_exposures",
            "personal_and_reproductive_history", "family_history",
            "presenting_complaints", "history_of_present_illness",
            "past_medical_and_surgical_history", "treatment_history",
            "medications_and_allergies", "physical_examination",
            "investigations", "diagnosis", "plan_of_care",
            "patient_education_and_consent"
        ],
        "abbreviationDensity": "medium",
        "temperature": 0.1,
        "maxTokens": 6000,
        "jsonSchema": {
            "patient_demographics": "string (markdown)",
            "risk_factors_and_exposures": "string (markdown)",
            "personal_and_reproductive_history": "string (markdown)",
            "family_history": "string (markdown)",
            "presenting_complaints": "string (markdown)",
            "history_of_present_illness": "string (markdown)",
            "past_medical_and_surgical_history": "string (markdown)",
            "treatment_history": "string (markdown)",
            "medications_and_allergies": "string (markdown)",
            "physical_examination": "string (markdown)",
            "investigations": "string (markdown)",
            "diagnosis": "string (markdown)",
            "plan_of_care": "string (markdown)",
            "patient_education_and_consent": "string (markdown)"
        }
    },
    "revisit": {
        "promptId": "71000000-0000-0000-0000-000000000011",
        "contextVariables": ["PREVIOUS CASE NOTES SUMMARY", "Recent Vitals", "same_day_prequel_summary"],
        "preferredSections": [
            "patient_identifiers", "interval_since_last_visit",
            "review_of_previous_plan_and_adherence",
            "presenting_complaints_and_updates",
            "clinical_examination_updates", "investigations_compared",
            "treatment_history_and_response", "new_findings_and_complications",
            "plan_of_care_current", "follow_up_and_monitoring_strategy",
            "patient_education_and_consent", "prepared_by_and_signatories"
        ],
        "abbreviationDensity": "medium",
        "temperature": 0.1,
        "maxTokens": 6000,
        "jsonSchema": {
            "patient_identifiers": "string (markdown)",
            "interval_since_last_visit": "string (markdown)",
            "review_of_previous_plan_and_adherence": "string (markdown)",
            "presenting_complaints_and_updates": "string (markdown)",
            "clinical_examination_updates": "string (markdown)",
            "investigations_compared": "string (markdown)",
            "treatment_history_and_response": "string (markdown)",
            "new_findings_and_complications": "string (markdown)",
            "plan_of_care_current": "string (markdown)",
            "follow_up_and_monitoring_strategy": "string (markdown)",
            "patient_education_and_consent": "string (markdown)",
            "prepared_by_and_signatories": "string (markdown)"
        }
    }
}
```

**All 18 departments** will have `preSummarization.promptId` pointing to the unified pre-summary template (`71000000-0000-0000-0000-000000000040`). The 12 template-backed departments additionally have fully populated `newVisit` and `revisit` groups with `preferredSections` and `jsonSchema` matching exactly the fields documented in `knowledge/PROMPT_TEMPLATES/<department>/template.md`.

**Pre-Summary Prompt Assignment (all departments)**:

| Department | `preSummaryPromptId` (column) | `promptConfig.preSummarization.promptId` |
|------------|-------------------------------|------------------------------------------|
| All 18 departments | `71000000-...-000000000040` (unified) | `71000000-...-000000000040` (unified) |

The unified template handles department-specific prioritization via `{current_department}` variable substitution at runtime. Department-specific pre-summary overrides (the existing `prompt_pre_summary_*` slugs) remain in the database as available alternatives for tenants that need specialized pre-summary behavior.

---

#### Phase 3: Users, API Keys & Settings

##### Task 3.1: Refactor `91-user.ts` — System Account + Enhanced Users

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/91-user.ts`

**Changes**:
1. **Create System Account** (`SYSTEM_USER_ID`):
   - `username: '__system__'`
   - `isServiceAccount: true`
   - `password: null` (or empty hash — non-interactive)
   - Role: `SERVICE_ACCOUNT` with global scope (`tenantId: null`)
   - Profile: `firstName: 'System'`, `lastName: 'Account'`, `email: 'system@arcaai.internal'`
   - No `lastLoginAt`, no `lastActiveAt`

2. **Enhance Super Admin**:
   - Ensure role assignment has `tenantId: null` (global access)
   - Add profile with `firstName: 'Super'`, `lastName: 'Admin'`

3. **Add Tenant Administrators per tenant**:
   - `tenant_admin` → Default tenant (already exists)
   - `arcaai_admin` → ArcaAI tenant (already exists)
   - Add `fourbits_admin` → 4bits tenant (NEW)
   - Add `mumbai_admin` → Mumbai Hospital tenant (NEW)

4. **Add department-specific doctors for new departments**:
   - Add `doctor_diet` (Dietetics) — for DIET department
   - Add `doctor_neph` (Nephrology) — for NEPH department
   - Add `doctor_sonc` (Surgical Oncology) — for SONC department
   - Add `doctor_derm` (Dermatology) — for DERM department
   - Add `doctor_heme` (Hematology) — for HEME department
   - Add `doctor_rheum` (Rheumatology) — for RHEUM department
   - Add `doctor_bren` (Breast & Endocrine) — for BREN department
   - Add `doctor_med` (General Medicine) — for MED department (reassign from dept_head)

5. **Add nurses per department** (at least 2):
   - Existing `nurse` (Sarah Williams) → General Practice
   - Existing `senior_nurse` (Emily Davis) → Surgery
   - Add `nurse_card` → Cardiology
   - Add `nurse_med` → General Medicine

6. **SDK Preferences** for each new doctor:
   - `workflowMode`, `language`, `dnaStyleId`, `localConfig`, `primaryDepartmentId`

**User summary after refactoring (20+ users)**:

| # | Username | Role | Tenant | Department |
|---|----------|------|--------|------------|
| 1 | `__system__` | SERVICE_ACCOUNT | null (global) | — |
| 2 | `super_admin` | SUPER_ADMIN | null (global) | — |
| 3 | `tenant_admin` | TENANT_ADMIN | Default | — |
| 4 | `arcaai_admin` | TENANT_ADMIN | ArcaAI | — |
| 5 | `fourbits_admin` | TENANT_ADMIN | 4bits | — |
| 6 | `mumbai_admin` | TENANT_ADMIN | Mumbai Hospital | — |
| 7 | `doctor` (John Smith) | DOCTOR | Default | GEN |
| 8 | `doctor2` (Jane Doe) | DOCTOR | Default | CARD |
| 9 | `department_head` (Michael Johnson) | DEPARTMENT_HEAD | Default | MED |
| 10 | `doctor_surgery` (Raj Patel) | DOCTOR | Default | SURG |
| 11 | `doctor_neuro` (Lisa Chen) | DOCTOR | Default | NEUR |
| 12 | `doctor_peds` (Maria Garcia) | DOCTOR | Default | PEDS |
| 13 | `doctor_er` (James Wilson) | DOCTOR | Default | ER |
| 14 | `doctor_bren` (Priya Sharma) | DOCTOR | Default | BREN |
| 15 | `doctor_rheum` (David Park) | DOCTOR | Default | RHEUM |
| 16 | `doctor_heme` (Aisha Khan) | DOCTOR | Default | HEME |
| 17 | `doctor_derm` (Carlos Rivera) | DOCTOR | Default | DERM |
| 18 | `doctor_diet` (Mei Lin) | DOCTOR | Default | DIET |
| 19 | `doctor_neph` (Omar Hassan) | DOCTOR | Default | NEPH |
| 20 | `doctor_sonc` (Elena Volkov) | DOCTOR | Default | SONC |
| 21 | `nurse` (Sarah Williams) | NURSE | Default | GEN |
| 22 | `senior_nurse` (Emily Davis) | SENIOR_NURSE | Default | SURG |
| 23 | `nurse_card` (Tom Brown) | NURSE | Default | CARD |
| 24 | `nurse_med` (Amy Lee) | NURSE | Default | MED |
| 25 | `service_account` | SERVICE_ACCOUNT | Default | — |

##### Task 3.2: Refactor `02-apikey.ts` — Scoped API Keys

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/02-apikey.ts`

**Changes**:
1. Import all constants from `00-constants`
2. Ensure all API keys are linked to interactive users (not service accounts for SDK keys)
3. Add specific scopes to each key:

| Key | Type | User | Scopes | Status |
|-----|------|------|--------|--------|
| SDK Doctor Key | SDK | doctor (Smith) | `["consultation:*", "summary:*", "dna:read"]` | ACTIVE |
| SDK Doctor2 Key | SDK | doctor2 (Doe) | `["consultation:*", "summary:*", "dna:read"]` | ACTIVE |
| SDK Surgery Key | SDK | doctor_surgery | `["consultation:*", "summary:*", "dna:*"]` | ACTIVE |
| Webhook Admin Key | WEBHOOK | tenant_admin | `["webhook:*", "notification:*"]` | ACTIVE |
| Integration Key | INTEGRATION | arcaai_admin | `["consultation:read", "summary:read", "user:read"]` | ACTIVE |
| Service Account Key | SERVICE_ACCOUNT | service_account | `["stt:*", "model:*", "pipeline:*"]` | ACTIVE |
| ArcaAI SDK Key | SDK | arcaai_admin | `["consultation:*", "summary:*", "dna:*", "prompt:*"]` | ACTIVE |
| Revoked Test Key | SDK | doctor | `["consultation:read"]` | REVOKED |
| Expired Test Key | SDK | doctor2 | `["consultation:read"]` | EXPIRED |

##### Task 3.3: Refactor `11-global-setting.ts` — Complete Tenant Configuration

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/11-global-setting.ts`

**Changes**:
1. Import from `00-constants`
2. Expand settings per tenant to cover all configuration areas:

**Per-tenant settings (15 per tenant × 3 tenants = 45 total)**:

| Namespace | Key | Type | Default | Description |
|-----------|-----|------|---------|-------------|
| `general` | `max-concurrent-sessions` | Integer | 10 | Max concurrent recording sessions |
| `general` | `default-language` | String | "en" | Default conversation language |
| `general` | `session-timeout-minutes` | Integer | 30 | Session inactivity timeout |
| `general` | `max-upload-size-mb` | Integer | 100 | Max audio upload size |
| `general` | `retention-days` | Integer | 365 | Data retention period |
| `feature-flags` | `enable-real-time-transcription` | Boolean | true | Real-time STT |
| `feature-flags` | `enable-dna-style` | Boolean | true | DNA writing style |
| `feature-flags` | `enable-cross-chain-summary` | Boolean | false | Cross-chain summarization |
| `feature-flags` | `enable-ner-extraction` | Boolean | true | Named entity recognition |
| `feature-flags` | `enable-code-switching` | Boolean | false | Multi-language support |
| `feature-flags` | `enable-pre-summary` | Boolean | true | Pre-summarization stage |
| `stt` | `default-stt-model` | String | "whisper-large-v3" | Default STT model |
| `stt` | `vad-sensitivity` | Float | 0.5 | Voice activity detection sensitivity |
| `stt` | `default-pipeline-slug` | String | "production-v1" | Default ASR pipeline |
| `stt` | `noise-reduction-enabled` | Boolean | true | Noise reduction preprocessing |

**Tenant-specific overrides**:
- **ArcaAI**: All features enabled, `max-concurrent-sessions: 50`, `retention-days: 730`
- **4bits**: `enable-dna-style: false`, `enable-cross-chain-summary: false`, `max-concurrent-sessions: 5`
- **Mumbai Hospital**: `default-language: "en"` (but supports Hindi), `enable-code-switching: true`, `max-concurrent-sessions: 20`

##### Task 3.4: Refactor `06-stt.ts` — STT Settings (Minor)

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/06-stt.ts`

**Changes**:
1. Import all constants from `00-constants` (remove local declarations)
2. Verify all AI model slugs are consistent with pipeline YAML references
3. No major structural changes needed — this file is already comprehensive

---

#### Phase 4: Clinical Data (Consultations, Case Notes, DNA)

##### Task 4.1: Refactor `09-consultation.ts` — Realistic Clinical Data

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/09-consultation.ts`

**Changes**:
1. Import from `00-constants`
2. Expand to 15+ consultations covering all major departments
3. Add realistic clinical content for each consultation type

**Consultation matrix**:

| # | Patient | Doctor | Department | Visit Type | Status | Chain |
|---|---------|--------|------------|------------|--------|-------|
| 1 | PAT-001 | doctor (Smith) | GEN | NEW_PATIENT | CLOSED | Root |
| 2 | PAT-001 | doctor (Smith) | GEN | REVISIT | OPEN | → #1 |
| 3 | PAT-002 | doctor2 (Doe) | CARD | NEW_PATIENT | REVIEW | Root |
| 4 | PAT-002 | doctor2 (Doe) | CARD | REVISIT | OPEN | → #3 |
| 5 | PAT-003 | doctor_surgery | SURG | NEW_PATIENT | CLOSED | Root |
| 6 | PAT-003 | doctor_surgery | SURG | REVISIT | OPEN | → #5 |
| 7 | PAT-004 | doctor_neuro | NEUR | REFERRAL | CLOSED | Root |
| 8 | PAT-005 | doctor_bren | BREN | NEW_PATIENT | CLOSED | Root |
| 9 | PAT-006 | doctor_rheum | RHEUM | NEW_PATIENT | CLOSED | Root |
| 10 | PAT-006 | doctor_rheum | RHEUM | REVISIT | REVIEW | → #9 |
| 11 | PAT-007 | doctor_heme | HEME | NEW_PATIENT | CLOSED | Root |
| 12 | PAT-008 | doctor_derm | DERM | NEW_PATIENT | CLOSED | Root |
| 13 | PAT-009 | doctor_diet | DIET | NEW_PATIENT | CLOSED | Root |
| 14 | PAT-010 | doctor_neph | NEPH | NEW_PATIENT | CLOSED | Root |
| 15 | PAT-011 | doctor_sonc | SONC | NEW_PATIENT | CLOSED | Root |
| 16 | PAT-005 | doctor_peds | PEDS | NEW_PATIENT | CLOSED | Root |
| 17 | PAT-012 | doctor_er | ER | NEW_PATIENT | RECORDING | Root |
| 18 | PAT-002 | doctor_neuro | NEUR | REFERRAL | OPEN | → #3 (cross-dept) |

**Each consultation must have**:
- Realistic `TRANSCRIPT` context item with doctor-patient dialogue
- `RAW_SUMMARY` for completed consultations (JSON matching department schema)
- `PRE_SUMMARY` where applicable
- `CASE_NOTE` items for chain consultations
- `AUDIO_RECORDING` for select consultations
- `SummaryMeta` for AI-generated summaries
- `NamedEntity` records for NER-processed consultations

**Realistic clinical content guidelines**:
- Transcripts: 500-2000 word doctor-patient dialogues with realistic medical terminology
- Summaries: Valid JSON matching the department's `jsonSchema` from `promptConfig`
- Case notes: 200-500 word clinical observations
- NER: 5-10 entities per consultation with ICD-10, RxNorm, SNOMED codes

##### Task 4.2: Add Historical Case Notes for DNA Testing

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/09-consultation.ts`

**Changes**:
Add historical case notes (CASE_NOTE context items) for at least 3 doctors to support DNA writing style generation testing:

**Doctor Smith (GEN) — 5 historical case notes**:
- Each 300-500 words of clinical documentation
- Written in Dr. Smith's style: formal, detailed, low abbreviation usage
- Cover different conditions: hypertension management, diabetes follow-up, respiratory infection, musculoskeletal complaint, preventive care

**Doctor Patel (SURG) — 5 historical case notes**:
- Surgical documentation style: concise, procedure-focused, medium abbreviation usage
- Cover: hernia repair follow-up, appendectomy pre-op, wound assessment, post-op day 1, surgical planning

**Doctor Doe (CARD) — 5 historical case notes**:
- Cardiology style: structured, investigation-heavy, medium abbreviation usage
- Cover: chest pain evaluation, heart failure follow-up, arrhythmia management, post-stent review, cardiac rehabilitation

Each case note should be a `CASE_NOTE` context item attached to the doctor's consultations, with realistic clinical language that demonstrates the doctor's unique writing patterns.

##### Task 4.3: Refactor `08-dna-writing-style.ts` — Realistic DNA Reports

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts`

**Changes**:
1. Import from `00-constants`
2. Expand to 8+ DNA reports covering more doctors
3. Add realistic `reportData` and `styleText` content

**DNA Report structure**:

```json
{
    "reportData": {
        "analysisMetadata": {
            "sampleCount": 5,
            "totalWordCount": 2500,
            "analyzedAt": "2026-02-20T10:00:00Z",
            "modelUsed": "gpt-4o"
        },
        "styleAttributes": {
            "formality": 0.85,
            "sentenceLength": { "average": 18.5, "stdDev": 6.2 },
            "medicalTermUsage": 0.72,
            "abbreviationStyle": "selective",
            "abbreviationDensity": 0.15,
            "passiveVoiceRatio": 0.45,
            "thirdPersonConsistency": 0.95
        },
        "vocabularyProfile": {
            "uniqueTerms": 342,
            "medicalTermFrequency": { "common": 0.6, "specialized": 0.3, "rare": 0.1 },
            "preferredTerms": ["presented with", "examination revealed", "plan of care includes"],
            "avoidedTerms": ["patient says", "I think", "maybe"]
        },
        "structurePreferences": {
            "sectionOrdering": ["presenting_complaints", "history", "examination", "diagnosis", "plan"],
            "bulletPointUsage": 0.7,
            "numberedListUsage": 0.3,
            "paragraphLength": { "average": 3.2, "preference": "medium" }
        },
        "documentationPatterns": {
            "negativeHistoryStyle": "explicit_only",
            "medicationFormat": "generic_name_first",
            "doseFormat": "mg_bd_notation",
            "dateFormat": "DD/MM/YYYY",
            "vitalSignsFormat": "structured_table"
        }
    },
    "styleText": "Dr. Smith writes in a formal, structured clinical style..."
}
```

**DNA Reports to seed**:

| # | Doctor | Department | isLatest | Style Summary |
|---|--------|------------|----------|---------------|
| 1 | doctor (Smith) | GEN | false | Old report (superseded) |
| 2 | doctor (Smith) | GEN | true | Formal, detailed, low abbreviation, explicit negative history |
| 3 | doctor2 (Doe) | CARD | true | Structured, investigation-focused, medium abbreviation |
| 4 | department_head (Johnson) | MED | true | Comprehensive, teaching-style, low abbreviation |
| 5 | doctor_surgery (Patel) | SURG | true | Concise, procedure-focused, medium abbreviation |
| 6 | doctor_neuro (Chen) | NEUR | true | Detailed neurological, systematic, low abbreviation |
| 7 | doctor_bren (Sharma) | BREN | true | Thorough, reproductive-history-aware, medium abbreviation |
| 8 | doctor_rheum (Park) | RHEUM | true | Joint-count-focused, lab-value-heavy, medium abbreviation |

Each report should have:
- Realistic `reportData` JSON with all fields populated
- 200-400 word `styleText` describing the doctor's writing patterns
- At least v1 `DnaWritingStyleVersion`
- `DnaUsageRecord` linking to a consultation
- `PromptUsageRecord` linking to the DNA analysis prompt template

##### Task 4.4: Refactor `10-audit-log.ts` — Expanded Audit Trail

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/10-audit-log.ts`

**Changes**:
1. Import from `00-constants`
2. Expand to 15+ audit entries covering:
   - Authentication events (login success, login failure, logout)
   - User management (create, update role, disable)
   - Consultation lifecycle (create, update, close, reopen)
   - Summary generation (pre-summary, final summary)
   - DNA report generation
   - API key management (create, revoke)
   - Global settings changes

---

#### Phase 5: Orchestration & Execution Order

##### Task 5.1: Refactor `index.ts` — Correct Execution Order

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/index.ts`

**Changes**:
Update execution order to respect FK dependencies:

```typescript
async function main() {
    // Phase 1: Independent entities (no FK deps)
    await seedPolicy(prisma);
    await seedTenant(prisma);

    // Phase 2: Depends on Phase 1
    await seedRole(prisma);          // needs policies
    await seedPromptTemplate(prisma); // no FK deps, but needed by departments

    // Phase 3: Depends on Phase 2
    await seedDepartment(prisma);    // needs tenants + prompt templates
    await seedStt(prisma);           // no FK deps

    // Phase 4: Depends on Phase 3
    await seedUser(prisma);          // needs roles, tenants, departments
    await seedApiKey(prisma);        // needs users
    await seedGlobalSetting(prisma); // needs tenants

    // Phase 5: Depends on Phase 4
    await seedDnaWritingStyle(prisma); // needs users, departments, prompts
    await seedConsultation(prisma);    // needs users, departments

    // Phase 6: Depends on everything
    await seedAuditLog(prisma);      // needs all entities
}
```

---

#### Phase 6: Test Updates

##### Task 6.1: Update `seed.test.ts` — Validate New Seed Data

**Files**:
- Modify: `packages/database/src/__tests__/seed.test.ts`

**Changes**:
1. Update policy tests to validate 15 policies (was 12)
2. Update role tests to validate new policy assignments
3. Update department tests to validate:
   - 18 departments (all with exported constants)
   - New 3-group `promptConfig` structure
   - `jsonSchema` validation per department matching knowledge base
4. Update prompt template tests to validate 51 templates
5. Update user tests to validate 25+ users
6. Update API key tests to validate 9 keys with scopes
7. Update DNA report tests to validate 8 reports with full `reportData`
8. Update consultation tests to validate 18+ consultations with realistic content
9. Update global settings tests to validate 45 settings (15 per tenant)
10. Update audit log tests to validate 15+ entries
11. Add cross-reference integrity tests:
    - Every `preSummaryPromptId` in departments references a valid prompt template
    - **All departments point to the unified pre-summary template by default**
    - The unified pre-summary template contains all required variables (`current_department`, `visit_type`, `safe_age`, `safe_dob`, `safe_gender`, `safe_vitals`, `formatted_test_results`, `formatted_previous_visits`, `language_name`)
    - The unified pre-summary template output format contains all 5 sections
    - Every `newPatientPromptId` references a valid prompt template
    - Every `revisitPromptId` references a valid prompt template
    - Every `promptConfig.preSummarization.promptId` matches the department's `preSummaryPromptId`
    - Every `promptConfig.*.jsonSchema` matches the knowledge base template
    - Every user's `primaryDepartmentId` references a valid department
    - Every API key's `userId` references a valid user
    - Every DNA report's `doctorId` references a valid user

##### Task 6.2: Update Test Fixtures

**Files**:
- Modify: `tests/fixtures/index.ts` (if exists)

**Changes**:
1. Re-export all new constants from `00-constants.ts`
2. Add new fixture factories:
   - `createDepartmentHeadFixture(options?)`
   - `createSeniorNurseFixture(options?)`
   - `createServiceAccountFixture(options?)`
   - `createConsultationWithContextFixture(options?)`
   - `createDnaReportFixture(options?)`

##### Task 6.3: Update SDK Hook Tests (if impacted)

**Files**:
- Review: `packages/agentic-sdk-v2/src/hooks/__tests__/*.test.ts`

**Changes**:
- SDK hook tests use inline mock data, so impact should be minimal
- Verify no tests import directly from `00-constants.ts`
- Update any tests that reference removed/renamed constants

##### Task 6.4: Update Knowledge Documentation

**Files**:
- Modify: `knowledge/database/seed-data.md`

**Changes**:
1. Update all entity counts and tables
2. Document the new 3-group `promptConfig` structure
3. Update the execution order diagram
4. Add the new users, API keys, and consultation matrix
5. Update the test coverage section

---

### Best Practices Applied

| Practice | Implementation |
|----------|---------------|
| **Single Source of Truth** | All IDs in `00-constants.ts`; no local declarations in seed files |
| **Idempotent Seeding** | All seed files use `upsert` or `findFirst` + create/update pattern |
| **FK-Correct Ordering** | Execution order strictly follows foreign key dependencies |
| **Realistic Test Data** | Clinical content uses actual medical terminology and realistic scenarios |
| **Complete Coverage** | Every department with a template has full prompt configuration |
| **Traceable System Actions** | System account is a real User record; all `createdBy` references resolve |
| **Multi-Tenant Testing** | 3 customer tenants with distinct configurations for edge case testing |
| **Role Hierarchy** | System roles are immutable; tenant-extendable roles inherit from parents |
| **Versioned Content** | All prompt templates and DNA reports have v1 versions |
| **Audit Trail** | Comprehensive audit log covering all major system events |
| **Defense in Depth** | Cross-reference integrity validated in tests |

### Business Workflow Coverage

| Workflow | Seed Data Coverage |
|----------|--------------------|
| **New Patient Consultation** | 12 departments × new-patient consultations with transcripts, summaries |
| **Revisit/Follow-up** | 4+ consultation chains with parent-child relationships |
| **Cross-Department Referral** | CARD → NEUR referral chain |
| **Pre-Summarization** | Unified pre-summary template (from knowledge base) as tenant-level default; pre-summary context items on completed consultations; department-specific overrides available |
| **DNA Writing Style Generation** | 15+ historical case notes across 3 doctors |
| **DNA Style Application** | DNA reports with realistic `styleText` used in summary generation |
| **NER Extraction** | Named entities with medical coding (ICD-10, RxNorm, SNOMED) |
| **API Key Authentication** | 9 keys with specific scopes across SDK, webhook, integration, service types |
| **RBAC Authorization** | 7 roles with 15 policies covering all permission patterns |
| **Multi-Tenant Isolation** | 3 tenants with distinct settings and user assignments |
| **Consultation Chain Summary** | Cross-chain comprehensive summary with linked consultations |

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Run full test suite after each phase; update tests incrementally |
| Seed execution time increase | Keep realistic content concise; use bulk operations where possible |
| `promptConfig` schema change | Backward-compatible — old flat structure still works; new structure is additive |
| Missing cross-references | Comprehensive integrity tests in `seed.test.ts` |
| Large file sizes | Consider splitting `09-consultation.ts` into sub-modules if > 3000 lines |

---

## Implementation Summary

*To be updated after implementation.*

---

## Change History

*To be updated with subsequent changes.*
