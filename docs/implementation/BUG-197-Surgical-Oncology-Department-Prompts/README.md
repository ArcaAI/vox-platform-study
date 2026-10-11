# BUG-197 — Surgical Oncology department prompts (New/Referral + Post-Op Review) with DNA overlay

| Field | Value |
|---|---|
| Status | Pending |
| Type | feature (enhancement) — verification / closure |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/197 (OPEN, 2025-10-07; enhancement, ALaaS) |
| Severity | Low |
| Proposed verdict | Fixed for templates and DNA slot; "Content DNA profile pending" is the open item |

## 1. Requirement Analysis
Two Surgical Oncology prompts with context variables `PREVIOUS CASE NOTES SUMMARY`, `Recent Vitals`, `same_day_prequel_summary`, `style_DNA_doctor_department_surgical_oncology` (profile "pending – to be added"); new-referral template (demographics, history, habits, ECOG, examination, MDT, PAC workup, advice, review date...) and post-op review template; log summary and fallback tier.

## 2. Current State Evaluation
- Department: `seed/04-department.ts:460-465` (SONC; new/revisit prompt ids).
- Templates: ids `seed/07b-arcaai-clinical-templates.ts:184-185`; V3 bodies `seed/07b-arcaai-clinical-content-v3.ts` (references `style_DNA_doctor_department_surgical_oncology` — 4 occurrences — and `same_day_prequel_summary`; ECOG present); library `seed/27-document-template-library.ts:855-856`.
- Content DNA profile for the department: none seeded; DNA is per-doctor (`services/dna-writing-style/`, no departmentId), so a department-named variable resolves only if a doctor report exists. Doctor then department then default tiers: only first and last exist.
- Logging of tier: obsolete; structured logging via `LoggingService`; no DNA-tier telemetry found.

## 3. Root Cause / Gap
Template delivered; the named `style_DNA_..._surgical_oncology` variable has no department-level source (shared gap, BUG-192). Whether a missing slot renders empty vs literal placeholder should be verified.

## 4. Implementation Plan
1. Test: render SONC new and revisit bodies through prompt assembly with no DNA available; assert no literal `style_DNA_` placeholder leaks and prequel/vitals blocks present (touched test file only).
2. Resolve DNA tier per BUG-192 decision; optionally emit a debug field naming the tier used.
3. Content change (if any): checksum fixture + reference-set sync caveats as in BUG-170.

## 5. Risks / Open Questions
- OD-1: who supplies the Surgical Oncology DNA corpus? OD-2: close ticket once BUG-192 tier ships?

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/197 |
