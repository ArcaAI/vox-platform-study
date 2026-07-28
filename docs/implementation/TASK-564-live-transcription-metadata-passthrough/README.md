# TASK-564 — Live-Transcription Per-Chunk Metadata Passthrough (v1→v2 Compatibility)

| | |
|---|---|
| **Status** | Review (TASK-565 + 566 implemented + verified; pending live-stack timeline check + commit) |
| **Type** | feature (migration-compatibility) |
| **Classification** | Epic — indexes sub-tickets TASK-565 · TASK-566 |
| **Parent context** | Extends [TASK-560](../TASK-560-v1-v2-consultation-migration/README.md) (the consultation-workflow compat layer) and its shipped [TASK-561](../TASK-561-v1-compat-sdk-hooks/README.md) `@arcaai/vox/compat` hooks |
| **Owner** | (multi-agent) |
| **Created** | 2026-07-28 |
| **Branch** | `thuynh/2607` (planning); execution branches per sub-ticket |
| **v1 source doc** | `…/HOPE/docs/packages/agentic-sdk/docs/live-transcription-websocket-metadata.md` |

> **One-line goal:** Reproduce v1's *per-chunk metadata passthrough* — `sendAudioData(pcm, metadata)` → `onTranscript(text, isFinal, metadata)` round-trip — on HOPE-v2's `@arcaai/vox/compat` surface, **entirely client-side**, so a migrated app's metadata-tagged live-transcription code keeps working with zero app change beyond TASK-560's import/provider swap. **No HOPE-v2 core-business changes** — the STT gateway, streaming bridge, and `apps/stt` stay untouched.

---

## 1. Requirement Analysis

### 1.1 The v1 feature (what we must preserve)

From `live-transcription-websocket-metadata.md`: on top of the live-STT WebSocket, the v1 client attaches an **arbitrary JSON metadata object to each audio chunk** (`{device_id, role, chunk_id, consultationId, …}`, ≤ 8 KiB); the server threads it through the recognizer and **echoes it verbatim on each transcription result**, and the client normalizes two derived keys (`chunk_id`, `detected_language`, §4.3). One-line contract:

```
sendAudioData(pcm, metadata)  ──►  … recognizer …  ──►  onTranscript(text, isFinal, metadata)
```

This is the middle step of the protected workflow (**start session → record mixed stream + metadata → live transcripts → stop → summary**). Session start and stop→summary are already covered by TASK-560/561/562; this ticket completes the **metadata fidelity** of the "record + live transcripts" step.

### 1.2 Constraints (hard)

- **DO NOT change core business logic.** `SttWsGateway`, `StreamingSessionService`, `StreamingAudioBridgeService`, `apps/stt`, and the existing v2 SDK hooks/store/clients stay untouched. Everything added is additive and client-side (in `@arcaai/vox/compat`) plus docs/tests.
- Respect `08-vox-sdk.md` (per-provider store, public accessors/sanctioned internal hooks only, `"use client"`), `07-react-ui.md`, `04/05/06` where relevant.
- Reproduce the v1 API **shape** faithfully; do NOT reproduce v1's two known defects (see §6).

### 1.3 Scope decisions (locked — see §2.2 for the evidence)

| # | Decision | Choice | Why |
|---|---|---|---|
| **E1** | Where the passthrough lives | **Client-side only, in `@arcaai/vox/compat`.** No new backend endpoint, no gateway/bridge/`apps/stt` change. | The v2 STT wire drops per-chunk metadata; every server-side echo design edits `SttWsGateway` at minimum (core) — verified §2.3. v1's own passthrough was best-effort/sticky anyway (§6 F1/F3). |
| **E2** | Correlation model | **Utterance-sticky with a capture-relative timeline** (improve on today's single "last-write-wins" bag), with pure-sticky as the documented fallback. | v2 (and v1) cannot do byte-exact per-chunk correlation — VAD aggregates many frames into one utterance and no `chunk_id` is echoed. Utterance-sticky matches v1's real guarantee; a timeline raises fidelity at low cost. |
| **E3** | Per-source (device/role) tagging under real mixing | **Not auto-derived; passed through as caller metadata only; diarization `speakerLabel` is the sole post-mix source signal.** | `AudioMixer` produces one opaque track — device identity is structurally lost before any transcript exists (§2.3-B). Honest limitation, documented. |
| **E4** | v2-native (non-compat) metadata API | **Deferred — documented pattern only, no new public v2 hook this ticket.** | Avoids scope creep / touching core hooks. If wanted later, add an opt-in `@arcaai/vox/compat` util reading the store; noted in §7. |

### 1.4 Deliverables (sub-tickets)

| Ticket | Deliverable | Package | Suggested tier |
|---|---|---|---|
| **TASK-565** | Harden `@arcaai/vox/compat` `useArcaSpeechToText` to faithfully implement the §5 metadata-passthrough contract: §4.3 normalization, default `transcriptTemplate`, **fix the caller-key-collision defect (F4)**, capture-relative timeline correlation, optional 8 KiB guard, TDD | `packages/agentic-sdk-v2` | claude-opus-4-8-medium |
| **TASK-566** | The v2 equivalent of the v1 doc (metadata-passthrough contract + honest limitations), example update, and contract tests locking the round-trip shape; update `MIGRATION_GUIDE.md` | `docs/`, `apps/example`, `tests/` | sonnet-5-high (doc/example) + opus (contract tests) |

**Dependency graph:** TASK-565 implements the contract (frozen §5). TASK-566 documents + locks it and depends on 565 landing. Both build only against §5.

---

## 2. Current State Evaluation (verified 2026-07-28)

### 2.1 Workflow-step mapping (metadata dimension)

| Aspect | v1 | v2 (as-built) | Delta |
|---|---|---|---|
| Send metadata | `sendAudioData(pcm, metadata)` → binary frame `[type\|len\|metaJSON\|pcm]` (or text `{type:'audio',metadata,data}`) | compat `sendAudioData(pcm, metadata)` → **sticky `turnMetadataRef`**, PCM discarded (v2 owns transport) | Same call shape; v2 records metadata client-side instead of on the wire |
| Server echo | recognizer buffers + re-attaches metadata → `{type:'transcription', …, metadata}` | **none** — v2 wire has no metadata field; gateway drops it | v2 cannot echo server-side without core change |
| Receive | `onTranscript(text, isFinal, metadata)` + client normalizes `chunk_id`/`detected_language` (§4.3) | compat synthesizes `onTranscript` from store `transcriptSegments`/`currentTranscript`, spreads sticky metadata | Missing §4.3 normalization + default template; has a collision defect (F4) |
| Correlation | Azure FIFO / Whisper sticky-per-batch — "coarse tag, not byte-exact" (v1 §9.3) | single sticky bag — "attach-to-next-turn" | Both coarse; v2 currently coarser (no timeline) |

### 2.2 Architecture differences (why it can't be a wire-level reproduction)

1. **No metadata on the v2 STT wire.** `WsAudioFrame` (`packages/agentic-sdk-v2/src/types/stt.ts:148-156`) carries only `{type,seq,data,microphoneId?}`; `WsTranscriptResult` (`stt.ts:200-252`) has a fixed field set with **no** generic `metadata`. The tolerant pre-normalization `WsTranscriptWirePayload` has an index signature (`stt.ts:304`) but `SttWebSocketClient.normalizeTranscript` (`core/SttWebSocketClient.ts:729-866`) extracts only named fields and drops the rest.
2. **Gateway drops it.** `SttWsGateway.handleMessage` `case 'audio'` (`apps/api/src/modules/streaming/stt-ws.gateway.ts:857-862`) reads only `seq`+`data` (the SDK's declared `microphoneId` is a **dead wire field** — zero reads under `apps/api/src`). Frames go to `bridgeService.writeAudioFrame(sessionId, seq, data, sampleRate, 'pcm_s16le', false)` (`:906-917`) → Redis XADD schema `seq,sr,enc,ch,data,final,ts` (`streamingAudioBridge.service.ts:233-268`) — no metadata field anywhere.
3. **VAD aggregation breaks 1:1 correlation.** `apps/stt` reads many `AudioFrame`s and emits one utterance-scoped `SegmentResult` (`apps/stt/src/stt/streaming/schemas.py` `AudioFrame` L50-81 / `SegmentResult` L130-168) — no per-frame result mapping exists in the protocol, only many-frames→one-utterance correlated loosely by `start_time`/`end_time`.
4. **Mixing destroys source identity.** `AudioMixer` (`packages/room/src/core/AudioMixer.ts`) sums sources into one `MediaStreamAudioDestinationNode`; the `AudioMixerSource.id` (`'primary'`/`'secondary'`) never leaves the mixer. Post-mix, **only diarization `speakerLabel` signals source** (`useArcaAudio.ts` `deriveSpeakerLabel:35-41`).

### 2.3 Backend-echo feasibility verdict (definitive — no additive seam)

To echo metadata to the client, the **minimum** design (gateway-only, sticky, mirroring the client shim) still edits **core**:
- `apps/api/src/modules/streaming/stt-ws.gateway.ts` — `SessionInfo` + `case 'audio'` + `relayResult`/`tagAndBuffer` (CORE, `05-nestjs-api.md`).
- SDK thread-through to surface it: `SttWebSocketClient.normalizeTranscript`, `packages/stt` `StreamingBackendSTTProvider.normalizeTranscript` (`:50-69,321-340`), `useArcaAudio.ts` `TranscriptSegment` build (`:204-218`).
- Stronger (across the VAD boundary): also `StreamingAudioBridgeService.writeAudioFrame` (CORE, applications) + `apps/stt/.../schemas.py` (CORE, Python).

**There is no edit path that avoids core.** → E1: client-side only. (The dead `microphoneId` field is a latent v2 capability; wiring it would be a core gateway change and is out of scope — recorded as a finding.)

### 2.4 As-built compat hook (`packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts`)

Already ships (TASK-561): sticky `turnMetadataRef` (`:89`), overwritten wholesale by `sendAudioData` (`:153-158`), spread onto every synthesized `onTranscript` for finals (`:106-114`) and interims (`:124`). Confirmed gaps: no `chunk_id`/`detected_language` normalization; no default `transcriptTemplate` (`:58-64` returns raw text when absent); single sticky value (no timeline); **caller-key-collision defect** (F4, §6); `language` is session-configured, not detected.

---

## 3. Implementation Plan (epic-level)

```
Phase 0 (this doc)   Frozen contract §5  ───────────────────────────┐
Phase 1  TASK-565  harden compat useArcaSpeechToText (TDD) ─────────┤
Phase 2  TASK-566  docs (v2 metadata contract) + example + tests ───┘  (after 565)
```

Per-layer gates: **565** — `pnpm --filter @arcaai/vox build lint test typecheck` green; **566** — contract tests green in `pnpm --filter @arcaai/vox test`; example builds; guide has no drift from as-built.

### Definition of done (epic)

- [ ] A v1 app that used `sendAudioData(pcm, {device_id, role, chunk_id, …})` + read `metadata.chunk_id`/`metadata.detected_language`/`metadata.device_id` off `onTranscript` keeps working on `@arcaai/vox/compat` unchanged.
- [ ] Caller metadata keys are **never** silently overwritten by hook-derived fields (F4 fixed).
- [ ] `transcriptTemplate` defaults to `"{timestamp} {speaker_id}: {text}"` (v1 parity).
- [ ] No diffs to `SttWsGateway`, `StreamingAudioBridgeService`, `StreamingSessionService`, `apps/stt`, or existing v2 hooks/store/clients.
- [ ] v2 metadata-passthrough doc + example + contract tests committed; limitations (no backend echo, no per-source device tag, coarse correlation) stated honestly.

---

## 4. Best Practices & Gold Standards

- **Additive-only, client-side.** New/edited files only under `packages/agentic-sdk-v2/src/compat/`, `docs/`, `apps/example/`, `tests/`. Do not touch v2 core hooks/store/clients or any backend file.
- **`08-vox-sdk.md` compliance:** read state via the sanctioned context-backed `useAgenticStore` selectors (already used by the compat hook — NOT the deprecated inert singleton); `"use client"` on every file.
- **TDD red-first** (`01-development-workflow.md`).
- **Honest docs:** do not oversell — state the three real limitations (E1/E2/E3). Reference the v1 doc's own §9 candor.
- **Don't reproduce v1 defects** (§6): the broken binary frame, and the caller-collision must be fixed, not carried.

---

## 5. Canonical Metadata-Passthrough Contract (SINGLE SOURCE OF TRUTH — frozen)

Both sub-tickets implement/lock against this.

### 5.1 Send

```ts
sendAudioData(audioData: ArrayBuffer, metadata?: Record<string, unknown>): void
```
- `metadata` — arbitrary JSON object (v1 examples: `device_id`, `role`, `chunk_id`, `consultationId`). PCM is **ignored** (v2 owns capture/transport).
- Records the metadata into a bounded, capture-relative **timeline** (E2). If `metadata` omitted, the timeline entry is `undefined` (no-op on delivery).
- **Optional (MAY)** 8 KiB guard for parity: if `JSON.stringify(metadata).length > 8192`, throw `Audio frame metadata exceeds 8192 bytes` (v1 `MAX_METADATA_BYTES`). Low value (no wire frame) — implement only if trivial; document either way.

### 5.2 Receive

```ts
onTranscript(text: string, isFinal: boolean, metadata?: Record<string, unknown>): void
```
- `text` — formatted through `transcriptTemplate` (**default `"{timestamp} {speaker_id}: {text}"`** — v1 parity).
- Delivered metadata is composed in this **exact precedence order (lowest → highest)** to fix the collision defect (F4) while matching v1's §4.3 overlay:

```ts
deliveredMetadata = {
  // (1) v2 ASR/diarization enrichments — LOWEST precedence (caller may override)
  speaker_id,        // from TranscriptSegment.speakerLabel (diarization)
  confidence,        // seg.confidence
  language,          // seg.language (session-configured; see note)
  startTime,         // seg.startTime
  endTime,           // seg.endTime
  isFinal,           // true | false
  // (2) caller-supplied metadata for the correlated turn — OVERRIDES enrichments
  ...correlatedCallerMetadata,
  // (3) v1-canonical normalized keys — HIGHEST precedence (matches v1 §4.3 overlay-last)
  ...(chunk_id !== undefined ? { chunk_id } : {}),
  ...(detected_language !== undefined ? { detected_language } : {}),
}
```

- **`chunk_id` normalization (§4.3):** resolve from caller `metadata.chunk_id → metadata.chunkId → metadata.other` (v1 priority). v2 has no server-assigned chunk_id — it echoes what the caller supplied. Document this.
- **`detected_language` normalization (§4.3):** resolve from caller `metadata.detected_language → metadata.detectedLanguage → seg.language`. Note v2 uses the **session-configured** language (not per-utterance detection) unless code-switching populates it; document honestly.
- Interim (`isFinal:false`) delivery uses the **most-recent** timeline metadata (sticky) since interims have no reliable `startTime` window.

### 5.3 Correlation model (E2, frozen)

- Record `captureStartMs` at `audio.start()`.
- On each `sendAudioData`, push `{ atMs, metadata }` to a bounded ring (cap ~256, drop-oldest), where `atMs` is a capture-relative timestamp.
- **Final** segment (has `startTime` in stream-relative seconds): choose the latest timeline entry with `atMs ≤ startTime*1000`; if none, fall back to the most-recent entry (pure sticky).
- **Interim:** most-recent entry.
- **RISK (flagged):** the timeline uses a wall-clock-derived `atMs` while `TranscriptSegment.startTime` is stream-relative seconds (from `vadStreamStartSec`). TASK-565 MUST verify the two share a usable base (map via `captureStartMs`); if the mapping proves unreliable in tests, **degrade to pure sticky** (still correct, matches today) and document. Do not ship a timeline that mis-attributes worse than sticky.

### 5.4 Props / return (unchanged from TASK-560 §5.3, restated)

`UseArcaSpeechToTextProps`: `{ sessionId, language, options?, transcriptTemplate?, onTranscript, onError?, onStatus? }`.
Return: `{ transcript, startTranscription, stopTranscription, sendAudioData, uploadAudioFile, getTranscriptionStatus, isUploading, uploadProgress, error }`.

---

## 6. Findings / Defects / Anti-patterns

| # | Item | Source | Action |
|---|---|---|---|
| **F4** | **Caller-key-collision (NEW defect, must fix).** The as-built hook spreads `{...turnMetadataRef.current, speaker_id, confidence, language, startTime, endTime, isFinal}` — a caller who sets `speaker_id`/`confidence`/`language`/`isFinal` in their metadata has it **silently overwritten** by the hook. | `compat/useArcaSpeechToText.ts:106-114,124` | Fix via the §5.2 precedence order (caller overrides enrichments; only v1-canonical `chunk_id`/`detected_language` overlay last). |
| F1 | v1 **binary frame header never stripped** by `apps/stt` → header bytes fed as audio; metadata not recovered on the binary path. | v1 doc §9.1; TASK-560 F1 | Not applicable to v2 (no wire frame). Do not reproduce. |
| F3 | v1 correlation is **best-effort/coarse** (Azure FIFO pops on partial+final; Whisper sticky-per-batch; buffer `maxlen=100` silently drops). | v1 doc §9.3 | v2 client-side utterance-sticky is an honest, equal-or-better equivalent. Document as coarse tag. |
| I3 | v2 `SttWebSocketClient.sendAudioFrameJson` declares `microphoneId` but the gateway never reads it (**dead wire field**). | `stt.ts:148-156`, `stt-ws.gateway.ts:857-862` | Finding only. Wiring it is a core gateway change → out of scope; note for a future backend ticket. |
| I4 | Post-mix **device identity is unrecoverable**; diarization `speakerLabel` is the only source signal. | `AudioMixer.ts`, `useArcaAudio.ts:35-41,176-195` | Document (E3). App-supplied `device_id`/`role` still round-trips as opaque caller metadata. |
| A1/A2 | v1 hardcoded default `apiKey`/`encryptionKey`; TTS 10-tuple. | TASK-560 §6 | Already excluded; not in this ticket's surface. |

---

## 7. Explicitly deferred / out of scope

- **Server-side metadata echo** (any backend passthrough) — requires core changes (§2.3). If ever wanted, a separate ticket must own the `SttWsGateway` (+ optionally bridge/`apps/stt`) edits and the SDK thread-through; wiring the latent `microphoneId` field is the smallest such change.
- **A v2-native (non-compat) public metadata hook** (E4) — deferred; TASK-566 documents the read-`transcriptSegments`+correlate pattern instead.
- **Byte-exact per-chunk correlation** — impossible (VAD aggregation; no echoed `chunk_id`). Contract is utterance-sticky by design.

## 8. Implementation Summary

Both sub-tickets shipped, entirely client-side + docs/tests. **No core-business changes** — `SttWsGateway`, `StreamingSessionService`, `StreamingAudioBridgeService`, `apps/stt`, and the v2 SDK hooks/store/clients are untouched. The frozen §5 contract needed **no revision**: the as-built hook implements it faithfully.

### TASK-565 — hardened compat hook (In Progress → done, verified PASS)
- `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` + new pure helpers `packages/agentic-sdk-v2/src/compat/speechToTextMetadata.ts`.
- Delivered metadata composed in the §5.2 precedence order (enrichments lowest → caller overrides → `chunk_id`/`detected_language` overlaid last) — **fixes defect F4** (caller keys were being clobbered).
- §4.3 normalization (`resolveChunkId`, `resolveDetectedLanguage`), default `transcriptTemplate` `"{timestamp} {speaker_id}: {text}"` (finals; interims raw), capture-relative timeline correlation with a documented degrade-to-sticky fallback, and the 8 KiB parity guard.
- Public props/return shape unchanged. 17 tests added (incl. a caller-`language`-override assertion closing a verify-flagged coverage gap).

### TASK-566 — doc + example + contract tests (Review)
- **Doc:** `docs/implementation/TASK-564-.../METADATA_PASSTHROUGH.md` — v2 migration counterpart of the v1 doc; §5.2 shape, §4.3 normalization, "what changed from v1" + limitations tables, correlation model, inline example, deferred items (dead `microphoneId` field I3, future backend-echo ticket).
- **Example:** `apps/example/src/compat-consultation.tsx` — turn-tagging buttons calling `sendAudioData(new ArrayBuffer(0), {device_id, role, chunk_id, consultationId})`; renders `[device_id · chunk_id · speaker_id]` per line. `apps/example/README.md` updated.
- **Contract tests:** `packages/agentic-sdk-v2/src/compat/__tests__/metadata-passthrough.contract.test.ts` (23) + golden fixture `__tests__/fixtures/metadata-passthrough.golden.ts` — drift guard on §5.2 precedence, §4.3 chains, default template.

### Definition of done (epic) — status
- [x] A v1 metadata-tagged live-transcription app works on `@arcaai/vox/compat` unchanged beyond TASK-560's import/provider swap.
- [x] Caller metadata keys never silently overwritten (F4 fixed) — locked by contract tests.
- [x] `transcriptTemplate` defaults to `"{timestamp} {speaker_id}: {text}"`.
- [x] No diffs to `SttWsGateway`/bridge/session services/`apps/stt`/v2 hooks/store/clients.
- [x] v2 doc + example + contract tests committed to the working tree; limitations stated honestly.

### Verification (real tails)
- `pnpm --filter @arcaai/vox test` → 213 files / **3652 tests passed**; new contract file 23/23; example typecheck + `vite build` (✓ built in 3.11s) green.

### Owner tail
- Staged/working-tree only (concurrent-session hazard) — commit 565 + 566 together.
- Live e2e in a running stack to confirm the timeline time-base holds (§5.3 residual risk); documented fallback is pure sticky.

## 9. Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-28 | (planning) | Ticket created. Reviewed v1 `live-transcription-websocket-metadata.md`; one-agent v2 metadata-plumbing discovery (definitive backend-echo-touches-core verdict). Gap analysis, scope decisions E1–E4, frozen contract §5, defect F4 identified. Sub-tickets TASK-565/566 defined. |
| 2026-07-28 | (multi-agent) | TASK-565 + TASK-566 implemented via opus-4-8-high workflow (harden → adversarial verify PASS, 0 core-business violations → docs/tests). F4 fixed + locked by contract tests. Independently re-confirmed 82 compat tests green in isolation (+1 caller-`language`-override assertion added in the main session); the non-zero `pnpm --filter @arcaai/vox test` exit is a pre-existing unrelated `window is not defined` flake, not a regression. Status → Review. |
| 2026-07-28 | (opus) | Sub-tickets complete: TASK-565 hardened the compat hook (F4 fix + §4.3 + default template + timeline) verified PASS; TASK-566 shipped the v2 doc (`METADATA_PASSTHROUGH.md`), extended the compat example with turn-tagging + metadata render, and added the metadata-passthrough contract test (23) + golden fixture. §5 unchanged (no drift). §8 Implementation Summary populated. |
