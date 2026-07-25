---

# @arcaai/vox SDK — Architectural Code Review

*Scope: `packages/agentic-sdk-v2/` — every source file read. May 2026.*

---

## 1. Architecture Summary

`@arcaai/vox` is a layered, React-centric SDK built for browser-only medical consultation workflows. Its top-level structure is a single `AgenticProvider` (React Context + Zustand) that bootstraps six singletons — `AgenticClient`, `PluginManager`, `PersonalizationManager`, `ModelRegistry`, `ConfigManager`, and `SDKLogger` — once on mount. These singletons are wired into a single flat Zustand store (`agenticStore`) and are consumed by ~25 hooks, making every part of the system reachable from any hook without prop-drilling. Three distinct entry points (`index.ts`, `core.ts`, `plugins.ts`) exist to enable tree-shaking: the core entry is ~200 KB and omits all audio plugin packages, while the full entry bundles `@arcaai/room`, `@arcaai/stt`, `@arcaai/vad`, and `@arcaai/noise-filter`. An optional fourth entry (`plugins-med-ner.ts`) isolates the 300 MB medical NER package behind an explicit import.

The audio pipeline follows a strict sequential order: `AudioContext → NoiseFilter (RNNoise WASM) → VAD (Silero ONNX) → STT (Whisper WebWorker)`. Each stage is wrapped in a `ProcessorStage` inside `TranscriptionPipeline`, and each processor is a `BaseProcessor` from `@arcaai/room` instantiated lazily via factory closures. A parallel `KnowledgePipeline` runs NER, spell-check, and summarization against transcribed text. Both pipelines are orchestrated by `PluginManager`, which is the only class that holds references to `AgenticClient`. Session state (active consultation, context items, summaries, auth, audio level) is kept entirely in the Zustand store; the 401-token-refresh path is handled inline in `AgenticClient.deduplicatedRefresh()` via an `inflightRefresh: Promise<boolean>` field. Cross-tab coordination uses `BroadcastChannel` (via `SimpleCrossTabSync`) and an optional `SharedConnectionManager` wrapping a `SharedWorker` that multiplexes SSE and WebSocket connections across browser tabs.

---

## 2. Public API Surface

### Entry `@arcaai/vox/core` (`src/core.ts`)

| Export | Kind | Status |
|---|---|---|
| `AgenticProvider` | Component | Stable |
| `useAgenticContext` | Hook | Stable |
| `useSDKLogger` | Hook | Stable |
| `useArca` | Hook | Stable |
| `useArcaSession` | Hook | Stable |
| `useArcaConfig` | Hook | Stable |
| `useArcaAudio` | Hook | Stable |
| `useAuth` | Hook | Stable |
| `useConsultationJob` | Hook | Stable |
| `useDepartments`, `usePrompts`, `useRoles`, `useUsers` | Hooks | Stable |
| `useDnaStyle` | Hook | Stable |
| `useGlobalSettings`, `useUserSettings` | Hooks | Stable |
| `useHealthCheck`, `useMonitoring` | Hooks | Stable |
| `useStorage`, `useApiKeys` | Hooks | Stable |
| `useTenants`, `usePolicies` | Hooks | Stable |
| `useVoiceEmbedding` | Hook | Stable |
| `useAuditLog` | Hook | Stable |
| `usePipelines` | Hook | Stable |
| `AgenticClient` | Class | Advanced/Stable |
| `ConfigManager`, `ModelRegistry`, `PersonalizationManager` | Classes | Advanced/Stable |
| `SSEClient`, `SttWebSocketClient`, `StreamingSessionManager`, `FileTranscriptionService` | Classes | Advanced/Stable |
| `useAgenticStore` | Zustand hook | Advanced – internal store exposed publicly |
| `SDKLogger`, `createSDKLogger`, `ConsoleTransport`, `HighlightTransport`, `LokiTransport`, `OTelTransport` | Logger infra | Advanced/Stable |
| All endpoint constants (`AUTH_ENDPOINTS`, `CONSULTATION_ENDPOINTS`, …) | Constants | Stable |
| `AgenticError`, `DEFAULT_MODELS`, `DEFAULT_STT_MODELS`, `DEFAULT_VAD_MODELS` | Constants/Classes | Stable |
| `computeDiff`, `computePromptDiff`, `computeSummaryDiff`, etc. | Utilities | Stable |
| `SecureStorage` | Class | **Undocumented** (exported from `src/utils/index.ts` but not from `core.ts`) |
| All config types (`AgenticConfig`, `VADPluginConfig`, …) | Types | Stable |
| `analyzeDNA` (via `UseArcaSummary`) | Method | **Deprecated stub** – throws immediately |

### Entry `@arcaai/vox/plugins` (`src/plugins.ts`)

| Export | Kind | Status |
|---|---|---|
| `useVAD`, `useSTT`, `useNoiseFilter` | Hooks (re-exported from packages) | Stable |
| `PluginManager` | Class | Stable |
| `TranscriptionPipeline`, `createTranscriptionPipeline` | Class/Factory | Stable |
| `KnowledgePipeline`, `createKnowledgePipeline` | Class/Factory | **Experimental** |
| `TriggerMode` | Type | Stable |

### Entry `@arcaai/vox/plugins/med-ner` (`src/plugins-med-ner.ts`)

| Export | Kind | Status |
|---|---|---|
| `useMedNER` | Hook (re-exported) | Stable |

---

## 3. Strengths

1. **Layered entry-point strategy with deliberate tree-shaking.** `tsup.config.ts:83–100` combines `treeshake: true`, per-entry `noExternal`/`external` lists, and the separate `plugins-med-ner` entry. The 300 MB `@arcaai/med-ner` can only be pulled in by an explicit `import`. The comment at `plugins.ts:77–87` documents the migration from a previously broken design where the whole plugins bundle failed when the package was absent.

2. **Deduplication of the 401-refresh race.** `AgenticClient.ts:711–722` — the `deduplicatedRefresh()` method stores an in-flight `Promise<boolean>` and re-uses it for all concurrent 401s, preventing the thundering-herd problem where multiple parallel requests each trigger an independent refresh. This is correct and production-grade.

3. **Structured, redacted, OTel-compatible logging.** `SDKLogger.ts:44–58` lists `DEFAULT_PHI_REDACT_FIELDS` (including `patientId`, `doctorId`, `mrn`, `token`), and `SDKLogger.ts:346–360` applies the redaction shallowly over the `attributes` bag. Correlation IDs are propagated as W3C `traceparent` headers in `AgenticClient.ts:126–130`.

4. **Surgical sessionUtils extraction (REFACTOR-02).** `sessionUtils.ts:21–121` pulls the duplicated `open`/`load`/`getPatientHistory` logic into three plain async functions that both `useArca` and `useArcaSession` call. This reduces maintenance surface substantially.

5. **Robust WebSocket message normalization.** `SttWebSocketClient.ts:430–543` normalises both snake_case and camelCase fields, validates `isFinal` as `'0'`/`'1'` strings, filters non-finite floats from `speakerEmbedding`, and drops invalid messages instead of crashing.

6. **`contextOwnership` flag on `TranscriptionPipeline`.** `TranscriptionPipeline.ts:341–350` checks `this.config.contextOwnership ?? 'borrowed'` before closing the `AudioContext` in `stop()`. This correctly avoids closing a context the pipeline does not own, preventing the common "closed AudioContext" bug when the caller manages context lifetime.

7. **IndexedDB-first preference persistence with localStorage fallback.** `AgenticProvider.tsx:28–89` provides a non-blocking, three-tier storage hierarchy (IndexedDB → localStorage → no-op) that degrades gracefully in private-browsing mode and SSR.

---

## 4. Defects & Bugs

### Critical

**C-1. `useArca.startAudio` creates a raw `new AudioContext()` and leaks it.**
`useArca.ts:446` — `const audioContext = new AudioContext()`. This context is never stored in the Zustand store, never passed to `setActiveAudioContext`, and never closed in `stopAudio` (`useArca.ts:555–577`). If the user starts and stops audio multiple times (or React Strict Mode double-mounts fire), a new `AudioContext` is created each time and only the last one can be GC'd (browsers enforce a limit of ~6 contexts per origin). Contrast with `useArcaAudio.ts:78–79` which correctly uses `AudioContextManager.getInstance()` — so the two hooks implementing the same start/stop flow diverge on a critical resource. Any application using `useArca()` for audio instead of `useArcaAudio()` will leak audio contexts silently.

**C-2. `stopAudio` in `useArca` never stops the `MediaStreamTrack`.**
`useArca.ts:555–577` calls `pluginManager.destroy()` and clears store flags, but never calls `track.stop()` on the raw `MediaStream` obtained at `useArca.ts:442`. The microphone LED will remain lit indefinitely. `useArcaAudio.ts:219–226` correctly stops all tracks — so again, the two hooks diverge on a critical cleanup.

**C-3. `AgenticProvider` fires `pluginManager.destroy()` without awaiting in the cleanup function.**
`AgenticProvider.tsx:369` — `pluginManager.destroy()` returns `Promise<void>` but the cleanup arrow returns `void`. React's `useEffect` cleanup is synchronous; the returned function is called synchronously by React, so the `Promise` is unobserved and any error thrown during destroy is silently swallowed. In Strict Mode the re-mount sequence is: cleanup → remount, so the pipeline may be half-destroyed when the new `PluginManager` is created.

**C-4. `SSEClient` — auth token is appended as a plain query parameter in the URL.**
`SSEClient.ts:64–66` and `SSEClient.ts:74–77` — `token=<value>` is appended to the URL. Tokens in query strings appear in server access logs, browser history, Referer headers, and third-party analytics integrations (including Highlight.io network recording, which is active by default at `HighlightTransport.ts:93`). This is a security-critical design flaw for a medical-domain SDK. EventSource doesn't support custom headers natively, but the workaround should be a cookie, a short-lived URL token, or a POST-handshake approach.

### High

**H-1. `deduplicatedRefresh` clears `inflightRefresh = null` in `finally` regardless of whether the caller's request is still pending.**
`AgenticClient.ts:711–722` — if two requests both hit 401 simultaneously and the first triggers `deduplicatedRefresh`, the second request shares the same promise correctly. However, after the refresh resolves (or rejects), `inflightRefresh` is set to `null`, then both callers retry at `AgenticClient.ts:235`. If the retry also returns 401 (e.g., the refresh succeeded but the endpoint itself is forbidden), the `isRetry = true` guard at line 231 prevents a second refresh, which is correct. But if a *third* request races in just after `inflightRefresh` is reset to `null` and before the retried request completes, it will trigger a new `deduplicatedRefresh`, potentially sending a second refresh with the same token. This is a TOCTOU window — narrow but real under sustained 401 conditions.

**H-2. `SSEClient` — named event listeners are never removed from the old `EventSource` on reconnect.**
`SSEClient.ts:194–199` — `attachNamedListener` calls `es.addEventListener(eventName, (...) => {...})` with an anonymous closure. When the `EventSource` is closed and a new one is created in `attemptReconnect` (`SSEClient.ts:239–246`), `createEventSource` is called again and new listeners are added. The old `es.close()` removes the native `onerror`/`onopen` handler references but does NOT remove named event listeners that were attached via `addEventListener`, because the anonymous closure references are never stored for later `removeEventListener`. While the old `EventSource` object will eventually be GC'd (since `this.eventSource` is nulled), in the window between close and GC, any pending events from the server can still fire the old callbacks. More importantly, each reconnect cycle accumulates a new listener on the *new* EventSource for every named event, so if `onEvent` is called (lines 89–95) while the EventSource is already open, the listener is added to `this.eventSource` in addition to the one already registered in `createEventSource` (line 189–191), causing double-firing.

**H-3. `useArca.pauseTranscription` / `resumeTranscription` ignores the async `pause()`/`resume()` return values.**
`useArca.ts:1441–1467` — both functions call `pipeline.pause()` / `pipeline.resume()` but do not `await` them. `TranscriptionPipeline.pause()` at `TranscriptionPipeline.ts:379–396` `await`s each processor's `disable()`. Calling pause without awaiting means the calling component may read `pipeline.state.status` as `'PAUSED'` before processors have actually paused, producing incorrect UI state.

**H-4. `useArcaSession.consultation` is re-created via `useMemo` on every change to `store.consultation`, comparing field-by-field.**
`useArcaSession.ts:280–294` — the `useMemo` creates a *new plain object* from every field of `store.consultation`. Because `useMemo` uses shallow equality on its deps list and `store.consultation` itself is a reference, this is fine conceptually. However, the memo is redundant — it copies every field explicitly, providing no structural benefit over returning `store.consultation` directly. The redundant copy also means that Zustand's referential stability guarantee is broken: consumers depending on `session.consultation` by reference equality will re-render even when content hasn't changed.

**H-5. `PluginManager.initializeNER` swallows errors silently via `onError` callback but still proceeds.**
`PluginManager.ts:236–244` — on catch, `callbacks.onError?.(error, 'ner')` is called and the method returns. `this.nerProcessor` remains `null`. If `isNERAvailable()` is checked later, it returns `false`, and any call to `extractEntities` logs a warn and returns `null`. The problem is that the error is reported only to `onError`; if `onError` is not registered (it is optional), the failure is silently discarded. A consumer who initializes NER will not know it failed unless they explicitly register `onError`.

**H-6. `SimpleCrossTabSync` channel key is predictable and collision-prone.**
`SimpleCrossTabSync.ts:77` — the channel name is `arcaai_session_${patientId}_${doctorId}_${appointmentDate}`. PatientId, doctorId, and date are backend-provided strings. If any field contains `_` characters (likely for IDs), channel names can collide across unrelated consultations. A hash of the composite key would be safer.

### Medium

**M-1. `AgenticClient.request` does not handle the case where `externalSignal` aborts after the internal `controller.abort()` listener is added but before the fetch starts.**
`AgenticClient.ts:98–103` — if `externalSignal.aborted` is true at the time of check, `controller.abort()` is called. But the `{ once: true }` event listener is added at line 102 regardless of whether `aborted` is already true. If `externalSignal` fires `abort` again (which it won't for standard `AbortSignal`, but could for custom implementations), the handler would be a no-op because `once` removes it. This is low-risk but the order is wrong — the check should come *before* adding the listener to avoid a race on the first check.

**M-2. `useArca.getLogger` is recreated on every render with `useCallback([store.logger])`.**
`useArca.ts:286–289` — `getLogger` is memoized but creates a new child logger on every call. Because `getLogger` is listed as a `useCallback` dependency of `openSession`, `loadConsultation`, etc., any change to `store.logger` cascades a full recreation of all action callbacks. Since `store.logger` is set once at SDK initialization, this is mostly benign, but the pattern defeats the purpose of `useCallback`.

**M-3. `KnowledgePipeline.process` clears `results` on every invocation.**
`KnowledgePipeline.ts:236` — `this.results.clear()` on every `process()` call means that a caller who has a long-running pipeline and invokes `process()` again before reading results from the first run will lose those results. The `lastInput` reference is also overwritten without any concurrency guard, so rapid consecutive transcription callbacks (each triggering `process()`) will race on `lastInput`.

**M-4. `SttWebSocketClient.debugLogTranscript` writes unconditionally to `console.log`.**
`SttWebSocketClient.ts:32–36` — the private `debugLogTranscript` function uses `console.log` directly (with an eslint-disable comment). While gated by `this._debugMode`, any debug mode enabled in production will produce unredacted transcript text (PHI) in the browser console and any console-intercepting tools (e.g., Highlight.io session replay). This should use the `SDKLogger` so redaction and level filtering apply.

**M-5. `AgenticProvider` runs `modelRegistry.loadTenantConfig()` twice on init.**
`AgenticProvider.tsx:265–277` and `AgenticProvider.tsx:300` — `loadTenantConfig()` is called once to set tenant state in the store, and again inside the `ConfigManager` initialization IIFE. This duplicates a network request on every provider mount.

**M-6. `useArca.transcriptions` / `caseNotes` — selectors are called with `useMemo` but incorrect dep arrays.**
`useArca.ts:1546–1547`:
```ts
const transcriptions = useMemo(() => selectTranscriptions(store), [store.contextItems]);
const caseNotes = useMemo(() => selectCaseNotes(store), [store.contextItems]);
```
`selectTranscriptions(store)` accepts the full store object, not just `store.contextItems`, so if any other store field changed but `contextItems` is the same reference, the memos would correctly not recompute. However, the selectors at `agenticStore.ts:499–504` filter by `item.type === 'transcription'` / `'case_note'`. The store's `contextItems` uses `===` for Zustand's identity check. This is technically correct in practice, but the `store` reference itself (passed to the selector) changes on every state update, making `useMemo` provide no protection if the dep were `[store]` — the current `[store.contextItems]` is the right dep, but is inconsistent with how the rest of the hook refers to `store.xyz` directly (no selector pattern).

**M-7. `HighlightTransport.buildAttributes` sends `patientId` and `doctorId` to Highlight.io.**
`highlight.transport.ts:181–182`:
```ts
if (entry.user?.patientId) attrs.patientId = entry.user.patientId;
if (entry.user?.doctorId) attrs.doctorId = entry.user.doctorId;
```
These are HIPAA-sensitive identifiers and are sent to a third-party observability service without any anonymization or hashing. The `redactFields` list in `SDKLogger` only applies to the `attributes` bag; the `user` context is assembled separately at `SDKLogger.ts:268–276` and goes through `createLogEntry` without redaction, then lands directly in Highlight's event metadata.

**M-8. `SecureStorage.getItem` ignores the stored salt field on decrypt.**
`secureStorage.ts:83–93` — the stored payload contains `{ s, iv, d }` (s = base64 salt), but `getItem` only reads `iv` and `d`, ignoring `s`. The salt is only used during `create()` to derive the key. If the same `SecureStorage` instance persists in memory, decryption works. But the class has no `restore(passphrase)` constructor path — a fresh page load cannot re-derive the key because the key is not persisted and the `create()` factory generates a *new random salt*. This makes `SecureStorage` effectively session-scoped (data encrypted in one session cannot be decrypted after a page refresh), defeating its stated purpose.

### Low

**L-1. `AgenticClient.postFormData` does not call `this.checkRateLimit()`.**
`AgenticClient.ts:381` — the `postFormData` method (used for file uploads) skips the rate limit check that `request()` performs at line 87. Large file uploads can bypass the client-side throttle.

**L-2. `TranscriptionPipeline.setupProcessorEventHandlers` casts processor data as `unknown` then re-casts.**
`TranscriptionPipeline.ts:596–607`:
```ts
stage.processor.on('data', (rawPayload: unknown) => {
  const payload = rawPayload as { type: string; data: unknown; timestamp: number };
```
This is a double-cast without validation. If a processor emits a malformed event (e.g., missing `type`), `payload.type` will be `undefined` and the `switch` will fall through to `default` silently. A `typeof payload.type === 'string'` guard should precede the switch.

**L-3. `useArcaSession.addContext` does not update `crossTabSyncRef` if called before `open()`.**
`useArcaSession.ts:119–153` — `addContext` calls `crossTabSyncRef.current.broadcastContext(contextItem)` but the ref is only set inside `setupCrossTabSync`, which is called from `open()`. If a developer calls `addContext` before `open()`, `crossTabSyncRef.current` is `null` and the broadcast is silently skipped — but no warning is logged.

**L-4. `SDKLogger.child()` creates a full `new SDKLogger(this.config)` instance and then overwrites `transports`.**
`SDKLogger.ts:419–426` — each child logger creation allocates a new `SDKLogger`, which in `initializeTransports()` creates new transport instances, only for those instances to be thrown away and replaced with the parent's shared transports. This is wasteful at initialization, especially since `child()` is called for every hook invocation on every render that touches `getLogger()`.

**L-5. `crossTabSync` channel name uses PII fields without hashing.**
Already covered at H-6, but worth noting as a low-severity secondary issue that PHI (patientId, doctorId, date) appears in a persistent browser API key (`BroadcastChannel` name), which is visible in DevTools Application panel.

---

## 5. Security Gaps

**SEC-1 (Critical). Auth token in SSE URL query string (already cited at C-4).** `SSEClient.ts:64–66` appends `?token=<jwt>` to the URL. JWTs passed as query strings are logged by CDNs, reverse proxies, and application servers. In a HIPAA-regulated context, this constitutes an unnecessary disclosure of PHI-adjacent credentials.

**SEC-2 (High). `patientId` and `doctorId` sent to Highlight.io without hashing.** `highlight.transport.ts:181–182` (cited at M-7). Healthcare identifiers are transmitted to a third-party SaaS in plaintext attributes. The `HeaderSanitizer` (`highlight.transport.ts:95–103`) redacts `Authorization` and `X-API-Key` headers, but does not address payload attributes. If `highlight.run`'s `networkRecording.recordHeadersAndBody` is ever enabled (it defaults to `false`, but the default is documented at line 93 of the transport, not enforced), full request bodies including PHI could be recorded.

**SEC-3 (High). `SecureStorage` is effectively session-scoped, not persistent.** `secureStorage.ts:60–63` — `create()` generates a fresh random salt and derives a new key. The derived `CryptoKey` is not exportable (`extractable: false` at `secureStorage.ts:42`). There is no mechanism to persist or restore the key across page loads. Medical preference data encrypted in session A cannot be read in session B. Since `SecureStorage` is positioned as a persistent encrypted store for medical data (per its JSDoc), this is a fundamental design defect.

**SEC-4 (High). Impersonation token stored in Zustand store as `string | null`.** `agenticStore.ts:94` — `authOriginalToken: string | null`. The original admin JWT is held in the store for the entire duration of impersonation. Zustand store state can be serialized via `useAgenticStore.getState()` (publicly exported at `core.ts:394`), which means any third-party code that can execute in the same JS context can read the raw token. Tokens should not be kept in store state; the `AgenticClient` should hold and restore them internally.

**SEC-5 (Medium). `BroadcastChannel` messages accepted without HMAC or nonce verification.** `SimpleCrossTabSync.ts:97–107` — the only check is `msg.tabId !== this.tabId` and an optional `sessionSecret` comparison (`msg.sessionSecret !== this.sessionSecret`, line 84). `sessionSecret` is not generated by default (`createCrossTabSync` at line 233 does not pass it), so any other tab from any origin on the same site can post crafted `context_added` events that will be accepted and stored. BroadcastChannel is same-origin by design, but a cross-frame XSS attack within the same origin could exploit this.

**SEC-6 (Medium). `AgenticProvider` logs `baseUrl` and `hasTenantId` at initialization time.** `AgenticProvider.tsx:184–191` — logged at `info` level, which is the default. If Highlight or Loki transports are active, this data reaches third-party backends. `baseUrl` itself may contain internal infrastructure hostnames.

**SEC-7 (Low). `SecureStorage` uses a hardcoded `KEY_ITERATIONS = 100_000`.** `secureStorage.ts:18` — 100,000 PBKDF2 iterations with SHA-256 was adequate in 2015 but is below modern NIST recommendations (>= 600,000 for SHA-256) and OWASP 2023 guidance (1,000,000 for SHA-256). For a medical-domain SDK, this should be at minimum 310,000 (NIST 800-132, 2023 revision).

**SEC-8 (Low). `highlight.run` is declared as an optional peer dependency but `HighlightTransport` has no sandbox.** `highlight.transport.ts:79–80` — Highlight is dynamically imported. The `H` object's methods (`identify`, `track`, `consumeError`, `log`) are called unconditionally. If a malicious CDN-injected version of `highlight.run` were loaded, the SDK would invoke its methods with full PHI-bearing log entries.

---

## 6. Performance Issues

**P-1. `useArca` subscribes to the entire Zustand store via `useAgenticStore()` without a selector.**
`useArca.ts:283` — `const store = useAgenticStore()`. In Zustand 5, calling the hook without a selector subscribes to the *entire* store. Every `set()` call anywhere in the application triggers a full re-render of the component that called `useArca()`. The hook then constructs three large `useMemo` objects (`session`, `audio`, `context`, `summaryInterface`), each with 7–14 dependencies. While the `useMemo`s limit what is returned, the component still re-renders on every store mutation. The granular selectors defined at `agenticStore.ts:554–575` exist specifically to prevent this, but they are not used in the primary `useArca` hook. The same problem exists in `useArcaAudio.ts:42`, `useArcaSession.ts:65`, and virtually every other hook.

**P-2. `getLogger` is a `useCallback` that returns a new child logger on every call.**
`useArca.ts:286–289` — `getLogger` is called inside every `useCallback` action. Each call to a returned action triggers `store.logger?.child('useArca')`, which per `SDKLogger.ts:419–426` allocates a new `SDKLogger` instance (and then discards the transports it created). This runs on every `startAudio`, `stopAudio`, `addCaseNote`, etc. The child should be memoized once.

**P-3. `AgenticProvider` calls `client.updateTenantId()` / `updateAccessToken()` / `updateApiKey()` synchronously on every render.**
`AgenticProvider.tsx:382–415` — this block runs outside of any `useEffect`, so it executes during the render phase on every re-render of `AgenticProvider`. While the conditional checks (`client.getTenantId() !== config.api.tenantId`) avoid redundant updates, the checks themselves call getter methods on every render. For high-frequency parent re-renders (e.g., any state above the provider), this creates unnecessary overhead.

**P-4. `TranscriptionPipeline.handleVADEvent` calls `transcribeSegment` without backpressure control.**
`TranscriptionPipeline.ts:644–671` — on every `vad-speech-end` event, the pipeline calls `sttProcessor.transcribeSegment(data.audio)` as a floating Promise. If VAD fires segments faster than Whisper can transcribe (likely on slow devices), Promises pile up with no queue, no cancellation, and no limit. Audio buffers (Float32Arrays) referenced by each Promise are held in memory until that Promise settles.

**P-5. `useArca.ts:1546–1547` — `selectTranscriptions(store)` / `selectCaseNotes(store)` used with `useMemo` but the entire `store` object is an implicit dep.**
Both selectors receive the full `store` object, but only `store.contextItems` is listed as the dep. If any selector were to accidentally read another store field, the memo would stale silently. The established pattern should be `useAgenticStore(selectTranscriptions)` which subscribes only to the relevant slice.

**P-6. `SDKLogger.child()` allocates a full `SDKLogger` instance per call (cited at L-4).**

**P-7. `dts: false` in tsup config means no type-declaration output from the bundler.**
`tsup.config.ts:84` — DTS generation is disabled with a comment explaining that workspace packages don't expose hook types. This forces consumers to use `typescript` path resolution via `typesVersions` and pre-built `.d.ts` files. If a consumer references an unexported type from a workspace package, they get a confusing error. More importantly, without DTS generation from source, the types in `dist/*.d.ts` may become stale if manually maintained.

**P-8. `splitting: false` in tsup config prevents chunk reuse between entry points.**
`tsup.config.ts:85` — the full entry (`index.ts`) and the plugins entry (`plugins.ts`) both bundle all of `@arcaai/room`, `@arcaai/vad`, `@arcaai/stt`, and `@arcaai/noise-filter` independently. A consumer who imports from both (which the main `index.ts` does by re-exporting `core.ts` and `plugins.ts`) will have duplicate code if their bundler doesn't deduplicate based on module identity.

---

## 7. Test Coverage Gaps

| Area | Test Files Present | Gaps |
|---|---|---|
| `AgenticClient` | `AgenticClient.test.ts` | 401 → refresh → retry flow not tested; `postFormData` / `uploadFormData` not tested; `inflightRefresh` concurrent-request deduplication not tested |
| `TranscriptionPipeline` | `TranscriptionPipeline.provider.test.ts` | VAD → STT segment hand-off path (`handleVADEvent` → `transcribeSegment`) not tested; `pause()`/`resume()` ordering not tested; `contextOwnership: 'owned'` path not tested |
| `SSEClient` | `SSEClient.test.ts` | Named listener double-registration on reconnect not tested; exponential backoff timing not tested; `authToken` URL injection not tested |
| `SharedConnectionManager` | `SharedConnectionManager.test.ts` | Fallback (non-SharedWorker) SSE/WS path not tested; `dispose()` double-call safety not tested |
| `SttWebSocketClient` | `SttWebSocketClient.test.ts` | Reconnect after `acknowledgeConnection()` reset not tested; intentional disconnect vs unexpected disconnect not tested |
| `KnowledgePipeline` | `KnowledgePipeline.test.ts` | Concurrent `process()` race on `lastInput`/`results` not tested; `triggerSummarization` API path not tested |
| `useArca` | `useArca.test.tsx`, `useArca.audio-pipeline.test.ts`, etc. | Audio context leak (raw `new AudioContext`) not tested; `stopAudio` track-stop not verified; lifecycle `requestGracefulShutdown` timeout logic not tested |
| `useAuth` | `useAuth.test.ts`, `useAuth.task224.test.ts`, `useAuth.task225.test.ts` | `endImpersonation` server-error fallback path not tested; concurrent login calls (double-click) not tested |
| `SecureStorage` | `secureStorage.test.ts` | Cross-session decrypt (new instance, same data) not tested — which would expose the design flaw at SEC-3 |
| `AgenticProvider` | `AgenticProvider.test.tsx` | React Strict Mode double-mount cleanup + remount cycle not tested; `configManager.loadUserPreferences` failure path not tested; tenant config load failure not tested |
| `PluginManager` | `PluginManager.test.ts` | NER silent-failure path (no `onError` registered) not tested; `destroy()` partial-failure (one processor throws) not tested |
| `SimpleCrossTabSync` | None found | No unit tests at all; BroadcastChannel message injection not tested |
| `sessionUtils` | None found | `openSessionOperation` store side-effects not tested in isolation |
| Integration (pipeline) | `pipeline.integration.test.ts` | Coverage unknown (excluded from vitest via `exclude: ['**/integration/**']` — `vitest.config.ts:8`) |

---

## 8. Conformance to 2026 Best Practices

### React 19

| Pattern | Status | Notes |
|---|---|---|
| `use()` for async data | Not used | All async data fetching is in callbacks; `use()` + Suspense could eliminate `isLoading` states |
| `useActionState` | Not used | Form/action-level state (login, addCaseNote) still uses `useState` + manual `isLoading` flag |
| Ref-as-prop | Not applicable | No forwarded refs in provider |
| Server Components compatibility | Partial | `"use client"` banner added to all bundles (`tsup.config.ts:89–91`). However, the SDK uses `IndexedDB`, `localStorage`, `AudioContext`, `BroadcastChannel`, and `navigator.mediaDevices` directly, none of which are guarded by `typeof window !== 'undefined'` before use. This makes the SDK unsuitable for import in Server Components even with the banner, since RSC bundlers may still statically analyze imports. |
| `useOptimistic` | Not used | Context item additions (e.g., `addCaseNote`) could benefit from optimistic updates |

### Zustand 5

| Pattern | Status | Notes |
|---|---|---|
| Slices pattern | Not used | The store is a single flat object with ~40 state fields and ~40 actions in one `create()` call (`agenticStore.ts:293–490`). Zustand 5 recommends the slice pattern for large stores. |
| Selector-based subscriptions | **Defined but not used in hooks** | Granular selectors exist at `agenticStore.ts:554–575` but the hooks subscribe to the full store (see P-1) |
| Vanilla store for non-React usage | Not provided | `useAgenticStore` is only a React hook; no `agenticStore.getState()` / `agenticStore.subscribe()` vanilla export |
| `immer` middleware | Not used | Array mutations (e.g., `addEntities` at `agenticStore.ts:348–356`) are done with manual spread-and-filter, which is correct but verbose |
| Stable identity on set | Correct | All set calls use primitive assignments or `(state) => ({...})` pattern |

### Valibot 1.x

Valibot is listed as a dependency (`package.json:63`) but no runtime schema validation was found in any reviewed file. All API responses are cast with `as T` generic type assertions (e.g., `return response.json()` at `AgenticClient.ts:250`). Config input is also not validated at the SDK boundary — `AgenticProvider` accepts `AgenticConfig` typed via TypeScript only; no runtime `valibot.parse()` call validates it. This is a significant gap for a medical SDK that receives external data.

### TypeScript Strict Mode

| Issue | Location |
|---|---|
| `any` cast for `createMedNER` return | `PluginManager.ts:177` — `(await import('@arcaai/med-ner')) as any` |
| `any` cast for med-ner entity types | `KnowledgePipeline.ts:196` — `entityTypes: this.config.ner.entityTypes as any` |
| `unknown` auth user in store | `agenticStore.ts:92–94` — `authUser: unknown`, `authImpersonatedUser: unknown`, `authOriginalUser: unknown` |
| `as` assertion on logger error | `SDKLogger.ts:333`, `336` — `(error as any).code`, `(error as any).cause` |
| `as T` on all `response.json()` | `AgenticClient.ts:250`, `469` — no runtime validation |
| `as INERProcessor` cast | `PluginManager.ts:222` |
| `as unknown[]` for entityTypes | `PluginManager.ts:182` |

### tsup / Dual-Build

The `exports` map in `package.json:8–29` correctly provides `types`, `import`, and `require` keys for all four entry points. `typesVersions` at `package.json:30–44` provides TypeScript < 5.0 fallbacks. However:
- `dts: false` (`tsup.config.ts:84`) means the `.d.ts` files must be manually maintained or pre-built separately (none found in the source scan).
- The `"use client"` banner is added as a string literal at the top of every output file (`tsup.config.ts:89–91`). Bundlers like Vite and webpack recognize this, but it also means CJS consumers on Node.js receive an invalid file directive they must ignore.
- `valibot` is bundled into the core output (it's in `dependencies`, not `peerDependencies`, and is not in `externalDependencies`), adding ~30 KB to the core bundle even though it's never used at runtime.

---

## 9. Refactor / Improvement Suggestions (Ranked by Impact)

**R-1 [Critical — Bug Fix]. Unify audio start/stop in `useArca` with `useArcaAudio`.**
`useArca.ts:420–553` duplicates the entire audio start implementation from `useArcaAudio.ts:53–205` but omits `AudioContextManager.getInstance()`, `store.setActiveStream()`, and `store.setActiveAudioContext()`. The `useArca` hook's audio methods should delegate to `useArcaAudio` internally, or `useArca` should simply re-export `useArcaAudio`'s return for its `audio` sub-object.

**R-2 [Critical — Security]. Replace query-string token in SSEClient.**
`SSEClient.ts:64–66` — implement a short-lived token exchange: POST to a dedicated `/stream-token` endpoint that returns a single-use ticket, then pass the ticket in the URL. Alternatively, require that all SSE connections go through a POST request that returns a `text/event-stream` response (requires a server-side change). At minimum, document this as a known insecure pattern in the SDK.

**R-3 [High — Security]. Hash PHI before sending to Highlight.io.**
`highlight.transport.ts:178–182` — replace `patientId` / `doctorId` with one-way SHA-256 hashes (e.g., using `crypto.subtle.digest`) before populating `attrs`. This allows session correlation without exposing raw identifiers to a third party.

**R-4 [High — Performance]. Subscribe hooks to granular Zustand selectors.**
Every hook (starting with `useArca.ts:283`) should be changed from `useAgenticStore()` to targeted subscriptions:
```ts
const isCapturing = useAgenticStore(selectIsCapturing);
const audioLevel = useAgenticStore(selectAudioLevel);
```
This eliminates ~20 unnecessary re-renders per store mutation for components that use only a subset of state.

**R-5 [High — Design]. Redesign `SecureStorage` with exportable key or IndexedDB key storage.**
The `SecureStorage.create()` factory should either export the derived key as a base64 string for caller persistence, or store the key in the `CryptoKey`-capable `IndexedDB` via the Web Crypto API's `exportKey('jwk')` with `extractable: true`. Alternatively, derive the key from a stable browser fingerprint (device-bound key using Web Authentication / PRF extension) to make it session-persistent by design.

**R-6 [High — Correctness]. Add Valibot runtime validation at the API boundary.**
Every `response.json()` call in `AgenticClient` returns `T` without validation. At minimum, add valibot schemas for the core domain types (`Consultation`, `ContextItem`, `SummaryResponse`, `AuthUser`) and validate in a wrapper:
```ts
async getValidated<T>(endpoint: string, schema: BaseSchema<T>): Promise<T> {
  const raw = await this.get<unknown>(endpoint);
  return parse(schema, raw); // throws ValiError on mismatch
}
```

**R-7 [High — Performance]. Memoize child loggers.**
`useArca.ts:286–289` — change `getLogger` to a `useMemo`:
```ts
const logger = useMemo(() => store.logger?.child('useArca'), [store.logger]);
```
And use `logger` directly instead of calling `getLogger()` in each action. This avoids allocating a new `SDKLogger` on every action invocation.

**R-8 [Medium — Correctness]. Await async `pause`/`resume` in pipeline control.**
`useArca.ts:1441–1467` — add `await` to `pipeline.pause()` / `pipeline.resume()` calls, or expose them as async callbacks to `pauseTranscription`/`resumeTranscription`.

**R-9 [Medium — Design]. Migrate store to Zustand 5 slice pattern.**
The 490-line `agenticStore.ts` should be split into domain slices: `authSlice`, `sessionSlice`, `audioSlice`, `contextSlice`, `summarySlice`, `pipelineSlice`, `configSlice`. This enables per-slice resets, independent testing, and reduces merge conflicts across the team.

**R-10 [Medium — Performance]. Deduplicate `modelRegistry.loadTenantConfig()` calls.**
`AgenticProvider.tsx:265–277` and `AgenticProvider.tsx:300` — cache the result of the first call (already returned at line 265) and pass it into the ConfigManager IIFE instead of calling it again.

**R-11 [Medium — Security]. Generate `BroadcastChannel` channel name from a hash.**
`SimpleCrossTabSync.ts:77` — use `crypto.subtle.digest('SHA-256', ...)` to hash the `patientId + doctorId + appointmentDate` composite before constructing the channel name, removing PHI from the browser's DevTools-visible channel list.

**R-12 [Medium — Reliability]. Add backpressure to `handleVADEvent` STT dispatch.**
`TranscriptionPipeline.ts:644–671` — maintain a simple semaphore or queue that limits concurrent `transcribeSegment` calls to N (e.g., 2). Cancel or drop segments if the queue is full, and emit a `transcriptionDropped` event for observability.

**R-13 [Low — Correctness]. Fix `SSEClient` named listener accumulation on reconnect.**
Store listener functions in a `Map<string, EventListener>` and call `removeEventListener` before each `close()`. Register named listeners only in `createEventSource`, not separately in `onEvent`.

**R-14 [Low — Correctness]. Remove the `console.log` from `SttWebSocketClient.debugLogTranscript`.**
`SttWebSocketClient.ts:32–36` — route through `ISDKLogger` (accept it via constructor injection and use `this.logger?.debug(...)`) so PHI redaction and transport routing apply.

**R-15 [Low — Hygiene]. Remove unused `valibot` from production bundle.**
Since valibot is in `dependencies` and not used at runtime, add it to a `peerDependencies` with `optional: true`, or remove it until schema validation (R-6) is implemented. Current state adds ~30 KB dead code to the core bundle.

---