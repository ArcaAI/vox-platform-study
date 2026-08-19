# Guardrail Service

AI-powered content safety and medical context validation service. Guardrail owns **policy**
— criteria, thresholds, taxonomies, verdict shape and the fail-closed posture — and hosts
**no LLM of its own**: medical-context judgement is delegated to `apps/text`'s isolated
judge lane (`POST {TEXT_URL}/api/v1/generate/internal/judge`), which owns the provider
adapters, the BYOK credential plane and the circuit breakers. Provider and model come from
`AiTaskDefault` (`guardrail.validate`), tenant row first and SYSTEM as the platform
fallback.

## Features

### **Primary: Medical Context Validation (Guardian Model)**

- **Medical Context Detection**: Validate if content is medical-related before processing
- **Confidence Scoring**: Get confidence levels for medical context validation
- **Context Classification**: Identify clinical, administrative, or general content
- **Keyword Analysis**: Fallback keyword-based validation for reliability

### **Secondary: General Content Safety**

- **Content Safety Analysis**: Detect harmful, inappropriate, or dangerous content
- **PII Detection**: Identify personally identifiable information
- **Prompt Injection Detection**: Detect attempts to manipulate system instructions
- **Comprehensive Analysis**: All checks combined in a single call

### **Processing Modes**

- **Real-time Processing**: Direct API calls for immediate results
- **Async Processing**: Job queue for batch processing and load balancing

### **Monitoring & Health**

- **Health Checks**: Comprehensive health checks for all services
- **Metrics**: Prometheus metrics for monitoring
- **Audit Logging**: Track all validation requests

## Quick Start

### Prerequisites

- Python 3.11+
- Redis server
- An LLM engine serving the configured model:
  - **LM Studio** (default) with `granite-guardian-4.1-8b` loaded, exposed at `http://localhost:1234/v1`
  - or vLLM / llama.cpp / Azure OpenAI / AWS Bedrock (see the LLM Engine section)

### Installation

```bash
# Install dependencies
pip install -e .

# For development
pip install -e ".[dev,test,lint]"
```

### Configuration

Copy the example environment file:

```bash
cp .env.sample .env
```

Edit `.env` to configure your settings:

```bash
# Where apps/text lives — the judge lane guardrail delegates to. Transport only:
# there is no engine, model, endpoint or vendor key in guardrail's env.
TEXT_URL=http://localhost:8862

# Redis configuration
GUARDRAIL_REDIS_URL=redis://localhost:6379/0

# Service configuration
GUARDRAIL_HOST=0.0.0.0
GUARDRAIL_PORT=8863
```

### Running the Service

```bash
# Development
python -m guardrail.main

# Production with uvicorn
uvicorn guardrail.main:app --host 0.0.0.0 --port 8863
```

## API Usage

### **Medical Context Validation (Primary Endpoint)**

Validate if content is medical-related before sending to medical documentation services:

```bash
curl -X POST "http://localhost:8863/api/medical/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Patient presents with chest pain and shortness of breath. Vital signs: BP 140/90, HR 95.",
    "request_id": "req_123",
    "include_reasoning": true
  }'
```

**Response:**

```json
{
  "is_medical": true,
  "confidence": 0.95,
  "context_type": "clinical",
  "reasoning": "Text contains clinical symptoms, vital signs, and patient presentation",
  "processing_time_ms": 250.5,
  "request_id": "req_123",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### **Batch Medical Validation**

```bash
curl -X POST "http://localhost:8863/api/medical/validate/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "texts": [
      "Patient diagnosed with hypertension",
      "Meeting scheduled for tomorrow",
      "Prescription: Lisinopril 10mg daily"
    ],
    "request_id": "batch_001"
  }'
```

### **General Content Safety Analysis**

```bash
curl -X POST "http://localhost:8863/api/guardrail/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your content to analyze",
    "guardrail_type": "comprehensive",
    "request_id": "req_123"
  }'
```

### Async Job Submission

```bash
curl -X POST "http://localhost:8863/api/guardrail/analyze/async" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your content to analyze",
    "guardrail_type": "comprehensive",
    "request_id": "req_123",
    "priority": "high"
  }'
```

### Check Job Status

```bash
curl "http://localhost:8863/api/jobs/status/job_123"
```

### Health Check

```bash
curl "http://localhost:8863/api/health"
```

## Guardrail Types

- `content_safety`: Detect harmful or dangerous content
- `pii_detection`: Identify personally identifiable information
- `prompt_injection`: Detect prompt injection attempts
- `comprehensive`: All checks combined (recommended)

## Response Format

```json
{
  "safe": true,
  "issues": ["pii_detected"],
  "confidence": 0.95,
  "processing_time_ms": 150.5,
  "request_id": "req_123",
  "timestamp": "2024-01-01T12:00:00Z",
  "error": null
}
```

## Development

### Running Tests

```bash
pytest
```

### Code Quality

```bash
# Format code
black src/

# Lint code
ruff check src/

# Type checking
mypy src/
```

### Pre-commit Hooks

```bash
pre-commit install
```

## LLM Judgement (delegated)

Guardrail declares no engine. `/medical/validate` resolves the tenant's
`guardrail.validate` selection and posts ONE judgement to `apps/text`:

| Concern | Owner |
| --- | --- |
| Criteria, thresholds, verdict shape, fail-closed posture | `apps/guardrail` |
| Provider adapters, pools, circuit breakers, BYOK credential resolution | `apps/text` (`/generate/internal/judge`) |
| Which provider + model runs | `AiTaskDefault` ⋈ `AiModel`, tenant row → SYSTEM row |
| Temperature / max tokens / timeout | provider-level `AiRuntimeProfile`, else the judge policy defaults |

The judge lane is deliberately OUTSIDE `text`'s own moderation gate and runs on its own
semaphore + breaker, so the safety plane can neither recurse into itself nor starve behind
the user-facing traffic it protects.

**Fail posture — FAIL-CLOSED throughout.** A judgement that never rendered (timeout,
`text` outage, exhausted retry budget) is a 503 on `/medical/validate` and a per-element
`is_medical=false` on the batch route. It is never `is_medical=true`.

## Per-Tenant Engine Configuration (Admin-Configurable, TASK-338 / TASK-506)

The provider/model are resolved **per tenant at request time** from the AI model registry
(`core."AiTaskDefault"` ⋈ `core."AiModel"`), tenant row over SYSTEM row. This is the ONLY
source of a selection: TASK-735 deleted the env engines that used to serve as a fallback,
so an unresolved (or tenant-VETOED) selection is a 503, never a substituted default.

### DB-driven config knobs

```bash
# Per-tenant DB resolution (default: true). False does NOT give an env-only mode —
# with no engine left to name, medical validation 503s.
GUARDRAIL_DB_CONFIG_ENABLED=true

# Read-only connection to the shared HOPE core DB (postgres:// is normalized to asyncpg)
GUARDRAIL_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope

# NOTE: there is no "default tenant" knob. Resolution is request tenant -> SYSTEM
# (00000000-...); a request without X-Tenant-Id resolves SYSTEM only.

# Resolved-config cache TTL in seconds (default 60)
GUARDRAIL_CONFIG_CACHE_TTL_S=60
```

`GUARDRAIL_DB_CONFIG_ENABLED` defaults to **true** (TASK-506). Set it to `false` and the
service never touches the DB and behaves exactly as the env-only configuration above.

### How resolution works (TASK-506: `AiTaskDefault` ⋈ `AiModel`)

1. The caller (SMR) forwards the consultation tenant as the **`X-Tenant-Id`** request header
   to `POST /api/medical/validate`.
2. The service reads (SQLAlchemy + asyncpg, read-only, mirroring STT) the ENABLED
   `core."AiTaskDefault"` row with `taskKey = 'guardrail.validate'` for
   `[tenant, SYSTEM]`, joined to the ENABLED `core."AiModel"` row matching its
   `modelSlug` in the same scope (tenant task-default preferred over SYSTEM's; the
   tenant's own model copy preferred over the SYSTEM catalog row):

   | resolved field   | source column                             | meaning                                                                        |
   | ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
   | provider         | `AiModel."provider"`                      | `lm-studio` \| `vllm` \| `llama-cpp` \| `azure` \| `bedrock` (NULL → env provider retained) |
   | model            | `AiModel."sourceUri"`                     | the provider-native model id sent to the runtime (never the slug)              |
   | azure deployment | `AiModel."_metadata"->>'azureDeployment'` | non-secret Azure deployment name (may be absent)                               |

3. **Resolution order (tenant-level):** request tenant (widened to SYSTEM) →
   default/system tenant → env defaults (`settings.engine`).
4. Resolved configs are held in a simple **per-tenant TTL cache (~60s)**, so steady-state
   request latency is unaffected.
5. The resolved **provider/model override** only the model selection; `base_url`/`api_key`
   still come from env (the DB only stores provider, model, and the non-secret Azure
   deployment name).

DB access is **fail-safe**: any DB error or empty result resolves to "no override", so the
endpoint transparently falls back to the env-selected engine.

### Azure key vs deployment

The Azure **deployment name** is DB-driven (`AiModel` `metaData.azureDeployment`). The Azure
**API key stays env/Vault** — it is never stored in plaintext DB rows (admin-set keys are
blocked on TASK-302 Phase 4D).

## Architecture

```
┌─────────────┐    ┌─────────────────┐    ┌──────────────────────┐
│   Client    │───▶│  Guardrail      │───▶│  LLM engine          │
│   Service   │    │    Service      │    │  (LM Studio default; │
└─────────────┘    │                 │    │   vLLM/llama.cpp/    │
                   │  ┌─────────────┐│    │   Azure/Bedrock)     │
                   │  │ Job Queue   ││    └──────────────────────┘
                   │  │ (Redis)     ││
                   │  └─────────────┘│
                   └─────────────────┘
```

## Monitoring

- **Metrics**: Available at `/metrics` (Prometheus format)
- **Health**: Available at `/api/health`
- **Job Statistics**: Available at `/api/jobs/stats`

## Configuration Options

See `.env.sample` for all available configuration options.

## Model Configuration

- **Judgement model**: the `AiTaskDefault` row for `guardrail.validate` — the tenant's own
  row when it has one, the SYSTEM row otherwise. Unresolved ⇒ 503.
- **Aux models**: `guardrail.safety` (GLiNER) and `guardrail.groundedness` (MiniCheck),
  resolved the same way and loaded lazily behind an idle-TTL cache.
- **Credential**: the tenant's `llm` `AiProviderConnection`, forwarded to `apps/text` as an
  opaque `provider_overrides` blob. Guardrail reads no vendor key from env — there is none
  to read (`test_text_judge_delegation.py` pins that).

## License

MIT License
