# Conformance Review — Python Service Mesh

| | |
|---|---|
| **Status** | Review findings. Analysis only — no code was changed. |
| **Reviewed** | 2026-08-17 / 2026-08-18, branch `feat/loop` |
| **Conformance target** | [product-brief.md](../product-brief.md) §3, refined by [owner-decisions-2026-08-17.md](../owner-decisions-2026-08-17.md) |
| **Scope** | `apps/{text,stt,tts,nlp,guardrail,harness}` — plus the `apps/api` edges needed to close the interaction graph |
| **Method** | Static inspection only (read/grep). No tests, builds, migrations or DB/cluster access were run. |

---

## 0. How to read this

Every claim carries a `file:line` citation that was read directly. Where a claim is an absence, the
searches performed are named so the absence can be re-tested rather than trusted.

All six services were audited to depth: interfaces, capabilities, configuration literals, peer
edges, auth, tenant propagation and fail posture. Two findings from an earlier draft of this
document were **corrected by that deeper pass** and are flagged in place:

- **`stt` MQ** — first assessed as "session transport only". Wrong. `stt` has a genuine
  broker-consumed interface (Dramatiq) with an external producer. Corrected in §1.2.
- **`stt` per-tenant config** — first assessed ABSENT. Wrong. It is **PARTIAL**: pipeline
  *selection* is read from the DB tenant-filtered; the instruction *text* is SYSTEM-only.
  Corrected in §2.2.

One finding was **narrowed** on the coordinator's own verification: the `stt` customer-tenant
constant is **latent, not active** (F-04).

---

## 1. The shared obligation

> *"gold-standard microservice architecture — well-defined and documented APIs, an SSE interface, a
> Message Queue real-time interface, and documented internal architecture and design."*
> — product-brief.md:49-51

| Service | REST | SSE | MQ (real-time interface) | Inbound auth | Documented API | Documented architecture |
|---|---|---|---|---|---|---|
| `text` | ✅ 13 routes | ✅ 1 endpoint | ⚠️ internal-only | ✅ | ⚠️ 5/10 | ❌ 1/10 |
| `stt` | ✅ 25 routes | ❌ **ABSENT** | ✅ **genuine (Dramatiq)** | ❌ **NONE** | ❌ 12 of 25 undocumented | ⚠️ diagram wrong |
| `tts` | ✅ 8 routes | ✅ | ❌ **ABSENT** | ⚠️ HTTP yes, **WS bypassable** | ✅ 8/10 | ⚠️ |
| `nlp` | ✅ 10 + 2 WS | ❌ **ABSENT** | ❌ **ABSENT** | ✅ | ⚠️ 6/10, stale | ✅ best in mesh |
| `guardrail` | ✅ 17 routes | ❌ **ABSENT** | ⚠️ internal-only | ✅ | ⚠️ 7/10 | ❌ none |
| `harness` | ✅ 19 routes | ❌ **ABSENT** | ❌ **ABSENT** (Temporal ≠ MQ) | ✅ | ⚠️ 5 routes undocumented | ⚠️ 6/10 |

### 1.1 SSE — present in 2 of 6

- `apps/text/src/text/api/endpoints/stream.py:92` — `GET /api/v1/tasks/{task_id}/stream`, Redis
  `XREAD BLOCK`-backed, resumable via `Last-Event-Id` (`stream.py:35`).
- `apps/tts/src/tts/api/endpoints/speech.py:178` — `EventSourceResponse` when
  `stream_format == "sse"`.

**ABSENT** in `stt`, `nlp`, `guardrail`, `harness` — searched `EventSourceResponse`,
`sse_starlette`, `text/event-stream`, `StreamingResponse` across each `src/` tree.

Nuance worth recording for `stt`: it *produces* SSE-shaped JSON onto Redis Pub/Sub
(`stt/core/messaging/pubsub.py:1-8`, channel `stt:transcription:{job_id}`) and the **gateway** owns
the socket (`apps/api/src/modules/streaming/transcription-job.controller.ts:458`). So the capability
reaches clients; the service itself exposes no SSE interface.

### 1.2 MQ — one genuine interface, two internal queues, three services with nothing

**CORRECTED.** `stt` has a real message-queue interface:

| Evidence | Location |
|---|---|
| Dependency declared | `apps/stt/pyproject.toml:45` — `dramatiq[redis]>=2.0.0` |
| Broker constructed | `stt/core/messaging/broker.py:122-162` (`RedisBroker`, `AgeLimit`/`TimeLimit`/`Retries`/`Results`) |
| Consumer process | `stt/worker.py:289-321` — `Worker(queues={"stt_batch","default"})` |
| Actor | `stt/transcription/workers/transcribe_file.py:34` — `@dramatiq.actor(queue_name="stt_batch")` |
| **External producer** | `apps/api/src/modules/streaming/transcription-job.controller.ts:430` — *"Dispatch Dramatiq message to stt_batch queue"* |

That is a peer enqueuing work onto a broker that another service consumes: a real MQ interface.

`stt`'s Redis Streams (`stt/streaming/redis_streams.py`) are a *different* thing and should not be
counted twice. They use consumer-group semantics (`xgroup_create :226`, `xreadgroup :383`,
`XAUTOCLAIM :309-360`) but the module states the purpose plainly at `redis_streams.py:47-50`:
*"Because the stream is per-session, one constant group name is unambiguous — a single group with
normally one live consumer (the owning worker)."* Crash recovery for a single owner, not work
distribution. Gateway writes at
`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:260,303`.

Everything else:

| Service | Broker use | Interface? |
|---|---|---|
| `text` | Redis Streams consumer group `text:workerpool:*` — `services/worker_pool_queue.py:29,69,100,105,136`; consumed by `worker.py` | **No.** Grep for `text:workerpool` across `apps/` and `packages/` returns only the two definition lines. Work is submitted over HTTP (`api/endpoints/embeddings.py:87`); the stream is internal fan-out. |
| `guardrail` | Redis **sorted set** `guardrail:jobs:pending` claimed via `ZPOPMAX` (`services/job_processor.py:57-59,249`); consumer is an `asyncio.create_task` in the same process (`main.py:147-149`) | **No.** HTTP-in (`api/endpoints/guardrails.py:179`), HTTP-poll-out (`jobs.py:38,118`). `guardrail:results` is `XADD`-only — **nothing ever reads it** (no `XREAD`/`XREADGROUP` anywhere). A write-only audit stream. |
| `tts` | `asyncio.Queue` only (`providers/azure_speech.py:179`) | **ABSENT** — no broker dependency in `pyproject.toml`. |
| `nlp` | none | **ABSENT** — searched `xadd`, `xreadgroup`, `kafka`, `nats`, `pika`, `dramatiq`, `celery`, `bullmq`. Only hit is an aspirational roadmap line, `apps/nlp/docs/01-architecture.md:701`. |
| `harness` | none | **ABSENT** — same search set. Temporal (`harness-task-queue`, `core/config.py:41`) is a durable-execution substrate; every workflow start is triggered by an **inbound HTTP route**. `core/config.py:397` even notes the BullMQ ingest processor lives in `apps/api` and calls harness *over HTTP*. |

**Dead config worth flagging:** guardrail's entire `GUARDRAIL_V2_QUEUE_` settings block
(`core/config.py:207-218`) has **zero read sites** — the processor uses hardcoded constants instead
(`job_processor.py:54,63-67`). Likewise `RedisConfig.task_ttl_seconds` / `stream_max_len` /
`cache_ttl_seconds` (`config.py:202-204`) are never read, so `guardrail:status:*` hashes **never
expire**, and `list_jobs`/`get_job_stats` do an unbounded `redis.keys("guardrail:status:*")` scan
(`job_processor.py:141,194`).

**The platform event bus is TypeScript-only.** BullMQ sys-events live in
`packages/applications/src/services/sysEvent/sysEvent.service.ts:19`. Searched `bull`, `sys_event`,
`SysEvent` across all six Python trees: **zero hits.**

**CONFIRMED, not new — the ratified envelope is unwired.** `async-contract.md:31-35` states:
*"Nothing today emits or consumes an `AsyncEnvelope` on the wire."* Still true —
`hope_async_contract` / `AsyncEnvelope` / `async_contract` return **zero** hits across all six
Python services. TS uses it only for workflow run events
(`apps/api/src/modules/workflows/workflow-run-event.ts:2`).

### 1.3 Documentation

No committed OpenAPI or AsyncAPI artifact exists anywhere in `apps/` — searched `openapi*`,
`asyncapi*` to depth 3. FastAPI generates a spec at runtime; nothing is versioned, reviewable or
diffable in CI, on a mesh where `apps/api` is a hard client of every route.

Per-service, with concrete defects:

| Service | Rating | Sharpest problem |
|---|---|---|
| `stt` | **4/10** | 12 of 25 endpoints undocumented — including `POST /api/v1/transcribe`, *the primary batch API*, and all nine `/internal/streaming/*` routes. The architecture diagram (`README.md:48-77`) omits Redis Streams, the SessionManager, the Pub/Sub→SSE relay and effective-config — a reader concludes `stt` is batch-only. Stale: `README.md:302,312` document a worker invocation that `core/job_concurrency.py:9-18` says never runs in production. |
| `text` | **5/10** | Excellent operations README with a genuinely valuable "Frozen identifiers" table (`README.md:117-131`), but **no architecture section at all** — no mention of the guardrail gate, the judge lane, degrade routing, circuit breakers or the drain protocol. `README.md:52` gives the wrong OpenAPI URL (`/docs`; real path `/api/v1/docs`, `main.py:368`). `/worker-pools` is absent. |
| `harness` | **6/10** | Internal architecture is genuinely well documented, but 5 internal routes are missing from the API table — including all three consultation-loop signals (`internal.py:402,490,539`), which are the entire loop entry surface. **MCP is not documented at all.** |
| `nlp` | **6/10** | 3,727 lines across `docs/01..06` — the most thorough in the mesh, and materially stale. `/classify/topic`, `/classify/intent` and `POST /extract` are **absent entirely**; `X-Service-Token` and `X-Tenant-Id` appear **nowhere** despite an "Authentication" heading (`docs/02-api-reference.md:18`); and the documented `/diagnosis/suggest` is a 404 — the real route is `/diagnosis/suggestions` (`api/v1/rest/diagnosis.py:14`). |
| `guardrail` | **7/10** | Narrower but more accurate. `POST /guardrail/ground` and `POST /guardrail/redact` — the two most safety-critical endpoints — are **undocumented**. The in-process GLiNER/MiniCheck model stack is essentially undocumented; a reader of `README.md:223` would conclude guardrail is a thin client. |
| `tts` | **8/10** | Best contract documentation in the mesh, dated and owner-named. Missing `GET /api/v1/providers` (post-dates it) and internals. One stale line: `README.md:76-79` claims an Azure env-key fallback that `config.py:44-47` deliberately prevents. |

---

## 2. Per-service conformance

### 2.1 `text` — the strongest service, with a hollow second execution plane

| Obligation (brief:53-59) | Status | Evidence |
|---|---|---|
| Text generation | **CONFORMS** | `api/endpoints/generate.py:324` |
| Text **embedding** first-class | **PARTIAL** | Dedicated models (`models/embedding.py`), registry (`providers/embedding.py:43-83`), provider (`providers/tei_embed.py`), two routes (`embeddings.py:36,58`). **But `POST /embeddings` (`embeddings.py:36-55`) has exactly one dependency and bypasses the pool router, semaphore, rate limiter, circuit breaker, provider queue, guardrail gate, tenant enforcement, idempotency, retry, metering and audit** — all of which `/generate` has. And `tei-embed` sits in a registry `/health` and `/providers` never iterate (`health.py:69` iterates the *LLM* registry), so **it is never health-checked and invisible to monitoring**. |
| Proxy across vLLM · llama.cpp · LM Studio · Ollama · Azure Foundry · Bedrock | **CONFORMS** | `main.py:62-113`. LM Studio via `openai_compat` registered under both keys as one shared instance (`main.py:61-68`); Ollama `:70-73`; Bedrock `:75-78`; Azure/OpenAI/Anthropic/Vertex unconditionally for BYOK `:96-103`; vLLM `:105-108`; llama.cpp `:110-113`. All six brief engines plus three. **Best-conforming item in the review.** |
| Parallel across workers | **PARTIAL** | Real request-level concurrency: `asyncio.gather` probing (`providers.py:91-96`), per-provider `ResizableSemaphore` (`main.py:282-287`), `asyncio.to_thread` for boto3 (`bedrock.py:185`). But the async worker pool creates exactly **two** consumers claiming `count=1` and awaiting inline (`worker.py:80-84,160-165`) — one task at a time per process. |
| Owns worker status/health/performance | **PARTIAL** | Degrade routing IS wired (`generate.py:373-379` → `resolve_pool_route`, typed 503 `PoolUnhealthyError`). Rich status at `providers.py:69-77` (probe latency, pool health, in-flight gauge) and `worker_pools.py:28`. **But `PoolHealthTracker` stores one boolean + one timestamp per provider (`pool_health.py:27-28`) — no latency, no error rate, no staleness expiry — and is populated ONLY by `GET /health` (`health.py:78,82`). With no external poller, degrade routing is a permanent no-op.** |
| k8s lifecycle | **PARTIAL** | `ShutdownManager` exists (`services/shutdown_manager.py:12-51`) and `/generate` rejects during drain (`generate.py:358`). **But `initiate_shutdown()` has zero production callers** — the flag flips only inside `wait_for_shutdown()` at `main.py:338`, i.e. *after* teardown begins — **and `/health/ready` (`health.py:122-146`) ignores the draining flag entirely**, so k8s keeps routing traffic through the drain. No HPA/KEDA manifests exist (`infrastructure/` has only `docker/`, `grafana/`, `single-deployment/`); `worker_pool_status.py:9-13` describes KEDA as aspiration. |

**VERIFIED — `batch_generation` raises `NotImplementedError`** at `worker.py:130`, registered as a
live consumer at `:162-164`, honestly flagged in the docstring at `:17-24`. The pool has two task
types and can execute one. `GET /worker-pools` (`worker_pools.py:40`) enumerates `WorkerTaskType`,
so it **advertises a `batch_generation` pool that no endpoint can fill and no handler can run.**

**Excellent design worth crediting:** the `text → guardrail → text` cycle is broken structurally.
Guardrail's judge call lands on `POST /generate/internal/judge`, outside the moderation gate, with a
`ContextVar` tripwire (`services/judge_guard.py:35,56-73`) asserted at `generate.py:220`;
re-entry raises `GuardrailRecursionError` → 500.

**Config.** `text` is the best in the mesh — `test_task602_byok_credentials.py` and
`test_no_model_default_d7.py` lock out cloud key and model-id env fallbacks. Residual violations:

| Literal | Location |
|---|---|
| `default_model = "gemma-4-e2b-it-qat"` — a live host-specific model id, **divergent from `.env.sample:376` (`local-model`)** | `core/config.py:155` |
| `default_model = "BAAI/bge-m3"` + coupled `embedding_dim = 1024` | `core/config.py:346-347` |
| `GENERATION_DEFAULTS = {"temperature": 0.1, "max_tokens": 16_384, "top_p": 0.95}` — **no env, no DB, no control-plane override path whatsoever** | `core/defaults.py:10-14` |
| `content_filter_severity = "medium"` — a safety threshold | `core/config.py:111` |
| `guardrail_version = "DRAFT"` — a safety-policy version | `core/config.py:133` |
| `region = "us-east-1"` — and this is the Bedrock *availability gate* at `main.py:75`, so it never closes | `core/config.py:122` |
| `api_version = "2024-12-01-preview"` | `core/config.py:97` |

**Prompts and taxonomies: ABSENT — clean, and deliberately so.** `api/endpoints/judge.py:3`:
*"`apps/guardrail` owns policy (thresholds, criteria, taxonomy, verdict shape…)"*. Text returns raw
model output. This is the correct separation, and it makes guardrail's engine ownership (§2.5)
harder to justify, not easier.

**Tenant identity — the reference implementation.** `generate.py:295-321` fails **closed** with 428
on an absent `X-Tenant-Id` and accepts a declared `tenantless:<reason>` marker. Every other service
should be measured against this.

### 2.2 `stt` — realtime and batch are strong; auth is absent

| Obligation (brief:72-77) | Status | Evidence |
|---|---|---|
| ASR realtime | **CONFORMS** | `streaming/session_manager.py`, 9 control routes at `streaming/api/routes.py`, Redis Streams audio plane |
| ASR batch | **CONFORMS** | Dramatiq actor (`transcription/workers/transcribe_file.py:34`), `transcription/batch_service.py`, plus a synchronous `POST /api/v1/transcribe` (`transcription/api/routes.py:54`) |
| **Audio embedding** | **PARTIAL** | One exposed endpoint: `POST /internal/voice-profile/extract` (`voice_profile/api/routes.py:23`), returning a 256-d speaker embedding. **But it is speaker-enrolment-specific** — VAD-gated (`routes.py:44-49`), 15 s capped (`extraction_service.py:19`), similarity-gated (`settings.py:383-393`). No endpoint embeds arbitrary audio; no vector store (there is a regression test asserting its absence, `tests/unit/diarization/test_no_qdrant_vectorstore.py`). Diarization embeddings (`diarization/embedding_service.py`) are an internal pipeline stage with no API. |
| Proxy across Whisper · NeMo · Azure Foundry · Azure Cognitive · **AWS Transcribe** | **PARTIAL** | Ten engines present: faster-whisper, whisper.cpp, HF/safetensor, ONNX, NeMo, parakeet.cpp, Azure Speech, Azure Foundry, OpenAI, Sarvam (`models/*_loader.py` + `streaming/*_asr.py`). **AWS Transcribe ABSENT** — searched `aws`, `boto`, `boto3`, `amazon`, `Transcribe`; the only AWS hits are S3 host construction (`core/storage/providers/factory.py:84-96`). Also absent: Google STT, Deepgram, AssemblyAI. |
| Worker pool + monitoring | **PARTIAL** | Three concurrency primitives exist — `ResizableThreadGate` (`core/job_concurrency.py:52`), `CapacityGuard` (`streaming/capacity_guard.py:38`), a single shared worker loop (`core/worker_loop.py:76`) — **all per-process, none a pool.** No `pool_router.py` / `pool_health.py` / `worker_pool_queue.py` equivalent exists. TASK-726 delivered drain (`streaming/api/routes.py:444`), readiness-gating on drain (`health/api/routes.py:113-134`), a drain-race exception, and one queue-depth gauge (`core/messaging/broker.py:95-119`). Its own design note is explicit: *"does not rebuild `stt`'s batch worker/engine registry/session manager (only extends them)"* (`TASK-726/design-notes.md:4-7`). |
| **Per-tenant ASR instructions from the DB** | **PARTIAL — CORRECTED** | See below. |

**CORRECTION — `stt` does read per-tenant ASR config from the DB.** There are three lanes and they
must not be conflated:

| Lane | Mechanism | Tenant-scoped? | Evidence |
|---|---|---|---|
| **ASR pipeline** (engine, language, beam/temperature/thresholds, prompt-template id, diarization) | **direct SQL** | **YES**, when the caller passes it | `pipeline/config_reader.py:63-70` — `query.where(AsrPipelineRead.tenant_id == tenant_id)`; docstring `:41-47` *"STT cannot load a pipeline owned by a different tenant"*. Instruction fields at `pipeline/dto.py:750-773`. |
| **initial_prompt TEXT** | direct SQL | **NO — `category == "SYSTEM"`** | `core/initial_prompt.py:18-22`. A tenant chooses *which* SYSTEM template its pipeline points at; it cannot own the prompt text. |
| **service knobs** (retention, concurrency) | HTTP from gateway | **NO** — and the cache is loop-local, not tenant-keyed | `core/effective_config.py:229-231,255-281` |

So: **per-tenant ASR *selection* from the DB — yes. Per-tenant ASR *instruction text* — no.**

**Three tenant-filter defects on that lane** (the guard the docstring promises is not applied
uniformly): `transcription/workers/transcribe_file.py:191` and `:331` call `get_pipeline()` with
**no `tenant_id`** — the entire MQ path is unfiltered; `transcription/api/routes.py:116` omits it on
the UUID branch while `:119-120` passes it on the slug branch. The streaming path does it correctly
(`session_manager.py:987-995`).

**`stt` has NO inbound authentication.** Searched `apps/stt/src` for `X-Service-Token`,
`internal_access_token`, `ServiceAuthMiddleware` — **zero hits**. `main.py:247-261` installs CORS,
request-logging and request-id middleware only. Every `/internal/*` route on :8861 — including
`POST /internal/streaming/drain` and `POST /internal/cache/clear` — is unauthenticated at the
service. Defence is network-level only. `cors_origins` also defaults to `["*"]` (`settings.py:50`)
on a PHI service.

**`stt` is outside D-D.** It presents `X-Internal-Service-Key` with `api_gateway_key`
(`core/api_client/gateway.py:39`, `settings.py:148`); there is no `internal_access_token` field.
Its tenant header is `X-Internal-Tenant-Id`, not `X-Tenant-Id` — and that substitution is
*deliberate and well-reasoned* (`gateway.py:100-119`: the gateway's `ContextInterceptor` rejects
`X-Tenant-Id` when it diverges from the authenticated principal). Keep the reasoning; the missing
inbound auth is the real problem.

### 2.3 `tts` — thinnest conformance, and one open door

Eight routes (`main.py:197-201`).

| Obligation (brief:79-82) | Status | Evidence |
|---|---|---|
| TTS realtime | **CONFORMS** | WS `stream_ws.py:108`, SSE `speech.py:178`, raw chunked `speech.py:205` |
| TTS **batch** | ❌ **ABSENT** | All three `POST /audio/speech` modes are one-request-one-synthesis. No queue, no worker entrypoint, no job table; no broker dependency in `pyproject.toml`. **And `design.md:112` contradicts the brief**: *"No batch/queue use case exists, so no worker pool is built for it."* brief:80 says realtime **or batch**. |
| Proxy across engines | **CONFORMS** | `routing/router.py:146` `TTSRouter`, five providers registered `main.py:52-117`, per-provider circuit breaker (`router.py:222`). Failover is before-first-byte only (`router.py:5-7,321-326`) — a correct, documented limit. |
| Worker pool | **PARTIAL** | Router + breaker only. TASK-726 scoped this down deliberately: *"TTS degrade-routing ALREADY EXISTS… does NOT need a Task-725-style `PoolHealthTracker` rebuild"* (`design-notes.md:95-109`). |
| **Per-tenant TTS instructions from the DB** | ❌ **ABSENT** | `tts` has **no DB driver at all** — no `sqlalchemy`/`asyncpg`/`psycopg` in `pyproject.toml`, no `database_url`. Its effective-config client consumes exactly one key, `retention.ttlSeconds` (`core/effective_config.py:55-68`). Per-tenant behaviour arrives **injected in the request body** (`speech.py:44-55`: `routing_en`, `routing_ml`, `allowed_providers`, `provider_overrides`, `voice_bindings`). |

**Credit where due:** the router **fails closed** with no injected chain —
`TtsRoutingUnconfiguredError` (`router.py:55-71`, raised `:188`), with the comment
*"The router carries NO code/env vendor default: the per-locale provider order is DB-sourced"*.
Reinforced at `core/config.py:205-209`. This is exactly the D-B posture the brief wants.

**But the voice catalog is a code literal.** `catalog/voices.py:29-43` hardcodes four internal
voice ids, two locales and eleven provider voice names (`en-IN-NeerjaNeural`, `af_heart`, `ishita`,
`Anjali`, …), instantiated with no override at `main.py:173` and served to every tenant by
`GET /voices`. Bindings can be merged per request (`router.py:84-107`), but **the voice-id namespace
itself cannot be changed without a code deploy** — a tenant cannot add a voice.

**WebSocket auth can be bypassed.** `ServiceAuthMiddleware` is a `BaseHTTPMiddleware`
(`api/middleware/auth.py:33`) and never sees WebSocket scope. WS auth is `stream_ws.py:100-105`,
which reads **only `settings.service_token`** — *not* `settings.accepted_service_tokens`
(`core/config.py:180-194`). Under D-D, a deployment that sets only `INTERNAL_ACCESS_TOKEN` and
drops the legacy `TTS_SERVICE_TOKEN` hits `if not token: return True` (`stream_ws.py:102-103`) —
**the WS synthesis surface is fully open while HTTP is protected.**

### 2.4 `nlp` — delegation is exemplary; four of seven capabilities are not real

| Obligation (brief:66-70) | Status | Evidence |
|---|---|---|
| NER | **CONFORMS** | `services/token_classifier.py`, `POST /classify/tokens` (`classify.py:97`), enriched with ontology codes, ConText/NegEx assertion, deterministic vitals |
| Classification | **PARTIAL** | `POST /classify/text` (`classify.py:55`) is **fail-closed-unconfigured by design** — the default model is the sentinel `"__UNCONFIGURED_DOC_TYPE_CLASSIFIER__"` (`core/config.py:246`), refused at `services/text_classifier.py:53-69` → 503. Functional only once the gateway injects a DB-selected model. |
| **Clustering** | ❌ **ABSENT** | Searched `cluster`, `clustering`, `kmeans`, `hdbscan`, `dbscan`, `umap` across `src`, `docs`, `README`, `pyproject`. `scikit-learn` is declared (`pyproject.toml:41`) and **never imported**. |
| Sentiment | **PARTIAL — claim, not code** | No sentiment code, endpoint or model default anywhere in `apps/nlp/src`. The intent exists only in a test docstring (`tests/test_classify_sentiment_toxicity.py:1-13`) and as `AiTaskDefault` keys added in TypeScript (`TASK-729 README:450-457`). |
| Toxicity | **PARTIAL — and structurally blocked** | Same. The existing `TextClassificationResponse` (`schemas/classification.py:28-32`) is **single-label** and cannot express multi-label toxicity; the ticket's own §6 flags this as HUMAN-GATED and unresolved (`TASK-729 README:414-419`). |
| Topic labeling | **CONFORMS (delegated)** | `POST /classify/topic` (`classify.py:155`), prompt built `:137-143`, delegates to `text` `:188` |
| Intent recognition | **CONFORMS (delegated)** | `POST /classify/intent` (`classify.py:202`), `:146-152`, delegates `:225` |

**Is a generic classifier enough to count?** No. `services/text_classifier.py:75-85` loads
`AutoModelForSequenceClassification` — the label set is baked into the checkpoint's head, and the
request schema has **no `candidate_labels` field**. One model = one fixed taxonomy. So four of the
brief's seven `nlp` capabilities collapse into one unconfigured endpoint plus two LLM prompt
templates. Counting them all as CONFORMS would be inflation.

**Delegation to `text` is the cleanest peer edge in the mesh.** `services/external_text_client.py`:
mandatory `X-Tenant-Id` raising on blank (`:66,82-89`), route-level 428 (`classify.py:29-52`),
bounded retry then **raise** (`:141-143` → 503), and an explicit rationale for refusing to fail
open — *there is no safe default label* (`:12-18`).

**Which makes one inconsistency stand out:** `services/text_classifier.py:114-120` **fabricates a
label** on any exception — returning `predicted_label="other", confidence=0.0`. That is precisely
the behaviour `external_text_client.py:12-18` refuses to permit, inside the same service.

**Per-tenant config — the right mechanism, incomplete coverage.** `nlp` touches no DB
(searched `sqlalchemy`/`asyncpg`/`psycopg`/`DATABASE_URL` — zero hits; stated at
`core/config.py:424-425`). Tenant instructions arrive **gateway-injected in the request body**
(`schemas/classification.py:109-119,126-138`), missing ⇒ 503 (`classify.py:176,217`). This is the
sanctioned pattern and it means `nlp` structurally **cannot** have a cross-tenant cache leak —
there is no tenant-scoped cache to mis-key. **But it covers only topic and intent.** Sentiment,
toxicity, NER and classification have no per-tenant instruction channel.

**A genuinely strong control worth copying:** `core/config.py:21-74` bars model identity from env
*and* dotenv *and* Vault `secrets_dir` — the rationale at `:57-62` is that a
`/vault/secrets/NLP_MODEL_NAME` file must not be able to select a model.

**Config violations:** live HuggingFace ids as defaults — `"blaze999/Medical-NER"`
(`config.py:287,290`), `"shanover/symps_disease_bert_v3_c41"` (`:340,342`). Thresholds
`0.6`/`0.5`/`0.5` (`:268,309,349`). And **`linker_confidence_floor = 0.0`** (`:331`) makes the
confidence gate a no-op by default — the opposite of its stated intent at `:321-323`.

**Ontology linking is a demo fixture, not a terminology service.** `services/ontology_linker.py:94-184`
is a hardcoded module-level tuple of ~40 concepts (14 medications, 9 conditions, 8 symptoms, 6 labs,
3 procedures). Not a DB read, not a data file. Self-aware about it (`:21-25`), null-safe on miss
(`:208`), and correctly refuses to map bare "diabetes" to T2 codes (`:117-123`) — good judgement
inside a fundamentally under-scoped artifact.

**Security default:** `cors_origins = ["*"]` **with `allow_credentials=True`**
(`config.py:388,391`, applied `app.py:41-47`) — a spec-invalid combination on a token-authenticated
service. Guardrail gets this right by comparison (`[]`, disabled: `config.py:314-315`).

**The WebSocket routes are real but single-process** — sessions live in an in-memory dict
(`core/websocket_manager.py:26`), so they do not survive horizontal scaling.

### 2.5 `guardrail` — the brief's clearest instruction, and the least honoured

> *"MUST delegate to `text` and `nlp` rather than owning engines."* — brief:63

**It does not delegate. It owns three independent inference stacks.**

1. **Direct multi-vendor LLM client.** `providers/openai_compat.py:105-110` posts to
   `{base_url}/chat/completions` with `Authorization: Bearer`. Five engines selectable
   (`core/config.py:405`): LM Studio, vLLM, llama.cpp, Azure, Bedrock. It even implements the IBM
   Granite Guardian BYOC wire protocol itself — criteria strings and the `<guardian>`/`<score>`
   template at `providers/_granite.py:18-43`.
2. **In-process ONNX NER/PII engine.** `providers/gliner.py:106,114` —
   `GLiNER2ONNXRuntime.from_pretrained(...)`, with **hardcoded label taxonomies** at `:22-70`
   (`SAFETY_LABELS`, `PII_LABELS`, 15 `ADVERSARIAL_LABELS`, 11 `HARMFUL_LABELS`). This duplicates
   NER that `apps/nlp` already does.
3. **GGUF NLI scorer.** `services/groundedness_scorer_minicheck.py:142-207` drives llama.cpp
   **private internals** (`._model`, `._ctx`, `llama_model_decoder_start_token`, `:146-160`) to run
   an encoder-decoder the high-level API does not support — acknowledged at `:138`. A hard,
   un-versioned coupling to a C++ binding's private surface.

**No client to `text` or `nlp` exists.** Searched `apps/guardrail/src` for httpx peer clients — the
only outbound HTTP is the effective-config pull (`main.py:57`) and the LLM engine call. There is no
`external_text_client.py` analogue, even though `apps/nlp` has exactly that.

The codebase argues its case for *one* slice, and the argument is worth reading:
`core/tenant_config.py:56-69` justifies the direct DB read on two grounds — guardrail's callers are
peer services, and routing config through the gateway would close a
`gateway → text → guardrail → gateway` liveness cycle on a safety-critical path. **That reasoning is
sound for config. It does not extend to owning three inference stacks, and no comparable
justification exists anywhere in the tree for the engines.**

TASK-735 is the fix and its status is **`Pending`** (`README:5`). Phases 0, 1, 2a and the TypeScript
half of 4 landed; Phase 2b (the client to `text`) and Phases 3–4-python (deleting the adapters) did
not. D4 states the target: *"Guardrail ends with zero provider adapters, zero resident weights, zero
engine env vars."* None of the three is true today.

**Hardcoded engine/model/threshold defaults — quantified.** `core/config.py`:

| Class | Detail |
|---|---|
| Six Granite model ids | `:32-36` (`guardrail_model`, `content_safety_model`, `pii_detection_model`, `prompt_injection_model`, `comprehensive_model`) + `:39` (`guardian_model`), all `"granite-guardian-4.1-8b"`. **`AzureOpenAIConfig` (`:56`) and `BedrockConfig` (`:72`) INHERIT all six** while their own docstrings say Azure/Bedrock do not host Granite (`:57-58,73-74`) — a misconfigured Azure deployment will be asked for `granite-guardian-4.1-8b`. |
| Three engine endpoints | `:28` LM Studio, `:98` vLLM, `:110` llama.cpp |
| Engine selector | `:299` `provider = "lm-studio"` |
| Model ids | `:122` GLiNER `"hivetrace/gliner-guard-uniencoder-onnx"`; `:155-156` MiniCheck GGUF |
| **Clinical thresholds** | `:127` `classification_threshold = 0.4`; `:128` `pii_threshold = 0.5`; `:183` `entailment_threshold = 0.5`; `:53` `guardian_min_confidence = 0.75` |
| **DB credentials in a source literal** | `:246` `"postgresql+asyncpg://postgres:postgres@localhost:5432/hope"` |
| Unreachable from any config layer | GLiNER taxonomies `providers/gliner.py:22-70`; Granite criteria `providers/_granite.py:18-32`; SAFE/UNSAFE system prompts `providers/openai_compat.py:~40-66` |

A defaulting *clinical safety threshold* is a patient-risk issue, not config hygiene.

**Mitigating, and it matters:** model *identity* has genuinely moved to the DB —
`core/dependencies.py:104-109` and `:288-330` fail closed with 503 and no env fallback, and
`db_config_enabled` defaults `True` (`config.py:243`). The literals above survive as a dev
escape-hatch reachable only via `db_config_enabled=False`.

**Per-tenant config — correctly implemented, and the `50000000-…` bug is genuinely fixed.**

- Cache key is tenant-scoped: `tenant_config.py:471` — `f"{task_key}::{tenant_id}"`.
- Cascade is exactly two tiers: `:386-392`, SQL scope `:530-532` uses only
  `[SYSTEM_TENANT_ID, tenant_id]`; `SYSTEM_TENANT_ID` at `:118`.
- `50000000-…` appears **only** in tests, as *negative* regression constants
  (`tests/test_tenant_config.py:655,788`).
- `core/config.py:248-254` carries a standing comment explaining why `default_tenant_id` was
  **deleted rather than repointed** — the stronger fix.
- DISABLED = veto, not fall-through (`:567-571` → 503), and vetoes are cached as vetoes (`:474-487`)
  rather than collapsing into a fail-open empty dict.

**But the enforcement half of TASK-737 is missing.** Every read site is
`request.headers.get("X-Tenant-Id")` with **no None-check** — `core/dependencies.py:90,370,410`;
`api/endpoints/guardrails.py:77,123`; `redact.py:286`. An absent header silently resolves SYSTEM,
downgrading a strict tenant to the platform floor with no error. Async jobs carry **no tenant at
all** (`main.py:136-138` passes `tenant_id=None`). Guardrail built the vocabulary for the directive
(`TENANTLESS_PREFIX`, `:135`) and never enforces it — while `apps/nlp` returns 428 for the same
condition (`classify.py:43-52`).

**Cache is TTL-only, and the gap is documented honestly** (`tenant_config.py:79-83`): a gateway-side
`AiTaskDefault` change lands within one 60 s TTL window rather than immediately, because no
publisher exists on the gateway side. Practical impact: revoking a tenant's model selection takes up
to 60 s to bite on a safety gate.

**Fail posture is inverted where it matters most:** the LLM engine call **fails OPEN** — a timeout
returns `safe: True` (`providers/openai_compat.py:150-156`). Compare `text`'s guardrail client,
which fails closed and says so.

### 2.6 `harness` — broad coverage, two structural holes

| Obligation (brief:84-88) | Status | Evidence |
|---|---|---|
| Session context management | **PARTIAL** | Real context-binding node (`temporal/interpreter/nodes/context_binding.py:84-91`, registry `:109-112`) and a rolling window (`workflows.py:1795`). But `session_id` is *derived* from the Temporal workflow id (`activities.py:430`), and session persistence is `apps/api`'s (`services/api_client.py:1-11`). Harness manages *workflow* context, not a session layer. |
| Tool-calling layer configuration | **PARTIAL** | Allowlist intersection `policy ∩ server`, deny-all default (`activities.py:654-663`), `TOOL_CALL` trajectory type (`:153`). **But there is no generic LLM function-calling loop** — `services/text_client.py:140-157` sends no `tools` field at all. |
| **Memories** | ❌ **ABSENT** | Searched `memor*` across `apps/harness/src`. Every hit is the claim-check in-memory blob store or a cache bound (`claim_check.py:108,186`; `core/config.py:223,246,262`; `workflows.py:1724`). No memory read/write/recall path, no store, no API, no interpreter node. |
| MCP | **PARTIAL** | A **genuine** MCP client — official SDK, `session.initialize()` then `session.call_tool()` over streamable-HTTP (`tools/mcp_client.py:130-151`), bounded retry (`:101-119`). **Server configs come from the DB**, not literals: `HarnessPolicy.mcp_servers` parsed from the gateway policy (`temporal/models.py:360-363,419-425`), credentials resolved by `authRef` through the gateway (`activities.py:620-652`). Triple-gated (`workflows.py:643`). **But only one tool name is ever invoked** — `MCP_TERMINOLOGY_TOOL = "validate_codes"` (`workflows.py:196`) — there is no `list_tools()` discovery. And `mcp_client.py:130` imports `httpx2`, **a package that does not appear in `pyproject.toml`**; the whole `_call_once` path is `# pragma: no cover` (`:127`), so it is never exercised by tests. |
| HITL | **CONFORMS** | A real durable clinician gate: `ApprovalSignal` (`models.py:125`), handler (`workflows.py:337-339`), approval raced against a durable SLA timer (`:1538`), draft persisted `PENDING_REVIEW` before the gate (`:1494`), escalation bounds (`config.py:447-448`, `models.py:58-63`). Degradation **forces** human review rather than auto-passing (`workflows.py:290,556`). |
| Grounding | **PARTIAL** | Self-computed: `sensors/inferential/groundedness.py` + a deterministic NLI atomic-fact gate (`atomic_fact.py`, `minicheck_entailer.py`). **It does NOT call guardrail's groundedness endpoint** — `services/guardrail_client.py` calls only `/analyze` (`:108`) and `/redact` (`:141`); its docstring `:4-7` says harness's groundedness *"is a locally-computed clinical assurance pass, not a call to this service."* So MiniCheck-class NLI is hosted **twice**, in harness and in guardrail. |
| Provenance | **CONFORMS** | `services/provenance.py:260-274` builds a deterministic `citationsMap`; citation-presence and citation-verify sensors; strict-citation prompt blocks; hallucinated-citation filtering (`:243`); full trajectory spine (`api_client.py:913`). |
| Observability | **CONFORMS** | Prometheus (`core/metrics.py:21,46,54,83-101`), Temporal SDK metrics runtime (`temporal/metrics.py:27-53`), OTel with a PHI sanitisation hook (`core/observability.py:30-31,60,126`), structured logs with trace ids. |
| **Database** | **PARTIAL / by design** | No general DB driver — all system-of-record access is HTTP-over-gateway via 19 `api_client.py` methods; stated at `:1-6` and `core/config.py:490-491` (*"harness holds no DB handle"*). One narrow exception: a lazy `asyncpg` import for a *"read-only SQL read, SYSTEM-scoped, fail-closed"* judge selection (`eval/judge/selection.py:32,134-147`). |
| **Object store** | **CONFORMS** | `temporal/claim_check.py:123-146` — `S3BlobStore`, lazy `boto3`, MinIO/S3. Plus a second path for model weights (`models/source_resolver.py:109-129`). |
| **Vector store** | **CONFORMS** | `guides/retrieval/qdrant_store.py:36,87`, constructed `activities.py:681`, driven from `api/endpoints/knowledge.py:115,210`. |
| **MUST interact with `text`, `nlp`, `stt`, `tts`** | ❌ **HALF-ABSENT** | `text_client.py`, `nlp_client.py`, `guardrail_client.py` exist. **No stt client and no tts client** — searched `stt`, `speech`, `transcribe`, `tts`, `synthes`, ports 8861/8865. The stt interpreter nodes are stamped **DELIBERATE PLACEHOLDERS** (`temporal/interpreter/nodes/stt_placeholder.py:1-8`, registry `:153`). For `tts`: **zero hits of any kind.** |

**Three delegation bypasses.** Harness calls model engines directly rather than through `text`:
the safety sensor hits LM Studio (`sensors/inferential/granite_client.py:90-95`, base
`core/config.py:82`), embeddings hit TEI (`services/embeddings_client.py:47`), the reranker hits TEI
(`services/reranker_client.py:54`). The brief makes `text` the owner of text-embedding.

**Config violations.** Five model ids (`config.py:83,202,497,498`; `eval/config.py:94`
`"gemma-4-e2b-it-qat"`), four engine/provider selections (`:80,82,199,206`), ~30 thresholds, and —
notably — a **full risk taxonomy as a code default**: `harm_criteria = ["harm","social_bias",
"jailbreak","violence","profanity","sexual_content","unethical_behavior"]` at `config.py:88-98`.
Mitigating: `:488-493` and `:512-519` explicitly label several as "BOOTSTRAP FALLBACK ONLY", and
`activities.py:480-489` documents that judge selection comes from the DB. The *architecture* is
D-B-aware; the *defaults* remain concrete.

**Caches.** Per-tenant policy has **no cache at all** — a fresh gateway round-trip per workflow run
(`activities.py:768-799`). `core/effective_config.py:108-118` is a single global snapshot, not
tenant-keyed (correct, since it holds only service knobs). `core/consent_client.py:75-79` **is**
tenant-keyed — `f"{tenant_id}::{external_patient_id}::{purpose}"` — and fail-closed (`:210-215`).

**The SYSTEM tenant UUID is absent from harness entirely** (searched `00000000-…`). Harness's
tenant-less convention is the string marker `tenantless:<reason>`
(`text_client.py:131-139`, `nlp_client.py:50-56`, `activities.py:216`) — the same idea as `text`'s.

---

## 3. The `effective-config` plane is SYSTEM-pinned — the structural blocker

The single most consequential architectural finding in the review.

All six Python services poll the same plane —
`GET /api/v1/internal/effective-config?service=<name>` — through structurally identical clients:
`text/core/effective_config.py:205`, `stt/core/effective_config.py:229`,
`tts/core/effective_config.py:159`, `nlp/core/effective_config.py:163`,
`guardrail/core/effective_config.py:163`, `harness/core/effective_config.py:196`.

**That plane cannot carry per-tenant values, deliberately.**
`apps/api/src/modules/internal/effective-config.controller.ts:40-60`:

```ts
// Values are service-level knobs ONLY — never per-request model selection ...
// Re-establish CLS here, pinned to the SYSTEM tenant: every effective-config
// subset resolves platform-level state (SYSTEM-scoped settings and SYSTEM-owned
// profile rows), never a customer tenant's.
return this.cls.run(async () => {
  this.cls.set('tenantId', SYSTEM_TENANT_ID);
  return this.effectiveConfig.resolveForService(service);
});
```

The pinning is *correct on its own terms* — a poll authenticated by a service token, not a tenant,
must not be able to read a customer's rows. The problem is that **it is the only shared config
channel that exists**, while the brief assigns three services a per-tenant obligation.

### 3.1 What it blocks

| Brief obligation | Status via this plane |
|---|---|
| `stt` — per-tenant ASR instructions (brief:76) | **Routed around.** `stt` opened its own SQL connection (`pipeline/config_reader.py:63-70`) for pipeline selection. The plane carries only retention/concurrency, un-tenant-keyed (`stt/core/effective_config.py:255-281`). The instruction *text* remains SYSTEM-only (`core/initial_prompt.py:21`). |
| `tts` — per-tenant TTS instructions (brief:82) | **Blocked.** `tts` has no DB and consumes one key. Per-tenant material reaches it only as gateway-injected request fields. |
| `nlp` — per-tenant NLP instructions (brief:70) | **Routed around, partially.** Gateway injection covers topic and intent (`schemas/classification.py:109-119,126-138`); nothing covers sentiment, toxicity, NER or classification. |

Note the pattern: **every service that needed per-tenant config solved it by leaving the plane** —
guardrail by direct SQL, `stt` by direct SQL, `nlp` and `tts` by gateway injection. Four different
answers to one question is the actual defect.

### 3.2 Options — an owner decision, laid out rather than chosen

**Option A — grow a tenant dimension on the plane.**
`?service=<name>&tenantId=<uuid>`, resolving tenant → SYSTEM, response carrying the resolved tier so
callers can derive funding.

*For:* one plane, one contract, one invalidation story; keeps DB drivers out of the services; the
cascade lives in one audited place (`IEffectiveConfigService`).
*Against:* the guard authenticates a *service*, not a tenant — a service token would become able to
name any tenant, so the guard must be re-reasoned or the caller's tenant attested. **And every
client cache must be re-keyed by `tenantId`** (rule 09 §M4). Today `text`, `stt`, `tts`, `nlp` and
`harness` all hold a *single global snapshot* with no tenant dimension — safe only because the plane
is SYSTEM-pinned. **Un-pinning without re-keying those five caches converts a correct design into a
cross-tenant leak in one commit.** That is the risk that makes A a real project rather than a
parameter addition.

**Option B — direct DB reads, extending guardrail's exception.**

*For:* proven twice in-tree (guardrail's `tenant_config.py`, `stt`'s `config_reader.py`); no gateway
on the hot path.
*Against:* rule 06 grants that exception to guardrail on a narrow rationale — its callers are peer
services, so no gateway exists to inject for it. That rationale does **not** hold for `tts`/`nlp`,
which are gateway-fronted. And the two existing implementations already show the cost: guardrail
leaked a customer tenant before TASK-735, and `stt` has three call sites that forget the tenant
filter (`transcribe_file.py:191,331`; `routes.py:116`). Multiplying the number of places the
two-tier cascade must be re-implemented correctly is how that class of bug recurs.

**Option C — gateway-injects per-request (extend the existing TTS/NLP pattern).**

*For:* already the sanctioned default (rule 06 §"gateway-resolved injection"). Already works in
three services. Services stay stateless with no DB and **no tenant cache to key wrong** — which is
exactly why `nlp` is structurally immune to the leak class. Resolution stays in one place.
*Against:* every instruction-bearing route needs a request-shape change plus a gateway resolver;
it does not serve peer-to-peer calls that bypass the gateway (guardrail's case); and large
instruction payloads ride every request rather than being cached.

**A reviewer's note, not a decision:** C is the smallest step from where the code already is and is
what the rules prescribe; A is the better long-run shape *if* the auth model and the cache-key rule
are fixed in the same change; B should be actively resisted for gateway-fronted services. The
choice is the owner's.

---

## 4. Service interaction graph

```mermaid
graph TD
  SDK["@arcaai/vox SDK · admin-console"]

  GW["apps/api — gateway :8868"]
  TEXT["text :8862"]
  STT["stt :8861"]
  TTS["tts :8865"]
  NLP["nlp :8864"]
  GRD["guardrail :8863"]
  HAR["harness :8866"]

  REDIS[("Redis 8 — Dramatiq broker<br/>streams · pub/sub")]
  TMP[("Temporal :7233")]
  PG[("Postgres 18")]
  OBJ[("MinIO / S3")]
  VEC[("Qdrant :6333")]
  ENG["engines: vLLM · llama.cpp · LM Studio<br/>Ollama · Azure · Bedrock · TEI"]

  SDK -->|HTTPS / WS / SSE| GW

  GW -->|HTTP + SSE| TEXT
  GW -->|HTTP| NLP
  GW -->|HTTP| GRD
  GW -->|HTTP + WS| TTS
  GW -->|"HTTP — UNAUTHENTICATED at stt"| STT
  GW -->|HTTP| HAR

  GW -->|"Dramatiq enqueue stt_batch"| REDIS
  REDIS -->|"consume — REAL MQ"| STT
  GW -->|"XADD stt:audio / stt:control"| REDIS
  REDIS -->|XREADGROUP| STT
  STT -->|"pub/sub stt:transcription"| REDIS
  REDIS -.->|subscribe → SSE to client| GW

  HAR -->|HTTP| TEXT
  HAR -->|HTTP| NLP
  HAR -->|HTTP| GRD
  HAR -->|"HTTP — consent · policy · persistence"| GW
  HAR -.->|"MISSING per brief"| STT
  HAR -.->|"MISSING per brief"| TTS
  HAR -->|"granite · embeddings · reranker — bypasses text"| ENG

  TEXT -->|"HTTP — fail-CLOSED"| GRD
  GRD -->|"judge — recursion-guarded"| TEXT
  NLP -->|HTTP /generate| TEXT
  GRD -->|"OWNS ENGINES + local weights"| ENG
  TEXT --> ENG
  TTS --> ENG

  GRD -->|"direct SQL — sanctioned"| PG
  STT -->|"direct SQL — pipelines + voice profiles"| PG
  HAR --> TMP
  HAR --> OBJ
  HAR --> VEC
  GW --> PG

  TEXT -.->|"effective-config — SYSTEM-pinned"| GW
  STT -.-> GW
  TTS -.-> GW
  NLP -.-> GW
  GRD -.-> GW

  classDef bad stroke:#c00,stroke-width:3px
  class GRD bad
  classDef warn stroke:#e80,stroke-width:3px
  class STT warn
```

### 4.1 Edge table

**T** = tenant propagation. **Fail** = *declared* fail posture.

| # | From → To | Transport | Auth | T | Fail | Evidence |
|---|---|---|---|---|---|---|
| E1 | gateway → `text` | HTTP + SSE | `INTERNAL_ACCESS_TOKEN` → `X-Service-Token` | ✅ mandatory | **closed (428)** | `text-proxy.controller.ts:319`; `generate.py:295-321` |
| E2 | gateway → `nlp`/`guardrail` | HTTP | shared token, **always attached even when empty so the receiver rejects** | ✅ mandatory | **closed, declared** | `ai-inference.client.ts:99-108` |
| E3 | gateway → `tts` | HTTP + WS | shared token | ✅ | ⚠️ **open** on two paths | `speech-proxy.controller.ts:84,91` |
| E4 | gateway → `stt` | HTTP | `X-Internal-Service-Key`; **`stt` verifies nothing** | via `X-Internal-Tenant-Id` | undeclared | `stt/core/api_client/gateway.py:39,100-119`; `stt/main.py:247-261` |
| E5 | gateway → `stt` | **Dramatiq / Redis — real MQ** | Redis ACL only | in payload | broker retry (`AgeLimit`, `Retries`) | `transcription-job.controller.ts:430`; `stt/worker.py:289` |
| E6 | gateway ⇄ `stt` | Redis Streams + pub/sub | Redis ACL only | session-scoped | undeclared | `streamingAudioBridge.service.ts:260,303`; `redis_streams.py:383` |
| E7 | gateway → `harness` | HTTP | `X-Service-Token` | ✅ | closed | `harness-ops.client.ts:97` |
| E8 | `harness` → gateway | HTTP | `INTERNAL_ACCESS_TOKEN` | ⚠️ in **body/query**, not header | mixed — policy degrades to defaults but 401/403 is non-retryable + loud | `api_client.py:287,169`; `activities.py:756-758,780-794` |
| E9 | `harness` → `text` | HTTP | `INTERNAL_ACCESS_TOKEN` | ✅ raises if blank | **closed post-send** (`retry_on_timeout=False`, never re-invokes a dispatched prompt) | `text_client.py:134-139,171,192-205` |
| E10 | `harness` → `nlp` | HTTP | `INTERNAL_ACCESS_TOKEN` | ✅ raises if blank | **fail-safe → forces human review**, explicitly not fail-open | `nlp_client.py:53-56,65`; `workflows.py:556,591-592` |
| E11 | `harness` → `guardrail` | HTTP | `X-Service-Token`, unconditional | ✅ mandatory | **closed — and refuses to inherit guardrail's own fail-open** | `guardrail_client.py:13-21,115-117,146-148`; `guardrail_check.py:85-103` |
| E12 | `harness` → TEI / LM Studio | HTTP | — | ❌ | degrade-safe | `embeddings_client.py:47`; `reranker_client.py:54`; `granite_client.py:90-95` |
| E13 | `text` → `guardrail` | HTTP | `INTERNAL_ACCESS_TOKEN` | ✅ | **closed — best-documented in mesh**; no fail-open branch exists | `external_guardrail.py:24-29,66-71,135-141`; `config.py:355-358` |
| E14 | `guardrail` → `text` (judge) | HTTP | shared token | log-correlation only | recursion-guarded | `judge.py:172-192`; `judge_guard.py:35,56-73` |
| E15 | `nlp` → `text` | HTTP `/generate` | `INTERNAL_ACCESS_TOKEN` | ✅ mandatory, 428 | **closed** — retry ×3 then raise → 503 | `external_text_client.py:12-18,66,89,141-143` |
| E16 | `guardrail` → LLM engine | HTTP | `Authorization: Bearer` | ❌ | ⚠️ **OPEN — timeout returns `safe: True`** | `providers/openai_compat.py:105-110,150-156` |
| E17 | `guardrail` → Postgres | direct SQL | DSN **in a source literal** | ✅ tenant-keyed cache | closed on veto, open on tuning | `tenant_config.py:118,471,534`; `config.py:246` |
| E18 | `stt` → Postgres | direct SQL | DSN | ⚠️ **3 call sites omit the filter** | closed | `config_reader.py:63-70`; gaps `transcribe_file.py:191,331`, `routes.py:116` |
| E19 | all six → gateway config | HTTP | service token | ❌ **SYSTEM-pinned** | **open** everywhere, by design | §3 |

### 4.2 Cycles

**C1 — `gateway ⇄ harness` (real, deliberate, unguarded).** E7 + E8. The gateway starts and signals
Temporal workflows *into* harness while harness reads consent, policy and persistence *out of* the
gateway. Mitigations present: idempotency keys (`api_client.py:287-292`), Temporal durability,
fire-and-forget trajectory, and a short timeout so *"a wedged gateway never holds a phase boundary
hostage"* (`activities.py:347`). **Not present: a circuit breaker in either direction.** A gateway
stall inside `assemble`/`persist_draft` holds a harness activity slot (capped at 8,
`config.py:544`) while the gateway may itself be awaiting a harness admin call.

**C2 — `text ⇄ guardrail` (real, and correctly guarded).** E13 + E14. Broken structurally rather
than by convention: the judge route sits outside the moderation gate and a `ContextVar` tripwire
raises `GuardrailRecursionError` on re-entry (`judge_guard.py:35,56-73`, asserted
`generate.py:220`). **This is the best piece of defensive design in the mesh** and is the pattern
TASK-735 Phase 2b must preserve when guardrail starts calling `text` for judgement in earnest. That
ticket's own acceptance criterion names the test — *"a `text/generate` under a saturated pool still
gets a judge verdict"* (`TASK-735 README:257`).

**No cycle involving `stt`, `tts` or `nlp`.**

---

## 5. Prioritized gap register

**P0** blocks the brief structurally or is a live security exposure · **P1** a named MUST is unmet ·
**P2** quality/hygiene.

| ID | Sev | Gap | Evidence | Proposed ticket |
|---|---|---|---|---|
| **F-01** | **P0** | **`stt` has NO inbound authentication.** No `X-Service-Token` middleware, no `internal_access_token` field. Every `/internal/*` route on :8861 — including `POST /internal/streaming/drain` and `POST /internal/cache/clear` — is unauthenticated at the service. `cors_origins` also defaults to `["*"]` on a PHI service. | Searched `apps/stt/src` for `X-Service-Token`/`ServiceAuthMiddleware` — zero hits; `stt/main.py:247-261`; `settings.py:50` | **Extend TASK-738 to `stt`.** Add the middleware the other five have and bind `INTERNAL_ACCESS_TOKEN` (D-D). Keep the deliberate `X-Internal-Tenant-Id` substitution (`gateway.py:100-119`) — that reasoning is sound. |
| **F-02** | **P0** | **`tts` WebSocket auth is bypassable under D-D.** `BaseHTTPMiddleware` never sees WS scope; `_authorized()` reads only `settings.service_token`, not `accepted_service_tokens`. Set only `INTERNAL_ACCESS_TOKEN` and drop the legacy var — the documented D-D end state — and `if not token: return True` opens the WS synthesis surface while HTTP stays protected. | `tts/api/middleware/auth.py:33`; `stream_ws.py:100-105`; `tts/core/config.py:180-194` | **One-line-class fix + regression test.** Point `_authorized()` at `accepted_service_tokens`. Small, urgent. |
| **F-03** | **P0** | **`guardrail` owns engines instead of delegating.** A five-vendor LLM client with its own Granite BYOC protocol, an in-process ONNX NER/PII engine with hardcoded taxonomies, and a GGUF NLI scorer bound to llama.cpp private internals. No client to `text` or `nlp` exists. Contradicts brief:63. **And its LLM call fails OPEN** — a timeout returns `safe: True`. | `providers/{gliner.py:106,114, _granite.py:18-43, openai_compat.py:105-110,150-156}`; `groundedness_scorer_minicheck.py:142-207` | **Resume TASK-735 Phases 2b/3/4-python** (status `Pending`). D4 already specifies the end state. Two hard gates: the saturated-pool judge test (`README:257`) before closing C2, and flipping the engine-call posture to fail-closed. |
| **F-04** | **P0** | **The per-tenant config plane cannot carry per-tenant config.** SYSTEM-pinned by design; the four services that needed tenant config each left the plane by a different route. | `effective-config.controller.ts:47-58`; §3 | **New TASK — "Tenant-aware service config plane."** Owner picks A/B/C from §3.2. Fixed acceptance criterion whichever wins: **every per-tenant cache key includes `tenantId`** (rule 09 §M4) — today five clients hold un-keyed global snapshots that are safe *only* because the plane is pinned. |
| **F-05** | **P0** | **Guardrail's hardcoded engine/model/threshold defaults**, including four clinical thresholds, six Granite ids that **Azure and Bedrock inherit** despite not hosting Granite, and **DB credentials in a source literal**. | `guardrail/core/config.py:28,32-39,53,98,110,122,127-128,155-156,183,246,299`; inheritance at `:56,72` | Same ticket as F-03 (owner decision 735 explicitly assigns it). Split the DSN literal out as an immediate hygiene fix. |
| **F-06** | **P1** | **`guardrail` never enforces `X-Tenant-Id`.** Six read sites use `headers.get(...)` with no None-check; an absent header silently resolves SYSTEM. Async jobs pass `tenant_id=None` outright. Guardrail defined `TENANTLESS_PREFIX` and never uses it as a gate, while `nlp` returns 428 for the same condition. | `core/dependencies.py:90,370,410`; `guardrails.py:77,123`; `redact.py:286`; `main.py:136-138` vs `nlp/classify.py:43-52` | **Complete TASK-737 in guardrail.** Copy `text/api/endpoints/generate.py:295-321` verbatim — 428, with the `tenantless:<reason>` escape for the job path. |
| **F-07** | **P1** | **`stt` tenant filter is omitted on three DB call sites**, defeating the documented cross-tenant guard on the entire MQ path. | `transcribe_file.py:191,331`; `transcription/api/routes.py:116` vs correct usage `session_manager.py:987-995` | **Small, high-value ticket.** Thread `tenant_id` through the Dramatiq payload and the UUID branch; add a cross-tenant regression test. |
| **F-08** | **P1** | **`harness` cannot reach `stt` or `tts`**, and bypasses `text` for embeddings/reranking/safety. Brief:88 mandates all four. **Memories are entirely absent.** | No stt/tts client in `harness/services/`; placeholders `nodes/stt_placeholder.py:1-8`; `embeddings_client.py:47`, `granite_client.py:90-95`; searched `memor*` | **Two tickets: "Harness speech clients"** (mirror `nlp_client.py` — shared token, mandatory tenant, declared posture; route embeddings through `text`) **and "Harness memory layer"** (brief:85; currently nothing exists). |
| **F-09** | **P1** | **SSE absent in 4 of 6.** `stt` produces SSE-shaped events onto Redis and the gateway owns the socket — capability reaches clients, obligation unmet at the service. | §1.1 | **New TASK — "SSE parity."** Scope per service against real need (`harness` run progress, `stt` transcription events have obvious consumers); record a justification where SSE is genuinely not warranted rather than building it for its own sake. |
| **F-10** | **P1** | **The ratified async envelope is unwired.** Zero Python importers of `hope_async_contract` — confirming TASK-717's own admission. Only `stt` has a genuine broker interface, and it carries no envelope. No Python service touches the platform sys-event bus. | §1.2 | **New TASK — "Wire `AsyncEnvelope` onto the real transports."** Adoption, not design: both language packages, a shared example corpus and `assertAsyncConformance` already exist. Start with `stt`'s Dramatiq payload (a real cross-service edge) and `text`'s stream path. |
| **F-11** | **P1** | **`text`'s drain is inert and its pool health is stale-by-construction.** `initiate_shutdown()` has zero production callers; `/health/ready` ignores the draining flag, so k8s keeps routing through the drain. `PoolHealthTracker` is populated **only** by inbound `GET /health` — with no prober, degrade routing is a permanent no-op. No HPA/KEDA manifests exist. | `shutdown_manager.py:36`; `health.py:122-146`; `pool_health.py:27-33` vs sole caller `health.py:78` | **New TASK — "Text lifecycle + health probing."** preStop → `initiate_shutdown()`, readiness reflects draining, background prober (or document the k8s probe interval as the contract and assert it). |
| **F-12** | **P1** | **`stt` has no pool control plane; AWS Transcribe absent.** TASK-726 added drain + one metric to existing per-process primitives — its design note says so. No `pool_router`/`pool_health` equivalent, no degrade routing, no pool API. | `TASK-726/design-notes.md:4-7`; searched `aws`/`boto`/`Transcribe` in `apps/stt/src` | **New TASK — "STT pool control plane"** (port `text`'s `resolve_pool_route` + tracker). AWS Transcribe is a separate, smaller ticket — confirm it is still wanted first. |
| **F-13** | **P1** | **`text`'s worker pool executes only embeddings**; `batch_generation` raises `NotImplementedError` while registered as a live consumer, and `/worker-pools` advertises a pool nothing can fill. **Embeddings themselves bypass guardrail, limiter, breaker and tenant enforcement, and `tei-embed` is never health-checked.** | `worker.py:128-138,162-164`; `worker_pools.py:40`; `embeddings.py:36-55`; `health.py:69` vs `main.py:204-215` | **New TASK — "Text batch-generation dispatch + embedding parity."** The residual is correctly flagged rather than faked; the work is re-threading `/generate`'s machinery for an out-of-process caller, and putting `/embeddings` behind the same gates. |
| **F-14** | **P1** | **`nlp`: clustering absent; sentiment/toxicity are task-key aliases with no code**; multi-label toxicity is representationally impossible; and the classifier **fabricates a label** on exception. | Searched `cluster`/`kmeans`/`hdbscan` — zero; `TASK-729 README:414-419`; `text_classifier.py:114-120` | **Close TASK-729's open questions**, fix the fabrication to fail closed (matching `external_text_client.py:12-18` in the same service), then scope clustering if still wanted. |
| **F-15** | **P1** | **`tts` has no batch path — and the brief and the design doc disagree.** | 8 routes, none batch; `design.md:112` vs brief:80 | **Owner decision first, ticket second.** Do not build speculatively — reconcile the documents, then scope. |
| **F-16** | **P1** | **`stt` mislabelled customer-tenant constant — LATENT, not active.** `DEFAULT_TENANT_ID = "50000000-…"` is the **customer** "Global" tenant, commented *"Default tenant ID (system-wide)"*. Verified: **no non-test consumers** — a grep of `apps/stt/src` returns only the definition. The sole importer is a test that asserts the value. A landmine any future `tenant_id or DEFAULT_TENANT_ID` would trip, **not** a live leak. | `stt/core/config/constants.py:9`; `apps/stt/tests/unit/test_constants.py:30` | **Small ticket: delete the constant and its assertion test together.** The test currently pins the landmine in place. Also purge the stale `guardrail.egg-info/PKG-INFO:325`, which still advertises the retired `GUARDRAIL_DEFAULT_TENANT_ID=50000000-…`. |
| **F-17** | **P2** | **D-D is half-wired.** `peer_service_token()` is used for peer calls, but **gateway** calls in `text`, `nlp` and `guardrail` still pass the legacy per-service token. A deployment that sets only `INTERNAL_ACCESS_TOKEN` sends an **empty** token for effective-config and self-registration — and effective-config fails open, so the breakage is invisible. | `text/main.py:297,325` vs `:160`; `nlp/lifespan.py:34,65` vs `:48`; `guardrail/main.py:58,162` | **Finish TASK-738.** Three one-line changes plus a test asserting the gateway hop uses `peer_service_token()`. |
| **F-18** | **P2** | **`text` control-plane timeouts are fetched, stored and never applied.** `runtime_timeouts` is injected and unread; the real timeout is a pure-env lookup whose map omits ollama/openai/anthropic/vertex, silently defaulting them to 120 s. **Streaming generations also bypass the per-provider semaphore entirely.** | `generate.py:350` vs `:250-262`; `config.py:71`; `generate.py:498-517` vs `:524-531` | Fold into F-11's ticket. |
| **F-19** | **P2** | **`text` guardrail moderation defaults to DISABLED**, and `GENERATION_DEFAULTS` (temperature/max_tokens/top_p) are frozen module constants with **no env, DB or control-plane override path**. | `core/config.py:371` (acknowledged `:366-370`); `core/defaults.py:10-14` | Small ticket: flip the default per D-A ("enabled for day-1"), and move the hyperparameters to `AiTaskDefault`. |
| **F-20** | **P2** | **`nlp` CORS defaults to `["*"]` with `allow_credentials=True`** — spec-invalid, on a token-authenticated service. Guardrail gets this right (`[]`, disabled). | `nlp/core/config.py:388,391`; `app.py:41-47` vs `guardrail/core/config.py:314-315` | Small security ticket. |
| **F-21** | **P2** | **`nlp` ontology linking is ~40 hardcoded literals** with a confidence floor of `0.0` (gate disabled by default). It is a demo fixture presented as UMLS/SNOMED/RxNorm/ICD/LOINC support. | `services/ontology_linker.py:94-184`; `core/config.py:331` | Scope decision needed: real terminology service, or relabel the capability honestly in the brief. |
| **F-22** | **P2** | **`harness` MCP has one hardcoded tool and an untested transport.** `MCP_TERMINOLOGY_TOOL = "validate_codes"` with no `list_tools()` discovery, and `mcp_client.py:130` imports `httpx2` — **a package absent from `pyproject.toml`** — on a path marked `# pragma: no cover`. Server config is correctly DB-driven; the call path may not import at runtime. | `workflows.py:196`; `tools/mcp_client.py:127,130` | Small ticket: verify the dependency, add tool discovery, remove the coverage exemption. |
| **F-23** | **P2** | **Guardrail's job plane is unmaintained.** `GUARDRAIL_V2_QUEUE_` and three `RedisConfig` fields have **zero read sites**; `guardrail:status:*` hashes never expire; `list_jobs`/`get_job_stats` do an unbounded `KEYS` scan; `guardrail:results` is written and never read. Its tenant-config cache is also TTL-only (60 s) with no invalidation channel. | `config.py:202-204,207-218`; `job_processor.py:54,141,194,380,411`; `tenant_config.py:79-83` | Small ticket: delete dead config, add TTLs, replace `KEYS` with a scan or index, add the invalidation subscriber once the gateway publisher exists. |
| **F-24** | **P2** | **No committed OpenAPI/AsyncAPI artifact anywhere**, and documentation defects are concrete: `stt` omits 12 of 25 routes including its primary batch API; `nlp` documents a 404 path and omits auth entirely; `guardrail` omits `/ground` and `/redact`; `harness` omits all three loop signals; `text` gives the wrong OpenAPI URL. | §1.3 | **New TASK — "Publish and CI-gate service API specs."** Export FastAPI's OpenAPI at build time, commit it, fail CI on undeclared drift. That mechanically fixes most of the omissions above. |
| **F-25** | **P2** | **Two gateway → `tts` paths declare fail-**open**.** Every other declared posture in the mesh is fail-closed. | `speech-proxy.controller.ts:84,91` | Confirm intent (kill-switch-gated, so possibly correct) and document it; otherwise close it. |

---

## 6. What is genuinely good

The gap register is not the whole picture. These are worth protecting during remediation:

- **The `text ⇄ guardrail` recursion guard** (`judge_guard.py:35,56-73`) — a `ContextVar` tripwire
  that makes the cycle structurally impossible rather than conventionally avoided. The best
  defensive design in the mesh, and the thing TASK-735 Phase 2b must not break.
- **`text`'s tenant enforcement** (`generate.py:295-321`) — fails closed with 428 *and* supports a
  declared `tenantless:<reason>` marker, which is the correct answer to "absent is indistinguishable
  from dropped". `nlp` and `harness` adopted it; `guardrail` and `stt` have not.
- **`text`'s guardrail client** (`external_guardrail.py:24-29,135-141`, `config.py:355-358`) —
  declares the posture in the docstring, implements it, and records that the `fail_open` option
  *"was retired"*. Every peer client should read like this.
- **`harness`'s guardrail client explicitly refuses to inherit guardrail's fail-open**
  (`guardrail_client.py:13-21`) — a transport failure raises rather than synthesising `safe=True`,
  and a non-null `analysis.error` beside `safe=True` is rejected as "no verdict"
  (`guardrail_check.py:94-103`). Defensive against a peer's known weakness.
- **The `50000000-…` cascade bug was fixed properly** — the knob was **deleted rather than
  repointed** (`guardrail/core/config.py:248-254`), with negative regression tests
  (`tests/test_tenant_config.py:655,788`). The strongest correctness result in this review.
- **`nlp` bars model identity from env, dotenv *and* Vault `secrets_dir`**
  (`core/config.py:21-74`) — reasoning at `:57-62` that a `/vault/secrets/NLP_MODEL_NAME` file must
  not select a model. This is what D-B looks like when taken seriously.
- **`tts`'s router fails closed with no injected chain** (`router.py:55-71,188`) and carries no
  vendor default — and `tts` deliberately made its BYOK keys un-settable from env
  (`config.py:44-47`).
- **`nlp`'s unconfigured-classifier sentinel** (`core/config.py:246`) — the comment records that the
  previous default was an *emotion* model silently serving clinical document-type classification.
  Replacing a plausible-looking wrong default with a loud sentinel is the right fix.
- **`harness`'s HITL gate** — a genuinely durable clinician gate raced against an SLA timer, where
  degradation **forces** human review rather than auto-passing (`workflows.py:290,556`).
- **`nlp`'s documentation structure** (`docs/01..06`) is what the brief's "documented internal
  architecture" obligation looks like in form — it just needs to be brought back in sync.

---

## 7. Verification statement

No source file was modified. No test suite, build, migration, database or cluster operation was run.
Every `file:line` above was read during this review, on branch `feat/loop`. Claims of absence name
the search terms used so they can be re-tested. Two findings from an earlier draft were corrected by
a deeper pass and are marked as corrections in §0, §1.2 and §2.2; one was narrowed to "latent" on
independent verification (F-16).
