# BUG-183 — Same-day re-visit continuation for final AI summaries (prequel, last-successful-summary rule, cross-department rollup)

| Field | Value |
|---|---|
| Status | Pending |
| Type | feature + bugfix |
| Source | https://github.com/ArcaAI/ALaaSv3.0/issues/183 (OPEN, 2025-09-01; enhancement, ALaaS) |
| Severity | Medium (core continuation delivered by TASK-1020; verification of residual edge cases) |
| Proposed verdict | Fixed by TASK-1020 / TASK-1045 (Review status); two edge cases to verify |

## 1. Requirement Analysis
Detect same-day follow-up (same patient+doctor+department+IST date), roll up earlier same-day notes into `same_day_prequel_summary` / `same_day_event_ids` / `same_day_flag`, use a distinct re-visit prompt, degrade gracefully. Later comments: (a) bug — different departments same day were wrongly rolled up (marked Resolved); (b) "Last Successful Summary" rule: the prequel must be the most recent SUCCESSFULLY generated summary of the same day for the same doctor even if a preceding visit's summary failed; (c) pre-summary for the third revisit was misaligned and "not pulling the updated summary"; same-day pre-summary was to use transcription.

## 2. Current State Evaluation
- Producer: `packages/applications/src/services/consultation/harness/same-day-prequel.ts` — walks `parentConsultationId` (max 5), requires same patient, tenant and date (`isSameDaySibling`), picks the authoritative note (signed > clinician-modified > raw) via `selectAuthoritativeNoteText`, skips ancestors without a note (loop continues, so a failed/empty visit does not break continuity), never throws, graceful degrade. Rendered block carries local time + status.
- Wiring: `harness-internal.service.ts:1847-1906` (`sameDayPrequelSummary`, key `same_day_prequel`); prompt variable in `prompt-assembly.service.ts` / `prompt-assembly-blocks.ts`; live path `live-documentation.service.ts`. Tests: `__tests__/same-day-prequel.task1020.test.ts`, `harness-internal.same-day-prequel.task1020.test.ts`, `prompt-assembly.same-day-prequel.task1020.test.ts`, `live-documentation.same-day-prequel.task1020.test.ts`.
- Cross-department isolation: `consultation.service.ts:1234` open key = tenant + doctor + patient + department; chain parent derived by `findLatestClosedByKey(openKey)` at :1377, so a different department never chains. TASK-1020 D-3/OD-4; TASK-1045 episode model supersedes the 12-state design (TASK-1020 change history 2026-10-05).
- Timezone: tenant setting `consultation.appointmentDay.timeZone` (default UTC) instead of hard-coded IST — IST must be configured on the ArcaAI tenant.
- Seeds: all 22 bodies reference the variable; seed tests `seed/__tests__/task-1020-same-day-return.test.ts`, `task-1020-arcaai-finalizer.test.ts`.
- Not found: explicit `same_day_event_ids` / `same_day_flag` response fields (flag exists as `trigger.context.same_day_prequel`); an explicit "failed" status filter.

## 3. Root Cause / Gap
Original bugs (cross-department rollup, no prequel producer) are addressed. Residual to VERIFY, not assumed broken: (1) the walk stops at the first ancestor that is not same-day/same-patient or whose lookup throws; a failed middle visit with no note is skipped, but a deleted middle row ends the chain; (2) tenant timezone default UTC vs IST boundary; (3) "not pulling the updated summary" — the prequel reads the authoritative stored note at generation time, so a still-generating earlier visit yields no block; the issue's expectation (wait or fall back to last good) is unverified; (4) debug telemetry of event ids absent.

## 4. Implementation Plan
1. Tests first: a three-visit same-day chain where visit 2 has no note, and where visit 2 is soft-deleted; assert visit 3 still gets visit 1's note (extend same-day-prequel.task1020.test.ts).
2. If the deleted-middle case fails: make the walk skip (not stop on) an unreadable parent by following its stored parent id only when readable; otherwise accept and document.
3. Add `same_day_event_ids` to debug telemetry (LoggingService field) — optional.
4. Verification: run only the touched test files (owner rule: no gating suites); then one live ALaaS-style two/three-visit replay at e2e time, only with owner go.

## 5. Risks / Open Questions
- OD-1: close as delivered by TASK-1020/1045 after the edge tests? OD-2: is the ArcaAI tenant timezone set to Asia/Kolkata? OD-3: should a not-yet-finished earlier summary block the next visit's start?

## 6. Implementation Summary
Not started.

## 7. Change History
| Date | Change |
|---|---|
| 2026-10-06 | Created from https://github.com/ArcaAI/ALaaSv3.0/issues/183 |
