# BUG-036: `DELETE stream/session/:sessionId` returns 404 after stop, and the ALaaS UI hangs on "Generating summary..."

| Field | Value |
|---|---|
| Status | Pending |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/36 (Rijna-arcaai, 2026-10-05; tusharAsthana 2026-10-06: "sufficient info, go ahead and assign") |
| Severity | High for ALaaS UX (UI deadlock). Low for HOPE data (the session is already finalized) |
| Related | TASK-1003 (finalization reliability), TASK-1042 D7 ("stop ends the session"), TASK-1045 (lifecycle), BUG-042 |

## Requirement Analysis
On consultation stop, ALaaS `audio-stream-svc` calls `stt.closeStreamSession(sessionId)` (vox-node, `DELETE /api/v1/audio/transcription-jobs/stream/session/:sessionId`). HOPE answers 404. ALaaS reads this as "HOPE never finalized", so it waits forever for `note.final`. Its `useClinicalLogic.js` has no timeout and keeps `isProcessing = true`. Two parts:
- (1) HOPE: explain or fix the 404.
- (2) ALaaS frontend timeout. This is ALaaS-owned and out of the HOPE repo.

## Current State Evaluation
- The route is `apps/api/src/modules/streaming/transcription-job.controller.ts:1296-1306`. Its guard, `@TenantOwnedResource({ modelName: 'StreamSession', lookup: 'session' })`, resolves ownership from the Redis `sessionId → tenantId` binding. **No binding means 404** (the 404-over-403 posture).
- The binding is cleared **before** the client's DELETE in the normal stop flow:
  - WS finalize: `stt-ws.gateway.ts:1985-1992` calls `sessionBinding.clear(sessionId)`, then `removeSession`. This runs whenever the socket closes ("session closed by client"), or on FINALIZE.
  - Superseded/stop path: `stt-ws.gateway.ts:2276-2280`.
  - `POST consultations/:id/stop` ends the bound session (TASK-1042 D7; `consultation-lifecycle.service.ts` `liveBoundSessions`, ~line 560).
- So when ALaaS stops the consultation or closes its socket and then sends DELETE, the binding is already gone and the guard answers 404. The session was finalized correctly. The 404 is not a tenant mismatch, not an expiry, and not a wrong route.
- HOPE has no `note.final` event. That is an ALaaS-side event, presumably derived from HOPE's note-ready lifecycle (`isNoteReady`) or the summary job SSE. Whether ALaaS gates `note.final` on the DELETE success must be confirmed on the ALaaS side. If it does, the 404 alone causes the hang.
- Not fixed on dev-2.2: the route is unchanged and the guard still requires the binding.

## Root Cause
DELETE is not idempotent across finalize. The gateway clears the session's tenant binding as part of finalize (WS close, FINALIZE, or consultation stop). A later best-effort `closeStreamSession` therefore fails the ownership guard with 404 for a session that the same tenant owned and that HOPE already closed. Confidence: high for the 404 mechanism. Medium that the 404 alone explains the missing note (needs ALaaS-side and log confirmation for the sample sessionId).

## Implementation Plan
TDD tests first:
1. Controller/e2e: open a session, finalize it through the WS close or `consultations/:id/stop`, then `DELETE stream/session/:id` with the same credential. Expect 204, not 404.
2. Cross-tenant: tenant B's DELETE on tenant A's finalized session still gets 404 (no existence oracle). This requires a tombstone: on `clear()`, write a short-TTL `finalized:<sessionId> → tenantId` marker instead of deleting outright.
3. The guard's `'StreamSession'` lookup accepts the tombstone **for DELETE only**. `refresh-ticket` and `switch-to-fallback` must still 404 on a finalized session (preserves F-36/F-06: no ticket against a dead session).
4. vox-node test: `closeStreamSession` treats 404 as already-closed (resolve, not throw). This is SDK defense in depth; it requires an SDK release (owner).

File order: `StreamSessionTenantBindingService` (tombstone on clear) → tenant-owned-resource interceptor StreamSession branch (route-aware tombstone acceptance) → `transcription-job.controller.ts` (DELETE becomes a no-op 204 when tombstoned) → optional `packages/vox-node` stt resource → docs (`08-vox-sdk.md` note: DELETE after stop is idempotent).

Verification: `pnpm test:unit` (api + applications), the e2e spec via `npx dotenv -e .env.test -- npx playwright test <spec>`, `pnpm api:build`, `pnpm lint`. Then a live ALaaS stop flow while watching the gateway log and the note-ready event.

## Risks / Open Questions (owner)
- OD-1: should the fix be gateway idempotency (tombstone), SDK-only (swallow 404), or both? Gateway is preferred, because the 404 is misleading to every integrator.
- OD-2: ALaaS must confirm what drives `note.final`. If it is HOPE's lifecycle SSE / `isNoteReady`, the hang is independent of DELETE and the summary itself may be failing (cf. BUG-041 OUTPUT_INVALID). Ask ALaaS for a sample sessionId and consultationId and check the run status.
- The ALaaS frontend timeout (Issue 2) is out of scope for this repo; recommend it regardless.

## Implementation Summary
Not started.

## Change History
- 2026-10-06: created from GitHub issue #36 (read-only investigation).
