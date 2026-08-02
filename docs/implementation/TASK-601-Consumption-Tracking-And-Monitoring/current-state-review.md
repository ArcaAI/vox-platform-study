# TASK-601 — Current State Review: Consumption Tracking & Monitoring

Factual map of everything that exists today (2026-08-02, branch `dev-2.1`) for consumption
tracking, usage metering, quotas/entitlements, cost tracking, and monitoring across the
scribe platform. Produced by two exhaustive codebase sweeps (TypeScript plane + Python
services). No recommendations here — see the README for synthesis and plan.

---

## 1. TypeScript plane (gateway, applications, database, admin console)

### 1.1 Prisma schema — what usage-related data is persisted

**`entitlement.prisma`** — the core entitlements/quota schema:

- **`PlanEntitlement`** (per `TenantPlan`, reference table): `maxUsers`, `maxDepartments`,
  `maxPromptTemplates`, `maxAsrPipelines`, `maxApiKeys`, `storageQuotaBytes`,
  `maxConcurrentSessions`, `monthlyConsultations`, `monthlyTranscriptionMinutes`,
  `monthlySummaries`, feature flags (`featureDnaReports`, `featureVoiceEnrollment`,
  `featureMonitoringAccess`), `modelTier`, `rateLimitTier`. `null` = unlimited.
- **`TenantEntitlement`** (per tenant, nullable-as-override of the plan row) +
  `rateLimitPerMinute` absolute override.
- **`TenantUsageMeter`** — the only persisted rolling usage-meter table.
  `enum UsageMeterMetric { CONSULTATIONS, TRANSCRIPTION_MINUTES, SUMMARIES }`, unique on
  `(tenantId, metric, periodStart)` over UTC calendar-month windows. It is a **snapshot
  cache** — the live read path never depends on it.

**`consultation.prisma`** — richest per-request usage data, all row-level, never aggregated:

- `AudioRecording.duration` (ms) — the sole source of "transcription minutes" platform-wide.
- `SummaryMeta` — per generated summary: `aiModelId`, `aiModelVersion`, `promptVersion`,
  `processingTimeMs`, **`inputTokens`**, **`outputTokens`**, `stopReason`, `ttftMs`,
  `tokensPerSecond`, `cacheHit`, `qualityScore`, `generatedAt`. Populated in
  `summary.service.ts` (lines ~233–235, 268, 368–370, 409; `sumAcrossCalls` ~1073) directly
  from the SMR HTTP response. **The single richest per-request LLM cost signal in the
  codebase** — but no currency/cost field, and nothing aggregates it.
- `NamedEntity.processingTimeMs` — NLP recognition time only; no entity/char counts.
- `TranscriptionJob` — status/timing only; no duration/token/cost columns (duration lives on
  `AudioRecording`).

**`agent-trajectory.prisma`** — `AgentTrajectoryStep`: per-session step stream with
`durationMs` and `stats` JSONB (AD-1 `GenerationStats`: ttft, tokens/sec, prompt+completion
tokens, stop reason) for `LLM_CALL` steps. Tenant-scoped, no soft delete, nightly retention
prune, no sys-event on write — the platform's precedent for an append-only operational ledger.

**`dna-writing-style.prisma`** — `DnaUsageRecord` / `PromptUsageRecord`: append-only
"who used what when" ledgers (tenant/doctor/consultation/department + timestamps). Precedent
for a usage-fact ledger pattern, but scoped to feature adoption, not units/cost.

**`ai-provider-connection.prisma` / `ai-runtime-profile.prisma` / `ai-task-default.prisma`** —
pure routing/config (credentials, `tpmLimit`/`rpmLimit` rate limits, model selection). **No
cost/pricing/currency field anywhere in the schema** — no `costPerToken`, `unitCost`,
`Invoice`, `Subscription`, or billing-provider integration exists.

**`audit.prisma`** — `AuditLog` is a compliance trail (envelope-encrypted payloads); no usage
aggregation reads it.

### 1.2 Entitlements & metering services (`packages/applications`)

- **`EntitlementsService`** (`services/entitlements/`): resolves `PlanEntitlement ←
  TenantEntitlement`; enforcement primitives:
  - `assertQuantityQuota` (409) — create-time caps: users, departments, prompt templates,
    ASR pipelines, API keys. Call-sites verified in user/userRoleAssignment/department/
    apikey/prompt-management/pipeline services + directory-sync processor.
  - `assertMeterQuota` (429) — the 3 rolling monthly meters, called from
    `consultation.service.ts` (create/revisit), `summary.service.ts` (sync + async
    generate), `transcriptionJob.service.ts` (submit).
  - `assertConcurrencyQuota` (429) — live Redis socket-registry count vs
    `maxConcurrentSessions`, called from `transcription-job.controller.ts:375` before STT
    session start. Fail-open on Redis error.
  - `evaluateStorageSoftWarn` — never blocks; emits `ENTITLEMENTS_STORAGE_WARN_EVENT`.
  - **Global kill-switch `entitlements.enabled` — OFF by default.** Every assert is a no-op
    until an operator enables it.
- **`MeteringService`** (`services/metering/`):
  - `getCurrentUsage(tenantId)` — live Postgres aggregates over the current UTC month:
    `COUNT(Consultation)`, `SUM(AudioRecording.duration)/60000`, `COUNT(SummaryMeta)`.
  - `reconcileAllActiveTenants()` — upserts those aggregates into `TenantUsageMeter` on a
    cron (`metering.reconcile.enabled` default **false**, `*/15 * * * *`).
  - Uses the unscoped base client with explicit `tenantId` filters (no CLS in the job).
- **`EntitlementsLifecycleService`** — downgrade sweeps + trial expiry.
- **Admin API**: `admin/entitlements/*` (GLOBAL_ADMIN) — kill-switch, plan matrix CRUD,
  per-tenant capability/usage snapshot, overrides, downgrade, trial expiry.
  `MyEntitlementsController` for tenant self-service reads.

**What is actually metered/enforced today:** 5 create-time quantity caps, 3 monthly
business-object meters (consultations / transcription-minutes / summaries), 1 streaming
concurrency cap, 1 storage soft-warn. **Nothing is metered per provider call, per model, or
per token/character.**

### 1.3 Sys-event / audit pipeline

`SysEventService` fans out to BullMQ (audit persistence, user activity, webhooks). No
consumption rollup happens there; metering reads business tables directly, never `AuditLog`.

### 1.4 Gateway metrics (`apps/api` + observability services)

- `MetricsInterceptor` → `SimplifiedMetricsService` (prom-client, `/metrics`):
  `http_requests_total{method,path,status,service}`, `http_request_duration_seconds{…}`,
  CPU/memory gauges, `active_connections_count`, generic (unused) `business_operations_*`.
  **No `tenantId` label anywhere** (deliberate — cardinality).
- `optimistic_lock_conflict_total{model,route}` (OCC 412 counter).
- `JobMetricsService` (BullMQ): `hope_job_processing_total{queue,status,processor}`,
  durations, errors, and **`hope_job_smr_call_duration_seconds{queue,provider}`** — the only
  Prometheus metric anywhere with an SMR provider label on the TS side.
- `OpenTelemetryService` — thin wrapper over an OTel meter; wired for infra readiness,
  no consumption-specific usage. `OTEL_*` vars in `turbo.json#globalEnv`.
- **Proxied AI calls emit no per-request usage metrics at the gateway edge.**
  `SmrProxyController` (1,175 lines) forwards `max_tokens`/model params but records no
  token/duration metric; `SttWsGateway` only feeds the socket registry for the concurrency
  gate. No TTS/NLP/Guardrail gateway module emits usage metrics.
- **Platform-metrics module** (`admin/platform/*`, GLOBAL_ADMIN, Redis-cached ~12s):
  - `GET admin/platform/metrics` — requests/min, error rate, P95, sockets, per-service
    (stt/smr/guardrail/nlp) latency/error, per-model running/latency (from the Python
    services' `model_running_instances` / `model_inference_latency_seconds`).
  - `GET admin/platform/consumption?tenantId=` — **`ConsumptionRollupResponse`**:
    transcriptionMinutes (all-time), summaries24h, storageUsedBytes/quota, consultations
    total/today. **A second, overlapping consumption view** to the entitlements meters —
    same tables, different windows, neither reads the other.

### 1.5 Admin console screens

- `/ai-operations/runs` — trajectory-run browser + harness gate-queue panel (operational).
- `/ai-operations/metrics` — `GET admin/agent-trajectory/metrics/generation` →
  `{ sampleCount, ttftMedianMs, ttftP95Ms, tokensPerSecondAvg, stopReasons[] }` — a
  quality/latency dashboard over `AgentTrajectoryStep.stats`; no token totals, no cost, no
  per-tenant breakdown.
- No screen surfaces `TenantUsageMeter`, entitlement plans/overrides, `SummaryMeta` token
  columns, or any cost figure.

### 1.6 Observability infra

- Grafana dashboards: `agentic-trajectory`, `model-retention`, `optimistic-locking`,
  `pgbouncer`, `smr-cache-friendliness`, `smr-overview`, `smr-resilience`, `smr-security`,
  plus the dev-stack `hope-platform-metrics`. **None for consumption/cost/tenant usage.**
- No alerting rules for quota-approach or cost spikes. `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` /
  `ENTITLEMENTS_STORAGE_WARN_EVENT` have no confirmed consumer beyond `logger.warn`.

---

## 2. Python services

### 2.0 Cross-service Prometheus contract

STT, SMR, Guardrail, NLP (not TTS, not Harness) expose a byte-identical pair:
`model_running_instances{service,model}` and `model_inference_latency_seconds{service,model}`,
plus a shared model-cache block feeding `model-retention.json`. **The only tenant-labeled
metric platform-wide is `stt_provider_switch_total{tenant,from,to,reason}`**
(`apps/stt/src/stt/core/metrics.py:62-66`). No token/cost/character metric carries a tenant
label anywhere.

### 2.1 STT (`apps/stt`, 8861)

- Metrics: `stt_transcription_total{pipeline,engine,status}`, latency + error counters,
  **`stt_audio_duration_seconds`** (histogram, no labels; `_sum/60` is the documented
  "transcription minutes" signal) — **fed only by the batch path**
  (`batch_service.py:519-557`). Streaming duration accumulates in
  `StreamingSessionMetadata.total_duration_seconds` (`session.py:171-209`) and appears in
  session summaries and one structured log, but **never reaches Prometheus**.
- No RTF metric (unlike TTS); processing time and audio duration are never divided.
- Batch responses carry `duration_seconds` + `processing_time_seconds`
  (`transcription/dto.py`, API schemas) — returned over HTTP.
- Gateway callbacks (`core/api_client/gateway.py`):
  - `complete_job()` → `PATCH /internal/stt/jobs/{id}/complete` with `resultText` + untyped
    `resultMetadata` JSON (contains duration/processing time). Gateway **encrypts the blob
    into ciphertext** (`sttInternal.service.ts:471-473`) — captured but unqueryable.
    **Effectively dropped for metering.**
  - `create_audio_recording()` → **typed `durationMs`** (+ sampleRate/channels/bitrate) —
    the one queryable STT usage field reaching a real column; only populated on the
    audio-record path, not on every job.
- No per-tenant accounting, rate limiting, or quota logic in the service. Cloud-ASR quota
  errors are provider failures classified into `stt_cloud_asr_errors_total{class="quota"}`.

### 2.2 SMR (`apps/smr`, 8862) — the richest instrumentation

- Metrics: `smr_generation_total{provider,model,status}`, latency, **`smr_tokens_total
  {provider,model,direction}`** (the platform's one first-class token metric),
  `smr_time_to_first_token_seconds`, `smr_tokens_per_second`, `smr_stop_reason_total`,
  queue/circuit-breaker/rate-limit metrics. No tenant labels.
- Sync `/generate` path: `_extract_usage()` normalizes prompt/completion/total tokens →
  Prometheus → returned in `GenerateResponse.usage` → logged via
  `generation_audit.log_generation()` as a `generation.audit` structlog event with tokens,
  latency, provider, model, finish reason — **but `GenerationAuditEvent` has no
  `tenant_id` field** (`generation_audit.py:13-25`).
- **Streaming/SSE path accumulates usage chunks and feeds Prometheus but NEVER calls
  `generation_audit.log_generation`** (call-sites confined to the non-streaming function).
  Streaming token usage exists only as untenanted Prometheus counters.
- Task state incl. `total_tokens` lives in **Redis with a 1-hour TTL** (`task_manager.py:46`)
  and is never read back or persisted.
- **Every provider adapter propagates usage correctly** (verified): OpenAI/Azure/
  OpenAI-compat incl. `stream_options.include_usage` trailing chunk; Ollama
  (`prompt_eval`/`eval_count`); llama.cpp (`timings.prompt_n/predicted_n`); Vertex
  (`usage_metadata`); Anthropic (`message.usage` + streaming deltas); Bedrock
  (`usage`/`metadata.usage`). All adapters also stamp OTel span attributes
  `gen_ai.usage.input_tokens`/`output_tokens` (`core/observability.py:186-187`).
- Rate limiter (`services/rate_limiter.py`) is **per-provider** RPM/TPM protection with a
  ~1.3-tokens-per-word estimate — not tenant-scoped, not billing-usable.

### 2.3 Guardrail (`apps/guardrail`, 8863) — thinnest instrumentation

- Only the generic cross-service pair + model-cache block. **Zero domain counters.**
- `GuardrailCallStats` (`providers/stats.py:54-125`) computes prompt/completion/total tokens
  for every LLM call; `openai_compat.py` attaches `result["stats"]` (lines 181/189/202/381)
  — **and the API endpoint throws it away**: `MedicalValidationResponse`
  (`api/endpoints/medical.py:34-48`) never reads `result.get("stats")`. Guardrail's own LLM
  token consumption is computed then silently discarded — invisible to SMR and the gateway.
- Groundedness endpoint uses a self-hosted NLI classifier (no token concept);
  `/jobs/stats` returns job-status counts only.

### 2.4 NLP (`apps/nlp`, 8864)

- Two parallel metric systems: OTel SDK metrics via OTLP gRPC (`nlp.inference.duration_ms`,
  `nlp.inference.total`, `nlp.entities.total`, `nlp.classification.confidence` …) — not
  Prometheus-scrapable — plus the generic Prometheus pair.
- **`record_entities()` is dead code** — zero call-sites outside its own definition/docstring.
  The advertised entities/documents-processed count is computed nowhere. The only place an
  entity count is observed is a prose log line (`classify.py:87`).
- No per-tenant accounting.

### 2.5 TTS (`apps/tts`, 8865)

- Metrics: `tts_ttfa_seconds{provider,locale}`, **`tts_rtf{provider}`** (the platform's only
  RTF metric, computed in `routing/router.py:392-399` from audio byte count), active
  streams, requests, failover, provider errors. Does NOT implement the cross-service
  `model_running_instances` pair.
- **No character count or synthesis duration is ever returned, logged with request identity,
  or recorded per-request** — exhaustive grep for char-count patterns returned zero hits.
  `max_input_chars` is enforced as a 413 guard but the accepted count is never recorded.
- Provider adapters (kokoro / indic_parler / azure_speech) record no usage independently.

### 2.6 Harness (`apps/harness`, 8866)

- Metrics: `harness_step_duration_seconds{step_type,name}`, `harness_regen_total`,
  `harness_gate_decision_total{decision}`. No token/cost metrics.
- `_tokens_from_stats()` + `_budget_exhausted()` (`temporal/workflows.py:170-201`, call-sites
  820/1308) accumulate `tokens_used` **in-memory within a single workflow run** to gate the
  bounded-regen loop (`tokenBudget.perRun`, settings-registry key
  `agentic.context.tokenBudget.perRun`, default 0 = unbounded). Never persisted, never
  exposed — a circuit-breaker, not a ledger. The harness calls SMR multiple times per
  document session with no per-tenant rollup.

---

## 3. Consolidated gap register

| # | Gap | Evidence |
|---|-----|----------|
| G1 | No per-request cost/pricing model anywhere (no rate, currency, or cost field in any table) | schema sweep |
| G2 | No unified per-request usage ledger across the 5 AI capabilities | §1.1, §2 |
| G3 | No per-tenant × provider × model usage/cost rollup (can't answer "tenant X's Azure vs Ollama spend") | `TenantUsageMeter` covers 3 business meters only |
| G4 | Two unreconciled generation-stats writers: `SummaryMeta` columns vs `AgentTrajectoryStep.stats` JSON | §1.1 |
| G5 | SMR streaming generations bypass the generation audit log entirely; sync audit events lack `tenant_id` | §2.2 |
| G6 | Guardrail token usage computed then discarded before the HTTP boundary; zero guardrail counters | §2.3 |
| G7 | TTS records no character/duration usage at any layer | §2.5 |
| G8 | NLP entity/document counts are dead code; domain metrics OTLP-only (invisible to Prometheus) | §2.4 |
| G9 | STT streaming duration never reaches Prometheus; batch job usage metadata is encrypted into an unqueryable blob | §2.1 |
| G10 | Harness token budget is per-run in-memory only; multi-call LLM consumption per document session is unaccounted | §2.6 |
| G11 | Entitlements enforcement AND the metering reconcile job both ship OFF by default | §1.2 |
| G12 | No meters for guardrail/NLP/TTS/generic-LLM invocations (only consultations/minutes/summaries) | §1.2 |
| G13 | No per-tenant dimension in Prometheus (correct decision) but no substitute per-tenant analytics store either | §1.4 |
| G14 | No billing/invoice/subscription domain model or billing-provider integration | schema sweep |
| G15 | No consumption/quota/cost alerting; quota-blocked events die in `logger.warn` | §1.6 |
| G16 | Two overlapping consumption read-paths (`MeteringService` vs `getConsumptionRollup`) with different windows and no shared source | §1.2/§1.4 |

Existing assets to build on (not gaps): the entitlements/metering skeleton and admin API,
`SummaryMeta` token capture, `AgentTrajectoryStep` ledger precedent, `DnaUsageRecord`
append-only precedent, complete SMR provider-adapter usage propagation, OTel span attributes
already stamped in SMR, socket-registry concurrency gate, BullMQ + sys-event infrastructure,
TimescaleDB Postgres image already in use.
