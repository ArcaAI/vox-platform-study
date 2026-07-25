> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `researcher` `a18021d3ec8885ce8` (top-level, independent pass on model quality/licensing). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Mid-2026 State of the Art: Self-Hostable ASR for Clinical Transcription

*Research date: 2026-07-10. Every claim carries an inline source + date. Numbers from SEO/marketing blogs are cross-checked against primary sources (Hugging Face model cards, arXiv, vendor announcements) wherever possible; residual uncertainties are flagged in the "Verification flags" section at the end.*

## Executive summary

The open-ASR frontier has moved decisively past Whisper. As of mid-2026 the accuracy leader among open, self-hostable English models is **IBM Granite-Speech-4.1-2B (5.33% mean WER on the Open ASR Leaderboard, Apr 2026)**, with **NVIDIA Canary-Qwen-2.5B (5.63%)** close behind; both beat every proprietary system measured on that leaderboard. For your multilingual (English + European) clinical requirement, the two most relevant open models are **NVIDIA Parakeet-TDT-0.6B-v3** and **Canary-1B-v2** (both 25 EU languages, native word timestamps, and — critically — trained with non-speech audio so they almost never hallucinate on silence), plus **Whisper large-v3 / large-v3-turbo** as the 99-language safety net. **The single most important clinical caveat**: general WER is a poor proxy for clinical safety — on the PriMock57 medical benchmark, fast transducer models like Parakeet post a **22% Drug M-WER** (0.6B-v3), which is unacceptable for medication capture, while the best small open model for clinical terms is **Qwen3-ASR-1.7B (4.40% Medical-WER)**. A production clinical stack in 2026 should therefore be model-plural (a fast multilingual workhorse + a clinical-accuracy pass + a streaming model), hardened with VAD gating and logprob/compression-ratio triage, and measured with medical-concept metrics, not raw WER alone.

---

## (a) Comparative model table

RTFx = seconds-of-audio processed per second of wall-clock (higher is faster; leaderboard RTFx is measured on an NVIDIA A100-class GPU, batch-dependent — see flags). "M-WER" = Medical WER on PriMock57 (Omi Health v4, Apr 8 2026). WER columns are the Open ASR Leaderboard English datasets unless noted.

| Model (checkpoint, date) | License | Langs | Params | Open-ASR avg WER | LibriSpeech clean / other | AMI | Earnings-22 | PriMock57 M-WER (clinical) | RTFx | Streaming? | Native biasing? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **IBM Granite-Speech-4.1-2B** (Apr 30 2026) | Apache-2.0 | en/fr/de/es/pt/ja | ~2B | **5.33%** (leaderboard #1) | — | — | — | not in Omi table | AR: moderate; **NAR: ~1820 (H100)** | No | **Yes (keyword-biased ASR)** |
| **NVIDIA Canary-Qwen-2.5B** (Jul 17 2025) | CC-BY-4.0 | English only | 2.5B | **5.63%** | 1.60% / — | 10.18% | 10.42% | not top-ranked | 418 (A100/A6000/5090) | No | No |
| IBM Granite-Speech-3.3-8B (mid-2025) | Apache-2.0 | en(+fr/de/es/pt) | ~8B | 5.76–5.85% | — | — | — | — | low | No | No |
| **NVIDIA Canary-1B-v2** (Aug 2025) | CC-BY-4.0 | **25 EU** + AST | ~1B (978M) | ~5.9% class | — | — | — | 1B-Flash: 5.97% (#21) | high (~1000+ RTFx class) | No | No |
| **NVIDIA Parakeet-TDT-0.6B-v3** (Aug 14 2025) | CC-BY-4.0 | **25 EU** | 600M | **6.34%** (v3); ~6.32% avg | 1.93% / 3.59% | 11.31% | 11.42% | **Drug M-WER 22% (weak)** | **~3,300× (batch)** | Yes (chunked) | No |
| Parakeet-TDT-1.1B / CTC-1.1B | CC-BY-4.0 | English | 1.1B | 6.43–6.68% | — | — | — | 1.1B: 5.20% M-WER, **15.5% Drug** | **2,793–3,380×** | Yes (RNN-T) | via NeMo word-boosting |
| **Whisper large-v3** (Nov 2023) | MIT | 99 | 1.55B | ~7.44% | 1.84% / 3.66% | ~16% | 13.07% | whisper-1 API: 5.62% (#19) | 68.56 (leaderboard) | No (chunk hacks) | initial_prompt only |
| **Whisper large-v3-turbo** (Oct 2024) | MIT | 99 (no translate) | 809M | ~7.75% | ~2% | — | — | — | 216× | No | initial_prompt only |
| distil-large-v3.5 (Apr 14 2026) | MIT | English | 756M | ~7.4% | — | — | — | — | ~1.5× turbo | No | initial_prompt |
| CrisperWhisper (Aug 2024, nyrahealth) | CC-BY-NC (check) | en/de focus | 1.55B | verbatim SOTA (TED/AMI) | — | best verbatim | — | — | ~large-v3 | No | initial_prompt |
| **Qwen3-ASR-1.7B** (Feb 2026) | Apache-2.0 | **52** | 1.7B | strong | offline 3.38 / stream 4.51 (other) | — | — | **4.40% (best small open)** | ~7s/file on A10 | **Yes** | LLM-prompt context |
| Qwen3-ASR-0.6B (Feb 2026) | Apache-2.0 | 52 | 0.6B | best acc/eff small | — | — | — | — | faster | Yes | LLM-prompt |
| **Kyutai STT-2.6B-en** / 1B-en_fr (Jun 2025) | CC-BY-4.0 | en / en-fr | 2.6B / 1B | competitive | — | — | — | — | H100: 400 streams RT | **Native streaming** | No |
| **Voxtral-Mini-4B-Realtime-2602** (Feb 4 2026) | Apache-2.0 | 13 | 4B | ~Whisper at 480ms | — | — | — | — | 16GB GPU; 80ms–2.4s delay | **Native streaming (vLLM)** | No |
| Voxtral-Mini-3B / Small-24B-2507 (Jul 15 2025) | Apache-2.0 | 8+ | 3B / 24B | > Whisper-lv3 | — | — | — | Mini-Transcribe-V1: 5.17% (#14) | good | No | prompt |
| VibeVoice-ASR 9B | Open (check) | multi | 9B | — | — | — | — | **3.16% (best OPEN)** | slow | No | — |
| Moonshine v2 / streaming (tiny/small/med) (2024–2026) | MIT | English | 27M+ | competitive edge | — | — | — | — | edge/CPU | **Streaming** | No |
| Meta Omnilingual ASR (Nov 2025) | Apache-2.0 | **1600+ (→5400 zero-shot)** | up to 7B | CER<10% in 78% langs | — | — | — | — | family varies | No | in-context |

**Commercial baselines (quality ceilings, not self-hostable):** Google Gemini 3 Pro **2.65% M-WER** (best overall on PriMock57); Deepgram Nova-3 Medical **4.53% M-WER** (9.05% WER) on Omi vs. its own marketing claim of "3.45% median WER"; AssemblyAI Universal-3 Pro 4.02%; ElevenLabs Scribe v2 3.86%; Soniox 3.32%; Microsoft MAI-Transcribe-1 4.85%; OpenAI GPT-4o transcribe family (API-only). (Omi Health, updated Apr 8 2026, https://omi.health/research/stt-benchmark)

---

## 1. Open / self-hostable ASR model landscape (mid-2026)

**Hugging Face Open ASR Leaderboard** is the canonical English reference and now has multilingual + long-form tracks. As of the paper's v4 (arXiv:2510.06961, submitted Oct 8 2025, updated Mar 30 2026, https://arxiv.org/abs/2510.06961) it compares **86 systems across 12 datasets**; the accompanying blog (Nov 21 2025, https://huggingface.co/blog/open-asr-leaderboard) states the structural finding you should internalize: **Conformer encoders + transformer/LLM decoders win on WER; CTC and TDT (token-and-duration transducer) decoders win on RTFx by 10–100×.** English datasets scored: LibriSpeech clean/other, TED-LIUM, AMI, GigaSpeech, Earnings-22, SPGISpeech, VoxPopuli.

- **Whisper family (OpenAI).** `large-v3` (Nov 2023, MIT, 1.55B, 99 langs) and `large-v3-turbo` (Oct 2024, MIT, 809M — decoder pruned 32→4 layers, ~6× faster, transcription-only, "minor quality degradation" but notably worse on Thai/Cantonese) remain the newest **open** OpenAI checkpoints (https://huggingface.co/openai/whisper-large-v3-turbo; discussion https://github.com/openai/whisper/discussions/2363). **There is no open Whisper successor.** OpenAI's newer transcription models — `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` (from Mar 2025) — are **API-only, not open-weights** (https://diyai.io/ai-tools/speech-to-text/reviews/openai-whisper-review/, 2026). Treat "Whisper successor" rumors as unconfirmed; the facts are: OpenAI's own trajectory is closed, and the open frontier has been taken over by NVIDIA/IBM/Alibaba/Mistral.

- **faster-whisper / CTranslate2 (SYSTRAN).** Actively maintained (https://github.com/SYSTRAN/faster-whisper). `BatchedInferencePipeline` is a drop-in replacement for `WhisperModel.transcribe` and reaches **~250× realtime on an RTX 4090 (large-v3, batch=16)** (https://knightli.com/en/2026/05/01/faster-whisper-speech-to-text/, May 2026). Note the hard dependency: recent CTranslate2 needs **CUDA 12 + cuDNN 9**. This is still the pragmatic default for self-hosted Whisper batch.

- **WhisperX (m-bain).** Still maintained; wraps faster-whisper + VAD + wav2vec2 forced alignment + pyannote diarization (https://github.com/m-bain/whisperX/releases). Recent commits added `progress_callback` and word-timestamp fixes. Caveat repeatedly noted: the wav2vec2 aligner is **less noise-robust than Whisper itself**, so word timings degrade faster than the transcript on noisy phone audio.

- **distil-whisper.** Newest is **`distil-large-v3.5`** (updated Apr 14 2026, MIT, 756M, English-only), trained on 98k h with a "patient" teacher + aggressive SpecAugment, ~**1.5× faster than large-v3-turbo**, marketed as a drop-in (https://huggingface.co/distil-whisper/distil-large-v3.5).

- **NVIDIA Parakeet-TDT-0.6B-v3** (Aug 14 2025, CC-BY-4.0, 600M, FastConformer-TDT). Extends v2 from English to **25 European languages** with auto language detection; trained on **Granary (660k pseudo-labeled h) + NeMo ASR Set 3.0 (10k human h)**; Open-ASR avg **6.34% WER**; LibriSpeech clean/other **1.93%/3.59%**, AMI 11.31%, Earnings-22 11.42%; native **word + segment timestamps**, punctuation/capitalization; up to 24 min (full attention, A100-80GB) or 3 h (local attention); chunked streaming (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). The **1.1B CTC** sibling is the throughput champion (**RTFx 2,793.75** vs Whisper large-v3's 68.56 on the leaderboard).

- **NVIDIA Canary** — three relevant checkpoints, all CC-BY-4.0: **Canary-1B-Flash** (883M, 4 langs en/de/fr/es, >1000 RTFx); **Canary-1B-v2** (Aug 2025, ~978M–1B, **25 EU languages, ASR+bidirectional AST**, trained 1.7M h with non-speech audio added to cut hallucinations, https://huggingface.co/nvidia/canary-1b-v2); **Canary-Qwen-2.5B** (Jul 17 2025, SALM = FastConformer encoder + Qwen3-1.7B decoder + LoRA, **English-only**, **5.63% avg WER**, LibriSpeech-clean 1.60%, AMI 10.18%, RTFx 418; https://huggingface.co/nvidia/canary-qwen-2.5b). Reference paper: arXiv:2509.14128 (Sep 2025).

- **Kyutai STT** (open-sourced Jun 2025, CC-BY-4.0): `stt-1b-en_fr` (~1B, 0.5s delay, semantic VAD) and `stt-2.6b-en` (2.6B, 2.5s delay). **Delayed-streams-modeling** architecture; native streaming with **word-level timestamps**; batching for **~400 real-time streams on one H100**; production Rust websocket server (https://kyutai.org/stt/, https://github.com/kyutai-labs/delayed-streams-modeling). Strong candidate for the realtime path.

- **Mistral Voxtral.** Two generations: (1) **Voxtral Small-24B-2507 / Mini-3B-2507** (Jul 15 2025, Apache-2.0, open weights, speech-understanding LLMs; "Voxtral Mini Transcribe" is the transcribe-optimized variant; arXiv:2507.13264, https://mistral.ai/news/voxtral/). (2) **Voxtral Transcribe 2** (Feb 4 2026, https://mistral.ai/news/voxtral-transcribe-2/): a **batch** model *Voxtral Mini Transcribe V2* (API-only — word timestamps + diarization + **context biasing up to 100 words** + 13 langs + up to 3h + ~4% FLEURS WER, $0.003/min) and a **streaming** model **`Voxtral-Mini-4B-Realtime-2602`** which **is open-weights (Apache-2.0), 4B, 13 langs, <500ms delay (configurable 80ms–2.4s), runs on a single ≥16GB GPU, official vLLM Realtime support** (arXiv:2602.11298, https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602). Note the split: the *streaming* model is self-hostable; the *batch/diarization* model is not.

- **Qwen3-ASR (Alibaba)** — technical report arXiv:2601.21337 (Feb 2026). **`Qwen3-ASR-1.7B` and `-0.6B`, Apache-2.0, 52 languages**, built on Qwen3-Omni; supports language ID + timestamp prediction; ships a vLLM-based inference framework (batch/async/streaming). 1.7B streaming: LibriSpeech-other WER **4.51 (stream) vs 3.38 (offline)**; best on FLEURS 12/20-lang subsets but degrades vs Whisper-large-v3 on the full 30-lang set (https://github.com/QwenLM/Qwen3-ASR). **This is the standout small open model for clinical accuracy** (see §2).

- **IBM Granite Speech.** `granite-speech-3.3-8b` topped the leaderboard in mid-2025 (~5.76–5.85%). The **4.1 generation (Apr 30 2026, Apache-2.0, ~2B)** is the current open leader: **`granite-speech-4.1-2b` = 5.33% mean WER**, plus a **`-2b-NAR` (non-autoregressive)** variant that edits a CTC hypothesis in one forward pass for **RTFx ~1820 on a single H100**, and a **"Plus"** variant with keyword-biased ASR. Langs: en/fr/de/es/pt/ja (NAR drops ja) (https://huggingface.co/ibm-granite/granite-speech-4.1-2b; https://www.marktechpost.com/2026/04/30/ibm-releases-two-granite-speech-4-1-2b-models...).

- **Moonshine v2 (Useful Sensors)** — edge/on-device streaming ASR; "ergodic" sliding-window encoder, no positional embeddings; tiny/small/medium; added to HF Transformers Feb 3 2026 (arXiv:2602.12241, https://huggingface.co/docs/transformers/model_doc/moonshine_streaming). English-only, sub-1GB memory — relevant only if you ever need a CPU/edge fallback.

- **Major 2026 releases you'd otherwise miss:** **Meta Omnilingual ASR** (Nov 2025, Apache-2.0, arXiv:2511.09690, https://github.com/facebookresearch/omnilingual-asr) — **1600+ languages natively, extensible to 5400+ via zero-shot in-context learning**, 4.3M h training, wav2vec2/CTC/LLM-ASR families incl. a 7B model, CER<10% in 78% of languages. Not clinically tuned, but the definitive answer for long-tail language coverage. **VibeVoice-ASR 9B** appears as the **best open model on the PriMock57 clinical benchmark (3.16% M-WER)** — worth tracking though it is large.

**Current leaderboard bottom line:** best open English accuracy = Granite-4.1-2B (5.33%) ≈ Canary-Qwen-2.5B (5.63%); best open multilingual-EU with timestamps = Parakeet-TDT-0.6B-v3 / Canary-1B-v2; best open clinical-term accuracy = Qwen3-ASR-1.7B / VibeVoice-ASR; best 99-language coverage = Whisper large-v3; best long-tail = Meta Omnilingual.

---

## 2. Medical / clinical ASR

**Benchmark that matters:** the **Omi Health Medical STT Benchmark** (v4, updated Apr 8 2026, originally Jul 29 2025, https://omi.health/research/stt-benchmark) runs **PriMock57** (55 simulated British-English GP consultations, ~80.5k words; Babylon Health, arXiv:2204.00333) and ranks 42 models by **Medical WER (M-WER)** — errors counted only on clinically relevant words (drugs, conditions, symptoms, anatomy, procedures) — plus a separately reported **Drug M-WER** for patient-safety weight. Top results:

| Rank | Model | WER | M-WER | Drug M-WER | Type |
|---|---|---|---|---|---|
| 1 | Google Gemini 3 Pro | 8.35% | **2.65%** | 3.1% | API |
| 3 | **VibeVoice-ASR 9B** | 8.34% | **3.16%** | 5.6% | **Open** |
| 8 | **Qwen3-ASR 1.7B** | 9.00% | **4.40%** | 8.6% | **Open** |
| 9 | Deepgram Nova-3 Medical | 9.05% | 4.53% | 9.7% | API |
| 15 | Parakeet TDT 1.1B | 9.03% | 5.20% | **15.5%** | Open |
| ~19 | OpenAI whisper-1 (API) | 13.20% | 5.62% | — | API |
| 21 | NVIDIA Canary 1B-Flash | — | 5.97% | — | Open |
| — | Parakeet TDT 0.6B-v3 | — | — | **~22% (weak)** | Open |

Key clinical takeaways: (i) **general WER ≠ clinical safety** — Parakeet is fastest but its **Drug M-WER (15.5–22%) is likely unacceptable for medication capture**; (ii) **Qwen3-ASR-1.7B is the best small open clinical model** ("4.40% M-WER at ~7s/file on an A10"); (iii) the Omi team found **two text-normalizer bugs "quietly inflating WER by 2–3% across every model in the industry"** — a direct warning for your eval harness (see §6); (iv) the Whisper row is the hosted `whisper-1` (≈large-v2), **not** local large-v3-turbo, so don't read it as Whisper's ceiling.

**Other medical corpora:** PriMock57 (primary, British English); **MMEDFD** (real-world multi-turn healthcare, arXiv:2509.19817); **ACI-Bench** (ambient clinical note generation, arXiv:2306.02022) — used with the **MEDCON** concept metric (§6); domain-adapted endoscopy ASR (arXiv:2604.01705, Apr 2026); Greek medical dictation (arXiv:2509.23550). "The Sound of Healthcare" (arXiv:2402.07658) and "Multicultural Medical Assistant" (arXiv:2501.15310) show **LLM post-correction lifts medical-term accuracy** on PriMock57.

**Open medical fine-tunes worth knowing** (all Hugging Face): **`Na0s/Medical-Whisper-Large-v3`** (fine-tuned on PriMock doctor/patient data — most directly relevant); `mahendra0203/whisper-medium-medical`; `Johnyquest7/whisper-small-finetuned-medical3`; `pr0mila-gh0sh/MediBeng-Whisper-Tiny` (Bengali-English code-switch clinical). Reality check on fine-tuning gains: one study reduced Whisper-small WER from ~63%→32% on medical audio — "clinician-in-the-loop assistant, not unsupervised" (ResearchGate 401022706, 2026).

**LoRA fine-tuning practice** (Whisper/Parakeet domain adaptation): LoRA trains ~0.1–1% of parameters, cheap enough for on-prem GPUs; the common recipe adapts Whisper-large-v3 with **synthetic medical audio-text pairs** then validates on real recordings, retaining general ASR while injecting terminology (https://medium.com/@anitaliubfsu/fine-tuning-whisper-with-lora-c796781f00f5; survey Preprints 202502.1637). Canary/Parakeet fine-tune via the NeMo framework.

**Contextual biasing / hotword boosting per engine** (your cheapest clinical win — a drug/formulary list without retraining):
- **Whisper / faster-whisper**: `initial_prompt` biases the decoder, but **only the last 224 tokens are consumed** — keep it compact, rare terms near the end. faster-whisper also exposes a `hotwords` param (https://arxiv.org/pdf/2410.18363). Multitask contextual-biasing training exists (arXiv:2309.09552) but needs fine-tuning.
- **NeMo Parakeet/Canary**: **word boosting** via a CTC-based Word Spotter / context graph, and shallow-fusion phrase boosting for RNN-T/TDT — **no retraining, just a phrase list** (https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/asr_customization/word_boosting.html). See also **TurboBias** (arXiv:2508.07014) — GPU-accelerated phrase-boosting tree for universal context biasing.
- **IBM Granite 4.1 "Plus"**: native **keyword-biased ASR**.
- **Voxtral Mini Transcribe V2 / Deepgram Nova-3 Medical**: **context biasing / Keyterm Prompting up to 100 terms** (both API-side).

**Commercial reference points (quality ceilings, keep for benchmarking, not adoption given PHI):** Deepgram **Nova-3 Medical** (HIPAA-compliant, Keyterm Prompting 100 terms, marketing "3.45% median WER" but 4.53% M-WER independently; https://deepgram.com/learn/introducing-nova-3-medical-speech-to-text-api); AssemblyAI Universal-3 Pro; **Microsoft MAI-Transcribe-1** and Azure healthcare STT; AWS HealthScribe / Transcribe Medical; Google Gemini 3 Pro (the accuracy ceiling at 2.65% M-WER). Independent WER for Azure/AWS medical endpoints was **not verified** here beyond the Omi Microsoft entry.

---

## 3. Anti-hallucination & quality hardening (Whisper-class in production)

**Failure modes** (well documented, clinically dangerous): on **silence / music / non-speech**, autoregressive Whisper fabricates fluent text ("Thank you for watching", "Please subscribe"); it also enters **repetition loops**. A 2024 study found Whisper hallucinated in ~1% of transcriptions, sometimes inventing medications/violence; long pauses (aphasia, elderly patients) are a top trigger (Science/AAAS, https://www.science.org/content/article/ai-transcription-tools-hallucinate-too; Healthcare Brew Nov 2024). Root-cause work: "Investigation of Whisper ASR Hallucinations Induced by Non-Speech Audio" (arXiv:2501.11378, Jan 2025).

**Baseline mitigations (do all of these):**
- **VAD gating** — run Silero/pyannote VAD first and only feed speech regions to the model (what WhisperX does). Removes most silence-triggered hallucinations at the pipeline level.
- **Decoder triage** — the three built-in signals in `whisper/transcribe.py`: `no_speech_threshold` (drop segments the model itself flags as non-speech), `logprob_threshold`/`avg_logprob` (low confidence → reject), `compression_ratio_threshold` (high gzip ratio ⇒ repetitive output ⇒ failed). Use them together (https://github.com/openai/whisper/blob/main/whisper/transcribe.py).
- **Temperature fallback** — pass a temperature tuple `(0.0, 0.2, …, 1.0)`; on a compression-ratio or logprob failure the decoder retries at higher temperature.
- **`condition_on_previous_text=False`** — the standard anti-loop switch: stops runaway repetition at the cost of some cross-window coherence (long-form flow). For clinical audio the safety tradeoff favors `False`.
- **Chunking / `beam_size=1`** — smaller windows + greedy/low-beam decoding reduce hallucination surface (some evidence lowest hallucination at beam=1).

**Newer 2025–2026 techniques:**
- **Calm-Whisper** (arXiv:2505.12969, May 2025) — identifies the small subset of large-v3 decoder self-attention heads responsible for non-speech hallucination and masks them; near-baseline WER.
- **SAE / hidden-representation steering** (arXiv:2606.07473, Jun 2026) — hallucination info is linearly separable in encoder activations; **SAE latent-space steering cuts the non-speech hallucination rate from 86.88%→27.33% for large-v3** with small WER cost, approaching fine-tuning-quality without retraining.
- **Silence-conditional output suppression** (training-free) — uses Whisper's internal non-speech signal to suppress output, reported **−39.9 pp hallucination rate** at near-baseline WER (analemma preprint, Feb 2026 — *secondary source, flagged*).
- **Choose a transducer model to sidestep the problem**: Canary "generates 16.7% fewer hallucinated characters than Whisper-large-v3" and 26% fewer again with noise-robust training; **Parakeet-TDT-0.6B-v3 "almost never hallucinates text during silence"** because it was trained on 36k+ h of noisy/non-speech audio (arXiv:2509.14128; https://www.arunbaby.com/speech-tech/0073-whisper-vs-parakeet-asr-decision/). This is a strong argument for a CTC/TDT primary model in a clinical setting.
- **LLM post-editing / GEC with constrained edits** — "Generative Speech Error Correction" (GenSEC) surveys (arXiv:2508.07285); **constrained decoding over the N-best** (FlanEC arXiv:2501.12979; N-best T5) prevents the LLM from inventing content; "Judge-Editor" preserves reliable spans and only rewrites uncertain ones. For medicine specifically, LLM correction improved medical-term accuracy on PriMock57 (arXiv:2402.07658, 2501.15310). **Warning: LLM correctors are themselves a hallucination source** — constrain them (N-best selection, span-preservation) and never let them free-generate clinical facts.

---

## 4. Word-level timestamps & alignment

- **Native model timestamps** are now the low-friction default: **Parakeet-TDT-v3, Canary, Qwen3-ASR, Kyutai STT** all emit **word + segment timestamps directly** from the transducer/CTC path — accurate and cheap, no second model. Prefer these when your primary model is one of them.
- **faster-whisper word timestamps** use cross-attention DTW; usable but coarser and prone to drift on long/noisy audio.
- **WhisperX** = faster-whisper + **wav2vec2 forced alignment** + pyannote. Improves word-timing precision but the wav2vec2 aligner is **less noise-robust than Whisper**, so on noisy phone/clinic audio the timestamps degrade faster than the words (https://github.com/m-bain/whisperX).
- **NeMo Forced Aligner (NFA)** — standalone CTC + Viterbi aligner producing token/word/segment timestamps; the natural choice when your stack is already NeMo (Parakeet/Canary). Recent word-timestamp work reports **80–90% precision/recall with 20–120 ms timestamp error** (arXiv:2505.15646; https://docs.nvidia.com/nemo-framework/.../nemo_forced_aligner.html).
- **torchaudio forced alignment** — multilingual CTC aligner; a **CUDA Viterbi kernel** landed (nightly) but isn't always faster than NFA's tensor implementation (https://docs.pytorch.org/audio/2.8/tutorials/forced_alignment_for_multilingual_data_tutorial.html).
- **CrisperWhisper** (arXiv:2408.16589) — retokenizes Whisper + DTW on cross-attention for **crisp verbatim word timestamps and filler detection ("um"/"uh")**, tops the leaderboard's **verbatim** (TED/AMI) track and adds hallucination robustness. From **nyrahealth** (a health company) — clinically relevant if you need verbatim/disfluency capture.
- **Accuracy/cost tradeoff summary:** native transducer timestamps (cheapest, robust) > NFA/CrisperWhisper (accurate, one extra pass) > WhisperX/wav2vec2 (accurate on clean audio, fragile in noise). Montreal Forced Aligner remains the phoneme-level gold standard but is heavyweight for realtime (arXiv:2606.18466, "state of speech-to-text alignment in 2026").

---

## 5. Batch / offline serving performance

Your STT is FastAPI + **Dramatiq** (a task queue) → offline/batch throughput is the dominant metric. Options, mid-2026:

- **faster-whisper `BatchedInferencePipeline`** — the pragmatic Whisper batch path. **~250× realtime on RTX 4090** (large-v3, batch=16); dynamic batching gives an extra 3–5×. **`int8_float16` / `int8` quantization is effectively lossless and halves VRAM**, letting you pack multiple workers per GPU (https://knightli.com/en/2026/05/01/faster-whisper-speech-to-text/; https://modal.com/docs/examples/batched_whisper). Needs CUDA 12 / cuDNN 9.
- **NeMo (Parakeet/Canary)** — the throughput leaders. **Parakeet-TDT** hits **RTFx ~3,380 at batch=128** on the leaderboard hardware; **int8 is essentially lossless (8.01% vs 8.03% FP32)**. On a **modest L4 GPU**, an independent benchmark shows fp16 **79.9×→228.3× going batch 1→8**, with **int8 recommended specifically for packing multiple workers** rather than max single-stream throughput (https://www.e2enetworks.com/blog/benchmarking-asr-models-nvidia-l4-parakeet-whisper-nemotron). **Optimal batch size differs per GPU** (A100 ≠ L4). IBM's **Granite-4.1-2B-NAR reaches RTFx ~1820 on one H100** by single-pass CTC editing.
- **vLLM for audio** — Whisper is supported as an encoder-decoder (encoder one-shot, only the decoder gets continuous batching); **Voxtral (incl. Realtime), Qwen3-Omni, Gemma3n** are supported too (https://docs.vllm.ai/en/latest/contributing/model/transcription/). The win is **unified serving for mixed LLM+ASR** — one server for your NLP/SMR LLMs and ASR. Tradeoff: **higher VRAM (FP16) and lower RTF than CTranslate2 int8**. If your realtime model is Voxtral Realtime or Qwen3-ASR, vLLM is the recommended runtime.
- **TensorRT-LLM / WhisperTRT** — max NVIDIA performance but heaviest to operate; production Whisper pipelines report **>2,400× RTFx**; C++ runtime ~18% faster than Python; **WhisperTRT ~3× faster / ~60% memory** on Jetson (https://github.com/NVIDIA-AI-IOT/whisper_trt). Baseten reports the fastest/cheapest hosted Whisper on this path. Reserve for when throughput is the binding constraint and you can absorb engine-build/versioning cost.
- **Quantization quality impact:** int8 is **essentially lossless for CTC/TDT** (Parakeet) and **near-lossless for Whisper** (`int8_float16`). This is the single highest-leverage lever for a GPU-limited k3s cluster: ~2× density with negligible WER change.
- **Realistic throughput by GPU class:** T4 (16GB, no bf16) — Whisper large int8 viable but slow, best for small/medium or Parakeet-0.6B int8; **L4 (24GB)** — the value workhorse, Parakeet fp16 ~200–230× at batch 8, several int8 Whisper workers; **A10/A10G (24GB)** — ~2.8× batching uplift, good multi-worker host; **L40S (48GB)** — cited as the faster-whisper "production sweet spot"; **RTX 4090** — ~250× Whisper batched; **A100/H100** — Parakeet 3,000×+, Granite-NAR 1,820×, and MIG partitioning for multi-tenant sharing.
- **CPU-only fallback:** **whisper.cpp** (GGML, int8/int4, Apple-Silicon/AVX) is the standard CPU path; faster-whisper also runs int8 on CPU; **Moonshine** for edge/on-device English. Expect << realtime for large models on CPU — use small/medium or Parakeet-0.6B and reserve CPU for overflow, not primary clinical load.
- **Multi-model GPU sharing:** because int8 Parakeet-0.6B and Whisper fit in a few GB, run **multiple Dramatiq worker replicas per GPU** (MIG on A100/H100, or time-slicing on L4/A10 via the k8s device plugin). Keep a small realtime pool (Voxtral Realtime / Kyutai) separate from the batch pool so streaming latency isn't starved by batch jobs.
- **Duration-aware scheduling / long-form serving** are emerging concerns (arXiv:2603.11273 "Duration Aware Scheduling for ASR Serving"; MURMUR arXiv:2606.01483; VoxServe arXiv:2602.00269) — relevant if consultation lengths vary widely across your Dramatiq queue.

---

## 6. Evaluation methodology

- **WER/CER with normalizers.** The **Whisper normalizer** (`whisper-normalizer` on PyPI) is standard but **opinionated** — it aggressively rewrites numbers/spellings and can *reduce* apparent WER (~11.29%→10.16% in one study) and even *hide* real multilingual errors (arXiv:2409.02449 "What is lost in Normalization?"). The **jiwer** normalizer is more conventional. **Report both, fix known bugs, and version your normalizer** — recall Omi Health found normalizer bugs inflating WER 2–3% across the whole industry. New tooling: **OpenWER** (arXiv:2606.21237) for cross-lingual/token-based accuracy; "Beyond Levenshtein" (arXiv:2408.15616) for granular error classification.
- **Medical-concept metrics (the ones that matter clinically):** **Medical WER / M-WER + Drug M-WER** (Omi/PriMock57) — WER weighted to clinical terms; **MEDCON** — UMLS concept **F1** via QuickUMLS, restricted to semantic groups {Anatomy, Chemicals&Drugs, Device, Disorders, Genes, Phenomena, Physiology}, the standard for **note-level** concept fidelity (ACI-Bench, arXiv:2306.02022); plus **HC-WER** (healthcare concept WER) appearing in 2025–2026 papers. Build a curated **drug/condition term list** and track recall on it as a first-class regression signal.
- **Diarization / speaker-attributed metrics:** **DER** (diarization only) is insufficient for clinical value; use **cpWER** (concatenated minimum-permutation WER — reference/hyp concatenated per speaker, best permutation) and **tcpWER** (time-constrained — also penalizes bad timestamps). For doctor/patient (2-speaker) this cleanly measures "did the right speaker get the right words." **pyannote community-1 (pyannote.audio 4.0)** is the current open diarizer with a **single-speaker mode** and much better noisy-audio handling than the legacy 3.1 pipeline (DER ranges: clean <8%, meetings 11–19%; https://www.pyannote.ai/changelog/community-1-now-available).
- **Streaming metrics** (for your realtime path): **finalization/emission delay** (audio-time between a word being spoken and committed), **partial recognition latency**, and **partial stability / flicker** (how often displayed partials get rewritten before commit) — measure all three, not just WER, because a low-WER stream that flickers is unusable at the bedside (deflickering: https://www.bruguier.com/pub/deflickering.pdf; "Quality and Stability of a Streaming Recognizer" arXiv:2006.01416; FastEmit arXiv:2010.11148). This maps directly to your team's known "tail final" finalization issue.
- **Open eval tooling / regression harness:** **jiwer** (WER/CER), **MeetEval** (`fgnt/meeteval`, PyPI 0.4.3 — cpWER/tcpWER/ORC-WER/MIMO-WER, arXiv:2307.11394), **NeMo** and **SpeechBrain** eval utilities, plus the **Open ASR Leaderboard** eval scripts (`huggingface/open_asr_leaderboard`) as a reproducible template. Wire a fixed **clinical audio holdout** (your own PHI-safe set + PriMock57) into CI and gate on M-WER + Drug-recall + streaming latency, with a pinned normalizer.

---

## (c) Synthesis — what a self-hosted clinical STT stack should look like in mid-2026

1. **Go model-plural, not Whisper-only.** Run (a) a fast multilingual **offline workhorse**, (b) a **clinical-accuracy pass** for medication/term-critical audio, and (c) a **native-streaming** model for realtime — routed by the Dramatiq job type. Whisper is no longer the default primary; it's the 99-language fallback.
2. **Offline workhorse = a transducer/CTC model, int8.** **Parakeet-TDT-0.6B-v3** or **Canary-1B-v2** (both CC-BY-4.0, 25 EU languages, native word timestamps, ~3,000×/high RTFx, int8 essentially lossless) — and they **barely hallucinate on silence**, unlike Whisper. This is the biggest single clinical-safety upgrade over an all-Whisper stack.
3. **But gate medication/critical audio on a clinical-accuracy model.** Parakeet's **Drug M-WER (15–22%) is not safe** for prescriptions. Add **Qwen3-ASR-1.7B** (Apache-2.0, 52 langs, 4.40% M-WER, native streaming, vLLM) as the second-pass/high-stakes engine, or Whisper-large-v3 fine-tuned on your clinical data (LoRA on synthetic + real consult audio).
4. **Realtime path = a natively-streaming model, not chunked Whisper.** Prefer **Voxtral-Mini-4B-Realtime-2602** (Apache-2.0, <500ms, 13 langs, single ≥16GB GPU, official vLLM Realtime) or **Kyutai STT** (400 streams/H100, native word timestamps). If you must stay on Whisper, use **SimulStreaming (MIT, ~5× faster than whisper_streaming)** / **WhisperLiveKit** with a LocalAgreement or AlignAtt policy — but budget for finalization-lag and partial-flicker tuning.
5. **Harden every Whisper-class path** with the full stack: **Silero VAD gating → `no_speech`/`avg_logprob`/`compression_ratio` triage → temperature fallback → `condition_on_previous_text=False`**, and consider Calm-Whisper/SAE-steering or CrisperWhisper if you keep Whisper for verbatim capture. Prefer transducer models precisely to avoid this class of failure.
6. **Add context biasing before you fine-tune** — it's the cheapest clinical win. Feed a per-tenant drug/formulary/condition list via **NeMo word-boosting** (Parakeet/Canary), **Granite-4.1 keyword biasing**, or Whisper `initial_prompt`/`hotwords` (≤224 tokens, rare terms last). Reserve LoRA fine-tuning for persistent term gaps.
7. **Timestamps: use the model's native output.** Parakeet/Canary/Qwen3-ASR/Kyutai emit robust word timings for free; only reach for WhisperX/wav2vec2 forced alignment on clean audio, and prefer **NeMo Forced Aligner or CrisperWhisper** for a Whisper-based path (wav2vec2 alignment is fragile in clinic noise).
8. **Diarization for 2-speaker consults = pyannote community-1 (4.0), evaluated with cpWER/tcpWER** — not DER. Speaker-attributed WER is what determines whether the note attributes symptoms to the right party.
9. **Serving on GPU-limited k3s: quantize to int8 and pack workers.** int8 is ~lossless for CTC/TDT and near-lossless for Whisper (`int8_float16`), giving ~2× density. Run multiple Dramatiq worker replicas per GPU (MIG on A100/H100, time-slicing on L4/A10). Use **faster-whisper BatchedInferencePipeline** for Whisper batch, **NeMo** for Parakeet/Canary, and **vLLM** as the shared runtime for Voxtral/Qwen3-Omni (unifies with your existing LLM services). Keep realtime and batch pools separate so streaming latency isn't starved.
10. **Measure clinically and continuously.** CI-gate on **M-WER + drug/term recall (MEDCON/concept-F1) + cpWER + streaming finalization-lag/stability**, with a **pinned, bug-checked normalizer** (jiwer + fixed Whisper normalizer) and a fixed clinical holdout. Track the commercial ceilings (Gemini 3 Pro 2.65% M-WER; Deepgram Nova-3 Medical 4.53%) as targets — but keep everything self-hosted for PHI, and remember marketing WER (Deepgram's "3.45%") is on vendor test sets, not your consultations.

---

## Verification flags (what I could not fully confirm)

- **Open ASR Leaderboard RTFx GPU**: the paper abstract (arXiv:2510.06961) confirms the CTC/TDT-vs-attention tradeoff but I **could not extract the exact GPU/batch used for RTFx** from the abstract; the Canary-Qwen card measures RTFx 418 on A100/A6000/RTX5090, so treat leaderboard RTFx as **A100-class, batch-dependent**. RTFx numbers vary widely by source/batch (Parakeet quoted as 2,793× CTC / 3,380× batch-128 / ~3,333× v3) — all directionally consistent (~thousands ×), none a single fixed figure.
- **Some mid-2026 items lean on secondary/SEO sources**: Northflank (Jan 7 2026), localaimaster, knightli, e2enetworks, weesperneonflow, chatforest. Their headline numbers were cross-checked against primary HF/arXiv/vendor pages where possible; the **L4 batch-scaling figures (79.9→228.3×)** and **faster-whisper "250× on 4090"** come from single secondary benchmarks — directionally reliable, not audited.
- **"Silence-conditional output suppression" (−39.9pp)** comes from an analemma-hosted preprint (Feb 2026), not a peer-reviewed venue — treat as promising, unverified.
- **VibeVoice-ASR 9B** (best OPEN on PriMock57, 3.16% M-WER) — I confirmed it via the Omi benchmark table but **did not independently verify its license/weights availability**; validate before adopting.
- **Voxtral Transcribe 2 batch model** is **API-only** (not self-hostable); only **Voxtral-Mini-4B-Realtime-2602** is open-weights. Don't conflate the two.
- **Azure / AWS medical STT** independent WER was **not obtained** beyond the Omi "Microsoft MAI-Transcribe-1 4.85% M-WER" row.
- **Qwen3-ASR / IBM Granite 4.1 / Voxtral Transcribe 2 / Moonshine v2 / Meta Omnilingual** are all confirmed via primary HF model cards and/or arXiv IDs and vendor blogs, so their existence and headline specs are solid; some per-dataset WERs (e.g., Granite-4.1 per-dataset, Qwen3-ASR full FLEURS table) were not exhaustively pulled and should be read from the model cards before final selection.

*No project files were created; findings are returned inline above per the research-agent brief.*
