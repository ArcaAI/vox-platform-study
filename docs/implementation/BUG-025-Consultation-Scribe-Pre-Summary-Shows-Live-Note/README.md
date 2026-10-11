# BUG-025 — Consultation Scribe: Pre-summary panel fills with the live note after Stop

- **Status:** Completed
- **Type:** bugfix
- **Source:** https://github.com/ArcaAI/project-hope/issues/25 (JayaramNambiar, 2026-09-30; labels `bug`, `Playground`)
- **Severity:** Medium (clinician-visible mislabelling of AI content; no data loss)

## Requirement Analysis

At `/playground/consultation`, with a fresh consultation and NO prior context, pressing Stop makes the **Pre-summary** panel (AI badge) populate with headed clinical text (Presenting Complaints, HPI, Family History, Treatment History) derived from the live dialogue. Expected: Pre-summary stays absent/empty ("nothing to summarise") when no prior record exists; spoken content appears only in the live transcript and the generated note. Secondary: clicking **Cancel generation** reported the job as no longer cancelable; reporter asks whether that is intended.

Env: tenant ArcaAI, impersonating `arcaai_doctor_heme`, governance "Hematology Consultation v2". Video: https://github.com/user-attachments/assets/79db2129-f778-4776-a7a9-2f7f1c073b02

## Current State Evaluation

- `apps/admin-console/src/features/playground-consultation/components/scribe/case-note-column.tsx:388` `PreSummaryPanel` renders any `ready` view with `content`. It renders what `usePreSummaryStream` gives it.
- `.../api/hooks.ts:744-753` `usePreSummaryStream` runs a REST catch-up `getLatestPreSummary` (`api/client.ts:197`, `GET consultations/:id/summary/pre-summary/latest`) and `reconcilePreSummaryFromLatest` (hooks.ts:~680) maps ANY row to `status: 'ready'`.
- `.../api/hooks.ts:123,204,869` invalidate `playgroundConsultationKeys.root` (recording stop / mutations), which refetches the active `latestPreSummary` query after Stop (the query client has `staleTime 30s`, `refetchOnWindowFocus:false`, `shared/providers.tsx:36-40`; the invalidation overrides staleness).
- Backend route `apps/api/src/modules/consultation/consultation.controller.ts:2094` -> `SummaryService.getLatestPreSummary` (`packages/applications/src/services/consultation/summary/summary.service.ts:1439`) -> `ContextItemRepository.findLatestPreSummary` (`packages/domains/src/repositories/generated/core/ContextItemRepository.ts:297`), which filters only `type = PRE_SUMMARY` and is NOT subType-aware.
- The live documentation lane persists its durable note snapshot AS a `PRE_SUMMARY` context item with `metaData.subType = 'LIVE_SOAP_SNAPSHOT'` (`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:5986` `ContextItemFactory.CreatePreSummary`, metadata at ~5953). Its own comments (service lines ~5962, ~6021) already warn that `findLatestPreSummary` "is NOT subType-aware".
- The genuine warm start (`LivePreSummaryAdapter`, `summary/live-pre-summary.adapter.ts`) summarises only `CASE_NOTE` items and degrades to `no_case_notes` when there are none (`summary.service.ts:492-502`), so it does not produce the reported text. The reported headings are the template (note) headings.
- Cancel: `consultation-job.service.ts:224 cancelJob` returns false for terminal jobs and when the harness refuses a cooperative cancel (SUMMARY, TASK-1038 B3a); the controller (`consultation-job.controller.ts:58-74`) maps that to 404 "already terminal, or not cancellable". Console: `consultation-demo-screen.tsx:643` shows `Could not cancel the generation`. No dedicated "not cancelable" state exists.
- Related: BUG-411 (pre-summary panel redesign, TASK-932). Not fixed on dev-2.2 (no commit touches `findLatestPreSummary` subType filtering). The SDK also reads this route (`packages/agentic-sdk-v2/src/core/constants.ts:230`, `hooks/useArca.ts:244`), so the same leak can affect SDK consumers.

## Root Cause

The "latest pre-summary" read returns the newest PRE_SUMMARY of any subType, so the live note's durable snapshot (LIVE_SOAP_SNAPSHOT, written during/at end of recording) is served as a pre-summary; the console's REST catch-up then renders it as a `ready` AI pre-summary after the Stop-triggered invalidation. Confidence: high on the data path; medium on the exact refetch trigger (confirm with a live repro, see plan step 0).

## Implementation Plan

TDD test list (write first, see RED):
1. `packages/applications` summary.service test: `getLatestPreSummary` ignores a newest row whose `metaData.subType === 'LIVE_SOAP_SNAPSHOT'` and returns an older genuine pre-summary / null.
2. `packages/domains` ContextItemRepository test (or service-level): subType exclusion (or `excludeSubTypes`) option on `findLatestPreSummary`.
3. `consultation.controller` unit: 404 when only a live snapshot exists.
4. admin-console `pre-summary-stream.task932.test.ts` extension: REST catch-up returning 404 leaves `preSummary` null after a root invalidation.
5. Cancel (only if owner chooses UX change): `case-note-column` test that a refused cancel shows a specific "already finishing" message.

File order:
0. (Live repro, orchestrator-owned) Start/Stop a context-free consultation; capture the `summary/pre-summary/latest` response and its row's `metaData.subType`.
1. `packages/domains/.../ContextItemRepository.ts` — add an optional subType exclusion to `findLatestPreSummary` (keep default behaviour for harness warm-start callers; `findLatestPreSummaryWithDecryptedContent` already accepts `subType`).
2. `summary.service.ts:1439` — call it excluding `LIVE_SOAP_SNAPSHOT`.
3. Console: no change expected; optionally make `reconcilePreSummaryFromLatest` ignore rows lacking a genuine pre-summary marker.
4. Re-run `pnpm api:route-manifest`/openapi checks only if the response shape changes (it should not).

Verification: `pnpm --filter @arcaai/domains test <file>`, `pnpm --filter @arcaai/applications test <file>`, `pnpm --filter @arcaai/admin-console test <file>`, `pnpm admin:typecheck`; then orchestrator-only manual pass with `next-dev-loop` (both themes). Per owner rule, lanes run only their own test files.

## Risks / Open Questions for the owner

- Should live-note snapshots stop being stored as `PRE_SUMMARY` at all (cleaner, but a data-model change touching the harness warm-start and `findLiveSnapshotRow`)? Recommended: filter, do not migrate.
- Cancel Generation: is "not cancelable" acceptable when the job is terminal/finalizing, or should the button be disabled with a reason (rule 11 §5: disabled buttons need a visible reason)?
- The SDK `useArca` path may display the same leaked row; confirm scope of the fix to SDK consumers (ALaaS).

## Implementation Summary

Decisions (owner, 2026-10-11): filter the live snapshot out of the read (no data-model change); a refused cancel gets a clear message.

- `packages/domains/src/repositories/generated/core/ContextItemRepository.ts` — `findLatestPreSummary(consultationId, { excludeSubTypes? })`: without the option the read is unchanged (one `findFirst`); with it, the ENABLED pre-summaries are read newest-first and the first whose `metaData.subType` is not excluded wins. Filtered in code, not SQL: a JSON-path `NOT` would also drop rows that carry no `subType` (NULL comparison).
- `packages/applications/src/services/consultation/summary/summary.service.ts` `getLatestPreSummary` — excludes `LIVE_SOAP_SNAPSHOT`. It is the only caller, and it serves `GET consultations/:id/summary/pre-summary/latest`, so the console Pre-summary panel and SDK consumers (`useArca`, ALaaS) are fixed together. The harness warm start reads the snapshot through its own finder and is untouched.
- `apps/admin-console/src/features/playground-consultation/lib/cancel-generation-error.ts` (new) + `consultation-demo-screen.tsx` — a 404 on cancel ("already terminal, or not cancellable") now reads "The note is already finishing and can no longer be cancelled."; other failures keep the gateway message.
- Tests: `ContextItemRepository.findLatestPreSummary.bug025.test.ts` (skips the snapshot → genuine row; only a snapshot → null; no option → unchanged), `summary.service.latest-pre-summary.bug025.test.ts` (the service passes the exclusion), `lib/__tests__/cancel-generation-error.test.ts`.

Evidence:
- RED: the repository test (2 of 3) and the service test failed before the change; the cancel test failed (module absent).
- GREEN: domains test 3 passed; `vitest run src/services/consultation/summary` → 55 files, 524 passed; console `vitest run src/features/playground-consultation` → 35 files, 388 passed; `tsc --noEmit` exit 0; eslint 0 errors (the package test/generated paths are lint-ignored).
- Live, against the running gateway (domains + applications rebuilt), with two local `LIVE_SOAP_SNAPSHOT` test rows (soft-deleted afterwards) — as the owning `doctor` @ Global: consultation `90000000-…0001` (genuine pre-summary + newer snapshot) → 200 with the genuine `91000000-…0006`; `90000000-…0002` (snapshot only) → 404 "No pre-summary has been generated yet". No model was run: the full repro (record → Stop) needs ASR + the live-note LLM lane.

Not done: whether live snapshots should stop being stored as PRE_SUMMARY at all (owner chose the filter).

## Final Verification (2026-10-11, cluster api `0.0.0-dev-2-2.b4c248f9`)

`GET consultations/01a121a4-…/summary/pre-summary/latest` (a consultation whose only PRE_SUMMARY is a `LIVE_SOAP_SNAPSHOT`) → 404 "No pre-summary has been generated yet". The live note is no longer served as the pre-summary.

## Change History

- 2026-10-11 — Final verification against the deployed cluster passed; status Completed.

- 2026-10-06 — Ticket created from GitHub issue #25 (read-only investigation).
- 2026-10-11 — Fixed (live snapshot filtered out of latest pre-summary; clearer refused-cancel message); tests, typecheck, lint, live API check green. Status Review.
