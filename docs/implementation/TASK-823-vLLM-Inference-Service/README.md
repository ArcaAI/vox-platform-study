# TASK-823 — vLLM inference service (priority-1 backend)

| | |
|---|---|
| **Status** | **Pending** — manifests are now **COMMITTED and deployed** (`arca/hope-v2-deployment@main` `eb3e5d92`; `hope-vllm` live at 0/0, Synced/Healthy, with this repo's first NetworkPolicies), so "authored" below understates it. Two independent blockers keep it at 0: the **hardware** (below) and **`OPEN-823-TLS`**, whose owner ruling is a DECISION, not a state — the publicly-trusted certificate has not been installed. See §14 |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | TASK-822 (MLflow) for the promotion path; independent for first deploy |
| **Feeds** | TASK-818 (router) — vLLM is provider priority #1 |
| **Target** | ~200 concurrent users ≈ **20–40 in-flight generations**; GPUs already present on the k3s cluster |
| **⚠️ Blocked on** | **Hardware.** The cluster's GPUs are 2× RTX 2000 Ada (16 GiB, 224 GB/s), not the H100 §2 assumed. §2A shows the target is unreachable by ~3× on VRAM and ~15× on bandwidth. Manifests are authored and gate-clean but ship at `replicas: 0`; enabling is an owner decision that needs a card in the A100/H100 class. |

## 1. Requirement Analysis

Stand up a self-hosted **vLLM** OpenAI-compatible inference server as the top-priority backend behind `apps/text`. Weights come from **MinIO**; model versions are registered and promoted in **MLflow** (TASK-822). `apps/text` must never host a model — vLLM is a **separate service**, which is exactly why this is its own ticket.

**What exists today**: the dev compose `inference` profile (`infrastructure/docker/docker-compose.dev.yml:440-560`, opt-in via `pnpm infra:dev:up -- -e`) already runs `vllm/vllm-openai:v0.11.0` as `hope-vllm` on `${TEXT_VLLM_PORT:-8000}` with an NVIDIA GPU reservation, `--model ${VLLM_MODEL:-Qwen/Qwen3-8B}`, and an `HF_HOME` named volume `vllm-cache`. **It pulls straight from HuggingFace Hub — nothing downloads weights from MinIO today.** The router adapter already exists and is a pure HTTP client (`apps/text/src/text/providers/vllm.py`), including a vLLM prefix-cache scrape into `TEXT_ENGINE_CACHE_HIT_RATE`.

So this ticket is: **cluster deployment + MinIO weight loading + MLflow promotion + the security posture** — not a new adapter.

## 2. Sizing — arithmetic, not rules of thumb

> ### ⚠️ SUPERSEDED — this section assumed H100 80GB. The hardware is 16 GiB.
> Everything in §2 is arithmetically correct **for the GPU it assumed** and is kept
> only as the record of what changed. The cluster's actual GPUs are **2× NVIDIA
> RTX 2000 Ada, 16380 MiB each**. Read **§2A**, which redoes the derivation
> against the real hardware and reaches a materially different conclusion:
> **nothing useful fits at the 20–40 in-flight target, and the gap is not a
> tuning gap.**

KV bytes/token = `2 × layers × kv_heads × head_dim × dtype_bytes`.

**8B class** (32 layers, 8 KV heads, head_dim 128, BF16): `2×32×8×128×2 = 131,072 B = **128 KiB/token**`. One 80 GB H100 at `--gpu-memory-utilization 0.92` → 73.6 GB usable; minus ~16 GB BF16 weights, minus ~5 GB activations/CUDA graphs → **~52 GB KV ≈ 425k tokens**. At a 4k working context that is **~106 concurrent sequences per GPU**; at 8k, ~53. FP8 KV halves it to 64 KiB/token → ~212 seq/GPU at 4k.

**~32B class** (64 layers, 8 KV heads, 128 dim): **256 KiB/token**. BF16 weights ~64 GB leave no usable KV on one H100 → TP=2. Two H100s: 147 − 64 − ~10 = **~73 GB KV ≈ 292k tokens ≈ 73 seq at 4k**. FP8/AWQ-quantized (~34 GB weights) on TP=2: ~103 GB KV ≈ 400k tok ≈ **100 seq at 4k**.

### Day-1 recommendation

**The 40-in-flight target fits on ONE H100 with an 8B-class model, roughly 2.5× over-provisioned at 4k context. The binding constraint is HA, not capacity.**

| Model | Precision | GPUs | TP | Replicas | `max_num_seqs` | `max_num_batched_tokens` |
|---|---|---|---|---|---|---|
| **8B (day-1)** | **BF16** | **2× H100 (1/replica)** | **1** | **2 (HA floor)** | **64** | **8192** |
| 8B headroom | BF16 + FP8 KV | 2× H100 | 1 | 2 | 128 | 8192 |
| ~32B | FP8/AWQ | 4× H100 | 2 | 2 | 64 | 8192 |

Tuning rules from vLLM: `max_num_batched_tokens` ≥ 2048 and **> 8192 for throughput on large GPUs**; smaller (2048) improves inter-token latency, larger improves TTFT; constraint `max_num_batched_tokens >= max_num_seqs`. Frequent preemptions ⇒ raise `gpu_memory_utilization` or lower `max_num_seqs`/`max_num_batched_tokens`. **V1's preemption mode is `RECOMPUTE`, not `SWAP`.**

**Do not declare done without `vllm bench serve`** swept at concurrency {10, 25, 50, 100} against the real prompt/response length distribution.

## 2A. Corrected sizing — the real hardware (2026-08-30)

### 2A.0 Ground truth

Read from the node's own GPU-Feature-Discovery labels and the live API, not from
documentation:

| Fact | Value | Source |
|---|---|---|
| GPU model | NVIDIA RTX 2000 Ada Generation | `nvidia.com/gpu.product` |
| **VRAM per card** | **16380 MiB = 15.99 GiB** | `nvidia.com/gpu.memory` |
| Cards | 2, one node | `nvidia.com/gpu.count`, `cluster_list` |
| Compute capability | 8.9 (Ada) — FP8 supported | `nvidia.com/gpu.compute.major/minor` |
| **MIG** | **`false`** | `nvidia.com/mig.capable` |
| **MPS** | **`false`** | `nvidia.com/mps.capable` |
| **vGPU** | **`false`** | `nvidia.com/vgpu.present` |
| Sharing | time-slicing, `replicas: 3` → allocatable 6 | `nvidia.com/gpu.sharing-strategy`, node capacity |
| GPU slots requested | **2 of 6** (`hope-stt`, `hope-stt-worker`, 1 each) | grep of `base/*.yaml` |
| Node CPU / memory | 16c / 47 GiB; **10.09c / 26 GiB requested** | `kubernetes_capacity` |
| Node is a VM | `Standard-PC-Q35-ICH9-2009` (QEMU/KVM, passthrough) | `nvidia.com/gpu.machine` |
| Driver / CUDA runtime | 590.48.01 / 13.1 | `nvidia.com/cuda.*` |

**Two corrections to §8 fall straight out of this**: time-slicing **is applied**
(§8 says it "is not applied" — `sharing-strategy=time-slicing` and
`allocatable: 6` say otherwise), and `hope-ollama` is **gone**, so
`gpu-time-slicing.yaml`'s "3 steady-state consumers" comment is stale at 2.

### 2A.1 Time-slicing is not partitioning

`allocatable: nvidia.com/gpu: 6` means **six scheduling permits over two
physical cards**, three per card. The device plugin:

- **tracks no VRAM at all** — a slice is a permit to open a CUDA context, not a
  memory reservation, and nothing enforces the sum on a card;
- **cannot express "give me a whole card"** — slices are fungible; a request for
  3 may be satisfied from two different cards
  (`failRequestsGreaterThanOne: false` permits the request, guarantees nothing);
- **cannot pin a pod to a specific physical card**;
- **context-switches compute**, so a neighbour's long prefill directly inflates
  this pod's TTFT.

And there is **no fallback isolation mechanism on this hardware**: MIG is
unsupported by AD107, MPS is off, vGPU is absent. NVIDIA's own GPU-Operator docs
state time-slicing provides no memory isolation; `gpu-time-slicing.yaml` already
records that a CUDA OOM in one pod can crash every pod sharing the card.

**So `--gpu-memory-utilization` is a fraction of the whole card, applied by a pod
that cannot know which neighbours it will get.**

### 2A.2 KV arithmetic against 15.99 GiB

`KV bytes/token = 2 × layers × kv_heads × head_dim × dtype_bytes`

For a Qwen3-class 8B (36 layers, 8 KV heads, head_dim 128):
`2 × 36 × 8 × 128 × 2 = 147,456 B` = **144 KiB/token** at BF16, 72 KiB at FP8.
Qwen3-4B has the *same* KV geometry — quantizing the model shrinks weights, not
KV per token.

Weights (vocab 151,936, untied embeddings; AWQ leaves embed/lm_head at FP16):

| Model | BF16 | AWQ W4A16 |
|---|---|---|
| Qwen3-8B | 16.38 GB = **15.25 GiB** | 6.10 GB = **5.68 GiB** |
| Qwen3-4B | 8.04 GB = 7.49 GiB | 3.43 GB = **3.19 GiB** |

**Scenario A — a whole card to itself** (not achievable here; see 2A.1).
Budget at `util 0.90` = 14.40 GiB; activations + CUDA graphs ≈ 1.2 GiB.

| Model | KV budget | KV tokens | @8k ctx | @4k ctx |
|---|---|---|---|---|
| **Qwen3-8B BF16** | **negative** | — | **DOES NOT LOAD** | — |
| Qwen3-8B AWQ | 7.52 GiB | 54,760 | 6.7 seq | **13.4 seq** |
| Qwen3-8B AWQ + FP8 KV | 7.52 GiB | 109,520 | 13.4 seq | 26.7 seq |
| Qwen3-4B AWQ | 10.21 GiB | 74,350 | 9.1 seq | 18.2 seq |

The 8B at BF16 does not merely run short of KV — **its weights alone exceed the
card**, so it refuses to start. Quantization is the entry ticket here, not an
optimisation.

To reach **40 sequences @ 4k with an 8B**: `40 × 4096 × 144 KiB` = **23.6 GiB of
KV**, + 5.68 weights + 1.2 activations = **~30.5 GiB on one device**. That is
roughly **two whole cards' worth of memory on a single device** — and TP=2
across the two cards does not deliver it either, because each card must still
hold its own shard *plus* the STT pods already resident.

**Scenario B — the bandwidth ceiling, which VRAM alone understates.**
Decode is memory-bandwidth-bound: each step reads all weights plus the KV of
every sequence in the batch. RTX 2000 Ada = **224 GB/s** (128-bit GDDR6).
H100 SXM = 3,350 GB/s, **~15×**.

| Batch | Ctx | Bytes/step | Step @224 GB/s | tok/s per user | Aggregate |
|---|---|---|---|---|---|
| 1 | 4k | 6.70 GB | 29.9 ms | 33 | 33 |
| 13 | 4k | 13.95 GB | 62.3 ms | **16** | 209 |
| **40** | **4k** | **30.3 GB** | **135 ms** | **7.4** | 296 |

These are **ceilings at 100% bandwidth efficiency**; achieved is typically
60–80%. So at the ticket's own target the card delivers **~5 tok/s per user in
practice** — below comfortable reading speed, and it would present as a visibly
stalling stream. Even the 13-sequence point that VRAM permits gives ~11 tok/s
achieved.

**Scenario C — what the scheduler actually permits.**
Nothing stops vLLM landing on a card already hosting both STT pods
(~3.9 + ~3.7 GiB, measured in `gpu-time-slicing.yaml`). That leaves **~8.0 GiB**:

| Model | KV | @4k ctx |
|---|---|---|
| Qwen3-8B AWQ | 1.12 GiB | **2.0 seq** |
| Qwen3-4B AWQ | 3.81 GiB | **6.8 seq** |

And vLLM must be configured for that worst case **permanently** — there is no
"0.90 when alone, 0.50 when crowded". Any higher value makes the outcome
scheduling-order-dependent: whichever CUDA context allocates last OOMs, and the
likely casualty is `hope-stt`, a working production capability.

**The ledger above is optimistic.** LM Studio runs on the node **host**
(`out-of-band/lmstudio-endpoints.yaml` → `10.10.1.10:1234`) and holds VRAM
outside k8s accounting entirely; `base/dashboards/gpu.json` already warns that
GPU work runs outside scheduler control. Real free VRAM must be measured with
`nvidia-smi` before any number here is trusted.

**Scenario D — the rest of the node.** 5.9 CPU and 21 GiB RAM remain, on a box
that is *also* the k3s control plane and is itself a VM. One vLLM pod at
`cpu 2 / mem 8Gi` takes ~34% of the remaining CPU and ~38% of the remaining RAM.

### 2A.3 Verdict

**No useful model fits at the target concurrency, and the shortfall is
structural, not a matter of flags.** The hardware is short **~3× on VRAM** and
**~15× on bandwidth simultaneously**; quantization addresses the first and
barely touches the second, because at batch the KV term dominates the read.

The only self-consistent operating point on this node is a **4B-class AWQ model
at `--gpu-memory-utilization 0.50`, `--max-model-len 4096`, serving ~7 concurrent
sequences** — 4–6× short of the 20–40 target, with a model whose clinical
summarization quality is unestablished. For calibration, the **only vLLM
`AiModel` row in the seed catalogue** (`vllm-medgemma-1.5-27b-it`) declares
`memorySizeMb: 55296` — **54 GiB**, about three and a half of these cards for
weights alone. It cannot run here at all.

**What the target actually requires** (40 in-flight, 4k avg, 8B-class,
≥25 tok/s/user): **≥ ~31 GiB usable VRAM on one device** and **≥ ~1.2 TB/s** of
memory bandwidth.

| Option | VRAM | Bandwidth | Meets the target? |
|---|---|---|---|
| 2× RTX 2000 Ada (today) | 16 GiB each | 224 GB/s | **No — on either axis** |
| 1× L40S / RTX 6000 Ada | 48 GB | 864 GB/s | VRAM yes; ~18 tok/s/user at B=40 |
| **1× A100 80GB** | 80 GB | 2,039 GB/s | **Yes** |
| **1× H100** | 80 GB | 3,350 GB/s | **Yes, with headroom** |

**A single A100 80GB or H100 replaces both current cards and meets this ticket as
written.** That is a purchasing decision, and it is the honest answer: the owner
can buy hardware, and no amount of flag-tuning substitutes for it.

**Recommended disposition** (owner decision): ship the manifests at
`replicas: 0` — the security posture, the first NetworkPolicy, the MinIO weight
path and the config are all reviewable and version-controlled, and enabling is a
one-line change the day the hardware exists. Meanwhile `apps/text` keeps LM
Studio (TASK-824) as its working backend, which is what the SYSTEM
`AiTaskDefault` rows already point at.

## 3. Security posture — non-negotiable for PHI

| # | Control | Why |
|---|---|---|
| **V-1** | **Never set `VLLM_SERVER_DEV_MODE=1`** in the PHI namespace | It exposes `/collective_rpc` (**arbitrary RPC execution**), `/sleep`, `/reset_prefix_cache`. **Consequence: vLLM Sleep Mode hot-swap is off the table** — model updates are rolling re-deploys (§5). |
| **V-2** | Reverse proxy with an endpoint allow-list | vLLM is **unauthenticated by default**, and `--api-key` protects **only** `/v1`, `/v2`, `/inference` — **not** `/invocations`, `/pause`, `/abort_requests`, `/update_weights`. |
| **V-3** | NetworkPolicy: ingress only from `apps/text` | Inter-node PyTorch-distributed and KV-transfer traffic is unencrypted and unauthenticated **by design**. |
| **V-4** | Keep `--enable-log-requests` **off**; log level INFO; `--disable-uvicorn-access-log` | It is opt-in and off by default, but **at DEBUG it logs prompt text and token IDs**. `--enable-log-outputs` also defaults False. `/metrics` carries **no** prompt text — token counts only. |
| **V-5** | Pin and patch deliberately; do not serve multimodal models you don't need | **CVE-2026-22778 (CVSS 9.8)** — RCE via a malicious video URL to a video-model endpoint, reachable **before auth** on `/invocations`. **CVE-2025-30165 (8.0)** — pickle deserialization RCE in multi-node ZeroMQ. |
| **V-6** | Non-root (1000:1000), read-only rootfs, drop all caps except `SYS_NICE` | Standard hardening. |

## 4. Weights from MinIO

**Run:ai Model Streamer is the fast win** — vLLM wires it in natively via `--load-format runai_streamer` and accepts an `s3://` model path directly.

```
AWS_ENDPOINT_URL=https://minio:9000
RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0     # path-style — MANDATORY for MinIO
AWS_EC2_METADATA_DISABLED=true
--model-loader-extra-config '{"concurrency":16,"memory_limit":5368709120}'
```

Benchmark (Llama-3-8B, 15 GB safetensors, A10G — 2024, still the canonical measurement): weight load from **S3 28.24s @ concurrency 4 → 4.88s @ concurrency 32**; end-to-end vLLM readiness **S3 23.18s (streamer) vs 65.18s (Tensorizer)**, GP3 SSD 35.08s (streamer) vs 66.13s (safetensors loader). 2026 write-ups on Azure Blob and GKE report the same ~6× shape. Sharded variant: `runai_streamer_sharded`.

**Fallback if the streamer misbehaves**: init-container pre-pull to a PVC — ~2× slower cold start, zero new failure modes. Only worth it if you scale/roll rarely.

> ~~**Unverified:** vLLM's page does not cover CA bundles for self-signed MinIO certs…~~
> **VERIFIED in Phase 2 — `AWS_CA_BUNDLE` is the mechanism, and it is mandatory.**
> Full evidence in `deployment/README.md` §8 and §10. Headlines:
>
> - The cluster's MinIO **is** TLS with a private issuer (`CN=ARCAAI Internal CA`),
>   and the system trust store does not contain it. Without a bundle the load dies at the
>   first LIST with `botocore.exceptions.SSLError … CERTIFICATE_VERIFY_FAILED`.
> - A **full 2.483 GiB / 902-tensor AWQ stream** was run end to end against a TLS MinIO
>   with a private CA, using vLLM's own loader chain (`pull_files` → `list_safetensors` →
>   `SafetensorsStreamer`) — 10.51 s at 241.8 MiB/s. **No GPU load was performed.**
> - Pitfall #7's real signature is NOT a DNS error. With virtual-host addressing on, the
>   C++ streamer fails with the opaque `ValueError: … b'File access error'`, and only
>   *after* config, tokenizer and shard listing have all succeeded — because those use
>   boto3 while only the weight read uses the C++ client.
> - **`--load-format runai_streamer` is confirmed available in `vllm/vllm-openai:v0.11.0`**:
>   `docker/Dockerfile:529` installs `runai-model-streamer runai-model-streamer[s3]` into
>   `vllm-openai-base`, which `vllm-openai` derives from. The init-container fallback is
>   not needed.

## 4B. The MinIO endpoint — resolved (Phase 2, 2026-08-30)

§4 above and the Phase 1 handover both stalled on the same blocker: the only MinIO address
the platform knew was `hope-secrets.MINIO_ENDPOINT = s3.taphuynh.dev`, a public Cloudflare
Tunnel hostname with no Access application (TASK-828 §4). Streaming weights through it
would be an internet round trip out of a PHI namespace, and it made the egress
NetworkPolicy unwritable.

**There is no MinIO Service, Endpoints or Pod anywhere in the cluster.** MinIO is
out-of-band infrastructure. The Cloudflare tunnel's own route table says where it lives:

```
s3.taphuynh.dev  ->  https://10.10.1.102:9000   (originRequest.noTLSVerify: true)
```

A dedicated LAN host on the same `/24` as the k3s node. Measured from inside
`hope-v2-dev` (`hope-text`, `GET /minio/health/live`, n=7):

| Path | median | min | max |
|---|---|---|---|
| LAN `10.10.1.102:9000` | **2.0 ms** | 1.9 | 8.3 |
| Tunnel `s3.taphuynh.dev:443` | **495.6 ms** | 387.4 | 1452.6 |

**~248× per request**, and the streamer issues many concurrent ranged GETs.

**Nothing new needs to be created for the endpoint itself**: the leaf's SAN carries
`IP:10.10.1.102`, so the IP verifies directly, and this matches how `hope-secrets` already
addresses Postgres (`10.10.1.250:5000`) and Redis (`10.10.1.120:6379`). MinIO was the only
dependency reached over the public internet. What *does* need creating is the CA ConfigMap
(`arcaai-internal-ca`) — the ARCAAI Internal CA is published nowhere in the namespace.
Raised as a ROOT_CONFIG_REQUEST in `deployment/README.md` §9.

**Wider consequence, out of scope here:** `hope-api` and every other MinIO client still use
`s3.taphuynh.dev` with `MINIO_USE_SSL=true`, so all PHI object traffic currently leaves the
cluster for the public internet. Same fix, different blast radius — `deployment/README.md`
§9.3.

## 4A. Resolving a model — two sources (added 2026-08-29)

The platform uses **both** HuggingFace and its own MLflow (TASK-822 §5B). The resolver is
source-aware and the two paths differ sharply:

- **`HUGGINGFACE` → pass-through.** vLLM's `--model` accepts `<user>/<model>` directly. No
  resolution step. **But pin the revision SHA, never a bare tag**, and see TASK-822 §5B.3: a runtime
  HF pull needs egress from a PHI namespace, which contradicts V-3's default-deny policy. The
  recommended posture is to mirror HF weights into MinIO and serve them as an `S3` source.
- **`MLFLOW` → resolve first.** The chain below.

### 4A.1 The MLflow chain

**vLLM cannot parse `models:/` in any form** — `--model` takes a local directory or an HF repo id
only, and **no MLflow flavor for vLLM exists** (`mlflow deployments` targets are `databricks, http,
https, openai, faketarget, sagemaker`). The gap is one resolution step wide.

**Chain, direct-mode / split-storage (recommended — no download at all):**

1. `mv = MlflowClient().get_model_version_by_alias("clinical-summariser-awq", "champion")`
2. `uri = client.get_model_version_download_uri(name, mv.version)` — **use this public method**, not
   `ModelsArtifactRepository.get_underlying_uri`, which is an undocumented static with no stability
   guarantee (it calls the same thing).
3. Assert `uri.startswith("s3://")` and that `mv.tags["weights_sha256"]` matches the stored object.
   Assert `mv.status == READY`. Fail the pipeline here — never the pod.
4. CI commits the URI + image digest to `hope-v2-deployment`; Argo CD syncs.
5. Pod serves it directly:
   `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0 AWS_EC2_METADATA_DISABLED=true AWS_ENDPOINT_URL=… vllm serve <uri> --load-format runai_streamer --served-model-name <logical>`

**If MLflow is ever run in proxied mode, step 2 cannot produce an `s3://` URI** — see TASK-822 R-1's
invariant. The fallback is `mlflow.artifacts.download_artifacts(artifact_uri="models:/…@champion")`,
then **merge `components/tokenizer/` into `model/`** before serving (TASK-822 §5A.3), then
`vllm serve <local>/model`.

**Build the resolver, do not adopt one.** Off-the-shelf options are each disqualified: Seldon Core
is **BSL 1.1** since 2024-01-22 (commercial licence required in production); KServe's MLflow support
needs an already-resolved `storageUri` and has no evidence of accepting `models:/`; **ModelMesh is
archived**; and no Argo CD ConfigManagementPlugin resolving MLflow URIs exists. The resolver is
~50 lines of `get_model_version_by_alias` + `download_artifacts`.

## 5. Model promotion — rolling re-deploy, not hot swap

**There is no production-grade hot model swap in vLLM in 2026.** Sleep Mode (`/sleep`, `/wake_up`, 18–200× faster than full reload) requires `VLLM_SERVER_DEV_MODE=1`, which V-1 forbids, and is documented "trusted networks only"; in-place weight loading is still an open RFC.

Therefore: MLflow alias flip → webhook → CI resolves `models:/name@champion` to an immutable MinIO URI + checksum → commits the URI and `--served-model-name` into the deployment repo → Argo CD rolling update. Details in TASK-822 §Phase 3. **Rollback = repoint the alias + revert the commit.**

## 5A. Integration contract — routing `apps/text` to vLLM with no router change

**The `AiProviderConnection` SYSTEM row already exists and is already enabled.**
Verified in `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts`
(id `87000000-0000-0000-0000-000000000007`):

| Field | Value | Notes |
|---|---|---|
| `tenantId` | `00000000-0000-0000-0000-000000000000` | SYSTEM — the platform-default tier |
| `service` | `llm` | plain `String` column; no Prisma enum exists |
| `provider` | `vllm` | **lowercase**; the member is `'vllm'`, not `VLLM` |
| `baseUrl` | `http://hope-vllm:8000/v1` | **top-level column**, not JSON — and it already matches the Service this ticket ships |
| `enabled` | `true` | |
| `encryptedApiKey` | ciphertext of `not-needed` | the platform's self-host placeholder; a **keyless row is dropped** from the `provider_overrides` fold, so this must stay populated |

`provider` is validated app-side against `AI_MODEL_PROVIDERS`
(`seed/ai-models/shared.ts`), which contains `'vllm'`. `vllm` is deliberately
**absent** from `CLOUD_BYO_PROVIDERS`, making it a **SYSTEM-tenant-only** engine:
a tenant row for `(llm, vllm)` is a 403, which is correct — a self-hosted engine
is platform infrastructure, not a BYO credential.

### There is no "provider priority" field — priority is a model selection

Nothing in the schema or in `apps/text` ranks providers. "vLLM is priority #1"
is expressed entirely by **which model the winning `AiTaskDefault` row names**.
Precedence, from `HarnessPolicyService.resolveTextSelection`:

```
0. workflow node's own llmBinding.modelSlug   (explicit, fails closed)
1. AiTaskDefault[taskKey], tenant → SYSTEM     ← the lever
2. legacy HarnessPolicy.textProvider/textModel, tenant → SYSTEM
```

So the **entire** change is repointing two SYSTEM `AiTaskDefault` rows:

| `taskKey` | current `modelSlug` | target |
|---|---|---|
| `text.live` | `lms-gemma-4-e2b-it-qat` | a slug whose `AiModel.provider = 'vllm'` |
| `text.finalize` | `lms-gemma-4-e2b-it-qat` | same |

The seed is **create-only**, so a re-run of `pnpm db:seed` will not update an
existing row. Repoint at runtime via
`PUT /api/v1/admin/ai-task-defaults/text.live`, or author a new seed value with
a new id.

### ⚠️ `--served-model-name` must equal `AiModel.sourceUri`

`resolveTextSelectionForKey` returns `model: model.sourceUri`, and that string
goes on the wire as the OpenAI `model` field. If the manifest's
`VLLM_SERVED_MODEL_NAME` differs from the `sourceUri` of the `AiModel` row that
`AiTaskDefault` points at, **every generation 404s** — and it fails at request
time, not at startup, so nothing catches it until traffic arrives. Keep them
identical.

### Two traps recorded so they are not rediscovered

- **Do not add `TEXT_VLLM_BASE_URL`** (or any `TEXT_VLLM_*` var) to `.env.dev`,
  `turbo.json#globalEnv` or `Settings`. `apps/text` holds **no endpoint config**:
  `require_base_url` reads the per-request `AiProviderConnection` the gateway
  injects, and fails closed with a typed 503 otherwise. The variable was deleted
  with the engine sub-configs (TASK-736/799) and
  `test_task799_config_surface.py` rejects reintroducing it structurally — it
  walks the pydantic field tree against an allow-list, so no spelling gets
  through. The reference to it in the seed comment describes history.
- **Enabling `--api-key` is a coupled change.** The row's key is the placeholder
  `not-needed`. Setting `--api-key` on the engine without simultaneously
  updating the row via `PUT /api/v1/admin/providers/llm/vllm` produces a 401 on
  every generation. This ticket therefore ships **without** `--api-key`; the
  enforcing controls are the nginx allow-list (V-2) and the NetworkPolicy (V-3),
  and `--api-key` would in any case protect only `/v1`, `/v2` and `/inference`.

## 6. Multi-model shape

**One vLLM Deployment per base model** is the 2026 default and the fast win: isolated KV cache, independent scaling and rollout, trivially expressed as Argo CD apps. Cost is one GPU floor per model.

**Multi-LoRA** (`--enable-lora`, `--max-loras`, `--max-cpu-loras`) serves many adapters over one base on one GPU — but reported throughput/latency degradation runs **up to ~50% vs the base model**, and `VLLM_ALLOW_RUNTIME_LORA_UPDATING` is flagged as a security risk not for production. Use only if tenants share a base model *and* you accept the tax, measured. `apps/text` does the model→endpoint mapping either way.

## 7. Config to get right on day one

```
--model s3://hope-models/<name>/<ver> --served-model-name <logical-name>
--load-format runai_streamer --model-loader-extra-config '{"concurrency":16}'
--max-model-len 8192            # NEVER leave at the model's advertised max
--gpu-memory-utilization 0.92   # documented default; do NOT push to 0.97+
--max-num-seqs 64 --max-num-batched-tokens 8192
--enable-prefix-caching         # set EXPLICITLY, see below
--tensor-parallel-size 1 --api-key <from Vault>
```

**Two genuinely contested defaults — set them explicitly rather than guessing:**
- **Prefix caching**: the engine-args page still lists `enable-prefix-caching` default `False`, while the V1 guide/blog describe it as on-by-default zero-overhead. **Pass the flag.**
- **Chunked prefill**: stable docs say "enabled by default whenever possible"; a secondary source claims it needs `long_prefill_token_threshold`. Verify against your pinned version's `--help` and startup log.

**Version**: the line is v0.28.0 (~2026-08), preceded by v0.27.1/v0.27.0/v0.26.0. **Pin one minor behind head (v0.27.1)** and do not enable Model Runner V2 (`VLLM_USE_V2_MODEL_RUNNER=1`), FP8 KV and LoRA on day 1 — you lose attributability for every failure.

## 8. Kubernetes shape
Deployment (replicas 2) · `nvidia.com/gpu: 1` · `shm` emptyDir ≥2Gi · **startupProbe on `/health` with `failureThreshold` covering ~120s cold start** · readiness on `/health` · **`terminationGracePeriodSeconds: 600`** (≫ longest generation) · `preStop` sleep 15 so the Service drops the endpoint first · `maxSurge: 1 / maxUnavailable: 0` · NetworkPolicy (router only) · metrics via `prometheus.io/scrape|port|path` **pod annotations**.

> **Two corrections against the deployment repo:** there is **no `ServiceMonitor`** anywhere (Prometheus
> is a plain Deployment self-scraping via pod annotations, `observability-config.yaml:546-584`), and
> there is **no `NetworkPolicy`** anywhere either — V-3 below would be the repo's first, so it needs a
> stated convention rather than a copied one. Also, **no workload in the repo sets
> `terminationGracePeriodSeconds` above 60s**; the 600s this ticket needs is a new value to justify
> in the manifest comment, not a house default.

**Autoscaling — corrected against the real deployment repo (2026-08-29).** The upstream-recommended
answer is a **KEDA Prometheus scaler on `vllm:num_requests_waiting`** (min 2 / max 4, cooldown ≥300s),
because **HPA-on-CPU is wrong**: a saturated vLLM pod is CPU-idle while its token queue fills, and a
new pod needs 3–10 min to pull the image, load weights and capture CUDA graphs. vLLM's own
production-stack documents exactly this pattern.

**But `hope-v2-deployment` has no KEDA** — zero hits for `keda` or `ScaledObject`. The house
precedent is the opposite and is deliberate: `deployment/k8s/base/stt.yaml` ships an HPA pinned
**inert** (`minReplicas == maxReplicas == 1`) with a long comment explaining that CPU-based
autoscaling is wrong for a GPU-bound pod, and naming DCGM-metrics-driven autoscaling as the real
answer — never implemented.

**Day-1 recommendation: follow the house precedent, not the upstream one.** Ship a fixed 2-replica
Deployment with an inert HPA and the same explanatory comment. Introducing KEDA is a real
platform decision with its own install, RBAC and failure modes; it should not ride in on this ticket.
Record `num_requests_waiting` as the metric to scale on **when** KEDA arrives, and alert on it
meanwhile so the need is visible.

Also note: `gpu-time-slicing.yaml` (3 virtual slices per physical GPU) exists in the repo but **is
not applied**. Any replica count must be checked against that capacity budget, not assumed.

> **Corrections to §8, verified against the live estate 2026-08-30:**
> - **Time-slicing IS applied.** The node reports
>   `nvidia.com/gpu.sharing-strategy=time-slicing`, `nvidia.com/gpu.replicas=3`
>   and `allocatable: nvidia.com/gpu: 6`. The claim above is stale.
> - **The house grace-period maximum is 90s, not 60s.**
>   `harness-worker.yaml` sets `terminationGracePeriodSeconds: 90`; `api.yaml`,
>   `stt.yaml` and `stt-worker.yaml` set 60. The 600s this ticket needs is still
>   far outside the norm and still needs the justification it now carries in the
>   manifest, but the stated baseline was wrong.
> - **`hope-ollama` no longer exists**, so `gpu-time-slicing.yaml`'s "3
>   steady-state consumers" comment is stale at 2 (`hope-stt`,
>   `hope-stt-worker`). Slot pressure is lower than that comment implies —
>   **but slots are not VRAM**, which is the constraint that actually binds
>   (§2A.1).
> - **`--max-model-len` and replica count are not the binding constraint here;
>   VRAM and memory bandwidth are.** See §2A.

## 9. Metrics and alerts
`vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:kv_cache_usage_perc`, `vllm:time_to_first_token_seconds`, `vllm:inter_token_latency_seconds`, `vllm:e2e_request_latency_seconds`, `vllm:request_queue_time_seconds`, `vllm:prefix_cache_queries`/`_hits`, `vllm:prompt_tokens_total`, `vllm:generation_tokens_total`, `vllm:request_success_total{finished_reason}`.

**Write dashboards defensively**: `kv_cache_usage_perc` was renamed from `gpu_cache_usage_perc`, and `inter_token_latency_seconds` from `time_per_output_token_seconds` — both names appear across versions, so `or` them.

Alert on: `num_requests_waiting > 0` sustained (queueing), `kv_cache_usage_perc > 0.9` (preemption risk), TTFT p95 breach, prefix-cache hit-rate collapse, finish-reason drift.

Reference Grafana dashboards: vLLM ships `examples/observability/prometheus_grafana/` in-repo; grafana.com IDs **25043, 24755, 24756, 25237, 25502, 23991**.

## 10. What NOT to build on day one
**Gateway API Inference Extension / llm-d / production-stack router: NO for day-1.** Its `InferencePool` + Endpoint Picker do KV/prefix-cache-aware scheduling (one deployment reports 3× output tok/s and 2× TTFT reduction), but at **1–3 replicas of a single model a plain k8s Service plus `apps/text` captures most of the win** — prefix-cache-aware routing pays off at higher replica counts with shared long prefixes. Revisit past ~4 replicas or when prefix-heavy RAG traffic arrives.

## 11. Verification Criteria
- [ ] `vllm bench serve` at concurrency {10, 25, 50, 100}; TTFT p95 and aggregate tok/s recorded as the baseline
- [ ] 40 concurrent in-flight generations sustained 10 min with `num_requests_waiting` at 0
- [~] **Weights load from MinIO via `runai_streamer`** — ⚠️ **this checkmark was downgraded
      2026-08-31; it was proven for a configuration that no longer ships.** Phase 2 measured
      902 tensors / 2.483 GiB in 10.51 s against a TLS MinIO **with a private CA and
      `AWS_CA_BUNDLE`** (`deployment/README.md` §10). Phase 3 removed both. The committed
      `base/vllm.yaml` carries `RUNAI_STREAMER_S3_VERIFY_SSL=0` for the C++ client and
      **nothing at all** for boto3 — and Phase 2's own variant 2 measured exactly that shape
      (https, no CA, no bundle) failing `CERTIFICATE_VERIFY_FAILED` on the first LIST. So the
      loader is proven; **the configuration that ships is expected to fail.** The manifest says
      so itself: *"THIS DOES NOT FULLY WORK YET"*. See `OPEN-823-TLS` and §14. Cold start on the
      real node also still unmeasured (needs the GPU).
- [ ] `VLLM_SERVER_DEV_MODE` unset — asserted by a test against the running pod's env
- [ ] `/invocations`, `/pause`, `/abort_requests`, `/update_weights` unreachable from outside the router
- [ ] No prompt text in pod logs under a full generation at INFO
- [ ] Rolling update completes with **zero** dropped in-flight generations
- [ ] KEDA scales on `vllm:num_requests_waiting`, not CPU
- [ ] `apps/text` routes to it as provider priority #1 via an `AiProviderConnection` SYSTEM row — **the connection row exists and is enabled** (`seed/17-ai-provider-connection.ts:354-367`, `provider: 'vllm'`, `baseUrl: http://hope-vllm:8000/v1`), but the lever has NOT been pulled: both SYSTEM `AiTaskDefault` rows that actually select a model (`text.live`, `text.finalize`) still name `lms-gemma-4-e2b-it-qat` (`seed/16-ai-task-default.ts:209-217`) — LM Studio, not vLLM
- [ ] A `models:/<name>@champion` alias resolves to an `s3://` URI and the pod serves it (§4A)
- [ ] Manifest follows house convention: annotation-based metrics, `imagePullSecrets`, inert HPA + PDB present, `runtimeClassName: nvidia` with matching GPU request **and** limit

## 12. Pitfalls (ranked)
1. `--max-model-len` left at the model's advertised max → KV starvation, ~10× fewer concurrent slots.
2. Sizing from `max_num_seqs` instead of KV-cache arithmetic — it is a **ceiling**, not achieved concurrency.
3. `VLLM_SERVER_DEV_MODE=1` or an unproxied `/invocations` in a PHI namespace.
4. `--enable-log-requests` at DEBUG → PHI prompts in cluster logs.
5. HPA on CPU; scale events arriving 5 minutes after saturation.
6. Assuming MLflow promotion deploys something.
7. `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING` unset → the weight read fails. **Corrected in
   Phase 2:** the symptom is NOT a DNS error but the opaque
   `ValueError: Could not receive runai_response from libstreamer due to: b'File access error'`,
   raised only after config, tokenizer and shard listing have all succeeded (those use boto3;
   only the weight read uses the C++ client). A smoke test that merely lists objects passes
   with this set wrong.
8. `gpu-memory-utilization` at 0.97+ → CUDA-graph capture OOM at startup.
9. Enabling MRV2 + FP8 KV + LoRA on day 1 → nothing is attributable.
10. Short `terminationGracePeriodSeconds` → dropped generations on every roll.
11. Assuming hot model swap exists.

## 12A. Implementation Summary — deployability pass (2026-08-30)

This pass did not change what vLLM *is*; it changed what it *depends on*, so that
the manifest can actually be applied. Three changes and one cancellation.

| Change | Before | After |
|---|---|---|
| **Transport to MinIO** | `https://10.10.1.102:9000` + mounted private CA | `https://10.10.1.102:9000` — **scheme unchanged**, CA removed, certificate verification turned OFF |
| **Credential** | `hope-secrets.MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` — the platform-wide read/**write** pair that can also reach the PHI buckets | `hope-models-reader` Secret (`accessKeyId` / `secretAccessKey`) — a MinIO **service account** narrowed by the committed `hope-models-reader` policy: read-only, `hope-models` only |
| **Endpoint's home** | already a ConfigMap key here; the rest of the platform still reads it from `hope-secrets` | unchanged here, and the runbook records why an endpoint is `env`-tier config and not a secret |
| **`ROOT_CONFIG_REQUEST R-1`** (create ConfigMap `arcaai-internal-ca`) | BLOCKING | **CANCELLED by owner decision** — recorded struck-through in `deployment/README.md` §9.1, never silently dropped |

**Net effect on the operator's job:** `vllm.yaml` previously required an object
that did not exist and could not be obtained from the cluster (a private CA PEM
that had to be fetched off the MinIO host). It now requires exactly **one**
hand-created object, the `hope-models-reader` Secret — and that same Secret is
what TASK-824's LM Studio sync Job already uses, so one service account serves
both serving tiers.

**Owner directive recorded in full:** *no CA at all*; MinIO authentication is a
service account and nothing else; **PHI hardening is explicitly de-prioritised
for now**. Crucially, **"no CA" settles AUTHENTICATION, not TRANSPORT** — the
scheme stays `https://`, because MinIO serves TLS on :9000 and one port serves one
scheme, so plain HTTP would have forced pgBackRest, GitLab, Loki, Tempo,
Prometheus and both cloudflared origins to be re-pointed as collateral. What
replaces the CA is **certificate verification turned off**, explicitly, with a
comment where it happens.

What that relaxes: an unverified TLS connection encrypts the wire but does **not**
authenticate the peer — it defeats passive capture on `10.10.1.0/24`, not an
on-path attacker. What it does not relax: the egress NetworkPolicy still confines
the traffic to `10.10.1.102/32`, and the endpoint allow-list (V-2),
`VLLM_SERVER_DEV_MODE` prohibition (V-1) and log-level controls (V-4) are
untouched.

**🟡 OPEN-823-TLS — the RULING is settled; the STATE is not. Re-checked 2026-08-31: the
certificate has NOT been installed, so this remains a live blocker.** The heading below said
"RESOLVED", which is true of the decision and false of the platform — and the difference is
exactly the thing that bites whoever scales this Deployment to 1. Owner ruling (2026-08-30): **a
publicly-trusted certificate goes on the MinIO listener.** No private CA returns and vLLM needs
no patch; verification succeeds, which is the shape both of its S3 clients
already support. An operator action outside both repos, not blocking while
`replicas: 0`, blocking the moment anyone scales to 1. It also lets
`minio.certCheck` return to `true` and `mc --insecure` come off the sync Job.
The measurement that forced the ruling is preserved below.

**⚠️ The finding (historical) — vLLM cannot be told to skip verification, and this
is measured, not suspected.** The weight-load path uses two S3 clients: **boto3**
(config, tokenizer, shard listing) and the Run:ai C++ SDK (weights). Only the
second reads `RUNAI_STREAMER_*`; **boto3 has no environment variable that disables
verification** — `verify=False` is a client-construction argument and vLLM builds
the client itself. Phase 2's lab ran exactly this shape as variant 2 (https +
private CA + no `AWS_CA_BUNDLE`) and it **failed** `CERTIFICATE_VERIFY_FAILED` on
the first LIST (`deployment/README.md` §10).

So vLLM is expected to fail at startup under the no-CA directive unless (a) the CA
is reinstated for vLLM only, (b) MinIO presents a publicly-trusted certificate, or
(c) vLLM's loader is patched upstream. All three are owner decisions. **Not
blocking today** — the workload is at `replicas: 0` for the unrelated hardware
reason in §2A — but blocking the moment anyone scales it to 1. The manifest
carries `RUNAI_STREAMER_S3_VERIFY_SSL=0` for the C++ half, clearly marked as an
**unverified** variable name (no vLLM image was available to this lane; an
unrecognised env var is inert, so it is safe to carry but must not be recorded as
"verification disabled" until a real pod proves it).

**Deployment runbook:** `docs/operations/inference/serving-tier-cluster-deployment.md`
— prerequisites, the objects an operator must create by hand, the ordered
LM Studio Service cutover, verification, rollback, and the known-unprovable list.

**`replicas: 0` is unchanged and the hardware blocker is unchanged.** Nothing in
this pass makes vLLM runnable on 2× RTX 2000 Ada; see §2A.

## 14. Where this actually stands (2026-08-31)

### The manifests are deployed, not merely authored

`eb3e5d92` — *"vLLM lands at replicas 0, with this repo's first NetworkPolicy"* — is on
`arca/hope-v2-deployment@main`. Live in `hope-v2-dev` and **Synced/Healthy** in the Argo
Application: Deployment `hope-vllm` (0/0, `ScaledToZero`), Service `hope-vllm`, HPA, PDB,
ConfigMaps `hope-vllm-config-h58cf94bt6` and `hope-vllm-endpoint-guard`, and NetworkPolicies
`hope-vllm-ingress` / `hope-vllm-egress`. The dev overlay additionally puts `hope-vllm` in the
`maxSurge: 0` set, for the sharpest form of the single-node reason: a surge pod is a second full
VRAM allocation and a second `nvidia.com/gpu` slice, on a node that has neither to spare.

Those two NetworkPolicies are also the **first this repo has ever produced**, which closes half of
TASK-828 §6's "zero NetworkPolicies" finding — and opens a new question it records: whether k3s is
enforcing them at all has never been tested (TASK-824 carries it as `R-5`).

### TWO blockers, not one — and only the first is in the header

1. **Hardware.** Unchanged and correctly stated: 2× RTX 2000 Ada (16380 MiB, 224 GB/s), short ~3×
   on VRAM and ~15× on bandwidth against the 20–40 in-flight target, with `mig.capable=false`,
   `mps.capable=false`, `vgpu.present=false` so time-slicing has no VRAM isolation and no
   workaround. Re-checked across the whole deployment repo: **no nodeSelector, node affinity or
   node label anywhere requests an A100/H100-class card.** Nothing is waiting to schedule onto
   hardware that exists.
2. **`OPEN-823-TLS` — and this one is easy to misread as closed.** Its section is headed
   "RESOLVED by owner ruling", which is true of the *decision* (put a publicly-trusted certificate
   on the MinIO listener) and false of the *platform*: **that certificate has not been installed.**
   The shipped `base/vllm.yaml` still carries `RUNAI_STREAMER_S3_VERIFY_SSL=0` for the C++ client
   and nothing for boto3, and the manifest's own comment says *"THIS DOES NOT FULLY WORK YET …
   vLLM is expected to fail at startup under the no-CA directive … blocking the moment anyone
   scales to 1."* Solving the hardware blocker alone would not produce a working pod.

### The routing lever has not been pulled

`AiProviderConnection` has the SYSTEM `vllm` row, enabled, pointing at `http://hope-vllm:8000/v1`
(`seed/17-ai-provider-connection.ts:354-367`). But selection lives in `AiTaskDefault`, and both
SYSTEM rows that choose a model for the live path — `text.live` and `text.finalize` — still name
`lms-gemma-4-e2b-it-qat` (`seed/16-ai-task-default.ts:209-217`). §5A already says the whole change
is repointing those two rows; recording here that it is **still to do**, so "vLLM is provider
priority #1" is not read as a live property.

### Criteria that cannot be met from a checkout, and one that has no path

Every unchecked box in §11 except the last needs a running pod, so they wait on the two blockers
above. One is different in kind: **KEDA scaling on `vllm:num_requests_waiting` has no path at all**
— there is no KEDA in the cluster and no `ScaledObject` anywhere in the deployment repo, and the
`hope-vllm` HPA is deliberately inert (`minReplicas: 1`, `maxReplicas: 1`, CPU metric, decorative
by its own comment). §10 already argues introducing KEDA is a real platform decision; the criterion
should be read as "when KEDA arrives", not as work in flight.

### What gates `replicas: 0 → 1`

1. A GPU in the A100/H100 class (owner decision — §2A).
2. A publicly-trusted certificate on the MinIO listener, or one of the two alternatives
   `OPEN-823-TLS` names (reinstate the CA for vLLM only; patch the loader upstream).
3. The `hope-models-reader` MinIO service account created by hand (`ROOT_CONFIG_REQUEST R-2`,
   shared with TASK-824) and the weights published to `s3://hope-models/`.
4. Re-tune `VLLM_GPU_MEMORY_UTILIZATION` for worst-case co-tenancy with `hope-stt` /
   `hope-stt-worker` on the same node, then flip the replica count by hand.
5. Separately, to make it matter: repoint the two `AiTaskDefault` rows.

## 13. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created from research. Sizing derived for 20–40 in-flight; security controls V-1..V-6 recorded; hot-swap ruled out via V-1. |
| 2026-08-30 (Phase 2) | **MinIO weight path PROVEN, and the endpoint blocker resolved.** Ran vLLM's own loader transport (`pull_files` → `list_safetensors` → `SafetensorsStreamer`) end to end against a TLS MinIO with a private CA: **902 tensors, 2.483 GiB, 10.51 s, 241.8 MiB/s**, with `Qwen/Qwen3-4B-AWQ` verified against HuggingFace's published sha256 before upload. Negative controls prove `AWS_CA_BUNDLE` and `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING=0` are both mandatory; corrected pitfall #7's failure signature (opaque `File access error`, not DNS) and the two-S3-clients reason behind it. **No GPU load was performed** — see `deployment/README.md` §10 "What was NOT proven". Resolved the endpoint (new §4B): MinIO is `10.10.1.102:9000` on the LAN, 2.0 ms vs 495.6 ms through the tunnel, with no in-cluster Service existing; repointed `config/vllm.env`, added `AWS_CA_BUNDLE` + CA mount, and **shipped the egress NetworkPolicy** that §4 of the handover previously could not write. Confirmed the image bundles the streamer (Dockerfile:529). Corrected the §2A weight estimate from 3.19 to the measured **2.483 GiB** (the checkpoint ties embeddings), raising honest capacity from ~6.8 to ~8.0 sequences. Two overstatements of my own were caught by the controls and corrected in place: `AWS_ENDPOINT_URL` alone IS sufficient with streamer 0.16.1, and the trailing slash on the model URI is optional. |
| 2026-08-30 | **§2 superseded by §2A.** Sizing redone against the real hardware (2× RTX 2000 Ada, 16380 MiB, read from the node's GFD labels) instead of the assumed H100 80GB. Verdict: no useful model fits at the 20–40 target — short ~3× on VRAM and ~15× on bandwidth simultaneously; an 8B at BF16 does not load at all. Recorded that MIG/MPS/vGPU are all unavailable, so time-slicing's lack of VRAM isolation has no workaround. Added §5A (the `AiProviderConnection`/`AiTaskDefault` integration contract — the SYSTEM connection row already exists; the lever is `AiTaskDefault`, and there is no priority field). Corrected §8: time-slicing IS applied, the house grace-period max is 90s not 60s, `hope-ollama` is gone. Manifests, config and handover authored under `deployment/`; dev compose `inference` profile extended with the MinIO streaming path and V-2/V-4 controls. Status left **Pending** — enabling is an owner hardware decision. |
| 2026-08-30 (Phase 3) | **Deployability pass — the CA is gone, the credential is least-privilege, and the manifest now depends on ONE hand-created object (§12A).** Per owner directive: no private CA anywhere, authentication is a MinIO SERVICE ACCOUNT and nothing else, PHI hardening explicitly de-prioritised. **"No CA" settles authentication, not transport** — the endpoint stays `https://10.10.1.102:9000` (MinIO serves TLS on :9000 and one port serves one scheme; plain HTTP would have forced pgBackRest, GitLab, Loki, Tempo, Prometheus and both cloudflared origins to be re-pointed as collateral), and what replaces the CA is **certificate verification turned OFF**, commented at the point it happens. Removed `AWS_CA_BUNDLE`, the `VLLM_S3_CA_BUNDLE` ConfigMap key, the `/etc/ssl/arcaai` mount and the `arcaai-internal-ca` volume from `deployment/vllm.yaml`; **`ROOT_CONFIG_REQUEST R-1` is recorded as CANCELLED, struck through rather than deleted**, so it can be reinstated when PHI hardening returns. Switched the credential from `hope-secrets.MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` — the platform-wide read/WRITE pair that can also reach the PHI buckets — to the dedicated `hope-models-reader` Secret (`accessKeyId`/`secretAccessKey`), the SAME Secret TASK-824's sync Job already reads, so one service account serves both serving tiers (new §9.1b). **Raised OPEN-823-TLS, which is a measurement rather than a caveat:** vLLM's load path has TWO S3 clients and only the Run:ai C++ one reads `RUNAI_STREAMER_*`; **boto3 has NO environment variable that disables verification** (`verify=False` is a construction argument vLLM owns), and Phase 2's variant 2 measured exactly this shape failing `CERTIFICATE_VERIFY_FAILED` on the first LIST. So vLLM is expected to fail at startup until the owner picks one of: reinstate the CA for vLLM only, put a publicly-trusted cert on MinIO, or patch the loader upstream. Not blocking today (`replicas: 0` for the hardware reason), blocking the moment anyone scales it to 1. `RUNAI_STREAMER_S3_VERIFY_SSL=0` is carried for the C++ half and marked UNVERIFIED — no vLLM image was available to this lane, and an unrecognised env var is inert. Validated on a throwaway single-node k8s namespace: `kubeconform -strict` 17/17 valid and `kubectl apply --dry-run=server` clean on all 7 objects; against a stand-in MinIO serving TLS with a self-signed leaf, the `hope-models-reader` policy JSON proved list/get ALLOWED and put/delete/other-bucket DENIED, and a MinIO service account was created end to end (MinIO rejects an access key longer than 20 characters — measured). Also measured the three transport controls that settle the scheme question: plain HTTP against a TLS listener returns `Client sent an HTTP request to an HTTPS server`; https without a CA fails `x509: certificate signed by unknown authority`; https with verification disabled works. Wrote the operator runbook `docs/operations/inference/serving-tier-cluster-deployment.md`. **`replicas: 0` and the hardware blocker are unchanged.** |
| 2026-08-31 | **Deployed, not just authored — and there are TWO blockers, not one.** New §14. `eb3e5d92` is on `hope-v2-deployment@main` and `hope-vllm` is live at 0/0, Synced/Healthy, with this repo's first NetworkPolicies (`hope-vllm-ingress`/`-egress`) — which closes half of TASK-828 §6's "zero NetworkPolicies" finding and raises its successor: k3s enforcement has never been tested (TASK-824 `R-5`). Three corrections. **(1)** §11's `[x]` on "weights load from MinIO via `runai_streamer`" was downgraded to `[~]`: it was proven in Phase 2 against a TLS MinIO **with a private CA and `AWS_CA_BUNDLE`**, and Phase 3 removed both — the configuration that actually ships is the one Phase 2's own variant 2 measured FAILING with `CERTIFICATE_VERIFY_FAILED`, and `base/vllm.yaml` says so itself (*"THIS DOES NOT FULLY WORK YET"*). **(2)** `OPEN-823-TLS`'s "✅ RESOLVED" heading is true of the DECISION and false of the PLATFORM — the publicly-trusted certificate has not been installed, so it is a second live blocker and solving the hardware one alone would still not produce a working pod. Re-headed 🟡 with the distinction stated. **(3)** The routing lever is unpulled: the SYSTEM `AiProviderConnection` row for vLLM exists and is enabled, but both `AiTaskDefault` rows that select a model (`text.live`, `text.finalize`) still name `lms-gemma-4-e2b-it-qat` — LM Studio. Also recorded: KEDA has no path (no KEDA, no `ScaledObject`, HPA deliberately inert at 1/1), and **no nodeSelector or node label anywhere in the deployment repo requests an A100/H100-class card**, so nothing is waiting to schedule onto hardware that exists. `replicas: 0` and the hardware blocker unchanged. |
