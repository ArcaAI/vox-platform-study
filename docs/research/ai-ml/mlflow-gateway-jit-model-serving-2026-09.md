# Research Report: Can MLflow front inference with LM-Studio-like JIT model loading?

**Date**: 2026-09-01
**Topic**: The owner requirement *"MLflow inference must act like LM Studio — if the model is loaded and serving, use it; if not, load it first, then infer"*, and *"remove the vllm provider and replace it with MLflow fronting vLLM inference"*
**Scope**: MLflow 3.15.2's DB-backed AI Gateway, vLLM v0.28.0 runtime model management, and the multi-model runtimes that actually deliver JIT
**Evidence**: Installed 3.15.2 source on the running `hope-mlflow` pod + live probes; vLLM v0.28.0 tagged docs/source; HOPE codebase
**Companion**: [mlflow-vllm-minio-onprem-inference-2026-09.md](./mlflow-vllm-minio-onprem-inference-2026-09.md) — reaches the same "MLflow out of the request path" verdict by a different route (pyfunc), and its §2.1 artifact-proxy number is load-bearing here too
**Ticket**: [TASK-853](../../implementation/TASK-853-MLflow-Fronts-Inference/README.md)

---

## Executive Summary

**The requested behaviour is real, valuable, and already running — but it lives in LM Studio, not MLflow, and it cannot be moved to MLflow or vLLM.**

| Question | Verdict |
|---|---|
| Does MLflow 3.15.2 have a supported way to front an OpenAI-compatible backend? | **YES** — the DB-backed AI Gateway, and it is *already mounted* on `hope-mlflow:5000` |
| Can that gateway load a model on demand? | **NO** — it is a stateless proxy. Nothing in its request path loads anything |
| Can vLLM swap or add a **base** model at runtime? | **NO** — `--model` binds once at engine start |
| Can anything in MLflow deliver LM-Studio-like JIT? | **NO** — and its artifact proxy makes the naive version ~110× too slow |
| Does HOPE already have the requested behaviour? | **YES** — LM Studio, already wired in `apps/text`, already admin-TTL'd |

**Decision taken 2026-09-01 (owner): vLLM is ON HOLD and will not run in the cluster.**

---

## 1. The requirement, stated precisely

> "the MLFlow inference part must act like LM studio, when there is a request, if model is
> loaded and serving, then use the model, if not, it should load the model first before
> inferencing"
>
> "the platform admin will configure the mlflow and manage the model registered in mlflow"

Two separable asks:

1. **JIT serving** — load-if-absent, serve-if-present, presumably unload-when-idle.
2. **Admin-managed registry** — a platform admin curates what is available.

They land in different tiers, and conflating them is what makes the design look impossible.
Ask 2 is exactly what MLflow is for. Ask 1 is a property of a **serving engine**.

---

## 2. MLflow 3.15.2 — what actually exists

Established against the **installed source** on the running pod, not documentation.

| Mechanism | In 3.15.2? | Separate process? | Evidence |
|---|---|---|---|
| **DB-backed AI Gateway** ("UI-based") | **YES — already mounted** | **NO — same process, same port 5000** | `mlflow/server/gateway_api.py` docstring: *"integrates the AI Gateway functionality directly into the MLflow tracking server"*; router included unconditionally at `mlflow/server/fastapi_app.py:230` |
| Legacy YAML gateway (`mlflow gateway start`) | present, **DEPRECATED** | yes | `mlflow/gateway/cli.py` carries `@deprecated(...)` pointing at the new gateway |
| Deployments Server (`mlflow deployments start-server`) | **REMOVED** | n/a | `mlflow deployments start-server --help` → `Error: No such command 'start-server'` |
| `mlflow models serve` | yes | yes | serves a *logged pyfunc*, one per process — a model server, not an LLM proxy |

**Live proof the gateway is mounted:** `POST /gateway/x/mlflow/invocations` →
`404 {"error_code":"RESOURCE_DOES_NOT_EXIST","message":"GatewayEndpoint not found (name='x')"}`
— the route matched and reached the database lookup.
`GET /api/3.0/mlflow/gateway/endpoints/list` → `200 {}`.

### 2.1 How it is configured

**Database rows created over REST — there is no config file for this mechanism.**

```
POST /api/3.0/mlflow/gateway/secrets/create             { secret_name, provider, secret_value }
POST /api/3.0/mlflow/gateway/model-definitions/create   { provider, model_name, secret_id,
                                                          auth_config: { auth_mode, api_base } }
POST /api/3.0/mlflow/gateway/endpoints/create           { name, model_configs, usage_tracking }
```

`api_base` is first-class for the `openai` provider — `gateway_api.py:300-301` maps it to
`openai_config["openai_api_base"]`, which is how any OpenAI-compatible backend is reached.
There is **no `vllm` provider** and no selectable `openai_compatible` value
(`providers/openai_compatible.py` is a base class, not a choice).

### 2.2 The request contract

`POST /gateway/mlflow/v1/chat/completions` — system message, `messages[]`, and
`temperature` / `max_tokens` / `top_p` / `top_k` / `n` / `stop` / `presence_penalty` /
`frequency_penalty` / `response_format` / `tools` / `tool_choice`. **Streaming works**
(`text/event-stream`).

---

## 3. Four gateway findings that constrain any adoption

### 3.1 PHI is persisted by default — the most serious

Request **and response** payloads are written as traces into the MLflow tracking database and
the artifact store (`s3://mlflow/artifacts`):

```python
# mlflow/server/tracing_utils.py:75
span.set_inputs(_dump_payload(kwargs["payload"]))
```

The only gate is `usage_tracking`, and it **defaults to `true`** (`handlers.py:5910-5912`;
gate at `tracing_utils.py:225`). The UI flow this feature is designed around therefore opts
you *in*.

> For a platform moving clinical consultation text, `usage_tracking: false` must be an
> enforced, tested invariant on every endpoint — not a convention someone remembers.

### 3.2 `model` cannot be chosen per request

The gateway treats the `model` field as the **endpoint name**, pops it, and returns **422** if
a real model name survives (`gateway_api.py:765-767`; `providers/base.py:604-610`).

Consequence for HOPE: per-tenant `AiTaskDefault` model selection would require **one gateway
endpoint per (tenant, task)**.

### 3.3 No tenant model, and no fallback semantics

`MLFLOW_ENABLE_WORKSPACES` defaults false and is unset on the pod. There is no per-tenant
credential resolution and no notion of "tenant value, else SYSTEM default".

This collides directly with `.claude/rules/00-project-context.md` §Configuration Principles,
where resolution is **always** tenant → SYSTEM. Either `apps/api` remains the resolver (and
MLflow adds a hop but no routing value), or the cascade is lost.

### 3.4 Auth is effectively absent; secret encryption is decorative

- Host/origin allow-listing (`fastapi_security.py:32-49`) is **not** authentication. Real auth
  requires `--app-name basic-auth`, which the Deployment does not pass.
- Secrets are envelope-encrypted, but the KEK derives from a **hardcoded salt**
  (`MLFLOW_KEK_SALT = b"mlflow-secrets-kek-v1-2025"`) and a **public default passphrase**
  (`DEFAULT_KEK_PASSPHRASE = "mlflow-default-kek-passphrase-for-development-only"`).
  `MLFLOW_CRYPTO_KEK_PASSPHRASE` was **verified unset** on the pod.

**Measured 2026-09-01:** `https://mlflow.taphuynh.dev/api/2.0/mlflow/experiments/search`
returns **200 unauthenticated from the public internet**. Once gateway endpoints exist, that
becomes "anyone can invoke inference using stored credentials." Cloudflare Access in front of
the admin hostnames is a prerequisite, not a follow-up.

### 3.5 Two smaller ones worth carrying

- **Post-response guardrails are skipped on streaming** (`gateway_api.py:785-787`) — material
  on a platform that runs a guardrail service.
- **The unified stream never emits `data: [DONE]`** — MLflow parses and drops the upstream
  sentinel (`utils.py:307,339`) and does not re-emit it. A client blocking on it will hang.
- With `--workers=4`, budgets need `MLFLOW_GATEWAY_BUDGET_REDIS_URL`; the default tracker is
  per-worker and in-memory, so limits are enforced 4× too loosely.

---

## 4. Why MLflow cannot be the JIT loader

Two independent reasons, either of which is sufficient.

**Reason 1 — the gateway does not load models.** It is a proxy to an already-serving upstream.

**Reason 2 — the registry path is orders of magnitude too slow.** From
[TASK-836](../../implementation/TASK-836-MLflow-Registry-vLLM-Metal/README.md):

| Measurement | Value |
|---|---|
| Load a **767 MB** model from the registry (§4) | **425.7 s** |
| MLflow `--serve-artifacts` proxy throughput (§5.1) | **~1.9 MB/s** |
| Direct S3 → MinIO, same host/object/disk (§5.1) | **204 MB/s** |
| Penalty | **~110×**, described as *"unusable for model weights"* |

`hope-mlflow` runs exactly that flag
(`--serve-artifacts --artifacts-destination=s3://mlflow/artifacts`). Extrapolated to the
published catalogue: a 2 GB Q4 GGUF ≈ **18 minutes**, granite at 4.9 GB ≈ **43 minutes** — per
cold load. LM Studio does it from local disk in seconds.

Two further registry constraints from the same ticket bind the admin workflow:

- **§5.5** — MLflow 3 will not register a bare artifact path; a GGUF must be wrapped with
  `mlflow.pyfunc.log_model(...)` to become a registry citizen.
- **§5.4** — a `.gguf` alone is not servable. The version must also carry the HF
  config/tokenizer directory (~23 MB), or it registers and then fails to serve.

---

## 5. Why vLLM cannot be the JIT backend

Confirmed against vLLM **v0.28.0** tagged sources.

| Capability | Verdict | Evidence |
|---|---|---|
| Swap/add a **base** model at runtime | **NO.** `--model` binds once at engine start; `/v1/models` is read-only | `vllm/entrypoints/openai/serving_models.py`; multi-base-model remains OPEN upstream — issues #299, #3326, #181, discussion #8077 |
| LoRA hot-load | **Adapters only**, layered on the already-loaded base model. Needs `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` | `docs/features/lora.md` @ v0.28.0 — *"This feature comes with security risks. It should not be used in production unless it is an isolated, fully trusted environment."* |
| Sleep mode | **Not a swap.** Level 1 resumes the SAME model (weights parked in CPU RAM); level 2 can load a different model **only via full reload** — stop-the-world, not a live registry. Needs `VLLM_SERVER_DEV_MODE=1` + `--enable-sleep-mode` | `docs/features/sleep_mode.md` @ v0.28.0 — *"development endpoints, and these endpoints should not be exposed to users"* |

### 5.1 Cold start makes the controller pattern unattractive anyway

A "scale one vLLM Deployment per model on demand" controller inherits vLLM's start cost:

| Measurement | Value |
|---|---|
| Llama 3.1 8B on A100, full pipeline to first token | **~176 s** |
| CUDA graph capture alone | ~54 s (reducible to ~7–8 s by tailoring batch shapes) |
| torch.compile | ~39 s warm-cache, more cold |
| 32B FP8 on 2×H200, optimized | 324 s → 91 s |

**CUDA-graph capture and torch.compile are largely fixed overheads independent of model size**,
so a 2–5 GB quantized model does not approach LM Studio's seconds. *(Third-party benchmarks;
no official vLLM table exists. The small-quantized case specifically is NOT ESTABLISHED — the
figures above are for 8B–32B-class models.)*

---

## 6. What does deliver JIT

| Runtime | JIT load | Multi-model | Idle unload | Licence | k8s fit |
|---|---|---|---|---|---|
| **LM Studio** | yes | yes | yes — `ttl` | **proprietary** (Element Labs; free for commercial use since 2025-07-08, but no redistribution/modification) | headless `llmster` daemon documented for k8s |
| **Ollama** | yes | yes — evicts idle to make room | yes — `keep_alive` (default 5 min), `OLLAMA_KEEP_ALIVE`, `OLLAMA_MAX_LOADED_MODELS` | **MIT** | good |
| **llama.cpp router mode** | yes | yes — one process per model | yes — `stop-timeout`; only one model resident per worker | MIT | good |
| **llama-swap** (proxy) | yes | yes | yes — `ttl` | MIT | purpose-built for this |
| Triton | explicit-API or POLL, **not** request-triggered JIT | yes | no native idle-TTL | OSS | standard, but wrong shape |
| Ray Serve LLM | replica autoscaling, not shared-pool JIT | yes | scale-to-zero, not a TTL flag | Apache 2.0 | heavyweight |
| KServe ModelMesh | yes, LRU eviction | yes | LRU, not TTL | Apache 2.0 | **explicitly documented as a poor fit for large single-GPU LLMs** |

### 6.1 HOPE already has it, and it is already admin-controlled

`apps/text/src/text/providers/lmstudio.py:80-87`:

```python
kwargs["extra_body"] = {"ttl": self._retention_ttl_s}
```

with the adapter's own docstring recording that the value is *"the control-plane retention TTL
adopted by `apply_retention` and clamped to the shared product range — one admin-controlled
number, not LM Studio's own 60-minute default."*

So load-on-demand, keep-warm and TTL-unload are **shipped**, and the TTL is already a platform
-admin-controlled value — which is the second half of the original requirement.

### 6.2 If the proprietary licence is a problem, Ollama is a control-plane change

`apps/text/src/text/main.py:101` already registers the adapter:

```python
_register(("ollama",), lambda: OllamaProvider(http_client))
```

Switching the JIT engine is therefore an `AiProviderConnection` row change, **not** a code
change. Per the standing owner decision, the Ollama *adapter* is kept even though its model
catalogue was purged.

---

## 7. Recommended architecture

```
apps/api  ── resolves AiProviderConnection + AiTaskDefault (tenant → SYSTEM)
   │          and PUSHes provider + credential + model per request
   ▼
apps/text ──► [ optional: MLflow AI Gateway ] ──► JIT engine (LM Studio today, Ollama if licence matters)
                 front door, budgets,                  load-if-absent · keep-warm · TTL unload
                 admin-managed endpoints

              MLflow Registry ................ governance: versions, aliases, lineage, promotion
              (control plane only — never in the weight path)
```

**Tier discipline, stated once:**

| Tier | Owner | Why |
|---|---|---|
| Governance — what exists, what is `champion`, who promoted it | **MLflow** | low volume, high governance value |
| Routing — which tenant gets which model | **`apps/api`** | only place that can express tenant → SYSTEM |
| Serving — tokens, JIT, keep-warm | **the engine** | latency-critical; MLflow must be nowhere near it |

This matches the companion report's control-plane/data-plane split, reached independently.

### 7.1 If the MLflow gateway is adopted as the front door

Non-negotiables, all from §3:

1. `usage_tracking: false` on **every** endpoint — enforced and tested (PHI).
2. Cloudflare Access (or `--app-name basic-auth`) in front of MLflow **before** any endpoint exists.
3. Set `MLFLOW_CRYPTO_KEK_PASSPHRASE` from Vault, or accept that stored credentials are effectively unencrypted.
4. Keep `apps/api` as the tenant resolver; provision gateway endpoints programmatically rather than moving tenant config into MLflow.
5. Confirm streaming end to end, including the missing `[DONE]` sentinel.
6. `MLFLOW_GATEWAY_BUDGET_REDIS_URL` if budgets are used with `--workers > 1`.
7. Accept the shared failure domain, or run a dedicated MLflow replica for gateway traffic — a stalled backend consumes worker slots shared with registry/experiment traffic.

---

## 8. Decisions taken

| Date | Decision |
|---|---|
| 2026-09-01 | **vLLM is ON HOLD — it will not run in the cluster.** It cannot hot-load or swap models (§5), so it does not serve the requirement that motivated it. Its manifests remain in the repo at `replicas: 0`. |
| 2026-09-01 | `qwen3-4b-awq` removed from `config/vllm.env`. It exists nowhere in HOPE v2 — no `AiModel` row, no seed reference. The only `provider: 'vllm'` row is `vllm-medgemma-1.5-27b-it` (55296 MB, ~54 GiB) which does not fit 2 × 16380 MiB cards. |
| 2026-09-01 | LM Studio is the day-1 serving engine: every `AiTaskDefault` already routes to an `lms-*` model. |

---

## 9. Open questions

| # | Question | Blocks |
|---|---|---|
| Q1 | Is the MLflow AI Gateway adopted as the front door at all, or does `apps/text` keep calling the engine directly? Given §3.2/§3.3, the gateway adds a hop and takes away per-request model choice. | TASK-853 build |
| Q2 | LM Studio (proprietary) or Ollama (MIT) as the JIT engine? | engine choice |
| Q3 | Is the MLflow **Model Registry** linked to gateway endpoints at all — can registering a version make it servable, or are they disjoint? **NOT ESTABLISHED**; the admin workflow in the requirement depends on the answer. | admin UX |
| Q4 | Does the `vllm` provider get deleted from the seed/enums, or retained as a disabled row? | TASK-853 scope |
