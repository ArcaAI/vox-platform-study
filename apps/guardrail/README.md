# Guardrail Service

AI-powered content safety and medical context validation service. The default LLM engine
is **LM Studio** (OpenAI-compatible, `http://localhost:1234/v1`) running **IBM Granite
Guardian** (`granite-guardian-4.1-8b`). The engine is selectable via `GUARDRAIL_V2_PROVIDER`
(`lm-studio` default | `ollama` | `azure` | `bedrock`).

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
  - or Ollama / Azure OpenAI / AWS Bedrock (see the LLM Engine section)

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
cp .env.example .env
```

Edit `.env` to configure your settings:

```bash
# LLM engine selector: lm-studio (default) | ollama | azure | bedrock
GUARDRAIL_V2_PROVIDER=lm-studio

# OpenAI-compatible engine (LM Studio default)
GUARDRAIL_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
GUARDRAIL_OPENAI_COMPAT_API_KEY=lm-studio
GUARDRAIL_OPENAI_COMPAT_GUARDRAIL_MODEL=granite-guardian-4.1-8b
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL=granite-guardian-4.1-8b

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

## LLM Engine

The service selects its LLM engine via `GUARDRAIL_V2_PROVIDER`:

| Provider | Transport | Protocol | Notes |
|---|---|---|---|
| `lm-studio` (default) | `POST {base_url}/v1/chat/completions` | Granite Guardian `<guardian>`/`<score>` | `granite-guardian-4.1-8b` |
| `ollama` | `POST {base_url}/api/generate` | Generic SAFE/UNSAFE prompts | optional, serves e.g. `gemma3` |
| `azure` | OpenAI-compatible chat | Generic SAFE/UNSAFE fallback | requires a guardian-capable deployment |
| `bedrock` | OpenAI-compatible gateway | Generic SAFE/UNSAFE fallback | requires a guardian-capable model |

**Granite Guardian protocol (BYOC):** criteria cannot be passed as API params over the
OpenAI-compatible endpoint, so each guardrail task appends a `<guardian>` block (the
criterion) as the final user message after the judged text. The model replies with
`<score>yes</score>` / `<score>no</score>` (`yes` = the criterion is met → unsafe). The
`comprehensive` task runs the content-safety, PII, and prompt-injection checks and merges
them. Medical-context validation uses a generic JSON prompt path. All engines fail open on
timeout/error.

## Per-Tenant Engine Configuration (Admin-Configurable, TASK-338 / TASK-506)

The engine/model are resolved **per tenant at request time** from the AI model registry
(`core."AiTaskDefault"` ⋈ `core."AiModel"`) — **enabled by default since TASK-506**, with
the env-only selection (`GUARDRAIL_V2_PROVIDER` + the per-engine `GUARDRAIL_*` vars above)
as the bootstrap/fail-open fallback. Deployments without a reachable Postgres behave
exactly as env-only ones.

### DB-driven config knobs

```bash
# Per-tenant DB resolution (default: true; false → env-only behavior)
GUARDRAIL_DB_CONFIG_ENABLED=true

# Read-only connection to the shared HOPE core DB (postgres:// is normalized to asyncpg)
GUARDRAIL_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope

# Fallback tenant used when X-Tenant-Id is absent or the request tenant has no rows
# (defaults to the seeded GLOBAL tenant where default guardrail config lives)
GUARDRAIL_DEFAULT_TENANT_ID=50000000-0000-0000-0000-000000000000

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

   | resolved field | source column | meaning |
   |---|---|---|
   | provider | `AiModel."provider"` | `lm-studio` \| `ollama` \| `azure` \| `bedrock` (NULL → env provider retained) |
   | model | `AiModel."sourceUri"` | the provider-native model id sent to the runtime (never the slug) |
   | azure deployment | `AiModel."_metadata"->>'azureDeployment'` | non-secret Azure deployment name (may be absent) |

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
└─────────────┘    │                 │    │   Ollama/Azure/      │
                   │  ┌─────────────┐│    │   Bedrock optional)  │
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

See `.env.example` for all available configuration options.

## Model Configuration

- **Default engine / model**: LM Studio serving `granite-guardian-4.1-8b`
- **Switch engine**: `GUARDRAIL_V2_PROVIDER` (`lm-studio` | `ollama` | `azure` | `bedrock`)
- **Override general guardrail model**: `GUARDRAIL_OPENAI_COMPAT_GUARDRAIL_MODEL`
- **Override guardian model**: `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL`
- Per-engine overrides use that engine's prefix (`GUARDRAIL_OLLAMA_*`, `GUARDRAIL_AZURE_*`, `GUARDRAIL_BEDROCK_*`)

## License

MIT License
