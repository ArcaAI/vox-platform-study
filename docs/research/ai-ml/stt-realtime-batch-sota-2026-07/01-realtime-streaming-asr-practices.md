> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `researcher` `a043b3c584cf591a7` (top-level; consolidates its five sub-researchers, captured individually as 03–07). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Reference report: mid-2026 state of the art for real-time streaming ASR (self-hosted clinical STT)

*Compiled 2026-07-10. Every claim carries an inline source + date; primary sources (GitHub/HF/arXiv/vendor docs) preferred. Unverifiable items flagged in the final section. Bottom line up front: your five planned bets are directionally correct, but two of them (LocalAgreement-2 as the default engine, and RNNoise on the ASR path) are the weakest links — the 2025–2026 evidence has moved past both.*

---

## 1. Streaming architectures for Whisper-class (encoder-decoder) models

**`whisper_streaming` / LocalAgreement-2 (UFAL) — works, but its own authors have deprecated it.** The original tool ([github.com/ufal/whisper_streaming](https://github.com/ufal/whisper_streaming); paper ["Turning Whisper into Real-Time Transcription System", arXiv:2307.14743, 2023-09-21](https://arxiv.org/html/2307.14743v2)) confirms a **3.3 s computationally-aware latency** on unsegmented English (ESIC dev set, 1 s MinChunkSize, VAD off), with only **0.2% absolute WER loss vs offline on English (8.1% vs 7.9%)** but **~2% on German and ~6% on Czech**. LocalAgreement-2 = "output the longest common prefix of two consecutive chunk hypotheses"; buffer is trimmed at sentence-ending punctuation, capped ~30 s. **Critically, the README now states: "In 2025, WhisperStreaming is becoming outdated, replaced by SimulStreaming"** ([README, accessed 2026-07-10](https://github.com/ufal/whisper_streaming/blob/main/README.md)). Backends: faster-whisper, whisper-timestamped, OpenAI API, MLX.

**SimulStreaming / AlignAtt (UFAL, 2025) — the direct successor, ~5× faster.** ([github.com/ufal/SimulStreaming](https://github.com/ufal/SimulStreaming), released **2025-10-22**). AlignAtt is an attention-guided policy: it uses encoder-decoder cross-attention to detect which audio frame is being decoded, and stops decoding when attention reaches a "dangerous zone" near the buffer end (`--frame-threshold`, where **1 frame = 0.02 s for large-v3**). Origin paper: Papi et al., ["AlignAtt", INTERSPEECH 2023, arXiv:2305.11408](https://arxiv.org/abs/2305.11408) — +2 BLEU and 0.5–0.8 s latency reduction vs prior policies on MuST-C. SimulStreaming **won the IWSLT 2025 Simultaneous Speech Translation shared task** ([elitr.eu/iwslt25](https://elitr.eu/iwslt25/)) and is **~5× faster than WhisperStreaming**. It merges Simul-Whisper (["Attention-Guided Streaming Whisper with Truncation Detection", INTERSPEECH 2024, arXiv:2406.10052](https://arxiv.org/pdf/2406.10052); repo **Apache-2.0**) + whisper_streaming (MIT), adds **beam search + in-domain terminology prompt injection + context carryover across 30 s windows**. ⚠️ **Licensing flag (see §Unverifiable):** the README states "Licence MIT," and both upstreams are permissive, but one scrape surfaced a "Noncommercial version 2025-10-22" note — **verify the LICENSE file directly before commercial clinical use.**

**`WhisperLiveKit` — the de-facto open reference integration (verify this before building your own).** ([github.com/QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit), **Apache-2.0, v0.2.23 dated 2026-07-09, 10.5k stars**). It ties together everything your plan needs: **SimulStreaming/AlignAtt as default** (`--frame-threshold` default **25 frames ≈ 0.5 s**, `--audio-max-len 30`), LocalAgreement as an option, backends (faster-whisper, MLX, vanilla, **Voxtral-Mini-4B**, **Qwen3-ASR streaming**), **Streaming Sortformer diarization** (`--diarization-backend sortformer`) or diart, **dual VAD+VAC**, a **full-state (default) vs experimental snapshot/diff WebSocket protocol**, and **Deepgram/OpenAI-compatible WS endpoints** for drop-in use.

**Other Whisper wrappers:** `WhisperLive` (Collabora — faster-whisper/TensorRT/OpenVINO backends, WebSocket) ([github.com/collabora/WhisperLive](https://github.com/collabora/WhisperLive)); `Lightning-SimulWhisper` (Apple-silicon MLX/CoreML, **~15× speedup, runs large-v3-turbo real-time on an M2**) ([github.com/altalt-org/Lightning-SimulWhisper](https://github.com/altalt-org/Lightning-SimulWhisper)); WhisperX (offline forced-alignment for word timestamps, arXiv:2303.00747).

**Chunking + prompt-carryover best practice.** `condition_on_previous_text=True` drives Whisper into **self-reinforcing hallucination/repetition loops in streaming** ([whisper.cpp #3744](https://github.com/ggml-org/whisper.cpp/issues/3744); [transformers #21467](https://github.com/huggingface/transformers/issues/21467), accessed 2026-07-10). Best practice: **selective/limited context carry**, **VAD-based segmentation** (external boundaries, not decoder timestamps), and **do not carry text across distant speech islands**. SimulStreaming's approach (prompt only for terminology + bounded 30 s context) is the safer pattern. `whisper-large-v3-turbo` (809M, 4 decoder layers, ~6× faster, Oct 2024) is a good *final-pass* base but is **inherently offline** and still needs a streaming wrapper ([HF turbo card](https://huggingface.co/openai/whisper-large-v3-turbo)).

**Typical achievable latency (Whisper-chunked):** partial ~0.5–1 s (governed by MinChunkSize), **confirmed/final ~2–3.3 s**. A 2026 optimization paper, **WhisperPipe** (["arXiv:2604.25611", 2026-04-28](https://arxiv.org/abs/2604.25611)), reports **median end-to-end 89 ms / p90 142 ms processing latency, WER within 2% of offline, 3–5× lower latency than existing streaming**, using a **hybrid Silero+energy VAD (34% fewer false activations)** and stable memory over 150 min — a useful proof that the Whisper path can be pushed hard, though the headline ms figure is processing latency, not user-perceived commit lag.

---

## 2. Native streaming models (true incremental decoders), self-hostable in mid-2026

This is the biggest shift since your training data. **NVIDIA's cache-aware FastConformer transducer family is now the mainstream self-hostable native-streaming path** — the encoder keeps self-attention + convolution state in a cache and updates it per chunk (no re-encoding of overlap), with a single runtime `att_context_size` knob trading latency for WER.

**The clean CTC-vs-transducer evidence** ([nvidia/stt_en_fastconformer_hybrid_large_streaming_multi, CC-BY-4.0](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi)) — `att_context_size [70,0]=0ms / [70,1]=80ms / [70,6]=480ms / [70,13]=1040ms`:

| Latency | Transducer (RNN-T) WER | CTC WER |
|---|---|---|
| 1040 ms | **5.4%** | 6.2% |
| 480 ms | **5.7%** | 6.7% |
| 80 ms | **6.4%** | 7.8% |
| 0 ms | **7.0%** | 8.4% |

→ **the transducer beats CTC by ~0.8–1.4 pts at every latency** — the accuracy argument for your transducer pilot in one table.

**The 2026 successors (concrete pilot candidates):**
- **`nvidia/parakeet-unified-en-0.6b`** (**2026-04-07**, NVIDIA Open Model) — *one checkpoint that is both offline and cache-aware streaming*. Streaming **8.44% WER @160 ms → 6.14% @2.08 s**; offline **1.63% LS-clean**; latency configs 160/240/320/560/1120/2080 ms ([HF card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b), independently verified). **This single artifact can replace your Whisper-chunked-plus-LocalAgreement stack for both live partials and the high-accuracy final.**
- **`nvidia/nemotron-speech-streaming-en-0.6b`** (**2026-01-05**) — RNN-T, **6.93% @1.12 s → 8.43% @80 ms**, **24 ms median time-to-final**, **560 streams/H100**, ships via **Riva/NIM** ([HF card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)).
- **`nvidia/nemotron-3.5-asr-streaming-0.6b`** (**2026-06-04**, license **OpenMDW-1.1**) — the multilingual generalization, **40 language-locales**, FLEURS avg **8.84% @1.12 s** (ES 4.11%, IT 4.25%, EN 7.91%), **~2,400 streams/H100** ([HF card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b); [MarkTechPost, 2026-06-06](https://www.marktechpost.com/2026/06/06/nvidia-releases-nemotron-3-5-asr-a-600m-parameter-cache-aware-streaming-model-transcribing-40-language-locales-in-real-time/)).

**RNN-T / TDT vs CTC.** CTC is cheapest but its per-frame independence assumption costs ~1 pt WER and needs an external LM. RNN-T is monotonic, streamable, and the accuracy workhorse. **TDT (Token-and-Duration Transducer)** additionally predicts each token's frame duration and *skips frames* — **up to 2.82× faster than RNN-T with better accuracy** and more robust to noisy/agitated speech (Xu et al., ICML 2023, [arXiv:2304.06795](https://arxiv.org/abs/2304.06795); [Speechmatics TDT explainer](https://www.speechmatics.com/company/articles-and-news/token-duration-transducer-tdt-explained)). Practical read: the *streaming* NVIDIA checkpoints ship RNN-T today; the *offline* leaders (`parakeet-tdt-0.6b-v3`, 25 EU langs, Open-ASR 6.34%) ship TDT — pair a cache-aware RNN-T for partials with a TDT model for the final rescore, or just use the unified checkpoint. **Note:** `parakeet-tdt-0.6b-v2/v3` are **offline** models (chunked inference re-encodes) — do not pilot streaming on them.

**Kyutai STT — the strongest non-NVIDIA open option** ("delayed streams modeling", [arXiv:2509.08753](https://arxiv.org/abs/2509.08753); [kyutai.org/stt](https://kyutai.org/stt/)). Decoder-only LM over the Mimi codec: **`stt-1b-en_fr`** (0.5 s delay, **built-in semantic VAD**, EN+FR) and **`stt-2.6b-en`** (2.5 s delay, mean **6.4% WER** HF Open-ASR). **Weights CC-BY-4.0**, production **Rust WebSocket server**, MLX (runs on iPhone 16 Pro), **400 streams/H100**. Its semantic VAD (predicts end-of-utterance from content + prosody) could *replace* a separate turn-detector.

**Other 2026 open releases.** **Mistral Voxtral-Mini-4B-Realtime-2602** (Feb 2026, **Apache-2.0** — the most permissive) — speech-LLM with a 970M *causal* audio encoder, 80 ms–2.4 s delay, **FLEURS 8.72%** over 13 langs, self-host via vLLM ([HF](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602); [arXiv:2602.11298](https://arxiv.org/abs/2602.11298)); but 4B ≈ 6–7× the compute of a 0.6B FastConformer per stream. **Qwen3-ASR** (Alibaba, [arXiv:2601.21337](https://arxiv.org/html/2601.21337v2); [github.com/QwenLM/Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)) — dynamic flash-attention window (1–8 s), single weights for stream+offline, **1.7B streaming 4.51% vs offline 3.38% LS-other**, vLLM, open. **Meta Omnilingual ASR** (2025-11-10, 1,600+ langs) — **offline only**.

**Commercial frontier (reference only; PHI caveats).** Only **Deepgram** and **Speechmatics** offer self-managed on-prem (licensed binaries, not open weights): Deepgram **Nova-3** (5.26% batch / 6.84% streaming) and **Flux** (integrated EOT <300 ms, multilingual 2026-04-29); **Speechmatics Ursa 2** (55 langs, −18% WER vs Ursa 1). API-only: **AssemblyAI Universal-Streaming** (~300 ms P50 word-emission), **Gladia Solaria-3** (103 ms partial / 270 ms final), **ElevenLabs Scribe v2 Realtime** (sub-150 ms). Independent benchmark caveat: *"vendor benchmarks are marketing copy with measurements attached"* ([Coval, accessed 2026-07-10](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)).

---

## 3. Endpointing & finalization best practice

**Silero VAD v6 IS out (correcting a likely stale assumption).** ([github.com/snakers4/silero-vad/releases](https://github.com/snakers4/silero-vad/releases)) — **v6.0 (2025-08-25): 16% fewer errors on noisy real-life data, 11% fewer multi-domain**; v6.2 (2025-12-10); **v6.2.1 (2026-02-24)** made `onnxruntime` optional. MIT, ~2 MB. **Frame-size correction:** since **v5, Silero is fixed to 512-sample / 32 ms windows at 16 kHz** — the "30 ms" figure is WebRTC VAD's frame and Silero's `speech_pad_ms` default, *not* its inference window. Defaults: `threshold=0.5`, `min_silence_duration_ms=100`, `speech_pad_ms=30`. **Alternatives:** **TEN VAD** (Apache-2.0, 10/16 ms hop, **beats Silero on precision and transition latency**, detects short inter-speech silences Silero misses — [github.com/TEN-framework/ten-vad](https://github.com/TEN-framework/ten-vad)); NeMo **Frame-VAD MarbleNet v2.0** (20 ms, multilingual).

**The 2026 consensus: VAD is only the silence trigger; a semantic/acoustic EOU model gates the actual endpoint.** Self-hostable turn-detectors:
- **Pipecat/Daily smart-turn v3 / v3.2** (Sept 2025+) — **fully open weights + data + training**, audio-native, **12 ms on CPU**, 8 MB quantized; v3.2 adds +40% on short utterances and noise robustness ([daily.co](https://www.daily.co/blog/smart-turn-v3-2-handling-noisy-environments-and-short-responses/)). **Cleanest license story for a clinical stack.**
- **LiveKit Turn Detector v1 / v1-mini** (2026-06) — dual-branch **audio-native** (audio encoder + Qwen2.5-0.5B semantic backbone + acoustic branch), 14 languages, CPU-capable mini ([livekit.com/blog/solving-end-of-turn-detection](https://livekit.com/blog/solving-end-of-turn-detection)).
- **Kyutai semantic VAD** — multi-head, predicts "pause of length L has occurred" for L ∈ {0.5, 1, 2, 3 s} = a tunable patience dial, EOU + transcript from one model.
- **TEN Turn Detection** (Qwen2.5-7B, EN+ZH) — **3-state `finished`/`unfinished`/`wait`**; the `unfinished` "hold" label is worth copying for a transcript you already have.

**Adaptive silence timeouts** — every leading system now selects the endpoint delay within a [min, max] window from an EOU confidence score: **LiveKit** `min_delay 0.3 s / max_delay 2.5 s` *with* the detector (0.5/3.0 without); **Deepgram Flux** `eot_threshold=0.7`, speculative `eager_eot`, and `eot_timeout_ms=5000` hard cap; **AssemblyAI U3 Pro** `min_turn_silence` 128/224/800 ms per mode + `max_turn_silence 1536 ms`; **OpenAI `semantic_vad`** eagerness dial. **Clinical bias:** doctors take long deliberate pauses (reading, enumerating doses) and cutoff cost is high → use higher EOU threshold + longer hard cap (**2.5–3.5 s**) and emit a "hold" on trailing conjunctions/numbers.

**Partial/final message contract of leading APIs — the semantics a 2026 WS protocol should expose:**

| Vendor / model | Partial (revisable) | Final / commit | Turn / endpoint signal | Force-finalize | Notable fields |
|---|---|---|---|---|---|
| **Deepgram Nova (classic)** | `Results is_final:false` | `Results is_final:true` (immutable chunk) | `speech_final:true`; separate `UtteranceEnd` (`utterance_end_ms`) | **`{"type":"Finalize"}`** | word start/end/conf; `is_final ≠ speech_final` |
| **Deepgram Flux (turn-native)** | `Update`, `StartOfTurn` | `EndOfTurn` | model-integrated `EagerEndOfTurn`+`EndOfTurn`+`TurnResumed`, `end_of_turn_confidence` | `eot_timeout_ms` | `turn_index`, `audio_window` |
| **AssemblyAI Universal-Streaming (2025)** | `Turn end_of_turn:false`, `word_is_final` (**committed words immutable**) | `end_of_turn:true` → `turn_is_formatted` | neural `end_of_turn` + confidence | **`ForceEndpoint`** | ~307 ms P50 |
| **AssemblyAI U3 Pro (2026)** | `Turn` re-transcribes whole turn, **supersedes prior (replace, not append)** | `end_of_turn:true` (formatted) | `min/max_turn_silence`, `vad_threshold` | `ForceEndpoint` | modes min_latency/balanced/max_accuracy |
| **Google STT V2** | `is_final:false` + **two-tier `stability`** | `is_final:true` | `voice_activity_events` BEGIN/END | close stream | `stability` score, Chirp 3 |
| **Azure Speech** | `Recognizing` | `Recognized` (immutable) | `Speech_SegmentationStrategy="Semantic"` (ends on . ? !) | stop recognition | semantic sentence finals |
| **OpenAI Realtime** | `…transcription.delta` | `…transcription.completed` | `speech_started/stopped`, `server_vad` or `semantic_vad` | `input_audio_buffer.commit` | `gpt-4o-transcribe(-diarize)` |

Two key semantics: **Deepgram `is_final` ("chunk won't be revised") ≠ `speech_final` ("utterance ended")**; and **AssemblyAI reversed course** — 2025 marketed *immutable* word-level partials, 2026 U3 Pro moved to *revisable segment-level* (whole-turn re-transcribe supersedes prior) for accuracy-with-full-context.

---

## 4. Realtime diarization

**NVIDIA Streaming Sortformer overturned the old rule that streaming diarization costs 5–15 DER points — it now matches or beats offline.** (["Streaming Sortformer", Medennikov et al., Interspeech 2025, arXiv:2507.18446, 2025-07-24](https://arxiv.org/abs/2507.18446)). Uses an **Arrival-Order Speaker Cache (AOSC)**; ~117M params; **max 4 speakers**. Exact HF IDs + **licenses (load-bearing for a commercial clinical product):**

| Model | Role | License | Notes |
|---|---|---|---|
| `nvidia/diar_sortformer_4spk-v1` | **offline** | **CC-BY-NC ⚠️ non-commercial** | do not use in product |
| **`nvidia/diar_streaming_sortformer_4spk-v2`** | **streaming** | **CC-BY-4.0 ✅** | latency 0.32/1.04/10/30.4 s |
| `nvidia/diar_streaming_sortformer_4spk-v2.1` | streaming | NVIDIA OML ✅ | meeting/far-field refresh |
| `nvidia/multitalker-parakeet-streaming-0.6b-v1` | **speaker-attributed streaming ASR** | NVIDIA OML | RNN-T + speaker-kernel injection |

Streaming Sortformer @1.04 s latency **beats offline Sortformer** (DIHARD III 19.02 vs 21.71; CALLHOME 11.22 vs 14.25) and on **2-speaker CH109 ties it (5.09 vs 4.86)**; **CALLHOME-2spk ~6.6% DER**; dropping to 0.32 s barely moves it. RTF 0.002–0.18 (far faster than real-time). A NeMo tutorial combines `multitalker-parakeet-streaming` + `diar_streaming_sortformer_4spk-v2` for **word-level speaker-attributed streaming ASR at ~1.12 s end-to-end** ([verified via HF cards + [NeMo Streaming_Multitalker_ASR tutorial](https://github.com/NVIDIA-NeMo/Speech/blob/main/tutorials/asr/Streaming_Multitalker_ASR.ipynb)]).

**pyannote:** **4.0.0 shipped 2025-09-29** (4.0.7 on 2026-06-30) with the open **Community-1** pipeline + VBx clustering — but **open-source pyannote has no native streaming**; the streaming wrapper **diart** (v0.9.2, Feb 2025) is pinned to `pyannote<3.1` so it lags the 4.x quality curve. pyannoteAI **Live-1 GA'd 2026-07-07 (<300 ms) — API only** ([pyannote.ai/changelog](https://www.pyannote.ai/changelog)).

**Practical 2-speaker doctor/patient:** **stereo / dual-channel capture wins — a hardware channel boundary is a perfect, ~0-DER, zero-latency speaker label** (standard call-center practice; NVIDIA frames Sortformer's alternative as "separate agent/customer streams"). Use model-based diarization only for true single-mic ambient capture, where 2-speaker is the *easy* regime for Sortformer (~5% DER on CH109). **Clinician voice enrollment** ("not-clinician = patient") is a cheap robustness boost; an enrollment-free variant exists ([arXiv:2506.22646](https://arxiv.org/pdf/2506.22646)). The real latency bottleneck is turn/endpoint detection, not the diarizer.

---

## 5. Audio transport & browser capture

**Capture:** use **AudioWorklet** (128-frame render quantum on a dedicated audio thread) — **ScriptProcessorNode is deprecated** ([MDN, accessed 2026-07-10](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)). Run WASM DSP synchronously inside/around the worklet (RNNoise is fixed 480-frame/10 ms; Silero wants 512-sample/32 ms — re-block with a ring buffer). **WASM SIMD needs no cross-origin isolation; WASM threads / SharedArrayBuffer DO** (`COOP: same-origin` + `COEP: require-corp`|`credentialless`) — for embeds, `credentialless` is the pragmatic middle path ([web.dev/coop-coep](https://web.dev/articles/coop-coep)). Downsample **48 kHz → 16 kHz** with a proper anti-aliasing resampler (libsamplerate/speex WASM); **16 kHz is the sweet spot** (Google: below hurts, above gives no benefit for speech). Set getUserMedia `noiseSuppression:{exact:false}` etc., but **Chrome may ignore it** ([Chromium issue 327472528](https://issues.chromium.org/issues/327472528)).

**PCM16 vs Opus over WS:**

| | Raw PCM16 (linear16) | Opus (VoIP) |
|---|---|---|
| Bandwidth | 256 kbps (fixed) | ~16–32 kbps (~90% less) |
| Lossy? | No | Yes |
| ASR WER impact | Baseline (best) | **+~2% relative** at good bitrate; **sharp below 16 kbps** ([arXiv:2106.07994](https://arxiv.org/abs/2106.07994); [IBM Watson](https://medium.com/ibm-data-ai/why-the-audio-compression-format-impacts-the-speech-to-text-transcription-accuracy-84da6438024c)) |
| Server decode | none | **<1% CPU core** (libopus) |
| Vendor stance | **Google prefers lossless; OpenAI Realtime = pcm16** | Deepgram/Google accept as low-bitrate fallback |

→ **Keep raw PCM16 @16 kHz mono as the quality-first default over WebSocket; add an Opus ≥24 kbps fallback (never <16 kbps) for constrained networks** (via WebCodecs `AudioEncoder`, which is **not Baseline** — Safari <26 / Firefox-Android need a libopus-WASM/PCM fallback). **Keep WebSocket, not WebRTC:** firewall-friendly on locked-down clinical nets, lets you keep raw PCM, and drops straight into your NestJS→Redis Streams path (WebRTC forces Opus + an SFU). Borrow WebRTC's *reliability ideas* at the app layer: **per-chunk monotonic sequence numbers, a resumable session `{sessionId, lastRedisStreamId}` with 30–60 s server retention, a client-side seconds-long PCM ring buffer to replay the gap, and explicit backpressure via `bufferedAmount`.** **Redis Stream entry IDs are already your durable sequence/resume mechanism** — lean on them.

**⚠️ Noise suppression for ASR — the decisive finding: aggressive spectral denoising HURTS modern ASR WER, including in medicine and even on clean audio.**
- ["When De-noising Hurts… Speech Enhancement Effects on Modern Medical ASR", arXiv:2512.17562, Dec 2025](https://arxiv.org/html/2512.17562): on 500 medical recordings × 9 noise conditions (Whisper Large-v3, **Parakeet-TDT-1.1B**, Gemini Flash, healthcare-tuned), **original noisy audio beat MetricGAN+-enhanced audio in ALL 40 configurations**; denoising added **+1.32–3.19% semWER even on clean audio**, catastrophic in some noise cases. Authors: enhancement "should not be applied by default."
- ["When Denoising Hinders… Whisper", arXiv:2603.04710, Mar 2026](https://arxiv.org/abs/2603.04710): SAM-Audio denoising *raised* WER/CER across Whisper sizes despite higher perceptual quality; **errors grew with model size.**
- Mechanism: enhancement's speech distortion/artifacts degrade ASR (Microsoft Research, [arXiv:2111.11606](https://arxiv.org/pdf/2111.11606)); Whisper was trained on **680k hours of noisy web audio** and is built to ingest noise directly ([OpenAI](https://openai.com/index/whisper/)).

→ **VAD (segmentation only) is safe and valuable; spectral denoising (RNNoise/DeepFilterNet) is the risk.** The "RNNoise gives 15–25% WER win" claim is vendor-blog only and scoped to *older ASR in stationary noise*. **DeepFilterNet3 real-time in-browser WASM is not well-proven** (canonical repo is Python/Rust CPU/GPU). **A/B RNNoise-on vs -off on your own consultation audio; if it doesn't prove a WER win, ship undenoised PCM16.**

---

## 6. Latency engineering: targets, metrics, measurement

**Metrics vocabulary** (["Analyzing the Quality and Stability of a Streaming E2E On-Device Recognizer", arXiv:2006.01416](https://arxiv.org/pdf/2006.01416); deflickering, Bruguier): **partial latency PR50/PR90** (time from correct partial to speech-end), **endpointer latency**, **finalization latency** (speech-end → final), and the flicker metric **UPWR — Unstable Partial Word Ratio** (fraction of already-emitted partial words later changed). Track **revision rate** and **RTF** alongside WER.

**Measurement methodology** ([Deepgram, "Measuring Streaming Latency", accessed 2026-07-10](https://developers.deepgram.com/docs/measuring-streaming-latency)): two cursors — audio submitted (X) minus audio processed-from-interims (Y) = transcript latency; **use interim results only** (finals conflate endpointing). Their targets: **transcription 150–300 ms, total transcript 200–500 ms, network 20–200 ms, buffer 20–100 ms.**

**Industry targets:** **voice agents — partial <300 ms** (>500 ms "feels broken"; streaming ASR itself 100–200 ms) ([AssemblyAI "The 300ms Rule", 2025-12-16](https://www.assemblyai.com/blog/low-latency-voice-ai)). **Live captioning / CART — 1–3 s tolerable at ~99% accuracy.** **Ambient clinical scribing — sub-second for the live transcript component; note generation 10–30 s (p50 ~14.4 s for a SOAP note)** ([JMIR/vendor data, 2025–2026](https://medinform.jmir.org/2025/1/e80898)). Ultra-low-latency extreme for reference: **CAIMAN-ASR** (Myrtle, LSTM transducer, **60 ms lookahead**, 2000 streams/FPGA card).

**Recommended targets for clinical STT:** first-partial **<300 ms**, committed-text lag **<1 s**, final formatted turn **<2 s**, note draft **<30 s**; keep **UPWR/flicker low** by rendering only sufficiently-stable partial words.

---

## 7. Ambient clinical scribing systems — architecture references

*(Mostly proprietary; [PUBLIC]=vendor-stated, [INDEP]=third-party study, [INFERRED]=common pattern.)*

- **Microsoft/Nuance — Dragon Copilot** ([DAX Copilot + Dragon Medical One merged 2025-03-03](https://news.microsoft.com/source/2025/03/03/microsoft-dragon-copilot-provides-the-healthcare-industrys-first-unified-voice-ai-assistant-that-enables-clinicians-to-streamline-clinical-documentation-surface-information-and-automate-task/)). [PUBLIC] drafts the note "in the background" during the visit, finalized "in seconds," **mandatory clinician review**; Azure cloud; models/latency not public.
- **Abridge** — [PUBLIC] **own ASR** (self-reports **16% better than Whisper v3**, 45% fewer med-name errors); **Contextual Reasoning Engine**; **Linked Evidence** (every note span maps back to transcript+audio); a **separate confabulation-detection model** (trained on 50k+ examples) that runs *first-draft→final-draft before the clinician* and catches **97% vs GPT-4o's 82%** ([abridge.com/ai](https://www.abridge.com/ai/science-confabulation-hallucination-elimination), 2025-08-19).
- **Nabla** — [PUBLIC] **Whisper derivative** (7,000 hrs, ~$5M, 3 yrs, hallucination suppression); **atomic-fact LLM verification** ("only facts with definitive proof kept"); **WebSocket** streaming; **cloud + zero audio retention**, PII-masked before the LLM ([nabla.com/blog/how-nabla-uses-whisper](https://www.nabla.com/blog/how-nabla-uses-whisper)).
- **Suki** — [PUBLIC] **dual-ASR** (one for dictation, one for wake-word commands), context biasing (age/specialty), GCP.
- **Corti (EU)** — most transparent and the closest architectural mirror to your plan: [PUBLIC] three endpoints (`/transcribe` stateless WS, `/streams` WS **with native diarization**, `/transcripts` REST), **interim + final**; **explicitly critiques Whisper-style AED models as "batch-oriented and prone to over-generation/hallucination" and favors streaming CTC/Transducer** because the metric that matters is **word-level latency**; orchestrated chain (acoustic → LM refine → punctuation/units → domain normalization → SOAP/JSON) with **keyterm biasing** and **synthetic TTS data** for rare terms; self-reports **1.4% WER EN**; BSI-C5 sovereign ([corti.ai, 2025-07-22](https://www.corti.ai/stories/building-better-speech-recognition-for-healthcare)).

**Cross-cutting patterns to borrow:** (1) **two-tier ASR** — fast streaming for live UI, heavier pass post-"stop" for the record ([INDEP industry norm](https://www.assemblyai.com/blog/how-to-build-ai-medical-scribe); note: a literal *larger-ASR re-transcription* is [INFERRED], not vendor-confirmed — Corti actually argues against a batch-Whisper rescore). (2) **a verification/fact-check model between draft and clinician** — the single most-copied non-obvious move (Abridge + Nabla). (3) **provenance** (Linked Evidence). (4) **orchestrated ASR chain + medical keyterm biasing**. (5) **diarization via clinician enrollment + explicit speaker-role tags feeding the LLM**. (6) **cloud + zero-retention is a viable alternative to on-device**. **[INDEP] reality check:** a Mayo/OHSU simulated-encounter study found transcripts averaged **13.9 errors, 19.5% propagated into the note, mean note error rate 26.3%** ([mcpdigitalhealth.org, Oct 2025](https://www.mcpdigitalhealth.org/article/S2949-7612(25)00099-9/fulltext)) — **mandatory clinician review is non-negotiable regardless of stack.**

---

## Master comparison: streaming approaches

| Approach | Representative model | Latency→partial | Latency→final/commit | WER Δ vs offline | Multilingual | Diarization | Maturity |
|---|---|---|---|---|---|---|---|
| **Whisper + LocalAgreement-2** | whisper_streaming (large-v3) | ~0.5–1 s | **~2–3.3 s** | +0.2% EN / +2% DE / +6% CS | 99 langs (Whisper) | external only | **Deprecated by authors** (2025) |
| **Whisper + AlignAtt** | SimulStreaming / WhisperLiveKit | ~0.3–0.5 s (frame-thr 25) | ~1–2 s | small (≈LA-2, better) | 99 langs | via WhisperLiveKit+Sortformer | Active, prod-integration (v0.2.23, 2026-07) |
| **Native cache-aware RNN-T (unified)** | **nvidia/parakeet-unified-en-0.6b** | **160–560 ms** | 160 ms–2.08 s (same ckpt) | **+2.5 pts @160ms → +0.2 @2.08s** vs its offline 5.9% | EN only | pair w/ Sortformer | New (2026-04), production lineage |
| **Native cache-aware RNN-T (multiling.)** | nvidia/nemotron-3.5-asr-streaming-0.6b | 80 ms–1.12 s | same | ~+1–2 pts | **40 locales** | pair w/ Sortformer | New (2026-06), Riva/NIM |
| **Streaming CTC** | FastConformer-CTC [70,x] | 0–1040 ms | same | ~1 pt worse than RNN-T | EN | Riva Sortformer (CTC-paired) | Mature |
| **Streaming speech-LLM (delayed streams)** | kyutai/stt-1b-en_fr | **0.5 s** (fixed) | 0.5 s | ≈offline SOTA (authors) | EN+FR (2.6B EN) | — (has semantic VAD) | Prod Rust server |
| **Streaming speech-LLM (causal)** | Voxtral-Mini-4B-Realtime | 80 ms–2.4 s | same | FLEURS 8.72% (13 lang) | 13 langs | — | New (2026-02), Apache-2.0, vLLM |
| **Speaker-attributed streaming ASR** | multitalker-parakeet-streaming-0.6b-v1 + Sortformer | ~1.12 s e2e | ~1.12 s | 7.44% 1-spk; cpWER 15.8–37.4 | EN | **native, word-level** | Medium-high (NeMo) |
| **Commercial on-prem (licensed)** | Deepgram Nova-3/Flux; Speechmatics Ursa 2 | ~150–300 ms | <300 ms EOT | 5.26% batch / 6.84% stream | multi | yes | GA |
| **FPGA transducer (extreme)** | CAIMAN-ASR (LSTM RNN-T) | 60 ms lookahead | ~sub-second | — | EN | — | GA (niche HW) |

---

## Synthesis: the reference architecture for self-hosted realtime clinical STT in mid-2026

1. **Two-tier ASR.** A **native cache-aware transducer** (e.g. `parakeet-unified-en-0.6b`, RNN-T) for live partials at **160–560 ms**; a **heavier offline pass** (the same unified checkpoint's offline mode, a TDT model, or Whisper-large-v3-turbo) re-decoding the full audio after "stop" to produce the note-generating transcript.
2. **Make the live engine a native transducer, not Whisper-chunked-LocalAgreement.** Cache-aware streaming removes re-encode overhead and the hallucinated-partial risk; RNN-T beats CTC ~1 pt at every latency; TDT adds ~2.8× throughput on the offline pass. This is exactly what clinical incumbent Corti argues publicly.
3. **Partial/final contract = revisable "tentative tail" + immutable "commit" prefix + explicit `endpoint{reason, confidence}` + formatted `final`.** Carry a **stability** score on partials, a **word `is_final`** flag, a monotonic **audio timestamp** on every message (Redis-Stream-ID resume), an optional **speaker tag**, and a client→server **`finalize`/flush** command. This is a superset of every vendor contract and maps 1:1 onto a LocalAgreement/AlignAtt engine.
4. **Endpointing = VAD trigger + semantic EOU gate.** Silero **v6** (or TEN VAD for tighter latency) as the *trigger only*; a self-hostable audio-native EOU model (**smart-turn v3.2** — cleanest license — or **LiveKit v1-mini**, or Kyutai's built-in semantic VAD) chooses the delay in an **adaptive [0.3–0.5 s min, 2.5–3.5 s max]** window **biased long for clinical** cutoff cost, with a "hold" state on trailing numbers/conjunctions.
5. **Diarization: prefer stereo/dual-channel capture (~0 DER) wherever the room/telehealth setup allows;** fall back to **Streaming Sortformer v2 (CC-BY-4.0) at 1.04 s** for single-mic ambient, or the **joint multitalker-Parakeet + Sortformer** recipe for word-level speaker-attributed streaming. Add **clinician voice enrollment** as a cheap 2-party robustness boost.
6. **Browser capture:** AudioWorklet + WASM VAD, 48→16 kHz anti-aliased resample, **raw PCM16 @16 kHz mono over WebSocket** as default; **Opus ≥24 kbps fallback** for weak networks. WebSocket over WebRTC (firewall, raw PCM, Redis Streams).
7. **Do NOT run aggressive spectral noise suppression on the ASR path.** Current evidence (incl. a medical-ASR study where denoising lost in all 40 configs) says it hurts Whisper/Parakeet-class WER. Keep VAD (segmentation is safe); **A/B RNNoise on your own audio and disable it if it doesn't prove a win.**
8. **Reliability:** app-layer **sequence numbers + resumable session on Redis Stream IDs + client PCM ring-buffer replay + `bufferedAmount` backpressure** (never drop medical audio).
9. **Post-ASR orchestrated chain:** punctuation/formatting/units/**medical keyterm biasing** (NeMo word-boosting for drug/procedure names) → **a verification/fact-check model between draft and clinician** (Abridge/Nabla pattern) → summarization; keep **provenance** (map every note span to transcript+audio offsets) and **mandatory clinician review**.
10. **Observe latency/quality:** track **first-partial (PR50/PR90), commit lag, finalization latency, UPWR/flicker, RTF, revision rate**; targets partial <300 ms, commit <1 s, final <2 s, note <30 s.
11. **License diligence is architecture:** the *streaming* Sortformer v2 is CC-BY-4.0 (OK) but *offline* v1 is **CC-BY-NC (not OK)**; NVIDIA **Open Model / OpenMDW-1.1** terms and **SimulStreaming's** license need explicit legal sign-off for commercial clinical use.
12. **The open reference to benchmark against before building bespoke:** **WhisperLiveKit** already assembles AlignAtt + Sortformer + VAD/VAC + a partial/final WS protocol + Deepgram/OpenAI-compatible endpoints.

---

## Validation / critique of your five planned bets

1. **LocalAgreement-2 as default pipeline — VALIDATED AS A BASELINE, BUT DATED; don't leave it as the *default*.** It is correct, well-understood, and low-risk (0.2% EN WER loss), but **its own authors declared it "outdated, replaced by SimulStreaming"** in 2025, and the whole Whisper-chunked paradigm is being displaced by native cache-aware transducers (lower latency, no re-encode, less hallucination). **Recommendation:** keep LA-2 as the conservative fallback; make the default either **AlignAtt/SimulStreaming** (if you stay on Whisper) or, better, promote the **native transducer** to the default streaming engine once piloted. Reuse WhisperLiveKit as the integration reference rather than hand-rolling.
2. **Native-transducer pilot — STRONGLY VALIDATED; this is the highest-value bet.** Concrete candidates: `parakeet-unified-en-0.6b` (offline+streaming in one checkpoint — ideal for your two-tier flow), `nemotron-speech-streaming-en-0.6b` (Riva/NIM ops maturity), or `nemotron-3.5` for multilingual. Evidence: RNN-T > CTC at every latency; TDT 2.82× throughput; Corti (clinical) publicly favors streaming transducer over AED. **Caveats:** the best ones are **English-only** (multilingual → nemotron-3.5, check OpenMDW license); **validate on de-identified clinical audio** (LibriSpeech/FLEURS under-predict real WER) with **keyterm biasing** for drug names.
3. **Semantic endpointing — VALIDATED; it is the 2026 industry standard.** VAD-as-trigger + semantic EOU gate is now universal. Use a self-hostable model (smart-turn v3.2 / LiveKit v1-mini / Kyutai semantic VAD). **Refinement:** bias the timeout window *longer* than voice-agent defaults (clinical pauses are long and deliberate; cutoff loses doses), and add a "hold/`unfinished`" state so the downstream summarizer doesn't fire mid-sentence.
4. **Streaming 2-speaker diarization — VALIDATED, WITH ONE STRONG CAVEAT.** Streaming Sortformer now matches/beats offline, and 2-speaker is its best-case regime (~6.6% DER). **But prefer stereo/channel separation (~0 DER) whenever the capture hardware allows — it is simpler, more accurate, and sidesteps model-licensing/overlap risk.** Reserve model-based streaming diarization for genuine single-mic ambient capture. Use the **CC-BY-4.0 streaming v2**, not the CC-BY-NC offline v1.
5. **Tentative-tail rendering — VALIDATED as best practice.** It matches every leading API's revisable-partial + immutable-commit model. **Enhancements:** render the tail visually distinct (grey/italic), gate it by a **stability score** to control **flicker (UPWR)**, and pair it with an explicit **`endpoint{reason, confidence}`** so the UI (and audit trail) distinguishes a semantic sentence completion from a mere silence/timeout cutoff.

---

## Explicitly flagged as unverifiable / needs your own check

- **SimulStreaming commercial license:** README says "MIT" and both upstreams are permissive (Simul-Whisper Apache-2.0 + whisper_streaming MIT), but one scrape surfaced a "Noncommercial version 2025-10-22" note. **Verify the LICENSE file directly before shipping commercially.**
- **NVIDIA model licenses** (Open Model / **OpenMDW-1.1** / OML) and **Sortformer v1 = CC-BY-NC** all need legal review for commercial clinical use.
- **Whether ambient-scribe incumbents literally re-transcribe with a *larger* ASR post-visit** is **inferred, not confirmed** (Corti argues against it). "Live streaming + heavier post-visit LLM note pass" *is* confirmed.
- **All vendor WER/latency numbers are self-reported benchmarks;** the only independent accuracy/safety data are the NEJM AI RCT (time-in-note) and the Mayo/OHSU simulated-encounter study (26.3% note error rate). **Validate any model on your own audio.**
- **Exact release dates** for Sortformer **v2.1** and `multitalker-parakeet-streaming-0.6b-v1` (paper ~2025-06-27 used as proxy); **no Sortformer v3** exists as of 2026-07-10.
- **Silero `min_speech_duration_ms=250`** is the standard library default but wasn't re-confirmed on a primary page this pass (threshold 0.5 / min_silence 100 / speech_pad 30 were).
- **"RNNoise gives 15–25% WER improvement"** is vendor-blog only (older ASR, stationary noise); **DeepFilterNet3 real-time in-browser WASM** is not production-proven. Treat noise-suppression benefit as **unproven for your Whisper/Parakeet stack until you A/B measure it.**
- **WhisperPipe's "89 ms" and CAIMAN-ASR figures** are processing/lookahead latencies, not full user-perceived commit lag — don't quote them as end-to-end.

*Research artifacts (fetched PDFs) cached under `/Users/taphuynh/.claude/projects/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/277917b1-c566-4111-99f3-e2cfa2fea765/tool-results/` if you need the raw sources.*
