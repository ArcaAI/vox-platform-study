# TASK-1039 — SDK 5.0: one run handle, one protocol

**Status:** Review. Implemented in TASK-1036 wave C (lanes S1 VOX-NODE-5 `77f8bd81f`, S2 VOX-5 `3c765098b`) and versioned as SDK 5.0.0 together with TASK-1042 and TASK-1045 (2026-10-06, owner: "increase the version number to 5.0"). Publishing follows the local runbook after the owner's go.
**Type:** feature (SDK major)
**Branch:** dev-2.2
**Raised:** 2026-10-04
**Programme:** TASK-1036 · TASK-1038 · **TASK-1039** (this) · TASK-1040
**Design record:** TASK-1036 README §8.7 (delivery plane) and §10.3 (event list).

## 1. Requirement Analysis

The owner's W5 asks for streaming or polling, complete SDK integration, and easy client setup.

| # | Requirement |
|---|---|
| R1 | **vox-node.** `hope.workflows.run(slug, input, opts)` and `hope.agents.run(slug, input, opts)` both return a `RunHandle`:<br>• `.text()`: async iterator of strings<br>• `.events()`: typed protocol-v2 events<br>• `.result()`<br>• `.wait({ poll })`<br>• `.cancel()`<br>The handle auto-resumes by `seq`, handles tickets internally, and never leaks frame shapes. It sends an `Idempotency-Key` on every start. |
| R2 | **vox (browser).** `useRun({ workflow \| agent })` returns `{ start, text, events, result, status, cancel }` and resumes on mount. `useRunAudio` streams the microphone into a run. Browser SSE uses run-scoped tickets, which work for API-key apps. |
| R3 | A **protocol normaliser** that reads v2 and the legacy shapes for one release. |
| R4 | Media helpers: upload a blob or attachment and get a `mediaId`; `runWithAudio`. |
| R5 | Typed inputs and outputs from the workflow's Input/Output shape (`vox-codegen` already emits the types). |

## 2. Plan

Lanes **S1 VOX-NODE-5** and **S2 VOX-5** (`sonnet`, wave C batch 1 and batch 2) are specified in TASK-1036 §5.4. Release follows the owner's local runbook (`docs/operations/vox-sdk-release/`): versions bump locally in lockstep to 5.0.0, the owner tags the release, and publishing happens before the tag is pushed. Never through the CI `publish-sdk` job.

## 3. Verification

- Unit: the handle against a recorded protocol-v2 stream, including a drop, resume and `run.resync`.
- Contract: the normaliser against fixtures of all legacy shapes.
- E2E: TASK-1036 §5.6 item 2 (invoke through `RunHandle`, stream text, read `.result()`).

## 4. Implementation Summary

Merged into `dev-2.2` in TASK-1036 wave C: vox-node `RunHandle` (`run()`/`attach()` on workflows and agents, protocol-v2 normaliser, auto-resume by `seq`; the old 202 `run()` is `start()`), vox `useRun` / `useRunAudio`, browser run-follow engine, `useConsultationJob` ticket scope. Changeset `task-1039-run-handle` (added 2026-10-06 so the 5.0.0 CHANGELOG records it); versioned 5.0.0 with TASK-1042 and TASK-1045.

## 5. Change History

| Date | Change |
|---|---|
| 2026-10-04 | Ticket raised from the TASK-1036 programme (OD-28, OD-23). Owner approved. |
| 2026-10-06 | Status corrected to Review (code merged in TASK-1036 wave C); changeset added; SDK family versioned 5.0.0 with TASK-1042 + TASK-1045 (TASK-1045 D-41). |
