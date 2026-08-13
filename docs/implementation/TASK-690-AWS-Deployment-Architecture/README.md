# TASK-690 — AWS Deployment Architecture & GitHub Actions Migration

| Field | Value |
|---|---|
| **Status** | `Pending` — solution design, no code written |
| **Type** | `infrastructure` |
| **Ticket number** | **PROVISIONAL.** Assigned as next-after-TASK-689; confirm against `docs/implementation/` + `docs/archive/` before this doc is treated as canonical. |
| **Region** | `ap-south-1` (Mumbai) |
| **Target scale** | Pilot — 1–5 tenants, < 50 concurrent consultations |
| **Service window** | 06:00–20:00 IST (14 h/day = 58 % duty cycle) |
| **Hard constraints** | Monthly budget ceiling (**number not yet supplied**) + zero-downtime/SLA |
| **Evidence base** | Four parallel audits, 2026-08-13: monorepo runtime inventory, `hope-v2-deployment` manifest audit, GitLab CI audit, AWS ap-south-1 pricing research |

---

## 0. The four findings that shaped everything else

Before the architecture, the four discoveries that changed the answer:

1. ~~**Only ONE service actually needs a GPU.**~~ **SUPERSEDED 2026-08-13 — see §2A.** This was true of the *manifests* and false of the *platform*. STT is the only workload declaring `nvidia.com/gpu`, but SMR, guardrail, and harness all depend on LLM inference served by **LM Studio at `10.10.1.10:1234`** — a host process with no manifest, invisible to a manifest audit. It serves at least three models to five roles. On AWS it must become something, and every option is a GPU. Worse, `apps/{smr,harness,guardrail}/.env.prod` already point at `http://hope-vllm:8000/v1`, so the production intent is self-hosted vLLM. §2A replaces this finding.

2. **The budget ceiling and the zero-downtime requirement are in direct conflict, and the resolution is a scoping decision, not an engineering one.** Zero-downtime *inside the 06:00–20:00 service window* is affordable. Zero-downtime *24/7* forbids the scale-to-zero that makes a 14-hour duty cycle worth having, and doubles the GPU line. **This design commits to: zero-downtime during service hours; 20:00–06:00 is a declared maintenance window.** If that is wrong, say so — it changes the number by roughly $500/month.

3. **The single-GPU-node SPOF has a nearly free fix you already built.** A hot-standby GPU node costs ~$515/month. But your STT service already has a provider abstraction with automatic fallback (TASK-614), and Amazon Transcribe streaming supports both `ml-IN` and `en-IN` in ap-south-1. Registering Transcribe as the failover provider buys zero-downtime on the clinical path for *only what an incident consumes*, instead of a permanently-idle second A10G.

4. **Roughly 40 % of the migration cost is paying down debt the audits found, not moving to AWS.** Node-local `hostPath` model caches, a single-node Shamir-sealed Vault with unseal keys stored in the cluster it protects, no ingress and no TLS anywhere, no StorageClass, `minAvailable: 0` on every PDB, an unprobed STT worker, two Temporal deployments of which the live one is a VM outside Kubernetes, and 15 container images rebuilt on every single push regardless of what changed. These are pre-existing defects. AWS does not fix them, but the migration is the natural forcing function.

---

## 1. Requirement Analysis

### 1.1 What is being deployed

From the runtime inventory — **13 long-running workloads + 3 jobs**:

| Workload | Runtime | GPU | Stateful? | Notes |
|---|---|---|---|---|
| `hope-api` | Node 24 / NestJS, :8868 | no | connection-stateful | 3 WS gateways + 9 SSE routes; **WS resume state is a per-process in-memory Map** — no cross-pod resume. Also hosts 10 in-process BullMQ processors. |
| `hope-admin-console` | Node 24 / Next.js standalone, :3000 | no | no | BFF, SSE passthrough |
| `hope-compat-playground` | static SPA via `serve` | no | no | |
| `hope-smr` | Python/FastAPI, :8862 | no | no | Pure LLM gateway, **no local model** |
| `hope-guardrail` | Python/FastAPI, :8863 | no | own DB conn | GLiNER ONNX CPU + llama.cpp CPU; sanctioned direct-Postgres exception |
| `hope-nlp` | Python/FastAPI, :8864 | **no, by design** | no | CUDA stack explicitly excluded from image (TASK-647) |
| `hope-harness` | Python/FastAPI, :8866 | no | no | Best-effort Temporal connect; must boot without it |
| `hope-harness-worker` | Python / Temporal worker | no | no | Heaviest non-GPU: 1 CPU / 2 Gi requested, 4 CPU / 6 Gi limit |
| `hope-tts` | Python/FastAPI, :8865 | no | no | CPU-pinned torch (1.39 GB vs 7.34 GB unpinned); Kokoro ~327 MB fetched at runtime. **Peak RSS scales with concurrency, not audio length** — 7.2 GB at N=5 pre-fix. |
| `hope-stt-v2` | Python/FastAPI, :8861 | **YES** | Redis session state | CUDA 12.8; startup probe allows **up to 15 min** |
| `hope-stt-v2-worker` | Dramatiq worker | **YES** | no | **Zero probes of any kind** — a wedged worker is never restarted |
| `hope-qdrant` | Qdrant v1.16 StatefulSet | no | **PVC** | `knowledge_chunks`, 1024-dim (bge-m3) |
| `hope-vault` | Vault 1.18.3 StatefulSet | no | **PVC** | Single node, Shamir, **no resource requests at all** |
| `hope-temporal` (+UI) | auto-setup 1.25.1 | no | external DB | **Dead code** — live Temporal is a VM at `10.10.1.10:7233` |
| Jobs | `db-migrate` (PreSync), `qdrant-init` (Sync w1), `smoke-test` (PostSync w5) | | | |

Plus an in-cluster observability stack: Prometheus, Grafana, Loki, Tempo, Alertmanager, OTel Collector, Alloy (DaemonSet), kube-state-metrics, node-exporter (DaemonSet).

### 1.2 Current operational baseline

One node named `dell`: **16 vCPU, 48 GB RAM, 2× RTX 2000 Ada (16 GB each), ~93 GB ephemeral**, sitting at ~15/16 CPU and 44/48 GB *requested*. Real data volume: 33 users, 14 consultations, 1,255 audit rows. Only `hope-v2-dev` exists; staging and prod namespaces are defined in Git but have never been created.

This matters for sizing: the resource **requests** are calibrated to keep pods scheduled on one box, not to measured load. Do not port them to AWS verbatim and then buy hardware to match — they are ceilings, not demand.

### 1.3 PHI classification (drives BAA scope and encryption)

| Holds PHI | Metadata only |
|---|---|
| Postgres `core` schema — `Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `TranscriptSegment`, `TranscriptionJob` | Redis (persistence deliberately disabled) |
| `UserVoiceProfile.embedding` — pgvector 256-dim biometric voiceprint, **deliberately unencrypted** for cosine similarity | Prometheus / Grafana / Loki / Tempo |
| S3 buckets `recordings`, `generated-audio`, `hope-audio`, `hope-audio-chunks` | Qdrant `knowledge_chunks` (reference corpus, not patient data) |
| Vault (holds the keys, not the data) | Temporal visibility DB (workflow IDs, not transcripts) |

---

## 2. Decision 1 — Inference: self-host GPU vs SageMaker vs Lambda

You asked directly which is best. **Self-host on an EKS GPU node, with Amazon Transcribe registered as the failover provider.** Here is why the alternatives lose.

### 2.1 The comparison

| Option | Verdict | Pilot cost/mo | Why |
|---|---|---|---|
| **Self-host on EKS GPU** (`g5.xlarge`, 14 h/day) | ✅ **Recommended** | **~$515** | Keeps your fine-tuned ml-en GGUF/CTranslate2 models. Your STT service ships as-is. Karpenter gives real scale-to-zero. |
| **SageMaker real-time endpoint** (`ml.g5.xlarge`) | ❌ | ~$700+ | Two independent blockers. (a) SageMaker adds a premium over the equivalent EC2 rate and real-time endpoints **do not scale to zero** — you pay 24/7 for a 14-hour workload, which is exactly backwards for your duty cycle. (b) More fundamental: **your STT service is not a model server.** It is a stateful FastAPI app doing VAD → ASR → diarization → punctuation, holding WebSocket sessions and Redis Streams state with a 500 MB/session audio buffer and a 15 s reconnect grace window. SageMaker endpoints serve stateless request/response. You would have to split the model out of the service and rebuild the session layer around it. |
| **SageMaker Serverless Inference** | ❌ | — | **CPU only. No GPU option exists.** Disqualified outright. |
| **SageMaker Async Inference** | ⚠️ Partial fit | scale-to-zero | Genuinely good for the **Dramatiq batch transcription queue** — async, queue-driven, scales to zero between jobs. Useless for live streaming. Worth considering later to move batch off the live GPU node; not for the pilot. |
| **AWS Lambda** | ❌ | — | Four hard blockers: no GPU at any memory tier; 15-minute execution cap against ~87-minute session support; 10 GB memory cap against a 3.5 GB model plus audio buffers; and no persistent WebSocket — streaming ASR is inherently connection-stateful. Lambda is appropriate for `db-migrate`/`qdrant-init`-shaped one-shot jobs, not for models. |
| **Amazon Transcribe streaming** | ⚠️ Failover role | ~$0.024/min | `ml-IN` and `en-IN` are both supported for streaming in ap-south-1 (ap-south-1 is *not* on the streaming exclusion list). But it has no Malayalam–English **code-switch** fine-tune — which was the entire point of TASK-594. Using it as primary is a quality regression on your core clinical case. |

### 2.2 The break-even you should know

```
g5.xlarge @ 14 h/day  = $1.208/hr × 426 hr/mo  = $515/mo
Transcribe streaming  = ~$0.024/min  (⚠ us-east-1-derived; verify the ap-south-1 rate)

Break-even = $515 ÷ $0.024 ≈ 21,500 min/month
           ≈ 715 min/day
           ≈ 36 twenty-minute consultations per day
```

**Below ~36 consultations/day, Transcribe is cheaper than owning a GPU.** At 14 consultations total in the dev DB today, you are far below that line — so on pure cost, Transcribe wins the pilot.

It still loses, because the ml-en code-switch fine-tune is a clinical-quality requirement, not a cost line. But this number tells you exactly when the GPU starts paying for itself, and it is the number to revisit if pilot volume stays low.

### 2.3 Recommended inference topology

| Capability | Placement | Rationale |
|---|---|---|
| **ASR (live)** | Self-hosted, EKS GPU node, `g5.xlarge` | Fine-tuned ml-en model; no managed equivalent |
| **ASR (failover)** | Amazon Transcribe streaming, `ml-IN`/`en-IN` | Registered as a provider in the existing auto-fallback (TASK-614). Costs nothing until an incident. **This is what buys zero-downtime without a second GPU.** |
| **ASR (batch)** | Same GPU node initially; SageMaker Async later | Dramatiq queue tolerates latency |
| **LLM summarization** | **Bedrock** — see governance flag below | SMR already has a Bedrock provider. At pilot volume, per-token beats a dedicated GPU by a wide margin. |
| **TTS (English)** | Kokoro, CPU, on Graviton | Already CPU-only. No GPU needed. Cap concurrency — RSS scales with parallel synths, not audio length. |
| **TTS (Malayalam)** | Sarvam (current) — evaluate Polly | Polly has Hindi + Indian English via the bilingual Kajal voice; **a Malayalam voice is not confirmed.** Verify before planning a migration. |
| **NER / guardrail / reranker** | CPU on Graviton | Already CPU-only by design |

> ### 🚩 Governance flag — Bedrock + Claude in India routes data OUT of India
> Models hosted **natively** in ap-south-1 are Mistral, Gemma, and MiniMax. Claude and Nova reach Indian customers through **Global Cross-Region Inference (CRIS)** (`global.anthropic.claude-*`), which by definition routes inference outside the region.
>
> You did not select "all PHI stays in India" as a hard constraint, so this design does not forbid it. But for a healthcare platform that may become ABDM/HRP-registered — where India-residency *is* the operative requirement — sending clinical text to a cross-region endpoint is a decision that needs an explicit, recorded owner sign-off, not a default. **If residency is required: use an ap-south-1-native Bedrock model, or self-host the summarization LLM on the same GPU node during off-peak.**

---

## 2A. GPU Tier — REVISED (supersedes §0.1 and parts of §2.3)

Added 2026-08-13 after a second audit pass across all six Python services plus AWS GPU-hardware research. Three facts below invalidate earlier conclusions; they are marked ⚠.

### 2A.1 The GPU surface is five roles, not one service

`hope-stt-v2` is the only workload declaring `nvidia.com/gpu`, but **LM Studio at `10.10.1.10:1234` serves at least three models to five roles**, and it has no manifest — which is why the first audit missed it:

| Role | Model | Config default |
|---|---|---|
| SMR summarization | `gemma-4-e2b-it-qat` (~2B, QAT) | `apps/smr/src/smr/core/config.py:135,146` |
| Guardrail guardian | `granite-guardian-4.1-8b` (4.9 GB, `q4_k_s`) | `apps/guardrail/src/guardrail/core/config.py:69,337` |
| Harness safety guard | `granite-guardian-4.1-8b` | `apps/harness/src/harness/core/config.py:81,84` |
| Harness eval judge | `google/gemma-4-e4b` | `apps/harness/src/harness/eval/config.py:49` |
| Harness embeddings | `bge-m3` (1024-dim) | `apps/harness/src/harness/core/config.py:173` |

Plus `bge-reranker-v2-m3` on TEI at `:8870`. Harness loads **nothing** locally except MiniCheck (`n_gpu_layers=0`, default-disabled). SMR has zero ML dependencies — no `torch`, no `transformers`.

**LM Studio does multi-model on-demand load/unload. vLLM does not** — one model per instance. So this is not a swap; it is either N vLLM instances, or Ollama, or consolidating roles. **The guardian and the judge are two separate 8B-class models doing closely-related evaluation work — collapsing them is the cheapest VRAM you will ever recover.**

Production intent is already vLLM: `apps/{smr,harness}/.env.prod` point at `http://hope-vllm:8000/v1`; `apps/guardrail/.env.prod` sets the URL with `ENABLED=false`. ⚠ **Unresolved:** these per-app `.env.prod` files are not part of the `NODE_ENV`-selected env contract, and the cluster actually reads generated ConfigMaps. Confirm which is authoritative — it changes the GPU count.

### 2A.2 ⚠ The concurrency target is decided by a hardcoded bucket table, not by benchmarking

`apps/stt/src/stt/streaming/execution_profile.py:299-358` picks `max_concurrent_streams` from a **literal lookup keyed on VRAM and GPU count** — nothing scales continuously:

| Detection | Max concurrent streams | Batch |
|---|---|---|
| CUDA, primary VRAM **≥ 40 GB** | **100** | 32 |
| CUDA, VRAM < 40 GB, ≥ 2 GPUs | 40 | 8 |
| CUDA, VRAM < 40 GB, 1 GPU | **20** | 8 |
| Apple Silicon / CPU | 5–50 | 2–4 |

`CapacityGuard` (`streaming/capacity_guard.py:59-66`) enforces this and returns **HTTP 503 + `Retry-After`** past the ceiling.

**Consequence for a <50-concurrent target:**

- `g5.xlarge` (A10G, 24 GB) → falls in the `< 40 GB, 1 GPU` bucket → **20 streams. Does not reach 50.**
- `g6.xlarge` (L4, 24 GB) → same bucket → **20 streams.**
- 2× `g5.xlarge` → still one STT pod per node detecting one GPU → **20 each.**
- `g6e.xlarge` (**L40S, 48 GB**) → crosses the 40 GB threshold → **100 streams.**

`STREAMING_MAX_CONCURRENT` can override the bucket, but the buckets encode real VRAM limits — overriding without a benchmark is how you OOM. **Under the profile logic as written, `g6e.xlarge` is the only single-card option that reaches the stated pilot target.**

### 2A.3 ⚠ The "Transcribe as free failover" recommendation does not work today

§2.3 proposed Transcribe as the registered failover to buy zero-downtime without a standby GPU. **The code cannot fire that failover on a GPU failure.**

`EngineSwitchController` only switches on `SWITCHABLE_ASR_ERRORS` = `CloudASRAuthError`, `CloudASRQuotaError`, `CloudASRTranscriptionError`, `ModelError` (`streaming/engine_switch.py:49-60`). But **no local ASR engine wraps CUDA failures into `ModelError`** — verified absent across `faster_whisper_asr.py`, `whisper_cpp_asr.py`, `parakeet_cpp_asr.py`. A `torch.cuda.OutOfMemoryError` or driver loss raises a bare `RuntimeError`, which lands in the generic handler at `streaming/inference.py:372-383` and **degrades silently to an empty transcript without calling `record_failure`**.

So a GPU dying mid-session produces no failover, no error, and no alert — just missing transcript. **Prerequisite: wrap CUDA/OOM errors into `ModelError` in the local engine adapters.** Small change, entirely load-bearing for the availability story.

Guardrail has the mirror-image problem: no circuit breaker, no retry, no cross-provider fallback, and it **fails open** (`safe: True`) on any LLM error (`providers/openai_compat.py:409-426`). A GPU loss there means clinical content passes safety screening unchecked. **This is why the generation pool cannot go on spot** — reversing §5.3's earlier suggestion.

### 2A.4 Hardware selection

Verified against the official AWS region-instance-types page: **`g6e` IS offered in ap-south-1** (family list: `G4dn | G5 | G6 | G6e | G6f | Gr6 | Gr6f | G7e | Inf1 | Inf2 | P4d | P5 | P5en | P6-B200 | Trn1`). The earlier source contradiction is resolved. Confirm actual `xlarge` capacity via `DescribeInstanceTypeOfferings` before committing.

| | A10G (`g5.xlarge`) | L4 (`g6.xlarge`) | L40S (`g6e.xlarge`) |
|---|---|---|---|
| VRAM | 24 GB | 24 GB | **48 GB** |
| Bandwidth | 600 GB/s | 300 GB/s | **864 GB/s** |
| FP8 | No (Ampere) | Yes | Yes |
| MIG | No | No | No |
| $/hr | 1.208 | 0.9664 | 2.235 |
| STT bucket | 20 streams | 20 streams | **100 streams** |

**`g6` is 20 % cheaper but has half A10G's memory bandwidth.** LLM decode is bandwidth-bound, so A10G should deliver ~2× the tok/s for 1.25× the price — roughly **1.6× better $/token**. This is spec-derived, not a matched benchmark; L4 could win on prefill-heavy workloads where its FP8 tensor cores engage. Benchmark with your real input/output length ratio.

Two claims to discard: A10G does **not** support FP8 (Ampere cc 8.6 has no FP8 tensor cores, despite one source asserting otherwise), and **MIG is unavailable on all three** — partitioning requires A100/H100-class silicon.

**`inf2` is a trap at pilot scale.** Available in ap-south-1 at $0.9857/hr, and vLLM-on-Neuron is real. But Whisper on Neuron has no established support, and GGUF/CTranslate2 — your actual ASR serving stack — have no Neuron path at all. Everything needs AOT `neuronx-cc` compilation to NEFF. Revisit when the ASR piece has a reference implementation.

### 2A.5 GPU sharing on Kubernetes

- **Time-slicing gives no memory isolation.** All processes share one VRAM address space; when the card is exhausted, the CUDA OOM hits **whichever process allocates next — possibly an innocent neighbour**, not the offending pod.
- **MPS gives soft limits only**, and a crashing client can hang or corrupt its neighbours.
- **MIG is unavailable** on A10G/L4/L40S.
- Industry practice is **one pod per GPU for latency-SLA production serving**; sharing is positioned for dev, CI, and notebooks.

Combined with §2A.3 — a silently-swallowed CUDA OOM — co-location on a 24 GB card is a genuinely poor risk on a clinical path. **48 GB is what makes sharing defensible**, not a cleverer isolation mechanism.

### 2A.6 Recommended GPU options

| | **A — Lean** | **B — Target** ✅ | ~~C — Isolated~~ |
|---|---|---|---|
| Hardware | 1× `g5.xlarge` | 1× **`g6e.xlarge`** | 2× `g5.xlarge` |
| GPU $/mo (14 h) | **515** | **952** | 1,030 |
| ASR concurrency | 20 | **100** | 20 |
| LLM | **Bedrock** | self-hosted vLLM | split |
| LLM $/mo | ~17–133 | 0 | 0 |
| VRAM used | ~8 of 24 GB | ~32 of 48 GB | — |
| Residency | data leaves region | **stays in region** | stays |
| **Total** | **~$532–648** | **~$952** | ~$1,030 |

**Option C is dominated** — costs more than B, delivers a fifth of the concurrency, and still shares a card. Reject it.

**Option A** if the budget ceiling binds and 20 concurrent streams is acceptable. Bedrock small-model pricing makes self-hosting indefensible at pilot volume:

```
Bedrock ap-south-1 (Mistral Large 3, Mumbai-confirmed):  $0.59 in / $1.76 out per 1M
Bedrock small-model (Gemma 3 4B, US rate):               $0.04 in / $0.08 out per 1M
Ministral 8B (US rate):                                  $0.15 / $0.15 per 1M

Your volume ≈ 50 consultations/day × 75k tokens ≈ 114M tokens/month
  → Gemma 3 4B class:   ~$6/month
  → Ministral 8B class: ~$17/month
  → Mistral Large 3:    ~$133/month

Self-hosted break-even vs Ministral 8B: $515 ÷ $0.15/1M ≈ 3.4 BILLION tokens/month
```

You are roughly **30× below the break-even**. Your current seeded default is a ~2B QAT model; the `.env.prod` jump to Qwen3-8B fp16 is an ~8× increase in served-model size, and *that*, not AWS, is what forces a bigger card.

**Option B** if residency binds, or if 50 concurrent streams is a real requirement. One 48 GB card fits everything without quantizing:

| Component | VRAM |
|---|---|
| vLLM Qwen3-8B fp16 + KV cache (`--gpu-memory-utilization 0.5`) | ~24 GB |
| Whisper large-v3-turbo fp16 | ~2.5 GB |
| TEI embeddings + reranker (needs a new GPU image — see below) | ~2.4 GB |
| GLiNER ONNX + MiniCheck | ~1.7 GB |
| Overhead / second CUDA context | ~2 GB |
| **Total** | **~32.6 of 48 GB** |

⚠ **vLLM's `--gpu-memory-utilization` defaults to `0.90`** and claims that share of the *whole card*, not of free memory. Left at the default it will starve every co-tenant. Capping it is mandatory.

### 2A.7 Work this creates that does not exist yet

| Item | Evidence |
|---|---|
| **Wrap CUDA/OOM into `ModelError`** in local ASR adapters | §2A.3 — blocks any ASR failover |
| **Fix guardrail's fail-open** or keep its LLM on on-demand capacity | §2A.3 |
| **TEI GPU image** | Both TEI services pinned `cpu-1.9`; a repo-wide grep for `turing-`/`hopper-`/`cuda-` tags returns nothing |
| **NLP GPU image variant** | `apps/nlp/Dockerfile:15-30,49-64` strips CUDA deliberately. All three models auto-select GPU via `torch.cuda.is_available()`, but the image can never satisfy it. Its `fp16` config fields are dead — never read. |
| **TTS GPU image variant + a Kokoro bug** | `apps/tts/Dockerfile:46-61,88-90` force-installs `torch==2.8.0+cpu`. `KokoroConfig.device` is **never passed to `KPipeline`** (`kokoro.py:111`) — setting it does nothing. Parler/IndicF5 do honour theirs. |
| **Re-point the seeded LM Studio URL** | `seed/17-ai-provider-connection.ts:81-82` seeds `baseUrl: 'http://localhost:1234/v1'` as the SYSTEM-tenant default; on EKS every pod resolves that to itself. Propagation is up to 60 s — guardrail's tenant-config cache has **no invalidation channel** (`core/tenant_config.py:55-59`). |
| **GPU telemetry** | **No service exports any GPU metric.** No pynvml, DCGM, or `nvidia-smi` anywhere. A DCGM exporter must be added. |
| **`llama-cpp` has no GPU config** | Framed in compose comments as the "production GGUF-tier engine" but declares no device reservation and passes no `-ngl`. |

### 2A.7b Two things that will bite on cutover

**⚠ `Qwen3-8B` has no production catalog row.** The `.env.prod` vLLM config names `Qwen/Qwen3-8B`, but a search of `seed/ai-models/*.ts` finds **no `AiModel` row for it** — it exists only as an API test fixture and as `SMR_E2E_VLLM_MODEL` in `apps/smr/src/smr/tests/e2e/test_vllm_live.py:12,24`. Provider/model selection is `failMode: closed`, so resolution against a missing row raises rather than substituting. **Standing up vLLM with this config would 503 until the catalog row and `AiTaskDefault` mapping are seeded.**

**⚠ Losing LM Studio degrades three ways, one of them silent.** Worth knowing precisely, because the AWS cutover *is* a controlled version of this event:

| Service | Behaviour on LM Studio loss |
|---|---|
| Guardrail | **Silent fail-open** — `providers/openai_compat.py:150-165` catches the connection error and returns `{"safe": True}`. Every content-safety, PII, and prompt-injection check passes unchecked. |
| SMR | Hard failure — no try/except around `chat.completions.create` (`providers/openai_compat.py:168`); the exception propagates and summarization fails |
| Harness RAG embeddings | Hard failure — `EmbeddingsServiceError` (`services/embeddings_client.py:60-61`) |
| Harness eval judge | Hard failure — `JudgeConnectionError`; eval-only, not a production path |
| Harness reranker | Unaffected — separate TEI container on `:8870` |

**⚠ The eval gates that would validate a quantized swap mostly do not run.** This weakens §2A's quantization lever further than the missing `clinical_v1.json` alone:

| Gate | Status |
|---|---|
| Harness offline calibration / faithfulness / PDSQI unit suite | ✅ **Runs** in the `test-harness` CI job |
| Guardrail groundedness unit suite | ✅ **Runs** in `test-guardrail` |
| Judge-backed golden-set gate (`python -m harness.eval.ci`) | ❌ `when: never` unless `RUN_INFRA_TESTS=true`, and the job comment concedes it "currently fails closed (connection error) rather than producing a real PASS/FAIL verdict" — no judge backend is wired to the runner |
| **STT CER/WER regression gate** (`mlen_quality_gate`) | ❌ **Never runs in CI** — `test-stt` passes `--ignore=tests/integration/` (`.gitlab/ci/test.yml:369`). Self-skips locally without the PHI clips + GGUF. The README's documented command is also stale: it says `pnpm py:stt:test:integration`, which does not exist; the real script is `stt:test:integration`. |
| Retrieval eval against live bge-m3 | ❌ Dense embedder deliberately stubbed (`eval/retrieval_eval.py:246`) |

So a model or quantization change today gets signal from two unit suites and nothing end-to-end. **Any GPU-tier change that swaps a model needs those gates armed first** — otherwise the migration's own validation story is hollow.

Note: `.github/workflows/harness-eval.yml` already exists as an unenforced mirror — the GitHub Actions migration has a starting point.

### 2A.8 Autoscaling — what exists and what is missing

Every HPA scales on CPU%, and the GPU workloads are pinned `min1/max1` (deliberately inert on the single `dell` box). **CPU% will scale a GPU pod at the wrong moment.** Move to KEDA on demand signals.

The good news: a **cross-service metric contract already exists** — `model_running_instances{service,model}` and `model_inference_latency_seconds{service,model}`, documented as byte-identical and confirmed present in STT, SMR, NLP, Guardrail, and TTS. Harness carries only the `model_cache_*` four.

| Service | Usable scaling signal | Status |
|---|---|---|
| SMR | **`smr_queue_size{provider}`** | ✅ ready |
| STT | `stt_streaming_sessions_active` | ⚠ exists, but **`CapacityGuard` occupancy is not exported** — confirm they track the same counter |
| TTS | `tts_active_streams{provider}` | ✅ ready. Note Kokoro serialises on a **single worker thread** (`kokoro.py:148-150`) — TTS scales by replica, not in-pod concurrency, so its target must be far lower |
| Guardrail | none | ❌ queue depth only via a REST `/jobs/stats` Redis scan |
| Harness | none | ❌ no Temporal backlog gauge; `pendingActivities` is an admin JSON field |
| All | GPU utilisation / VRAM | ❌ nothing anywhere |

Also add a **KEDA cron scaler warming the GPU tier at 05:30 IST**. Karpenter cold start is 3–8 min typical and 8–15 min worst case; the vLLM healthcheck already carries `start_period: 600s`, and STT's startup probe tolerates 15 min. Use **SOCI parallel pull** and `instanceStorePolicy: RAID0` on GPU nodes — the vLLM image alone is ~10 GB.

Three dead-config findings worth cleaning while in here: `AzureSpeechConfig.max_concurrent` / `SarvamConfig.max_concurrent` (TTS), `QueueConfig.max_retries` / `retry_backoff_s` (guardrail), and NLP's three `fp16` fields — all declared, none read.

---

## 3. Decision 2 — Orchestration substrate

You asked for a matrix with cost. Sized against the pilot footprint below.

### 3.1 Pilot footprint (derived from actual manifest requests)

| Tier | vCPU | Memory | Notes |
|---|---|---|---|
| App workloads (9, `hope-api` ×2 for HA) | 3.8 | 6.8 Gi | |
| In-cluster stateful (Qdrant, Vault) | 0.75 | 1.5 Gi | Vault has no requests today — 250m/512Mi assigned |
| Temporal + UI | 0.35 | 0.6 Gi | |
| Observability stack | 1.17 | 2.1 Gi | |
| **Non-GPU subtotal** | **~6.1** | **~11.5 Gi** | plus ~0.5 vCPU / 1 Gi per node for EKS system DaemonSets |
| GPU tier (STT ×2) | 4.0 | 16 Gi | + 1 GPU (time-sliced across both pods) |

For N+1 (survive one node loss with no pending pods): **3 × `m7g.xlarge`** = 12 vCPU / 48 GiB across 3 AZs. After losing one node: 8 vCPU / 32 GiB, still ≥ the 6.1/11.5 requirement.

### 3.2 The matrix

| | **EKS + Karpenter** | **EKS Auto Mode** | **ECS Fargate + EC2 GPU CP** | **EC2 + k3s** |
|---|---|---|---|---|
| Control plane $/mo | $73 | $73 | **$0** | **$0** |
| Node-management surcharge | $0 | ~12 % of EC2 ≈ **$30** | (premium is inside the Fargate vCPU rate) | $0 |
| Non-GPU compute $/mo (on-demand) | 3× m7g.xlarge = **$255** | **$285** | 6 vCPU + 12 GiB, 24/7 ≈ **$216** | **$255** |
| ...with 1-yr Compute Savings Plan | ~$169 | ~$199 | n/a (Fargate SP exists, lower discount) | ~$169 |
| GPU $/mo (14 h/day) | g5.xlarge = **$515** | **$515** | **$515** (ECS/EC2 capacity provider) | **$515** |
| **Compute total (on-demand)** | **$843** | **$873** | **$731** | **$770** |
| Existing Kustomize/Argo reuse | ✅ ~90 % | ✅ ~90 % | ❌ **full rewrite to task definitions** | ✅ 100 % |
| GPU support | ✅ | ✅ | ⚠️ EC2 capacity provider only — **Fargate cannot run GPUs** | ✅ |
| DaemonSets (node-exporter, Alloy) | ✅ | ✅ | ❌ **no DaemonSet concept** — observability stack breaks | ✅ |
| Scale-to-zero GPU | ✅ Karpenter, first-class | ✅ | ✅ capacity provider | ⚠️ manual ASG schedule |
| Spot + consolidation | ✅ best-in-class | ✅ | ✅ | ⚠️ DIY |
| Multi-AZ zero-downtime | ✅ | ✅ | ✅ | ❌ you build it |
| Node patching / upgrades | you own it | **AWS owns it** | AWS owns it (Fargate) | **you own everything** |
| Ops burden | Medium | **Low** | Low–Medium | **High** |
| Migration effort | **Low** | **Low** | **High** | Lowest |

### 3.3 Why Fargate loses despite the cheapest number

It shows $731 — the lowest compute total — and it is still the wrong answer:

- **Cannot run GPUs.** The GPU tier has to sit on ECS/EC2 anyway, so you operate two paradigms, not one.
- **No DaemonSets.** node-exporter, Alloy log collection, and the NVIDIA device plugin all assume per-node placement. Your entire observability stack would need rebuilding around sidecars or a managed service.
- **No hostPath, no `runtimeClassName`.** Both are load-bearing in the current manifests.
- **Image pull is not cached across tasks.** Your Python images are large and the STT CUDA image is multi-GB. Fargate re-pulls per task — cold starts get materially worse, on a service whose startup probe already tolerates 15 minutes.
- **The Kustomize/Argo investment is written off entirely.**

### 3.4 Recommendation

**EKS + Karpenter, `ap-south-1`.**

The deciding factor is not the $112/month gap — it is that ~90 % of the existing manifest tree ports with changes measured in fields, not rewrites, and GPU + DaemonSets are hard requirements only Kubernetes satisfies. You already run Argo CD, Kustomize overlays, the NVIDIA GPU Operator, and sync waves; that skill transfers directly.

**Take EKS Auto Mode instead if fewer than two people on the team are comfortable operating Kubernetes nodes.** The ~$30/month surcharge is cheap for removing node patching, autoscaler tuning, and add-on lifecycle from your plate at this scale — and the manifests port identically either way. This is a team-shape decision, not a technical one.

**Region: `ap-south-1` (Mumbai), not `ap-south-2` (Hyderabad).** Hyderabad is missing `g4dn`, `inf2`, `p4d`/`p5`, and `g6e` entirely, and its EKS/Bedrock/Aurora-Serverless-v2 parity could not be independently verified. Mumbai also satisfies India-residency for DPDP and ABDM purposes, since it is a physical region inside India.

---

## 4. Target Architecture

### 4.1 Service mapping

| Today (self-hosted) | AWS target | Rationale |
|---|---|---|
| k3s on one `dell` node | **EKS 1.31+, 3 AZs, Karpenter** | Manifests port; GPU + DaemonSets required |
| Traefik (k3s built-in) | **AWS Load Balancer Controller → ALB** | **Must set `idle_timeout.timeout_seconds: 3600`** — default 60 s will sever every SSE stream and WebSocket |
| (no TLS anywhere) | **ACM cert on ALB + external-dns → Route 53** | Currently a total gap, including `GF_SECURITY_COOKIE_SECURE` in prod asserting a certificate that does not exist |
| Postgres VM `10.10.1.250` / Patroni HA | **RDS PostgreSQL, Multi-AZ, `db.m7g.large`, gp3** | pgvector required for `UserVoiceProfile.embedding`. ⚠️ **Verify RDS supports PG 18** — schema targets it; PG 17 fallback is likely fine but must be confirmed. |
| Redis VM `10.10.1.120` | **ElastiCache Valkey, 2-node Multi-AZ replication group, `cache.t4g.small`** | Valkey is ~20–33 % cheaper than Redis OSS. ⚠️ Persistence is disabled by design — but **BullMQ jobs live in Redis**, so a failover loses in-flight jobs. Multi-AZ replication, not a single node. |
| MinIO VM `10.10.1.102` | **S3** + gateway VPC endpoint | Loki/Tempo already speak S3 — the most AWS-ready piece of the stack. Lifecycle: audio → Standard-IA @ 30 d → Glacier IR @ 90 d. |
| Qdrant StatefulSet | **Keep self-hosted, EBS gp3** | **OpenSearch Serverless is NOT HIPAA-eligible** — that is a harder blocker than its cost. Decisive. |
| Vault (single-node Shamir, unseal keys in a cluster Secret) | **Keep Vault, switch to KMS auto-unseal + Raft + scheduled snapshot to S3** | See §4.3 — this is deliberately *not* a move to Secrets Manager |
| Temporal VM `10.10.1.10:7233` + dead in-cluster copy | **Consolidate to one in-cluster Temporal against RDS** | Delete the dead copy. ⚠️ `auto-setup` is a dev-convenience image — move to the Temporal Helm chart before prod. |
| LM Studio at `10.10.1.10:1234`, unauthenticated | **Bedrock** (see §2.3 governance flag) | Removes the selector-less-Service failure mode that took out SMR + Guardrail on 2026-08-09 |
| `hostPath: /mnt/data/models-cache` | **S3 model registry + init-container sync** | See §4.2 — the single most important portability fix |
| Self-hosted registry `10.10.1.110:5050` (plain HTTP) | **ECR** + interface VPC endpoint | Endpoint pays for itself on multi-GB CUDA image pulls during node scale-up |
| Prometheus/Grafana/Loki/Tempo in-cluster | **Keep for pilot**; AMP + AMG when ops cost exceeds ~$100/mo | Keeping it is cheaper at this scale; revisit at scale-out |
| (no StorageClass declared) | **gp3 StorageClass + EBS CSI driver** | Every PVC silently relies on k3s `local-path` today |
| (no NetworkPolicy anywhere) | **VPC CNI network policy or Cilium** | Fresh design; nothing to port |
| (no backups anywhere) | **RDS automated backups + EBS snapshot policy + Velero → S3** | Currently zero backup coverage on any PVC |

### 4.2 The model-cache fix (critical path)

Today `/mnt/data/models-cache` is a node-local `hostPath` shared by `hope-stt-v2`, `hope-stt-v2-worker`, and `hope-tts`. On EKS this breaks three ways: nodes are ephemeral under Karpenter, STT (GPU node) and TTS (CPU node) will land on **different** nodes and cannot share it, and every node replacement re-downloads weights from HuggingFace — from a PHI-adjacent pod.

**Fix: mirror all model weights into a private S3 bucket and sync via an init container.**

```
S3: s3://hope-models/{whisper-large-v3-turbo, arcaai-whisper-ml-en-gguf, kokoro-82m,
                      gliner-guard-onnx, minicheck-gguf, bge-m3, bge-reranker-v2-m3}
      │
      └─ initContainer: aws s3 sync → emptyDir (node ephemeral, Karpenter-sized)
             └─ set HF_HUB_OFFLINE=1 in the main container
```

This simultaneously: removes the hostPath, removes the HuggingFace runtime dependency, satisfies the `allow_network=False` clinical-path guardrail, makes model versions immutable and auditable, and cuts NAT egress. EFS was considered and rejected — ~$0.30/GB-mo vs ~$0.08 for EBS, and the access pattern is read-mostly-write-once, which S3 serves better.

### 4.3 Why keep Vault instead of moving to Secrets Manager

Secrets Manager is cheaper (~$10/mo for ~25 secrets) and removes a stateful component — tempting. It is still the wrong call **for now**, because Vault's role here is not only kv-v2 storage:

- The `db-secret` config tier stores **per-tenant BYOK credentials as Vault Transit ciphertext**. Replacing Transit with KMS is an application-layer rewrite of the tenant credential path, not a config change.
- `SECRETS_PROVIDER` is pluggable (`env|vault|...`), so an AWS provider is a bounded addition — but it is still new code on the critical secrets path, during a migration.

**Instead, fix the actual defect with a config change:** switch the Vault seal from Shamir to **AWS KMS auto-unseal**. That eliminates the genuinely alarming finding — five unseal keys and a root token sitting in a plaintext Kubernetes Secret inside the very cluster Vault protects — plus the manual unseal step, with no application change. Add Raft storage and a scheduled `vault operator raft snapshot save` to S3 for the missing backup story.

Adopt the 3-node HA Raft blueprint that already exists at `infrastructure/single-deployment/vault/` and was never wired into the deployment repo. Do not port the single-node stopgap forward.

Revisit Secrets Manager after the pilot, as a deliberate ticket.

### 4.4 Zero-downtime, scoped honestly

**In-window (06:00–20:00 IST):**
- 3 AZs; `topologySpreadConstraints` replacing today's soft anti-affinity (which exists only because everything ran on one box)
- `hope-api` ≥ 2 replicas, real `PodDisruptionBudget` (`minAvailable: 1`) — today **every PDB in the fleet is `minAvailable: 0`**, which is a structural placeholder providing zero protection
- RDS Multi-AZ; ElastiCache Multi-AZ replication group
- ALB target-group health checks + `preStop` drain hooks
- **Live ASR:** one GPU node + Amazon Transcribe as registered failover

**Out-of-window (20:00–06:00 IST):** declared maintenance window. GPU node group scales to zero; app tier drops to minimum replicas. Deploys, migrations, and node rotations land here.

**The cold-start trap.** STT's startup probe already tolerates 15 minutes. Add Karpenter node provisioning (~2 min) plus a multi-GB CUDA image pull (~3–5 min) and the first request after an overnight scale-to-zero could wait **10–20 minutes**. Mitigate with a **KEDA cron scaler warming the GPU tier at 05:30 IST**, 30 minutes ahead of traffic. Do not discover this in production.

---

## 5. Cost Model

> ⚠️ **Every price below is flagged for verification.** AWS renders region-specific pricing tables in client-side JavaScript, so the research pass could not extract ap-south-1 figures from AWS's own pages for most services. Instance rates come from a third-party aggregator mirroring the AWS Price List API; several managed-service rates are us-east-1 examples. **Re-run every line through the AWS Pricing Calculator with region = Asia Pacific (Mumbai) before this becomes a budget.** Treat the *shape* as sound and the *absolute numbers* as ±20 %.

### 5.1 Recommended configuration

**Always-on (24/7)**

| Item | Spec | On-demand $/mo | 1-yr Savings Plan $/mo |
|---|---|---|---|
| EKS control plane | 1 cluster | 73 | 73 |
| App-tier nodes | 3× `m7g.xlarge`, 3 AZs | 255 | ~169 |
| RDS PostgreSQL | `db.m7g.large` Multi-AZ + 100 GB gp3 | 257 | ~185 (RI) |
| ElastiCache Valkey | 2× `cache.t4g.small` Multi-AZ | ~50 | ~35 |
| S3 | ~200 GB + requests | 6 | 6 |
| EBS (PVCs: Qdrant 50, Prom 20, Loki 10, Tempo 10, Grafana 5, Vault 10) | ~105 GB gp3 | 9 | 9 |
| NAT Gateway | 1× + VPC endpoints (S3 gw, ECR, Secrets Mgr) | ~48 | 48 |
| ALB | 1 + LCU | ~22 | 22 |
| ECR | ~60 GB (CUDA images are large) | 6 | 6 |
| KMS | 3 CMKs | 3 | 3 |
| CloudWatch, Route 53, misc | | ~15 | 15 |
| **Subtotal always-on** | | **~$744** | **~$571** |

**Service-hours only (14 h × 30.4 = 426 hr/mo)** — REVISED per §2A.6

| Item | Spec | $/mo |
|---|---|---|
| GPU node — Option A (20 concurrent, LLM on Bedrock) | 1× `g5.xlarge`, on-demand | 515 |
| GPU node — **Option B (100 concurrent, self-hosted LLM)** | 1× **`g6e.xlarge`**, on-demand | **952** |
| GPU burst (batch STT) | `g5.xlarge` spot, queue-driven | ~60 |
| **Subtotal GPU** | A: ~$575 · **B: ~$1,012** | |

⚠ Spot is **not** available for the guardian LLM — see §2A.3. Batch STT only.

**Consumption**

| Item | Basis | $/mo (pilot est.) |
|---|---|---|
| Bedrock (summarization) | pilot token volume | ~$30–80 |
| Transcribe (failover only) | incident-driven | ~$0–20 |
| Data transfer out | India egress | ~$10 |
| CI (GitHub Actions + CodeBuild) | see §6.4 | ~$60 |
| **Subtotal** | | **~$110–170** |

### 5.2 Three budget tiers

REVISED per §2A.6. The GPU line now dominates the spread.

| | **Lean** | **Recommended** | **Target-scale** |
|---|---|---|---|
| App nodes | 2× m7g.xlarge, 2 AZ | 3× m7g.xlarge, 3 AZ | 3× m7g.xlarge, 3 AZ |
| RDS | `db.t4g.medium` Single-AZ | `db.m7g.large` **Multi-AZ** | `db.m7g.large` Multi-AZ |
| Redis | single `cache.t4g.micro` | 2-node Multi-AZ | 2-node Multi-AZ |
| GPU | 1× `g5.xlarge`, 14 h | 1× `g5.xlarge`, 14 h | 1× **`g6e.xlarge`**, 14 h |
| **ASR concurrency** | **20** | **20** | **100** |
| LLM | Bedrock | Bedrock (~$17–133) | self-hosted vLLM |
| Residency | leaves region | leaves region | **stays in region** |
| Observability | CloudWatch only | in-cluster stack | in-cluster stack |
| **On-demand $/mo** | **~$780** | **~$1,430** | **~$1,870** |
| **With 1-yr commitments** | **~$620** | **~$1,150** | **~$1,590** |
| Zero-downtime? | ❌ | ✅ in-window¹ | ✅ in-window¹ |

¹ Conditional on the §2A.3 fix. **Until CUDA errors are wrapped into `ModelError`, no tier delivers ASR failover** — a GPU loss silently drops transcripts.

**Two tiers now satisfy zero-downtime, and the choice between them is not cost — it is whether you need 50 concurrent streams and in-region inference.** Recommended (~$1,150 committed) caps ASR at 20 concurrent and sends LLM traffic to Bedrock. Target-scale (~$1,590 committed) reaches 100 concurrent and keeps everything in ap-south-1, for +$440/month.

Given the stated pilot target of "<50 concurrent consultations," **Recommended does not actually meet the requirement** — it tops out at 20. Either the target is aspirational and Recommended is right, or the target is real and Target-scale is the floor. This is question 7 in §8.

### 5.3 Where the savings actually come from

| Lever | Saving | Notes |
|---|---|---|
| **14 h vs 24 h GPU duty cycle** | **−$355/mo** | 10/24 = 41.7 % straight reduction on GPU hours. The single biggest lever. |
| **Transcribe failover instead of a hot standby GPU** | **−$515/mo** | Buys the same zero-downtime property for incident-only cost |
| **Graviton (m7g) over x86 (m7i)** | **−~45 %** on app-tier compute | Requires arm64 rebuilds — see risk R-3 |
| 1-yr Compute Savings Plan on the always-on tier only | −~30–35 % | **Do NOT commit against the GPU fleet** — a Savings Plan on a 58 %-duty-cycle resource guarantees paying for the idle 42 % |
| Spot for the batch STT worker | −~65 % on that node | Batch tolerates interruption; live ASR does not |
| **CI change-filtering** | **−~$370/mo** | Today all 15 images rebuild on every push. See §6.4 — biggest single CI lever. |
| VPC endpoints (S3 gw + ECR) | −NAT data charges | Multi-GB image pulls dominate egress |
| S3 lifecycle on audio | grows over time | Standard → IA @30 d → Glacier IR @90 d |

---

## 6. GitLab CI → GitHub Actions Migration

### 6.1 🚨 Do not port the `dev-2.1` shim

On the current branch, `.gitlab-ci.yml:65-68` sets `SKIP_TESTS: "true"` and `rules.yml:23-26` forces `when: never` on **all 8 validate jobs and 14 of 16 scan jobs**. Builds still run, with `needs:` marked `optional: true`.

**The pipeline that runs on `dev-2.1` today ships container images built from completely unverified code** — no lint, no typecheck, no tests, no generator drift gates, no Trivy scan. This is documented as a deliberate temporary shim. It must not survive the migration. Removing it is a prerequisite, not a follow-up.

### 6.2 Feature translation

| GitLab feature | GitHub Actions equivalent | Effort |
|---|---|---|
| `workflow:` rules computing `PIPELINE_TYPE` (9 types) | A first `classify` job emitting `outputs.pipeline_type`, consumed by every downstream `if:` | **High** — load-bearing abstraction with no direct equivalent |
| `extends` + `!reference` across split files (~100+ refs, `rules.yml` alone is 395 lines) | Reusable workflows (`workflow_call`) + composite actions. **No equivalent for shared `rules:` fragments.** | **High** — largest engineering risk; this is where silent behavior drift enters |
| `needs: {optional: true}` (~40+ uses) | `if: ${{ !cancelled() && contains(fromJSON('["success","skipped"]'), needs.X.result) }}` | **High** — must be hand-translated every time; miss one and a job either fails on a legitimately-skipped dep or runs when it shouldn't |
| `rules:changes` + `compare_to` | `dorny/paths-filter` inside `classify`, feeding downstream `if:` | Medium |
| GitLab Registry (plain HTTP, LAN) | **ECR** + `aws-actions/amazon-ecr-login`; BuildKit cache → `type=registry` on ECR | Medium |
| GitLab OIDC → Vault JWT | **GitHub OIDC → IAM role** (`aws-actions/configure-aws-credentials`) for AWS; keep Vault for app secrets with rewritten `bound_claims` (`repository`, `ref`, `environment`, `job_workflow_ref`) | Medium |
| `artifacts:reports:dotenv` (`build.env` digest passing) | Parse and write to `$GITHUB_OUTPUT` | Low |
| `artifacts:reports:sast` / gitleaks SARIF | **`github/codeql-action/upload-sarif`** → native Security tab | Low — **strictly better on GitHub** |
| `interruptible` + `auto_cancel` | `concurrency: {group, cancel-in-progress}` | Low |
| `environment:` + `when: manual` on `promote-prod` | GitHub Environments + required reviewers | Low |
| `services:` | Not used today — but **needed** (see R-1) | — |
| `github-backup` mirror job | **Delete.** GitHub becomes primary. | Trivial |

### 6.3 Two things get *better* on GitHub

1. **cosign signing becomes possible.** All 14 `sign-*` jobs are currently 100 % inert — public Sigstore Fulcio does not trust the self-hosted GitLab's OIDC issuer. **GitHub Actions' issuer is on Fulcio's public allow-list.** The work is already written; the migration unblocks it. Combined with the Kyverno `verifyImages` policy (also written, also excluded pending the same Fulcio gap), this closes a supply-chain gap you have already paid to build.
2. **SARIF → native Security tab**, replacing artifacts nobody opens.

### 6.4 CI cost — and the one lever that dominates

**Runner choice: GitHub Actions with AWS CodeBuild-hosted runners.** Native integration, no runner ops, arm64 support, large disk (GitHub-hosted runners have ~14 GB free — the multi-GB CUDA image build will not fit), per-minute billing with no idle cost, and IAM-native ECR access. Alternative if cost pressure demands: `actions-runner-controller` on the same EKS cluster with a spot node pool.

```
Today:   15 images rebuilt on EVERY push (build jobs have NO `changes:` filter)
         15 × ~8 min = 120 build-min/push
         × ~20 pushes/day × $0.006/min  ≈  $430/month

With change-filtering (typically 1–3 images touched per push):
         ~24 build-min/push  ≈  $60/month
```

**Change-filtering the build matrix saves ~$370/month — more than the entire app-tier compute bill.** It is also a behavior change from today, not a like-for-like port, so it needs an explicit decision.

Second lever: **Turbo remote cache is not configured at all** — no `remoteCache`, no `TURBO_TOKEN`, `.turbo/` is in no cache path. Every `turbo build`/`lint`/`typecheck`/`test` runs stone cold on every pipeline. An S3-backed remote cache is a large, entirely unclaimed win on the validate and test stages.

### 6.5 Secrets to recreate

**GitHub Secrets / AWS Secrets Manager:** `CI_DATABASE_URL`, `CI_REDIS_URL`, `CI_REDIS_PASS`, `CI_JWT_SECRET`, `CI_API_KEY_PEPPER`, `NPM_PUBLISH_TOKEN`, `DEPLOY_TOKEN`, `PGB_SMOKE_*` (6), `NEXT_PUBLIC_API_HOST`. Vault KV paths `ci/*` and `deploy/*` map across with rewritten claims.

**Everything `CI_*` remaps:** `CI_COMMIT_SHA`→`GITHUB_SHA`, `CI_PIPELINE_URL`→ computed from `GITHUB_SERVER_URL`/`GITHUB_REPOSITORY`/`GITHUB_RUN_ID`, etc. — pervasive, because TASK-648 bakes these into `/app/build-info.json` in **all 12 buildable Dockerfiles**.

> ### 🚩 Rotate before migrating, not after
> Known-leaked and (per the audit) **still unrotated**: a GitLab OAuth client secret and API token for `git.taphuynh.dev` (committed via `.mcp.json`/`.cursor/mcp.json`/`.env.dev`), and two credentials in `hope-v2-deployment` history (a `gl4bits-` token and a `gldt-` deploy token, commit `08d1651`). A **live GitLab access token is committed in plaintext right now** at `deployment/argocd/bootstrap.dev.yaml:76-91`.
>
> None of these should be re-seeded into GitHub Secrets in their current form. CI scans working-tree only (`--no-git`), so history-resident leaks are invisible to the gate. The migration is the forcing function — rotate as part of it.

### 6.6 Gaps to close during migration

No SAST (add **CodeQL** — free on GitHub), no dependency scanning (add **Dependabot**), no license scanning. `scan-source` is advisory-only (`--exit-code 0`) and effectively decorative. Trivy image scanning is enforced but narrow — CRITICAL-with-a-known-fix only.

---

## 7. Implementation Plan

| Phase | Scope | Gate |
|---|---|---|
| **P0 — Decisions** | Confirm ticket number, budget ceiling, Bedrock residency posture (§2.3), EKS vs Auto Mode | Written sign-off |
| **P1 — Benchmark** | Measure real concurrent-stream capacity of whisper-large-v3-turbo + the ml-en fine-tune on one A10G (`g5.xlarge`). **All GPU sizing is provisional until this exists.** Also verify every price in §5 against the AWS Pricing Calculator. | Measured concurrency + verified cost model |
| **P2 — Landing zone (IaC)** | Terraform: VPC 3 AZ, EKS + Karpenter, ECR, RDS Multi-AZ, ElastiCache, S3 + lifecycle, KMS, IAM/IRSA, VPC endpoints, Route 53 + ACM. **Currently zero IaC exists** — all bootstrap is manual runbook commands. | `terraform apply` reproducible from scratch |
| **P3 — Debt paydown** | S3 model registry + init-container sync (kills hostPath); Vault → KMS auto-unseal + Raft + S3 snapshots; gp3 StorageClass; real PDBs; probes on `stt-v2-worker`; delete the dead Temporal; ALB `idle_timeout: 3600`; ingress + TLS | Manifests render clean; no k3s-isms |
| **P4 — arm64 rebuilds** | Multi-arch images for all Node + CPU-Python services. STT stays x86 (CUDA). | `docker buildx --platform linux/arm64` green; all tests pass on arm64 |
| **P5 — CI migration** | GitHub Actions: `classify` job, reusable workflows, `paths-filter`, ECR + OIDC, service-container test DBs, Turbo remote cache, activate cosign, add CodeQL + Dependabot, **remove the `dev-2.1` shim** | Full pipeline green on a real PR, all gates enforced |
| **P6 — Data migration** | Postgres → RDS (`pg_dump`/DMS), MinIO → S3, Qdrant re-index, Vault re-seed. **Rehearse on a restored copy first** — precedent: the TASK-644 baseline was shadow-rehearsed before execution. | Rehearsal passes; rollback documented |
| **P7 — Cutover** | Argo CD on EKS, KEDA cron scaling (05:30 warm-up), smoke tests, DNS switch, 2-week parallel run | SLA observed one full week |

---

## 8. Open Questions

1. **Budget ceiling — what is the number?** You flagged it as a hard constraint but did not supply it. §5.2 gives three tiers ($620 / $1,150 / $1,700 committed). Which ceiling applies determines whether Multi-AZ RDS and on-demand GPU survive.
2. **Bedrock residency (§2.3).** Claude in India routes via cross-region inference. Acceptable, or must clinical text stay in ap-south-1?
3. **Is the 20:00–06:00 maintenance window acceptable?** The whole cost model depends on it. 24/7 zero-downtime adds ~$500/month.
4. **EKS + Karpenter or EKS Auto Mode?** Team-shape question (§3.4).
5. **Ticket number** — confirm TASK-690.
6. **Per-customer stamps?** You selected shared-pilot, but `hope-v2-deployment` is described as a self-hosting template. If per-hospital isolated stacks are coming, the per-stamp floor (~$744 always-on) is the number that matters, and the design should shift toward shared control planes.
7. **Is "<50 concurrent consultations" a real requirement or a ceiling?** §2A.2: the hardcoded `ExecutionProfile` bucket caps a 24 GB card at **20 streams**. Reaching 50 needs `g6e.xlarge` (48 GB → 100 streams) at +$440/month, or an `STREAMING_MAX_CONCURRENT` override validated by benchmark. **This is now the single largest open cost driver.**
8. **Which config source is authoritative for the cluster** — the per-app `.env.prod` files (which already point at `hope-vllm`) or the deployment repo's generated ConfigMaps? §2A.1. It determines whether self-hosted vLLM is already a committed decision.
9. **Can the guardian and the eval judge be the same model?** They are two separate 8B-class models doing related evaluation work. Collapsing them is the cheapest VRAM recovery available (§2A.1).

---

## 9. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-0a | **A GPU failure silently drops transcripts.** No local ASR engine wraps CUDA/OOM into `ModelError`, so `EngineSwitchController` never fires and `inference.py:372-383` returns an empty transcript with no error and no alert. Clinical data loss with no signal. | **Critical** | Wrap CUDA/OOM into `ModelError` in the local engine adapters — prerequisite to any ASR failover claim (§2A.3) |
| R-0b | **Guardrail fails open on LLM loss.** No circuit breaker, no retry, no cross-provider fallback; any error returns `safe: True`. A GPU node loss means clinical content passes safety screening unchecked. | **Critical** | Keep the guardian on on-demand capacity (never spot), and fix the fail-open posture. Note the tenant-config cache has no invalidation — redirecting traffic takes up to 60 s (§2A.3) |
| R-0c | **The 50-concurrent target is unreachable on a 24 GB card** under the hardcoded `ExecutionProfile` bucket (20 streams). | **High** | `g6e.xlarge` (+$440/mo) or a benchmarked `STREAMING_MAX_CONCURRENT` override (§2A.2) |
| R-1 | **CI tests target LAN-only Postgres `10.10.1.250` / Redis `10.10.1.120`** — unreachable from any cloud runner | **Critical** | Service containers per job (postgres:18 + redis:8). The TASK-689 isolated-test-Vault work suggests this is already in motion. |
| R-2 | **`PIPELINE_TYPE` + `extends`/`!reference` rewrite introduces silent behavior drift** across ~90 jobs | **Critical** | Port branch-by-branch; diff the effective job set per trigger against GitLab before cutover |
| R-3 | **arm64 rebuild breaks a native dependency** (llama-cpp-python, onnxruntime, GLiNER, torch CPU) | High | P4 gate. All have arm64 support, but each needs proving. Fallback: keep specific services on `m7i` (x86) at ~45 % higher cost. |
| R-4 | **GPU concurrency assumption wrong** — the 50-concurrent target may need 2+ A10Gs | High | P1 benchmark before committing. STT's own `ExecutionProfile` tiers (100/40/20) suggest wide variance. |
| R-5 | **Cold start after overnight scale-to-zero** — node + multi-GB CUDA pull + 15-min startup probe = 10–20 min | High | KEDA cron warm-up at 05:30 IST; pre-pull via a warm image cache |
| R-6 | **`hope-api` WS resume state is a per-process in-memory Map** — no cross-pod resume, so scaling `hope-api` past 1 replica silently degrades reconnects | High | Pre-existing defect. Either ALB sticky sessions (stopgap) or move resume state to Redis (correct fix). **Directly blocks the ≥2-replica HA requirement.** |
| R-7 | **Data-migration loss** on Postgres/MinIO/Qdrant cutover | High | Rehearse on a restored copy first (TASK-644 precedent) |
| R-8 | **Leaked credentials carried into GitHub** | High | Rotate in P0, before any secret lands in GitHub |
| R-9 | **Zero backup coverage today** on every PVC-backed component | Medium | RDS automated backups + EBS snapshot policy + Velero → S3 in P2 |
| R-10 | Prices in §5 are third-party-sourced; AWS pages render regional tables in JS | Medium | Verify every line in P1 via the Pricing Calculator, region = Mumbai |
| R-11 | RDS may not support PostgreSQL 18 yet | Medium | Verify in P1; PG 17 fallback likely fine but must be confirmed against the schema |
| R-12 | Malayalam TTS voice unconfirmed on Polly | Low | Sarvam remains the Malayalam path; do not plan a Polly migration on an unverified assumption |

---

## Change History

| Date | Change |
|---|---|
| 2026-08-13 | Initial solution design. Four parallel audits (runtime inventory, deployment-repo manifests, GitLab CI, AWS ap-south-1 pricing). Recommends EKS + Karpenter in ap-south-1, self-hosted GPU ASR with Transcribe failover, Bedrock for LLM (with residency flag), ~$1,150/mo committed at the Recommended tier. Status `Pending` — 6 open questions block P1. |
