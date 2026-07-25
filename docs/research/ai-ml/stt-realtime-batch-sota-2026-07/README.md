# STT Realtime + Batch SOTA (2026-07) — Captured Research & Codebase Maps

Complete source material behind [`../stt-realtime-batch-sota-assessment-2026-07.md`](../stt-realtime-batch-sota-assessment-2026-07.md) (the synthesis/report). Produced 2026-07-10 by a 17-agent research/mapping fleet (session `277917b1-c566-4111-99f3-e2cfa2fea765`): 5 top-level agents, 12 sub-agents. Each file is one agent's **final report captured verbatim** (only process narration removed) with a provenance header. Code citations are `file:line` at the repo state of 2026-07-10 (branch `fix/2605-review`) and may drift as the code moves; external claims carry URL + access date.

**Reading guide:** start with the synthesis. Come here when you need the underlying evidence at full depth — e.g. the complete stt parameter inventory (10), the exact wire/teardown traces (11, 15, 16), or the full model/license matrices (01–03).

## 01–07 · External deep research (primary web sources)

| Doc | Scope | Feeds synthesis |
|---|---|---|
| [01-realtime-streaming-asr-practices.md](./01-realtime-streaming-asr-practices.md) | Consolidated realtime SOTA: whisper_streaming/SimulStreaming/WhisperLiveKit, cache-aware transducers, endpointing, diarization, transport, latency targets, reference architecture, validation of the five planned bets | §3, §6 |
| [02-sota-asr-engines-quality.md](./02-sota-asr-engines-quality.md) | Model/license matrix (Open ASR Leaderboard v4, Omi Medical STT), clinical M-WER/Drug M-WER, biasing, anti-hallucination, timestamps, batch serving, eval methodology | §4, §5, §6 |
| [03-native-streaming-models.md](./03-native-streaming-models.md) | Native/true-incremental streaming models: NVIDIA cache-aware FastConformer family, Kyutai DSM, Voxtral Realtime; TDT vs RNN-T vs CTC; pilot candidates | §3.1 |
| [04-endpointing-finalization.md](./04-endpointing-finalization.md) | Silero v6/TEN VAD, semantic EOU models (smart-turn, LiveKit, Kyutai, TEN), adaptive silence windows, vendor partial/final contracts, proposed WS contract | §3.4, §3.8 |
| [05-realtime-diarization.md](./05-realtime-diarization.md) | Streaming Sortformer (licenses, DER, latency modes), pyannote 4.x/diart, multitalker joint ASR, stereo channel separation, 2-speaker practice | §3.5 |
| [06-ambient-clinical-scribes.md](./06-ambient-clinical-scribes.md) | Dragon Copilot, Abridge, Nabla, Suki, Corti architectures; verification-model pattern; independent accuracy studies (NEJM AI RCT, Mayo/OHSU) | §5.4 |
| [07-browser-audio-transport.md](./07-browser-audio-transport.md) | AudioWorklet/WASM/COOP-COEP, PCM16 vs Opus, WebCodecs baseline status, WS vs WebRTC, reconnect-with-resume patterns, **NS-hurts-ASR evidence** | §3.2, §3.7 |

## 10–19 · Codebase maps & spot checks (read-only)

| Doc | Scope | Feeds synthesis |
|---|---|---|
| [10-stt-service-internals.md](./10-stt-service-internals.md) | Full `apps/stt` map: engines/loaders/cache, streaming session manager, batch service, VAD/diarization/punctuation, settings table, tests, metrics, tech-debt register | §2.2–2.5, §7.1 |
| [11-browser-gateway-audio-path.md](./11-browser-gateway-audio-path.md) | End-to-end browser→gateway map: capture, pipeline wiring, WS client, gateway bridge, `0040fe3e` analysis, audio-format contract, weaknesses register | §2.1, §3.3, §7.2–7.3 |
| [12-audio-capture-rnnoise-chain.md](./12-audio-capture-rnnoise-chain.md) | `packages/room` + `packages/noise-filter`: getUserMedia constraints, AudioContext/48 kHz, RNNoise worklet/frames/ring, bypass conditions, mixer | §2.1, §3.2, §7.2 |
| [13-silero-vad-integration.md](./13-silero-vad-integration.md) | `packages/vad`: model/assets/CDN, ORT threading, threshold constants + production overrides, frame sizes, event surface, downstream gating | §2.1, §3.4, §7.2 |
| [14-local-whisper-and-legacy-ws-client.md](./14-local-whisper-and-legacy-ws-client.md) | `packages/stt`: local Whisper worker/engines/buffering/resampler, capture worklet, provider selection, legacy WS protocol island status | §2.4, §7.2 |
| [15-sdk-pipeline-store-live-transcript-ui.md](./15-sdk-pipeline-store-live-transcript-ui.md) | `@arcaai/vox` wiring: `audio.start` trace, `SttWebSocketClient` protocol/backoff/backpressure, stop-teardown race, store flow, tentative-tail render reachability | §2.1, §3.3, §3.6, §3.7 |
| [16-gateway-redis-streaming-bridge.md](./16-gateway-redis-streaming-bridge.md) | `SttWsGateway` + `StreamingAudioBridgeService`: ticket auth, XADD/XREADGROUP details, `0040fe3e` diff, heartbeat absence, internal callback auth | §2.1, §7.3 |
| [17-docs-and-sota-ticket-review.md](./17-docs-and-sota-ticket-review.md) | Architecture-docs vs code, 16-ticket SOTA track review (451–487), already-decided register, self-acknowledged open gaps, prior ai-ml research docs | §1, §7.4 |
| [18-ticket-deep-dive-454-461-464-470-471.md](./18-ticket-deep-dive-454-461-464-470-471.md) | Verbatim-quoted deep dive of the drop-visibility/reconnect/scorecard/tentative-tail tickets incl. the TASK-484 change-history entry | §1, §2.5 |
| [19-spot-check-internal-api-key-auth.md](./19-spot-check-internal-api-key-auth.md) | `X-Internal-Service-Key` header handling in `ApiKeyService`/`UnifiedAuthGuard` | §7.3 |

## Provenance

- Fleet: 5 top-level agents (01, 02, 10, 11, 17) spawned 12 children (03–07 under 01; 12–16 + 18 under 11; 19 at depth 3 under 16).
- Raw session transcripts and fetched source PDFs remain outside the repo under `~/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/277917b1-c566-4111-99f3-e2cfa2fea765/{subagents,tool-results}/`.
- Related prior research in this directory: [whisper-onnx-apple-silicon-best-practices.md](../whisper-onnx-apple-silicon-best-practices.md), [whisper-onnx-optimum-inference-optimization-2025.md](../whisper-onnx-optimum-inference-optimization-2025.md) (batch/offline Whisper tuning — still valid; superseded on model choice by this set).
