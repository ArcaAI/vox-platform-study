# BUG-170 — Surgery department prompts (New/Referral + Review) with DNA style overlay

| Field | Value |
|---|---|
| Status | Pending |
| Type | feature (enhancement) — verification / closure |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/170 (OPEN, 2025-08-20; labels enhancement, ALaaS) |
| Severity | Low |
| Proposed verdict | Fixed for template + same-day prequel input; residual DNA department fallback |

## 1. Requirement Analysis
Surgery needs two final-summary prompts (new/referral, review) starting with a Note to LLM; context variables used as non-verbatim context: `PREVIOUS CASE NOTES SUMMARY` (<=8 notes/12 mo), `Recent Vitals` (last 2), `same_day_prequel_summary`; today's transcript has priority; DNA overlay (#192) doctor to department to default; log outputs; standard abbreviations (`docs/medical_abbreviations.md`). Body of the issue lists sections (biodata, complaints, comorbidities, past surgical history, family history, examination incl. abdominal/PR/local, investigations, diagnosis, plan, fitness for surgery).

## 2. Current State Evaluation
- Department: `seed/04-department.ts:255-270` (Surgery, SURG; `newPatientPromptId`=SURGERY_NEW_REFERRAL, `revisitPromptId`=SURGERY_FOLLOWUP; `promptConfig.contextVariables` lists PREVIOUS CASE NOTES SUMMARY, Recent Vitals).
- Templates: `seed/07b-arcaai-clinical-templates.ts:251-265` ("Surgery - New Referral", "Surgery - Follow-up"); V3 bodies in `seed/07b-arcaai-clinical-content-v3.ts`; library `seed/27-document-template-library.ts:837`.
- same_day_prequel_summary: all 22 department bodies reference it (35 refs in content-v3); producer is `packages/applications/src/services/consultation/harness/same-day-prequel.ts` (TASK-1020), wired in `harness-internal.service.ts:1847-1906`. Fixed.
- Prior-case-notes / vitals: `prompt/pre-summary-variables.ts`, `prompt-assembly.service.ts`.
- DNA: generic `dna_style_text` slot (`prompt-assembly.service.ts:86,631-675`); the Surgery body has no named `style_DNA_*` slot; DNA is per-doctor only (no `departmentId` in `services/dna-writing-style/`), so "department then default" tier is missing.
- Console logging: obsolete (use `LoggingService`). Abbreviation doc: not a prompt-time input in HOPE.

## 3. Root Cause / Gap
Delivered except the DNA department-tier fallback (shared with BUG-192). Owner/clinician sign-off of V3 Surgery text vs the issue's section list not located.

## 4. Implementation Plan
1. Tests: seed test that Surgery new/revisit V3 bodies reference `same_day_prequel_summary`, vitals and prior-notes variables (extend existing arcaai-clinical-templates-seed test).
2. Section diff vs issue (clinician review); edit V3 body only if owner approves; bodies are checksum-guarded (`v1-clinical-prompt-checksums.fixture.ts`) so a content change needs fixture regeneration and a SYSTEM reference-set re-sync (`POST /admin/tenants/:id/reference-set/sync`) — a deploy never refreshes seeded content on a seeded DB.
3. DNA department tier: tracked under BUG-192.

## 5. Risks / Open Questions
- OD-1: close as delivered? OD-2: does the issue's section list override the clinician-approved V3 wording? Cluster content needs hope-reset/republish to change.

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/170 |
