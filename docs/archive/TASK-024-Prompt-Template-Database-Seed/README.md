# TASK-024: Prompt Template Database Seed

- **Ticket Number**: TASK-024
- **Created Date**: 2026-02-18
- **Last Updated**: 2026-02-18
- **Status**: Completed

---

## 1. Requirement Analysis

### Description
Extract all prompt templates from SMR v1 (Python service) and seed them into the `PromptTemplate` and `PromptVersion` database tables. This enables the Prompt Template management module (WS-2 of SDK-207) to serve prompts from the database instead of hardcoded Python files.

### Business Context
- The SMR v1 service has 14 department-specific prompt templates hardcoded in Python files
- The SDK-207 Feature Expansion plan requires prompts to be database-managed for versioning, CRUD, and department assignment
- The WS-2 (Prompt Template + DNA Writing Style Backend Modules) depends on having seed data available

### Acceptance Criteria
- [x] All 14 department-specific prompt templates seeded (7 departments x 2 visit types)
- [x] All system/utility prompts seeded (base, specialty overlays, JSON enforcement, retry, pre-summary)
- [x] Existing 4 placeholder templates preserved
- [x] Each template has a corresponding `PromptVersion` (v1) snapshot
- [x] Missing departments added to department seed
- [x] Existing departments wired with `newPatientPromptId` / `revisitPromptId`
- [x] Visit type terminology standardized: `revisit` (not `followup`)
- [x] No prompt content modified — exact copies from SMR v1 source

---

## 2. Current State Evaluation

### Before
- `07-prompt-template.ts`: 4 generic placeholder templates (System Default, SOAP Summary, DNA Analysis, Cardiology Custom)
- `04-department.ts`: 10 departments, only GEN and CARD had prompt IDs wired
- `prompts_json.py` / `prompt_selector.py`: Used `"followup"` as the canonical visit type key
- 14 department prompt files in `apps/smr/src/smr/models/prompts_*.py` with hardcoded content

### After
- `07-prompt-template.ts`: 27 templates (4 existing + 23 new) with matching versions
- `04-department.ts`: 15 departments (5 new: Surgery, General Medicine, Breast & Endocrine, Rheumatology, Hematology)
- All 9 departments with SMR v1 prompts have `newPatientPromptId` / `revisitPromptId` wired
- Visit type standardized to `"revisit"` across Python codebase

---

## 3. Implementation Summary

### Files Modified

| File | Change |
|------|--------|
| `packages/database/src/prisma/db_main/seed/04-department.ts` | Added 5 new departments (SURG, MED, BREN, RHEUM, HEME); wired prompt IDs for NEUR, ORTH |
| `packages/database/src/prisma/db_main/seed/07-prompt-template.ts` | Replaced with 27 templates + 27 versions covering all SMR v1 prompts |
| `apps/smr/src/smr/models/prompts_json.py` | Renamed all `"followup"` schema keys to `"revisit"`; updated `_normalize_visit_type()` |
| `apps/smr/src/smr/models/prompt_selector.py` | Updated `_normalize_visit_type()` and all `vt == "followup"` checks to `"revisit"` |

### Template Inventory (27 total)

#### System Category (9 templates)
| ID | Name | Department |
|----|------|------------|
| 01 | System Default Prompt | Global |
| 05 | SMR System Prompt - Base | Global |
| 06 | SMR System Prompt - Emergency Medicine | Emergency |
| 07 | SMR System Prompt - Pediatrics | Pediatrics |
| 08 | SMR System Prompt - Cardiology | Cardiology |
| 09 | SMR System Prompt - Psychiatry | Psychiatry |
| 24 | JSON Enforcement Note | Global |
| 25 | Corrective Retry Suffix | Global |
| 26 | Pre-Summary System Prompt | Global |
| 27 | Previous Visit Summary System Prompt | Global |

#### Summary Category (15 templates)
| ID | Name | Department | Visit Type |
|----|------|------------|------------|
| 02 | SOAP Summary Prompt | Global | — |
| 10 | Surgery - New Referral | Surgery | new_referral |
| 11 | Surgery - Revisit | Surgery | revisit |
| 12 | General Medicine - New Referral | General Medicine | new_referral |
| 13 | General Medicine - Revisit | General Medicine | revisit |
| 14 | Breast & Endocrine - New Referral | Breast & Endocrine | new_referral |
| 15 | Breast & Endocrine - Revisit | Breast & Endocrine | revisit |
| 16 | Rheumatology - New Referral | Rheumatology | new_referral |
| 17 | Rheumatology - Revisit | Rheumatology | revisit |
| 18 | Orthopedics - New Referral | Orthopedics | new_referral |
| 19 | Orthopedics - Revisit | Orthopedics | revisit |
| 20 | Neurology - New Referral | Neurology | new_referral |
| 21 | Neurology - Revisit | Neurology | revisit |
| 22 | Hematology - New Referral | Hematology | new_referral |
| 23 | Hematology - Revisit | Hematology | revisit |

#### DNA Analysis Category (1 template)
| ID | Name | Department |
|----|------|------------|
| 03 | DNA Writing Style Analysis Prompt | Global |

#### Custom Category (1 template)
| ID | Name | Department |
|----|------|------------|
| 04 | Cardiology Department Prompt | Cardiology |

### Department Additions

| Code | Name | New Patient Prompt | Revisit Prompt |
|------|------|--------------------|----------------|
| SURG | Surgery | ID 10 | ID 11 |
| MED | General Medicine | ID 12 | ID 13 |
| BREN | Breast & Endocrine | ID 14 | ID 15 |
| RHEUM | Rheumatology | ID 16 | ID 17 |
| HEME | Hematology | ID 22 | ID 23 |

### Department Updates (existing)

| Code | Name | New Patient Prompt | Revisit Prompt |
|------|------|--------------------|----------------|
| NEUR | Neurology | ID 20 | ID 21 |
| ORTH | Orthopedics | ID 18 | ID 19 |

### Visit Type Standardization

- **Before**: `_normalize_visit_type()` returned `"followup"` for review/follow-up visits
- **After**: Returns `"revisit"` for the same inputs
- All `DEPT_VISIT_SCHEMAS` keys updated: `("dept", "followup")` → `("dept", "revisit")`
- All `prompt_selector.py` comparisons updated: `vt == "followup"` → `vt == "revisit"`
- Input recognition unchanged: `"follow-up"`, `"review"`, `"fu"`, `"rv"` etc. all still recognized

### ID Convention

| Entity | Prefix | Range |
|--------|--------|-------|
| Department | `70000000-0000-0000-0000-0000000000XX` | 01–15 |
| PromptTemplate | `71000000-0000-0000-0000-0000000000XX` | 01–27 |
| PromptVersion | `72000000-0000-0000-0000-0000000000XX` | 01–27 |

---

## 4. Deployment Notes

### Running the Seed
```bash
cd packages/database
npx prisma db seed
```

### Rollback
The seed uses `upsert` operations, so re-running is idempotent. To remove the new data, a migration would need to delete records with IDs in the `71000000-*-05` through `71000000-*-27` range.

---

## 5. Related Tasks

- **SDK-207 WS-1**: Database schema (PromptTemplate, PromptVersion models) — prerequisite
- **SDK-207 WS-2**: Prompt Template management module — consumes this seed data
- **TASK-023**: SMR Text Generation Service — uses prompts at runtime
