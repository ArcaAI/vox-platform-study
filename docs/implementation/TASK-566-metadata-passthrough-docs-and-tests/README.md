# TASK-566 — Metadata-Passthrough Doc, Example & Contract Tests

| | |
|---|---|
| **Status** | Pending |
| **Type** | docs + tests |
| **Parent** | [TASK-564](../TASK-564-live-transcription-metadata-passthrough/README.md) |
| **Depends on** | TASK-565 (as-built hook) |
| **Suggested tier** | sonnet-5-high (doc + example) · claude-opus-4-8-medium (contract tests) |
| **Rules to read first** | `08-vox-sdk.md`, `01-development-workflow.md` |

> **Goal:** Give app engineers the v2 equivalent of the v1 `live-transcription-websocket-metadata.md` — honest about what changed — a runnable metadata-tagging example, and contract tests that lock the TASK-564 §5 round-trip so future v2 changes can't silently break it.

---

## 1. Requirement Analysis

Three deliverables:
1. **v2 metadata-passthrough doc** — the migration-facing counterpart to the v1 doc.
2. **Example** — extend the compat example to tag audio with metadata and render it back off `onTranscript`.
3. **Contract tests** — lock the §5.2 delivered-metadata shape (incl. the F4 fix) and §4.3 normalization.

## 2. Current State Evaluation

- v1 doc to mirror/contrast: `…/HOPE/docs/packages/agentic-sdk/docs/live-transcription-websocket-metadata.md` (esp. §4 contract, §9 known gaps, §10 v2 differences, §11 example).
- Existing compat example: `apps/example/src/compat-consultation.tsx` + `compat.html` (from TASK-563) — extend, don't fork.
- Existing migration guide: `docs/implementation/TASK-560-v1-v2-consultation-migration/MIGRATION_GUIDE.md` — add a metadata section + link.
- Contract-test precedent: `packages/agentic-sdk-v2/src/compat/__tests__/contract.test.ts` and `tests/contracts/smr-compat.*` (TASK-563).

## 3. Implementation Plan

### 3.1 Doc — `docs/implementation/TASK-564-live-transcription-metadata-passthrough/METADATA_PASSTHROUGH.md`

Sections:
- **What round-trips** — `sendAudioData(pcm, metadata)` → `onTranscript(text, isFinal, metadata)`; the §5.2 delivered-metadata shape; the §4.3 `chunk_id`/`detected_language` normalization.
- **What changed from v1 (be honest):**
  - Passthrough is **client-side** in v2 (no server echo); PCM is not pushed (v2 owns transport).
  - Correlation is **utterance-sticky (+ optional timeline)** — a coarse session/device/role tag, not byte-exact (same real guarantee as v1 §9.3).
  - **Device identity is lost after mixing** — pass `device_id`/`role` as caller metadata (it round-trips opaquely); the derived source signal is diarization `speaker_id`/`speakerLabel`.
  - Caller metadata keys are never overwritten by hook fields (F4 fixed); only `chunk_id`/`detected_language` overlay last.
  - `transcriptTemplate` defaults to `"{timestamp} {speaker_id}: {text}"`.
- **Limitations table** — no backend echo, no per-source device tag, coarse correlation, `detected_language` is session-configured unless code-switching populates it.
- **Example** — the §3.2 code inline.
- **Deferred** — the latent `microphoneId` wire field + a future backend-echo ticket (TASK-564 §7).

### 3.2 Example — extend `apps/example/src/compat-consultation.tsx`

Add metadata tagging to the live-transcription section: call `stt.sendAudioData(new ArrayBuffer(0), { device_id:'mic-1', role:'clinician', chunk_id: nextId(), consultationId })` at turn boundaries, and render `metadata.device_id`/`metadata.chunk_id`/`metadata.speaker_id` next to each transcript line. Keep it framework-light and runnable (`compat.html`). Update `apps/example/README.md` run snippet.

### 3.3 Contract tests

- **SDK contract** (`packages/agentic-sdk-v2/src/compat/__tests__/` — extend `contract.test.ts` or a new `metadata-passthrough.contract.test.ts`): assert the delivered-metadata precedence (§5.2) — enrichments lowest, caller overrides, `chunk_id`/`detected_language` last; assert §4.3 resolution chains; assert default template. A drift guard: if the composition order regresses (caller key clobbered), the test fails.
- **Golden fixture** under `tests/fixtures/` — a canned sequence of `sendAudioData` metadata + segments and the expected delivered-metadata objects, so shape drift fails CI.

### 3.4 Verification

- `pnpm --filter @arcaai/vox test` green (incl. new contract tests); paste tail.
- Example typechecks/builds (`pnpm --filter @arcaai/example build` or the vite build used by TASK-563).
- Guide/doc reviewed against the **as-built** TASK-565 hook (no drift). If 565 changed anything vs §5, update TASK-564 §5 first, then the doc.

## 4. Best Practices

- Reference TASK-564 §5 as the authority; don't restate the contract divergently.
- Keep the tone honest (mirror the v1 doc's own §9 candor) — no "zero-change" overselling.
- Hermetic tests; no live stack required.

## 5. Implementation Summary
_(pending)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | (planning) | Ticket created from TASK-564. |
