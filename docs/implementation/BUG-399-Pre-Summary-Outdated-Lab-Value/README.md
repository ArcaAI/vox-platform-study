# BUG-399: Pre-Consult Summary Shows An Outdated Lab Value From The Latest Case Note

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (clinical accuracy of pre-summary) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/399 (ArcaAI/ALaaSv3.0) |
| **Severity** | High (the issue itself rates it High Clinical Risk) |
| **Classification** | Config (prompt) mostly; small code hardening on the structured results renderer; model-dependent |
| **Still applicable on dev-2.2?** | Partly. The v3 prompt now forces event dates and forbids provenance-date substitution, which addresses the reported failure; but it also instructs "use all dated values", which conflicts with the issue's "display only the most recent", and no code orders structured results. Needs a replay. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

When the latest case note contains a table or list of one parameter over several days (e.g. blood sugar trend), the AI picks an outdated value and presents it as current because it sits in the "latest" note. The output even says "taken from the latest case note". Expected: parse the dates inside the note and show only the most recent measurement per lab parameter.

## 2. Current State Evaluation

- **Prompt (config).** `PRE_SUMMARY_CONTENT_V3` (`packages/database/src/prisma/db_main/seed/07b-arcaai-clinical-content-v3.ts:152`, introduced 2026-08-13, `b377575ad`) carries exactly this failure mode in its SOURCE RULES: "Never let the provenance date stand in for an event date ... `CPK 362 (recorded 11-Aug-2026)` for a result measured months earlier turns an old value into a new one"; correct forms are `CPK 362 on 12-Sep-2025 (recorded 11-Aug-2026)` or `date of test not stated`. "Do not infer", "do not compute or normalise", "state a trend only when two or more dated values support it".
- **Conflict with the request.** The same prompt says "Use **all** the dated values supplied, not only the two most recent" for trends and lists every dated value for notable series. The issue wants only the most recent per parameter as the current value. The prompt does satisfy "do not present an old value as current" (dated inline) but not "show only the latest".
- **Structured path (code).** The client can send `investigations` with per-result `collectedAt` (`07g-arcaai-two-schemas.ts:260-290`, TASK-1020 OD-6). `formatTestResultsForPrompt` renders every result as a line in the order sent, with no grouping or recency selection (`packages/applications/src/services/consultation/context/client-clinical-context.ts:~222-245`). If a client sends the whole history, the model sees all values undistinguished except by `— collectedAt` text.
- **Unstructured path.** Lab tables inside `previous_case_notes` text are free text; recency is the model's job and `CAPTURE` says "All investigation results reported in the latest department note" - which can pull in a historic series printed in that note.
- The "taken from the latest case note" phrase in the issue's output does not occur in the current v3 prompt (the v3 format uses provenance parentheses), indicating the issue was produced with an earlier body.

## 3. Root Cause

Prompt/config in the era of the issue (provenance date conflated with measurement date). In the current seeded body the failure is mostly specified away, leaving (a) a spec conflict ("all values" vs "most recent only"), and (b) no deterministic recency selection for structured `investigations`.

## 4. Implementation Plan

1. **Replay (no code):** reproduce with a note containing a dated blood-sugar table on the current build; capture prompt and output. If dated correctly, record evidence.
2. **Decide the display rule** (OD-1). Recommended: show the most recent value as the current one, and prior values only as a dated trend when two or more exist, which v3 already roughly does; add a line "the current value of a parameter is the one with the latest event date; list earlier dated values only inside a trend".
3. **Tests first (code, small):** `client-clinical-context.test.ts` - `formatTestResultsForPrompt` groups by `name`, orders by parsed `collectedAt` descending, marks the first as latest and keeps older ones as a dated trail; unparsable dates keep client order and are not treated as latest (same rule as `formatPreviousVisitsForPrompt`).
4. **Config:** add the sentence in step 2 to the v3 pre-summary body (and the dept prompts that share the pre-summary dated rule); republish agents (tenant content is cloned).
5. Verification: touched test file only; one live replay.

## 5. Risks and Open Questions

- OD-1 (owner/clinical): "only the most recent" versus "latest plus dated trend". The issue says only the most recent; the prompt authors deliberately kept trends (steroid tapers, insulin changes). Clinical sign-off needed.
- OD-2: should structured `investigations` be required for lab values (no extraction from text), as for vitals (BUG-398)? Same decision family; align the two tickets.
- Risk: grouping by `name` needs normalisation (synonyms, units); conservative: group only on exact trimmed lower-case name+unit.
- Model dependency: date parsing from free-text tables is probabilistic; strongest control is the structured path.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #399 (read-and-document lane); no code changed. |
