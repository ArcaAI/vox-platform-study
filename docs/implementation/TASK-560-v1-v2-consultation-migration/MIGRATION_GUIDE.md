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
| `uploadAudioFile()` / `getTranscriptionStatus()` | present but **throws** | — | Out of the live-workflow scope; use the v2 file-transcription API if you need batch upload. |
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
| `POST /api/smr/api/v1/summary/sync` | **Yes** (TASK-562) | **identical** `POST /api/smr/api/v1/summary/sync` | `x-api-key` (or Bearer) | Stateless shim over SMR `/api/v1/generate`; returns the v1 `SummaryResponse` (§5.4). |
| `POST /api/smr/api/v1/presummary` | **Yes** (TASK-562) | **identical** `POST /api/smr/api/v1/presummary` | `x-api-key` (or Bearer) | Returns the v1 `PreSummaryResponse` (§5.5); `structured_data.sections` may be `[]` with `pre_summary` as the source of truth. |
| `POST /api/smr/api/v1/summary/async` | Not part of the shim set | — | — | Prefer `summarizeSync`. |
| `POST /api/sessions` (raw session CRUD) | **No** — handled by the SDK | `POST /api/v1/consultations/open` (internal) | Bearer/api-key | The compat session hook drives v2's native ticketed flow; you don't call this directly. |
| `WS /stt?sessionId=&key=` (raw STT socket) | **No** — handled by the SDK | ticketed `WS /ws/stt/stream` (internal) | stream ticket | Two-step ticketed handshake is hidden behind `useArcaSpeechToText`. Never put a JWT in a WS URL. |

**Why the summary paths are byte-identical.** v2's global prefix is `api/v1`, but
these two routes are declared `@Controller('api/smr/api/v1')` **and excluded from
the global prefix** (TASK-560 §5.6). Point your existing v1 base URL at the v2
gateway and the summary calls "just work" with no URL edits.

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
