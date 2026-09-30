# Self-Hosted Inference Engines — engine tuning and local-dev serving

`apps/text` (port 8862) is the only service that dials a self-hosted LLM engine. This document
covers wiring Text to vLLM/llama.cpp/LM Studio and running them for local development via the
Docker Compose `inference` profile. **For deploying a serving tier into the k3s cluster, treat
[`serving-tier-cluster-deployment.md`](./serving-tier-cluster-deployment.md) as authoritative** —
it documents an owner decision (2026-08-30) that the production self-host tier is **LM Studio**
(GGUF) plus **vLLM** (safetensors/AWQ); `llama.cpp` has no cluster manifest today and remains a
local-dev/compose-only engine. Model residency/lifecycle tuning (`OLLAMA_KEEP_ALIVE`, LM Studio
TTL/Auto-Evict, `*.modelCache.*` settings) is covered in the companion
[`model-retention.md`](./model-retention.md).

## Layout

| Path | What it holds |
|---|---|
| `README.md` | This file — engine wiring and local-dev serving |
| `serving-tier-cluster-deployment.md` | Authoritative runbook for deploying `hope-lmstudio`/`hope-vllm` into the `hope-v2-dev` k3s namespace — MinIO weight staging, network policy, the LM Studio Service cutover |
| (this file) §vLLM ASR pool | Operating note for `apps/vllm` / `hope-vllm-asr` (TASK-1021 Phase 1, the successor of the TASK-1010 `asr-vllm` spike) |
| `model-retention.md` | When a model loads, how long it stays resident, and how to change that at runtime without a redeploy |

## Commands

```bash
# Local dev/test — start vLLM + llama.cpp + TEI embeddings (profile: inference)
mkdir -p infrastructure/docker/models/llama-cpp   # pre-stage a GGUF here first
pnpm infra:dev:up -- -e
#   vLLM        -> :8000  (OpenAI wire /v1, /health, /metrics)
#   llama.cpp   -> :8080  (/completion, /health, /slots)
#   TEI bge-m3  -> :8871  (/embed, /health)

# --- Smoke checks ---
curl -fsS http://localhost:8000/health && echo " vllm healthy"
curl -fsS http://localhost:8000/v1/models | jq '.data[].id'
curl -fsS http://localhost:8000/metrics | grep -E 'vllm:.*prefix_cache'

curl -fsS http://localhost:8080/health && echo " llama.cpp healthy"
curl -fsS http://localhost:8080/slots | jq '.[].state'
curl -fsS http://localhost:8080/completion \
  -d '{"prompt":"Say hello in one word.","n_predict":16,"cache_prompt":true}' \
  | jq '{content, timings}'

# Through Text (engine identity + provider-level stats)
curl -fsS http://localhost:8862/api/v1/generate \
  -H 'content-type: application/json' \
  -d '{"provider":"vllm","model":"Qwen/Qwen3-8B","prompt":"Say hello in one word."}' \
  | jq '{provider, stats}'
```

Compose vars (`.env`, all read by `infrastructure/docker/docker-compose.dev.yml`): `VLLM_MODEL`,
`VLLM_MAX_MODEL_LEN`, `VLLM_GPU_MEM_UTIL`, `HF_TOKEN` (gated HuggingFace downloads),
`LLAMA_CPP_MODELS_DIR`, `LLAMA_CPP_MODEL`, `LLAMA_CPP_CTX_SIZE`, `HOPE_TEI_EMBED_MODEL`. Images are
pinned (no `latest`); bump only to a build validated on your own hardware.

## How it works

**Local dev/test** still defaults to LM Studio and Ollama (`openai_compat`/`lm-studio`,
`ollama` providers). vLLM and llama.cpp are exercised locally through the Compose `inference`
profile for staging and smoke-testing before anything reaches the cluster.

Text holds no engine endpoint of its own. Every self-hosted adapter is fail-closed on a
caller-supplied `base_url`; to make an engine reachable, seed an `AiProviderConnection` row
(SYSTEM tenant for a platform default, or a tenant's own row for BYO):

| Column | vLLM | llama.cpp |
|---|---|---|
| `service` | `llm` | `llm` |
| `provider` | `vllm` | `llama-cpp` |
| `baseUrl` | `http://<host>:8000/v1` (includes `/v1`; `/health` and `/metrics` sit at the root) | `http://<host>:8080` |
| `enabled` | `true` | `true` |

Resolution is tenant to SYSTEM, two tiers, fail-closed when neither exists: an absent row means
"no opinion" (the SYSTEM default applies); a disabled row is a veto in both tiers. Self-hosted
engines are SYSTEM-only — tenant rows are for cloud APIs with BYO keys.

**Per-task selection is no longer table-driven for text generation.** `AiTaskDefault` is retired
(TASK-881); its replacement, `AiRoutingPolicy`, no longer carries the `text.live` / `text.finalize`
/ `text.test` elections either — text generation now selects through the tenant's assigned
`TEXT_GENERATION` Agent (TASK-876). `AiRoutingPolicy` (tenant to SYSTEM cascade) remains the
selection tier for the peer Python services that are not agent-driven (`apps/guardrail`,
`apps/nlp`).

Both vLLM and llama.cpp are first-class Text providers (`apps/text/src/text/providers/vllm.py`,
`llama_cpp.py`) rather than the generic `openai_compat` adapter re-pointed: distinct engine
identity in stats/spans, native `/health` checks at the server root, and structured-output
routing (vLLM's native `response_format={"type":"json_schema",...}` on vLLM >= 0.8, only ever
`extra_body.guided_json` as a hardcoded engine-build property — there is no environment variable
to toggle it, deliberately, so one deployment's vLLM version can't be applied process-wide).
llama.cpp accepts a `json_schema` field or a raw GBNF grammar via `context.grammar`, and
`cache_prompt: true` reuses the KV cache of a stable prefix across flushes/regens.

## Gotchas

- **The cluster manifest for llama.cpp does not exist.** Only `hope-vllm` and `hope-lmstudio` have
  k8s manifests in `arca/hope-v2-deployment` (`deployment/k8s/base/vllm.yaml`,
  `deployment/k8s/base/lmstudio.yaml`). Do not plan a cluster rollout around llama.cpp — it is
  local-dev/compose only today.
- **vLLM's `guided_json` fallback is not configurable by env var.** It is a hardcoded
  `self._use_guided_json = False` on the provider, deliberately, because the choice is a property
  of the vLLM build, not something a process-wide setting should apply to every deployment.
- **GPU budget on the cluster is shared and finite.** Per `.claude/rules/09-infrastructure-devops.md`,
  the node's GPUs are time-sliced with no VRAM isolation — a serving tier scaled up without
  accounting for co-tenants (STT, STT worker) risks a CUDA OOM whose victim is decided by
  allocation order, not by which workload is "supposed" to win.

## vLLM ASR pool (`apps/vllm`, TASK-1021 Phase 1)

`apps/vllm` (package `hope_vllm`, port **8867**, settings prefix `VLLM_`) is the OpenAI-compatible
Whisper ASR tier. It is the renamed TASK-1010 spike `apps/asr-vllm`, and it is a different thing from
the text-generation `hope-vllm` above (`vllm/vllm-openai`, `base/vllm.yaml`, replicas 0), which Phase 1
does not touch and Phase 2 retires with LLM/TTS. `apps/stt` calls it through its `vllm` engine
(`libraryName: 'vllm'`), selected by the SYSTEM `AiProviderConnection(stt, vllm)` →
`http://hope-vllm-asr:8867/v1`. The shell serves `POST /v1/audio/transcriptions` and `GET /v1/models`
(auth `X-Service-Token` or `Authorization: Bearer`; `X-Tenant-Id` mandatory) and resolves
`model=<AiModel slug>` through the gateway route
`GET /api/v1/internal/models/:slug/serving-spec?service=vllm`. Full API and error table:
`apps/vllm/README.md`.

In the cluster it is a `vllm-pool` Kustomize template in `arca/hope-v2-deployment` (Service
`hope-vllm-asr`, pool identity `VLLM_POOL=asr`). The dev pool ships at `replicas: 0` until the first
image digest is promoted; flip it to `replicas: 1` in Git (never `kubectl scale`). Flipped, it takes
**1 time-sliced GPU unit** of the 2 free (see the GPU budget in
`.claude/rules/09-infrastructure-devops.md`) and there is no VRAM isolation from LM Studio/STT.

**Pin a model.** Pools come from the platform setting `vllm.pools` (platform admin,
`PUT admin/settings/registry/vllm.pools`, `scope: "system"`); default entries `default` and `asr`.
Add the model's slug to `vllm.pools.<pool>.pins`. The map is applied WHOLE, so write every pool, and it
must keep the pod's own pool (a map that drops it is refused and logged
`vllm.control_plane.pool_missing_refused`). Pins load at startup, are never evicted, and
`/api/v1/health/startup` stays 503 until every pin is resident. A change lands on the next effective-config
poll (about 60 s; the pool pod has no Redis, so wait a minute or restart it).

**Size a model.** Engine sizing lives on the `AiModel` row, not in settings or env:
`_metadata.serving.vramGiB` (required — a row without it is 409 `SERVING_FACTS_MISSING`), plus optional
`maxNumSeqs` and `enforceEager`. Write it with `PATCH admin/ai-models/:id` and `If-Match`, using the
update DTO's `serving` field. `vramGiB` is GiB, converted at load into vLLM's
`gpu_memory_utilization` from the device's total memory, and admission is
`Σ resident vramGiB + new ≤ pool vramBudgetGiB`. The `asrVllm.*` settings no longer exist: soft-delete
any leftover `asrVllm.*` `GlobalSetting` rows; `vllm.truncation.*` replaces the truncation keys.

**Health paths.** `/api/v1/health` (always 200) · `/api/v1/health/live` (never fails because the replica
is busy or loading) · `/api/v1/health/ready` (503 when vLLM is absent or while draining) ·
`/api/v1/health/startup` (503 until every pin is resident). `GET /v1/models` lists resident engines and
pins (`resident: false` while a pin is still loading), `GET /api/v1/engines` is the pool snapshot, and
`/metrics` carries `hope_vllm_*` plus vLLM's own `vllm:*` series.

**`503 MODEL_NOT_PUBLISHED`.** Cluster pods run `HF_HUB_OFFLINE=1`, so a model whose weights are not on the
mounted models bucket (`/mnt/models-bucket/<bucketPrefix>`, a directory holding `config.json` and
`*.safetensors`) is refused with this code and is never pulled from Hugging Face. Publish the model to the
bucket (the TASK-1019 publisher), then retry; build failures are not cached, so the next request
re-evaluates.

**A failed pin warm-up is recovered by a restart.** A pin that fails to load at startup (slug
unresolvable, model not published, build failed) is not retried in-process: `/health/startup` stays 503
and the kubelet's startup probe restarts the pod. Fix the row, the pool or the bucket, then let the restart
happen (or delete the pod). Once running, a pin that fails to re-resolve on a refresh keeps the current
engine and is retried on the next refresh (`vllm.pins.refresh_failed`).

## Related

- [`serving-tier-cluster-deployment.md`](./serving-tier-cluster-deployment.md) — cluster deployment (authoritative for that surface)
- [`model-retention.md`](./model-retention.md) — model residency and lifecycle tuning
- [`../../../.claude/rules/06-python-services.md`](../../../.claude/rules/06-python-services.md) — Python service configuration rules, including the "no second inference stack" rule
- [`../../../.claude/rules/09-infrastructure-devops.md`](../../../.claude/rules/09-infrastructure-devops.md) — GPU capacity, cluster topology, configuration tiers
