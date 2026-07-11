# TASK-492 — WS-Duplex LLM→TTS Streaming (speak-while-generating)

| | |
|---|---|
| **Status** | `Pending` — plan only (no code) |
| **Type** | `feature` — Python WS endpoint + NestJS WS gateway bridge + SDK duplex |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488](../TASK-488-Realtime-TTS-Service/README.md) §6 follow-up #2 (Q5-prioritized) |
| **Depends on** | TASK-488 (service + provider router), TASK-491 (SDK playback), existing SMR SSE stream |
| **Branch (suggested)** | `feature/492-tts-ws-duplex` |

## 1. Requirement Analysis

Today the read-aloud path is **one-shot**: a completed summary → `POST /api/v1/speech/synthesize` → streamed audio (TASK-488/491). The Q5 use case wants **speak-while-generating** — as SMR streams summary tokens, synthesize and play audio incrementally so the clinician hears the summary as it forms.

**Requirements**
- R1 — A duplex TTS transport: incremental text in → audio frames out, over a single connection (WebSocket), so first audio ships after the first sentence rather than after the whole summary.
- R2 — Gateway-fronted with the same posture as STT streaming: single-use stream ticket (never a JWT in the URL), tenant binding, generic auth-failure close code (404/enumeration-safe).
- R3 — Reuse the provider abstraction: a `stream()` method alongside `synthesize()` (the LiveKit-style dual interface from the TASK-488 architecture research). Azure has a native **text-input streaming** WS (v2 endpoint, `TextStream`); non-streaming engines (Kokoro/Parler) use a **sentence aggregator** (`pysbd`) so they still stream per sentence.
- R4 — SDK consumption: the browser bridges the SMR SSE token stream into the TTS WS and plays the returned audio (reuses the TASK-491 `TtsPlaybackPlayer`).

**Non-goals (this ticket)**: backend-orchestrated SMR→TTS piping (browser-driven bridge is day-1; a server-side orchestrator is a later option), word-timestamp karaoke highlighting, barge-in/WebRTC.

## 2. Current State Evaluation

- **Router** (`apps/tts-v2/src/tts_v2/routing/router.py`) implements `synthesize()` (chunked) only; the TASK-488 design already anticipates a `stream()` + `SynthesisStream` protocol — not yet built. `native_streaming` per engine exists.
- **Providers**: Azure (`azure_speech.py`) uses `start_speaking_text_async` (one-shot); the SDK also supports the **v2 websocket `SpeechSynthesisRequestInputType.TextStream`** for incremental text (no SSML in that mode) — the native duplex path. Kokoro/Parler are full-utterance → aggregate to sentences.
- **Gateway WS exemplar**: `apps/api/src/modules/streaming/stt-ws.gateway.ts` — `@WebSocketGateway({ path: '/ws/stt-v2/stream' })`, handshake `?sessionId=&ticket=`, `StreamTicketService.consumeTicket` (scope `stt_session:{id}`), `StreamSessionTenantBindingService`, all rejections close with the same `4401`. Stream tickets minted via `POST /api/v1/auth/stream-ticket`.
- **STT streaming session control-plane**: `apps/stt-v2/src/stt_v2/streaming/api/routes.py` (`/internal/streaming/sessions`) + Redis Streams transport — the shape to mirror for a tts-v2 session/WS runtime.
- **SDK**: `TtsPlaybackPlayer` (TASK-491) already does gapless PCM playback; SMR SSE is consumed today via `SSEClient`/summary hooks.

## 3. Design

- **tts-v2 WS endpoint** — a FastAPI `websocket` route (behind `X-Service-Token` at the gateway hop; browser never connects directly). Protocol (ElevenLabs-style, from the TASK-488 API research):
  - init: `{ voice, format?, speed? }`
  - incremental: `{ text: "words ending with a space " }`, `{ flush: true }`
  - EOS: `{ text: "" }`
  - server → **binary audio frames** (PCM) + optional JSON `{ type: "alignment", ... }`; final `{ type: "done" }`.
- **Router `stream(voice_id, fmt)` → `SynthesisStream`** with `push_text()`, `flush()`, `end_input()`, `__aiter__()` (chunks). Native-streaming engines (Azure text-stream) forward directly; others wrap in a `SentenceAdapter` that buffers tokens to sentence boundaries (`chunk_text`) then calls `synthesize()` per sentence. Failover only before first byte (unchanged rule).
- **Azure text-stream provider path** — connect to `wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2`, `SpeechSynthesisRequestInputType.TextStream`, `request.input_stream.write(token)` / `.close()`; pre-warmed connection pool. (No SSML in this mode — plain voice.)
- **Gateway `TtsWsGateway`** — `@WebSocketGateway({ path: '/ws/tts-v2/stream' })` mirroring `SttWsGateway`: `?sessionId=&ticket=`, `consumeTicket` (new scope `tts_session:{id}`), tenant binding, uniform `4401` close. Bridges browser frames ↔ tts-v2 WS, injecting `X-Service-Token`. Add `tts_session` to the stream-ticket scope allow-list.
- **SDK** — a `useTtsStream` hook (or a `speakStream()` mode on `useTtsPlayback`): opens the gateway WS with a stream ticket, `pushText(token)` from the SMR SSE callback, pipes returned audio into `TtsPlaybackPlayer`.

## 4. Implementation Plan (phased, TDD)

1. **Provider `stream()` + SentenceAdapter** (`routing/`, `providers/base.py`): `SynthesisStream` protocol; adapter over non-streaming engines; unit tests with `FakeEngine` (push_text → per-sentence synth, flush, EOS, no-mid-stream-failover).
2. **Azure native text-stream** (`azure_speech.py`): `stream()` via the v2 WS TextStream; hermetic tests (mock SDK), live test behind `TTS_AZURE_LIVE_TEST=1`.
3. **tts-v2 WS endpoint** (`api/…/ws` + a `StreamingSessionManager`): protocol handling; hermetic tests (fake engine, in-memory WS).
4. **Gateway `TtsWsGateway`** (`apps/api/src/modules/speech/`): mirror `SttWsGateway`; new `tts_session` ticket scope; unit tests (ticket consume, tenant binding, 4401 on bad ticket) + e2e handshake.
5. **SDK duplex hook** (`packages/agentic-sdk-v2`): `useTtsStream`; WS client (reuse transport conventions); pipe SMR SSE → pushText → `TtsPlaybackPlayer`; vitest with mocked WS.
6. **Docs**: architecture overview (WS path), rules 05/06/08 as needed.

**Verification**: per-layer green (`py:tts-v2:test`, `pnpm build:api test:unit`, `pnpm --filter @arcaai/vox test`); manual: type into a demo → hear incremental audio; SMR-stream → read-aloud latency (first-audio-after-first-sentence) measured.

## 5. Risks
- Azure text-stream is SDK-only + no SSML (speed via a different mechanism) — validate the pooled-connection latency.
- Sentence aggregation adds latency for engines without native streaming — measure; keep sentence-1 fast.
- WS lifecycle/backpressure + client disconnect must cancel upstream synthesis (free GPU/Azure conn).

## 6. Implementation Summary
_(empty — plan only)_

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 follow-up #2) | Claude (Fable 5) + Tap Huynh |
