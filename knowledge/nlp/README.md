# NLP Service

Production-ready medical Natural Language Processing service providing text classification, named entity recognition, medical diagnosis suggestion, and text correction for the HOPE platform.

## Overview

The NLP service is a Python FastAPI application that exposes four core NLP capabilities through REST and WebSocket APIs. Each capability is backed by a dedicated ML model loaded at startup and shared across all requests.

### Capabilities

| Capability | Model | Task |
|-----------|-------|------|
| **Text Classification** | `michellejieli/emotion_text_classifier` | Emotion categorization (labels determined by model's `id2label` mapping at runtime) |
| **Token Classification (NER)** | `blaze999/Medical-NER` | Medical entity extraction using BIO tagging (signs/symptoms, diseases/disorders, biological structures, clinical events, medications, procedures, and more) |
| **Medical Diagnosis Suggestion** | `shanover/symps_disease_bert_v3_c41` | 41-class disease prediction from symptom descriptions |
| **Text Correction** | SymSpell + Medical dictionaries | Spelling and medical terminology correction (English, Malayalam) |

All transformer-based capabilities support GPU acceleration with optional FP16 precision. The text corrector uses SymSpellPy for fast edit-distance-based corrections.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Client Applications                        │
│              (API Gateway, Web UI, Mobile Apps)               │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────┴───────────────────────────────────────┐
│                    NLP Service (FastAPI)                       │
├───────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐    │
│  │ REST API   │  │ WebSocket  │  │ Health & Monitoring   │    │
│  │ /api/v1/*  │  │ /ws/v1/*   │  │ (Prometheus, OTEL)   │    │
│  └─────┬──────┘  └─────┬──────┘  └──────────────────────┘    │
│        │               │                                      │
│  ┌─────┴───────────────┴──────────────────────────────────┐   │
│  │               Service Layer                             │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐  │   │
│  │  │  Text    │ │  Token   │ │  Medical  │ │  Text    │  │   │
│  │  │Classifier│ │Classifier│ │ Suggester │ │Corrector │  │   │
│  │  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘  │   │
│  └───────┼─────────────┼─────────────┼────────────┼────────┘   │
│          │             │             │            │             │
│  ┌───────┴─────────────┴─────────────┴────────────┴────────┐   │
│  │            ML Models (Transformers / SymSpell)           │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐      │   │
│  │  │ Emotion     │ │ Medical NER │ │ Disease BERT │      │   │
│  │  │ Classifier  │ │   Model     │ │   Model      │      │   │
│  │  └─────────────┘ └─────────────┘ └──────────────┘      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │            Infrastructure                               │   │
│  │  Logging  |  Observability  |  Security  |  Config      │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

### Model Loading

Models are loaded once during application startup via the lifespan event handler (`lifespan.py`), which calls `asyncio.gather()` to initialize all services concurrently. Each service implements an abstract base class (`TextClassifier`, `TokenClassifier`, `TextCorrector`) with `initialize()`, `process()`/`correct()`/`suggest()`, and `shutdown()` methods. Transformer pipelines from HuggingFace run inference. Services are managed as singletons through the `dependencies.py` module.

### Inference Pipeline

1. **Request validation** — Pydantic schemas enforce types, lengths, and language codes
2. **Dependency injection** — FastAPI injects the appropriate service singleton
3. **Preprocessing** — Text normalization and language detection
4. **Model inference** — Transformer pipeline or SymSpell lookup
5. **Postprocessing** — Confidence filtering, entity aggregation, probability normalization
6. **Response serialization** — Pydantic models ensure consistent output

### Multi-Language Support

The service supports English (`en`) and Malayalam (`ml`). Language selection affects:

- Text corrector dictionary selection (separate medical dictionaries per language)
- Model behavior for language-specific text patterns
- Entity normalization rules

## Tech Stack

| Category | Technology | Purpose |
|----------|-----------|---------|
| Runtime | Python 3.11+ | Application runtime |
| Package Manager | uv | Fast dependency management |
| Framework | FastAPI + Uvicorn | Async HTTP/WebSocket server |
| ML Framework | Transformers (HuggingFace) + PyTorch | Model inference |
| Text Correction | SymSpellPy | Edit-distance spelling correction |
| NLP | spaCy | Tokenization and linguistic features |
| Validation | Pydantic + Pydantic Settings | Input/output validation, configuration |
| Observability | OpenTelemetry, Prometheus, Jaeger | Tracing, metrics, distributed tracing |
| Logging | Structured JSON logging | Correlation IDs, structured output |
| Security | python-jose, passlib | JWT handling, password hashing |
| HTTP Client | httpx | Async HTTP requests |

## Getting Started

### Prerequisites

- **Python 3.11+**
- **uv** package manager
- GPU with CUDA support (optional, for acceleration)

### Local Development

```bash
cd apps/nlp

# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
uv sync

# Configure environment
cp env.example .env
# Edit .env with your settings

# Run the service
uv run python src/nlp/main.py

# Access Swagger UI
open http://localhost:8864/docs
```

### Using Docker

```bash
cd apps/nlp

cp env.example .env

docker build -t hope-nlp:latest .
docker run -d \
  --name hope-nlp \
  -p 8864:8864 \
  --env-file .env \
  hope-nlp:latest

curl http://localhost:8864/api/v1/health
```

### Verify Service

```bash
# Root info
curl http://localhost:8864/

# Health check
curl http://localhost:8864/api/v1/health

# Quick classification test
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient is recovering well", "language": "en"}'
```

## Configuration

All configuration uses environment variables with Pydantic validation. Key groups:

### Service Settings

The `NLPServiceConfig` class uses the `NLP_` env prefix for Pydantic settings. However, several fields read directly from specific environment variables via `os.getenv` with fallbacks:

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_SERVICE_NAME` / `SERVICE_NAME` | `nlp` | Service identifier (read via `os.getenv`, not `NLP_` prefix) |
| `OTEL_SERVICE_VERSION` / `SERVICE_VERSION` | `0.1.0` | Service version (read via `os.getenv`, not `NLP_` prefix) |
| `OTEL_SERVICE_NAMESPACE` / `SERVICE_NAMESPACE` | `hope` | Service namespace (read via `os.getenv`, not `NLP_` prefix) |
| `NLP_ENVIRONMENT` | `development` | Environment: `development`, `staging`, `production` |
| `NLP_DEBUG` | `false` | Debug mode |
| `HOST` | `0.0.0.0` | Bind address (read via `os.getenv`, not `NLP_` prefix) |
| `PORT` | `5005` | Bind port (read via `os.getenv`, not `NLP_` prefix) |
| `WORKERS` | `1` | Uvicorn worker count (read via `os.getenv`, not `NLP_` prefix) |
| `NLP_LOG_LEVEL` | `20` (INFO) | Log level (integer: 0=NOTSET, 10=DEBUG, 20=INFO, 30=WARNING, 40=ERROR, 50=FATAL) |

### Text Classification Model (`TEXT_CLASSIFIER_` prefix)

| Variable | Default | Description |
|----------|---------|-------------|
| `TEXT_CLASSIFIER_MODEL_NAME` | `michellejieli/emotion_text_classifier` | Text classification model |
| `TEXT_CLASSIFIER_MODEL_VERSION` | `1.0.0` | Model version string |
| `TEXT_CLASSIFIER_MODEL_PATH` | `None` | Optional local model path |
| `TEXT_CLASSIFIER_TOKENIZER_NAME` | `michellejieli/emotion_text_classifier` | Tokenizer name |
| `TEXT_CLASSIFIER_MAX_SEQUENCE_LENGTH` | `512` | Max token sequence length |
| `TEXT_CLASSIFIER_BATCH_SIZE` | `16` | Batch size |
| `TEXT_CLASSIFIER_NUM_LABELS` | `11` | Number of classification labels |
| `TEXT_CLASSIFIER_USE_GPU` | `true` | Enable GPU for text classification |
| `TEXT_CLASSIFIER_FP16` | `false` | Enable FP16 precision |
| `TEXT_CLASSIFIER_CONFIDENCE_THRESHOLD` | `0.6` | Minimum confidence threshold |
| `TEXT_CLASSIFIER_RETURN_ALL_PROBABILITIES` | `true` | Return all class probabilities |

### Token Classification Model (`TOKEN_CLASSIFIER_` prefix)

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_CLASSIFIER_MODEL_NAME` | `blaze999/Medical-NER` | NER model |
| `TOKEN_CLASSIFIER_MODEL_VERSION` | `1.0.0` | Model version string |
| `TOKEN_CLASSIFIER_MODEL_PATH` | `None` | Optional local model path |
| `TOKEN_CLASSIFIER_TOKENIZER_NAME` | `blaze999/Medical-NER` | Tokenizer name |
| `TOKEN_CLASSIFIER_MAX_SEQUENCE_LENGTH` | `512` | Max token sequence length |
| `TOKEN_CLASSIFIER_BATCH_SIZE` | `16` | Batch size |
| `TOKEN_CLASSIFIER_STRIDE` | `128` | Stride for long text handling |
| `TOKEN_CLASSIFIER_AGGREGATION_STRATEGY` | `simple` | Entity aggregation: `simple`, `first`, `max`, `average` |
| `TOKEN_CLASSIFIER_IGNORE_LABELS` | `["O"]` | Labels to ignore |
| `TOKEN_CLASSIFIER_USE_GPU` | `true` | Enable GPU for NER |
| `TOKEN_CLASSIFIER_FP16` | `false` | Enable FP16 precision |
| `TOKEN_CLASSIFIER_CONFIDENCE_THRESHOLD` | `0.5` | Minimum entity confidence |
| `TOKEN_CLASSIFIER_ENTITY_CONFIDENCE_AGGREGATION` | `mean` | Confidence aggregation method: `mean`, `max`, `min` |

### Medical Suggester Model (`MEDICAL_SUGGESTER_` prefix)

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDICAL_SUGGESTER_MODEL_NAME` | `shanover/symps_disease_bert_v3_c41` | Diagnosis model |
| `MEDICAL_SUGGESTER_MODEL_VERSION` | `1.0.0` | Model version string |
| `MEDICAL_SUGGESTER_TOKENIZER_NAME` | `shanover/symps_disease_bert_v3_c41` | Tokenizer name |
| `MEDICAL_SUGGESTER_USE_GPU` | `true` | Enable GPU for diagnosis |
| `MEDICAL_SUGGESTER_FP16` | `false` | Enable FP16 precision |
| `MEDICAL_SUGGESTER_CONFIDENCE_THRESHOLD` | `0.5` | Minimum suggestion confidence |

### Text Corrector

Uses env prefix `SPELLING_CORRECTOR_`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SPELLING_CORRECTOR_DICTIONARY_PATH` | `<project_root>/data/dictionaries` | Path to dictionary files |
| `SPELLING_CORRECTOR_SYMSPELL_MAX_EDIT_DISTANCE` | `2` | Maximum edit distance for suggestions |
| `SPELLING_CORRECTOR_SYMSPELL_PREFIX_LENGTH` | `7` | Prefix length for indexing |
| `SPELLING_CORRECTOR_SYMSPELL_MAX_SUGGESTIONS` | `5` | Maximum suggestions per word |
| `SPELLING_CORRECTOR_SYMSPELL_PRESERVE_CASE` | `true` | Preserve original casing via transfer_casing |
| `SPELLING_CORRECTOR_SYMSPELL_IGNORE_NON_WORDS` | `true` | Ignore non-word tokens |
| `SPELLING_CORRECTOR_SYMSPELL_IGNORE_TERM_WITH_DIGITS` | `true` | Ignore terms containing digits |

### WebSocket

> **Note**: `WebSocketConfig` and `WebSocketTokenClassificationConfig` classes exist in `config.py` with env prefixes `WEBSOCKET_` and `WEBSOCKET_TOKEN_CLASSIFICATION_` respectively, but they are **not currently instantiated** in the `Settings` container. The `WebSocketManager` uses hardcoded defaults instead:

| Hardcoded Constant | Value | Description |
|----------|---------|-------------|
| `HEARTBEAT_INTERVAL` | `30` | Heartbeat send interval in seconds |
| `CLEANUP_INTERVAL` | `60` | Inactive session cleanup interval in seconds |
| `WAIT_TIMEOUT` | `60` | Timeout waiting for client message before sending heartbeat |
| `SPANNING_TIMEOUT` | `30` | Additional buffer before declaring session inactive |
| `HEARTBEAT_TIMEOUT` | `90` | Max seconds since last heartbeat before session is considered inactive |

### Observability

These are read via `os.getenv` in `NLPServiceConfig`, not through the `NLP_` prefix:

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `None` | OTLP exporter endpoint (also used as `opentelemetry_endpoint` and `otlp_endpoint`) |
| `OTEL_EXPORTER_JAEGER_ENDPOINT` | `None` | Jaeger endpoint URL |
| `OTEL_EXPORTER_JAEGER_AGENT_HOST` | `None` | Jaeger agent host (auto-extracted from `OTEL_EXPORTER_JAEGER_ENDPOINT` if not set) |
| `OTEL_EXPORTER_JAEGER_AGENT_PORT` | `None` | Jaeger agent port (auto-extracted from `OTEL_EXPORTER_JAEGER_ENDPOINT` if not set) |
| `OTEL_RESOURCE_ATTRIBUTES` | `None` | Resource attributes dict |
| `OTEL_TRACES_ENABLED` | `true` | Enable distributed tracing |
| `OTEL_METRICS_ENABLED` | `true` | Enable metrics export |

### Security (`SECURITY_` prefix)

| Variable | Default | Description |
|----------|---------|-------------|
| `SECURITY_CORS_ORIGINS` | `["*"]` | Allowed CORS origins |
| `SECURITY_CORS_METHODS` | `["GET", "POST", "PUT", "DELETE", "OPTIONS"]` | Allowed HTTP methods |
| `SECURITY_CORS_HEADERS` | `["*"]` | Allowed CORS headers |
| `SECURITY_CORS_ALLOW_CREDENTIALS` | `true` | Allow credentials in CORS |
| `SECURITY_CORS_MAX_AGE` | `3600` | CORS max age in seconds |

## API Reference

See the [API Reference](api-reference.md) for complete endpoint documentation with request/response schemas.

### Endpoint Summary

**Health & Monitoring:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Service information |
| `GET` | `/api/v1/health` | Health check (currently returns minimal response) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/docs` | Swagger UI (disabled in production) |
| `GET` | `/redoc` | ReDoc documentation (disabled in production) |

**NLP Capabilities:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/classify/text` | Text classification |
| `POST` | `/api/v1/classify/tokens` | Medical NER entity extraction |
| `POST` | `/api/v1/diagnosis/suggestions` | Medical diagnosis suggestion |
| `POST` | `/api/v1/correct/text` | Spelling and terminology correction |
| `WS` | `/ws/v1/classify/text/{session_id}` | Real-time streaming text classification |
| `WS` | `/ws/v1/classify/token/{session_id}` | Real-time streaming token classification |

## Testing

### Running Tests

```bash
cd apps/nlp

# All tests
uv run pytest

# With coverage
uv run pytest --cov=src --cov-report=html

# Specific test file
uv run pytest tests/test_text_classifier.py -v

# Integration tests
uv run pytest tests/integration/ -v
```

### Test Structure

```
tests/
├── unit/
│   ├── test_text_classifier.py
│   ├── test_token_classifier.py
│   ├── test_medical_suggester.py
│   └── test_text_corrector.py
├── integration/
│   ├── test_api.py
│   └── test_websocket.py
├── fixtures/
│   └── sample_data.py
└── conftest.py
```

### Code Standards

```bash
uv run ruff check src tests   # Lint
uv run black src tests         # Format
```

- Type hints required for all functions
- Google-style docstrings for public APIs
- Target >80% code coverage
- Async patterns for all I/O operations

## Deployment

### Docker Production Build

The Dockerfile uses multi-stage builds with a distroless production image for minimal attack surface.

```bash
# Build production image
docker build --target production -t hope-nlp:1.0.0 .

# Run with GPU
docker run -d \
  --name hope-nlp-prod \
  -p 8864:8864 \
  -e NLP_ENVIRONMENT=production \
  -e TEXT_CLASSIFIER_USE_GPU=true \
  -e TOKEN_CLASSIFIER_USE_GPU=true \
  --gpus all \
  --restart unless-stopped \
  --memory="4g" \
  --cpus="2.0" \
  hope-nlp:1.0.0
```

### GPU Acceleration

GPU provides 2-5x performance improvement for transformer inference.

| Mode | RAM | VRAM | CPU | Typical Latency |
|------|-----|------|-----|----------------|
| CPU | 1-2 GB | — | 500m-1 core | 100-300ms per inference |
| GPU | 2-4 GB | 2-4 GB | 500m-1 core | 30-80ms per inference |

Enable per-model GPU usage via environment variables:

```bash
TEXT_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_USE_GPU=true
MEDICAL_SUGGESTER_USE_GPU=true
```

FP16 precision (halves VRAM usage with minimal accuracy loss):

```bash
TEXT_CLASSIFIER_FP16=true
```

### Resource Requirements

- **Disk**: ~2 GB for model weights (cached from HuggingFace)
- **Concurrent requests**: 10-50 per instance
- **Batch processing**: Up to 100 texts per batch

### Container Security

- Non-root user (UID 1001)
- Distroless production base image
- Read-only filesystem
- Input validation via Pydantic

## Observability

### Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `nlp_requests_total` | counter | Total requests by endpoint and status |
| `nlp_request_duration_seconds` | histogram | Request processing latency |
| `nlp_active_requests` | gauge | Currently processing requests |
| `nlp_model_inference_duration_seconds` | histogram | ML model inference time |
| `nlp_text_classification_total` | counter | Text classification requests |
| `nlp_token_classification_total` | counter | Token classification requests |
| `nlp_diagnosis_suggestions_total` | counter | Diagnosis suggestion requests |
| `nlp_text_corrections_total` | counter | Text correction requests |
| `nlp_model_load_duration_seconds` | histogram | Model loading time |
| `nlp_cpu_usage_percent` | gauge | CPU usage |
| `nlp_memory_usage_bytes` | gauge | Memory usage |
| `nlp_gpu_memory_usage_bytes` | gauge | GPU memory usage |

### Health Check Response

The current health endpoint (`GET /api/v1/health`) returns a minimal response:

```json
{}
```

> **Note**: Per-model loading status is not yet included in the health check response. The endpoint returns `200` if the service is running, `503` if the health check fails.

The root endpoint (`GET /`) returns service identification:

```json
{
  "service": "Medical Entity Recognition & NLP",
  "version": "1.0.0"
}
```

### Structured Logging

```python
from nlp.core.logging import get_logger

logger = get_logger(__name__)
logger.info("Processing request", extra={
    "model": "text_classifier",
    "text_length": 150,
    "language": "en",
    "confidence": 0.92
})
```

Output is structured JSON with correlation IDs for distributed tracing.

## Troubleshooting

### Service won't start

```bash
python --version              # Must be 3.11+
uv sync                       # Reinstall dependencies
cat .env                       # Verify configuration
```

### Model loading failures

```bash
# Clear HuggingFace cache and re-download
rm -rf ~/.cache/huggingface/
python -c "from transformers import AutoModel; AutoModel.from_pretrained('michellejieli/emotion_text_classifier')"

# Check GPU availability
python -c "import torch; print(torch.cuda.is_available())"
```

### Out of memory

Reduce batch sizes or disable GPU:

```bash
TEXT_CLASSIFIER_BATCH_SIZE=8
TOKEN_CLASSIFIER_BATCH_SIZE=8
TEXT_CLASSIFIER_USE_GPU=false
TOKEN_CLASSIFIER_USE_GPU=false
```

### WebSocket connection issues

```bash
# Test text classification WS
wscat -c ws://localhost:8864/ws/v1/classify/text/test-session

# Test token classification WS
wscat -c ws://localhost:8864/ws/v1/classify/token/test-session

# Check active connections
curl http://localhost:8864/api/v1/health
```

### Performance tuning

| Scenario | Recommended Settings |
|----------|---------------------|
| Low latency | GPU enabled, FP16, batch_size=1 |
| High throughput | GPU enabled, batch_size=32 |
| Low memory | CPU mode, batch_size=8 |
| Development | CPU mode, batch_size=16 |

## Related Documentation

- [STT V2 Service](../stt-v2/README.md) — Speech-to-text service
- [API Reference](api-reference.md) — Complete endpoint documentation
