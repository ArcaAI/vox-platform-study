# BUG-395: Summary Labels ("Primary complaint:", "Onset:") Render Inline, Not On New Lines

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | bugfix (note formatting) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/395 (ArcaAI/ALaaSv3.0) |
| **Severity** | Medium (scannability; no clinical content error) |
| **Classification** | Config (tenant/department template shape) + model output; possibly ALaaS-side rendering. No deterministic newline normaliser exists in HOPE. |
| **Still applicable on dev-2.2?** | Unknown, leaning open. The finalized note now has an explicit `## ` Markdown heading contract (TASK-1022), but in-section `Label: value` lines are not covered. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

The AI summary arrives as one continuous block: "Primary complaint: Blurry vision ... Onset: Recent weeks. Duration: Persistent. Severity: ..." with each label inline after the previous sentence. Expected: each label starts on its own line (preceded by `\n`) or is block-level. Requirement: every identified header/subheading is preceded by a newline.

## 2. Current State Evaluation

- The literal label "Primary complaint" does not appear anywhere in this repository (search over `packages/database/src`, `packages/applications/src`, `apps`, 2026-10-06). The label set is therefore tenant/department-authored template content (ophthalmology-style fields) or ALaaS UI configuration, not HOPE platform text.
- HOPE's finalizer instructs Markdown: "Write the note under EXACTLY these headings ... each as a `## ` Markdown heading" (`packages/database/src/prisma/db_main/seed/25-agents.ts:845`). That governs section headings, not `Label:` fields inside a section. The finalized note is also the RAW_SUMMARY the clinician copies to the EMR.
- The document-template section forms are `PROSE` for the platform shapes (`packages/applications/src/services/document-template/platform-document-shapes.ts:42-45`); a section whose template says "list the fields" gets whatever line structure the model chooses.
- There is no post-processor that splits `Label: value Label2: value2` runs. Harness note-plan has normalisation for COVERAGE matching only (`apps/harness/src/harness/services/note_plan/normalise.py`), which must not rewrite stored text. `final-note-sections.ts` parses `## ` headings only (`packages/applications/src/services/consultation/summary/final-note-sections.ts:56-67`).
- Whether the defect is HOPE output or ALaaS rendering is not determinable from the issue: the screenshot may show Markdown text `\n`-collapsed by an HTML `<p>` (single newlines collapse in HTML unless `white-space: pre-line`, or Markdown needs two trailing spaces or a blank line for a hard break). The issue does not include the raw payload.

## 3. Root Cause

Undetermined, two candidates: (1) model emitted `Label: value` pairs separated by spaces rather than newlines because the section form is prose; (2) HOPE emitted single `\n` and the client collapsed them when rendering Markdown/HTML. Needs the raw `resultText` of the failing summary.

## 4. Implementation Plan

1. **Evidence first:** fetch the raw summary (`GET consultations/:id/summary...` / `resultText`) for an affected consultation (ask the reporter for the consultation id) and inspect the bytes: are there `\n` between labels?
2. If bytes have `\n` -> not HOPE; hand to ALaaS with a rendering note (Markdown renderer or `white-space: pre-wrap`); close here.
3. If bytes lack `\n`:
   - **Config route (preferred, no code):** declare the template section form as a field list (`form: 'LIST'`/bulleted) or put the instruction "each field on its own line, as `**Label:** value`" in the department template, republish the agent (content is tenant-owned; republish via the admin API).
   - **Code route (only if config is not enough):** a deterministic, conservative formatter at the note-assembly boundary that inserts `\n` before a configured label vocabulary (labels taken from the template's own section field names, never a literal list), covered by tests: `final-note-sections.test.ts`-style fixtures with `A: x. B: y.` -> two lines; must not alter any other character (clinical-fact safety: assert text minus whitespace is identical).
4. Verification: the new unit test only (owner no-gate rule for lanes); then a live generation.

## 5. Risks and Open Questions

- OQ-1: is the label set platform-owned or tenant-owned for this clinic? Determines config vs code.
- OQ-2: where is the text rendered (ALaaS UI vs HOPE console)? The HOPE console should be checked too.
- Risk: a formatter can split legitimate in-sentence colons ("Plan: continue ..." inside prose). Use the template's declared labels only.
- Owner decision: whether deterministic post-formatting of clinical text is acceptable policy (Karpathy rule: no speculative layers).

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0 #395 (read-and-document lane); no code changed. |
