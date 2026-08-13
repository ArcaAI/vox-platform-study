# Live-Transcription Metadata Passthrough on `@arcaai/vox/compat` (v2)

**Audience:** engineers migrating a HOPE **v1** (`@arcaai/agentic-sdk`) live-transcription app onto HOPE **v2** (`@arcaai/vox`).
**Scope:** the compat hook `useArcaSpeechToText` from `@arcaai/vox/compat` — the v2 counterpart of the v1 *"attach metadata to each audio chunk → get it back on the transcript"* feature.
**This is the v2 companion to the v1 doc** `…/HOPE/docs/packages/agentic-sdk/docs/live-transcription-websocket-metadata.md`. Read that for the v1 wire protocol; read this for **what survives the port and what does not**.

> **The contract is frozen in [TASK-564 §5](./README.md#5-canonical-metadata-passthrough-contract-single-source-of-truth--frozen).** This doc explains and illustrates it; §5 is authoritative. Where the two ever disagree, §5 wins and this file is the bug.

---

## 1. One-line contract (unchanged call shape)

```
sendAudioData(pcm, metadata)  ──►  … v2 capture + STT …  ──►  onTranscript(text, isFinal, metadata)
```

A migrated app keeps the exact v1 call shape: it tags a "turn" with an arbitrary JSON object (`{device_id, role, chunk_id, consultationId, …}`, ≤ 8 KiB) via `sendAudioData`, and reads that object back — normalized — off `onTranscript`. **The one behavioral truth to internalize:** in v2 this round-trip is **entirely client-side**. Nothing is put on the wire; nothing is echoed by a server. The hook records your metadata locally and re-attaches it to the transcripts v2 produces. See §3 for why, and §4 for exactly what that costs you.

---

## 2. What round-trips

### 2.1 Send — `sendAudioData(audioData, metadata?)`

- `metadata` — any JSON-serializable object (v1 examples: `device_id`, `role`, `chunk_id`, `consultationId`).
- **`audioData` (PCM) is ignored.** v2 owns capture and transport (mic → `@arcaai/room` → VAD → STT); the hook is a **metadata sink**, not an audio path. Pass `new ArrayBuffer(0)` — or your real buffer; either way the bytes are discarded. This is the single biggest shape difference from v1 (§4).
- The metadata is appended to a bounded, **capture-relative timeline** (cap ~256, drop-oldest). Omitting it records a no-op entry.
- **8 KiB guard (parity):** if `JSON.stringify(metadata).length > 8192`, the hook throws `Audio frame metadata exceeds 8192 bytes` — the same message and limit as v1's `MAX_METADATA_BYTES`, even though there is no wire frame to bound.

### 2.2 Receive — `onTranscript(text, isFinal, metadata?)`

- `text` — formatted through `transcriptTemplate`, **default `"{timestamp} {speaker_id}: {text}"`** (v1 parity). The default is applied to **finals**; interim (`isFinal:false`) text is delivered **raw** (interims carry no speaker/timestamp, so those template slots would be meaningless).
- `metadata` — the delivered object, composed in the **exact precedence order** of [§5.2](./README.md#52-receive):

  ```ts
  deliveredMetadata = {
    // (1) v2 ASR/diarization enrichments — LOWEST precedence (caller may override)
    speaker_id,   // ← TranscriptSegment.speakerLabel (diarization)
    confidence,   // ← seg.confidence
    language,     // ← seg.language (session-configured; see §4)
    startTime,    // ← seg.startTime
    endTime,      // ← seg.endTime
    isFinal,      // true | false
    // (2) caller metadata for the correlated turn — OVERRIDES enrichments (F4 fix)
    ...correlatedCallerMetadata,
    // (3) v1-canonical normalized keys — HIGHEST precedence (overlay last)
    ...(chunk_id !== undefined ? { chunk_id } : {}),
    ...(detected_language !== undefined ? { detected_language } : {}),
  }
  ```

- **Caller keys are never silently overwritten by hook enrichments.** If your metadata sets `speaker_id`, `confidence`, `language`, or `isFinal`, *your* value is delivered — the hook's diarization/segment values only fill keys you did not set. (This fixes v1-era defect **F4**; see §4.)

### 2.3 §4.3 normalization (the two derived keys)

The hook derives the same two convenience keys the v1 client normalized, from the **caller's** metadata (v2 has no server to assign them):

| Key | Resolution order | Notes |
|---|---|---|
| `chunk_id` | `metadata.chunk_id → metadata.chunkId → metadata.other` | v2 has **no server-assigned** chunk id; it echoes what you supplied. Omitted from the delivered object if none of the three is present. |
| `detected_language` | `metadata.detected_language → metadata.detectedLanguage → seg.language` | Falls back to the segment language, which in v2 is the **session-configured** language, not per-utterance detection — unless code-switching populates `seg.language`. Document/treat it as coarse. |

> **Takeaway for callers (same as v1):** always read `chunk_id` / `detected_language` off the delivered metadata — they are normalized regardless of which spelling you sent.

---

## 3. Why it is client-side (and can't be a wire reproduction)

v1 threaded metadata through the STT WebSocket and echoed it from the recognizer. **v2 structurally cannot do that without changing core** — verified in [§2.2/§2.3 of the ticket](./README.md#22-architecture-differences-why-it-cant-be-a-wire-level-reproduction):

1. **No metadata field on the v2 STT wire.** `WsAudioFrame` carries only `{type, seq, data, microphoneId?}`; `WsTranscriptResult` has a fixed field set with no generic `metadata`. The gateway (`SttWsGateway`) reads only `seq`+`data` and drops everything else.
2. **VAD aggregation breaks 1:1 correlation.** `apps/stt` folds many audio frames into one utterance-scoped result — there is no per-frame result to attach a per-chunk tag to.
3. **Mixing destroys source identity.** `AudioMixer` sums all sources into one opaque track before any transcript exists; device identity is gone by the time STT runs.

Every server-echo design edits `SttWsGateway` at minimum (core, `05-nestjs-api.md`), plus the SDK client, plus — across the VAD boundary — the streaming bridge and `apps/stt` (core Python). **There is no additive seam.** TASK-564 therefore scopes the passthrough to the client (decision E1). This is not a lesser guarantee than v1 in practice: v1's own passthrough was best-effort/sticky and coarse (v1 doc §9.3), which the client-side model matches honestly.

---

## 4. What changed from v1 — be honest

| Aspect | v1 | v2 compat (`@arcaai/vox/compat`) | Impact on a migrated app |
|---|---|---|---|
| **Where it happens** | Server echoes metadata through the recognizer | **Client-side only** — the hook records + re-attaches; no server involvement | None on the call shape; the data no longer proves a server round-trip |
| **PCM** | `sendAudioData(pcm, …)` frames + sends the PCM | **PCM ignored** — v2 owns capture/transport; `sendAudioData` is a metadata sink | Stop hand-feeding PCM; keep calling `sendAudioData` only to *tag* turns |
| **Correlation** | Azure FIFO / Whisper sticky-per-batch — "coarse tag, not byte-exact" (v1 §9.3) | Utterance-sticky with a **capture-relative timeline**; degrades to pure sticky when the time base is unknown | Same real guarantee (coarse). Change your tag only at logical source boundaries |
| **Device identity** | App supplies `device_id`; no per-source derivation either | **Lost after mixing** — pass `device_id`/`role` as caller metadata (round-trips opaquely). The only *derived* source signal is diarization `speaker_id` (`speakerLabel`) | Keep sending `device_id`/`role`; don't expect v2 to infer them |
| **Caller-key collision (F4)** | n/a (server-owned) | **Fixed** — caller keys override hook enrichments; only `chunk_id`/`detected_language` overlay last | A metadata `speaker_id`/`confidence`/`language`/`isFinal` you set is preserved, not clobbered |
| **`transcriptTemplate`** | default `"{timestamp} {speaker_id}: {text}"` | **Same default** (finals only; interims raw) | Identical for finals; interim text is now un-templated |
| **`detected_language`** | recognizer-reported when available | **Session-configured** `seg.language` unless you send `detected_language`/`detectedLanguage` | Treat as coarse; send your own if you have real detection |

### Limitations table (what NOT to rely on)

| Limitation | Consequence | Mitigation |
|---|---|---|
| **No backend echo** | Delivered metadata is client-recorded, not server-verified | If you need a server-attested tag, that's a future backend ticket (§6) |
| **No per-source device tag** | Mixing erases which mic a word came from | Pass `device_id`/`role` yourself; use diarization `speaker_id` for the derived signal |
| **Coarse correlation** | A tag maps to an *utterance window*, not a byte range | Change `chunk_id`/`role` only at logical turn boundaries |
| **`detected_language` is session-configured** | Not true per-utterance language detection unless code-switching populates `seg.language` | Send your own `detected_language` when you have it |
| **Interims are raw + coarse** | Interim `metadata` uses most-recent sticky tag; interim `text` is un-templated | Rely on finals for the authoritative tag + formatting |

---

## 5. Correlation model (E2, frozen in §5.3)

- `captureStartMs` is anchored at `startTranscription()`; the timeline resets on `stopTranscription()`.
- Each `sendAudioData` pushes `{ atMs, metadata }` where `atMs = Date.now() - captureStartMs` (capture-relative).
- **Final** segment (has stream-relative `startTime` seconds): choose the latest timeline entry with `atMs ≤ startTime*1000`; if none precedes — or the base is unknown — fall back to the **most-recent** entry (pure sticky).
- **Interim:** most-recent entry (sticky).
- **Time-base risk (flagged in §5.3):** `atMs` is wall-clock-relative while `startTime` is stream-relative seconds; both count forward from ~capture start, so the comparison is meaningful, but a large clock offset could mis-window a tag. When the base is unavailable the model **degrades to sticky — never worse than v1's single-bag behavior.** If live testing shows mis-attribution across an utterance boundary, the documented fallback is pure sticky.

---

## 6. Example (inline)

The runnable version lives in `apps/example/src/compat-consultation.tsx` (`compat.html`). Minimal shape:

```tsx
import { useArcaSpeechToText } from '@arcaai/vox/compat';

function LiveTranscribe({ sessionId, consultationId }: { sessionId: string; consultationId: string }) {
  const chunk = useRef(0);
  const [lines, setLines] = useState<{ text: string; meta?: Record<string, unknown> }[]>([]);

  const stt = useArcaSpeechToText({
    sessionId,
    language: 'en',
    // metadata comes back here, normalized with chunk_id / detected_language (§2.3)
    onTranscript: (text, isFinal, metadata) => {
      if (isFinal) setLines((prev) => [...prev, { text, meta: metadata }]);
    },
  });

  // Tag a turn at its boundary. PCM is ignored — pass an empty buffer.
  const tagTurn = (role: 'clinician' | 'patient') =>
    stt.sendAudioData(new ArrayBuffer(0), {
      device_id: role === 'clinician' ? 'mic-1' : 'mic-2',
      role,
      chunk_id: `chunk-${(chunk.current += 1)}`,
      consultationId,
    });

  return (
    <>
      <button onClick={() => stt.startTranscription()}>Start</button>
      <button onClick={() => tagTurn('clinician')}>Clinician speaking</button>
      <button onClick={() => tagTurn('patient')}>Patient speaking</button>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>
            {l.text}
            {/* device_id / chunk_id you sent; speaker_id derived from diarization */}
            <small> [{String(l.meta?.device_id ?? '—')} · {String(l.meta?.chunk_id ?? '—')} · {String(l.meta?.speaker_id ?? '—')}]</small>
          </li>
        ))}
      </ul>
    </>
  );
}
```

---

## 7. Deferred / out of scope (per [§7](./README.md#7-explicitly-deferred--out-of-scope))

- **Server-side metadata echo** — requires core changes (`SttWsGateway`, and across VAD the bridge + `apps/stt`). A separate backend ticket must own those edits and the SDK thread-through. The smallest such change is wiring the latent **`microphoneId` field** on `WsAudioFrame`, which the SDK declares but the gateway never reads today (a **dead wire field**, finding I3). Until then there is no per-source device tag on the wire.
- **A v2-native (non-compat) public metadata hook** (E4) — deferred; the documented pattern is to read `transcriptSegments` from the store and correlate app-side, exactly as this compat hook does.
- **Byte-exact per-chunk correlation** — impossible in v2 (VAD aggregation; no echoed `chunk_id`). The contract is utterance-sticky by design.

---

## 8. Where the truth lives

| Question | Authority |
|---|---|
| The frozen contract (send/receive/precedence/correlation) | [TASK-564 §5](./README.md#5-canonical-metadata-passthrough-contract-single-source-of-truth--frozen) |
| Why client-side (feasibility verdict) | [TASK-564 §2.3](./README.md#23-backend-echo-feasibility-verdict-definitive--no-additive-seam) |
| As-built hook | `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` + `speechToTextMetadata.ts` |
| Contract tests (drift guard) | `packages/agentic-sdk-v2/src/compat/__tests__/metadata-passthrough.contract.test.ts` |
| Runnable example | `apps/example/src/compat-consultation.tsx` (`compat.html`) |
| v1 protocol (for contrast) | `…/HOPE/docs/packages/agentic-sdk/docs/live-transcription-websocket-metadata.md` |
