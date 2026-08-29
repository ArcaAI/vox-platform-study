# Production Inference Engines — Operations Runbook

> **Model retention & lifecycle** (when models load, how long they stay
> resident, and how to change that at runtime) lives in a companion runbook:
> [`model-retention.md`](./model-retention.md). Read it before tuning
> `OLLAMA_KEEP_ALIVE`, LM Studio TTL/Auto-Evict, or any `*.modelCache.*` setting.

vLLM and llama.cpp are the **production** self-host LLM engines for HOPE.
LM Studio (`openai_compat` / `lm-studio`) and Ollama stay the **local dev/test**
engines — this runbook covers staging, wiring, and smoke-testing the production
engines behind Text's first-class `vllm` and `llama-cpp` providers.

> **PHI posture unchanged.** These engines are self-hosted (in-boundary). Cloud
> providers (Azure/Bedrock) remain governance-gated per the gap review §7.C. No
> transcript/PHI ever leaves the Text ⇄ engine hop inside the cluster/host.

---

## 1. Engine matrix (AD-4)

| Environment | Chat / summarization | Safety / judge | Embeddings | Rerank |
|---|---|---|---|---|
| Local dev/test | LM Studio · Ollama | LM Studio (Granite) | LM Studio bge-m3 | TEI `:8870` |
| Production self-host | **vLLM** (primary; safetensors/AWQ/FP8) · **llama.cpp** (GGUF tier: MiniCheck, small utility, CPU/edge) | vLLM (Granite) or llama.cpp (GGUF) | **TEI** bge-m3 `:8871` | TEI `:8870` |
| Cloud C2 (gov-gated) | Azure OpenAI / Bedrock | — | — | — |

Both engines are **first-class Text providers** (not `openai_compat` re-pointed):
engine identity in stats, native stop reasons + token counts (AD-1), structured
output control, `/health`, and — for vLLM — a prefix-cache hit-rate gauge.

---

## 2. Model staging per hardware tier (gap review §7)

Footprints are planning approximations (quantization/KV/context move them ±20%);
validate on the actual serving engine before purchase decisions.

### 2.A Edge server — 64 vCPU / 128 GB / 1× RTX 5090 32 GB
- **Generation + judge (shared, ~18 GB free):**
  - quality-first: `MedGemma-27B AWQ` (~16.5 GB, FP8 KV, 8–16k ctx, 1–2 concurrent) on **vLLM**.
  - throughput-first: `Qwen3-14B AWQ` or `GPT-OSS-20B` (~10–13 GB, 3–4 concurrent).
- Speech + `bge-m3` + reranker + Granite-Guardian q4 share the rest.
- GGUF tier (MiniCheck-Flan-T5-L Q6 ~0.7 GB, small utility models) on **llama.cpp** CPU.

### 2.B Workstation — 128 vCPU / 256 GB / RTX PRO 6000-class (96 GB)
This tier makes **two-tier routing** real:
- **Live tier** (every flush): `gemma-4-e4b` / `Qwen3-8B AWQ` (~6 GB) on **vLLM** — sub-second TTFT with cached prefix.
- **Finalize tier** (harness generate + judges): `MedGemma-27B FP8` (~28 GB), `Llama-3.3-70B AWQ` (~40 GB), or `GPT-OSS-120B MXFP4` (~63 GB) on **vLLM**.
- GGUF utility models + MiniCheck on **llama.cpp**.

### 2.C Cloud
Rent L40S 48 GB (≈ edge+) or A100/H100 80 GB (≈ workstation) in a VPC; identical
images + posture, elastic concurrency. Data-residency (DPDP/ABDM) favors
in-region GPU instances — "cloud" without a policy change.

### Quantization choices
- **vLLM**: prefer **AWQ** (INT4) for the largest model that fits; **FP8** KV cache to stretch context; safetensors FP16 only when VRAM is ample. `--max-model-len` and `--gpu-memory-utilization` bound KV.
- **llama.cpp**: **GGUF** `Q4_K_M` for utility/CPU models, `Q6_K` for MiniCheck (CPU-proven 523 docs/min). Stage the `.gguf` once onto the host/PVC — the pod does not download weights.

---

## 3. Wiring Text to the engines

> **Corrected 2026-08-30 (TASK-818 Wave 0, V-2).** This section previously documented
> an env-var wiring model — `TEXT_VLLM_BASE_URL`, `TEXT_LLAMA_CPP_BASE_URL`,
> `apps/text/.env.prod`. **None of it exists.** Those variables were deleted with the
> engine sub-configs (TASK-736 / TASK-799) and are now BANNED BY NAME in
> `test_task799_config_surface.py`; `apps/text/.env.prod` has never existed in this
> checkout. Setting any of them has no effect whatsoever. The instructions below are
> the real ones.

Text holds **no engine endpoint of its own**. Every self-hosted adapter is fail-closed
on a caller-supplied `base_url` (`text.core.connection.require_base_url`), and
`core/config.py` declares nine bootstrap fields with no provider block, model id or
credential among them.

**To make an engine reachable, seed an `AiProviderConnection` row** — SYSTEM tenant for
a platform default, or the tenant's own row for BYO:

| Column | vLLM | llama.cpp |
|---|---|---|
| `service` | `llm` | `llm` |
| `provider` | `vllm` | `llama-cpp` |
| `baseUrl` | `http://hope-vllm:8000/v1` (**includes `/v1`**; `/health` + `/metrics` sit at the root) | `http://hope-llama-cpp:8080` |
| `enabled` | `true` | `true` |

Resolution is **tenant → SYSTEM, two tiers**, fail-closed when neither exists. An absent
row means "no opinion" (the SYSTEM default applies); a **disabled** row is a veto in both
tiers. Self-hosted engines are SYSTEM-only — tenant rows are for cloud APIs with BYO keys.

**Per-task model selection has moved.** As of TASK-816 Phase 1 the three node-reachable
keys — `text.live`, `text.finalize`, `text.test` — resolve from a workflow node's
per-node **`llmBinding`**, and the `{provider, model}` pair sent to `apps/text` is DERIVED
from the `AiModel` row the binding's slug names. `AiTaskDefault` survives as the selection
tier for **non-node capabilities only** (the peer services: `apps/guardrail`, `apps/nlp`).
Do not add new `text.*` rows to `AiTaskDefault` expecting a node to read them.

> **Deferred provider-accept wiring** (owned by parallel agents, NOT in this
> ticket): guardrail engine selector + harness `JudgeConfig.provider` accepting
> `vllm`/`llama-cpp`, and `AiModel.provider` seed rows. Text already routes to
> both engines today.

---

## 4. Serving — local dev (`inference` compose profile)

```bash
# GPU host required for vLLM. Pre-stage a GGUF for llama.cpp first:
mkdir -p infrastructure/docker/models/llama-cpp
# e.g. huggingface-cli download <repo> <file.gguf> --local-dir infrastructure/docker/models/llama-cpp

docker compose -f infrastructure/docker/docker-compose.dev.yml --profile inference up -d
#   vLLM        → :8000  (OpenAI wire /v1, /health, /metrics)
#   llama.cpp   → :8080  (/completion, /health, /slots)
#   TEI bge-m3  → :8871  (/embed, /health)
```

Compose vars (`.env`): `VLLM_MODEL`, `VLLM_MAX_MODEL_LEN`, `VLLM_GPU_MEM_UTIL`,
`HF_TOKEN` (gated downloads), `LLAMA_CPP_MODELS_DIR`, `LLAMA_CPP_MODEL`,
`LLAMA_CPP_CTX_SIZE`, `HOPE_TEI_EMBED_MODEL`. Images are pinned (no `latest`);
bump to a build validated on your hardware.

## 5. Serving — cluster

vLLM and llama.cpp serving manifests live in the **deployment repo**
(`arca/hope-v2-deployment`), not in this tree (`deployment/k3s/` was deleted).
Third-party images are pinned. Set the served model / sizing via overlay patches
on the `VLLM_MODEL` / `LLAMA_CPP_MODEL` env vars; stage the GGUF into the
`hope-llama-cpp-models` PVC before rollout.

---

## 6. Smoke commands

```bash
# --- vLLM ---
curl -fsS http://localhost:8000/health && echo " vllm healthy"
curl -fsS http://localhost:8000/v1/models | jq '.data[].id'
# prefix-cache counters (re-exported by Text as text_engine_cache_hit_rate{engine="vllm"}):
curl -fsS http://localhost:8000/metrics | grep -E 'vllm:.*prefix_cache'

# --- llama.cpp ---
curl -fsS http://localhost:8080/health && echo " llama.cpp healthy"
curl -fsS http://localhost:8080/slots | jq '.[].state'   # requires --slots
curl -fsS http://localhost:8080/completion \
  -d '{"prompt":"Say hello in one word.","n_predict":16,"cache_prompt":true}' \
  | jq '{content, timings}'

# --- Through Text (engine identity + AD-1 stats) ---
curl -fsS http://localhost:8862/api/v1/generate \
  -H 'content-type: application/json' \
  -d '{"provider":"vllm","model":"Qwen/Qwen3-8B","prompt":"Say hello in one word."}' \
  | jq '{provider, stats}'
```

### Owner-run live E2E (GPU hardware only)
```bash
TEXT_E2E_VLLM_BASE_URL=http://localhost:8000/v1 TEXT_E2E_VLLM_MODEL=Qwen/Qwen3-8B \
  conda run -n arcaenv --no-capture-output \
    pytest apps/text/src/text/tests/e2e/test_vllm_live.py -q -m e2e
```

---

## 7. Structured output & prefix caching

- **vLLM**: JSON-schema structured output via native `response_format={"type":"json_schema",...}` (vLLM ≥ 0.8); flip `TEXT_VLLM_USE_GUIDED_JSON=true` to route through `extra_body.guided_json` on older builds. Automatic prefix caching is on by default — Text scrapes the hit rate into `text_engine_cache_hit_rate{engine="vllm"}`.
- **llama.cpp**: JSON-schema (`json_schema` field) or raw **GBNF** grammar (via `context.grammar`). `cache_prompt: true` reuses the KV cache of a stable prefix across flushes/regens (the 4C prompt-reorder program depends on this).
