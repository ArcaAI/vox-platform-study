# TASK-836 — MLflow as model registry, MinIO as storage, vLLM (Metal) as serving backend

| Field | Value |
|---|---|
| Status | `Review` |
| Type | `infrastructure` (research spike) |
| Branch | `dev-2.2` |
| Date | 2026-09-01 |
| Related | [TASK-835](../TASK-835-S3-Mounted-Model-Store/README.md) — S3-mounted model store |

> Numbering caveat: `docs/implementation/` tops out at TASK-835; `docs/archive/**`
> is hook-blocked this sprint and could not be checked.

## 1. Requirement Analysis

Investigate a local MLOps loop:

- **vLLM** as the serving backend for MLflow-registered models
- **MLflow** as the model registry
- **MinIO/S3** as artifact storage
- **k8s** for the services
- a **sub-1 GB** LLM, on a Mac, using the **Metal plugin**

## 2. Current State Evaluation — the constraint that shapes the design

TASK-835 established that vLLM could not run on this Mac at all: the published
arm64 image is CUDA-only, and Rosetta provides no AVX. **That conclusion is now
superseded for this path.** `vllm-metal` — an official `vllm-project` hardware
plugin using MLX — does run, natively.

Its requirements (verified against this machine):

| Requirement | This machine |
|---|---|
| macOS 15+ | macOS 26.6.2 |
| Apple Silicon | M3 Max |
| native arm64 Python 3.12 | 3.12.8 arm64 |
| Rosetta/x86_64 **not** supported | n/a — native |

**Metal is not reachable from a container.** Linux containers on macOS have no
Metal access, so `vllm-metal` CANNOT run inside a k8s pod. This forces a split
architecture, and it is a property of the platform, not a configuration choice:

- **k8s** runs the control plane — MLflow + MinIO
- **the macOS host** runs the inference backend — vLLM on Metal

## 3. Implementation Plan

1. MinIO in k8s (LoadBalancer, host-reachable), buckets `mlflow` + `models`.
2. MLflow server in k8s: sqlite backend store, `--artifacts-destination s3://mlflow/`.
3. Install `vllm-metal` natively via the official installer.
4. Register a sub-1 GB GGUF into MLflow; artifacts land in MinIO.
5. Pull from the registry and serve with vLLM/Metal; predict through the MLflow model.

## 4. Implementation Summary — WORKING end to end

| Component | Where | Result |
|---|---|---|
| MinIO | k8s `mlops`, LB `192.168.139.2:9000` | serving |
| MLflow 3.6.0 | k8s `mlops`, LB `192.168.139.2:5000` | serving, artifacts to `s3://mlflow/` |
| vllm-metal 0.4.0.dev | macOS host, `~/.venv-vllm-metal` | `Platform plugin metal is activated` -> `MetalPlatform` |
| vLLM core | 0.28.0 (macOS arm64 CPU wheel) + MLX 0.32.0 | — |
| Model | `Qwen3-0.6B-Q8_0.gguf`, **767 MB** | registered + served |

Metal genuinely engaged (server log):

    Native paged-attention Metal kernels loaded
    Metal: chunked prefill enabled (paged attention), max_num_batched_tokens=2048
    Metal memory: 51.5GB total, 19.7GB available
    Application startup complete            health HTTP 200

Registry round trip:

    REGISTERED qwen3-0.6b-q8-metal v1 alias=champion
    loaded pyfunc from registry in 425.7s
    predict via vLLM-Metal backend in 22.8s

`predict()` on the MLflow pyfunc proxies to the vLLM OpenAI endpoint — so MLflow
owns versioning/lineage/aliases and vLLM owns inference. That is the
"vLLM as backend for MLflow" wiring.

## 5. Findings

### 5.1 MLflow's artifact proxy is a ~110x bottleneck (most actionable)

Same host, same network path, same target disk, same 805 MB object:

| Path | Throughput |
|---|---|
| MLflow `--serve-artifacts` proxy | ~426 s (**~1.9 MB/s**) |
| Direct S3 (boto3 -> MinIO) | **3.9 s (204 MB/s)** |

`--serve-artifacts` proxies bytes through the tracking server. That is fine for
metrics and small artifacts and **unusable for model weights**. For LLM-sized
artifacts, clients must be given direct S3 access (`MLFLOW_S3_ENDPOINT_URL` +
credentials) rather than routing through the tracking server.

### 5.2 vllm-metal GGUF supports only LEGACY quants

    GGUFLoadError: Unsupported qtype Q4_K on mapped weight 'token_embd.weight';
    only Q8_0/Q4_0/Q4_1 (and plain F32/F16/BF16) are supported.

**K-quants (Q4_K_M, Q6_K, Q3_K_L) are rejected** — and they are the most common
GGUFs published. Model selection for this path must be constrained to Q8_0/Q4_0/Q4_1.
`Q8_0` is also ~1.5x larger than the `Q4_K_M` of the same model (767 MB vs 462 MB).

### 5.3 Multimodal GGUF is rejected outright

    NotImplementedError: Multimodal GGUF checkpoints are not supported by vllm-metal.

This killed Qwen3.5-0.8B (which ships an `mmproj`). Text-only checkpoints only.

### 5.4 A GGUF alone is not a servable artifact

    ValueError: Serving GGUF model '...' needs a config source: '...' has no
    config.json. A .gguf carries weights only; pass --tokenizer <dir> ...

**Registry consequence:** a registered model version must carry BOTH the `.gguf`
AND the HF config/tokenizer directory. The final registration logs them as two
artifacts (`gguf`, `tokenizer_dir`) for exactly this reason. The tokenizer dir is
~23 MB, so this is cheap — but omitting it produces an unservable version.

### 5.5 MLflow 3.x will not register a bare artifact path

`mlflow.register_model("runs:/<id>/model")` fails with *"Unable to find a
logged_model with artifact_path model"* — MLflow 3 requires a real logged model
(`mlflow.pyfunc.log_model(...)`), not just `log_artifact`. A GGUF must be wrapped
in a pyfunc to become a registry citizen.

### 5.6 Relation to TASK-835's GGUF conclusion

TASK-835 concluded vLLM cannot consume GGUF (vLLM 0.28 CUDA dropped it entirely:
no `gguf` in `QUANTIZATION_METHODS`, package absent). **`vllm-metal` reverses this
for the Metal path** — it has a dedicated GGUF loader (`vllm_metal/gguf/loader.py`),
though gated by 5.2/5.3. So "one GGUF for both LM Studio and vLLM" IS achievable
on Apple Silicon, provided the quant is Q8_0/Q4_0/Q4_1 and the model is text-only.
It remains false for the CUDA path.

## 6. Architecture conclusion

```
   k8s (control plane)                         macOS host (compute)
   ┌───────────────────────────┐               ┌────────────────────────┐
   │ MLflow  (registry, LB)    │◄──register────│ client / CI            │
   │ MinIO   (s3://mlflow, LB) │◄──DIRECT S3───│ (NOT via --serve-       │
   └───────────────────────────┘   weights     │  artifacts, see 5.1)   │
                                               │ vLLM + Metal (MLX)     │
                                               │ OpenAI API :8010       │
                                               └────────────────────────┘
```

Metal cannot be containerised, so the serving tier stays on the host while the
registry and storage tiers stay in k8s. On a real hope-v2 node (CUDA x86) the
serving tier moves into k8s and this split disappears — but so does `vllm-metal`,
and with it GGUF support (5.6).

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket opened. Full loop working: MLflow registry (k8s) + MinIO (k8s) + vLLM-Metal (host) serving a 767 MB Q8_0 GGUF. Status `Review`. |
