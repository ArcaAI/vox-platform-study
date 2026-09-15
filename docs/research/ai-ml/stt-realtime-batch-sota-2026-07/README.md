# STT Realtime + Batch SOTA (2026-07) Research — captured source material

A dated research archive: the complete source material behind
[`../stt-realtime-batch-sota-assessment-2026-07.md`](../stt-realtime-batch-sota-assessment-2026-07.md)
(the synthesis/report), produced 2026-07-10 by a 17-agent research/mapping fleet (5 top-level
agents, 12 sub-agents). Each file is one agent's final report captured verbatim (only process
narration removed) with a provenance header. Code citations are `file:line` at the repo state of
2026-07-10 (branch `fix/2605-review`) and may have drifted as the code moved since; external claims
carry a URL and access date. This is a point-in-time record, not current guidance — read the
synthesis document for the conclusions and come here only for the underlying evidence at full
depth.

## Layout

| Doc | Scope |
|---|---|
| `01-realtime-streaming-asr-practices.md` | Consolidated realtime SOTA: whisper_streaming/SimulStreaming/WhisperLiveKit, cache-aware transducers, endpointing, diarization, transport, latency targets |
| `02-sota-asr-engines-quality.md` | Model/license matrix (Open ASR Leaderboard v4, Omi Medical STT), clinical M-WER/Drug M-WER, biasing, anti-hallucination, timestamps, batch serving |
| `03-native-streaming-models.md` | Native/true-incremental streaming models: NVIDIA cache-aware FastConformer family, Kyutai DSM, Voxtral Realtime; TDT vs RNN-T vs CTC |
| `04-endpointing-finalization.md` | Silero v6/TEN VAD, semantic EOU models, adaptive silence windows, vendor partial/final contracts |
| `05-realtime-diarization.md` | Streaming Sortformer (licenses, DER, latency modes), pyannote 4.x/diart, multitalker joint ASR |
| `06-ambient-clinical-scribes.md` | Dragon Copilot, Abridge, Nabla, Suki, Corti architectures; verification-model pattern; independent accuracy studies |
| `07-browser-audio-transport.md` | AudioWorklet/WASM/COOP-COEP, PCM16 vs Opus, WebCodecs status, WS vs WebRTC, reconnect-with-resume |
| `10-stt-service-internals.md` | Full `apps/stt` map as of 2026-07-10: engines/loaders/cache, streaming session manager, batch service, settings, tests, metrics |
| `11-browser-gateway-audio-path.md` | End-to-end browser-to-gateway map as of 2026-07-10: capture, pipeline wiring, WS client, gateway bridge |
| `12-audio-capture-rnnoise-chain.md` | `packages/room` + `packages/noise-filter` as of 2026-07-10: constraints, AudioContext, RNNoise worklet, mixer |
| `13-silero-vad-integration.md` | `packages/vad` as of 2026-07-10: model/assets, ORT threading, thresholds, event surface |
| `14-local-whisper-and-legacy-ws-client.md` | `packages/stt` as of 2026-07-10: local Whisper worker, capture worklet, legacy WS protocol status |
| `15-sdk-pipeline-store-live-transcript-ui.md` | `@arcaai/vox` wiring as of 2026-07-10: `audio.start` trace, `SttWebSocketClient`, store flow |
| `16-gateway-redis-streaming-bridge.md` | `SttWsGateway` + `StreamingAudioBridgeService` as of 2026-07-10: ticket auth, XADD/XREADGROUP, heartbeat |
| `17-docs-and-sota-ticket-review.md` | Architecture-docs vs code (as of 2026-07-10), a 16-ticket SOTA track review, prior research |
| `18-ticket-deep-dive-454-461-464-470-471.md` | Deep dive of specific tickets as they stood 2026-07-10 |
| `19-spot-check-internal-api-key-auth.md` | `X-Internal-Service-Key` header handling as of 2026-07-10 |

## Related

- [`../stt-realtime-batch-sota-assessment-2026-07.md`](../stt-realtime-batch-sota-assessment-2026-07.md) — the synthesis this material backs
- [`../whisper-onnx-apple-silicon-best-practices.md`](../whisper-onnx-apple-silicon-best-practices.md), [`../whisper-onnx-optimum-inference-optimization-2025.md`](../whisper-onnx-optimum-inference-optimization-2025.md) — prior batch/offline Whisper tuning research in this same directory
- [`../../../../.claude/rules/06-python-services.md`](../../../../.claude/rules/06-python-services.md) — `apps/stt` as actually implemented today
- Raw session transcripts and fetched source PDFs remain outside the repo, under `~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/277917b1-c566-4111-99f3-e2cfa2fea765/{subagents,tool-results}/`
