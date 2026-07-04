# TASK-420 — Admin Console Playground Tier (Figma frames 50–59)

- **Status**: Pending
- **Type**: feature — playground screens inside `apps/admin-console`
- **Created**: 2026-07-04
- **Origin**: TASK-415 Decision 2 (Playground tier deferred) confirmed by the 2026-07-04 review

## Requirement Analysis

Deliver the tier 50–59 Playground surfaces inside the Admin Console (deferred out of TASK-415, which covers admin tiers 10–49):

- **SDK-based clinical consultation demo** — `@arcaai/vox` capture → transcribe → document flow.
- **Live transcription** — WS streaming session (`/ws/stt-v2/stream`, session via `POST /audio/transcription-jobs/stream/session`).
- **Voice profile enrollment** — `/voice-profile/*`.
- **DNA writing style self-service** — `/dna-writing-styles/*` (incl. self SSE job stream).
- **Summarization / LLM demos** — `/text/generate*`, task streams (`GET /text/tasks/:taskId/stream`), provider catalog.

## Current State Evaluation

- All backend planes exist and are exercised today by the deprecated `apps/ui-playground` (API-integration reference only — its design tokens and sessionStorage auth are NOT to be copied).
- The console's BFF (TASK-415 Phase 3) already mints single-use stream tickets; browser SSE/WS connect directly to the gateway (`NEXT_PUBLIC_API_HOST`) per the established pattern.
- Design gate: Figma frames 50–59 in `HOPE-Admin-Console` must be authored and approved before screen implementation (`12-design-workflow.mdc`).

## Implementation Plan (high level — detail before starting)

1. Extend the TASK-415 capabilities matrix with a tier 50–59 section (endpoints/guards verified against controllers).
2. Figma frames 50–59 + approval gate.
3. Screens per the TASK-415 phase pattern (failing test → implement → verify; `@arcaai/ui` fitness pass; `@arcaai/vox` integration for capture flows).

## Implementation Summary

*Pending.*

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review (deferred Playground tier formalized). |
