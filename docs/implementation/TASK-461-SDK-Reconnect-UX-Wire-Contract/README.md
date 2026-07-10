# TASK-461 — SDK Reconnect UX + Transcript Wire Contract (C6-02 · C6-03 · C6-04 · C5-05)

- **Status**: Pending
- **Type**: bugfix (clinician-facing reliability UX + realtime data integrity)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 3 (P2)
- **Findings**: C6-02 (Med, observability) · C6-03 (Med, reliability-durability) · C6-04 (Med, correctness) · C5-05 (Med, nlp-summary-quality) — all CONFIRMED — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch (when scheduled)**: `fix/task-461-sdk-reconnect-wire-contract` (from the current `fix/2605-review` HEAD)
- **Size**: M
- **Suggested agent**: general-purpose (React / vox SDK)

## ⚠️ Cross-stream coordination

Two ledger entries govern this ticket:

1. **[TASK-454](../TASK-454-Client-Audio-Drop-Visibility/README.md) already landed on `use-live-stt-session.ts` + `SttV2WebSocketClient.ts`** (C6-01 drop-surfacing — the `onBackpressureDrop`/`audioLostThisSession`/`droppedFrameCount` machinery you now see at [use-live-stt-session.ts:316-323](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts) is TASK-454's). TASK-461 builds on that landed state — do not revert or duplicate it. Per the [Wave-1→2 ledger](../TASK-449-Harness-Loop-Remediation-Program/README.md#cross-stream-conflict-ledger-wave-1--wave-2), **454 merged first**; 461 rebases onto it.
2. **TASK-461 shares `packages/agentic-sdk-v2` with [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md) but is FILE-DISJOINT** — 464 owns the vox store/provider path (`agenticStore` / `useArcaAudio` / `PluginManager` + `packages/stt`), 461 owns `use-live-stt-session.ts` / `SttV2WebSocketClient.ts` / `KnowledgePipeline.ts` / `types/stt-v2.ts`. They never touch the same file, so they **parallelize**. See the [program ledger row](../TASK-449-Harness-Loop-Remediation-Program/README.md#cross-stream-conflict-ledger-wave-1--wave-2).

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts` | Reset status to `streaming` on reconnect success (C6-02); release mic + close gateway session on terminal reconnect failure (C6-03) |
| `apps/admin-console/src/features/playground-live-transcription/api/__tests__/use-live-stt-session.test.tsx` | RED-first reconnect-recovered + terminal-cleanup tests |
| `packages/agentic-sdk-v2/src/types/stt-v2.ts` | Introduce the shared transcript **wire-contract** type (the `dts` type the register asks for) that both `normalizeTranscript` and consumers reference |
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | Tolerant `normalizeTranscript` — parse against the shared type; a missing/mistyped OPTIONAL field no longer discards the whole transcript (C6-04) |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | RED-first partial-payload tolerance test |
| `packages/agentic-sdk-v2/src/core/KnowledgePipeline.ts` | Stable, content/offset-derived entity id (C5-05) |
| `packages/agentic-sdk-v2/src/core/__tests__/KnowledgePipeline.test.ts` | RED-first re-extraction dedup test |

Touching the vox store/provider path (`agenticStore` / `useArcaAudio` / `PluginManager` / `packages/stt` — TASK-464's territory), the gateway/STT-v2 **emitters** of the wire payload (`apps/api`, `apps/stt-v2` — the server side of the contract), or a barrel/`index.ts` re-export → STOP and report. Anything outside the manifest → STOP.

## Requirement Analysis

Four SDK/playground defects that leave the clinician-facing realtime surface either lying about its state or quietly corrupting data. All four are on the best-effort REALTIME loop (never the durable transcript), so the harm is UX/observability + live-note quality — but on a clinical surface a stuck "reconnecting" spinner and a silently-dropped caption both erode trust and can prompt a needless restart mid-consultation.

### C6-02 (Med) — direct hook stays stuck on `reconnecting` after a SUCCESSFUL auto-reconnect
`onReconnect` ([use-live-stt-session.ts:304-311](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts)) records the attempt, resets the per-connection dropped-frame counter, and sets `setStatus('reconnecting')` (:310) — but **nothing ever transitions back to `streaming`** once the socket recovers. `setStatus('streaming')` appears **only** in `start()` (:374), which the reconnect path does not re-enter. The client's `onReconnect` fires on a *successful* reconnect (it carries the attempt number), so the hook lands on `reconnecting` and stays there for the rest of a healthy session. The clinician reads a permanent "reconnecting" and assumes the pipe is broken → restarts a working consultation.

### C6-03 (Med) — terminal reconnect failure leaks the mic + the gateway session slot
`onReconnectFailed` ([use-live-stt-session.ts:312-315](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts)) sets `setError(GENERIC_AUTH_COPY)` + `setStatus('error')` and **returns without cleanup**. Contrast the handshake-failure path in the same file ([:333-342]) which, on a failed `connect()`, correctly `releaseAudio()` (:336) + `void closeStreamSession(created.sessionId)` (:337) + nulls the refs. So when reconnection is exhausted mid-session, the microphone track stays live (recording indicator on, privacy surprise) and the gateway-side streaming session is never `DELETE`d — the concurrency slot is held until it reaps. The capture-error path ([:362-372]) is the third correct cleanup exemplar to mirror.

### C6-04 (Med) — `normalizeTranscript` discards the whole transcript on any missing/mistyped field; still no shared wire-contract type
`normalizeTranscript` ([SttV2WebSocketClient.ts:614-660](packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts)) hand-mirrors the server payload with dual-cased fallbacks, then a single hard guard (:629) `if (typeof msg.text !== 'string' || startTime == null || endTime == null || isFinal == null) return null;` **drops the entire transcript** the moment any one of `text`/`startTime`/`endTime`/`isFinal` is absent or the wrong type (e.g. a numeric `is_final` the branch didn't anticipate, a server that omits timing on a partial). The consumer type `WsTranscriptResult` lives in [types/stt-v2.ts](packages/agentic-sdk-v2/src/types/stt-v2.ts) but there is **no single shared wire-contract type** that both this parser and the gateway/STT emitters agree on — the mapping is a brittle hand-mirror (`dts:false` in the register). Target: a shared transcript wire-contract type + tolerant parsing that degrades gracefully (keep the caption text; default/omit the optional metadata) instead of dropping the whole message.

### C5-05 (Med) — browser auto-NER mints a fresh `crypto.randomUUID()` per extraction → dedup never matches, entities accumulate
`executeNER` ([KnowledgePipeline.ts:452-459](packages/agentic-sdk-v2/src/core/KnowledgePipeline.ts)) maps every extracted entity to `{ id: crypto.randomUUID(), ... }` (:453). Because the id is random per run and auto-NER re-extracts over overlapping/rolling text, the downstream store dedup (which keys on `id`) **never matches across extractions** → the same clinical entity accumulates duplicate rows, each with per-segment (meaningless) offsets. Fix: derive a **stable** id from the entity content + normalized span (e.g. a hash of `entityType|text|globalOffset`) so a re-extracted entity keeps its identity and dedup collapses it.

### Acceptance criteria

- [ ] **C6-02 (red first)**: a test drives the hook through disconnect → `onReconnect(success)` and asserts the status returns to `streaming` (currently it stays `reconnecting`). Then reset to `streaming` on reconnect success. A recovered stream must read as live. Do not clobber a concurrent `stopping`/`idle` transition (mirror the `statusRef` guard the disconnect handler already uses at :300).
- [ ] **C6-03 (red first)**: a test exhausts reconnection (`onReconnectFailed`) and asserts the mic track is released AND the gateway session is closed (currently neither happens). Then `releaseAudio()` + `void closeStreamSession(...)` + null the refs, mirroring the handshake-fail path (:336-337). No leaked mic, no held slot.
- [ ] **C6-04 (red first)**: a test feeds a transcript payload missing an OPTIONAL field (and one with a numeric `is_final`) and asserts the caption text still surfaces (currently the whole message is dropped). Then introduce the shared wire-contract type in `types/stt-v2.ts` and make `normalizeTranscript` tolerant — only a truly unusable payload (no text) is dropped; optional metadata absence degrades, not discards. Keep the existing dual-casing/`seq`/`stableChars`/`utteranceIndex` handling.
- [ ] **C5-05 (red first)**: a test extracts the same entity twice and asserts one deduped store entry (currently two). Then derive a stable content/offset id. Identical entity across re-extractions → one row.
- [ ] **AC-gate**: `pnpm --filter @arcaai/admin-console test` + `pnpm --filter @arcaai/vox build test lint typecheck` green; output pasted.

### Non-goals

- The vox SDK **provider/consultation** drop-surfacing path (C6-01 sibling) → [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md). Do not touch `agenticStore`/`useArcaAudio`/`PluginManager`/`packages/stt`.
- The server (gateway/STT-v2) side of the wire contract — C6-04 introduces the type in the SDK and parses tolerantly; making the emitters import a shared package-level type is a separate cross-package change (STOP-and-report if it seems required).
- Re-architecting reconnect/backoff (the client already owns attempts + ticket refresh); this ticket only fixes the hook's reaction to the client's existing reconnect callbacks.
- The deprecated `apps/ui-playground` transcription hook — out of scope (deprecated app).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review`)

- **C6-02**: `onReconnect` sets `reconnecting` at [use-live-stt-session.ts:310]; the only `setStatus('streaming')` is [:374] inside `start()`. The reconnect path never re-enters `start()`. Confirmed stuck-state. (TASK-454's C6-01 additions — `onBackpressureDrop`, `audioLostThisSession`, `droppedFrameCount` reset at :309 — are present and correct; leave them.)
- **C6-03**: `onReconnectFailed` [:312-315] sets error+status only; the handshake-fail catch [:333-342] does `releaseAudio()` [:336] + `closeStreamSession()` [:337] + ref-null — the exemplar to mirror. Capture-error catch [:362-372] is a second exemplar.
- **C6-04**: `normalizeTranscript` [SttV2WebSocketClient.ts:614-660], hard drop guard [:629]; consumer type `WsTranscriptResult` at [types/stt-v2.ts](packages/agentic-sdk-v2/src/types/stt-v2.ts); dual-cased `seq`/`stableChars`/`utteranceIndex`/`resultType` handling [:641-664] must be preserved.
- **C5-05**: random id at [KnowledgePipeline.ts:453]; entity shape `MedicalEntity` in [types/context.ts](packages/agentic-sdk-v2/src/types/context.ts). Browser branch is `stage.location === 'browser' || 'auto'` [:445].
- **Test gaps**: `use-live-stt-session.test.tsx` has no reconnect-recovered or terminal-cleanup coverage; `SttV2WebSocketClient.test.ts` has no partial-payload-tolerance case (the parser's drop is untested); `KnowledgePipeline.test.ts` has no re-extraction dedup case.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (all four defects are on the **best-effort REALTIME loop** — never the durable transcript; do not "harden" them into the durable path) · `.claude/rules/13-nextjs-apps.md` (the hook) + `.claude/rules/08-vox-sdk.md` (the SDK client/pipeline/types) + `.claude/rules/07-react-ui.md`.

1. RED→GREEN per finding, independent. Suggested order: C6-02 → C6-03 (both in the hook, mirror the existing cleanup exemplars) → C6-04 (define the shared type first, then make the parser tolerant against it) → C5-05 (stable id + dedup test).
2. Each: failing test first (capture red), minimal fix, green. Behavior over implementation.
3. For C6-04, keep the wire-contract type change additive so consumers compile unchanged.

### Verification gate

```bash
pnpm --filter @arcaai/admin-console test
pnpm --filter @arcaai/vox build test lint typecheck
```

Adversarial review focus: (a) C6-02 — does the status correctly settle on `streaming` WITHOUT overriding a legitimate `stopping`/`idle` in-flight (the `statusRef` guard)? (b) C6-03 — is cleanup now identical to the handshake/capture paths (mic released, session closed, refs nulled), with no double-close crash? (c) C6-04 — is a genuinely unusable payload still rejected while a partial one survives? did the shared type actually get referenced by the parser (not just declared)? no regression to `seq`/`stableChars` resume metadata? (d) C5-05 — is the id stable across re-extractions AND still unique across genuinely-distinct entities (no over-collapse)? (e) zero diff outside the manifest; TASK-464's store/provider files untouched.

## Implementation Summary

_Pending — not yet implemented._

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from TASK-448 findings C6-02/03/04 + C5-05 as Wave 3 (P2). All four re-verified OPEN against the current `fix/2605-review` tree: C6-02 (`reconnecting` set at :310, `streaming` only at :374), C6-03 (`onReconnectFailed` :312-315 has no cleanup vs handshake path :336-337), C6-04 (drop guard at `normalizeTranscript` :629; `WsTranscriptResult` in `types/stt-v2.ts`), C5-05 (`crypto.randomUUID()` at KnowledgePipeline :453). 464↔461 file-disjoint parallelization + 454→461 rebase recorded. No implementation. |
