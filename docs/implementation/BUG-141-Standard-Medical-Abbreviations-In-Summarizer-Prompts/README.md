# BUG-141: Standardize Abbreviations for Pre-Summarizer and Post-Summarizer LLM

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | change-request / feature (prompt content) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/141 (labels: change request, ALaaS; opened 2025-08-01; no comments; attachment `abbreviations_parsed.csv`, not downloaded for this review) |
| **Severity** | Low to Medium (consistency of notes) |
| **Still applicable on dev-2.2?** | Yes. Not implemented; the proposed mechanism (a docs file the prompt references) does not fit the architecture. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Supply the pre-summarizer and the final summarizer with one comprehensive list of standard medical abbreviations and symbols (sourced from the CAMC abbreviations list PDF, merged into an attached CSV) and instruct the LLM to apply them consistently. Tasks as filed: (1) create or update `docs/medical_abbreviations.md`; (2) update the prompts to reference that file. Intent: brevity, clarity and consistency of AI-generated notes.

## 2. Current State Evaluation (read 2026-10-06, `dev-2.2`)

- `docs/medical_abbreviations.md` does not exist, and no abbreviation list is carried in any seeded prompt. The v3 department bodies only say to "recognize" abbreviated forms for specific joints and labs (e.g. Rheumatology: "Recognize both expanded and abbreviated forms ... Recognising an abbreviation means understanding it when it is spoken - it never licenses recording a joint or a lab that was not mentioned") and to use "standard clinical abbreviations" in a few places (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts`). The pre-summary body (`PRE_SUMMARY_CONTENT_V3`, line 152) has no abbreviation guidance.
- A prompt cannot "reference a file in docs/": a model only sees text assembled into the prompt. Prompt content is tenant content: PromptTemplates and Agent instructions are cloned from the SYSTEM reference set at tenant creation and then tenant-owned (`00-project-context.md` "Content is cloned; configuration cascades"). The sanctioned vehicle for reusable instruction text is a composite-instruction fragment (`instruction.fragments[]`, TASK-947; precedent: the reserved `output_language_policy` fragment, `packages/types/src/agent.ts:194`, attached to every ArcaAI summary agent in `07b-arcaai-clinical-templates.ts`).
- Department configuration already has an `abbreviationDensity` hint (`low|medium|high`) in each department's `promptConfig` (`packages/database/src/prisma/db_main/seed/04-department.ts:75` and following; `packages/applications/src/services/tenant/departmentDefaults.ts`), but it carries no abbreviations and no prompt consumes it as a list.
- Interaction with DNA: per-clinician DNA reports describe abbreviation habits (the issue-129 DNA analysis lists "BP -", "Rx -"). A global abbreviation list that forces one style would fight the doctor's own style pass (TASK-1034), so the list must define the vocabulary only, with the DNA pass deciding density.
- Interaction with safety rules: v3 RULE 6 repairs mangled medicine names and RULE 7 forbids inventing content; abbreviating dosing text (for example "qd", "q.d.", "U", "QOD") is a known medication-error risk (Joint Commission "Do Not Use" list). A blanket "apply these abbreviations" instruction needs an exclusion list for dose and unit terms.
- Size: department bodies are about 15-21 KB each and the pre-summary about 12.7 KB. A full CAMC list (hundreds of entries) added to every call costs tokens on every summary; the prompt budget work (TASK-995, TASK-1000) shows token cost matters on the dev GPU estate.
- Licensing: the CAMC PDF is another organisation's document; redistributing it in the repo or seed needs a decision. (Not verified: the CSV was not opened.)

## 3. Root Cause / Gap

Feature never built. The issue's design (file in `docs/` referenced from a prompt) is not implementable; an equivalent needs a content artifact that reaches the prompt as text.

## 4. Implementation Plan

1. Owner decisions first (section 5).
2. Tests first (RED): a seed test that (a) the abbreviation fragment exists in the SYSTEM reference set and is attached to each ArcaAI summary and pre-summary agent, (b) the rendered instruction contains the do-not-abbreviate list and does not exceed the agreed token budget, (c) `output_language_policy`-style parity: tenants cloned from the reference set receive it (`26-tenant-reference-set.ts` parity contract test).
3. File order: curated list as data in `packages/database/src/prisma/db_main/seed/` (new `07*-abbreviations-fragment.ts`) -> fragment attached in `07b-arcaai-clinical-templates.ts` / agent seeds -> `TenantReferenceSetService` copy path unchanged (fragments ride with the agent) -> reference-set sync for existing tenants -> optional human-readable copy in `docs/architecture/` for maintainers, labelled non-authoritative.
4. Verification: only the new seed test; one replay comparing a note before/after for abbreviation consistency and for no abbreviated doses.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Direction. The issue says apply abbreviations consistently; the #117 thread earlier asked for more concise notes. Should the model abbreviate everything on the list or only recognise it (as v3 does for joints and labs)?
- OD-2: Subset. Use the full merged list, or a curated clinical subset per department? Per-department lists could ride on `Department.promptConfig`, not a global fragment.
- OD-3: Licensing of the CAMC list and the CSV.
- OD-4: Do-not-abbreviate set for doses, frequencies and units.
- OD-5: Pre-summary and final summary only, or the live per-flush sections as well (token cost on every flush).
- Risk: more tokens per call; abbreviation conflicts with DNA style and with the English-only note policy (TASK-1001).

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#141 after review of hope-v2 `dev-2.2`. |
