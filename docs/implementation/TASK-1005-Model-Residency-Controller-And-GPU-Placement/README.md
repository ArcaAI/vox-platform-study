# TASK-1005 — Model residency: load/unload control, live visibility, and demand-aware GPU placement

| Field | Value |
|---|---|
| Status | **In Progress** — owner said **go** 2026-09-24 with all OD recommendations |
| Type | feature + infrastructure |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) |
| Services | `stt` (+ `stt-worker`), `nlp`, `text`, LM Studio (`hope-lmstudio`), gateway (`apps/api`, `packages/applications`), admin console |
| Opened | 2026-09-24 |
| Rules read | `00`, `01`, `02`, `03`, `04`, `05`, `06`, `09`, `13`, `14`, `_karpathy` |

## 1. Requirement (owner, 2026-09-24)

> "An automatic load and unload of models based on workload and GPU/memory capacity, and allow the platform admin to control model load/unload for `stt`, `text`, `lm-studio`, `nlp`."
> 1. "lm-studio: use the SDK or call the API — we have official documents from LM Studio to load/unload and control the life-cycle."
> 2. "for `stt`, `nlp` we need to allow the user to control model load/unload and lifetime, same as lm-studio."
> 3. "allow admin (at least platform admin) to see which model is loaded and serving how many requests."
> 4. "need a smart algorithm to dynamically distribute/allocate load/unload of models based on requests and GPUs/GPU memory capacity."
> "For the rest, we need best practices for best performance." Do not build on or refer to other open tickets; this ticket is self-contained.

Classification: **feature + infrastructure**.

## 2. Current state (repo + live cluster, 2026-09-24)

### 2.1 Hardware and budget

| Fact | Value | Source |
|---|---|---|
| GPUs | 2× NVIDIA RTX 2000 Ada, ~16 GB each, on the single k3s node | DCGM `modelName` |
| Sharing | time-sliced ×3 → 6 `nvidia.com/gpu` slots, **6/6 allocated** (LM Studio 4, STT 1, STT worker 1); **no memory or fault isolation** between tenants of a card | deployment repo `base/gpu-time-slicing.yaml`, rule 09 |
| Memory now | GPU0 **4.0 GB** used · GPU1 **~0 GB** used | `DCGM_FI_DEV_FB_USED`, 2026-09-24 12:31Z |
| Memory 7-day peak | GPU0 **10.7 GB** · GPU1 **11.9 GB** | `max_over_time(...[7d])` |
| Utilisation, 24 h average | GPU0 **1.5 %** · GPU1 **0.3 %** | `DCGM_FI_DEV_GPU_UTIL` |
| NLP, TTS, harness | CPU-only (no GPU request) | deployment manifests |

The cards are mostly idle. **The performance problem is cold loads on the request path, not throughput.** Measured cold loads include 6.5–6.9 s for the whisper ml-en GGUF (TASK-1003 F-14) and 9–12 s for a mid-size GGUF LLM in LM Studio's own docs.

### 2.2 What exists

| Area | Exists | Missing |
|---|---|---|
| **Shared cache engine** `packages/py-runtime-models/src/hope_runtime_models/cache.py` (used by stt, nlp, harness, tts) | Single-flight load, pin/refcount, idle TTL (clamped 60–3600 s), max-models LRU, eviction order ttl → lru → vram, metrics contract `model_cache_{loads_total,evictions_total,resident_models,resident_bytes_estimate}`, `vram_free_bytes` | The **VRAM eviction path is dead**: no service passes a `vram_probe` (`make_vram_probe()` in `vram.py` is never called). `AiModel.memorySizeMb` is null in resolved specs, so budget estimates are 0 |
| **stt internal API** (`apps/stt/src/stt/health/api/routes.py`) | `GET /internal/cache/stats`, `GET /internal/cache/model/{slug}`, `POST /internal/cache/clear`, `GET /internal/pipelines/loaded`, `GET /internal/sessions` | No load / unload / pin / TTL verb for an operator; pin is per-session only |
| **nlp** (`apps/nlp/src/nlp/dependencies.py`) | Five caches keyed on `(model_name, model_path)`, pinned per request, retention adopted from control-plane | No operator surface beyond `GET /health` |
| **Per-model request gauges** | `model_running_instances{service,model}` + `model_inference_latency_seconds` wired in stt, nlp, text, tts, guardrail | Nothing reads them into an admin view |
| **LM Studio** (pod `hope-lmstudio`, llmster daemon, REST **v1** answers `GET /api/v1/models`) | Gateway `LmStudioEngineClient` reads `GET /api/v1/models` and unloads via `POST /api/v1/models/unload`; super-admin routes `admin/inference-engines/lm-studio/{runtime,models/:key/load,models/:id/unload}`; console "Serving Control" tab; descriptors `lmStudio.serving.*`, `lmStudio.jit.*` | `load` answers **501** because `POST /api/v1/models/load` was measured failing for every payload. The only working loader is `@lmstudio/sdk` over loopback inside the pod at boot (`infrastructure/docker/lmstudio/loader/load.mjs`). LM Studio has no `/metrics` endpoint (verified: "Unexpected endpoint") and reports neither VRAM per model nor in-flight count |
| **GPU observability** | DCGM per **device** (`DCGM_FI_DEV_FB_USED/FREE`, util, temp) | Per-process attribution: `infrastructure/gpu-process-exporter/` is built but **not deployed**; dcgm-exporter 4.4.2 has no per-pod attribution. Dashboard panels reference `hope_lmstudio_model_weights_bytes`, `hope_gpu_process_memory_bytes`, which nothing produces |
| **Placement** | LM Studio `_metadata.serving.gpuSplit` on the `AiModel` row (a configured intent) | No controller, no GPU-aware autoscaling (LM Studio HPA is CPU-only, 1/1) |
| **Settings** | `<svc>.modelCache.{ttlSeconds,maxModels,maxMemoryMb}` descriptors | `stt.warmDefaultAsrOnBoot` is read by STT but has **no descriptor**, so no admin path can set it (TASK-1003 addendum) |

### 2.3 LM Studio official lifecycle surface (research, sources in §11)

- **REST v1** (LM Studio ≥ 0.4.0):
  - `GET /api/v1/models` lists `loaded_instances[]` with `config{context_length, eval_batch_size, parallel, flash_attention, offload_kv_cache_to_gpu}`.
  - `POST /api/v1/models/load` takes `model, context_length, eval_batch_size, flash_attention, num_experts, offload_kv_cache_to_gpu, echo_load_config` and returns `instance_id, load_time_seconds`.
  - `POST /api/v1/models/unload` takes `{instance_id}`.
  - `ttl`, GPU split and `identifier` are **not** in the documented REST load schema.
- **SDK** (`@lmstudio/sdk`, `lmstudio` Python): `client.llm.load(key, {config:{gpu, contextLength, flashAttention, …}, ttl, identifier})`, `listLoaded()`, `unload()`, `getLoadConfig()`.
- **Built-in policy** (0.3.9+): JIT load, idle TTL (JIT default 60 min; `lms load` has none unless `--ttl`), Auto-Evict (keeps at most **one** JIT model).
- **Not settable by API:** Max Concurrent Predictions (`parallel`) is GUI or boot-env only (`LMS_PARALLEL=4` today). It is readable in v1 `GET /models`.
- **Load guardrails:** LM Studio's resource guardrail can reject CLI/REST loads that the GUI's "load anyway" would accept (bug tracker #1631). This is the leading hypothesis for our "REST load always fails".
- **Auth:** API tokens (≥ 0.4.0) with `Authorization: Bearer`. Off by default, and off on our pod today.

## 3. Findings (why a controller, not per-service tweaks)

1. **Four services, four residency policies, no shared view.** LM Studio evicts by its own JIT rule; stt/nlp evict by idle TTL and LRU; nobody sees the whole GPU.
2. **Decisions are made on estimates that are zero** (`memorySizeMb` null), so memory-aware eviction cannot work even once wired.
3. **Cold loads land on the live path.** The first STT session after a TTL eviction waits ~7 s. That is the TASK-1003 start-of-speech loss, now buffered, but still a quality and latency cost.
4. **Operators cannot act**: no load, pin or TTL control for stt/nlp, and no LM Studio load.
5. **Time-slicing gives no isolation**, so an over-committed load can OOM co-tenants on the same card. Admission must be conservative and based on measured free memory.

## 4. Best practices applied

| Practice | How it lands here | Source |
|---|---|---|
| **One control plane decides; data planes execute** (explicit model control) | A gateway residency controller owns every load/unload/pin decision; services expose a small uniform agent API and never evict a model the controller pinned | NVIDIA Triton `--model-control-mode=explicit` |
| **Measure, don't estimate** | Footprint is measured at load (NVML free-memory delta around the load, plus the service's own allocator stats) and written to a residency ledger and to the catalogue's observed size; decisions use measured values | dcgm-exporter #521 (no per-process data), our null `memorySizeMb` |
| **Busy guard + idle TTL + LRU** | Never evict a model with `inFlight > 0` or pinned; evict idle-longest first when memory is needed | Ollama `keep_alive` / eviction, LM Studio idle TTL |
| **Cost-aware eviction** | The score favours evicting models that are cheap to reload and rarely used: `score = idleSeconds × (1 / reloadSeconds) × (1 / priorityWeight)` | ModelMesh LRU + load awareness; HydraServe cold-start cost |
| **Admission control with headroom** | Load only if measured free memory on the target GPU ≥ footprint + headroom (default 15 %); otherwise evict candidates, else refuse with backpressure (queue with bounded wait, then 503 + `Retry-After`) | industry mixed-LLM GPU scheduling; time-slicing OOM blast radius |
| **Anti-thrash / hysteresis** | Minimum residency time, a re-load cool-down, and promotion to `WARM` only after sustained demand (EWMA request rate above a threshold for N windows) | common to Ray Serve multiplexing, Ollama, ModelMesh |
| **Warm the critical path** | Models on the live consultation path (each assigned ASR agent's primary model, the live-summary LLM) are `PINNED` and loaded at boot, before readiness; cold loads never land on a live request | latency-first serving; TASK-1003 F-14 |
| **Affinity routing** | Requests go to the instance that already holds the model; a replica only loads on miss | Ray Serve model multiplexing |
| **Shadow before enforce** | The policy engine first logs its intended actions ("would evict X for Y") with metrics; enforcement is a SYSTEM flag turned on after review | safe rollout of autonomous control loops |
| **Least privilege and audit** | Platform-admin only (SUPER_ADMIN), every manual action is a sys-event with actor and reason; LM Studio API auth turned on | rules 05, 09 |

## 5. Design

### 5.1 Components

```
                        ┌───────────────────────────── gateway (apps/api + packages/applications) ─────────────────────────────┐
 admin console ──REST──▶│ ModelResidencyController (policy engine, ledger, audit)  ◀── Prometheus (DCGM, model_running_instances) │
  (platform admin)      │   │ desired state (ModelResidencyPolicy rows + SYSTEM settings)                                     │
                        │   ▼ commands: load / unload / pin / setTtl        ▲ reports: resident models, bytes, gpu, inFlight   │
                        └───┼──────────────────────────────────────────────┼──────────────────────────────────────────────────┘
                            ▼                                              │
        stt agent API ── stt / stt-worker      nlp agent API ── nlp      LM Studio adapter ──▶ LM Studio REST v1 (or in-pod SDK sidecar)
        (/internal/residency/*)                (/internal/residency/*)   (gateway-side; auth token from Vault)
```

- **Residency agent API** (the same contract in stt, stt-worker, nlp; implemented once in `hope_runtime_models`):
  - `GET /internal/residency` returns resident models, each with `state`, `bytes` (measured), `device`, `inFlight`, `lastUsedAt`, `loadSeconds`, `pinned`, `ttlSeconds`, and device free/total.
  - `POST /internal/residency/load` (`{modelRef, pin?, ttlSeconds?}`), `POST /internal/residency/unload` (`{modelRef, force?}`; refuses `inFlight > 0` unless `force`), `PUT /internal/residency/{model}/policy` (pin, TTL).
  - Guarded by `X-Service-Token`, with `X-Tenant-Id: tenantless:residency`.
- **LM Studio adapter**: REST v1 for list, load and unload. TTL and pin are enforced by the controller (it unloads on idle), because REST v1 has no TTL field. GPU split per model uses REST if Phase 0 shows it is accepted; otherwise it goes through an in-pod SDK sidecar (see D-5).
- **Ledger**: controller memory, rebuilt from agent reports every 10 s (bounded staleness) and on every command result. The Prometheus gauges below are the durable history.
- **Metrics** (new, uniform): `model_resident{service,model,device,state}`, `model_resident_bytes{service,model,device}` (measured), `model_load_seconds{service,model}` histogram, `model_evictions_total{service,reason}` (`ttl|lru|pressure|admin|policy`), `residency_decisions_total{action,mode=shadow|enforce}`, `residency_admission_rejections_total{reason}`. The existing `model_running_instances` supplies in-flight counts.

### 5.2 Desired state

- **New Prisma model `ModelResidencyPolicy`** (SYSTEM-only configuration, rule 00): `aiModelId`, `service`, `class` (`PINNED | WARM | ON_DEMAND`), `idleTtlSeconds`, `priority` (int), `maxInstances`, `preferredDevice?`, standard meta/audit/soft-delete fields, OCC `_version`.
  - A typed table, not `_metadata` JSONB, because the controller queries it on every decision.
  - One row per `(aiModelId, service)`.
- **Defaults when no row exists:**
  - Every model that backs an **assigned ASR agent's primary** (any tenant, department or workflow resolution) or the **live-summary LLM** is implicitly `PINNED`.
  - Everything else is `ON_DEMAND` with the service's existing `modelCache.ttlSeconds`.
- **SYSTEM settings** (descriptors, `global-kv`): `residency.enforce` (default **false**, meaning shadow mode), `residency.headroomPercent` (15), `residency.minResidencySeconds` (300), `residency.reloadCooldownSeconds` (120), `residency.promotion.{rateThreshold,windows}`, `residency.admission.maxWaitMs` (5000).

### 5.3 Algorithm (runs every 10 s, and on every miss or command)

1. **Observe:** per device, free = DCGM `FB_FREE` (authoritative) and reported = the sum of the agents' measured bytes; per model, `inFlight`, EWMA request rate, `idleSeconds`, `reloadSeconds` (from the histogram, p50).
2. **Desired set:** `PINNED` ∪ `WARM` whose EWMA rate ≥ threshold for N windows (hysteresis) ∪ models with `inFlight > 0`.
3. **Place** each desired model that is not resident:
   - Choose the device (or service) with the most free memory that satisfies footprint + headroom (best-fit-decreasing by measured footprint; ties go to `preferredDevice`, then the device already hosting the same service).
   - LM Studio models may span both cards (its split strategy); stt/nlp place on their visible device.
4. **Make room if needed** with a cost-aware score over candidates that are **not pinned, `inFlight == 0`, resident ≥ `minResidencySeconds`**, evicting the lowest-value first until the model fits. If it cannot fit, record `admission_rejected` and, for a live request, keep serving from the current resident set (never evict a pinned model).
5. **Expire:** unload `ON_DEMAND` models with `idleSeconds > idleTtlSeconds` and `inFlight == 0`.
6. **Act or recommend:** in shadow mode, log and meter every intended action; in enforce mode, send the commands, bounded to one load per device at a time so load bandwidth doesn't collapse.
7. **On a request miss** (agent reports a load on demand): the agent loads immediately if the admission check passes locally (fast path), and the controller reconciles afterwards. A request waits at most `admission.maxWaitMs` for room, then gets 503 + `Retry-After`.

### 5.4 Admin console — "Model residency" (platform admin, global tier)

- **Per GPU:** a used/free bar (DCGM) plus stacked measured bytes per model, and the utilisation sparkline.
- **Table:** service · model · device · state · measured size · in-flight · requests/min · p50 latency · last used · class · TTL · pinned.
- **Actions:** Load, Unload (confirm; disabled with reason while `inFlight > 0` unless forced), Pin/Unpin, Set TTL, Set class. Every action is audited, and the screen shows "shadow" vs "enforce" mode with the policy's recommended actions.
- Built on `ScreenTemplate` + `AdminDataGrid`, skeleton loading, both themes, axe clean (rules 11, 13).

### 5.5 Performance targets (acceptance)

| Target | Value |
|---|---|
| Live STT session create when the agent's model is pinned | p95 **< 300 ms** (today 6.9 s cold) |
| Cold loads on the live consultation path | **0** during a 24 h soak |
| OOM kills or CUDA OOM errors in any GPU pod | **0** during a 24 h soak with enforcement on |
| Eviction thrash (same model loaded ≥ 3 times within 30 min) | **0** |
| Residency view freshness | ≤ 15 s |

## 6. Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | The controller lives in the **gateway**; services keep executing loads and unloads locally through a uniform agent API | Single decision-maker (Triton explicit mode), no new deployment, reuses auth/audit/settings |
| D-2 | **Measured** footprint, never catalogue estimates. The observed size is written back to `AiModel` as an observed field | Estimates are null today; time-slicing punishes over-commit |
| D-3 | **Shadow mode first** (`residency.enforce=false`); enforcement is a SYSTEM flag | A safe rollout for an autonomous loop |
| D-4 | Live-path models are **implicitly PINNED** and warmed before readiness; the ad-hoc `stt.warmDefaultAsrOnBoot` is superseded (it gets a descriptor in the TASK-1003 addendum meanwhile) | Latency-first; removes cold loads from live sessions |
| D-5 | **LM Studio load via the official REST v1 API.** Phase 0 reproduces the failure live: try `lms load --estimate-only` and REST load, check the resource-guardrail setting in the headless config, and test whether undocumented `ttl`/GPU fields are accepted. If REST v1 is unusable, promote the existing in-pod SDK loader (`load.mjs`) to a small authenticated sidecar on loopback | Use the vendor's supported, versioned surface first |
| D-6 | Enable **LM Studio API authentication**; the token lives in Vault kv (`vault-kv` tier), injected into the gateway only | Least privilege; LM Studio is reachable in-cluster today without auth |
| D-7 | **Placement stays within each workload's visible devices** (LM Studio spans both cards; stt and stt-worker hold one slice each). Cross-workload balancing is by per-device memory budgets, not by moving pods | Kubernetes time-slice slots are static; moving models between pods would mean restarts |
| D-8 | **Evaluate NVIDIA MPS** in a bounded spike (Phase 4): measure p95 latency and co-tenant OOM behaviour with per-client memory limits. Adopt only if it improves p95 and caps blast radius with no stability regression | MPS gives soft memory limits and concurrent kernels; MIG is not available on this card class |
| D-9 | Deploy per-process VRAM attribution with the already-built `infrastructure/gpu-process-exporter` (`nvidia-smi --query-compute-apps`), in addition to self-reported bytes | DCGM 4.4.2 cannot attribute per pod; our own exporter exists |
| D-10 | NLP and TTS stay on **CPU**; they join residency control for RAM budgets with the same algorithm (device = `cpu`) | They are fast enough on CPU, and there are no free GPU slots |
| D-11 | Platform-admin only; tenants never see this surface. Actions are sys-events (`ResourceType` gains `ModelResidencyPolicy`) | Models are platform infrastructure (rule 00: SYSTEM-only configuration) |

## 7. Open decisions (owner)

| OD | Question | Recommendation |
|---|---|---|
| **OD-1** | How long should shadow mode run before enforcement: a fixed window, or after a reviewed report of recommended actions? | 7 days of shadow data plus a review of the recommendation log |
| **OD-2** | When the GPU is full and nothing is evictable, should a live request wait (bounded) or be refused immediately? | Wait ≤ 5 s, then 503 + `Retry-After`; pinned live-path models make this rare |
| **OD-3** | May a platform admin **force**-load over budget (with an audit reason), knowing it can OOM card-mates under time-slicing? | Yes, force with a mandatory reason and a red confirmation |

### 7.1 Owner answers (2026-09-24)

> "go with your recommendations on all ODs for both tickets by align agents using appropriate model-effort tier"

- **OD-1:** 7 days of shadow data plus a review of the recommendation log before `residency.enforce` is turned on.
- **OD-2:** wait ≤ 5 s for room, then 503 + `Retry-After`.
- **OD-3:** a platform admin may force-load over budget with a mandatory audited reason and a red confirmation.

## 8. Implementation plan (on go)

### 8.1 Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Spikes** (1 day) | LM Studio REST v1 load repro (D-5); measure load footprint and time per model (whisper ml-en, gemma, embeddings, NLP models); confirm DCGM `FB_FREE` accuracy under time-slicing | A written finding decides REST vs sidecar; a measured footprint table in §10 |
| **1 — Observe** | Agent API (read side) in `hope_runtime_models` for stt, stt-worker and nlp; wire `vram_probe`; the new metrics; LM Studio adapter read; the controller ledger; a read-only console screen; deploy the per-process exporter | The console shows every resident model with measured bytes, device and in-flight across all four services |
| **2 — Control** | Agent load/unload/pin/TTL verbs; LM Studio load (REST or sidecar) and unload; the `ModelResidencyPolicy` table and domain trio; console actions with audit; LM Studio auth | A platform admin can load, unload, pin and set TTL for any model on all four services |
| **3 — Automate** | Policy engine (§5.3) in shadow mode; recommendation log and metrics; enforcement flag | Shadow report reviewed (OD-1); enforcement turned on; §5.5 targets met in a 24 h soak |
| **4 — MPS spike** | D-8 measurement on a maintenance window | Go/no-go recorded |

### 8.2 Lanes and tiers (rule 14)

| Lane | Owns | Tier / effort |
|---|---|---|
| L-SPIKE | Phase 0 measurements (read-only on cluster, LM Studio loopback calls through `kubernetes_exec`) | `sonnet` / medium |
| L-AGENT | `packages/py-runtime-models` agent API + VRAM probe + measured footprint + metrics; mounted in `apps/stt` and `apps/nlp` | `opus` / high (shared engine used by four services) |
| L-LMS | LM Studio adapter (REST v1 load/unload/list, auth), sidecar only if D-5 requires it; deployment repo auth + token wiring | `opus` / medium |
| L-DB | `ModelResidencyPolicy` Prisma model + migration (authored on the shadow DB by the orchestrator) + domain trio + `ResourceType` | `sonnet` / low (orchestrator runs the migration) |
| L-CTRL | Controller service, ledger, policy engine (shadow/enforce), settings descriptors, admin routes, sys-events | `opus` / high (the deciding algorithm) |
| L-UI | Console "Model residency" screen + actions | `sonnet` / medium |
| L-OBS | Deploy per-process exporter, recording rules, Grafana dashboard, alerts (`ResidencyAdmissionRejections`, `ModelThrash`, `GpuMemoryHeadroomLow`) | `sonnet` / low |

Each lane runs only its own RED → GREEN test file (owner rule); the orchestrator merges and runs one gate pass, then the runtime proof.

### 8.3 TDD test list (first failing test per lane)

- `hope_runtime_models`: an unload refuses while `inFlight > 0`; measured bytes equal the NVML free-memory delta (fake NVML); the agent API contract.
- Controller: the cost-aware eviction order; admission refusal with no evictable candidate; hysteresis (no promotion before N windows); the cool-down blocks a re-load; a pinned model is never evicted; shadow mode sends no command.
- LM Studio adapter: load/unload request shapes against recorded v1 responses; auth header present.
- Console: table renders from the residency DTO; the unload action is disabled while in-flight is above zero; axe clean.

### 8.4 Verification (after deploy)

- **Phase 1:** the console residency table matches `nvidia-smi --query-compute-apps` within 5 %.
- **Phase 2:** load, pin, TTL-expire and unload each model on each service, with evidence (screens plus metrics).
- **Phase 3:** a 24 h soak with enforcement on meets every §5.5 target; attach the recommendation log excerpt.

## 9. Risks

- **Time-slicing OOM blast radius.** Mitigated by headroom, measured footprints, one load per device at a time, and pinned live-path models (D-8 may add MPS limits).
- **LM Studio REST load may stay broken.** Mitigated by the D-5 sidecar fallback, which already works at boot.
- **Controller outage.** Services keep their existing local TTL/LRU caches, so failure is safe: no model is pinned or evicted by a controller that is down.

## 10. Implementation summary

_Pending._

## 11. Sources

- LM Studio REST v1: [list](https://lmstudio.ai/docs/developer/rest/list), [load](https://lmstudio.ai/docs/developer/rest/load), [unload](https://lmstudio.ai/docs/developer/rest/unload); [Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict); [headless llmster](https://lmstudio.ai/docs/developer/core/headless); [authentication](https://lmstudio.ai/docs/developer/core/authentication); [TS SDK load config](https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config); [parallel requests](https://lmstudio.ai/docs/app/advanced/parallel-requests); bug tracker [#1631](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1631), [#1666](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1666)
- [Triton model management (explicit mode)](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/model_management.html) · [KServe ModelMesh](https://kserve.github.io/website/latest/modelserving/mms/modelmesh/overview/) · [Ray Serve model multiplexing](https://docs.ray.io/en/latest/serve/model-multiplexing.html) · [vLLM sleep mode](https://docs.vllm.ai/en/latest/features/sleep_mode/)
- [GPU Operator time-slicing](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html) · [dcgm-exporter #521](https://github.com/NVIDIA/dcgm-exporter/issues/521) · [HydraServe cold start (arXiv 2502.15524)](https://arxiv.org/pdf/2502.15524)

## 12. Change history

| Date | Change |
|---|---|
| 2026-09-24 | Owner **go**: OD-1 (7 days shadow + review), OD-2 (≤ 5 s wait then 503), OD-3 (audited force-load) as recommended. |
| 2026-09-24 | Ticket opened from the owner's TASK-1003 follow-up comments. Discovery: two read-only agents (repo state; LM Studio + serving research), plus live checks (LM Studio v1 API present, no `/metrics`; DCGM baseline and 7-day peak). Plan, decisions and ODs written; awaiting go. |
