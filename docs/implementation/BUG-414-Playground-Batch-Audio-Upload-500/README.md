# BUG-414 — Batch transcription "Upload audio" fails with Internal Server Error

- **Status:** Pending
- **Type:** bugfix
- **Source:** https://github.com/ArcaAI/ALaaSv3.0/issues/414 (NeenaPanicker, 2026-05-04; 1 screenshot, no repro details, no file/format/size, no server log)
- **Severity:** High if reproducible (core flow), but unactionable as filed
- **Verdict:** open — insufficient evidence; probable causes identified, unconfirmed

## Requirement Analysis

Uploading audio in the Playground batch/job transcription tab returned a 500. No file type, size, tenant, date/time or request id was supplied.

## Current State Evaluation

- Client: `features/playground-live-transcription/components/batch-tab.tsx` validates type/size against `ACCEPTED_AUDIO_MIME_TYPES` / `MAX_UPLOAD_BYTES` before upload; the queue (`lib/batch-queue.ts`) calls `api/client.ts:57 uploadBatchAudio` → multipart POST `audio/transcription-jobs/transcribe` through the BFF proxy.
- Server path: gateway resolves the ASR agent into a `ResolvedAsrSpec` (rule 06; `RESOLVED_SPEC_REQUIRED` is a named refusal) and enqueues a Dramatiq job in apps/stt; MinIO writes in between. A 500 (rather than a named 4xx) means an unmapped exception in that chain.
- Candidate causes from repo history: ASR optional-stage failures previously surfaced as 409/500 until TASK-1048 degraded them with notices (909c8db54); the pre-agent pipeline path was removed in TASK-1006/1012 (54b19669f) — a build from April-May could 500 on a missing pipeline/agent; storage/bucket resolution (tenant storage config cascade); ingress body limit. Memory notes also record ml-en model loading and GPU OOM time-slicing as dev-box failure modes.
- The "no named 4xx" gap is itself a defect: the gateway should map these to typed errors with `correlationId` (rule 05 Errors).

## Root Cause

Unknown from the artefacts. Needs the failing request id → Loki/Tempo trace (`mcp grafana`) on the dev cluster, or a local repro with a small WAV through the live stack.

## Implementation Plan

1. Request from reporter: file format/size/duration, tenant, approximate UTC time, the `correlationId` from the toast/response.
2. Reproduce on the current build with 3 fixtures (wav small, mp3 large near `MAX_UPLOAD_BYTES`, m4a). One live pass by the orchestrator only (shared stack; no model changes without approval).
3. If a 500 persists: RED test in `apps/api` controller/service asserting the failing precondition maps to a typed 4xx/503; fix at the origin; client shows the `correlationId` (`GatewayError`).
Verification commands: `pnpm --filter @arcaai/admin-console test`, `pnpm admin:typecheck`, `pnpm admin:lint`, then a manual headed pass (`next-dev-loop` skill) in both themes. Per the owner rule, a lane runs only its own new/changed test files; the orchestrator gates after merge.

## Risks / Open Questions

- OD: close as cannot-reproduce after one clean current-build pass, or keep open pending the reporter's data?
- Live repro touches STT/GPU: requires explicit approval for any model load.

## Implementation Summary

Not started.

## Change History

| Date | Change |
|---|---|
| 2026-10-06 | Ticket created (read-and-document lane; no code changed). |
