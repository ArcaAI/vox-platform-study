# BUG-121: Hematology Final-Summary Prompts (New/Referral & Revisit) with DNA Style Overlay

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix / change-request (prompt content + two UI notes); label on the issue is `bug` |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/121 (labels: bug, ALaaS; opened 2025-07-22; 4 comments) |
| **Severity** | Medium |
| **Still applicable on dev-2.2?** | Partially. Heading lists in the issue do not match the seeded v3 prompts; the copy-as-markdown note is an ALaaS UI defect that still exists. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Two Hematology prompts (New/Referral, Revisit) that: open with a Note to LLM, use `PREVIOUS CASE NOTES SUMMARY`, `Recent Vitals`, `same_day_prequel_summary` and a doctor DNA variable only as context, prefer the current transcript, apply Content DNA as a style overlay with Doctor -> Department -> Default fallback, and log the final summary to the console. The issue lists exact headings: New/Referral = 9 (Presenting Complaints, Referral Source, History of Presenting Illness, Family History, Treatment History (Prior to Referral), Investigations (to Date), General Examination, Diagnosis / Differential Diagnosis, Plan of Care); Revisit = 13+ (Patient Details, Oncologic Summary, Co-morbidities & Allergies, Presenting Complaints (Since Last Visit), Interim Events & Adverse Effects, Treatment History (Cumulative), Current Treatment Regimen & Cycle, Investigations (Latest + Trends), Clinical Examination, Clinical Summary of Findings, Discussion / Clinical Interpretation, Treatment Options Considered, Plan of Care ...).

Comments: reviewer (drshibuarca) edited the Hematology prompt PDF and said the revisit needs more work; owner replied the prompts were updated; QA linked the New/Revisit docs and reported that the summary shown in the AI Feedback panel is rich text but pasting it elsewhere yields raw markdown. First-person speech for doctor-to-patient recommendations was "added in Note to LLM" per a comment.

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- **Seeded prompts.** `HEMATOLOGY_NEW_REFERRAL_CONTENT_V3` and `HEMATOLOGY_REVISIT_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:110`, `:113`), approved version 3 (`07b-arcaai-clinical-templates.ts:562`).
- **Heading drift versus the issue** (headings extracted from the v3 bodies):
  - New/Referral v3 has 7: Presenting Complaints; History of Presenting Illness; Family History; Treatment History; General Examination; Diagnosis; Plan of Care. Missing versus the issue: Referral Source, Investigations (to Date); names shortened (Diagnosis vs Diagnosis / Differential Diagnosis; Treatment History vs "(Prior to Referral)").
  - Revisit v3 has 13: Patient Details; Primary Diagnosis / Co-morbidities; Presenting Complaints; History of Presenting Illness; Past Medical / Surgical History; Family History; Investigations; Clinical Summary of Findings; Discussion / Clinical Interpretation; Treatment Options Considered; Plan of Care / Further Management; Follow-up and Monitoring Strategy; Prepared By & Signatories. Different structure from the issue's list (no Oncologic Summary, Interim Events, Cumulative Treatment History, Current Regimen & Cycle).
  - The v3 corpus is a separately supplied customer set (header of `07b-arcaai-clinical-content-v3.ts`), so v3 and this issue are two sources that disagree. Which one is signed off is not recorded in the repo.
- **Rules present in v3:** third person past tense, omit empty headings (RULE 3), vitals rule, no AI authorship (RULE 9), English output. `same_day_prequel_summary` is built by `prompt-assembly.service.ts` (TASK-1020).
- **DNA overlay.** The v3 bodies contain no DNA text and no `style_DNA_*` variable. DNA is now per clinician: `dna_style_text` / `dna_style_id` flow to the finalizer instruction (`docs/implementation/TASK-1034-DNA-Weekly-Regeneration-Ingest-And-Prompt-Rules/README.md` section 2.3, proved live 2026-10-02). `DnaWritingStyle` has no Department FK since TASK-025, so the "Doctor -> Department -> Default" fallback in the issue does not exist and is not planned.
- **"Log the final summary to console".** Obsolete and unsafe: logging goes through `hope_obs` / `LoggingService` with PHI redaction (rules 05, 06); printing a clinical note to a console log would violate the PHI posture.
- **Structure fidelity.** The finalizer now receives the template headings (TASK-1022, Review, rollout after push); Hematology was one of the QA-failed templates listed in #117.
- **First person for recommendations.** Not in v3; v3 forbids anything not said by the clinician (RULE 9) and writes third person.
- **Copy as markdown (UI).** In ALaaS `apps/web_ui/components/SummaryVersions.jsx:283` the Copy button calls `navigator.clipboard.writeText(summary)` with the stored markdown; `CaseNoteDocument.jsx:130-131` also writes plain text. The EMR path converts with `marked` (`SummaryVersions.jsx:133`). HOPE emits headed Markdown by design (`apps/harness/src/harness/services/note_plan/merge.py:185`, `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:1183`), so conversion on copy is a client concern.

## 3. Root Cause

1. Two uncoordinated sources of truth for Hematology headings (customer-supplied v3 corpus versus this issue's spec); the v3 seed won and was never reconciled.
2. DNA, console logging and fallback requirements describe the retired v1 design; they are satisfied by, or replaced with, TASK-1034 and PHI-safe logging.
3. Copy button writes `text/plain` markdown; no `text/html` clipboard item is produced (ALaaS repo).

## 4. Implementation Plan

1. Owner decides OD-1 below. If the issue headings win: tests first in `packages/database/src/prisma/db_main/seed/__tests__/` asserting the extracted heading list of both Hematology bodies equals the agreed list in order (RED against current v3), plus the existing DocumentTemplate/heading parity test for the department table at `27-document-template-library.ts:845`.
2. File order: new corpus text in the generator inputs `packages/database/scripts/generate-arcaai-clinical-content-v3.mjs` (regenerate; do not hand-edit the generated file) -> add as `versionNumber 4` or replace per OD-2 (versions are never edited in place; `07b-arcaai-clinical-templates.ts` policy) -> republish tenant agents/templates (content is cloned per tenant, so a reseed does not reach existing tenants; use the reference-set sync `POST /admin/tenants/:id/reference-set/sync`).
3. ALaaS copy fix (separate repo, separate ticket): write both `text/plain` and `text/html` with `ClipboardItem`, converting through the existing `marked`.
4. Verification: only the new seed test; one cluster replay for the Hematology new and revisit.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Which heading list is authoritative for Hematology (this issue's, or seeded v3)? A reviewer said the revisit "needs more work"; no sign-off is recorded.
- OD-2: Ship as a new version 4 pinned by the approved-version constant, or edit v3? Policy says never replace older versions.
- OD-3: Doctor -> Department DNA fallback: drop (recommended; DNA is per clinician).
- OD-4: First-person patient advice: confirm the owner position from #117 (third person).
- Risk: more headings means longer outputs and more omitted-heading handling; the document template's strict schema is "all keys present, `null` when absent" (`27-document-template-library.ts` header), so RULE 3 wording must stay consistent with it.
- Not verified: the revisit PDF/Google-doc content referenced by comments was not available.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#121 after review of hope-v2 `dev-2.2` and the ALaaS `refactor-hope-integaration` checkout. |
