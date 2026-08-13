# TASK-628 Reference — Streaming-ASR Reconnect & Resume: Vendor Survey

**Researched**: 2026-08-07 · **Method**: primary vendor documentation only; community/blog sources explicitly flagged as non-primary.

Preserved here ahead of the TASK-628 ticket body so the sourcing isn't lost. It answers one question: *what do production streaming-ASR vendors actually do about mid-session disconnects?*

---

## The headline

**None of the six vendors surveyed documents a session-resumption mechanism.** In every case a reconnect is a brand-new session. Where a vendor says anything at all, the client is told to **buffer the gap audio itself and re-base the timestamps**.

| Vendor | Resume token? | How you detect a restart | Max stream/session | Gap-audio guidance |
|---|---|---|---|---|
| **Deepgram** | **No** — docs say "start a new streaming session" | new `request_id`; timestamps restart at `00:00:00` | ⚠️ not documented for STT; 10 s inactivity → `NET-0001` | Buffer locally, send for delayed transcription, add your own start-timestamp offset |
| **AssemblyAI v3** | **No** | new `Begin.id`; `turn_order` restarts | 3 h (or token-set max); expiry → close `3008` | ⚠️ not documented |
| **Speechmatics RT** | **No** — `seq_no` is flow control, not a cursor | new `RecognitionStarted.id`; `seq_no` restarts | 48 h; 1 h no-audio; 3 min no ping/pong | ⚠️ not documented — and nothing is stored server-side, so a lost session's un-emitted transcript is unrecoverable |
| **OpenAI Realtime** | **No** | ⚠️ `session.created` payload unverified (403 on the reference page) | 60 min (current docs) | ⚠️ not documented; replay conversation items yourself |
| **Google STT v2** | **No** — "close the stream and open a new one" | client-managed `restart_counter` | **5 min** per stream; 25 KB per message | **Best-documented of the six** — see below |
| **Azure Speech** | **No**; the SDK reconnects the *transport* only | new `SessionId` on `SessionStarted`/`Connected` | ⚠️ not documented for plain RT STT; 240 min for RT diarization | ⚠️ not documented; a mid-interaction disconnect is documented as **"loss of data for that interaction"** |

---

## What this means for HOPE

Two conclusions, and they point in opposite directions:

**1. HOPE's resume protocol is ahead of the industry, not behind it.** `SttWebSocketClient`'s `{type:'resume', sessionId, lastSeq}` handshake, the server's 200-entry resume buffer, the 15 s grace window, and `rebindSession()` are more than any surveyed vendor offers. That is a genuine differentiator for a clinical product where a dropped sentence matters. It should be treated as an asset worth finishing, not a half-built feature.

**2. HOPE is missing the baseline that every vendor tells clients to implement.** `StreamingBackendSTTProvider.processAudio` returns early and **discards** audio while disconnected. Every vendor's published guidance — explicitly Deepgram's and Google's, implicitly the rest — is that the *client* buffers the gap and re-sends it.

So the priority ordering is the inverse of what "we already have a resume protocol" would suggest: **client-side audio buffering should land first.** It is the industry-universal fallback, it works even when resume fails (`unknown_session`, cross-pod reconnect, Redis loss), and it is strictly simpler than moving session state into Redis. Cross-pod resume remains the right end-state; it is not the right first step.

---

## Google's infinite-streaming pattern — the one concrete reference implementation

Google publishes a working sample precisely because its 5-minute cap forces every long session to restart. It is the clearest vendor-published gap-handling pattern available and maps almost directly onto HOPE's problem:

- A `STREAMING_LIMIT` constant (~4–5 min) restarts the stream **before** the API's hard cap.
- On restart: close the send side, cancel the observer, increment a `restart_counter`, open a new stream.
- **Buffer recent audio and re-send the overlap into the new stream** —
  `chunks_from_ms = round((final_request_end_time - bridging_offset) / chunk_time)`.
- **Re-base timestamps client-side** so they stay monotonic across the seam —
  `corrected_time = result_end_time - bridging_offset + (STREAMING_LIMIT * restart_counter)`.

The timestamp re-basing matters for HOPE specifically: the platform already carries per-utterance provenance and timeline anchoring (see TASK-611/613), so a naive re-send would produce duplicate or non-monotonic timestamps unless an equivalent bridging offset is applied.

---

## Useful protocol details worth borrowing

- **Deepgram KeepAlive** — `{"type":"KeepAlive"}` as a text frame, recommended every 3–5 s against a 10 s inactivity window. KeepAlive alone does not hold the socket open indefinitely; at least one audio message is required.
- **Deepgram Finalize / CloseStream** — `{"type":"Finalize"}` flushes buffered audio and forces final results without closing; `{"type":"CloseStream"}` flushes, sends final metadata, then terminates. HOPE's drain path (Appendix G §G2) wants exactly this shape: flush-then-close, not close-and-lose.
- **AssemblyAI ForceEndpoint / Terminate** — manual turn termination, plus a `Termination` reply carrying `audio_duration_seconds` and `session_duration_seconds`. Useful for reconciling billing/usage metering against a session that ended abnormally.
- **Speechmatics `AudioAdded`/`seq_no` acks** — per-chunk acknowledgement gives the client a precise picture of what the server has actually processed. HOPE's `lastSeq` is the same idea; the difference is Speechmatics does *not* let you resume from it, and HOPE does.
- **Close codes** — vendors use `1008` (policy/auth), `1011` (internal), and app-specific `3006`/`3008`/`3009`. HOPE's proposed `1012` (service restart) for drain is consistent with this style, though note `1012` is an IANA-registered code rather than one defined in RFC 6455 itself.

---

## Explicitly unverified — do not cite as primary

Recorded so nobody re-derives a wrong number later:

1. **Deepgram STT max connection duration** — no primary source found. The widely-quoted 60-minute figure is on the **TTS** streaming page, not Listen/STT. Do not attribute it to STT.
2. **OpenAI `session.created` schema / `session.id` field** — the API-reference page returned HTTP 403; the fetchable guide pages were truncated and did not include it.
3. **OpenAI 15-min / 30-min session limits** — community forum and GitHub-issue material only. The limit has been raised over time; current docs say 60 min.
4. **Azure token expiry (~10 min) and `ServiceTimeout` semantics** — Microsoft Q&A community answers, not reference documentation.
5. **Speechmatics "10 s / 500 `AddAudio` ahead-of-time buffer"** — from the **legacy container** docs (v1.4.1), not the current SaaS RT reference.
6. **AssemblyAI reconnect-with-backoff advice** — an AssemblyAI **blog post**, not the reference docs.

Also worth stating as a finding in its own right: **no vendor publishes reliability numbers for audio loss or transcript completeness**, and none prescribes a bounded-queue size or overflow policy for client-side buffering. Those are decisions vendors push onto the client. For HOPE that means the bar is being set, not inherited — the design rationale has to stand on its own reasoning rather than on an industry citation.

---

## Sources

[Deepgram: recovering from connection errors](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio) · [Deepgram NET/DATA errors](https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors) · [Deepgram KeepAlive](https://developers.deepgram.com/docs/audio-keep-alive) · [Deepgram Finalize](https://developers.deepgram.com/docs/finalize) · [Deepgram CloseStream](https://developers.deepgram.com/docs/close-stream) · [Deepgram Listen Live reference](https://developers.deepgram.com/reference/listen-live) · [AssemblyAI streaming API reference](https://assemblyai.com/docs/api-reference/streaming-api/streaming-api) · [AssemblyAI session errors & closures](https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures) · [AssemblyAI Universal-Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming) · [Speechmatics RT WebSocket reference](https://docs.speechmatics.com/api-ref/realtime-transcription-websocket) · [Speechmatics RT limits](https://docs.speechmatics.com/speech-to-text/realtime/limits) · [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) · [Google STT quotas](https://docs.cloud.google.com/speech-to-text/docs/quotas) · [Google STT v2 streaming](https://docs.cloud.google.com/speech-to-text/v2/docs/streaming-recognize) · [Google infinite-streaming sample](https://docs.cloud.google.com/speech-to-text/docs/samples/speech-transcribe-infinite-streaming) · [Azure session ID](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-get-speech-session-id) · [Azure connection control](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-control-connections) · [Azure quotas & limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
