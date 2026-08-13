# TASK-615 — Research Findings: AI Usage Metering & Billing Best Practices

Deep research performed 2026-08-02 (under TASK-601) across six specialist tracks:
OpenTelemetry GenAI conventions, LLM usage-object semantics per provider, STT metering
units, TTS/NLP metering units, metering pipeline architecture, and BYOK economics / AI
gross margins — **extended 2026-08-06 (TASK-615) with a seventh track (§13): tenant-facing
pricing/billing norms** (provider rate-card survey, usage-billing platform architecture,
hybrid plan design, healthcare/BAA constraints on billing vendors). Citations inline;
secondary/unverified figures are flagged. This document records the findings; the README
carries the synthesis and plan.

---

## 1. The foundational split: telemetry plane vs metering plane

The single strongest cross-source consensus. They look like the same data and are not:

| | Telemetry plane | Metering plane |
|---|---|---|
| Signals | OTel traces/metrics, Prometheus, structlog | Durable usage events → ledger |
| Store | Prometheus/Grafana, trace backend | PostgreSQL (Timescale) |
| Semantics | Lossy, sampled, aggregate, rolls off | Exactly-once-effective, per-tenant, auditable, retained years |
| Cardinality | Bounded labels, **no tenant_id** | Tenant/model/capability are first-class columns |
| Consumers | On-call, SLOs, capacity | Quotas, COGS, margin, tenant dashboards, disputes |

Nothing in the OTel/Prometheus stack is billing-grade: sampling drops spans, OTLP push is
at-most-once across collector restarts, histograms quantize (you cannot reconstruct exact
sums from buckets), and no cost attribute exists in the OTel spec at all. The OTel GenAI
blog frames its metrics as a way to *estimate* per-request cost
([opentelemetry.io](https://opentelemetry.io/blog/2026/genai-observability/)); metering
literature treats metering/rating/billing as a separate pipeline
([BluLogix](https://blulogix.com/blog/how-do-ai-companies-bill-for-token-usage-a-guide-to-metering-rating-infrastructure/)).

Second consensus: **one AI-gateway chokepoint** — every provider call (cloud, self-hosted,
BYOK) passes one code path that emits the usage event
([MLflow AI Gateway](https://mlflow.org/articles/ai-gateway-architecture-a-guide-for-technical-teams/),
[Envoy AI Gateway](https://aigateway.envoyproxy.io/blog/envoy-ai-gateway-reference-architecture/)).
For HOPE the risk to close is peer-to-peer paths that bypass the gateway (SMR → guardrail).

---

## 2. OpenTelemetry GenAI semantic conventions — state of play (Aug 2026)

- **The spec moved repos**: all `gen_ai.*` content split into
  [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai)
  (created 2026-05); deprecated in core semconv v1.42.0 (2026-06-12), removed in v1.43.0.
  The new repo has **no releases or tags** — no pinnable schema version.
- **Everything is `Development` maturity.** Nothing Stable. Breaking renames already
  happened (`gen_ai.system` → `gen_ai.provider.name` in v1.37.0;
  `prompt_tokens`/`completion_tokens` → `gen_ai.usage.input_tokens`/`output_tokens` in
  v1.27.0). Frameworks in the wild emit mixed vintages
  ([John Hodge, Jul 2026](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/)).
- Key attributes: `gen_ai.operation.name` (well-known values: `chat`, `embeddings`,
  `execute_tool`, `invoke_agent`, … — **no STT/TTS/NER values exist**),
  `gen_ai.provider.name` (**no value for Ollama/LM Studio/llama.cpp/vLLM** — custom values
  permitted), `gen_ai.request.model` / `gen_ai.response.model`,
  `gen_ai.usage.input_tokens`/`output_tokens`, and 2026 additions
  `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`,
  `gen_ai.usage.reasoning.output_tokens`
  ([PR #96](https://github.com/open-telemetry/semantic-conventions-genai/pull/96)).
- Key metrics (all histograms, all Development): `gen_ai.client.token.usage` (`{token}`;
  spec rule: *"When systems report both used tokens and billable tokens, instrumentation
  MUST report billable tokens"*), `gen_ai.client.operation.duration` (`s`, buckets top out
  ~82 s — long local-LLM summarizations overflow; override via Views),
  `gen_ai.server.time_to_first_token`, `gen_ai.server.time_per_output_token`.
- **Speech/NLP are not modelled.** Open PRs
  [#390](https://github.com/open-telemetry/semantic-conventions-genai/pull/390) (voice-agent
  conventions with `speech_to_text`/`text_to_speech` operations — audio-duration usage
  explicitly an unresolved open question), #393/#394 (audio token attributes). No
  convention anywhere (incl. OpenInference) defines audio-seconds as a usage unit.
  Embeddings DO have a shipping convention (`gen_ai.operation.name=embeddings`,
  input tokens only).
- **PHI content capture**: default is NO capture. The switch is
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` — but it is an
  instrumentation-library convention, **absent from the official SDK env-var spec**, so a
  library that ignores it will capture content anyway. Community guidance: redact/deny at
  the OTel Collector as an independent layer
  ([maketocreate.com](https://maketocreate.com/opentelemetry-genai-tracing-ai-agents-without-leaking-pii/)).
  Content-bearing attributes to never set: `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.prompt.variable.*`,
  `gen_ai.retrieval.*`.
- Ecosystem: OpenLIT (Apache-2.0; only tool naming Ollama/vLLM/llama.cpp/LM Studio
  first-class), OpenLLMetry (Apache-2.0), **Langfuse (MIT since June 2025, OTLP-native —
  the clean self-host option for PHI)**, Arize Phoenix (ELv2; speaks OpenInference, NOT
  `gen_ai.*`), Logfire (enterprise-only self-host). All default to capturing
  prompts/completions — a liability for PHI; self-host + disable capture + BAA if adopted.
- Practitioner consensus for polyglot stacks fronting OpenAI-compatible endpoints:
  **hand-instrument the gateway/adapter layer** rather than rely on auto-instrumentation
  (which mislabels providers and misses mandatory attributes)
  ([freeCodeCamp](https://www.freecodecamp.org/news/build-end-to-end-llm-observability-in-fastapi-with-opentelemetry/)).

---

## 3. LLM usage-object semantics per provider — the normalizer contract

Full detail in the research transcript; the load-bearing table:

| Semantic | OpenAI Chat | OpenAI Responses | Anthropic | Bedrock Converse | Gemini API | Vertex AI |
|---|---|---|---|---|---|---|
| Input total | `prompt_tokens` | `input_tokens` | *compute* | *compute* | `promptTokenCount` | `promptTokenCount` |
| **Input incl. cache?** | ✅ inclusive | ✅ inclusive | ❌ **exclusive** | ❌ **exclusive** | ✅ inclusive | ✅ inclusive |
| Cache read | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cacheReadInputTokens` | `cachedContentTokenCount` | `cachedContentTokenCount` |
| Cache write | `…cache_write_tokens` (new/optional) | same | `cache_creation_input_tokens` (+ TTL split `cache_creation.ephemeral_{5m,1h}_input_tokens`) | `cacheWriteInputTokens` + `cacheDetails[]` | n/a | n/a |
| Output total | `completion_tokens` | `output_tokens` | `output_tokens` | `outputTokens` | `candidatesTokenCount` | `candidatesTokenCount` |
| Reasoning | `completion_tokens_details.reasoning_tokens` (inside output) | `output_tokens_details.reasoning_tokens` (inside) | not broken out (inside output, invisible) | not broken out | `thoughtsTokenCount` (**inside** candidates) | `thoughtsTokenCount` (**outside** — must add) |
| Streaming usage | opt-in final chunk (`stream_options.include_usage`) | opt-in final chunk | `message_start` + **cumulative** `message_delta` (take last, never sum) | `metadata` event / `amazon-bedrock-invocationMetrics` final chunk | final chunk | final chunk |

The five defects most likely to corrupt a meter (ranked by blast radius):

1. **Inclusive vs exclusive input.** Anthropic/Bedrock report `input_tokens` *after*
   subtracting cache; OpenAI/Google report it *before*. One shared normalizer applied to
   both silently mis-bills every cached request — by up to the whole cache prefix (90%+ on
   cache-heavy loops). Anthropic formula:
   `total_input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
   ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching);
   [Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)).
2. **Vertex vs Gemini API thinking tokens.** Same field name, different arithmetic:
   Gemini API `candidatesTokenCount` includes thoughts; Vertex excludes them (add
   `thoughtsTokenCount`). Branch on endpoint, not model
   ([Google docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/list-token)).
3. **Anthropic `message_delta` usage is cumulative** — summing deltas multiplies charges.
4. **Non-token meters** (Azure PTU capacity-hours: *"billed … regardless of the number of
   tokens consumed"* ([MS Learn](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/provisioned-throughput));
   Vertex cache storage-hours) never appear in any usage object — they need billing-export
   ingestion, and PTU spillover requests silently switch back to token billing.
5. **Streaming usage is opt-in and lossy.** OpenAI: no `stream_options.include_usage` → no
   usage at all; interrupted stream → the final usage chunk may never arrive though the
   provider bills the tokens. Reconciliation against provider usage/cost APIs is mandatory,
   not optional.

Cache-write multipliers (Anthropic, verified): 5-min write ×1.25, 1-hour write ×2.00, read
×0.10 of base input. The flat `cache_creation_input_tokens` cannot distinguish the two write
rates — use the TTL breakdown.

Self-hosted OpenAI-compatible servers: `prompt_tokens`/`completion_tokens` reliable
everywhere; **vLLM `prompt_tokens_details.cached_tokens` is broken on the V1 engine**
(returns null despite the flag — [vllm#44961](https://github.com/vllm-project/vllm/issues/44961));
Ollama native fields `prompt_eval_count`/`eval_count` (final chunk only, ns durations);
llama.cpp returns `usage` + a `timings` object where `prompt_n` is the NON-cached portion;
LM Studio returns `usage` + non-standard `stats` (ttft, tokens/sec, stop reason).

Tokenizer rules: never bill from local counts (tool schemas, system prompts, chat framing,
multimodal tiling all diverge — [tiktoken#474](https://github.com/openai/tiktoken/issues/474));
use provider count-tokens endpoints for pre-flight gating only. Anthropic's newer-model
tokenizer produces ~30% more tokens for the same text — cached per-prompt token estimates
must be keyed by model and invalidated across migrations
([Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)).

Price-book key: `(provider, model, deployment_or_endpoint, service_tier, token_class,
cache_role, cache_ttl, inference_geo)` — plus non-request-scoped meters (PTU hours, cache
storage-hours) ingested from billing exports. Batch tiers ≈50% discounts
(OpenAI/Anthropic/Azure verified); Anthropic surfaces `usage.service_tier`; OpenAI echoes
`service_tier` (sending `fast` reads back `priority`); Bedrock echoes a `serviceTier` header.

---

## 4. STT metering units

"Per audio second" is actually **three different units** across the industry:

1. **Audio-duration billing** — Deepgram batch, Azure ("hours of audio sent to the service,
   billed in second increments"), AWS, Google.
2. **Session-duration billing** — AssemblyAI streaming bills WebSocket open-to-close
   **including idle time** ([AssemblyAI billing](https://www.assemblyai.com/docs/billing-and-pricing));
   Deepgram reportedly bills streams on max(stream duration, audio duration) [unverified].
3. **Token billing** — OpenAI `gpt-4o-transcribe` bills tokens incl. audio-input tokens;
   the response `usage` is a discriminated union on `usage.type` (`"tokens"` →
   input/output/total + `input_token_details{audio_tokens,text_tokens}`; `"duration"` →
   `seconds` for whisper-1)
   ([OpenAI transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)).

Rounding folklore is stale in both directions: Google moved to 1-second round-up with no
minimum back in Nov 2022 ([release notes](https://docs.cloud.google.com/speech-to-text/docs/release-notes));
but AWS Transcribe and Rev AI keep a **15-second per-request minimum** (1-second increments
above it) ([AWS Transcribe pricing](https://aws.amazon.com/transcribe/pricing/)); Groq has a
10-second minimum. Distinguish "rounding increment" from "per-request minimum" — the
minimum dominates chunked architectures (4-second chunks bill at 375% on AWS).

Channel multipliers split the field: AssemblyAI ("multiplied by the number of channels",
explicit), Deepgram and Google reportedly multiply; **AWS explicitly does not** ("for a
two-channel conversation, you only pay for the total audio duration"). A stereo clinical
recording is a 2× swing between vendors. Streaming carries a 2–3× premium over batch across
vendors; medical modes carry large premiums (AssemblyAI Medical Mode +$0.15/hr ≈ +71%;
AWS Transcribe Medical 12.5–15× standard).

Usage metadata: Deepgram returns `metadata.duration` (float seconds) + `channels` and is the
only vendor returning per-request cost in dollars (`response.details.usd`); AssemblyAI's
streaming Termination event returns both `audio_duration_seconds` AND
`session_duration_seconds` (capture both — the second is the billed one); Azure batch
returns `durationMilliseconds`; AWS returns almost nothing reliable — measure duration
yourself and apply `max(duration, 15s)` when reconciling against CUR.

Self-hosted whisper.cpp: no standard exists — meter **audio-seconds decoded** as the
primary unit (comparable across every vendor, stable across hardware swaps) and record
wall-clock processing time + derived RTF + model/quantization + channel count alongside.
Cost basis = GPU-hour ÷ RTF (indicative: ~$0.02/audio-hour on an L40S at 35× RTF vs $0.36
API — secondary figures).

---

## 5. TTS & NLP metering units

### TTS — characters, but the counting rules diverge sharply

- **Azure Speech**: bills every Unicode code point incl. all SSML markup except
  `<speak>`/`<voice>`; **CJK counts double**; charged even when no audio is produced
  ([MS Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)).
  Separate meters for custom-voice training (compute-hours), endpoint hosting
  (model-hours), avatar (video-minutes).
- **Amazon Polly**: the outlier — *"SSML tags are not counted as billed characters"*
  ([Polly quotas](https://docs.aws.amazon.com/polly/latest/dg/limits.html)); engine tiers
  Standard $4 → Neural $16 → Generative $30 → Long-Form $100 per 1M chars; Speech Marks
  bill the same text again.
- **Google TTS**: bills all SSML except `<mark>`; request LIMIT is 5,000 **bytes** while
  billing is characters — Malayalam at 3 bytes/char caps at ~1,600 chars/request
  ([quotas](https://docs.cloud.google.com/text-to-speech/quotas)).
- **OpenAI**: `tts-1`/`tts-1-hd` per character ($15/$30 per 1M); **`gpt-4o-mini-tts` bills
  tokens** (text-in $0.60/1M + audio-out $12/1M) — audio-out tokens track *generated
  duration*, weakly coupled to input length. The `/v1/audio/speech` endpoint **documents no
  usage object** — per-request attribution may require estimating from output duration and
  reconciling via the org usage API.
- **ElevenLabs**: credits, 1 credit/char on Multilingual, **0.5 on Flash/Turbo** (derived
  from published $0.10 vs $0.05 per 1K chars) — the model changes the unit conversion.
- SSML inconsistency means the same markup-heavy clinical input can differ 2–3× in billed
  characters across vendors.
- Self-hosted (Kokoro / Indic Parler): no published unit. Recommendation: meter **both**
  characters (cross-provider comparability, tenant quota parity) and synthesized
  audio-seconds (actual cost/capacity; GPU time tracks output duration).

### NLP — text units with dangerous minimums

- **AWS Comprehend**: 1 unit = 100 chars, **3-unit (300-char) minimum per request**;
  ≈$1/1M chars at the first band. Custom sync endpoints bill provisioned
  inference-unit-seconds (~$43/month per idle IU)
  ([pricing](https://aws.amazon.com/comprehend/pricing/)).
- **AWS Comprehend Medical**: 1 unit = 100 chars, **1-unit minimum** (different from plain
  Comprehend!). NERe $0.01/unit tier 1 = **$100 per 1M chars — 100× plain Comprehend**;
  SNOMED-CT inference has a 5 KB/request, 2 TPS cap
  ([pricing](https://aws.amazon.com/comprehend/medical/pricing/),
  [quotas](https://docs.aws.amazon.com/comprehend-medical/latest/dev/comprehendmedical-quotas.html)).
- **Azure AI Language / TA4H**: 1 text record = 1,000 chars, **rounds up** (7,500 chars = 8
  records); limits counted in *documents* (grapheme clusters) — a two-axis model. TA4H
  allows 125,000 chars/document (a full consultation fits in one call)
  ([data limits](https://learn.microsoft.com/en-us/azure/ai-services/language-service/concepts/data-limits)).
- **Consequence**: a 100-char document costs ~10× more on Azure TAH than Comprehend Medical
  purely from the rounding minimum. **Calling NLP per utterance/segment pays the minimum
  dozens of times per encounter — batch NER to consultation/paragraph granularity.**
  Probably the single highest-ROI cloud-cost finding for HOPE's NLP path.
- Self-hosted NER (GLiNER/HF): meter **tokens** as cost unit + **characters** as
  comparability unit — Malayalam tokenizes to far more tokens/char than English, so a
  characters-only meter systematically under-forecasts local NER cost.

---

## 6. Metering pipeline architecture

Canonical pipeline: `emit usage event → durable transport → idempotent dedup → raw ledger →
rating (effective-dated price book) → pre-aggregates → quotas/dashboards/COGS`. Keep
metering (what happened), rating (what it costs), billing (what is owed) as distinct stages.

Platform lessons:
- **OpenMeter** (CloudEvents ingest, dedup on `id`+`source`, SUM meters over token
  properties grouped by provider/model/prompt-type)
  ([docs](https://openmeter.io/docs/metering/events/usage-events)).
- **Stripe Billing Meters v2**: dedup on `(event_name, identifier)` for ~24 h; events
  backdated into a closed period are rejected; async processing, no sync confirmation
  ([changelog](https://docs.stripe.com/changelog/acacia/2024-09-30/usage-based-billing-v2-meter-events-api)).
- Transferable rules: (1) at-least-once delivery + domain-derived idempotency key is the
  universal design — nobody sells exactly-once; (2) dedup windows are finite (~24 h) —
  later corrections are explicit adjustment events, never retries; (3) finalized periods
  are immutable — fix with credit memos, never by mutating history.

Storage: TimescaleDB hypertable + hierarchical continuous aggregates (1 min → 1 h → 1 day).
**Set CAGG `end_offset` greater than worst-case ingest lateness** or bucket values silently
change after materialization — a correctness bug for billing rollups
([Timescale docs](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/hierarchical-continuous-aggregates/)).
Separate `occurredAt` (event time) from `recordedAt` (ingest time) to measure lateness.
Compress raw events after ~7 days; retain raw 13–24 months for disputes/re-rating; daily
aggregates indefinitely (they carry no PHI — cheap and low-risk).

Emission: **transactional outbox** — write the usage event in the same DB transaction as
the business row, drain via a worker. Avoids both "AI call succeeded, usage lost" and
"usage recorded, work rolled back."

Reconciliation: **shadow-meter one full billing cycle before enforcing anything**; compare
internal totals against provider usage/cost APIs (OpenAI org usage/costs, Anthropic admin
usage, Azure Cost Management, AWS CUR + application inference profiles with cost-allocation
tags) and alert on drift > 2%. Bedrock application inference profiles are the strongest
provider-side per-tenant attribution primitive (tag → Cost Explorer/CUR) but are coarse and
lagging — a complement to in-app metering, not a substitute
([AWS](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html)).

---

## 7. Quota & entitlement enforcement

- **Output tokens are unknowable pre-flight.** Patterns, in order of preference:
  (1) **reserve-then-settle** — reserve `counted_input + max_tokens` on admission, settle to
  actual on completion (authorize-then-capture); (2) estimate-then-verify — Azure APIM's
  `azure-openai-token-limit` policy (429 on TPM breach, paired with
  `azure-openai-emit-token-metric` to dashboard estimate-vs-actual drift)
  ([MS Learn](https://learn.microsoft.com/en-us/azure/api-management/azure-openai-token-limit-policy));
  (3) post-hoc debit — only acceptable with a hard `max_tokens`.
- **LiteLLM as reference implementation**: hard budgets (reject) vs soft budgets (notify),
  scoped per key/team/org/customer/tag, daily/monthly resets; **cross-pod Redis counters as
  the fast enforcement path with background DB reconciliation**
  ([docs](https://docs.litellm.ai/docs/proxy/users)). Copy the Redis-fast-path/
  Postgres-source-of-truth split; avoid their un-scopeable customer budgets — scope to
  `(tenant, capability)` minimum.
- Streaming STT is constrained by **concurrent sessions**, not tokens: Redis lease
  semaphore (`SET … NX EX 60`) + client heartbeat + reaper for dead tabs; 429 with
  `Retry-After` on breach. (HOPE's socket-registry concurrency gate already approximates
  this.)
- Degradation ladder: cheaper model → shrink context → drop optional enrichment → queue →
  read-only. **Never degrade or bypass the guardrail stage** — a clinical-safety boundary,
  not a cost knob; encode as non-degradable (consistent with HOPE's `failMode: closed`).
- Status codes: 429 rate/throughput (retryable), 402 credit exhausted, 403 capability not
  in plan, 409 quantity quota (existing `QuotaExceededException` mapping).

---

## 8. Cost attribution, FinOps, BYOK

### Business framing
AI-scribe vendors price **per provider per month** (DAX ~$370–1,500 list, Abridge
~$400–600, Suki ~$200–300 — secondary), not per encounter. So the metering plane is a
**COGS/margin/abuse-control engine**, not an invoicing engine. North-star metric:
**cost per encounter as a distribution (p50/p90/p99)** — `Σ costMicros GROUP BY
consultationId` — against per-seat revenue. Agent cost distributions have CV 2–4; pricing at
3× the average still only yields ~22% margin — the tail kills you
([Cycles](https://runcycles.io/blog/ai-agent-unit-economics-cost-per-conversation-per-user-margin)).

Margin benchmarks: AI-native gross margins ~45% (2025) → ~53% (2026e) → ~59% (2027e)
(ICONIQ [State of AI 2026](https://www.iconiq.com/growth/reports/2026-state-of-ai-bi-annual-snapshot));
a16z's original 50–60% framing ([The New Business of AI](https://a16z.com/the-new-business-of-ai-and-how-its-different-from-traditional-software/))
still holds; plan for a structural ceiling in the 60s, not classic-SaaS 80%. Counterpoint:
sky-high margins on an AI-native product are an "orange flag" of low usage — cost per
encounter is a value signal before it is a cost problem. 84% of consumption-priced AI
companies pass some inference cost through; the dominant 2026 shape is
**seat/subscription floor + metered component above an included allowance**.

COGS allocation rule: *"Did a customer trigger this API call? If yes, it's COGS"*
([SaaS Academy](https://www.thesaasacademy.com/blog/how-ai-changes-saas-pnl-gross-margin)).
Include self-hosted GPU (whisper.cpp/VAD/diarization), TTS synthesis, guardrail + NLP
inference, audio storage/egress, per-encounter worker compute. Don't let AI COGS hide in
"infrastructure."

### Self-hosted GPU amortization
`effective_cost_per_gpu_second = (amortized hw + power + colo + ops labor) /
(seconds × utilization)`. **Utilization is the dominant term** (~40% utilization ≈ +80%
cost/M tokens; dedicated-vs-serverless break-even ~72% utilization —
[DigitalOcean](https://www.digitalocean.com/community/tutorials/llm-inference-cost)).
Allocate by measured GPU-seconds; **idle capacity goes to an unallocated pool, never spread
across tenants**. Include ops labor (20–30% of a senior engineer is standard).

### BYOK
- Market postures: platform keys + markup (default); BYOK + fee (OpenRouter: **5% of
  list-price equivalent**, first 1M req/month free — the fee basis is *notional list price*,
  proving the notional-cost computation is production practice
  ([OpenRouter BYOK](https://openrouter.ai/docs/guides/overview/auth/byok))); BYOK free
  (Vercel AI Gateway: no markup, but **metered separately** and excluded from budget caps;
  **failover to platform keys is billed**
  ([Vercel BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok))).
- **Consensus: meter fully, rate notionally, invoice never.** Add
  `cost_basis ∈ {internal, byok_notional}` to every event; filter on it in every financial
  query; report margin % AND gross-profit $ (BYOK flatters percentages).
- Providers will NOT enforce your caps on BYOK keys — enforce at your gateway.
- **HIPAA BAA chain fork** (the most consequential BYOK finding): with platform keys the
  chain is clinic → HOPE (BA) → provider (subcontractor BA). With BYOK, the provider's BAA
  runs directly to the clinic for the PHI-to-model hop; HOPE remains BA for everything else.
  Microsoft: a customer's BAA cannot be used by the platform and vice versa
  ([Azure HIPAA offering](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-hipaa-us)).
  Bedrock has **model-level BAA exclusions** within an eligible service
  ([AWS HIPAA eligible services](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)).
  Consequences: per-credential attestation flags (`baa_confirmed`, `zdr_confirmed`,
  `permitted_models[]`), fail-closed, captured in the audit log (Vercel skips
  non-ZDR-attested BYOK keys by default — copy this); constrain model allow-lists per BYOK
  credential; **BYOK→platform-key failover must be opt-in, logged, and disabled when
  coverage differs** — it moves PHI between BAA scopes mid-request.

---

## 9. Monitoring & alerting

- SLIs per capability: LLM — TTFT, time-per-output-token, tokens/sec, total duration;
  STT — RTF, endpointing lag, queue depth, partial→final latency; all — error rate split
  provider-side vs internal, **fallback rate as a top-level SLI** (a fallback event changes
  quality AND cost simultaneously), retry rate, cache-hit rate; quality proxies —
  guardrail block rate, empty/truncated output rate, Whisper repetition detection.
- Multi-window multi-burn-rate alerting (SRE workbook) applied to error budgets AND to
  tenant budget consumption ("tenant exhausts monthly budget in 3 days at current rate" is
  the highest-value cost alert).
- **Prometheus cardinality — the decisive rule**: never label metrics with `tenant_id`
  (10k tenants × existing series ≈ 10M+ series
  — [Last9](https://last9.io/blog/how-to-manage-high-cardinality-metrics-in-prometheus/)).
  Safe labels: capability, provider, model, deployment, outcome. Enforce with
  `metric_relabel_configs` at scrape (treat unbounded label injection as a DoS vector).
  Per-tenant analytics live in Postgres/Timescale, surfaced in Grafana via the Postgres
  datasource; exemplars bridge aggregate spikes to traces. Anomaly detection (rolling
  median + MAD over per-tenant hourly CAGGs) runs in Postgres, not Prometheus.
- Two dashboards, two sources: service health (Prometheus — TTFT heatmap, RTF, error/
  fallback rates, queue depth, GPU utilization) and consumption & cost (Postgres — units by
  capability, top-N tenant cost, cost-per-encounter distribution, budget burn-down,
  price-book version).

---

## 10. Healthcare/PHI-safe telemetry

- Transcripts, prompts, completions, summaries are PHI — never in metrics/traces/logs.
  Leak paths: OTel GenAI content capture; LLM-observability SDKs capturing by default.
- Four defense layers: (1) `NO_CONTENT` pinned everywhere; (2) telemetry attribute
  **allow-list** (not deny-list); (3) OTel Collector transform/redaction as an independent
  layer; (4) CI assertions that no content-bearing attribute is emitted. No free-text
  fields in usage-event metadata — enums and ids only.
- Identifiers: `tenant_id` is an organization — safe. `user_id` (clinician) — ledger and
  audit log yes, Prometheus labels no. `consultation_id` — PHI-adjacent under Safe Harbor's
  "unique identifying number" prong; keep in the tenant-scoped Postgres ledger; salted-hash
  if it must appear in traces.
- **HIPAA audit log ≠ usage ledger** — different legal basis (§164.312(b) audit controls,
  6-year retention via §164.316(b)(2)(i)), different content (PHI references vs none),
  different mutability (tamper-evident vs re-ratable). Keep HOPE's existing
  AuditLog/sys-event pipeline as the audit system; the usage ledger is a new parallel
  structure. Because usage events carry no PHI they can have long retention, broad analyst
  access, and no BAA complications — but only if the separation stays clean from day one
  ([Kiteworks](https://www.kiteworks.com/hipaa-compliance/hipaa-audit-log-requirements/)).

---

## 11. Provider usage/cost APIs, cloud attribution mechanics, price books

### 11.1 The universal conclusion
**No cloud provider gives per-request, per-tenant cost.** Every provider-native mechanism
aggregates to usage-type × hour/day. AWS states it outright: CUR (classic and 2.0) carries
no per-`requestId` identifier — *"To attribute cost to an individual request or prompt, use
your model invocation logs rather than CUR"*
([Bedrock CUR docs](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html)).
Microsoft, for shared deployments: *"implement logic to track token usage for each tenant in
your application"*
([Multitenancy and Azure OpenAI](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/openai)).
**Meter at your own gateway as the system of record; use provider billing as a monthly
control total joined at model × usage-type × day.**

### 11.2 Provider reconciliation surfaces (for the true-up job)
- **OpenAI**: `GET /v1/organization/usage/*` (completions, audio_transcriptions,
  audio_speeches [returns characters], embeddings, …; bucket 1m/1h/1d; group by
  project/user/api_key/model/batch/service_tier) + `GET /v1/organization/costs` (1d only).
  Admin key required; freshness undocumented — measure empirically. Ungrouped queries
  return null attribution fields silently.
- **Anthropic**: `GET /v1/organizations/usage_report/messages` +
  `/v1/organizations/cost_report` (note plural `organizations`). Data fresh ~5 min. Usage
  splits cache writes by TTL (`cache_creation.ephemeral_{5m,1h}_input_tokens`). Traps:
  priority-tier costs absent from the cost endpoint; not available for Claude-on-Bedrock.
- **Azure**: Monitor metrics PT1M (`ProcessedPromptTokens`, `GeneratedTokens`,
  `ActiveTokens` = total−cached, cache-match-rate; native Anthropic cache metrics) — tokens
  fast, no dollars; Cost Management daily, 4-hour refresh — dollars slow, no tokens. No
  tenant dimension unless tenant ≡ deployment/resource-group/Foundry project (new
  auto-`project` tag, preview). APIM `llm-emit-token-metric`/`llm-token-limit` are
  governance-grade (streaming estimates, 50k active-time-series cardinality wall — tenant
  IDs cannot be metric dimensions).
- **AWS Bedrock**: four attribution mechanisms — application inference profiles (per-model
  resource, N×M explosion), Projects (`bedrock-mantle` only), **IAM principal attribution**
  (Apr 2026; `line_item_iam_principal` in CUR 2.0 + session tags via `sts:AssumeRole` —
  the documented LLM-gateway pattern; cache STS creds), per-request `requestMetadata`
  (invocation logs only, never the bill). CUR splits four token types
  (input/output/cache-read/cache-write) as separate line items — *"If you only sum input
  and output tokens, your totals will not match your bill."* Tag activation ~24–48 h; AWS
  uniquely supports 12-month tag backfill. Split Cost Allocation Data (EKS/ECS) is the only
  provider-native per-pod GPU cost split — relevant to self-hosted STT/NLP/TTS on k8s.
- **GCP**: BigQuery billing export is the best raw substrate (hourly rows, first-class
  `usage.amount`/`usage.pricing_unit`, effective price, credits, `export_time` for
  restatement detection). Labels non-retroactive. Per-request labels for Vertex are
  documented-by-title but unverified — highest-value item to confirm.
- Fixed commitments (Bedrock PT model-units, Azure PTU + reservations, Vertex GSUs) have
  **no token dimension and no provider-side split** — allocating them across tenants is a
  named internal accounting policy; idle capacity books to platform overhead, never smeared
  into tenant COGS. Azure cost-allocation rules explicitly exclude purchases and freeze
  percentages at rule creation.

### 11.3 Price-book prior art
- **LiteLLM `model_prices_and_context_window.json`** (~3,000 entries, measured 2026-08-02):
  the best field vocabulary and seed data. Units are USD per single unit (per token/char/
  second). Models tier/context-band/cache-state by exploding field NAMES
  (`cache_read_input_token_cost_above_272k_tokens_priority`) — proof those belong in
  columns, not names. **No version field, no effective dates, mutated in place with
  retroactive corrections — import from it (pinned by git SHA), never depend on it live.**
- **OpenRouter `GET /api/v1/models`**: best live JSON API (337 models; prices as decimal
  strings — copy that; `input_cache_write_1h` as a separate rate).
- **FOCUS** (FinOps Foundation): v1.4 current (2026-06); **no AI/token support yet — lands
  in 1.5** ("AI model identity and token consumption directly in the Cost and Usage
  dataset"). Borrow now: the `PricingQuantity`/`PricingUnit` vs
  `ConsumedQuantity`/`ConsumedUnit` split (consume 1M tokens, priced as 1 × "1M tokens"),
  `SkuPriceId`, and 1.3's data-recency/finality metadata (an `estimated` vs `final` flag
  per bucket — AWS Cost Explorer exposes exactly this as `"Estimated": boolean`).
- **Metering vendors converge on a five-part contract** (Metronome / Orb / Lago /
  OpenMeter / Stripe): (1) client-supplied idempotency key with exactly-once semantics;
  (2) bounded acceptance window (Orb ~12 h back / 5 min forward; Metronome 34 days);
  (3) an explicit, auditable correction path outside the window (backfill lifecycle, never
  silent overwrite); (4) an over-populated properties bag ("include dimensions you might
  price on in the future" — metric definitions are forward-only); (5) aggregation declared
  on the meter, not the event.
- Price-book shape synthesis: rows keyed
  `(provider, model_id, unit_kind, tier, context_band, effective_from, effective_to)`;
  rates as decimal strings; **never mutate a price row — supersede it**; store the resolved
  rate + price-book version on each rated event.

## 12. Known-unverified items (do not encode without confirming)

- All specific vendor dollar rates flagged "secondary" above (STT per-hour, Azure TTS/
  Language rates render client-side, Google NL unit model, Comprehend Medical PHI/ICD/RxNorm
  rows, ElevenLabs credit phrasing, Gemini-TTS token billing, OpenAI audio-input-token rate
  for gpt-4o-transcribe: $2.50 vs $6.00/1M unresolved — a 2.4× swing).
- OpenAI `/v1/audio/speech` usage object existence (undocumented; verify empirically).
- Deepgram rounding/multichannel primary confirmation; Google STT per-channel and
  empty-transcript charging.
- Whether Azure emits `cache_write_tokens` / full `completion_tokens_details`.
- vLLM cached-token fix status on the newest release.
- Bessemer margin figures (fetch 404'd); AI-scribe vendors' BYOK postures (none found —
  hypothesis: the vertical is platform-keys-only, which would make HOPE's BYOK a
  differentiator).
- 2025 HIPAA Security Rule NPRM status (could change logging obligations).

---

## 13. Billing & pricing research (added 2026-08-06, TASK-615)

Seventh research track: how the market prices the same capabilities to CUSTOMERS, how
usage-billing platforms structure invoicing, and what a hybrid fixed-plan + on-demand model
looks like in 2026. Structural patterns (ratios, discount %, architecture) are more durable
than absolute dollar figures — treat prices as a snapshot (Aug 2026).

### 13.1 STT sell-side norms (Deepgram, AssemblyAI, OpenAI, Google, Azure, Speechmatics, Sarvam)

- **1-second billing granularity, no per-request minimum** is now the dominant norm — the
  legacy 15-second minimums (AWS-era) are being phased out (Google v2 = 1 s rounding;
  Deepgram/AssemblyAI/Azure/Speechmatics/Sarvam = per-second).
- **Streaming premium over batch is normal but wildly variable**: AssemblyAI ~2–3×, Azure
  ~5.5×, Speechmatics ~7% — and **Deepgram inverts it** (streaming cheaper than batch).
  Sarvam charges one flat rate regardless of transport (₹30/hr).
- **Streaming billed-on basis splits the market**: Deepgram/Google/Azure bill audio
  duration processed; **AssemblyAI explicitly bills wall-clock connection time including
  idle** — the documented cost trap for apps that hold sockets open between utterances.
  Connection-time billing must pair with idle-timeout auto-close to be defensible.
- **Multichannel**: billed per channel summed (N× cost) wherever documented
  (Deepgram/AssemblyAI/Google); AWS historically did not multiply.
- **Add-ons are flat per-hour SKUs stacked on the base rate, not multipliers**: Deepgram
  redaction/diarization $0.0020/min each; AssemblyAI diarization +$0.02–0.12/hr, PII
  +$0.05–0.08/hr; Speechmatics translation +$0.65/hr; Sarvam diarization +₹15/hr. Azure
  prices the SAME feature two ways: diarization/lang-ID +$0.30/hr on real-time but bundled
  free on batch.
- Sources: [Deepgram](https://deepgram.com/pricing) ·
  [AssemblyAI](https://www.assemblyai.com/pricing) +
  [streaming-pricing FAQ](https://www.assemblyai.com/docs/faq/how-does-universal-streaming-session-based-pricing-work) ·
  [OpenAI](https://developers.openai.com/api/docs/pricing) ·
  [Google STT](https://cloud.google.com/speech-to-text/pricing) ·
  [Azure Speech](https://azure.microsoft.com/en-us/pricing/details/speech/) ·
  [Speechmatics](https://www.speechmatics.com/pricing) ·
  [Sarvam](https://docs.sarvam.ai/api-reference-docs/pricing)

### 13.2 LLM sell-side norms

- Input/output split universal; current flagship output:input ratios cluster **1:5–1:8**
  (Anthropic rigidly 5.0× on every model; OpenAI/Google 4–8.33×, drifting per release).
- **Cache-read discount has converged at ~90% off** across OpenAI/Anthropic/Google;
  cache-WRITE premiums (1.25–2×) still consolidating. Google explicit caching is
  structurally different: storage-hour billing independent of reads.
- **Reasoning/thinking tokens bill as ordinary output tokens** at all three labs (Google
  tried split pricing on Gemini 2.5 Flash and abandoned it) — the strongest cross-vendor
  norm found.
- **Batch discount is exactly 50%** at OpenAI/Anthropic/Google — the single most stable
  number in the space. Priority tiers run ~1.8–2× standard.
- Gateways/resellers normalize to **USD via per-provider rate cards, never to a synthetic
  credit unit** (OpenRouter: 0% inference markup, revenue from payment rails + 5% BYOK fee;
  LiteLLM: no markup mechanism at all — `response_cost` is an estimate). Transferable
  lesson: store cost as a **breakdown by unit type**, not a total — that is what makes
  provider-invoice reconciliation tractable.
- Azure PTU: hourly PTU is never cost-competitive with PAYG (2.8–5×) — it is a
  capacity/latency instrument. Documented blend: PTU floor → PAYG spillover
  (`spilloverDeploymentName`) → priority tier → batch.
- **Self-hosted pricing splits by what is sold**: model-catalog platforms
  (Together/Fireworks/Baseten) sell **per-token** for shared capacity with GPU-hour as the
  graduation path; compute platforms (Modal/RunPod/Replicate) sell **per-second GPU**.
  Same-hardware H100 rates vary 2.3× across platforms ($2.99–7.00/hr) — throughput is a
  serving-stack property, which is why token-equivalent pricing involves vendor
  risk-eating. Converged progression: tokens for spiky/early traffic, GPU-time for steady
  high-utilization production.
- Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing) ·
  [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) ·
  [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
  [OpenRouter FAQ](https://openrouter.ai/docs/faq) ·
  [LiteLLM cost tracking](https://docs.litellm.ai/docs/proxy/cost_tracking) ·
  [Azure PTU](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/provisioned-throughput) ·
  [Together](https://www.together.ai/pricing) · [Fireworks](https://fireworks.ai/pricing) ·
  [Baseten](https://www.baseten.co/pricing/) · [Modal](https://modal.com/pricing) ·
  [Replicate](https://replicate.com/pricing) · [RunPod](https://www.runpod.io/pricing)

### 13.3 TTS sell-side norms

- **Characters is the dominant billing unit** (ElevenLabs, Azure, PlayHT, OpenAI
  `tts-1`/`tts-1-hd`, Cartesia functionally). Deviation: OpenAI `gpt-4o-mini-tts` bills
  LLM-style tokens (text-in + audio-out) because it is an audio-generating LLM.
- Quality-tier multipliers are the norm inside one vendor: Azure HD = 1.375× standard,
  OpenAI HD = 2×, ElevenLabs Flash = 0.5× Multilingual, Cartesia pro cloning = 1.5×.
- **No provider publishes a per-request minimum** — only max-characters-per-request caps.
- Self-hosted TTS has **no standard**: fal.ai normalizes Kokoro to per-character
  ($0.02/1K) to be legible against market rate cards; Replicate/Baseten leave it in raw
  GPU-time. Break-even analysis (L40S vs ElevenLabs Flash) lands ~29k utterances/month —
  below that, serverless GPU wins.
- Sources: [ElevenLabs](https://elevenlabs.io/pricing) ·
  [Azure Speech](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/) ·
  [Cartesia](https://cartesia.ai/pricing) · [PlayHT](https://play.ht/pricing/) ·
  [Kokoro on fal.ai](https://fal.ai/models/fal-ai/kokoro/american-english) ·
  [self-hosted TTS cost cliff](https://www.arunbaby.com/speech-tech/0062-self-hosting-tts-production-economics/)

### 13.4 Usage-billing platform architecture (Stripe Meters, Lago, OpenMeter, Metronome, Orb)

All five converge on: `raw append-only event (idempotency-keyed) → dedup + windowed
aggregation → rating (effective-dated price book) → invoice line`. Deltas that matter:

| Platform | Dedup / window | Backdating | Rating maturity |
|---|---|---|---|
| Stripe Meters | `(event_name, identifier)` ~24 h | **hard reject: 35 d past / 5 min future** | applied at invoice time; no re-rate primitive |
| Lago (OSS) | `transaction_id`; same id+ts **replaces** | none documented; blocked by finalized invoices | plan-scoped, cycle-end |
| OpenMeter (OSS) | CloudEvents `source+id`, **32-day window** | soft | rate cards + separate entitlements |
| Metronome | event `transaction_id`, **34-day retention**, silent dup-drop | 34 d practical ceiling | **strongest re-rating**: time-ranged rate cards, "backdate pricing without re-ingesting events" |
| Orb | `event_id` = idempotency key; backfill in a separate key namespace | **12 h grace, then explicit Backfill API** | immutable published price versions, explicit grandfathering |

Universal rules: append-only with compensating corrections (never edits); idempotency key
derived from **intent** (job/session id + unit), never a fresh random UUID at send time;
event-time processing with a bounded acceptance window; exact-key dedup only (heuristic
dedup silently under-bills). Recommended composite: Metronome's raw-events/metric/rate-card
split + OpenMeter's CloudEvents schema + Orb's acceptance-window/backfill semantics.
Sources: [Stripe meter events](https://docs.stripe.com/api/billing/meter-event) ·
[Lago ingestion](https://getlago.com/docs/guide/events/ingesting-usage) ·
[OpenMeter dedup](https://openmeter.io/blog/usage-deduplication) ·
[Metronome idempotency](https://docs.metronome.com/developer-resources/use-api/idempotency/) +
[rate cards](https://docs.metronome.com/guides/implement-metronome/core-concepts/create-manage-rate-cards) ·
[Orb backfills](https://docs.withorb.com/guides/events-and-metrics/reporting-errors) +
[plan versions](https://www.withorb.com/blog/how-we-built-plan-versions-and-migrations)

### 13.5 Hybrid plan design (fixed + overage), credits, caps, BYOK billing

- **Allowance structure**: fungible credit pools are the dominant pattern for
  multi-capability AI platforms (Inworld, LiveKit — one dollar-denominated pool across
  LLM+STT+TTS); the counter-signal is **Windsurf publicly reverting from credits to hard
  per-capability quotas** because the abstraction destroyed cost predictability. For
  predictability-sensitive B2B (healthcare), per-capability allowances are the defensible
  start.
- **Overage rate**: subscription/self-serve → parity with included rate (Inworld explicit);
  enterprise commits → 15–25% premium over committed rate. 2026 trend: overage reframed as
  expansion incentive; punitive overage correlates with churn.
- **Proration**: no universal mechanic — Stripe does NOT prorate usage prices (clean period
  split); Chargebee applies the new plan's full quota **retroactively to period start** on
  upgrade. Pick one deliberately and document it.
- **Commitment drawdown**: prepaid credits vs recurring minimum commit; use-it-or-lose-it
  at term end is standard (80% usage → full commit billed); negotiated rollover 10–25%,
  usually capped to the next period. Purchased top-up credits carry longer/no expiry vs
  subscription credits (two separate expiry tracks).
- **Alerts/caps**: dominant alert cadence **50 / 80 / (95) / 100%**. Segment rule: paid
  tiers → soft caps (keep serving, bill overage); free/trial → hard caps (no billing
  relationship to absorb excess). Hard safety caps on paid tiers sit at the 95–98th
  percentile so they are rarely hit. AssemblyAI PAYG hard-blocks at credit exhaustion.
- **BYOK billing**: dominant pattern = two fully independent flows — provider bills the
  customer's own account directly; the platform charges a flat/seat orchestration fee,
  explicitly NOT a token markup. Usage still logged in full (zero-rated) for
  chargeback/audit. (OpenRouter's 5% notional fee is the outlier that proves notional
  rating is production practice.)
- Sources: [Metronome 2026 pricing-model survey](https://metronome.com/blog/2026-trends-from-cataloging-50-ai-pricing-models) ·
  [enterprise commits](https://metronome.com/blog/a-practical-guide-to-enterprise-commit-contracts) ·
  [Orb prepaid credits](https://docs.withorb.com/product-catalog/prepurchase) ·
  [Stripe usage caps](https://stripe.com/resources/more/usage-caps-how-to-protect-performance-and-turn-usage-into-revenue) +
  [prorations](https://docs.stripe.com/billing/subscriptions/prorations) ·
  [Chargebee mid-term UBB](https://www.chargebee.com/docs/billing/2.0/usage-based-billing/mid-term-subscription-changes-ubb) ·
  [Inworld](https://inworld.ai/pricing) · [LiveKit Inference](https://livekit.com/pricing/inference) ·
  [Kinde BYOK pricing](https://www.kinde.com/learn/billing/billing-for-ai/byok-pricing/) ·
  [L.E.K. overages](https://www.lek.com/insights/saas-pricing/mastering-overages-saas-pricing-models)

### 13.6 Healthcare constraints on the billing plane

- Minimum-necessary (45 CFR §164.506) applies to payment operations; the safe metering
  payload is opaque tenant/resource UUIDs + counts + timestamps + status enums —
  practitioner synthesis, not a named HHS scenario.
- §164.514(c) re-identification codes must NOT be derived from individual data — **a hash
  of a patient identifier fails this test**; a random, non-derivative UUID (which
  `consultationId` already is) resolved only inside the clinical system of record is the
  compliant pattern.
- **No mainstream billing/metering vendor signs a BAA**: Stripe explicitly does not (and
  states it is not a business associate); Metronome and Orb advertise SOC 2 Type II only,
  no HIPAA/BAA (verified against their trust pages Aug 2026; note Stripe acquired Metronome
  Jan 2026 — recheck posture). Consequence: the PHI-free architecture is the ONLY legally
  viable way to use any of them — rating stays in-house, only PHI-free finalized lines are
  exported.
- If the billing pipeline is kept PHI-free, HIPAA §164.312(b) audit controls do not attach
  to it (inference from rule text), and HITRUST scope can exclude it entirely (explicit
  HITRUST scoping guidance) — its audit obligations are then ordinary financial controls
  (SOX/ASC 606: immutable usage logs, line-item-to-event reconciliation, written dispute
  policy).
- Sources: [HHS TPO disclosures](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/disclosures-treatment-payment-health-care-operations/index.html) ·
  [HHS de-identification](https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html) ·
  [Is Stripe HIPAA compliant? (HIPAA Journal)](https://www.hipaajournal.com/is-stripe-hipaa-compliant/) ·
  [avoiding BAAs (Holland & Hart)](https://hhhealthlawblog.com/avoiding-business-associate-agreements/) ·
  [HIPAA 164.312(b) audit controls](https://blog.cloudticity.com/hipaa-164.312b-audit-control) ·
  [HITRUST scoping](https://www.ispartnersllc.com/blog/determine-scope-hitrust-engagement/)
