# BUG-410 — Playground Consultation tab: context-item gaps

- **Status:** Pending
- **Type:** feature (change request; filed as enhancement bundle)
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/410 (NeenaPanicker, 2026-03-31; comment 2026-04-08)
- **Severity:** Medium (UX gaps; no data loss)
- **Verdict:** open, but redesigned — items map onto a different model today

## Requirement Analysis

The issue asked for (1) dropdown options Summary / Edited Summary / Pre-summary in the "add context" selector, (2) multi-select of context items, (3) a "Template" context type, (4) custom items (Header + Content, e.g. Lab Results) injected into the LLM prompt, and (comment) (5) the ability to remove/edit a file or text block already added as context.

## Current State Evaluation

The old "context item dropdown" no longer exists. The consultation playground (`apps/admin-console/src/app/(console)/playground/consultation/page.tsx`, screen `features/playground-consultation/components/consultation-demo-screen.tsx`, 3 resizable columns at lines ~758-817) now offers:

- Only ONE ad-hoc context affordance: `scribe/add-detail-control.tsx:30-80` — "Add detail", a popover with one Textarea that calls `context.addCaseNote`. No header field, no type, no remove/edit.
- Pre-summary is a first-class generated panel (`scribe/case-note-column.tsx:388` `PreSummaryPanel`), not a selectable context item; Summary/Edited summary are the persisted note draft with an edit path (`case-note-column.tsx:592` `canEdit`, `hooks/use-note-editor.ts`).
- Templates are not a context type: the governing workflow/agent supplies the prompt (rule 00 "Content is cloned"); the console shows it read-only in `scribe/governing-workflow-meta.tsx`. Structured inputs (vitals, prior notes, labs) are the tenant's ConsultationContextSchema (`docs/consultation-context-schema-integration-guide.md`; TASK-951/982).
- No client function deletes or updates a context item: `features/playground-consultation/api/client.ts` has only `getTranscriptions`, summary calls and add calls; no `DELETE`/`PATCH` consultation-context route was found in `apps/api/src/modules/consultation/consultation.controller.ts` (grep shows only the internal `extracted-text` read at harness-internal.controller.ts:1016). Gateway support must be confirmed.

## Root Cause

Item 1/3: obsolete as phrased (pre-summary/summary are generated artefacts; template belongs to agent governance). Item 2: obsolete (the selector is gone; all context feeds the run). Items 4 and 5: still real gaps — only free-text case notes can be added, and nothing can be removed or edited.

## Implementation Plan (items 4 + 5 only, after owner decision)

1. RED tests: `scribe/__tests__/add-detail-control.test.tsx` — header + content fields, both sent; empty header rejected; `consultation-demo-screen.test.tsx` — context list shows added items with Remove/Edit.
2. Gateway/SDK (only if absent): authored per rules 03-05 + vox SDK hook (`packages/agentic-sdk-v2/src/hooks/useArcaContext.ts`) with soft delete and If-Match. Needs layer order DB → domain → service → API; regenerate the five API artefacts.
3. Console: extend `AddDetailControl` (header optional), add a context-items list with confirm-to-remove (rule 11 §5), `toast` feedback, Skeleton loading.
4. Prompt injection: confirm the harness renders case notes with a header; otherwise add to composable-instruction variables (TASK-947).
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: is editing/removing context after a run allowed once a summary was generated (provenance/citations reference items)? Soft-delete vs hard.
- OD: is "Custom item" a case note with a header, or a schema-declared kind (D2 in memory: a new kind against a frozen trigger fails silently)?
- OD: close the issue as partly obsolete and re-scope to a feature ticket?

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
