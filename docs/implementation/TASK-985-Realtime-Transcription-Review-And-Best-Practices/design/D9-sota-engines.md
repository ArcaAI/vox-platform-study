# D9 — SOTA engines and streaming policies

**Area dossier for TASK-985.** Design only; no code, no measurement, no service touched.
Author: area D9. Date: 2026-09-19. Branch `agent/agent-transcription-coordination-9dbc25`
(= `dev-2.2` @ `3f9145a98`).

Citation convention is Appendix C's: every external claim carries **fetched** (page retrieved
and the number read on it) or **search-only** (snippet only), plus **vendor self-reported** vs
**third-party** where a number is involved. Repo claims carry `file:line` and were read in this
worktree. As in Appendix C: **nothing external in here was measured on Malayalam-English
streaming clinical audio.** HOPE's own scorecard remains the only Malayalam number in existence
for this stack, and it currently says the served path loses 82–88 % of the words on *English*.

---

## 0. The honest framing

The orchestrator's measurement is the fact this dossier has to be written against:

> 21.8 s of English clinical speech → 46 characters, one final, `medical_wer` 0.885/0.935/0.918,
> **51–53 deletions of ~61 reference words**, keyterm recall 0/21, `inference_ms` 2677, RTF ~0.12.

Deletion-dominated collapse with a healthy RTF is not an engine being slow, a window being
wrong, or a commit policy losing a prefix. Those produce *fragmented* or *revised* text, not
*absent* text. Near-total deletion with the decoder returning promptly is the signature of the
decoder being **steered into emitting nothing** — a prompt the model was not trained with, a
language/token-forcing state it cannot recover from, or a fine-tune that has lost the English
it was built on top of. All three live upstream of every option below.

**So the first-order answer to "what does the 2026 state of the art offer here" is: almost
certainly nothing, yet.** No engine swap is worth buying until BP-2 says whether the served
*configuration* or the served *weights* produced that number, because the two answers lead to
opposite decisions and the cheaper one (configuration) costs a day. Every ranked option below
is therefore explicitly conditional on that attribution, and §8's decision tree is ordered by
cost-to-falsify rather than by expected ceiling.

I have one substantive disagreement with the review's own framing, developed in §2 and §6:
**the review treats new engines as work that has to be built, and the repo says most of it is
already built and merely unassigned.** That changes the ranking materially.

---

## 1. Three constraints that decide everything

### 1.1 The GPU is a 70 W card with 224 GB/s of memory bandwidth

`2x RTX 2000 Ada`, time-sliced ×3 → 6 allocatable units, **6/6 in use** (LM Studio 4, STT 1,
STT worker 1) — `09-infrastructure-devops.md` §Topology, and README §2.1 Deployment.

Per card: **16 GB GDDR6, 128-bit bus, 224 GB/s, 2816 CUDA cores, 70 W, sm_89**
([NVIDIA RTX 2000 Ada specs, 2024](https://www.nvidia.com/en-us/products/workstations/rtx-2000/) — *search-only*, figures consistent across the PNY datasheet and Leadtek/Dell listings in the same result set; vendor-published).

Two consequences that most "SOTA engine" conversations ignore:

1. **Autoregressive Whisper decoding is memory-bandwidth bound, and 224 GB/s is 4–9× less
   bandwidth than the GPUs every published streaming-ASR benchmark uses.** An H100 (3.35 TB/s)
   or an L40S (864 GB/s) number does not transfer. Any vendor concurrency figure quoted below
   is marked with the GPU it was measured on, and none of them was this one.
2. **Time-slicing does not partition VRAM** ([NVIDIA GPU Operator, GPU sharing, 2026](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html) — cited as *fetched* by F9-G1). Three clients share one card's 16 GB with no isolation, and LM Studio is one of them. So the practical VRAM budget for a new ASR model is **not 16 GB** — it is whatever LM Studio is not holding, and a CUDA OOM in one pod can take its card-mates down.

The design rule that follows: **prefer options that reduce decoder passes per second of audio,
and treat any option that multiplies them (beam-5 everywhere, temperature fallback, second-pass
rescoring, AlignAtt re-decode per chunk) as spending a budget that is already fully committed.**

### 1.2 An engine is only a real option if it is selectable as configuration

`00-project-context.md` Configuration Principles: an engine name, model id or endpoint is not a
code literal and not an env var. Concretely, in this repo an engine is *available* only when all
five of these exist:

| Layer | Where | Today |
|---|---|---|
| `AiModelFormat` value | `apps/stt/src/stt/pipeline/dto.py:32-61` | 13 values incl. `SARVAM`, `OPENAI`, `PARAKEET_CPP` |
| a loader | `apps/stt/src/stt/models/*_loader.py`, registered in `models/cache.py` | 10 loaders registered |
| an adapter satisfying `(samples, sample_rate, *, prompt) -> {text, language, word_timestamps, segments}` | `streaming/*_asr.py`, `models/nemo_adapter.py` | 7 adapters |
| a capability + trait declaration | `processors/asr_capabilities.py` | 11 engines registered |
| an `AiModel` row + an `Agent` that names it | `seed/ai-models/audio.ts`, `seed/25-agents.ts` | 19 audio rows, **1** `SPEECH_TO_TEXT` agent |

That last column is the finding: **the bottleneck is not adapters, it is assignment.**

### 1.3 PHI residency is a decision, not a toggle

Every cloud lane below is gated on an owner decision about PHI egress. The STT pod only gained
public egress on 2026-09-14 (memory record; README OD-H notes the same date), so "we already
call the cloud" is not available as a precedent — nothing clinical has gone out.

---
## 2. What the repo already has (the finding that reorders the ranking)

The review's Wave 3 reads as though a second engine lane is weeks of work. It is not. Read as
built:

### 2.1 Eleven ASR engines are registered; seven have working adapters

`apps/stt/src/stt/processors/asr_capabilities.py` declares, per engine, its `(device, compute)`
matrix and its **traits** — and the traits column is the whole biasing story:

| Engine (registry name) | `initial_prompt` | `word_timestamps` | `phrase_list` | Streaming | Runnable today? |
|---|---|---|---|---|---|
| `whisper_cpp` (served) | ✅ | ✅ | — | ✅ | **yes** |
| `faster_whisper` (CT2) | ✅ | ✅ | — | ✅ | **yes** |
| `safetensor` (transformers) | ✅ | ✅ | — | ✅ | **yes** |
| `nemo` | — | ✅ | — | ✅ | **no — extra not installed** (§2.3) |
| `sarvam` (cloud) | — | — | — | ✅ | yes, needs a key |
| `openai` (cloud) | — | — | — | ✅ | yes, needs a key |
| `azure_speech` (cloud) | — | ✅ | — | ✅ | yes, needs a key |
| `azure_foundry` (cloud) | — | ✅ | ✅ | ❌ batch-only | preview, off |
| `parakeet_cpp` | — | ✅ | — | ✅ (declared) | **no — no Python binding exists** (§2.3) |
| `onnx` / `onnx_optimum` | ✅ (optimum) | ✅ | — | partial | n/a for this decision |

### 2.2 The *same fine-tune* is already seeded in three runtimes

`packages/database/src/prisma/db_main/seed/ai-models/audio.ts`:

| Slug | Format / runtime | Source | Line |
|---|---|---|---|
| `arcaai-whisper-large-ml-en-gguf` | `WHISPER_CPP` f16 | `taphuynh/…-fullft-2607.29.1-GGUF` | :100 |
| `arcaai-whisper-large-ml-en-gguf-q8_0` | `WHISPER_CPP` q8_0 | same repo | :150 |
| **`arcaai-whisper-large-ml-en`** | **`SAFETENSOR` / transformers, fp16** | `…-fullft-2607.29.1-fp16` | **:188** |
| **`arcaai-whisper-large-ml-en-ct2`** | **`FASTER_WHISPER` / CTranslate2, fp16** | `…-fullft-2607.29.1-ct2` | **:213** |

Plus a **separate English clinical fine-tune** nobody serves — `whisper-large-en-medical-260726-merged-gguf` (:240), `-gguf-q8_0` (:278) and `-ct2` (:315).

Two consequences the review does not draw:

- **OD-J's precondition is already satisfied.** ST-9 says AlignAtt "needs the fine-tune's HF
  weights". Row :188 declares exactly those, in the `SAFETENSOR` format whose streaming lane
  (`session_manager.py:2669 _make_transformers_callable`) is live and builds `model.generate()`
  kwargs through the shared `build_whisper_generate_kwargs`. See §5.
- **There is exactly ONE `SPEECH_TO_TEXT` agent in the whole seed** (`25-agents.ts:472`,
  assigned at `:652`). Every alternative lane above is an `Agent` row away from being
  A/B-testable in the Global playground, with no code and no image change.

### 2.3 Two lanes are declared but cannot run, and both failures are documented in-tree

- **`nemo` is deliberately not installed.** `apps/stt/docker/Dockerfile:227-257`: the root
  `pyproject.toml` declares `stt[ml]`/`stt[ml-gpu]` ⇄ `stt[nemo]` as *conflicting* extras and
  `uv.lock` resolves them apart — `ml-gpu` on **torch 2.8.0** (pyannote 4.x hard-pins it),
  `nemo` on **torch ≥2.12**. Installing both into one venv broke torchvision's ABI and silently
  disabled diarization for a whole session on 2026-09-10. The comment is explicit: *"A
  nemo-capable image is a SEPARATE build target on its own venv … it must never be layered onto
  this one"*, and `tests/unit/test_task944_ml_runtime_extra_conflicts.py` enforces it.
  **So any NeMo/Conformer lane costs a second STT image, a second Deployment and a second GPU
  slice — on a 6/6-allocated budget.** That is the true integration cost, not "add a model row".
- **`parakeet_cpp` has no driver.** `models/parakeet_cpp_loader.py:1-16` states upstream
  `mudler/parakeet.cpp` ships *"no official Python bindings"*; the loader falls back to a raw
  ctypes handle and `streaming/parakeet_cpp_asr.py:44-49` **rejects** it
  (*"raw ctypes handle cannot be driven directly"*). The README's own run log shows the
  control plane refusing `stt.parakeetCpp.libraryPath` on every session create. This lane is a
  stub.

### 2.4 The knobs the served engine refuses are already wired on the CT2 lane

`streaming/whisper_cpp_asr.py:672-697` passes exactly `temperature=0.0, temperature_inc=0.0,
token_timestamps, split_on_word, max_len, language, initial_prompt` — no beam, no thresholds.
`streaming/faster_whisper_asr.py:198-233` builds `beam_size`, `temperature`,
`compression_ratio_threshold`, `log_prob_threshold`, `no_speech_threshold`,
`condition_on_previous_text` and `vad_filter` from the same `InferenceConfig`.

**The agent's declared `beamSize: 5` (`25-agents.ts:291`) becomes live the moment the primary
model row is a `FASTER_WHISPER` row.** No code change. M-14 and half of QW-9 are closed by a
row swap.

What is *not* wired on either lane: **native hotword biasing.** faster-whisper's
`transcribe()` accepts `hotwords: Optional[str]` ([faster-whisper transcribe.py, 2026](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py) — **fetched**; docstring: *"Hotwords/hint phrases to provide the model with. Has no effect if prefix is not None."*), and the repo pins `faster-whisper==1.2.1` (`apps/stt/pyproject.toml:158`). The adapter's `_build_decode_kwargs` never sets it. That is a ~5-line change that turns F9-K3's "native biasing per engine" from a Wave-3 item into a Wave-2 one **on the CT2 lane only**.

### 2.5 The fallback mechanism is richer than ST-6 assumes

`build-resolved-asr-spec.ts:590-611`: `fallbackOf()` has three kinds. `kind: 'model'` takes
`asrChainModels(agent).fallback` = **`chain[0]` only** (`:586-587`) — which is why the agent's
second entry (`faster-whisper-large-v3-turbo-int8`) is unreachable and the **only live fallback
today is the q8_0 sibling of the very same fine-tune**. But `kind: 'agent'` (`:601-603`) calls
`buildAsrSpecCore(fallbackAgent, …)` — a whole second agent, **with its own model, engine,
decode parameters, prompt, language mode, hotwords and windows**
(`:518-523`: *"a fallback engine gets its own decode parameters instead of inheriting the
primary's"*), and `pipeline/spec.py:833-849` keys both chains by runtime key so
`_build_fallback_asr_callable` (`session_manager.py:1588-1611`) resolves the fallback's own
spec.

**So a heterogeneous fallback — different engine, correct decode parameters — is already
expressible as `parameters.fallback.agentSlug`, with no code change.** What ST-6/M-34 still
buys is the *prompt and lexicon* side, which `inference.py` composes from session-level state
rather than re-deriving per chain, and carrying more than one chain entry.

---
## 3. Ranked engine options

### 3.0 The finding that governs the whole table

I searched for a self-hostable, natively-streaming 2026 ASR model that speaks Malayalam **and**
English. **There isn't one.**

| Model | Malayalam? | Evidence |
|---|---|---|
| NVIDIA Nemotron 3.5 ASR streaming 0.6B | **No** — 40 locales, Hindi is the only Indic one | [model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), 2026 — **fetched** |
| Mistral Voxtral Realtime | **No** — 13 languages, no Malayalam | [mistral.ai/news/voxtral-transcribe-2](https://mistral.ai/news/voxtral-transcribe-2/), 2026 — **fetched** |
| Kyutai STT (2.6b-en, 1b-en_fr) | **No** — English, or English+French | [kyutai/stt-2.6b-en](https://huggingface.co/kyutai/stt-2.6b-en), 2026 — **fetched** |
| NVIDIA Parakeet family | **No** (same locale set) | via Nemotron card, 2026 — **fetched** |
| Open ASR Leaderboard | **has no Indic track at all** — English, 5 European languages, long-form | [blog/open-asr-leaderboard](https://huggingface.co/blog/open-asr-leaderboard), 2026 — **fetched** |

The only Malayalam-capable *open* families are (a) the Whisper family — which is what HOPE
already fine-tuned — and (b) AI4Bharat's Conformers, which are **Malayalam-only, document no
streaming mode, and need AI4Bharat's fork of NeMo**. There is no third door. Anyone proposing
"just move to a modern streaming ASR" for this problem has not checked the language lists.

### 3.1 The table

Ranked by **expected value per unit of cost and risk on this cluster**, not by ceiling.
"Integration cost" is measured against §1.2's five layers.

| # | Option | Malayalam | English | Streaming | VRAM / throughput on one time-sliced RTX 2000 Ada slice | Licence | PHI posture | Integration cost in HOPE | Rank |
|---|---|---|---|---|---|---|---|---|---|
| **A** | **Keep the fine-tune, fix the configuration** (prompt, decoding gates, geometry — BP-2/QW-8/QW-9) | fine-tuned for it (no external number exists) | fine-tuned for it; **today measured at WER 0.885–0.935** | per-utterance, LocalAgreement | already resident; measured RTF p50 0.375 / p95 0.98 (README §2.3, cluster, 14 d) | in-house | in-cluster, no egress | **zero** — agent-field A/Bs | **1** |
| **B** | **Swap primary to `arcaai-whisper-large-ml-en-ct2`** (same weights, CTranslate2/faster-whisper) | same weights as A | same weights as A | per-utterance | 3000 MB declared (`audio.ts:236`); int8_float16 or fp16; CT2 is generally the faster Whisper runtime but **no in-repo A/B exists** | in-house weights; CTranslate2 MIT | in-cluster | **one `AiModel` row swap.** Instantly makes `beamSize`, `temperature`, `logprob/no-speech/compression` thresholds and `vad_filter` live (§2.4) | **2** |
| **C** | **Serve the English clinical fine-tune to English-pinned departments** (`whisper-large-en-medical-260726-merged-*`, rows already seeded) | none | purpose-built for English clinical | per-utterance | same class as A | in-house | in-cluster | **one `Agent` row + one `AgentAssignment`** | **3** |
| **D** | **Cloud fallback: ElevenLabs Scribe v2 Realtime** | listed, bucketed *"High Accuracy (>5–10 % WER)"* — [docs](https://elevenlabs.io/docs/capabilities/speech-to-text), 2026, **fetched**, vendor self-reported | yes, 90+ languages, auto-detect | native realtime; **<150 ms** claimed ([realtime-speech-to-text](https://elevenlabs.io/realtime-speech-to-text), 2026, *search-only*, vendor) | none (cloud) | commercial | **India data residency is an offered location; BAA available for HIPAA-eligible services; Zero-Retention Mode exists** ([data-residency](https://elevenlabs.io/docs/), 2026, **fetched**). Whether Scribe is inside the residency and ZR scopes is **unverified** | **new adapter + loader + format value + row** (~a `sarvam_asr.py`-sized file, ≈140 lines) | **4** |
| **E** | **Cloud fallback: Sarvam** (adapter + row already exist: `streaming/sarvam_asr.py`, `audio.ts:405`) | `ml-IN` claimed incl. streaming; "codemix" output mode on saaras — all **search-only**, vendor | `en-IN` | WebSocket streaming claimed; <150 ms TTFT claimed (**search-only**, vendor) | none | commercial | India-based; DPDP-driven localization; on-prem/air-gapped enterprise option claimed. **No BAA/HIPAA statement found anywhere** — this is the blocker | **a BYO key + a row edit.** Cheapest cloud lane by far | **5** |
| **F** | **Cloud fallback: Azure Speech `ml-IN`** (adapter + row already exist) | `ml-IN` **confirmed in the official real-time table** ([language-support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt), 2026, **fetched**) | yes, but single-language-selected per stream; no native mid-stream code-switch documented | native realtime | none | commercial | Central India hosts Speech; South India does not (*search-only*). Microsoft BAA is broad but **HIPAA-eligibility of Speech in Central India is unverified** | key + row. **But see the killer:** Custom Speech for `ml-IN` is *audio + human-labeled transcript only* — **plain-text phrase lists are NOT supported for ml-IN** (**fetched**), so F9-K3's biasing story does not apply to the language that needs it | **6** |
| **G** | **Quantized sibling as the fallback** (`…-gguf-q8_0`, the status quo) | same weights | same weights | same | ~half the f16 footprint | in-house | in-cluster | **already the only live fallback** (§2.5) | **7** (see §6 — it is a weak fallback, not a wrong one) |
| **H** | **Google Chirp 3 `ml-IN`** | in the GA streaming table ([chirp-3 docs](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3), 2026, **fetched**); **excluded from diarization** | yes | native streaming | none | commercial | **Speech-to-Text is a BAA-covered product** on [Google's HIPAA page](https://cloud.google.com/security/compliance/hipaa), 2026, **fetched**, *with data-logging disabled*; `asia-south1` exists but an explicit STT-residency statement is **unverified** | new adapter + row | **8** — the documented `ml-IN` code-mixing/transliteration artifacts (F9-M1, user report, not a spec) hit exactly our failure mode |
| **I** | **AI4Bharat IndicConformer-ml** (`…_ml_hybrid_ctc_rnnt_large`) | Malayalam, 120M, MIT ([card](https://huggingface.co/ai4bharat/indicconformer_stt_ml_hybrid_ctc_rnnt_large), 2026, **fetched**) | **none — Malayalam-only model** | **no streaming/cache-aware mode documented**; the card ships offline decode only | tiny — 120M would be the cheapest thing on the cluster | MIT | in-cluster | **needs AI4Bharat's NeMo *fork* (`nemo-v2` branch), and the `nemo` extra is a torch-2.12 venv that `uv.lock` declares in conflict with the served torch-2.8 image → a SECOND STT image, Deployment and GPU slice on a 6/6 budget** (§2.3) | **9** |
| **J** | **AI4Bharat indic-conformer-600m-multilingual** | 22 Indian languages incl. `ml`, 600M, MIT (**fetched**) | **not mentioned — unverified** | not documented (**fetched**: offline example only) | 600M | MIT | in-cluster | same second-image problem as I | **10** |
| **K** | **NVIDIA Nemotron 3.5 ASR streaming 0.6B** | **no Malayalam** (**fetched**) | yes, tier-1 | **natively cache-aware streaming**, chunks 80 ms…1.12 s (**fetched**) | 600M; concurrency 240 @80 ms / 2400 @1.12 s **on an H100** (*search-only*, **vendor self-reported**) — not transferable to a 224 GB/s card | OpenMDW-1.1 | in-cluster | `AutoModelForRNNT`, transformers ≥5.13 — **and the repo already pins `transformers>=5.13.0,<6`** (`pyproject.toml:153`) and seeds the row (`audio.ts:72`). Runs on the existing `safetensor` engine | **11** — right answer to a question HOPE is not asking (English-only, and option C is cheaper for English) |
| **L** | **Deepgram Nova-3 / AssemblyAI streaming** | **not supported** — verified absent from both vendors' own language tables (**fetched**) | yes | yes | — | — | — | — | **excluded** |

Two rows deserve their exclusion stated rather than implied: Deepgram and AssemblyAI are the
two vendors most often proposed for clinical streaming, and both are simply out on language
support. OpenAI's `gpt-4o-transcribe` is also excluded: no primary-source language table could
be located — only "Whisper's 99 languages" inherited marketing — so Malayalam support there is
**unverified**, and an unverified language claim is not a fallback.

---

## 4. Top recommendation

**Do not buy a new engine. Buy the CT2 lane of the engine you already have (option B), behind
the configuration attribution of option A, and give English-pinned departments option C.**

The argument in one line: the measured failure is deletion-dominated on *English* audio at a
healthy RTF, every knob that could diagnose or suppress that class (`beam_size`,
`log_prob_threshold`, `no_speech_threshold`, `compression_ratio_threshold`,
`condition_on_previous_text`) is implemented on the faster-whisper adapter and implemented
nowhere on the whisper.cpp adapter, the CTranslate2 conversion of the identical fine-tune is
already a seeded row, and swapping it in costs one `AiModel` row on a Global-playground sibling
agent. Compared with the alternatives that would take weeks — a second STT image for a
Malayalam-only Conformer with no documented streaming mode, or a PHI-egress decision for a
cloud lane whose Malayalam quality nobody has measured — this is the only option that buys
diagnostic power and a possible fix in the same day, with no new dependency, no new image, no
new GPU slice and no PHI decision. It also makes QW-9 executable instead of theoretical, and
it is the prerequisite for native hotword biasing (§2.4), which is the cheapest route to the
0/21 keyterm recall.

**The falsifying measurement** — and it is genuinely falsifying, not confirmatory: run the
three English fixtures through a Global sibling agent whose only difference is
`modelSlug: 'arcaai-whisper-large-ml-en-ct2'`, prompts held exactly as served. If `medical_wer`
stays in the 0.85–0.95 band and deletions stay above 45/61, **the weights are the problem, not
the runtime**, option B is dead, and the decision tree jumps straight to §8's branch 3
(re-fine-tune or split the English lane). If WER drops below ~0.4, the runtime/decode path was
the problem and options I/J/K stay unfunded indefinitely. A single confound to control: the CT2
artifact must be a conversion of *the same checkpoint* — verify `sourceUri`
`…-fullft-2607.29.1-ct2` resolves and that its tokenizer/config match the fp16 row before
reading anything into the result. **I could not verify that these three private HuggingFace
repos actually contain artifacts** (they are private; no fetch is possible from here), and if
the CT2 repo is an empty placeholder the whole recommendation collapses to option A — so
checking it is step zero and costs one authenticated API call.

---
## 5. ST-9 / OD-J — AlignAtt and SimulStreaming beside LocalAgreement

### 5.1 What AlignAtt actually needs, and which lane can give it

AlignAtt is not a post-processing rule. In `ufal/SimulStreaming`'s implementation
(`simulstreaming/whisper/simul_whisper/simul_whisper.py`, 2025/26 — **fetched**),
`PaddedAlignAttWhisper.__init__` registers a **PyTorch forward hook on `b.cross_attn` for every
decoder block**, capturing `net_output[1]` of shape `B × num_head × token_len × audio_len`. It
selects `(layer, head)` pairs from the model's `alignment_heads`, normalises and median-filters
them, and at **each generated token** takes `argmax` over `attn[:, -1, :]` to find the
`most_attended_frame` — emitting the token only while that frame is safely inside the audio
already received. **It needs live, per-step encoder-decoder attention out of the middle of
generation.**

That single requirement decides the lane, and it rules out two of the three:

| Lane | Can it hand AlignAtt per-step cross-attention? | Evidence |
|---|---|---|
| **`whisper_cpp` (the SERVED engine)** | **No.** `include/whisper.h` exposes `dtw_token_timestamps`, `dtw_aheads_preset`, `dtw_n_top`, `dtw_aheads`, `dtw_mem_size` — the same alignment-head DTW machinery, but it runs **after `whisper_full()` completes a segment**. No pywhispercpp or C API streams attention during generation. | [whisper.h](https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/include/whisper.h), 2026 — **fetched** |
| **`faster_whisper` / CTranslate2** | **No.** `Whisper.align()` is a **separate, post-hoc call** taking *already-generated* `text_tokens` and recomputing DTW; `generate()` has no per-step attention output, and CT2 issue #1716 confirms `alignment_heads`/`alignment_layer` are opaque for HF-converted models with no documented way to stream attention out of the compiled C++ decode loop. | [CTranslate2 docs](https://opennmt.net/CTranslate2/python/ctranslate2.models.Whisper.html) + [issue #1716](https://github.com/OpenNMT/CTranslate2/issues/1716), 2024–25 — **fetched** |
| **`safetensor` / transformers (PyTorch)** | **Yes** — this is the only lane where a forward hook on cross-attention is possible at all. | architectural; the served lane is `session_manager.py:2669 _make_transformers_callable`, a `model.generate()` path |

**This is a correction to ST-9 as written.** The review says *"prototype … on the CT2 or PyTorch
lane"*. **CT2 cannot host AlignAtt.** If the prototype is scoped to CT2 it will fail for a reason
that is knowable today, at zero cost.

### 5.2 Do the weights exist? Yes — and the licence is fine, with a caveat worth reading

**Weights: yes.** `arcaai-whisper-large-ml-en` (`ai-models/audio.ts:188`) declares the fp16
safetensors checkpoint of the identical fine-tune, `format: SAFETENSOR`, `libraryName:
'transformers'`, `memorySizeMb: 3584`, and the `safetensor` engine is registered streaming-capable
on CUDA float16 (`asr_capabilities.py:34-44`). OD-J's stated precondition — *"needs the fine-tune's
HF weights"* — **is already satisfied at the declaration level.** (Subject to M-D9-0: the HF repo
is private and returns HTTP 401 unauthenticated, which tells us nothing about its contents.)

**Licence: currently permissive, recently otherwise.**
`ufal/SimulStreaming` `LICENCE.txt` today reads **plain MIT, "Copyright (c) 2025 Charles
University"** (**fetched**). But the repo's GitHub Releases carry a tag `nc`, published
2025-10-22, whose body reads *"The version with non-commercial license on October 22 2025"* —
confirming it was under **PolyForm Noncommercial 1.0.0** within the last year, and the README
still asks commercial users to complete a usage questionnaire (voluntarily). `ufal/whisper_streaming`
(the LocalAgreement reference) is and was **MIT** (**fetched**). `WhisperLiveKit` is **Apache-2.0**
but its own docs still describe the SimulStreaming backend as dual-licensed/PolyForm — stale text
reflecting the pre-relicense state (**fetched**).

**Practical rule for a commercial healthcare product:** a project that moved
permissive → noncommercial → MIT inside twelve months is a licence-risk surface, not a settled
one. **Vendor the exact commit, record its SHA and its `LICENCE.txt` verbatim in the ticket, and
re-verify at adoption.** Do not depend on "SimulStreaming is MIT" as a standing fact.

### 5.3 The honest case against doing this now

- **The published gain is a gain on the wrong axis.** Simul-Whisper's abstract (**fetched**,
  [arXiv 2406.10052](https://arxiv.org/abs/2406.10052), Interspeech 2024) claims *"an average
  absolute word error rate degradation of only 1.46 % at a chunk size of 1 second"*, with the
  paper's LocalAgreement comparison in the 6.9–14.6 % band. That is a **revision/latency**
  improvement. HOPE's measured problem is **51–53 deletions of 61 words** — text that is never
  produced at all. AlignAtt would deliver those 46 characters with fewer revisions.
- **The evaluation has no overlap with HOPE's problem.** LibriSpeech + Multilingual LibriSpeech
  (Dutch, French, Polish, German, Italian, Portuguese, Spanish). **No Indic language, no
  code-switched data, anywhere in the AlignAtt / Simul-Whisper / SimulStreaming lineage** —
  including the 2026 AlignAtt4LLM follow-up (*search-only*). The numbers are the authors' own
  and I found no independent replication.
- **AlignAtt was designed for simultaneous speech *translation*.** Papi et al., Interspeech 2023
  (**fetched**): 8 MuST-C language pairs, ~2 BLEU, 0.5–0.8 s latency reduction. Transcription is
  a repurposing.
- **It costs decoder passes on a 224 GB/s card** (§1.1), and the PyTorch lane is the *slowest*
  of the three runtimes.
- **An unresolved, specific technical risk I could not close:** SimulStreaming reads
  `self.model.alignment_heads`, which is openai-whisper's per-checkpoint alignment-head set. A
  **fine-tune** loaded through HF transformers carries its heads in `generation_config`, not in
  the openai-whisper `.pt` layout. So the prototype must either export the fine-tune to the
  openai-whisper checkpoint format or port the hook to HF's `WhisperForConditionalGeneration`,
  and must verify that the *turbo* alignment heads are still meaningful after a full fine-tune.
  *(This is my inference from the fetched implementation detail, not a fetched claim; it is the
  first thing the prototype should test.)*

### 5.4 Bounded prototype and exit criteria

**Only after §8 STEP 1 returns CONFIGURATION**, and only if committed-revision rate is still the
complaint. Gate: OD-J, plus the licence record in §5.2.

**Scope (hard limits):** offline harness only — no gateway, no Redis, no session manager, no
admin surface, no `Agent` row, no GPU slice (runs on the existing STT slice off-hours, or on a
developer machine). Time-boxed to **5 working days**. One engineer. Deliverable is a scorecard
JSON plus a one-page verdict, not a branch to merge.

**Design.**
1. Day 1 — **kill-first checkpoint test.** Load `arcaai-whisper-large-ml-en` fp16 through
   openai-whisper (or HF) and confirm `alignment_heads` resolve and the cross-attention hook
   fires with sane shapes on one clip. *If this fails, stop: report §5.3's last bullet as the
   answer and close OD-J.*
2. Days 2–3 — run the 3 English fixtures + the 24 ml-en clips through (a) SimulStreaming AlignAtt
   at 1 s chunks and (b) the repo's own `LocalAgreementPolicy` over the same PyTorch lane, so the
   **policy** is the only variable. Not against the served whisper.cpp path — that would confound
   policy with runtime.
3. Days 4–5 — score with the §5.5 metrics; write the verdict.

**Exit criteria — proceed to a real ST-9 ticket only if ALL of:**

| # | Criterion | Threshold |
|---|---|---|
| E1 | The checkpoint test passes on day 1 | hook fires, heads resolve |
| E2 | `committed_revision_rate` improves materially over LocalAgreement **on the same lane** | ≥ 40 % relative reduction |
| E3 | `medical_wer` does not regress | ≤ baseline + 0.02 on English **and** CER ≤ baseline + 0.02 on ml-en |
| E4 | Commit latency improves | p50 ≥ 1 s better than the LocalAgreement arm |
| E5 | It is affordable here | inference p95 per second of audio no worse than the CT2 arm's, measured on a time-sliced Ada slice — **not** extrapolated from the paper |
| E6 | Licence recorded | commit SHA + verbatim `LICENCE.txt` in the ticket |

**Abandon immediately if:** E1 fails; or the ml-en CER regresses at all (there is no evidence
base for this policy on Indic or code-switched audio, so a regression there is an unexplained
risk, not a tuning problem); or E5 shows it needs a GPU slice that does not exist.

### 5.5 The second half of ST-9 (a natively-streaming English lane) — do not fund it

ST-9's second clause proposes Nemotron 3.5 streaming as a second `SPEECH_TO_TEXT` agent for
English-pinned departments. It is a coherent idea and HOPE has already seeded the row
(`audio.ts:72`) and pinned `transformers>=5.13.0` for `AutoModelForRNNT`. **But option C is
strictly better for that use case**: `whisper-large-en-medical-260726-merged-*` is an *in-house
English clinical fine-tune*, already seeded in three runtimes, needs no new weights, no
OpenMDW-1.1 licence review, no new architecture in the commit path, and doubles as the
diagnostic in §8 STEP 2a. Nemotron's headline numbers (240 streams @80 ms, 2 400 @1.12 s) are
**NVIDIA's own, on an H100** (*search-only*) and say nothing about a 70 W, 224 GB/s card.
Revisit only if concurrency — not accuracy — becomes the binding constraint.

---
## 6. ST-6 / OD-H — the Malayalam fallback

### 6.1 Correct the premise first

OD-H is written as *"the CT2 turbo currently declared as fallback has 4 decoder layers…"*. Two
corrections, both from the code:

1. **The CT2 turbo is never reached.** `build-resolved-asr-spec.ts:586-587` takes `chain[0]`.
   The agent declares `['arcaai-whisper-large-ml-en-gguf-q8_0', 'faster-whisper-large-v3-turbo-int8']`
   (`25-agents.ts:478`), so the **only live fallback today is the q8_0 sibling of the primary**.
   Dropping the turbo changes nothing about what runs; it only stops the seed from describing a
   fallback that does not exist.
2. **The turbo-has-4-decoder-layers concern is real and confirmed** — [whisper-large-v3-turbo card](https://huggingface.co/openai/whisper-large-v3-turbo), 2026, **fetched**: *"the number of decoding layers have reduced from 32 to 4"*, 809 M params, and the card concedes *"lower accuracy on low-resource and/or low-discoverability languages"*. But it applies **equally to the primary**, because the in-house fine-tune is itself a full fine-tune *of* `whisper-large-v3-turbo` (`audio.ts:100-113`, `baseModel: 'openai/whisper-large-v3-turbo'`). There is no 32-layer lane anywhere in this stack.

### 6.2 The real problem with the status quo fallback

A fallback to the **q8_0 quantization of the same weights** protects against exactly one failure
class: the f16 artifact failing to load, or OOM-ing. It cannot protect against the class that is
actually biting — the model producing empty/deleted output — because it is the same model. And
`engine_switch.py:52` arms only on `CloudASRTranscriptionError` / `ModelError`; a decoder that
returns 46 characters is a *success* to the switch controller. **Today's failure would never
trigger a fallback of any kind.**

Note also that **no published evidence exists on quantization quality for Malayalam or any
low-resource language.** The only quantization-vs-WER study located tests LibriSpeech English
(F16 5.35 % → Q8_0 5.25 % → Q5_0 5.19 % → Q4_0 5.61 % — [whisper-quantization-wer-degradation](https://github.com/yoarajota/whisper-quantization-wer-degradation), 2026, **fetched**, third-party, and the author explicitly notes non-English is untested). So "q8_0 is near-lossless" is an English claim being borrowed for a Malayalam decision.

### 6.3 Recommendation

**Three-part, in this order:**

1. **Now (no code): make the fallback a different *runtime* of the same weights, via an
   agent-level fallback.** Set `parameters.fallback.agentSlug` to a sibling agent whose primary
   is `arcaai-whisper-large-ml-en-ct2`. `fallbackOf()` `kind: 'agent'` gives that chain its own
   engine, decode parameters, prompt and windows (§2.5) — so the fallback is a genuinely
   different decode path (beam search, thresholds, native `vad_filter`) over identical weights.
   That is the strongest fallback available today at zero integration cost, and it doubles as
   the option-B A/B rig.
2. **Next (Wave 2, ~5 lines): wire `hotwords` on the CT2 adapter** so the fallback — and, if
   option B wins, the primary — carries native biasing instead of relying on the prompt append
   that has no admin surface (M-35). Evidence caveat in §7.4: this is *prompt-shaped* biasing on
   an attention encoder-decoder, which the literature says is a weak lever, so gate it on
   measured keyterm recall rather than assuming a win.
3. **Do NOT fund the IndicConformer lane on this evidence.** It fails on three independent
   grounds, any one of which is sufficient: it is **Malayalam-only with no English** (**fetched**)
   in a corpus whose defining property is English medical terminology inside Malayalam
   sentences; **no streaming or cache-aware mode is documented** on either AI4Bharat card
   (**fetched** — offline decode examples only); and it needs **AI4Bharat's NeMo fork on a
   torch-2.12 venv that `uv.lock` declares in conflict with the served image** (§2.3), i.e. a
   second STT image, Deployment and GPU slice against a 6/6-allocated budget. The 600 M
   multilingual sibling covers `ml` but publishes a WER **for Hindi only** (13.2 on the
   ARTPARK-IISc Vaani benchmark, **fetched**, vendor self-reported) and says nothing about
   English either. Revisit only if §8 branch 3 fires *and* an owner funds a GPU slice.

### 6.4 What a PHI-egress decision would have to say for the cloud option to be admissible

The cloud lane is not blocked by capability — **ElevenLabs Scribe v2 (D)**, **Azure `ml-IN` (F)**
and **Chirp 3 (H)** each have Malayalam in a streaming API on a primary source. It is blocked by
four statements that do not exist yet. To be admissible, an owner decision must state:

| # | Requirement | Where each candidate stands |
|---|---|---|
| 1 | **A signed BAA (or the equivalent DPDP-Act instrument) that names the specific API.** | Google: Speech-to-Text is **named** on the HIPAA-covered list, *conditional on disabling data logging* (**fetched**). ElevenLabs: BAA offered for "HIPAA-eligible services" — whether Scribe Realtime is one is **unverified**. Azure: broad BAA, but HIPAA-eligibility of Speech **in Central India** is **unverified**. Sarvam: **no BAA or HIPAA statement found at all.** |
| 2 | **Zero retention and no training on the audio, contractually, by default.** | ElevenLabs has a documented Zero Retention Mode (*search-only*); Google requires logging to be explicitly disabled; the rest unverified. |
| 3 | **A residency answer that survives the question "which region processed this utterance?"** | ElevenLabs lists India as a residency location (**fetched**) but Scribe's inclusion is unverified. Azure Speech runs in Central India, **not** South India (*search-only*). GCP `asia-south1` exists; an explicit STT residency statement is **unverified**. |
| 4 | **A named degradation posture**: what the clinician sees when the tenant's key fails, the quota is exhausted, or egress is down mid-consultation — and who is billed. | `engine_switch.py` already handles `CloudASRAuthError`/`CloudASRQuotaError` as immediate switches, so the mechanism exists; the policy does not. |

**My recommendation on OD-H: do not open a cloud lane yet, and do not open it for accuracy.**
Open it, if at all, as an *availability* fallback for a tenant that has signed its own DPA, with
its own BYO key, per the `AiProviderConnection` BYO rule — never as the platform default. And
note the asymmetry that makes the accuracy argument weak anyway: **not one of these vendors
publishes a Malayalam number, let alone a code-switched clinical Malayalam number.** ElevenLabs
buckets Malayalam as ">5–10 % WER" on its own marketing scale; that is not a measurement.

---

## 7. The code-switching question — what the literature actually establishes

### 7.1 The honest baseline: there is almost no literature

- **No Malayalam-English code-switched ASR corpus with a published system WER was found.** The
  closest primary work is a **grapheme-to-phoneme** system, not ASR: Manghat & Manghat,
  *"Malayalam-English Code-Switched: Grapheme-to-Phoneme System"*, Interspeech 2020 (PER 3.8 %
  En→Ma / 2.1 % Ma→En on code-switched words) — *search-only*.
- **No peer-reviewed clinical/medical Malayalam ASR work was found at all.** The hits are vendor
  marketing with no methodology.
- MUCS 2021, the standard Indic code-switch benchmark, covers **Hindi-English and
  Bengali-English** — not Malayalam (*search-only*).

So: HOPE is not behind the state of the art on Malayalam-English clinical ASR. **HOPE's own
scorecard, once BP-1 re-captures it, would be among the only numbers that exist.** That is a
reason to invest in the measurement apparatus (ST-4) before investing in engines.

### 7.2 Prompt-tuning — the evidence is neutral-to-negative, and the ticket's own citation says so

This is the single most consequential correction in this dossier, and it bears directly on OD-B,
OD-I and ST-3. I fetched the paper the review cites as F9-M2
([arXiv 2412.19785v1](https://arxiv.org/html/2412.19785v1), 2024 — **fetched by me**):

| Whisper-medium, **Malayalam** | WER |
|---|---|
| Baseline pre-trained | **134.40 %** |
| **Fine-tuned, no prompt** | **35.15 %** |
| **Fine-tuned, with prompt** | **35.74 %** ← *worse* |

The 134 → ~35 improvement is **fine-tuning**. The prompt made Malayalam **slightly worse** at
medium size. In the ablation (Table V) the prompt helps Malayalam only at Large (34.02 → 31.63)
and hurts at Small (41.79 → 42.37). And the paper's "prompt" is not an `initial_prompt` string
at all — it is a language-family token (`<dra>`) prepended on the decoder side **during
fine-tuning as well as inference**.

The review's Appendix C summarises F9-M2 as *"prompt-tuned Whisper-medium Malayalam WER 134 % to
33 % only when the prompt was trained in"*, which reads as evidence that trained-in prompts are a
large win for Malayalam. **On the paper's own Malayalam rows they are not a win at all.** The
correct reading is: *fine-tuning is the large win; family-token prompting is a small, sign-unstable
effect that happened to be negative for Malayalam at two of three model sizes.*

Directly on code-switched audio, the effect of an inference-time prompt is **negative**:
*"Do Prompts Really Prompt? Exploring the Prompt Understanding Capability of Whisper"*
([arXiv 2406.05806](https://arxiv.org/abs/2406.05806), 2024 — *search-only*) reports on **ASCEND,
a Mandarin-English code-switching benchmark**: with-prompt WER **15.63 %** vs no-prompt
**12.21 %** (+3.42 pp worse), and finds *mismatched* prompts sometimes beating matched ones by up
to 11 % relative — i.e. Whisper does not use text prompts the way the prompt's author intends.

**Implication for OD-B:** the external evidence now points the same way as the internal evidence
(the SINGLE-prompt arm that lost 77 % of content, TASK-946 OD-2). I would state the prior openly:
*expect the served PAIR prompt to be net-harmful, and design BP-2 to measure the size of the harm
rather than to discover its direction.* **Implication for OD-I:** re-fine-tuning *with the
inference-time prompt format* is the expensive path and F9-M2 does not support it; the cheap path
that the same paper does support is **serving prompt-less**.

### 7.3 What does have evidence behind it

Ranked by strength of evidence, for HOPE's exact error classes:

| Lever | Evidence | Verdict for HOPE |
|---|---|---|
| **Fine-tuning on in-domain code-switched data** | 134.40 → 35.15 % Malayalam WER (**fetched**, 2412.19785). Indic CS augmentation: 21.8 % relative WER reduction for Telugu, ~5 % absolute for Hindi-English (*search-only*, IEEE 2024/25) | **Strongest lever by an order of magnitude.** HOPE already did it once; the question §8 has to settle is whether *this* checkpoint regressed English. |
| **Dictionary post-correction of clinical terms** | **CER 0.2336 → 0.0820, 64.9 % relative reduction**, Korean-English code-switched clinical notes, 1,070-entry dictionary, 23,652 notes ([JMIR/PMC13344086](https://pmc.ncbi.nlm.nih.gov/articles/PMC13344086/), 2026 — **fetched** by the research lane). Matching is **rule-based** (exact / substring / n-gram / space-agnostic / single-char) — **not phonetic**. Failure mode named: the LLM stage is *"susceptible to hallucination"*, mitigated by constraining it to dictionary-anchored refinement rather than open generation | **Best evidence-to-cost ratio of any accuracy lever available** — and it is already ST-7. Two design notes it changes: (a) the precedent is *not* phonetic matching, so ST-7's "→ phonetic" tail is unevidenced and should be gated; (b) the 65 % figure is for an **LLM-plus-dictionary** pipeline, not a dictionary alone, so ST-7's rule-only design should not claim that number. |
| **Native contextual biasing (CTC/RNNT)** | Streaming CTC word-spotting: WER 12.09 → 10.48 %, F 88.26 → 95.06 % on STOP2 ([arXiv 2605.18222](https://arxiv.org/pdf/2605.18222), 2026, *search-only*). Trie-based deep biasing / TCPGen are the RNNT-native mechanisms | **Not available to HOPE** — these are transducer mechanisms, and every Malayalam-capable engine in §3 is attention encoder-decoder. This is a real architectural advantage HOPE cannot have without giving up Malayalam. |
| **Prompt/hotword biasing on Whisper** | B-Whisper ([arXiv 2502.11572v2](https://arxiv.org/abs/2502.11572), 2025, *search-only*): raw prompt-biasing cuts rare-word error 23.7 → 18.0 % **but increases unbiased WER** ("prompt misalignment"); the 45.6 % relative rare-word gain requires **fine-tuning the model for biasing** | **Weak, and it trades against general accuracy.** Wire `hotwords` on CT2 because it is cheap, but measure `medical_wer` alongside `keyterm_recall` and be willing to turn it off. |
| **LLM N-best rescoring / second pass** | General gains documented; a code-mixed rescoring claim of "up to 8 % relative" could not be verified to a primary source (*low confidence*). **No published work does N-best reranking in a genuinely streaming code-switched setting**; the streaming-compatible proposal is first-pass "Delayed Fusion" ([arXiv 2501.09258](https://arxiv.org/abs/2501.09258), 2025, *search-only*) | **Do not build this.** It is unevidenced for streaming CS, and §1.1 says the GPU budget for extra decoder passes is zero. |
| **Script-normalised evaluation** | SN-WER: transliterate reference *and* hypothesis to a canonical script before scoring; shrinks cross-model WER gaps by up to 12 % on FLEURS but inconsistently on Common Voice, so some gaps are genuine ([arXiv 2606.02548](https://arxiv.org/abs/2606.02548), 2026, *search-only*). *"What is Lost in Normalization?"* ([arXiv 2409.02449](https://arxiv.org/abs/2409.02449), 2024, *search-only*) warns that standard ASR normalization **strips Malayalam vowel signs and overstates error** | **Adopt in ST-4.** HOPE's `latin_ratio` and `script_mismatch` counters are measuring the right phenomenon with the wrong yardstick; a script flip is currently scored as a total miss. Report SN-WER *alongside* WER/CER, as the authors insist — not instead of. |

### 7.4 Where the evidence is simply absent — state it, do not infer it

- **No number, anywhere, for Malayalam-English code-switched clinical ASR.** Not from a vendor, not from a paper.
- **No quantization-quality evidence for Malayalam** (§6.2).
- **No evidence that any of the four cloud lanes handles intra-sentence Malayalam-English switching**; ElevenLabs and Chirp 3 market multilingual auto-detect, which is a *language identification* claim, not a code-switching one, and the one user report on `ml-IN` Chirp 3 is a complaint about exactly this (F9-M1).
- **No evidence about the transliteration direction problem** (English word rendered in Malayalam script vs Malayalam word romanised) beyond the evaluation-side work in the last row above. Nobody has published a fix; HOPE's `script_mismatch` counter plus a bidirectional lexicon is, as far as I can establish, an original design rather than a replication.

---
## 8. Decision tree for the owner

**The budget constraint, restated so the tree is honest:** 6 GPU units exist, 6 are allocated
(LM Studio 4, STT 1, STT worker 1). **Every option that needs a new GPU slice needs LM Studio to
give one back first** (that is OD-G). Every option below that does *not* appear in the tree with
a "costs a slice" tag runs inside the existing STT slice, on the existing image, as an `Agent`
row in the Global playground. That asymmetry — free vs. costs-a-slice-and-an-image — is what
orders the tree, more than any quality argument.

```
STEP 0  (minutes, no GPU)  — Does the artifact exist?
        Authenticated HF API call on taphuynh/…-2607.29.1-{ct2,fp16}.
        [I measured only that all three repos return HTTP 401 unauthenticated,
         which proves nothing about their contents.]
        ├─ ct2 artifact absent ────► options B and the §5 prototype are dead. Go to STEP 1
        │                            with option A only, and raise producing a CT2 + fp16
        │                            export of the checkpoint as its own small ticket.
        └─ present ────────────────► STEP 1

STEP 1  (days, no GPU, no image)  — Is it the CONFIGURATION or the WEIGHTS?
        BP-2 as written, PLUS one arm this dossier adds:
          arm X = same prompts, same everything, modelSlug → arcaai-whisper-large-ml-en-ct2
        Prior from §7.2: expect "pair prompt OFF" to be the largest single win.
        ├─ WER falls below ~0.4 on any arm ──► CONFIGURATION. Promote the winner.
        │                                     Ship option B for the decode knobs.
        │                                     STOP. Do not fund any new engine. Go to STEP 4.
        ├─ WER stays 0.85–0.95 on EVERY arm, including prompt-off and CT2 ──► WEIGHTS. STEP 2.
        └─ mixed (English recovers, Malayalam does not, or vice versa) ──► STEP 3.

STEP 2  (weeks)  — The fine-tune regressed. Two bets, run in this order:
        2a  FREE: serve `whisper-large-en-medical-260726-merged-*` (already seeded, §2.2)
            to English-pinned departments as a second SPEECH_TO_TEXT agent.
            Falsifier: if the English clinical fine-tune ALSO produces deletion-dominated
            output on the same fixtures, the fault is in the SERVING PATH, not either
            checkpoint — and every engine bet is premature. This is the cheapest
            discriminator in the whole tree and it needs one Agent row.
        2b  Re-fine-tune ml-en, prompt-less, per §7.2. This is the only lever with
            order-of-magnitude evidence behind it (134.40 → 35.15 %).
            Costs: data + training GPU, not serving GPU.

STEP 3  (weeks)  — Split the lanes by language rather than chasing one model.
        English-pinned departments → option C (free).
        Malayalam → keep the ml-en fine-tune; invest in ST-7 dictionary post-correction,
        which has the best evidence-to-cost ratio of anything in §7.3 and needs no GPU.

STEP 4  (only after STEP 1 says CONFIGURATION, and only if revision rate is the
         remaining complaint)  — the §5 streaming-policy prototype. Gated on OD-J and
         on the licence answer in §5.2.

NEVER-BEFORE-STEP-2  — anything that costs a GPU slice or a second image:
        IndicConformer (§6.3), Nemotron (option K), MPS sharing (ST-8).
```

### 8.1 Expected value, stated plainly

| Bet | Cost | Falsifier | Cost to falsify | My expected value |
|---|---|---|---|---|
| Prompt off (BP-2, OD-B) | 0 | WER unmoved with prompt off | hours | **Highest.** Two independent literatures (§7.2) and one in-repo measurement point the same way. |
| CT2 lane (option B) | 1 row | WER unmoved and deletions unmoved | hours | **High** — even a null result converts M-14 from theory to fact and unlocks QW-9. |
| English clinical agent (option C / 2a) | 1 row + 1 assignment | English fine-tune also collapses | hours | **High, and it is a diagnostic as much as a feature.** |
| Dictionary post-correction (ST-7) | weeks, no GPU | `abbrev_recall` does not clear 0.7; over-correction raises `medical_wer` | days | **High** — one strong quantified precedent, transferable design. |
| Hotwords on CT2 | ~5 lines | keyterm recall unmoved, or unbiased WER rises | hours | Medium — §7.3 says this lever is weak on Whisper. |
| AlignAtt / SimulStreaming (§5) | weeks + licence risk | revision rate unmoved at 1 s chunks | weeks | Low until STEP 1 resolves — it optimises *revisions*, and HOPE's problem is *absence*. |
| IndicConformer lane | second image + a GPU slice | no English output on the first code-switched clip | **days, if anyone bothers to check the language list — which is free** | **Negative.** §6.3. |
| Cloud lane | PHI decision + adapter | vendor's Malayalam is no better than ours | weeks + legal | Low; unmeasurable until someone signs something. |

---

## 9. What NOT to do

1. **Do not replace the engine before BP-2 attributes the collapse.** A deletion-dominated
   failure at RTF 0.12 is not an engine-capability failure. Swapping engines now would either
   mask the real cause or be blamed for it.
2. **Do not fund an IndicConformer/NeMo lane.** Malayalam-only (no English), no documented
   streaming mode, and a torch-version conflict that `uv.lock` and a unit test both enforce into
   a second image — against a 6/6 GPU budget. §6.3.
3. **Do not adopt Nemotron 3.5 / Voxtral / Kyutai / Parakeet.** None of them speaks Malayalam
   (**fetched** on all four). For the English-only case they are strictly worse value than
   option C, which is already in the seed.
4. **Do not plan around Deepgram or AssemblyAI.** Their own language tables exclude Malayalam
   (**fetched**).
5. **Do not quote H100 concurrency numbers at this cluster.** 240/2400 concurrent streams is an
   H100 figure on a 3.35 TB/s card; this fleet runs 70 W cards at 224 GB/s (§1.1).
6. **Do not add a second-pass LLM rescorer.** Unevidenced for streaming code-switch, and the
   decoder-pass budget is already fully committed (§1.1, §7.3).
7. **Do not "fix" prompting by re-fine-tuning with the current prompt format before reading
   §7.2.** The paper cited as the justification shows prompting was *neutral-to-negative* for
   Malayalam; the gain in that paper is fine-tuning.
8. **Do not turn on temperature fallback to escape a low-logprob gate.** The repo already
   measured that it *"spirals into sampled garbage"* on this fine-tune
   (`whisper_cpp_asr.py:672-680`), which contradicts the generic advice in F9-D2. Local
   measurement beats a generic best practice.
9. **Do not treat a quantized sibling as a real fallback.** Same weights, same failure modes, and
   the switch controller would not fire on today's failure anyway (§6.2).
10. **Do not open a cloud lane as the platform default.** BYO key, tenant-signed DPA, availability
    not accuracy — or not at all (§6.4).
11. **Do not build a new adapter for any engine before checking `asr_capabilities.py`.** Seven
    adapters and eleven registrations already exist; the scarce artifact in this repo is an
    `Agent` row, not an adapter.

---

## 10. Measurement requests

Ordered so each one can kill the next. **All must be run by the orchestrator** — this area ran
no transcription, started no service and executed no test.

1. **M-D9-0 — artifact existence.** Authenticated HF API `GET` on
   `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-{ct2,fp16,GGUF}`; record whether each
   carries usable artifacts (CT2: `model.bin` + tokenizer; fp16: `model.safetensors` + config) and
   whether all three derive from the same checkpoint.
   *Decision settled:* whether options B, C-analogue and the §5 prototype exist at all.
2. **M-D9-1 — the CT2 arm of BP-2.** Arms: `{gguf-f16 (served), ct2}` × `{pair prompt ON, OFF}`,
   everything else held; 3 English fixtures; N ≥ 3; quiet stack; CUDA if possible, else labelled
   MPS. Metrics: `medical_wer`, **deletion count**, `keyterm_recall`, `inference_ms`, `latin_ratio`.
   *Decision settled:* **OD-B**, and configuration-vs-weights — the root of §8.
3. **M-D9-2 — decode-knob liveness proof on the CT2 arm.** Same fixture, `beamSize` 1 vs 5 and
   `logprob_threshold` −1.0 vs −inf. *Decision settled:* whether M-14/QW-9 are closed by a row
   swap or still need adapter work.
4. **M-D9-3 — the English clinical fine-tune as a discriminator.** One Global sibling agent on
   `whisper-large-en-medical-260726-merged-gguf`, same three fixtures.
   *Decision settled:* whether the fault is the ml-en checkpoint or the serving path. **Run this
   even if M-D9-1 succeeds** — it is hours of work and it is the only arm that can exonerate the
   serving path.
5. **M-D9-4 — native hotwords on CT2 (needs the ~5-line change).** `hotwords` = the 20 row terms
   vs unset, on the CT2 arm. Gate: `keyterm_recall` up **and** `medical_wer` not worse by >0.02
   (the B-Whisper "prompt misalignment" risk, §7.3). *Decision settled:* ST-6 step 2, and whether
   the lexicon stage can be demoted.
6. **M-D9-5 — script-normalised scoring.** Re-score every existing and new scorecard with SN-WER
   alongside WER/CER, and re-score the three finals from 2026-09-18 with a normalizer that
   preserves Malayalam vowel signs. *Decision settled:* how much of `medical_wer` 0.9 is real
   error vs a scoring artifact — it will not be much, given the deletions, but it must be ruled
   out before anyone acts on the number.
7. **M-D9-6 — fallback reachability.** Force a `ModelError` mid-session with
   `parameters.fallback.agentSlug` set to a CT2 sibling agent; assert `provider_switched` fires,
   the new chain's own `beamSize`/window/prompt are in the published spec, and captions continue.
   *Decision settled:* **OD-H** step 1, and whether ST-6's "carry the chain end to end" still
   needs the model-list change or only the prompt/lexicon re-derivation.
8. **M-D9-7 (only if §8 reaches STEP 4) — the streaming-policy prototype**, per §5.4's exit
   criteria.

---

## 11. Open questions I could not close

| # | Question | Why it matters | Who can close it |
|---|---|---|---|
| 1 | Do the `-ct2` and `-fp16` HF repos contain real artifacts of the *same* checkpoint? | Gates options B, C-analogue and §5 | orchestrator/owner, one authenticated call |
| 2 | Was the ml-en fine-tune trained with, or without, the pair priming prompt in its target format? | Decides OD-I entirely; §7.2 makes the prompt-less prior strong but the training recipe would make it certain | owner / whoever holds the training config |
| 3 | What English data (if any) was in the fine-tune mix? | Today's collapse is on **English**; if English was thin, the checkpoint explains the number and §8 STEP 2 is the answer | owner |
| 4 | Is ElevenLabs Scribe inside the "HIPAA-eligible services" and "Zero Retention" scopes? | Decides whether the best-documented Malayalam cloud lane is admissible at all | vendor, in writing |
| 5 | Is Azure Speech HIPAA-eligible in Central India? | Same, for option F | Microsoft, in writing |
| 6 | Does LM Studio actually need 4 GPU units? | Unblocks every "costs a slice" option and OD-G | owner |

---

## Appendix D9-A — sources

Same convention as the ticket's Appendix C. **fetched** = the page was retrieved and the quoted
value read on it. **search-only** = seen in a search result snippet, not opened. "self-reported"
marks a number published by the party that benefits from it. **Nothing here was measured on
Malayalam-English streaming clinical audio.**

| § | Claim | Source (year) | URL | Status | Provenance |
|---|---|---|---|---|---|
| 1.1 | RTX 2000 Ada: 16 GB GDDR6, 128-bit, **224 GB/s**, 2816 CUDA cores, 70 W | NVIDIA / PNY / Dell listings (2024) | https://www.nvidia.com/en-us/products/workstations/rtx-2000/ | search-only (consistent across 3 listings) | vendor |
| 1.1 | Time-slicing gives no memory or fault isolation | NVIDIA GPU Operator, GPU sharing (2026) | https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html | fetched (as F9-G1) | vendor |
| 2.4 | `transcribe(..., hotwords: Optional[str] = None)`, *"Has no effect if prefix is not None"* | faster-whisper `transcribe.py` (2026) | https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py | **fetched** | upstream |
| 3.0, 6.1 | turbo: decoder layers **32 → 4**, 809 M params; *"lower accuracy on low-resource … languages"*; *"minor quality degradation"* | openai/whisper-large-v3-turbo card (2026) | https://huggingface.co/openai/whisper-large-v3-turbo | **fetched** | vendor |
| 3.0, K | Nemotron 3.5 ASR streaming 0.6B: 40 locales, **Hindi the only Indic**, no Malayalam; OpenMDW-1.1; 600 M; `AutoModelForRNNT`, transformers ≥5.13; chunks 80 ms–1.12 s | NVIDIA model card (2026) | https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b | **fetched** | vendor |
| K | 240 streams @80 ms / 2 400 @1.12 s **on one H100** | NVIDIA blog (2026) | https://huggingface.co/blog/nvidia/nemotron-speech-asr-scaling-voice-agents | search-only | **vendor self-reported** |
| 3.0 | Voxtral Realtime: 13 languages, **no Malayalam**; Apache-2.0; 4 B | Mistral (2026) | https://mistral.ai/news/voxtral-transcribe-2/ | fetched | vendor |
| 3.0 | Kyutai STT: `stt-2.6b-en` English-only, `stt-1b-en_fr` en+fr; CC-BY-4.0 | HF card (2026) | https://huggingface.co/kyutai/stt-2.6b-en | fetched | vendor |
| 3.0 | Open ASR Leaderboard: English + 5 European + long-form; **no Indic track**; WER + RTFx only | HF blog (2026) | https://huggingface.co/blog/open-asr-leaderboard | fetched | — |
| 3.1 I, 6.3 | IndicConformer-ml: **Malayalam only**, 120 M, MIT, 17 conformer blocks/512-dim; requires **AI4Bharat NeMo fork `nemo-v2`**; no streaming documented; no WER on card | AI4Bharat card (2026) | https://huggingface.co/ai4bharat/indicconformer_stt_ml_hybrid_ctc_rnnt_large | **fetched** | vendor |
| 3.1 J, 6.3 | indic-conformer-600m-multilingual: 22 Indian languages incl. `ml`, 600 M, MIT; only published WER **13.2, Hindi only**, ARTPARK-IISc Vaani V1.0; English unmentioned; no streaming documented | AI4Bharat card (2026) | https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual | fetched | vendor self-reported |
| 3.1 D, 6.4 | ElevenLabs Scribe v2: Malayalam (`mal`) listed, bucket *"High Accuracy (>5–10 % WER)"*; India is a data-residency location; BAA for HIPAA-eligible services | ElevenLabs docs (2026) | https://elevenlabs.io/docs/capabilities/speech-to-text | fetched | vendor |
| 3.1 D | *"<150 ms"* realtime latency; Zero Retention Mode | ElevenLabs (2026) | https://elevenlabs.io/realtime-speech-to-text | search-only | **vendor self-reported** |
| 3.1 F, 6.4 | `ml-IN` present in real-time STT; **Custom Speech for `ml-IN` is audio + human-labeled transcript ONLY — plain-text phrase lists not supported** | Azure language support, STT tab (2026) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt | **fetched** | vendor |
| 6.4 | Central India hosts Speech; South India does not | Azure regions (2026) | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions | search-only | vendor |
| 3.1 H, 6.4 | Chirp 3 `ml-IN` in the GA `StreamingRecognize` table; **excluded from diarization** | Google Cloud STT (2026) | https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3 | **fetched** | vendor |
| 6.4 | **Speech-to-Text is a BAA-covered product**, conditional on disabling data logging | Google HIPAA compliance (2026) | https://cloud.google.com/security/compliance/hipaa | **fetched** | vendor |
| 3.1 E, 6.4 | Sarvam: `ml-IN` incl. streaming, "codemix" mode, <150 ms TTFT, India localization, on-prem option; **no BAA/HIPAA statement found** | Sarvam (2026) | https://www.sarvam.ai/apis/speech-to-text/malayalam | search-only | **vendor self-reported; BAA unverified** |
| 3.1 L, 9 | **Deepgram: Malayalam absent** from both language tables | Deepgram docs (2026) | https://developers.deepgram.com/docs/models-languages-overview | **fetched** | vendor |
| 3.1 L, 9 | **AssemblyAI: Malayalam absent from streaming** (19 langs); batch-only | AssemblyAI docs (2026) | https://www.assemblyai.com/docs/streaming/universal-streaming/multilingual-transcription | **fetched** | vendor |
| 3.1 | OpenAI `gpt-4o-transcribe`: **no primary language table located** — Malayalam support **unverified** | OpenAI docs (2026) | https://developers.openai.com/api/docs/guides/realtime-transcription | search-only | — |
| 5.1 | AlignAtt needs live per-step cross-attention: forward hook on `b.cross_attn` per decoder block, `net_output[1]` `B×num_head×token_len×audio_len`, `argmax` → `most_attended_frame` | ufal/SimulStreaming `simul_whisper.py` (2025–26) | https://github.com/ufal/SimulStreaming | **fetched** | upstream |
| 5.1 | CT2 `Whisper.align()` is **post-hoc**, takes already-generated `text_tokens`; `generate()` has no per-step attention | CTranslate2 docs + issue #1716 (2024–25) | https://github.com/OpenNMT/CTranslate2/issues/1716 | **fetched** | upstream |
| 5.1 | whisper.cpp `dtw_token_timestamps` / `dtw_aheads*` run **after `whisper_full()`**; no live attention API | whisper.h (2026) | https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/include/whisper.h | **fetched** | upstream |
| 5.2 | SimulStreaming `LICENCE.txt` is **MIT, © 2025 Charles University**; release tag `nc` (2025-10-22) = *"The version with non-commercial license"* | ufal/SimulStreaming (2025–26) | https://raw.githubusercontent.com/ufal/SimulStreaming/main/LICENCE.txt | **fetched** | upstream |
| 5.2 | `ufal/whisper_streaming` is MIT; WhisperLiveKit is Apache-2.0 and its docs still describe SimulStreaming as PolyForm-dual-licensed (stale) | ufal / QuentinFuxa (2023–26) | https://github.com/ufal/whisper_streaming | **fetched** | upstream |
| 5.3 | *"average absolute word error rate degradation of only 1.46 % at a chunk size of 1 second"*; LibriSpeech + MLS (nl/fr/pl/de/it/pt/es); **no Indic, no code-switch** | Simul-Whisper, Interspeech 2024 | https://arxiv.org/abs/2406.10052 | **fetched** | **authors' own** |
| 5.3 | AlignAtt is a simultaneous speech **translation** policy: 8 MuST-C pairs, ~2 BLEU, 0.5–0.8 s latency | Papi et al., Interspeech 2023 | https://www.isca-archive.org/interspeech_2023/papi23_interspeech.html | fetched (abstract) | authors' own |
| 5.3 | No AlignAtt/SimulStreaming evaluation on low-resource or code-switched languages found; AlignAtt4LLM (IWSLT 2026) is standard pairs only | — (2026) | https://arxiv.org/abs/2606.03967 | search-only | — |
| 6.2 | whisper quantization on **LibriSpeech English only**: F16 5.35 % → Q8_0 5.25 % → Q5_0 5.19 % → Q4_0 5.61 %; author notes non-English untested | independent study (2026) | https://github.com/yoarajota/whisper-quantization-wer-degradation | **fetched** | third-party |
| 7.1 | Malayalam-English CS: closest primary work is a **G2P** system (PER 3.8 % / 2.1 %), not ASR; MUCS 2021 CS tracks are Hindi-En and Bengali-En; **no clinical Malayalam ASR paper found** | Manghat & Manghat, Interspeech 2020 | https://www.isca-archive.org/interspeech_2020/manghat20_interspeech.pdf | search-only | authors' own |
| **7.2** | **Whisper-medium Malayalam: baseline 134.40 % → fine-tuned no-prompt 35.15 % → fine-tuned WITH prompt 35.74 % (worse).** Ablation: Small 41.79 → 42.37 (worse), Large 34.02 → 31.63 (better). "Prompt" = language-family token on the decoder side, used **during fine-tuning and inference** | Prompt-Tuning and Tokenization for Indian Languages (2024) | https://arxiv.org/html/2412.19785v1 | **fetched by me** | authors' own |
| 7.2 | **Code-switched ASCEND: with-prompt WER 15.63 % vs no-prompt 12.21 %** (worse); mismatched prompts sometimes beat matched by up to 11 % relative | *Do Prompts Really Prompt?* (2024) | https://arxiv.org/abs/2406.05806 | search-only | authors' own |
| 7.3 | Streaming CTC word-spotting biasing: WER 12.09 → 10.48 %, F 88.26 → 95.06 % (STOP2) | arXiv 2605.18222 (2026) | https://arxiv.org/pdf/2605.18222 | search-only | authors' own |
| 7.3 | B-Whisper: raw prompt-biasing 23.7 → 18.0 % rare-word error **but raises unbiased WER**; 45.6 % relative gain needs fine-tuning for biasing | arXiv 2502.11572v2 (2025) | https://arxiv.org/abs/2502.11572 | search-only | authors' own |
| 7.3 | Korean-English CS clinical: **CER 0.2336 → 0.0820 (64.9 % relative)**, WER 0.3709 → 0.2590; 1 070-entry dictionary, **rule-based not phonetic**; 23 652 notes; LLM stage *"susceptible to hallucination"* | JMIR (2026) | https://pmc.ncbi.nlm.nih.gov/articles/PMC13344086/ | fetched (research lane) | authors' own |
| 7.3 | No published LLM N-best reranking in a streaming code-switched setting; streaming-compatible proposal is first-pass "Delayed Fusion" | arXiv 2501.09258 (2025) | https://arxiv.org/abs/2501.09258 | search-only | authors' own |
| 7.3 | SN-WER: transliterate ref + hyp to a canonical script; shrinks gaps up to 12 % on FLEURS, inconsistent on Common Voice; report **alongside** WER/CER | arXiv 2606.02548 (2026) | https://arxiv.org/abs/2606.02548 | search-only | authors' own |
| 7.3 | Standard ASR normalization **strips Malayalam vowel signs**, overstating error | *What is Lost in Normalization?* (2024) | https://arxiv.org/abs/2409.02449 | search-only | authors' own |
| 7.3 | Indic CS augmentation: 21.8 % relative WER reduction (Telugu); ~5 % absolute (Hindi-English) | IEEE (2024/25) | https://ieeexplore.ieee.org/document/10835062 | search-only | authors' own |

**Could not verify at all** (attempts recorded): `ai4bharat/indicwhisper` (HF 401, gated) — its
licence and Malayalam WER are search-snippet only; OpenAI's enumerated transcription language
list; Gnani.ai's and Reverie's language tables; Bhashini/ULCA's full language matrix; Voxtral's
VRAM requirement on a Mistral primary page; whether ElevenLabs Scribe is inside the India
residency and Zero-Retention scopes; whether Azure Speech is HIPAA-eligible in Central India;
the contents of the three private `taphuynh/…` HuggingFace repos (all return HTTP 401
unauthenticated, which is consistent with private *or* absent).

**Numbers to treat as self-reported:** every vendor latency and concurrency figure above;
Simul-Whisper's 1.46 %; AI4Bharat's Vaani 13.2; ElevenLabs' WER bucketing; Sarvam's entire row.
