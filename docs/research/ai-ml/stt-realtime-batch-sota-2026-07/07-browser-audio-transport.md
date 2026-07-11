> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `general-purpose` `afe3e6bbff8dc4c52` (sub-agent of 01). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Browser Audio Capture + WebSocket Transport for Healthcare ASR — Mid-2026 Best Practice

*Research date: 2026-07-10. "Accessed" = living doc read today. Source-confidence flags at the end. Bottom line up front: the strongest, most decision-relevant finding is that **aggressive noise suppression measurably HURTS modern ASR word-error-rate, including in medical settings and even on clean audio** — which directly implicates the RNNoise stage in your current pipeline.*

---

## 1. Browser audio capture (AudioWorklet, WASM DSP, SIMD/threads, sample rate)

**ScriptProcessorNode is deprecated; AudioWorklet is the only correct choice in 2026.** ScriptProcessorNode ran user callbacks on the **main UI thread** with async event dispatch, inducing latency and UI-thread jank/glitches; it is officially deprecated on MDN ([MDN ScriptProcessorNode](https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode), accessed 2026-07-10). AudioWorklet runs custom code in `AudioWorkletGlobalScope` on a **separate, dedicated Web Audio rendering thread**, giving very low latency and synchronous rendering ([MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet), accessed 2026-07-10). It has shipped by default in Chrome since v66 (2018) ([Chrome for Developers: Audio Worklet](https://developer.chrome.com/blog/audio-worklet), accessed 2026-07-10).

**Render quantum = 128 frames.** `AudioWorkletProcessor.process()` is called with fixed **128-sample-frame** `Float32Array` blocks per channel — 2.67 ms at 48 kHz. MDN explicitly warns this may become variable in future and that you must read `channel.length` rather than assume 128 ([MDN AudioWorkletProcessor.process](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process), accessed 2026-07-10). Your DSP stages have larger native frames — **RNNoise is fixed at 480 frames (10 ms @ 48 kHz)** and **Silero VAD wants ~30 ms chunks** — so the worklet must re-block 128→480/512 with a ring buffer.

**Running WASM DSP in/around the worklet.** The canonical production pattern is a WASM module compiled with Emscripten loaded *inside* the AudioWorklet so the modified track never touches the main thread. RNNoise-in-worklet is exactly how Jitsi Meet ships suppression ([github.com/jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm), accessed 2026-07-10). Constraint: the worklet loads the processor **synchronously**, so you must inline/synchronously-compile the WASM (async `WebAssembly.instantiate` promise won't be resolved in time). Silero VAD runs in-browser via **onnxruntime-web** loading `silero_vad_v5.onnx` + the ORT WASM files, with a worklet for capture/framing; one 30 ms chunk decodes in <1 ms on a single CPU thread ([snakers4/silero-vad](https://github.com/snakers4/silero-vad); [ricky0123/vad browser guide](https://docs.vad.ricky0123.com/user-guide/browser/), accessed 2026-07-10).

**SIMD vs threads vs cross-origin isolation — a distinction that matters:**
- **WASM SIMD alone does NOT require cross-origin isolation.** It's a plain instruction-set feature.
- **WASM threads / SharedArrayBuffer DO require the page to be "cross-origin isolated":** you must serve `Cross-Origin-Opener-Policy: same-origin` **and** `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). This has been mandatory in Chrome 92+ and is enforced by every major engine ([web.dev: making your site cross-origin isolated](https://web.dev/articles/coop-coep), accessed 2026-07-10; [web.dev: WebAssembly threads](https://web.dev/articles/webassembly-threads), accessed 2026-07-10).
- Practical consequence for you: the **efficient lock-free SharedArrayBuffer ring buffer** to shuttle audio from the AudioWorklet to the main thread — and any **multi-threaded onnxruntime-web backend** — both need COOP/COEP. `require-corp` blocks freely embedding cross-origin resources (mark them `crossorigin`/CORP or use `credentialless`). If you don't want to pay that tax, use `MessagePort.postMessage` (a copy, not shared memory) and single-threaded WASM+SIMD — jitsi's rnnoise-wasm is single-threaded and needs no COI. For a clinical app embedding third-party widgets, **`credentialless` COEP is usually the pragmatic middle path.**

**Sample-rate handling (48 kHz capture → 16 kHz for ASR).** Browsers almost always open the mic `AudioContext` at 48 kHz (hardware native); ASR wants 16 kHz mono. **Do the downsample yourself with a proper anti-aliasing resampler inside the worklet chain** — do not rely on naive decimation. High-quality options: `libsamplerate-js` (WASM port of libsamplerate, `SRC_SINC_BEST_QUALITY`) or a speex-resampler; the SEPIA `sepia-web-audio` library was built specifically to resample to 16 kHz 16-bit mono for ASR in a background thread ([SEPIA-Framework/sepia-web-audio](https://github.com/SEPIA-Framework/sepia-web-audio); [libsamplerate-js](https://github.com/aolsenjazz/libsamplerate-js), accessed 2026-07-10). Note `OfflineAudioContext` resampling is **main-thread only** and cannot be used inside a worklet ([0110.be: resampling via AudioWorklet](https://0110.be/posts/Resampling_audio_via_a_Web_Audio_API_Audio_Worklet), accessed 2026-07-10). **16 kHz is the sweet spot** — Google confirms capturing below 16 kHz impairs accuracy and above 16 kHz has *no appreciable benefit* for speech ([Google Cloud STT encoding docs](https://docs.cloud.google.com/speech-to-text/docs/encoding), accessed 2026-07-10).

**getUserMedia constraints for ASR.** Defaults are `echoCancellation:true, noiseSuppression:true, autoGainControl:true` ([blog.addpipe.com getUserMedia audio constraints](https://blog.addpipe.com/getusermedia-audio-constraints/); [MDN Constraints](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Constraints), accessed 2026-07-10). Because you run your own RNNoise + VAD, you should **stop the browser from double-processing** — but see §6 for the deeper point that suppression itself may hurt WER. Use `exact` so you get an `OverconstrainedError` instead of a silent best-effort track: `{ audio: { echoCancellation:{exact:false}, noiseSuppression:{exact:false}, autoGainControl:{exact:false} } }`. **Caveat (verify per-browser):** Chrome has long-standing bugs where NS/echo cancellation can't be fully disabled via constraints ([Chromium issue 327472528](https://issues.chromium.org/issues/327472528), accessed 2026-07-10) — so browser DSP may still touch your signal even when you ask it not to.

---

## 2. Transport: 16 kHz PCM16 raw vs Opus over WebSocket

**Opus is a lossy codec** (SILK/CELT hybrid), 6–510 kbit/s, sample rates 8–48 kHz, frame sizes 2.5–60 ms, **default algorithmic delay 26.5 ms (20 ms frames), min 5 ms** in restricted-low-delay mode; it can encode intelligible wideband speech at ~12 kbit/s and down to ~5 kbit/s ([Wikipedia: Opus](https://en.wikipedia.org/wiki/Opus_(audio_format)), accessed 2026-07-10).

**Server-side Opus decode is essentially free.** libopus decode is well under ~1% of a laptop CPU core even with packet-loss-concealment/enhancement enabled; it's malloc-free after `_create()`, so it's realtime-safe ([opus-codec.org 1.5 demo](https://opus-codec.org/demo/opus-1.5/); [Xiph OpusFAQ](https://wiki.xiph.org/OpusFAQ), accessed 2026-07-10). So "decode cost" is **not** a reason to avoid Opus.

**Does lossy Opus hurt ASR WER? Modestly, at sane bitrates — but the big ASR vendors still prefer lossless.** Evidence:
- Ogg Opus showed ~**2% relative WER degradation** vs uncompressed WAV/FLAC; MP3 was ~10% ([IBM Watson: why audio compression impacts STT accuracy](https://medium.com/ibm-data-ai/why-the-audio-compression-format-impacts-the-speech-to-text-transcription-accuracy-84da6438024c), accessed 2026-07-10; corroborated by AmiVoice testing, 2025-07-29, [acp.amivoice.com](https://acp.amivoice.com/en/blog/2025-07-29/)).
- WER "degrades sharply below 16 kbps" (Opus drops to narrowband at 8 kbps); at 128 kbps/channel degradation was only ~2.4% relative ([Amazon Science / Drude et al., Interspeech 2021, arXiv 2106.07994](https://arxiv.org/abs/2106.07994), accessed 2026-07-10). Distortion/spatial-info loss especially hurts multi-channel front-ends.
- **Google Cloud STT explicitly recommends lossless LINEAR16 or FLAC** and warns "recognition accuracy may be reduced if lossy codecs are used…**particularly if background noise is present**"; OGG_OPUS is offered only "if a very low bitrate encoding is required" ([Google Cloud STT encoding](https://docs.cloud.google.com/speech-to-text/docs/encoding), accessed 2026-07-10).
- **OpenAI Realtime API** input = `pcm16` (16-bit, **24 kHz**, mono, little-endian), or `g711_ulaw/alaw`; community reports Opus/g711 input handling is flaky ([openai-python sessions](https://github.com/openai/openai-python/blob/main/src/openai/resources/beta/realtime/sessions.py), accessed 2026-07-10).
- **Deepgram** accepts raw `linear16/linear32/mulaw/alaw/opus/ogg-opus` and containerized Opus (Ogg/WebM); you must declare encoding + sample rate for raw; it takes no strong lossless-vs-lossy stance ([Deepgram: determining your audio format](https://developers.deepgram.com/docs/determining-your-audio-format-for-live-streaming-audio); [Deepgram: encoding](https://developers.deepgram.com/docs/encoding), accessed 2026-07-10).

Net: the industry pattern is **PCM/linear16 preferred for quality; Opus accepted as the bandwidth-saving fallback, kept at ≥16–24 kbps.**

### PCM16 vs Opus tradeoff table (16 kHz mono voice, WebSocket ingest)

| Dimension | Raw PCM16 (linear16) | Opus (VoIP settings) |
|---|---|---|
| Bitrate / bandwidth | **256 kbps** (16 kHz × 16 bit) — fixed | **~16–32 kbps** typical; ~90% less; adaptive/VBR down to ~6 kbps ([Wikipedia Opus](https://en.wikipedia.org/wiki/Opus_(audio_format))) |
| Lossy? | No — bit-exact | **Yes** — perceptual loss ([Wikipedia Opus](https://en.wikipedia.org/wiki/Opus_(audio_format))) |
| ASR WER impact | Baseline (best) | +~2% relative @ good bitrate; **sharp** below 16 kbps ([arXiv 2106.07994](https://arxiv.org/abs/2106.07994); [IBM/Watson](https://medium.com/ibm-data-ai/why-the-audio-compression-format-impacts-the-speech-to-text-transcription-accuracy-84da6438024c)) |
| Added codec latency | ~0 (framing only) | 26.5 ms default, 5 ms min ([Wikipedia Opus](https://en.wikipedia.org/wiki/Opus_(audio_format))) |
| Client CPU (encode) | ~0 | Low; near-free with WebCodecs HW path (§3) |
| Server CPU (decode) | none | **<1% CPU core** ([opus-codec.org](https://opus-codec.org/demo/opus-1.5/)) |
| Robustness on bad Wi-Fi | Bandwidth-heavy; more drop risk | Better under congestion (adaptive) |
| What big ASR APIs prefer | **Google prefers lossless; OpenAI Realtime = pcm16** | Deepgram/Google accept as low-bitrate fallback |
| Implementation complexity | Trivial (send Int16Array) | Encoder + container/framing on both ends |

**Guidance:** with a **self-hosted** Whisper-class STT and typical clinic bandwidth, **PCM16 @ 16 kHz mono is the quality-first default** (256 kbps is modest for wired/decent Wi-Fi). Add an **Opus ≥24 kbps fallback** only for constrained/mobile networks; never drop below ~16 kbps for medical transcription.

---

## 3. WebCodecs (`AudioEncoder`/`AudioDecoder`) — useful, but NOT yet Baseline

WebCodecs gives you off-main-thread, optionally hardware-accelerated **Opus** (and AAC) encode/decode with direct access to encoded chunks — ideal for compressing captured PCM into Opus for a plain WebSocket without MediaRecorder/container overhead ([MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API), accessed 2026-07-10).

**Baseline status: NO.** MDN states `AudioDecoder`/`AudioEncoder` "are not Baseline because they do not work in some of the most widely-used browsers" ([MDN AudioEncoder](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder), accessed 2026-07-10). Support: Chrome/Edge 94+, Firefox 130+ (**desktop only** — Android still lacks it), Safari **full only from 26.0** (macOS/iOS); Safari **16.4–18.7 was video-only** (`AudioEncoder`/`AudioDecoder` undefined) ([caniuse: webcodecs](https://caniuse.com/webcodecs), ~92% global, accessed 2026-07-10). AAC encode is missing in Firefox and on desktop Linux.

**Implication for a healthcare app:** WebCodecs Opus is a great *progressive enhancement* for the outbound path, but you **cannot hard-depend on it** — older iOS Safari (pre-26) and Firefox Android need a fallback (send PCM16 via AudioWorklet, or a libopus-WASM encoder). Reported HW-accel CPU wins (e.g. "18%→3% on M2") come from a low-confidence SEO source — treat as directional, not measured ([callsphere.ai, flagged](https://callsphere.ai/blog/vw9e-webcodecs-api-ai-voice-opus-encoding-2026)).

---

## 4. WebRTC vs raw WebSocket for ASR ingest

| | Raw WebSocket (wss) | WebRTC |
|---|---|---|
| Transport | TCP, ordered/reliable | UDP (SRTP), unreliable + jitter buffer, PLC |
| Latency | Higher (TCP HoL blocking possible) | **Sub-100–200 ms**, media-optimized |
| Firewall/proxy (clinical nets) | **Passes almost anywhere on :443** | Needs ICE/STUN/TURN; symmetric NAT → TURN relay |
| Codec control | **Any format incl. raw PCM16** | Effectively **forces Opus** (lossy) |
| Packet-loss handling | You build it (TCP retransmits, adds latency) | Built-in PLC/FEC/jitter buffer |
| Server integration | **Trivial → Redis Streams** | Needs SFU/media server to terminate RTP |
| Complexity | Low | High |

Sources: [getstream.io: WebRTC vs WebSocket](https://getstream.io/blog/webrtc-websocket-av-sync/); [liveapi.com: WebRTC vs WebSocket](https://liveapi.com/blog/webrtc-vs-websocket/) (accessed 2026-07-10).

**Why most ASR vendors still use WebSocket** (and why you should too here): firewall friendliness on locked-down hospital/clinic networks, simpler ops, and — decisively for you — **it lets you keep raw uncompressed PCM16** end-to-end and drop straight into your NestJS→Redis Streams path without an SFU. WebRTC's jitter buffer / Opus-PLC / packet-loss concealment genuinely matter for **live human-to-human** playback under loss; for **server-side ingest you control**, you can buffer and reorder at the application layer instead. A common hybrid (WebRTC client→relay, WebSocket relay→ASR) exists but adds a media server you don't need. **Keep WebSocket; borrow WebRTC's *reliability ideas* at the app layer (§5).**

---

## 5. Reliability: jitter/backpressure + reconnect-with-resume

**Backpressure (do NOT drop audio):** monitor `WebSocket.bufferedAmount`; when it climbs, the socket is draining slower than you produce. For audio you cannot silently drop frames, so **throttle at the source or buffer**, and signal flow control with small control frames (window/token). WebSocket has no built-in backpressure, so implement it explicitly ([websocket.org: reconnection guide](https://websocket.org/guides/reconnection/); [vertextlabs: WS backpressure & flow control](https://vertextlabs.com/websocket-backpressure-flow-control-real-time-chat-streams/), accessed 2026-07-10).

**Reconnect-with-resume protocol (recommended shape):**
1. **Monotonic sequence number per audio chunk.** Client tracks last-acked seq; server tracks last-received seq.
2. **Session/resume token.** On reconnect the client sends `{sessionId, lastSeq}`; server keeps session state **30–60 s** after disconnect and replays/accepts from `lastSeq+1` ([websocket.org reconnection](https://websocket.org/guides/reconnection/); [oneuptime: WS reconnection, 2026-01-27](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view), accessed 2026-07-10).
3. **Client history ring buffer.** Keep the last few seconds of PCM so you can re-send audio produced during the disconnect gap — a known telephony/contact-center pattern for lossless handover ([USPTO 12212790: efficient streaming of audio to third-party servers](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12212790), accessed 2026-07-10).
4. **Server-side bounded buffer with TTL.** Bound by size/time to avoid unbounded memory.
5. **Exponential backoff + jitter** on reconnect attempts.

**You already have the ideal server primitive: Redis Streams.** Stream entry IDs are natural, durable sequence numbers — persist each chunk as a stream entry and let a reconnecting client resume by last-seen stream ID (this mirrors how SMR resumes SSE by embedding the Redis message id per event, per your gateway design, and aligns with your MEMORY note on tail-final relay). Make the client resume token = `{sessionId, lastRedisId}`.

---

## 6. Noise suppression for ASR — the decisive finding ⚠️

**VERDICT: For a modern Whisper-class STT, do NOT apply aggressive noise suppression by default. The current evidence (2025–2026) is that denoising/enhancement HURTS WER — including in medical ASR, and even on already-clean audio.** VAD (which *segments* audio) is safe and useful; spectral denoising (which *rewrites* the signal, e.g. RNNoise/DeepFilterNet/MetricGAN) is the risk.

**Primary evidence:**
- **Medical, most on-point:** *"When De-noising Hurts: … Speech Enhancement Effects on Modern Medical ASR"* tested Whisper Large-v3, NVIDIA Parakeet-TDT-1.1B, Gemini Flash 2.0, and a healthcare-tuned model on 500 medical recordings × 9 noise conditions with MetricGAN+ denoising. **Result: original noisy audio beat enhanced audio in ALL 40 configurations.** Even on clean audio, denoising added **+1.32–3.19%** semWER; severe cases were catastrophic — background noise @10 dB SNR pushed Whisper **8.82%→25.83%** (+17 pts), and Gaussian noise pushed Gemini **11.2%→57.77%** (+46.6 pts). Authors: enhancement "should not be applied by default… potentially harmful to transcription accuracy" ([arXiv 2512.17562](https://arxiv.org/html/2512.17562), Dec 2025, accessed 2026-07-10).
- **Whisper-specific corroboration:** *"When Denoising Hinders: Revisiting Zero-Shot ASR with SAM-Audio and Whisper"* — SAM-Audio denoising **raised WER/CER across multiple Whisper sizes** on English + Bengali noisy sets despite higher PSNR/perceptual quality; **errors got worse as Whisper size grew**. "Audio perceptually cleaner to humans is not necessarily robust for machine recognition" ([arXiv 2603.04710](https://arxiv.org/abs/2603.04710), Mar 2026, accessed 2026-07-10).
- **Mechanism (Microsoft Research):** suppression's "speech distortion and artifacts… often significantly degrade ASR"; the magnitude/phase tradeoff in the enhancement loss is a fundamental tension, and small edge-deployable models can't escape it ([arXiv 2111.11606](https://arxiv.org/pdf/2111.11606), Nov 2021, accessed 2026-07-10).
- **Why:** Whisper was trained on **680,000 hours** of diverse, real-world (noisy) web audio, giving it built-in robustness to background noise; it's designed to ingest noisy audio directly rather than depend on denoised input ([OpenAI: Introducing Whisper](https://openai.com/index/whisper/), accessed 2026-07-10).

**The counter-case (weaker sources, narrower scope):** RNNoise is cited as giving **15–25% WER improvement in *stationary* noise** and is widely used in WebRTC — but this is from vendor/SEO blogs, not peer-reviewed, and RNNoise "struggles with non-stationary noise (babble, music, transients)" ([picovoice.ai noise-suppression guide](https://picovoice.ai/blog/complete-guide-to-noise-suppression/); [deepgram.com/learn](https://deepgram.com/learn/noise-robust-speech-recognition-techniques) — **both flagged**). The likely reconciliation: light denoising can help *older/traditional* ASR in *steady* noise, but for *modern end-to-end* models (your Whisper-class case) it more often hurts. **Treat "denoising helps" as unproven for your stack until you A/B measure it.**

**RNNoise vs DeepFilterNet vs browser NS vs none:**
- **RNNoise** — tiny (~96k params, ~85k in classic), classic-DSP+RNN hybrid, ~13.3 ms latency in an AudioWorklet (480-sample fixed frame + worklet buffering), single-threaded WASM (no COI needed), battle-tested in Jitsi ([github.com/jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm), accessed 2026-07-10). Realtime-in-browser: **yes, proven.**
- **DeepFilterNet2/3** — heavier deep model, better on complex/non-stationary noise, ~10–20 ms latency; **DFN3 real-time-in-*browser*-WASM is not well documented** — the canonical repo ships Python/Rust real-time on CPU, and browser WASM ports are not clearly production-proven. The detailed "DeepFilterNet3, PESQ 3.5–4.0, 2025/2026 updates" numbers come from an **SEO source (flagged)** — the authoritative artifact is [github.com/Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) + [arXiv 2110.05588 / 2312.12415](https://arxiv.org/pdf/2110.05588) (accessed 2026-07-10). Assume DFN3 needs native/GPU or at least a nontrivial WASM effort; don't assume drop-in browser realtime.
- **Browser built-in `noiseSuppression`** — convenient but a black box you can't tune, can't fully disable in Chrome, and is exactly the "aggressive suppression strips phonemes" class the studies warn about.
- **None** — send the cleanest *unmodified* 16 kHz PCM16 and let the Whisper-class model do the work. **This is the evidence-backed default for ASR quality.**

---

## Recommendations for this browser-capture + WS pipeline (mid-2026)

1. **Re-evaluate — and likely gate/disable — the RNNoise stage for the ASR path.** The 2025–2026 evidence (esp. the medical-ASR study, all-40-configs-worse) says spectral denoising hurts Whisper-class WER, even on clean audio. **Run a controlled A/B on your own consultation audio: RNNoise-on vs RNNoise-off vs browser-NS-off, measured in WER/semWER.** If it doesn't *prove* a win, ship audio **without** denoising. **Keep Silero VAD** — VAD only segments/endpoints, it doesn't rewrite the signal, so it's safe and valuable for chunking/silence-trimming into Redis Streams.

2. **Capture correctly in an AudioWorklet:** mic → AudioWorklet at native 48 kHz → high-quality anti-aliased resample to **16 kHz mono** (libsamplerate/speex WASM) → Int16 PCM. Never ScriptProcessorNode; never naive decimation. Set getUserMedia `{ echoCancellation:{exact:false}, noiseSuppression:{exact:false}, autoGainControl:{exact:true-or-tested} }` to stop the browser silently re-denoising, and verify per-browser that it took effect (Chrome may ignore it).

3. **Keep raw PCM16 @ 16 kHz mono as the default transport; keep WebSocket.** It's the quality-first choice (matches Google's lossless recommendation and OpenAI Realtime's pcm16 stance), keeps your NestJS→Redis Streams path trivial, and traverses clinical firewalls. 256 kbps is fine for wired/decent Wi-Fi.

4. **Add an Opus fallback for constrained networks — kept at ≥24 kbps, never below 16 kbps.** Encode via **WebCodecs `AudioEncoder`** (off-main-thread, HW-accelerated where available) *as progressive enhancement*, with a **libopus-WASM or PCM16 fallback** for Safari <26 and Firefox Android (WebCodecs audio is **not Baseline**). Server-side Opus decode is <1% CPU, so cost is a non-issue; the only cost is ~2% relative WER — acceptable when the alternative is a dropped/janky stream.

5. **Adopt a WebRTC-inspired reliability layer over the WebSocket** without adopting WebRTC: per-chunk monotonic **sequence numbers**, a **resumable session** (`{sessionId, lastRedisStreamId}`, 30–60 s server retention), a **client-side seconds-long PCM history ring buffer** to replay the disconnect gap, and explicit **backpressure via `bufferedAmount`** (throttle/buffer capture — never drop medical audio). Redis Streams entry IDs *are* your durable sequence/resume mechanism — lean on them.

6. **If you must cross-origin-isolate** (for a SharedArrayBuffer worklet↔main ring buffer or multi-threaded onnxruntime-web VAD), serve `COOP: same-origin` + `COEP: credentialless` (friendlier to embeds than `require-corp`). Otherwise stay single-threaded WASM + SIMD (no COI needed) and pass audio via `postMessage`. **SIMD needs no isolation; only threads/SAB do.**

---

## Source-confidence flags

**High confidence (primary):** MDN, W3C, web.dev, Chrome for Developers, caniuse; arXiv **2512.17562**, **2603.04710**, **2111.11606**, **2106.07994**; Microsoft Research; OpenAI; Google Cloud & Deepgram docs; Wikipedia/Xiph/opus-codec.org for Opus specs; GitHub repos (jitsi/rnnoise-wasm, snakers4/silero-vad, ricky0123/vad, SEPIA-Framework, libsamplerate-js).

**Lower confidence — SEO/vendor content, used only for directional color and explicitly flagged in-text:** callsphere.ai, aiadoptionagency.com, forasoft.com, techbytes.app, testmuai.com, novascribe.ai, softcery.com, antmedia.io, picovoice.ai blog, deepgram.com/learn blog.

**Explicitly unverified / needs your own measurement:**
- "RNNoise gives 15–25% WER improvement in stationary noise" — vendor-blog claim, no peer-reviewed primary; scope likely older ASR + steady noise. **Verify against your own audio + Whisper.**
- "DeepFilterNet3" as a distinct release with PESQ 3.5–4.0 / 10–20 ms and drop-in browser-WASM realtime — the perf numbers and browser-realtime claim come from a flagged SEO source; canonical artifact is the Rikorose repo + DFN arXiv papers. **Do not assume drop-in in-browser DFN3.**
- WebCodecs HW-accel CPU figures ("18%→3%", "60–80%") — flagged SEO source; directional only.
- Chrome's degree of honoring `noiseSuppression:false` — known bug reports exist; **verify empirically per target browser.**
