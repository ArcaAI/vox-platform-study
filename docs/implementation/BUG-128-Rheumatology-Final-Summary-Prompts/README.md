# BUG-128: Rheumatology Department Prompts (New/Referral & Review) with DNA Style Overlay

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (QA-failed template: heading names/casing do not match the spec); issue label is `bug` |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/128 (labels: bug, ALaaS; opened 2025-07-23; 4 comments) |
| **Severity** | Medium |
| **Still applicable on dev-2.2?** | Yes for heading naming and casing. The markdown/emoji output and "bold alternate headings" comments describe older behaviour or an ALaaS UI defect. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Rheumatology New/Referral (12 headings, ALL CAPS: PRESENTING COMPLAINTS, CURRENT ISSUES, PAST HISTORY, TREATMENT HISTORY, PERSONAL HISTORY, FAMILY HISTORY, GENERAL EXAMINATION, LOCAL EXAMINATION, DIAGNOSIS, PLAN, PtGH, REMARKS) and Review (10: DIAGNOSIS, DISEASE ACTIVITY, CURRENT ISSUES, Rx REVIEW, REVIEW ON, TESTS TO DO, ADVICE, PLAN, CONSULTATION NOTES, LAB REPORTS). DNA variable `style_DNA_doctor_department_rheumatology_vc` (Dr. Vishnu Chandran: long compound sentences, ALL-CAPS headers, "Diagnosis -", "Rx -" patterns). Context variables, Doctor -> Department -> Default DNA fallback, summaries audit-ready.

Comments: QA listed Rheumatology (New and Review) as failing the template structure (via #117); QA pasted a Revisit output with emoji heading "Rheumatology | Review Encounter Note", bold headings, "ICD-10 Code(s): Not provided", and only 4 sections; QA asked for the alternate-heading-bold rendering to be fixed and later marked it "Resolved".

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- Prompts: `RHEUMATOLOGY_NEW_REFERRAL_CONTENT_V3` and `RHEUMATOLOGY_FOLLOWUP_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:92`, `:95`), approved version 3 (`07b-arcaai-clinical-templates.ts:562`).
- **Heading drift versus the issue** (extracted from the bodies):
  - New/Referral v3 (12): Symptoms; Current Issues; Past History; Treatment History; Personal History; Family History; General Examination; Local Examination; Impression; Plan; Patient Global Health (PtGH); Remarks. Differences: "Symptoms" vs PRESENTING COMPLAINTS; "Impression" vs DIAGNOSIS; "Patient Global Health (PtGH)" vs PtGH; Title Case and bold markup vs ALL CAPS.
  - Review v3 (10): Diagnosis; Disease Activity; Current Issues; Medication Review (Rx); Review On; Tests to Do; Advice; Plan; Consultation Notes; Lab Reports. Differences: "Medication Review (Rx)" vs "Rx REVIEW"; Title Case vs ALL CAPS.
  - Counts and order match; names and casing do not. The v3 corpus is a separately supplied customer set, so this issue and the seed disagree and neither is recorded as final.
- ALL-CAPS headings are described in the issue as part of the DNA of one doctor. In HOPE, the clinician style reaches the finalizer through `dna_style_text` (TASK-1034); heading text comes from the frozen DocumentTemplate (`27-document-template-library.ts:839-840`), not from DNA, so a doctor-specific casing cannot be applied through DNA without changing the template. DNA has no department fallback (TASK-025), so "Doctor -> Department -> Default" does not exist.
- QA's pasted revisit output (emoji title, "Not provided", 4 sections) reflects the pre-v2 prompt. Today RULE 3 forbids "not mentioned/not provided/N/A" placeholders and an emoji title is not in the corpus; this symptom is likely fixed (not re-run).
- "Alternate headings bold": ALaaS rendering defect, marked Resolved by QA in the thread.
- Finalizer structure loss (headings not provided to the model) is addressed by TASK-1022 (Review, not pushed).
- ICD-10: not written by the model by design (RULE 7); "ICD-10 Code(s)" lines in the pasted output are therefore not expected.

## 3. Root Cause

1. Spec/seed mismatch: the headings customer-signed in v3 differ in name and casing from this issue's list.
2. Structure instability from the finalizer input (TASK-1022), fixed pending rollout.
3. Style (ALL CAPS) cannot be delivered through the per-clinician DNA path.

## 4. Implementation Plan

1. Owner picks the heading set and casing (OD-1). Tests first in `packages/database/src/prisma/db_main/seed/__tests__/`: a heading-extraction test for both Rheumatology bodies against the agreed lists (RED against current v3), plus the document-template parity test for the RHEUM row.
2. Order: update the corpus source consumed by `packages/database/scripts/generate-arcaai-clinical-content-v3.mjs` and regenerate (never hand-edit the generated content file) -> add as a new `PromptVersion` (versions are retained, `07b-arcaai-clinical-templates.ts` policy) and bump `ARCAAI_CLINICAL_APPROVED_VERSION` -> keep `27-document-template-library.ts` heading lists in sync (it derives from the bodies) -> sync existing tenants through the reference-set sync.
3. Verification: run only the changed seed test files; cluster replay of a Rheumatology new visit and a review; compare headings and confirm no placeholder lines.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Which names are authoritative: this issue's (PRESENTING COMPLAINTS, DIAGNOSIS, PtGH, Rx REVIEW) or the seeded v3 (Symptoms, Impression, Patient Global Health (PtGH), Medication Review (Rx))? Casing: ALL CAPS or Title Case?
- OD-2: If ALL CAPS is wanted for this department only, it must be a department-specific document template, not DNA.
- Risk: renaming a heading changes `sectionKey`s and the downstream template keys; a tenant with existing notes keeps its old keys.
- Not verified: the QA Google documents were not accessible; no Rheumatology replay on the cluster is documented.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#128 after review of hope-v2 `dev-2.2`. |
