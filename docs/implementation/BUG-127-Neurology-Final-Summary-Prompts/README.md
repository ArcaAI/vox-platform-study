# BUG-127: Neurology Department Prompts (New/Referral & Review) with DNA Style Overlay

| | |
|---|---|
| **Status** | `Pending` (verification after TASK-1022 rollout) |
| **Type** | bugfix (heading fidelity of generated summary) over a feature request; labelled `enhancement` |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/127 (labels: enhancement, ALaaS; opened 2025-07-23; 2 comments) |
| **Severity** | Medium (QA-failed template; clinician-visible structure) |
| **Still applicable on dev-2.2?** | Seeded headings now match the issue; the QA failure mode (missing or misaligned headings) was addressed by TASK-1022 but is not yet QA-verified on a deployed build. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Neurology New/Referral (8 headings: Presenting Complaints; History; Clinical Examination with Mental Status, Cranial Nerves, Motor, Sensory, Reflexes, Coordination/Gait; Investigations; Diagnosis; Treatment Advice; Remarks; Plan of Care) and Review (14 headings: Diagnosis & Visit Context through Doctor's Current Instructions). Context variables, transcript priority, DNA overlay `style_DNA_doctor_department_neurology_jg`, console logging of the final summary.

Comments: QA reports the Neurology revisit summary "does not align with the expected template structure" and links the New/Review documents. In #117 QA separately listed "Neurology (NewVisit - 1 heading)" as failing.

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- Prompts: `NEUROLOGY_NEW_REFERRAL_CONTENT_V3` and `NEUROLOGY_FOLLOWUP_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:140`, `:143`), approved version 3 (`07b-arcaai-clinical-templates.ts:562`).
- Headings extracted from the bodies equal the issue: New/Referral = Presenting Complaints, History, Clinical Examination, Investigations, Diagnosis, Treatment Advice, Remarks, Plan of Care (8); Review = Diagnosis & Visit Context, Interval Since Last Visit, Previous Recommendations, Adherence Assessment, Current Symptom Assessment, Comparative Clinical Findings, Medication Effectiveness & Tolerance, New Patient Concerns, New Clinical Findings, Laboratory & Imaging Updates, Comorbidity Control Status, Vital Signs, Additional Discussion Points, Doctor's Current Instructions (14). So the prompt text is not the cause of the QA failure.
- Why headings were missing or misaligned in practice: TASK-1022 documents that the finalizer was told to keep headings it never received (its user turn was section contents joined without titles; `CASENOTE_FINALIZATION_SYSTEM_PROMPT` at `packages/database/src/prisma/db_main/seed/25-agents.ts:554`), so the model invented a layout. TASK-1022 (status Review, merged locally on `dev-2.2`, not pushed) publishes the frozen template headings to the finalizer and keeps them; a live two-visit replay passed the structural criteria (`docs/implementation/TASK-1022-Finalizer-Keeps-Template-Headings/README.md` sections 9.3-9.4).
- Omission semantics: RULE 3 omits headings with no content today. A Review note with many omitted headings can look like "missing headings" to QA; this is intended, but the document-template schema is "all keys present, `null` when absent" (`27-document-template-library.ts` header), so what the clinician sees depends on the renderer.
- DNA and console logging: same findings as BUG-121 (per-clinician DNA via `dna_style_text`, no department fallback; console logging of notes is PHI-unsafe and obsolete).
- Neurology document template shape: `27-document-template-library.ts:841-842`.

## 3. Root Cause

Structure loss was in the finalizer input (headings absent), not in the Neurology prompt; fixed by TASK-1022 pending push and QA re-test. Residual risk: omitted-empty-heading behaviour versus QA's expectation of all headings.

## 4. Implementation Plan

1. Tests first (only if QA wants the heading set pinned): a seed test asserting the two Neurology heading lists equal sections 1 lists (should already be GREEN; it is a regression pin).
2. Wait for the owner push and the cluster rollout of TASK-1022; run a Neurology new-visit and revisit replay; compare note headings with section 1 and record omitted headings with the reason.
3. If QA still sees misalignment, capture the finalizer prompt (the TASK-1020/1022 prompt-capture recipe) before changing any prompt text.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Should QA acceptance be "all headings always present" or "headings with content only"? The current product rule is the latter (RULE 3); this is the source of repeated "1 heading" failures.
- OD-2: Close once TASK-1022 is deployed and QA passes?
- Not verified: no Neurology replay on the cluster is recorded in the repo; the QA documents were not accessible; the exact "1 heading" case was not reproduced.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#127 after review of hope-v2 `dev-2.2`. |
