# TASK-386 — Platform Runtime Metrics: Metric Contract

**Status:** Active · **Owner:** Python/observability worker · **Consumer:** NestJS `PrometheusQueryService` (separate TS worker)

This file is the **source of truth** for the metric names, types, labels, scrape
jobs, and canonical PromQL the NestJS read-API layer queries. It is owned by the
Python/infra side of TASK-386; the TS worker codes against it. (Do not confuse
with the TASK-386 `README.md`, owned by the TS worker.)

> Metrics source = **Prometheus** (scrape), not in-process readout. Per-model
> "running" + "avg latency" come from the scraped Python `/metrics`, not a
> per-request fan-out.

---

## 1. Connection

| Item | Value |
|---|---|
| Env var | `PROMETHEUS_URL` |
| Default (dev) | `http://localhost:9090` |
| Host port var | `PROMETHEUS_PORT` (default `9090`) |
| Query API | `GET {PROMETHEUS_URL}/api/v1/query?query=<promql>` (instant), `…/api/v1/query_range` (range) |

`PROMETHEUS_URL` is wired in `.env.dev`. Prometheus runs as the **opt-in**
`prometheus` service in `infrastructure/docker/docker-compose.dev.yml` (profile
`observability`). Start it (does not disturb existing infra):

```bash
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile observability up -d prometheus
# Prometheus UI: http://localhost:9090
```

Scrape config: `infrastructure/docker/configs/prometheus/prometheus.yml`.

---

## 2. Scrape jobs

In **dev** the API gateway and the Python services run on the **host** (pnpm /
conda), not in containers, so Prometheus (in Docker) reaches them via
`host.docker.internal`.

| `job` label | Target | Service | Exposes |
|---|---|---|---|
| `api-gateway` | `host.docker.internal:8868/metrics` | API (NestJS) | `http_requests_total`, `http_request_duration_seconds`, `active_connections_count`, `hope_job_*` |
| `stt` | `host.docker.internal:8861/metrics` | STT | `http_*`, `stt_*`, `model_*` |
| `smr` | `host.docker.internal:8862/metrics` | SMR | `http_*`, `smr_*`, `model_*` |
| `guardrail` | `host.docker.internal:8863/metrics` | Guardrail | `model_*` (no `http_*` — see gaps) |
| `nlp` | `host.docker.internal:8864/metrics` | NLP | `nlp_http_*`, `model_*` |
| `harness` | `host.docker.internal:8866/metrics` | Harness | `http_*` only (no models) |

### Label conventions (read before writing PromQL)

- **No `service` target label is set by the scrape config.** The cross-service
  `model_*` metrics already carry their own `{service,model}` labels; adding a
  target `service` label would collide and Prometheus would rename the metric's
  own one to `exported_service`. **Per-service distinction for un-labelled
  metrics (e.g. `http_*` from Python services) uses the `job` label.**
- The **API gateway** `http_*` metrics carry their **own `service` label**
  (set in code by the interceptor) — use `service` there, not `job`.
- Histograms expose `_bucket` (with `le`), `_sum`, `_count` series.

---

## 3. Cross-service per-model metrics (headline #19 — running + avg latency)

Emitted **byte-identically** by STT, SMR, NLP, Guardrail. This is the single
PromQL pattern for per-model "running instances" and "avg/p95 latency".

| Metric | Type | Labels | Exposed by (job) |
|---|---|---|---|
| `model_running_instances` | gauge | `service`, `model` | stt, smr, nlp, guardrail |
| `model_inference_latency_seconds` | histogram | `service`, `model` | stt, smr, nlp, guardrail |

Histogram buckets (seconds): `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0`.

### Model inventory (`{service, model}` exact values)

Matches `apps/admin/src/features/platform-dashboard/models.ts`.

| `service` | `model` | What an inference is |
|---|---|---|
| `stt` | `whisper-large-v3-turbo` | one batch/streaming ASR pass |
| `stt` | `silero-vad-v5` | one full-file VAD pass |
| `smr` | `gemma-4-e4b` | one LLM generation (the request's `model`; value follows the caller) |
| `guardrail` | `granite-guardian-4.1-8b` | one guardian medical-context validation (value = configured guardian model) |
| `nlp` | `Medical-NER` | one token-classification (NER) pass |
| `nlp` | `symps-disease-bert` | one disease-suggestion classification pass |

> **SMR/Guardrail `model` value caveat:** these services emit the *configured/
> requested* model string. With dev defaults that string equals the canonical id
> above (`gemma-4-e4b`, `granite-guardian-4.1-8b`). If an operator points them at
> a different deployment, the label reflects that real value. NLP and STT map to
> the canonical ids explicitly.

### Canonical PromQL

```promql
# Currently-running instances per model (point-in-time gauge)
sum by (service, model) (model_running_instances)

# Currently-running for ONE model
sum(model_running_instances{service="stt", model="whisper-large-v3-turbo"})

# Average inference latency per model over 5m (seconds)
sum by (service, model) (rate(model_inference_latency_seconds_sum[5m]))
  /
sum by (service, model) (rate(model_inference_latency_seconds_count[5m]))

# p95 inference latency per model over 5m (seconds)
histogram_quantile(
  0.95,
  sum by (le, service, model) (rate(model_inference_latency_seconds_bucket[5m]))
)

# Inference throughput per model (inferences/sec)
sum by (service, model) (rate(model_inference_latency_seconds_count[5m]))
```

---

## 4. STT domain metrics (`job="stt"`)

Previously defined-but-dead; **now wired** into the real batch + streaming code
paths (`transcription/batch_service.py`, `vad/silero_service.py`,
`streaming/session_manager.py`, `streaming/inference.py`).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `stt_transcription_total` | counter | `pipeline`, `engine`, `status` | batch transcription jobs; `status` ∈ `success`/`error` |
| `stt_transcription_latency_seconds` | histogram | `pipeline`, `engine` | end-to-end batch latency |
| `stt_transcription_errors_total` | counter | `pipeline`, `error_type` | batch failures by exception type |
| `stt_audio_duration_seconds` | histogram | _(none)_ | submitted audio seconds — **transcription-minutes source** |
| `stt_streaming_sessions_active` | gauge | _(none)_ | currently-active streaming sessions |
| `stt_streaming_sessions_total` | counter | `status` | streaming sessions started (`status="started"`) |
| `stt_streaming_inference_latency_seconds` | histogram | _(none)_ | per-utterance streaming ASR latency |

Example label values: `pipeline="default"`, `engine="faster_whisper"` (the
`AiModelFormat` value, e.g. `faster_whisper`/`onnx`/`nemo`/`azure`),
`status="success"`, `error_type="ValueError"`.

### Canonical PromQL

```promql
# Transcription MINUTES processed (cumulative) — _sum is in seconds
sum(stt_audio_duration_seconds_sum) / 60

# Transcription minutes in the last 24h
sum(increase(stt_audio_duration_seconds_sum[24h])) / 60

# Transcription throughput (jobs/sec, successful)
sum(rate(stt_transcription_total{status="success"}[5m]))

# Transcription error ratio
sum(rate(stt_transcription_total{status="error"}[5m]))
  / clamp_min(sum(rate(stt_transcription_total[5m])), 1)

# Active streaming sessions (single-instance dev)
sum(stt_streaming_sessions_active)

# Batch p95 end-to-end latency
histogram_quantile(0.95, sum by (le) (rate(stt_transcription_latency_seconds_bucket[5m])))
```

---

## 5. SMR domain metrics (`job="smr"`)

Pre-existing; the standardized `model_*` pair (§3) was added alongside them in
`api/endpoints/generate.py` (inc/dec running gauge around generation, observe
latency on completion — both non-streaming and streaming paths).

| Metric | Type | Labels |
|---|---|---|
| `smr_generation_total` | counter | `provider`, `model`, `status` (`completed`/`failed`) |
| `smr_generation_latency_seconds` | histogram | `provider`, `model` |
| `smr_tokens_total` | counter | `provider`, `model`, `direction` (`input`/`output`) |
| `smr_generation_errors_total` | counter | `provider`, `model`, `error_type` |
| `smr_active_generations` | gauge | `provider` |
| `smr_time_to_first_token_seconds` | histogram | `provider`, `model` |
| `smr_concurrent_requests` | gauge | `provider` |

Example label values: `provider="lm-studio"`, `model="gemma-4-e4b"`,
`status="completed"`, `direction="output"`.

### Canonical PromQL

```promql
# Tokens/sec (output) per model
sum by (model) (rate(smr_tokens_total{direction="output"}[5m]))

# Generation p95 latency
histogram_quantile(0.95, sum by (le, model) (rate(smr_generation_latency_seconds_bucket[5m])))

# In-flight generations
sum(smr_active_generations)
```

---

## 6. NLP metrics (`job="nlp"`)

- **Per-model** `model_*` (§3): `service="nlp"`, `model ∈ {Medical-NER, symps-disease-bert}`
  — wired in `services/token_classifier.py` and `services/medical_suggester.py`.
  Defined with `prometheus_client` so they appear on `/metrics`.
- **HTTP** metrics are **namespaced**: `nlp_http_requests_total`,
  `nlp_http_request_duration_seconds`, etc. (the FastAPI instrumentator uses
  `metric_namespace="nlp"`).
- NLP's OpenTelemetry domain metrics (`nlp.inference.*`) export via **OTLP gRPC**,
  **not** Prometheus — do **not** query them here.

```promql
# NLP HTTP p95 (note the nlp_ prefix)
histogram_quantile(0.95, sum by (le) (rate(nlp_http_request_duration_seconds_bucket[5m])))
```

---

## 7. Guardrail metrics (`job="guardrail"`)

- **Per-model** `model_*` (§3): `service="guardrail"`,
  `model="granite-guardian-4.1-8b"` — wired around both guardian providers
  (`providers/guardian.py` Ollama path, `providers/openai_compat.py` LM-Studio/
  Azure/Bedrock path) in `validate_medical_context`.
- `/metrics` is served via `generate_latest()` with **no HTTP middleware**, so
  Guardrail emits **no `http_*` metrics** (see gaps). Per-service request health
  for guardrail is available from the API gateway's downstream metrics.

---

## 8. Harness metrics (`job="harness"`)

`http_*` only (default instrumentator). The harness **orchestrates** the model
services (STT/SMR/NLP/Guardrail) and runs **no local ML model**, so it emits no
`model_*` metrics — **by design, not a gap**. Per-model signals for work it
triggers appear under the downstream services' own `service` labels.

---

## 9. API gateway metrics (`job="api-gateway"`) — owned by the TS worker

Exposed by the NestJS app (`@willsoto/nestjs-prometheus`, public `/metrics`).
Defined in `packages/applications/.../observability/simplified-metrics.service.ts`.
Listed here so the read-API can query per-service HTTP health + sockets.

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `path`, `status`, `service` |
| `http_request_duration_seconds` | histogram | `method`, `path`, `status`, `service` |
| `active_connections_count` | gauge | `service` | (Redis-backed socket gauge; multi-instance aggregation handled on the NestJS side) |
| `hope_job_processing_total` | counter | `queue`, `status`, `processor` |
| `hope_job_processing_duration_seconds` | histogram | `queue`, `processor` |
| `hope_job_active_count` | gauge | `queue` |

### Canonical PromQL

```promql
# Per-service request p95 (uses the API's own `service` label)
histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))

# Per-service request rate
sum by (service) (rate(http_requests_total[5m]))

# Per-service 5xx error ratio
sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
  / clamp_min(sum by (service) (rate(http_requests_total[5m])), 1)

# Active socket connections (platform-wide)
sum(active_connections_count)
```

> For HTTP health of an individual **Python** service (which lacks a `service`
> label), filter by `job` instead, e.g.
> `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="stt"}[5m])))`.
> Guardrail is the exception (no `http_*`).

---

## 10. Gap list (documented, not faked)

| Gap | Impact | Note |
|---|---|---|
| Guardrail has no `http_*` middleware metrics | No per-service request rate/latency from guardrail's own `/metrics` | Use API-gateway downstream metrics; adding `prometheus_fastapi_instrumentator` to guardrail would close it (out of scope here). |
| NLP HTTP metrics are `nlp_`-prefixed | PromQL for NLP HTTP must use `nlp_http_*` | Different from other services' `http_*`. |
| NLP OTel domain metrics not scraped | `nlp.inference.*` unavailable in Prometheus | They go via OTLP gRPC; per-model coverage provided by the `model_*` pair instead. |
| Harness emits no `model_*` | No per-model rows for harness | By design — harness runs no local model. |
| `model` value for SMR/Guardrail follows config | Label may differ if a non-default model is deployed | Dev defaults match the canonical ids. |

---

## 11. Dashboard widget → PromQL quick map

| Widget | PromQL |
|---|---|
| Per-model **running** | `sum by (service, model) (model_running_instances)` |
| Per-model **avg latency** | `sum by (service,model)(rate(model_inference_latency_seconds_sum[5m])) / sum by (service,model)(rate(model_inference_latency_seconds_count[5m]))` |
| Per-model **p95 latency** | `histogram_quantile(0.95, sum by (le,service,model)(rate(model_inference_latency_seconds_bucket[5m])))` |
| **Transcription minutes** (24h) | `sum(increase(stt_audio_duration_seconds_sum[24h])) / 60` |
| **Active streaming sessions** | `sum(stt_streaming_sessions_active)` |
| **SMR tokens/sec** | `sum by (model)(rate(smr_tokens_total{direction="output"}[5m]))` |
| **Per-service request p95** | `histogram_quantile(0.95, sum by (le, service)(rate(http_request_duration_seconds_bucket[5m])))` |
| **Per-service error rate** | `sum by (service)(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (service)(rate(http_requests_total[5m])),1)` |
| **Active socket connections** | `sum(active_connections_count)` |
