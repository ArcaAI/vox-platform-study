# TASK-853 — MLflow fronts inference; retire the `vllm` provider

| | |
|---|---|
| **Status** | `In Progress` — research phase |
| **Type** | `feature` (monorepo) + `infrastructure` (deployment repo) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-01 |
| **Depends on** | TASK-823 (custom vLLM GGUF image), TASK-824 (LM Studio service) |

---

## 1. Requirement Analysis

**Owner directive, 2026-09-01, verbatim:**

> "i dont expect vllm to be handling any model, the workflow is, `text` service will
> send request to mlflow for inference with system message, messages, model
> hyperparameter declared!"

> "we need mlflow fronts inference — create new ticket and spawn agents to build it!
> we need to remove vllm provider and replace by mlflow fronts vllm inference!"

Target chain:

```
apps/api (resolves AiProviderConnection + AiTaskDefault, tenant → SYSTEM)
   └─ PUSHes provider + credential + model into the request
        └─ apps/text  ──►  MLflow  ──►  vLLM        (vLLM is a BACKEND, never addressed directly)
```

Two changes follow from it, and they are not independent:

1. **Add an `mlflow` provider** that `apps/text` can call, carrying a system message,
   a `messages` array, and per-request hyperparameters.
2. **Retire the `vllm` provider** as a *tenant-selectable* identity. vLLM does not
   disappear as a process — it stops being something the control plane routes to.

### What forced this ticket

vLLM was found at `replicas: 0` with `VLLM_MODEL_URI=s3://hope-models/qwen3-4b-awq/v1/`.
`qwen3-4b-awq` **exists nowhere in HOPE v2** — no `AiModel` row, no seed reference. It was
never a platform model. Correcting it surfaced the real question ("what should vLLM serve?"),
which the owner answered by changing the topology rather than the model.

**A constraint that shapes the whole design:** a vLLM server *cannot start without
`--model`*. "Ready" and "holds no model" are mutually exclusive for the vLLM process
itself. So MLflow-fronts-vLLM means vLLM still loads weights — it just is not the thing
`apps/text` talks to, and it is not a row any tenant can select.

---

## 2. Current State Evaluation

Everything in this section was **measured on 2026-09-01**, not inferred.

### 2.1 The MLflow inference path does not exist today

| Claim | Evidence |
|---|---|
| `apps/text` has no MLflow adapter | `grep -rln mlflow apps/text/` → **no hits** |
| `apps/text` selects no provider at all | `apps/text/src/text/core/config.py:3` — *"a STATELESS gateway. It selects no provider, holds no vendor credential, owns no endpoint"* |
| Its adapters are a closed set | same file, ~line 22: `OLLAMA, AZURE, BEDROCK, OPENAI, ANTHROPIC, VERTEX, OPENAI_COMPAT, VLLM, LLAMA_CPP, SARVAM, TEI` — no MLflow |
| MLflow is registry-only in `apps/api` | `apps/api/src/modules/ai-service-admin/mlflow-proxy.client.ts` exposes `status`, `experiments/search`, `registered-models/search`, `model-versions/search`. **No inference route.** |

So the owner's described workflow is the **target**, not the shipped behaviour. This ticket
is a feature build, not a configuration change.

### 2.2 MLflow itself is now healthy and is a usable foundation

Brought up earlier the same day (see §5 Change History):

- `hope-mlflow` **1/1 Running**, HTTP **200** in-cluster and via `https://mlflow.taphuynh.dev`
- backend store = the in-cluster PostgreSQL (`hope-postgres-rw`), **59 tables** migrated
- artifacts on in-cluster MinIO (`mlflow` bucket)
- image `ghcr.io/mlflow/mlflow:v3.15.2-full`

### 2.3 vLLM's current state

| Fact | Evidence |
|---|---|
| `replicas: 0` | `deployment/k8s/base/vllm.yaml` |
| pointed at a non-existent model | `VLLM_MODEL_URI=s3://hope-models/qwen3-4b-awq/v1/` |
| its ONE catalog row does not fit the hardware | `vllm-medgemma-1.5-27b-it`, SAFETENSOR bf16, `memorySizeMb: 55296` (~54 GiB) vs 2 × 16380 MiB cards |
| a GGUF-capable custom image ALREADY exists | `infrastructure/docker/vllm/Dockerfile` (TASK-823): vLLM v0.28.0 + `vllm-gguf-plugin`, with a build-time verifier and the `verify-vllm-plugin` CI gate |
| but the manifest uses the STOCK image | `deployment/k8s/base/vllm.yaml` → `vllm/vllm-openai:v0.11.0` |
| and `vllm` was never in `promote.sh SERVICES` | so the custom image is built by CI and **never pinned into any overlay** |

The TASK-823 Dockerfile header records three hard limits that this ticket must respect:
**embeddings are impossible** through the GGUF plugin (no pooling path), **Granite is
unverified**, and **`s3://` cannot reach the GGUF loader** (it needs a local path).

### 2.4 GPU headroom is not a constraint

Measured: 2 × RTX 2000 Ada, **16380 MiB each, 2 MiB and 4 MiB in use**; `nvidia.com/gpu`
allocatable **6** (time-sliced), **2** requested. The published models are Q4 GGUF
(`gemma-4-e2b-it-qat` declares `memorySizeMb: 2048`). Any earlier claim that the GPUs
could not hold the platform's models was wrong for the models actually published.

> ⚠️ Time-slicing does **not** partition VRAM. If LM Studio and vLLM land on the same
> physical card they compete for the same 16 GiB. Sizing must assume that.

---

## 3. Implementation Plan

> **Phase 0 (current): research.** Two read-only agents are establishing (a) which MLflow
> 3.15.2 mechanism actually fronts an OpenAI-compatible backend, its config, its request
> contract and whether it is a separate process; and (b) a complete inventory of every
> `vllm` provider surface — especially the enums and validators that would REJECT a new
> `mlflow` value. **No code is written until both land.** The steps below are the intended
> shape and will be corrected by those findings.

### 3.1 Open questions that gate the design

| # | Question | Why it gates |
|---|---|---|
| Q1 | Does MLflow 3.15.2 ship the Deployments Server / AI Gateway, and is it the SAME process as `mlflow server`? | Decides whether this is a config change to `hope-mlflow` or a NEW Deployment + Service + Ingress |
| Q2 | Can its provider config express an OpenAI-compatible custom base URL (vLLM `/v1`)? | If not, the whole topology changes |
| Q3 | Does it support streaming? | `apps/text` streams SSE today; losing streaming is a product regression, not a detail |
| Q4 | Can per-tenant credentials/routing be expressed? | Rule 00 §Configuration Principles: resolution is always tenant → SYSTEM. A single global gateway config cannot express BYO |
| Q5 | Does it persist request/response payloads? | **PHI risk.** A gateway that logs prompts is a compliance problem |

Q4 and Q5 are the ones most likely to force a redesign. Neither may be waved through.

### 3.2 Intended steps (subject to Phase 0)

1. **Deployment repo** — stand up the MLflow inference front per Q1/Q2: config, Deployment/Service as needed, probes, NetworkPolicy allowing MLflow → `hope-vllm:8000`.
2. **vLLM becomes a private backend** — custom TASK-823 image (`hope-v2/vllm:dev`), a **local** GGUF path from the `hope-models-cache` PVC (`/models/staging/<slug>/<file>.gguf`), `--tokenizer <that dir>`, drop `--load-format runai_streamer`, add an `await-models` initContainer mirroring `base/lmstudio.yaml`. Add `vllm` to `promote.sh SERVICES`.
3. **`apps/text`** — new MLflow adapter alongside the existing ones, same interface, fail-closed with no injected connection (`core/connection.py`), registered at the same point as its peers.
4. **Seed / control plane** — replace the `provider: 'vllm'` `AiProviderConnection` row (`87000000-0000-0000-0000-000000000007`) with an `mlflow` one; add the `mlflow` value to every enum/validator the inventory finds; decide the fate of `vllm-medgemma-1.5-27b-it`.
5. **Regenerate the five API artifacts** per `.claude/rules/05-nestjs-api.md` (`api:build`, `route-manifest`, `openapi`, `portal`, `vox-node gen:admin`) if any route or DTO changes.
6. **Tests** — TDD: a failing adapter test first; update every test asserting the provider set; cross-tenant coverage for the new connection row.

### 3.3 Verification criteria

- [ ] `apps/text` MLflow adapter unit tests green; `pnpm text:test`, `text:lint`, `text:typecheck`
- [ ] `pnpm --filter @arcaai/database test`; seed applies to a fresh DB
- [ ] An end-to-end generation through `text → MLflow → vLLM` with a system message, a `messages` array and hyperparameters — **actual output pasted**, not asserted
- [ ] Streaming verified, or its loss explicitly accepted by the owner
- [ ] No `provider: 'vllm'` reachable from any tenant-facing surface
- [ ] Both themes / a11y N/A (no UI change unless the admin console enumerates providers)

---

## 3A. Phase 0 findings — MLflow mechanism (source-verified, 2026-09-01)

Established against the **installed 3.15.2 source** on the running pod plus live probes,
which outrank documentation.

### The mechanism exists, and it is already running

| Mechanism | In 3.15.2? | Separate process? |
|---|---|---|
| **DB-backed AI Gateway** (UI-based) | **YES — already mounted on `hope-mlflow:5000`** | **NO — same process, same port** |
| Legacy YAML gateway (`mlflow gateway start`) | present but **DEPRECATED** in the installed code | yes |
| Deployments Server (`mlflow deployments start-server`) | **REMOVED** (`No such command`) | n/a |
| `mlflow models serve` | yes — but it serves a *logged model*, not an LLM proxy | yes |

`mlflow/server/fastapi_app.py:230` mounts the gateway router unconditionally. Live proof:
`POST /gateway/x/mlflow/invocations` → `404 GatewayEndpoint not found (name='x')` — the route
matched and reached the DB lookup.

**Consequence: no new Deployment, Service, or port is required.** Configuration is
**database rows created over REST** (`/api/3.0/mlflow/gateway/{secrets,model-definitions,endpoints}/create`),
not a YAML file. An `openai` provider with a custom `api_base` reaches vLLM's `/v1` natively
(`gateway_api.py:300-301`). There is no `vllm` provider and no selectable `openai_compatible`.

Call shape for `apps/text` — `POST /gateway/mlflow/v1/chat/completions`, system message +
`messages[]` + `temperature`/`max_tokens`/`top_p`/... all supported. **Streaming works.**

### Four findings that change the design

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **F-1** | **PHI is persisted by default.** Request AND response payloads are written as traces to the MLflow DB and the `s3://mlflow/artifacts` store. The only gate is `usage_tracking`, which **defaults to `true`**. | `tracing_utils.py:75` `span.set_inputs(_dump_payload(...))`; gate at `tracing_utils.py:225`; default at `handlers.py:5910-5912` | Consultation text would land outside the PHI boundary. `usage_tracking: false` must be an enforced, tested invariant — not a convention. The UI flow this feature is built around defaults it ON. |
| **F-2** | **`model` cannot be chosen per request.** The gateway pops `model` and treats it as the ENDPOINT name; a surviving `model` field raises **422**. | `gateway_api.py:765-767`; `providers/base.py:604-610` | Model choice becomes a property of the endpoint. HOPE's per-tenant `AiTaskDefault` model selection then requires **one gateway endpoint per (tenant, task)**. |
| **F-3** | **No tenant model, and no fallback semantics.** `MLFLOW_ENABLE_WORKSPACES` defaults false and is unset here; there is no per-tenant credential resolution. | `get_request_workspace()`; env verified unset on the pod | MLflow cannot express *"tenant value, else SYSTEM"*. Either `apps/api` stays the resolver (and MLflow adds a hop but no routing value), or the tenant → SYSTEM cascade is lost — which `.claude/rules/00` forbids. |
| **F-4** | **Auth is effectively absent, and secret encryption is decorative.** Host/origin allow-listing is not authentication; real auth needs `--app-name basic-auth`, which the Deployment does not pass. Secrets are envelope-encrypted with a KEK derived from a **hardcoded salt** and a **public default passphrase**. | `fastapi_security.py:32-49`; `utils/crypto.py` (`MLFLOW_KEK_SALT`, `DEFAULT_KEK_PASSPHRASE`); `MLFLOW_CRYPTO_KEK_PASSPHRASE` verified **unset** on the pod | Anything that can reach port 5000 can invoke inference using stored credentials. |

Two smaller ones worth carrying: **post-response guardrails are skipped on streaming**
(`gateway_api.py:785-787`) — material here because HOPE runs a guardrail service; and the
unified stream **never emits `data: [DONE]`** (MLflow parses and drops the upstream sentinel),
so a client blocking on it will hang.

Also: with `--workers=4`, budgets need `MLFLOW_GATEWAY_BUDGET_REDIS_URL` or they are enforced
four times too loosely (the default tracker is per-worker and in-memory).

### The honest cost/benefit

vLLM already speaks OpenAI `/v1`. What MLflow adds is cost budgets, a credential store and
unified tracing — and HOPE already has a guardrail service, Vault-backed tenant credentials
and OTel. **The tracing is the part that must be disabled for PHI (F-1).** Set against F-2 and
F-3, the front adds a hop and a shared failure domain: a vLLM stall consumes MLflow worker
slots shared with experiment/registry traffic.

**Cheapest de-risking step, to run before committing:** create ONE gateway endpoint and make
ONE chat call in dev. This can be proven against **LM Studio** (`http://hope-lmstudio:1234/v1`,
also OpenAI-compatible) without waiting on vLLM.

---

## 3B. Phase 0 findings — `vllm` provider inventory (measured 2026-09-01)

Every surface that would have to accept a new `mlflow` value, or that hard-codes `vllm`.
The delegated inventory agent stalled; this was gathered directly.

### The provider value is a free string, not a Prisma enum

`packages/database/src/prisma/db_main/seed/ai-models/shared.ts:95-110` defines
`AI_MODEL_PROVIDERS` (a `const` tuple) → `type AiModelProvider`. Its own comment:
*"free-string provider values, no Prisma enum migration (the column is a plain string)"*.

**So adding `mlflow` needs no database migration** — it is a TypeScript-level change plus
the validators below. That is the cheapest part of this ticket.

### Gates that would REJECT an unknown provider

| File:line | What it is |
|---|---|
| `seed/ai-models/shared.ts:107` | `AI_MODEL_PROVIDERS` — the canonical set behind `AiModelProvider` |
| `applications/src/services/usageLedger/vocabulary.ts:90` | metering vocabulary (self-hosted connection ids) |
| `applications/src/services/stt/model/dto/create-model.request.ts:29` | request-DTO validator |
| `applications/src/services/stt/model/dto/create-model.request.ts:38` | `DISCOVERABLE_AI_MODEL_PROVIDERS` |
| `vox-node/src/resources/admin/schemas.ts:1041, 3623, 5072` | three union types — **GENERATED**, must be regenerated (`gen:admin`), never hand-edited |

### Funding derivation — easy to miss, mis-bills silently

| File:line | Set |
|---|---|
| `applications/src/services/consultation/summary/text-usage.ts:74` | `SELF_HOSTED_PROVIDERS = {ollama, lm-studio, vllm, llama-cpp, built-in}` |
| `applications/src/services/agent-trajectory/harness-usage.mapper.ts:57` | same set, second copy |

These decide **BYOK vs CLOUD** metering. An `mlflow` provider absent from both would be
metered as a cloud provider. Rule 09 says funding is *derived, never stamped* — so the
classification question is real: MLflow is self-hosted, but what it fronts may not be.

### Seed rows and the adapter

| File:line | Row / symbol |
|---|---|
| `seed/17-ai-provider-connection.ts:352-367` | `AiProviderConnection` id `87000000-…-0007`, `provider: 'vllm'`, `baseUrl: http://hope-vllm:8000/v1`, `enabled: true` |
| `seed/ai-models/llm.ts:250-259` | `AiModel` `vllm-medgemma-1.5-27b-it` — SAFETENSOR, `memorySizeMb: 55296` |
| `apps/text/src/text/providers/vllm.py` | the adapter (`_ENGINE = "vllm"`, prefix-cache metrics off `vllm:*`) |
| **`apps/text/src/text/main.py:107`** | **the registration point** — `_register(("vllm",), lambda: VllmProvider(http_client))`. A new adapter hooks here, alongside its peers at :100-108. |

Tests asserting on the provider: `apps/text/src/text/tests/unit/test_task818_client_cache.py`
(:409, :436, :443, :452).

### Blast radius

~12 files, no migration, one generated artifact set to regenerate. The genuinely
*decision-bearing* items are the two `SELF_HOSTED_PROVIDERS` copies (metering correctness)
and whether the `vllm` adapter is deleted or retained as a direct fallback path.

---

## 3C. Phase 0 findings — the JIT requirement (2026-09-01)

**Owner requirement:** *"the MLFlow inference part must act like LM studio, when there is a
request, if model is loaded and serving, then use the model, if not, it should load the model
first before inferencing"* and *"the platform admin will configure the mlflow and manage the
model registered in mlflow"*.

### The behaviour already exists — in LM Studio, and it is already wired

`apps/text/src/text/providers/lmstudio.py:80-87` attaches LM Studio's **JIT idle-retention
hint** on every call:

```python
kwargs["extra_body"] = {"ttl": self._retention_ttl_s}
```

and its own docstring records that the value is *"the control-plane retention TTL adopted by
`apply_retention` and clamped to the shared product range — one admin-controlled number, not
LM Studio's own 60-minute default."*

So load-on-demand, keep-warm, and TTL-unload are **shipped**, and the TTL is already a
platform-admin-controlled value. This is exactly the described behaviour.

### MLflow cannot provide it, and the repo already measured why

| Claim | Evidence |
|---|---|
| The AI Gateway is a **stateless proxy** — nothing in its request path loads a model | §3A; it forwards to an already-serving upstream |
| The registry/pyfunc path loads per invocation, and it is **slow** | TASK-836 §4: *"loaded pyfunc from registry in **425.7s**"* for a **767 MB** model |
| Root cause: MLflow's artifact proxy | TASK-836 §5.1 — `--serve-artifacts` moves bytes through the tracking server at **~1.9 MB/s** vs **204 MB/s** direct to S3. A **~110×** penalty, called *"unusable for model weights"* |
| **`hope-mlflow` runs exactly that flag** | `deployment/k8s/base/mlflow.yaml` → `--serve-artifacts --artifacts-destination=s3://mlflow/artifacts` |

Extrapolating 1.9 MB/s to the published models: a 2 GB Q4 GGUF is **~18 minutes**, granite at
4.9 GB is **~43 minutes** — per cold load. That is not "act like LM Studio"; LM Studio does it
from local disk in seconds.

Two further registry constraints from TASK-836 that bind the admin workflow:

- **§5.5** — MLflow 3 will not register a bare artifact path. A GGUF must be wrapped with
  `mlflow.pyfunc.log_model(...)` to become a registry citizen.
- **§5.4** — a `.gguf` alone is not servable; the version must also carry the HF
  config/tokenizer directory (~23 MB), or it registers and cannot serve.

### Recommended shape — satisfies BOTH sentences of the requirement

```
apps/text ──► MLflow AI Gateway ──► LM Studio          (JIT: load-if-absent, TTL unload)
              (front door,            (already wired, already admin-TTL'd)
               admin-managed
               endpoints, budgets)
              MLflow Registry ......  governance: versions, aliases, lineage
```

- **LM Studio is the JIT engine.** It already does precisely what was asked, and `apps/text`
  already speaks its dialect. Nothing needs inventing.
- **MLflow is the admin/config and registry surface** — which is the second sentence of the
  requirement, and the thing MLflow is genuinely good at.
- **vLLM is the pinned, always-hot engine**, not the JIT one: it binds one base model at
  process start. Keep it for a model that should never be cold, or leave it at `replicas: 0`.
- **If weights ever move through MLflow, give clients DIRECT S3** (`MLFLOW_S3_ENDPOINT_URL` +
  credentials), never the `--serve-artifacts` proxy (§5.1).

**What this avoids:** building a controller that scales one vLLM Deployment per model, whose
cold start is minutes of weight loading — strictly worse than the LM Studio behaviour the
platform already has.

### 3C.1 vLLM runtime model management — confirmed against v0.28.0 sources

| Question | Verdict | Evidence |
|---|---|---|
| Can one vLLM process swap/add a **base** model at runtime? | **No.** `--model` binds once at engine start. `/v1/models` is read-only. | `vllm/entrypoints/openai/serving_models.py`; multi-base-model remains an OPEN request — vllm-project issues #299, #3326, #181, discussion #8077 |
| LoRA hot-load? | Yes — `POST /v1/load_lora_adapter` / `unload_lora_adapter`, but **adapters layered on the already-loaded base model only**. Needs `VLLM_ALLOW_RUNTIME_LORA_UPDATING=True`. | `docs/features/lora.md` @ v0.28.0. Docs warn verbatim: *"should not be used in production unless it is an isolated, fully trusted environment."* |
| Sleep mode = model swap? | **No.** Level 1 resumes the SAME model (weights parked in CPU RAM); level 2 can load a different model **only via a full reload** — a stop-the-world restart-in-place, not a live registry. Needs `VLLM_SERVER_DEV_MODE=1` + `--enable-sleep-mode`. | `docs/features/sleep_mode.md` @ v0.28.0, which calls these *"development endpoints … should not be exposed to users"* |
| Cold start cost | Llama 3.1 8B on A100 ≈ **176 s** to first token. **CUDA-graph capture (~54 s) and torch.compile (~39 s) are largely fixed overheads independent of model size**, so even a 2–5 GB quantized model is tens of seconds to minutes — not the seconds LM Studio delivers. | Third-party benchmarks; no official vLLM table. Marked *uncertain* for the small-quantized case specifically. |

**Conclusion: a per-model vLLM controller cannot deliver LM-Studio-like JIT.** The only two
runtime-mutable surfaces are adapters and a full-reload sleep/wake, and vLLM's own docs
disqualify both for production use.

### 3C.2 If LM Studio's licence is a problem, Ollama is the drop-in

LM Studio is **proprietary** (Element Labs) — free for commercial/internal use since
2025-07-08, but redistribution and modification are forbidden. For a platform that ships
images, that is worth a deliberate decision.

| Runtime | JIT load | Multi-model | Idle unload | Licence |
|---|---|---|---|---|
| **LM Studio** | yes | yes | yes (`ttl`, already wired) | **proprietary** |
| **Ollama** | yes | yes (evicts idle to make room) | yes — `keep_alive` (default 5 min), `OLLAMA_KEEP_ALIVE`, `OLLAMA_MAX_LOADED_MODELS` | **MIT** |
| llama.cpp router mode | yes | yes (one process per model) | yes (`stop-timeout`) | MIT |
| llama-swap (proxy) | yes | yes | yes (`ttl`) | MIT |
| Triton / Ray Serve / KServe ModelMesh | explicit-API or autoscaling, **not** idle-TTL JIT | yes | no native idle-TTL | OSS |

**`apps/text` already has an Ollama adapter** — `apps/text/src/text/main.py:101`,
`_register(("ollama",), lambda: OllamaProvider(http_client))` — so switching the JIT engine
is a control-plane change (`AiProviderConnection`), not a code change. ModelMesh is explicitly
documented as a poor fit for large single-GPU LLMs; Triton and Ray Serve do not offer
idle-TTL unload.

---

## 4. Implementation Summary

*Pending — Phase 0 research in flight.*

---

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket opened. Owner directive recorded (§1). Established that the `text → MLflow` inference path **does not exist in code** (§2.1) and that `qwen3-4b-awq` is foreign to the platform. Phase 0 research agents dispatched. |
| 2026-09-01 | Prerequisite, done under this ticket's umbrella: `hope-mlflow` brought from `replicas: 0` to serving — DB blocker already cleared, **OOMKilled** at the 1 Gi limit (raised to 3 Gi), and a **403 DNS-rebinding** rejection fixed on `--allowed-hosts` (the CLI arg wins over `MLFLOW_SERVER_ALLOWED_HOSTS` from `envFrom`; a ConfigMap-only fix was inert). |
