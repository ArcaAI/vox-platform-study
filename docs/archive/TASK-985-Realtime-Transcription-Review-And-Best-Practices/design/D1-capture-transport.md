# D1 — Browser Capture & Transport: design dossier (TASK-985)

Area: `@arcaai/vox` (packages/agentic-sdk-v2), `@arcaai/stt`, `@arcaai/room`, `@arcaai/vox-node`
realtime-STT socket, `apps/admin-console` playground, `apps/example` demo.
Findings owned: M-02, M-05, M-06, M-27 (client half), M-28, M-33, M-36, M-53, M-54, M-55, M-56,
M-63, M-69; QW-2, QW-11; BP-3, BP-8; OD-L, OD-K.

All line numbers verified against `dev-2.2` in this worktree (`agent/agent-transcription-coordination-9dbc25`,
based on `3f9145a98`) on 2026-09-19. No code was changed — read-only research + design.

---

## 1. QW-2 — stop defaulting `language`/`languageMode` (M-02)

### 1.1 The mechanism (verified)

The backend backfill this defeats is a plain Python truthiness check:

```python
# apps/stt/src/stt/streaming/session_manager.py:1107
if not language_mode:
    language_mode = _language_mode_for_declared_language(language)
    if not language_mode and not language:
        language_mode = bundle.spec.decoding.language_mode   # ← the agent's ml-en mode
```

`'auto'` is a non-empty Python string, so it is **truthy** — `if not language_mode` is `False`
whenever the SDK sends `languageMode: 'auto'`, and the agent's own catalog mode is never read.
`language_modes.py:427` confirms `'auto'` is itself a real catalog entry
(`ResolvedInference(language=None, code_switching=False, ...)`), not a "no opinion" sentinel — so
sending it is actively wrong, not merely redundant.

### 1.2 Every place that manufactures a literal today (four, not one)

| # | File:line | What it does | Fix |
|---|---|---|---|
| 1 | `packages/agentic-sdk-v2/src/store/agenticStore.ts:405` | Initial state `audioLanguage: 'en'` | Change to `audioLanguage: undefined` (widen the store field type from `string` to `string \| undefined` — check `AgenticStore` interface in the same file/`store/types.ts` and update it alongside). This is the ONLY store-level change needed; `useArcaAudio.ts:425`'s `options?.language ?? store.audioLanguage` already degrades correctly to `undefined` once the store default is gone. |
| 2 | `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:434` | `languageMode: options?.languageMode ?? store.sttLanguageMode ?? 'auto'` | Drop the trailing `?? 'auto'`: `languageMode: options?.languageMode ?? store.sttLanguageMode`. Delete the comment block above it (lines ~426-433) that justifies defaulting to `'auto'` — it is exactly the reasoning M-02 refutes (a 'auto' catalog entry is not equivalent to "let the agent decide"). |
| 3 | `packages/agentic-sdk-v2/src/core/PluginManager.ts` `buildAudioPluginConfig` (~line 663-664) | `language: this.runtimeOptions.language ?? prefs?.language ?? sttConfig.language ?? DEFAULT_STT_CONFIG.language` and `languageMode: this.runtimeOptions.languageMode ?? sttConfig.languageMode ?? 'auto'` | Drop BOTH trailing `?? DEFAULT_STT_CONFIG.language` and `?? 'auto'`. Result: `language: this.runtimeOptions.language ?? prefs?.language ?? sttConfig.language` and `languageMode: this.runtimeOptions.languageMode ?? sttConfig.languageMode`. `sttConfig.language`/`sttConfig.languageMode` come from `AppConfig` (see #4) and must themselves resolve to `undefined` when the tenant/user declared nothing. |
| 4 | `packages/agentic-sdk-v2/src/core/ConfigSchema.ts:51` | `SttConfigSchema.language = v.optional(v.string(), 'en')` (valibot schema default) | Change to `v.optional(v.string())` — no default, so an un-set tenant/user preference parses to `undefined` instead of `'en'`. `languageMode` has no schema field at all today; leave that (it travels only through `runtimeOptions`/store, not `AppConfig`). Do NOT touch `UiConfigSchema.language` (`ConfigSchema.ts:69`) — that is the UI locale picker, unrelated to STT. |
| 5 | `packages/agentic-sdk-v2/src/core/constants.ts:663-667` | `DEFAULT_STT_CONFIG = { enabled: true, provider: 'auto', language: 'en' }` | Once #3 stops reading `.language` off this constant, it becomes reachable only via other STT surfaces (check with a repo-wide `grep -rn DEFAULT_STT_CONFIG` before deleting the field — do not remove speculatively; if a local-provider-only caller still needs it, keep `.language` there but stop PluginManager's BACKEND-streaming path from consulting it). |

Session-body construction downstream of these four (`StreamingSessionManager.createSession` →
`this.normalizeSelection(request)` → `apiClient.post(STT_ENDPOINTS.CREATE_SESSION, body)`,
`packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:101-115`) needs **no change**: an
`undefined` field is dropped by `JSON.stringify`, so once nothing upstream forces a literal, the
wire body simply omits `language`/`languageMode` — which is exactly the "no opinion" the backend's
`if not language_mode:` branch is written to detect.

### 1.3 The one remaining defensive default — leave it, but only for the LOCAL provider

`packages/stt/src/core/STTProcessor.ts` has **six** sites doing `audio.language ?? DEFAULT_LANGUAGE_LOCALE`
(`'en-US'`, `types/index.ts:76`): lines ~200 (debug log), ~312 (`getLanguage()` public getter),
~596 (`getLocalProviderCacheKey`), ~635 (`initializeLocalProvider` → `LocalProviderConfig.language`),
~715-722 (`initializeRemoteProvider` → non-streaming `RemoteProviderConfig.language`), and
**~780 (`initializeStreamingRemoteProvider` → `provider.init({ language: ..., languageMode: this.options.audio?.languageMode, ... })`, the STREAMING session-create path)**.

Only the last one is in scope for QW-2 (it feeds `StreamingBackendSTTProvider.init` →
`StreamingSessionManager.createSession`, the same wire body §1.2 fixes). Change line ~780 from:

```ts
language: audio.language ?? DEFAULT_LANGUAGE_LOCALE,
```
to
```ts
language: audio.language,   // no default — let the backend's tenant→agent cascade decide
```

Leave `languageMode: this.options.audio?.languageMode` on the same call untouched (it already
passes `undefined` through). **Do not touch the other five sites** — `getLocalProviderCacheKey`
and `initializeLocalProvider` construct a config for the in-browser Whisper engine, which has no
backend agent to fall back to and genuinely needs a locale; `getLanguage()` is a display getter
whose return type (`LanguageLocale`, non-optional) would need a wider signature to change, and it
is not wire-affecting. `initializeRemoteProvider` (~715) is a *different*, non-streaming remote
path (`RemoteSTTProvider`, batch-shaped) — out of scope for this streaming-transport review.

### 1.4 Regression guard: `audio.start({})` sends neither field

New test, same shape as `packages/stt/src/__tests__/prompt-wiring.test.ts` /
`numThreads-wiring.test.ts` (mock the transport boundary, assert the constructed request):

```ts
// packages/agentic-sdk-v2/src/__tests__/language-wiring.task985.test.ts
it('audio.start({}) with no language/languageMode declared sends neither field on session create', async () => {
  const postSpy = vi.fn().mockResolvedValue({ sessionId: 's1', wsUrl: 'wss://x', maxConcurrent: 1, currentActive: 0 });
  // ... wire a store + PluginManager + StreamingSessionManager with apiClient.post = postSpy
  await audio.start({}); // no language, no languageMode
  const body = postSpy.mock.calls[0][1];
  expect(body).not.toHaveProperty('language');
  expect(body).not.toHaveProperty('languageMode');
});

it('audio.start({ language: "ml", languageMode: "ml-en" }) still forwards an explicit declaration', async () => {
  await audio.start({ language: 'ml', languageMode: 'ml-en' });
  const body = postSpy.mock.calls[0][1];
  expect(body.language).toBe('ml');
  expect(body.languageMode).toBe('ml-en');
});
```

A second, narrower unit test belongs beside `PluginManager`'s existing config-build tests: assert
`buildAudioPluginConfig()` returns `stt.language === undefined` and `stt.languageMode === undefined`
when `runtimeOptions`, `prefs` and `sttConfig` all carry no opinion — this pins §1.2 item 3 directly
without going through the whole hook.

---

## 2. QW-11 — reconnect ring buffer (M-06), interaction with M-36

### 2.1 Where audio is silently dropped today

```ts
// packages/stt/src/providers/StreamingBackendSTTProvider.ts:320-323
async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
  if (!this.processing || !this.wsClient.isConnected()) {
    return;                                    // ← silent, uncounted, unconditional
  }
  ...
```

`wsClient` here is `SttWebSocketClient` (`packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts`).
It already distinguishes `onReconnect(attempt)` (backoff started, socket down),
`onReconnected()` (socket genuinely re-opened — fired from `ws.onopen` at line ~381-384 only
`if (wasReconnecting)`), and `onReconnectFailed()` (attempts exhausted). None of these three is
consumed by `StreamingBackendSTTProvider` today — only `onTranscript`/`onWsError` are wired
(`StreamingBackendSTTProvider.ts:239-246`).

### 2.2 Design

**New state on `StreamingBackendSTTProvider`:**

```ts
private reconnectRing: Int16Array[] = [];       // FIFO of already-Int16 frames
private reconnectRingBytes = 0;
private isReconnectingLocal = false;
private static readonly RECONNECT_RING_MAX_BYTES = 960_000; // 30s @16kHz mono Int16 (16000*2*30)
```

**Wire the three callbacks in `init()`, beside the existing `onTranscript`/`onWsError` block
(`StreamingBackendSTTProvider.ts:239-246`):**

```ts
this.wsClient.onReconnect(() => { this.isReconnectingLocal = true; });
this.wsClient.onReconnected(() => {
  this.isReconnectingLocal = false;
  this.flushReconnectRing();          // FIFO, oldest first — see below
});
this.wsClient.onReconnectFailed(() => {
  this.isReconnectingLocal = false;
  this.reconnectRing = [];            // session is dead; nothing left to replay
  this.reconnectRingBytes = 0;
});
```

**Change `processAudio` (line ~320-345):**

```ts
async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
  if (!this.processing) return;
  const resampled = prepareFloat32ForWhisper(audio, sampleRate);
  const int16 = float32ToInt16(resampled);
  this.totalAudioProcessed += resampled.length / 16000;
  if (int16.length === 0) return;

  if (!this.wsClient.isConnected()) {
    if (this.isReconnectingLocal) {
      this.pushToReconnectRing(int16);   // buffers, drop-oldest past the cap, counted below
    } else {
      // Not mid-reconnect and not connected: genuinely gone (never
      // connected yet, or reconnect exhausted). Nothing to buffer into.
      this.droppedFrameCount++;
      this.onDropCallback?.(this.droppedFrameCount);
    }
    return;
  }
  // ... existing sendAudioFrame path, unchanged
}

private pushToReconnectRing(frame: Int16Array): void {
  this.reconnectRing.push(frame);
  this.reconnectRingBytes += frame.byteLength;
  while (this.reconnectRingBytes > StreamingBackendSTTProvider.RECONNECT_RING_MAX_BYTES && this.reconnectRing.length > 1) {
    const dropped = this.reconnectRing.shift()!;
    this.reconnectRingBytes -= dropped.byteLength;
    this.droppedFrameCount++;
    this.onDropCallback?.(this.droppedFrameCount);   // ring-overflow drop, same channel
  }
}

private flushReconnectRing(): void {
  const frames = this.reconnectRing;
  this.reconnectRing = [];
  this.reconnectRingBytes = 0;
  for (const frame of frames) {
    // Same watermark-gated path live audio uses — a replay that trips the
    // 1 MiB bufferedAmount watermark is counted as an ordinary backpressure
    // drop (existing `onDropCallback` wiring in the live-send branch), not a
    // second reconnect-specific counter.
    const sent = this.wsClient.sendAudioFrame(frame);
    if (sent === false) {
      this.droppedFrameCount++;
      this.onDropCallback?.(this.droppedFrameCount);
    } else {
      this.bytesSent += frame.byteLength;
    }
  }
}
```

### 2.3 Memory ceiling, drop policy, ordering

- **Ceiling**: 960,000 bytes (~937.5 KiB) = 30 s of mono 16 kHz Int16 PCM — matches the review's
  "~30 s" ask and lands just under the existing 1 MiB `bufferedAmount` watermark
  (`SttWebSocketClient.DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK`, `SttWebSocketClient.ts:177`), so
  the two budgets are comparable in magnitude and neither dwarfs the other.
- **Drop policy**: drop-OLDEST once the ring exceeds the ceiling (`while` loop above), because the
  most recent audio is the most likely to still matter once the socket comes back; every eviction
  increments the SAME `droppedFrameCount`/`onDropCallback` channel the existing watermark drop
  uses, so `use-live-stt-session.ts`'s and `useArcaAudio.ts`'s existing "N frames dropped" UI wiring
  (`onAudioDrop` → `store.markAudioLost()` / `store.incrementDroppedFrames()`,
  `useArcaAudio.ts:890-893`) picks this up with **no consumer-side change**.
- **Ordering vs `lastSeq` resume**: `lastSeq`/`resume` govern the SERVER→CLIENT transcript stream
  only (`SttWebSocketClient.sendResumeHandshake`, sent synchronously inside `ws.onopen`,
  `SttWebSocketClient.ts:369-370` — BEFORE `onReconnectedCb?.()` fires at line ~384). Audio frames
  carry no sequence number on the wire (`sendAudioFrame` is a raw binary `ws.send`, no envelope);
  ordering is implicit in send order on one TCP connection. Because `flushReconnectRing()` runs
  from the `onReconnected` callback — which fires strictly AFTER `sendResumeHandshake` in the same
  `ws.onopen` handler — the resume JSON frame is always on the wire before any replayed PCM, and
  replayed PCM is always before newly-captured live PCM (the ring is drained synchronously, and
  `processAudio` for new frames keeps queuing behind it because `isReconnectingLocal` only flips
  to `false` at the top of the SAME callback). No new sequencing primitive is needed.
- **Interaction with the 1 MiB watermark (M-36)**: deliberately NOT double-buffered. The ring is a
  pre-connection queue; `sendAudioFrame`'s watermark is a post-connection admission gate. Flushing
  routes every replayed frame back through `sendAudioFrame`, so a network that is still congested
  immediately after reconnect sheds replay backlog through the existing, already-observable
  backpressure path rather than a bespoke one — see also M-36's own separate recommendation
  (~128 KiB / ~4 s watermark, expose `bufferedAmount / 32000`) in §2.6 of the review; QW-11 does
  not depend on that follow-up landing first.

### 2.4 Test plan

- Unit (`packages/stt/src/__tests__/StreamingBackendSTTProvider.reconnectRing.task985.test.ts`):
  fake `SttWebSocketClient` double exposing `onReconnect`/`onReconnected`/`onReconnectFailed`/
  `isConnected`/`sendAudioFrame`; drive `processAudio()` N times while `isConnected()` returns
  `false` and `onReconnect` has fired, assert frames accumulate up to the byte ceiling and beyond
  it drop-oldest with `onDropCallback` firing once per eviction; then fire `onReconnected` and
  assert `sendAudioFrame` is called with the buffered frames in original push order, followed by
  the next live frame.
- Unit: genuinely-disconnected path (no prior `onReconnect`) still counts every dropped frame via
  `onDropCallback` (was previously silent — this alone closes the "uncounted" half of M-06 even
  before a reconnect is in flight).
- Live (moved into the LIVE loss harness, per the review's own QW-11 text — **request, not mine to
  run**): see §6 measurement request #2.

---

## 3. Tail drain across all four consumers (M-05)

Consumers: (a) `@arcaai/vox` via `useArcaAudio` → `StreamingBackendSTTProvider.destroy()` — already
uses the correct primitive; (b) `apps/admin-console` playground `use-live-stt-session.ts` — bypasses
it; (c) `@arcaai/vox-node` `RealtimeSttSocket` — no promise at all, and a false doc claim;
(d) `apps/example` `LiveTranscriptionDemo.tsx` — stop+close in the same tick.

### 3.1 The shared fix that helps (a), (b) and closes M-23 for both: send `{type:'close'}` from `stopAndDrainOnce`

`SttWebSocketClient.stopAndDrainOnce()` (`SttWebSocketClient.ts:602-692`) already sends
`{type:'stop'}`, waits for the terminal `status`/quiet-window/timeout, then calls
`this.disconnect()` — which only does a raw `ws.close(1000, ...)` (`SttWebSocketClient.ts:537-551`).
It never sends the app-level `{type:'close'}` the gateway is documented to treat as a clean,
immediate finalize with **no grace window**
(`apps/admin-console/src/shared/docs/stt-socket-protocol.ts:118` — *"Tear the session down. Prefer
`stop` first..."*; gateway behavior per the review, `stt-ws.gateway.ts:1303-1308`). Absent that
frame, the gateway sees an ordinary TCP close, starts its 15 s grace window, and — per M-23 —
eventually finalizes with `interrupted = true` even for a clean, intentional Stop.

**Change** (`SttWebSocketClient.ts`, end of `stopAndDrainOnce`, replacing the tail
`this.disconnect();` at line ~691):

```ts
if (this.ws && this.ws.readyState === WebSocket.OPEN) {
  try {
    this.ws.send(JSON.stringify({ type: 'close' }));
  } catch {
    // best-effort — disconnect() below still runs.
  }
}
this.disconnect();
```

This is an internal, non-breaking change (no public signature changes) and fixes M-23 for EVERY
caller of `stopAndDrain()` in one place — including `useArcaAudio`'s already-correct path
(`StreamingBackendSTTProvider.destroy()` → `this.wsClient.stopAndDrain(...)`,
`packages/stt/src/providers/StreamingBackendSTTProvider.ts:356-365`) and, once §3.2 lands, the
playground.

### 3.2 (b) Playground: `use-live-stt-session.ts` — expose/use `stopAndDrain`

Current `stop()` (`apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts:405-423`):

```ts
const stop = useCallback(async () => {
  if (!wsClientRef.current && !sessionIdRef.current) return;
  setStatus('stopping');
  try {
    if (wsClientRef.current?.isConnected()) {
      wsClientRef.current.sendStop();
    }
  } catch { /* best-effort finalize */ }
  releaseAudio();
  wsClientRef.current?.disconnect();     // ← no drain: closes on the SAME tick as sendStop
  wsClientRef.current = null;
  if (sessionIdRef.current) {
    await closeStreamSession(sessionIdRef.current).catch(() => {});
    sessionIdRef.current = null;
  }
  ...
```

**Fix**: mirror `useArcaAudio.stopAudio`'s "release mic synchronously, THEN await the drain"
ordering (`useArcaAudio.ts:1332-1433`):

```ts
const stop = useCallback(async () => {
  if (!wsClientRef.current && !sessionIdRef.current) return;
  setStatus('stopping');

  releaseAudio();   // mic off immediately — unchanged UX

  const client = wsClientRef.current;
  wsClientRef.current = null;
  if (client) {
    if (client.isConnected()) {
      await client.stopAndDrain();   // sends {type:'stop'}, waits, sends {type:'close'} (§3.1), disconnects
    } else {
      client.disconnect();
    }
  }

  if (sessionIdRef.current) {
    await closeStreamSession(sessionIdRef.current).catch(() => {});
    sessionIdRef.current = null;
  }
  ...
```

Drop the separate `sendStop()` call — `stopAndDrain()` sends the same `{type:'stop'}` frame
internally. No new public surface on this hook; `stop` was already `async` and awaited by callers
(`streaming-tab.tsx`).

### 3.3 (c) vox-node `RealtimeSttSocket`: promise-returning `finalize()` + new `waitForClosed()`

Current (`packages/vox-node/src/core/realtime-stt-socket.ts:279-293`):

```ts
/**
 * ...The gateway itself will close this socket once that flush
 * completes; there is no grace window...
 */
finalize(): void {
  this.requireSocket().send(JSON.stringify({ type: 'stop' }));
}
```

The doc string's claim ("the gateway itself will close this socket") is the same false claim M-05
flags in the browser docs — the gateway never proactively closes on `{type:'stop'}` alone; the
class's OWN `close()` (line 317-326) is what sends `{type:'close'}`, and nothing currently calls
`close()` automatically after `finalize()`.

**Design** — `RealtimeSttSocket` already has a typed `on<E>(event, cb): () => void` subscription
(`realtime-stt-socket.ts:206-215`) over `RealtimeSttSocketEvents` (`status`, `close`, ...,
`realtime-stt-socket.ts:70-82`). Add two members:

```ts
/**
 * Finalize the current utterance and END THE SESSION (unchanged wire
 * behavior). Now resolves once the server's terminal `status: 'closed'`
 * frame arrives (or `timeoutMs` elapses) instead of firing-and-forgetting —
 * the caller learns WHEN it is safe to call {@link close}. The gateway does
 * NOT close the socket for you; call `close()` after this resolves (or call
 * {@link waitForClosed} if you already called `close()` yourself and want to
 * await the transport actually tearing down).
 */
finalize(timeoutMs = 5000): Promise<void> {
  this.requireSocket().send(JSON.stringify({ type: 'stop' }));
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; unsub(); resolve(); } }, timeoutMs);
    const unsub = this.on('status', (status) => {
      if (!settled && (status.status === 'closed' || status.status === 'cancelled')) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

/**
 * Resolve when the socket's `close` event fires — i.e. the transport has
 * actually torn down (whether from {@link close}, a server-initiated close,
 * or an unrecoverable error). Use after `finalize()` + `close()` when the
 * caller needs to know teardown is COMPLETE, not merely requested.
 */
waitForClosed(timeoutMs = 5000): Promise<RealtimeSttCloseEvent> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; unsub(); resolve({ requested: this.requestedClose, resuming: false }); }
    }, timeoutMs);
    const unsub = this.on('close', (event) => {
      if (!settled) { settled = true; clearTimeout(timer); unsub(); resolve(event); }
    });
  });
}
```

Rewrite the `finalize()` doc comment (lines 279-286) to remove *"The gateway itself will close this
socket once that flush completes"* and state instead: *"The server answers `status: finalizing`
then `status: closed`; this resolves on that `closed` (or `timeoutMs`). It does NOT close the
socket — call `close()` afterward (or let `autoResume`/the caller decide)."* The `stop()` alias
(line 306-308, `@deprecated`) inherits the new `Promise<void>` return with no further change.

### 3.4 (d) `apps/example/LiveTranscriptionDemo.tsx` — stop+close same tick

Current (`LiveTranscriptionDemo.tsx:166-176`): sends `{type:'stop'}` and `{type:'close'}` back to
back with `ws.close()` immediately after, with zero wait for a tail final. This file hand-rolls the
wire protocol with a raw `WebSocket` rather than using the SDK. Per M-54 (already tracked,
low-severity, "rewrite against the protocol snippet before TASK-901 lands"), the correct fix is to
replace the hand-rolled `WebSocket`/`ScriptProcessor` plumbing with `SttWebSocketClient` from
`@arcaai/vox/core` (as the playground hook already does) and call `.stopAndDrain()` in `stop()` —
at which point §3.1's `{type:'close'}` fix covers this consumer for free and the duplicate
hand-written stop/close send is deleted outright. Given severity `low`/`improvement`, this dossier
records the design but does not propose it as a QW-1 blocker; flagging it as a follow-up is
sufficient (`M-54`'s existing recommendation stands).

### 3.5 Public API changes (see §5 for the full list)

- `RealtimeSttSocket.finalize()`: return type `void` → `Promise<void>` (ADDITIVE/widening — an
  un-awaited call site is unaffected at runtime). `stop()` inherits the same widening.
- `RealtimeSttSocket.waitForClosed()`: NEW public method.
- `SttWebSocketClient.stopAndDrainOnce`/`stopAndDrain`: no signature change, INTERNAL behavior
  change only (now also sends `{type:'close'}`) — not a public API change, but worth a CHANGELOG
  line since it changes observable server-side session accounting (`interrupted` flag).
- `use-live-stt-session.ts` `stop()`: no signature change (already `async`).

---

## 4. `ready`-frame gating (M-22) and the `gap` frame (M-43, client half)

### 4.1 Confirmed wire shapes (gateway side, read-only — not my area to change)

```ts
// apps/api/src/modules/streaming/stt-ws.gateway.ts:813-822
{ type: 'ready', sessionId, fromSeq: session.resultSeq + 1, sessionEpochMs?: number }

// apps/api/src/modules/streaming/stt-ws.gateway.ts:1035-1057
{ type: 'gap', reason: 'egress_partial_dropped', sessionId, droppedPartials: number }
{ type: 'gap', reason: 'egress_overflow', sessionId, droppedSeq?: number }
```

### 4.2 Confirmed client gap (both frame types fall into the `default:` branch)

`SttWebSocketClient`'s `handleMessage` switch (`SttWebSocketClient.ts:1162-1275`) has cases for
`transcript`, `resumed`, `resume_failed`, `status`, `error` — `ready` and `gap` both fall to
`default:` and are logged as `'Unknown WebSocket message type'` WARN
(`SttWebSocketClient.ts:1272-1277`) with no callback fired. Separately, `connect()`
(`SttWebSocketClient.ts:355-385`) resolves its promise from the RAW `ws.onopen` handler — before
any `ready` frame can have arrived — and, on reconnect, `sendResumeHandshake` fires synchronously
in that SAME handler (line ~369-370), i.e. strictly before the gateway's `ready` (which the gateway
emits "after handler registration" per the review's evidence). This is exactly M-22's race.

### 4.3 Design — `ready`

- Add `case 'ready':` to the switch, storing `fromSeq`/`sessionEpochMs` on new private fields
  (`this.serverFromSeq`, `this.sessionEpochMs`) and firing a new `onReadyCb?.()`.
- Change `connect()` to resolve on `ready` instead of `ws.onopen`, with `ws.onopen` still doing its
  existing bookkeeping (session id parse, reconnect-attempt reset) but NOT calling `resolve()`
  directly. Concretely: move the `resolve()` call (currently inline in `ws.onopen`,
  `SttWebSocketClient.ts:356-384`) into the new `ready` case, guarded by a `pendingConnectResolve`
  field set at the top of `connect()`'s executor (mirrors the existing `pendingDrainResolve`
  pattern already used for `stopAndDrain`). Add a fallback: if `ready` never arrives within the
  existing `connect()` `timeoutMs`, the existing timeout-rejection path already fires — no new
  timeout needed.
- **Move `sendResumeHandshake` out of `ws.onopen` into the new `ready` case**, still gated on
  `wasReconnecting` — this is the actual fix for the race (handshake now provably happens after
  the gateway has registered its result-stream handler, since `ready` is emitted only after that
  registration completes, per the review's own evidence for the gateway).
- `onReconnected()` (which currently fires from `ws.onopen`, `SttWebSocketClient.ts:381-384`) moves
  to fire from the `ready` case too, so §2's ring-buffer flush (which listens on `onReconnected`)
  also naturally waits for `ready` — tightening QW-11's ordering guarantee for free.

### 4.4 Design — `gap`

- Add `case 'gap':` firing a new `onGapCb?.(payload: WsGapMessage)` where
  `WsGapMessage = { type: 'gap'; reason: 'egress_partial_dropped' | 'egress_overflow'; sessionId: string; droppedPartials?: number; droppedSeq?: number }`.
  Add `onGap(cb)` registration method beside `onWsError`/`onStatus` (`SttWebSocketClient.ts:706-738`).
- `StreamingBackendSTTProvider` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts`) wires
  `this.wsClient.onGap(...)` beside its existing `onTranscript`/`onWsError` block
  (`StreamingBackendSTTProvider.ts:239-246`) and re-emits through a new `onGapCallback` (same shape
  as the existing `onDropCallback` at line 451-452), so `useArcaAudio`'s plugin-callback wiring
  (`useArcaAudio.ts:886-946`) can add an `onSttGap` handler alongside the existing `onAudioDrop`.
- **`LiveTranscript` rendering** (`packages/ui/src/components/live-transcript/`): add a new
  optional prop `gaps?: LiveTranscriptGap[]` to `LiveTranscriptProps`
  (`packages/ui/src/components/live-transcript/types.ts`, beside `interim`/`segments` at line
  ~46-50), with `interface LiveTranscriptGap { id: string; reason: 'egress_partial_dropped' | 'egress_overflow'; occurredAt: number; droppedSeq?: number }`.
  Render a persistent inline marker row ("Transcript incomplete from here — N seconds of captions
  may be missing") anchored at the point in the segment list where the gap was received (append to
  `segments` render order by `occurredAt` vs each segment's arrival, OR simplest: render as a
  sticky banner above the live region rather than interleaved, since a `gap` carries no `seq`
  anchor into the FINALIZED transcript — `egress_partial_dropped` is partial-only and
  `egress_overflow` may or may not carry `droppedSeq`). This gives a clinician a durable signal
  distinguishing "the room went quiet" from "the transport silently dropped text under a green
  badge" — the exact ask.
- `apps/vox-node`'s `RealtimeSttSocket` already has a typed `gap`... **no** — checked: its
  `RealtimeSttSocketEvents` map (`realtime-stt-socket.ts:70-82`) has `transcript`/`status`/`error`/
  `resumed`/`close` but NO `gap` — add `gap: SttGapMessage` to that map and a `case 'gap':` in its
  message-handling switch (mirrors the browser fix; exact line TBD at implementation time, follow
  the existing `status`/`resumed` case pattern).
- Playground `streaming-tab.tsx`: subscribe to the new gap signal from `use-live-stt-session.ts`
  (which itself needs a new `onGap` wire onto its own `SttWebSocketClient` instance, mirroring the
  `onBackpressureDrop` wiring already present at `use-live-stt-session.ts:345-348`) and render the
  same persistent banner treatment used in `LiveTranscript`.

---

## 5. Dead/contradictory capture knobs (M-33, M-63, M-53, M-55) + governed `audioFrontEnd.capture` for OD-L

### 5.1 M-33 — confirmed dead knobs

`ConfigSchema.ts` declares a fully governed, permission-tagged surface for browser DSP:

```ts
// ConfigSchema.ts:23-35 (AudioConfigSchema)
noiseSuppression, echoCancellation, autoGainControl  // all v.optional(v.boolean(), true)
// ConfigSchema.ts:110-113 (CONFIG_PERMISSIONS)
'audio.noiseSuppression': { permission: 'user', ... }
'audio.echoCancellation':  { permission: 'user', ... }
'audio.autoGainControl':   { permission: 'user', ... }
```

Repo-wide grep for any reader of `audioConfig.echoCancellation` / `.noiseSuppression` /
`.autoGainControl` (i.e. `config.audio.*` from `AppConfig`) returns **zero hits** anywhere in
`packages/agentic-sdk-v2/src` or `apps/admin-console/src`. `PluginManager.buildAudioPluginConfig`
(`PluginManager.ts:640-680`) builds `noiseFilter`/`vad`/`stt` sub-objects from the SAME `AppConfig`
but never touches these three fields. The ONLY thing that reaches `getUserMedia` is the entirely
separate, ephemeral, per-call `AudioStartOptions.audioProcessing` override
(`useArcaAudio.ts:517-531,557-569`, documented at `types/audio.ts:395-415`) — which has no tenant/
admin governance at all. Two disconnected mechanisms, one dead.

### 5.2 M-63 — AudioContextManager singleton race

```ts
// packages/room/src/core/AudioContextManager.ts:107-123
static getInstance(options?: RoomOptions): AudioContextManager {
  if (!AudioContextManager.instance) {
    AudioContextManager.instance = new AudioContextManager(options);   // FIRST caller's rate wins
  } else if (options && ... rate/latencyHint differ) {
    console.warn(...);   // every LATER caller's requested rate is silently ignored
  }
  return AudioContextManager.instance;
}
```

`useArcaAudio.ts:580` calls `AudioContextManager.getInstance({ sampleRate: 48000 })`; TTS playback
(`TtsPlaybackPlayer.ts:49`, not read in this pass but cited by the review) asks for 24 kHz. Whichever
mounts first decides the ACTUAL context rate for the whole page, and the resampler
(`prepareFloat32ForWhisper` → `resampleSinc`, §5.3) then silently operates on whatever rate it was
actually handed — no assertion anywhere that `audioContext.sampleRate === 48000` before capture
starts.

### 5.3 M-53 — stateless resampler edges

`packages/stt/src/utils/audioResampler.ts`: `resampleSinc()` (line ~222) → `resampleWithBank()`
(line ~155-177) is a PURE function called fresh per 80 ms frame via
`prepareFloat32ForWhisper(samples, sampleRate)` (line ~348-354), itself called once per frame from
`StreamingBackendSTTProvider.processAudio` (line ~320-322, see §2.1). Inside `resampleWithBank`,
out-of-range input indices are explicitly zero-padded (*"Out-of-range input indices contribute
zero (edge zero-padding)"*, comment at line ~117) — so the first/last ~16 output samples of every
frame see a truncated 97-tap kernel with no memory of the previous frame's trailing samples.

**Fix**: convert the resample call from a pure function to a small stateful wrapper owned by
`StreamingBackendSTTProvider` for the life of one session:

```ts
// packages/stt/src/utils/audioResampler.ts — new export
export function createStreamingResampler(fromRate: number, toRate: number) {
  let history = new Float32Array(0);   // trailing ~96 input samples from the previous call
  return {
    push(frame: Float32Array): Float32Array {
      if (fromRate === toRate) return frame;
      const extended = new Float32Array(history.length + frame.length);
      extended.set(history);
      extended.set(frame, history.length);
      const resampled = resampleSinc(extended, fromRate, toRate);
      const historyOutputLen = Math.round((history.length * toRate) / fromRate);
      history = extended.slice(-SINC_HISTORY_SAMPLES);   // ~96 samples, one kernel half-width
      return resampled.slice(historyOutputLen);           // drop the portion covering the OLD history
    },
  };
}
```

`StreamingBackendSTTProvider` instantiates one `createStreamingResampler(audioContext.sampleRate, 16000)`
in `init()` and calls `.push(audio)` instead of calling `prepareFloat32ForWhisper` directly in
`processAudio` (line ~322) — `prepareFloat32ForWhisper` itself stays as the STATELESS entry point
for callers that only ever resample one full buffer (e.g. batch/offline paths), so this is additive,
not a breaking change to the existing exported function.

### 5.4 M-55 — playground assumes the context rate it requested

```ts
// apps/admin-console/.../use-live-stt-session.ts:55  const SAMPLE_RATE = 16_000;
// :232  getUserMedia({ audio: { sampleRate: SAMPLE_RATE, ... } })   // hint only
// :256  createStreamSession({ ..., sampleRate: SAMPLE_RATE, ... })  // told to the BACKEND
// :373  new AudioContext({ sampleRate: SAMPLE_RATE })               // hint only, NOT guaranteed
// :375-379  captureRef.current = await createAudioCapture(audioContext, track, (frame) => {
//   client.sendAudioFrame(float32ToInt16(frame));   // ← NO resample, NO rate check
```

`AudioContextOptions.sampleRate` is a REQUEST some engines (notably Safari, and some Linux/ALSA
stacks) silently clamp to the hardware native rate instead of honoring — unlike `useArcaAudio`'s
path, nothing here ever reads back `audioContext.sampleRate` after construction, and nothing
resamples before `sendAudioFrame`. If the browser grants e.g. 48 kHz, the backend is still told
`sampleRate: 16000` (line 256) and receives 3x-too-fast-labeled audio — "2.75 to 3x slowed audio
looks like a model failure" per the review.

**Fix**: after `new AudioContext({ sampleRate: SAMPLE_RATE })` (line 373), read
`audioContext.sampleRate` and, if it differs from `SAMPLE_RATE`, either (a) resample each captured
frame through `createStreamingResampler(audioContext.sampleRate, SAMPLE_RATE)` (§5.3) before
`sendAudioFrame`, or (b) simplest and consistent with this being a reference/playground surface:
pass the ACTUAL `audioContext.sampleRate` to `createStreamSession` (line 256) instead of the
constant, so the session's declared rate always matches what is actually sent — no resample needed,
since the backend already accepts an explicit `sampleRate` field. Prefer (a) for parity with the
production SDK path (fixed 16 kHz wire contract is simpler for the STT service to reason about);
(b) is the smaller diff if this hook stays a reference/demo surface only.

### 5.5 Governed `audioFrontEnd.capture` design for OD-L

Per the task instruction: no env var, tenant → SYSTEM resolution, applied via `applyConstraints`.

- **New resolved field** on `AudioPluginConfig` (the object `PluginManager.buildAudioPluginConfig`
  returns, `PluginManager.ts` return statement at line ~636-680): add
  `audioFrontEnd: { capture: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean } }`,
  populated from the SAME `AudioConfigSchema` fields already declared and permission-tagged
  (§5.1) — `this.config.audio?.echoCancellation` etc. — following the exact `?? DEFAULT_*` pattern
  already used for `noiseFilterConfig`/`vadConfig` two lines above it in the same function. This is
  config governance the app ALREADY resolves through `PersonalizationManager`/`AppConfig`'s
  existing tenant → user cascade (`CONFIG_PERMISSIONS['audio.echoCancellation'].permission === 'user'`
  means a tenant admin sets the platform/tenant default and a user may override it, same as every
  other `permission: 'user'` field) — **no new config tier, no new env var**, it is purely wiring an
  already-governed value through to where capture actually happens.
- **`useArcaAudio.startAudio`** reads this resolved value with the SAME precedence already used for
  `language` (explicit per-call `options.audioProcessing` wins over the resolved cascade value,
  which wins over the browser's own default): merge `pluginManager`'s resolved
  `audioFrontEnd.capture` into `audioProcessingRef.current` (currently built ONLY from
  `options?.audioProcessing`, `useArcaAudio.ts:524-530`) BEFORE the per-call override is applied,
  i.e. `{ ...resolvedCaptureDefaults, ...explicitPerCallOverride }`.
- **Apply via `applyConstraints`, not just the `getUserMedia` request shape** — per the task's
  explicit instruction, and because a `getUserMedia` constraint is only a REQUEST (same caveat as
  §5.4's sample-rate problem): after acquiring each stream (`useArcaAudio.ts:560-569`, both the
  `deviceIds.length === 0` and the per-device loop branches), call
  `track.applyConstraints({ echoCancellation, noiseSuppression, autoGainControl })` on every
  resolved audio track using the SAME merged `audioProcessingRef.current` object, wrapped in a
  try/catch (constraint application can reject on unsupported browsers/devices — log at `debug`,
  never throw, matching the existing defensive posture of the level-meter block a few lines below).
  This also gives runtime source additions (`addSource`, `useArcaAudio.ts:1096-1175`) a second,
  authoritative place to reassert the SAME constraints instead of only the initial `getUserMedia`
  hint, closing a gap the current `audioProcessing` mechanism already has for late-joining mics.
- **OD-L sequencing**: per the task and the review, this wiring should land ONLY after BP-8's
  virtual-mic A/B reports a number (§6, measurement #2) — until then, `TASK-865 F-6`'s "keep all
  three constraints on" stays the SHIPPED default; this section documents the MECHANISM so the
  owner decision has something concrete to approve, not a recommendation to flip today.

---

## 6. Test plan

### 6.1 Unit / component (I can write and the repo can run without live infra)

| Area | New test file | Asserts |
|---|---|---|
| QW-2 | `packages/agentic-sdk-v2/src/__tests__/language-wiring.task985.test.ts` | `audio.start({})` → session-create body has neither `language` nor `languageMode`; `audio.start({ language, languageMode })` forwards both verbatim; `PluginManager.buildAudioPluginConfig()` resolves both to `undefined` absent any opinion |
| QW-11 | `packages/stt/src/__tests__/StreamingBackendSTTProvider.reconnectRing.task985.test.ts` | ring accumulates during `onReconnect`→`isConnected()===false`; drop-oldest past 960,000 bytes with `onDropCallback` per eviction; FIFO replay order on `onReconnected`; genuinely-disconnected (`onReconnect` never fired) path also counts+calls back |
| M-05/QW-1 | `apps/admin-console/.../__tests__/use-live-stt-session.stopDrain.task985.test.tsx` | `stop()` calls `stopAndDrain()` (not raw `disconnect()`) when connected; falls back to `disconnect()` when already disconnected |
| M-05/QW-1 | `packages/agentic-sdk-v2/src/core/__tests__/SttWebSocketClient.closeFrame.task985.test.ts` | `stopAndDrainOnce()` sends `{type:'close'}` immediately before the raw `ws.close()`, only when the socket is still OPEN at drain-end |
| M-05 | `packages/vox-node/src/core/__tests__/realtime-stt-socket.finalize.task985.test.ts` | `finalize()` resolves on a `status: closed` frame; resolves on timeout if none arrives; `waitForClosed()` resolves on the `close` event; doc string no longer asserts gateway auto-close (grep-based doc test, matching the package's existing convention of pinning doc-comment claims, e.g. `deprecation-register.md` parity tests) |
| M-22 | `SttWebSocketClient.readyGating.task985.test.ts` | `connect()` does NOT resolve on raw `ws.onopen` alone; resolves once a `ready` frame arrives; on reconnect, `sendResumeHandshake` fires AFTER `ready`, not inside `onopen` |
| M-43 | `SttWebSocketClient.gapFrame.task985.test.ts` + a `LiveTranscript` RTL test | `gap` frames dispatch `onGap` instead of falling to `default:`; `LiveTranscript` renders the persistent marker given a `gaps` prop entry |
| M-53 | `packages/stt/src/__tests__/audioResampler.streaming.task985.test.ts` | a signal resampled frame-by-frame through `createStreamingResampler` matches (within tolerance) the SAME signal resampled whole via the existing stateless `resampleSinc`, at the frame boundaries specifically (regression target: today's test would show a discontinuity there) |
| M-55 | `use-live-stt-session.sampleRateMismatch.task985.test.tsx` | when a fake `AudioContext` reports a DIFFERENT `sampleRate` than requested, the session-create body (or the resample path, per §5.4's chosen option) reflects the ACTUAL rate, not the constant |
| M-56 | extend existing `PluginManager`/`useArcaAudio` tests | `startFromPreferences()` and `switchProvider`'s rebuild path forward `agentSlug` when the preference/rebuild target carries one, no longer silently emitting only deprecated `pipelineId` |

### 6.2 Live measurements requested from the orchestrator (I cannot run these)

1. **BP-3 — SDK-vs-harness operating point** (per the master review's own item, mine to state the
   arms precisely for). Run `test_streaming_quality_scorecard` twice per English fixture:
   - **Arm A ("harness")**: session create body `{ sampleRate: 16000 }` only (today's baseline
     operating point — no language/languageMode at all).
   - **Arm B ("scribe, pre-QW-2")**: `{ sampleRate: 16000, languageMode: 'auto', language: 'en' }`
     (today's ACTUAL SDK-forwarded body, per §1.1-1.2).
   - **Arm C ("scribe, post-QW-2")**: `{ sampleRate: 16000 }` (§1.2's fix applied — should equal
     Arm A once QW-2 lands; run it anyway to prove the fix closed the gap rather than assuming it).
   - Fixture: the three English clinical-read WAVs already in the scorecard. Metric: `medical_wer`,
     `keyterm_recall`, `latin_ratio`, per-clip finals text. Decision settled: whether the clinic's
     ACTUAL SDK path (Arm B) was materially worse than the harness's recorded baseline (Arm A) —
     i.e. whether M-02 alone explains any part of today's clinic-observed degradation, independent
     of the six-variable geometry confound BP-2 already covers.

2. **QW-11 reconnect ring — mid-clip close case in the loss harness** (already scoped by the master
   review as QW-11's own acceptance test, restated here with the exact mechanism this dossier adds):
   drive `test_streaming_loss_harness` with a forced socket close ~5-10 s into a clip (before the
   ring cap), resume, and assert `audio_coverage_ratio >= 0.992` and `seq_gap_count == 0` against
   the steady-state thresholds — this is the FIRST test that will actually exercise §2's ring code
   path end-to-end (today's harness never closes mid-clip). Decision settled: does the ring buffer
   actually restore the coverage number the review's §2.3 baseline (0.997) implied was already
   being met, or was that number never earned because this path was never exercised.

3. **BP-8 — browser capture A/B (OD-L)**. Exact arms, restated with the §5.5 mechanism in mind:
   - **Arm 1 ("today")**: `getUserMedia` with browser defaults (AEC/NS/AGC all default ON, per
     Chrome/Edge/Safari) — i.e. `useArcaAudio.startAudio()` called with no `audioProcessing`.
   - **Arm 2 ("F9-C1")**: `audioProcessing: { noiseSuppression: false, autoGainControl: false }`
     (AEC left ON — external practice per the review's F9-C1 citation is "AGC off for server-side
     STT, never disable AEC").
   - Fixture: the three English clinical WAVs (and the Malayalam BP-4 audio once available) played
     through a virtual input device (per the review's own text) into the scribe path, N >= 3 each
     arm, via `useArcaAudio.startAudio({ audioProcessing: {...} })` — no SDK code change needed to
     run this today, since the per-call override already exists (§5.1); only §5.5's GOVERNED
     default needs the code change, and only after this measurement reports a number.
   - Metrics: `medical_wer`, `keyterm_recall` per arm; RMS level-swing variance per arm (using the
     existing `useArcaAudio` level meter, `useArcaAudio.ts:620-663`, as the instrument). Decision
     settled: OD-L — whether `audioFrontEnd.capture`'s governed default should ship with NS/AGC off
     (matching external practice) or stay on browser defaults (current `TASK-865 F-6` position).

---

## 7. Public API changes

| Surface | Change | Kind | Version note needed? |
|---|---|---|---|
| `agenticStore.ts` `audioLanguage` | default `'en'` → `undefined`; type `string` → `string \| undefined` | Behavior-changing (a consumer reading `store.audioLanguage` for display, e.g. a language picker, now sees `undefined` until the user/tenant picks one) | Yes — CHANGELOG entry; check `packages/agentic-sdk-v2` consumers of `store.audioLanguage` for a display fallback before shipping |
| `AudioStartOptions` session body | stops sending `language`/`languageMode` when undeclared | Behavior-changing but ADDITIVE at the type level (no field removed) — an integrator relying on the SDK's PREVIOUS silent `'en'`/`'auto'` default now gets the tenant/agent default instead | Yes — this is the whole point of QW-2, call it out explicitly in the SDK CHANGELOG as a behavior change, not just a bugfix |
| `SttConfigSchema.language` (`ConfigSchema.ts`) | valibot default `'en'` removed | Behavior-changing for any caller that parses `AppConfigSchema`/`SttConfigSchema` and expects a non-undefined `.language` | Yes |
| `RealtimeSttSocket.finalize()` / `.stop()` | return type `void` → `Promise<void>` | ADDITIVE/widening (non-breaking at call sites; new information for callers that choose to await) | Yes — CHANGELOG, SDK minor bump per the existing `3.x` lockstep versioning (`08-vox-sdk.md`) |
| `RealtimeSttSocket.waitForClosed()` | NEW public method | Additive | Yes |
| `SttWebSocketClient.onGap()` / `onReady()` | NEW public registration methods + `gap`/`ready` reaching consumer callbacks | Additive | Yes — also update `apps/admin-console/src/shared/docs/stt-socket-protocol.ts`'s snippet section to show a client actually handling `gap`/`ready` |
| `LiveTranscriptProps.gaps` (`packages/ui`) | NEW optional prop | Additive | Component-library changelog only |
| `PluginManager` `AudioPluginConfig.audioFrontEnd.capture` | NEW resolved field | Additive | Yes — ties to OD-L, ship behind "governed, default unchanged" per §5.5 until BP-8 reports |
| `createStreamingResampler` (`packages/stt`) | NEW export | Additive | No — internal utility, but document alongside `resampleSinc` |
| `SttWebSocketClient.stopAndDrainOnce` internal `{type:'close'}` send | Internal behavior only | Non-breaking, but changes gateway-observed session accounting (`interrupted` flag) | Worth a CHANGELOG line even though it's not a signature change |

---

## New defects (beyond the ones assigned above)

| Claim | Evidence | Severity | Suggested fix |
|---|---|---|---|
| `startFromPreferences()` never forwards an `agentSlug` — it can only ever start on the deprecated `pipelineId` (`prefs.remoteConfig?.pipelineId`), even though `RemoteConfigResponse` (`types/config.ts:600-607`) has no `agentSlug` field to read one from in the first place | `useArcaAudio.ts:1252-1258`; `types/config.ts:600-607` (confirms M-56's "no `agentSlug`" claim precisely — the type itself lacks the field, not just the call site) | low (tracked under M-56, but worth stating the type-level root cause explicitly since the fix is two-sided: add `agentSlug?: string` to `RemoteConfigResponse` on the SERVER response contract AND read it here — a client-only fix cannot close this) | add `agentSlug?: string` to `RemoteConfigResponse`; `startFromPreferences` prefers it over `pipelineId` |
| `SttWebSocketClient.onReconnect`/`onReconnected`/`onReconnectFailed` are fully implemented and correct, but `StreamingBackendSTTProvider` (the ONE place that owns `processAudio`, i.e. the only place that could act on a reconnect) never registers any of them today — the entire reconnect-callback surface is dead code from this provider's perspective until QW-11 wires it | `packages/stt/src/providers/StreamingBackendSTTProvider.ts:239-246` (only `onTranscript`/`onWsError` wired); confirmed via full-file grep for `onReconnect`/`onDisconnect` — zero hits | new, low (this IS what QW-11 fixes, flagging separately because it means the reconnect *signal* itself was already available and simply unused — not a transport gap, an integration gap) | covered by §2's design; no separate ticket needed |
| `AudioContextManager.getInstance()`'s mismatched-options branch (`AudioContextManager.ts:113-121`) only `console.warn`s to the raw browser console — never through the SDK's own `ISDKLogger`, so the ONE diagnostic that would explain M-63's non-determinism is invisible to any consumer piping SDK logs to their own telemetry | `AudioContextManager.ts:107-123` | new, low | thread an optional logger into `AudioContextManager` (or have `useArcaAudio`/`TtsPlaybackPlayer` log the mismatch themselves by comparing `ctxManager.acquire()`'s resolved rate against what they asked for) |

---

**Files read in this pass (for the orchestrator's traceability):**
`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`, `store/agenticStore.ts`, `core/PluginManager.ts`,
`core/ConfigSchema.ts`, `core/constants.ts`, `core/StreamingSessionManager.ts`,
`core/SttWebSocketClient.ts`, `types/audio.ts`, `types/config.ts`;
`packages/stt/src/core/STTProcessor.ts`, `providers/StreamingBackendSTTProvider.ts`,
`utils/audioResampler.ts`; `packages/room/src/core/AudioContextManager.ts`, `core/AudioMixer.ts`;
`packages/vox-node/src/core/realtime-stt-socket.ts`;
`apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts`,
`components/streaming-tab.tsx`, `src/shared/docs/stt-socket-protocol.ts`;
`apps/example/src/LiveTranscriptionDemo.tsx`;
`packages/ui/src/components/live-transcript/types.ts`;
`apps/api/src/modules/streaming/stt-ws.gateway.ts` (read-only, gateway wire-shape confirmation);
`apps/stt/src/stt/streaming/session_manager.py`, `apps/stt/src/stt/pipeline/language_modes.py`
(read-only, backend backfill-condition confirmation);
`packages/stt/src/__tests__/prompt-wiring.test.ts` (test-style reference).
