# BUG-117: Implement Structured LLM Prompt for SAIL-Optimized Clinical Summary Generation

| | |
|---|---|
| **Status** | `Pending` (verification and residual items only; the core was delivered under other tickets) |
| **Type** | change-request (content) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/117 (labels: enhancement, change request, ALaaS; opened 2025-07-21; 10 comments) |
| **Severity** | Medium (note quality) |
| **Still applicable on dev-2.2?** | Mostly fixed; four residual items in section 3. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Original body: embed a SAIL-oriented prompt for the "Get Summary" path producing five sections (Presenting Complaints, History of Presenting Complaints, Past Medical/Surgical, Family, Discussion), omitting empty sections, third person past tense, no AI recommendations; acceptance includes a >= 90 % SAIL-rubric test harness, malformed-structure retry-once with a logged violation, and QA checks (missing family history omitted, newest-first numbering, bullets).

Comment thread adds: variable names `PREVIOUS CASE NOTES SUMMARY` and `Recent Vitals`; omit missing sections and never write "Not mentioned"; document explicitly stated negative history; maintain concise phrasing; a vitals inclusion rule (include only if recorded same day, same patient, same department, or spoken in the transcript; transcript wins); a tester asking for first-person speech and "more human-like" notes (owner declined first person for the base note, citing clinical-note convention); all rules to be copied to the department sub-issues (#121, #122, #127, #128, #129); QA reported Rheumatology, Hematology, Neurology and General Medicine templates failing heading fidelity. The last comment re-specifies the default catch-all prompt as four-heading SOAP with a `same_day_prequel_summary` input.

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- **Prompt corpus.** The 22 department x visit-type bodies plus the pre-summary are seeded in `packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts` (department bodies lines 86-149, pre-summary line 152) and wired in `07b-arcaai-clinical-templates.ts`; the approved/served version is 3 (`ARCAAI_CLINICAL_APPROVED_VERSION = 3`, `07b-arcaai-clinical-templates.ts:562`). v1 is the byte-exact v1 port, v2 added hardening (TASK-692, archived).
- **Rules from the thread are present in v3**, in every body: third person and past tense ("Write all summaries in third person and past tense"), only the doctor's instructions (RULE 9 "NO AI AUTHORSHIP"), concise phrasing, omit empty headings (RULE 3 "EMPTY IS CORRECT", forbids "not mentioned", "N/A" and placeholders), negative history only when stated today (RULE 8), and a `VITALS` paragraph equal to the owner's rule: include only if spoken today, or recorded today for this patient in this department; transcript wins on conflict. Context variable names match the thread (`PREVIOUS CASE NOTES SUMMARY`, `Recent Vitals`, `same_day_prequel_summary`).
- **Catch-all.** `07-prompt-template.ts:820-870` seeds "Catch-All SOAP" (SYSTEM tenant, pinned version 1) with the four Subjective / Objective / Assessment / Plan headings, matching the last comment. Resolved by `PromptResolutionService`; `same_day_prequel_summary` is assembled in `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` (TASK-1020).
- **Five-section a-e structure.** Superseded: department headings now come from v3 and, for the running and final note, from the frozen `DocumentTemplate` (`27-document-template-library.ts`, department table at lines 835-846). TASK-1022 made the finalizer receive and keep those headings (`docs/implementation/TASK-1022-Finalizer-Keeps-Template-Headings/README.md`, status Review, merged locally, rollout after push).
- **Language.** Notes are English; output language is tenant-managed via the reserved `output_language_policy` fragment (`packages/types/src/agent.ts:194`, TASK-1001). v3 states "THE NOTE IS WRITTEN ENTIRELY IN ENGLISH".
- **Retry on malformed structure (AC 5).** No generate-then-retry-once-with "adhere to the structure" injection was found. The harness has computational sensors (`apps/harness/src/harness/sensors/computational/schema_validity.py`, `coverage_omission.py`), and the structured-output envelope work (TASK-1046) constrains shape, but a heading-conformance retry and a "structure violation" analytics log were not located.
- **SAIL rubric harness (AC 4).** A search for `SAIL` in `apps/` and `packages/` code returns only prompt text; no rubric-scoring test exists.

## 3. Root Cause / Remaining Gap

The ticket's mechanism (one catch-all five-section prompt) was replaced by per-department prompts, document templates and a harness. Residual items:

1. **No automated structure/heading conformance retry or violation log** (AC 5 and the QA "simulate LLM failure" case).
2. **No SAIL rubric evaluation** (AC 4, >= 90 %); no agreed rubric file or scorer.
3. **Heading-fidelity failures reported by QA** for Rheumatology, Hematology, Neurology, General Medicine: addressed by TASK-1022 but not yet verified by QA on a deployed build. Separately, the seeded v3 headings differ from the sub-issue specs for Hematology, Rheumatology and General Medicine revisit (see BUG-121, BUG-128, BUG-129).
4. **First-person doctor-to-patient recommendations** (tester request, repeated in #121): not in v3; v3 is third person only, and RULE 9 forbids anything the clinician did not say.

Unverified risk: whether `Recent Vitals` and prior-note context actually reach the prompt variables on every path (a TASK-981 live proof recorded that some context did not reach prompt variables; confirm against current `prompt-assembly.service.ts` before relying on the VITALS rule in practice).

## 4. Implementation Plan

1. Tests first (RED): a unit test that feeds a malformed finalizer output (missing/renamed heading) to the structure check and expects exactly one retry and one counted `structure_violation` log event; a seed test asserting every v3 body contains the vitals rule and RULE 3 (the corpus tests under `seed/__tests__/` are the model).
2. Order: (a) decide whether the retry belongs in `apps/harness` (finalizer step, `apps/harness/src/harness/services/note_plan/`) or the applications live lane; (b) implement the heading check against the frozen document template headings; (c) rubric scorer as an eval fixture under `apps/harness/src/harness/eval/` only if OD-2 says yes.
3. Verification: run only the new test files; one cluster replay of a revisit with QA (the TASK-1022 replay recipe).

## 5. Risks / Open Questions (owner decisions)

- OD-1: Close the issue as superseded by v3 + TASK-1022, tracking only items 1-2 in a new ticket?
- OD-2: Is a SAIL rubric scorer still wanted? It needs a clinician-owned rubric; the linked SAIL tool is an external Word document.
- OD-3: First person for recommendations: the owner ruled third person is correct for clinical notes; confirm that this stands for patient-directed advice.
- OD-4: "More human-like notes to reduce English" contradicts the current English-only note policy (TASK-1001); treat as obsolete unless the owner reverses it.
- Risk: a retry doubles LLM cost on the finalizer; heading check must read the frozen template, never the model output, to avoid circularity.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#117 after review of hope-v2 `dev-2.2`. |
