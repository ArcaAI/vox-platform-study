# HOPE v1 → v2 Consultation Migration Guide

> **Audience:** application engineers moving a live-consultation UI off HOPE-v1
> (`@arcaai/agentic-sdk` + the v1 gateway) onto HOPE-v2 (`@arcaai/vox` + the v2
> gateway).
>
> **Authority:** the request/response shapes and the v1→v2 mapping are frozen in
> [TASK-560 §5](./README.md#5-canonical-v1-contracts-single-source-of-truth--frozen).
> This guide never restates a schema divergently — where a shape matters it
> points at §5. If you find a conflict, §5 wins.
>
> **What this guide covers:** the compat layer built in TASK-561 (SDK hooks under
> `@arcaai/vox/compat`) and TASK-562 (gateway summary shim endpoints). It is a
> concrete, copy-pasteable path — not a rewrite.

---

## TL;DR — 3-step checklist

Your session → record → live-transcript → stop → summary workflow keeps the same
hook names and the same summary endpoints. Three changes, done once:

1. **Wrap your app once** in `<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>`.
   v1 had no provider; v2 needs exactly one (per-provider store). This is the
   single unavoidable change — see [The one unavoidable change](#the-one-unavoidable-change).

2. **Swap the import specifier** everywhere:
   `@arcaai/agentic-sdk` → `@arcaai/vox/compat`. The hook **names** and call
   signatures are preserved (`useArcaSessionManager`, `useAudioCapture`,
   `useArcaSpeechToText`, `useSMR`).

3. **Feed your existing `SDK_CONFIG_OPTIONS`** straight into the provider (it maps
   it for you via `mapV1ConfigToAgenticConfig`). One new optional field —
   `sttPipelineId` — turns on live backend transcription (see
   [Behavioral differences](#behavioral-differences-you-must-be-aware-of) #4).

```diff
- import { useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useSMR } from '@arcaai/agentic-sdk';
+ import {
+   ArcaCompatProvider,
+   useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useSMR,
+ } from '@arcaai/vox/compat';

  // index.tsx — wrap ONCE
+ <ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
     <App />
+ </ArcaCompatProvider>
```

That is the whole migration for the protected workflow. The rest of this guide
explains the behavioral deltas so nothing surprises you at runtime.

---

## The one unavoidable change

v1 hooks each took a plain `SDK_CONFIG_OPTIONS` object and had **no provider**.
v2 keeps SDK state in a **per-provider Zustand store** (see
[`08-vox-sdk.md`](../../../.claude/rules/08-vox-sdk.md)), so the tree must be
wrapped once. The compat layer reduces that to a single wrapper that accepts your
familiar v1 config object:

```tsx
import { ArcaCompatProvider } from '@arcaai/vox/compat';

const SDK_CONFIG_OPTIONS = {
  apiEndpoint: 'https://api.your-tenant.example.com', // REST origin (no /api/v1 needed)
  websocketUrl: 'wss://api.your-tenant.example.com',
  credentials: { apiKey: process.env.NEXT_PUBLIC_ARCA_API_KEY! }, // REQUIRED
  sttPipelineId: 'your-streaming-pipeline-id',        // NEW: enables live backend STT
  audioSettings: { noiseSuppression: true },
};

export function Root() {
  return (
    <ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
      <ConsultationScreen />
    </ArcaCompatProvider>
  );
}
```

If you prefer to build the v2 `AgenticConfig` yourself, call the same adapter the
provider uses:

```ts
import { mapV1ConfigToAgenticConfig } from '@arcaai/vox/compat';
const config = mapV1ConfigToAgenticConfig(SDK_CONFIG_OPTIONS);
// → <AgenticProvider config={config}>…</AgenticProvider>
```

> **No default API key.** v1 shipped a baked-in default `apiKey`/`encryptionKey`
> (TASK-560 §6 A1). The compat adapter **does not** — an omitted/blank
> `credentials.apiKey` **throws**. Supply your tenant key. The tenant is resolved
> server-side from that key (`x-api-key` parity, TASK-560 D2), so you never set a
> `tenantId` client-side.

---

## Side-by-side hook map

Same names, same signatures; the compat hook delegates to the v2 public API.

| v1 (`@arcaai/agentic-sdk`) | v2 compat (`@arcaai/vox/compat`) | Delegates to (v2) | Notes / caveats |
|---|---|---|---|
| `useArcaSessionManager({doctorId,doctorName,patientId,patientName})` | `useArcaSessionManager(...)` — same props | `useArcaSession().open/close/...` | `createSession()` + `startSession()` collapse onto **one** idempotent `open()`. `doctorId` is dropped from the wire and preserved in `metadata.legacyDoctorId`. |
| `createSession(meta)` | `createSession(meta)` | `open({patientId, department, metadata})` | Returns a synthesized `MedicalSession` view (id/status/timestamps). |
| `startSession()` | `startSession()` | (same `open`, idempotent) | Second call does not re-open. |
| `pauseSession()` / `resumeSession()` | `pauseSession()` / `resumeSession()` | *(no v2 equivalent)* | **Local status only** — flips the synthesized status; no server call. |
| `endSession()` | `endSession()` | `close()` | |
| `loadSession(id)` | `loadSession(id)` | `loadConsultation(id)` | |
| `updateSession(data)` | `updateSession(data)` | `update({metadata:data})` | |
| `useAudioCapture({onAudioData})` | `useAudioCapture(...)` | `useArcaAudio().start/stop` | `onAudioData` is retained for source-compat but **never fires** (v2 owns PCM/transport). See #3. |
| `startRecording()` / `stopRecording()` | same | `audio.start(...)` / `audio.stop()` | Idempotent; coordinated with the STT hook so pairing them never double-starts the mic. |
| `getDeviceStatus()` | same | `navigator.mediaDevices` + `audio.level` | |
| `useArcaSpeechToText({onTranscript})` | `useArcaSpeechToText(...)` | `useArcaAudio()` + store selectors | `onTranscript(text,isFinal,meta)` **still fires** — synthesized by observing `transcriptSegments`/`currentTranscript`. See #2. |
| `startTranscription()` / `stopTranscription()` | same | `audio.start(...)` / `audio.stop()` | Same coordinated `useArcaAudio()` instance as `useAudioCapture`. |
| `sendAudioData(buf, meta)` | `sendAudioData(buf, meta)` | *(metadata sink)* | Records `{deviceid, role}`-style metadata for the next turn; **does not push PCM**. See #3. |
| `uploadAudioFile()` / `getTranscriptionStatus()` | same signatures, now **live** (TASK-603) | `POST /audio/transcription-jobs/transcribe`, `GET /audio/transcription-jobs/:id` | Resolves to the job id (v1: task id). v1's `provider` argument is honoured as a **pipeline override**; absent, `options.pipelineId` is used. `isUploading`/`uploadProgress` are real. For MANY files use `useArcaBatchTranscription`. |
| `useSMR().summarizeSync(req)` | `summarizeSync(req)` | `POST /api/smr/api/v1/summary/sync` | Same path, same `x-api-key`. Sends **real per-turn** segments now (F2). See #6. |
| `useSMR().summarize(req)` | `summarize(req)` | (alias of `summarizeSync`) | |
| `useSMR().preSummarize(req)` | `preSummarize(req)` | `POST /api/smr/api/v1/presummary` | Same path. |
| `useSMR().summarizeAsync(req)` | `summarizeAsync(req)` | `POST /api/smr/api/v1/summary/async` | The async job endpoint is **not** part of the reproduced shim set — treat as best-effort; prefer `summarizeSync`. |

---

## Behavioral differences you must be aware of

These are the deltas that can surprise you at runtime. Each is intentional and
follows TASK-560 §2.2 / §5 / §6.

1. **`doctorId` is dropped from the wire, server-derived instead.**
   v2 derives the provider identity from the JWT / API key. Your `doctorId` prop
   is preserved in `session.metadata.legacyDoctorId` for display/audit, but it is
   never sent as a top-level session field. Names (`doctorName`, `patientName`)
   travel in `metadata`.

2. **Transcripts are pull-state, but `onTranscript` still fires.**
   v2 exposes `transcriptSegments[]` (finals) + `currentTranscript` (interim) in
   the store — there is no native push callback. The compat hook **synthesizes**
   your v1 `onTranscript(text, isFinal, metadata)` by diffing those selectors:
   each new final → `onTranscript(text, true, meta)`; a changed interim →
   `onTranscript(text, false, meta)`. Your existing callback keeps working. The
   `metadata` is now *richer* (optional `confidence`, `speaker_id`/`speakerLabel`,
   `startTime`/`endTime`, `language`) — additive, backward-compatible (TASK-560
   §6 I2).

3. **`sendAudioData(buf, metadata)` is a metadata sink — it does not send PCM.**
   In v1 the app captured raw PCM and pushed each chunk to the STT socket. In v2
   the SDK owns capture → mix → noise → VAD → STT and the transport (TASK-560
   §2.2.3). So `sendAudioData` **ignores the audio buffer** and only records the
   `metadata` (e.g. `{deviceid, role}`) to attach to the next synthesized turn.
   Likewise `useAudioCapture`'s `onAudioData` never fires. Do **not** rewire your
   own socket — that reintroduces the v1 custom binary framing defect (TASK-560
   §6 F1).

4. **Live backend transcription needs a `pipelineId`.**
   v1's STT WS was a flat api-key socket. v2 routes live STT to the backend
   streaming provider only when a `pipelineId` is present. Set `sttPipelineId` on
   your `SDK_CONFIG_OPTIONS` (mapped into `audio.stt.pipelineId`). Omit it and STT
   falls back to local/in-browser transcription.

5. **Real mixed-stream is an optional upgrade (`secondaryDeviceId`).**
   v1's "mixed stream" was per-chunk metadata tagging, not real mixing. v2 has a
   real `AudioMixer`. The compat hooks preserve the v1 single-mic behavior; if you
   want true two-device mixing you can upgrade to the native
   `useArcaAudio().start({ deviceId, secondaryDeviceId })` at your own pace. Not
   required for the protected workflow.

6. **Summaries send real per-turn segments (not one collapsed blob).**
   v1's `useSMR` collapsed the whole transcript into a single
   `conversation_segments` entry (`speaker:'user'`) — TASK-560 §6 F2. The compat
   `useSMR` sends **real per-turn** segments: pass `request.segments` (preferred),
   or pass `request.text` and it splits per line, keeping `"Speaker: text"`
   speaker labels. The v1 `SummaryResponse` shape you already parse is unchanged.

7. **`pause`/`resume` are local-only.** v2 has no server pause/resume for a
   consultation. The compat hook flips the synthesized status locally so your UI
   keeps working, but there is no backend state change.

---

## Endpoint parity

| v1 endpoint | Reproduced in v2? | Path in v2 | Auth | Notes |
|---|---|---|---|---|
| `POST /api/smr/api/v1/summary/sync` | **Yes** (TASK-562) | **identical** `POST /api/smr/api/v1/summary/sync` | `x-api-key` (or Bearer) | Stateless shim over SMR `/api/v1/generate`; returns the v1 `SummaryResponse` (§5.4). Optional `stream:true` → SSE (TASK-589). Tenant mandatory (see below). |
| `POST /api/smr/api/v1/presummary` | **Yes** (TASK-562) | **identical** `POST /api/smr/api/v1/presummary` | `x-api-key` (or Bearer) | Returns the v1 `PreSummaryResponse` (§5.5); `structured_data.sections` may be `[]` with `pre_summary` as the source of truth. Optional `stream:true` → SSE (TASK-589). Tenant mandatory (see below). |
| `POST /api/smr/api/v1/summary/async` | Not part of the shim set | — | — | Prefer `summarizeSync`. |
| `POST /api/sessions` (raw session CRUD) | **No** — handled by the SDK | `POST /api/v1/consultations/open` (internal) | Bearer/api-key | The compat session hook drives v2's native ticketed flow; you don't call this directly. |
| `WS /stt?sessionId=&key=` (raw STT socket) | **No** — handled by the SDK | ticketed `WS /ws/stt/stream` (internal) | stream ticket | Two-step ticketed handshake is hidden behind `useArcaSpeechToText`. Never put a JWT in a WS URL. |

**Why the summary paths are byte-identical.** v2's global prefix is `api/v1`, but
these two routes are declared `@Controller('api/smr/api/v1')` **and excluded from
the global prefix** (TASK-560 §5.6). Point your existing v1 base URL at the v2
gateway and the summary calls "just work" with no URL edits.

---

## Streaming summaries & pre-summaries (opt-in — TASK-589)

Both `summary/sync` and `presummary` accept an optional **`stream: boolean`** in the
request body. Default `false` → the single JSON body you get today. `true` → the
response is `text/event-stream` (SSE) with three event types:

- `event: delta` — `data: {"text":"<incremental content>"}` — progress. For the
  **summary** these are strict-JSON fragments (not display text); for the
  **pre-summary** they are clean markdown you can render as they arrive.
- `event: result` — `data: <the exact same v1 JSON body>` the non-streaming call
  returns (`SummaryResponse` / `PreSummaryResponse`). **Streaming and non-streaming
  converge on an identical final object.**
- `event: error` — `data: {"detail":"…"}` — PHI-redacted; raw upstream/LLM content is
  never placed on the wire.

### SDK
`useSMR` takes `stream` + an `onDelta` callback per call; the promise still resolves
with the final structured object and `onComplete` still fires with it:

```tsx
const smr = useSMR({ onComplete: (s) => setSummary(s) });

// summary — deltas are JSON fragments, use them only for a progress indicator
await smr.summarizeSync({
  text, departmentId: 'Medicine', visitType: 'New Referral',
  stream: true,
  onDelta: (_delta, accumulated) => setProgressChars(accumulated.length),
});

// pre-summary — deltas are markdown, safe to render progressively
await smr.preSummarize({
  current_department: 'Medicine', visit_type: 'New Referral',
  stream: true,
  onDelta: (delta) => appendMarkdown(delta),
});
```

### Raw API
```
POST /api/smr/api/v1/summary/sync
x-api-key: <tenant-scoped key>
Content-Type: application/json

{ "session_data": { … }, "stream": true }
```
Response `Content-Type: text/event-stream`:
```
event: delta
data: {"text":"{\"presenting_complaints\":"}

event: result
data: {"summary_id":"…","session_id":"…","summary":{…},"metadata":{…}}
```

**Fallback caveat (summary only):** the per-tenant SMR fallback applies only if the
stream fails to *start*; once bytes are flowing, a mid-stream provider failure surfaces
as a single `event: error` — a half-emitted stream cannot be restarted.

---

## Tenant context is mandatory (TASK-589)

v2 **rejects** a summary / pre-summary call that has no resolvable tenant with
`401 "Tenant context is required"`. There is **no v1-style SYSTEM-default fallback**.

- A **tenant-scoped `x-api-key`** already carries its tenant — nothing to add.
- A **global-admin key** must send `X-Tenant-Id: <tenant>` for the working tenant.
- The tenant must have SMR provider/model configured (`smr.*` AI task defaults);
  selection **fails closed** if unconfigured (v1's env-based default is gone).

This applies to both the streaming and non-streaming forms.

---

## Before / after — the full workflow

The complete session → record → live-transcript → stop → summary workflow. See the
runnable version in [`apps/example/src/compat-consultation.tsx`](../../../apps/example/src/compat-consultation.tsx).

### Before (HOPE v1)

```tsx
// v1 — no provider; every hook takes SDK_CONFIG_OPTIONS
import { useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useSMR } from '@arcaai/agentic-sdk';

function Consultation() {
  const [lines, setLines] = useState<string[]>([]);

  const mgr = useArcaSessionManager({
    doctorId: 'dr-1', doctorName: 'Dr. Rao',
    patientId: 'pat-42', patientName: 'A. Kumar',
    options: SDK_CONFIG_OPTIONS,
  });

  const capture = useAudioCapture({ options: SDK_CONFIG_OPTIONS });

  const stt = useArcaSpeechToText({
    sessionId: mgr.session?.id ?? '',
    language: 'en',
    options: SDK_CONFIG_OPTIONS,
    onTranscript: (text, isFinal) => { if (isFinal) setLines((l) => [...l, text]); },
  });

  const smr = useSMR({ sessionId: mgr.session?.id });

  const start = async () => {
    await mgr.createSession();
    await mgr.startSession();
    await capture.startRecording();
    await stt.startTranscription();
  };
  const stop = async () => {
    await stt.stopTranscription();
    await capture.stopRecording();
    await mgr.endSession();
  };
  const summarize = () =>
    smr.summarizeSync({ text: lines.join('\n'), departmentId: 'cardiology', visitType: 'New Referral', useEnhancedFormat: true });

  // …render lines + summary…
}
```

### After (HOPE v2 — compat)

```tsx
// v2 — same hook code; ONE provider + import swap
import {
  ArcaCompatProvider,
  useArcaSessionManager, useAudioCapture, useArcaSpeechToText, useSMR,
} from '@arcaai/vox/compat';

// index.tsx
<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
  <Consultation />
</ArcaCompatProvider>;

function Consultation() {
  const [lines, setLines] = useState<string[]>([]);

  const mgr = useArcaSessionManager({
    doctorId: 'dr-1', doctorName: 'Dr. Rao',      // doctorId → metadata.legacyDoctorId
    patientId: 'pat-42', patientName: 'A. Kumar',
  });

  const capture = useAudioCapture();               // onAudioData no longer needed

  const stt = useArcaSpeechToText({
    sessionId: mgr.session?.id ?? '',
    language: 'en',
    onTranscript: (text, isFinal) => { if (isFinal) setLines((l) => [...l, text]); }, // still fires
  });

  const smr = useSMR({ sessionId: mgr.session?.id });

  const start = async () => {
    await mgr.createSession();
    await mgr.startSession();
    await capture.startRecording();                // idempotent with the STT hook
    await stt.startTranscription();
  };
  const stop = async () => {
    await stt.stopTranscription();
    await capture.stopRecording();
    await mgr.endSession();
  };
  const summarize = () =>
    smr.summarizeSync({ text: lines.join('\n'), departmentId: 'cardiology', visitType: 'New Referral', useEnhancedFormat: true });

  // …render lines + summary… (identical to v1)
}
```

The body of `Consultation` is byte-for-byte the same except: the provider wrapper,
the import specifier, and dropping the now-unused `options`/`onAudioData` props.

---

## Provider switching (no v1 ancestor)

v1 had **no** STT-provider concept, so this is the one import a migrated app adds
that has no v1 equivalent: **`useArcaSttProvider`** (TASK-568). It lets you build
the "switch transcription provider" control flow (a clinician moving the live
session to the tenant's configured fallback engine on the fly) using only
`@arcaai/vox/compat` — no v2 store, no `useArcaAudio`, no WebSocket awareness.

It exposes provider state plus one action:

```tsx
import { useArcaSttProvider } from '@arcaai/vox/compat';

function ProviderSwitch() {
  const [banner, setBanner] = useState<string | null>(null);
  const provider = useArcaSttProvider({
    // Fires for BOTH a user switch AND a backend auto-switch on an outage.
    onProviderSwitched: (info) =>
      setBanner(`Transcription now on ${info.toPipeline.name ?? info.toPipeline.id} (${info.reason})`),
    onSwitchFailed: (err) => setBanner(`Switch failed: ${err.message}`),
  });

  return (
    <>
      {banner ? <div role="status">{banner}</div> : null}
      <span>Provider: {provider.activeProvider?.name ?? 'local'}{provider.isFallbackActive ? ' (fallback)' : ''}</span>
      <button
        onClick={() => void provider.switchToFallback().catch(() => undefined)}
        disabled={!provider.fallbackAvailable || provider.switchStatus === 'switching'}
      >
        {provider.switchStatus === 'switching' ? 'Switching…' : 'Switch provider'}
      </button>
    </>
  );
}
```

- `activeProvider` — `{ pipelineId, name?, isFallback } | null` (null before capture / for local STT).
- `fallbackAvailable` — `true` only when a live backend session can switch and is not already on the fallback. Deployments that predate TASK-567 leave it `false`; `switchToFallback()` then rejects with an `ErrorInfo` (code `FALLBACK_UNAVAILABLE`) — never crashes or silently resolves.
- `switchStatus` — `'idle' | 'switching' | 'switched' | 'failed'`. A failed user switch is recoverable (retry allowed); a rejected v2 switch yields code `SWITCH_FAILED`.
- `switchToFallback()` is idempotent — a call while already on the fallback resolves without a second backend call.

**Auto-switch also rides your existing `onStatus`.** If your app already passed
the v1 `onStatus` prop to `useArcaSpeechToText`, it now also receives
`onStatus('provider_switched', { fromPipeline, toPipeline })` when the backend
swaps engines, plus `onStatus('reconnecting')` / `onStatus('reconnected')` across
a transport reconnect — transitions v1 never surfaced. The payload carries only
the pipeline ids the v2 store exposes; the switch **reason** (`auto` vs `user`)
lives on `useArcaSttProvider`'s richer `onProviderSwitched`. Apps that never
passed `onStatus` are byte-for-byte unaffected.

Non-goals (v2-native, not compat): listing/selecting arbitrary pipelines
(`usePipelines()`), and switching *back* to primary mid-session.

---

## External microphones / custom audio sources (TASK-612)

v1 apps that wanted a specific or custom audio source did their **own**
capture — built the `MediaStream`/PCM themselves and pushed it via
`sendAudioData()`. v2 inverts that: the SDK owns capture end-to-end, so the
way to use your own source is to hand it the `MediaStream`, not the samples.

```diff
- // v1 — app captures, pushes PCM manually
- const stream = await getMyOwnAudioSource();
- recordAndPush(stream, (chunk) => stt.sendAudioData(chunk));
+ // v2 — hand the SDK the stream; it captures, mixes, and transports it
+ const stream = await getMyOwnAudioSource();
+ const capture = useAudioCapture({ sourceStreams: [stream] });
+ await capture.startRecording();       // start capture FIRST
+ await stt.startTranscription();       // then STT — it never carries sources
```

- Pass one or more streams via `useAudioCapture({ sourceStreams: [stream, ...] })`,
  or pick real input devices with `deviceId`/`secondaryDeviceId`/
  `additionalDeviceIds` — see behavioral difference #5 above for the
  device-mixing upgrade.
- **Start capture first.** `useAudioCapture` and `useArcaSpeechToText` race to
  call `audio.start()`; only the hook that actually starts FIRST has its
  source options applied. Call `startRecording()` (carrying `sourceStreams`/
  `deviceId`) before `startTranscription()`, never the reverse. Getting this
  backwards is no longer silently dropped — see the reference for the exact
  error.
- `sendAudioData()` keeps working exactly as behavioral difference #3
  describes — a metadata-tagging sink only, never an audio path. Don't try to
  push your own PCM through it; that reintroduces the v1 defect #3 already
  warns about.
- The stream you pass is yours: the SDK never stops its tracks, so the same
  `MediaStream` can be reused across sessions — but that also means **you**
  release its microphone when you're done (`track.stop()`).
- Full contract — ownership rules, liveness validation, the silent-uplink
  watchdog, virtual/loopback-device guidance, and a troubleshooting table:
  [`Compat-API-Reference.md` §8 External microphones & injected streams](../../../packages/agentic-sdk-v2/docs/Compat-API-Reference.md#8-external-microphones--injected-streams).

---

## What you must change vs. what stays

| Stays the same | Must change |
|---|---|
| Hook names + call signatures | Add **one** `<ArcaCompatProvider>` wrapper |
| `onTranscript(text, isFinal, meta)` callback contract | Import specifier `@arcaai/agentic-sdk` → `@arcaai/vox/compat` |
| Summary endpoint paths + `x-api-key` auth | Supply a real `apiKey` (no default key) |
| `SummaryResponse` / `PreSummaryResponse` shapes (§5.4/§5.5) | Add `sttPipelineId` for live backend STT |
| `summarizeSync` / `preSummarize` request fields | Stop relying on `onAudioData` / manual `sendAudioData` PCM push |
| Your React component bodies | Treat `pause`/`resume` as local-only |

---

## Verification checklist for your app

- [ ] App renders under exactly one `<ArcaCompatProvider>`.
- [ ] `credentials.apiKey` is supplied (the adapter throws otherwise).
- [ ] `sttPipelineId` set if you need live backend transcription.
- [ ] `onTranscript` finals accumulate; interim updates render (optional).
- [ ] `summarizeSync` returns a `SummaryResponse` your existing renderer accepts.
- [ ] No custom audio WebSocket / PCM push code remains.

For the contract that protects these shapes across future v2 changes, see the
tests in [TASK-563](../TASK-563-v1-migration-guide-and-tests/README.md#5-implementation-summary).
