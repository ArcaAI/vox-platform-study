# BUG-394: Pre-Summary Fills Every Section With Generic Negative Placeholders

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (pre-summary quality) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/394 (ArcaAI/ALaaSv3.0) |
| **Severity** | High (the feature produces no usable content) |
| **Classification** | Config (prompt body) primarily; data-plumbing dependency on the client sending `previous_case_notes`. Not a code defect in the template engine. |
| **Still applicable on dev-2.2?** | Probably fixed by the rebuilt v3 pre-summary prompt and the client-context reader; must be re-verified with the same patient on the current build. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

The pre-consult summary shows the template headers but every section reads "No specific", "No confirmed", "None reported" and so on, although the patient has historical case notes. Expected: real extracted clinical data from the notes, and no filler. Reproduce: open a patient with historical notes, trigger Pre-summary, observe placeholder text. (Screenshot in the issue.)

## 2. Current State Evaluation

- The prompt that produced placeholders is the pre-rebuild corpus (issue era 2025-12). The current seeded pre-summary is `PRE_SUMMARY_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:152`), rebuilt 2026-08-13 (`b377575ad`) "after review against a real generated snapshot". Binding rules in it directly forbid the observed behaviour:
  - "Omit what is absent - never fill it ... Never write 'not available', 'not mentioned', 'none', 'nil'..." and "omit the heading entirely when it has no content".
  - "Silence is not a negative finding: never write a negative statement ... unless a supplied record explicitly states it."
  - "Empty inputs are absent inputs ... do not comment on its absence."
  - Output limited to five fixed headings; self-check item 5/6: no negative finding, no placeholder, no empty heading.
- Data plumbing: the pre-summary reads the client's `previous_case_notes` and `vitals` through the shared reader (`packages/applications/src/services/consultation/context/client-clinical-context.ts:393`, `pre-summary.processor.ts:204-216`) and falls back to `CASE_NOTE` context items; with neither it throws "No case notes available for pre-summary generation" (`pre-summary.processor.ts:198-200`), so an all-empty input would fail rather than render placeholders. The earlier bug "clinical context not reaching the prompt" was TASK-652 (archived) and the TASK-951/1020 client-context work.
- Residual risk found: variable defaults inject literal placeholder strings into the prompt - `safe_vitals` -> `'Not available'`, `safe_age/dob/gender` -> `'Unknown'` (`packages/applications/src/services/consultation/prompt/pre-summary-variables.ts:128-133`). The v3 prompt tells the model to treat blank as absent, but `Not available` is not blank, so a weaker model can echo it. The v1 seed template still carries `Recent Vitals: {{context.safe_vitals}} (two most recent encounters)` (`07-prompt-template.ts:424`).
- The per-tenant department prompts (`07b-arcaai-clinical-content-v2/v3.ts`) are tenant content cloned at tenant creation; an older cloned tenant copy (deployed before the v3 refresh) can still carry the old body, since content never re-reads SYSTEM at runtime (00-project-context "Content is cloned").

## 3. Root Cause

Prompt/config: the old pre-summary body let the model emit placeholder negatives when it could not find a section's facts (or the notes did not reach it). Plausibly closed by v3; the deployed tenant copy must be checked. Secondary: injected `Not available` / `Unknown` defaults invite echo.

## 4. Implementation Plan

1. **Verify (no code):** on the dev cluster, check the ArcaAI tenant's `case-notes-pre-summary` agent version and its template body for the "Omit what is absent" clause (read the DB via the postgres MCP, read-only). If stale, republish through the admin API (content is cloned; republish freezes fragments, per the TASK-1001 lessons) - owner approval for the write.
2. **Replay:** run a pre-summary on a patient with historical notes (use an existing playground consultation) and capture the prompt (no model change).
3. **Test first (only if residual risk is confirmed):** `pre-summary-variables.test.ts` asserting that empty vitals render as the empty string rather than `Not available` for the dept-free variant (goldens for the frozen v1 surface exist: update deliberately).
4. **Change (small):** make absent vitals/demographics render `''` for the `dept-free` variant; keep v1 defaults for the frozen surface. Add a pre-summary guard test: model output containing the forbidden placeholders is flagged by a sensor (the harness already has computational guards; reuse, do not add a second stack).
5. Verification: `pnpm --filter @arcaai/applications test` on the touched file only (per owner rule: no directory/regression runs by lanes).

## 5. Risks and Open Questions

- OQ-1: does the tenant's deployed pre-summary agent still run the pre-rebuild body? (Fixes this issue with a republish, no code.)
- OQ-2: is ALaaS sending `previous_case_notes` at open? If notes arrive as `CASE_NOTE` items only, the dedup logic (`clientCaseNoteRenderings`) applies; confirm in a captured prompt.
- Risk: changing default strings touches golden fixtures of a frozen surface.
- Model dependency: a small model may still emit negatives; the guard sensor is the backstop.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #394 (read-and-document lane); no code changed. |
