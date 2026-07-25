# TASK-492 — WS-Duplex LLM→TTS Streaming (speak-while-generating)

| | |
|---|---|
| **Status** | **Implemented (code, hermetic-tested)** (2026-07-11) — all 6 phases. Live Azure text-stream (SDK-only, no creds here) and browser end-to-end remain manual/CI gates (`TTS_AZURE_LIVE_TEST=1` + a headed browser). |
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

- **Router** (`apps/tts/src/tts/routing/router.py`) implements `synthesize()` (chunked) only; the TASK-488 design already anticipates a `stream()` + `SynthesisStream` protocol — not yet built. `native_streaming` per engine exists.
- **Providers**: Azure (`azure_speech.py`) uses `start_speaking_text_async` (one-shot); the SDK also supports the **v2 websocket `SpeechSynthesisRequestInputType.TextStream`** for incremental text (no SSML in that mode) — the native duplex path. Kokoro/Parler are full-utterance → aggregate to sentences.
- **Gateway WS exemplar**: `apps/api/src/modules/streaming/stt-ws.gateway.ts` — `@WebSocketGateway({ path: '/ws/stt/stream' })`, handshake `?sessionId=&ticket=`, `StreamTicketService.consumeTicket` (scope `stt_session:{id}`), `StreamSessionTenantBindingService`, all rejections close with the same `4401`. Stream tickets minted via `POST /api/v1/auth/stream-ticket`.
- **STT streaming session control-plane**: `apps/stt/src/stt/streaming/api/routes.py` (`/internal/streaming/sessions`) + Redis Streams transport — the shape to mirror for a tts session/WS runtime.
- **SDK**: `TtsPlaybackPlayer` (TASK-491) already does gapless PCM playback; SMR SSE is consumed today via `SSEClient`/summary hooks.

## 3. Design

- **tts WS endpoint** — a FastAPI `websocket` route (behind `X-Service-Token` at the gateway hop; browser never connects directly). Protocol (ElevenLabs-style, from the TASK-488 API research):
  - init: `{ voice, format?, speed? }`
  - incremental: `{ text: "words ending with a space " }`, `{ flush: true }`
  - EOS: `{ text: "" }`
  - server → **binary audio frames** (PCM) + optional JSON `{ type: "alignment", ... }`; final `{ type: "done" }`.
- **Router `stream(voice_id, fmt)` → `SynthesisStream`** with `push_text()`, `flush()`, `end_input()`, `__aiter__()` (chunks). Native-streaming engines (Azure text-stream) forward directly; others wrap in a `SentenceAdapter` that buffers tokens to sentence boundaries (`chunk_text`) then calls `synthesize()` per sentence. Failover only before first byte (unchanged rule).
- **Azure text-stream provider path** — connect to `wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2`, `SpeechSynthesisRequestInputType.TextStream`, `request.input_stream.write(token)` / `.close()`; pre-warmed connection pool. (No SSML in this mode — plain voice.)
- **Gateway `TtsWsGateway`** — `@WebSocketGateway({ path: '/ws/tts/stream' })` mirroring `SttWsGateway`: `?sessionId=&ticket=`, `consumeTicket` (new scope `tts_session:{id}`), tenant binding, uniform `4401` close. Bridges browser frames ↔ tts WS, injecting `X-Service-Token`. Add `tts_session` to the stream-ticket scope allow-list.
- **SDK** — a `useTtsStream` hook (or a `speakStream()` mode on `useTtsPlayback`): opens the gateway WS with a stream ticket, `pushText(token)` from the SMR SSE callback, pipes returned audio into `TtsPlaybackPlayer`.

## 4. Implementation Plan (phased, TDD)

1. **Provider `stream()` + SentenceAdapter** (`routing/`, `providers/base.py`): `SynthesisStream` protocol; adapter over non-streaming engines; unit tests with `FakeEngine` (push_text → per-sentence synth, flush, EOS, no-mid-stream-failover).
2. **Azure native text-stream** (`azure_speech.py`): `stream()` via the v2 WS TextStream; hermetic tests (mock SDK), live test behind `TTS_AZURE_LIVE_TEST=1`.
3. **tts WS endpoint** (`api/…/ws` + a `StreamingSessionManager`): protocol handling; hermetic tests (fake engine, in-memory WS).
4. **Gateway `TtsWsGateway`** (`apps/api/src/modules/speech/`): mirror `SttWsGateway`; new `tts_session` ticket scope; unit tests (ticket consume, tenant binding, 4401 on bad ticket) + e2e handshake.
5. **SDK duplex hook** (`packages/agentic-sdk-v2`): `useTtsStream`; WS client (reuse transport conventions); pipe SMR SSE → pushText → `TtsPlaybackPlayer`; vitest with mocked WS.
6. **Docs**: architecture overview (WS path), rules 05/06/08 as needed.

**Verification**: per-layer green (`py:tts:test`, `pnpm build:api test:unit`, `pnpm --filter @arcaai/vox test`); manual: type into a demo → hear incremental audio; SMR-stream → read-aloud latency (first-audio-after-first-sentence) measured.

## 5. Risks
- Azure text-stream is SDK-only + no SSML (speed via a different mechanism) — validate the pooled-connection latency.
- Sentence aggregation adds latency for engines without native streaming — measure; keep sentence-1 fast.
- WS lifecycle/backpressure + client disconnect must cancel upstream synthesis (free GPU/Azure conn).

## 5b. Verified Research (2026-07-11 spike) — amends §2/§3/§5

- **Azure text-stream CONFIRMED**: v2 WS endpoint `wss://{region}.tts.speech.microsoft.com/cognitiveservices/websocket/v2` (build `SpeechConfig(endpoint=…, subscription=…)`, NOT `from_subscription`); `SpeechSynthesisRequest(input_type=TextStream)`; feed via `request.input_stream.write(token)` / `.close()`; read audio via the **`synthesizing` event** (`evt.result.audio_data`) — NOT `AudioDataStream.read_data` (that's the one-shot path; keep the two distinct); voice/format as **global properties** (`speech_synthesis_voice_name`, `Raw24Khz16BitMonoPcm`); set `SpeechSynthesis_FrameTimeoutInterval` + `SpeechSynthesis_RtfTimeoutThreshold` so slow LLM token arrival doesn't abort; pre-warm via `Connection.from_speech_synthesizer(synth).open(True)` + a synthesizer pool. The callback fires on an SDK thread → bridge to asyncio via `loop.call_soon_threadsafe` into an `asyncio.Queue`; offload the blocking `speak_async().get()` with `asyncio.to_thread`.
- **⚠️ Two Azure constraints (NEW):** (1) native duplex is **SDK-only** — no hand-rollable raw WS protocol. (2) **No speed control** in TextStream mode (no SSML, no documented rate knob) → **route `speed != 1.0` to the one-shot `synthesize()` path** (which can use SSML `<prosody rate>`); ship the native duplex at `speed=1.0`. Confirm empirically in the Azure spike.
- **Finalized WS protocol** (binary PCM frames + JSON control — no base64, saves ~33% + a decode):
  - Client→server (JSON text frames): `{"type":"init","voice","format":"pcm","sample_rate":24000,"language","speed":1.0}` (MUST be first; server validates → `ready`/`error` **before** any audio, so bad-voice/no-provider surfaces up front) · `{"type":"text","text":"words ending with a space "}` (trailing space significant) · `{"type":"flush"}` · `{"type":"end"}`.
  - Server→client: `{"type":"ready","sample_rate":24000,"format":"pcm","channels":1}` · **binary frames** = raw PCM s16le/24k/mono (no per-frame header) · `{"type":"done"}` · `{"type":"error","code":"provider_unavailable|invalid_voice|invalid_input|internal","message":"<generic, PHI-safe>"}`.
  - Rules: one `init`→one stream→one `done` (no multiplexing day 1); **failover only before the first audio frame** (unchanged rule); binary opcode preserved end-to-end (never JSON-wrap audio).
- **SentenceAdapter algorithm** (non-native engines): reuse the existing `routing/chunking.py` `chunk_text` (pysbd en / punctuation-fallback ml — decimals/ratios/`X-ray-യിൽ` already safe); on `push_text` buffer + emit complete sentences, **keep the last segment buffered** until more text/whitespace confirms the boundary; `flush`/`end` force-emit the remainder; `MIN_FIRST_FRAGMENT≈10` (first-fragment-fast → audio ASAP), `MIN_SENTENCE≈10–20` after sentence 1; a concurrent synth loop `synthesize()`s each sentence and yields its frames. Mirrors LiveKit `StreamAdapter`; tune params in Phase 0.
- **`stream()` interface**: `SynthesisStream` = `push_text` / `flush` / `end_input` / `__aiter__` / **`aclose`** (client-disconnect cancellation → Azure `stop_speaking_async()` + close pooled conn; local → cancel synth task, freeing GPU). Router picks native-streaming vs `SentenceAdapter`, with the Azure-speed fallback above.
- **Gateway `TtsWsGateway`**: mirror `stt-ws.gateway.ts` — path `/ws/tts/stream`, `?sessionId=&ticket=`, **new `tts_session` ticket scope** (add to the allow-list), tenant binding, uniform **`4401`** close on any auth failure, `X-Service-Token` on the upstream hop only, **binary PCM passthrough** (no re-encode/compress), backpressure via `bufferedAmount` (stop reading upstream when the browser socket saturates), `TTS_URL`→`ws(s)://…` form.
- **Flag**: end-to-end TTFA is gated by *when SMR delivers the first sentence's tokens*, not the Azure model boundary — measure SMR-token→first-audio, not just the provider latency.

Full spike (Azure code sketch, protocol table, adapter pseudo-code, gateway notes) in the completion report; cited sources: Azure lower-latency how-to + `tts-text-stream` sample, ElevenLabs stream-input reference, LiveKit `stream_adapter.py`, RealtimeTTS/stream2sentence, Deepgram chunking.

## 6. Implementation Summary — ✅ (2026-07-11, all phases)

**Phase 1 — provider `stream()` + SentenceAdapter** (`providers/base.py`, `routing/`)
- `SynthesisStream` protocol (`push_text`/`flush`/`end_input`/`__aiter__`/`aclose`) + `DuplexTTSEngine` (optional `open_stream`) in `base.py`.
- `routing/sentence_adapter.py` `SentenceAdapter`: buffers tokens, emits confirmed sentences to a per-sentence synth callable via a worker task, yields audio through a queue; `aclose` cancels the worker AND enqueues a done-sentinel so a parked consumer unblocks (client-disconnect path).
- `routing/chunking.py` `split_confirmed(buffer, locale)`: pulls sentences whose boundary is confirmed by trailing whitespace, keeps the unterminated remainder buffered (never splits decimals/`X-ray-യിൽ`).
- `TTSRouter.stream(voice_id, fmt, speed)`: prefers a native-duplex engine (`open_stream`) when it's the first candidate AND PCM + speed 1.0 (TextStream has no SSML); otherwise `SentenceAdapter` over `_ChainSynthesizer` — sentence 1 tries the candidate chain (before-first-byte failover), then locks to the serving provider (no mid-stream voice switch). `speed != 1.0` always uses the adapter (one-shot `synthesize` SSML-rate path).

**Phase 2 — Azure native text-stream** (`providers/azure_speech.py`)
- `open_stream` → `AzureTextStream` (v2 WS `…/cognitiveservices/websocket/v2`, `SpeechConfig(endpoint=…, subscription=…)`, `SpeechSynthesisRequest(TextStream)`): tokens → `request.input_stream.write/close`; audio arrives on the SDK `synthesizing` event (native callback thread) bridged to an asyncio queue via `call_soon_threadsafe`; blocking `speak_async().get()` off-loaded with `to_thread`; frame/RTF timeouts so slow LLM tokens don't abort; `aclose` → `stop_speaking_async()` + unblock.

**Phase 3 — tts WS endpoint** (`api/endpoints/stream_ws.py`, `/api/v1/audio/stream`)
- Protocol: `init`→`ready` (voice + provider availability validated up front), `text`/`flush`/`end`, **binary PCM frames out**, `done`, generic PHI-safe `error` (`invalid_voice`/`provider_unavailable`/`invalid_input`/`internal`). One init→one stream→one done; PCM only.
- Own `X-Service-Token` check (constant-time; empty = dev bypass) because `BaseHTTPMiddleware` doesn't cover the WS scope; auth failure closes `4401`. Concurrent reader (control frames) + writer (audio); client disconnect → `aclose` frees upstream.

**Phase 4 — NestJS `TtsWsGateway`** (`apps/api/src/modules/speech/tts-ws.gateway.ts`, `/ws/tts/stream`)
- Mirrors `SttWsGateway`: `?sessionId=&ticket=`, `consumeTicket` + scope `tts_session:<sessionId>`, uniform generic **`4401`** on any auth failure, `X-Service-Token` injected on the upstream hop only, **binary PCM passthrough** (never re-encoded), client→upstream frames buffered until upstream open, egress backpressure (pause/resume the upstream on `bufferedAmount` over `TTS_WS_EGRESS_HIGH_WATERMARK_BYTES`), teardown closes the peer. **No tenant-binding cross-check** — unlike STT there is no server-side session resource to own; the ticket is minted bound to the caller's active tenant, so scope-match + single-use consume is the authorization (documented in the gateway header). Registered in `SpeechModule`.

**Phase 5 — SDK `useTtsStream`** (`packages/agentic-sdk-v2/src/hooks/useTtsStream.ts`, exported from `@arcaai/vox/plugins`)
- `open({voice, speed})`: mints a `tts_session:<uuid>` ticket via `apiClient.post('/auth/stream-ticket')`, opens the gateway WS at the base **origin** (so a REST `/api/v1` suffix never leaks into the WS path), sends `init`, resolves on `ready`. `pushText(token)` / `end()` feed the SMR token stream; binary frames → `TtsPlaybackPlayer.enqueuePcm16` (TASK-491), `done` → `player.end()`, `error` → surfaced. Kept out of `/core` (audio isolation).

### Evidence
```
tts:  pytest src/tts/tests -q   → 131 passed, 2 deselected (azure + sarvam live)   · ruff clean
api:     vitest tts-ws.gateway.test   → 9 passed   · pnpm build:api → success   · eslint clean
vox:     vitest useTtsStream.test     → 5 passed   · build + tsc --noEmit → clean   · eslint clean
         bundle isolation: useTtsStream in dist/plugins.mjs (2 refs), dist/core.mjs (0 refs)
```
Hermetic throughout: fake engines, a fully-faked Azure SDK (event bridge exercised), Starlette's WS test client, a mock `ws`/`WebSocket`. **Manual/CI gates** (unchanged from the plan): live Azure text-stream behind `TTS_AZURE_LIVE_TEST=1`; browser end-to-end (SMR SSE → `pushText` → audible incremental playback) + the SMR-token→first-audio latency measurement.

**Non-goals** (deferred, per §1): server-side SMR→TTS orchestration, word-timestamp karaoke, barge-in/WebRTC.

## 7. Change History
| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Plan scaffolded (TASK-488 follow-up #2) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Research spike done (§5b): Azure text-stream confirmed (v2 WS, SDK-only, **no speed → speed≠1.0 falls back to one-shot**); finalized binary-PCM WS protocol; SentenceAdapter algorithm; `stream()`/`aclose` interface; `TtsWsGateway` (tts_session scope, 4401, binary passthrough, backpressure) | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | **Implemented all 6 phases (§6).** Provider `stream()` + `SentenceAdapter` + `split_confirmed` + `_ChainSynthesizer`; Azure `open_stream`/`AzureTextStream` (v2 WS, event→queue bridge); tts WS endpoint (`/api/v1/audio/stream`); NestJS `TtsWsGateway` (`/ws/tts/stream`, tts_session scope, 4401, binary passthrough, backpressure, no tenant-binding by design); SDK `useTtsStream` (plugins-only). Evidence: tts 131 pytest, api gateway 9 vitest + build, vox 5 vitest + build/typecheck, bundle isolation. Live Azure + browser E2E remain gated | Claude (Fable 5) + Tap Huynh |
