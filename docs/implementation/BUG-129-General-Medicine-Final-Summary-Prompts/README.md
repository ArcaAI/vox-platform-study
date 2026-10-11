# BUG-129: General Medicine Prompt Templates (New/Referral & Review) with DNA Style Overlay

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix / change-request (one heading difference, DNA design change, and an ALaaS UI copy defect); issue label is `bug` |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/129 (labels: bug, ALaaS; opened 2025-07-23; 4 comments) |
| **Severity** | Medium |
| **Still applicable on dev-2.2?** | Partially: the Review template differs from the spec by one extra heading; DNA fallback design is obsolete; copy-as-markdown still reproduces in ALaaS. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

General Medicine New/Referral (10 headings: Presenting Complaints; Past History; Family History; Drug History; Hospital Admissions; General Examination & Vitals; Previous Diagnosis; Reports; Current Diagnosis; Plan of Care) and Review (10: Last Visit Complaints; Previous Diagnosis; Current Medications; Investigations (Previous vs Current); General Examination & Vitals; Current Diagnosis; Treatment Plan; Follow-up Plan; Additional Data; Doctor's Instructions & Orders). DNA `style_DNA_doctor_department_general_medicine` (Dr. S. K. Matthew: terse fragments, abbreviations, uppercase blocks "REVIEW", "DIAGNOSIS", "Rx") with fallback Doctor -> Department -> Default; log summary and DNA fallback to console.

Comments: QA reported that the summary shows correctly in the AI Feedback panel but copy/paste keeps markdown rather than rich text (with screenshot); another comment adds a second doctor DNA overlay (`style_DNA_doctor_department_general_medicine_AT`, Dr. Ani Thampi: 87 % fragments, abbreviation density about 47 per 100 words, "BP -", "Rx -") with fallback `_AT` -> department -> default. In #117, General Medicine was among QA-failed templates ("1 heading in ReVisit").

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- Prompts: `MEDICINE_NEW_REFERRAL_CONTENT_V3` and `MEDICINE_FOLLOWUP_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:98`, `:101`), approved version 3 (`07b-arcaai-clinical-templates.ts:562`). A shared General Medicine pre-summary lineage exists in `07-prompt-template.ts` (see lines near 1711 and 1770).
- New/Referral heading list in v3 equals the issue (10, same order).
- **Review drift:** v3 has 11 headings, starting with "New Complaints" (not in the issue) and then Last Visit Complaints, Previous Diagnosis, Current Medications, Investigations (Previous vs Current), General Examination & Vitals, Current Diagnosis, Treatment Plan, Follow-up Plan, Additional Data, Doctor's Instructions & Orders. The issue's Review spec has no "New Complaints".
- **DNA.** Not in the prompt bodies. Style comes from the clinician's own DNA report through `dna_style_text` (TASK-1034 README section 2.3; live proof 2026-10-02). Because DNA is per doctor with no Department FK (TASK-025), both `style_DNA_doctor_department_general_medicine` (Dr. Matthew) and the `_AT` overlay (Dr. Thampi) are expressed simply as each doctor's own generated DNA report; the department level is not a thing, so the three-level fallback is not applicable. The statistics in the issue (sentence length, abbreviation density) are analysis output of the kind the DNA generation job computes (TASK-1034 adds the weekly schedule and admin ingest; status Review), not text to paste into a prompt.
- **Console logging of summary + DNA fallback:** obsolete and PHI-unsafe (rules 05, 06; `hope_obs` redaction).
- **Copy-as-markdown (ALaaS):** `apps/web_ui/components/SummaryVersions.jsx:283` copies with `navigator.clipboard.writeText(summary)` (raw markdown); `CaseNoteDocument.jsx:130-131` plain text. Only the EMR path converts markdown to HTML (`SummaryVersions.jsx:133`, `marked`). Reproducible by reading; not re-run.
- Structure fidelity for the Review (1 heading): TASK-1022 (finalizer keeps frozen template headings; Review, not pushed).
- General Medicine document-template row: `27-document-template-library.ts:835-836`. The platform SOAP/two-shape templates were themselves ported from the General Medicine body (comment near line 781).

## 3. Root Cause

1. Review heading list diverged from the spec: "New Complaints" was added in the v3 corpus (customer-supplied) and the issue was never updated, or vice versa.
2. DNA fallback requirement belongs to the retired design.
3. The Copy button writes only `text/plain`.
4. "1 heading" failures: finalizer input without headings (TASK-1022).

## 4. Implementation Plan

1. Decide OD-1. If "New Complaints" must go: seed test first (heading list of `MEDICINE_FOLLOWUP_CONTENT_V3` equals the 10-item list; RED), then edit the corpus input consumed by `packages/database/scripts/generate-arcaai-clinical-content-v3.mjs`, regenerate, add the new prompt version, bump the approved version, update the document-template parity (`27-document-template-library.ts`), then reference-set sync for existing tenants.
2. ALaaS (separate ticket in `ALaaSv3.0`): put both `text/plain` and `text/html` on the clipboard in `SummaryVersions.jsx` and `CaseNoteDocument.jsx`, converting with the already-present `marked`.
3. DNA: no code; document in this README that the `_AT` variable is satisfied by per-doctor DNA.
4. Verification: only the changed seed test; cluster replay of a General Medicine new and review visit; manual paste into a rich-text target for the UI fix.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Is "New Complaints" a wanted heading on the Review note (it is useful for a follow-up) or should v3 follow this issue exactly?
- OD-2: Drop the department-level DNA fallback and the two named DNA variables (recommended)?
- OD-3: ALaaS clipboard fix owner and priority (affects every department, not only this one).
- Risk: dropping a heading changes keys of the live running note; check the Medicine follow-up row of the document template before editing.
- Not verified: QA documents and screenshots not accessible; Review replay not found in docs.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#129 after review of hope-v2 `dev-2.2` and the ALaaS `refactor-hope-integaration` checkout. |
