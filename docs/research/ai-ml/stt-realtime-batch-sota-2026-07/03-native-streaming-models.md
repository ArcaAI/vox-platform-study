> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** External deep research (primary web sources, verified 2026-07-10).
> Agent: `general-purpose` `aa92f8bef56a8de7d` (sub-agent of 01). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Native / True-Incremental Streaming ASR — Self-Hostable State of the Art (mid-2026)

*Research date: 2026-07-10. Every row verified against primary sources (HF model cards, NeMo docs, arXiv, vendor docs) linked inline.*

## Framing: what "native streaming" means vs. what you run today

Your current pipeline (Whisper-class + chunked/LocalAgreement) is **offline-model-chunked pseudo-streaming**: you re-feed overlapping windows to a full-utterance encoder–decoder and reconcile hypotheses. It works but pays for it in latency, compute (re-encoding overlap), and hallucination risk on partials.

**Native/true-incremental streaming** models process audio in one forward pass per chunk and never re-encode history. Two families dominate the self-hostable frontier in mid-2026:

1. **Cache-aware transducers (NVIDIA FastConformer + RNN-T/TDT).** The encoder keeps an internal cache of self-attention + convolution state; each new chunk updates the cache instead of recomputing context. A single `att_context_size` knob trades latency for WER at *runtime* with no retraining. This is the mainstream, production-proven native-streaming path and the natural home for a "transducer pilot." ([NeMo docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/models.html), accessed 2026-07-10)
2. **Streaming speech-LLMs / decoder-only LMs** (Mistral Voxtral Realtime causal encoder; Kyutai "delayed streams modeling"). Newer, higher accuracy ceiling, heavier (4B / 2.6B), latency configurable but compute-hungrier per stream.

Offline models chunked for streaming (Parakeet-TDT v2/v3, Canary, Whisper-turbo, Meta Omnilingual) are **not** native-streaming — I call them out explicitly below because they are easy to confuse with the streaming checkpoints that share their names.

---

## Master comparison table

| Model / ID | Type | Self-host? | Latency-to-partial | WER (benchmark) | Multilingual | Maturity | License | Source (date) |
|---|---|---|---|---|---|---|---|---|
| **nvidia/parakeet-unified-en-0.6b** | FastConformer + **RNN-T**, unified offline+streaming (one ckpt) | ✅ open weights | **160 ms – 2.08 s** (runtime knob) | Offline 1.63% LS-clean; **streaming 8.44%@160ms → 6.14%@2.08s** | EN only | New but production-grade lineage | NVIDIA Open Model | [HF](https://huggingface.co/nvidia/parakeet-unified-en-0.6b) (2026-04-07) |
| **nvidia/nemotron-3.5-asr-streaming-0.6b** | Cache-aware FastConformer(24L) + **RNN-T** | ✅ open weights | **80 ms – 1.12 s** (`att_context_size` [56,0]→[56,13]) | FLEURS: EN 7.91%, ES 4.11%, IT 4.25%; transcription-tier avg **8.84%@1.12s** | **40 language-locales** (prompt LangID) | Flagship 2026 release | **OpenMDW-1.1** | [HF](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) (2026-06-04); [MarkTechPost](https://www.marktechpost.com/2026/06/06/nvidia-releases-nemotron-3-5-asr-a-600m-parameter-cache-aware-streaming-model-transcribing-40-language-locales-in-real-time/) (2026-06-06) |
| **nvidia/nemotron-speech-streaming-en-0.6b** | Cache-aware FastConformer(24L) + **RNN-T** | ✅ open weights | **80/160/560/1120 ms** | HF Open-ASR avg **6.93%@1.12s → 8.43%@80ms**; 24 ms median time-to-final | EN only | Shipping, Riva/NIM available | NVIDIA Open Model | [HF](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b) (2026-01-05, upd. 2026-03-13); [HF blog](https://huggingface.co/blog/nvidia/nemotron-speech-asr-scaling-voice-agents) |
| **nvidia/stt_en_fastconformer_hybrid_large_streaming_multi** | Cache-aware FastConformer **hybrid Transducer+CTC** (114M) | ✅ open weights | **0/80/480/1040 ms** ([70,0]/[70,1]/[70,6]/[70,13]) | **Transducer 7.0/6.4/5.7/5.4%**; **CTC 8.4/7.8/6.7/6.2%** (internal test set) | EN only | Mature (the reference cache-aware model) | CC-BY-4.0 | [HF](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi) |
| **kyutai/stt-2.6b-en** | Decoder-only LM + Mimi codec ("delayed streams") | ✅ open weights | **2.5 s** fixed delay | Mean **6.4%** (HF Open-ASR); AMI 12.17%; RTFx 88 | EN | Production Rust server; powers Unmute | Weights **CC-BY-4.0**, code MIT/Apache | [HF](https://huggingface.co/kyutai/stt-2.6b-en); [kyutai.org/stt](https://kyutai.org/stt/); paper [arXiv 2509.08753](https://arxiv.org/abs/2509.08753) |
| **kyutai/stt-1b-en_fr** | Decoder-only LM + Mimi + **semantic VAD** | ✅ open weights | **0.5 s** delay | (lower than 2.6B; on-par w/ offline SOTA per authors) | EN + FR | Production Rust server | CC-BY-4.0 | [kyutai.org/stt](https://kyutai.org/stt/); [GitHub DSM](https://github.com/kyutai-labs/delayed-streams-modeling) |
| **mistralai/Voxtral-Mini-4B-Realtime-2602** | **Speech-LLM**: 970M causal audio encoder + 3.4B LM (sliding-window) | ✅ open weights | **80 ms – 2.4 s** (rec. 480 ms) | FLEURS **8.72%@480ms** (13-lang avg) | 13 languages | New (Feb 2026), vLLM day-1 | **Apache-2.0** | [HF](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602); paper [arXiv 2602.11298](https://arxiv.org/abs/2602.11298) |
| nvidia/parakeet-tdt-0.6b-v3 | FastConformer + **TDT** — **OFFLINE** | ✅ but needs external chunking | ~2 s chunks (not cache-aware) | Open-ASR **6.34%**, FLEURS 11.97%, RTFx 3333 | 25 EU languages | Mature, tops leaderboard | CC-BY-4.0 | [HF](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (2025-08-14); paper [arXiv 2509.14128](https://arxiv.org/abs/2509.14128) |
| openai/whisper-large-v3-turbo | Enc-dec (4 decoder layers) — **OFFLINE** | ✅ but chunked only | ~3.3 s (chunked); 30 s window | ~+0.3% vs large-v3 | 99 languages | Ubiquitous | MIT | [HF](https://huggingface.co/openai/whisper-large-v3-turbo) |
| facebookresearch/omnilingual-asr | wav2vec2 (≤7B) + CTC or LLaMA decoder — **OFFLINE** | ✅ but no streaming iface | CER <10 for 78% of langs | **1,600+ languages** | Research/offline | Apache-2.0 | [Meta blog](https://ai.meta.com/blog/omnilingual-asr-advancing-automatic-speech-recognition/) (2025-11-10) |
| *AssemblyAI Universal-Streaming* | Proprietary | ❌ API-only | **~300 ms** word-emission (P50); P99 ~1.0 s | Universal-3 Pro 5.6% mean | multi | GA | commercial | [AssemblyAI](https://www.assemblyai.com/blog/introducing-universal-streaming) (2025-06-02) |
| *Deepgram Nova-3 / Flux* | Proprietary | ⚠️ on-prem *licensed* (not open) | Flux EOT **<300 ms** | Nova-3 **5.26% batch / 6.84% streaming** | Flux ML (2026-04-29) | GA | commercial | [Deepgram docs](https://developers.deepgram.com/docs/flux/flux-nova-3-comparison) |
| *Speechmatics Ursa 2* | Proprietary | ⚠️ on-prem *licensed* | sub-1 s | −18% WER vs Ursa 1 | 55 languages | GA | commercial | [Speechmatics](https://www.speechmatics.com/company/articles-and-news/best-in-class-real-time-asr-system) |
| *Gladia Solaria-3* | Proprietary | ❌ API-only | **103 ms partial / 270 ms final** | 9.6% (internal EN) | 100 languages | GA | commercial | [Gladia](https://www.gladia.io/solaria-3) |
| *ElevenLabs Scribe v2 Realtime* | Proprietary | ❌ API-only | **sub-150 ms** | 2.3% (AA-WER v2), 93.5% acc/30 lang | multi | GA | commercial | [Coval benchmark](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/) (accessed 2026-07-10) |

---

## 1. NVIDIA cache-aware FastConformer streaming family (the core self-hostable native-streaming line)

**The latency knob you asked about.** The canonical reference is `stt_en_fastconformer_hybrid_large_streaming_multi`. `att_context_size = [left, right]` in 80 ms frames maps exactly to: **`[70,0]=0ms`, `[70,1]=80ms`, `[70,6]=480ms`, `[70,13]=1040ms`** ([HF card](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi)). A single checkpoint serves all four latencies at runtime. Its published WER curve is the cleanest CTC-vs-transducer evidence available:

| Latency | Transducer WER | CTC WER |
|---|---|---|
| 1040 ms | 5.4% | 6.2% |
| 480 ms | 5.7% | 6.7% |
| 80 ms | 6.4% | 7.8% |
| 0 ms | 7.0% | 8.4% |

The transducer decoder beats CTC by ~0.8–1.4 pts absolute at every latency — the accuracy argument for a transducer pilot in one table.

**2026 successors (same architecture, bigger/better):**
- **`nemotron-speech-streaming-en-0.6b`** (2026-01-05, updated 2026-03-13): cache-aware FastConformer 24-layer encoder + **RNN-T** decoder, 600M params, 530k hrs. Runtime modes 80/160/560/1120 ms; HF Open-ASR average **6.93%@1.12s**, degrading to **8.43%@80ms**. **24 ms median time-to-final**; **560 concurrent streams on one H100** at 320 ms chunk (3× the RNN-T 1.1B baseline). License: NVIDIA Open Model. Deploy via NeMo, HF Transformers ≥5.13, **Riva**, and **NIM** containers ([HF card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b); [HF blog](https://huggingface.co/blog/nvidia/nemotron-speech-asr-scaling-voice-agents), 2026-01-05).
- **`nemotron-3.5-asr-streaming-0.6b`** (2026-06-04): the multilingual generalization — same 600M cache-aware FastConformer+RNN-T, extended to **40 language-locales** via prompt-based LangID conditioning (19 "transcription-ready" incl. EN/ES/FR/IT/PT/DE/AR/HI/JA/KO/VI/RU/UK, 13 "broad-coverage", 8 "adaptation-ready"). Configs `[56,0]=80ms … [56,13]=1120ms`. FLEURS WER: **ES 4.11%, IT 4.25%, EN 7.91%, transcription-tier avg 8.84%@1.12s**. **~2,400 concurrent streams/H100** at 1120 ms (vs ~400 for Parakeet-RNNT-1.1B). License: **OpenMDW-1.1** ([HF card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b); [MarkTechPost](https://www.marktechpost.com/2026/06/06/nvidia-releases-nemotron-3-5-asr-a-600m-parameter-cache-aware-streaming-model-transcribing-40-language-locales-in-real-time/)).
- **`parakeet-unified-en-0.6b`** (2026-04-07): **one checkpoint that is both offline and cache-aware-streaming** (jointly trained, shared params). FastConformer 24L + RNN-T, 600M. Offline **1.63% LS-clean / 3.11% LS-other**; streaming **8.44%@160ms → 6.14%@2.08s** (configs 160/240/560 ms …). License: NVIDIA Open Model ([HF card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)). This is the most operationally attractive single artifact for a clinical deployment that needs both live partials *and* a high-accuracy final transcript.

**Self-hosting paths:** NeMo (`ASRModel.from_pretrained`), HF Transformers, ONNX export, or **Riva/NIM** for a batteries-included gRPC/WebSocket server. All fit a Python STT service behind your NestJS gateway — the cache-aware streaming API maintains encoder cache across your PCM16 chunks, so you drop the LocalAgreement reconciliation entirely.

**Important clarification (v2/v3 confusion):** `parakeet-tdt-0.6b-v2` (EN, tops leaderboard since May 2025) and `parakeet-tdt-0.6b-v3` (25 EU languages, Open-ASR 6.34%, 2025-08-14) are **offline** models. NeMo ships a chunked-inference script, but it re-encodes and is *not* the cache-aware native path — don't pilot streaming on these; use the cache-aware/unified checkpoints above ([parakeet-tdt-0.6b-v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)).

## 2. TDT vs RNN-T vs CTC for streaming — why a transducer, and why TDT

- **CTC**: non-autoregressive, cheapest, but the per-frame conditional-independence assumption costs ~1 pt WER (table above) and it needs an external LM for competitive accuracy. Fine for lowest-compute, weak for clinical accuracy.
- **RNN-T**: naturally monotonic + streamable, emits incrementally, strong accuracy — the workhorse decoder for all the Nemotron/unified streaming models above.
- **TDT (Token-and-Duration Transducer)**: RNN-T that *also predicts each token's duration in frames*, so at inference it **skips frames** instead of stepping one encoder frame at a time. Original paper (NVIDIA, Xu et al., ICML 2023, [arXiv 2304.06795](https://arxiv.org/abs/2304.06795)) reports **up to 2.82× faster inference than RNN-T with better accuracy**, and it is more robust to noisy/agitated speech. TDT is why Parakeet leads RTFx by ~3× ([Speechmatics explainer](https://www.speechmatics.com/company/articles-and-news/token-duration-transducer-tdt-explained)).
- Practical read for your pilot: the *streaming* NVIDIA checkpoints currently ship **RNN-T** decoders (Nemotron 3.5 / unified), while the *offline* leaders ship **TDT**. So "native transducer pilot" = RNN-T cache-aware today; TDT is the throughput multiplier on the offline/final pass. You get both by using the unified checkpoint or by pairing a cache-aware RNN-T for partials with a TDT final rescore.

## 3. Kyutai STT — "delayed streams modeling" (the strongest non-NVIDIA open option)

Decoder-only LM over the **Mimi** streaming codec (12.5 Hz frames), audio+text modeled as time-aligned "delayed" streams (paper [arXiv 2509.08753](https://arxiv.org/abs/2509.08753)):
- **`stt-1b-en_fr`**: ~1B, EN+FR, **0.5 s** delay, with a built-in **semantic VAD** that predicts end-of-utterance from content + intonation (replaces a separate VAD/turn-detector — relevant to your VAD stage).
- **`stt-2.6b-en`**: ~2.6B, EN, **2.5 s** delay, mean **6.4% WER** on HF Open-ASR (AMI 12.17%), RTFx ~88.
- Self-host: **PyTorch** (research), **Rust WebSocket server** (production; powers Kyutai's Unmute), **MLX** (Apple silicon, runs on iPhone 16 Pro). **400 real-time streams on one H100.** Weights **CC-BY-4.0**, code MIT/Apache ([kyutai.org/stt](https://kyutai.org/stt/); [GitHub](https://github.com/kyutai-labs/delayed-streams-modeling)).
- Trade-off vs NVIDIA: authors claim accuracy parity with offline SOTA and it's genuinely streaming with semantic turn-taking, but it's 2–4× the parameters, delays are *fixed per checkpoint* (no runtime latency knob), and per-stream throughput is ~6× lower than Nemotron 3.5. Best where you value the semantic-VAD/turn-taking and EN/FR is enough.

## 4. Other 2026 open-source streaming releases

- **Mistral Voxtral-Mini-4B-Realtime-2602** (Feb 2026, [HF](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [arXiv 2602.11298](https://arxiv.org/abs/2602.11298)): open-weight **Apache-2.0** speech-LLM — 970M **causal** audio encoder (sliding-window attention → true left-to-right streaming) + 3.4B LM. Configurable **80 ms – 2.4 s** delay (rec. 480 ms), **FLEURS 8.72%** across 13 languages, self-hostable on a single GPU via **vLLM**. The most permissively licensed native-streaming multilingual option, but 4B params ≈ 6–7× the compute of a 0.6B FastConformer per stream.
- **Meta Omnilingual ASR** (2025-11-10): 1,600+ languages, wav2vec2 (≤7B) + CTC or LLaMA decoder, Apache-2.0 — but **offline only** ("does not currently support real-time/streaming"). Relevant only if you need extreme language coverage in batch ([Meta blog](https://ai.meta.com/blog/omnilingual-asr-advancing-automatic-speech-recognition/)).
- **Google**: no new open-weight streaming ASR in 2025–26 (released the WAXAL African speech *dataset*, 2026-03); Cloud STT remains API-only.
- **OpenAI**: `whisper-large-v3-turbo` is enc-dec/offline (4 decoder layers, ~2× faster than large-v3, +0.3% WER) — good for your *batch/final* pass but **not native streaming** (30 s window + autoregressive decoder; chunked ≈3.3 s latency). OpenAI's low-latency streaming is Realtime-API-only, not self-hostable ([HF turbo card](https://huggingface.co/openai/whisper-large-v3-turbo)).

## 5. Commercial frontier (reference only — PHI-relevant caveats)

For a clinical/PHI workload, treat these as the WER-vs-latency frontier to beat, not deployment targets. Only **Deepgram** and **Speechmatics** offer *self-managed on-prem* (licensed binaries, not open weights) — potentially HIPAA-viable without data egress; the rest are cloud-API-only.
- **AssemblyAI Universal-Streaming**: ~**300 ms** P50 word-emission (41% faster than Nova-3's 516 ms), P99 ~1.0 s, immutable partials, $0.15/hr, API-only ([blog](https://www.assemblyai.com/blog/introducing-universal-streaming), 2025-06-02).
- **Deepgram Nova-3 / Flux**: Nova-3 **5.26% batch / 6.84% streaming**; **Flux** voice-agent model with integrated end-of-turn **<300 ms** (multilingual 2026-04-29). On-prem/self-hosted enterprise option ([Deepgram docs](https://developers.deepgram.com/docs/flux/flux-nova-3-comparison)).
- **Speechmatics Ursa 2**: 55 languages, sub-1 s, −18% WER vs Ursa 1, on-prem option.
- **Gladia Solaria-1/3**: **103 ms partial / 270 ms final**, 100 languages, Solaria-3 9.6% internal-EN; API-only.
- **ElevenLabs Scribe v2 Realtime**: sub-150 ms, 2.3% AA-WER; **Microsoft MAI-Transcribe-1**: 3.8% FLEURS/25-lang (Azure only); **OpenAI Realtime**: sub-150 ms TTFT — all API-only ([Coval independent benchmark](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/), accessed 2026-07-10; caveat from that source: *"vendor benchmarks are marketing copy with measurements attached"* — validate on your own clinical audio).

---

## Best "transducer pilot" candidates for self-hosted clinical STT

- **Primary pick — `nvidia/parakeet-unified-en-0.6b` (RNN-T, cache-aware + offline in one checkpoint).** It is the cleanest fit for a clinical flow that needs low-latency live partials *and* a high-accuracy final note from the *same* deployed model: streaming **8.4%@160ms → 6.1%@2.08s**, offline **1.63% LS-clean**, runtime latency knob, 600M (cheap to serve), NVIDIA Open Model license. One artifact replaces your Whisper-chunked-plus-LocalAgreement stack. English-only is its main limit ([HF](https://huggingface.co/nvidia/parakeet-unified-en-0.6b), 2026-04-07).
- **If you need multilingual now — `nvidia/nemotron-3.5-asr-streaming-0.6b`.** Same cache-aware FastConformer+RNN-T, **40 language-locales** from one checkpoint, **~2,400 streams/H100**, FLEURS avg 8.84%@1.12s. Watch the **OpenMDW-1.1** license terms for clinical/commercial use before committing ([HF](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), 2026-06-04).
- **English-only, want the most throughput + Riva/NIM ops maturity — `nvidia/nemotron-speech-streaming-en-0.6b`.** 24 ms median time-to-final, 6.93%@1.12s, shipped container path (Riva/NIM) that slots behind your NestJS gateway with minimal glue ([HF](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), 2026-01-05).
- **Architecture rationale to bake into the pilot:** pick a **transducer** decoder — the published cache-aware curve shows RNN-T beats CTC by ~1 pt WER at *every* latency, and **TDT** (arXiv 2304.06795) buys up to **2.82×** throughput on the offline/final pass. Cache-aware streaming eliminates the re-encode overhead and hallucinated-partial risk inherent to your current offline-chunked LocalAgreement approach.
- **Non-NVIDIA hedges:** **Kyutai `stt-1b-en_fr`** if the built-in **semantic VAD/turn-detection** is worth adopting (could simplify your VAD stage) and EN/FR suffices; **Mistral Voxtral Realtime** if you want a fully **Apache-2.0** license and a speech-LLM accuracy ceiling and can afford 4B-param serving cost. Keep a **Whisper-large-v3-turbo** or **Parakeet-TDT-v3** offline pass available for high-stakes final-transcript rescoring.

**One caveat for the plan:** validate the shortlist on your own de-identified consultation audio (accents, medical terms, noise) — all WER numbers above are LibriSpeech/FLEURS/Open-ASR, which under-predict real clinical error rates; consider keyterm/vocabulary biasing (NeMo supports word-boosting/contextual biasing) for drug and procedure names.
