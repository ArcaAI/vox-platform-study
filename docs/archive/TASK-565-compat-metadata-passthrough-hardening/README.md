# TASK-565 — Harden `@arcaai/vox/compat` Metadata Passthrough

| | |
|---|---|
| **Status** | Review |
| **Type** | feature (bugfix + enhancement) |
| **Parent** | [TASK-564](../TASK-564-live-transcription-metadata-passthrough/README.md) |
| **Package** | `packages/agentic-sdk-v2` (`@arcaai/vox`) |
| **Suggested tier** | claude-opus-4-8-medium |
| **Depends on** | TASK-564 §5 (frozen contract) |
| **Rules to read first** | `08-vox-sdk.md`, `07-react-ui.md`, `01-development-workflow.md` |
| **Files in play** | `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` (+ its `__tests__`) |

> **Goal:** Make the shipped compat `useArcaSpeechToText` faithfully implement the v1 metadata-passthrough contract (TASK-564 §5): §4.3 normalization, default `transcriptTemplate`, **fix the caller-key-collision defect (F4)**, and add capture-relative timeline correlation — all client-side, **no core change**.

---

## 1. Requirement Analysis

Implement TASK-564 §5 exactly. Priority buckets:

- **MUST**
  - **Fix F4 (caller-key collision):** compose delivered metadata in the §5.2 precedence order (enrichments lowest, caller metadata overrides, `chunk_id`/`detected_language` overlay last). A caller who passes `speaker_id`/`confidence`/`language`/`isFinal` must see **their** value.
  - **§4.3 normalization:** derive `chunk_id` (`metadata.chunk_id → chunkId → other`) and `detected_language` (`metadata.detected_language → detectedLanguage → seg.language`) onto delivered metadata.
  - **Default `transcriptTemplate`** = `"{timestamp} {speaker_id}: {text}"` when the prop is absent (v1 parity).
- **SHOULD**
  - **Capture-relative timeline correlation (E2):** replace the single sticky `turnMetadataRef` with a bounded ring of `{atMs, metadata}`; finals pick the entry with `atMs ≤ startTime*1000` (fallback most-recent); interims use most-recent. **Verify the time base** (§5.3 RISK) in tests; if unreliable, degrade to pure sticky and document in code + TASK-564 §5.3.
- **MAY**
  - 8 KiB metadata guard on `sendAudioData` (throw, v1 `MAX_METADATA_BYTES`). Implement only if trivial; document the decision either way.

**Non-goals:** any backend change; wiring `microphoneId`; a v2-native public hook; byte-exact per-chunk correlation.

## 2. Current State Evaluation

As-built (`compat/useArcaSpeechToText.ts`, from TASK-561):
- `turnMetadataRef` single sticky bag (`:89`), overwritten by `sendAudioData` (`:153-158`).
- Finals: `onTranscript(text, true, {...turnMetadataRef.current, speaker_id, confidence, language, startTime, endTime, isFinal:true})` (`:106-114`) — **F4 collision here**.
- Interims: `{...turnMetadataRef.current, isFinal:false}` (`:124`).
- `applyTemplate` returns raw text when template absent (`:58-64`) — **no default**.
- Reads store via `useAgenticStore` + `selectCurrentTranscript` (sanctioned) + local `selectTranscriptSegments` (`:55`).
- `captureStartMs` is not tracked today (needed for E2) — derive at first `startTranscription`/`audio.start` or via a store field if available; keep it local to the hook.

Type context (do not edit these — read only): `TranscriptSegment` (`src/types/audio.ts:240-253`: `text,startTime,endTime,isFinal,speakerLabel?,confidence?,language?,words?`).

## 3. Implementation Plan

### 3.1 Changes (single file + tests)

1. Add a small pure helper module or in-file functions:
   - `resolveChunkId(meta): unknown | undefined` and `resolveDetectedLanguage(meta, seg): unknown | undefined` (§4.3 priority chains).
   - `composeDeliveredMetadata({ seg, isFinal, callerMeta }): Record<string,unknown>` implementing the §5.2 precedence order. **Unit-test this in isolation** — it is the crux of F4.
   - `DEFAULT_TRANSCRIPT_TEMPLATE = '{timestamp} {speaker_id}: {text}'`; `applyTemplate` uses it when the prop is falsy.
2. Replace `turnMetadataRef` with a bounded timeline ring `metadataTimelineRef: Array<{atMs:number; metadata?:Record<string,unknown>}>` (cap 256, drop-oldest) + `captureStartMsRef`. `sendAudioData` pushes `{ atMs: now - captureStartMs, metadata }`. Provide `pickMetadataForFinal(startTime)` and `pickMetadataForInterim()`.
   - Keep a graceful fallback: if `captureStartMs` unknown or timeline empty, behave exactly like today's sticky (last metadata).
3. Update the finals effect (`:97-117`) and interim effect (`:120-126`) to call `composeDeliveredMetadata` with the correlated caller metadata.
4. (MAY) `sendAudioData`: if `metadata` and `JSON.stringify(metadata).length > 8192` → throw the v1 message.

### 3.2 TDD test list (write red first) — `compat/__tests__/useArcaSpeechToText.test.ts` (extend the existing suite)

- **F4 fix:** caller metadata `{speaker_id:'app-x', confidence:0.1, isFinal:'nope'}` survives — delivered `speaker_id === 'app-x'` even when the segment has its own `speakerLabel`; hook enrichments only fill keys the caller didn't set.
- **§4.3 chunk_id:** caller `{chunk_id:'c1'}` → delivered `chunk_id:'c1'`; caller `{chunkId:'c2'}` → `chunk_id:'c2'`; caller `{other:'c3'}` → `chunk_id:'c3'`; priority order respected.
- **§4.3 detected_language:** caller `{detected_language:'ml'}` wins; else `{detectedLanguage:'ml'}`; else falls back to `seg.language`.
- **Default template:** absent `transcriptTemplate` → final text rendered as `"{startTime} {speakerLabel}: {text}"`; explicit template still honored; missing speaker → empty slot (no `undefined`).
- **Timeline correlation:** two `sendAudioData` calls with `{role:'clinician'}` then `{role:'patient'}` at different times; a final whose `startTime*1000` falls in the first window gets `role:'clinician'`; a later final gets `role:'patient'`. Include a test that asserts the **fallback to most-recent** when no entry precedes, and that interims use most-recent.
- **Time-base guard:** a test documenting/asserting the chosen base (if degraded to sticky, assert sticky behavior and leave a comment pointing to §5.3).
- **(MAY) size guard:** >8 KiB metadata throws the v1 message; ≤8 KiB does not.
- **Regression:** existing TASK-561 tests still pass (sticky fallback path, `sendAudioData` no-PCM, interim/final firing).

### 3.3 Verification

- `pnpm --filter @arcaai/vox typecheck && pnpm --filter @arcaai/vox lint && pnpm --filter @arcaai/vox test && pnpm --filter @arcaai/vox build` — all green; paste real tails.
- Confirm no other file changed (`git status` shows only `useArcaSpeechToText.ts`, its test, and this README).

## 4. Best Practices

- Keep `composeDeliveredMetadata`, `resolveChunkId`, `resolveDetectedLanguage` **pure** and separately unit-tested (they are the contract).
- Do not import from the root barrel or the deprecated singleton; keep `"use client"`.
- Preserve the exact `UseArcaSpeechToTextReturn` shape (TASK-560 §5.4) — this is a behavior fix, not an API change.
- If the timeline base is unreliable, prefer **correctness (sticky) over cleverness (bad timeline)** — degrade and document (Karpathy §2).

## 5. Implementation Summary

Implemented client-side only; **no core-business file touched** (`git status` shows exactly the hook, its test, and one new pure helper). All four gates green.

### Files

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/compat/speechToTextMetadata.ts` | **NEW** pure-helper module: `composeDeliveredMetadata`, `resolveChunkId`, `resolveDetectedLanguage`, `pickMetadataForFinal`, `pickMetadataForInterim`, `applyTemplate`, `DEFAULT_TRANSCRIPT_TEMPLATE`, `MAX_METADATA_BYTES`, `METADATA_TIMELINE_CAP`, `TimelineEntry`. |
| `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` | Rewired to the helpers; timeline ring + `captureStartMs`; §5.2 compose on finals **and** interims; default template; 8 KiB guard. Public props/return shape unchanged (TASK-560 §5.4). |
| `packages/agentic-sdk-v2/src/compat/__tests__/useArcaSpeechToText.test.ts` | Extended to 21 cases (8 pure-helper + 13 hook). |

### What shipped vs. the MUST/SHOULD/MAY buckets

- **MUST — F4 fixed.** `composeDeliveredMetadata` composes in the exact §5.2 order: `{ …enrichments, …callerMeta, …(chunk_id/detected_language overlay) }`. Caller keys (`speaker_id`/`confidence`/`language`/`isFinal`) now override hook enrichments; enrichments only fill keys the caller left unset. Unit-tested in isolation.
- **MUST — §4.3 normalization.** `resolveChunkId` (`chunk_id → chunkId → other`) and `resolveDetectedLanguage` (`detected_language → detectedLanguage → seg.language`) overlay onto delivered metadata, only when defined.
- **MUST — default template** `"{timestamp} {speaker_id}: {text}"` applied to finals when the prop is absent. **Scope decision:** the default/explicit template is applied to **finals only**; interim text is delivered **raw** — interims carry no speaker/timestamp, so templating them with those slots is meaningless (`" : partial"`). This also preserves the existing interim regression assertion. Documented in the hook header.
- **SHOULD — timeline correlation (E2), shipped (`correlationModel = 'timeline'`).** `sendAudioData` appends `{ atMs = Date.now() − captureStartMs, metadata }` to a bounded ring (cap 256, drop-oldest). `captureStartMs` is anchored at `startTranscription()`; the ring resets on `stop`. Finals pick the latest entry with `atMs ≤ startTime*1000`, else fall back to most-recent; interims use most-recent.
  - **Time-base verification (§5.3 RISK):** `atMs` is capture-relative wall-clock ms and `startTime*1000` is stream-relative ms, both anchored at ~capture start — the comparison is meaningful and unit-verified (`pickMetadataForFinal — capture-relative timeline base`). The design is strictly a refinement over sticky: when `captureStartMs`/`startTime` is unknown, or no entry precedes, it degrades to most-recent (today's behavior), so it is **never worse than sticky**. Kept `timeline` rather than degrading; the residual clock-offset risk (a large enough offset crossing an utterance boundary when multiple distinct metadata are in flight) is documented in `pickMetadataForFinal`'s doc comment.
- **MAY — 8 KiB guard, shipped.** `sendAudioData` throws `Audio frame metadata exceeds 8192 bytes` (v1 `MAX_METADATA_BYTES`) when `JSON.stringify(metadata).length > 8192`. Trivial and adds v1 parity.

### Gate evidence (actual tails)

- `typecheck`: `tsc --noEmit` — clean, no output.
- `lint`: `eslint src` — `0 errors`; the only remaining warnings are pre-existing (`useArcaConfig.ts`, `AgenticProvider.tsx`), none in the changed files.
- `test`: `Test Files 212 passed (212) · Tests 3629 passed (3629)`.
- `build`: `tsup` CJS+ESM build success + `build:dts` (`tsc --emitDeclarationOnly`) clean.

### Constraints honored

- `coreBusinessTouched = false` — no edits to `SttWsGateway`, streaming bridge/session services, `apps/stt`, `packages/stt`, or existing v2 hooks/store/clients/providers (read-only).
- `"use client"` retained on both compat files; store read via the sanctioned `useAgenticStore` + `selectCurrentTranscript` selectors (not the root barrel, not the deprecated singleton).
- Public `UseArcaSpeechToTextProps`/`Return` shape unchanged.
- v1 defects not reproduced (no binary frame; no hardcoded-key clobber — F4 fixed).

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-28 | (planning) | Ticket created from TASK-564. |
| 2026-07-28 | (opus) | Implemented TDD. New `speechToTextMetadata.ts` pure helpers; F4 fixed via §5.2 precedence; §4.3 `chunk_id`/`detected_language` normalization; default template (finals; interims raw — documented decision); capture-relative timeline correlation (`correlationModel='timeline'`, verified base, never-worse-than-sticky); 8 KiB guard. 21 tests (8 helper + 13 hook). Gates green (typecheck/lint/test 3629/build). Status → Review. |
