# TASK-1021 — `vllm`: one general, OpenAI-compatible inference service (text-generation, ASR, TTS)

| Field | Value |
|---|---|
| Status | **In Progress** — Phase 1 (Whisper ASR) merged into local `dev-2.2` (`2a82092a1` + `8a8bcc9b9`), gates run; NOT pushed; deployment branch `task-1021/vllm-asr` unmerged; cluster rollout + GPU proof (L5) pending owner go |
| Type | feature + infrastructure |
| Branch | `dev-2.2` |
| Repos | `arca/hope-v2` (this repo) and `arca/hope-v2-deployment` |
| Supersedes | TASK-1010 (vLLM Whisper spike — its open items are absorbed here); the parked text-generation `hope-vllm` tier (TASK-823) |
| Depends on | TASK-1019 (model registry HF publish — unmerged at time of writing, touches the same `AiModel` catalogue; merge it first or rebase wave 1 onto it) |

---

## 1. Requirement Analysis

### 1.1 Owner request (2026-09-29, verbatim intent)

`stt` runs several in-process engines with poor concurrency: faster-whisper (limited), whisper.cpp
(none — one lock per model), transformers (unknown). The TASK-1010 `asr-vllm` spike is to become
general:

1. Rename `asr-vllm` → `vllm`.
2. `vllm` serves models for **text-generation, ASR and text-to-speech**.
3. `vllm` exposes gold-standard, common APIs — **OpenAI-compatible**.
4. `vllm` mounts the shared model bucket through the **s3fs sidecar** like the other services and loads
   models from that mount point.
5. `vllm` fits the **scaling, GPU and memory allocation** configuration.
6. `vllm` is integrated with the **observability stack** (see `hope-v2-deployment`).
7. `stt` acts as the **gateway** when calling `vllm` for inference.

### 1.2 Decisions taken in the design conversation (owner-confirmed)

| # | Question | Owner answer |
|---|---|---|
| D-1 | Who calls `vllm` for each task? | **Each owning service is the gateway for its own task**: `stt` → ASR, `text` → text-generation, `tts` → TTS. `vllm` is a pure engine tier; no other caller. |
| D-2 | Service shape | **Approach 2 — keep and grow the HOPE shell** (`apps/asr-vllm` → `apps/vllm`): one process hosts several engines, loaded on demand; OpenAI routes served by the shell. (Rejected: 1 = stock `vllm serve` per model; 3 = stock instances behind a router.) |
| D-3 | How the shell knows what to load | **A + C**: the OpenAI `model` field is the `AiModel` slug, resolved by the shell through the gateway and loaded on first use; plus a per-pool **pin list** that is preloaded and never evicted. |
| D-4 | Topology | **One image, named pools.** Overlays stamp one or more pool Deployments; each pool declares accepted engine kinds, GPU units/memory, VRAM budget and pins. |
| D-5 | TTS scope | **Full**: shell hosts TTS engines (vLLM-Omni), `apps/tts` gets a `vllm` provider, and a **production** TTS model is selected, published and seeded as a SYSTEM default in this ticket. |
| D-6 | Ticket | TASK-1021 |

### 1.3 Success criteria

1. `apps/vllm` serves `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/completions`,
   `POST /v1/audio/transcriptions`, `POST /v1/audio/speech`, `GET /v1/audio/voices` with request and
   response bodies (including streaming SSE and error shapes) identical to upstream vLLM / vLLM-Omni at
   the pinned versions.
2. A stock OpenAI client (`openai` Python SDK, `curl`) can call it with only `base_url`, a bearer
   service token, an `X-Tenant-Id` header and `model=<AiModel slug>`.
3. In the cluster, weights load only from `/mnt/models-bucket` (s3fs, `HF_HUB_OFFLINE=1`); a model whose
   `localPath` is absent from the mount is refused (`503 MODEL_NOT_PUBLISHED`), never pulled. The
   registry-first HF pull inherited from TASK-1010 survives only for local/compose runs (offline flag
   unset). Never `s3://` streaming.
4. Every pool's replicas, GPU units, memory and VRAM budget are set per environment (overlay + DB), never
   in portable `base/`.
5. The service is scraped, alerted on, dashboarded, logged and traced, and every `hope-v2-deployment`
   CI gate is green.
6. `stt`, `text` and `tts` each reach it through a SYSTEM `AiProviderConnection(<service>, vllm)` row.
7. Runtime proof on dev (evidence pasted in §5): 25 concurrent ASR streams at commit p99 ≤ 15 s (the
   TASK-1010 target); one live consultation end to end `stt → vllm`; one summary through the `llm`
   pool; Malayalam speech through `tts → vllm`; the Grafana dashboard and one Tempo trace spanning
   gateway → `stt` → `vllm`.

---

## 2. Current State Evaluation (explored 2026-09-29)

### 2.1 `apps/asr-vllm` (TASK-1010 spike) — what exists

- Custom FastAPI shell (`src/asr_vllm/main.py:70`, `create_app()`), port **8867**, embedding vLLM
  in-process: `AsyncLLM.from_engine_args(...)` (`engine/vllm_backend.py:282-298`). It does **not** run
  `vllm serve` and exposes **no** `/v1/*` route.
- HOPE-only API: `POST /api/v1/transcriptions` (base64 PCM16 ≤ 30 s + the full `ResolvedAsrSpec` in the
  body), `POST /api/v1/engines/warm`, health ×4, `/metrics` (`asr_vllm_*`).
- Auth: `X-Service-Token` (`INTERNAL_ACCESS_TOKEN`) + mandatory `X-Tenant-Id`.
- Engine pool keyed by `runtimeKey`: single-flight, idle-LRU, 503 + `Retry-After` when full
  (`engine/pool.py`).
- Registry-first loading: `localPath` on the mount → HF pull with the owner's
  `model-registry:huggingface` credential (`models/source_resolver.py:165-190`); SAFETENSOR only; checksum
  verified.
- ASR specifics: 30 s window guard, `<|startofprev|>` prompt-prefix fix, vllm#53144 truncation
  heuristic (`truncation.py`).
- Control plane: `asrVllm.*` settings (`packages/applications/src/services/settings-registry/descriptors/asr-vllm.descriptors.ts`),
  pulled via `GET internal/effective-config?service=asr-vllm`.
- Build isolation (TASK-1010 OD-5): own `uv.lock`, base `vllm/vllm-openai:v0.30.0@sha256:…`
  (CUDA 13, Python 3.12, torch 2.13.0), outside the uv workspace.
- **Never built, never run on a GPU.** No CI job, no manifest, no STT adapter calls it.

### 2.2 The other, older `vllm` (text-generation only)

| Where | What |
|---|---|
| `hope-v2-deployment/deployment/k8s/base/vllm.yaml` | `hope-vllm` Deployment, `replicas: 0` ("on hold by owner decision"), stock `vllm/vllm-openai:v0.11.0` (tag, not digest), `runai_streamer` from `s3://`, nginx allow-list guard (CVE-2026-22778: `--api-key` does not cover admin routes), `prometheus.io/*` annotations, `VLLMDown` alert, no dashboard |
| `base/config/vllm.env` | `VLLM_MODEL_URI` = medgemma-1.5-27b (≈54 GiB — cannot fit a 16 GB card; header says it was sized for Qwen3-4B-AWQ) |
| `infrastructure/docker/vllm/` | `vllm-openai:v0.28.0` + GGUF plugin image |
| `.gitlab/ci/build.yml:717-835` | hidden `.build-vllm` job (`SERVICE_NAME: vllm`) |
| `infrastructure/docker/docker-compose.dev.yml:463-560` | compose `vllm` service, `inference` profile, `v0.11.0` |
| DB / app wiring | provider `llm:vllm` → `http://hope-vllm:8000/v1` (`built-in-defaults.ts:119-125`, seed `17-ai-provider-connection.ts:408-421`); `apps/text` `VllmProvider` (`providers/vllm.py:43`); admin `/ai-services/vllm` |

A rename of `asr-vllm` to `vllm` therefore **merges** with this tier; it is not a plain rename.

### 2.3 `apps/stt` engines

- Loader chosen by `AiModel.libraryName` (`models/cache.py:688-725`), engine adapter by `AiModelFormat`
  (`processors/asr_engines.py:469`). Adapter contract: `run_batch` + `make_streaming_callable`
  (`asr_engines.py:84-131`).
- Concurrency: whisper.cpp one `threading.Lock` per model (`streaming/whisper_cpp_asr.py`); faster-whisper
  `asyncio.to_thread` + opt-in cross-stream batcher; remote engines no semaphore; sessions capped by
  `CapacityGuard`.
- Closest template for a remote engine: the `openai` cloud REST engine (`models/openai_loader.py`,
  `streaming/openai_asr.py`, `OpenAIEngine` at `asr_engines.py:415`) — but it is BYOK-keyed.

### 2.4 `apps/text`, `apps/tts`

- `text`: `OpenAICompatProvider` / `VllmProvider` already speak the OpenAI wire; the endpoint comes only
  from the gateway-resolved `ProviderOverride` (`require_base_url()` fails closed).
- `tts`: providers `azure`, `sarvam`, `kokoro`, `indic_parler`, `indic_f5`; router over a
  `ResolvedTtsSpec` chain, fails over only before the first audio byte; inbound API already OpenAI-shaped
  (`POST /api/v1/audio/speech`). No HTTP self-host provider.

### 2.5 Deployment and observability facts (`hope-v2-deployment`)

- s3fs pattern: native sidecar (`initContainers` + `restartPolicy: Always`), `efrecon/s3fs:1.95@sha256:…`,
  privileged, `-o ro -o allow_other -o uid=… -o gid=… -o umask=0022`, `mountPropagation: Bidirectional`
  → app `HostToContainer` read-only at `/mnt/models-bucket`; `await-models-bucket` init. Copy-pasted in
  `stt`, `stt-worker`, `nlp`, `tts-v2`, `lmstudio` (no shared component). Known trap: a `#` comment
  inside the `\`-continued `exec s3fs` line silently drops every option after it (2026-09-21).
- Prometheus: static jobs + an opt-in `kubernetes-pods` annotation job (`service` label from `app`);
  `ExpectedTargetCountMismatch` counts static jobs only. Config rolls via hashed `configMapGenerator`
  (TASK-1005).
- Alerts `platform.rules.yml` + `alert-rules.test.yml` (promtool, CI job `prometheus-config`).
- Dashboards: `configMapGenerator grafana-dashboards`, gate `scripts/check-dashboards.py`.
- Logs: Alloy DaemonSet collects every pod automatically.
- Traces: `OTEL_EXPORTER_OTLP_ENDPOINT` via `hope-platform-config` (dev overlay sets
  `http://otel-collector:4317`); collector does PHI allow-list redaction.
- NetworkPolicy: podSelector-only egress rules do not match on this k3s cluster — use port/ipBlock
  rules (`stt.yaml:543-559`).
- CI gates a new workload must satisfy: `render`, `schemas`, `config-refs`, `image-hygiene`,
  `pull-secrets`, `envfrom-coverage` (workload must be classified), `secret-keys`, `capacity`, `probes`
  (readiness+liveness or waiver; explicit `progressDeadlineSeconds` with a startupProbe; no bare
  `/api/v1/health`), `patch-hygiene`, `dashboards`, `prometheus-config`, `secrets`.
- No HPA on any GPU workload; every HPA is CPU-based; no KEDA/custom-metrics adapter.

### 2.6 GPU estate

- **Dev** (`dell`): 2× RTX 2000 Ada 16 GB, sm_89, time-sliced ×4 = 8 units, 6 allocated (LM Studio 4,
  STT 1, STT worker 1). ⚠ `base/gpu-time-slicing.yaml` in git still says `replicas: 3` — the live value is
  ×4; reconcile in wave 3.
- **Prod**: ONE RTX A6000 48 GB, sm_86 (no FP8 tensor cores, no MIG).
- Time-slicing gives no VRAM isolation; co-tenants must be subtracted by policy.

### 2.7 Upstream facts that shape the design

- `vllm serve` / `vllm serve --omni` host **one model per server instance**. Multi-engine in one
  process is only possible at the library level (`AsyncLLM`, vLLM-Omni `AsyncOmni`) — whether the two
  coexist in one process is **undocumented** (wave 0 proves it).
- ASR: `/v1/audio/transcriptions` is native for Whisper / Voxtral
  ([docs](https://docs.vllm.ai/en/latest/serving/online_serving/speech_to_text/)).
- TTS requires **vLLM-Omni**: `/v1/audio/speech` (`input`, `model`, `voice`, `response_format`,
  `speed`, `language`, `instructions`, `stream`, `stream_format`, `max_new_tokens`, `sample_rate`,
  `ref_audio`, `ref_text`) and `/v1/audio/voices`
  ([docs](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/)). Supported TTS models
  include Qwen3-TTS (10 languages, **no Indic**), Fish Speech S2 Pro, Voxtral TTS, CosyVoice3, VoxCPM2 and
  **`k2-fsa/OmniVoice`** (646 languages **including Malayalam**, zero-shot cloning + voice design —
  [model card](https://huggingface.co/k2-fsa/OmniVoice), [paper](https://arxiv.org/html/2604.00688v1)).

---

## 3. Design

### 3.1 The `apps/vllm` service

`apps/asr-vllm` is renamed `apps/vllm` (Python package `hope_vllm`, settings prefix `VLLM_`, port
**8867**). It keeps TASK-1010's build isolation: own `uv.lock`, pinned `vllm-openai` base image with a
**matching `vllm-omni`** layered on, outside the uv workspace. One process per pod; the entrypoint is the
HOPE FastAPI shell (uvicorn `--workers 1`), never `vllm serve`.

| Layer | Owns |
|---|---|
| `api/` | OpenAI: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/audio/transcriptions`, `POST /v1/audio/speech`, `GET /v1/audio/voices`. HOPE: `GET /api/v1/health`, `/api/v1/health/{live,ready,startup}`, `GET /metrics`, `POST /api/v1/engines/warm`, `GET /api/v1/engines` (resident engines, VRAM used/budget — read-only, service-token). |
| `auth` | `Authorization: Bearer <INTERNAL_ACCESS_TOKEN>` (the OpenAI client convention) **or** `X-Service-Token`, constant-time compare. `X-Tenant-Id` REQUIRED on `/v1/*` (400 when absent). Health, `/metrics`, docs exempt. No admin/dev/debug/LoRA/tokenizer routes are mounted — the CVE-2026-22778 route set does not exist, so no nginx guard. |
| `resolver` | `model` slug → `ResolvedServingSpec` via the gateway (§3.2). |
| `pool` | Resident engines keyed by `runtimeKey`: single-flight loads, LRU eviction, pins, VRAM budget admission, per-engine in-flight cap (§3.3). |
| `engines/` | One adapter per kind — `llm` and `asr` wrap `AsyncLLM`; `tts` wraps vLLM-Omni `AsyncOmni`. Each adapter delegates request handling to **upstream's own OpenAI serving handler** for that route (chat, completions, transcription, speech), so wire format, SSE and error bodies are upstream's. The shell never re-implements an OpenAI schema. |
| `models/` | Registry-first source resolution, checksum verification (kept from TASK-1010). |
| `observability` | `hope_obs` (JSON logs, OTLP traces, request/tenant context, PHI hook); metrics §3.6. |

**Removed from the spike:** the HOPE `POST /api/v1/transcriptions` contract and "spec in the body";
the ASR window guard, prompt prefix and truncation heuristic (they move to `stt`, §3.4).

**Kind gating:** a request whose resolved `kind` does not match the route (chat on an ASR model) or is not
in the pool's `acceptedKinds` returns an OpenAI-shaped `404 model_not_found`.

**Upstream-internal risk:** the serving handlers are internal vLLM classes. Contained by the pinned image
and a contract test that imports them and asserts the constructor/handler signatures the adapters use —
a version bump that moves them fails CI, not production.

### 3.2 Model resolution

- New gateway route **`GET /api/v1/internal/models/:slug/serving-spec`** (internal service-token guard;
  `internal-service-token.guard.ts` map gains `vllm`). Resolves the `AiModel` visible to `X-Tenant-Id`,
  tenant → SYSTEM on absence (catalogue rule), and returns a **`ResolvedServingSpec`**:

  ```ts
  // packages/types/src/serving-spec.ts (pydantic mirror in apps/vllm; committed parity fixture)
  interface ResolvedServingSpec {
    slug: string;
    kind: 'llm' | 'asr' | 'tts';
    runtimeKey: string;           // AiModel id + published checksum/version
    tenantId: string;             // owner of the row (SYSTEM or the tenant)
    localPath: string | null;     // derived /mnt/models-bucket/...
    sourceUri: string; sourceRevision: string | null;
    checksum: string | null;
    format: 'SAFETENSOR';         // anything else → 409 at the gateway
    quantization: string | null;  // refused per compute capability (OD-5)
    engine: {
      vramGiB: number;            // weights + KV budget for this engine
      maxModelLen: number | null;
      maxNumSeqs: number | null;
      dtype: string | null;
      enforceEager: boolean | null;
    };
    tts?: { voices: string[]; defaultVoice: string | null };
  }
  ```

- Only rows with `servedBy: 'vllm'` resolve; others → 404. Engine arguments live on the model row
  (`AiModel._metadata.serving`), extending TASK-1010 OD-8 — never env.
- Shell cache: `(tenantId, slug) → runtimeKey` (TTL + negative cache + single-flight, the
  `core/effective_config.py` pattern). Engines keyed by `runtimeKey`: a SYSTEM model's engine is shared by
  every tenant; a tenant BYO model gets its own engine reachable only by that tenant.

### 3.3 Pools, GPU memory, concurrency

- Pool identity is the only engine-related env var: **`VLLM_POOL`** (`llm` | `asr` | `tts` | `mixed` |
  any overlay-defined name) — process identity, allowed by the bootstrap floor.
- Pool configuration is one platform setting **`vllm.pools`** (global-kv descriptor, SYSTEM-tier,
  super-admin write), a map `poolName → { acceptedKinds[], pins[], vramBudgetGiB, maxResidentEngines,
  idleEvictSeconds }`, pulled via `internal/effective-config?service=vllm`.
- Pins load at startup; `/health/startup` passes only when every pin is resident; pins are never evicted.
- **Sizes are GiB, not fractions.** At load time the shell reads the device's total memory and converts
  `engine.vramGiB` into vLLM's `gpu_memory_utilization`. The same model row sizes correctly on a 16 GB dev
  card and the 48 GB A6000.
- **Admission:** load admitted iff `Σ resident vramGiB + new ≤ vramBudgetGiB`; otherwise evict the
  least-recently-used idle non-pinned engine; if none, `503` + `Retry-After`.
- **Concurrency:** vLLM continuous batching per engine; shell adds a per-engine in-flight cap derived
  from `maxNumSeqs` (settings-tunable multiplier) → `429` + `Retry-After` beyond it.
- Scope limits: tensor parallel = 1, one GPU per pod; multi-GPU / 1,000-stream fleet stays deferred.
  Tenant id in logs/traces, never in metric labels.

### 3.4 Callers (each service is the gateway for its own task — D-1)

**Stable addresses.** Three ClusterIP Services exist in every environment — `hope-vllm-llm`,
`hope-vllm-asr`, `hope-vllm-tts`, each `:8867` — selecting pods by label
`vllm.hope/serves-{llm,asr,tts}: "true"`. Overlays decide which pool backs which Service (dev: one `mixed`
pod carries all three labels). DB URLs are identical in every environment.

**Connections.** SYSTEM `AiProviderConnection` rows `llm/vllm` → `http://hope-vllm-llm:8867/v1`,
`stt/vllm` → `http://hope-vllm-asr:8867/v1`, `tts/vllm` → `http://hope-vllm-tts:8867/v1`; `vllm` added to
`PLATFORM_SELF_HOST_PROVIDERS` for `llm`, `stt`, `tts`; rows carry the self-host placeholder key and the
platform service token authenticates. Extra pools are TASK-958 siblings bound by
`AiModel.sourceConnectionId`.

**`stt` (ASR).**
- New remote engine selected when the spec's `libraryName` is `vllm` (no new Prisma `AiModelFormat`;
  SAFETENSOR stays descriptive). Loader returns `RemoteVllmConfig` (base URL, `maxConcurrent`) from the
  connection override.
- Streaming callable: each ≤ 30 s window → multipart WAV `POST /v1/audio/transcriptions` with
  `model=<slug>`, `language`, `prompt`, `temperature`, `response_format=verbose_json`; headers
  `Authorization: Bearer`, `X-Tenant-Id`, `X-Request-Id`, `traceparent`.
- The 30 s guard, prompt prefix and truncation heuristic move here; settings `asrVllm.truncation.*` →
  `stt.vllm.truncation.*`.
- Backpressure: per-connection semaphore = `AiProviderConnection.maxConcurrent`; `429`/`503` retried with
  backoff honouring `Retry-After`, then failover through `engine_switch` to the agent's next fallback
  model. `CapacityGuard` still caps sessions.
- Batch (Dramatiq): files cut into ≤ 30 s windows and fanned out concurrently under the same semaphore.

**`text` (LLM).** `VllmProvider` keeps the OpenAI wire; it now sends the service token + `X-Tenant-Id`,
probes `/api/v1/health`, reads prefix-cache stats from the shell's re-exported `vllm:*` metrics, and
`guided_json` is re-checked against the pinned version's structured-output parameters.

**`tts` (TTS).** New `vllm` provider, `CredentialPosture.SELF_HOST`, a router chain candidate:
`synthesize` → `POST /v1/audio/speech` (`stream: true`, `response_format: pcm`) streamed through, failover
only before the first byte; `voices` → `GET /v1/audio/voices`. Only preset / designed voices (`voice`,
`instructions`) — reference-audio cloning is out of scope unless OD-3 says otherwise.

**Catalogue and seed.**
- `servedBy: 'asr-vllm'` → `'vllm'` everywhere (`AI_MODEL_SERVED_BY`, `CONSUMING_DEPLOYABLES`, seed
  `ai-models/shared.ts`, admin `SERVED_BY_OPTIONS`, regenerated OpenAPI / portal / vox-node schemas).
- SYSTEM model rows: the existing `arcaai-whisper-large-ml-en-vllm`; one LLM (OD-1); `k2-fsa/OmniVoice`
  (OD-2), each with `_metadata.serving`.
- The `realtime-transcription-vllm-spike` agent is renamed and stays playground-only.
- AI readiness: `servedBy: vllm` is healthy when the matching Service answers `/api/v1/health/ready`.

### 3.5 Deployment (`hope-v2-deployment`)

- **Pool template** `deployment/k8s/vllm-pool/` (Deployment, PDB `minAvailable: 0`, NetworkPolicies,
  per-pool ConfigMap). Each overlay instantiates it once per pool through a sub-kustomization with
  `nameSuffix` and patches for GPU units, memory, replicas, `VLLM_POOL` and the `serves-*` labels.
- **`base/vllm-services.yaml`**: the three stable Services. Base stays portable — no pool, no GPU count,
  no replicas.
- **Retired:** `base/vllm.yaml` (Deployment, nginx guard, NetworkPolicies, PDB), `config/vllm.env`
  `runai_streamer` keys, orbstack delete-patches.
- **Pod:** native s3fs sidecar copied from `stt.yaml` with `uid=gid=10001` (the image user) and every
  comment above `exec s3fs`; `await-models-bucket` init; app container with `runtimeClassName: nvidia`,
  `/dev/shm` memory emptyDir, read-only root (triton / inductor / HF caches on `/tmp`),
  `HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_OFFLINE=1`, `envFrom` `hope-platform-config` +
  `hope-vllm-config` (`VLLM_API_GATEWAY_URL`), `INTERNAL_ACCESS_TOKEN` from `hope-secrets`.
- **Probes:** startup `/api/v1/health/startup` (pins loaded; long budget), readiness `/ready`, liveness
  `/live`; explicit `progressDeadlineSeconds` derived from the startup budget.
- **Rollout:** `maxSurge: 0`, `maxUnavailable: 1` (GPU singleton); drain on SIGTERM (stop admitting,
  finish in-flight), `terminationGracePeriodSeconds: 600`.
- **NetworkPolicy:** ingress from `hope-stt`, `hope-stt-worker`, `hope-text`, `hope-tts`, prometheus;
  egress DNS, MinIO 9000, `hope-api` 8868, `otel-collector` 4317 — port/ipBlock rules.
- **Gates:** `check-envfrom-coverage.py` moves `hope-vllm-*` from `NOT_APP_SERVICES` to
  `WORKLOAD_TO_SERVICE`; `check-probes.py` waivers for the sidecar and the init container;
  `check-capacity.py` GPU roles for the pools; EKS `gpu-nodegroup` patches cover the pools; a CI step
  executes the rendered s3fs script against a stub `s3fs` and asserts argv.
- **Scaling:** replicas + GPU units per overlay. Dev: one `mixed` pool on 1 time-sliced unit. Prod
  (A6000): separate `asr` and `llm`+`tts` pools. No HPA (CPU is the wrong signal; no custom-metrics
  adapter) — queue/in-flight metrics ship so KEDA or an adapter can be added later without code change.
  `gpu-time-slicing.yaml` reconciled to ×4.

### 3.6 Observability

- **Metrics** — pod `prometheus.io/*` annotations (the `kubernetes-pods` job; static-target count
  unchanged). The shell exports:
  - `hope_vllm_requests_total{route,kind,model,status}`, `hope_vllm_request_seconds` (histogram),
    `hope_vllm_ttft_seconds`, `hope_vllm_asr_rtf`, `hope_vllm_tts_first_audio_seconds`,
    `hope_vllm_inflight`, `hope_vllm_queue_depth`, `hope_vllm_rejections_total{reason=429|503}`,
    `hope_vllm_engine_loads_total{result}`, `hope_vllm_engine_evictions_total`,
    `hope_vllm_resident_gib`, `hope_vllm_vram_budget_gib`;
  - upstream `vllm:*` engine metrics relabelled with `model` and `pool`;
  - the existing `model_resident_bytes` / `model_load_seconds` names, so the `model-residency` dashboard
    and `ModelThrash` / headroom alerts cover vLLM unchanged.
- **Alerts** (replacing `VLLMDown`): `VllmPoolDown` (gated on replicas > 0), `VllmAdmissionRejected`,
  `VllmSaturated`, `VllmEngineLoadFailing`, `VllmKvCacheFull` (`vllm:gpu_cache_usage_perc`), per-kind
  latency SLO; each with a promtool test.
- **Dashboard** `base/dashboards/vllm.json` (`uid: hope-vllm`) — pools, resident engines vs budget,
  throughput, TTFT/ITL, ASR RTF, TTS first-audio, rejections, loads/evictions; `$__rate_interval`, units,
  descriptions, no tenant labels.
- **Logs** — Alloy automatic. vLLM request logging forced off (prompts, transcripts and speech text are
  PHI); `hope_obs` redaction applies.
- **Traces** — `hope_obs` OTLP; `traceparent` propagated by `stt` / `text` / `tts`, so one trace spans
  gateway → caller → `vllm`.

### 3.7 `hope-v2` build, CI, local dev

- Real `build-vllm` job from `apps/vllm/Dockerfile` (replaces hidden `.build-vllm`); `.github/services.json`
  entry; promote lists; Trivy; build-info. `infrastructure/docker/vllm/` deleted.
- Compose `inference` profile builds `apps/vllm` (NVIDIA hosts only). macOS dev = unit tests against a
  fake engine (vLLM needs CUDA).
- Renames: `package.json` `asr-vllm:*` → `vllm:*`, `scripts/dev-service.sh`, `turbo.json#globalEnv`
  (`ASR_VLLM_*` → `VLLM_*`), `scripts/env-sync.mts`, `scripts/python-env-surface.py`,
  `scripts/env-consumer-inventory.py`, generated env surfaces, root `.env.sample`, contract tests
  (`dockerfile-build-info`, `test_observability_parity`, `test_health_contract_parity`).

### 3.8 Error handling summary

| Condition | Where | Result |
|---|---|---|
| Missing/invalid token | shell | 401 |
| Missing `X-Tenant-Id` on `/v1/*` | shell | 400 |
| Unknown slug / not `servedBy: vllm` / not visible to tenant / wrong kind for route or pool | gateway + shell | 404 `model_not_found` (OpenAI shape) |
| Non-SAFETENSOR, or quantization unsupported on this device | gateway / shell | 409 / 503 `QUANTIZATION_UNSUPPORTED` |
| VRAM budget exhausted, nothing evictable | shell | 503 + `Retry-After` |
| Engine in-flight cap reached | shell | 429 + `Retry-After` |
| `localPath` missing from the mount while `HF_HUB_OFFLINE=1` (cluster) | shell | 503 `MODEL_NOT_PUBLISHED` |
| Engine load failure | shell | 503, `hope_vllm_engine_loads_total{result="error"}`, alert |
| 429/503 at a caller | `stt` / `text` / `tts` | bounded backoff honouring `Retry-After`, then the caller's own fallback chain; `tts` only before the first byte |

---

## 4. Implementation Plan — Phase 1: Whisper ASR on `vllm`

> **For agentic workers:** execute lane by lane with `superpowers:subagent-driven-development`.
> Each lane runs in its OWN worktree (`.claude/rules/14-multi-agent-worktrees.md`) and owns ONLY
> the files listed under it. Steps use `- [ ]` checkboxes. Per the owner rule, a lane runs only its
> own RED→GREEN tests; the full gate pass happens once, after every lane is merged (L5).

**Goal:** `stt` decodes Whisper windows on a GPU-pooled `vllm` service over the OpenAI
`/v1/audio/transcriptions` wire, with the model loaded from the s3fs mount and the service fully
deployed and observable on dev.

**Architecture:** `apps/asr-vllm` becomes `apps/vllm`. The shell keeps its tested engine, pool and
source resolver. It swaps the "spec in the body" contract for OpenAI multipart plus `model=<slug>`,
resolving the slug through a new gateway route. `stt` gains a `vllm` engine (a self-hosted REST
client) selected by `libraryName: 'vllm'`. `hope-v2-deployment` gets a pool template, the
`hope-vllm-asr` Service and the observability wiring.

**Tech stack:** vLLM 0.30.0 (`AsyncLLM`, pinned image), FastAPI, httpx, NestJS 11, Prisma seed,
Kustomize, Prometheus/promtool, Grafana.

**Spec:** §1–§3 of this README. §4.0 records where Phase 1 narrows or amends it.

### 4.0 Phase-1 scope and decisions taken (owner 2026-09-29: "focus on vLLM handling Whisper for ASR; the rest later"; orchestrator authorised to align)

| # | Decision | Why |
|---|---|---|
| D-7 | **Phase 1 = ASR only.** LLM and TTS engines, the `text`/`tts` providers, vLLM-Omni, OmniVoice, retirement of the `hope-vllm` text-gen tier (`base/vllm.yaml`, `infrastructure/docker/vllm`, hidden `.build-vllm`), and the `hope-vllm-llm`/`hope-vllm-tts` Services are all **Phase 2+**. OD-1, OD-2, OD-3 and OD-6 are deferred with them. | Owner scope. |
| D-8 | **The ASR route is a thin HOPE implementation of the OpenAI transcription schema over the spike's own engine, not upstream's handler.** This amends §3.1 for ASR. Chat and speech still delegate to upstream in Phase 2. | vLLM 0.30.0's transcription prompt prefixes previous text with `<|prev|>`, which is not a Whisper token, and `SamplingParams.max_tokens` defaults to 16. The spike's `build_decoder_prompt` / `resolve_max_tokens` already fix both, with tests. The OpenAI transcription schema is small (multipart, five fields). |
| D-9 | **The truncation heuristic stays in the shell**, returned as the extension object `x_hope.truncation` in `verbose_json` and as a metric. This amends §3.4. | `finish_reason == "length"` is only visible server-side. The flag is informational, and `stt` logs it. |
| D-10 | **Auth header is `X-Service-Token`** (house peer pattern, the value of `INTERNAL_ACCESS_TOKEN`). The shell also accepts `Authorization: Bearer` for stock OpenAI clients. | `stt` already holds `internal_access_token` (`apps/stt/src/stt/core/config/settings.py:189`). |
| D-11 | **Engine facts move from settings to the model row.** New `AiModel._metadata.serving = { vramGiB, maxNumSeqs?, enforceEager? }`. The `asrVllm.engine.*` settings are deleted; `quantization` / `maxModelLen` stay in `_metadata.asr` (TASK-1010 OD-8). A row with no `vramGiB` is refused (409 `SERVING_FACTS_MISSING`). | Spec §3.2/§3.3 (GiB not fractions). Fails closed because it sizes a GPU. |
| D-12 | **OD-4:** the dev `asr` pool takes 1 of the 2 free time-sliced units. **OD-5:** fp8 is refused below sm_89 (existing `vllm_quantization`). **OD-7:** no HPA. | Defaults adopted. |
| D-13 | **Model identity is the `AiModel` row.** `runtimeKey = "<aiModel.id>:<checksum ?? version>"`, replacing the agent-version key. The existing row `arcaai-whisper-large-ml-en-vllm` becomes `provider: 'vllm'`, `libraryName: 'vllm'`, `servedBy: 'vllm'`. | `provider: 'vllm'` is already an `ENGINE_SERVED_PROVIDER`, so its usability follows the SYSTEM `stt/vllm` connection. |

### 4.1 Frozen contracts (every lane codes against these — do not change them without the orchestrator)

**C-1 · `ResolvedServingSpec`.** Wire form is camelCase. Source of truth is
`packages/types/src/serving-spec.ts`; the fixture `tests/contracts/resolved-serving-spec.fixture.json`
is committed by L1, and L2's pydantic mirror parses it.

```ts
export type ServingKind = 'asr' | 'llm' | 'tts';
export interface ResolvedServingSpec {
  slug: string;
  kind: ServingKind;                 // SPEECH_TO_TEXT→asr, TEXT_GENERATION→llm, TEXT_TO_SPEECH→tts
  runtimeKey: string;                // `${aiModel.id}:${checksum ?? `v${version}`}`
  tenantId: string;                  // OWNER of the row (SYSTEM or the tenant)
  localPath: string | null;          // deriveLocalPath(bucketPrefix, primaryObject)
  sourceUri: string;
  sourceRevision: string | null;
  checksum: string | null;
  format: 'SAFETENSOR';
  computeType: 'float16' | 'bfloat16' | 'float32' | null;
  quantization: 'none' | 'fp8' | 'awq' | 'gptq' | 'int8' | null;
  maxModelLen: number | null;
  engine: { vramGiB: number; maxNumSeqs: number | null; enforceEager: boolean | null };
}
```

Fixture (exact content):

```json
{
  "slug": "arcaai-whisper-large-ml-en-vllm",
  "kind": "asr",
  "runtimeKey": "00000000-0000-0000-0001-000000000026:v1",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "localPath": "/mnt/models-bucket/hf/hub/models--arcaai--whisper-large-ml-en/snapshots/0000000000000000000000000000000000000000",
  "sourceUri": "hf:arcaai/whisper-large-ml-en",
  "sourceRevision": null,
  "checksum": null,
  "format": "SAFETENSOR",
  "computeType": "float16",
  "quantization": null,
  "maxModelLen": null,
  "engine": { "vramGiB": 5, "maxNumSeqs": 64, "enforceEager": null }
}
```

**C-2 · Gateway route** `GET /api/v1/internal/models/:slug/serving-spec`.
- Guard: `InternalServiceTokenGuard`, whose map entry is renamed `'asr-vllm'` → `'vllm'`.
- Header `X-Tenant-Id` is required; a missing header is 400.
- Responses:
  - 200: `ResolvedServingSpec`.
  - 404 `{ code: 'MODEL_NOT_FOUND' }`: the slug is not visible to the tenant (tenant row first, then SYSTEM, never another customer), or the row's `servedBy !== 'vllm'`.
  - 409 `{ code: 'MODEL_NOT_SERVABLE', reason }`, with `reason` one of `FORMAT_UNSUPPORTED`, `SERVING_FACTS_MISSING`, `DISABLED`.
- It is excluded from the public docs with `@ApiExcludeEndpoint()`, like the other internal routes, and it still goes through the route manifest.

**C-3 · Shell HTTP** (`apps/vllm`, port 8867).
- `POST /v1/audio/transcriptions`, multipart. Fields:
  - `file`: WAV, PCM16, mono, any rate (resampled to 16 kHz), ≤ 30 s.
  - `model`: slug, required.
  - `language`: ISO-639-1, required. This deviates from OpenAI because Whisper-on-vLLM needs the language token.
  - `prompt`: optional.
  - `temperature`: default 0.
  - `response_format`: `json` | `text` | `verbose_json`, default `json`.
- Headers: `X-Service-Token` (or `Authorization: Bearer`), and `X-Tenant-Id` (required).
- `json` response: `{"text": "..."}`.
- `text` response: the plain transcript.
- `verbose_json` response:
  ```json
  {"task":"transcribe","language":"ml","duration":12.48,"text":"...","segments":[],
   "x_hope":{"finish_reason":"stop","decode_ms":812.4,"engine_queue_ms":3.1,
             "truncation":{"suspected":false,"reason":null,"voiced_seconds":9.7,"chars":142}}}
  ```
- Errors use the OpenAI shape `{"error":{"message":str,"type":str,"param":str|null,"code":str}}`:
  - 400 `invalid_request_error` / `audio_too_long` | `unsupported_audio` | `language_required`
  - 401 `authentication_error`
  - 404 `invalid_request_error` / `model_not_found`
  - 409 `invalid_request_error` / `model_not_servable`
  - 429 `rate_limit_error` / `engine_saturated`, with `Retry-After`
  - 503 `server_error` / `engine_capacity` | `engine_load_failed` | `<EngineBuildRefused.code>` | `MODEL_NOT_PUBLISHED`, with `Retry-After` on capacity errors
- `GET /v1/models`: `{"object":"list","data":[{"id":slug,"object":"model","owned_by":"hope","x_hope":{"kind":"asr","resident":true,"pinned":bool}}]}`, listing resident and pinned models.
- Kept from the spike: `GET /api/v1/health`, `/api/v1/health/{live,ready,startup}`, `/metrics`, `POST /api/v1/engines/warm` (body now `{"model": slug}`), and `GET /api/v1/engines` (the pool snapshot).

**C-4 · Settings.**
- `vllm.descriptors.ts` replaces `asr-vllm.descriptors.ts`, with `consumedBy: ['vllm']` and `failMode: 'open-to-default'`. It declares:
  - `vllm.pools` (JSON). Default `{"default":{"acceptedKinds":["asr"],"pins":[],"vramBudgetGiB":6,"maxResidentEngines":1,"inflightFactor":2},"asr":{…same…}}` — the `asr` entry was added by the final-review fix round (F1) because the dev overlay runs `VLLM_POOL=asr`; both sides are pinned to `tests/contracts/vllm-default-pools.fixture.json`. Each pool: `acceptedKinds` ⊆ `asr|llm|tts`; `pins` = array of slugs; `vramBudgetGiB` > 0; `maxResidentEngines` ≥ 1; `inflightFactor` ≥ 1 (optional, default 2). Validator pattern: `metering-compute.descriptors.ts:104`.
  - `vllm.truncation.minCharsPerVoicedSecond` and `vllm.truncation.voicedDbfs`: same defaults as the `asrVllm.*` keys they replace.
- Pool identity: env `VLLM_POOL` (default `default`), declared in `turbo.json#globalEnv`.

**C-5 · `stt` wire to vLLM.**
- `ModelCache` library key: `vllm`.
- `stt`-side pseudo-format `AiModelFormat.VLLM = "vllm"`. It is set by the loader on `LoadedModel.format`, is never a Prisma value, and follows the SARVAM/OPENAI superset precedent (`pipeline/dto.py:56`).
- Engine name `vllm`.
- Override entry `provider_overrides["vllm"]` (or `vllm:<slug>` for a sibling) = `{ base_url, max_concurrent?, timeout_s?, connection_id, connection_slug, funding }`.
- No API key: the loader's posture is `CredentialPosture.SELF_HOSTED`, and it authenticates with `internal_access_token`.

### 4.2 Lane map

| Lane | Owns (nobody else edits these) | Tier | Depends on |
|---|---|---|---|
| **L1 Contracts** | `packages/types/src/serving-spec.ts` (+ barrel), `tests/contracts/resolved-serving-spec.fixture.json`, `packages/applications/src/services/ai-model/serving-spec/**` (new), `packages/applications/src/services/ai-model/constants.ts`, `packages/applications/src/services/ai-provider-connection/constants.ts`, `packages/applications/src/services/stt/agent-resolver/asr-agent-resolver.service.ts`, `packages/applications/src/services/settings-registry/{descriptors/vllm.descriptors.ts,descriptors/asr-vllm.descriptors.ts (deleted),registry.ts,registry.types.ts}`, `apps/api/src/modules/internal/{internal-service-token.guard.ts,model-serving-internal.controller.ts (new),internal.module.ts}`, `packages/database/src/prisma/db_main/seed/{ai-models/audio.ts,ai-models/shared.ts,17-ai-provider-connection.ts,25-agents.ts}`, `apps/admin-console/src/**/model-meta.ts`, the five generated API artifacts | opus | — |
| **L2 `apps/vllm`** | `apps/vllm/**` (git mv from `apps/asr-vllm`), root `package.json` scripts, `turbo.json`, `scripts/dev-service.sh`, `scripts/env-sync.mts`, `scripts/python-env-surface.py`, `scripts/env-consumer-inventory.py`, `scripts/generated/**`, `env-surface.generated.md`, root `.env.sample`, `tests/contracts/{dockerfile-build-info.test.ts,test_observability_parity.py,test_health_contract_parity.py}` | opus | C-1, C-3, C-4 (frozen) |
| **L3 `stt` engine** | `apps/stt/src/stt/models/vllm_loader.py` (new), `apps/stt/src/stt/streaming/vllm_asr.py` (new), `apps/stt/src/stt/models/cache.py`, `apps/stt/src/stt/pipeline/dto.py`, `apps/stt/src/stt/processors/{asr_engines.py,asr_capabilities.py}`, `apps/stt/src/stt/streaming/session_manager.py` (one method), `apps/stt/src/stt/transcription/batch_service.py` (one method), `apps/stt/tests/unit/test_task1021_*.py` | opus | C-3, C-5 |
| **L4 Deploy + CI** | whole `hope-v2-deployment` change set; in `hope-v2`: `.gitlab/ci/build.yml`, `.github/services.json`, `.gitlab/ci/promote.sh` service list | sonnet | C-3 (paths/ports), C-4 (`VLLM_POOL`) |
| **L5 Orchestrator** | merges, gates, docs (`.claude/rules/09-infrastructure-devops.md` + `.cursor` twin, `docs/operations/inference/README.md`, TASK-1010 README), model publish check, cluster rollout, proof | — | L1–L4 |

L1–L4 start in parallel, because the contracts are frozen above. Worktrees branch from `dev-2.2`
**after TASK-1019 is merged** (it rewrites the same `AiModel` catalogue). If TASK-1019 is still open,
L1 rebases onto it before its merge. Worktree hygiene: symlink the primary's `node_modules` in; never
run `pnpm install` inside `.claude/worktrees/*` (memory note on primary corruption). Python lanes use
`~/miniconda3/envs/arcaenv/bin/python -m pytest`, because `conda run` is broken in the sandbox.

---

### L1 — Contracts (gateway, types, catalogue, settings)

Read first: `.claude/rules/{02,03,04,05}-*.md`.

**Task L1.1 — `ResolvedServingSpec` type + fixture**

Files: create `packages/types/src/serving-spec.ts`; export it from `packages/types/src/index.ts`;
create `tests/contracts/resolved-serving-spec.fixture.json` (the exact C-1 content); create
`packages/types/src/__tests__/serving-spec.fixture.test.ts`.

- [ ] Write the failing test:
  ```ts
  import fixture from '../../../../tests/contracts/resolved-serving-spec.fixture.json';
  import { isResolvedServingSpec } from '../serving-spec';
  it('the committed fixture is a valid ResolvedServingSpec', () => {
    expect(isResolvedServingSpec(fixture)).toBe(true);
  });
  it('rejects a spec without engine.vramGiB', () => {
    expect(isResolvedServingSpec({ ...fixture, engine: { maxNumSeqs: 1, enforceEager: null } })).toBe(false);
  });
  ```
- [ ] RED: `pnpm --filter @arcaai/types test -- serving-spec` fails (module missing).
- [ ] Implement the C-1 interface, plus a structural guard `isResolvedServingSpec(x: unknown): x is ResolvedServingSpec` that checks every key and its type.
- [ ] GREEN: the same command passes. Commit `feat(task-1021): ResolvedServingSpec contract + fixture`.

**Task L1.2 — serving-spec builder (pure function)**

Files: create `packages/applications/src/services/ai-model/serving-spec/build-resolved-serving-spec.ts`
and `__tests__/build-resolved-serving-spec.test.ts`.

Interface:
```ts
export type ServingSpecRefusal = 'FORMAT_UNSUPPORTED' | 'SERVING_FACTS_MISSING' | 'DISABLED';
export function buildResolvedServingSpec(row: AiModelEntity):
  { ok: true; spec: ResolvedServingSpec } | { ok: false; reason: ServingSpecRefusal };
```

Rules:
- `kind` comes from `taskType` (SPEECH_TO_TEXT → asr, TEXT_GENERATION → llm, TEXT_TO_SPEECH → tts).
- `format !== 'SAFETENSOR'` → `FORMAT_UNSUPPORTED`.
- `_metadata.serving.vramGiB` must be a number > 0, else `SERVING_FACTS_MISSING`.
- `resourceStatus !== 'ENABLED'` → `DISABLED`.
- `localPath` = `deriveLocalPath(bucketPrefix, primaryObject)`, or `null` when there is no `bucketPrefix`.
- `quantization` / `maxModelLen` come from `_metadata.asr`.
- `runtimeKey` = `` `${id}:${checksum ?? `v${version}`}` ``.

- [ ] Write the failing tests, one per rule. Build the whisper row as in the fixture and assert `toEqual(fixture)`; add one test each for FORMAT_UNSUPPORTED (a `WHISPER_CPP` row), SERVING_FACTS_MISSING (no `_metadata.serving`), and DISABLED.
- [ ] RED → implement → GREEN (`pnpm --filter @arcaai/applications test -- build-resolved-serving-spec`). Commit.

**Task L1.3 — `ModelServingSpecService` + internal controller**

Files:
- Create `packages/applications/src/services/ai-model/serving-spec/{IModelServingSpecService.ts,model-serving-spec.service.ts,model-serving-spec.service.module.ts,index.ts,__tests__/model-serving-spec.service.test.ts}`.
- Create `apps/api/src/modules/internal/model-serving-internal.controller.ts` and `__tests__/model-serving-internal.controller.test.ts`.
- Modify `internal.module.ts`, and in `internal-service-token.guard.ts:54` rename `'asr-vllm'` to `'vllm'`.

Behaviour:
- `resolve(slug, tenantId)` first reads the tenant's own row by `(tenantId, slug)`. Only when that is absent does it read the SYSTEM row, using the `AiModelRepository` methods the catalogue already uses. It never reads a third tenant's row.
- `servedBy !== 'vllm'` → `NotFoundException({ code: 'MODEL_NOT_FOUND' })`.
- A builder refusal → `ConflictException({ code: 'MODEL_NOT_SERVABLE', reason })`.
- It emits `ResourceViewed` only through the existing read pattern (no audit write).
- The controller is `@Get('internal/models/:slug/serving-spec')` with `@ApiExcludeEndpoint()` (comment: internal decode-tier route). It reads `X-Tenant-Id` and returns 400 when the header is missing.

- [ ] Failing tests:
  - a tenant row wins over SYSTEM;
  - SYSTEM serves when the tenant has none;
  - tenant B asking for tenant A's slug → 404;
  - a `servedBy: 'stt'` row → 404;
  - a missing `vramGiB` → 409 with `SERVING_FACTS_MISSING`;
  - the controller without `X-Tenant-Id` → 400.
- [ ] RED → implement → GREEN (`pnpm --filter @arcaai/applications test -- model-serving-spec` and `pnpm test:unit -- model-serving-internal`). Commit.

**Task L1.4 — catalogue, connections, resolver gate**

Files: `ai-model/constants.ts` (in `AI_MODEL_SERVED_BY`, rename `'asr-vllm'` to `'vllm'`),
`ai-provider-connection/constants.ts` (`PLATFORM_SELF_HOST_PROVIDERS.stt = ['vllm']`),
`stt/agent-resolver/asr-agent-resolver.service.ts:398`.

- Change the gate to `isCloudByoProvider('stt', provider) || isPlatformSelfHostProvider('stt', provider)`. The helper at `constants.ts:161` is exported, or exported now if it isn't.
- Make sure the entry the credential plane returns for a self-host row carries `base_url` and `max_concurrent`. Add `max_concurrent` to the override builder if it is absent; `AiProviderConnection.maxConcurrent` already exists.

- [ ] Failing test in `stt/agent-resolver/__tests__/asr-agent-resolver.task1021.test.ts`: an agent whose primary model has `provider: 'vllm'` gets `providerOverrides.vllm = { base_url: 'http://hope-vllm-asr:8867/v1', max_concurrent: 32, … }`, and the spec itself stays credential-free.
- [ ] RED → implement → GREEN. Commit.

**Task L1.5 — settings descriptors (C-4)**

- Replace `descriptors/asr-vllm.descriptors.ts` with `descriptors/vllm.descriptors.ts`.
- Update `registry.ts` (the import at `:13` and the registration at `:299`) and `registry.types.ts:52` (`CONSUMING_DEPLOYABLES`: `'asr-vllm'` → `'vllm'`).
- Rename the test `asr-vllm.descriptors.task1010.test.ts` → `vllm.descriptors.task1021.test.ts`.
- [ ] Failing tests:
  - the default `vllm.pools` passes the validator;
  - `vramBudgetGiB: 0` is rejected;
  - `acceptedKinds: ['video']` is rejected;
  - the `asrVllm.*` keys are absent from `HOPE_SETTINGS_REGISTRY`.
- [ ] RED → implement → GREEN. Commit.

**Task L1.6 — seed**

- `seed/ai-models/audio.ts:345-376`: row `…0026` gets `provider: 'vllm'`, `libraryName: 'vllm'`, `servedBy: 'vllm'` and `metaData.serving = { vramGiB: 5, maxNumSeqs: 64 }`.
- `seed/ai-models/shared.ts:162`: servedBy union.
- `seed/17-ai-provider-connection.ts`: add the SYSTEM row `stt/vllm`, default for its provider:
  - `baseUrl`: `process.env.SEED_VLLM_ASR_BASE_URL ?? 'http://hope-vllm-asr:8867/v1'`, following the `lmStudioBaseUrl()` pattern at `:67`;
  - `maxConcurrent: 32`;
  - the self-host placeholder key;
  - `enabled: true`.
- `seed/25-agents.ts:861-895`: rename the agent `realtime-transcription-vllm-spike` → `realtime-transcription-vllm`. It stays playground-only.
- Admin console `model-meta.ts:150`: `SERVED_BY_OPTIONS` gets `vllm`.
- Declare `SEED_VLLM_ASR_BASE_URL` in `turbo.json#globalEnv`. This one `turbo.json` line belongs to L1; L2 must rebase over it.

- [ ] Update the existing seed tests: `aiModel.asr-profile.serving-facts.task1010.test.ts` → `…task1021.test.ts`. It asserts the row's `serving.vramGiB` and `libraryName`.
- [ ] Run `pnpm --filter @arcaai/database test` and `pnpm --filter @arcaai/applications test -- task1021`. Commit.

**Task L1.7 — the five API artifacts**

- [ ] `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`, then `pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check`. Commit the regenerated files as `chore(task-1021): regenerate API artifacts`.

---

### L2 — `apps/vllm` (the shell)

Read first: `.claude/rules/06-python-services.md`, `.claude/rules/14-multi-agent-worktrees.md` §4
(Python provenance guard). Run tests as
`~/miniconda3/envs/arcaenv/bin/python -m pytest apps/vllm/src/hope_vllm/tests -q`.

**Task L2.1 — rename, with no behaviour change**

- [ ] `git mv apps/asr-vllm apps/vllm`, then `git mv apps/vllm/src/asr_vllm apps/vllm/src/hope_vllm`.
- [ ] Rewrite imports `asr_vllm` → `hope_vllm`. Change the pyproject name to `hope-vllm`, the settings `env_prefix` to `VLLM_`, the log event prefix `asr_vllm.` → `vllm.`, the metric prefix `asr_vllm_` → `hope_vllm_`, and `effective-config?service=vllm`.
- [ ] Update the conftest guard path (`assert_source_tree`), the Dockerfile (paths, `COPY`, `--factory hope_vllm.main:create_app`, build-info `service=vllm`) and `.env.sample`.
- [ ] Repo plumbing:
  - `package.json` `asr-vllm:*` → `vllm:*`;
  - `turbo.json` `ASR_VLLM_*` → `VLLM_*`, plus `VLLM_POOL`;
  - the `scripts/dev-service.sh` case;
  - `scripts/{env-sync.mts,python-env-surface.py,env-consumer-inventory.py}`;
  - regenerate `scripts/generated/python-env-surface.json`, `env-surface.generated.md` and the root `.env.sample` with `pnpm env:sync`;
  - the three contract tests listed under L2.
- [ ] GREEN: the whole existing suite passes unchanged, plus `pnpm vitest run tests/contracts/dockerfile-build-info.test.ts` and `~/miniconda3/envs/arcaenv/bin/python -m pytest tests/contracts/test_observability_parity.py tests/contracts/test_health_contract_parity.py -q`. Commit `refactor(task-1021): rename apps/asr-vllm to apps/vllm`.

**Task L2.2 — `ResolvedServingSpec` mirror + gateway resolver**

Files: replace `src/hope_vllm/spec.py` with the C-1 pydantic mirror (`extra='forbid'`, frozen,
camelCase aliases). `to_camel('vram_gib')` yields `vramGib`, so declare `vram_gib: float = Field(alias='vramGiB', gt=0)` explicitly; the fixture test catches a miss. Create `src/hope_vllm/core/serving_spec_client.py`:

```python
class ServingSpecClient:
    """slug → ResolvedServingSpec through GET {gateway}/internal/models/{slug}/serving-spec.
    Cache key (tenant_id, slug); positive TTL 60 s, negative TTL 10 s; single-flight per key."""
    async def resolve(self, slug: str, tenant_id: str) -> ResolvedServingSpec: ...
class ModelNotFound(Exception): ...
class ModelNotServable(Exception):
    def __init__(self, reason: str) -> None: ...
```

Base it on `core/effective_config.py`'s httpx client, TTL and single-flight. It sends `X-Service-Token`
and `X-Tenant-Id`. 404 raises `ModelNotFound`; 409 raises `ModelNotServable(reason)`; any other
failure raises, and nothing is cached.

- [ ] Failing tests (respx):
  - the committed fixture parses (`tests/contracts/resolved-serving-spec.fixture.json`);
  - a second call within the TTL makes no second request;
  - tenants A and B asking for the same slug make two requests (the key includes the tenant);
  - 404 → `ModelNotFound` and is negatively cached for 10 s;
  - 500 → raises and is not cached;
  - concurrent first calls → one request.
- [ ] RED → implement → GREEN. Commit.

**Task L2.3 — pool: GiB admission, pins, kinds**

Files: `engine/pool.py`, `engine/vllm_backend.py`, `core/config.py`, `core/control_plane.py`,
`tests/unit/test_engine_pool.py`, `tests/unit/test_vllm_backend.py`.

- `EnginePool.__init__` gains `pool_config: Callable[[], PoolConfig]`, where `PoolConfig` is a frozen dataclass: `accepted_kinds: frozenset[str]`, `pins: tuple[str, ...]`, `vram_budget_gib: float`, `max_resident: int`. It comes from `vllm.pools[VLLM_POOL]`; a missing pool name means the process refuses to start (named error).
- Admission: `Σ resident.spec.engine.vram_gib + new ≤ vram_budget_gib` and `count ≤ max_resident`.
  - Otherwise evict the least-recently-used idle engine that is not pinned.
  - If none, `EngineCapacityError`.
  - A spec whose `vram_gib` exceeds the whole budget → `EngineBuildRefused("VRAM_BUDGET_EXCEEDED")`.
- Kind gating: `spec.kind not in accepted_kinds` → `ModelNotServable("KIND_NOT_ACCEPTED")` before any load.
- Pins: `EnginePool.warm_pins(resolve: Callable[[str], Awaitable[ResolvedServingSpec]])`, called in `lifespan`. It resolves pins against the SYSTEM tenant `00000000-0000-0000-0000-000000000000` and loads them. `pinned` is recorded per `runtimeKey`.
- Backend (`VllmEngineFactory._build_sync`):
  - `gpu_memory_utilization = round(spec.engine.vram_gib / device_total_gib(), 3)`, where `device_total_gib` is an injected callable. The default uses `pynvml` (`nvmlDeviceGetMemoryInfo(handle).total / 2**30`, device 0) and creates no CUDA context.
  - `max_num_seqs = spec.engine.max_num_seqs or 64`, and `enforce_eager = bool(spec.engine.enforce_eager)`.
  - Delete the `settings.gpu_memory_utilization`, `max_num_seqs` and `enforce_eager` fields.

- [ ] Failing tests (the existing `fakes.py` factory, fake clock):
  - two 3 GiB specs fit a 6 GiB budget and a third evicts the least-recently-used idle one;
  - a busy engine is never evicted (→ `EngineCapacityError`);
  - a pinned engine is never evicted;
  - a 7 GiB spec against a 6 GiB budget → `VRAM_BUDGET_EXCEEDED`;
  - an `llm` spec on an `asr`-only pool → `KIND_NOT_ACCEPTED`;
  - 5 GiB on a 16 GiB device → `gpu_memory_utilization == 0.312`;
  - `warm_pins` loads every pin, and `/health/startup` stays 503 until they are loaded.
- [ ] RED → implement → GREEN. Commit.

**Task L2.4 — the OpenAI routes (C-3)**

Files:
- Create `api/endpoints/openai_transcriptions.py`, `api/endpoints/openai_models.py` and `api/openai_errors.py`.
- Delete `api/endpoints/transcriptions.py` and its test.
- Modify `main.py` (mount under the root, not `/api/v1`) and `api/middleware/auth.py` (accept `Authorization: Bearer` as well as `X-Service-Token`; require `X-Tenant-Id` on `/v1/*`).
- Reuse `audio.py` (resampling to 16 kHz, voiced seconds), `truncation.py` and `engine/base.DecodeRequest`.

Handler outline:
```python
@router.post("/v1/audio/transcriptions")
async def create_transcription(request: Request, file: UploadFile, model: str = Form(...),
                               language: str | None = Form(None), prompt: str | None = Form(None),
                               temperature: float = Form(0.0),
                               response_format: Literal["json","text","verbose_json"] = Form("json")):
    tenant_id = request.state.tenant_id
    if not language: raise openai_error(400, "language_required", param="language")
    samples, duration = decode_wav(await file.read())          # 400 unsupported_audio
    if duration > MAX_WINDOW_SECONDS: raise openai_error(400, "audio_too_long", param="file")
    spec = await resolver.resolve(model, tenant_id)             # 404 / 409
    async with pool.lease(spec) as engine:                      # 429 / 503 + Retry-After
        result = await engine.transcribe(DecodeRequest(samples, language, prompt, temperature,
                                                       None, request_id=request.state.request_id))
    ...render json | text | verbose_json (with x_hope) ...
```

- The per-engine in-flight cap: a lease beyond `max_num_seqs × pool.inflightFactor` (C-4) gets 429 `engine_saturated` with `Retry-After: 1`.
- A stock OpenAI SDK must work: `openai.AsyncOpenAI(base_url=…/v1, api_key=<token>, default_headers={"X-Tenant-Id": …}).audio.transcriptions.create(model=…, file=…, language="ml")`.

- [ ] Failing tests (FastAPI `TestClient`, fake engine):
  - all three `response_format` bodies are byte-shape exact to C-3;
  - 31 s of audio → 400 `audio_too_long`;
  - a non-WAV body → 400 `unsupported_audio`;
  - no language → 400;
  - no token → 401;
  - bearer and `X-Service-Token` both accepted;
  - no `X-Tenant-Id` → 400;
  - `ModelNotFound` → 404 `model_not_found`;
  - capacity → 503 with `Retry-After`;
  - saturation → 429 with `Retry-After`;
  - `verbose_json.x_hope.truncation.suspected` is true when `finish_reason == "length"`;
  - `/v1/models` lists the resident engine;
  - a contract test with the real `openai` package (already in the test extra, or add it) against `TestClient` parses the response.
- [ ] RED → implement → GREEN. Commit.

**Task L2.5 — metrics, logging, drain, image**

- Metrics (`core/metrics.py`): `hope_vllm_requests_total{route,kind,model,status}`,
  `hope_vllm_request_seconds{route,kind}`, `hope_vllm_asr_rtf{model}`, `hope_vllm_inflight{model}`,
  `hope_vllm_queue_depth{model}`, `hope_vllm_rejections_total{reason}`,
  `hope_vllm_engine_loads_total{result}`, `hope_vllm_engine_evictions_total`,
  `hope_vllm_resident_gib`, `hope_vllm_vram_budget_gib`, plus `model_resident_bytes{service="vllm",model}`
  and `model_load_seconds{service="vllm",model}`. Use the exact names and labels the
  `model-residency` dashboard reads; copy them from `apps/stt/src/stt/residency/`.
- Re-export vLLM's `vllm:*` series: build `AsyncEngineArgs` with `disable_log_stats=False`, and serve vLLM's Prometheus registry from the same `/metrics`. vLLM 0.30 registers into the default `prometheus_client` registry; assert that in a GPU smoke test in L5.
- vLLM request logging stays off (`AsyncEngineArgs(disable_log_requests=True)` or the 0.30 equivalent). No transcript text is ever logged.
- Drain: on SIGTERM, `lifespan` sets `draining = True`. New `/v1/*` requests get 503 `server_error` / `draining`, `/health/ready` → 503, and in-flight leases finish before `pool.close()`.
- [ ] Failing tests:
  - after one request, `/metrics` contains each `hope_vllm_*` name;
  - no metric has a `tenant` label;
  - while draining, a new request → 503 and an in-flight one completes.
- [ ] RED → implement → GREEN. Commit.
- [ ] Update the Dockerfile to the renamed paths. It keeps the digest-pinned `vllm/vllm-openai:v0.30.0` base and adds `pynvml` if it is not already in the image. Run `docker build` only if a Linux builder is available; CI (L4) is the real build.

---

### L3 — `stt` `vllm` engine

Read first: `.claude/rules/06-python-services.md`. Tests:
`~/miniconda3/envs/arcaenv/bin/python -m pytest apps/stt/tests/unit -q -k task1021`.

**Task L3.1 — loader + pseudo-format**

Files: `pipeline/dto.py` (add `AiModelFormat.VLLM = "vllm"`, commented as an stt-side superset value
like SARVAM/OPENAI); create `models/vllm_loader.py`; `models/cache.py` (`_library_loaders["vllm"]`).

```python
@dataclass(frozen=True)
class VllmAsrConfig:
    base_url: str            # e.g. http://hope-vllm-asr:8867/v1
    model_slug: str          # the AiModel slug — sent as OpenAI `model`
    max_concurrent: int | None
    timeout_s: float         # override `timeout_s` or 30.0

class VllmLoader(BaseModelLoader):
    credential_posture = CredentialPosture.SELF_HOSTED
    override_key = None
    # load(): entry = resolve_override_key(provider_overrides, "vllm", connection_key=...)
    # missing entry or base_url → ModelLoadError("vllm connection not configured: enable the SYSTEM
    #   AiProviderConnection(stt, vllm) with its baseUrl") ; returns LoadedModel(format=AiModelFormat.VLLM,
    #   model=VllmAsrConfig(...)) — no weights, no cache residency.
```

Also add `AiModelFormat.VLLM` to the set of formats that bypass the shared model cache
(`session_manager.py:192-201`).

- [ ] Failing tests:
  - `loader_for` a spec with `library_name="vllm"` returns `VllmLoader`;
  - the override maps to `VllmAsrConfig` (with `max_concurrent`);
  - a missing entry raises a named `ModelLoadError`;
  - the BYOK lock test still passes (the loader is SELF_HOSTED with no override key).
- [ ] RED → implement → GREEN. Commit.

**Task L3.2 — REST client with backpressure**

Create `streaming/vllm_asr.py`:
```python
async def vllm_recognize_utterance(config: VllmAsrConfig, samples: np.ndarray, sample_rate: int, *,
                                   language: str, prompt: str | None, tenant_id: str,
                                   request_id: str | None, service_token: str) -> dict[str, Any]:
    """POST {base_url}/audio/transcriptions (multipart WAV, response_format=verbose_json).
    Returns {"text", "word_timestamps": [], "language", "truncation", "request_bytes",
    "response_bytes", "byte_source"} — same keys as openai_recognize_utterance plus "truncation"."""
```

- Headers: `X-Service-Token`, `X-Tenant-Id`, `X-Request-Id` (when set), and W3C `traceparent` through the `hope_obs` propagator.
- Per-process `asyncio.Semaphore` keyed by `base_url`, sized `max_concurrent` (unbounded when `None`).
- 429/503: up to 2 retries, sleeping `min(float(Retry-After or 0.5), 2.0)`, then raise `CloudASRQuotaError` (429) or `CloudASRTranscriptionError` (503) so `engine_switch` fails over.
- 4xx other than 429: raise `CloudASRTranscriptionError` immediately, with no retry.
- `x_hope.truncation.suspected` → log `stt.vllm.truncation_suspected` (slug, reason, voiced_seconds, chars — never the text).

- [ ] Failing tests (respx):
  - the multipart carries `model`, `language`, `response_format=verbose_json`, and `prompt` only when set;
  - all four headers are present;
  - 429 with `Retry-After: 0.1` then 200 → succeeds after one retry;
  - three 503s → `CloudASRTranscriptionError`;
  - a 400 is not retried;
  - with `max_concurrent=2`, a third concurrent call waits (assert peak in-flight == 2 using a gated respx side effect);
  - a suspected truncation is logged without the transcript.
- [ ] RED → implement → GREEN. Commit.

**Task L3.3 — engine adapter, streaming + batch**

- `processors/asr_engines.py`: `ASR_FORMAT_TO_NAME[AiModelFormat.VLLM] = "vllm"`, and a `class VllmEngine(AsrEngine)` whose `run_batch` → `service._run_vllm_inference(...)` and `make_streaming_callable` → `manager._make_vllm_callable(loaded_model, inference_config, initial_prompt=initial_prompt)`.
- `processors/asr_capabilities.py`: register `vllm` with its capability (streaming per utterance, batch, device `remote`), copying the `openai` entry's shape.
- `streaming/session_manager.py`: `_make_vllm_callable`, modelled on `_make_openai_callable` (`:3789`). It passes the session's tenant id, resolved language and `initial_prompt` (the agent's prompt; empty for the ml-en fine-tune, per TASK-994), and `internal_access_token`.
- `transcription/batch_service.py`: `_run_vllm_inference`.
  - Cut the audio with the SAME segmentation the whisper.cpp batch path uses (read `_run_whisper_cpp_inference` and reuse its segmenter; do not write a new one), capping every segment at 30 s.
  - Decode the segments concurrently with `asyncio.gather` under the client's semaphore.
  - Reassemble in order, with each segment's offset added to its timestamps.
- [ ] Failing tests:
  - `resolve_asr_engine(AiModelFormat.VLLM)` → `VllmEngine`;
  - the streaming callable forwards tenant and prompt;
  - a 70 s batch file becomes 3 segments of ≤ 30 s, decoded concurrently and reassembled in order;
  - a 503 on the primary makes the session fail over to the agent's fallback chain (existing `engine_switch` test pattern).
- [ ] RED → implement → GREEN. Commit.

---

### L4 — Deployment (`hope-v2-deployment`) + image CI (`hope-v2`)

Read first: `.claude/rules/09-infrastructure-devops.md`, the deployment repo's `README.md`, and
memory note `models-bucket-mount-green-probes.md`.
Verify every step with `kustomize build deployment/k8s/overlays/{dev,staging,prod,standalone}`.

**Task L4.1 — image job (`hope-v2`)**
- [ ] Add a real `build-vllm` job in `.gitlab/ci/build.yml` next to the other service builds. Context `.`, Dockerfile `apps/vllm/Dockerfile`, image `registry.taphuynh.dev/arca/hope-v2/vllm`, tags as in the house rules (no `latest`), build-info args, Trivy scan entry.
- [ ] Rename the hidden text-gen template's `SERVICE_NAME` to `vllm-textgen` so the two cannot collide. Its retirement is Phase 2.
- [ ] Add `vllm` to `.github/services.json` and to the promote list in `.gitlab/ci/promote.sh`.
- [ ] Verify with `mcp__gitlab__validate_ci_lint` on the merged YAML. Commit.

**Task L4.2 — pool template + Service**

- Create `deployment/k8s/vllm-pool/{kustomization.yaml,deployment.yaml,pdb.yaml,networkpolicy.yaml}`.
- Deployment `hope-vllm`, which the overlay suffixes:
  - pod labels `app: hope-vllm` and `vllm.hope/serves-asr: "false"`; the overlay patches the label to `"true"`.
  - annotations `prometheus.io/{scrape: "true", port: "8867", path: /metrics}`.
  - `runtimeClassName: nvidia`, `terminationGracePeriodSeconds: 600`, pod `securityContext` uid/gid/fsGroup **10001**.
- Native s3fs sidecar copied verbatim from `base/stt.yaml:77-192` with `-o uid=10001 -o gid=10001 -o umask=0022`. Every comment stays ABOVE `exec s3fs`. Also `await-models-bucket`.
- App container:
  - image `hope-v2/vllm` (pinned by overlay digest), port 8867;
  - env `VLLM_POOL` (patched), `VLLM_API_GATEWAY_URL=http://hope-api:8868/api/v1`, `HF_HOME=/mnt/models-bucket/hf`, `HF_HUB_OFFLINE=1`, `OTEL_SERVICE_NAME=hope-vllm`, `INTERNAL_ACCESS_TOKEN` from `hope-secrets`;
  - `envFrom: hope-platform-config`, `readOnlyRootFilesystem`, `/tmp` and `/dev/shm` (Memory, 2Gi) emptyDirs, the models mount `HostToContainer` read-only;
  - probes: startup `/api/v1/health/startup` (period 10, failureThreshold 60), readiness `/api/v1/health/ready`, liveness `/api/v1/health/live`;
  - `progressDeadlineSeconds: 900`, and strategy `maxSurge: 0` / `maxUnavailable: 1`.
- NetworkPolicy:
  - ingress on 8867 from `app in (hope-stt, hope-stt-worker, prometheus)`;
  - egress DNS 53, TCP 9000 (MinIO), 8868 (api) and 4317 (otel) as port-only rules. podSelector-only egress does not match on k3s (`base/stt.yaml:543-559`).
- PDB `minAvailable: 0`.
- `base/vllm-services.yaml`: Service `hope-vllm-asr` on 8867, selector `vllm.hope/serves-asr: "true"`. Add it to `base/kustomization.yaml`.
- `overlays/dev/vllm-asr/kustomization.yaml`: resources `../../../vllm-pool`, `nameSuffix: -asr`. Patches:
  - `VLLM_POOL=asr` and label `serves-asr: "true"`;
  - resources `nvidia.com/gpu: 1`, cpu 1/4, memory 6Gi/12Gi.
  - Reference it from `overlays/dev/kustomization.yaml`, and add the `images:` digest entry for `hope-v2/vllm`. CI `promote-dev` fills it.
- `overlays/orbstack`: delete-patch the pool (no GPU).
- Gates:
  - `scripts/check-envfrom-coverage.py`: `hope-vllm-asr` → `WORKLOAD_TO_SERVICE` as `vllm`;
  - `scripts/check-probes.py`: waiver for `("hope-vllm-asr","s3fs")` and `await-models-bucket` in `NOT_PROBEABLE_INIT_CONTAINERS`;
  - `scripts/check-capacity.py`: `GPU_ROLE["hope-vllm-asr"] = "asr"`;
  - EKS `gpu-nodegroup` patches cover `hope-vllm-asr`.
- [ ] Add CI job `s3fs-argv`: render dev, extract the sidecar script of every workload that has one, run it with a stub `s3fs` first on `PATH` that echoes argv, and assert `-o uid=` / `-o gid=` / `-o umask=0022` / `-o ro` are present.
- [ ] Reconcile `base/gpu-time-slicing.yaml` `replicas: 3` → `4`, commenting that it is hand-applied.
- [ ] Verify: `kustomize build` on every overlay, plus `scripts/check-*.py` locally. Commit.

**Task L4.3 — observability**

- `base/prometheus/platform.rules.yml`: replace `VLLMDown` / the serving-tier vllm term with a group `vllm_asr`. Rules:
  - `VllmPoolDown`: `up{service=~"hope-vllm-.*"} == 0` and `kube_deployment_spec_replicas{deployment=~"hope-vllm-.*"} > 0`, for 10m;
  - `VllmAdmissionRejected`: `increase(hope_vllm_rejections_total{reason="engine_capacity"}[10m]) > 0`;
  - `VllmSaturated`: `rate(hope_vllm_rejections_total{reason="engine_saturated"}[5m]) > 0.1`, for 10m;
  - `VllmEngineLoadFailing`: `increase(hope_vllm_engine_loads_total{result="error"}[15m]) > 0`;
  - `VllmKvCacheFull`: `max by (pod, model) (vllm:gpu_cache_usage_perc) > 0.95`, for 5m;
  - `VllmAsrSlow`: `histogram_quantile(0.99, sum by (le) (rate(hope_vllm_request_seconds_bucket{kind="asr"}[5m]))) > 15`, for 10m.
- Keep the text-gen `VLLMDown` untouched only if it still targets `hope-vllm` (it does; Phase 2 removes it).
- `alert-rules.test.yml`: one firing and one silent case per rule.
- `base/dashboards/vllm.json` (`uid: hope-vllm`). Panels:
  - requests by status;
  - p50/p95/p99 by kind;
  - ASR RTF;
  - in-flight and queue depth;
  - rejections by reason;
  - resident GiB against budget;
  - engine loads and evictions;
  - `vllm:gpu_cache_usage_perc`;
  - `vllm:num_requests_running` / `waiting`.
  Each panel has a unit and a description and uses `$__rate_interval`; no tenant labels. Register it in the `grafana-dashboards` generator.
- [ ] Verify: `promtool check rules` and `promtool test rules` (the CI image `prom/prometheus:v3.10.0`), and `scripts/check-dashboards.py`. Commit.

---

### L5 — Orchestrator: merge, gates, rollout, proof

- [ ] Merge L1 → L2 → L3 into `dev-2.2` (after TASK-1019), resolving `turbo.json` by union. Merge L4's `hope-v2` part too, then the deployment repo branch into its `main`.
- [ ] Run one full gate pass, pasting output:
  - `pnpm --filter @arcaai/types test`
  - `pnpm --filter @arcaai/applications build test`
  - `pnpm api:build && pnpm test:unit`
  - `pnpm api:openapi:check && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin:check`
  - `pnpm vllm:test vllm:lint vllm:typecheck` (via the arcaenv binaries)
  - `stt` tests, lint and typecheck (same)
  - `pnpm env:sync` producing no diff
  - `pnpm lint`
  - `git grep -n -i "asr-vllm\|asr_vllm\|ASR_VLLM\|asrVllm"` returns only `docs/archive/**` and this README
- [ ] Docs: `.claude/rules/09-infrastructure-devops.md` + `.cursor` twin, `docs/operations/inference/README.md`, and TASK-1010's README (a Change History entry: superseded by TASK-1021).
- [ ] Check the model is on the mount. The layout is whatever the row's `bucketPrefix` names — FLAT
  (`<slug>/<version>/`, what a re-publish writes now that `libraryName` is `vllm`, which is not an
  HF-cache library) or HF-cache (`hf/hub/models--<org>--<repo>/snapshots/<sha>`, what an older publish
  left). Read the row first (`GET admin/ai-models/<id>` → `bucketPrefix`), then
  `stat /mnt/models-bucket/<bucketPrefix>` (and `ls` it: `config.json` + `*.safetensors` must be there)
  from an existing s3fs pod (Rancher exec). `localPath` = `/mnt/models-bucket/<bucketPrefix>` with no
  trailing slash — a DIRECTORY, never `primaryObject`. If it is absent, publish it with the TASK-1019
  publisher before rollout.
- [ ] **Gates BEFORE flipping the dev replicas `0 → 1`** (`overlays/dev/vllm-asr` ships `replicas: 0`):
  - (a) **Write the config the pod needs through the admin API first**, platform admin, working tenant unset:
    - `PUT admin/settings/registry/vllm.pools` with `{"scope":"system","value":{…}}` — the map is applied
      WHOLE, so write every pool, and it MUST keep the `asr` entry (a map that drops the pod's own pool is
      refused by the pod and logged `vllm.control_plane.pool_missing_refused`):
      `{"default":{"acceptedKinds":["asr"],"pins":[],"vramBudgetGiB":6,"maxResidentEngines":1,"inflightFactor":2},"asr":{"acceptedKinds":["asr"],"pins":["arcaai-whisper-large-ml-en-vllm"],"vramBudgetGiB":6,"maxResidentEngines":1,"inflightFactor":2}}`.
    - `PATCH admin/ai-models/80000000-0000-0000-0001-000000000026` with `If-Match: "<_version>"` and
      `{"serving":{"vramGiB":5,"maxNumSeqs":64},"wireModelId":"arcaai-whisper-large-ml-en-vllm","expectedVersion":<_version>}`.
      Both fields in ONE write: the live row predates `_metadata.serving` (so the serving-spec route
      answers 409 `SERVING_FACTS_MISSING`) AND predates `wireModelId` — `vllm` is an ENGINE_SERVED
      provider, so a PATCH without `wireModelId` is refused 400 whatever else it carries.
    - Verify: `GET /api/v1/internal/models/arcaai-whisper-large-ml-en-vllm/serving-spec?service=vllm`
      with `X-Service-Token` + `X-Tenant-Id: 00000000-0000-0000-0000-000000000000` answers 200 with
      `engine.vramGiB: 5` (not 409).
  - (b) **The live dev agent keeps its OLD slug.** The agent seed is create-only by id, so a seeded
    database still has `realtime-transcription-vllm-spike`, not `realtime-transcription-vllm`. Proof
    step 4 (and the bench's `--agent`) uses whichever slug `GET admin/agents?task=SPEECH_TO_TEXT` shows
    in Global; renaming it is optional and is an admin edit, not a re-seed.
  - (c) **Vault must be up for any re-seed.** The SYSTEM `stt/vllm` connection gets its placeholder key
    only when Vault Transit is reachable at seed time; seeded without it the row is keyless, the
    credential fold drops it, and `stt` gets no `provider_overrides.vllm` (no `base_url`) — the session
    then fails over as if the engine were down. Check `GET admin/providers/stt` shows `vllm` enabled and
    keyed before the proof.
  - (d) **Clean up the stale `asrVllm.*` rows.** Any `GlobalSetting` written under the retired
    `asrVllm.*` keys (TASK-1010) is now an unknown key: nothing reads it and the registry routes 404 it.
    List `GET admin/settings/tenant/00000000-0000-0000-0000-000000000000`, and soft-delete each
    `asrVllm.*` row with `DELETE admin/settings/<id>`.
  - (e) **No Redis path for the vllm pod.** The pool Deployment sets no `REDIS_URL`, so the
    `app-settings:invalidate` push never reaches it: a `vllm.pools` / `vllm.truncation.*` edit lands
    on the next effective-config poll (60 s TTL). Wait a minute (or restart the pod) after an edit;
    do not read a stale answer inside that window as a failed write.
- [ ] Rollout: push `dev-2.2` → pipeline builds `vllm` → `promote-dev` pins the digest → Argo syncs
  (still `replicas: 0`). Run the (a)–(e) gates. Then flip `overlays/dev/vllm-asr` to `replicas: 1`
  in the deployment repo (Git, never `kubectl scale`).
- [ ] **GPU smoke** (from the `hope-stt` pod or a Rancher exec into `hope-vllm-asr`):
  - `curl -s :8867/api/v1/health/startup` → 200 once the pin is resident; `curl -s :8867/v1/models`
    lists the slug with `resident: true`.
  - `curl -s :8867/metrics | grep -E 'vllm:(kv_cache_usage_perc|num_requests_running)'` — both
    series present, labelled `model_name` (vLLM V1 names; the alert `VllmKvCacheFull` and the
    dashboard read exactly these). Absent means vLLM's registry is not served from the shell's
    `/metrics` and the upstream panels stay empty.
  - `curl -s :8867/metrics | grep hope_vllm_engine_loads_total` shows `result="loaded"`.
- [ ] Proof, pasted into §5:
  1. `/health/startup` goes green with the pin resident. `GET /v1/models` lists it.
  2. A stock `openai` SDK call from inside the `hope-stt` pod returns Malayalam text.
  3. The bench: `apps/vllm/scripts/bench_concurrency.py` at 25 concurrent streams, commit p99 ≤ 15 s (the TASK-1010 target). Record GPU memory with `nvidia-smi` from the GPU exporter.
  4. A live consultation in the admin playground on the vLLM ASR agent — `realtime-transcription-vllm` on a fresh seed, `realtime-transcription-vllm-spike` on the live dev DB (gate (b)) — with the transcript flowing.
  5. The Grafana `hope-vllm` dashboard populated, and one Tempo trace spanning gateway → stt → vllm.
  6. `kubectl logs` show no transcript text.
- [ ] Set status to Review and fill in §5. The worktrees are removed only after their merge commits exist.

### 4.3 Review focus (failure modes no single lane's happy path covers)

1. **The model is not on the mount.** A cluster pod has `HF_HUB_OFFLINE=1`, so a missing `localPath` must be a named 503 `MODEL_NOT_PUBLISHED`, never a hang or an HF call. Test: in L2.3, a `SourceResolver` with offline set and a missing directory → `EngineBuildRefused("MODEL_NOT_PUBLISHED")`.
2. **Mixed-tenant cache.** Tenant A's BYO model must never be served to tenant B under the same slug. Test: in L2.2, the same slug for two tenants resolves two different `runtimeKey`s and yields two engines.
3. **Engine load during live traffic.** The first request for an unpinned model must not stall `/health/live`. Test: in L2.3, a fake factory that blocks for 2 s still lets `/health/live` answer within 100 ms (the load runs in `asyncio.to_thread`).
4. **A client disconnects mid-decode.** Upstream `abort(request_id)` must fire and the lease must be released. Test: in L2.4, cancel the request task and assert the fake engine recorded the abort and `inflight == 0`.
5. **Time-slice co-tenancy on dev.** The `asr` pool's 6 GiB budget plus the `stt` and `stt-worker` pods on the same card must not run out of memory. Covered by L5 proof step 3 (`nvidia-smi` headroom) and the existing `GpuMemoryHeadroomLow` alert.

---

## 5. Implementation Summary

### 5.1 What shipped (Phase 1 — Whisper ASR), merged into local `dev-2.2`

| Lane | Branch / range | Delivered |
|---|---|---|
| L1 contracts | `task-1021/l1` `dd23901a9..2c7fb29ae` | `ResolvedServingSpec` (`packages/types/src/serving-spec.ts`) + fixture; `buildResolvedServingSpec`; `ModelServingSpecService`; internal route `GET /api/v1/internal/models/:slug/serving-spec?service=vllm` (service-token guard, tenant → SYSTEM, 404/409); `servedBy: 'vllm'`; `PLATFORM_SELF_HOST_PROVIDERS.stt = ['vllm']` with engine-served classification kept first; ASR resolver + batch credential pull deliver `provider_overrides.vllm`; `vllm.*` descriptors (pools, truncation) replace `asrVllm.*`; seed: model row `provider/libraryName/servedBy = vllm`, `_metadata.serving`, SYSTEM `stt/vllm` connection → `http://hope-vllm-asr:8867/v1`, agent renamed `realtime-transcription-vllm` |
| L2 shell | `task-1021/l2` `dd23901a9..63028f542` | `apps/asr-vllm` → `apps/vllm` (`hope_vllm`); OpenAI `POST /v1/audio/transcriptions` (json/text/verbose_json + `x_hope`) and `GET /v1/models`; plain-ASGI auth (`X-Service-Token` or Bearer, `X-Tenant-Id`); `ServingSpecClient` (tenant-keyed, bounded, single-flight); pool with GiB admission, victims released before the next build, pins by slug re-resolved per refresh, kind gating, in-flight cap → 429; `served_model_name = slug`; drain; `hope_vllm_*` + residency metrics |
| L3 stt | `task-1021/l3` `dd23901a9..620fbb8a3` | `VllmLoader` (SELF_HOSTED), stt-side `AiModelFormat.VLLM`, `VllmEngine`; REST client with per-base_url semaphore, retry only 429 / capacity-class 503; tenant threaded explicitly; batch windows ≤ 30 s via the whisper.cpp segmenter under `TaskGroup`; ml-en → language `ml` (live check pending) |
| L4 deploy + CI | hope-v2 `caeee6d98`; deployment `task-1021/vllm-asr` `ada789e..6a59eeb` | `build-vllm` job + services.json + promote list; `vllm-pool` Kustomize template (s3fs sidecar uid 10001, probes, port-only egress, `part-of` label), Service `hope-vllm-asr`, dev pool at **replicas 0**; alerts `VllmPoolDown/AdmissionRejected/Saturated/EngineLoadFailing/KvCacheFull/AsrSlow` with promtool tests; `vllm.json` dashboard; `s3fs-argv` CI gate; envfrom/probe/capacity gates |
| Final fix wave | `ef7eb8547..def414764` (+ deployment `480baf6..6a59eeb`) | `asr` in the default pools map; alert label `failed`; vLLM V1 metric names; model update DTO `serving` facts (platform-admin, If-Match unchanged); retry scope; placeholder-aware outbound token; HF_MODULES_CACHE / VLLM_NO_USAGE_STATS; L5 gates in this README |

Review trail: every lane passed a task review (spec + quality) after 1–2 fix rounds; a whole-branch cross-lane review found 5 Important issues, all fixed and re-reviewed "Ready to merge".

### 5.2 Gate pass after merge (2026-09-30, primary `dev-2.2` @ `8a8bcc9b9` + docs)

| Gate | Result |
|---|---|
| `@arcaai/types` test, `@arcaai/database` test | pass |
| `@arcaai/applications` build + test | pass |
| `api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check`, `env:sync --check` | pass (artifacts regenerated in `8a8bcc9b9`) |
| admin-console `model-meta` | pass |
| `apps/vllm` pytest / ruff / black / mypy (`--config-file apps/vllm/pyproject.toml`) | pass / clean / clean / "no issues in 31 files" |
| `apps/stt` unit pytest; ruff on changed files | pass; clean |
| `apps/stt` mypy | 4 errors, all pre-existing in files this ticket did not touch (`azure_continuous_asr`, `openai_realtime_asr`, `preprocessor`, `sarvam_realtime_asr`) |
| `apps/stt` black | 2 files (`session_manager.py`, `transcribe_file.py`) already unformatted at `5466ab56c` — pre-existing drift |
| Python contracts | pass |
| `pnpm lint` | pass |
| `pnpm test:unit` | 28,099 pass / 49 fail: 3 `env-sync.test.ts` failures reproduce on pre-merge `dev-2.2` `5466ab56c` (TASK-1019 bootstrap-floor keys); 46 logging-suite failures pass in isolation and as a directory (17 files / 405 tests) — full-run ordering flake in files this ticket did not touch |

### 5.3 Not done yet (needs owner go)

1. Push `dev-2.2` → CI builds `vllm`, `promote-dev` pins the digest.
2. Merge + push `hope-v2-deployment` `task-1021/vllm-asr` (pool ships at replicas 0).
3. L5 gates (a)–(g) and the GPU proof (§4 L5): admin writes (`vllm.pools.asr` pins; model row `serving` + `wireModelId`), flip replicas → 1, 25-stream bench, live consultation, dashboard, trace.

### 5.4 Follow-ups recorded

Phase 2 (LLM/TTS, text-gen `hope-vllm` retirement); `increase()` first-sample blind spot on two alerts; SBOM/sign jobs for `vllm`; `/v1/models` lists a tenant-disabled SYSTEM model; `vllm:*` series of an earlier engine vanish when a second starts; a vllm agent with `streaming_english_gloss` fails at gloss load; `WhisperCppAsrAdapter._split_spans` → staticmethod; httpx client per request in the stt vLLM client; `serving` PATCH cannot null optional fields; `.claude/rules/00-project-context.md` monorepo map lacks `apps/vllm`.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-30 | Owner go for rollout + the stt `CHANGE_ME` inbound-token fix (merged, `2d55df2d7`). Push HELD by owner: local `dev-2.2` is 271 commits ahead of `origin` (TASK-1009…1022 from other sessions; TASK-1021 depends on unpushed TASK-1010), and hope-v2-deployment local `main` holds 2 unpushed commits and is 19 behind `origin/main`. Resume L5 once origin carries TASK-1010…1020: pull deployment `origin/main`, merge `task-1021/vllm-asr` (expect conflicts on `gpu-time-slicing.yaml` ×4 and the `hope-gpu-process-exporter` envfrom classification — both already on origin), push; then push hope-v2. |
| 2026-09-30 | Phase 1 built in four parallel lanes (worktrees), each task-reviewed; cross-lane final review + one fix wave; merged into local `dev-2.2` (owner: "merge + gates, no push"); artifacts regenerated; gate pass recorded in §5.2; docs (rule 09, inference ops, overview, TASK-1010 superseded). |
| 2026-09-30 | Final whole-branch review fix round (F1–F8). F1 `vllm.pools` default declares `asr` on both sides (shared fixture). F2 `VllmEngineLoadFailing` matches `result="failed"`. F3 KV-cache alert + dashboard on vLLM V1 `vllm:kv_cache_usage_perc` / `model_name`. F4 `PATCH admin/ai-models/:id` takes `serving` (merged into `_metadata.serving`); the vllm seed row names `wireModelId`. F5 `stt` retries a vllm 503 only for `engine_capacity` / `draining` / `serving_spec_unavailable`. F6 `stt` never presents a `CHANGE_ME` token. F7 pool env `HF_MODULES_CACHE`, `VLLM_NO_USAGE_STATS`. F8 L5 pre-flip gates (a)–(e) and GPU smoke. |
| 2026-09-29 | Owner approved the spec and narrowed Phase 1 to Whisper ASR on vLLM (LLM/TTS later). Plan §4 written with decisions D-7…D-13 (ASR route over the spike engine because upstream 0.30.0 uses `<|prev|>` and max_tokens=16; truncation stays in the shell; engine facts on the model row). |
| 2026-09-29 | Ticket created. Discovery (two read-only agents over `hope-v2` and `hope-v2-deployment`), upstream research (vLLM STT, vLLM-Omni speech API, OmniVoice), design approved section by section in conversation (D-1…D-6). Spec written; status Pending. |
