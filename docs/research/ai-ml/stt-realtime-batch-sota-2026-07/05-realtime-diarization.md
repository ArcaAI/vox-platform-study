> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `general-purpose` `a39e0411f3da97612` (sub-agent of 01). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Realtime / Streaming Speaker Diarization — State of the Art, mid-2026

**Bottom line up front:** The field moved fast in the last 12 months. The single most important finding for your clinical STT use case: **modern end-to-end streaming diarization (NVIDIA Streaming Sortformer) now *matches or beats* offline clustering diarization**, overturning the old "streaming costs you 5–15 DER points" rule of thumb. For a self-hosted, 2-speaker doctor/patient pipeline, **NVIDIA Streaming Sortformer is the strongest open, self-hostable option**, and it slots directly into a NeMo transducer ASR pipeline for word/frame-level speaker attribution. Where hardware permits, **stereo channel separation still beats any model** and should be preferred.

---

## 1. NVIDIA Streaming Sortformer

**Primary paper:** *"Streaming Sortformer: Speaker Cache-Based Online Speaker Diarization with Arrival-Time Ordering"*, Medennikov, Park, Wang, Huang, Dhawan, Wang, Balam, Ginsburg — [arXiv:2507.18446](https://arxiv.org/abs/2507.18446), submitted **24 Jul 2025**, accepted to **Interspeech 2025**. Original (offline) Sortformer: [arXiv:2409.06656](https://arxiv.org/html/2409.06656v3) (Sep 2024).

**Architecture:** 17-layer **NEST** encoder (Fast-Conformer based) → 18-layer Transformer (hidden size 192), **~117M params**. The streaming innovation is the **Arrival-Order Speaker Cache (AOSC)**: it stores frame-level acoustic embeddings of previously seen speakers, ordered by arrival time (which is how Sortformer resolves the permutation problem — no permutation-invariant loss needed, it uses "Sort Loss"). The cache is dynamically pruned to keep only high-confidence frames (~188 frames ≈ 15s at 80ms/frame). (paper §3; [v2 model card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2))

**Max speakers: 4** (degrades at ≥5). ([model cards](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1), NVIDIA blog).

### Exact HuggingFace model IDs confirmed to exist (mid-2026) — and their licenses (this matters a lot for a commercial clinical product)

| HF model ID | Role | Params | License | Notes |
|---|---|---|---|---|
| [`nvidia/diar_sortformer_4spk-v1`](https://huggingface.co/nvidia/diar_sortformer_4spk-v1) | **Offline** diarization | 123M | **CC-BY-NC-4.0 (NON-commercial)** ⚠️ | DIHARD3 14.76%, CALLHOME-2spk 5.85%, CH109 6.27% |
| [`nvidia/diar_streaming_sortformer_4spk-v2`](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2) | **Streaming** diarization | 117M | **CC-BY-4.0 (commercial OK)** ✅ | 4 latency modes (below) |
| [`nvidia/diar_streaming_sortformer_4spk-v2.1`](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) | **Streaming** (newest) | 117M | **NVIDIA Open Model License (commercial OK)** ✅ | Meeting-corpus refresh of v2 |
| [`nvidia/multitalker-parakeet-streaming-0.6b-v1`](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1) | **Speaker-attributed streaming ASR** (RNN-T) | 600M | NVIDIA Open Model License | Joint ASR+diarization; see §3 |
| [`FluidInference/diar-streaming-sortformer-coreml`](https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml) | Community CoreML port | — | (derivative) | Apple-silicon on-device |

⚠️ **Licensing gotcha worth flagging up front:** the *offline* Sortformer v1 is **CC-BY-NC (non-commercial)** — unusable in a commercial product — while the *streaming* v2/v2.1 are commercially licensed. So for you, the streaming models are actually the *more* licensable choice. (Verified directly from the raw model-card license fields.)

### Latency modes & real-time factor (v2 — from paper Table 2 and model card; frames are 80ms; quoted latency = input-buffer delay, excludes compute)

| Mode | Latency | RTF (GPU) | Chunk / Right-context |
|---|---|---|---|
| Very high | **30.4 s** | 0.002 (~500× realtime) | 340 / 40 |
| High | **10.0 s** | 0.005 | 124 / 1 |
| Low | **1.04 s** | 0.093 (~11× realtime) | 6 / 7 |
| Ultra-low | **0.32 s** | 0.180 (~5.5× realtime) | 3 / 1 |

RTF ≪ 1 means it's far faster than realtime on a GPU (RTF 0.093 = 1s of audio processed in ~93ms), so the diarizer is cheap; the *latency* number is the look-ahead buffer you deliberately trade for accuracy.

### Published DER (lower = better)
- **v2** @1.04s latency ([v2 card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2)): DIHARD III 1–4spk **13.24%** (full 18.91%); CALLHOME-part2 **2spk 6.57%**, 3spk 10.05%, 4spk 12.44%.
- **v2.1** @1.04s latency ([v2.1 card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)): DIHARD III ≤4spk **15.09%** (full 20.21%); CALLHOME **2spk 6.65%** (full 2–6spk 11.19%); AliMeeting-near **12.6%**; AMI-IHM 16.67%; NOTSOFAR1 ≤4spk 17.26%.
- **v2 vs v2.1 nuance:** v2.1 is *not* uniformly better — it's slightly worse on DIHARD ≤4spk but **much** better on meeting corpora (AliMeeting-near improved from 19.63%→11.73% at 30.4s latency). Treat v2.1 as a meeting/far-field-optimized refresh. For clean 2-party close-mic clinical audio, **v2 and v2.1 are near-identical on the 2-speaker CALLHOME number (~6.6%)**.

### The key streaming-vs-offline result (paper Table)
Streaming Sortformer-AOSC @1.04s latency **beats offline Sortformer**:
- DIHARD III Eval (all spk): **19.02** streaming vs **21.71** offline
- CALLHOME-part2 (all): **11.22** streaming vs **14.25** offline
- CH109 (2-speaker): **5.09** streaming vs **4.86** offline (essentially tied)
- Dropping to 0.32s latency barely moves it: DIHARD **19.32** (from 19.02).

Authors: *"performance expectedly decreases as latency is reduced, [but] the degradation is not severe. Even with a very low latency of 0.32 seconds, the model continues to deliver highly competitive performance."* This directly answers your Q5.

### NeMo/Riva ASR integration (speaker-attributed transcription)
- **Coupling mechanism:** Arrival-Time Sorting (ATS) — speaker tokens from ASR and speaker timestamps from diarization are both sorted by arrival time, resolving the permutation; speaker supervision is injected as **"speaker kernels" into the ASR encoder states**, so ASR and diarization can be jointly trained/fine-tuned. ([NeMo diarization models docs](https://docs.nvidia.com/nemo/speech/nightly/asr/speaker_diarization/models.html))
- **End-to-end streaming recipe:** NeMo's [Streaming_Multitalker_ASR tutorial](https://github.com/NVIDIA-NeMo/Speech/blob/main/tutorials/asr/Streaming_Multitalker_ASR.ipynb) combines `multitalker-parakeet-streaming-0.6b-v1` (ASR) + `diar_streaming_sortformer_4spk-v2` (diarization) at **~1.12s total** end-to-end latency. Attribution is **frame-level** (kernel injection), one model instance per detected speaker.
- **Riva production:** NVIDIA ships a pre-built RMIR combining Parakeet + Sortformer; note the constraint — **Sortformer streaming is supported only with Parakeet-CTC / Conformer-CTC ASR** in Riva streaming mode, and low-latency mode can mislabel overlapping speech ([Riva ASR release notes](https://docs.nvidia.com/nim/riva/asr/1.8.0/release-notes.html)). Production framing (contact centers, "separate agent/customer streams for QA/compliance") is in NVIDIA's [blog, 18 Aug 2025](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/).

**Is there a v2?** Yes — v2 *and* v2.1 both exist and are current as of mid-2026. There is **no v3** that I could verify. (⚠️ I could not pin an exact calendar release date for v2.1 on its card — the v2 paper is Jul 2025; v2.1 appears to be a later-2025/early-2026 checkpoint.)

---

## 2. pyannote — 3.x vs 4.x, streaming, and commercial

**pyannote.audio 4.x IS released.** [`4.0.0` shipped 29 Sep 2025](https://pypi.org/project/pyannote-audio/); latest **`4.0.7` on 30 Jun 2026** (Python 3.10+ required). *(Note: a raw GitHub-releases scrape initially returned 2023/2024 dates — those are wrong; PyPI and the pyannoteAI changelog both confirm Sep 2025 for 4.0.)*

**What changed in 4.0** ([GitHub](https://github.com/pyannote/pyannote-audio), [changelog](https://www.pyannote.ai/changelog)): new open-source pipeline **Community-1**; **VBx clustering** replaces agglomerative clustering (better speaker counting); an **"exclusive/single-speaker" mode** that cleans up ASR↔speaker alignment; ~40% faster training; local/air-gapped pipeline storage; hooks into pyannoteAI premium models.

- **Community-1** ([`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1)): **open-source, self-hostable, but OFFLINE/batch only.** DER ranges ~**7.4% (REPERE) to 51.2% (Ego4D)** across benchmarks — no single headline number; "significant improvement over OSS 3.1" especially on noisy real-world audio.
- ⚠️ **Open-source pyannote.audio has no native streaming.** To stream pyannote you need a wrapper (diart) or the commercial API.

**diart** (the community streaming wrapper, [`juanmc2005/diart`](https://github.com/juanmc2005/diart)): open-source, **v0.9.2 (12 Feb 2025)**, still maintained. Rolling buffer + incremental clustering + overlap-aware segmentation; **adjustable 500ms–5s latency**; seg 8ms / emb 12ms on an RTX 4060. **Caveat:** it recommends `pyannote.audio<3.1` for reproducibility — so diart **lags behind** the 4.x/Community-1 quality curve. It's the mature open path, but not the accuracy frontier.

**pyannoteAI commercial** (API only, **not self-hostable** — likely a non-starter for your PHI posture, but as reference points, from the [changelog](https://www.pyannote.ai/changelog)):
- **Precision-2** (API, 2 Sep 2025): +14% vs Precision-1, **+28% vs OSS 3.1**.
- **Streaming beta** (4 May 2026): **~300ms** latency, "same accuracy as Precision-2", **max 8 speakers**, 10 parallel streams.
- **Live-1 GA** (7 Jul 2026): **<300ms**, purpose-built for streaming (not retrofitted batch), WebSocket API, €0.198/hr.

---

## 3. Speaker-attributed streaming ASR — joint vs post-hoc

Two paradigms:
- **Post-hoc alignment** (diarize + ASR separately, align by timestamp): e.g., diart + streaming Whisper, or whisperX-style. Simple, modular, but speaker boundaries and word boundaries are reconciled *after the fact* — error-prone at turn boundaries and on overlap.
- **Joint / tightly-coupled** (the frontier): NVIDIA's Sortformer approach injects speaker kernels into the ASR encoder so **the ASR is speaker-aware natively**. `multitalker-parakeet-streaming-0.6b-v1` is a **native RNN-T transducer** (600M, English) doing exactly this — cpWER 15.81–37.44 on multi-talker sets, ~7.44% single-speaker WER, streaming look-ahead configs from **0.08s to 1.12s** ([model card](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1)). **This is directly relevant to your native-transducer pilot** — it's the transducer + Sortformer joint recipe, already packaged.
- **Target-speaker without enrollment:** *"Speaker Targeting via Self-Speaker Adaptation for Multi-talker ASR"* ([arXiv:2506.22646](https://arxiv.org/pdf/2506.22646), same NVIDIA team, Jun 2025) adapts to a speaker on-the-fly, no enrollment sample needed — conceptually attractive for 2-party clinical. Older token-level SA-ASR reference: [arXiv:2203.16685](https://arxiv.org/pdf/2203.16685).

---

## 4. Practical 2-speaker doctor/patient approaches

- **Channel separation wins when you can get it.** If clinician and patient are captured on **separate channels** (stereo, dual-mic, or telehealth where each party is a distinct RTP stream), diarization becomes *trivial and error-free* — you run ASR per channel and the "who spoke" label is the channel itself, **zero DER**. This is standard call-center/telephony practice (NVIDIA explicitly frames Sortformer's alternative as "separate agent/customer streams"). ⚠️ I could not find a *clinical-specific published DER* for stereo separation, but the argument is first-principles: a hardware channel boundary is a perfect speaker boundary. **Recommend this as the default whenever the room/telehealth setup allows it.**
- **Single ambient mic (one room, one mic):** you need model-based diarization. Here 2-speaker is the *easy* regime — Sortformer hits ~**5% DER on the 2-speaker CH109 set**, near its offline ceiling.
- **Speaker enrollment / target-speaker:** the clinician's voice is known and stable across visits — enroll it once, and "not-clinician" = patient. Robust and simple for strictly 2-party.
- **Does "just 2 speakers" simplify streaming meaningfully? Yes.** No speaker-count estimation, the permutation is binary, and the online-vs-offline accuracy gap is *smallest* at 1–2 speakers (it widens with >2 speakers, per the paper). Your constrained 2-speaker problem is close to the best case for streaming diarization.

---

## 5. Latency / accuracy tradeoffs (summary)

- **Achievable streaming diarization latency in mid-2026:** ~**300ms–1s** at production quality (Sortformer 0.32s/1.04s; pyannoteAI Live-1 <300ms; AssemblyAI Universal-3 Pro Streaming ~307ms P50 per [Hamming.ai bench](https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis)).
- **Streaming no longer necessarily degrades vs offline.** The old "streaming is 5–15 DER points worse" held for *clustering-based* online systems; end-to-end AOSC broke that — streaming Sortformer *beats* offline Sortformer (§1). The wider offline advantage persists mainly for **many-speaker** clustering, not 2–4 speaker end-to-end.
- **Real bottleneck is turn/endpoint detection, not diarization compute.** As AssemblyAI put it: *"the biggest delay isn't the diarization — it's waiting for someone to finish talking."* Budget your latency around VAD/turn-detection, not the diarizer.

---

## Realtime diarization options — comparison

| Option | Approach | Streaming latency | DER / quality | Max spk | Self-hostable | Maturity | Source |
|---|---|---|---|---|---|---|---|
| **NVIDIA Streaming Sortformer v2 / v2.1** | E2E neural, Arrival-Order Speaker Cache | 0.32s / 1.04s / 10s / 30.4s (tunable) | CALLHOME-2spk **~6.6%**; DIHARD 1–4spk 13–15%; **beats offline** | 4 | ✅ **Yes** (CC-BY-4.0 / NVIDIA OML — commercial OK) | **High** (Riva/NeMo prod) | [v2](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2), [v2.1](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1), [arXiv 2507.18446](https://arxiv.org/abs/2507.18446) |
| **NeMo Multitalker Parakeet + Sortformer** | Joint speaker-attributed streaming ASR (RNN-T) | ~1.12s e2e | cpWER 15.8–37.4 (multi-talker); 7.4% WER 1-spk | 4 | ✅ Yes (NVIDIA OML) | Medium-High | [model card](https://huggingface.co/nvidia/multitalker-parakeet-streaming-0.6b-v1), [tutorial](https://github.com/NVIDIA-NeMo/Speech/blob/main/tutorials/asr/Streaming_Multitalker_ASR.ipynb) |
| **diart (pyannote wrapper)** | Rolling buffer + incremental clustering | 0.5–5s | ~pyannote 3.x-era (lags 4.x) | flexible | ✅ Yes (MIT/open) | Medium (v0.9.2, Feb 2025) | [GitHub](https://github.com/juanmc2005/diart) |
| **pyannote.audio 4.x / Community-1** | E2E seg + VBx clustering | **Offline only** (no native streaming) | DER 7.4–51% by set; strong offline | flexible | ✅ Yes (open, MIT) | High (offline) | [HF](https://huggingface.co/pyannote/speaker-diarization-community-1), [PyPI](https://pypi.org/project/pyannote-audio/) |
| **pyannoteAI Live-1 / Streaming** | Purpose-built streaming, commercial | **<300ms** | "= Precision-2" (+28% vs OSS 3.1) | 8 | ❌ API only | High (GA Jul 2026) | [changelog](https://www.pyannote.ai/changelog) |
| **AssemblyAI Universal-3 Pro Streaming** | Commercial streaming + turn detection | ~307ms P50 | 2.9% speaker-count err; cpWER-based | 1–10 (stream) | ❌ API only | High (public beta) | [blog](https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis) |
| **Stereo / dual-channel separation** | Hardware channel = speaker | ~0 (channel routing) | **~0% DER** (perfect if isolated) | = #channels | ✅ Yes (your infra) | Highest (trivial) | first-principles; NVIDIA "separate streams" framing |

⚠️ One source ([AssemblyAI "Top 8" blog](https://www.assemblyai.com/blog/top-speaker-diarization-libraries-and-apis)) labels NeMo and pyannote "batch-only" — that's **outdated/misleading**: streaming Sortformer is explicitly a self-hostable streaming diarizer. Treat that blog's self-hosting/streaming column with caution.

---

## Recommendation — best 2-speaker streaming diarization for self-hosted clinical STT (mid-2026)

- **Prefer stereo/dual-channel capture wherever the room or telehealth setup allows it** — a hardware channel boundary is a perfect, zero-latency, zero-DER speaker label, and it sidesteps model risk, PHI-model-licensing questions, and overlap errors entirely. Fall back to model-based diarization only for true single-mic ambient capture.
- **For single-mic capture, adopt NVIDIA Streaming Sortformer `v2` (CC-BY-4.0) or `v2.1` (NVIDIA OML)** — both self-hostable, commercially licensed, GPU-cheap (RTF ~0.09), and at ~**6.6% DER on 2-speaker** they're near their own offline ceiling. Run the **1.04s low-latency mode** (best accuracy/latency balance) or 0.32s if you need sub-second labels for barely more DER. **Avoid the offline `diar_sortformer_4spk-v1` — it's CC-BY-NC (non-commercial).**
- **If you want tight word-level speaker attribution rather than post-hoc alignment, pilot the joint `multitalker-parakeet-streaming-0.6b-v1` (RNN-T) + Sortformer recipe** — it's a native transducer with speaker-kernel injection, exactly the architecture your native-transducer pilot is heading toward, and gives speaker-attributed streaming transcription at ~1.1s end-to-end in one NeMo pipeline. Watch the Riva constraint (Sortformer streaming pairs with CTC ASR there) and validate that transducer+Sortformer path in NeMo directly.
- **Consider speaker enrollment of the clinician** as a cheap robustness boost for the strict 2-party case (clinician voice is known/stable → "not clinician" = patient); the self-speaker-adaptation line ([arXiv:2506.22646](https://arxiv.org/pdf/2506.22646)) offers an enrollment-free variant worth tracking.
- **Skip the pyannote streaming path for the frontier use case:** open-source pyannote 4.x/Community-1 is offline-only, and diart (its streaming wrapper) is pinned to the older pyannote <3.1 quality tier. pyannote.audio 4.x is an excellent *offline/batch* option (e.g., for re-processing recordings), just not your realtime engine. pyannoteAI Live-1 (<300ms) and AssemblyAI are strong but **API-only** — likely disqualified by self-hosting/PHI requirements.

**Explicitly flagged as unverifiable / uncertain:** exact calendar release date of Streaming Sortformer **v2.1** (not on the card); a clinical-specific published DER for stereo channel separation (argued from first principles, not a cited benchmark); a single aggregate DER for Community-1 (varies 7.4–51% by dataset); the precise HF-publish date of `multitalker-parakeet-streaming-0.6b-v1` (paper timestamp ~27 Jun 2025 used as proxy). No **v3** Sortformer found as of this research (10 Jul 2026).
