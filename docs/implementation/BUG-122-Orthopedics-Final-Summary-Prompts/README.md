# BUG-122: Orthopedics Department Prompts (New/Referral & Review) with DNA Style Overlay

| | |
|---|---|
| **Status** | `Pending` (verification only) |
| **Type** | feature / change-request (prompt content) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/122 (labels: enhancement, ALaaS; opened 2025-07-22; 1 comment, QA doc links only) |
| **Severity** | Low |
| **Still applicable on dev-2.2?** | Fixed in substance; remaining items are two documented deliberate deviations and a live check. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Add Orthopedics final-summary prompts for New/Referral and Review visits. Both: Note to LLM, third person past tense, English, only the doctor's instructions, context variables (`PREVIOUS CASE NOTES SUMMARY`, `Recent Vitals`, `same_day_prequel_summary`) used as context only, apply DNA `style_DNA_doctor_department_orthopedics_np`, log the final summary to console. New/Referral headings (10): Patient Details; Chief Complaints; History of Illness; Past History; Personal History; Examination (Inspection, Palpation, ROM, Special Tests, Neurovascular); Provisional Diagnosis (ICD-10 coded); Investigations Ordered; Treatment Plan; Review Date. Review headings (6): Patient Details; Current Complaints; Clinical Findings; Investigations Reviewed; Current Plan; Next Review Date.

The only comment contains QA links to the New/Revisit documents; no failure was reported against Orthopedics in the thread (QA's failed-template list in #117 does not name Orthopedics).

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- `ORTHOPEDICS_NEW_REFERRAL_CONTENT_V3` and `ORTHOPEDICS_REVIEW_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:104`, `:107`), served at approved version 3 (`07b-arcaai-clinical-templates.ts:562`).
- Heading lists extracted from the bodies match the issue exactly: New/Referral = the same 10 headings in the same order; Review = the same 6.
- Deliberate deviation: the issue says Provisional Diagnosis is "ICD-10 coded". v2/v3 removed code-authoring instructions (RULE 7: "Never record a diagnostic code - state the diagnosis in words only; codes are attached separately from a verified terminology source"; TASK-702 Icd10-Prompt-Containment). Following the issue literally would re-introduce hallucination risk, and a seed test (`seed/__tests__/arcaai-clinical-version-policy.test.ts`) fails if the approved pin lands on a body that instructs a code.
- DNA: the v3 bodies carry no DNA text; the clinician's style reaches the finalizer through `dna_style_text` (TASK-1034 README section 2.3). Department-level DNA fallback does not exist (DNA is per doctor, TASK-025). The `_np` variable name belongs to the retired v1 design.
- Console logging of the final summary: obsolete and PHI-unsafe (see BUG-121 section 2).
- Other rules (empty heading omitted, negative history only if stated, vitals rule, transcript beats prior notes) are in the shared protocol block of every v3 body.
- Structure of the live and final note comes from the frozen DocumentTemplate built from these headings (`27-document-template-library.ts:843-844`), and TASK-1022 makes the finalizer keep them.

## 3. Root Cause

None outstanding for content. The issue is a feature request that was delivered by the v2/v3 corpus. Residual: the ICD-10 conflict (intentional) and absence of a recorded live verification for Orthopedics specifically.

## 4. Implementation Plan

1. Tests first: none new needed for headings (an existing seed corpus test covers shape; add a single assertion that the Orthopedics heading lists equal this issue's lists only if the owner wants it pinned).
2. Verification: one cluster replay (ArcaAI Orthopedics tenant department) for a new visit and a review; compare headings to section 1 and confirm no ICD code is written. Run only the touched seed test file.
3. Close the issue after the replay; no code change expected.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Confirm ICD-10 stays out of the model output (recommended; codes attached from a verified terminology source).
- OD-2: Close as delivered by the v3 corpus once a replay is recorded?
- Not verified: no Orthopedics-specific live run was found in the repo docs; the QA documents linked in the comment were not accessible.
- Tenants that existed before v3 only get the new body after a reference-set sync/republish (content is cloned, not resolved from SYSTEM at runtime, `00-project-context.md`).

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#122 after review of hope-v2 `dev-2.2`. |
