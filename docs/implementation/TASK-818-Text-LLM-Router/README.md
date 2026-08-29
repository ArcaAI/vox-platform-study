# TASK-818 — `apps/text` becomes a high-throughput LLM router

| | |
|---|---|
| **Status** | Pending — awaiting resolution of OPEN-1..3 below |
| **Type** | refactor + infrastructure |
| **Branch** | `dev-2.2` |
| **Primary surface** | `apps/text` (port 8862) |
| **Blast radius (owner-approved)** | callers may be rewritten · `@arcaai/vox-node` may change · DB/tenant config may change · deploy/infra may change |
| **Related** | TASK-735 (guardrail delegation + judge cycle guard), TASK-799 (python config plane), TASK-808 (unblock TEXT generation), TASK-736 (engine removal) |
| **Companion tickets** | **TASK-822** MLflow deployment · **TASK-823** vLLM inference service · **TASK-824** LM Studio containerized service. 818 is the router; 822–824 are the backends it routes to. |

---

## 1. Requirement Analysis

**Owner statement.** `apps/text` receives requests from other services and routes them to
the corresponding LLM backend — Azure OpenAI, Azure AI Foundry, AWS Bedrock, OpenAI,
Anthropic, LM Studio, vLLM, Ollama, llama.cpp — selected by **tenant configuration** with a
platform-provided fallback. **`apps/text` must NOT be able to serve any model.**

**Owner decisions already taken (2026-08-29):**

| # | Decision | Consequence |
|---|---|---|
| D-1 | **Scope: router + embeddings + translate.** Keep proxy-shaped capabilities that route to an external backend. Drop the async task/worker-pool plane, generation audit, and (see OPEN-1) `/judge`. | The durable-state plane leaves `apps/text` entirely. |
| D-2 | **Two PERMANENT interfaces, one hot path.** `text` publishes gold-standard internal REST + streaming APIs in **two** supported contracts: an **OpenAI-standard** surface and the **existing HOPE** surface. Both are first-class and permanent. *(Revised 2026-08-29 — supersedes the earlier "shim then delete" reading.)* | Neither contract is deprecated. Both are thin layers over one shared routing core. |
| D-3 | **Target: ~200 concurrent users ≈ 20–40 in-flight generations.** Optimize per-stream memory, backpressure, connection limits, graceful drain. *(Revised 2026-08-29 — supersedes the earlier 2,000-stream target.)* | Comfortably inside a hardened Python proxy. Heavier optimizations (Granian, SigV4 direct-HTTP Bedrock) become **measure-first**, not scheduled work. |
| D-4 | Callers, SDK, DB/tenant config and deploy/infra are all in scope. | No compatibility shim needed — both contracts are permanent. |
| D-5 | **Provider priority order**: vLLM → LM Studio → Azure OpenAI / Azure AI Foundry → AWS Bedrock → OpenAI → Anthropic. **All existing providers are KEPT** — Ollama, llama.cpp, Vertex/Gemini and Sarvam translate stay. | Two new adapters needed (Azure AI Foundry, LM Studio as its own identity); nothing is deleted. |
| D-6 | **Routing policy**: the platform **super admin** authors the default routing policy AND the failover chain at SYSTEM tier. A tenant's **enabled + keyed `AiProviderConnection`** overrides it. | Needs **no** new privilege exception — it is exactly the existing three-state semantics (no row = no opinion, enabled+keyed = tenant wins, disabled = veto). |
| D-7 | **Explicit provider in a request is honoured**, subject to the failover ruling in §3.4. | Request-named provider is the primary candidate, not a hint. |
| D-8 | **Cost and performance must be manageable by platform super admins.** | Extends the EXISTING `AiPriceBook` / `AiUsageEvent` / `AiUsageRollup*` ledger and the `/ai-operations/*` console screens — not a new plane. |

**Standing platform rules that bind this work** (do not re-litigate):

- **Pre-production, build for day-1.** No production data exists. Ship complete and ENABLED,
  not flag-gated. Delete rather than deprecate.
- **Config: tenant → SYSTEM, two tiers.** `50000000-…` ("Global") is a customer tenant and
  must never appear in a runtime cascade. `.claude/rules/09-infrastructure-devops.md`.
- **No hardcoded configuration.** No model id, engine name, endpoint, threshold or credential
  as a literal or as a `pydantic-settings` default. Env is the bootstrap floor only.
- **`X-Tenant-Id` is mandatory** on internal service-to-service calls carrying tenant work.
- **Test scope exclusions**: `apps/compat-playground`, `apps/quick-compat-app`, `packages/ui`.

---

## 2. Current State Evaluation

### 2.1 The headline finding: `apps/text` already cannot serve a model

Audited 2026-08-29 across the dependency closure, every import under `apps/text/src`, the
Dockerfile, and the compose files.

**Verdict: NO — it cannot serve a model today.**

- `apps/text/pyproject.toml:25-57` and the resolved `uv.lock` closure for the `text` package
  contain **zero** inference runtimes: no torch, transformers, onnxruntime, llama-cpp-python,
  `vllm` (the library), ctranslate2, sentence-transformers.
- Repo-wide grep across `apps/text/src` for `from_pretrained` / `AutoModel` / `HF_HOME` /
  `TRANSFORMERS_CACHE` / `.gguf` / `.safetensors` / `snapshot_download`: **no hits**.
- Grep for `subprocess` / `Popen` / `asyncio.create_subprocess` / `os.system` /
  `multiprocessing`: **no hits**. `apps/text` starts no process.
- `apps/text/Dockerfile:90-91,120` copies only the venv and `src`, and runs only uvicorn.
  `apps/text/docker-compose.yml` mounts no model volume.
- Every adapter resolves endpoint + credential + model **per request** through
  `core/connection.py:55-105` and fails closed when absent.
  `providers/vllm.py:22,40-44`, `providers/llama_cpp.py:22,68-70`,
  `providers/ollama.py:13,81-83`, `providers/tei_embed.py:13,43-47` all call
  `require_base_url(request, …)` — no default endpoint exists.
- `providers/embedding.py:26-40` is a Protocol + registry only. **Text does not compute
  embeddings**; it proxies them to TEI at `POST {base_url}/embed` (`tei_embed.py:45`).
- `translation/sarvam.py:97-127,157` is plain httpx to `{base_url}/translate`; key, base_url
  and model are all BYOK / fail-closed.
- The vLLM / llama.cpp / TEI containers are owned by the infra compose `inference` profile
  (`infrastructure/docker/docker-compose.dev.yml:460,509,546`), with weight caches on
  `vllm-cache` / `tei-embed-data` volumes — never on text.
- No hardcoded model ids: every adapter ships `default_model=""`
  (`providers/{llama_cpp:268, tei_embed:84, openai:301, vertex:362, openai_compat:416,
  anthropic:370, azure_openai:401, ollama:335, bedrock:378}.py`), locked by
  `tests/unit/test_no_model_default_d7.py:176-184`.
- `core/config.py:152-190` declares nine bootstrap-floor fields and **no** provider block,
  model id or credential — locked by `test_task799_config_surface.py:65-131`.
- `worker.py:1-31,132-165` is a Redis-Streams consumer reusing the same HTTP adapters. It
  hosts nothing.

**Therefore this ticket is not "remove serving". It is "become a fast router, and install a
permanent guard against ever regressing into a server."**

### 2.2 Residual regression invitations (documentation, not capability)

These do not let text serve a model. They tell an operator or a future agent that it can.

| # | Location | Problem | Severity |
|---|---|---|---|
| V-1 | `infrastructure/docker/docker-compose.dev.yml:448-451` | Comment tells operators to "wire TEXT via `.env.dev`" with `TEXT_VLLM_BASE_URL` / `TEXT_LLAMA_CPP_BASE_URL`, and points at a nonexistent `apps/text/.env.prod`. Those vars were deleted (`core/config.py:22-27`) and are banned by name in `test_task799_config_surface.py:100`. | RISK |
| V-2 | `docs/operations/inference/README.md:65,71,75` | Same three dead env vars, same nonexistent file, in the operator runbook. | RISK |
| V-3 | `apps/text/README.md:58` | Cites a "`TEXT_*` / per-provider set" and `.env.prod` as the production config path; contradicts the service's own module docstring. | RISK |
| V-4 | `apps/text/src/text/main.py:181-182` | Comment claims `tei-embed` "always carries a topology-level default `base_url`". Untrue — `tei_embed.py:25-27,43` is fail-closed. This is precisely the sentence that would justify re-adding an endpoint default. | COSMETIC |
| V-5 | `apps/text/src/text/api/endpoints/judge.py:25` | Docstring cites deleted `TEXT_JUDGE_*` vars; sizing is now `JUDGE_LANE_FLOOR` + `AiRuntimeProfile`. | COSMETIC |
| V-6 | `providers/openai_compat.py:119,475` | Admin probe builds a client from the process-wide memo `_last_base_url` — the one place an endpoint persists across tenants. Probe-only today; a future edit letting it reach `_client_for` reintroduces a shared endpoint. | COSMETIC / watch |
| V-7 | `apps/text/.deepeval` | Stray empty untracked dir from the `deepeval` package (which belongs to harness's `eval` extra, not text's closure). | COSMETIC |

### 2.3 The throughput picture — where the streams actually die

**Streaming today does not stream.** `POST /generate` with `stream=true`
(`generate.py:475-497`) returns **202 + a `task_id`**, runs generation in a FastAPI
`BackgroundTask`, and for **every chunk** does `await task_manager.append_chunk(...)`
(`generate.py:972`) → **one Redis `XADD` per token** (`task_manager.py:128`) with JSON
encode + envelope wrapping. The caller then polls `GET /tasks/{id}/stream`
(`stream.py:34`), which loops `XREAD BLOCK 5000 COUNT 100` (`task_manager.py:225`), JSON-decodes
and **pydantic-validates every chunk** (`task_manager.py:176-194`) before relaying it as SSE.

For the owner's stated target — thousands of concurrent streams — this is the whole problem:
per stream, per token, you pay two Redis round trips, two JSON passes and two pydantic
validations. This is the single largest item in the ticket.

**Ranked bottlenecks** (all evidence-cited):

| # | Bottleneck | Evidence | Why it matters for concurrent streams |
|---|---|---|---|
| B-1 | Per-token JSON + pydantic on **both** sides, plus the 202-and-poll indirection | `task_manager.py:128,176-194,225`; `generate.py:972` | **Revised (§3C.1): the Python tax is the cost, not Redis** — Redis runs at ~6% capacity at this scale. Fixed by coalescing, not by deletion. |
| B-2 | **Fresh SDK client + TLS pool per request** for OpenAI, Azure, Anthropic, Vertex, Bedrock **and** `openai_compat` (LM Studio) | `openai.py:91`, `azure_openai.py:114`, `anthropic.py:97`, `vertex.py:150`, `bedrock.py:78-88`, `openai_compat.py:139-144` | Every stream pays a TLS handshake and gets no connection reuse. `openai_compat` is `SELF_HOST` — it has no BYOK reason to pay this. |
| B-3 | Bedrock streaming holds a **default-executor thread for the entire stream** | `bedrock.py:265-278` | Executor is `min(32, cpu+4)`. ~32 concurrent Bedrock streams saturates it and starves every other `to_thread` user in the process. Hard ceiling. |
| B-4 | Single uvicorn process, **no `--workers`** | `Dockerfile:121`, `scripts/dev-service.sh:242` | One event loop per pod. Any CPU-bound work (JSON, pydantic) stalls all concurrent streams. (`uvicorn[standard]` does give uvloop + httptools.) |
| B-5 | Provider semaphore is held across the **entire retry loop** incl. backoff sleeps — released only in the outer `finally` | `generate.py:526-562` vs `796-798` | A degrading provider consumes a concurrency slot for `sum(backoffs) + attempts × timeout`. Compounds provider degradation into capacity starvation. |
| B-6 | Inline guardrail network hop before any generation | `generate.py:383`, `services/external_guardrail.py:59` | Full round trip (with retries) added to every gated request's TTFT. |
| B-7 | ≥2 Redis round trips per non-streaming request for task bookkeeping (`create_task` SET, `update_task` EVAL ×2) | `generate.py:463,512,592`; `task_manager.py:28-48` | Pure overhead once the durable-state plane is gone. |
| B-8 | No HTTP/2 on the shared client | `main.py:108-114` (no `http2=True` anywhere) | Each concurrent stream to a local engine needs its own TCP connection, capped at `max_keepalive_connections=100`. |
| B-9 | No orjson, no `ORJSONResponse` default | `main.py` has no `default_response_class` | Responses go through Starlette's stdlib-`json` path. |
| B-10 | Full pydantic validation of request **and** response on every call | `generate.py` throughout | Paid twice per request on bodies that are mostly pass-through. |
| B-11 | 8–12 synchronous Prometheus `.labels().inc()/.observe()` per request | `generate.py:596-650,713-716,767-770` | Individually cheap; label cardinality grows with the model catalog. |
| B-12 | Idempotency Redis GET + full-response SET when `Idempotency-Key` present | `generate.py:365-375,692-700` | Latency for dedup safety; keep, but move off the stream path. |

### 2.4 What is already good — do not "fix" these

- **Config hot path is sound.** `EffectiveConfigClient.get()` (`effective_config.py:267`) is
  a boolean expiry check inside the TTL window — **no per-request I/O**. 60 s TTL with ±10%
  jitter (`:40,387-390`), `asyncio.Lock` single-flight with double-checked expiry
  (`:263,272-278`), negative caching (`:414-427`), and Redis pub/sub invalidation on
  `arca:config:invalidate` (`:323`, started `main.py:261`) as the real propagation path.
  The snapshot is process-global **and that is correct** — it carries service-level capacity
  knobs, not tenant data; provider/model selection is pushed per-request
  (`effective_config.py:1-6`). *Only defect:* `_refresh()` builds a throwaway
  `httpx.AsyncClient` each cycle (`:395`) — ≤1/60 s, cosmetic.
- **Bedrock non-streaming correctly offloads** via `asyncio.to_thread(client.converse, …)`
  (`bedrock.py:215`). Only the streaming path (B-3) is the problem.
- **The resilience primitives are exactly what a router should own**: `circuit_breaker.py`,
  `rate_limiter.py`, `provider_queue.py`, `resizable_semaphore.py`, `pool_router.py`,
  `runtime_limits.py`. Keep and improve; do not delete.
- **`ResizableSemaphore` keeps object identity across resize** (`runtime_limits.py:786`) so
  admins can retune live. Preserve this property.
- **Credential posture is clean**: no ambient credential chains
  (`bedrock.py:75-90` explicit bearer session, `vertex.py:66,136-154` explicit `credentials=`).

### 2.5 Caller inventory (what a contract change costs)

| Consumer | Files |
|---|---|
| API gateway | `apps/api/src/modules/streaming/text-proxy.controller.ts`, `text-proxy-redirect.shim.controller.ts`, `apps/api/src/modules/text-compat/**` (12 files incl. `v1-wrapper`, prompt builders, response mappers) |
| Applications | `packages/applications/src/services/consultation/jobs/processors/{pre-summary,comprehensive-summary}.processor.ts`, `consultation/live-documentation/live-documentation.service.ts`, `dna-writing-style/dna-writing-style.processor.ts`, `baseServices/serviceHealth/serviceHealthMonitoring.service.ts` |
| Guardrail | `apps/guardrail/src/guardrail/core/{config,tenant_config}.py` (+ 5 test files incl. `test_text_judge_delegation.py`) |
| NLP | `apps/nlp/src/nlp/core/config.py` (`external_text_client.py`) |
| Harness | `apps/harness/src/harness/core/config.py` (+ `test_text_client.py`) |
| SDK | `packages/vox-node` — `hope.summarization.*` v1-compat paths |

Endpoint reference counts across the repo: `/generate` ×80, `/translate` ×19, `/tasks/*` ×12,
`/embeddings` ×12, `/generate/assembled` ×6, `/generate/internal/judge` ×5.

---

## 3. Open Decisions — owner input required

These three change what the plan builds. Each carries my recommendation; work proceeds on the
recommendation unless overridden.

### OPEN-1 — `/generate/internal/judge` must NOT be deleted. (Recommend: keep, reframed.)

D-1 as selected drops `/judge`. **This is unsafe as literally applied.** The judge lane is a
deliberate two-layer structural cycle guard, documented in
`services/judge_guard.py:1-25`:

> `apps/text` gates every PUBLIC `/generate` on `apps/guardrail`, fail-closed. Guardrail, in
> turn, delegates its LLM judgement calls back to `apps/text`. Those two facts together
> describe a cycle — `text → guardrail → text → guardrail → …` — which is unbounded and,
> under saturation, **deadlocks the safety plane behind the very pool it protects**.

Layer one is static (the judge module names neither the guardrail client nor its provider,
pinned by `tests/unit/test_judge_route.py`); layer two is a `ContextVar` tripwire
(`judge_scope()` / `assert_not_in_judge_scope()`) raising `GuardrailRecursionError`.

Deleting the route sends guardrail's judgement calls onto public `/generate`, which recloses
the cycle *and* puts safety traffic in the same concurrency lane as clinical traffic.

**Recommendation:** keep it, and reclassify it. A separately-budgeted, ungated internal lane
is a **routing** concern, not a business concern — it is admission control, which a router
must own. Rename to make that explicit (e.g. `POST /internal/lanes/judge` or a generalized
`lane=` admission parameter), delete only judge-specific business logic, and keep both guard
layers and their tests intact. Cross-reference TASK-735 Phase 2 before touching it.

### OPEN-2 — RESOLVED 2026-08-29: resumability is REQUIRED. Design in §3C. ✅

Dropping `task_manager` + Redis Streams (D-1) is the single biggest throughput win (B-1) and
is exactly right for D-3. But today's design buys one real capability with that cost: a
client that disconnects mid-generation can reconnect and **resume from the last Redis stream
id**, and generation continues server-side independent of the client.

Direct SSE passthrough removes both: a dropped connection means a lost (and already-billed)
generation.

**Owner ruling: nothing may be lost.** A client that disconnects — tab closed, network drop, pod
restart, laptop sleep — must reconnect and resume the same generation without losing context or
output. **This reverses the recommendation above**, and Lane B changes from "delete the durable
plane" to "restructure it". See **§3C** for the design.

**And the cost premise behind the original recommendation was wrong** — see §3C.1. Redis was not
the bottleneck.

### OPEN-3 — RESOLVED 2026-08-29: move it off the hot path. ✅

D-1 drops generation audit. `services/generation_audit.py` is called synchronously on every
completion and failure (`generate.py:611,718,772,924`). It is in-process structured logging,
not an external call, so it is cheap — but in a healthcare platform, *usage attribution and
generation audit for a multi-tenant router is arguably intrinsic to the router*, not a
business concern.

**Owner ruling: move it off the hot path. Do not delete it.**

Lane D converts `generation_audit` to a **fire-and-forget async event**: emit to the existing
sys-event / BullMQ fan-out via the gateway (per `.claude/rules/04-application-services.md`),
never an inline write. Constraints that survive the move:

- **BYOK-vs-CLOUD funding attribution stays derived, never stamped** — `row.tenantId === SYSTEM_TENANT_ID`
  decides it, as `AiProviderConnectionService` already does. A call site that stamps it mis-bills silently.
- **The emit must not be able to fail the generation.** Wrap it; a full queue drops the event and
  increments a counter rather than 500-ing a billed request.
- **But the event must not be silently lossy either** — HIPAA §164.312(b) audit controls is a
  *required* standard. Use the existing transactional-outbox shape (`AiUsageOutbox`) rather than a
  bare `fire_and_forget`, so an emit that fails is retried, not lost. That is the difference between
  "off the hot path" and "best effort".
- Alert on audit-event lag. An audit plane that is quietly hours behind is a compliance finding.

**The guardrail gate is now specified in §3B — RESOLVED 2026-08-29.** ✅

---

## 3A. The Routing Policy Plane (added 2026-08-29)

### 3A.1 What already exists — and the honest gap

Verified in-repo:

- **`AiProviderConnection`** (`packages/database/src/prisma/db_main/ai-provider-connection.prisma:51-89`) — WHERE/HOW to reach a provider: `service`, `provider`, `baseUrl`, `region`, `apiVersion`, `deploymentName`, `encryptedApiKey` (Vault-Transit `Bytes?`), `enabled`, unique on `(tenantId, service, provider)`. Cascade documented at `:38` — **tenant row (enabled) → SYSTEM row → fail closed**. Implemented in `ai-provider-connection.service.ts:287-301`; funding derived, never stamped, at `:734-736` (`row.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant'`).
- **`AiTaskDefault`** (`ai-task-default.prisma:23-53`) — per-`(tenant, taskKey)` model selection. `text.live` / `text.finalize` and their `.fallback` variants **are tenant-admin configurable** (`:12-20`). This is the existing routing substrate.
- **`AiRuntimeProfile`** (`ai-runtime-profile.prisma:16-55`) — hyperparameters/concurrency per `(tenant, provider, modelSlug)`.
- **`AiModel`** (in `stt.prisma`) — `source: AiModelSource` includes **`MLFLOW`, an enum value with no implemented resolver**; only `hf:`, `file://`, `s3://` are handled (`stt.prisma:33-42`).

**The gap is real and specific.** What exists is **one primary + one fallback**, expressed as two `AiTaskDefault` rows, and the cross-provider retry is **reactive only** — `summary.service.ts:1601-1642` catches an error and retries once against `resolveTextFallbackSelection`. There is:

- **no ordered N-way candidate chain**, no weights, no selection strategy;
- **no proactive health-driven failover** — `pool_router.py:14-45` degrades within `apps/text`'s own health cache and is one-provider-to-one-named-fallback, driven by a **per-request** `GenerateRequest.fallback_provider` (`models/requests.py:170`), not by policy;
- **`.fallback` wired only for `finalize`, not `live`** (streaming);
- **no routing-policy field in the effective-config contract** — `effective-config.controller.ts:40-41` states outright that its values are *"service-level knobs ONLY — never per-request model selection"*;
- **`GenerateRequest.provider` defaults to the hardcoded literal `"lm-studio"`** (`requests.py:142`) — a rule-00 "config costume" that must become "absent ⇒ resolve via policy".

### 3A.2 Minimum policy vocabulary (derived from what shipped gateways actually expose)

Surveyed LiteLLM Router, Portkey, Envoy AI Gateway, Kong AI Proxy Advanced, OpenRouter and Cloudflare AI Gateway. The common denominator every serious router has: (1) ordered candidate list per logical model; (2) a selection strategy; (3) weights; (4) a **depth-bounded** fallback chain; (5) **typed** fallback triggers; (6) cooldown/circuit gating; (7) match conditions on tenant/metadata; (8) explicit-caller-override semantics; (9) an addressable, **versioned** config unit.

Signal worth heeding: **LiteLLM ships three separate fallback chains** — `fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks` — which is the clearest evidence in the field that **one undifferentiated chain is not enough**. A context-window overflow and a 503 need different next-hops.

Equally: **Bedrock Intelligent Prompt Routing and Azure AI Foundry Model Router are NOT rules engines** — they are learned, per-request routers inside one model family. Do not model our admin-editable policy on them.

### 3A.3 Recommended schema

One `RoutingPolicy` row per `(tenantId, taskKey, version)`; `tenantId = SYSTEM` is the super-admin-authored platform default (D-6).

```jsonc
{
  "policyId": "uuid7", "version": 7, "status": "ACTIVE",      // DRAFT | ACTIVE | ARCHIVED
  "tenantId": "00000000-…-0000", "taskKey": "text.finalize",
  "match": { "models": ["gpt-4o-class"], "metadata": {"phi":"true"},
             "minContextTokens": null, "maxContextTokens": 128000 },
  "candidates": [                       // ORDER = priority; weight splits within a rank tier
    {"rank":0,"weight":100,"connectionRef":"vllm-inhouse","model":"qwen3-32b-med",
     "residency":"IN_CLUSTER","baaCovered":true,"maxTtftMs":1500},
    {"rank":1,"weight":100,"connectionRef":"azure-openai-eastus","model":"gpt-4o",
     "residency":"AZURE_US","baaCovered":true},
    {"rank":2,"weight":100,"connectionRef":"bedrock-us-east-1","model":"claude-sonnet-4",
     "residency":"AWS_US","baaCovered":true}
  ],
  "strategy": "PRIORITY",               // PRIORITY | WEIGHTED | LEAST_BUSY | LOWEST_LATENCY | LOWEST_COST
  "fallback": {
    "maxDepth": 2,                                     // hops AFTER the primary; hard cap
    "triggers": ["CONNECT_ERROR","TIMEOUT","HTTP_5XX","HTTP_429_AFTER_BACKOFF",
                 "CONTEXT_WINDOW_EXCEEDED","CONTENT_POLICY"],
    "requireSameResidencyClass": true,
    "requireBaaCovered": true,
    "crossFundingAllowed": false                       // never BYOK -> SYSTEM credential silently
  },
  "health": {"consecutiveFailures":5,"failureRatePct":50,"windowSec":60,
             "baseEjectionSec":30,"maxEjectionSec":300,"maxEjectionPct":50,"halfOpenProbes":1,
             "rateLimit":{"treatAs":"BACKOFF_NOT_OUTAGE","maxBackoffRetries":2}},
  "explicitProvider": {"mode":"STRICT"}, // STRICT | STRICT_UNLESS_OPTED_IN | POLICY_MAY_OVERRIDE
  "killSwitch": false,
  "createdBy":"uuid","activatedAt":"…","supersedesVersion":6
}
```

- **Per-model override** = a policy row with a narrower `match.models`. Most-specific match wins; ties broken by an explicit `priority` int.
- **Resolution stays tenant → SYSTEM, two tiers.** Never `50000000-…`.
- **Worked example** ("prefer vLLM, fall back Azure then Bedrock, except tenant X pins Anthropic"): the row above at `tenantId = SYSTEM`, plus one row at `tenantId = X` with a single candidate `{rank:0, connectionRef:"anthropic-byok-tenantX"}`, `fallback.maxDepth: 0`, `explicitProvider.mode: "STRICT"`. Tenant X wins on presence; everyone else inherits SYSTEM.
- **Propagation**: DB row + `routing-policy:invalidate` on Redis pub/sub, TTL as backstop — mirrors the existing `app-settings:invalidate` mechanism. This is the LiteLLM `STORE_MODEL_IN_DB` model, which is the only hot-reload approach proven at scale in the survey.
- **Dry-run**: `POST /admin/routing-policies/{id}/simulate` replays the last N logged requests through a DRAFT policy and returns per-candidate hit counts, projected cost delta vs ACTIVE, and any request that would now be **rejected**. Prior art: Kong `deck gateway diff` (the only mature dry-run found in any AI gateway) and LaunchDarkly's test-run preview. **Neither LiteLLM nor Portkey has a dry-run** — this is a genuine differentiator, not catch-up.

### 3A.4 FAILOVER RULING — explicit provider that is down returns an ERROR

**Default `explicitProvider.mode = "STRICT"`: a request naming a provider that is down returns 503 with a machine-readable `provider_unavailable` code and retry guidance. No silent substitution, ever.** Opt-in is per-request (`allow_fallbacks: true`), bounded by the residency/BAA/funding gates below.

**This deliberately inverts the industry default** — OpenRouter and Cloudflare default `allow_fallbacks` to true, and LiteLLM fires configured fallbacks by default. Nothing surveyed defaults to hard-fail. The healthcare evidence is what justifies the deviation:

- **BAA coverage is per-vendor AND per-model.** AWS's HIPAA-eligible reference (updated 2026-08-03) lists *"Amazon Bedrock [excluding Fable and Mythos models]"* — eligibility is not blanket even within one vendor. OpenAI's BAA never covers ChatGPT Free/Plus/Pro/Team. Anthropic's excludes beta products and Free/Pro/Max/Team. Azure OpenAI is eligible under the standard DPA but **excludes image inputs**. A single fallback hop can therefore move PHI outside BAA coverage.
- **There is no HTTP-standard way to signal substitution.** RFC 9111 (June 2022) **obsoleted the `Warning` header**, so every gateway invented its own (`cf-aig-step`, `X-Kong-LLM-Model`, `x-litellm-model-id`). A silent fallback is genuinely invisible to a caller who did not ask for it.
- **Under BYOK it is a billing fact**: failing over from the tenant's own key to a SYSTEM credential moves the charge onto the platform's P&L and flips the metering class mid-request.

**When fallback IS permitted it must be loud.** Every response carries:
`x-hope-provider-requested` / `x-hope-provider-served`, `x-hope-model-requested` / `x-hope-model-served`, `x-hope-fallback-step` (0 = primary), `x-hope-fallback-reason`, `x-hope-funding` (`BYOK`|`CLOUD`, **derived** from the row that supplied the credential). Plus OTel `gen_ai.request.model` vs `gen_ai.response.model` — the semconv separates these two attributes precisely to catch silent model substitution — and a `fallback_occurred` sys-event carrying tenant, from/to, trigger and both prices.

**Three hard gates on any hop, enforced in code, not in policy text**: same residency class, BAA-covered target, same funding tier. A hop crossing any of them is **not a fallback — it is a rejection.**

### 3A.5 Health signals — 429 is not an outage

- **Envoy outlier detection is the reference implementation**: `consecutive_5xx` (default 5), `success_rate` = mean − (stdev × factor), `base_ejection_time` 30s multiplied by ejection count, **`max_ejection_percent` default 10% so the pool can never be fully ejected**.
- **Copy LiteLLM's per-exception-type thresholds** (`AllowedFailsPolicy`): a `RateLimitError` budget far higher than a hard-error budget. Its default is `allowed_fails` 3/min → cooldown.
- **Feeding 429s into a 5xx ejection counter ejects a healthy-but-busy provider.** Correct response is same-provider backoff honouring `Retry-After`, and only then a lateral shift. Anthropic distinguishes client-quota `429` from server-side `529 overloaded_error`; Azure returns `retry-after-ms` + `x-ratelimit-remaining-*`; Bedrock marks `ThrottlingException` retry-eligible while `ValidationException`/`AccessDeniedException` are not. Kong makes it *easy* to conflate them (`http_429` in `failover_criteria`) — **do not.**
- **Hedging** (Dean & Barroso, *The Tail at Scale*, CACM 2013 — a duplicate request after p95 cut one BigTable p99 from 1800ms to 74ms at ~2% extra work) applies to **non-streaming, idempotent** calls only, and doubles token cost. Not day-1.

### 3A.6 Cost governance — extend what exists, build only the gap

**Already built in this repo** (`packages/database/src/prisma/db_main/usage-ledger.prisma`): `AiUsageEvent` (append-only per-(request,unit) ledger with `deployment: SELF_HOSTED|CLOUD|BYOK`, `unitPriceMicros`, `costMicros`, `costBasis: INTERNAL|BYOK_NOTIONAL`), `AiUsageOutbox` (transactional outbox, BullMQ-drained), **`AiPriceBook`** (a real effective-dated, supersede-only price table keyed by `(plane, capability, provider, model, unit, contextBand, cacheTtl)`), `AiUsageRollupHourly`/`Daily`, and `ProviderReconciliationRun` (vendor-vs-ledger drift). Console screens `/ai-operations/consumption` and `/ai-operations/reconciliation` already exist.

**So the cost work is extension, not construction.** The genuine gaps, confirmed against the market survey:

1. **Price-table freshness.** The **Azure Retail Prices API is the only first-party programmatic token-price feed** found; no equivalent exists for Bedrock, OpenAI or Anthropic. LiteLLM's community-maintained JSON is the de-facto source and it defaults unmapped models to **$1/token to avoid false-cheap** — copy that defensive default and **alert on an `unpriced_model` counter**, because a silent $0 is worse than a wrong price.
2. **One budget ceiling spanning BYOK + platform spend is structurally impossible off-the-shelf** — the gateway is not the payer of record for BYOK. Track BYOK as `BYOK_NOTIONAL` (already modelled) and never sum it into a platform budget.
3. **Showback is required, chargeback is optional** (FinOps Foundation). Ship showback.
4. **Do NOT ship prompt-difficulty / quality-aware routing day-1.** RouterArena (arXiv:2510.00202) exists precisely because the space lacks reproducible evaluation; vendor claims are marketing-grade (Azure's Model Router figure rests on a **10-prompt** sample).

### 3A.7 Dashboards and the cardinality rule that governs them

**Verified Grafana dashboard IDs for vLLM**: 25043, 24755, 24756, 25237, 25502, 23991 (vLLM ships `examples/observability/prometheus_grafana/` in-repo). **No dashboard exists for Kong AI Gateway or Envoy AI Gateway.**

Panels a super admin needs, grouped: **Fleet health** (rps by provider; error rate by provider × class — 5xx/429/timeout/content-policy as *separate series, never summed*; circuit state gauge; cooldown events/hr; **failover events/hr by (from, to, reason)**; strict-mode rejections). **Latency** (TTFT p50/p95/p99 by provider × model; TPOT p95; e2e p95; **gateway overhead = total − provider latency**, the one panel that proves the router is not the bottleneck; streaming vs non-streaming split). **Saturation** (in-flight; **queue depth** — the leading indicator; KV-cache utilisation; prefix-cache hit rate; remaining RPM/TPM headroom, the 429 early warning). **Cost** (spend/hr by provider/model/tenant; tokens in/out; cost per 1k requests by task; BYOK vs SYSTEM split; top-10 tenants + "other"; budget burn-down; **unpriced-model counter**). **Governance** (active policy version per tenant; policy changes in last 24h with actor; kill-switches engaged).

**The cardinality rule, non-negotiable:** 500 tenants × 20 models × 7 providers ≈ **70k series per metric** before other labels — and histograms multiply that by bucket count. Therefore: **`tenant_id` on counters ONLY; NEVER on a histogram.** Latency histograms carry `provider` + `model` + `outcome`. Per-tenant latency comes from the usage/audit table, queried on demand. Precedent: Kong disables its AI metrics by default (`config.ai_metrics=true`) explicitly for cardinality, and LiteLLM makes the `model` label opt-in.

### 3A.8 Policy changes are auditable — this is a HIPAA requirement, not a nicety

**HIPAA §164.312(b) audit controls is a *required*, not addressable, standard.** A routing-policy change can redirect PHI to a different vendor, so it is squarely in scope: record **who, what, when, before/after, immutably**. Every policy mutation emits a sys-event and writes an AuditLog row; the previous version stays addressable for one-click rollback. Prior art for the rollout mechanics is the feature-flag world (Unleash ships an exportable audit log of every config change; LaunchDarkly does staged rollout + kill-switch), **not** the AI gateways — LiteLLM's admin UI has no dry-run, no audit trail and no kill switch.

### 3A.9 New lane

**Lane I — Routing policy plane.** *Owns `src/text/routing/policy.py`, the `RoutingPolicy` Prisma model + domain trio, its admin controller, and the `/ai-task-defaults` console extension.* Depends on Lane F (config plane) and merges after Lane C. Delivers: the §3A.3 schema, tenant→SYSTEM resolution, the §3A.4 STRICT ruling with its three hard gates and response headers, §3A.5 health semantics, the simulate/dry-run endpoint, and the §3A.8 audit trail. Tier `opus`, effort `high` — it decides where PHI goes.

---

## 3C. Resumable streaming — the design (owner ruling 2026-08-29)

**Requirement: nothing may be lost.** Reconnect after a tab close, network drop, laptop sleep,
gateway restart or router restart must resume the same generation with no gap and no duplicate.

### 3C.1 ⚠️ Correction: Redis was never the bottleneck

§2.3 ranked per-token `XADD`/`XREAD` as bottleneck B-1, "the dominant cost". **That was
overstated, and the plan is corrected here.**

Arithmetic at this platform's scale: 40 concurrent streams × ~100 tok/s = **4,000 tok/s**, so
per-token XADD plus XREAD delivery ≈ **8,000 Redis ops/s**. A single node benchmarks at
**~136,000 XADD/s, p50 0.191 ms** — so this is **~6% of one node's capacity, with ~16× headroom**,
adding ~0.4–1 ms against a 10–20 ms inter-token budget.

**The diagnosis was misplaced, not the symptom.** What is genuinely expensive per token is the
**Python tax** already identified in B-1: two JSON encode/decode passes, two pydantic validations
and two event-loop round trips — plus the 202-and-poll indirection itself. Coalescing collapses
that by roughly 10–40× *for the same durability*. Memory is the other real constraint
(~200 B/entry × 4,000/s ≈ 800 KB/s without `MAXLEN`), which batching also fixes.

**So: batch for the CPU and the memory, not for Redis.** And profile `apps/text` before sizing the
win — no published measurement splits the per-token cost across Redis, JSON and pydantic in a
FastAPI SSE router, so the 10–40× is arithmetic from op counts, not a benchmark.

### 3C.2 The providers cannot help — the router must own durability

| Provider | Resume |
|---|---|
| **OpenAI / Azure Responses** | **Yes** — create with `background: true, stream: true`; every event carries `sequence_number`; resume via `GET /v1/responses/{id}?stream=true&starting_after={n}`. Retention ~10 min; **streams older than ~5 min are refused** |
| **Anthropic** | **No.** Documented recovery is a **new, separately billed request** continuing from the captured prefix. Tool-use and thinking blocks **cannot** be partially recovered |
| **Bedrock** | **No resume documented** |
| **vLLM / LM Studio** | No |

Exactly one provider family offers resume, with a five-minute window. **A multi-provider router
cannot build its resume contract on the provider** — the buffer is ours.

### 3C.3 Architecture — one buffer, at the router

**Router owns durability. Gateway is a pure stateless relay. Browser owns its cursor.**

1. **Split producer from response.** `POST /generate` returns **200 + SSE immediately** — drop the
   202-and-poll indirection entirely. An `asyncio` task owns the provider socket and is the
   *producer*; the HTTP response is a *subscriber*. **Killing the response never kills the
   producer.** This is the shape vercel/resumable-stream and LibreChat both converged on.
2. **Dual-write, coalesced.** Producer appends the delta to an in-process ring buffer → writes to
   attached subscribers **first** → hands the batch to a flush task. Flush on **N = 16–32 deltas OR
   T = 25 ms, whichever first**. One `XADD text:gen:{gid} MAXLEN ~ 10000` **per batch**, fields
   `{seq, deltas[], type}`, `EXPIRE 3600`. The client's latency never waits on Redis.
   *Shipped precedents for the window: LibreChat 25 ms, S2 10 chunks / 50 ms, Temporal AI plugins
   100 ms. **Nobody who scaled this stayed at one durable write per token.***
3. **Terminal state goes to Postgres**, keyed by `generation_id` — that is the record of record.
   Redis is the replay buffer, not the store.
4. **Event ids: `id: {generation_id}:{seq}`.** The first event carries `generation_id` in `data` so
   the client can persist it *before any token arrives*.
5. **Resume endpoint** `GET /generations/{gid}/stream`: cursor from the `Last-Event-ID` header
   (canonical) or `?from=<seq>` (fallback for header-stripping proxies) → `XRANGE (gid seq+1 +` for
   the backlog → then tail live. Cursor ahead of the stream head (the dual-write race) → emit
   nothing, tail. Terminal → replay backlog + `done`, close. Unknown → **204**.
6. **Gateway: stateless relay.** Forwards `Last-Event-ID` upstream and `id:` downstream unchanged;
   sets `Cache-Control: no-cache`, `X-Accel-Buffering: no`, `Connection: keep-alive`. **On browser
   disconnect it drops only its own upstream subscription — it never cancels the router
   generation.** Keeping it stateless is what makes a gateway pod restart survivable.
7. **Browser:** a `fetch`-based SSE reader — **`EventSource` cannot set `Authorization` or
   `X-Tenant-Id` and cannot POST**, which is why every provider SDK uses `fetch`. Persist
   `{generation_id, last_seq}` per consultation in IndexedDB on every event, **and** store
   `activeGenerationId` on the consultation row server-side, because **`Last-Event-ID` does not
   survive a page reload** — the spec gives each new `EventSource` an empty buffer. Reconnect with
   capped exponential backoff + jitter.

### 3C.4 Disconnect detection is unreliable — do not build on it

- **`request.is_disconnected()` does not fire** for apps using `BaseHTTPMiddleware` (Starlette ≥ 0.21),
  and raises noisy `ClientDisconnected` on uvicorn 0.28.0.
- A vanished peer (sleep, NAT drop) is invisible to TCP until a **write fails** — which for a silent
  LLM can be minutes.

**Therefore:** generation lifetime is **never** derived from socket state. **Cancellation is an
explicit persisted flag** (`POST /generations/{gid}/cancel` → Redis flag, checked by the producer
between batches). A dropped socket is not a cancel.

This also **kills the lazy/spill-on-disconnect design** that looked attractive: disconnect detection
is precisely the unreliable part, so the gap between "client left" and "buffering started" is
unbounded — and that gap is exactly the data that must not be lost.

**Heartbeat is mandatory**, not optional: `sse_starlette` `ping=15`. Idle timeouts that will
otherwise kill a long clinical generation: **Cloudflare 100 s** (Free/Pro/Business → 524),
**AWS ALB 60 s**, nginx needs `proxy_buffering off; proxy_http_version 1.1; proxy_read_timeout <long>`
plus `X-Accel-Buffering: no` and gzip off on SSE routes. **Confirm what actually sits in the k3s
path and its configured idle timeout** — Lane G owns this.

### 3C.5 Abandonment is configuration, not a hardcoded policy

`db-config`, tenant → SYSTEM, per task key: `abandonOnDisconnect` (**default `false`** for clinical
summarization), `disconnectGraceSeconds`, `maxGenerationSeconds`. The grace timer starts on
**heartbeat write failure**, not on `is_disconnected()`. An expensive summarization and a cheap
classification should differ, and that is a tenant-visible cost decision, not a code constant.

### 3C.6 Idempotency — at-least-once delivery, exactly-once effect

`Idempotency-Key` on create (Standards Track, `draft-ietf-httpapi-idempotency-key-header-07`,
2025-10-15). Router maps key → `generation_id` and returns the same id on retry; payload mismatch →
**409 `idempotency_conflict`**. The terminal write to the consultation/document is keyed by
`generation_id`, so replaying the terminal event is a **no-op** — that is what makes at-least-once
delivery safe. Conversation and document state are separately checkpointed, never reconstructed
from token replay.

### 3C.7 Provider bonus: survive a router restart on OpenAI/Azure

When the resolved provider is OpenAI or Azure Responses, create with `background: true,
stream: true` and persist `response.id` + `sequence_number`. **A router pod restart then becomes
survivable** — re-attach with `starting_after`, subject to the ~5-min streaming and ~10-min
retention windows. For Anthropic, Bedrock and self-hosted engines this is impossible; the fallback
is re-issuing with the persisted prefix as a continuation (Anthropic's documented technique) — **a
new billed request**, under the same idempotency key.

### 3C.8 Failure matrix — what the user sees

| Failure | User sees | Recovered |
|---|---|---|
| Browser tab closed | On reopen, the consultation shows an in-flight generation and streams the backlog, then live | **Everything** — the producer never stopped |
| Network drop / laptop sleep | Brief stall, then text resumes exactly where it stopped | **Everything** — `Last-Event-ID` → `XRANGE seq+1 +` |
| **Gateway pod restart** | One reconnect stall | **Everything** — the gateway holds no state; a new pod re-subscribes at the browser's cursor |
| **Router pod restart** | Stall, then either seamless continuation (OpenAI/Azure only), or a visible "resuming" state, or an explicit failure with all prior text intact | **All flushed tokens.** ≤ 25 ms of unflushed deltas can be lost — **and those were never delivered to anyone**, so no user-visible gap |
| Provider error mid-generation | Partial text stays, explicit error event + "Continue" | **All tokens up to the error**, persisted. Retry is a new provider call with the prefix as continuation; same `generation_id`, so no double-write |

---

## 3B. The guardrail gate — specified (owner ruling 2026-08-29)

The owner named two uses with very different latency budgets:

1. **Authoring-time** — a *tenant admin* manages prompts / agent instructions; guardrail validates
   them. A human waits on a form submit. Seconds are fine.
2. **Runtime** — pre-summarization / summarization requests, where the clinical content's validity
   is unknown. Latency-sensitive clinical hot path.

### 3B.0 Two findings that constrain the whole design

**⚠️ "Prompt Overflow" — a guardrail that inspects less than the model infers is not a guardrail.**
Guardrail models inspect a **truncated window** while the downstream LLM processes the **full
context**; harmful instructions fragmented across an overlong prompt pass every inspected segment
while remaining actionable. Demonstrated against Llama Prompt Guard, IBM Granite Guardian and
DeBERTa detectors (arXiv:2605.23196, 2026-05-22). **This bites us directly** — clinical transcripts
are long. The T0 tier below therefore asserts *inspection window ≥ model window*, and **chunks
rather than truncates**.

**⚠️ Guardrails are a DoS target, and that makes `timeout ⇒ fail-open` a safety bypass.** Crafted
input traps LLM-based guardrails in extended reasoning loops: **13–63× token amplification, up to
148× latency amplification**, and a single poisoned document can saturate *shared* guardrail
infrastructure (arXiv:2606.14517, 2026-06-12). An attacker who can manufacture timeouts owns the
bypass. Hence §3B.4, and hence a hard token + wall-clock cap on every judgement call — the existing
judge lane's concurrency budget is necessary but not sufficient.

### 3B.1 Use 2 — the runtime gate stays inline, tiered, and overlapped

**Keep it inline. Do not move it to the caller.** But restructure it so "inline" stops meaning
"serial".

- **Run it concurrently with request setup** — config resolution, tenant-config, credential
  resolution, retrieval. Setup already costs tens of ms, so a ~20–100 ms classifier is largely
  absorbed. This is the free win, and it is what NeMo's `parallel: True` and every practitioner
  source recommend.
- **Tier it:**

| Tier | What | Budget | When |
|---|---|---|---|
| **T0** | Deterministic: PHI-pattern scan, size/structure limits, **and the window assertion above** — if content exceeds the classifier window, chunk and check every chunk | ~1 ms | Always |
| **T1** | Small classifier — injection + a **clinical-aware** harm taxonomy resolved tenant → SYSTEM via `AiModel._metadata.labelTaxonomy` | ~20–100 ms | Always |
| **T2** | LLM judge over the existing ungated judge lane | ≤ 1.5 s hard cap | **Only on T1 ambiguity**, and never inline on a streaming summary |

  Reference latencies (ranking is robust; absolute ms are not — benchmark on our own hardware with
  clinical-length inputs): regex ~0.4 ms · Prompt-Guard-2-22M ~19 ms · Prompt-Guard-2-86M ~92 ms ·
  Llama Guard 3 1B ~53 ms · 8B ~111 ms · LLM-as-judge, seconds.

- **Budget: T0+T1 p95 ≤ 120 ms, fully overlapped with setup ⇒ ~0–40 ms net added TTFT.**

**Do NOT speculatively dispatch to the provider before the T0+T1 verdict.** OpenAI's Agents SDK
runs guardrails in parallel with the agent *by default* and documents that "the agent may have
already consumed tokens and executed tools before being cancelled" — but that framing is written for
a non-regulated default. For PHI the objection is not token cost: **an LLM call is a disclosure.**
If the verdict was "this should never have gone to provider X," speculation means it already did.
Speculate only *inside our own trust boundary* — warm the connection, resolve credentials,
pre-tokenize. Same latency win, no disclosure.

### 3B.2 ⚠️ A general harm taxonomy will block valid clinical documentation

This is documented, not theoretical: Azure's self-harm classifier blocks routine psychiatric
documentation (*"suicidal ideation denied"*) and surgical/emergency notes mentioning cutting,
bleeding, amputation or risk of death, and customers report being unable to fully exempt clinical
text (Microsoft Q&A 5624982).

**Consequence:** the runtime taxonomy must be clinical-context-aware and **tenant-resolved** — which
is exactly what `AiModel._metadata.labelTaxonomy` already provides (TASK-735 Phase 6). Do not ship a
fixed harm set. And **track false-positive rate as a first-class metric** (§3B.5): over-blocking a
clinician is a patient-safety failure, not a tuning inconvenience.

### 3B.3 Use 1 — authoring-time, two phases

Called synchronously by the **admin BFF** on form submit. It is not on the router's hot path at all.

- **Phase 1 — synchronous, ≤ 2 s p95, blocking:** deterministic lint, PHI-in-template scan,
  policy/taxonomy conformance, output-schema check, plus one small-classifier injection pass.
- **Phase 2 — async job, minutes:** curated adversarial suite (promptfoo-style critical set) over
  the ungated judge lane. The result attaches to the prompt **version** as a validation record.

**Lifecycle:** save → `PENDING_VALIDATION`; promotion to `APPROVED` requires Phase 2 green.
Adversarial red-teaming of a template does not fit a form submit, and pretending otherwise produces
a validation that proves only that the prompt is well-formed.

### 3B.4 Authoring-time trust — yes, for the template only

**A prompt validated at authoring time may skip its own runtime re-validation**, which removes the
per-request re-scan of long instruction sets. That is real waste eliminated. Seven conditions, and
condition 5 is non-negotiable:

1. **Immutable and content-addressed.** Runtime loads by `promptVersionId` + content hash, never a
   mutable name. Any edit creates a new version in `PENDING_VALIDATION`.
2. **The stamp binds every input to the verdict**: `{contentHash, policyVersion, guardrailModelVersion,
   taxonomyVersion, thresholdSet, tenantId, validatedAt, validatorIdentity}`, HMAC-signed so a DB
   write alone cannot forge it.
3. **Any policy / guardrail-model / taxonomy version change invalidates every stamp issued under the
   old versions, en masse.** The stamp is a cache entry; it dies when its key components change.
4. **Scoped to the validating tenant.** A SYSTEM template inherited by a tenant is trusted only
   under that tenant's resolved policy version.
5. **The runtime prompt is `template ⊕ clinical_content`. Only the template is trusted. The clinical
   content is untrusted every single time**, and the *composition* is re-checked for window overflow
   (§3B.0) and for injection carried in the content. Without this condition the whole scheme is a
   safety bypass, not an optimisation.
6. The template's own validation must have been **adversarial**, not merely structural.
7. **Bounded validity** — expire stamps (≈90 days) and re-validate on a model/provider change, since
   injection resistance is model-dependent.

*Honest status: no vendor or framework publishes this pattern.* It is synthesised from immutable
prompt registries (MLflow Prompt Registry, LangSmith Hub) and LLM cache-key completeness rules.
Treat it as a reasoned design, and note arXiv:2605.23196 is direct evidence against the naive
version of it.

### 3B.5 Verdict caching

**Exact hash only. Never semantic.** Guardrail verdicts are adversarially sensitive — near-identical
inputs can legitimately have opposite verdicts, so approximate matching is unsound here even though
it is fine for answer caching.

Key: `sha256(normalized_content) | policyVersion | guardrailModelVersion | taxonomyVersion |
thresholdSet | tenantId`. **Omit `tenantId` and you serve one tenant's policy verdict to another** —
the same failure the `AppSettingsService` cache rule already guards against. Short TTL as a
staleness backstop; **invalidation via the existing Redis channel on any policy/model/taxonomy write
is the propagation mechanism**, per §Config caches.

### 3B.6 Streaming output moderation

Summaries are the higher-risk direction — PHI leak and ungrounded clinical claims. If output is
moderated while streaming, use **buffered/synchronous chunk moderation** (Bedrock `SYNCHRONOUS`,
Azure Default). TTFT cost ≈ one buffer's generation time.

**Async-with-retraction is the wrong posture here, on both vendors' own guidance:** Bedrock
**cannot mask PII at all in `ASYNCHRONOUS` mode**, and Microsoft explicitly scopes its Asynchronous
Filter *away* from regulated industries, naming "customer-facing chatbots in regulated industries"
as the Default-mode case.

### 3B.7 Fail posture — closed on both, with a distinguished timeout path

| Condition | Action |
|---|---|
| Definitive violation, or an attributable 4xx/5xx | **Block.** 503 to caller, audited |
| **Timeout** | **Block, not allow.** See §3B.0 — 148× latency amplification makes timeout an attacker-reachable state, so `timeout ⇒ open` converts a DoS into a safety bypass |
| Retry | Exactly one, **on timeout only**, on T0/T1 only, within the remaining request deadline. **Never retry the LLM judge** — that is what the DoS amplifies. Never retry a definitive violation |
| T2 unavailable | **Degrade to T1 at a stricter threshold — never to "allow."** T0/T1 are in-process/small-model and must have a better availability profile than the router, which the judge lane depends on |
| Kill-switch | Exists, **platform-admin only, defaults OFF, time-boxed, audited on every invocation** — `redis-flag` tier semantics |

This is consistent with the platform's own rule that `failMode` governs an **absent value** only —
*a backend error propagates and is never disguised as "the default."* **A guardrail timeout is a
backend error, not an absent value.**

**Per-tenant configurability is a one-way ratchet.** A tenant may make it stricter (lower thresholds,
force T2 always); it can never go below the SYSTEM floor. A symmetric per-tenant `fail_open` is a
customer-facing off-switch for safety — indefensible for PHI, and it breaks "entitlements bound,
they never supply".

### 3B.7b Realtime consultation — see TASK-825

The realtime-consultation application of this gate (validate a partial transcript once at the STT
boundary, fan out to summarization / NER / grammar; two independent verdict axes; alerts to the
clinician) is specified separately in **TASK-825**, because it spans `apps/{stt,guardrail,harness,nlp,text}`
and the admin console rather than `apps/text` alone. §3B here remains the policy; TASK-825 is its
realtime instance.

### 3B.8 PHI and audit obligations on the guardrail hop

- **The guardrail hop processes PHI.** Any vendor whose infrastructure sees it is a business
  associate and needs a BAA. Verified coverage: OpenAI `/v1/moderations` **is** ZDR-eligible (and
  ZDR is an account-team opt-in, not a self-serve toggle; without it, abuse-monitoring logs retain
  up to 30 days). Azure is covered under the Online Services DPA **but default abuse monitoring
  retains prompts 30 days with possible human review** — PHI workloads must apply for **Modified
  Abuse Monitoring**, for which **only EA/MCA-E Managed Customers are eligible**. Bedrock's
  HIPAA-eligibility is **per-model**, not blanket.
- **Minimum necessary (§164.502(b)) applies here too** — sending a whole chart to a classifier when
  one section needs checking is itself a violation.
- **Log the decision, not the content.** Per decision: verdict, category + confidence, policy
  version, guardrail model id + version, taxonomy version, tenantId, requesting principal, latency,
  fail-posture taken, and a **content digest** — never the content.
- **⚠️ EU AI Act Article 12 is already in force.** Full application for high-risk systems began
  **2 August 2026** — three weeks before this ticket was written — and healthcare is Annex III
  high-risk. It requires **automatic** logging over the system lifetime, generated at the moment
  events occur (no scheduled export), **minimum 6-month retention**, and regulators read
  "appropriate to the intended purpose" as tamper-evident. This is a present obligation, not a
  roadmap item, and it applies to the audit plane OPEN-3 just moved off the hot path.
- **Metrics:** block rate by category, **false-positive rate** (§3B.2), p50/p95/p99 guardrail
  latency, timeout rate, cache hit rate, fail-posture invocations.

---

## 4. Best-Practice Reference (researched 2026-08-29; apply, don't re-derive)

### 4.1 Build vs adopt — keep Python, keep the hot path lean

- LiteLLM's own harness (4 vCPU/16 GB, mock upstream): **LiteLLM Python p99 added latency
  257.7 ms**, 330 MB RSS — versus their Rust rewrite at 0.7 ms, Bifrost 4.5 ms, Portkey OSS
  2.3 ms, ~2,814 RPS. <https://docs.litellm.ai/blog/rust-ai-gateway-benchmarks> (2026-07-22)
- Independent run: Bifrost 1.70–2.08 ms flat; LiteLLM 19.31 ms @5 VUs → 66.13 ms @20 VUs.
  <https://ravishtiwari.medium.com/ai-gateway-benchmark-bifrost-vs-litellm-e983541c4d9f> (2026-07)
- **But** Portkey (not Python) reportedly lands at **20–40 ms once guardrails and routing are
  enabled**. <https://www.deepinspect.ai/blog/ai-gateway-latency-benchmarks> (2026-06)
- Envoy AI Gateway v1.0 covers multi-provider + multi-tenant but **publishes no per-request
  overhead benchmark**. <https://aigateway.envoyproxy.io/release-notes/>
- Gateway API Inference Extension is explicitly scoped to **self-hosted models on k8s** — it
  is the right tool *in front of your vLLM pods*, not a replacement for per-tenant BYOK
  routing to Azure/Bedrock/Anthropic. <https://gateway-api-inference-extension.sigs.k8s.io/>

**Conclusion adopted:** keep and harden Python. The evidence supports *"feature-laden proxies
cost tens of ms regardless of language"* at least as strongly as *"Python is the problem"* —
and nobody has published a lean-Python-proxy benchmark to settle it. **Revisit only if
measured p99 overhead exceeds ~10 ms after Phase 2.** Against a real provider (TTFT
500 ms–5 s) a 1–10 ms gateway is <2% of end-to-end latency.

### 4.2 Python egress-proxy technique

- **Do not pydantic-validate pass-through bodies.** msgspec decodes *and validates* faster
  than orjson decodes alone; ~12× faster than pydantic v2.
  <https://msgspec.dev/benchmarks>. The real win is validating **only the routing envelope**
  (tenant, model, stream) and forwarding body bytes untouched.
- **Streaming**: `client.stream(...)` + `aiter_bytes()`/`aiter_raw()` — never load the body.
  Starlette's streaming response **respects TCP backpressure**: a slow client blocks the send
  which throttles the generator, self-regulating. Use `await request.is_disconnected()` to
  abandon the upstream call early.
  <https://deepwiki.com/fastapi/fastapi/3.7-streaming-responses>
- **SSE buffering is usually the ingress, not the app**: needs `proxy_buffering off`,
  `proxy_http_version 1.1`, `Connection ''`; emit `Cache-Control: no-cache` and
  `X-Accel-Buffering: no`. <https://github.com/fastapi/fastapi/discussions/6173>
- **httpx pooling**: defaults are `max_connections=100, max_keepalive_connections=20,
  keepalive_expiry=5.0` — too small for a busy egress proxy, and the expiry silently
  mismatches upstream idle timeouts, handing you reaped sockets. Size keepalive to real
  concurrency; set `keepalive_expiry` **below** the provider/LB idle timeout; use **one client
  per upstream**, not one global. <https://www.python-httpx.org/api/>
- httpx ≥0.28: the param is `proxy=` (not `proxies=`); per-request `stream=` is gone — use
  `client.stream()`.
- **Granian** (Rust ASGI) showed ~35% plaintext throughput over uvicorn with a tighter
  avg→max spread; guidance is that uvicorn+gunicorn is the lower-risk default and Granian is
  for *measured* server-level bottlenecks on low-logic services. **Trial, do not adopt blind.**
- **Free-threaded Python**: 3.14t is PEP 779 "supported" and asyncio has first-class
  free-threaded support since 3.14. **Irrelevant to the 3.11 pin today** — it is an argument
  for planning a 3.14t track, not a workaround.
- **No 2026 benchmark settles httpx vs aiohttp** for a streaming egress proxy at this scale.
  Treat "switch to aiohttp" as unevidenced; do not do it in this ticket.

### 4.3 The blocking-SDK hazard (Bedrock, B-3)

- aiobotocore/aioboto3 are **not** a clean fix — open issues: *"aiobotocore blocks the event
  loop with I/O in several locations"* (<https://github.com/aio-libs/aiobotocore/issues/1023>),
  *"async code calls synchronous functions of boto3"* (#940), aioboto3 blocks on session/
  resource creation (<https://github.com/terricain/aioboto3/issues/254>).
- langchain-aws confirms it in the Bedrock path specifically: *"ChatBedrockConverse and
  BedrockEmbeddings async methods wrap sync boto3, so I/O isn't truly async."*
  <https://github.com/langchain-ai/langchain-aws/issues/663> (2025-09-29)
- **Adopted:** *structural* — call the Bedrock HTTP API directly over the shared httpx client
  with **SigV4-signed requests**, using botocore only to compute the signature (offline, no
  I/O). One connection pool, one streaming path, one retry policy, one timeout budget across
  all providers. *Fast win in the interim* — a **bounded dedicated** `ThreadPoolExecutor`
  sized to Bedrock concurrency (never the default executor, which the SDK monopolises).

### 4.4 Routing and resilience

- **Rate limiting must be token-aware, not request-aware.** RPM and TPM are independent; a
  50K-token request must drain the bucket differently from a 500-token one.
  <https://www.metacto.com/blogs/llm-rate-limiting-token-quotas-production> (2026)
- Shape: **token bucket per user for burst + sliding window per tenant for the contractual
  limit, in series.** Fixed-window counters allow a 2× boundary spike and must not back an
  SLA. Soft limit → **429 + `Retry-After`**; hard cap → 403. Surface `RateLimit-Remaining`.
  <https://www.truefoundry.com/blog/rate-limiting-in-llm-gateway>
- **Retries**: ≤3, exponential backoff, **always jitter even when you have an exact wait**
  (else every limited caller retries on the same tick), honour `Retry-After`.
  <https://www.getmaxim.ai/articles/retries-fallbacks-and-circuit-breakers-in-llm-apps-a-production-guide/>
- **Fallback chain**: practical 2026 recommendation is two cross-provider fallbacks plus one
  on-premises option, with a per-provider breaker skipping to the next while open.
- **Hedging**: fire only after a delay tuned near p95, only where tail latency matters —
  otherwise you pay double tokens on every request.
  <https://tianpan.co/blog/2026-05-02-tail-tolerant-retry-policy-llm-gateway-latency-cliff>
- **Prompt caching is the highest-value routing constraint available.** Anthropic's cache is
  **byte-exact on the prefix**, not semantic. Concrete proxy rules — *do no harm*:
  1. **Never reorder, normalise or re-serialise the message array.**
  2. **Never inject a per-request header or system preamble ahead of the cached prefix.**
  3. Make the load balancer **cache-affinity aware** — a tenant's repeated prefix should land
     on the same deployment (OpenRouter calls this provider sticky routing).
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> ·
  <https://openrouter.ai/docs/guides/best-practices/prompt-caching>
- **Self-hosted vLLM fleets**: prefix-cache-aware routing belongs in an Inference Gateway
  (GAIE EPP, approximate or precise via KV-Events) **in front of the vLLM pods, behind this
  proxy** — not in this proxy.
  <https://github.com/llm-d/llm-d/blob/main/guides/precise-prefix-cache-aware/README.md>

### 4.5 Caching and cost — the PHI ruling

- **GPTCache last updated July 2025** — treat as unmaintained; not a 2026 dependency.
- **Semantic caching is disqualified for clinical content.** Reported incident: a team enabled
  semantic caching, saw a 38% bill drop, and had the cache return **one customer's
  cancellation summary into a different customer's session**.
  <https://futureagi.com/blog/what-is-semantic-caching-llms-2026/> (2026)
  **Ruling for this ticket: no semantic/approximate-match caching of clinical content, at any
  similarity threshold.** Exact-hash caching is permitted only when the key includes
  `tenantId`, the TTL is short, and the content is non-PHI. The existing `Idempotency-Key`
  path (B-12) already satisfies this and is the only response cache we keep.
- **The safe cost lever is provider-side prompt caching** (4.4) — exact, provider-enforced,
  tenant-scoped by credential, and structurally incapable of cross-tenant leakage.
- **Token accounting off the hot path**: prefer the provider's returned `usage` over local
  tokenisation; emit as an async event, not an inline write. For streams, capture usage in the
  terminal chunk during stream teardown — never by re-parsing the stream.

### 4.6 Observability

- **OTel GenAI conventions are NOT stable.** As of 2026-07-17 every `gen_ai.*` attribute,
  span, metric and event carries the **"Development"** badge. On **2026-06-12 (semconv
  v1.42.0) all GenAI conventions were deprecated in the main repo and moved to
  `open-telemetry/semantic-conventions-genai`, which has no releases or tags** — so there is
  **no versioned schema URL to pin against**.
  <https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/>
  **Adopted:** emit them, but **behind our own mapping layer** so a rename is a one-file change.
  Use `gen_ai.client` spans with `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`.
- **Metrics a router must expose**: TTFT, inter-token latency, output tokens/sec per stream,
  p99 TTFT under concurrency, 5xx rate at spike, **queue depth**, **active streams**.
- **Cardinality**: never label with prompt/response text, conversation id, request id, or
  unbounded user id. Redesign if potential cardinality exceeds ~100 per metric. Precedent:
  **LiteLLM makes the `model` label opt-in and off by default**
  (`PROMETHEUS_INCLUDE_MODEL_LABEL`). <https://docs.litellm.ai/docs/proxy/prometheus>
  **Adopted:** tenant goes on **exemplars/traces, never on a metric label**.
- **TTFT through a proxy** must be measured as *first byte forwarded to the client*, and
  reported alongside *first byte received from the provider*. **The delta is our actual
  overhead** and it is the number this ticket is judged on.

### 4.7 Deployment

- **Do not scale an I/O-bound proxy on CPU.** Use request-queue length / latency / custom
  metrics via Prometheus Adapter or KEDA. For an LLM proxy the right signal is **in-flight
  upstream requests per pod (concurrency)** — long streams make RPS meaningless.
  <https://oneuptime.com/blog/post/2026-02-20-kubernetes-hpa-custom-metrics/view>
- **Graceful shutdown with in-flight streams**: handle SIGTERM explicitly, track in-flight to
  know when exit is safe, and set `terminationGracePeriodSeconds` **greater than max stream
  duration** — a long clinical summarisation runs minutes; a short grace period cuts
  clinicians off mid-generation. Keep **scale-down stabilisation ≥ 300 s**.
- Set `publishNotReadyAddresses: true` on the metrics Service so Prometheus keeps scraping
  terminating pods — otherwise you lose exactly the shutdown data you need.

### 4.8 Benchmarking honestly

- Tooling: k6 / Locust / vegeta for the proxy; genai-perf / llmperf for model-side numbers.
- Method: 50–200 concurrent users sustained ~10 min; record **p50/p95/p99 TTFT, output
  tokens/sec, full request latency, 5xx at spike**; sweep concurrency until throughput
  plateaus then degrades — that inflection is the saturation point.
- **Mock the upstream, but publish both numbers.** The dominant 2026 methodological failure is
  measuring only against a mock, which deletes provider latency and lets published figures
  span five orders of magnitude (11 µs → 40 ms). Run **(1)** a zero-latency mock to isolate
  proxy overhead and **(2)** a **latency-injecting** mock (e.g. 800 ms TTFT, 30 tok/s) to
  measure realistic connection-hold time — **(2) is what exposes pool exhaustion.**

---

## 5. Verification Criteria (the numbers this ticket is judged on)

D-3 selected **concurrent streams** as the target, so the acceptance criteria are stated in
stream terms. All measured against the Lane H harness, both mock modes.

| # | Criterion | Target | How measured |
|---|---|---|---|
| AC-1 | Concurrent SSE streams per pod, sustained 10 min, zero drops | **≥ 100** (2.5× the 40 in-flight day-1 target) | Latency-injecting mock @ 800 ms TTFT, 30 tok/s |
| AC-2 | Steady-state RSS per active stream | **< 50 KB** | RSS delta / stream count at plateau |
| AC-3 | Proxy-added TTFT (client first byte − provider first byte), p99 | **< 10 ms** | Both mocks; report both numbers per §4.6 |
| AC-4 | Proxy-added inter-token latency, p99 | **< 2 ms** | Latency-injecting mock |
| AC-5 | Redis writes per streamed token | **≤ 1 per 16–32 deltas or 25 ms**, not per token (§3C.2) | Instrumented |
| AC-15 | Reconnect after a forced disconnect mid-generation | Resumes at `seq+1`, **no gap, no duplicate** | Kill the client socket at a random point; diff the reassembled output against an uninterrupted run |
| AC-16 | Gateway pod restart during an active stream | Zero tokens lost; one reconnect stall | Rolling restart under load |
| AC-17 | Router pod restart during an active stream | All flushed tokens recovered; loss bounded by one batch and never user-visible | Rolling restart under load |
| AC-18 | A dropped socket never cancels a generation | Producer continues; only an explicit cancel stops it | Contract test |
| AC-6 | Streams dropped during a rolling restart | **0** | Rolling deploy under AC-1 load |
| AC-7 | Non-streaming p99 added latency / RPS per core | **< 10 ms / ≥ 500 RPS-core** | Zero-latency mock |
| AC-8 | Concurrent Bedrock streams before executor starvation | **≥ AC-1**, no cross-provider impact | Mixed-provider mock run |
| AC-12 | Explicit-provider request whose provider is down | Returns **503 `provider_unavailable`**, never a silent substitution (§3.4) | Contract test per §3.4 |
| AC-13 | Permitted fallback is signalled on every response | `x-hope-provider-requested` / `-served`, `x-hope-fallback-step`, `-reason`, `x-hope-funding` all present | Contract test |
| AC-14 | Both interfaces serve the same routing core | OpenAI-standard and HOPE contracts produce identical routing decisions for equivalent inputs | Differential test |
| AC-9 | `apps/text` cannot serve a model | Automated test fails the build on any inference-runtime import or weight path | New `test_no_serving_invariant.py` (Phase 0) |
| AC-10 | Config lookups doing I/O per request | **0** | Preserved property; regression test |
| AC-11 | Prometheus series count per metric | **< 100** potential cardinality; tenant absent from labels | Metric registry assertion test |

**No baseline exists.** `apps/text/tests/load/locustfile.py` is a resilience/correctness smoke
test (asserts status codes and `Retry-After` headers against `provider="lm-studio"` only), and
`docs/` contains no recorded throughput or latency figures anywhere. **Phase 0 must capture a
"before" run** or none of the above is provable.

---

## 6. Implementation Plan

### 6.0 Rules for every agent on this ticket

Non-negotiable, from `.claude/rules/14-multi-agent-worktrees.md`:

1. **One writer per working tree.** Each lane gets its own `git worktree`, branched from
   **`dev-2.2`** (not `dev`). Name it after the lane: `../hope-v2-task-818-lane-a`.
2. **The orchestrator owns shared surfaces alone**: merges, branch switches, `pnpm install`,
   `pnpm db:push` / `db:migrate` / `test:db:reset`, and every Docker/infra command. A lane
   agent that resets the DB while a sibling runs integration tests destroys both runs.
3. **Never `git stash` in a worktree** — the stash stack is repo-wide. Commit, then
   `git checkout HEAD~1 -- <path>` for a baseline.
4. **Copy `.env.dev` / `.env.test` into the worktree** — gitignored files do not follow, and
   conda `arcaenv` editable installs still point at the PRIMARY checkout, so **Python work
   generally belongs in the main tree**, not a worktree. Coordinate with the orchestrator.
5. **Merge before cleanup, always.** Finish → gates green → orchestrator merges into `dev-2.2`
   from the primary checkout → re-run gates after the merge → only then remove the worktree.
   Never `git worktree remove --force` or `prune` with unmerged commits.
6. **Evidence, not assertions.** Every report pastes actual command output. "tests pass" with
   nothing pasted is not a result.
7. **TDD.** Failing test first, watch it go RED, minimal green, refactor. `.claude/rules/01`.
8. **Never run `pnpm gen:mapper`** — it is destructive and strips the `_version` OCC guard.
9. Python gates per lane: `pnpm text:test`, `pnpm text:lint`, `pnpm text:typecheck`. Do **not**
   run `apps/compat-playground`, `apps/quick-compat-app` or `packages/ui` suites.
10. **Nothing in this ticket may reintroduce a hardcoded model id, engine name, endpoint,
    threshold or credential**, nor a `pydantic-settings` default that is a real selection.
    AC-9's test is the backstop; do not weaken it.

### 6.1 Phase 0 — Baseline and decomposition (orchestrator / single writer, main tree)

**This phase is serial and must complete before any lane starts.** It removes the file
contention that would otherwise force lanes to collide on `generate.py` (1076 lines).

| Step | Work | Verify |
|---|---|---|
| 0.1 | Capture the **"before" baseline** with the current code using the Lane H harness spec (§6.9). Both mock modes. Record every AC-1..AC-8 number into `docs/implementation/TASK-818-Text-LLM-Router/baseline.md`. | Numbers committed |
| 0.2 | Write `apps/text/src/text/tests/unit/test_no_serving_invariant.py` — **AC-9**. Assert: no inference-runtime module is importable from the `text` closure; no `from_pretrained`/`AutoModel`/weight-path/`HF_HOME` reference in `apps/text/src`; no `subprocess`/`Popen`/`create_subprocess`/`multiprocessing`; every adapter's `default_model == ""`. Model it on the existing `test_no_model_default_d7.py:176-184`. | Test RED against a deliberately-added violation, then GREEN |
| 0.3 | Fix V-1..V-7 (§2.2): rewrite the compose comment and `docs/operations/inference/README.md` to say "seed a SYSTEM-tenant `AiProviderConnection` row carrying the engine `baseUrl`" per `core/connection.py:21-29`; fix `apps/text/README.md:58`, `main.py:181-182`, `judge.py:25`; delete `apps/text/.deepeval`. | grep for the three dead `TEXT_*_BASE_URL` names and `.env.prod` returns nothing outside tests that ban them |
| 0.4 | **Decompose `api/endpoints/generate.py`** into `src/text/routing/{admission,dispatch,streaming,nonstreaming}.py` with `generate.py` reduced to thin route handlers. **Pure move, zero behaviour change** — the full existing test suite must stay green with no test edits. | `pnpm text:test` green, **no test file modified** |
| 0.5 | Commit on `dev-2.2` so every worktree branches off a base containing it. | `git log` |

### 6.2 Phase 1 — Parallel lanes A · B · F · H

#### Lane A — Egress client layer *(owns `src/text/providers/**`, `src/text/core/connection.py`)*

Fixes **B-2, B-3, B-8**. This is the highest-value lane after B.

- **A-1 — Keyed client cache.** Replace per-request client construction in `openai.py:91`,
  `azure_openai.py:114`, `anthropic.py:97`, `vertex.py:150`, `bedrock.py:78-88`,
  `openai_compat.py:139-144` with an LRU+TTL cache keyed by
  `(provider, base_url, credential_fingerprint)` — fingerprint is a salted hash, **never the
  credential**. **The multi-tenant isolation property the current comments defend must be
  preserved**: two tenants with different credentials must never share a client. Two requests
  from the *same* tenant with the *same* credential must. Cache eviction on
  `arca:config:invalidate` (`effective_config.py:323`) so a rotated key is dropped immediately.
  `openai_compat` (`SELF_HOST`, LM Studio) has no BYOK reason to pay this at all — key it on
  `base_url` alone.
- **A-2 — Per-upstream httpx pools with tuned limits.** One client per upstream, not one
  global (§4.2). Set `max_keepalive_connections` to real per-upstream concurrency, and
  `keepalive_expiry` **below** each provider's idle timeout. All values from the config plane
  (`AiProviderConnection` / `AiRuntimeProfile`), **never hardcoded, never env**.
- **A-3 — HTTP/2**: enable on self-hosted upstreams (vLLM/Ollama/llama.cpp/TEI) where
  multiplexing removes the per-stream TCP connection (B-8). Benchmark before enabling on
  vendor endpoints — measure, do not assume.
- **A-4 — Bedrock de-blocking (B-3).** Interim: bounded **dedicated** `ThreadPoolExecutor`
  sized to Bedrock concurrency — never the default executor. Target: **SigV4-signed direct
  HTTP over the shared httpx client**, botocore used only to compute the signature (§4.3).
  Ship the interim in Lane A; the direct-HTTP conversion may land in Phase 2 if the interim
  meets AC-8.
- **A-5 — Fix `_last_base_url` (V-6)**: make the probe path take an explicit URL argument; no
  process-wide endpoint memo survives.
- **A-6 — New adapters**: **Azure AI Foundry** as its own provider (its surface differs from
  `azure_openai.py`), and **LM Studio** as its own provider identity over `openai_compat` so
  tenant config and the admin console can name it. Both `default_model=""`, fail-closed.
- **A-7 — Prompt-cache do-no-harm (§4.4)**: audit every adapter for message reordering,
  normalisation, re-serialisation, or preamble injection ahead of the cached prefix. Add a
  test per adapter asserting byte-stable prefix pass-through.

**Gates:** `pnpm text:test text:lint text:typecheck`; `test_provider_*`, `test_azure_provider`,
`test_bedrock_provider`, `test_bedrock_async_stream`, `test_ollama_provider`,
`test_openai_compat_provider`, `test_tei_embed_provider`, `test_task799_provider_discovery`
all green **unmodified except where the ticket explicitly changes contract** — and where you
must modify one, say so and why in the report.

#### Lane B — Resumable streaming *(owns `routing/streaming.py`, `api/endpoints/stream.py`, `services/task_manager.py`, `api/endpoints/tasks.py`, and the producer/subscriber split)*

**Rewritten 2026-08-29.** The original brief said "delete the durable-state plane." **The owner
ruled that resumability is required and nothing may be lost**, and the cost premise behind that
deletion was wrong (§3C.1 — Redis runs at ~6% capacity here). Lane B now **restructures** the plane.
Read **§3C in full** before starting; it is the specification.

- **B-1 — Producer/subscriber split.** `POST /generate` returns **200 + SSE immediately**; drop the
  202-and-poll indirection. An `asyncio` producer task owns the provider socket; the HTTP response
  is a subscriber. **Killing the response must never kill the producer** — that property is the
  whole ticket.
- **B-2 — Dual-write, coalesced.** Deltas go to attached subscribers **first**, then to a flush task
  batching on **N = 16–32 deltas OR T = 25 ms**. One `XADD … MAXLEN ~ 10000` per batch. The
  client's latency never waits on Redis. Remove the per-chunk JSON + pydantic on both sides — that
  is the actual win.
- **B-3 — `id: {generation_id}:{seq}` on every event**, and `generation_id` in the first event's
  `data` so a client can persist it before any token arrives.
- **B-4 — Resume endpoint** `GET /generations/{gid}/stream` per §3C.3(5), honouring `Last-Event-ID`
  and `?from=`, including the cursor-ahead-of-head race and the **204** for unknown.
- **B-5 — Cancellation is an explicit persisted flag**, checked between batches. **A dropped socket
  is never a cancel** (§3C.4). Do **not** build on `request.is_disconnected()` — it does not fire
  under `BaseHTTPMiddleware`.
- **B-6 — Heartbeat `ping=15`** and the SSE headers; coordinate the ingress half with Lane G.
- **B-7 — Terminal state to Postgres** keyed by `generation_id`; Redis holds the replay buffer only.
- **B-8 — Idempotency** per §3C.6: key → `generation_id`, 409 on payload mismatch, terminal write is
  a no-op on replay.
- **B-9 — Abandonment as config** (§3C.5), tenant → SYSTEM, `abandonOnDisconnect` defaulting
  **false**. Never a hardcoded constant.
- **B-10 — Delete only what is genuinely dead**: the batch/worker-pool plane
  (`worker.py`, `services/worker_pool_queue.py`, `api/endpoints/worker_pools.py`,
  `/generate/batch`, `/embeddings/batch`, the `text:worker:dev` script) if and only if no caller
  needs it. **`task_manager.py` is NOT deleted** — it is refactored into the replay buffer.
- **B-11 — Profile before and after** (§3C.1): no published measurement splits the per-token cost
  across Redis, JSON and pydantic, so the 10–40× claim is arithmetic, not evidence. Lane H's
  harness supplies the numbers.

**Gates:** `test_stream_endpoint`, `test_stream_chunk_model`, `test_xread_streaming` updated to the
new contract with justification; `test_generate_idempotency` must stay green **unmodified**.
AC-5 and AC-15..AC-18 are this lane's.

#### Lane F — Tenant config and routing policy *(owns `packages/database/**`, `packages/domains/**`, `packages/applications/**`)*

- **F-1** — Extend the config plane for router semantics: per-tenant **fallback chains**,
  **per-provider weights**, **cache-affinity/sticky-routing hints** (§4.4), **per-tenant
  concurrent-stream ceilings**, and **token-aware limits (RPM *and* TPM, independent)** per
  §4.4. Resolution is **tenant → SYSTEM, two tiers**; `50000000-…` never appears.
- **F-2** — New Prisma models follow `.claude/rules/02-database-prisma.md` §Standard Model
  Field Template exactly, and `.claude/rules/03-domain-layer.md` §Generated Code Discipline:
  `pnpm gen:model` is the **only** scaffolding step; **hand-author** entity/factory/mapper/
  repository (exemplars `AiTaskDefault*`, `AiProviderConnection*`); mapper carries
  `FIELDS_NOT_WRITABLE = ['version']` if OCC-written; then `gen:entity` + `gen:factory` to
  reconcile barrels. **Never `gen:mapper`.**
- **F-3** — Add each new model to `ResourceType` in **both** `audit.prisma` (+ an
  `ALTER TYPE … ADD VALUE` migration) **and** `packages/domains/src/enums/generated/
  ResourceType.ts`, or every AuditLog INSERT throws and rolls the mutation into a 500.
- **F-4** — Register repositories in `CoreDatabaseModule` (providers **and** exports); update
  `TENANT_SCOPED_MODELS` / `MODELS_WITHOUT_SOFT_DELETE` allow-lists.
- **F-5** — Migration authored against a **throwaway shadow DB**, never the dev DB, per
  `.claude/rules/02` §Authoring a migration. Name it `task_818_<snake_case>`. **The
  orchestrator runs all DB commands** — Lane F prepares SQL and requests execution.

#### Lane H — Benchmark harness *(owns `apps/text/tests/load/**`, new `apps/text/tests/bench/**`)*

Blocks nothing but proves everything. **Start this first**; Phase 0.1 needs it.

- **H-1** — Mock upstream in **two modes**: zero-latency (isolates proxy overhead) and
  **latency-injecting** (800 ms TTFT, 30 tok/s — exposes pool exhaustion). §4.8.
- **H-2** — Instrument the **AC-3 delta**: first byte received from provider vs first byte
  forwarded to client. This is *the* number.
- **H-3** — Concurrency sweep to the plateau-then-degrade inflection; report p50/p95/p99, not
  averages.
- **H-4** — Per-stream RSS measurement for AC-2; rolling-restart drop test for AC-6.
- **H-5** — Wire into CI as a **non-blocking** report first; promote to a gate only once the
  numbers are stable.

### 6.3 Phase 2 — Parallel lanes C · D · G

#### Lane C — OpenAI-compatible fast path *(owns new `src/text/api/v1_compat/**`, `src/text/routing/admission.py`)*

Implements **D-2**. Fixes **B-9, B-10**.

- **C-1** — New `POST /v1/chat/completions` and `POST /v1/embeddings`. **Validate only the
  routing envelope** (tenant, model, stream) with **msgspec**; forward the remaining body
  **as bytes** (§4.2). Do not build a pydantic model of the payload.
- **C-2** — Adapters translate **only** where the backend is not OpenAI-shaped (Bedrock,
  Anthropic, Vertex). OpenAI/Azure/vLLM/LM Studio/Ollama/llama.cpp are near-passthrough.
- **C-3** — Existing HOPE `/generate` becomes a **thin shim** over C-1 with a scheduled
  deletion in Phase 4. Add a module docstring naming Phase 4 as its death date.
- **C-4** — `ORJSONResponse` as `default_response_class` (B-9).
- **C-5** — Fix **B-5**: release the provider semaphore **between** retry attempts, or hold a
  distinct admission token from the dispatch permit. A degrading provider must not starve
  capacity for `sum(backoffs) + attempts × timeout`.
- **C-6** — Retry policy to §4.4: ≤3 attempts, **always jitter**, honour `Retry-After`;
  429 + `Retry-After` + `RateLimit-Remaining` on tenant limit, 403 on hard cap.

#### Lane D — Non-routing surface disposition *(owns `api/endpoints/judge.py`, `services/{judge_guard,generation_audit,external_guardrail}.py`, `core/guardrail_posture.py`)*

**Fully gated on OPEN-1 and OPEN-3.** Default behaviour absent an override:

- **D-1** — **Keep the judge lane.** Reframe as router admission control; rename to an explicit
  lane concept; delete only judge-specific business logic. **Both cycle-guard layers and
  `tests/unit/test_judge_route.py` stay intact.** Read `services/judge_guard.py:1-25` and
  TASK-735 Phase 2 before touching anything here.
- **D-2** — **`generation_audit` → fire-and-forget async event**, off the hot path. Preserve
  BYOK-vs-CLOUD funding attribution **derived** from `row.tenantId === SYSTEM_TENANT_ID`,
  never stamped at the call site.
- **D-3** — Guardrail gate (B-6) stays inline unless the owner rules otherwise; make the
  posture per-tenant configurable so the decision becomes data, not code.
- **D-4** — Prometheus cardinality (§4.6, AC-11): tenant off metric labels and onto
  exemplars/traces; `model` label opt-in per the LiteLLM precedent. Add the registry
  assertion test.
- **D-5** — OTel GenAI attributes behind **our own mapping layer** (§4.6) — the upstream
  conventions are unstable and unversioned, so a rename must be a one-file change.

#### Lane G — Runtime and deploy *(owns `apps/text/Dockerfile`, `scripts/dev-service.sh`, root `package.json` text scripts, k8s manifests in `arca/hope-v2-deployment`)*

- **G-1** — Multi-worker (B-4): uvicorn `--workers` sized to the pod's CPU allocation, or trial
  **Granian** (§4.2) — **decide on Lane H numbers, not on the blog posts**.
- **G-2** — **`terminationGracePeriodSeconds` > max stream duration** and scale-down
  stabilisation **≥ 300 s** (§4.7). A clinical summarisation runs minutes; today's default
  cuts it off. Pair with Lane B's drain (B-7).
- **G-3** — **HPA on in-flight upstream concurrency**, not CPU and not RPS (§4.7), via
  Prometheus Adapter or KEDA.
- **G-4** — `publishNotReadyAddresses: true` on the metrics Service so terminating pods are
  still scraped.
- **G-5** — **Ingress SSE config**: `proxy_buffering off`, `proxy_http_version 1.1`,
  `Connection ''` (§4.2). Pair with Lane B's B-3.
- **G-6** — Deployment repo changes are **digest-pinned promotions by CI** — never live-cluster
  edits, never a moved tag (`.claude/rules/09` §Cluster Deploys).

### 6.4 Phase 3 — Lane E: callers and SDK *(serial, after C is merged)*

Owns `apps/api/src/modules/{streaming,text-compat}/**`,
`packages/applications/src/services/**` (text consumers), `apps/{nlp,guardrail,harness}` text
clients, `packages/vox-node/**`.

- **E-1** — Migrate every caller in §2.5 to the C-1 contract. 80 `/generate` references,
  19 `/translate`, 12 `/embeddings`, 12 `/tasks/*` (the last of which **have no successor** —
  they migrate to the gateway job plane per OPEN-2, or the caller is rewritten to consume SSE).
- **E-2** — Gateway: `text-proxy.controller.ts` must pass SSE through **unbuffered** and
  preserve `If-Match`/`ETag`. `text-compat/**` (12 files) is the v1 summarization compat
  surface — its prompt builders and response mappers move or adapt.
- **E-3** — `@arcaai/vox-node`: regenerate/reshape. If any admin route changes, **all five
  artifacts regenerate together** — `pnpm api:build && pnpm api:route-manifest &&
  pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin` — or
  `generate-vox-node-admin-check` goes red (`.claude/rules/05` §Definition of Done).
- **E-4** — Gateway e2e: new/changed routes appear in a regenerated `route-manifest.json`;
  authz matrix (`task-776-route-authz-matrix.spec.ts`) stays green; cross-tenant coverage
  added for any new admin surface (404-over-403, never 403).

### 6.5 Phase 4 — Shim deletion and closure (orchestrator)

- Delete the D-2 compatibility shim (C-3) once E reports every caller migrated.
- Re-run the full Lane H suite; fill in the AC table against the Phase 0 baseline.
- Update this README's Implementation Summary + Change History.

### 6.6 Lane dependency graph

```
Phase 0 (serial: baseline, AC-9 test, doc fixes, generate.py decomposition)
   |
   +-- Phase 1 --> A (clients)   B (streaming)   F (db/config)   H (bench)
   |                    |             |               |            |
   +-- Phase 2 --> C (fast path, needs A+B)   D (surfaces)   G (deploy, needs B+H)
   |
   +-- Phase 3 --> I (routing policy, needs C+F)  -->  E (callers + SDK, needs C+I merged)
   |
   +-- Phase 4 --> shim deletion, closure
```

### 6.7 File-ownership map (the partition that makes parallelism safe)

| Lane | Owns exclusively |
|---|---|
| 0 | everything, serially, before any lane starts |
| A | `src/text/providers/**`, `src/text/core/connection.py` |
| B | `src/text/routing/streaming.py`, `api/endpoints/stream.py`, `services/task_manager.py`, `worker.py`, `services/worker_pool_queue.py`, `api/endpoints/{tasks,worker_pools}.py` |
| C | `src/text/api/v1_compat/**`, `src/text/routing/{admission,dispatch,nonstreaming}.py`, `api/endpoints/generate.py` (shim only) |
| D | `api/endpoints/judge.py`, `services/{judge_guard,generation_audit,external_guardrail}.py`, `core/{guardrail_posture,metrics,observability,telemetry}.py` |
| E | `apps/api/**`, `packages/applications/**` (consumers), `apps/{nlp,guardrail,harness}` text clients, `packages/vox-node/**` |
| F | `packages/database/**`, `packages/domains/**`, `packages/applications/**` (config plane) |
| G | `apps/text/Dockerfile`, `scripts/dev-service.sh`, root `package.json`, deployment repo |
| H | `apps/text/tests/load/**`, `apps/text/tests/bench/**` |
| I | `src/text/routing/policy.py`, the `RoutingPolicy` Prisma model + hand-authored domain trio, its admin controller in `apps/api`, and the `/ai-task-defaults` console extension |

**E, F and I all touch `packages/applications`.** They must be **serialized** (F in Phase 1,
I then E in Phase 3) — never run concurrently. `src/text/main.py` is touched by A, B, C and D:
**the orchestrator owns `main.py`** and applies each lane's registration change at merge time.

### 6.8 Model tier per lane (`.claude/rules/14` §1)

| Lane | Tier | Effort | Rationale |
|---|---|---|---|
| 0.4 decomposition | `opus` | high | A pure-move refactor of 1076 lines that must not change behaviour |
| A | `opus` | high | Multi-tenant credential isolation is a correctness-critical boundary |
| B | `opus` | high | Deletes a durable-state plane; the verdict is acted on directly |
| C | `opus` | medium | Multi-file, new contract |
| D | `opus` | high | Touches a documented deadlock guard |
| E | `sonnet` | medium | Mechanical migration against a settled contract, many files |
| F | `opus` | medium | Schema + hand-authored domain trio, high blast radius |
| G | `sonnet` | medium | Config/manifest work with a measured decision handed in by H |
| H | `sonnet` | medium | Harness construction; the numbers it produces are judged by the orchestrator |
| I | `opus` | high | It decides where PHI goes — the deciding stage, never downshifted |

Escalate **on evidence** — a hedged or self-contradicting result re-runs *that* lane higher,
not the whole fleet.

### 6.9 Report contract — every lane, every time

Final message is DATA for the orchestrator. Exactly these fields:

- `LANE`, `BRANCH`, `WORKTREE_PATH`
- `CHANGED`: files added / modified / deleted
- `GATES`: **pasted actual output** of `pnpm text:test`, `text:lint`, `text:typecheck` (or the
  lane's equivalents)
- `AC_IMPACT`: which of AC-1..AC-11 this lane moves, with numbers where measurable
- `TESTS_MODIFIED`: any pre-existing test changed or deleted, **with justification** — an
  unexplained test edit is a finding, not a result
- `DEVIATIONS`: anything done differently from this plan, and why
- `BLOCKED`: anything left undone, explicitly, at the top

---

## 7. Implementation Summary

*(to be filled in as phases land)*

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-29 | Ticket created. Three-agent discovery: serving-capability audit (verdict: text cannot serve a model today), throughput architecture map (12 ranked bottlenecks), external best-practice research (2025–2026 sources). Owner decisions D-1..D-4 recorded. OPEN-1..3 raised for resolution. |
