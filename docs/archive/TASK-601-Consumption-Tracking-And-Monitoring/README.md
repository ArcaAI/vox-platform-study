# TASK-601 — Consumption Tracking & Monitoring for AI Capabilities

| | |
|---|---|
| **Status** | **Closed — Superseded by [TASK-615](../TASK-615-Usage-Metering-And-Billing/README.md)** (2026-08-06) — no implementation happened under this ticket |
| **Type** | feature (cross-cutting: database → domain → applications → api → python services → admin console → infra) |
| **Created** | 2026-08-02 |
| **Branch** | dev-2.1 |
| **Companion docs** | [current-state-review.md](./current-state-review.md) (exhaustive codebase map) · [research-findings.md](./research-findings.md) (external research with citations) |

> **⚠️ Superseded.** All research, findings, design decisions (D1–D9), and the resolved
> owner questions were carried into **TASK-615 — AI Usage Metering, Consumption Monitoring
> & Tenant Billing**, which extends this work with the tenant billing plane (sell-side
> rate card, fixed plan + on-demand invoicing), a 2026-08-06 current-state re-verification,
> and a parallel-agent workstream plan. **Do not implement from this README** — TASK-615
> is authoritative. This folder is retained for provenance and can move to `docs/archive/`.

---

## 1. Requirement Analysis

Establish best-practice **consumption tracking and monitoring** for the scribe platform's
four AI capability groups:

1. **Speech-to-text** — self-hosted whisper.cpp pipelines + cloud fallback ASR, streaming
   and batch.
2. **Text generation** — SMR pre-summarization/summarization, guardrail LLM validation,
   harness agentic loops; providers: LM Studio, Ollama, llama.cpp, Azure OpenAI, Bedrock,
   Anthropic, Vertex (+BYOK).
3. **NLP** — medical NER / classification (self-hosted).
4. **Text-to-speech** — Azure Speech + local Kokoro / Indic Parler.

Deliverables of this ticket phase: (a) review of the current implementation, (b) deep
research into current best practices, (c) brainstorm/synthesis of design decisions, and
(d) an implementation plan. Implementation itself proceeds phase-by-phase after plan
approval (Phase 3 gate of the development workflow).

---

## 2. Current State Evaluation (summary)

Full detail with file:line evidence in [current-state-review.md](./current-state-review.md).

**What exists and is sound:**
- A real entitlements/quota skeleton: `PlanEntitlement` / `TenantEntitlement` /
  `TenantUsageMeter` with three business meters (consultations, transcription minutes,
  summaries), five create-time quantity caps, a Redis-backed streaming concurrency cap,
  storage soft-warn, an admin API, and a reconcile cron — all behind the
  `entitlements.enabled` kill-switch (OFF by default).
- `SummaryMeta` captures per-summary `inputTokens`/`outputTokens`/`processingTimeMs`/
  `ttftMs`/`tokensPerSecond` from SMR responses — the richest per-request cost signal.
- Every SMR provider adapter (OpenAI/Azure/compat, Ollama, llama.cpp, Anthropic, Bedrock,
  Vertex) correctly extracts and propagates usage, including streaming trailing chunks, and
  stamps OTel `gen_ai.usage.*` span attributes.
- Ledger precedents: `AgentTrajectoryStep` (append-only, no soft delete, retention-pruned,
  no sys-event) and `DnaUsageRecord`/`PromptUsageRecord`.
- Prometheus discipline is already correct: no `tenantId` labels anywhere.

**The 16 gaps** (register in the companion doc): headline items —
- **G1/G2/G3**: no cost model, no unified per-request usage ledger, no
  tenant × provider × model rollup. `TenantUsageMeter` counts business objects, not
  inference units.
- **G5**: SMR streaming generations bypass the generation audit log entirely; the sync
  audit event has no `tenant_id`; SMR task token totals die in Redis after 1 h.
- **G6**: guardrail computes per-call token stats (`GuardrailCallStats`) and discards them
  before the HTTP response; zero guardrail counters.
- **G7**: TTS records no character count or synthesis duration anywhere.
- **G8**: NLP's entities-processed metric is dead code; NLP domain metrics are OTLP-only.
- **G9**: STT streaming duration never reaches Prometheus; batch usage metadata is
  encrypted into an unqueryable blob at the gateway.
- **G11**: enforcement and reconcile both ship OFF — even existing meters aren't persisted
  unless an operator opts in.

---

## 3. Research Findings (summary)

Full detail with citations in [research-findings.md](./research-findings.md). The findings
that drive the design:

1. **Two planes, never merged.** Telemetry (OTel/Prometheus: sampled, lossy, bounded
   labels, no tenant) vs metering (Postgres ledger: idempotent, per-tenant, billing-grade,
   retained years). Nothing in OTel/Prometheus is billing-grade; no OTel cost attribute
   exists.
2. **One gateway chokepoint** for usage-event emission; peer-to-peer paths (SMR→guardrail)
   must self-report.
3. **OTel GenAI conventions are Development-status and moved repos (June 2026)** — adopt
   the naming, hand-instrument our own adapter layer, never build billing on it. STT/TTS/
   NER have no conventions at all → private `hope.*` namespace. Pin
   `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` + collector deny-list +
   CI assertion (PHI).
4. **Provider usage semantics are a minefield**: Anthropic/Bedrock `input_tokens` EXCLUDES
   cache tokens, OpenAI/Gemini INCLUDES them; Vertex excludes thinking tokens from
   `candidatesTokenCount`, the Gemini API includes them; Anthropic streaming usage is
   cumulative (take last, never sum); streaming usage is opt-in and lossy (emit usage from
   the abort path too — the exact TASK-470/471 dropped-tail-final bug class).
5. **Units are not one thing per capability**: STT is audio-seconds OR session-seconds OR
   tokens depending on provider; TTS is characters (with divergent SSML/CJK counting) OR
   tokens; NLP is 100-char vs 1,000-char units with per-request minimums that make
   per-utterance calls ~10× more expensive than batched calls. The event model needs a
   `unit` enum, not per-capability assumptions.
6. **No provider gives per-request/per-tenant cost** — provider billing APIs/exports are a
   monthly reconciliation control total joined at model × usage-type × day, nothing more.
7. **Metering-vendor consensus contract**: idempotency key (exactly-once effective),
   bounded acceptance window, explicit correction path, over-populated dimensions,
   aggregation declared on the meter. Transactional outbox for emission; TimescaleDB
   continuous aggregates with `end_offset` > worst-case lateness.
8. **Price book**: effective-dated, decimal strings, superseded-never-mutated rows keyed
   `(provider, model, unit_kind, tier, context_band, effective_from)`; rate at ingest and
   store the resolved price + book version on the event; seed from LiteLLM's JSON pinned by
   SHA. FOCUS 1.5 will standardize AI token cost — align field names loosely, don't wait.
9. **BYOK**: meter fully, rate notionally, invoice never — `costBasis ∈ {internal,
   byok_notional}` on every event. BYOK→platform failover moves PHI between BAA scopes:
   opt-in, logged, attested (`baa_confirmed`, model allow-list per credential).
10. **The business metric is cost-per-encounter as a distribution** vs per-seat revenue
    (scribe market prices per provider/month; AI-native gross margins ~50–60%). Self-hosted
    GPU: allocate by measured GPU-seconds; idle capacity to an unallocated pool.
11. **Guardrails are never degraded** under budget pressure — clinical safety boundary,
    consistent with the platform's `failMode: closed` posture.
12. **Prometheus cardinality**: tenant/user/consultation ids never become labels; per-tenant
    analytics come from Postgres via the Grafana Postgres datasource.

---

## 4. Brainstorm — Design Decisions & Trade-offs

### D1. Build on the existing entitlements/metering skeleton — don't replace it
The `EntitlementsService`/`MeteringService`/`TenantUsageMeter` triad stays authoritative
for business-object meters and enforcement. The new work adds the missing substrate
underneath: a per-request **`AiUsageEvent` ledger** that business meters, cost rollups, and
new unit meters all derive from. `getConsumptionRollup` (platform-metrics) eventually reads
the same rollups, resolving the G16 dual-read-path drift.

### D2. One event shape, one `unit` enum
```
AiUsageEvent (append-only, tenant-scoped, NO soft delete — AgentTrajectoryStep precedent)
  id (uuid7), tenantId, idempotencyKey (unique)
  occurredAt, recordedAt                      # event time vs ingest time — both required
  capability   ∈ {STT, LLM, NLP, TTS, EMBEDDING}
  operation    (bounded enum-ish string: transcribe.stream, transcribe.batch, generate,
                generate.stream, presummarize, guardrail.validate, ner.extract,
                tts.synthesize, harness.step, …)
  provider, model, deployment ∈ {SELF_HOSTED, CLOUD, BYOK}
  unit ∈ {INPUT_TOKEN, OUTPUT_TOKEN, CACHE_READ_TOKEN, CACHE_WRITE_TOKEN, REASONING_TOKEN,
          AUDIO_SECOND, SESSION_SECOND, CHARACTER, TEXT_UNIT, REQUEST, GPU_SECOND}
  quantity (Decimal)
  consultationId?, doctorId?, departmentId?, requestId?, sessionId?   # attribution joins
  unitPriceMicros?, priceBookVersion?, costMicros?, costBasis ∈ {INTERNAL, BYOK_NOTIONAL}
  metadataJson  # ALLOW-LISTED enum/id fields only — never free text (PHI rule)
```
One logical AI call emits **multiple rows** (one per unit kind) sharing a `requestId` —
this is how every metering vendor models it and how cache/reasoning tokens stay first-class.
A summary generation emits input+output(+cache) token rows; a streaming STT session emits
an `AUDIO_SECOND` row (and optionally `SESSION_SECOND`) at session end; TTS emits
`CHARACTER` + `AUDIO_SECOND`; NLP emits `TEXT_UNIT` (chars/100) + `REQUEST`.

Trade-off considered: single-row-per-call with token columns (like `SummaryMeta`) is
simpler to query but freezes the unit vocabulary in the schema and can't represent
capability-specific units without sparse columns. The row-per-unit ledger + rollups wins.

### D3. Emission paths — gateway-first, service-carried
- **Rule: usage is recorded where `tenantId` is known and the call is authoritative** —
  the NestJS gateway for everything it fronts (summary generation, STT jobs/sessions, TTS,
  NLP), via **transactional outbox** in the same Prisma transaction as the business row.
- Python services **return** usage in their responses (they mostly already do; guardrail
  and TTS need their computed-but-dropped numbers surfaced); they do not write the ledger
  themselves. Exception: SMR→guardrail is peer-to-peer — guardrail returns usage to SMR,
  and SMR forwards a `guardrail.validate` usage block to the gateway alongside its own
  (both reach the ledger through the one SMR-response path). Harness reports per-step usage
  through its existing gateway trajectory-persistence path.
- **Streaming**: usage events emit from the stream-teardown path (complete OR abort), never
  only from the happy-path terminal event — the TASK-470/471 lesson. On abort, emit with
  whatever cumulative usage was seen plus an `interrupted` flag in metadata.

### D4. Rating: at-ingest, effective-dated price book, BYOK notional
New `AiPriceBook` table (supersede-only rows, decimal micros, seeded from LiteLLM pinned
SHA + hand-verified rows for Azure Speech/vendors we actually use). The outbox drainer
rates each event as it lands and stamps `unitPriceMicros`/`costMicros`/`priceBookVersion`.
Self-hosted rates are **configured platform costs** (per GPU-second or per audio-second,
derived from the amortization formula) — admin-editable, versioned like any other rate.
BYOK events rate at list price with `costBasis=BYOK_NOTIONAL` and are excluded from COGS
queries by default.

### D5. Aggregation: Postgres-first, Timescale when needed
Start with plain rollup tables (`AiUsageRollupHourly`/`Daily`: tenant × capability ×
provider × model × unit) maintained by the drainer + a periodic job — the platform's
volumes (hundreds of consultations/day) do not need continuous aggregates yet. The
`AudioRecording`-style Timescale hypertable + CAGGs is a later optimization; the schema
(occurredAt partition key, hourly grain) is designed so the swap is non-breaking. Extend
`UsageMeterMetric` with unit meters (e.g. `LLM_TOKENS`, `TTS_CHARACTERS`, `NLP_TEXT_UNITS`,
`GUARDRAIL_CALLS`) derived from the same ledger so `assertMeterQuota` gains new capabilities
without a second mechanism.

### D6. Enforcement: keep it simple first, reserve-then-settle later
Phase 1 enforcement = extend the existing monthly-meter pattern (post-hoc debit against the
ledger-derived meters, `max_tokens` capped). Reserve-then-settle token budgets and Redis
fast-path counters are deferred until a real abuse/budget problem exists — the research
supports this ordering (shadow-meter a full cycle before enforcing anything). Guardrail
calls are metered but **never quota-blocked**.

### D7. Telemetry plane fixes (independent of the ledger)
Close the pure-observability gaps in place: STT streaming audio-duration histogram + RTF;
guardrail request/token counters; TTS character/audio-second counters (+ the shared
model_running_instances pair); NLP entity counter wired to Prometheus (not just OTLP);
labels bounded to `{capability, provider, model, engine, status}`. Adopt `gen_ai.*` naming
for LLM spans (already partially done in SMR), `hope.*` namespace for STT/TTS/NLP.

### D8. Surfacing
- Admin console: a **Consumption & Cost** screen (global tier, per-tenant drill-down)
  reading new `admin/usage/*` endpoints over the rollups — units by capability, top-N
  tenants, cost-per-encounter distribution, budget burn-down. Tenant self-service view
  scoped to own tenant (BYOK tenants see their notional spend — a product feature).
- Grafana: keep service-health dashboards on Prometheus; add a consumption dashboard on
  the Postgres datasource.
- Alerting: quota-approach (80%) and budget-burn-rate alerts from the rollups; wire
  `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` to a real sys-event consumer.

### D9. What we deliberately do NOT build now
- No invoice/billing-provider integration (no revenue metering exists yet — margin
  analytics only).
- No Kafka/ClickHouse/OpenMeter deployment — Postgres + BullMQ suffice at current scale.
- No per-request provider-side attribution (Bedrock AIPs per tenant etc.) — provider
  attribution stays coarse (one profile/tag per deployment tier) as a reconciliation check.
- No HIPAA-audit-log coupling — the usage ledger stays PHI-free and separate by design.

### Open questions for the owner (before Phase A starts)
| # | Question | Recommendation | Answer |
|---|---|---|---|
| OQ1 | Meter STT on ingested audio-seconds only, or also session-seconds (idle time)? | Both columns, quota on audio-seconds | Both columns, quota on session-seconds |
| OQ2 | Dual-mic (`secondaryDeviceId`/AudioMixer) — 1× mixed or 2× channels? | 1× mixed (AWS-style), record channel count | 1× mixed (AWS-style), record channel count |
| OQ3 | Flip `entitlements.enabled` + `metering.reconcile.enabled` ON in dev as part of this work? | Yes in dev/staging; production stays a launch decision | Yes in dev/staging; production stays a launch decision |
| OQ4 | Self-hosted cost rates: who owns the amortization inputs (GPU cost, utilization)? | Ops-owned settings-registry keys, reviewed quarterly | Ops-owned settings-registry keys, reviewed quarterly |
| OQ5 | Retention for raw `AiUsageEvent` rows | 18 months raw, rollups indefinite | 18 months raw, rollups indefinite |

---

## 5. Implementation Plan

Phased to match the layer chain; each phase independently shippable and TDD-gated. Rough
sizing assumes existing patterns are followed (hand-authored domain trios, symbol-token DI).

### Phase A — Ledger foundation (database → domains → applications)
1. Prisma: `AiUsageEvent`, `AiUsageOutbox`, `AiPriceBook`, `AiUsageRollupHourly/Daily`
   models per D2/D4/D5 (+ `TENANT_SCOPED_MODELS`, `MODELS_WITHOUT_SOFT_DELETE`
   allow-lists; migration `task_601_ai_usage_ledger`). No `ResourceType` additions —
   ledger writes emit no sys-events (AgentTrajectoryStep precedent).
2. `pnpm gen:model`; hand-author entities/factories/mappers/repositories (no OCC `_version`
   strip needed — append-only, non-OCC); register in `CoreDatabaseModule`.
3. Applications: `IUsageLedgerService` (recordUsage via outbox in-transaction; idempotent
   drainer as BullMQ worker; rating against `IPriceBookService`), unit tests first:
   idempotency-conflict no-op, rating math incl. BYOK notional, occurredAt/recordedAt.
   - **Tests**: repository CRUD + unique-key conflict; outbox drains exactly-once under
     retry; price resolution picks the row effective at `occurredAt`; rollup upsert math.

### Phase B — Emitters per capability (gateway + python)
1. **LLM/summary**: emit usage rows where `SummaryMeta` is written (sync + async + compat
   paths); include cache/reasoning tokens when providers report them (extend the SMR
   response DTO passthrough). Add `tenant_id` to SMR's `GenerationAuditEvent`; make the
   streaming path call `generation_audit.log_generation` and return final usage to the
   gateway proxy (which emits the ledger row on stream teardown, abort included).
2. **Guardrail**: surface `GuardrailCallStats` in `MedicalValidationResponse` (+ batch and
   judge paths); SMR forwards it; gateway emits `guardrail.validate` rows. Add guardrail
   Prometheus counters.
3. **STT**: batch — lift `duration_seconds`/`processing_time_seconds` out of the
   about-to-be-encrypted `resultMetadata` into typed fields on the internal complete-job
   DTO; emit `AUDIO_SECOND` rows on job completion. Streaming — emit at session close from
   the gateway session teardown (`total_duration_seconds` already flows in session
   summaries); observe the streaming duration histogram + RTF in the STT service.
4. **TTS**: record `len(body.input)` (accepted request) + synthesized audio-seconds (from
   the existing RTF byte math) in the response/headers; gateway TTS path emits
   `CHARACTER` + `AUDIO_SECOND` rows; add TTS Prometheus counters + the shared
   model-metrics pair.
5. **NLP**: wire `record_entities()` call-sites; add a Prometheus entities/documents
   counter; emit `TEXT_UNIT` + `REQUEST` rows from the gateway NLP path (consultation-batched).
6. **Harness**: per-step usage rows via the existing trajectory persistence path (stats
   already carried in `AgentTrajectoryStep.stats` — emit ledger rows alongside, resolving
   the G4 dual-writer drift in the ledger's favor).
   - **Tests per emitter**: unit (usage extracted/normalized per provider incl. the
     Anthropic-exclusive-input and cumulative-delta rules), integration (row lands with
     correct quantities), streaming-abort emission test.

### Phase C — Meters, quotas, reconcile
1. Extend `UsageMeterMetric` + capability map (`LLM_TOKENS`, `TTS_CHARACTERS`,
   `NLP_TEXT_UNITS`, `GUARDRAIL_CALLS`, …) — enum parity + `ADD VALUE` migration;
   `MeteringService.getCurrentUsage` reads rollups for the new metrics.
2. `assertMeterQuota` call-sites for TTS synth and (soft) LLM token budgets; guardrail
   explicitly exempt. Plan matrix gains the new nullable ceilings.
3. Shadow-metering report: a scheduled job comparing ledger totals vs `SummaryMeta` sums
   and (where configured) provider usage APIs; drift > 2% alert. Run one full cycle before
   any new enforcement defaults ON.

### Phase D — Surfacing & alerting
1. `admin/usage/*` endpoints (rollup queries, cost-per-encounter distribution, top-N) +
   tenant self-service endpoint; DTOs + e2e incl. cross-tenant 404 posture.
2. Admin-console Consumption & Cost screen (design gate per rule 12 first), tenant usage
   panel in the existing AI-configuration hub.
3. Grafana: consumption dashboard (Postgres datasource) + new telemetry panels; alert rules
   for quota-approach/budget-burn; `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` consumer.

### Phase E — PHI-safe telemetry hardening
1. Pin `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` in env samples +
   boot-time assertion (JWT-placeholder-refusal precedent); CI test asserting no
   content-bearing `gen_ai.*` attribute in any emitter; metadata allow-list test on
   `AiUsageEvent` writes; document the collector deny-list for production OTLP.

### Verification criteria (Phase 5 gate)
- All new/changed packages: build + tests green (`domains`, `applications`, `api`,
  `stt/smr/guardrail/nlp/tts/harness` suites), lint clean incl. only-warn.
- One consultation exercised end-to-end in dev produces: STT audio-second rows, LLM token
  rows (incl. guardrail), NLP rows, and a non-zero cost-per-encounter figure queryable via
  `admin/usage/*` — pasted as evidence.
- Streaming-abort test proves usage still lands.
- Prometheus `/metrics` diff shows the new bounded-label instruments and no tenant labels.

---

## 6. Implementation Summary

_Pending — implementation has not started. This section will record files changed,
migrations, API changes, and evidence per phase._

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-02 | Ticket created. Current-state review (2 codebase sweeps), external research (6 specialist tracks), synthesis, and phased implementation plan documented. Status → Review, awaiting owner approval of the plan and the 5 open questions (§4). |
| 2026-08-06 | **Superseded by TASK-615.** Current state re-verified (all 16 gaps still open, no code produced here); research, decisions D1–D9, and the answered owner questions carried into TASK-615, which adds the billing plane (sell-side rate card, plan + overage invoicing, D10–D17) and restructures the plan into 11 parallel agent workstreams. Status → Superseded. |
| 2026-08-12 | Status formally set to Closed. All scope absorbed by TASK-615 (AI Usage Metering, Consumption Monitoring & Tenant Billing); no code was ever written under this ticket. |
