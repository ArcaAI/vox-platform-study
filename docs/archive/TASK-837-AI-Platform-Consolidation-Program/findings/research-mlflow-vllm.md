# MLflow + vLLM(+GGUF) on k3s — validation brief

**Date**: 2026-09-01 · **Branch**: `dev-2.2` · **Read-only research pass**
**Validates**: `docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md`
**Reads**: TASK-822, TASK-823, TASK-831, TASK-832, TASK-835, TASK-836
**Cluster fact taken as given** (not re-derived): Rancher `c-nfhxq` / ns `hope-v2-dev` — `hope-mlflow`
and `hope-vllm` exist at **0 replicas**, and the **entire gpu-operator daemonset set is also at 0**
(`nvidia-driver`, `device-plugin`, `container-toolkit`, `dcgm-exporter`).

> **The single most consequential consequence of that fact**: with the NVIDIA **device plugin at 0
> replicas the node advertises no `nvidia.com/gpu` resource at all**. Any pod carrying
> `resources.limits."nvidia.com/gpu"` stays **Pending — Insufficient nvidia.com/gpu**, forever, with
> no error in the container. So "scale `hope-vllm` to 1" is not a one-line change today: the
> gpu-operator must come back first, and *that* is a separate, riskier operation than flipping a
> replica count (driver DaemonSet ↔ kernel version, container-toolkit rewriting the containerd
> config). Budget it as its own step with its own rollback.

---

## A. What the existing research doc got right / wrong / missed

### A.1 RIGHT — keep these, they survive re-verification

| # | Claim | Verification |
|---|---|---|
| R1 | **Control plane vs data plane.** MLflow decides *which weights a pod started with*; it must never be in the token path. | Confirmed. There is **no MLflow flavor for vLLM**, and `mlflow deployments` targets do not include it. An MLflow `pyfunc` in front of vLLM destroys continuous batching and SSE. This is the doc's best contribution and it is correct. |
| R2 | **Do not stream model weights through the MLflow artifact proxy.** | Correct *conclusion*. Reason partly obsolete — see W3. |
| R3 | **`--load-format runai_streamer` + `s3://` + path-style addressing for safetensors.** | Confirmed against [vLLM Run:ai Model Streamer docs](https://docs.vllm.ai/en/stable/models/extensions/runai_model_streamer.html): `runai_streamer` / `runai_streamer_sharded`, `s3://`/`gs://`/`az://`/local, `AWS_ENDPOINT_URL`, `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0`, `AWS_EC2_METADATA_DISABLED=true`, `--model-loader-extra-config {concurrency, memory_limit, distributed, pattern}`. The docs say **Safetensors** — no GGUF path (see B). |
| R4 | **Postgres backend, not sqlite.** | Correct, and now *load-bearing beyond concurrency*: MLflow **Evaluation Datasets require a SQL backend** ([MLflow eval-dataset docs](https://mlflow.org/docs/latest/genai/datasets/)) and **Workspaces require a SQL backend** ([MLflow Workspaces](https://mlflow.org/docs/latest/self-hosting/workspaces/)). FileStore/sqlite forecloses both. |
| R5 | **Aliases (`@champion`), not Stages; pin Deployments to the alias; promotion triggers the rollout.** | Confirmed — [MLflow Model Registry](https://mlflow.org/docs/latest/ml/model-registry/) documents `models:/<name>@<alias>` and describes only the alias workflow. |
| R6 | **A `.gguf` is not servable alone; register weights AND tokenizer/config together.** | Confirmed by upstream, from the other direction: vLLM's GGUF docs tell you to *prefer the base model's tokenizer* because "the tokenizer conversion from GGUF is time-consuming and unstable". |
| R7 | **MLflow OSS ships no authentication; put an authenticating proxy in front; never routable.** | Confirmed. Built-in basic auth is opt-in (`--app-name basic-auth`) and creates a **default admin `admin` / `password1234`** ([MLflow basic HTTP auth](https://mlflow.org/docs/latest/self-hosting/security/basic-http-auth)). |
| R8 | **§4.4 — MLflow must not become a second answer to "which model serves this request".** | Correct and consistent with `.claude/rules/00` and `09`. `AiTaskDefault` (tenant → SYSTEM, `failMode: closed`) stays the selector. |
| R9 | Separate least-privilege MinIO identities; serving pods read-only; keys in Vault. | Correct, and already implemented as `hope-models-reader` (TASK-823 §12A). |

### A.2 WRONG or OUTDATED — flag explicitly

| # | What the doc says | What is actually true |
|---|---|---|
| **W1** | **§5.1: "vLLM (CUDA build) has NO GGUF support… On the GPU path, plan on safetensors."** and §5.6 "It remains false for the CUDA path." | **The measurement was right; the conclusion is now wrong.** In-tree GGUF was **deprecated and moved out-of-tree** ([RFC #39583](https://github.com/vllm-project/vllm/issues/39583)) to the **official `vllm-project/vllm-gguf-plugin`**. vLLM's own docs now say *"GGUF support has migrated to OOT vllm-gguf-plugin"* and instruct `uv pip install vllm-gguf-plugin` before serving a GGUF model ([vLLM GGUF docs](https://docs.vllm.ai/en/stable/features/quantization/gguf/)). GGUF on CUDA **is** available. This is the doc's most important omission, and TASK-823's image lane has already built an image around it. |
| **W2** | Measured against **MLflow 3.6.0**. | The platform deployed **3.15.2** (TASK-822 §9.2/§13). 3.6.0 predates **Workspaces** (3.10.0), the **MCP Registry**, and **proxy-less presigned artifact transfer** (3.15.0). Any 3.6-era behavioural conclusion needs re-testing. |
| **W3** | §2.1 "MLflow's artifact proxy is a ~110× bottleneck" presented as a *permanent property*. | Directionally right, now dated. **MLflow 3.15.0 added proxy-less artifact transfer via presigned URLs**, precisely to remove the proxy from the byte path ([MLflow 3.15.0 release](https://github.com/mlflow/mlflow/releases/tag/v3.15.0)). The 110× number should be read as "measured on 3.6.0 with `--serve-artifacts`", not as a law. **The deployed decision is stronger than either**: TASK-822 R-2 keeps weights *out of MLflow's artifact store entirely*. |
| **W4** | **§7 Step 3's code sample** `mlflow.log_artifacts("/models/qwen3-8b-awq", artifact_path="model")` — i.e. weights INTO MLflow's artifact store. | **Directly violates TASK-822 R-2, and in the shipped proxied mode it silently breaks vLLM.** In proxied mode a client can only ever address `/api/2.0/mlflow-artifacts/artifacts` over HTTP (TASK-822 F-3), so `get_model_version_download_uri` cannot return an `s3://` URI, and `runai_streamer` needs a real `s3://`. **Do not copy that snippet.** TASK-822 ships `verify/check_weights_uri.py` asserting `weights_uri.startswith("s3://")` for exactly this. |
| **W5** | **§7 Step 2 MLflow manifest**: `--artifacts-destination s3://mlflow/` with `--serve-artifacts` deliberately absent. | That combination is the ambiguity MLflow's own docs warn about: proxied = *"specify `--artifacts-destination` and do **not** set `--default-artifact-root`"*; direct = *"set `--default-artifact-root` and `--no-serve-artifacts`"* ([Tracking Server](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/)). The doc's flag set reads as proxied-with-the-flag-removed. What shipped is `--serve-artifacts --artifacts-destination s3://mlflow/artifacts`. |
| **W6** | Same manifest **omits `--allowed-hosts`**. | **Mandatory.** MLflow ≥3.5 host-validates; omitting it 403s every DNS-named client (*"Invalid Host header — possible DNS rebinding attack detected"*), and an explicit list **replaces** the private-IP defaults, so a pod-IP Prometheus scrape 403s while `/health` still returns 200 and the pod looks Ready (TASK-822 **F-2**, measured). Include the pod CIDR. |
| **W7** | Same manifest uses image `hope-mlflow:3.6.0` "mlflow + boto3 + psycopg2, pinned". | The official image exists and **only the `-full` variant is viable**: plain `ghcr.io/mlflow/mlflow:v3.15.2` has **no psycopg2, no boto3, no prometheus_flask_exporter** (TASK-822 **F-1**, measured by import in both images). It also **runs as root** by default (**F-7**) — `runAsNonRoot: true` / `runAsUser: 1000` is load-bearing. |
| **W8** | Manifest has **no schema-migration step**. | MLflow **hard-fails on a stale schema**; `mlflow db upgrade` must run before the server. Vendor warns migrations *"can be slow and are not guaranteed to be transactional"* → back up Postgres first. Note the house constraint: TASK-822 **de-hooked** this from Argo PreSync because a hook that cannot succeed **deadlocks** the whole Application (`hope-vault-init` precedent). |
| **W9** | **§7 Step 4's vLLM manifest** is offered as the shape for the platform, while §5 frames GGUF as the format of interest. | The two are **mutually exclusive**. `--load-format runai_streamer` + `--model s3://…` is a **safetensors** path. GGUF `--model` resolution accepts only a **local file path** or a HuggingFace **`<repo_id>:<quant>`** (TASK-823 §13, read from the pinned plugin source; corroborated by the upstream usage forms `vllm serve ./X.gguf --tokenizer …` and `vllm serve unsloth/Qwen3-0.6B-GGUF:Q4_K_M --tokenizer …`). **An `s3://` string is not recognised as GGUF at all.** |
| **W10** | `--gpu-memory-utilization=0.90` given without qualification. | Documented default is **0.92** ([engine args](https://docs.vllm.ai/en/latest/configuration/engine_args/)), but on **this** node time-slicing is applied with **no VRAM isolation** (`mig.capable=false`, `mps.capable=false`, `vgpu.present=false`), so the value is a fraction of the **whole card** applied by a pod that cannot know its neighbours (TASK-823 §2A.1). Worst-case co-tenancy with `hope-stt`/`hope-stt-worker` forces ~**0.50**, permanently. |
| **W11** | §7 topology: "Registry DB VM 500–502, Postgres HA via PgBouncer 6432". | Deployed reality is `10.10.1.250:5000` in `hope-secrets`, with a **separate `mlflow` database** bootstrapped out-of-band. PgBouncer **transaction** mode for MLflow is explicitly *reasoned, not sourced* in TASK-822 — connect direct or use session mode. |
| **W12** | §6 security section. | Correct as far as it goes, but it **never mentions MLflow's own host-validation/CORS middleware** (the thing that actually breaks first, W6) and — far more seriously — **never mentions MLflow 3 GenAI tracing**, which is the platform's single largest PHI leak vector (A.3 below). |
| **W13** | §5.2 "vllm-metal supports only Q8_0/Q4_0/Q4_1; K-quants are rejected" generalised into the GGUF picture. | True **for the Metal plugin only**, and it is *not* the constraint on the CUDA plugin. The CUDA plugin's tested set includes **Q6_K, Q8_0, IQ4_XS, Q4_K_M, Q4_0, UD-IQ2_XXS** — i.e. **K-quants and I-quants are in scope** ([plugin README](https://github.com/vllm-project/vllm-gguf-plugin)). Presenting the Metal restriction as "the GGUF findings" understates the CUDA path. |

### A.3 MISSED — gaps the doc leaves that this brief fills

1. **The GGUF plugin exists and is official** (W1) — the entire product requirement hinges on it.
2. **CPU is never considered.** The doc assumes a GPU throughout. See §C.
3. **MLflow 3 GenAI tracing is default-on full-payload capture.** Spans capture prompts and responses; redaction is **client-side and opt-in**. On a consultation-transcription platform an autologged GenAI call writes clinical text verbatim into MLflow's Postgres. TASK-822 S-1/S-2 has this right; the research doc does not mention it at all. **`log_traces=False` on every clinical path, and audit the OTLP dual-export separately.**
4. **`mlflow gc` is MLflow's only hard-delete path** — therefore its only right-to-erasure mechanism — and **enabling MinIO versioning on the `mlflow` bucket silently converts erasure into retention** (delete becomes a delete marker; TASK-822 **F-4**, measured). The two buckets have **opposite** requirements: `hope-models` versioned + object-locked; `mlflow` **unversioned**.
5. **MLflow Workspaces (3.10+)** exist and their docs explicitly disclaim the use one is tempted to make of them. See §F.
6. **Concurrency and hyper-parameter control**: which knob is server-start and which is per-request, and the fact that **vLLM cannot enforce a per-request ceiling** on sampling parameters. See §G.
7. **OpenAI-compat surface differences** between vLLM and LM Studio that a uniform adapter must absorb. See §H.
8. **`--api-key` protects only `/v1`, `/v2`, `/inference`** — every operational endpoint (`/invocations`, `/pause`, `/resume`, `/update_weights`, `/tokenize`, `/health`) is unauthenticated even when a key is set ([vLLM security](https://docs.vllm.ai/en/stable/usage/security)).
9. **TASK-831 already inverted the engine priority for the five named GGUF models** to llama.cpp / LM Studio, on the same upstream evidence. The research doc does not reconcile with it.
10. **Probe/sync-wave ordering and real cold-start numbers.** See §I.
11. **`AiModelSource.MLFLOW` still has no resolver anywhere** (TASK-822 §13 grep evidence) — the registry→serving handoff is entirely unbuilt.

---

## B. GGUF-on-vLLM verdict

### B.1 The "plugin" framing is CORRECT — the owner is not asking for something that does not exist

There **is** a first-class, `vllm-project`-owned GGUF plugin. The mechanism is neither
`--quantization gguf` (that was the removed in-tree path) nor a vague "plugin idea":

- **Package**: `vllm-gguf-plugin` — [GitHub](https://github.com/vllm-project/vllm-gguf-plugin) · [PyPI](https://pypi.org/project/vllm-gguf-plugin/)
- **Latest PyPI release**: **0.0.5, 2026-08-10** (history: 0.0.1 2026-05-13 → 0.0.5). Prebuilt
  **abi3** wheels for x86-64 and ARM64 Linux (glibc ≥ 2.28), CPython ≥ 3.10.
- **How it activates**: it registers under vLLM's `vllm.general_plugins` entry-point group. Install
  it and `vllm serve` recognises GGUF; you do **not** pass `--quantization gguf`.
- **vLLM's own docs make it the documented path**: *"GGUF support has migrated to OOT
  vllm-gguf-plugin"*, install with `uv pip install vllm-gguf-plugin`
  ([docs](https://docs.vllm.ai/en/stable/features/quantization/gguf/)).
- **Why it moved**: [RFC #39583](https://github.com/vllm-project/vllm/issues/39583) — GGUF is
  ~**0.1 %** of vLLM usage (bitsandbytes ~0.5 %), injects conditional branches through
  `linear.py` / `fused_moe/layer.py` / `vocab_parallel_embedding.py`, and carries ~6,000 lines of
  CUDA kernels. The RFC is **still open** as of writing.

**So: tell the owner the framing is right.** What must be corrected is the *maturity* claim, not
the existence claim.

### B.2 Production-ready? **No — "supported", not "production-ready".**

| Signal | Evidence |
|---|---|
| Upstream's own words | *"GGUF support in vLLM is highly experimental and under-optimized at the moment, it might be incompatible with other features."* — [vLLM GGUF docs](https://docs.vllm.ai/en/stable/features/quantization/gguf/) |
| Usage share | **~0.1 %** of vLLM users ([RFC #39583](https://github.com/vllm-project/vllm/issues/39583)) |
| Maturity | Plugin version **0.0.5**; first release 2026-05-13 — under four months old |
| Coverage guarantee | *"a model appearing in vLLM's general supported-model list does not by itself guarantee GGUF compatibility"* ([plugin README](https://github.com/vllm-project/vllm-gguf-plugin)) |
| Version pincer | v0.11.0 has the in-tree loader but no Gemma 4; v0.28.0 knows Gemma 4 but has no in-tree loader. **No vLLM release has both** (TASK-823). PyPI 0.0.5 also lacks Gemma 4 — it landed on `main` in commit `d4c1f0d0…` on 2026-08-31, so the HOPE image pins a **commit SHA**, and the plugin's reported version string still reads `0.0.5`. |

### B.3 The actual constraints (all verified)

| Constraint | Detail |
|---|---|
| **GPU only — no CPU** | The plugin's prerequisites are **CUDA toolkit or ROCm toolkit**. There is **no CPU path**. This is decisive: **"vLLM + GGUF on CPU" does not exist.** |
| **Source URI forms** | Local `.gguf` file path, or HF `<repo_id>:<quant>`. **`s3://` is not recognised**, and `--load-format runai_streamer` is a *safetensors* streamer with no GGUF path. On the cluster, weights must be **materialised into the pod**. |
| **Tokenizer is mandatory in practice** | Upstream tells you to pass `--tokenizer <base-hf-repo>`; GGUF tokenizer conversion is *"time-consuming and unstable, especially for … large vocab size"*. For an air-gapped PHI namespace the tokenizer must therefore ship **inside the same MinIO prefix** as the weights — which is what TASK-832's flat-prefix layout already does. |
| **Single-file only** | Multi-file GGUF must be merged with `gguf-split` first (recorded in TASK-831 against the vLLM docs). |
| **No embeddings** | The plugin's tested-coverage table has three modalities — Text, Vision-language, Image generation — and **no pooling/embedding entry**. `text-embedding-embeddinggemma-300m-qat` **cannot be served as GGUF by vLLM at all**; embeddings need vLLM's native pooling runner (`--runner pooling --convert embed`) against **safetensors**. |
| **Granite Guardian unverified** | Absent from the plugin's tested set. |
| **Tensor parallel** | **Supported** — upstream documents `vllm serve <repo>:<quant> --tokenizer … --tensor-parallel-size 2`. (No TP limit found; irrelevant on 16 GiB cards anyway.) |
| **Tested quantizations** | Q6_K, Q8_0, IQ4_XS, **Q4_K_M**, Q4_0, UD-IQ2_XXS. K-quants **are** supported on CUDA (unlike `vllm-metal`). |
| **Tested architectures** | Text: Qwen 2.5 / 3, Phi 3.5, GPT-2, StableLM, Gemma 3, OLMoE. VLM: Gemma 3, **Gemma 4**, Qwen 3.5–3.6 (F16/BF16 projectors). Image-gen: Z-Image-Turbo, FLUX.2-klein. |
| **Performance vs safetensors** | **UNVERIFIED — no upstream benchmark found.** The only published statement is "under-optimized". Do not promise a number; measure with `vllm bench serve`. |

### B.4 Verdict, stated for the owner

> The GGUF plugin is real, official, and installable — the request is coherent. But it is a
> **0.0.5-versioned, ~0.1 %-usage, upstream-labelled "highly experimental"** code path, it
> **requires a GPU**, it **cannot stream from MinIO** (weights must be copied into the pod), it
> **cannot do embeddings**, and it is **unverified for Granite Guardian**. Shipping the clinical
> summarization and safety paths on it is a deliberate risk acceptance, not an engineering default.
> The de-risked alternative — already argued in TASK-831 — is to serve **safetensors/W4A16** on
> vLLM and leave GGUF to llama.cpp / LM Studio, which HOPE already runs.

---

## C. CPU-only verdict

**Not viable for the stated requirement. Two independent reasons, one fatal.**

**Fatal**: **the GGUF plugin has no CPU build.** Its prerequisites are CUDA or ROCm. "MLflow backed
by vLLM with GGUF plugin, on CPU" is not a configuration that exists.

**Separately, vLLM-on-CPU with safetensors is real but weak:**

| Fact | Detail |
|---|---|
| Support status | Official backend. x86 needs **`avx512f`** (recommended) or `avx2` (limited features); AArch64 needs NEON; Apple Silicon and s390x are **experimental** ([CPU installation](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html)). |
| Prebuilt artifacts | Wheels for x86 since **v0.17.0**, ARM since **v0.11.2**. Official CPU images at `public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo`. **`vllm/vllm-openai` is CUDA-only** — TASK-835 §4.3's finding was about that image, and remains correct for it. |
| Landmine | The prebuilt CPU image **requires AVX512**; on a machine without `avx512f`/`avx512_bf16`/`avx512_vnni` it raises **Illegal instruction** ([vLLM issue #18660](https://github.com/vllm-project/vllm/issues/18660)). The k3s node is a **QEMU/KVM VM** (`nvidia.com/gpu.machine = Standard-PC-Q35-ICH9-2009`); whether the guest CPU model exposes AVX512 is **UNVERIFIED** — check `grep avx512f /proc/cpuinfo` on the node before assuming. |
| Tuning | `VLLM_CPU_KVCACHE_SPACE` (GB) and `VLLM_CPU_OMP_THREADS_BIND` (`0-30` / `auto` / `nobind`); reserve 1–2 cores for the server; bind to physical cores only; keep a rank's cores on one NUMA node. |
| Feature gaps | Chunked prefill and prefix caching are disabled on some CPU paths (RISC-V; AMX + linear attention; MLA on non-GPU). Quantization support on CPU is **narrower than CUDA — UNVERIFIED which of AWQ/GPTQ/compressed-tensors work on this backend**; assume BF16/FP16 unless proven. |
| Honest performance | Microsoft's Azure study on Llama 3.1 8B + vLLM: *"It is a struggle (insufficient FLOPs and memory bandwidth) to run Llama 3.1 8B on CPU VMs, even the best performing CPU VM (HB176-96_v4) throughput and latency is significantly slower than the A100_40GB"*, and *"Smaller AI models (≤ 1B parameters) may be OK on CPUs for some light weight inference"* ([blog](https://techcommunity.microsoft.com/blog/azurehighperformancecomputingblog/inference-performance-of-llama-3-1-8b-using-vllm-across-various-gpus-and-cpus/4448420) · [mirror](https://argonsys.com/microsoft-cloud/library/inference-performance-of-llama-3-1-8b-using-vllm-across-various-gpus-and-cpus/)). No per-SKU tok/s table was published — **numbers for a 16-vCPU VM are UNVERIFIED, and the qualitative verdict is unambiguous**. |
| Node budget | TASK-823 §2A: node is 16 cores / 47 GiB with **10.09 cores and 26 GiB already requested**, and it is *also* the k3s control plane. ~5.9 cores are actually free. A CPU vLLM pod that could serve anything would want most of the box. |

**Therefore, the honest CPU/GGUF day-1 answer is not vLLM at all.** It is **llama.cpp /
LM Studio**, which:
- consumes GGUF natively (proven end to end from a mounted MinIO bucket in TASK-835 §4.1 — load
  33.9 s, inference 1.66 s),
- is **already running** at `10.10.1.10:1234` (`out-of-band/lmstudio-endpoints.yaml`), and
- is **already what the SYSTEM `AiTaskDefault` rows select** (`text.live` / `text.finalize` →
  `lms-gemma-4-e2b-it-qat`).

Saying "vLLM+GGUF works on CPU day-1" would be a fiction. Saying "GGUF inference works day-1, on
llama.cpp, and vLLM joins when a GPU is available" is true today.

---

## D. MLflow ↔ vLLM wiring — the verified concrete path

### D.1 The gap, stated precisely

**vLLM cannot parse `models:/…` or `mlflow-artifacts:/…` in any form.** `--model` takes a local
directory/file or an HF repo id. There is **no MLflow flavor for vLLM**, and `mlflow deployments`
targets are `databricks, http, https, openai, faketarget, sagemaker`. The gap is exactly **one
resolution step wide**, and it is resolved **at promotion time in CI**, never at pod start.

### D.2 Path 1 — safetensors, split storage (RECOMMENDED; no download step at all)

This is what TASK-822 R-2 + TASK-823 §4A.1 specify, and what Phase 2 measured.

```
1. mv  = MlflowClient().get_model_version_by_alias("clinical-summariser-awq", "champion")
2. uri = MlflowClient().get_model_version_download_uri(name, mv.version)
        # public method — NOT ModelsArtifactRepository.get_underlying_uri (undocumented static)
3. ASSERT uri.startswith("s3://")            # the R-1/R-2 invariant, else vLLM cannot load it
   ASSERT mv.status == "READY"
   ASSERT sha256(object) == mv.tags["weights_sha256"]
   ASSERT tokenizer_config.json exists in the served prefix   # the §5A.3 tokenizer trap
4. CI commits {weights_uri, image digest, served-model-name} to arca/hope-v2-deployment
5. Argo CD syncs → vLLM pod starts with:
      --model s3://hope-models/<slug>/<version>/
      --load-format runai_streamer
      --served-model-name <logical>          # MUST equal AiModel.sourceUri
```

Required environment on the serving pod:

| Var | Value | Why |
|---|---|---|
| `AWS_ENDPOINT_URL` | `https://10.10.1.102:9000` | LAN MinIO. Measured **2.0 ms** vs **495.6 ms** via the Cloudflare tunnel — ~248× (TASK-823 §4B). |
| `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING` | `0` | **Mandatory** for MinIO. Failure signature is the opaque `ValueError: … b'File access error'` **after** config/tokenizer/shard listing already succeeded — because boto3 and the C++ streamer are **two different S3 clients**. A smoke test that only lists objects passes with this set wrong. |
| `AWS_EC2_METADATA_DISABLED` | `true` | Avoids IMDS timeouts. |
| `AWS_DEFAULT_REGION` | `us-east-1` | MinIO default. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `hope-models-reader` service account | Read-only on the model prefix. |

> ⚠️ **`OPEN-823-TLS` is live and blocking.** Phase 2 proved this path **with a private CA and
> `AWS_CA_BUNDLE`**; Phase 3 removed both by owner directive. **boto3 has no environment variable
> that disables verification** (`verify=False` is a construction argument vLLM owns), so
> `RUNAI_STREAMER_S3_VERIFY_SSL=0` covers only the C++ half and the **first boto3 LIST fails
> `CERTIFICATE_VERIFY_FAILED`**. The shipped manifest says so itself. Three exits: install a
> publicly-trusted cert on the MinIO listener; reinstate the CA for vLLM only; patch the loader
> upstream. **Nothing else in this brief matters until one of those is chosen.**

### D.3 Path 2 — GGUF (the owner's stated requirement): materialise, do not stream

`s3://` **cannot reach the GGUF loader**. So:

```
initContainer  (mc / aws-cli, hope-models-reader creds)
   ├─ verify manifest.json + SHA256SUMS + shardCount + primaryObject   (TASK-832 §6)
   ├─ copy <slug>.<QUANT>.gguf + config.json + tokenizer.json → emptyDir /models
   └─ write /models/.ready ; fail loudly on digest mismatch

container vllm  (hope image: vllm/vllm-openai:v0.28.0 + plugin @ d4c1f0d0…)
   --model /models/<slug>.Q4_K_M.gguf
   --tokenizer /models                      # local dir; NEVER egress to huggingface.co
   --served-model-name <AiModel.sourceUri>
```

**Do not use the `<repo_id>:<quant>` form on the cluster** — it resolves through
`huggingface_hub.hf_hub_download`, i.e. egress to huggingface.co, which `hope-vllm-egress` was
written to forbid and which TASK-822 §5B.3 rules against for a PHI namespace.

MLflow's role is unchanged: it stores the version + alias + `weights_uri`/`weights_sha256`/`format`
tags; CI resolves the alias to the immutable prefix and commits it. The **only** difference from
Path 1 is that the pod copies instead of streams — which costs one init-container's runtime and
one emptyDir sized ≥ the model.

### D.4 Path 3 — proxied-mode fallback (only if MLflow ever holds the weights)

`mlflow.artifacts.download_artifacts(artifact_uri="models:/<name>@champion")` → then **merge
`components/tokenizer/` into `model/`** (the `transformers` flavor writes them to different
directories, so `model/` is **not servable as-is** — TASK-822 §5A.3) → then `vllm serve <local>/model`.
**Avoid.** It reintroduces the byte path R-2 exists to remove.

### D.5 Registry conventions that make the handoff work (from TASK-822 §5A — validated, keep)

- **One registered model per (logical model × format)** — `…-awq` and `…-gguf` are *separate*
  registered models, because an alias attaches to a registered model, not to an artifact inside a
  version. Sharing one makes `@champion` ambiguous and makes independent rollback impossible.
- **Required model-version tags** (tags, not params — params are not settable on a model version):
  `weights_uri`, `weights_sha256`, `format`, `quantization`, `context_length`, `size_bytes`,
  `tokenizer_uri`.
- **Immutable content-addressed prefixes**: `s3://hope-models/<slug>/<quant>-<sha256-12>/…`, never
  overwritten; MinIO versioning + object lock on `hope-models` **only**.
- **The sync job verifies, it does not trust** — recompute sha256; for GGUF additionally
  `gguf-dump.py --no-tensors --json` and assert `general.file_type` and `<arch>.context_length`.
  A silently-swapped quantization in a clinical setting is a patient-safety issue.

---

## E. MLflow on k3s — config table (reusing existing Postgres 18 + MinIO)

**No new datastores.** Postgres 18 at `10.10.1.250:5000` (separate `mlflow` **database**, never the
Prisma one — Alembic's ledger and Prisma drift-detection must not share a schema); MinIO at
`10.10.1.102:9000`.

| Concern | Setting | Notes / evidence |
|---|---|---|
| Image | `ghcr.io/mlflow/mlflow:v3.15.2-**full**`, digest-pinned | Plain variant lacks psycopg2 / boto3 / prometheus_flask_exporter (**F-1**). |
| Backend store | `--backend-store-uri postgresql://mlflow:…@10.10.1.250:5000/mlflow` | SQL backend is **required** for Workspaces and Evaluation Datasets. Verified `mlflow db upgrade` on **PostgreSQL 18.4** (TASK-822 §9.2). |
| Migration | one-shot Job `mlflow db upgrade`, **same image digest**, exactly one runner | Not concurrency-safe. Back up Postgres first (vendor: migrations "not guaranteed to be transactional"). Currently **out-of-band**, deliberately, so a not-yet-satisfiable hook cannot deadlock the Application. |
| Artifact store | `--serve-artifacts --artifacts-destination s3://mlflow/artifacts` | Proxied. Clients hold **no** MinIO credentials. Never `--default-artifact-root` (silent direct mode — pitfall #1). |
| Weights | **NOT here.** `s3://hope-models/…`, referenced from MLflow by tag | R-2. CI asserts `weights_uri.startswith("s3://")`. |
| MinIO wiring | `MLFLOW_S3_ENDPOINT_URL=https://10.10.1.102:9000`, `AWS_ACCESS_KEY_ID/SECRET`, `AWS_DEFAULT_REGION=us-east-1` | [Artifact store docs](https://mlflow.org/docs/latest/self-hosting/architecture/artifact-store) document `MLFLOW_S3_ENDPOINT_URL` explicitly for MinIO. |
| TLS to MinIO | `MLFLOW_S3_IGNORE_TLS=true` **today** | Docs: set `MLFLOW_S3_IGNORE_TLS` **or** `AWS_CA_BUNDLE`, *"not both at the same time"*. S-5 is **withdrawn**, not unmet — the private CA was cancelled. Revert to `false` the day a publicly-trusted cert lands. |
| Large artifacts | `MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true`, `MLFLOW_MULTIPART_UPLOAD_MINIMUM_FILE_SIZE`, `_CHUNK_SIZE`, `MLFLOW_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS` | 3.15.0 added **proxy-less transfer via presigned URLs**. **UNVERIFIED against MinIO** — MLflow's docs say "currently Amazon S3". Two caveats even if it works: presigned URLs remove the *credential* problem, **not** the *reachability* problem (a client off the LAN cannot reach `10.10.1.102`), and multipart-against-MinIO is untested by MLflow. |
| Host validation | `--allowed-hosts mlflow.internal.<domain>,10.*` | **Mandatory (F-2).** An explicit list **replaces** the private-IP defaults; matching is `fnmatch` and **port-exact**; `/health` and `/version` are exempt but **`/metrics` is host-validated** → a pod-IP scrape 403s on a pod that looks Ready. |
| Auth | **Authenticating reverse proxy in front, always.** `--app-name basic-auth` only as a second layer | MLflow ships no OAuth2/SAML/LDAP. Built-in auth creates **`admin` / `password1234`** on first boot — rotate immediately. Requires `MLFLOW_FLASK_SERVER_SECRET_KEY` for CSRF. RBAC has **no explicit-deny override** (cannot grant broadly then except one resource). |
| Exposure | `Service: ClusterIP` — no LoadBalancer, no unauthenticated Ingress | Shipped as ClusterIP with a `kubectl port-forward` comment. The Cloudflare-Tunnel-+-Access design (§9.4c) is a **decision, not a state**. |
| Probes | liveness **and** readiness `httpGet /health :5000`; `initialDelaySeconds: 10`, `periodSeconds: 10` | `/health` is host-validation-exempt, so it works from the kubelet's IP. |
| Metrics | `--expose-prometheus=/tmp/metrics` + **`prometheus.io/scrape\|port\|path` pod annotations** | **No ServiceMonitor** — the Prometheus Operator is not installed; Prometheus is a plain Deployment that self-scrapes via annotations. |
| Filesystem | `readOnlyRootFilesystem: true` + **emptyDir at `/tmp`** | Required: the multiprocess metrics dir must be writable, else `/metrics` breaks (pitfall #8). |
| Security ctx | `runAsNonRoot: true`, `runAsUser: 1000`, `drop: [ALL]`, `automountServiceAccountToken: false` | The official image **runs as root by default** (**F-7**) — this is load-bearing, not decorative. |
| Workers / pooling | `--workers 4`; `MLFLOW_SQLALCHEMYSTORE_POOL_SIZE` / `_MAX_OVERFLOW` / `_POOL_RECYCLE` | Tiny at ~200 users. Connect direct or PgBouncer **session** mode; transaction-mode tolerance is **UNVERIFIED**. |
| Erasure | `mlflow gc` CronJob, `failedJobsHistoryLimit > 0` | gc is the **only** hard-delete path. On 3.15.2 it **raises** `MlflowException: Tracking URL is not set` and exits non-zero rather than silently half-deleting (**F-5**) — so a lost env var fails the *erasure mechanism*, and that failure must be visible. |
| Bucket versioning | `mlflow` bucket **OFF**; `hope-models` **ON** + object lock | **F-4**: with versioning on, gc's delete becomes a delete marker and bytes survive as a non-current version — erasure silently becomes retention. Object lock is **creation-only** and both obvious ways to check it are misleading; branch on **exit code**, never the message (TASK-832 §7.6e). |
| Tracing | **`log_traces=False` on every clinical path.** Audit `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` + `MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT` separately | MLflow 3 GenAI spans capture full prompts/responses by default; redaction is client-side and opt-in. **The single largest PHI risk in this stack.** |
| Webhooks | `MLFLOW_WEBHOOK_ALLOW_PRIVATE_IPS=true`, `MLFLOW_WEBHOOK_SECRET_ENCRYPTION_KEY` | Off by default → an **in-cluster** CI target fails silently (pitfall #7). HMAC-SHA256 in `X-MLflow-Signature`. **Webhooks are experimental.** |
| Do NOT deploy | The **MLflow AI Gateway** (`/gateway/{endpoint}/mlflow/invocations`) | It overlaps `apps/text` directly. Two routers = tenant policy, BYOK and audit in two places. R-3. |
| Secrets | `hope-secrets` + app-level Vault AppRole login | No Vault injector / VSO / ESO is installed; the `AppProject` **blacklists `{group:"", kind: Secret}`** so Argo CD may never manage Secrets. |

---

## F. Multi-tenancy posture for MLflow

**Recommendation: MLflow is PLATFORM-ADMIN-ONLY. A single shared instance. Tenants never touch it,
directly or indirectly. This matches the requirement as stated, and it is the sane design.**

Why, argued rather than asserted:

1. **MLflow's own docs disclaim the tempting reading of Workspaces.** Workspaces (3.10.0+,
   `--enable-workspaces` / `MLFLOW_ENABLE_WORKSPACES`) add an organizational layer over
   experiments, registered models, prompts, gateway resources and artifacts, isolating artifacts by
   URI prefixing. But: *"Workspaces provide logical separation and authorization controls inside one
   MLflow server. For strict data-plane or compliance isolation, run independent MLflow deployments
   instead of sharing a server."* ([MLflow Workspaces](https://mlflow.org/docs/latest/self-hosting/workspaces/) ·
   [3.10.0 release](https://mlflow.org/releases/3.10.0/)). **Mapping tenants onto workspaces would
   present a soft boundary as a compliance boundary — worse than no boundary at all.**
2. **The permission model cannot express HOPE's posture.** MLflow RBAC is
   `READ/EDIT/MANAGE/NO_PERMISSIONS` with **no explicit-deny override**, and there is no tenant
   concept — so it cannot express the **tenant → SYSTEM cascade**, and it cannot express
   **404-over-403** (a cross-tenant miss must be indistinguishable from "not found"; MLflow returns
   403s that leak existence). The gateway already enforces both.
3. **The tenant boundary already exists, one layer up.** `AiTaskDefault` / `AiProviderConnection`
   resolve tenant → SYSTEM with `failMode: closed`. MLflow describing an artifact is orthogonal to
   who may use it.
4. **`vllm` is deliberately SYSTEM-only.** It is absent from `CLOUD_BYO_PROVIDERS`
   (`seed/ai-models/shared.ts`), so a tenant row for `(llm, vllm)` is a **403** — which is exactly
   the requirement *"a tenant admin cannot disable this provider"*. **This is already true in the
   seed; nothing needs building.**
5. **PHI does not belong in MLflow at all.** Both PHI-carrying surfaces are avoidable by policy:
   GenAI **traces** (disable on clinical paths) and **evaluation datasets** built from real
   consultations (a dataset of real consultation text is PHI at rest in Postgres — TASK-822 S-9).
   Keep MLflow to de-identified or synthetic evaluation corpora, or accept it as a PHI store with
   the full attendant obligations. **Choose deliberately; the default is a leak.**

**Namespacing convention** (organizational only — do **not** present it as isolation):

```
experiment:        platform/<capability>/<model-family>     e.g. platform/summarization/gemma4
registered model:  <logical-slug>-<format>                  e.g. clinical-summariser-awq
tags on version:   logical_model, format, weights_uri, weights_sha256, quantization,
                   context_length, size_bytes, tokenizer_uri, eval_run_id
```

If per-team separation is ever wanted **inside the platform team**, Workspaces are the right tool.
For anything tenant-facing, the answer is a separate deployment — or, as recommended, no tenant
access at all.

---

## G. Concurrency + hyper-parameter control — which knob lives where

### G.1 Server-start (platform admin; requires a pod restart / GitOps redeploy)

| Knob | Default | What it controls |
|---|---|---|
| `--max-model-len` | model's advertised max | **The only hard server-side ceiling on `max_tokens`.** Leaving it at the advertised max is pitfall #1 — ~10× fewer concurrent slots. |
| `--max-num-seqs` | convenience default | Max sequences per iteration = the **concurrency ceiling**. A *ceiling*, not achieved concurrency. |
| `--max-num-batched-tokens` | — | Token budget per iteration. Constraint: `max_num_batched_tokens ≥ max_num_seqs`. Smaller (2048) improves inter-token latency; larger improves TTFT. |
| `--gpu-memory-utilization` | **0.92** | Fraction of the **whole card**. ≥0.97 → CUDA-graph capture OOM at startup. On this node, co-tenancy forces ~0.50. |
| `--kv-cache-dtype` | `auto` | `fp8` halves KV bytes/token — doubles concurrency at fixed VRAM. |
| `--enable-prefix-caching` | listed `False` in engine args, described on-by-default in the V1 guide — **contested; pass it explicitly** | Cache reuse across shared prefixes. |
| `--enable-chunked-prefill`, `--long-prefill-token-threshold` | threshold `0` | Splits long prefills; protects TTFT of concurrent decodes. |
| `--scheduling-policy` | `fcfs` | `priority` enables the per-request `priority` field. **Without this, a request's `priority` raises an error.** |
| `--tensor-parallel-size` / `--pipeline-parallel-size` | `1` / `1` | Shard across GPUs. |
| `--generation-config auto\|vllm` + `--override-generation-config '{"temperature":0.5}'` | `auto` (reads HF `generation_config.json`), override `{}` | **The platform-admin sampling knob.** Sets server-side **DEFAULTS**. With `auto` the overrides merge into the HF config; with `vllm` only the overrides apply. |
| `--quantization`, `--load-format`, `--tokenizer`, `--served-model-name` | — | Model identity. `--served-model-name` **must equal `AiModel.sourceUri`** or every generation 404s **at request time**, not at startup. |
| `--api-key` | none | Protects **only** `/v1`, `/v2`, `/inference`. |
| `--limit-mm-per-prompt` | 999 per modality | Multimodal DoS ceiling. Set it. |
| `VLLM_MAX_N_SEQUENCES` (env) | 16384 | Hard cap on the per-request `n`. **Lower it.** |
| `VLLM_CPU_KVCACHE_SPACE`, `VLLM_CPU_OMP_THREADS_BIND` | — | CPU backend only. |

### G.2 Per-request (the caller sets these; vLLM applies them over the server defaults)

`temperature` (1.0) · `top_p` (1.0) · `top_k` (0) · `min_p` (0.0) · `presence_penalty` (0.0) ·
`frequency_penalty` (0.0) · `repetition_penalty` (1.0) · `max_tokens` · `min_tokens` · `n` ·
`seed` · `stop` / `stop_token_ids` · `logit_bias` · `logprobs` / `prompt_logprobs` ·
`response_format` / `structured_outputs` · `ignore_eos` · `priority` (only under `priority`
scheduling) · `cache_salt` · `chat_template_kwargs` · `vllm_xargs` · `request_id`.

Validation bounds vLLM enforces: penalties ∈ [-2, 2]; `repetition_penalty > 0`; `temperature ≥ 0`;
`top_p ∈ (0, 1]`; `top_k = 0` (disabled) or ≥ 1; `min_p ∈ [0, 1]`; `max_tokens ≥ 1` and
`min_tokens ≤ max_tokens`.

### G.3 ⚠️ The finding that shapes the design

> **vLLM has NO mechanism to enforce a per-request CEILING on sampling parameters.**
> `--override-generation-config` sets **defaults**, and any request that supplies its own value
> **wins** (vLLM tracks which keys the caller explicitly set precisely so server defaults do not
> clobber them). `max_tokens` is the sole exception — it is clamped to
> `max_model_len − prompt_tokens`.

**Consequence:** "platform admin controls hyper-parameters, tenants set per-request values" **cannot
be implemented in vLLM.** It must be implemented in `apps/text` / the gateway, where the
tenant → SYSTEM cascade already lives:

| Requirement | Where it is actually enforced |
|---|---|
| Ceilings on temperature / top_p / penalties / `n` | **`apps/text`**, clamping against a `db-config` descriptor resolved tenant → SYSTEM. vLLM cannot. |
| Ceiling on `max_tokens` | `--max-model-len` (hard) **and** an `apps/text` clamp (policy). |
| Which tasks a tenant may use | `AiTaskDefault` rows, tenant → SYSTEM, `failMode: closed`. |
| Per-tenant concurrency quota | **Not a vLLM concept at all.** `max_num_seqs` is a *global* engine ceiling. Per-tenant limits belong to `TieredThrottlerGuard` (`apps/api`) and the `apps/text` worker pool. |
| Global concurrency ceiling | `--max-num-seqs` + `--max-num-batched-tokens` (server-start). |
| Tenant cannot disable the provider | **Already true**: `vllm` ∉ `CLOUD_BYO_PROVIDERS` → a tenant `(llm, vllm)` row is a 403. |

---

## H. OpenAI-compat diff table — vLLM vs LM Studio vs OpenAI

| Surface | OpenAI | **vLLM 0.28** | **LM Studio** |
|---|---|---|---|
| `POST /v1/chat/completions` | ✅ | ✅ — **`user` is ignored**; `parallel_tool_calls:false` forces ≤1 tool call | ✅ |
| `POST /v1/completions` | legacy | ✅ — **`suffix` NOT supported** | ✅ |
| `POST /v1/embeddings` | ✅ | ✅ **only if the server was started with an embedding model** | ✅ (multiple models on one port) |
| `GET /v1/models` | ✅ | ✅ (the served model(s) only) | ✅ (all local models) |
| `POST /v1/responses` (+ `/{id}`, `/{id}/cancel`) | ✅ | ✅ | ✅ (since 0.3.29) |
| `POST /v1/chat/completions/batch` | ✗ | ✅ | ✗ |
| `/v1/audio/transcriptions`, `/v1/audio/translations` | ✅ | ✅ (ASR models) | ✗ |
| SSE streaming | ✅ | ✅ | ✅ |
| Structured output | `response_format` | `response_format` **+** `structured_outputs`, `structural_tag` | `response_format` |
| Extra request params | — | `top_k`, `min_p`, `repetition_penalty`, `ignore_eos`, `priority`, `cache_salt`, `chat_template_kwargs`, `mm_processor_kwargs`, `media_io_kwargs`, `kv_transfer_params`, `request_id`, `vllm_xargs`, `enable_response_messages` | idle **TTL** / auto-eviction, LM-Studio model-load params, MCP-via-API |
| Auth | API key **required** | `--api-key` **optional**, protects only `/v1`, `/v2`, `/inference` | **none by default** |
| Native (non-OpenAI) API | — | `/tokenize`, `/detokenize`, `/pooling`, `/score`, `/rerank`, `/invocations`, `/pause`, `/resume`, `/abort_requests`, `/update_weights`, `/health`, `/metrics`, `/version` (+ dev-mode `/collective_rpc`, `/sleep`, `/wake_up`, `/reset_prefix_cache` under `VLLM_SERVER_DEV_MODE=1`) | `/api/v1/*` (native REST, 0.4.0+; the older `/api/v0` is superseded) |
| Prometheus `/metrics` | ✗ | ✅ (`vllm:*`) | ✗ |
| Model loading | one model per server; **404 on an unknown `model` string** | — | **JIT-loads on request**, and **evicts on idle TTL** |

**Adapter implications for `apps/text` (this is the part that bites):**

1. **Model identity is a hard join on vLLM.** `--served-model-name` must equal `AiModel.sourceUri`
   exactly, or every generation 404s **at traffic time**, not at startup. LM Studio resolves by
   model key and will load on demand. → A uniform adapter must treat "model unknown" as a
   **configuration** error on vLLM and a **transient** one on LM Studio.
2. **Readiness is not symmetric.** LM Studio can evict a model and re-load it on the next request
   (latency spike, no error). vLLM never evicts; a cold vLLM is *down*, not slow.
3. **Embeddings**: one LM Studio serves LLM + embedding models on one port; vLLM needs a **separate
   server instance** for an embedding model. The routing table must allow different base URLs per
   task, which `AiProviderConnection.baseUrl` already does.
4. **Sampling parameter surface**: `top_k` / `min_p` / `repetition_penalty` are extras on vLLM.
   Send them in `extra_body`, and be prepared for LM Studio to ignore or reject them
   (**UNVERIFIED** which of these LM Studio accepts — test per parameter).
5. **Auth**: vLLM's `--api-key` is a coupled change — setting it on the engine without
   simultaneously updating the `AiProviderConnection` row (`PUT /api/v1/admin/providers/llm/vllm`,
   currently the placeholder `not-needed`) produces a 401 on **every** generation.
6. **`user` is silently ignored by vLLM** — do not use it for attribution or tenancy. `X-Tenant-Id`
   and the audit trail remain the only attribution mechanism.

---

## I. Manifest shape, probe timings, sync waves

### I.1 Workload kinds

| Component | Kind | Why |
|---|---|---|
| MLflow tracking server | **Deployment**, replicas 1, RollingUpdate | Stateless; all state in Postgres + MinIO. No PVC. |
| MLflow migration | **Job**, out-of-band today (would be a PreSync hook) | Not concurrency-safe; a hook that cannot succeed **deadlocks** the Application. |
| `mlflow gc` | **CronJob**, `failedJobsHistoryLimit > 0` | Only erasure path; its failure must be visible. |
| vLLM | **Deployment** (not StatefulSet), `maxSurge: 1 / maxUnavailable: 0` — but **`maxSurge: 0` in the dev overlay** | No per-replica identity or persistent state. On a single GPU node a surge pod is a **second full VRAM allocation and a second `nvidia.com/gpu` slice** the node does not have. |
| Model cache | **`emptyDir`** for GGUF materialisation; **none** for safetensors + `runai_streamer` | See I.2. |
| `/dev/shm` | `emptyDir` `medium: Memory`, ≥ 2Gi | Torch distributed / worker IPC. |

### I.2 Model-cache volume strategy (cross-referencing TASK-835)

| Option | Verdict |
|---|---|
| **No volume — stream `s3://` with `runai_streamer`** | **Best for safetensors.** Measured 2.483 GiB / 902 tensors in **10.51 s @ 241.8 MiB/s**. No volume, no init container, no cache invalidation. **Cannot serve GGUF.** |
| **initContainer → `emptyDir`** | **The only option for GGUF.** Full control; the serving container starts with a warm local copy; the copy time is *outside* the startupProbe clock. Cost: the emptyDir is re-filled on every pod start. |
| **initContainer → PVC (RWO)** | Warm restarts, but a PVC pins the pod to a node and blocks `maxSurge` on a single-node cluster. Only worth it if pods roll rarely and the model is large. |
| **`mountpoint-s3` CSI** | Measured **376 MB/s** sequential, `mmap` works and serves genuine range GETs — but **1.53× egress amplification** and effectively **read-only** (append/reopen refused). Requires a CSI driver install. Good when *many* pods share *many* models; overkill for one model. |
| **s3fs sidecar** | 312 MB/s, 1.07× egress, needs a privileged sidecar + `/dev/fuse`, one extra container per pod. |
| **Baking weights into the image** | **No.** Unpullable, uncacheable, un-promotable; and TASK-835 §6.1 measured the failure mode — a 1463 s vendor fetch aborting on an HTTP/2 `INTERNAL_ERROR` that buildkit cannot resume. |

**Rule that survives all of them:** the serving pod is **never** the downloader. Population is an
out-of-band sync/verify Job that writes a `.ready` sentinel; the pod refuses to start without it.

### I.3 GPU scheduling

```yaml
resources:
  limits:   { nvidia.com/gpu: 1, cpu: "4", memory: 12Gi }
  requests: { nvidia.com/gpu: 1, cpu: "2", memory: 8Gi }   # GPU request MUST equal limit
runtimeClassName: nvidia
nodeSelector:
  nvidia.com/gpu.present: "true"
# When an A100/H100 is added, gate on it explicitly — today NOTHING in the deployment repo
# requests such a card, so nothing is waiting to schedule onto hardware that exists:
#   nvidia.com/gpu.product: NVIDIA-A100-80GB-PCIe
tolerations: [{ key: nvidia.com/gpu, operator: Exists, effect: NoSchedule }]
```

**Precondition, not a detail:** with the device-plugin DaemonSet at 0 replicas the node advertises
**no** `nvidia.com/gpu`, so the pod stays **Pending**. Restore gpu-operator *before* touching the
replica count.

### I.4 Probe timings — real numbers, and where each phase's clock runs

Total time-to-serving = **image pull** + **init container** + **engine startup**. Probes only cover
the third.

| Phase | Measured / published | Covered by |
|---|---|---|
| Image pull, `vllm/vllm-openai` v0.28 | **~8.7 GB (CUDA 13.0) to ~12.6 GB**; the HOPE image adds the plugin layer. Minutes on a LAN registry, longer on a cold node | **Nothing.** Pod is `ContainerCreating`. Pre-pull on the node or accept it. |
| Init container (GGUF materialisation) | ~2–4 GB at MinIO LAN speed (`mc` measured **47 MB/s**; `runai_streamer` reached **241.8 MiB/s**) ⇒ tens of seconds | Its own `activeDeadline`; **not** the startupProbe. |
| Weight load + CUDA-graph capture + `torch.compile` | Llama-3.1-8B cold start **294 s**, reduced to **82 s** with caching ([case study](https://tensorfuse.io/docs/blogs/reducing_gpu_cold_start)); a small model **~110 s**. TASK-823 budgets **~120 s** minimum | `startupProbe`. |

```yaml
startupProbe:                     # 30s + 60×10s = up to ~10.5 min before the pod is killed
  httpGet: { path: /health, port: 8000 }
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 60
readinessProbe:                   # keeps the Service endpoint away until weights are resident
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 10
  failureThreshold: 3
livenessProbe:                    # k8s SUSPENDS liveness until startupProbe succeeds — that is the point
  httpGet: { path: /health, port: 8000 }
  periodSeconds: 20
  failureThreshold: 6
terminationGracePeriodSeconds: 600     # ≫ longest generation; house max elsewhere is 90s — justify in a comment
lifecycle:
  preStop: { exec: { command: ["sleep", "15"] } }   # Service drops the endpoint before SIGTERM
```

**The classic failure this prevents**: without a `startupProbe`, a `livenessProbe` with a short
`failureThreshold` kills the pod mid-load, forever — a crash-loop that looks like a broken image and
is actually a broken probe. Conversely, do **not** set the startup budget from the small model you
tested with: a model that loads in 60 s and one that loads in 500 s need the same generous
`failureThreshold`, because a fast model proceeds the moment `/health` returns.

### I.5 Argo CD sync waves

Annotation `argocd.argoproj.io/sync-wave: "<int>"` (default `0`, negatives allowed; lowest first).
Hooks: `argocd.argoproj.io/hook: PreSync|Sync|PostSync|SyncFail|Skip|PostDelete`;
`argocd.argoproj.io/hook-delete-policy: BeforeHookCreation` (default) `|HookSucceeded|HookFailed`
([Argo CD sync waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)).

| Wave | Objects | Note |
|---|---|---|
| **out-of-band** | MinIO buckets + policies + service accounts; `mlflow` database + role; `mlflow db upgrade`; `hope-secrets` keys | **Deliberately outside every kustomization.** These are hand-run because a PreSync hook that cannot yet succeed **deadlocks** the sync — measured twice (`hope-vault-init` blocked every Git change for days; `hope-mlflow-migrate` wedged its first sync). Argo may never manage Secrets (`AppProject` blacklist). |
| `-1` | ConfigMaps, NetworkPolicies, ServiceAccounts | Policy exists before the workload it governs. |
| `0` | `hope-mlflow` Deployment + Service | |
| `1` | Weight sync/verify Job (`.ready` sentinel; sha256 + `gguf-dump` assertions) | Must complete before a serving pod can succeed. |
| `2` | `hope-vllm` Deployment + Service + `hope-vllm-ingress`/`-egress` | |
| `3` | HPA (inert), PDB, `hope-mlflow-gc` CronJob, dashboards | |

**House constraints that override generic guides**: no ServiceMonitor (Prometheus is a plain
Deployment self-scraping `prometheus.io/*` **pod annotations**); no Vault injector/VSO/ESO
(app-level AppRole login instead); the dev overlay **de-hooks** migration Jobs; and `hope-vllm`
carries `maxSurge: 0` in dev.

**Autoscaling**: ship an **inert HPA** (`minReplicas == maxReplicas`) with the house explanatory
comment. HPA-on-CPU is wrong — a saturated vLLM pod is CPU-idle while its token queue fills, and a
new pod needs minutes. Record `vllm:num_requests_waiting` as the metric to scale on **when KEDA
arrives**, and alert on it meanwhile. **KEDA has no path today** (none installed, no `ScaledObject`
anywhere).

---

## J. The day-1 minimum

Three configurations, ordered by honesty. Pick one; do not blur them.

### J-A. **Ship today, no new hardware, no gpu-operator change** — llama.cpp / LM Studio serves GGUF; MLflow becomes the registry of record

| | |
|---|---|
| Serving | **LM Studio at `10.10.1.10:1234`** — already running, already selected by the SYSTEM `AiTaskDefault` rows (`text.live`, `text.finalize` → `lms-gemma-4-e2b-it-qat`) |
| Models | The five already laid out in `s3://hope-models/`: `gemma4-e2b-it-qat`, `gemma4-e4b-it-qat`, `granite-guardian-4.1-8b`, `qwen3.5-4b`, `text-embedding-embeddinggemma-300m-qat` — all GGUF Q4 |
| MLflow | Scale `hope-mlflow` **0 → 1** after the five named operator steps (§13). **No hardware blocker exists for MLflow.** |
| Registry role | Register each model with `weights_uri` / `weights_sha256` / `format` / `quantization` tags + `@champion`; promotion = alias flip → CI commit → Argo sync |
| What it delivers | Model registry ✅ · experiments ✅ · datasets ✅ (SQL backend) · platform-admin governance ✅ · real GGUF inference ✅ |
| What it does **not** deliver | vLLM in the serving path. **That is the entire gap between this and the stated requirement.** |
| Effort | Operator steps only; nothing to build |

### J-B. **vLLM day-1, GPU, safetensors** — the smallest configuration that serves real vLLM inference

| | |
|---|---|
| Model | **`Qwen3-4B-AWQ`** — **already published** to `s3://hope-models/qwen3-4b-awq/v1/`, verified against HuggingFace's published sha256 (TASK-823 Phase 2) |
| Quantization | AWQ W4A16 safetensors — **2.483 GiB measured** (the checkpoint ties embeddings) |
| Image | Stock `vllm/vllm-openai:v0.28.0` — **no plugin needed** |
| Loading | `--load-format runai_streamer`, `--model s3://hope-models/qwen3-4b-awq/v1/` — proven: 902 tensors, 10.51 s, 241.8 MiB/s |
| Flags | `--max-model-len 4096 --gpu-memory-utilization 0.50 --max-num-seqs 8 --max-num-batched-tokens 4096 --enable-prefix-caching --tensor-parallel-size 1` |
| Hardware | **1× RTX 2000 Ada (15.99 GiB)** — `gpu-memory-utilization 0.50` is the worst-case co-tenancy value with `hope-stt` + `hope-stt-worker` on the same card, since time-slicing gives **no VRAM isolation** and no way to pin a card |
| Footprint | 1 `nvidia.com/gpu` slice · cpu 2–4 · mem 8–12 Gi · 2 Gi `/dev/shm` · **no PVC** · ~15 GB ephemeral for the image |
| **Can do** | ~**7 concurrent sequences at 4k context**, ~**11–16 tok/s per user** (bandwidth-ceiling arithmetic, 60–80 % efficiency). Enough for staged internal use, evaluation runs, a single-clinician demo, and to prove the whole registry → promotion → rollout loop end to end |
| **Cannot do** | The 20–40 in-flight target — short **~3× on VRAM and ~15× on memory bandwidth simultaneously**. Cannot serve an 8B at BF16 **at all** (weights alone exceed the card). Cannot serve `vllm-medgemma-1.5-27b-it` (seed row declares 54 GiB). Quality of a 4B on clinical summarization is **unestablished** |
| Blockers | (1) **gpu-operator back to non-zero**; (2) **`OPEN-823-TLS`** — the shipped config is expected to fail `CERTIFICATE_VERIFY_FAILED` on the first boto3 LIST; (3) `hope-models-reader` service account minted by hand; (4) repoint the two `AiTaskDefault` rows |
| To actually meet the target | **1× A100 80GB or 1× H100.** ≥ ~31 GiB usable VRAM on one device and ≥ ~1.2 TB/s. That is a purchasing decision, and no flag substitutes for it |

### J-C. **vLLM day-1 with the GGUF plugin** — if the owner holds the requirement as literally stated

Everything in J-B, changed as follows:

| | |
|---|---|
| Model | **`qwen3.5-4b` GGUF Q4_K_M** — Qwen 3.5 and Q4_K_M are both in the plugin's tested set |
| Image | **`vllm/vllm-openai:v0.28.0` + `vllm-gguf-plugin@d4c1f0d082fc7cd4350da56689109a01c1f29d6c`**, built by GitLab CI (`infrastructure/docker/vllm/Dockerfile`, already authored). Pin the **SHA**, never the tag — the installed version string reads `0.0.5` regardless |
| Loading | **initContainer materialises from MinIO into an `emptyDir`**; `--model /models/<slug>.Q4_K_M.gguf --tokenizer /models`. **No `s3://`. No `runai_streamer`. No `<repo>:<quant>`** (that egresses to huggingface.co) |
| Extra footprint | `emptyDir` ≥ 4 Gi + init-container runtime on every pod start |
| **Cannot do** (properties of the path, not bugs) | **Embeddings — at all** (no pooling path in the plugin) → EmbeddingGemma must stay on LM Studio or move to vLLM's native pooling runner against safetensors. **Granite Guardian — unverified.** Multi-file GGUF needs `gguf-split` merging first. Performance vs safetensors is **UNVERIFIED** and upstream says "under-optimized" |
| Risk statement to put in front of the owner | The clinical summarization and safety paths would run on a **0.0.5-versioned, ~0.1 %-usage, "highly experimental"** loader that upstream deprecated out of the core. Recommend J-B; take J-C only as an explicit, recorded risk acceptance |

**Recommended sequencing:** **J-A now** (it needs no hardware and closes the registry/experiments/
datasets requirement immediately) → **J-B** the moment gpu-operator and TLS are resolved (it proves
the vLLM path with an artifact that is already published and already measured) → **J-C** only if the
owner, having read §B, still wants GGUF specifically on vLLM.

---

## K. Top 5 risks

| # | Risk | Why it is real | Mitigation |
|---|---|---|---|
| **1** | **GPUs are not schedulable, and turning them back on is not a one-liner.** | The device-plugin DaemonSet is at 0 → no `nvidia.com/gpu` advertised → a vLLM pod stays **Pending** with no in-container error. Restoring gpu-operator touches the driver DaemonSet (kernel-version-coupled) and container-toolkit (rewrites containerd config) on a node that is **also the k3s control plane** and **also a VM**. | Treat it as its own change with its own rollback and maintenance window. Verify with `kubectl describe node | grep nvidia.com/gpu` **before** flipping any replica count. **Ship J-A meanwhile — it needs none of this.** |
| **2** | **`OPEN-823-TLS`: the shipped vLLM config is expected to fail at startup.** | vLLM's load path has **two** S3 clients; only the Run:ai C++ one honours `RUNAI_STREAMER_*`. **boto3 has no env var that disables verification** — `verify=False` is a construction argument vLLM owns. With the private CA cancelled, the **first boto3 LIST fails `CERTIFICATE_VERIFY_FAILED`**. Phase 2 measured exactly this shape failing. Solving the hardware blocker alone still yields a dead pod. | Owner picks one: publicly-trusted cert on the MinIO listener (preferred — also un-breaks every other MinIO client), reinstate the CA for vLLM only, or patch the loader upstream. **Do not scale to 1 before this.** |
| **3** | **MLflow GenAI tracing writes PHI into Postgres by default.** | Spans capture full prompts and responses; redaction is **client-side and opt-in**. One autologged call on a consultation path puts verbatim clinical text in the tracking DB — and `MLFLOW_TRACE_ENABLE_OTLP_DUAL_EXPORT` is a **second** egress for the same payload. Compounded by **F-4**: if anyone versions the `mlflow` bucket, `mlflow gc` — the only erasure path — silently becomes retention. | `log_traces=False` on every clinical path (never rely on redaction as the primary control). A test asserting no prompt text reaches MLflow. `mlflow` bucket **unversioned**; `hope-models` versioned + locked. Audit the OTLP endpoint separately. **These are policy controls; nothing enforces them structurally today.** |
| **4** | **The GGUF path is experimental, cannot stream from MinIO, and cannot do embeddings.** | 0.0.5 plugin, ~0.1 % usage, upstream-labelled "highly experimental", pinned to a **`main` commit** (not a release) to get Gemma 4. `s3://` is unreachable to the loader, so the streaming design that was measured **cannot serve GGUF**. EmbeddingGemma is impossible; Granite Guardian unverified. | Prefer safetensors/W4A16 on vLLM (J-B) and leave GGUF to llama.cpp. If GGUF on vLLM is kept: initContainer materialisation, an explicit `--tokenizer` from the same prefix, a **separate** serving path for embeddings, and `vllm bench serve` numbers before any clinical traffic. Re-pin to a plugin **release** the moment one contains Gemma 4. |
| **5** | **Hyper-parameter ceilings cannot be enforced where the requirement assumes they can.** | `--override-generation-config` sets **defaults**, not caps; a caller's `temperature: 2.0` wins. Per-tenant concurrency is **not a vLLM concept** — `max_num_seqs` is a global engine ceiling. Building the control plane against the wrong layer means the ceilings silently do not exist. | Enforce ceilings in **`apps/text`**, clamping against a `db-config` descriptor resolved **tenant → SYSTEM**; enforce per-tenant concurrency in `TieredThrottlerGuard` + the worker pool; use vLLM only for the **global** ceilings (`--max-model-len`, `--max-num-seqs`, `--max-num-batched-tokens`, `VLLM_MAX_N_SEQUENCES`). Add a test asserting an out-of-range per-request value is clamped, not forwarded. |

**Runners-up worth tracking:** `--served-model-name` ≠ `AiModel.sourceUri` fails at **request** time,
not startup (nothing catches it until traffic arrives); `--api-key` protects only `/v1`/`/v2`/
`/inference`, so `/invocations`, `/pause`, `/update_weights` need the nginx allow-list and the
NetworkPolicy — and **whether k3s enforces NetworkPolicies here has never been tested**; and
`AiModelSource.MLFLOW` still has **no resolver anywhere**, so the registry→serving handoff is
entirely unbuilt.

---

## Sources

**vLLM** — [GGUF quantization](https://docs.vllm.ai/en/stable/features/quantization/gguf/) ·
[RFC #39583 deprecate bitsandbytes + GGUF](https://github.com/vllm-project/vllm/issues/39583) ·
[vllm-gguf-plugin (GitHub)](https://github.com/vllm-project/vllm-gguf-plugin) ·
[vllm-gguf-plugin (PyPI)](https://pypi.org/project/vllm-gguf-plugin/) ·
[Run:ai Model Streamer](https://docs.vllm.ai/en/stable/models/extensions/runai_model_streamer.html) ·
[CPU installation](https://docs.vllm.ai/en/latest/getting_started/installation/cpu.html) ·
[CPU docker image requires AVX512 (#18660)](https://github.com/vllm-project/vllm/issues/18660) ·
[Engine args](https://docs.vllm.ai/en/latest/configuration/engine_args/) ·
[Online serving / OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/online_serving) ·
[Security — API key limitations & unprotected endpoints](https://docs.vllm.ai/en/stable/usage/security) ·
[Production metrics](https://docs.vllm.ai/en/stable/usage/metrics) ·
[Release v0.28.0](https://github.com/vllm-project/vllm/releases/tag/v0.28.0) ·
[Gemma 4 recipe](https://github.com/vllm-project/recipes/blob/main/Google/Gemma4.md)

**MLflow** — [Model Registry](https://mlflow.org/docs/latest/ml/model-registry/) ·
[Tracking server (self-hosting)](https://mlflow.org/docs/latest/self-hosting/architecture/tracking-server/) ·
[Artifact stores](https://mlflow.org/docs/latest/self-hosting/architecture/artifact-store) ·
[Basic HTTP auth](https://mlflow.org/docs/latest/self-hosting/security/basic-http-auth) ·
[Workspaces](https://mlflow.org/docs/latest/self-hosting/workspaces/) ·
[3.10.0 release — multi-workspace](https://mlflow.org/releases/3.10.0/) ·
[3.15.0 release — proxy-less presigned artifacts](https://github.com/mlflow/mlflow/releases/tag/v3.15.0) ·
[Datasets (mlflow.data)](https://mlflow.org/docs/latest/ml/dataset/) ·
[GenAI evaluation datasets](https://mlflow.org/docs/latest/genai/datasets/)

**Kubernetes / Argo CD** —
[Sync phases and waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/) ·
[Liveness, readiness and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)

**Performance** —
[Llama 3.1 8B with vLLM across GPUs and CPUs (Microsoft)](https://techcommunity.microsoft.com/blog/azurehighperformancecomputingblog/inference-performance-of-llama-3-1-8b-using-vllm-across-various-gpus-and-cpus/4448420) ·
[same, mirror](https://argonsys.com/microsoft-cloud/library/inference-performance-of-llama-3-1-8b-using-vllm-across-various-gpus-and-cpus/) ·
[Reducing GPU cold start with vLLM](https://tensorfuse.io/docs/blogs/reducing_gpu_cold_start) ·
[vLLM docker image size discussion](https://discuss.vllm.ai/t/current-vllm-docker-image-size-is-12-64gb-how-to-reduce-it/1204)

**Internal** — `docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md` ·
`docs/implementation/TASK-822-MLflow-Deployment/README.md` ·
`docs/implementation/TASK-823-vLLM-Inference-Service/README.md` ·
`docs/implementation/TASK-831-Model-Catalogue-Alignment/README.md` ·
`docs/implementation/TASK-832-MinIO-Internal-Access-And-Model-Bucket/README.md` ·
`docs/implementation/TASK-835-S3-Mounted-Model-Store/README.md` ·
`docs/implementation/TASK-836-MLflow-Registry-vLLM-Metal/README.md` ·
`infrastructure/docker/vllm/Dockerfile`

**Marked UNVERIFIED in this brief**: MLflow presigned/proxy-less transfer against MinIO (docs say
"currently Amazon S3"); MLflow multipart against MinIO; PgBouncer transaction-mode tolerance for
MLflow; GGUF-vs-safetensors throughput on vLLM; which quantizations vLLM's CPU backend supports;
whether the k3s node's guest CPU exposes AVX512; which vLLM extra sampling parameters LM Studio
accepts; per-SKU CPU tok/s for a 4B/8B model.
