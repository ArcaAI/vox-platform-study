# TASK-831 — Align the model catalogue with the serving tiers

| | |
|---|---|
| **Status** | Review (research + seed proposal; nothing applied) |
| **Type** | infrastructure / docs |
| **Branch** | `dev-2.2` |
| **Related** | TASK-818 (Text LLM router, D-5 priority order), TASK-823 (vLLM, "priority #1"), TASK-824 (LM Studio, "priority #2"), TASK-736 (Ollama catalog purge), TASK-763/766 (day-one seed) |
| **Researched** | 2026-08-30, against live vendor documentation |

## 1. Requirement Analysis

The owner named five models, all GGUF, all 4-bit quantized:

**LLM / multimodal:** `gemma4-e2b-it-qat`, `gemma4-e4b-it-qat`, `granite-guardian-4.1-8b`, `qwen3.5-4B`
**Text embedding:** `text-embedding-embeddinggemma-300m-qat`

The platform's written engine priority is **vLLM #1, LM Studio #2** (TASK-818 D-5). Every model on the
owner's list is GGUF. This ticket exists to resolve that collision, verify each model actually exists,
size the set against fixed hardware, and propose catalogue rows.

## 2. THE ENGINE VERDICT — the priority order is inverted for this catalogue

**vLLM + GGUF is not a production path, and the case is now stronger than when it was last assessed.**
This was re-verified against current vLLM documentation rather than taken on trust, and the situation
has moved *against* GGUF since:

| Evidence | Source |
|---|---|
| "GGUF support in vLLM is **highly experimental and under-optimized** at the moment, it might be incompatible with other features." | [vLLM GGUF docs](https://docs.vllm.ai/en/stable/features/quantization/gguf/) |
| **In-tree GGUF support has been DEPRECATED** and moved out-of-tree: "This plugin provides out-of-tree GGUF quantization support for vLLM **after in-tree support deprecation**." | [vllm-gguf-plugin](https://github.com/vllm-project/vllm-gguf-plugin) |
| The deprecation RFC's own reasoning: bitsandbytes and GGUF "see **very low usage relative to the maintenance burden**" — roughly **0.5% and 0.1%** of usage respectively; GGUF carries ~6,000 lines of CUDA kernels. | [vLLM RFC #39583](https://github.com/vllm-project/vllm/issues/39583) |
| Only single-file GGUF is loadable; multi-file must be merged with `gguf-split`. | vLLM GGUF docs |
| Tokenizer conversion from GGUF is "time-consuming and unstable"; the docs recommend taking the tokenizer from the base model instead. | vLLM GGUF docs |
| vLLM's own **Gemma 4 recipe never mentions GGUF at all** — it documents BF16, FP8 KV, and QAT W4A16. | [vllm-project/recipes Gemma4.md](https://github.com/vllm-project/recipes/blob/main/Google/Gemma4.md) |

**GGUF is used by ~0.1% of vLLM users and is now a third-party plugin.** For a clinical platform,
running the safety- and summarization-critical path on the least-used, explicitly-deprecated,
"highly experimental" code path of the engine is not defensible.

### 2.1 The consequence, stated plainly

**For the owner's five-model catalogue as specified, the priority order is inverted:
llama.cpp / LM Studio is the serving tier, and vLLM has nothing to serve.**

This does **not** repeal TASK-818 D-5 as a general policy. It scopes it:

| Statement | Status |
|---|---|
| "vLLM is priority #1" as a *general* engine policy | **Still correct** — for AWQ/FP8/BF16 safetensors checkpoints |
| "vLLM is priority #1" *for these five GGUF models* | **Wrong** — vLLM cannot serve them on a supported path |

There are exactly two ways to restore vLLM to #1, and both are owner decisions, not engineering ones:

1. **Source different artifacts.** Serve safetensors/AWQ/FP8 checkpoints instead of GGUF. For the
   Gemma 4 pair Google publishes `-qat-q4_0-unquantized` (safetensors from the QAT run) and vLLM's
   recipe documents QAT W4A16 — but the recipe states official W4A16 checkpoints exist **for the
   dense models only**, not E2B/E4B. So this path is *not* currently open for E2B/E4B specifically.
2. **Accept the plugin.** Run `vllm-gguf-plugin` and own the risk. Not recommended for a PHI path.

**A third fact settles it independently of all the above:** vLLM's own Gemma 4 recipe states
E2B/E4B require **24 GB+ of VRAM**. The cards here are **15.99 GiB**. vLLM cannot serve the owner's
two headline models on this hardware in *any* format.

### 2.2 A real advantage vLLM has that llama.cpp does not

Recorded so this is not a one-sided verdict: vLLM has **full, first-class Per-Layer Embeddings (PLE)
support** for Gemma 4 E2B/E4B, "including scale buffers, OOV guards, and PP adaptations"
([vLLM gemma4 model docs](https://docs.vllm.ai/en/latest/api/vllm/model_executor/models/gemma4/)).
llama.cpp's PLE status is *weaker evidence* — see §4.1. That is a genuine quality argument for vLLM,
and it is defeated here only by the 24 GB VRAM floor, not by principle.

## 3. Verified model table

Every identifier below was checked against the live HuggingFace repo. "Unverified" means exactly that.

| Owner's name | Real identifier | Publisher | Format / quant | On-disk | Engine that can serve it | Vision path |
|---|---|---|---|---|---|---|
| `gemma4-e2b-it-qat` | `google/gemma-4-E2B-it-qat-q4_0-gguf` | **Google DeepMind (official)** | GGUF Q4_0, **QAT** | `gemma-4-E2B_q4_0-it.gguf` **3.35 GB** + `gemma-4-E2B-it-mmproj.gguf` **987 MB** | llama.cpp / LM Studio | mmproj **shipped**; see §4.1 |
| `gemma4-e4b-it-qat` | `google/gemma-4-E4B-it-qat-q4_0-gguf` | **Google DeepMind (official)** | GGUF Q4_0, **QAT** | `gemma-4-E4B_q4_0-it.gguf` **5.15 GB** + `gemma-4-E4B-it-mmproj.gguf` **992 MB** | llama.cpp / LM Studio | mmproj **shipped**; see §4.1 |
| `granite-guardian-4.1-8b` | weights `ibm-granite/granite-guardian-4.1-8b`; GGUF **`ibm-granite/granite-guardian-4.1-8b-GGUF`** | **IBM (official GGUF)** | GGUF, full quant ladder Q2_K→bf16 | **Q4_K_M 4.77 GiB** (5.12 GB) · Q4_0 4.49 GiB | llama.cpp / LM Studio | n/a (text classifier) |
| `qwen3.5-4B` | `Qwen/Qwen3.5-4B` | Alibaba (weights); **NO official GGUF** | GGUF only as community re-quant (`bartowski`, `lmstudio-community`, `unsloth`) | **Q4_K_M 2.81 GiB** · Q4_0 2.59 GiB | llama.cpp (support merged, [PR #19468](https://github.com/ggml-org/llama.cpp/pull/19468)) | multimodal — vision unified into the **same** repo, no separate `-VL` |
| `text-embedding-embeddinggemma-300m-qat` | `ggml-org/embeddinggemma-300M-qat-q4_0-GGUF` | **ggml-org (llama.cpp maintainers)**, from Google's QAT checkpoint | GGUF Q4_0, **QAT** | **278 MB** | **llama.cpp only** (§5) | n/a |

### 3.1 Provenance — which are official, which are not

For a clinical platform this distinction is load-bearing:

- **Official vendor GGUF (best provenance):** both Gemma 4 QAT models, **and Granite Guardian**. Google
  publishes the Gemma GGUFs itself, and they are genuinely **QAT**, not a post-training re-quant of a
  BF16 checkpoint. IBM publishes `ibm-granite/granite-guardian-4.1-8b-GGUF` (created 2026-05-26) with
  a full quant ladder — so the platform's **safety model has first-party provenance**, which is the
  outcome a clinical deployment wants.
- **Near-official:** the embedding model. `ggml-org` is the llama.cpp maintainers' own org, quantizing
  Google's QAT checkpoint. This is the best available and is what llama.cpp's own docs use.
- **Community re-quant (weaker provenance):** **Qwen3.5-4B alone.** A live query of the `Qwen` HF org
  returns **zero** GGUF repos; every 4-bit GGUF is third-party (`bartowski` and `lmstudio-community`
  are the reputable ones; the org also hosts many "abliterated"/"uncensored" derivative re-quants that
  must not be used clinically). **This is now the only provenance gap in the owner's list.**

> ⚠ **Correction made during this research.** An earlier draft of this section recorded Granite
> Guardian as community-re-quant-only. That was **wrong** — IBM ships an official GGUF. The claim was
> corrected after direct verification against the HF API. Recorded here because the erroneous version
> would have prompted an unnecessary owner decision.

### 3.2 QAT vs PTQ — the owner's `-qat` suffix is honoured for three of the five

The owner specified `-qat` on the two Gemma models and on the embedding model. All three genuinely
exist as QAT:

- Gemma 4 E2B/E4B: Google's QAT "allows preserving similar quality to bfloat16 while dramatically
  reducing the memory requirements."
- EmbeddingGemma: Google publishes MTEB numbers for the QAT checkpoint —
  **full precision 61.15 → Q8_0 60.93 → Q4_0 60.62** (multilingual mean). A **0.53-point** drop at
  4-bit, i.e. near-lossless *because it is QAT*.
  ([model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card))
- ⚠ A **non**-QAT post-training Q4 of the same base model would be expected to degrade further; no
  benchmark for that comparison was found. **Use the `-qat-` repos, not a generic Q4 re-quant.**

Note a naming trap: `google/embeddinggemma-300m-qat-q4_0-unquantized` is **not GGUF and not
quantized** — it is safetensors (1.21 GB) from the QAT run, published so third parties can quantize
it. It is the *base* of the GGUF repos, not an alternative to them.

## 4. Findings that change how these must be deployed

### 4.1 The multimodal path — it works, and the real trap is a stale binary

**The projector ships, and it was verified by parsing the GGUF headers directly** (HTTP range request),
not by trusting filenames:

```
general.type              = mmproj
general.architecture      = clip
clip.has_vision_encoder   = True
clip.has_audio_encoder    = True          # one projector carries BOTH modalities
clip.vision.projector_type = gemma4v
clip.audio.projector_type  = gemma4a
general.file_type          = 32 (BF16)
clip.{vision,audio}.attention.layer_norm_epsilon = 1e-06
```

The main-model header independently confirms this ticket's KV arithmetic:
`attention.shared_kv_layers = 20` for E2B (§6.2 derives 35 − 20 = 15 KV-computing layers) and
`context_length = 131072`.

**Engine support is real, in both modalities:**

| Modality | llama.cpp support | Evidence |
|---|---|---|
| Vision | ✅ merged 2026-04-02 | [PR #21309](https://github.com/ggml-org/llama.cpp/pull/21309); `docs/multimodal.md` lists E2B/E4B under Vision models |
| Audio | ✅ merged 2026-04-12 | [PR #21421](https://github.com/ggml-org/llama.cpp/pull/21421) implements `mtmd_audio_preprocessor_gemma4a`, matching the file's `gemma4a` projector; E2B/E4B listed under **Mixed modalities** |

**The feared failure mode does not apply to `llama-server`: it fails loudly.** Missing projector
raises `"image input is not supported - hint: if this is unexpected, you may need to provide the
mmproj"` (`server-common.cpp:1217`), and the audio equivalent at `:1230`. There is no silent
text-only degradation on a missing mmproj.

#### ⚠ The actual silent-degradation risk: the runtime version, not the file

Two bugs shipped that produced **plausible-but-wrong multimodal output with no error at all**:

| Bug | Fix | Effect if unpatched |
|---|---|---|
| Multimodal projector used **post-norm**; Gemma 4 swapped to **pre-norm** | [PR #23822](https://github.com/ggml-org/llama.cpp/pull/23822), merged 2026-05-28 | Degraded vision output, silently |
| Audio RMS-norm eps hardcoded `1e-5` instead of `1e-6` | [PR #23815](https://github.com/ggml-org/llama.cpp/pull/23815) | Degraded audio; baked into converted files |

**Hard floor: llama.cpp build `b9383` (2026-05-28) or later.** Between roughly b8630 and b9383 the
server loads the projector, emits no error, and is quietly wrong. Google's current files carry the
corrected `1e-06`, verified in the header above.

#### Three deployment conditions

1. **Pin the runtime at ≥ `b9383`**, and preferably materially higher — `mtmd` churned further
   through early June.
2. **`-m` does NOT auto-pair the projector; only `-hf` does.** `llama-server -m gemma-4-E2B_q4_0-it.gguf`
   without `--mmproj` is a text-only server. **Pass `--mmproj` explicitly and assert it at boot.**
3. **Use the BF16 projector.** PR #21421 warns: *"It is recommended to use BF16 mmproj. Other
   quantizations are known to have degraded performance."* Google's is BF16; ggml-org's Q8_0 variant
   (557 MB) falls under that warning.

Google's card additionally specifies: audio max **30 seconds**, and modality order matters —
**image before text, audio after text**.

#### ⚠ LM Studio is the weaker choice for these two models

- **Vision works** (auto-pairs any mmproj in the model folder, with no opt-out —
  [issue #1760](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1760)).
- **Audio: no evidence of support.** No badge, no changelog entry; the OpenAI-compat docs say only
  *"Chat Completions (text and images)"*. Recorded as **UNVERIFIED-negative**, not as a confirmed gap.
- **A model-specific load failure was filed against these exact repos:**
  [issue #2169](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2169) — Google's Gemma 4
  GGUFs crashed LM Studio 0.4.19 (`exitCode=3221226505`) *"regardless of whether an mmproj file is
  present."* **Resolved by Google re-uploading on 2026-07-17** ("Upload validated QAT GGUF checkpoint
  (280 sequence length, corrected vocabulary)"), not by an LM Studio fix. **Current files are good —
  but any copy cached or mirrored between 15–17 July 2026 is poisoned.** Verify checksums against the
  current HF blobs before staging into MinIO.

**If the audio path is required, LM Studio should be considered out and llama.cpp used directly.**

#### The `ggml-org` alternative — faster, but not QAT

`ggml-org/gemma-4-E2B-it-GGUF` / `-E4B-it-GGUF` also exist, with **smaller Q4_0** files (E2B 2.84 GB,
E4B 4.59 GB) and **MTP multi-token-prediction weights Google's QAT repos lack** — a documented >2×
speedup path. Their BF16 projectors are byte-identical in size to Google's but have **different
SHA256** (independently converted; do not assume interchangeability).

**Recommendation: stay on Google's QAT repos.** The owner specified `-qat`, and QAT is a genuine
quality property (§3.2), not a label. The ggml-org MTP speedup is worth a follow-up ticket, not a
silent substitution.

### 4.1b Per-Layer Embeddings — the one unresolved quality question

The more serious question is **Per-Layer Embeddings**, which E2B/E4B depend on architecturally:

> llama.cpp issue [#22243](https://github.com/ggml-org/llama.cpp/issues/22243) — "Gemma 4 E2B/E4B
> Per-Layer Embeddings (PLE) not implemented in forward graph" — reported that PLE tensors are
> *loaded* but the auxiliary per-layer signal may never be *injected* into the decoder layers,
> "leading to subtly degraded output quality" with **no crash**.

**Resolution, reported honestly:** the issue is **closed as `completed`** (opened 2026-04-22, closed
2026-04-23 by the reporter, 4 comments). A llama.cpp **member (CISC)** directed the reporter to follow
the `inp_per_layer` variable, indicating PLE *is* wired into the forward graph, and the reporter
accepted and closed it. **But no maintainer stated outright that PLE is fully implemented, and no
benchmark was published.** The balance of evidence favours "implemented", and this is not a blocker —
but it is **weaker evidence than vLLM's explicit PLE support**, and the failure mode is silent quality
degradation, not an error. **Recommendation: run a quality spot-check of E2B/E4B output against the
vLLM or Google reference before these serve clinical traffic.** Do not assume.

### 4.2 `qwen3.5-4B` — servable, but the weakest link

Two of the three concerns initially raised against this model **dissolved on verification**, and that
is recorded rather than quietly dropped:

- ✅ **llama.cpp support exists.** Qwen3.5 support is **merged**
  ([PR #19468](https://github.com/ggml-org/llama.cpp/pull/19468)). The hybrid architecture is not a
  blocker.
- ✅ **It is cheap on KV.** Its hybrid design is an *advantage* here — see §6.2.

What genuinely remains:

1. **No official GGUF.** A live query of the `Qwen` HF org returns **zero** GGUF repos. Every 4-bit
   GGUF is a community re-quant. This is the only model on the list without first-party artifacts.
2. **Its slug is retired and must not be un-retired.** `lms-qwen3.5-4b` is in
   `RETIRED_AI_MODEL_SLUGS` (`seed/ai-models/retired.ts:69`), whose header states:
   *"NEVER remove a slug from this ledger once added — that un-retires it and leaves any tenant's
   already-materialised copy pointing at a removed engine."* A new row must therefore use a **new
   slug**, not the retired one. Note the ledger retired **four** Qwen3.5 LM Studio slugs (`-4b`,
   `-0.8b`, `-9b`, `-35b-a3b`), so this model was deliberately removed once before.

**Architecture, for the record** (raw `config.json`): 32 layers split by `full_attention_interval: 4`
into **8 full-attention layers** (`num_key_value_heads` 4, `head_dim` 256) and **24 Gated-DeltaNet
linear-attention layers** carrying a *fixed-size* recurrent state that does not grow with sequence
length. `hidden_size` 2560, `vocab_size` 248,320, native context **262,144**. Vision is unified into
the same checkpoint (`vision_config` present, `pipeline_tag: image-text-to-text`) — there is no
separate `-VL` repo.

**Recommendation: drop `qwen3.5-4B` from the day-one catalogue — on capacity grounds, not capability.**
It is servable. But it is the only model lacking first-party artifacts, its slug collides with a
ledger that forbids reuse, and §6.4 shows it is what starves the guardrail model of KV headroom. If
the owner wants it, it should displace something rather than join everything.

### 4.3 Four of the five already exist in the catalogue — with wrong memory figures

This ticket is mostly a **correction**, not five additions. Live rows in
`packages/database/src/prisma/db_main/seed/ai-models/llm.ts`:

| Slug | Line | `memorySizeMb` today | Measured reality | Verdict |
|---|---|---|---|---|
| `lms-gemma-4-e2b-it-qat` | 107 | **2048** | 3.35 GB weights (**3195 MiB**) + 987 MB mmproj | **Understated ~36% (text) / ~64% (with vision)** |
| `lms-gemma-4-e4b-it-qat` | 128 | **3072** | 5.15 GB weights (**4912 MiB**) + 992 MB mmproj | **Understated ~37% / ~68%** |
| `granite-guardian-4.1-8b` | 58 | 4900 | ~5 GB at Q4_K_M | Approximately right |
| *(embedding)* | — | — | — | **No embedding row exists at all** |

`memorySizeMb` is what capacity planning reads. **Both Gemma rows understate their own weights**, and
neither accounts for the ~1 GB projector. On a node with no VRAM isolation (§6), an understated
figure is not a cosmetic error — it is how a card gets oversubscribed and takes production STT down
with it.

## 5. The embedding plane — a separate answer, and TEI is ruled out

Do not assume the LLM answer transfers. It does not.

| Engine | Can it serve a **GGUF** embedding model? | Evidence |
|---|---|---|
| **llama.cpp** | **YES — this is the answer** | EmbeddingGemma support merged [PR #15798](https://github.com/ggml-org/llama.cpp/pull/15798), build **b6384**. `llama-server --embeddings`, OpenAI-compatible `/v1/embeddings`. |
| LM Studio | Yes (same llama.cpp engine) | Serves `/v1/embeddings`; has an embedding-gemma model page. Prefix/MRL behaviour undocumented. |
| **TEI** | **NO — ruled out by format** | TEI's supported-models doc lists **safetensors and ONNX only**. It *can* serve embeddinggemma, but only from the safetensors checkpoint, never the GGUF. |
| vLLM | No / unverified | GGUF docs are generative-only; the OOT plugin lists no pooling/embedding architectures. |

**This contradicts the current platform assumption.** `apps/text` registers exactly one embedding
provider — `tei-embed` (`apps/text/src/text/main.py:188-194`), which POSTs to TEI's native `/embed`.
**TEI cannot load the owner's GGUF file.** Serving `text-embedding-embeddinggemma-300m-qat` therefore
requires **either**:

- **(a)** point the embedding provider at a **llama.cpp** `/v1/embeddings` endpoint (new provider, or
  reuse `openai_compat` shape), **or**
- **(b)** keep TEI and serve the **safetensors** checkpoint `google/embeddinggemma-300m` instead of
  the GGUF — which contradicts the owner's "all GGUF" instruction but needs no new provider.

**This is an owner decision and is flagged, not decided here.** (a) honours the instruction; (b) is
less work. Note there is currently **no `AiModel` row for any text-embedding model**, and no
`FEATURE_EXTRACTION` member in the seed's mirrored `ModelTaskType` — adding one requires extending
the mirror in `seed/ai-models/shared.ts`.

### 5.1 Two silent-correctness traps for the embedding path

1. **Task prefixes are mandatory and no engine applies them.** EmbeddingGemma requires
   `task: search result | query: {content}` for queries and `title: none | text: {content}` for
   documents. Sentence-Transformers applies these automatically; **llama.cpp and LM Studio do not**.
   Omitting them does not error — it **silently degrades retrieval quality**.
2. **Matryoshka truncation is caller-side.** Truncating 768 → 512/256/128 requires the caller to slice
   **and L2-renormalize**; Google's model card explicitly requires re-normalization. llama.cpp exposes
   no server-side truncation.

Also note the two Q4_0 GGUFs differ in size (ggml-org **278 MB** vs lmstudio-community **229 MB**),
most likely because the SentenceTransformers dense modules
([PR #16367](https://github.com/ggml-org/llama.cpp/pull/16367)) are an optional conversion flag and
omitting them degrades embedding quality. **Prefer the 278 MB `ggml-org` build** and verify its tensor
list before deployment.

## 6. Co-tenancy plan — the arithmetic

### 6.1 The hardware, and why "fits" is not the same as "safe"

From TASK-823 §2A (read from live GPU-Feature-Discovery labels, not documentation):

| Fact | Value |
|---|---|
| GPUs | 2 × RTX 2000 Ada, **15.99 GiB each** (16380 MiB), one node → **31.98 GiB total** |
| MIG / MPS / vGPU | **all false** — no isolation mechanism exists |
| Sharing | time-slicing, `replicas: 3` → **6 fungible permits**, no VRAM accounting, no card pinning |
| Already resident | `hope-stt` ~3.9 GiB + `hope-stt-worker` ~3.7 GiB = **~7.6 GiB** |
| Bandwidth | **224 GB/s** per card |
| Outside k8s accounting | LM Studio runs on the node **host** and holds VRAM the scheduler cannot see |

**Free pool: 31.98 − 7.6 ≈ 24.4 GiB**, minus unmeasured LM Studio host usage.

### 6.2 KV arithmetic — Gemma 4's cache is unusually small, and that is the whole story

`KV bytes/token = 2 × layers × kv_heads × head_dim × dtype_bytes`, **but only over layers that
compute their own KV**. Gemma 4 shares KV across a back-loaded block, which changes the answer
dramatically. From `config.json`:

| | E2B | E4B |
|---|---|---|
| `num_hidden_layers` | 35 | 42 |
| `num_kv_shared_layers` | 20 | 18 |
| **Layers computing own KV** | **15** | **24** |
| `num_key_value_heads` | **1** | **2** |
| `head_dim` / `global_head_dim` | 256 / 512 | 256 / 512 |
| `sliding_window` | 512 | 512 |

**E2B:** 15 × 2 × 1 × 256 × 2 B = **15.0 KiB/token** (uniform `head_dim` 256).
Full-attention layers using `global_head_dim` 512 raise this to ≈ **18 KiB/token**.

**E4B:** 24 × 2 × 2 × 256 × 2 B = **48.0 KiB/token**; with the 4 full-attention layers at
`global_head_dim` 512, ≈ **56 KiB/token**.

**Method validated against a published figure:** at 128k context E4B gives
131,072 × 49,152 B = **6.44 GB**, matching the reported "saving about 6 GB at 128K context for E4B"
with roughly half the cache saved by sharing. The band **48–56 KiB/token** is therefore sound to
about ±20%. Sliding-window layers cap at 512 tokens in implementations that exploit it, which makes
the **realized** figure lower — so these are upper bounds.

**For scale, quantization shrinks weights, not KV.** Qwen3-4B's KV geometry is **144 KiB/token**
(TASK-823 §2A.2) — Gemma 4 E4B is **~3× cheaper per token**, and E2B ~8× cheaper. This is why the
Gemma 4 pair fits here and an 8B-class model does not.

Per-sequence KV:

**Granite Guardian 4.1 8B — verified, and it is the expensive one.** Raw `config.json` confirms a
**dense** `GraniteForCausalLM` (40 layers, 32 attention heads, **8 kv heads**, `hidden_size` 4096 →
`head_dim` **128**, `vocab_size` 100,352, context **131,072**). It is **not** the hybrid Mamba-2
architecture the "Granite 4" branding suggests — that is the separate `-h-` line. So the standard
formula applies to **all 40 layers**:

`2 × 40 × 8 × 128 × 2 B` = **160 KiB/token** — more than 3× Gemma 4 E4B and ~10× E2B.

**Qwen3.5-4B — cheap, because only 8 layers keep a growing cache.**
`2 × 8 × 4 × 256 × 2 B` = **32 KiB/token** for the full-attention layers, plus a *fixed* recurrent
state for the 24 linear-attention layers that does not scale with context.

Per-sequence KV:

| Model | KiB/token | @4k | @8k | @32k |
|---|---|---|---|---|
| Gemma 4 E2B | 15–18 | 72 MiB | 144 MiB | 576 MiB |
| Qwen3.5-4B | 32 (+fixed state) | 128 MiB | 256 MiB | 1.0 GiB |
| Gemma 4 E4B | 48–56 | 224 MiB | 448 MiB | 1.75 GiB |
| **Granite Guardian 8B** | **160** | **640 MiB** | **1.25 GiB** | 5.0 GiB |

The guardrail model dominates KV consumption. Because it is a **classifier that emits yes/no against a
template**, its inputs are short — sizing it at 8k+ would waste the node's scarcest resource. **Cap
its `--ctx-size` deliberately** rather than inheriting its 128K maximum.

### 6.3 Weights ledger

All figures are measured file sizes (HTTP `Content-Length` on the actual GGUF objects), not estimates.

| Model | Weights | + projector | Total resident |
|---|---|---|---|
| Gemma 4 E2B q4_0 | 3.35 GB = **3.12 GiB** | 987 MB = 0.92 GiB | **4.04 GiB** |
| Gemma 4 E4B q4_0 | 5.15 GB = **4.80 GiB** | 992 MB = 0.92 GiB | **5.72 GiB** |
| Granite Guardian 4.1 8B **Q4_K_M** | 5.12 GB = **4.77 GiB** | — | **4.77 GiB** |
| *(Granite at Q4_0 instead)* | 4.82 GB = **4.49 GiB** | — | *(saves 0.28 GiB)* |
| Qwen3.5-4B **Q4_0** | 2.78 GB = **2.59 GiB** | — | **2.59 GiB** |
| EmbeddingGemma 300M q4_0 | 278 MB = **0.26 GiB** | — | **0.26 GiB** |
| **Subtotal — four models (no Qwen), vision on** | | | **14.79 GiB** |
| **Total — all five** | | | **17.38 GiB** |

### 6.4 The plan

**All five fit on weights. Only four fit with a usable KV budget.**

**Recommended placement — four models:**

| Card | Resident | Weights | Free for KV + activations | Capacity |
|---|---|---|---|---|
| **Card 0** (holds STT ~7.6 GiB → 8.39 GiB free) | EmbeddingGemma + Gemma 4 **E2B** (+mmproj) | 0.26 + 4.04 = **4.30 GiB** | **~4.09 GiB** | **~28 seq @ 8k** (E2B at 144 MiB/seq) |
| **Card 1** (15.99 GiB free) | Gemma 4 **E4B** (+mmproj) + Granite Guardian | 5.72 + 4.77 = **10.49 GiB** | **~5.50 GiB** | e.g. 3.5 GiB → **~8 E4B seq @ 8k**, 2.0 GiB → **~6 guardrail seq @ 2k** |

**Adding Qwen3.5-4B to Card 1** takes weights to 13.08 GiB and collapses the KV budget from
**5.50 → 2.91 GiB** — for *three* models that must also fund activations and CUDA graphs
(TASK-823 measured ~1.2 GiB for a single vLLM instance). After that overhead there is roughly
**1.5–2 GiB of real KV left across three models**, i.e. ~3 guardrail calls *or* ~4 summarization
sequences, not both.

**The trade-off, stated plainly:** Qwen3.5-4B is only 2.59 GiB and is genuinely servable — the cost is
not its own footprint, it is that **it halves the KV budget on the card that hosts the guardrail
model**. On hardware with **no VRAM isolation and no card pinning**, where per TASK-823 §2A.1 one
pod's CUDA OOM can crash every pod sharing the card — and the likely casualty is `hope-stt`, a working
production capability — spending the last of the margin on the one model that has no first-party GGUF
and a retired slug is the wrong purchase. **Drop it, or displace something with it. Do not simply add
it.**

**A cheaper variant if all five are mandatory:** serve Granite Guardian at **Q4_0** (4.49 GiB, −0.28)
and cap its context at 2k, and run Gemma 4 E2B **text-only** (drop the 987 MB projector if vision is
not needed on the small model, −0.92). That recovers ~1.2 GiB. It makes five *possible*; it does not
make them *comfortable*.

**Two caveats that bound all of the above:**

1. **Placement cannot be guaranteed.** Time-slicing hands out fungible permits; nothing pins a model
   to a card. The table above is a *plan*, not something the scheduler will enforce. Achieving it
   requires either a single-process server owning both cards, or accepting that the layout may not hold.
2. **Measure before trusting.** LM Studio on the host holds VRAM outside k8s accounting. Real free
   VRAM must be read with `nvidia-smi`, not computed from this table.

**Bandwidth remains the unfixed constraint.** At 224 GB/s these models will serve a handful of
concurrent users at readable speed, not the 20–40 target TASK-823 sized against. Fitting in VRAM and
being fast enough are different questions; this section answers only the first.

## 7. Proposed `AiModel` seed rows

**PROPOSAL ONLY — not applied.** The orchestrator owns DB surfaces. Rows follow the exact
`AiModelSeed` shape (`seed/ai-models/shared.ts:250-293`) and the `80000000-0000-0000-0007-…` id block.

Fields deliberately **not** used because they do not exist on `AiModelSeed`: `contextLength` (it lives
on `AiRuntimeProfile.contextLength`) and `fileSizeMb` (a real Prisma column, but no seed row sets it).

### 7.1 Corrections to existing rows (the main change)

```ts
// llm.ts:107 — lms-gemma-4-e2b-it-qat
-    memorySizeMb: 2048,
+    // 3.35 GB q4_0 weights (3195 MiB) + 987 MB mmproj projector.
+    memorySizeMb: 4136,

// llm.ts:128 — lms-gemma-4-e4b-it-qat
-    memorySizeMb: 3072,
+    // 5.15 GB q4_0 weights (4912 MiB) + 992 MB mmproj projector.
+    memorySizeMb: 5858,
```

Both rows should also gain `sourceRevision` pinning and a `sourceUri` that matches what the serving
engine is actually told to call the model — see §7.4.

The Granite Guardian row's `memorySizeMb: 4900` is close enough to the measured **4885 MiB** (Q4_K_M)
to leave alone, but its `computeType` says `'q4_k_s'` while the measured quant above is **Q4_K_M**.
One of the two is wrong; the row should be reconciled against whichever file is actually staged. IBM
ships the full ladder (Q2_K → bf16) at `ibm-granite/granite-guardian-4.1-8b-GGUF`, so
`sourceUri`/`sourceRevision` can now name a first-party artifact rather than a bare slug.

### 7.2 New row — the embedding model

Requires first adding `FEATURE_EXTRACTION: 'FEATURE_EXTRACTION'` to the mirrored `ModelTaskType` in
`seed/ai-models/shared.ts` (the Prisma enum already has it; only the seed mirror lacks it), and
`'llama-cpp'` is already a valid `AI_MODEL_PROVIDERS` member.

```ts
{
  id: '80000000-0000-0000-0007-000000000030',
  tenantId: SYSTEM_TENANT_ID,
  name: 'EmbeddingGemma 300M QAT (llama.cpp)',
  slug: 'llama-cpp-embeddinggemma-300m-qat',
  description:
    'Google EmbeddingGemma 300M, QAT q4_0 GGUF from ggml-org — platform text-embedding model. Served by llama-server --embeddings (mean pooling, /v1/embeddings). NOT servable by TEI: TEI loads safetensors/ONNX only. Caller MUST apply the task prefixes ("task: search result | query: ..." / "title: none | text: ...") and MUST L2-renormalize after any Matryoshka truncation — neither is applied server-side.',
  category: ModelCategory.NLP,
  taskType: ModelTaskType.FEATURE_EXTRACTION,
  modelType: ModelType.QUANTIZED_MODEL,
  source: AiModelSource.HUGGINGFACE,
  sourceUri: 'ggml-org/embeddinggemma-300M-qat-q4_0-GGUF',
  sourceRevision: 'main',
  format: AiModelFormat.GGUF,
  provider: 'llama-cpp',
  architecture: 'gemma3',
  memorySizeMb: 278,
  computeType: 'q4_0',
  tags: ['embedding', 'llama-cpp', 'qat', 'retrieval'],
},
```

### 7.3 `qwen3.5-4B` — proposed NOT to seed

No row is proposed, for the three reasons in §4.2. **If the owner overrides this**, the row must use a
**new slug** (e.g. `llama-cpp-qwen3.5-4b`) — never `lms-qwen3.5-4b`, which the retirement ledger
forbids reusing — and its llama.cpp hybrid-architecture support must be verified first.

### 7.4 ⚠ The `sourceUri` / `--served-model-name` trap

Recorded because it fails at **request** time, not startup:

> `resolveTextSelectionForKey` returns `model: model.sourceUri`, and that string goes on the wire as
> the OpenAI `model` field. If the served model name differs from the `sourceUri` of the `AiModel` row
> that `AiTaskDefault` points at, **every generation 404s**. (TASK-823 §5A)

The existing Gemma rows use bare LM Studio-style identifiers (`gemma-4-e2b-it-qat`) rather than HF repo
ids, which is correct **for LM Studio**, whose catalogue is keyed on the `<publisher>/<model>` directory
tree. **If these models move to a llama.cpp server, `sourceUri` must change to whatever
`--alias`/served name that server advertises.** The proposed embedding row uses the HF repo id because
that is what `llama-server -hf` resolves and advertises; **verify against the running server before
enabling it.**

## 8. Unverified — explicit list

Resolved during research (recorded so the list is not read as still-open): Granite Guardian's official
GGUF, its exact file sizes and its dense (non-Mamba) architecture; Qwen3.5-4B's file sizes and its
merged llama.cpp support; the existence and structure of both Gemma 4 projectors.

Genuinely still unverified:

| Item | Status |
|---|---|
| **llama.cpp PLE correctness for E2B/E4B** | Issue closed `completed`, maintainer *implied* support, **never stated outright**; no benchmark. **The most consequential open item** — failure mode is silent quality loss (§4.1b) |
| **LM Studio audio support for Gemma 4** | No badge, no changelog entry, docs say "text and images". **UNVERIFIED-negative** — absence of evidence, not evidence of absence (§4.1) |
| LM Studio auto-application of embedding task prefixes / MRL truncation | Not documented by LM Studio; assume caller-side (§5.1) |
| Granite Guardian "Bring Your Own Criteria" feature | Secondary-source only; not re-confirmed from the model card |
| Qwen3.5-4B extended context "~1,010,000 tokens" | Secondary reporting only. Shipped `config.json` has `rope_type: "default"` with **no scaling configured** — native 262,144 is the verified number |
| Cause of the 278 MB vs 229 MB embedding GGUF delta | Most likely the optional SentenceTransformers dense modules; not confirmed |
| Non-QAT Q4 degradation for EmbeddingGemma | No benchmark found; QAT numbers exist, PTQ numbers do not |
| **Real free VRAM on the node** | **Not measured.** LM Studio host usage sits outside k8s accounting — every number in §6 is a planning figure, not an observation |

**One risk no amount of metadata inspection closes:** every multimodal finding above verifies *files*
and *merged PRs*. It does not prove the running server uses them correctly. **Before clinical traffic,
run one smoke test per modality against a known-answer image and a known-transcript audio clip and
diff against the HF Transformers reference.** That is the only check that closes the gap between "the
file is right" and "this server uses it right".

## 9. Implementation Summary

Research and proposal only. **No code, schema, seed or migration was modified.** Deliverables are
§2 (engine verdict), §3 (model table), §5 (embedding plane), §6 (co-tenancy), §7 (seed proposal).

**Decisions required from the owner:**

1. **Accept the inverted priority for GGUF** — llama.cpp/LM Studio serves this catalogue; vLLM is
   retained as #1 for safetensors/AWQ checkpoints only (§2.1).
2. **Embedding transport** — (a) new llama.cpp embedding provider honouring "all GGUF", or (b) keep
   TEI on the safetensors checkpoint (§5). TEI **cannot** load the GGUF; this cannot be left as-is.
3. **Drop `qwen3.5-4B`** from day one, or name what it displaces (§4.2, §6.4).
4. **Serving engine for the Gemma 4 pair** — llama.cpp directly, or LM Studio. If the **audio**
   modality is required, this is not a free choice: LM Studio has no evidence of audio support (§4.1).

**Engineering follow-ups implied (not owner decisions):**

- Pin the llama.cpp runtime at **≥ b9383** and assert it — below that, vision and audio are silently
  wrong (§4.1).
- Assert `--mmproj` is passed at boot; `-m` does not auto-pair it.
- Verify staged GGUF checksums against current HF blobs — the 15–17 July 2026 Google uploads were
  broken and later replaced (§4.1).
- Cap Granite Guardian's context deliberately; it is 160 KiB/token and defaults to 128K (§6.2).
- Correct the two understated `memorySizeMb` values before anyone plans capacity from them (§4.3).

## 10. Change History

| Date | Change |
|---|---|
| 2026-08-30 (research pass 2) | **Two of my own claims corrected by verification, recorded rather than quietly amended.** (1) Granite Guardian was written up as community-re-quant-only; IBM in fact publishes **`ibm-granite/granite-guardian-4.1-8b-GGUF`** (2026-05-26, full Q2_K→bf16 ladder), so the safety model has first-party provenance and **Qwen3.5-4B is the only remaining provenance gap**. (2) Qwen3.5-4B was written up as having unverified llama.cpp support for its Gated-DeltaNet hybrid; support is **merged** ([PR #19468](https://github.com/ggml-org/llama.cpp/pull/19468)), so the recommendation to drop it now rests on capacity and provenance, not capability. Verified geometries replaced estimates: Granite Guardian is a **dense** `GraniteForCausalLM` (40 layers, 8 kv heads, head_dim 128 → **160 KiB/token**, confirming the earlier estimate exactly) and is **not** the hybrid Mamba line the "Granite 4" branding implies; Qwen3.5-4B keeps a growing cache on only **8 of 32 layers** (**32 KiB/token**). Parsed both Gemma 4 **mmproj GGUF headers directly**: one projector carries **both** vision (`gemma4v`) and audio (`gemma4a`) encoders in BF16, and `attention.shared_kv_layers = 20` independently confirms this ticket's KV derivation. Established that the real silent-degradation risk is **not** a missing projector — `llama-server` errors loudly — but a **stale binary**: a post-norm/pre-norm projector bug and an audio eps bug produced plausible-but-wrong multimodal output with no error until **b9383** (2026-05-28), which is now a hard runtime floor. Recorded that Google's 15–17 July uploads of these exact repos were broken and silently replaced, that `-m` does not auto-pair the projector, and that LM Studio has **no evidence of audio support**. |
| 2026-08-30 | Ticket created. Re-verified vLLM GGUF status against current docs: prior conclusion **holds and is stronger** — in-tree GGUF is now **deprecated** (RFC #39583, ~0.1% usage) and moved to the out-of-tree `vllm-gguf-plugin`; vLLM's own Gemma 4 recipe never mentions GGUF and states E2B/E4B need 24 GB+ vs the node's 15.99 GiB. All five models pinned to real HF ids with measured file sizes; both Gemma 4 QAT GGUFs are **official Google** and ship mmproj projectors, while Granite Guardian and Qwen3.5-4B have **no official GGUF**. Found four of the five already seeded, with `lms-gemma-4-e2b-it-qat` / `-e4b-` **understating `memorySizeMb` by 36–68%**. Recovered KV geometry from `config.json` (E2B 15 KV-computing layers × 1 head; E4B 24 × 2) giving **15–18 / 48–56 KiB per token** — validated against the published ~6 GB-at-128k figure, and ~3–8× cheaper than Qwen3-4B, which is why these fit. Established that **TEI cannot serve the GGUF embedding model at all** (safetensors/ONNX only), contradicting the platform's only registered embedding provider. Recommended dropping `qwen3.5-4B` (no official GGUF, retired slug that must not be reused, unverified hybrid-architecture support, and it is what breaks the VRAM budget). |
