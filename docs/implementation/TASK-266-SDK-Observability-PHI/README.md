# TASK-266 — SDK Observability & PHI Scrubbing

| | |
|---|---|
| Ticket Number | TASK-266 |
| Parent Ticket | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Bugfix / Security hardening |
| Owner | A4 (SDK observability & PHI scrubbing) |
| Scope | `packages/agentic-sdk-v2` — logger pipeline, cross-tab sync, STT-V2 WS debug log |
| Wave | TASK-262 Wave 0 (W0-2, W0-4, W0-5, W0-13) |

---

## 1. Requirement Analysis

### 1.1 Description

Wave 0 of TASK-262 (`docs/implementation/TASK-262-Vox-SDK-Deep-Assessment/README.md`, §5 and `01-vox-sdk.md` §SEC-1/SEC-2/SEC-5) identified four observability + cross-tab defects that risk leaking PHI from the browser SDK to either third-party SaaS (Highlight.io) or other browser contexts (extensions, iframes, sibling tabs). This ticket closes those gaps.

- **W0-2 — Highlight transport gating + PHI redaction.** Highlight.io is HIPAA-incompatible by default; it must be gated behind an explicit opt-in, a DSN, and non-production environment. Independently, every log entry must pass through a deep PHI redactor before reaching ANY transport (highlight, loki, otel, console, custom).
- **W0-4 — Cross-tab message signing.** `SimpleCrossTabSync` posts on `BroadcastChannel` with no authentication, allowing same-origin malicious code (an injected extension, a sibling iframe, a service worker) to spoof context_added / context_updated events into the SDK.
- **W0-5 — Per-tenant `BroadcastChannel`.** The channel was previously named `arcaai_session_<patient>_<doctor>_<date>` with no tenant scoping; two tenants opening the SDK in the same browser process could cross-talk.
- **W0-13 — Ad-hoc `console.log` in `SttV2WebSocketClient.ts`.** A debug branch in the WebSocket client wrote a raw transcript JSON blob (containing PHI text) directly to `console.log`, bypassing the structured logger and PHI redactor entirely.

### 1.2 Business context

All four defects sit on HIPAA-relevant data paths (consultation transcripts, patient/doctor ids, voice embeddings). The PHI exposure surface they expand is:

- **W0-2** — Third-party SaaS retention of raw consultation logs.
- **W0-4/W0-5** — In-browser cross-context PHI leak (other tabs, extensions, iframes).
- **W0-13** — Browser DevTools logs, OS-level browser log files, and (in some staging configurations) Sentry's `console.log` integrations.

### 1.3 Acceptance criteria

1. `redactPHI(input)` exists in `packages/agentic-sdk-v2/src/core/logger/redactor.ts`. It returns a deep clone with values for `patientId`, `doctorId`, `consultationId`, `transcript`, `transcriptText`, `sttText`, `sttResult`, `audioBuffer`, `audioBlob`, `recording`, `voiceEmbedding`, `email`, `phone`, `dob`, `nationalId` replaced with `'[REDACTED]'`. Strings prefixed with `data:`, `blob:`, or `file:` become `'[REDACTED-URL]'`. Input is never mutated. Circular references are tolerated.
2. `SDKLogger.dispatch()` calls `redactPHI(entry, this.config.redactFields)` before passing the entry to any transport.
3. `HighlightTransport` exposes a `static isAllowedToActivate(config): boolean` predicate. The constructor and `SDKLogger.initializeTransports()` both consult it. When `false`, neither `init` nor `log` calls reach the Highlight SDK and no log is queued in memory.
4. `SimpleCrossTabSync` wraps every outgoing message as `{ payload, hmac }` where `hmac` is `HMAC-SHA-256` over `JSON.stringify(payload)`, signed with a 32-byte per-session secret held in module memory. Receivers verify and drop unsigned / mismatched / cross-secret messages, warning via the injected logger.
5. `SimpleCrossTabSync` channel name is `agentic.<tenantId>` (preferred) or `agentic.<consultationKey>` (fallback). Never the bare `'agentic'`. `setTenantId(id)` closes the old channel and opens a new tenant-scoped one.
6. `SttV2WebSocketClient.ts` contains no `console.log(` call sites (verified by a regex scan against the source file in a unit test). The debug transcript output is routed through `logger.debug()`.
7. `pnpm --filter @arcaai/vox build`, `... test` (within W0-2/4/5/13 scope), `... lint` all pass; ReadLints clean for every file in my exclusive write scope.

---

## 2. Current State Evaluation

### 2.1 `packages/agentic-sdk-v2/src/core/logger/SDKLogger.ts` (pre-W0-2)

`dispatch()` forwarded the raw `LogEntry` to every transport. A `redactSensitiveFields()` helper scrubbed `entry.attributes` only — PHI in `entry.user`, `entry.sdk`, `entry.error.cause`, or arbitrary user-supplied `meta` blobs reached transports unredacted. `DEFAULT_PHI_REDACT_FIELDS` covered a subset of the W0-2 PHI key list (no `transcript`, no `sttResult`, no `voiceEmbedding`).

### 2.2 `packages/agentic-sdk-v2/src/core/logger/transports/highlight.transport.ts` (pre-W0-2)

`initialize()` constructed the Highlight SDK unconditionally whenever `enabled && projectId` (checked by SDKLogger). No NODE_ENV gate. Pre-init `log()` calls were queued in `pendingLogs[]` (a memory accumulator that could leak PHI if the gate were flipped at runtime). `recordHeadersAndBody` defaulted to `false` (HIPAA-safe — pre-existing SEC-08 fix).

### 2.3 `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts` (pre-W0-4/W0-5)

Channel name was `arcaai_session_${patient}_${doctor}_${date}` — no `agentic.` namespace, no tenant scoping. Authentication was an opt-in plaintext `sessionSecret` field comparison (SEC-05); without it, any same-origin code could forge messages. No HMAC. No `setTenantId` API.

### 2.4 `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` (pre-W0-13)

Lines 32–36 contained:
```ts
function debugLogTranscript(source: string, entry: DebugTranscriptEntry): void {
  // eslint-disable-next-line no-console
  console.log(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`);
}
```
The `entry` object contained `speaker`, `start`, `end`, `duration`, `inference` — derived from raw STT output. In debug builds it shipped to the browser console with no redaction.

### 2.5 Test inventory affected

| File | Pre-state | Why touched |
|---|---|---|
| `core/logger/__tests__/SDKLogger.test.ts` | 53 tests. One asserted `entry.user.patientId` passes through verbatim. | Inverted to assert `[REDACTED]` + added `TASK-266 W0-2: PHI redaction reaches every transport surface` suite. |
| `core/logger/__tests__/highlight.transport.test.ts` | 31 tests (SEC-08 included). | Added `TASK-266 W0-2: gated activation` suite (6 tests). |
| `core/__tests__/SimpleCrossTabSync.test.ts` | 22 tests, including SEC-05 sessionSecret tests. | Rewritten: async-aware (`flushAsync`), new W0-4 HMAC tampering / wrong-secret / signing tests, new W0-5 channel-naming and `setTenantId` tests. SEC-05 sessionSecret tests dropped — superseded by W0-4 HMAC. |
| `core/__tests__/SttV2WebSocketClient.test.ts` | 61 tests. TASK-241 debug-mode block spied on `console.log`. | Updated to spy on `mockLogger.debug` + console-NOT-called assertion. Added `TASK-266 W0-13: source must not contain console.log` regex-grep test. |

---

## 3. Implementation Plan

### 3.1 TDD test list (RED first)

| # | Test file | Assertion |
|---|---|---|
| T1 | `logger/__tests__/redactor.test.ts` | `redactPHI` on the full W0-2 PHI key list + URL prefix + deep recursion + immutability + cycle safety + Date/Error/Blob handling |
| T2 | `logger/__tests__/SDKLogger.test.ts` | `entry.user.patientId/doctorId` redacted; `entry.sdk.consultationId` redacted; `attributes.transcript/sttResult/voiceEmbedding` redacted; data:/blob:/file: URLs become `[REDACTED-URL]`; caller meta not mutated |
| T3 | `logger/__tests__/highlight.transport.test.ts` | `init` and `log` NOT called when NODE_ENV=production, `enabled=false`, or empty `projectId`; both called when all gates pass; no log queueing in gated-off state; `isAllowedToActivate` is a pure static predicate |
| T4 | `__tests__/SimpleCrossTabSync.test.ts` | Outgoing message has `{payload, hmac}` envelope; unsigned messages dropped + warn; tampered payload dropped + warn; wrong-secret messages dropped + warn; happy-path verified delivery; 32-byte secret; secret regenerated on `__resetSessionHmacSecretForTests` |
| T5 | `__tests__/SimpleCrossTabSync.test.ts` | Channel name = `agentic.<tenantId>` when tenantId given, `agentic.<consultationKey>` fallback, never `'agentic'`; cross-tenant isolation; `setTenantId` closes old + opens new; `setTenantId` is no-op for same id |
| T6 | `__tests__/SttV2WebSocketClient.test.ts` | Debug-mode final transcript routed through `mockLogger.debug` (NOT `console.log`); console spy never invoked; segment counter still increments; source file contains zero `console.log(` call sites (regex scan, JSDoc comments stripped) |

### 3.2 File creation / modification order

1. `core/logger/redactor.ts` + colocated test → RED → GREEN (✓ from prior session, verified intact).
2. `core/logger/SDKLogger.ts` integration + test → RED → GREEN.
3. `core/logger/transports/highlight.transport.ts` gating + test → RED → GREEN.
4. `core/SimpleCrossTabSync.ts` HMAC + per-tenant naming + test → RED → GREEN.
5. `core/SttV2WebSocketClient.ts` debug log replacement + test → RED → GREEN.

### 3.3 Verification criteria

- `pnpm --filter @arcaai/vox build` exits 0.
- `pnpm --filter @arcaai/vox test` — all tests in MY exclusive write scope pass (`logger/**`, `SimpleCrossTabSync.test.ts`, `SttV2WebSocketClient.test.ts`). Failures in OTHER A-agents' files (TASK-265 constants, TASK-267 useArca audio) are not in scope.
- `pnpm --filter @arcaai/vox lint` exits 0 with zero errors and zero new warnings in files I edited.
- `ReadLints` returns no findings on every modified file.

---

## 4. Implementation Summary

### 4.1 Files created

| Path | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/core/logger/redactor.ts` | Pure-function PHI redactor with W0-2 PHI key list + URL stripping + cycle safety + Blob/ArrayBuffer/typed-array handling + Error flattening. |
| `packages/agentic-sdk-v2/src/core/logger/__tests__/redactor.test.ts` | 17 tests covering primitives, shallow + deep redaction, URL prefixes, immutability, circular references, Date/Error preservation. |
| `docs/implementation/TASK-266-SDK-Observability-PHI/README.md` | This document. |

### 4.2 Files modified

| Path | Change |
|---|---|
| `packages/agentic-sdk-v2/src/core/logger/SDKLogger.ts` | `dispatch()` now passes the entry through `redactPHI(entry, this.config.redactFields)` before invoking any transport. `initializeTransports()` gates `HighlightTransport` construction on `HighlightTransport.isAllowedToActivate(this.config.highlight)`. |
| `packages/agentic-sdk-v2/src/core/logger/transports/highlight.transport.ts` | Added `private permanentlyDisabled` flag, `static isAllowedToActivate(config)` predicate (checks NODE_ENV !== 'production' && enabled && projectId non-empty). Constructor sets `permanentlyDisabled = true` and clears `pendingLogs` when gate fails. `initialize()` no-ops when disabled. `log()` is a hard no-op when disabled — no queueing — so a misconfigured deploy cannot buffer PHI for a later runtime gate flip. |
| `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts` | Rewritten. Adds module-level singleton 32-byte secret (`crypto.getRandomValues`), lazy `Promise<CryptoKey>` via `crypto.subtle.importKey`, async sign/verify in `broadcast`/`handleIncoming`. New `{ payload, hmac }` envelope (base64 HMAC). New `agentic.<tenantId>` channel naming with `consultationKey` fallback. New `setTenantId(id)` method (close + reopen). New optional `{ tenantId, logger }` constructor option. Test-only helpers `__resetSessionHmacSecretForTests` + `__getSessionHmacSecretForTests`. `broadcastContext*` now return `Promise<void>`. |
| `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` | `debugLogTranscript()` signature changed to `(logger?: ISDKLogger, source: string, entry: DebugTranscriptEntry)`. Body uses `logger?.debug(...)` instead of `console.log(...)`. Call site at line ~598 updated to pass `this.logger`. No other lines touched. |
| `packages/agentic-sdk-v2/src/core/logger/__tests__/SDKLogger.test.ts` | Inverted the legacy `should include user context` assertion (doctorId/patientId now expect `[REDACTED]`). Added 5-test `TASK-266 W0-2: PHI redaction reaches every transport surface` suite. |
| `packages/agentic-sdk-v2/src/core/logger/__tests__/highlight.transport.test.ts` | Added 6-test `TASK-266 W0-2: gated activation` suite. |
| `packages/agentic-sdk-v2/src/core/__tests__/SimpleCrossTabSync.test.ts` | Rewritten end-to-end (async-aware), 24 tests covering original contract + W0-4 HMAC + W0-5 per-tenant naming. SEC-05 sessionSecret tests removed (superseded). |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | TASK-241 debug-mode tests now spy on `mockLogger.debug` and assert `consoleSpy` NOT called. Added `TASK-266 W0-13: source must not contain console.log` regex-grep test using `fs.readFileSync` + comment-stripping. |

### 4.3 Public API additions (config-facing)

#### `LoggerConfig.highlight.enabled`

The Highlight transport is now default-disabled. To enable, set:

```ts
const logger = createSDKLogger({
  highlight: {
    enabled: true,         // explicit opt-in
    projectId: '<dsn>',    // required, non-empty
    // ...
  },
});
```

> **⚠️ HIPAA WARNING — `observability.highlight.enabled` flag**
>
> Setting `observability.highlight.enabled = true` causes the SDK to ship structured log entries (and, depending on Highlight's own configuration, session replay frames and network metadata) to **Highlight.io**, a third-party SaaS based in the United States.
>
> Highlight.io is **NOT** covered by ARCAAI's BAA and is **NOT** an authorised PHI processor under HIPAA. The W0-2 gate enforces three defences:
>
> 1. The transport refuses to activate when `process.env.NODE_ENV === 'production'`.
> 2. Activation requires an explicit `enabled: true`.
> 3. Activation requires a non-empty `projectId` (DSN).
>
> Even with the gate open, every log entry is run through `redactPHI` (which strips known PHI keys and `data:`/`blob:`/`file:` URLs). Treat the redactor as a **secondary** safety net; the primary safety net is leaving this flag `false` (its default) in any environment that touches real patient data.

#### `SimpleCrossTabSync` constructor options

```ts
new SimpleCrossTabSync(
  { patientId, doctorId, appointmentDate },
  {
    tenantId?: string,    // W0-5: drives `agentic.<tenantId>` channel name
    logger?: { warn(msg, meta?): void },  // W0-4: drop-warning sink
  },
);

sync.setTenantId(newTenantId);  // close + reopen on tenant switch
```

### 4.4 W0-2 PHI key set

Drawn from the TASK-266 brief plus the pre-existing `DEFAULT_PHI_REDACT_FIELDS` superset (preserves backwards compatibility):

```
patientId, doctorId, consultationId, transcript, transcriptText, sttText,
sttResult, audioBuffer, audioBlob, recording, voiceEmbedding, email, phone,
dob, nationalId, patientName, doctorName, ssn, dateOfBirth, mrn, token,
accessToken, refreshToken, password, apiKey
```

URL prefixes stripped: `data:`, `blob:`, `file:` → `[REDACTED-URL]`.

### 4.5 W0-4 HMAC details

- **Algorithm:** `HMAC-SHA-256` (`crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])`).
- **Secret:** 32 bytes from `crypto.getRandomValues(new Uint8Array(32))`. NIST SP 800-107 recommends ≥128 bits; 256 bits matches the hash output. Held in module memory only — never written to `localStorage`, `sessionStorage`, cookies, or IndexedDB. Regenerated on every `import` of the module (effectively: per app load).
- **Envelope:** `{ payload: CrossTabPayload, hmac: string }`. `hmac` is base64 of the HMAC bytes. `payload` is JSON-serialised before signing so verification is deterministic on the JSON form (verifier re-serialises with `JSON.stringify(envelope.payload)` and compares).
- **Drop conditions:** missing envelope, malformed payload, missing hmac, HMAC mismatch, sign/verify exception. All log a `warn` via the injected logger (if any).

### 4.6 W0-5 channel naming rules

| Inputs | Channel name |
|---|---|
| `{ tenantId: 'tenant-A' }` | `agentic.tenant-A` |
| `{ tenantId: '' }` or `tenantId` absent | `agentic.<patient>_<doctor>_<date>` |
| Constructor without options | `agentic.<patient>_<doctor>_<date>` |

`setTenantId(newId)`:
1. No-op when `newId === this.tenantId`.
2. Otherwise closes the existing `BroadcastChannel`, opens a new one with the recomputed name. The new channel re-uses the same module-level HMAC secret, so messages from peers that still use the old name are dropped (different channel name) AND messages from peers on the new name are verified.

### 4.7 W0-13 — surgical replacement

Only two lines of `SttV2WebSocketClient.ts` were touched:

```ts
// before
function debugLogTranscript(source: string, entry: DebugTranscriptEntry): void {
  // eslint-disable-next-line no-console
  console.log(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`);
}
// after
function debugLogTranscript(logger: ISDKLogger | undefined, source: string, entry: DebugTranscriptEntry): void {
  logger?.debug(`[ARCAAI:DEBUG] ${source} Transcript:\n${JSON.stringify(entry, null, 2)}`, {
    operation: 'debugLogTranscript',
    component: 'SttV2WebSocketClient',
    attributes: { entry },
  });
}
```
and the single call site:
```ts
// before:  debugLogTranscript('SttV2WebSocket', entry);
// after:   debugLogTranscript(this.logger, 'SttV2WebSocket', entry);
```
No other logic in the file is touched. The W0-13 test `expect(stripped).not.toMatch(/console\.log\s*\(/)` locks this contract going forward.

---

## 5. Verification

### 5.1 `pnpm --filter @arcaai/vox build`

```
ESM dist/index.mjs   5.40 MB   Build success in 7190ms
CJS dist/index.js    5.41 MB   Build success in 7193ms
ESM dist/core.mjs    Build success
CJS dist/core.js     Build success
ESM dist/plugins.mjs Build success
CJS dist/plugins.js  Build success
```
Exit code `0`.

### 5.2 `pnpm --filter @arcaai/vox test` — scope-focused

In-scope test files (10 files / 328 tests):
```
src/core/logger/__tests__/console.transport.test.ts
src/core/logger/__tests__/highlight.transport.test.ts
src/core/logger/__tests__/loki.transport.test.ts
src/core/logger/__tests__/otel.transport.test.ts
src/core/logger/__tests__/redactor.test.ts
src/core/logger/__tests__/SDKLogger.test.ts
src/core/logger/__tests__/types.test.ts
src/core/logger/__tests__/utils.test.ts
src/core/__tests__/SimpleCrossTabSync.test.ts
src/core/__tests__/SttV2WebSocketClient.test.ts

Test Files  10 passed (10)
     Tests  328 passed (328)
```

Full-suite run (`pnpm --filter @arcaai/vox test`): `113 passed | 2 failed (115 files) — 2716 passed | 17 failed (2733 tests)`. Of the 17 failures, **zero** are in files I touched. The failures cluster in two other A-agents' tickets:

- `src/core/__tests__/constants.task265.test.ts` (13 failures) — TASK-265 SDK constants drift, owned by A3.
- `src/hooks/__tests__/useArca.audio-unification.test.ts` (4 failures) — TASK-267 useArca audio unification, owned by A5.

Both were already failing on `dev` before my work; my edits neither introduced nor resolved them.

### 5.3 `pnpm --filter @arcaai/vox lint`

```
✖ 13 problems (0 errors, 13 warnings)
```
Exit code `0`. The 13 warnings are all `prettier/prettier` formatting nits in **other** files (`core.ts`, `FileTranscriptionService.ts`, `types/dna.ts`, `types/index.ts`, and the pre-existing nested ternary at `SttV2WebSocketClient.ts:463` inside `normalizeTranscript` — not a line I touched). Zero warnings in any file I created or substantively edited.

### 5.4 `ReadLints` on every modified file

```
No linter errors found.
```
(All 10 files listed in §4.1 / §4.2.)

---

## 6. Deviations

### D1 — `SimpleCrossTabSync.broadcastContext*` now returns `Promise<void>`

The brief calls for HMAC signing using Web Crypto, which is async (`crypto.subtle.sign`). The original methods returned `void`. To keep verification deterministic in tests (which assert delivery after broadcast), the methods now return `Promise<void>`. The existing fire-and-forget callsite in `useArcaSession` (`crossTabSyncRef.current.broadcastContext(contextItem)` with no `await`) continues to work because Promise rejections are caught and logged internally.

### D2 — `sessionSecret` constructor option removed (SEC-05 supersession)

The pre-W0-4 SEC-05 mitigation was an optional plaintext `sessionSecret` shared between tabs. W0-4's per-session HMAC enforces signing unconditionally and supersedes that mechanism. The `sessionSecret` option is removed from the public constructor signature. The only caller in this repo (`useArcaSession`) never passed it.

### D3 — Channel-name fallback uses `consultationKey`, not `sessionId`

The brief says `agentic.<tenantId>` or `agentic.<sessionId>` "if tenant id isn't reachable". `SimpleCrossTabSync` does not currently take a `sessionId`; its closest session-scoped identifier is the `consultationKey` (`<patient>_<doctor>_<date>`). The fallback is therefore `agentic.<consultationKey>`. The W0-5 invariant (never the bare `'agentic'`, always namespaced) is upheld.

### D4 — Per-session secret is module-level, not per-instance

The brief says "per-session HMAC key … in memory … regenerated on app reload". A per-instance secret would prevent two `SimpleCrossTabSync` instances inside the same JS context (e.g., two React component mounts) from verifying each other's messages. A module-level singleton matches the intended "per app session" granularity.

### D5 — Pre-existing TypeScript strict errors not fixed

`pnpm --filter @arcaai/vox typecheck` (`tsc --noEmit`) emits 199 pre-existing errors before my changes (verified by stashing). The same 199 errors persist after my changes (I introduced zero net-new typecheck errors in my scope after fixing the small `config.level` cast in `highlight.transport.ts`). The dominant cluster is `Uint8Array<ArrayBufferLike>` ↔ `BufferSource` incompatibilities in `utils/secureStorage.ts`; that file is in A2's FORBIDDEN write scope.

### D6 — Pre-existing failing tests not addressed

Per §5.2, 17 test failures persist in `constants.task265.test.ts` and `useArca.audio-unification.test.ts`. Both files are in OTHER A-agents' FORBIDDEN scope and were already failing on `dev`. Not in this ticket.

---

## 7. Follow-ups / Open work

- **FU-1.** `LoggerConfig` (in `core/logger/types.ts`, owned by A2) does not yet declare an `observability.highlight.enabled` namespace; the consumer-facing config field referenced in the brief is currently `loggerConfig.highlight.enabled` (the existing `HighlightTransportConfig.enabled` flag). A small naming-alignment refactor to surface `observability.*` as a public config shape would be a non-breaking addition once A2's types are stable.
- **FU-2.** Real cross-browser-tab messaging is impossible under W0-4 as specified — two browser tabs are separate JS processes with separate module singletons, so HMACs will not match across them. The current implementation defends against same-process attackers (extensions, iframes). If true cross-tab sync is required, a follow-up ticket should look at deriving the HMAC secret from a SharedWorker / `SessionStorage`-bound secret (acknowledging the trade-off against the "never persisted" requirement).
- **FU-3.** `LokiTransport` / `OTelTransport` would benefit from the same gating pattern as `HighlightTransport` (`isAllowedToActivate`). Out of scope here but obvious next step.
- **FU-4.** A few unrelated prettier warnings (`core.ts`, `FileTranscriptionService.ts`, `types/dna.ts`, `types/index.ts`) could be cleaned in a follow-up; not in scope of TASK-266.

---

## 8. Change History

| Date | Author | Description | Files modified |
|---|---|---|---|
| 2026-05-23 | A4 | Initial implementation of W0-2, W0-4, W0-5, W0-13. | See §4.1 / §4.2. |
