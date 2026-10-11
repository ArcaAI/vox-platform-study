# BUG-031 — DNA Writing Style: job SSE 404 shows a false "Generation failed"; report content not viewable on selection

| Field | Value |
|---|---|
| Status | Pending |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/31 |
| Reporter / date | JayaramNambiar, 2026-09-30 |
| Labels | bug, Playground |
| Severity | Medium (successful generations reported as failed; content discoverability) |
| Area | `apps/admin-console` playground-dna-style + shared streams (rule 13), `apps/api` dna-writing-style (rule 05) |
| Attachments | sample_cases.txt https://github.com/user-attachments/files/32860667/sample_cases.txt · video https://github.com/user-attachments/assets/f2248028-cebe-4ed1-b04f-1fc6a349a07b · screenshot https://github.com/user-attachments/assets/9f90d847-ef52-4809-9736-ca26340b669e |

## Requirement Analysis

Context: super admin impersonating `doctor_med` (DOCTOR), working tenant Global, `/playground/dna-writing-style`.
1. `POST dna-writing-styles/generate` 201 → `POST stream-ticket` 200 → `GET dna-writing-styles/jobs/<jobId>/stream?ticket=…` **404**.
   UI shows `Failed · Generation failed · Generation failed` + toast, yet the worker completes and the report appears in My reports.
2. Clicking a report row / v1 version row only selects it and shows version metadata — the style text is never shown for that report/version.

Expected: live progress to 100% with no false failure; selected report/version content viewable.

## Current State Evaluation

**Part 1a — any transport error is rendered as a job failure (confirmed, independent of the 404):**
- `apps/admin-console/src/features/playground-dna-style/api/hooks.ts:131` — `DNA_JOB_EVENTS = ['status','progress','result','error']`.
- `apps/admin-console/src/shared/streams/use-event-stream.ts:140-155` — every name is `source.addEventListener(name, forward(name))`.
  `EventSource` dispatches its **native** transport-failure `Event` under the name `error`, so a 404 / dropped connection reaches
  `onEvent('error', undefined)` (`event.data` undefined → `JSON.stringify(undefined)`).
- `hooks.ts:233-246` — the `error` branch marks the job `failed` with `'Generation failed'` and closes the stream, so the
  documented poll fallback (`hooks.ts:270-276`, enabled only when `streamStatus === 'error'`) can never correct it — the SSE
  snapshot is already terminal. This produces exactly "Generation failed · Generation failed".
- Side effect: `forward()` resets the retry budget (`attempt = 0`, `use-event-stream.ts:148`, TASK-999) on that fake "delivered" event.
- Same pattern in the admin twin: `apps/admin-console/src/features/dna-writing-styles/api/hooks.ts:84`.

**Part 1b — why the stream is 404 (needs live repro; candidates):**
- Route: `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:396-403` with `@StreamScope({ namespace: 'dna_job', param: 'jobId' })`
  (added by TASK-991, `6f26cb40f`, 2026-09-19). Every rejection in `dna-writing-style-job-stream.ts:75-121` (`assertDnaJobAccess`) and the
  missing-job branch (`:174-177`) is the same `NotFoundException`.
- The ticket mint ran the same ownership check and passed (`auth.controller.ts:1001`, `assertDnaJobScopeOwnership`), so the
  404 means the CLS restored from the ticket on the SSE request differs from the mint request: candidates are
  (a) `tenantId` in CLS on the ticket path ≠ the working tenant (Global) stamped on the job payload under super-admin impersonation,
  (b) `cls.get('user').id` on the ticket path is the impersonator rather than the impersonated doctor (`getDoctorId`, controller `:80-86`;
  the job's `userId` is the impersonator, `doctorId` the doctor — either matches only if the ticket restores one of them),
  (c) the cluster image predates TASK-991 (then it would typically be 401, so less likely).
- Ticket carries `userId`, `tenantId`, `impersonatedBy` (`auth.controller.ts:1007-1015`, `stream-ticket.service.ts:80-107`).

**Part 2 — content not shown on selection (design gap, confirmed):**
- `components/my-reports-card.tsx:136-160` — the row button only `setSelected(report.id)`; `:197-203` renders `VersionTimeline` (metadata only).
- Style text is shown only by `my-style-card.tsx:199-208` for the DEFAULT report (`GET my-style`), clamped to 6 lines.
- The self-plane API has no "get one report by id" or "get version content" read: routes are `generate`, `my-style`, `mine`,
  `doctor/:doctorId`, `PATCH :reportId`, `:reportId/default`, `:reportId/versions`, `DELETE :reportId` (controller `:110-360`).
  Whether `DnaVersionResponse` / `mine` items carry `styleText` must be checked before choosing UI-only vs API work.

## Root Cause

1a. The shared SSE hook subscribes to a server event literally named `error`, colliding with EventSource's native `error`
transport event; the DNA hook treats it as a terminal job failure (high confidence).
1b. A CLS identity/tenant mismatch on the ticket-restored SSE request vs the minting request under impersonation (medium; reproduce).
2. Missing feature: no per-report / per-version content view (high).

## Implementation Plan

TDD (red first):
1. `shared/streams/__tests__/use-event-stream.test.ts`: a native `Event('error')` without `data` is NOT forwarded to `onEvent`; it
   drives `onerror` retry/`status='error'`; budget not reset.
2. `playground-dna-style/api/__tests__/hooks.test.ts`: transport error → job stays non-terminal, poll fallback engages and reports `completed`.
3. Same for `dna-writing-styles` admin hook.
4. `apps/api/.../__tests__/dna-writing-style-job-stream.access.test.ts`: ticket-restored CLS for an impersonated doctor in a working tenant → 200 stream (reproduce 1b first; write the failing case from the live finding).
5. `my-reports-card` test: selecting a report / version shows its style text (after OD-2).

Change order:
1. `use-event-stream.ts` — in `forward`, ignore events that are not `MessageEvent` with string `data` (or skip the `error` name for
   native events); keep TASK-999 budget semantics.
2. Optionally rename the server event `error` → `failed` in `dna-writing-style-job-stream.ts:232` (+ admin twin, both console hooks) — OD-1.
3. Fix 1b per live finding (likely in the ticket-restore CLS population or `jobAccess()`), keeping 404-over-403.
4. Part 2: UI selection panel showing styleText (and API read if needed — would also need route-manifest/openapi/portal/vox-node gen:admin regen per rule 05 if a new route is added).

Verification: own test files only (`pnpm --filter @arcaai/admin-console test -- use-event-stream hooks my-reports-card`,
`pnpm --filter @arcaai/api test -- dna-writing-style-job-stream`), `pnpm --filter @arcaai/admin-console build lint`, `pnpm api:build`;
live: impersonated generate on the cluster/local stack, watch network for a 200 SSE and no false failure.

## Risks / Open Questions (owner)

- **OD-1**: Rename the SSE terminal event from `error` to `failed` (wire change for any SDK consumer of `dna_job`) vs fix only the client filter.
- **OD-2**: Part 2 scope — show content of the selected report only, or also of each historical version (may need a new read route)?
- Reproduce 1b on the cluster image actually deployed on 2026-09-30 before changing server code.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from GitHub issue #31 (read-only triage). |
