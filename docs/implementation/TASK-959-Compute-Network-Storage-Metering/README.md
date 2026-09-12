# TASK-959 — Compute, network and storage metering for billing and invoicing

| Field | Value |
|---|---|
| Status | In Progress — D-1..D-5 approved 2026-09-12 as recommended; lanes running (§10) |
| Type | `feature` (ledger units + emitters + price rows + storage snapshot job) |
| Branch | `dev-2.2` |
| Requested | 2026-09-12 — the owner's measurement model (§1) |
| Depends on | TASK-957 (agent/workflow metering review — the token side; F-1 `workflow.step` and F-2 `usage_detail` land first), TASK-958 (`connectionId` on the ledger row, in flight in another session — this ticket reads it, never writes it) |
| Precedent | TASK-874 (STT engine-time per fallback leg), TASK-615 (ledger + price book), TASK-890 OD-E (every inference activity counts) |

## 1. Requirement Analysis — the owner's measurement model

Five measurements, applied per funding leg:

| # | Measure | Applies to |
|---|---|---|
| M-1 | Tokens processed and generated: input, output, reasoning, cache read/write | every call that uses a generative LLM, built-in or third-party |
| M-2 | GPU time spent handling models and inference | built-in engines that run on a GPU (LM Studio, vLLM, STT) |
| M-3 | CPU time spent handling models and inference, and CPU time spent CALLING a third-party provider | built-in engines on CPU (NLP, TTS, guardrail, TEI); every outbound third-party call |
| M-4 | Network consumption when calling third-party providers | every outbound call to Azure, OpenAI, Anthropic, Google, Bedrock, Sarvam |
| M-5 | Storage consumed by data generated during usage: recordings, transcripts, text, uploaded files | every tenant, continuously |
| M-6 | CPU time the durable-function server (the Temporal worker, `hope-harness-worker`) spends handling each workflow run — orchestration, node activities, sensors, claim-check I/O — separate from the inference legs the run calls | every workflow run, both the interpreter and the consultation lane (added 2026-09-12) |

Three funding legs, and a fallback moves a call from one leg to another mid-flight:

| Leg | Who pays the vendor | Ledger encoding today | Measures |
|---|---|---|---|
| **Built-in** — self-hosted engines (stt, tts, nlp, guardrail, LM Studio, Ollama, vLLM, llama.cpp, TEI) | the platform's own hardware | `deployment: SELF_HOSTED`, `costBasis: INTERNAL` | M-1 (when an LLM), M-2 or M-3, M-5 |
| **Platform third-party** — a vendor on the platform's key, configured by the platform admin as the fallback | the platform | `deployment: CLOUD`, `costBasis: INTERNAL` | M-1, M-3 (calling), M-4, M-5 |
| **Tenant third-party (BYOK)** — a vendor on the tenant's own connection | the tenant, directly | `deployment: BYOK`, `costBasis: BYOK_NOTIONAL` | M-3 (calling), M-4, M-5; M-1 recorded for visibility, never invoiced (D14) |

A BYOK call that fails and falls back to built-in records the BYOK leg's CPU + network for the attempt AND the built-in leg's tokens + GPU/CPU for the work that actually completed. Each leg is its own set of rows, sharing the `requestId`, each with its own `deployment` and `costBasis` — the TASK-874 span design applied to every capability.

## 2. Design principle — no new grain, new units

The ledger is already one row per `(request, unit)` and one call already lands as several rows sharing a `requestId` (input tokens, output tokens, cache reads, …). Every new measure below is **another unit row on the same request**, not a new event shape, a new table, or a new operation. `AiUsageRollupDaily` is keyed on `(tenant, day, capability, operation, provider, deployment, model, unit)`, so the rollups, the meters and the invoice engine absorb a new unit by adding it to one allow-list each.

### 2.1 Units

| Unit | Status | Grain | Emitted by | Rated how |
|---|---|---|---|---|
| `INPUT_TOKEN` `OUTPUT_TOKEN` `CACHE_READ_TOKEN` `CACHE_WRITE_TOKEN` `REASONING_TOKEN` | exist | per request | text (via gateway / harness) | COST per provider+model; SELL pooled into `monthlyLlmTokens` |
| `GPU_SECOND` | exists in the enum and the COST seed; **never emitted** | per request, on the same batch as the tokens / audio seconds | every GPU-hosted built-in engine (§3) | COST row `B1000000-…-0014` (placeholder $1.98/GPU-hour); SELL: a new pooled `monthlyComputeSeconds` allowance, or priced into the plan fee (D-2) |
| `CPU_SECOND` | **new** | per request | every CPU-hosted built-in engine; every outbound third-party call on the calling service (§3) | COST placeholder (amortised vCPU-hour); SELL as above |
| `EGRESS_BYTE` `INGRESS_BYTE` | **new** (two units, so direction stays a dimension of the row, not an attribute) | per outbound third-party call | the one HTTP interception point per calling service (§4) | COST 0 today (the tunnel bills nothing per byte); SELL optional |
| `STORAGE_GB_DAY` | **new** | one row per (tenant, storage class) per UTC day; quantity = bytes held at the snapshot ÷ 10⁹ (Decimal(24,6): 1 KB resolution) | a nightly snapshot job (§5) | COST from amortised disk per GB-day (~2,667 µ placeholder); SELL per GB-month = Σ GB-days ÷ days in period. A byte-day is unpriceable at integer-micro precision (~0.0000027 µ), which is why the unit is the gigabyte-day (W0 finding, 2026-09-12) |

`GPU_SECOND` and `CPU_SECOND` are **occupancy seconds**: the wall-clock time the request held the model / worker on that device. They are not scheduler CPU cycles or DCGM SM-active time. That is the honest fast-win: it is what every service already measures per request (§3), it is what the tenant occupied, and it is what a SELL rate can be attached to today. COGS reconciliation against physical hardware is a monthly comparison of Σ `GPU_SECOND` with DCGM utilisation, not a per-request measurement (§6).

### 2.2 Capabilities and operations

- No new **operation**: compute and network rows carry the operation of the call they belong to (`generate`, `transcribe.batch`, `tts.synthesize`, `ner.extract`, `embed`, `workflow.step` after TASK-957 F-1).
- Two new **capability** members: `STORAGE` for the snapshot rows, and `WORKFLOW` for the durable worker's own compute (M-6, §3.4) — a run's worker CPU is neither STT nor LLM, and giving it its own capability is what lets the invoice engine give it its own allowance and line without touching the inference capabilities.
- `STORAGE` is (`operation: storage.snapshot`). Storage is not an AI capability, but the ledger is the billing plane and the invoice engine iterates `AiCapability`; a parallel storage plane would be a second invoice engine.
- `AiUsageUnit`, `AiCapability` and `UsageMeterMetric` are Prisma enums, so each addition is one migration (`ALTER TYPE … ADD VALUE`); the schema was baselined in `20260817000000_init` and has no later enum migration to copy — the shape is the `ResourceType` precedent in `03-domain-layer.md` §4.

### 2.3 Rollout gates the code already imposes

| Gate | Where | Consequence for rollout order |
|---|---|---|
| An event with no matching COST row still appends, **unrated** (`unitPriceMicros`/`costMicros` null) | `usage-outbox.drainer.ts:190-215` | Emitters may ship before COST rows exist; COGS for those days is simply null, never wrong. |
| A billable unit with no SELL rate makes the invoice draft **throw** (`MissingSellRateError` → 409) | `billing.service.ts:504-511`, seed comment at `20-ai-price-book.ts:498` | A new unit must NOT enter `BILLABLE_UNITS` until its SELL row is seeded; until then it is metered and visible, not invoiced. That is the safe two-step. |
| Allowance columns are per `AiCapability` (`monthlyLlmTokens`, …) | `allowances.ts:24-45`, `entitlement.prisma:107-111` | Compute seconds need their own allowance column(s) or a decision to price them into the plan fee (D-2). |
| Unknown attribute keys are rejected | `usage-attributes.ts` | `device` (`cuda` / `mps` / `cpu`) and `leg` (`primary` / `fallback`) become allow-listed keys. |

## 3. Compute seconds per service — what is measured today and the cheapest derivation

### 3.1 The one fact that shapes the design: wall-clock on the model is measured everywhere, GPU-seconds nowhere

Every service already times its inference per request. None of them attributes a physical GPU-second to a request, and none can: LM Studio runs `LMS_PARALLEL=8` decode slots per replica, vLLM batches continuously, STT's streaming scheduler batches utterances from up to 20 sessions per GPU and the on-prem cluster time-slices two cards into six units, and NLP's `MicroBatcher` folds concurrent requests into one forward pass. Summing per-request wall-clock over-counts physical GPU time by the concurrency factor in force at that instant, and no service records that factor.

So the unit this ticket emits is **occupancy**: the seconds a request held the model on a device. That is the tenant-facing measure (what the tenant occupied), it is already measured, and the price book absorbs concurrency without per-request arithmetic: the COST row for `GPU_SECOND` is per provider, so an LM Studio occupancy-second is priced at the GPU-hour rate ÷ its parallel slots. Physical truth for COGS comes from the DCGM exporter the production Prometheus already scrapes, pod-labelled (`observability-config.yaml:290-294`, `dashboards/gpu.json`, `DCGM_FI_DEV_GPU_UTIL{pod=~"hope-stt.*"}`): a monthly reconciliation of Σ occupancy against Σ utilisation per pod, not a per-request join.

Device is a **deployment property**, not a per-request discovery: STT resolves it per process (`execution_profile.py:108-118`, `LoadedModel.device`), TTS and NLP per settings (`tts/core/config.py:88,112,150` default `cpu`; `nlp/core/device.py`), and the text service knows nothing at all (no `device` field on `ProviderOverride`, `GenerateRequest`, or `AiModel` — `computeType` is a precision, not a device). The emitters therefore stamp `attributesJson.device` from what the SERVING service reports, and for the LLM engines from a settings-registry descriptor `metering.compute.deviceByProvider` (SYSTEM default `{ lm-studio: cuda, vllm: cuda, ollama: cuda, llama-cpp: cpu }`, tenant-overridable for a BYO self-hosted server; `db-config` tier, `failMode: open-to-default` — a missing entry records `CPU_SECOND`, the cheaper unit, never nothing). `device` decides the unit: `cuda`/`mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND`.

### 3.2 Per service

| Service / path | Number that exists today | Where it is lost today | Fast-win change | Python change? |
|---|---|---|---|---|
| **STT batch** (`transcribe.batch`) | `processingTimeSeconds` — computed at `batch_service.py:720`, sent by `gateway.py:complete_job`, **declared on `InternalCompleteJobRequest`** (`internal.request.ts:204-211`) and stored | `emitBatchUsage` (`sttInternal.service.ts:549-586`) emits `AUDIO_SECOND` only | add one `{ unit: GPU_SECOND│CPU_SECOND, quantity: processingTimeSeconds }` to the same batch; device from a new `device` field on the callback | one field (`device`) on the callback, from `LoadedModel.device` |
| **STT streaming** (`transcribe.stream`) | `cumulative_processing_seconds` — accumulated per utterance at `inference.py:888`, read at `session_manager.py:4118` for Prometheus, then dropped before the teardown dict | the pushback DTO (`stt-streaming-usage.request.ts`) carries `audio_seconds`, `session_seconds`, `segments[]` but no processing time | add `processing_seconds` per TASK-874 `UsageSegment` (so a fallback leg carries its own compute), declare it on the DTO, emit it as a unit row beside `SESSION_SECOND` | thread the counter into the segment (`usage_segments.py`) |
| **TTS** (`tts.synthesize`) | `gen_s` — `perf_counter` around the whole synthesis (`routing/router.py:401`), fed to `TTS_RTF` and discarded | no timing header; the gateway reads `X-Tts-Characters/Audio-Seconds/Provider/Connection-Id` only | add `X-Tts-Synthesis-Ms` and `X-Tts-Device` beside `X-Tts-Audio-Seconds`; `speech-proxy`, `harness-tts-internal` and the agent speech route emit the unit row | two headers |
| **NLP** (`ner.extract`, classify) | `track_model_inference` (`nlp/core/metrics.py:177-189`) measures `perf_counter` delta into a histogram and returns nothing | response schemas carry no timing; `nerUsageEvent.ts:65-89` emits `TEXT_UNIT` + `REQUEST` | the context manager returns its elapsed value; `inference_ms` + `device` go on the classify/NER response; `buildNerUsageEvent` adds the unit row | small |
| **Text / LM Studio, vLLM** (`generate*`, `workflow.step`) | `GenerationStats.total_ms` (`stats.py:121`, client wall clock, always present) — already inside `usage_detail`/`stats` on every response and terminal frame | `buildLlmUsageInput` / `harness-usage.mapper.ts` map tokens only | map `total_ms` to the unit row when `deployment === SELF_HOSTED`; device from the descriptor above | none |
| **Text / llama.cpp** | native `timings.prompt_ms + predicted_ms` (`stats.py:293-329`, in `engine_native`) | same | prefer the native sum over `total_ms` when present (engine time, not client time) | none |
| **Text / Ollama** | native `total_duration` − `load_duration` (ns, in `engine_native`, `stats.py:258-267`) | never promoted to a field | same, ns → s | none |
| **Text / cloud, BYOK** | `total_ms` | — | emit `CPU_SECOND = total_ms` on the CALLING service's behalf: the owner's "CPU time used calling the provider". Priced at a vCPU rate, tagged `device: cpu`, `deployment: CLOUD│BYOK` | none |
| **Guardrail** | nothing — hosts no models since TASK-735; its LLM and NER calls are text's and nlp's, already timed there | — | nothing to emit; guardrail rows stay token-only | none |
| **Embeddings / reranker (TEI)** | nothing on the HOPE side; TEI exposes `te_request_duration_seconds` itself but is not scraped in the dev compose | `ingest-knowledge-document.processor.ts` and `embeddings_client.py` have no timer | wrap the embed HTTP call in a timer, emit `CPU_SECOND` (TEI runs the CPU image by default) on the existing `embed` row | none |
| **Model cold-start** | STT measures `model_loading_seconds` (`batch_service.py:399`) and folds it into the total; no other service measures it | — | out of scope for R1: load time is a platform cost shared by every request after it, not one tenant's; it stays inside the occupancy second on the request that paid it | — |

The pattern is the same everywhere: the number exists, one field or header carries it to the emitter, the emitter appends one unit row to a batch it already writes. No new event shape, no new callback, no new queue.

### 3.4 The durable-function server — CPU per workflow run (M-6)

**What runs where.** Every workflow node, sensor, claim-check write and run-event emission is a Temporal **activity** executed by `hope-harness-worker` (its own Deployment, `replicas: 1`, CPU request 1 / limit 4 — `harness-worker.yaml:33, 180-184`); the interpreter issues one `execute_activity` per node (`interpreter/workflow.py:837`) plus per-stage config and event activities. All 94 activities are `async def`, so on one worker they share one event-loop thread, admitted up to `max_concurrent_activities = 8` (`core/config.py:672`, `worker.py:336`). Orchestration itself (the `@workflow.defn` bodies and their replay on every workflow task) runs in the SDK sandbox on the same process.

**What is measured today.** Wall-clock per trajectory step (`AgentTrajectoryStep.durationMs`, `agent-trajectory.prisma:109`, set by `_TrajectoryBatch.record`) — but only the six node paths that record a step, and it is occupancy: an LLM node's 20 s are 20 s of waiting on the text service, not worker CPU. No CPU clock is read anywhere in the worker. The pod's CPU IS scraped: `container_cpu_usage_seconds_total` is in the cAdvisor keep-list (`observability-config.yaml:627`), so worker CPU per pod per month is already in Prometheus — the reconciliation source, not a per-run figure.

**The seam.** `Worker(...)` at `worker.py:294` takes no `interceptors=` today; `temporalio 1.31.0` (installed) exposes `Worker(interceptors=[...])` with `ActivityInboundInterceptor.execute_activity`, and the repo already relies on the same mechanism — the OpenTelemetry `TracingInterceptor` wired on the client (`temporal/client.py:38-40`) IS a worker interceptor and wraps every activity. One more interceptor, `ComputeMeteringInterceptor`, wraps every activity execution without touching any activity's code:

- **Measure.** On the loop thread, `time.thread_time()` is the CPU the worker's Python actually burned (the SDK's Rust core runs on its own threads and is excluded — it is per-pod overhead, reconciled below). Concurrent activities share that clock, so the interceptor keeps a small in-flight registry and, at every enter/exit transition, apportions the thread-CPU delta since the last transition equally across the activities in flight. Each activity leaves with its fair share, `cpu_ms`, plus its exact `wall_ms`. Fair-share is the documented approximation; it is exact when one activity runs alone, and it always sums to the thread's true CPU.
- **Identify.** `activity.info()` gives `workflow_id` (= `sessionId`), `workflow_run_id` (= `runId`), `activity_id`, `attempt`, `activity_type`. The ledger key is `harness:cpu:<workflow_id>:<run_id>:<activity_id>:<attempt>` — stable under a Temporal redelivery of the same attempt, distinct for a real retry (attempt + 1 is a second execution that really burned CPU).
- **Deliver.** No new endpoint: `ReportTrajectoryRequest` (`harness-internal.controller.ts:249`, `{ steps: [...] }`) gains an optional `computeSamples: [{ tenantId, sessionId, runId, activityId, attempt, activityType, cpuMs, wallMs }]` array. The interceptor buffers samples per worker and flushes them through the existing `report_trajectory` client (`api_client.py:1449`) every few seconds or every N samples — and this flush gets the retry + Redis spool that TASK-957 F-5 already prescribes for the trajectory POST, since it is the same hazard. `AgentTrajectoryService.recordSteps` emits one `CPU_SECOND` row per sample: `capability: WORKFLOW`, `operation: workflow.step`, `provider: 'harness'` (a new self-hosted engine id in `KNOWN_PROVIDERS`), `deployment: SELF_HOSTED`, `requestId: runId`, `sessionId`, `attributesJson: { engine: 'harness', device: 'cpu', activityType, trigger }`. Tenant comes from the activity's own input (every interpreter activity carries `tenant_id`; the interceptor reads it off `ExecuteActivityInput.args[0]` and drops the sample, with a warning, when it cannot).
- **Per run.** "CPU time for each workflow" = `SUM(quantity) WHERE capability = WORKFLOW AND requestId = runId`, exposed on the run detail (`admin/workflow-runs/:id` gains `cpuSeconds`) and as `MeterUsage.workflowCpuSeconds` for the month.

**Not measured in R1, stated.** Orchestration CPU (sandboxed workflow bodies and their replay) — reading a CPU clock inside the sandbox is a determinism hazard, and it is small next to activity CPU; the SDK's Rust core; and any activity that carries no `tenant_id`. All three land in the pod's `container_cpu_usage_seconds_total`, so the monthly reconciliation `Σ cpu_ms ÷ pod CPU seconds` reports the unattributed share explicitly rather than hiding it. If it is material, the second step is proportional allocation of the residual across the month's runs by their attributed CPU.

**Pricing.** COST row `CPU_SECOND` / provider `harness` at the amortised vCPU-hour of the worker's node; SELL, when D-1 lands, as a `WORKFLOW` capability allowance `monthlyWorkflowCpuSeconds` beside the run-count quota that already exists.

### 3.5 What stays unmeasurable in R1, stated

- Physical GPU-seconds per request (concurrency factor unrecorded) — reconciled monthly from DCGM, not measured per call.
- Device for a text-service call — supplied by configuration, not observed; a mis-set descriptor records the wrong unit for that provider until corrected (visible on the consumption screen, correctable by a compensating event).
- TEI load and per-request device — CPU assumed until the container is scraped.

## 4. Network bytes per third-party call — interception points

### 4.1 What exists today (verified)

| Calling service | Vendor | Client | Where bytes are observable | Today |
|---|---|---|---|---|
| `apps/text` | OpenAI, Azure OpenAI, Anthropic, and every OpenAI-compatible self-hosted server (LM Studio, vLLM, llama.cpp) | the vendor SDKs, **all constructed with `http_client=pooled_http_client(...)`** (`openai.py:110`, `azure_openai.py:139`, `anthropic.py:113`, `openai_compat.py:134`) | `providers/pool.py:391-407` — a custom `AsyncHTTPTransport.handle_async_request` already wraps every request and response on that pool (it exists to drain responses on close); `request.content` and the response byte stream pass through it | nothing counted; `core/metrics.py` has no byte metric |
| `apps/text` | Vertex (`google-genai`) | `genai.Client(...)` built **without** `http_options.httpx_async_client` (`vertex.py:159-165`) — off the pool | the SDK accepts an injected httpx client; one adapter change puts it on the pool | invisible |
| `apps/text` | Bedrock | boto3/botocore, client built per call (`bedrock.py:92-96`) — not httpx | botocore `before-send` / response events, a separate hook | invisible |
| `apps/stt` | Sarvam, OpenAI Whisper API, Azure AI Foundry | a fresh `httpx.AsyncClient` per call (`sarvam_asr.py:114`, `openai_asr.py:56`, `batch_service.py:2994`), non-streaming | `len(wav)` is already computed at each call site; `len(response.content)` is one line | not counted |
| `apps/stt`, `apps/tts` | Azure Speech (STT recognize, TTS synthesis) | the native Speech SDK over its own websocket — no HTTP layer to hook | input: `len(pcm_bytes)` (`azure_asr.py:56-57`); output: the TTS adapter already reads audio in 4 KiB chunks (`azure_speech.py:154-159, 232-237`) | application-level proxies only; the SDK's encoded wire bytes are opaque |
| `apps/api` | vendor reachability probes on "Test connection" (`provider-connection-probe.ts:163-343`, raw `fetch`) | — | admin clicks, not inference | not counted; negligible |
| `apps/nlp`, `apps/guardrail` | none — peer services only | — | — | nothing to count |

Infrastructure cannot substitute: there is no Cilium, Hubble or Istio; `NetworkPolicy` enforces and does not count; and the per-pod cAdvisor `container_network_*_bytes_total` series are **dropped at scrape** by the cardinality keep-list (`observability-config.yaml:617-628`). The only network panel reads node-exporter per physical NIC, excluding pod interfaces. Per-tenant bytes can only come from the application.

### 4.2 The fast win — count at the one seam that already sees everything

- **`apps/text`**: extend the existing `pool.py` transport wrapper to accumulate `len(request.content)` and the bytes iterated through `_DrainOnCloseMixin`, and attach both to the response so `build_usage_detail` can carry `request_bytes` / `response_bytes` on `usage_detail` (and on the streaming terminal frame). The gateway/harness mappers then append `EGRESS_BYTE` / `INGRESS_BYTE` unit rows to the batch they already write, with the row's `deployment` (CLOUD or BYOK) deciding the leg. Self-hosted servers on the same pool are counted too (LM Studio over the LAN is not third-party egress, but the number is free and `deployment: SELF_HOSTED` keeps it out of the third-party sums). Vertex joins the pool by injecting the client; Bedrock gets a botocore `before-send`/`after-call` pair in its adapter.
- **`apps/stt` REST adapters**: instrument the three call sites directly (`len(wav)`, `len(response.content)`) and add `request_bytes`/`response_bytes` to the completion callback and the streaming segment — the same DTO fields the compute counters use.
- **Azure Speech**: report the application-level proxies (PCM in, audio chunks out) as the bytes, and say so on the row (`attributesJson.byteSource: 'app'` vs `'wire'`), so a later exact figure does not silently change the meaning of old rows.
- Rating: COST 0 today (no vendor or tunnel charges per byte); the rows exist for visibility, capacity planning and a future SELL decision (D-3).

Not measurable in R1, stated: bytes of a failed attempt (§6.2), the Speech SDK's real encoded wire bytes, and anything the platform's own reachability probes send.

## 5. Storage byte-days — the nightly snapshot

### 5.1 What exists today (verified)

| Data class | Where the bytes live | Size known at write? | Summed today? |
|---|---|---|---|
| Recordings and attachments | per-tenant MinIO buckets `hope-<slug>-<tenantKey>` (`TenantBucketFactory.ts:46-50`), referenced by `Media.uri` | `Media.size` (`media.prisma:21`), written by `sttInternal.service.ts:672, 766` and `media.service.ts:45` | **Yes** — `TenantService.getUsageStats` (`tenant.service.ts:1138`) and `PlatformMetricsService.getConsumptionRollup`: `SUM(Media.size)` per tenant, point-in-time, never persisted |
| Transcripts, summaries, notes, edit history, entities, highlights, document sections, knowledge chunks | **Postgres**, encrypted `Bytes?` columns on tenant-scoped rows (`ContextItem.encryptedContent` `consultation.prisma:106`; `ContextItemVersion.*` `:525-528` — one full snapshot per edit; `DocumentSection` `:764`; `NamedEntity` `:471-473`; `Highlight` `:604-607`; `KnowledgeChunk.encryptedText` `knowledge.prisma:93`; `TranscriptionJob.encryptedResult*` `stt.prisma:184-185`) | implicit (column length) | **No** — zero uses of `octet_length` / `pg_column_size` repo-wide |
| Harness claim-check payloads: offloaded transcripts/prompts/notes, workflow-run outputs, sandbox configs, **harness-synthesised TTS audio** (`nodes/core.py:1680-1683`) | one platform-wide bucket `harness-claim-check` (`claim-check.ts:8`), content-addressed, no tenant prefix in the key | yes — `payloadRef.size` (`async-contract/src/claim-check-ref.ts:52`) and `WorkflowRun.resultRef.sizeBytes` (`workflow-run.prisma:118-119`), inside JSONB on tenant-scoped rows | **No** |
| Knowledge documents | metadata row only; content is `KnowledgeChunk` rows in Postgres, vectors in Qdrant | no byte column on `KnowledgeDocument` | No |
| Interactive TTS output | streamed, never stored | — | — |

Quota: `PlanEntitlement.storageQuotaBytes` / `TenantEntitlement.storageQuotaBytes` exist (`entitlement.prisma:71, 197`), applied to the tenant's primary bucket by `applyPlanStorageQuota`; enforcement is soft-warn only (`evaluateStorageSoftWarn`, never blocks). `UsageMeterMetric` has no STORAGE member; the console tenant usage tab shows the live `Media.size` sum against that quota with no history.

Three attribution holes the snapshot cannot paper over:
1. **Shared-bucket fallback.** When the tenant's AUDIO bucket is not resolved, STT writes to the platform-wide `hope-audio` (`settings.py:158`, `transcriptionRealtime.service.ts:374`) and the object key carries no tenant id by contract (`path_resolver.py:50`, "used for bucket resolution, not in path"). `Media.size` still attributes it (the row is tenant-scoped), but a bucket-level reconciliation cannot.
2. **Claim-check has no TTL and no prune job** — bounded only by its 20 GiB MinIO quota (write failures, not cleanup). `AgentTrajectoryRetentionService` deletes step rows and orphans their payloads.
3. **`Media.bucketId` is never populated** (no factory parameter, no writer), so the one figure that is summed cannot be split into recordings vs attachments without parsing `uri`.
4. **DEDICATED-topology tenants** keep their bytes in their own S3/Azure account; those are not platform storage and must not be billed as such.

### 5.2 The fast win — snapshot the three sums the DB can already answer

One nightly job (`storage.snapshot`, same scheduler shape as `MeteringService.reconcileAllActiveTenants`, unscoped base client, per-tenant loop), emitting through `recordUsage` one `STORAGE_GB_DAY` row per (tenant, class) for the UTC day just closed, idempotency key `storage:<tenantId>:<class>:<YYYY-MM-DD>`, `capability: STORAGE`, `operation: storage.snapshot`, `provider: 'minio'` or `'postgres'`, `deployment: SELF_HOSTED`, `model: null`, quantity = bytes held at the snapshot ÷ 10⁹ (GB-days). Three classes:

| Class | Query | Cost |
|---|---|---|
| `media` | `SUM(Media.size) GROUP BY tenantId` — the existing query, persisted instead of computed live | one aggregate |
| `text` | `SUM(pg_column_size(col)) … GROUP BY tenantId` over the nine encrypted-column tables above, raw SQL, one statement per table on the `tenantId` index | nine aggregates; `pg_column_size` counts the stored (TOASTed, compressed) bytes, which is what the disk actually holds |
| `claim-check` | `SUM((payloadRef->>'size')::bigint)` over `AgentTrajectoryStep` and `SUM((metadata->'resultRef'->>'sizeBytes')::bigint)` over `WorkflowRun`, grouped by tenant | two aggregates |

GB-month for the invoice = Σ GB-days over the period ÷ days in the period, computed by the invoice engine from the daily rollup exactly as it sums every other unit. A per-class breakdown rides on `attributesJson.storageClass` (new allow-listed key) and the rollup's `provider` dimension. The meter `monthlyStorageBytes` (current snapshot, for quota) reads the latest day's row; the SELL unit is the byte-day.

Skipped on purpose in R1: a MinIO admin `bucket usage` scan (builds nothing the DB sums do not already know, and cannot attribute the shared buckets) and write-path increment/decrement (correct in theory, but several delete paths do not exist yet to hook). Two hygiene fixes ride along because the snapshot exposes them: populate `Media.bucketId` at the three writers, and add a lifecycle rule to `harness-claim-check` (an owner decision on retention days) so the class stops growing without bound.

## 6. Served-by attribution on fallback — what is already right, and the two gaps

### 6.1 Verified: every chain attributes to the candidate that actually served

| Capability | Chain | How the serving leg is known | Ledger row reflects |
|---|---|---|---|
| TEXT (agents, workflows) | ordered `AgentModelFallback` / `fallback.agentSlug`, resolved per candidate with its own `fundingTier` (`text-agent-resolver.service.ts:262-289`) | **one HTTP request per candidate** — the harness walks the chain itself (`nodes/core.py:1314-1473`, `continue` on `TextServiceError`); `apps/text` is stateless per call and reads funding from the entry of the provider it was asked to serve (`routing/usage.py:68-95`, `_credential_attribution`) | the serving leg: `deployment`, `costBasis`, `provider`, `model`, `funding_tier` on the harness step — no primary-vs-served drift is possible by construction |
| STT streaming | one fallback core (`AsrSpecFallback`) | TASK-874 engine-time **segments**, one per live-engine span, anchored so Σ segments = session totals | one row batch per segment with its own `(engine, deployment)` (`streamingSession.service.ts:432-505`) |
| STT batch | none (one engine per job) | `resolve_usage_attribution` on the engine that ran | correct by construction |
| TTS | ordered chain walked **inside `apps/tts`** | `X-Tts-Provider` / `X-Tts-Connection-Id` are read off the **winning `AudioChunk`** after failover (`speech.py:128-173`) | `classifyTtsProvider(provider, overrides)` on the serving provider |
| NLP, embeddings, guardrail | no tenant provider plane (NLP locked by `test_task799_byok_credentials.py`; guardrail = SYSTEM `AiRoutingPolicy`, tenant row wins when present) | — | always built-in / platform |

The owner's three legs map one-to-one onto what the rows already carry: built-in = `SELF_HOSTED`; platform third-party fallback = `CLOUD` + `INTERNAL`; tenant third-party = `BYOK` + `BYOK_NOTIONAL`. Nothing in this ticket changes that derivation. `connectionId` (which of a tenant's several keys) is TASK-958's: the Python wire emits it everywhere (`8b5fed939`), and the TypeScript half — `ProviderOverrideEntry.connection_id`, `UsageEventInput.connectionId`, the STT DTOs, the three TTS gateway readers of `X-Tts-Connection-Id`, `text-usage.ts` — is that ticket's remaining lane. This ticket adds no connection logic; its new unit rows inherit `connectionId` from the batch they join once TASK-958 lands.

### 6.2 Gap A — a failed leg records nothing

When a BYOK candidate raises and the walk moves on, the attempt cost the platform CPU time and network bytes and the tenant nothing; the owner's model counts both ("CPU time used calling the provider", "network consumption"). Today the harness does `last_error = exc; continue` (`nodes/core.py:1430-1434`) with no timer around the attempt, and `apps/text` returns an error body with no `usage_detail`. Fast win: the caller times each attempt (`perf_counter` around `generate`) and, on failure, emits a `CPU_SECOND` row for that leg with the failed candidate's `deployment`, `attributesJson.leg: 'failed'`, zero tokens — key `llm:<runId>:<seq>:attempt:<index>`. Bytes for a failed attempt stay a documented blind spot until `apps/text` carries `usage_detail` on error responses (a request body and an error body, usually small).

### 6.3 Gap B — the CPU leg of a successful third-party call is not separated from the token leg

A successful cloud/BYOK generation is one batch of token rows. The owner wants the platform's own CPU time for making that call counted on every third-party leg, even BYOK. §3.2's rule covers it: `CPU_SECOND = total_ms` is appended to the same batch with `device: cpu`, and for BYOK its `costBasis` is **`INTERNAL`** — the tenant paid the vendor for the tokens, but the platform's CPU handling the call is platform cost. That is the one place a batch deliberately carries two cost bases, so `UsageLedgerService.warnOnInconsistentCostBasis` (`usage-ledger.service.ts:118-140`) must learn that a `CPU_SECOND` unit on a `BYOK` row is expected, not a forgotten flag.

## 7. Fast-win plan — four waves, each independently mergeable and observable

The ordering follows the gates in §2.3: emit first (rows land unrated but visible), price and meter second, sell third. Every wave ends with the consumption screen (`admin/usage/{summary,timeseries}`) showing the new figure, because a metered unit nobody can see is not a fast win.

### Wave 0 — schema and vocabulary (one migration, no behaviour change)

| # | Change | Files |
|---|---|---|
| 0.1 | `AiUsageUnit` += `CPU_SECOND`, `EGRESS_BYTE`, `INGRESS_BYTE`, `STORAGE_GB_DAY`; `AiCapability` += `STORAGE`, `WORKFLOW`; `UsageMeterMetric` += `COMPUTE_SECONDS`, `WORKFLOW_CPU_SECONDS`, `STORAGE_BYTES`; one migration `task_959_compute_network_storage_units` (`ALTER TYPE … ADD VALUE`, the `ResourceType` precedent) | `enums.prisma`, `entitlement.prisma`, migration, `packages/domains/src/enums/generated/*` |
| 0.2 | `USAGE_OPERATIONS` += `storage.snapshot`; `KNOWN_PROVIDERS` += `harness` (self-hosted engine); `USAGE_ATTRIBUTE_KEYS` += `device` (`cuda│mps│cpu`), `leg` (`primary│fallback│failed`), `storageClass` (`media│text│claim-check`), `activityType`; pin in `vocabulary.test.ts`, `usage-attributes.test.ts` | `usageLedger/vocabulary.ts`, `usage-attributes.ts` |
| 0.3 | Settings-registry descriptor `metering.compute.deviceByProvider` (db-config, SYSTEM default, tenant-overridable, `open-to-default`) | `settings-registry/descriptors/` |
| 0.4 | Price book seed: COST rows for `CPU_SECOND` (provider null, amortised vCPU-hour), `GPU_SECOND` per self-hosted provider = GPU-hour ÷ parallel slots (`lm-studio` ÷ 8, `vllm` ÷ batch, `stt` engines ÷ streams), `STORAGE_GB_DAY` (amortised disk), `EGRESS_BYTE`/`INGRESS_BYTE` at 0 — **per emitting capability, never `capability: null`**: the rater matches `capability` exactly (`AiPriceBookRepository.findEffectiveCandidates`), so a capability-null row looks like coverage and rates nothing. **No SELL rows yet** (§2.3) | `seed/20-ai-price-book.ts` |

Gate: `pnpm db:generate`, `pnpm --filter @arcaai/database test`, `pnpm --filter @arcaai/applications test`. Nothing emits yet, so nothing can mis-bill.

### Wave 1 — compute seconds from numbers that already exist (§3)

| # | Path | Change | Python? |
|---|---|---|---|
| 1.1 | STT batch | `emitBatchUsage` appends `GPU_SECOND│CPU_SECOND = processingTimeSeconds`; callback gains `device`; DTO declares it | one field |
| 1.2 | STT streaming | `UsageSegment` + `StreamingUsageSegment` gain `processing_seconds`; `emitStreamingUsage` appends the unit row per segment | thread the counter |
| 1.3 | Text (all lanes) | `buildLlmUsageInput`, `buildLlmUsageInputFromTokenCounts`, `harness-usage.mapper.ts` append `GPU_SECOND│CPU_SECOND` from `total_ms` (llama.cpp/Ollama native timings preferred), device from the descriptor; cloud/BYOK append `CPU_SECOND` with `costBasis: INTERNAL`; `warnOnInconsistentCostBasis` learns the exception (§6.3) | none |
| 1.4 | TTS | `X-Tts-Synthesis-Ms` + `X-Tts-Device`; the three gateway readers append the unit row | two headers |
| 1.5 | NLP | `inference_ms` + `device` on classify/NER responses; `buildNerUsageEvent` appends the unit row | small |
| 1.6 | Embeddings | timer around the embed call; `CPU_SECOND` on the `embed` row | none |
| 1.7 | Failed fallback legs (§6.2) | harness and gateway time each attempt; a failed leg emits `CPU_SECOND` with `leg: 'failed'` | harness only |
| 1.7b | Durable worker CPU per run (§3.4) | `ComputeMeteringInterceptor` on `Worker(interceptors=[...])`: fair-share `thread_time` per activity, buffered flush through `report_trajectory` with the F-5 retry/spool; `ReportTrajectoryRequest.computeSamples`; `recordSteps` emits `WORKFLOW` / `CPU_SECOND` / provider `harness` per sample; `cpuSeconds` on the run detail | one interceptor module + one client field |
| 1.8 | Meter + screen | `MeterUsage.computeSeconds` (Σ `GPU_SECOND` + `CPU_SECOND` over the inference capabilities, split by `device` on the timeseries) and `MeterUsage.workflowCpuSeconds` (capability `WORKFLOW`), `admin/usage/summary` and the consumption screen show GPU s / CPU s per tenant; DCGM reconciliation panel in the deployment repo's Grafana | — |

Gate per path: the existing emitter unit tests grow one assertion each (the batch carries the new unit); the interceptor gets a hermetic harness test (two concurrent fake activities on one loop, fair-share sums to the thread total, a retried attempt keys differently); `task-959-compute.spec.ts` e2e: one agent invocation on the seeded LM Studio agent writes token rows AND a `GPU_SECOND` row sharing the `requestId`, and one API-triggered workflow run writes `WORKFLOW` / `CPU_SECOND` rows whose `requestId` is the run id.

### Wave 2 — network bytes (§4)

| # | Change | Python? |
|---|---|---|
| 2.1 | `apps/text/providers/pool.py` transport wrapper counts request and response bytes; `usage_detail` gains `request_bytes` / `response_bytes` (blocking and terminal frame); Vertex injects the pooled client; Bedrock adds the botocore hook pair | yes, contained in `providers/` |
| 2.2 | `text-usage.ts`, `llm-usage-normalizer.ts`, `harness-usage.mapper.ts` append `EGRESS_BYTE` / `INGRESS_BYTE` rows when `deployment !== SELF_HOSTED` (self-hosted bytes recorded under their own deployment, never summed as third-party) | none |
| 2.3 | STT REST adapters instrument the three call sites; completion callback and streaming segment gain the two byte fields; `emitBatchUsage` / `emitStreamingUsage` append the rows | three call sites |
| 2.4 | Azure Speech STT/TTS report the application-level proxies with `byteSource: 'app'` | small |
| 2.5 | Meter + screen: `MeterUsage.thirdPartyBytes` (egress + ingress, third-party deployments only) on the summary and timeseries; no allowance, no gate | — |

Gate: `pnpm text:test` (a unit test on the transport wrapper with a canned response), `pnpm stt:test`, applications tests; e2e: a BYOK-configured agent invocation writes token rows AND two byte rows with `deployment: BYOK` sharing the `requestId`.

### Wave 3 — storage snapshot (§5)

| # | Change |
|---|---|
| 3.1 | `StorageSnapshotService` on the `MeteringService` scheduler shape: nightly, per tenant, three classes, `recordUsage` with `storage:<tenant>:<class>:<day>` keys |
| 3.2 | `MeterUsage.storageBytes` reads the latest snapshot; `storageQuotaBytes` (already on both entitlement rows) becomes the meter's limit, still soft-warn (Q6) |
| 3.3 | Hygiene the snapshot exposes: `Media.bucketId` set at the three writers; `harness-claim-check` lifecycle rule (owner: retention days) |
| 3.4 | Console: storage by class on the tenant usage tab replaces the single live `Media.size` sum |

### Wave 4 — sell (after D-1 … D-4)

SELL rows per new unit, `BILLABLE_UNITS` += `{ WORKFLOW: [CPU_SECOND], STORAGE: [STORAGE_GB_DAY] }` plus `GPU_SECOND`/`CPU_SECOND` on the inference capabilities, with allowance columns `monthlyComputeSeconds`, `monthlyWorkflowCpuSeconds`, `monthlyStorageGbDays`; invoice lines "GPU compute — overage", "Storage — GB-month"; `task-959-invoice.spec.ts`. Until this wave the figures are visible on the consumption screen and in COGS, never on an invoice — which is the safe direction.

### What this plan deliberately does not do

- No per-request physical GPU-second (concurrency factor unrecorded; DCGM reconciles monthly).
- No write-path storage increments (several delete paths do not exist to hook); the snapshot is the source of truth.
- No MinIO bucket scan (cannot attribute the shared buckets; the DB sums already know more).
- No new event shape, queue, or callback anywhere: every measure is a unit row on a batch an emitter already writes, or a nightly snapshot through the same port.


## 10. Lane plan and wire contract (approved 2026-09-12 — D-1..D-5 as recommended)

Owner approval: D-1 cost-only first, SELL after; D-2 occupancy seconds; D-3 bytes recorded, priced later; D-4 media + text + claim-check per GB-month; D-5 fair-share worker CPU with the residual reported. TASK-957 F-1 (`workflow.step`), F-2 (`usage_detail` on the blocking path), F-5 (trajectory POST retry + spool) are prerequisites and are built in these lanes.

### 10.1 Lanes, tiers, boundaries

Every lane runs in its own worktree `../hope-v2-t959-<lane>` on branch `task-959/<lane>` off `dev-2.2`; the orchestrator (this session) merges, runs `pnpm db:push` / `db:generate`, and owns the dev DB. TASK-958 runs concurrently in this repo (worktrees `../hope-v2-t958-*`); the TS emitter files it still owes (`text-usage.ts`, `usage-event.input.ts`, `streamingSession.service.ts`, `sttInternal.service.ts`, the two STT internal DTOs, the three TTS gateway readers) are shared with wave B below, so wave B starts only after the two sessions agree on order.

| Lane | Tier / effort | Owns (writes ONLY here) | Delivers | Gate |
|---|---|---|---|---|
| **W0** schema + vocabulary | opus / high | `packages/database/src/prisma/db_main/{enums,entitlement}.prisma`, one new migration folder, `packages/domains/src/enums/generated/*`, `usageLedger/{vocabulary,usage-attributes}.ts` (+ tests), `seed/20-ai-price-book.ts`, `settings-registry/descriptors/` (new descriptor file) | §2.1 units, `STORAGE` + `WORKFLOW` capabilities, `UsageMeterMetric` members, `storage.snapshot` operation, `harness` provider, five attribute keys, COST rows, `metering.compute.deviceByProvider` | migration proven on a shadow DB (`migrate diff` empty), `pnpm --filter @arcaai/database test`, `@arcaai/domains` + `@arcaai/applications` build + test, `gen:model/entity/factory` no drift |
| **P-TEXT** | opus / high | `apps/text/**` | §4.2 pool byte counting → `usage_detail.request_bytes/response_bytes`; `usage_detail.total_ms/engine_ms`; `guardrail_usage` on the stream terminal frame; Vertex on the pool; Bedrock hooks; the `assert_source_tree` conftest guard the rule requires | `pnpm text:test`, `text:lint`, `text:typecheck` |
| **P-STT** | opus / medium | `apps/stt/**` | `device` + byte fields on batch completion; `processing_seconds`, bytes, `device` per streaming `UsageSegment`; bytes at the three REST call sites; Azure proxies with `byte_source` | `pnpm stt:test`, `stt:lint` |
| **P-TTS** | sonnet / medium | `apps/tts/**` | `X-Tts-Synthesis-Ms`, `X-Tts-Device`, `X-Tts-Response-Bytes` (`X-Tts-Byte-Source`) | `pnpm tts:test`, `tts:lint` |
| **P-NLP** | sonnet / medium | `apps/nlp/**` | `inference_ms` + `device` on every inference response; `track_model_inference` yields its elapsed | `pnpm nlp:test`, `nlp:lint` |
| **P-HARNESS** | opus / xhigh | `apps/harness/**` | §3.4 `ComputeMeteringInterceptor` + `computeSamples` flush; trajectory POST retry + Redis spool (957 F-5); failed-leg step (§6.2); five `usage_detail` counts + `total_ms` + bytes on `LLM_CALL` step stats (F-6) | `pnpm harness:test` incl. a hermetic interceptor test and replay-compat |
| **T1** ledger + mappers (wave B) | opus / high | `usageLedger/**` except W0's two files, `consultation/summary/text-usage.ts`, `agent-trajectory/**`, `nerUsageEvent.ts`, `metering/**`, `billing/billable-usage.ts` + tests | builders append compute/byte units; `workflow.step` split (957 F-1) pinned billable + metered; `computeSamples` → `WORKFLOW`/`CPU_SECOND` rows; BYOK+CPU cost-basis exception; new meters | applications build + test |
| **T2** gateway agent + speech + workflow (wave B) | opus / high | `apps/api/src/modules/{agent,speech,internal,consultation/harness-internal.controller.ts}`, `services/agent/agent-invocation.service.ts`, `workflow-exposure.service.ts` | 957 F-2/F-3 blocking `usage_detail` + guardrail; F-4 spend ceiling on the three routes and run start; `ReportTrajectoryRequest.computeSamples`; TTS header readers | api unit + `api:build` |
| **T3** STT gateway (wave B) | opus / medium | `packages/applications/src/services/stt/**`, `apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts` | DTO fields, compute/byte unit rows per segment and per job | applications test |
| **T4** storage + analytics (wave B) | opus / medium | new `services/storage-snapshot/**`, `usageAnalytics/**`, `apps/api/src/modules/admin-usage/**` | §5.2 snapshot job; summary/timeseries carry compute, bytes, storage, workflow CPU; run detail `cpuSeconds` | applications + api unit |
| **T5** console (wave C) | sonnet / medium | `apps/admin-console/src/features/{consumption-cost,tenants,workflow-runs}/**` | the new figures on the consumption screen, tenant usage tab, run detail | console build + test |
| **E2E** (wave C, primary checkout after merges) | sonnet / medium | `apps/api/tests/e2e/task-959-*.spec.ts` | §7 wave gates | filtered playwright run |


### 10.1b Cross-session protocol with TASK-958 (agreed 2026-09-12 with session hope-v2-82)

- TASK-958 lane B2 (`../hope-v2-t958-b2`, `task-958/b2-binding-catalogue`) owns, until it merges: `services/agent/**`, `services/stt/agent-resolver/**`, `services/stt/internal/**`, `services/stt/streaming/streamingSession.service.ts`, `services/ai-model/**`, `consultation/summary/text-usage.ts` (+ sibling usage-event builders), the live-documentation fold, `packages/types/src/{asr-spec,tts-spec}.ts`, `tests/contracts/**`, `apps/api/src/modules/speech/**`, `apps/api/src/modules/agent/agent.controller.ts`, `apps/api/src/modules/internal/dto/stt-streaming-usage.request.ts` (+ handler). It also closes the STT `connectionId` DTO gap. **Wave B of this ticket starts only after B2 merges and TASK-958 regenerates the five API artifacts**; T1/T3 then carry `connectionId` through untouched.
- Merge protocol, both sessions: announce before any `git merge` into `dev-2.2` in the primary checkout, never concurrently; heads-up before `pnpm db:push` / `test:db:reset` / `pnpm install` there. Whoever merges second re-runs the five artifact commands rather than hand-resolving `openapi.json`. Session hope-v2-51 holds an uncommitted lint edit in the primary checkout and is pinged before any merge.
- Shadow DB `hope_shadow` on the dev Postgres carries the full ledger through `20260912134123_task_958_…`; handed to W0. TASK-958's migrations are already applied to the dev DB. W0's migration sorts after and is applied by this session at merge.
- **After merging a schema/enum change into the primary checkout, rebuild `packages/database` and `packages/domains` (`pnpm --filter @arcaai/database build && pnpm --filter @arcaai/domains build`) before any applications or api gate.** `pnpm db:generate` refreshes `src/generated` only; a stale `dist` surfaces as `AiCapability`/`AiUsageUnit`/`UsageMeterMetric` type mismatches between the two packages (hit once on 2026-09-12 after W0's merge; not a code defect).
- Wave A: W0, P-TTS, P-NLP, P-TEXT merged (2026-09-12, window announced to hope-v2-82/40); P-STT waits for T3, P-HARNESS (running) waits for T2. TASK-958 B2 (`0cfe82680`) and Lane C (`2519f77f6`) are in; its fix lane G touches `apps/api/src/modules/speech/**`, so T2's speech readers are a separate lane T2b after G. Wave B (T1, T2, T3, T4) branched off `bb60d2b09` and spawned 2026-09-12; the first attempt died on an API session limit before writing code and was respawned at 23:35 Saigon on the same worktrees. Post-merge gates on `bb60d2b09` + `719ceaafc` after the dist rebuild: applications 13371 passed, `api:build` clean, openapi coverage OK, portal no drift, vox-node admin no drift, three gen checks no drift.


### 10.4 Lane status and merge sequencing (living)

| Lane | Branch @ | Orchestrator re-verification | Deviations accepted | Merge with |
|---|---|---|---|---|
| P-TTS | `task-959/tts` @ `0e2f47124` — **merged** `04601f1ea`; post-merge 440 passed, lint clean; worktree removed | 4 files in `apps/tts`; `pnpm tts:test` 439 passed; lint clean (re-run 2026-09-12) | `X-Tts-Ttfa-Ms` added for streams; `X-Tts-Synthesis-Ms` / `X-Tts-Response-Bytes` / `X-Tts-Byte-Source` batch-only (a stream's total is unknown at header time — the gateway times the stream); `X-Tts-Device` on all modes; Sarvam → `wire` | any window — extra headers are ignored by an older gateway |
| P-STT | `task-959/stt` @ `61f8f2beb` (7 commits) | 19 files in `apps/stt`, `streaming/api/schemas.py` untouched; lint + typecheck clean; the lane's 58 new/amended tests pass, 1 expected-fail pinned to the schema file (re-run 2026-09-12); full suite machine-diffed by the lane: zero new failures against baseline `5c44b2577` | cloud legs bill `cpu`; self-hosted spans report `null` bytes, never `0`; partial decodes on cloud REST engines count bytes; a crash-recovered session loses pre-crash bytes (§6.2 blind spot); `whisper_cpp`/`parakeet_cpp` stamped `device: "auto"` → billed CPU — **closed** by `61f8f2beb` (both ggml loaders stamp the resolved device; 12 tests pin both error directions; re-verified) | **T3 only.** `InternalCompleteJobRequest` and `SttStreamingUsageSegmentRequest` run under `forbidNonWhitelisted`; four + five undeclared keys reject the callbacks. The `schemas.py` five-field hunk (`git show b55573ab5 -- apps/stt/src/stt/streaming/api/schemas.py`) is folded in by the orchestrator after TASK-958 Lane C's two-field change to the same file |
| P-HARNESS | `task-959/harness` @ `e20955726` (3 commits) | 15 files in `apps/harness`; lint + typecheck clean; the four new test files + replay-compat pass (96 tests, re-run 2026-09-12); lane's full suite 2563 passed | spool is ONE shared Redis list (per-worker keys would strand batches when a pod is replaced); `cpuMs`/`wallMs` are floats; the interpreter's failed step also carries `trigger`; failed legs recorded on total failure too; `_SEQ_STRIDE` 4→16 in the interpreter (activity input, replay green); no Prometheus counter on the Python side (structured warnings; the gateway half owns the metric); no `Idempotency-Key` on compute-only flushes; a terminal 4xx is dropped loudly, never spooled | **T1 only** — `ReportTrajectoryRequest.computeSamples` and an optional `steps` are T1's DTO; until it lands a compute-only POST is a 400 and dropped |
| P-NLP | `task-959/nlp` @ `bccc77844` (6 commits) — **merged** `3c22225b0`; post-merge 676 passed + the 2 pre-existing; lint clean; worktree removed | 12 files in `apps/nlp`; lint + typecheck clean; 19 new tests pass; its two remaining failures (`test_metrics_endpoint_task636`) fail identically on the base in the primary checkout (re-run 2026-09-12) | diagnosis endpoint included (two local models); topic/intent excluded (delegate to text, no local model); transformer pipelines resolve device from their own `use_gpu` predicate rather than `nlp.core.device` (only the guard plane is wired to it); empty `pairs` on entailment answers `cpu` without touching the model; batched guard passes report the request's share | any window — the gateway parsers read named keys and ignore the rest |
| P-TEXT | `task-959/text` @ `10d8b7f14` (7 commits) — **merged** `3ed23c0c8`; post-merge 1739 passed, lint clean | 14 files in `apps/text`; lint + typecheck clean; the four new test files pass (60 tests, re-run 2026-09-12); full suite green at `9f7cdc1d4`, one load-flake at HEAD (`test_xadd_count_is_far_below_the_delta_count`, timer-driven flushes under load average 218; 3/3 in isolation); `total_ms` on the terminal frame verified to be the producer's monotonic wall-clock | conftest guard already existed (TASK-871) — rule 14 corrected; `guardrail_usage` on all three terminal frames; judge route fills the fields too; Bedrock streaming `response_bytes` absent (unobservable without consuming the stream); bytes are body bytes only; retries accumulate; Vertex on the pool forces the httpx path and drops any custom TLS context; `text_provider_bytes_total{provider,direction,funding}` | any window |
| W0 | `task-959/w0` @ `8f0a283a0` (5 commits) — **merged** `bb60d2b09` | migration `20260912150046_task_959_compute_network_storage_units` is `ADD VALUE` only (grep-checked), proven on a rebuilt `hope_shadow` (empty `migrate diff`); three gen checks no drift + coverage OK; database 1811 passed; targeted applications 652 passed (re-run 2026-09-12). Dev DB synced with `pnpm db:push` (additive), enum members confirmed on `hope`; client regenerated | descriptor tier `global-kv` (registry writes/cascades only that tier; TASK-950 D-9 precedent); byte/CPU COST rows per emitting capability (the rater matches capability exactly); `billable-usage.ts`/`allowances.ts` type-forced edits; a second `bookVersion` `2026-09-12-compute-network-storage-v1`; `STORAGE_GB_DAY` replaces the byte-day (unpriceable at integer micros); STT GPU rows ÷8 (batch worker concurrency; streaming ÷20 noted as a repricing item needing an `operation` price dimension), TTS ÷1, lm-studio ÷4 (k3s), ollama ÷1; `parakeet_cpp`/`indic_f5` added to `KNOWN_PROVIDERS` | done |

### 10.2 Wire contract (frozen for the lanes; a lane that must deviate says so in its report, it does not improvise)

**apps/text → gateway / harness.** `UsageDetail` (`models/usage.py`) gains `total_ms: int` (wall clock, = `GenerationStats.total_ms`), `engine_ms: int | None` (native engine time when the engine reports one: llama.cpp `prompt_ms + predicted_ms`, Ollama `(total_duration − load_duration)/1e6`; else `None`), `request_bytes: int | None`, `response_bytes: int | None` (from the pool transport; `None` when the adapter is off the pool). The streaming terminal frame's `data.usage` is the same object, and the frame gains `data.guardrail_usage` (same shape as the blocking response's). Omitted-when-`None`, never `null`, so an older gateway sees an unchanged shape.

**apps/stt → gateway.** Batch completion (`complete_job`): `+ device: "cuda" | "mps" | "cpu"`, `+ requestBytes: int | None`, `+ responseBytes: int | None`, `+ byteSource: "wire" | "app" | None`. Streaming `UsageSegment` → `segments[]`: `+ processing_seconds: float`, `+ device`, `+ request_bytes`, `+ response_bytes`, `+ byte_source`. (`connection_id` / `connectionId` on both belong to TASK-958 and are left exactly as its Python lane wrote them.)

**apps/tts → gateway.** Headers beside `X-Tts-Audio-Seconds`: `X-Tts-Synthesis-Ms` (integer), `X-Tts-Device` (`cuda|mps|cpu`), `X-Tts-Response-Bytes` (audio bytes produced; for the Azure SDK the summed chunk bytes), `X-Tts-Byte-Source` (`wire|app`). Absent, never empty.

**apps/nlp → gateway.** Every inference response (`/classify/tokens`, entity extraction, text classification, guard) gains `inference_ms: int` and `device: "cuda" | "mps" | "cpu"`.

**apps/harness → gateway.** `POST /internal/harness/trajectory` body gains an optional `computeSamples: [{ tenantId, sessionId, runId, activityId, attempt, activityType, cpuMs, wallMs, trigger? }]` (camelCase on the wire like `steps[]`); a POST may carry `steps` only, `computeSamples` only, or both. `LLM_CALL` step `stats` gains, copied from `usage_detail` when present: `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `total_ms`, `engine_ms`, `request_bytes`, `response_bytes`. A failed fallback attempt is recorded as an `LLM_CALL` step with a non-OK status and `stats: { provider, model, funding_tier, total_ms, leg: "failed" }` and no token counts. The trajectory POST retries with bounded backoff and spools undeliverable batches to Redis for the next flush; the `Idempotency-Key` header keeps its current derivation.

**Ledger (TypeScript).** Units: `GPU_SECOND` (exists), `CPU_SECOND`, `EGRESS_BYTE`, `INGRESS_BYTE`, `STORAGE_GB_DAY`. Capabilities: `+ STORAGE`, `+ WORKFLOW`. Operations: `+ workflow.step`, `+ storage.snapshot`. Providers: `+ harness`. Attribute keys: `device` (`cuda|mps|cpu`), `leg` (`primary|fallback|failed`), `storageClass` (`media|text|claim-check`), `activityType` (enum-ish), `byteSource` (`wire|app`). Keys: compute and byte units join the batch of the call they belong to (same base key, `:<UNIT>` appended); worker CPU rows use `harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>`; storage rows `storage:<tenantId>:<class>:<YYYY-MM-DD>` (unit `STORAGE_GB_DAY`, quantity in GB-days). Device → unit: `cuda|mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND`. A `CPU_SECOND` row on a `BYOK` batch carries `costBasis: INTERNAL` and is the one sanctioned mixed-basis case. `UsageMeterMetric`: `+ COMPUTE_SECONDS`, `+ WORKFLOW_CPU_SECONDS`, `+ STORAGE_BYTES`. Descriptor `metering.compute.deviceByProvider` (tier `global-kv` — the only tier the registry writes and cascades, the TASK-950 D-9 precedent; `db-config` has no resolver lane for it): `Record<string, 'cuda'|'mps'|'cpu'>`, SYSTEM default `{ "lm-studio": "cuda", "vllm": "cuda", "ollama": "cuda", "llama-cpp": "cpu" }`, `open-to-default` → `cpu`.

**Not in any lane (owner-visible blind spots).** Failed-attempt bytes; orchestration and SDK-core CPU; Speech SDK wire bytes; DEDICATED-topology storage.

## 8. Owner decisions

| Id | Question | Recommendation |
|---|---|---|
| D-1 | Are `GPU_SECOND` / `CPU_SECOND` SELL units (a second allowance next to tokens) or COGS-only inputs that inform the token SELL rate? | Start COGS-only with a visible per-tenant figure on the consumption screen; add the SELL row when the price is decided. Emitting is the same work either way. |
| D-2 | Is compute occupancy (wall-clock on the model) an acceptable definition of GPU/CPU seconds for invoicing, with hardware reconciliation monthly? | Yes for R1 — it is the only per-request figure every service already has. |
| D-3 | Is network consumption invoiced, or recorded for visibility only? Vendors do not charge the platform per byte today. | Record now, price later. |
| D-4 | Storage SELL unit: GB-month from byte-days (industry norm), and which storage classes count — recordings, uploads, knowledge documents, transcripts/summaries in Postgres? | All four, reported per class; priced per GB-month. |
| D-5 | Is fair-share apportioning of the worker's thread CPU across concurrent activities acceptable as the per-run figure, with the unattributed residual (orchestration, SDK core) reported against pod CPU monthly? | Yes for R1. It sums to the true thread CPU by construction and the residual is reported, never hidden. |

## 9. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened from the owner's measurement model. §1–§2 and the gates from verified code; §3–§7 from a four-lane read-only discovery sweep (compute telemetry, egress seams, storage sources, served-by attribution), each lane's deciding lines re-verified by hand. Status `Pending` — awaiting D-1..D-4. 2026-09-12 later: M-6 added on the owner's instruction — CPU time per workflow run on the durable-function server (§3.4, plan 1.7b, D-5), grounded in the worker construction, the installed SDK's interceptor seam, and the cAdvisor keep-list. Cross-lane note for TASK-958: its Python wire (`8b5fed939`) sends `connectionId` on the STT completion callback and `connection_id` in streaming segments, and neither gateway DTO declares the field under a `forbidNonWhitelisted` pipe. |
