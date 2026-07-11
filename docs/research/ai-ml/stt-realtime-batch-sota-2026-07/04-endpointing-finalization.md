> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `general-purpose` `a6de0410b85665d7c` (sub-agent of 01). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Streaming STT Endpointing, Turn Detection & Partial/Final Contracts — State of the Art (verified 2026-07-10)

Scope note: your pipeline (self-hosted Whisper-class + LocalAgreement + Silero VAD, planning "semantic endpointing" + "tentative-tail rendering") maps cleanly onto the 2025–2026 industry consensus: **VAD is only the silence trigger; a semantic/acoustic turn model gates the actual endpoint; partials are a revisable tail over an immutable committed prefix.** Details, sources, and a proposed contract below.

---

## 1. VAD-based endpointing

### Silero VAD — yes, v5 AND v6 exist; v6 is current
- **v6.0** shipped **Aug 2025**: "16% fewer errors on noisy real-life data, 11% fewer on multi-domain validation" vs v5; retrained for robustness; added a C++/libtorch implementation, a published quality comparison **against TEN VAD**, and **removed the `hop_size_ratio` parameter**. Remaining weak spots called out: music with voice-like instruments, very high-pitched/cartoon/small-child voices. ([release notes](https://github.com/snakers4/silero-vad/releases/tag/v6.0), accessed 2026-07-10)
- **v6.2** (Dec 2025) added ONNX/tinygrad 16k model variants; **v6.2.1** (Feb 24 2026) made **`onnxruntime` an optional dependency** — you now `pip install onnxruntime` (CPU) or `onnxruntime-gpu` explicitly. ([releases](https://github.com/snakers4/silero-vad/releases), accessed 2026-07-10)
- **License MIT, JIT model ~2 MB, 8 kHz + 16 kHz, per-frame speech probability output.** ([repo](https://github.com/snakers4/silero-vad), accessed 2026-07-10)

**Frame size — an important correction to "30 ms":** Since **v5**, Silero is **fixed to 512-sample chunks at 16 kHz = exactly 32 ms** (256 samples / 32 ms at 8 kHz). The multi-window flexibility of v4 (256/512/768/1024/1536) was removed; feeding anything other than the trained window degrades it. The **30 ms** figure in your notes is (a) WebRTC VAD's frame size and (b) Silero's default `speech_pad_ms` — **not** Silero's inference window. Feed it 512-sample/32 ms frames. ([v5 user guide, ricky0123/vad](https://github.com/ricky0123/vad/blob/master/docs/user-guide/silero-v5.md); [discussion #443](https://github.com/snakers4/silero-vad/discussions/443), accessed 2026-07-10)

**Canonical tuning defaults** (`get_speech_timestamps` / `VADIterator`, stable across v4–v6): `threshold=0.5` (probability to activate; `neg_threshold ≈ threshold−0.15` to deactivate), `min_silence_duration_ms=100`, `speech_pad_ms=30`, `min_speech_duration_ms=250`. ([confirmed for threshold/min_silence/speech_pad via Stackademic + repo docs](https://blog.stackademic.com/silero-vad-the-lightweight-high-precision-voice-activity-detector-26889a862636); accessed 2026-07-10). *Flag: `min_speech_duration_ms=250` is the well-known library default but was not re-confirmed on a primary page in this pass.*
For **endpointing**, do NOT rely on Silero's `min_silence_duration_ms` as your turn timeout — that's a within-VAD segmenter. Use VAD only to detect "silence has begun," then hand off to a semantic timeout (§3).

### VAD alternatives
| VAD | Frame/hop | Size / cost | Notes | Source |
|---|---|---|---|---|
| **WebRTC VAD** | 10/20/30 ms | tiny, energy-GMM | Legacy; fast but noisy, no ML robustness; still fine as a cheap gate | (industry baseline) |
| **TEN VAD** | 160/256 samples = **10/16 ms** hop @16 kHz | 277 KB–731 KB, Apache-2.0 (+BSD LPCNet) | **Beats Silero on precision AND latency**; detects short inter-speech silences Silero misses; Silero has a "several-hundred-ms" transition delay TEN avoids; per-frame prob; Python/C/Java/Go/JS, WASM | [TEN-framework/ten-vad](https://github.com/TEN-framework/ten-vad) (accessed 2026-07-10) |
| **NVIDIA NeMo Frame-VAD Multilingual MarbleNet v2.0** | **20 ms** frames | 91.5 K params, GPU-oriented | 1D time-channel-separable CNN; noise/volume-augmented training; 8× less GPU mem than segment-VAD; multilingual | [HF card](https://huggingface.co/nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0) (accessed 2026-07-10) |

**Recommendation for a latency-sensitive clinical pipeline:** TEN VAD's shorter transition latency + short-silence sensitivity is materially better for barge-in and tight endpointing than Silero; but Silero v6's noise-robustness and MIT license remain strong. Either is fine as the *trigger*; the endpoint decision should not live in the VAD.

---

## 2. Semantic / end-of-utterance (EOU) turn-detection models — the 2025–2026 wave

The field moved decisively from **transcript-only transformers (2024)** to **audio-native (or fused audio+semantic) EOU models (2025–2026)** that predict "the human is done and expects a reply" without waiting on ASR.

### LiveKit Turn Detector v1 / v1-mini (open-ish, self-hostable mini)
- **Announced 2026-06-17**; plugin published 2026-06-24; `v1-mini` bundled in Agents SDK **Python 1.6.1 / TypeScript 1.4.7**. ([LiveKit blog](https://livekit.com/blog/solving-end-of-turn-detection); [PyPI](https://pypi.org/project/livekit-plugins-turn-detector/), accessed 2026-07-10)
- **Architecture: dual-branch, audio-native.** A semantic branch = audio encoder → learned adapter → **fine-tuned LLM backbone (Qwen2.5-0.5B-Instruct)**; a separate acoustic branch (recurrent) captures timing/prosody; a fusion module emits EOU **with no transcription step**. `v1-mini` = same architecture, **quantized + pruned LLM** for CPU. Model files under LiveKit Model License; SDK code Apache-2.0. ([blog](https://livekit.com/blog/solving-end-of-turn-detection); [HF](https://huggingface.co/livekit/turn-detector), accessed 2026-07-10)
- **14 languages** (English + 13). Benchmarks (their framing): at a **300 ms** latency budget, **9.9% false-cutoff vs Deepgram Flux 12.9%**; at 600 ms, 4.5% vs 5.5–9.9%.
- **History:** LiveKit shipped a **transcript-based** transformer EOU model in **2024**; v1 keeps that LLM backbone for semantics but adds audio encoders → audio-native. This is the key generational shift.

### Pipecat / Daily "Smart Turn" (fully open: weights + data + training)
- **smart-turn v3** (Sept 2025): first version small/fast enough for **CPU — 12 ms on modern CPUs, ~60 ms on a low-cost AWS instance**; **8 MB quantized (CPU) / 32 MB unquantized (GPU)**; native-audio, open weights/data/training script. ([Daily blog](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/); [HF](https://huggingface.co/pipecat-ai/smart-turn-v3); [kwindla/X](https://x.com/kwindla/status/1966359269080707363), accessed 2026-07-10)
- **v3.1** and **v3.2** followed: v3.2 = **+40% accuracy on short utterances** and better background-noise handling. ([v3.2 blog](https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/), accessed 2026-07-10). *No public "v3.3/v4" as of 2026-07-10.*
- Strongest fit for a **self-hosted, permissively-licensed** clinical stack that wants audio-native EOU on CPU.

### Kyutai semantic VAD (inside Kyutai STT, Delayed-Streams-Modeling)
- The **~1B en/fr** STT model ships a **semantic VAD** with a **0.5 s delay**; the 2.6B en model has 2.5 s delay. ([kyutai.org/stt](https://kyutai.org/stt/); [DSM repo](https://github.com/kyutai-labs/delayed-streams-modeling), accessed 2026-07-10)
- **How it predicts end-of-turn:** the VAD has **multiple prediction heads**, each estimating "has a pause of length L occurred," for **L ∈ {0.5, 1.0, 2.0, 3.0 s}**. The app selects which head = a tunable "patience" dial. It streams and returns **word-level timestamps**, so EOU + transcript come from one model. ([DSM issue #86](https://github.com/kyutai-labs/delayed-streams-modeling/issues/86), accessed 2026-07-10)

### TEN Turn Detection (transcript/semantic, EN+ZH)
- **Text-based on Qwen2.5-7B**; classifies user text into **three states: `finished` / `unfinished` / `wait`** (wait = explicit "stop"). EN+ZH, open source, pairs with TEN VAD; bilingual open test set. ([theten.ai docs](https://theten.ai/docs/ten_turn_detection); [GitHub](https://github.com/ten-framework/ten-turn-detection), accessed 2026-07-10). Heavier (7B) and transcript-dependent — but if you already have a LocalAgreement transcript, a text EOU can reuse it cheaply. The 3-state `unfinished` label (hold, don't respond) is a design worth copying.

### Krisp VIVA turn-taking (commercial SDK)
- **Audio-only, ~6M weights.** **Turn Prediction v2** (Nov 2025) → **v3** (May 2026, **multilingual**, part of VIVA 2.0), plus a first-of-kind **Interrupt Prediction v1** (predicts user intent to interrupt the agent). ([Krisp v2 blog](https://krisp.ai/blog/krisp-turn-taking-v2-voice-ai-viva-sdk/); [VIVA 2.0 coverage](https://techintelpro.com/news/ai/agentic-ai/krisp-launches-viva-20-voice-infrastructure-for-ai-agents), accessed 2026-07-10). *Flag: architecture details are limited (commercial); not self-hostable open weights.*

**Research corroboration** (arXiv, 2025–2026): "Easy Turn" (acoustic+linguistic fusion, [2509.23938](https://arxiv.org/html/2509.23938v1)), Voice Activity Projection multilingual turn-taking ([2403.06487](https://arxiv.org/pdf/2403.06487)), Prompt-Guided Turn-Taking ([2506.21191](https://arxiv.org/pdf/2506.21191)), and a Thai semantic-EOU paper ([2510.04016](https://arxiv.org/pdf/2510.04016)) — all confirm fused acoustic+semantic EOU as the 2026 direction.

---

## 3. Adaptive / dynamic silence timeouts

The universal 2026 pattern: **VAD detects silence onset → a turn model scores P(end-of-turn) → the endpoint delay is chosen within a [min, max] window** — short when confident the utterance is complete, long (up to a hard acoustic cap) when it looks mid-sentence.

- **LiveKit** exposes exactly this. Endpointing-delay defaults: **without** the audio turn detector `min_delay=0.5 s / max_delay=3.0 s`; **with** it `min_delay=0.3 s / max_delay=2.5 s` ("the model provides a confident EOU signal, so the session commits sooner"). Per-language `unlikely_threshold` calibrates how confident it must be. VAD provides the silence trigger; the model gates commit within the window. ([LiveKit turn-detector docs](https://docs.livekit.io/agents/build/turns/turn-detector/), accessed 2026-07-10). *Flag: the exact confidence→delay mapping is proprietary/undocumented; only the min/max defaults and "dynamic endpointing uses session pause statistics" are public.*
- **Deepgram Flux** = confidence + hard timeout: `eot_threshold` **0.7** (range 0.5–0.9) fires `EndOfTurn`; `eager_eot_threshold` (0.3–0.9, **off by default**, must be ≤ `eot_threshold`) fires a speculative `EagerEndOfTurn`; `eot_timeout_ms` **5000** (500–10 000) **forces** EndOfTurn on silence regardless of confidence, **timer resets on new speech**. ([Flux config](https://developers.deepgram.com/docs/flux/configuration), accessed 2026-07-10)
- **AssemblyAI Universal-3 Pro** = mode-driven min-silence + confidence + acoustic hard cap: `min_turn_silence` per mode (**128 ms** min_latency / **224 ms** balanced / **800 ms** max_accuracy), `max_turn_silence` **1536 ms** (acoustic force-end), `vad_threshold` **0.2**, `interruption_delay` (0/500 ms). ([U3 Pro turn-detection doc](https://www.assemblyai.com/docs/streaming/universal-3-pro/turn-detection-and-partials), accessed 2026-07-10)
- **OpenAI semantic_vad** = eagerness dial: `low` (wait longer / more patience) → `high` (respond ASAP); `auto`≈`medium`. Low P(done) → wait for timeout; high → no wait. ([OpenAI Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad), accessed 2026-07-10)
- **Kyutai** = pick-a-head: choose the 0.5/1/2/3 s pause head as your patience threshold.

**Clinical implication:** doctor dictation/consults have *long deliberate pauses* (thinking, reading, enumerated lists) and *cost asymmetry* — cutting off loses a drug name or dose. Bias toward **not** cutting off: higher EOU threshold, longer `max_delay` (e.g., 2.5–3.5 s hard cap), and a "hold" state (à la TEN's `unfinished`) for trailing conjunctions/numbers. Use the semantic model to *shorten* delay only on high-confidence complete sentences.

---

## 4. Partial / final contract of leading streaming ASR APIs

Two philosophies now coexist, sometimes within one vendor:
- **Revisable-tail** (classic): mutable partials → finalized chunks (immutable prefix + revised tail). *Deepgram Nova, Google, Azure, AssemblyAI Universal-Streaming (word-level), OpenAI.*
- **Turn-native**: no per-word interims; the unit is a turn/utterance with model-integrated EOU. *Deepgram Flux, AssemblyAI Universal-3 Pro (segment-level).*

| Vendor / model | Partial (revisable) event | Final / commit event | Turn / endpoint signal | Force-finalize | Notable fields | Source (accessed 2026-07-10) |
|---|---|---|---|---|---|---|
| **Deepgram Nova (classic streaming)** | `Results` msg, `is_final:false` (~every 1 s) | `Results`, `is_final:true` (accuracy-maxed chunk, immutable) | `speech_final:true` (endpointing silence, **default 10 ms**); separate **`UtteranceEnd`** event via `utterance_end_ms` (≥1000 ms, word-gap based) | **`{"type":"Finalize"}`** control msg flushes buffered audio | word `start/end/confidence`, channels, `KeepAlive`, `CloseStream` | [endpointing](https://developers.deepgram.com/docs/endpointing) · [utterance-end](https://developers.deepgram.com/docs/utterance-end) |
| **Deepgram Flux (turn-native)** | `Update` (~every 250 ms), `StartOfTurn` | **`EndOfTurn`** (transcript == preceding EagerEndOfTurn) | **model-integrated**: `EagerEndOfTurn` (speculative) + `EndOfTurn` + `TurnResumed`; `end_of_turn_confidence` | `eot_timeout_ms` hard cap (5 s) | `turn_index`, `audio_window_start/end`, `words[]`, `eot_threshold`/`eager_eot_threshold` | [state machine](https://developers.deepgram.com/docs/flux/state) · [config](https://developers.deepgram.com/docs/flux/configuration) |
| **AssemblyAI Universal-Streaming (2025, immutable)** | `Turn`, `end_of_turn:false`; words carry `word_is_final` (**committed words immutable**, tail revised) | `end_of_turn:true`; then `turn_is_formatted:true` after formatting pass | neural **`end_of_turn`** + `end_of_turn_confidence`; `end_of_turn_confidence_threshold`, `min_end_of_turn_silence_when_confident`, `max_turn_silence` | **`ForceEndpoint`**; `Terminate` | `turn_order`, ~307 ms P50, $0.15/hr | [intro blog](https://www.assemblyai.com/blog/introducing-universal-streaming) · [turn-detection](https://www.assemblyai.com/docs/streaming/universal-streaming/turn-detection) |
| **AssemblyAI Universal-3 Pro (2026, revisable)** | `Turn`, `end_of_turn:false`; **whole-turn re-transcribe → each msg supersedes prior (replace, not append)**; all words `word_is_final:false`; first partial after ~750 ms speech | `end_of_turn:true` (formatted, punctuation/entities) | `min_turn_silence` (mode 128/224/800 ms), `max_turn_silence` 1536 ms, `vad_threshold` 0.2, `interruption_delay` | `ForceEndpoint` | modes `min_latency`/`balanced`/`max_accuracy`; `words[]` text/start/end/confidence/word_is_final | [U3 Pro turn-detection](https://www.assemblyai.com/docs/streaming/universal-3-pro/turn-detection-and-partials) |
| **Google Cloud STT V2** | results `is_final:false`, with **two-tier stability** (high-stability head + low-stability tail) | results `is_final:true` | **`voice_activity_events`**: `SPEECH_ACTIVITY_BEGIN`/`_END`; `voice_activity_timeout`; endpointer sensitivity `ENDPOINTING_SENSITIVITY_*`; V1 `single_utterance` | close the write stream | `stability` score, Chirp 3 model | [v2 rpc ref](https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2) · [voice-activity-events](https://docs.cloud.google.com/speech-to-text/docs/voice-activity-events) |
| **Azure Speech** | **`Recognizing`** events (revisable) | **`Recognized`** events (immutable segment) | `Speech_SegmentationSilenceTimeoutMs`, `Speech_SegmentationMaximumTimeMs`, **`Speech_SegmentationStrategy="Semantic"`** (ends on sentence punctuation .?!), `InitialSilenceTimeout` | `StopContinuousRecognitionAsync` | semantic segmentation → sentence-complete finals | [how-to-recognize-speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech) |
| **OpenAI Realtime / gpt-4o-transcribe** | `conversation.item.input_audio_transcription.delta` | `…input_audio_transcription.completed` | `input_audio_buffer.speech_started` / `speech_stopped` / `committed`; **`server_vad`** (`threshold`, `prefix_padding_ms`, `silence_duration_ms`) or **`semantic_vad`** (`eagerness` low/med/high/auto) | `input_audio_buffer.commit` (manual) | `create_response`/`interrupt_response`; models incl. `gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`, `gpt-realtime-whisper` | [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) · [server events](https://developers.openai.com/api/reference/resources/realtime/server-events) |

Key semantic notes:
- **Deepgram `is_final` ≠ `speech_final`.** `is_final` = "this chunk is accuracy-maxed, won't be revised" (can fire multiple times per utterance); `speech_final` = "endpointing detected a pause, utterance done." Concatenate `is_final:true` segments until `speech_final:true`. ([end-of-speech doc](https://developers.deepgram.com/docs/understanding-end-of-speech-detection), accessed 2026-07-10)
- **AssemblyAI reversed itself on immutability.** 2025 Universal-Streaming marketed **immutable word-level** partials ("~307 ms, every character final, never changes"). 2026 **Universal-3 Pro** moved to **segment-level revisable** partials (each Turn message re-transcribes the full turn and *supersedes* the prior — you replace rendered text, not append), trading immutability for accuracy-with-full-context. *Flag: docs show both "Universal-3 Pro" and "Universal-3.5 Pro" naming; 3.5 Pro appears to be a point update. Defaults above are from the 3.x Pro doc.*
- **Deepgram Flux** GA'd **Flux Multilingual on 2026-04-29 (10 languages, dynamic in-conversation switching)**; English-only at first launch; p50 EOU ~500 ms, p95/p99 ~1–1.5 s; matches Nova-3 accuracy but fuses VAD+EOU into the model. ([Flux Multilingual PR](https://deepgram.com/learn/introducing-flux-multilingual); [intro](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition), accessed 2026-07-10). *Flag: standard Flux pricing not publicly disclosed beyond the launch promo.*

---

## 5. Synthesis — proposed 2026 partial/final WebSocket contract for a self-hosted clinical STT

Design principle: **separate the three concerns the industry now separates** — (a) revisable hypothesis, (b) immutable committed text, (c) turn/endpoint decision — and make the endpoint's *reason and confidence* explicit. This is exactly what LocalAgreement + a semantic EOU layer produces; expose it rather than collapsing it into one "final."

**Server → client messages**
1. **`ready`** — `{ session_id, model, language, sample_rate, features[] }`. Handshake/ack.
2. **`speech_started`** — `{ audio_ts_ms }`. VAD onset (barge-in / UI "listening"). (≈ Google `SPEECH_ACTIVITY_BEGIN`, OpenAI `speech_started`.)
3. **`partial`** (the **tentative tail**) — `{ utterance_index, tail_text, words[]{text,start,end,conf}, stability }`. Revisable; render greyed/italic. Carry a **`stability`** score (Google-style) so the UI can hold jittery low-stability words.
4. **`commit`** (the **immutable prefix advance**) — `{ utterance_index, text, words[]{text,start,end,conf}, committed_through_ms }`. LocalAgreement's agreed prefix; **never revised**. Clients append; this is your audit-safe transcript.
5. **`endpoint`** (turn boundary) — `{ utterance_index, reason: "semantic"|"silence"|"max_timeout"|"forced", end_of_turn_confidence, trailing_silence_ms }`. The single most valuable field others bury: **why** the turn ended and **how confident**. Distinguish semantic completion from a mere silence/timeout cutoff.
6. **`final`** (formatted turn) — `{ utterance_index, text, words[], duration_ms, speaker?, is_formatted:true }`. Post-endpoint, punctuated/normalized (numbers, units, drug names), optional speaker tag. Analogous to AssemblyAI `turn_is_formatted`/Azure `Recognized`.
7. **`hold`** *(optional, clinical-valuable)* — `{ utterance_index, p_incomplete }`. Explicit "user paused but likely continuing" (TEN's `unfinished`) so downstream (LLM summarizer) does **not** fire on mid-sentence pauses.
8. **`error` / `warning`** — `{ code, message, recoverable }`.
9. **`metrics`** *(optional)* — `{ p50_partial_ms, endpoint_latency_ms, rtf }` for observability.

**Client → server control**
10. **`finalize` / flush** — force an immediate `endpoint(reason:"forced")` + `final` (Deepgram `Finalize` / AssemblyAI `ForceEndpoint`). Essential for "stop dictation" buttons.
11. **`configure`** — live-tune `{ eot_threshold, min_delay_ms, max_delay_ms, vad_threshold, formatting }` (mode presets like AssemblyAI `min_latency|balanced|max_accuracy`).
12. **`keepalive` / `close`** — connection hygiene; audio frames as binary with a monotonic `audio_ts_ms` to enable resume (Redis-stream-id style, matching your existing streaming transport).

**Field-level must-haves** across the above: monotonic **audio timestamps** on every message (resume/replay), **word `is_final` flag** (immutable vs tail), **`end_of_turn_confidence`** on endpoints, **explicit endpoint `reason`**, **`stability`** on partials, **`utterance_index`/`turn_order`** to correlate partial→commit→final, and optional **speaker tag** (consults are 2-party).

**Concrete recommendations for HOPE's clinical pipeline**
- Keep VAD as the *trigger only*; add a **semantic EOU gate**. Best self-hostable open options: **Pipecat smart-turn v3.2** (audio-native, CPU 12–60 ms, fully open weights/data — cleanest license story) or **LiveKit turn-detector v1-mini** (open weights, CPU, 14 langs). If you adopt Kyutai STT, its **multi-head semantic VAD** gives EOU + transcript in one model. Since you already produce a LocalAgreement transcript, a **transcript-based EOU** (TEN-style 3-state) is a low-cost add that reuses it.
- **Adaptive endpointing window:** VAD silence onset → EOU score → delay in **[min 0.3–0.5 s, max 2.5–3.5 s]** with a hard acoustic cap; bias longer than voice-agent defaults because clinical cutoff cost is high. Emit `hold` on trailing conjunctions/numbers.
- **Partial/final:** emit revisable `partial` (tentative tail) + immutable `commit` + `endpoint{reason,confidence}` + formatted `final`; support `finalize`. This is a superset of every vendor above and matches your LocalAgreement architecture 1:1.

---

### Unverifiable / flagged items
- LiveKit's exact confidence→delay algorithm is **proprietary** (only min/max defaults + "session pause statistics" are documented).
- Deepgram **Flux standard pricing** not publicly disclosed (only launch promo); Flux benchmark numbers are LiveKit's framing of a competitor.
- AssemblyAI **version naming** ("Universal-3 Pro" vs "Universal-3.5 Pro") is inconsistent across current docs; treated as same 3.x-Pro generation.
- Silero **`min_speech_duration_ms=250`** is the standard library default but wasn't re-confirmed on a primary page this pass (threshold 0.5 / min_silence 100 / speech_pad 30 were confirmed).
- Deepgram **`Finalize`** control message is documented for **classic** streaming; Flux's forced path is `eot_timeout_ms`, not a Finalize message.
- Krisp VIVA turn-taking internals are commercial/limited-disclosure (audio-only, ~6M weights confirmed; deeper architecture not public).
