# TASK-461 — SDK Reconnect UX + Transcript Wire Contract (C6-02 · C6-03 · C6-04 · C5-05)

- **Status**: Completed — all 4 ACs (C6-02/03/04, C5-05) met + adversarially reviewed (budget follow-up applied); gates green; only the owner's own push/PR to main remains
- **Type**: bugfix (clinician-facing reliability UX + realtime data integrity)
- **Branch (implemented)**: `fix/task-461-sdk-reconnect` (from `fix/2605-review` HEAD `87b33f57`)
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

All four findings fixed via strict TDD (RED captured before each fix). Changes are confined to the 7 manifest files; TASK-464's store/provider path (`agenticStore` / `useArcaAudio` / `PluginManager` / `packages/stt`), the server emitters, and all barrels are untouched.

### C6-02 — stuck on `reconnecting` after a successful auto-reconnect

**Deviation from the scaffold's premise (verified against code).** The register assumed `onReconnect` "fires on a *successful* reconnect". It does not: `SttV2WebSocketClient.attemptReconnect()` fires `onReconnectCb` at attempt-**start** (during backoff, before `connect()` — the method's own doc-comment says "Called when a reconnection attempt **starts**"), and `onopen` fired **no** callback on a reconnect open. So there was no reconnect-**success** signal to key off. Keying `streaming` off `onReconnect` would flip a clinical surface to a false "live" during the whole backoff/attempt window (worse than a stuck spinner). Fix:

- `SttV2WebSocketClient.ts` — added an additive, back-compatible reconnect-**success** callback: private `onReconnectedCb`, a public `onReconnected(cb)` registrar, and one firing site in `onopen` guarded by `wasReconnecting` (fires only on a reconnect open, never the initial connect). No change to `onReconnect`/`acknowledgeConnection`/reset logic.
- `use-live-stt-session.ts` — added `onReconnected?` to the structural `SttStreamClient` view and registered a handler that sets `streaming`, guarded by the same `statusRef` check the `onDisconnect` handler uses (:300) so a `stopping`/`idle` in flight is never clobbered. `onReconnect` still sets `reconnecting` (attempt in progress); the redundant set is left as-is.

### C6-03 — terminal reconnect failure leaked the mic + gateway session slot

- `use-live-stt-session.ts` — `onReconnectFailed` now mirrors the handshake-fail cleanup (:335-341): `wsClientRef.current = null` → `releaseAudio()` → `void closeStreamSession(sessionIdRef.current)` (null-guarded, no double-close) + null the session ref → `setSession(null)` → `setError(GENERIC_AUTH_COPY)` → `setStatus('error')`. No hot mic, no held concurrency slot.

### C6-04 — `normalizeTranscript` dropped the whole transcript on any missing/mistyped field; no shared wire type

- `types/stt-v2.ts` — introduced the shared **wire-contract** type `WsTranscriptWirePayload`: the raw server→client transcript exactly as it arrives (all-optional, dual-cased `camelCase | snake_case`, `unknown`-typed values, index signature so a `JSON.parse` result stays assignable). Additive; no consumer recompiles.
- `SttV2WebSocketClient.ts` — `normalizeTranscript` now takes `WsTranscriptWirePayload` (the type is **referenced by the parser**, not just declared) and degrades gracefully: only a payload with no string `text` (truly unusable) is dropped; absent `startTime`/`endTime` default to `0`; a new `coerceIsFinal()` helper accepts boolean, **numeric** `1`/`0`, and string `'1'`/`'0'`, defaulting to `false` (partial) — an absent/odd `is_final` never costs the caption. All existing dual-casing / `seq` / `stableChars` / `utteranceIndex` / `resultType` resume metadata handling is preserved unchanged.

### C5-05 — browser auto-NER minted a fresh `crypto.randomUUID()` per extraction → dedup never matched

- `KnowledgePipeline.ts` — `executeNER` now derives a **stable** id via a module-local `stableEntityId(entityType, text, startOffset, endOffset)` (FNV-1a 32-bit over the composite → `ner-xxxxxxxx`). A hash is used so the id carries **no PHI** (entity text can surface in logs). Re-extractions of the same entity keep one identity, so the store's id-keyed dedup (`agenticStore.addEntities`) collapses them; genuinely distinct entities still get distinct ids (no over-collapse).

### Tests (RED → GREEN)

| Finding | RED evidence (before fix) | Test(s) added/updated |
|---|---|---|
| C6-02 | client: `reconnectClient.onReconnected is not a function`; hook: `expected 'reconnecting' to be 'streaming'` | `SttV2WebSocketClient.test.ts` (fires `onReconnected` only on reconnect open, not initial connect); `use-live-stt-session.test.tsx` (recovered → `streaming`) + a guard test (late success never resurrects a stopped session) + `onReconnected` added to the test fake |
| C6-03 | hook: `expected "vi.fn()" [micTrack.stop] to be called at least once` | `use-live-stt-session.test.tsx` (terminal failure → mic released, capture destroyed, session DELETEd, meta cleared) |
| C6-04 | client: `expected null not to be null` (text-only + numeric `is_final` payloads dropped) | `SttV2WebSocketClient.test.ts` (missing timing/`isFinal` keeps the caption; numeric `is_final`; metadata rides through; no-text/non-string-text still rejected) |
| C5-05 | pipeline: two different UUIDs (`34e4…` ≠ `8bca…`) | `KnowledgePipeline.test.ts` (stable id across re-extractions + one deduped row; distinct entities → distinct ids). Two pre-existing tests that asserted the old **UUID-format** id (the behaviour C5-05 removes) were updated to the stable-id contract (kept their distinctness assertions, added a determinism check). |

### Verification gate (evidence)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/vox test` | **3516 passed** (198 files) |
| `pnpm --filter @arcaai/vox build` | **success** (ESM/CJS/DTS) |
| `pnpm --filter @arcaai/vox lint` | **0 errors** (71 pre-existing `prettier/prettier` warnings in untouched files; my 3 source files: 0 warnings — test files are excluded by the lint ignore pattern) |
| `pnpm --filter @arcaai/vox typecheck` | **10 pre-existing errors, unchanged by this ticket** — proven by re-running `tsc --noEmit` with my changes stashed (identical error set). All are in unrelated test files (`bundle-externals.task364.test.ts`, `useHarnessAdmin.test.ts`, `promptMetrics.test.ts`, and an `Int16Array` cast at `SttV2WebSocketClient.test.ts:334`, far above my edits). My changes add **zero** new type errors; fixing those files is outside the manifest. |
| `pnpm --filter @arcaai/admin-console test` | **843 passed** (111 files) |

> Fresh-worktree prerequisites (per the ticket note): `pnpm install`, then `turbo run build` for the workspace deps (`@arcaai/ui`, `@arcaai/vox`, `@arcaai/stt`, …) so Vitest can resolve their `dist` entries — otherwise ~42 admin-console suites fail on `Failed to resolve entry for package "@arcaai/ui"` before any test runs.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from TASK-448 findings C6-02/03/04 + C5-05 as Wave 3 (P2). All four re-verified OPEN against the current `fix/2605-review` tree: C6-02 (`reconnecting` set at :310, `streaming` only at :374), C6-03 (`onReconnectFailed` :312-315 has no cleanup vs handshake path :336-337), C6-04 (drop guard at `normalizeTranscript` :629; `WsTranscriptResult` in `types/stt-v2.ts`), C5-05 (`crypto.randomUUID()` at KnowledgePipeline :453). 464↔461 file-disjoint parallelization + 454→461 rebase recorded. No implementation. |
| 2026-07-10 | **Implemented all four findings via TDD** on `fix/task-461-sdk-reconnect` (from `fix/2605-review` HEAD `87b33f57`). C6-02: added an additive reconnect-**success** callback `onReconnected` to `SttV2WebSocketClient` (fired in `onopen` when `wasReconnecting`) and consumed it in the hook to reset to `streaming` (statusRef-guarded) — **deviation from the scaffold**, which wrongly assumed `onReconnect` was the success signal (code shows it fires at attempt-**start**, and `onopen` fired no success callback; keying `streaming` off it would falsely read "live" during backoff). C6-03: `onReconnectFailed` now mirrors the handshake-fail cleanup (`releaseAudio` + `closeStreamSession` + null refs). C6-04: introduced shared wire-contract type `WsTranscriptWirePayload` in `types/stt-v2.ts`, re-typed + made `normalizeTranscript` tolerant (text-required; timing defaults; numeric/`'1'`/`'0'` `is_final` coercion via `coerceIsFinal`), preserving all resume metadata. C5-05: stable FNV-1a `stableEntityId(type\|text\|offsets)` replaces `randomUUID()`; two pre-existing UUID-format tests updated to the stable-id contract. Gates: vox test 3516✓, build✓, lint 0-errors✓, admin-console test 843✓; vox typecheck has 10 **pre-existing** errors in unrelated test files (proven identical with changes stashed — zero added, all outside the manifest). Status → Review. |
| 2026-07-10 | **Follow-up review fix — reconnect-attempt budget (C6-02 sibling), surfaced by this ticket's adversarial review, out of the original scope.** `acknowledgeConnection()` (the reconnect-attempt-counter reset) had **no production caller**, so after a successful auto-reconnect the counter was never reset: the `maxAttempts` budget depleted **cumulatively across a session** instead of per-disconnect-episode — a stream that reconnects a couple of times and then drops again could find its budget already exhausted and give up prematurely (a stuck/failed clinical stream that should have retried). Naïvely resetting in `onopen` (the first-proposed fix) would **regress `BUG-04`** ([SttV2WebSocketClient.test.ts:1059](packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts)): a bare `onopen` can't distinguish a stable reconnect from a socket that opens then immediately flaps, and BUG-04 deliberately requires flapping to still exhaust `maxAttempts`/fire `onReconnectFailed`. **Chosen approach:** reset on the **first server message after a reconnect** (the "session is genuinely alive" signal) — wired the existing `acknowledgeConnection()` into `handleMessage`, guarded by `isReconnecting`. A flap that closes before any message never reaches it → BUG-04 preserved; a working reconnect resets on the server's resume reply → each disconnect episode gets a full budget. `onopen`/`onReconnected`/`attemptReconnect` reset logic unchanged (this supersedes the C6-02 summary's "no change to acknowledgeConnection" note — the method is now auto-invoked). Added RED-first test (`SttV2WebSocketClient.test.ts`, TASK-2605): reconnect+message → `getReconnectAttempts()` back to `0` → a later drop gets the full 3-attempt budget before `onReconnectFailed` (RED without the fix: counter stuck at `2`). Within the file-ownership manifest (`SttV2WebSocketClient.ts` + its test). Gates: `pnpm --filter @arcaai/vox test` **3517 passed** (198 files; BUG-04 and the manual-`acknowledgeConnection` test both still green); changed source lint 0-errors/0-warnings and the +70 added test lines are byte-identical to prettier-canonical (repo config); vox typecheck pre-existing errors unchanged (zero added). On `fix/2605-review`. |
| 2026-07-11 | **Closed (Status → Completed).** Closure-review pass (owner directive): all 4 ACs met with pasted evidence (vox 3517 passed / build ✓ / lint 0), adversarial review ran and its one follow-up (reconnect-attempt budget) was applied + re-verified; the 10 vox typecheck errors proven pre-existing/unchanged in unrelated out-of-manifest test files. No external work remains — only the owner's git push/PR to main. |
