# TASK-823 — vLLM inference service (priority-1 backend)

| | |
|---|---|
| **Status** | Pending |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | TASK-822 (MLflow) for the promotion path; independent for first deploy |
| **Feeds** | TASK-818 (router) — vLLM is provider priority #1 |
| **Target** | ~200 concurrent users ≈ **20–40 in-flight generations**; GPUs already present on the k3s cluster |

## 1. Requirement Analysis

Stand up a self-hosted **vLLM** OpenAI-compatible inference server as the top-priority backend behind `apps/text`. Weights come from **MinIO**; model versions are registered and promoted in **MLflow** (TASK-822). `apps/text` must never host a model — vLLM is a **separate service**, which is exactly why this is its own ticket.

**What exists today**: the dev compose `inference` profile (`infrastructure/docker/docker-compose.dev.yml:440-560`, opt-in via `pnpm infra:dev:up -- -e`) already runs `vllm/vllm-openai:v0.11.0` as `hope-vllm` on `${TEXT_VLLM_PORT:-8000}` with an NVIDIA GPU reservation, `--model ${VLLM_MODEL:-Qwen/Qwen3-8B}`, and an `HF_HOME` named volume `vllm-cache`. **It pulls straight from HuggingFace Hub — nothing downloads weights from MinIO today.** The router adapter already exists and is a pure HTTP client (`apps/text/src/text/providers/vllm.py`), including a vLLM prefix-cache scrape into `TEXT_ENGINE_CACHE_HIT_RATE`.

So this ticket is: **cluster deployment + MinIO weight loading + MLflow promotion + the security posture** — not a new adapter.

## 2. Sizing — arithmetic, not rules of thumb

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

> **Unverified:** vLLM's page does not cover CA bundles for self-signed MinIO certs; it defers to the streamer's env docs. Plan on mounting the CA and setting `AWS_CA_BUNDLE`, but **verify**. Safest day-1: terminate MinIO TLS with a cluster-trusted cert, or use the in-cluster endpoint on an isolated network.

## 5. Model promotion — rolling re-deploy, not hot swap

**There is no production-grade hot model swap in vLLM in 2026.** Sleep Mode (`/sleep`, `/wake_up`, 18–200× faster than full reload) requires `VLLM_SERVER_DEV_MODE=1`, which V-1 forbids, and is documented "trusted networks only"; in-place weight loading is still an open RFC.

Therefore: MLflow alias flip → webhook → CI resolves `models:/name@champion` to an immutable MinIO URI + checksum → commits the URI and `--served-model-name` into the deployment repo → Argo CD rolling update. Details in TASK-822 §Phase 3. **Rollback = repoint the alias + revert the commit.**

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
Deployment (replicas 2) · `nvidia.com/gpu: 1` · `shm` emptyDir ≥2Gi · **startupProbe on `/health` with `failureThreshold` covering ~120s cold start** · readiness on `/health` · **`terminationGracePeriodSeconds: 600`** (≫ longest generation) · `preStop` sleep 15 so the Service drops the endpoint first · `maxSurge: 1 / maxUnavailable: 0` · NetworkPolicy (router only) · ServiceMonitor on `/metrics`.

**Autoscaling: KEDA Prometheus scaler on `vllm:num_requests_waiting`**, min 2 / max 4, cooldown ≥300s, with Cluster Autoscaler for GPU nodes. **HPA-on-CPU is wrong** — a saturated vLLM pod is CPU-idle while its token queue fills, and a new pod needs 3–10 min to pull the image, load weights and capture CUDA graphs. vLLM's own production-stack documents exactly this KEDA pattern.

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
- [ ] Weights load from MinIO via `runai_streamer`; cold start measured and recorded
- [ ] `VLLM_SERVER_DEV_MODE` unset — asserted by a test against the running pod's env
- [ ] `/invocations`, `/pause`, `/abort_requests`, `/update_weights` unreachable from outside the router
- [ ] No prompt text in pod logs under a full generation at INFO
- [ ] Rolling update completes with **zero** dropped in-flight generations
- [ ] KEDA scales on `vllm:num_requests_waiting`, not CPU
- [ ] `apps/text` routes to it as provider priority #1 via an `AiProviderConnection` SYSTEM row

## 12. Pitfalls (ranked)
1. `--max-model-len` left at the model's advertised max → KV starvation, ~10× fewer concurrent slots.
2. Sizing from `max_num_seqs` instead of KV-cache arithmetic — it is a **ceiling**, not achieved concurrency.
3. `VLLM_SERVER_DEV_MODE=1` or an unproxied `/invocations` in a PHI namespace.
4. `--enable-log-requests` at DEBUG → PHI prompts in cluster logs.
5. HPA on CPU; scale events arriving 5 minutes after saturation.
6. Assuming MLflow promotion deploys something.
7. `RUNAI_STREAMER_S3_USE_VIRTUAL_ADDRESSING` unset → MinIO host-style DNS failures at load.
8. `gpu-memory-utilization` at 0.97+ → CUDA-graph capture OOM at startup.
9. Enabling MRV2 + FP8 KV + LoRA on day 1 → nothing is attributable.
10. Short `terminationGracePeriodSeconds` → dropped generations on every roll.
11. Assuming hot model swap exists.

## 13. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created from research. Sizing derived for 20–40 in-flight; security controls V-1..V-6 recorded; hot-swap ruled out via V-1. |
