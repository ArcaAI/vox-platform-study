# TASK-454 — Client Audio-Drop Visibility (C6-01)

- **Status**: Review — implemented, adversarially reviewed, merged to `fix/task-449-wave1`; final landing pending
- **Type**: bugfix (patient-safety — silent clinical data loss)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0)
- **Finding**: C6-01 (High, CONFIRMED ✓C) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch**: `fix/task-454-audio-drop-visibility` (cut from `main`)
- **Size**: M
- **Suggested agent**: general-purpose (React + TS SDK)

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts` | Honor `sendAudioFrame` boolean + register `onBackpressureDrop`; expose degraded/dropped state |
| `apps/admin-console/src/features/playground-live-transcription/components/streaming-tab.tsx` | Degraded banner + dropped-frame counter |
| `apps/admin-console/src/features/playground-live-transcription/api/__tests__/use-live-stt-session.test.tsx` | Drop-path coverage |
| `packages/stt/src/providers/StreamingBackendSTTProvider.ts` | Honor the boolean return at the SDK call site (tighten `boolean \| void` → `boolean`) |
| `packages/stt/src/providers/__tests__/StreamingBackendSTTProvider.test.ts` | Drop-path coverage |

**Do NOT modify** `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts` — the drop plumbing (`sendAudioFrame` boolean return, `onBackpressureDrop`, `getDroppedFrameCount`, the 1 MiB watermark) already exists and is well-tested; this ticket only *consumes* it at the two call sites. Do NOT touch `PluginManager.ts` or `StreamingSessionManager.ts`. `apps/ui-playground/**` is deprecated — ignore its caller. Anything outside the manifest → STOP and report.

## Requirement Analysis

The client 1 MiB `bufferedAmount` watermark in `SttWebSocketClient` silently drops outbound audio, and **neither caller reacts**: `sendAudioFrame` returns `false` on drop but both call sites discard it, and nothing in production registers `onBackpressureDrop` or reads `getDroppedFrameCount()`. Dropped PCM never reaches the durable transcript, and there is no clinician-visible signal — the clinician believes the encounter is fully captured. The drop plumbing is already built and tested at the client level (TASK-298 D-15); the defect is purely that the two consumers ignore it and no UI surfaces it.

**Scope clarification from the scout**: the "two stacks" share ONE watermark implementation inside `@arcaai/vox`'s `SttWebSocketClient`. There are exactly two live call sites to fix — the admin-console direct hook ([use-live-stt-session.ts:324]) and the SDK provider ([StreamingBackendSTTProvider.ts:216]). Only the `buffered_amount_high` reason is ever emitted (`queue_full` is declared but dead), so the degraded signal maps 1:1 to WS send-buffer backpressure.

### Acceptance criteria

- [ ] **AC-1 (red — hook)**: a `use-live-stt-session` test drives `sendAudioFrame` returning `false` (buffer over watermark) and asserts the hook currently exposes NO degraded/dropped signal — fails once the assertion expects one. (The existing fake returns `true` unconditionally, [use-live-stt-session.test.tsx:50-53] — the test must be able to return `false`.)
- [ ] **AC-2 (hook)**: the hook registers `onBackpressureDrop` on the client and reads/exposes a dropped-frame count + a boolean "connection degraded" state in `UseLiveSttSessionResult`; the count resets with the session/reconnect (mirroring the client's reset-on-connect).
- [ ] **AC-3 (UI)**: `streaming-tab.tsx` renders a degraded-connection banner (following the existing mic-permission warning pattern, [streaming-tab.tsx:144-146]) and a dropped-frame counter (in the status-badge cluster, [streaming-tab.tsx:122-128], or the transcript footer meta). Follows `11-ux-ui-principles.md` (visible feedback, semantic tokens, both themes) and `10-skeleton-loading.md` where relevant.
- [ ] **AC-4 (red — SDK provider)**: a `StreamingBackendSTTProvider` test drives `sendAudioFrame` returning `false` and asserts the drop is observed (counter / callback), not silently swallowed — fails against current code.
- [ ] **AC-5 (SDK provider)**: the provider honors the boolean return (surfaces/accounts for the drop) and its duck-typed client interface tightens `boolean | void` → `boolean` ([StreamingBackendSTTProvider.ts:85]) so the signal isn't discarded at the type boundary.
- [ ] **AC-6 (no behavior regression)**: below the watermark, every frame is still sent exactly as today; the fix adds signalling only.
- [ ] **AC-7**: WCAG — the degraded banner is announced (live region / role), icon-not-color-alone, ≥ 4.5:1 contrast in both themes; a11y check per `web-accessibility` skill.
- [ ] **AC-8**: verification gate green, output pasted into §Implementation Summary.

### Non-goals

- Changing the 1 MiB watermark value or the drop policy itself (client-side, out of scope).
- Reconnect-recovered status (C6-02), terminal-failure mic cleanup (C6-03), wire-contract type (C6-04) → TASK-461 (Wave 3).
- Any server-side durability change (that's the consumer-groups work, TASK-457) — this ticket makes loss *visible*, it does not make the transport lossless.
- The deprecated `apps/ui-playground` caller ([use-realtime-transcription.ts:379]).

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Hook discards the boolean** ([use-live-stt-session.ts:322-324](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts)):

```ts
captureRef.current = await createAudioCapture(audioContext, track, (frame) => {
    if (!client.isConnected()) return;
    client.sendAudioFrame(float32ToInt16(frame));   // ← return ignored; drop is silent
});
```

Public state `UseLiveSttSessionResult` ([:85-103]) has no dropped/degraded field (only `status`, `error`, `reconnectAttempt`, …). The hook registers only `onTranscript`/`onWsError`/`onDisconnect`/`onReconnect`/`onReconnectFailed` ([:261-296]) — never `onBackpressureDrop`.

**Client plumbing already exists (do not edit)** ([SttWebSocketClient.ts](packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts)): `sendAudioFrame` returns `false` on drop (:345-353); `onBackpressureDrop(cb)` (:384-387); `getDroppedFrameCount()` (:374-377); reset-on-connect (:278); watermark check `shouldDropForBufferedAmount` (:891-895), default 1 MiB (:141, applied :200). Only `buffered_amount_high` is emitted; `queue_full` is dead.

**SDK provider discards it too** ([StreamingBackendSTTProvider.ts:207-217](packages/stt/src/providers/StreamingBackendSTTProvider.ts)): `this.wsClient.sendAudioFrame(int16);` return dropped; duck-typed interface widens return to `boolean | void` ([:85]).

**UI surfaces** ([streaming-tab.tsx](apps/admin-console/src/features/playground-live-transcription/components/streaming-tab.tsx)): status-badge cluster (:122-128, already shows `Reconnect attempt N`), mic-permission warning banner pattern (:144-146), transcript footer meta (:200-204).

**Test gaps**: hook fake returns `true` unconditionally ([use-live-stt-session.test.tsx:50-53]); provider mock `sendAudioFrame: vi.fn(() => true)` ([StreamingBackendSTTProvider.test.ts:26]) — no drop coverage at either caller. (Client-level drop is well covered at [SttWebSocketClient.test.ts:1722-1787].)

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-449 §Architecture preamble (dropped PCM here is lost from the **durable transcript** — this is real clinical data loss made visible, not cosmetic) · `.claude/rules/13-nextjs-apps.md`, `.claude/rules/07-react-ui.md`, `.claude/rules/11-ux-ui-principles.md`, `.claude/rules/08-vox-sdk.md`.

1. **RED (hook)** (AC-1): make the fake able to return `false`; assert the hook exposes a degraded/dropped signal. Red. Commit.
2. **GREEN (hook)** (AC-2): register `onBackpressureDrop`, track count + degraded boolean in hook state. Green. Commit.
3. **UI** (AC-3/AC-7): banner + counter in `streaming-tab.tsx`; verify both themes + a11y in a running `next dev` (prefer the `next-dev-loop` skill).
4. **RED (SDK provider)** (AC-4): fake returns `false`; assert drop observed. Red. Commit.
5. **GREEN (SDK provider)** (AC-5): honor the boolean, tighten the interface type. Green. Commit.
6. Regression: below-watermark send unchanged (AC-6).

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm --filter @arcaai/admin-console build lint test
pnpm --filter @arcaai/stt build test lint typecheck   # confirm exact filter name in package.json
pnpm lint
# Runtime: verify the degraded banner appears under simulated backpressure in a running next dev (next-dev-loop skill) — screenshot both themes.
```

Adversarial review focus (reviewer agent): (a) is EVERY drop path now visible at both call sites, or only the hook? (b) does the degraded state clear correctly on recovery/reconnect (no stuck banner)? (c) is the below-watermark send byte-for-byte unchanged? (d) a11y — announced, not color-only, contrast in both themes? (e) confirm `SttWebSocketClient.ts` is untouched; zero diff outside the manifest.

## Implementation Summary

**Branch**: `fix/task-454-audio-drop-visibility` (2 commits: `a48d7b28` fix, `e72e720f` review cleanups) — merged into `fix/task-449-wave1`.

**What shipped**: both callers now honor `sendAudioFrame`'s boolean and the client's `onBackpressureDrop`. The admin-console hook exposes a per-connection `droppedFrameCount` (resets on reconnect) AND a session-sticky `audioLostThisSession` latch (survives reconnect, clears only on start/stop); `streaming-tab.tsx` renders a degraded banner + live count. The SDK provider (`StreamingBackendSTTProvider`) honors the return, counts drops (`getDroppedFrameCount`), and its client interface is tightened `boolean | void` → `boolean`. `SttWebSocketClient.ts` untouched (its plumbing already existed).

**Gates**: `@arcaai/admin-console` build/lint clean + **840 tests**; `@arcaai/stt` **411 tests**. RED captured for the hook and provider drop paths; new `DegradedBanner` a11y render test (3/3: `role=status`, `aria-live=polite`, `aria-hidden` count, icon+text).

**Adversarial review**: no Critical — the key risk (does `onBackpressureDrop?.()` fire in production?) was **refuted**: the hook always constructs the real client, which always implements the method, so it always fires. Fixed on review: the reconnect reset erased the loss signal exactly when loss happens (backpressure precedes the disconnect) → replaced with the session-sticky latch above; banner copy changed to past/stative.

**Discovered → [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md)**: the provider COUNTS drops but nothing reads the count, so the vox SDK consultation path is still silent (only the playground surfaces it). Tracked separately.

**Deferred**: a live both-theme browser screenshot of the banner (needs an authenticated live session + a real >1 MiB backpressure drop) — covered instead by `next build` compile + the a11y render test + both-theme-by-construction (semantic tokens defined in both themes).

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 finding C6-01; both call sites, the already-built client drop plumbing, UI surfaces, and test gaps re-verified against code by read-only scout (confirmed one shared watermark impl, two live callers, `queue_full` dead). No implementation started. |
| 2026-07-09 | Implemented (TDD) + adversarially reviewed. Production callback-registration refuted-safe; reconnect signal-erasure fixed with a session-sticky latch; a11y render test added. Review discovered the SDK path is still silent → TASK-464. Merged to `fix/task-449-wave1` (integration build green). |
