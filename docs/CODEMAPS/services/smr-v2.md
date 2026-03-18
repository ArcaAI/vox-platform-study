# SMR V2 Codemap

**Last Updated:** 2026-03-14  
**Language:** Python 3.11+ / FastAPI  
**Port:** 8862 (development)  
**Entry Point:** [src/smr_v2/main.py](../../../apps/smr/src/smr_v2/main.py)

---

## 📋 Purpose

Medical conversation summarization service. Generates structured clinical documentation from doctor-patient conversations using multi-provider LLM support (Azure OpenAI, Ollama) with specialty-specific prompts and async processing.

---

## 🗂️ Directory Structure

```
apps/smr/src/smr_v2/
├── main.py                    # FastAPI app entry point
├── __init__.py                # Package init
│
├── api/                       # FastAPI endpoints
│   ├── health.py              # GET /health endpoints
│   ├── summarization.py       # POST /summarize (batch/async)
│   └── providers.py           # GET /providers (available LLMs)
│
├── core/                      # Configuration & initialization
│   ├── config.py              # Settings loader (pydantic)
│   ├── logging.py             # Structured logging setup
│   └── constants.py           # Application constants
│
├── models/                    # LLM model management
│   ├── model_factory.py       # Model selection & caching
│   ├── llm_providers.py       # LLM provider interfaces
│   └── model_loader.py        # Model initialization
│
├── providers/                 # LLM provider implementations
│   ├── azure_openai.py        # Azure OpenAI integration
│   ├── ollama.py              # Ollama local/remote
│   ├── gemini.py              # Google Gemini (optional)
│   └── base.py                # Provider abstract base
│
├── services/                  # Business logic
│   ├── summarization.py       # Summarization orchestrator
│   ├── prompt_manager.py      # Specialty prompts • templates
│   ├── result_formatter.py    # Output validation • schema
│   ├── specialty_handler.py   # Specialty-specific logic
│   └── job_handler.py         # Dramatiq job integration
│
├── schemas/                   # Request/response models (Pydantic)
│   ├── summarization.py       # Summarization DTOs
│   ├── medical.py             # Medical data structures
│   ├── provider.py            # Provider responses
│   └── error.py               # Error schemas
│
└── tests/                     # Unit and integration tests
    ├── unit/                  # Unit tests
    └── integration/           # Integration tests
```

---

## 📊 Medical Specialties

Supported medical specialties with tuned prompts:

- **Cardiology** — Heart/vascular diagnostics
- **Neurology** — Neurological conditions
- **Orthopedics** — Bone/joint conditions
- **Surgery** — Surgical consultations
- **Internal Medicine** — General medical consultations
- **Pediatrics** — Child health
- **Psychiatry** — Mental health
- **Oncology** — Cancer care

---

## 🔄 Request Flow: Summarization

```
┌─────────────────────────────────────────────────────────────┐
│  API Gateway receives POST /smr-v2/summarize                │
│  • Validates input (transcript, specialty, provider)        │
│  • Creates Dramatiq job                                     │
│  • Returns job ID to client                                 │
└────────────────┬────────────────────────────────────────────┘
                 │ Job enqueued to Redis
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Dramatiq Worker picks up job                               │
│  (SMR V2 worker process)                                    │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
    ┌──────────────────────────────┐
    │  Load LLM Model              │
    │  • Select provider (Azure,   │
    │    Ollama, Gemini)           │
    │  • Initialize connection     │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Select Specialty Prompt     │
    │  • Load template for field   │
    │  • Inject conversation data  │
    │  • Format system context     │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  LLM Inference               │
    │  • Call provider API         │
    │  • Stream or batch response  │
    │  • Handle errors/retries     │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Parse & Validate Output     │
    │  • Extract JSON structure    │
    │  • Schema validation         │
    │  • Medical compliance check  │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Store Result                │
    │  • MinIO or database         │
    │  • Associate with session    │
    └──────────┬───────────────────┘
               ▼
    ┌──────────────────────────────┐
    │  Notify API Gateway          │
    │  (callback / webhook)        │
    └──────────────────────────────┘
```

---

## 🔌 Key Components

### Summarization Service
**Purpose**: Orchestrates conversation summarization with provider selection

```python
class SummarizationService:
    async def summarize(
        conversation_id: str,
        provider: str = "azure",       # azure | ollama | gemini
        specialty: str = "general",
        model: str = "gpt-4",
        temperature: float = 0.7
    ) -> SummarizationResult:
        # 1. Load conversation transcript
        # 2. Select LLM provider
        # 3. Load specialty prompt
        # 4. Call LLM
        # 5. Validate output
        # 6. Store result
        # 7. Return summary
```

### Prompt Manager
**Purpose**: Manages medical specialty prompts and templates

```python
class PromptManager:
    def get_system_prompt(
        specialty: str,
        language: str = "en"
    ) -> str:
        # Returns specialty-tuned system prompt
        
    def get_user_prompt(
        conversation: str,
        context: Dict
    ) -> str:
        # Formats conversation + context into user message
```

### Provider Base Class
**Purpose**: Abstract interface for LLM providers

```python
class LLMProvider(ABC):
    async def complete(
        messages: List[Dict],
        temperature: float = 0.7,
        max_tokens: int = 2000
    ) -> str:
        # Call provider's LLM API
        
    async def health_check() -> bool:
        # Verify provider availability
```

---

## 🔗 External Dependencies

### Python Libraries
- `fastapi>=0.133.0` — Web framework
- `uvicorn[standard]>=0.41.0` — ASGI server
- `httpx>=0.28.1` — Async HTTP client
- `pydantic>=2.12.5` — Data validation
- `pydantic-settings>=2.13.1` — Config management
- `asyncpg>=0.31.0` — Async PostgreSQL
- `openai>=1.64.0` — Azure OpenAI SDK
- `ollama` — Ollama client library
- `google-generativeai` — Gemini API
- `dramatiq[redis]>=2.0.0` — Job queue
- `minio>=7.2.20` — Object storage
- `pydantic-json-schema` — JSON schema generation

### LLM Providers
- **Azure OpenAI** — GPT-4, GPT-3.5-turbo
- **Ollama** — Mistral, Llama2, Neural Chat
- **Google Gemini** — Gemini Pro (optional)

### Microservices
- **API Gateway** (NestJS) — Job submission
- **PostgreSQL** — Conversation storage
- **Redis** (Dramatiq) — Job queue
- **MinIO** — Result storage

---

## ⚙️ Configuration

**Environment Variables**:

```bash
# FastAPI
HOST=0.0.0.0
PORT=8862

# Database
DATABASE_URL=postgresql+asyncpg://...

# Redis (Dramatiq)
REDIS_HOST=localhost
REDIS_PORT=6379

# MinIO
MINIO_URL=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

# LLM Providers
# Azure OpenAI
AZURE_OPENAI_KEY=...
AZURE_OPENAI_ENDPOINT=https://...
AZURE_OPENAI_DEPLOYMENT=gpt-4

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral

# Gemini (optional)
GEMINI_API_KEY=...

# LLM Settings
PRIMARY_PROVIDER=azure               # azure | ollama | gemini
DEFAULT_TEMPERATURE=0.7
MAX_TOKENS=2000
REQUEST_TIMEOUT=30                   # seconds
```

---

## 📋 API Endpoints

### Health Probes
- `GET /health` — Liveness probe
- `GET /health/ready` — Readiness probe (checks LLM provider)

### Summarization
- `POST /summarize` — Submit summary job (async)
- `GET /summarize/{job_id}` — Get job status
- `GET /summarize/{job_id}/result` — Fetch result

### Provider Management
- `GET /providers` — List available LLM providers
- `POST /providers/{name}/health` — Check provider status

---

## 🧪 Testing

**Unit Tests**:
```bash
pytest tests/unit/ -v
```

**Integration Tests** (requires LLM provider):
```bash
pytest tests/integration/ -v
```

**Load Testing** (k6):
```bash
k6 run tests/load/summarization.js
```

---

## 🔐 Security Considerations

- **No auth** on SMR endpoints (auth handled by API Gateway)
- **Secrets** stored in environment (Azure Key Vault, Vault)
- **HIPAA-compliant** logging (no PHI in logs)
- **Input sanitization** on conversation text
- **Rate limiting** via API Gateway

---

## 📊 Observability

### Logging
- Structured JSON logs
- Context: job_id, tenant_id, specialty, provider, duration
- Sensitive data masking (patient names, IDs)

### Metrics (Prometheus)
- `smr_summarization_duration_seconds`
- `smr_provider_call_duration_seconds`
- `smr_errors_total`
- `smr_queue_length`

### Health Checks
- LLM provider connectivity
- Database connectivity
- Redis connectivity
- MinIO connectivity

---

## 🔗 Related Codemaps

- [API Gateway](./api-gateway.md) — Service consumer
- [Database Package](../packages/database.md) — Schema
- [Applications Package](../packages/applications.md) — Shared DTOs

---

**Status**: ✅ Current | SMR V2 active in development
