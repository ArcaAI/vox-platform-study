# Guardrail Service - API Documentation

## Service Overview

**Path**: `apps/guardrail/src/guardrail/`
**Entry Point**: `guardrail/main.py` → `create_app()` → `app = create_app()`
**Port**: 8865 (default)
**Framework**: FastAPI (Python 3.11+)

### Core Responsibilities
- **Content Safety Analysis** — Real-time and batch analysis via delegation to `apps/nlp` (GLiNER2)
- **Medical Context Validation** — Delegated to `apps/text` (LLM judge)
- **PII Detection & Redaction** — Delegated to `apps/nlp` (GLiNER2)
- **Groundedness Verification** — NLI verification via `apps/nlp` (MiniCheck)
- **Bidirectional Screening** — Inbound prompt + outbound response screening
- **Realtime Guardrails** — Streaming segment validation, consumption gating, output checks
- **Async Job Processing** — Background guardrail analysis with status tracking
- **Model Delegation** — Holds ZERO resident model weights; all inference delegated to `apps/nlp` and `apps/text`

### Key Architectural Patterns
- **Pure Delegation** — Guardrail holds ZERO model weights; all inference runs in `apps/nlp` (classification, NER, entailment) and `apps/text` (medical validation)
- **Fail-Closed** — Every endpoint fails closed (503) when a verdict cannot be computed; never returns "safe"/"grounded"/"medical" without a model actually running
- **Tenant-Scoped** — Every request requires `X-Tenant-Id` header (428 if absent)
- **Delegation with Credentials** — Provider overrides forwarded verbatim to `apps/nlp` and `apps/text`
- **Async Job Queue** — Redis-backed job processor for batch/async analysis

### Infrastructure Dependencies
| Dependency | Purpose | Client |
|------------|---------|--------|
| PostgreSQL | Tenant config resolver (AiRoutingPolicy, AiModel) | SQLAlchemy async |
| Redis | Job queue, config invalidation pub/sub | redis.asyncio |
| `apps/nlp` (8863) | Classification, PII, groundedness NLI | `NlpGuardClient` (HTTP) |
| `apps/text` (8864) | Medical validation (LLM judge) | `TextJudgeClient` (HTTP) |
| API Gateway | Config resolution, service registration, auth | httpx |

---

## API Endpoints Summary

### Health (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | Detailed health (always 200) |
| GET | `/health/live` | `liveness_check()` | K8s liveness |
| GET | `/health/ready` | `readiness_check()` | K8s readiness (Redis only) |
| GET | `/health/startup` | `startup_check()` | K8s startup |

### Guardrail Analysis (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/guardrail/analyze` | `analyze_content()` | Real-time content safety analysis |
| POST | `/api/guardrail/analyze/batch` | `analyze_batch()` | Batch content safety analysis |
| POST | `/api/guardrail/analyze/async` | `analyze_content_async()` | Submit async analysis job |
| GET | `/api/guardrail/types` | `get_guardrail_types()` | Available analysis types |

### Screening (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/guardrail/screen/inbound` | `screen_inbound()` | Screen inbound prompt with containment envelope |
| POST | `/api/guardrail/screen/outbound` | `screen_outbound()` | Screen outbound response |

### PII Redaction (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/guardrail/redact` | `redact_text()` | Redact PII (pseudonymize or full) |

### Medical Validation (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/medical/validate` | `validate_medical_context()` | Validate medical context (delegated to `text`) |
| POST | `/api/medical/validate/batch` | `validate_batch_medical_context()` | Batch medical validation |
| GET | `/api/medical/config` | `get_medical_validation_config()` | Policy configuration |
| GET | `/api/medical/health` | `medical_validation_health()` | Delegation health |

### Groundedness (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/guardrail/ground` | `ground_summary()` | Verify summary against transcript (NLI) |

### Realtime Guardrails (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/guardrail/realtime/segments` | `validate_segment()` | Validate finalized STT segment |
| GET | `/api/guardrail/realtime/segments/{id}` | `read_segment_verdict()` | Read stored segment verdict |
| POST | `/api/guardrail/realtime/consumption` | `gate_consumption()` | Gate cumulative artifact consumption |
| POST | `/api/guardrail/realtime/output` | `check_output()` | Output-side NER/grammar checks |

### Async Jobs (Service Token + Tenant Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/jobs/status/{job_id}` | `get_job_status()` | Get job status |
| GET | `/api/jobs/list` | `list_jobs()` | List tenant's jobs |
| DELETE | `/api/jobs/cancel/{job_id}` | `cancel_job()` | Cancel pending/processing job |
| GET | `/api/jobs/result/{job_id}` | `get_job_result()` | Get completed job result |
| GET | `/api/jobs/stats` | `get_job_stats()` | Tenant job statistics |

---

## Detailed API Documentation

### 1. Guardrail Analysis - POST /api/guardrail/analyze

**File**: `guardrail/api/endpoints/guardrails.py:84`
**Handler**: `analyze_content(request, http_request, analyzer) -> GuardrailResponse`

**Implementation Chain**:
```
analyze_content() [guardrails.py:84]
  → admitted() [core/dependencies.py] — admission gate
  → get_safety_analyzer() [core/dependencies.py]
    → pinned_safety_analyzer() [core/dependencies.py]
      → TenantConfigResolver.resolve() → SafetyPolicy
      → NlpGuardClient [services/external_nlp_client.py]
  → analyzer.analyze_content() [services/safety_analyzer.py:177]
    → policy.tasks_for(guardrail_type) — select tasks
    → _safety_client.classify() [services/external_nlp_client.py]
      → POST to NLP /classify/tokens (multi-task)
    → extract_pii_entities() [safety_analyzer.py:166] (if comprehensive/pii)
      → _pii_client.extract_pii_entities() [external_nlp_client.py]
        → POST to NLP /classify/tokens (PII model)
  → Collapse labels → safe/issues/confidence
```

**Data Integration**:
- **PostgreSQL**: TenantConfigResolver → AiRoutingPolicy → AiModel (guardrail.safety, guardrail.pii)
- **apps/nlp (8863)**: HTTP delegation via `NlpGuardClient` → `/classify/tokens`
- **In-Memory**: SafetyPolicy (registry-sourced), admission gate, circuit breaker

**Fail-Closed**: Missing model selection → 503; Model error → 503; Never returns `safe: true` without model running

---

### 2. Batch Analysis - POST /api/guardrail/analyze/batch

**File**: `guardrail/api/endpoints/guardrails.py:134`
**Handler**: `analyze_batch(request, http_request, analyzer) -> list[GuardrailResponse]`

**Implementation Chain**:
```
analyze_batch() [guardrails.py:134]
  → admitted() + _batch_gate() — fan-out bound
  → analyzer.batch_analyze() [safety_analyzer.py:230]
    → gate.map() if gate provided (bounded concurrency)
    → asyncio.gather(analyze_content() per text)
    → Per-element fail-closed: Exception → safe=false, issues=["undetermined"]
```

**Key Feature**: Multiplex cannot collapse to single status; undetermined elements marked distinctly

---

### 3. Async Analysis - POST /api/guardrail/analyze/async

**File**: `guardrail/api/endpoints/guardrails.py:202`
**Handler**: `analyze_content_async(request, http_request, job_processor) -> dict`

**Implementation Chain**:
```
analyze_content_async() [guardrails.py:202]
  → require_tenant_id() — mandatory tenant
  → JobProcessor.submit_job() [services/job_processor.py]
    → Redis job queue (LPUSH)
    → Returns job_id
  → JobProcessor background worker
    → pinned_safety_analyzer(tenant_id) — tenant-scoped
    → analyzer.analyze_content()
    → Result stored in Redis job record
```

---

### 4. Screening - POST /api/guardrail/screen/inbound

**File**: `guardrail/api/endpoints/screen.py:111`
**Handler**: `screen_inbound(request, http_request) -> ScreenResponse`

**Implementation Chain**:
```
screen_inbound() [screen.py:111]
  → require_tenant_id() — mandatory tenant
  → admitted() — admission gate
  → build_screener() [core/dependencies.py]
    → TenantConfigResolver → SafetyPolicy + NlpGuardClient
  → screener.screen_inbound() [services/screening.py]
    → SafetyAnalyzer.classify_tasks_scored() — per-task labels + confidences
    → Containment checks (injection defense)
  → wrap_untrusted() [services/injection_defense.py] — nonce-fenced envelope
```

**Output**: `ScreenResponse` with `decision`, `reasons`, `checks`, `envelope`, `nonce`, `usage_detail`

---

### 5. Outbound Screening - POST /api/guardrail/screen/outbound

**File**: `guardrail/api/endpoints/screen.py:143`
**Handler**: `screen_outbound(request, http_request) -> ScreenResponse`

**Implementation Chain**: Same as inbound but calls `screener.screen_outbound(response, source_context, nonce)`

**Key Features**: PII-leakage check (requires `source_context`), echo detection via `nonce`

---

### 6. PII Redaction - POST /api/guardrail/redact

**File**: `guardrail/api/endpoints/redact.py:267`
**Handler**: `redact_text(request, http_request, analyzer) -> RedactResponse`

**Implementation Chain**:
```
redact_text() [redact.py:267]
  → get_safety_analyzer() — raises 428/503 if no tenant/model
  → _resolve_chunk_chars() [redact.py:186] — control-plane chunk budget
  → _extract_spans() [redact.py:212]
    → _split_for_extraction() [redact.py:103] — chunk on separators
    → analyzer.extract_pii_entities() per chunk [safety_analyzer.py:166]
      → _pii_client.extract_pii_entities() → NLP
    → Normalize offsets to document coordinates
  → _apply_mask() [redact.py:238]
    → full: [REDACTED] for all spans
    → pseudonymize: stable per-label tokens ([PERSON_1], [EMAIL_1]...)
```

**Modes**:
- `pseudonymize`: Clinical terms preserved; identifiers → stable tokens
- `full`: All flagged spans → `[REDACTED]`

**Fail-Closed**: Runtime error → 502 (never 200 with unredacted text)

---

### 7. Medical Validation - POST /api/medical/validate

**File**: `guardrail/api/endpoints/medical.py:120`
**Handler**: `validate_medical_context(request, settings, guardian_provider) -> MedicalValidationResponse`

**Implementation Chain**:
```
validate_medical_context() [medical.py:120]
  → get_resolved_guardian_provider() [core/dependencies.py]
    → TenantConfigResolver.resolve_guardian_provider()
      → AiRoutingPolicy (guardian task) → AiModel → AiProviderConnection
    → TextJudgeClient [services/external_text_client.py]
      → POST to TEXT /api/v1/judge with provider_overrides
  → guardian_provider.validate_medical_context() [external_text_client.py]
    → TextJudgeClient.validate_medical_context()
      → POST to TEXT /api/v1/generate (judge prompt)
```

**Fail-Closed**: No model selection → 503; Timeout → 503; Never `is_medical=true` without model

---

### 8. Groundedness Verification - POST /api/guardrail/ground

**File**: `guardrail/api/endpoints/groundedness.py:95`
**Handler**: `ground_summary(request, http_request) -> GroundResponse`

**Implementation Chain**:
```
ground_summary() [groundedness.py:95]
  → acquire_groundedness_verifier() [core/dependencies.py]
    → pinned_groundedness_verifier() [core/dependencies.py]
      → MiniCheckLoadSpec (model_id, model_path, calibration)
      → load_minicheck_scorer() [services/entailment_scorer.py] — GGUF via llama.cpp
  → verifier.verify(summary, transcript) [services/groundedness_nli.py]
    → split_segments() — split summary into sentences
    → MiniCheck score per segment against transcript
    → verdict: GROUNDED | UNGROUNDED | UNVERIFIED
```

**Fail-Closed**: Missing model → 503; Unavailable → `unverified` (never `grounded`)

---

### 9. Realtime Guardrails

#### Segment Validation - POST /api/guardrail/realtime/segments
**File**: `guardrail/api/endpoints/realtime.py:112`
Validates finalized STT segment; stores verdict for fan-out reads

#### Consumption Gate - POST /api/guardrail/realtime/consumption
**File**: `guardrail/api/endpoints/realtime.py:151`
Validates cumulative artifact + capabilities; gates model consumption

#### Output Checks - POST /api/guardrail/realtime/output
**File**: `guardrail/api/endpoints/realtime.py:189`
NER provenance check + clinical preservation check (deterministic)

---

### 10. Async Jobs

**File**: `guardrail/api/endpoints/jobs.py`
- `GET /jobs/status/{job_id}` — Job status (404 if cross-tenant)
- `GET /jobs/list` — Paginated list with filters
- `DELETE /jobs/cancel/{job_id}` — Cancel pending/processing
- `GET /jobs/result/{job_id}` — Completed result
- `GET /jobs/stats` — Tenant statistics

**Tenant Isolation**: Job IDs are guessable; cross-tenant access returns 404 (not 403)

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `guardrail/main.py` | FastAPI app, lifespan, admission gates, circuit breakers |
| `guardrail/api/endpoints/guardrails.py` | Core analysis endpoints |
| `guardrail/api/endpoints/screen.py` | Bidirectional screening |
| `guardrail/api/endpoints/redact.py` | PII redaction |
| `guardrail/api/endpoints/medical.py` | Medical validation (delegated to `text`) |
| `guardrail/api/endpoints/groundedness.py` | Groundedness NLI (delegated to `nlp`) |
| `guardrail/api/endpoints/realtime.py` | Realtime streaming guardrails |
| `guardrail/api/endpoints/jobs.py` | Async job management |
| `guardrail/api/endpoints/health.py` | Health probes |
| `guardrail/services/safety_analyzer.py` | Policy + delegation to `nlp` |
| `guardrail/services/screening.py` | Bidirectional screening logic |
| `guardrail/services/job_processor.py` | Redis-backed async job queue |
| `guardrail/services/external_nlp_client.py` | HTTP client to `nlp` service |
| `guardrail/services/external_text_client.py` | HTTP client to `text` service |
| `guardrail/services/groundedness_nli.py` | MiniCheck NLI verifier |
| `guardrail/services/job_processor.py` | Redis-backed job queue |
| `guardrail/core/tenant_config.py` | Tenant config resolver (AiRoutingPolicy) |
| `guardrail/core/dependencies.py` | FastAPI dependencies (pinned analyzers, gates) |
| `guardrail/core/tenant_config.py` | SQL-based config resolution |
| `guardrail/core/effective_config.py` | Control plane config client |
| `guardrail/core/concurrency.py` | AdmissionGate, ResizableSemaphore |
| `guardrail/core/breaker.py` | CircuitBreaker with fail postures |

---

## Configuration (Control Plane)

| Key | Description |
|-----|-------------|
| `guardrail.judge.timeoutSeconds` | Medical judge timeout |
| `guardrail.judge.minConfidence` | Medical confidence floor |
| `guardrail.redact.chunkChars` | Redaction chunk budget |
| `guardrail.safety.threshold` | Moderation classification threshold |
| `guardrail.pii.threshold` | PII detection threshold |
| `guardrail.groundedness.model` | MiniCheck model selection |
| `guardrail.transport.maxConcurrentRequests` | Admission gate |
| `guardrail.transport.breakerFailureThreshold` | Circuit breaker |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `guardrail-analyze.html` — Real-time analysis with NLP delegation
- `guardrail-medical-validate.html` — Medical validation via Text service
- `guardrail-redact.html` — PII redaction with chunking
- `guardrail-groundedness.html` — Groundedness NLI via NLP
- `guardrail-screen.html` — Bidirectional screening with envelope
- `guardrail-realtime.html` — Realtime segment validation + consumption gate
- `guardrail-jobs.html` — Async job submission + status
- `guardrail-health.html` — Health probes (delegated model reporting)