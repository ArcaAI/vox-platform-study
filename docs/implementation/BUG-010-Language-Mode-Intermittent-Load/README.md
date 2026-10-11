# BUG-010 — Language mode intermittently fails to load after entering UHID and clicking the microphone

| Field | Value |
|---|---|
| Status | Review (fix already landed in ALaaS `7d1bcdb`; verified live 2026-10-11, see Implementation Summary) |
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

**Correction to the triage above (2026-10-11).** The Current State analysis targeted `useConsultationWorkspace.js` /
`ConsultationSetupPanel.jsx` (the *Workspace* screen). The screen the reporter uses — UHID header + microphone, served at
`/?openTab=recording` — is `ClinicalUIPopUp.jsx` + `hooks/useClinicalLogic.js`. That screen was already fixed by ALaaS commit
**`7d1bcdb`** (`fix(web-ui): popup lifecycle UX -- ..., language-mode retry a11y, ...`), an ancestor of
`refactor-hope-integaration`. No code change was needed in either repo for this ticket.

What the fix is (`ALaaSv3.0/apps/web_ui/hooks/useClinicalLogic.js:827-846`, `ClinicalUIPopUp.jsx:588-611`):
`refreshLanguageModes` wraps `getLanguageModes()` in `withRetry(..., { attempts: 3 })`, keeps `modesLoading` / `modesError`
state, and on exhaustion shows "Couldn't load modes" with a `Retry loading language modes` button instead of an endless
"Loading modes…". Pinned in `src/functionMap.js` as row `L08`.

### Live verification (2026-10-11, local ALaaS → cluster HOPE)

Setup: local `audio-stream-svc` on :4000 (`HOPE_API_URL=https://api.taphuynh.dev`, i.e. the deployed cluster gateway) and
`web_ui` on :5173, both run from worktree `ALaaSv3.0-e2e-1053` (its three language-mode files are identical to
`refactor-hope-integaration`). No model was loaded or changed.

| Check | Result |
|---|---|
| Healthy path: 20 × `GET localhost:4000/api/v1/consultation/language-modes` (relay → cluster) | 20/20 HTTP 200; cold first call 0.64 s, rest ~0.14 s; catalog returns `en`, `ml`, … |
| Failure path: UI loaded from `127.0.0.1:5173` (CORS-blocked → `net::ERR_FAILED`) | 3 failed `GET`s (the 3 attempts), then picker shows "Couldn't load modes" + Retry; no endless "Loading modes…" |
| Recovery: fetch stubbed to succeed, click Retry | 1 call; picker lists English, Malayalam; Retry button removed |

Limits of this evidence: the failure was injected at the browser (CORS), and recovery used a synthetic catalog, so they
prove the UI's retry/error/recovery logic, not a real transient relay/tunnel failure. The reporter's HAR / environment is
still missing, so which hop failed originally remains unconfirmed.

### Remaining / not done

- `audio-stream-svc` `hope-realtime.vox-node.adapter.ts:932` still does a single `serviceAccountGet` (no retry, no 401
  refresh) — plan item 4 not implemented; the UI retry covers it in practice. Decide whether to add it (ALaaS repo, OD-1).
- The older Workspace screen (`useConsultationWorkspace.js:198-209`) still fetches once with no error state. OD-2 (start with
  the agent default language when modes can't load) is unanswered.
- Gateway/relay logs for real `language-modes relay failed:` occurrences were not pulled.

Landing: this README is the only change (`hope-v2`, `dev-2.2`). No ALaaS or `hope-v2-deployment` change; no worktree was
created for this work, so none to remove. The `ALaaSv3.0-e2e-1053` worktree is another session's live E2E tree (running dev
servers, detached HEAD) and was left alone.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from GitHub issue #10 (read-only triage). |
| 2026-10-11 | Verified live against local ALaaS + deployed cluster; found the reporter's screen already fixed by ALaaS `7d1bcdb`; status → Review; corrected the component analysis. |
