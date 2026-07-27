# TASK-563 — v1→v2 Migration Guide, Example & Contract/E2E Tests

| | |
|---|---|
| **Status** | Pending |
| **Type** | docs + tests |
| **Parent** | [TASK-560](../TASK-560-v1-v2-consultation-migration/README.md) |
| **Depends on** | TASK-561 (SDK hooks) **and** TASK-562 (endpoints) landed |
| **Suggested tier** | sonnet-5-high (guide + example) · claude-opus-4-8-medium (contract/e2e tests) |

> **Goal:** Give application engineers a concrete, copy-pasteable migration path, prove it with a working example, and lock the v1 contract shapes with cross-version tests so future v2 changes can't silently break migrated apps.

---

## 1. Requirement Analysis

Three deliverables:
1. **Migration guide** — a v1→v2 mapping doc app engineers follow: import changes, the one `<AgenticProvider>`/`<ArcaCompatProvider>` wrapper, config adapter, hook-by-hook diffs, behavior notes (metadata sink, pull vs push transcripts, doctorId dropped), and the endpoint path parity table.
2. **Working example** — the full workflow (session → mixed-stream record → live transcripts → stop → summary) using `@arcaai/vox/compat`, runnable.
3. **Contract + e2e tests** — assert the compat SDK output and the shim endpoints match the frozen v1 shapes (TASK-560 §5).

## 2. Current State Evaluation

- `apps/example` is a deliberate raw-WebSocket demo (not an SDK consumer) — good host for a NEW compat example page, or add a `apps/example/src/compat-consultation.*`. Alternatively demonstrate in the playground consultation screen (TASK-543) — but keep the canonical example framework-light so v1 teams recognize it.
- v1 reference workflow to mirror 1:1: TASK-560 §J of the v1 SDK inventory (the exact code a v1 app writes today).
- Contract sources of truth: TASK-560 §5 + `SMR_Summary_Endpoints.md`.

## 3. Implementation Plan

### 3.1 Migration guide — `docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md`

Sections:
- **TL;DR checklist** (3 steps): wrap app once; swap imports `@arcaai/agentic-sdk` → `@arcaai/vox/compat`; map `SDK_CONFIG_OPTIONS` via `mapV1ConfigToAgenticConfig` (or use `<ArcaCompatProvider options={…}>`).
- **Side-by-side hook table**: v1 hook/method → v2 compat equivalent → behavior notes/caveats.
- **Behavioral differences that need app awareness** (from TASK-560 §2.2/§6): `doctorId` dropped (server-derived); transcripts are pull-state but `onTranscript` still fires; `sendAudioData` metadata is a sink; live backend transcription needs a `pipelineId`; mixed-stream is now real (`secondaryDeviceId`) — optional upgrade; summary returns per-turn segments now.
- **Endpoint parity table**: `/api/smr/api/v1/summary/sync` + `/presummary` unchanged path + `x-api-key`; async/session/STT-WS raw endpoints not reproduced (use SDK).
- **"What you must change vs. what stays"** matrix.
- **Before/after full code sample** (the §3.2 example inline).

### 3.2 Working example

- `apps/example/…/compat-consultation.tsx` (or a small standalone) implementing TASK-560 §J verbatim but on `@arcaai/vox/compat`, wrapped in `<ArcaCompatProvider>`. Demonstrates: `useArcaSessionManager` create+start, `useAudioCapture`+`useArcaSpeechToText` live transcript render (interim + final), stop, `useSMR.summarizeSync`, render `Enhanced` summary.
- README snippet: how to run it against a local gateway.

### 3.3 Contract tests

- **SDK contract** (`packages/agentic-sdk-v2` vitest): assert `@arcaai/vox/compat` hook return shapes match TASK-560 §5.2/§5.3 (type-level + runtime for `useSMR` response pass-through). A `expectTypeOf` / structural assertion that the v1 `SummaryResponse`/`MedicalSession` shapes are honored.
- **Endpoint contract** (`apps/api` e2e, may reuse TASK-562's spec or extend): POST real requests, validate responses against a JSON-schema copy of TASK-560 §5.4/§5.5 (Enhanced + Simplified + PreSummary). Include the `x-api-key` auth matrix and a cross-tenant isolation case.
- **Regression lock**: a golden fixture (a canned `SessionData`) + its expected structural response keys, so schema drift fails CI.

### 3.4 E2E workflow test (optional, if live stack available)

- Playwright driving the example: start session → feed a fixture audio (or mock STT) → assert transcript segments render → stop → assert a summary renders. Gate behind the same infra the SDK e2e uses; keep hermetic where possible.

### 3.5 Verification

- Guide reviewed against the actual compat API (no drift from TASK-561/562 as-built).
- Example builds and runs; screenshot/log evidence captured.
- Contract tests green in `pnpm --filter @arcaai/vox test` and `pnpm test:e2e`.

## 4. Best Practices

- Keep the guide honest about the *unavoidable* change (one Provider wrapper) — don't oversell "zero change."
- Golden fixtures live under `tests/` fixtures; reference TASK-560 §5 as the authority, don't restate schemas divergently.
- If TASK-561/562 changed any signature during build, update TASK-560 §5 first (source of truth), then this guide.

## 5. Implementation Summary
_(pending)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created from TASK-560. |
