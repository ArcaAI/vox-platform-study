# BUG-010 — Language mode intermittently fails to load after entering UHID and clicking the microphone

| Field | Value |
|---|---|
| Status | Pending |
| Type | bugfix |
| Source | https://github.com/ArcaAI/project-hope/issues/10 |
| Reporter / date | NeenaPanicker, 2026-09-29 |
| Labels | none |
| Severity | Medium (intermittent; blocks starting a consultation when it hits) |
| Area | Mostly the **ALaaS** client (`~/Desktop/igglo/ARCAAI/ALaaSv3.0`, `apps/web_ui` + `apps/audio-stream-svc`); HOPE gateway route (rule 05) as upstream |

## Requirement Analysis

Enter a UHID, click the microphone → the Language selector sometimes hangs / never loads. Expected: it loads every time.
The issue has no environment, browser, frequency, or network trace — a repro with DevTools network capture is needed.
UHID entry does not exist in HOPE (`git grep -i uhid` hits only seeds/fixtures), so the screen is the ALaaS `web_ui`.

## Current State Evaluation

Call chain (verified in code):
1. `ALaaSv3.0/apps/web_ui/hooks/useConsultationWorkspace.js:198-209` — `getLanguageModes()` is fetched **once on mount**;
   on failure it only `logger.error`s. No retry, no error state.
2. `apps/web_ui/services/consultationService.js:31-42` — `GET {API_BASE_URL}/api/v1/consultation/language-modes`; any non-2xx throws.
3. `apps/web_ui/components/agentic/ConsultationSetupPanel.jsx:140` — with `languageModes.length === 0` the select shows
   `Loading…` **forever** — matches "hangs or fails to load".
4. `apps/audio-stream-svc/src/consultation/consultation.controller.ts:42-56` — relay; any upstream error → 503 by design.
5. `apps/audio-stream-svc/src/consultation/hope-realtime.vox-node.adapter.ts:932,968-977` — service-account token + `GET
   api/v1/audio/transcription-jobs/language-modes`; no retry; non-OK throws.
6. HOPE: `apps/api/src/modules/streaming/transcription-job.controller.ts:894-925` — per-tenant catalog via
   `languageCapability.catalogFor(tenantId, agentSlug)`.

Known transient upstream failures in this window: cloudflared QUIC drops producing 502s and ALaaS reconnect storms
(TASK-1003 triage, 2026-09-24, `docs/implementation/TASK-1003-Realtime-Consultation-Transport-And-Finalization-Reliability/`);
service-account token exchange at cold start. Any single one of these on the mount-time request leaves the picker stuck.
At the reporter's date (2026-09-29) the workspace code was at ALaaS `99ec191` (TASK-1004); TASK-1045 commits since
(`ef06850`, `d5f5865`, 2026-10-05) did not change the language fetch.

## Root Cause

Most likely: the ALaaS web_ui loads language modes with a single, non-retried request on mount and has no failure state, so
any transient relay/HOPE/edge failure (503/502/timeout) leaves the selector permanently "Loading…". Confidence: medium (code
path certain; the triggering upstream failure is unconfirmed without a trace). Not fixed on either repo's current head.

## Implementation Plan

TDD (red first) — ALaaS repo:
1. `web_ui` hook test: first `getLanguageModes` rejects, second resolves → modes appear (bounded retry with backoff).
2. Test: all retries fail → explicit error state with a Retry action (not `Loading…`).
3. Test: clicking the mic with no modes loaded triggers a refetch before start (or start uses the agent default — OD-2).
4. `audio-stream-svc` adapter test: one retry on 502/503/network error for the idempotent GET; token refresh on 401.

HOPE side (only if the trace shows HOPE errors): unit test for `getLanguageModes` under a cold `languageCapability` cache.

Change order: `consultationService.js` (retry/timeout) → `useConsultationWorkspace.js` (status + refetch) →
`ConsultationSetupPanel.jsx` (error/Retry UI, no stuck `Loading…`) → `hope-realtime.vox-node.adapter.ts` (bounded retry).

Verification: ALaaS package tests for the touched files; live: throttle/kill the relay once and confirm recovery; capture the
original failure's status code from audio-stream-svc logs (`language-modes relay failed:`) and HOPE gateway logs for the request id.

## Risks / Open Questions (owner)

- **OD-1**: This fix lands in the ALaaS repo — confirm it should be tracked here or moved to the ALaaS tracker.
- **OD-2**: If modes cannot load, should recording start with the tenant/agent default language instead of blocking?
- Need reporter environment (URL, browser, frequency) and a HAR to confirm which hop fails.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from GitHub issue #10 (read-only triage). |
