# HOPE Natural Language Processing (NLP) Service

A production-ready medical NLP service built with FastAPI, providing text classification, token classification (NER), medical diagnosis suggestion, and text correction capabilities using state-of-the-art transformer models.

## 🚀 Quick Start

### Using Docker (Recommended)

```bash
# 1. Clone and navigate to NLP service
git clone <repository-url>
cd apps/nlp

# 2. Configure environment
cp env.example .env
# Edit .env with your configuration

# 3. Build and run with Docker
docker build -t hope-nlp:latest .
docker run -d \
  --name hope-nlp \
  -p 8864:8864 \
  --env-file .env \
  hope-nlp:latest

# 4. Verify service is running
curl http://localhost:8864/api/v1/health
```

### Local Development

```bash
# 1. Install Python 3.11+ and UV package manager
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Install dependencies
cd apps/nlp
uv sync

# 3. Configure environment variables
cp env.example .env
# Edit .env with your settings

# 4. Run the service
uv run python src/nlp/main.py

# 5. Access the service
open http://localhost:8864/docs
```

## 📋 Features

### Core NLP Functionality

- **Text Classification**: Categorize medical documents into 11 emotion categories
  - Uses `michellejieli/emotion_text_classifier` model
  - Supports emotion detection: anger, fear, joy, love, sadness, surprise, etc.
  - Confidence scoring with probability distributions

- **Token Classification (NER)**: Extract medical entities from text
  - Uses `blaze999/Medical-NER` model
  - Identifies medical entities: diseases, symptoms, treatments, medications
  - BIO tagging with position tracking

- **Medical Diagnosis Suggestion**: AI-powered disease prediction
  - Uses `shanover/symps_disease_bert_v3_c41` model
  - Analyzes symptoms to suggest possible conditions
  - Confidence-based ranking

- **Text Correction**: Spelling and terminology correction
  - SymSpell-based correction engine
  - Medical terminology dictionaries (English & Malayalam)
  - Customizable edit distance and suggestion limits

### API Capabilities

- **REST API**: Synchronous processing endpoints
- **WebSocket API**: Real-time streaming classification
- **Multi-language Support**: English and Malayalam
- **Batch Processing**: Process multiple texts efficiently
- **Configurable Models**: GPU/CPU support with FP16 precision

### Enterprise Features

- **Production Ready**: Docker containerization with multi-stage builds
- **Observability**: OpenTelemetry tracing, Prometheus metrics, structured logging
- **Health Monitoring**: Comprehensive health checks and readiness probes
- **Security**: Non-root containers, distroless production images
- **Configuration Management**: Comprehensive environment-based configuration

## 🏗️ Architecture

The service follows a clean, modular architecture:

```
src/nlp/
├── api/                          # API Layer
│   └── v1/
│       ├── rest/                 # REST endpoints
│       │   ├── classify.py       # Text/Token classification
│       │   ├── correct.py        # Text correction
│       │   ├── diagnosis.py      # Medical diagnosis
│       │   └── monitoring.py     # Health & metrics
│       └── ws/                   # WebSocket endpoints
│           └── classify.py       # Real-time classification
├── core/                         # Core Configuration
│   ├── config.py                # Configuration management
│   ├── logging.py               # Structured logging
│   ├── observability.py         # OpenTelemetry setup
│   └── websocket_manager.py     # WebSocket management
├── services/                     # Business Logic
│   ├── text_classifier.py       # Text classification service
│   ├── token_classifier.py      # Token classification service
│   ├── medical_suggester.py     # Medical diagnosis service
│   └── text_corrector.py        # Text correction service
├── schemas/                      # Data Models
│   ├── classification.py        # Classification models
│   ├── diagnosis.py             # Diagnosis models
│   ├── correction.py            # Correction models
│   ├── common.py                # Shared models
│   └── health.py                # Health check models
├── infra/                       # Infrastructure
├── dependencies.py              # Dependency injection
├── lifespan.py                  # Application lifecycle
├── utils.py                     # Utility functions
├── app.py                       # FastAPI app factory
└── main.py                      # Application entry point
```

## 🔧 Technology Stack

### Core Technologies

- **Runtime**: Python 3.11+ with UV package manager
- **Framework**: FastAPI with Uvicorn ASGI server
- **ML Framework**: Transformers (Hugging Face) + PyTorch
- **NER Models**: BERT-based token classification
- **Text Classification**: Emotion classification transformer
- **Spelling Correction**: SymSpellPy with medical dictionaries

### ML Models

| Feature | Model | Task |
|---------|-------|------|
| Text Classification | `michellejieli/emotion_text_classifier` | 11 emotion categories |
| Token Classification | `blaze999/Medical-NER` | Medical entity extraction |
| Medical Diagnosis | `shanover/symps_disease_bert_v3_c41` | Disease suggestion (41 classes) |
| Text Correction | SymSpell + Medical Dictionaries | Spelling & terminology correction |

### Infrastructure

- **Containerization**: Docker with multi-stage builds (debug + production)
- **Production Image**: Distroless Python for minimal attack surface
- **GPU Support**: CUDA-enabled for GPU acceleration
- **Observability**: OpenTelemetry, Prometheus, Jaeger
- **Logging**: Structured JSON logging with correlation IDs

## 📊 Performance

### Model Performance

- **Text Classification**: ~100-200ms per text
- **Token Classification**: ~200-300ms per text
- **Medical Diagnosis**: ~150-250ms per text
- **Text Correction**: ~50-100ms per text

### Resource Usage

- **CPU Mode**: 1-2 GB RAM, 500m-1 core
- **GPU Mode**: 2-4 GB RAM + 2-4 GB VRAM
- **Disk**: ~2 GB for models (cached from Hugging Face)

### Scalability

- **Concurrent Requests**: 10-50 per instance
- **Batch Processing**: Up to 100 texts per batch
- **GPU Acceleration**: 2-5x faster with CUDA support

## 🔗 API Endpoints

### Health & Monitoring

- `GET /` - Service information
- `GET /api/v1/health` - Health check with model status
- `GET /metrics` - Prometheus metrics
- `GET /docs` - Interactive API documentation (Swagger UI)
- `GET /redoc` - Alternative API documentation (ReDoc)

### Text Classification

- `POST /api/v1/classify/text` - Classify text into emotion categories

**Request:**
```json
{
  "text": "The patient is very happy with the treatment results",
  "language": "en"
}
```

**Response:**
```json
{
  "predicted_label": "joy",
  "confidence": 0.92,
  "probabilities": {
    "joy": 0.92,
    "love": 0.05,
    "surprise": 0.02,
    "other": 0.01
  },
  "model_version": "1.0.0"
}
```

### Token Classification (NER)

- `POST /api/v1/classify/tokens` - Extract medical entities from text

**Request:**
```json
{
  "text": "Patient has diabetes and hypertension with chest pain",
  "aggregation_strategy": "simple",
  "language": "en"
}
```

**Response:**
```json
{
  "entities": [
    {
      "id": "uuid-1",
      "text": "diabetes",
      "normalized_text": "diabetes",
      "entity_type": "DISEASE",
      "confidence": 0.95,
      "position": {
        "start": 12,
        "end": 20
      },
      "model_version": "1.0.0"
    },
    {
      "id": "uuid-2",
      "text": "hypertension",
      "entity_type": "DISEASE",
      "confidence": 0.93,
      "position": {
        "start": 25,
        "end": 37
      }
    },
    {
      "id": "uuid-3",
      "text": "chest pain",
      "entity_type": "SYMPTOM",
      "confidence": 0.89,
      "position": {
        "start": 43,
        "end": 53
      }
    }
  ],
  "model_version": "1.0.0"
}
```

### Medical Diagnosis Suggestion

- `POST /api/v1/diagnosis/suggest` - Suggest possible medical conditions

**Request:**
```json
{
  "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
  "min_confidence": 0.1,
  "language": "en"
}
```

**Response:**
```json
{
  "suggestions": [
    {
      "disease": "Pneumonia",
      "confidence": 0.78
    },
    {
      "disease": "COVID-19",
      "confidence": 0.65
    },
    {
      "disease": "Bronchitis",
      "confidence": 0.52
    }
  ],
  "symptoms_analyzed": ["fever", "cough", "difficulty breathing"],
  "model_version": "1.0.0"
}
```

### Text Correction

- `POST /api/v1/correct/text` - Correct spelling and terminology

**Request:**
```json
{
  "type": "spelling",
  "text": "paracetmol for fver",
  "language": "en",
  "min_confidence": 0.7,
  "include_alternatives": true
}
```

**Response:**
```json
{
  "original_text": "paracetmol for fver",
  "corrected_text": "paracetamol for fever",
  "language": "en",
  "alternatives": [
    "paracetamol -> paracetamol",
    "fver -> fever"
  ]
}
```

### WebSocket Endpoints

- `WS /ws/classify/text/{session_id}` - Real-time text classification stream

**WebSocket Message (Incoming):**
```json
{
  "text": "Patient is experiencing severe anxiety",
  "language": "en"
}
```

**WebSocket Message (Outgoing):**
```json
{
  "predicted_label": "fear",
  "confidence": 0.88,
  "probabilities": {
    "fear": 0.88,
    "sadness": 0.08,
    "other": 0.04
  },
  "model_version": "1.0.0"
}
```

## 📚 Documentation

Comprehensive documentation is available in the `docs/` directory:

### Core Documentation

- **[Architecture Overview](docs/01-architecture.md)** - System architecture and design patterns
- **[API Reference](docs/02-api-reference.md)** - Complete API documentation with examples
- **[Model Documentation](docs/03-models.md)** - ML models, capabilities, and performance
- **[Development Guide](docs/04-development-guide.md)** - Development setup and guidelines

### Configuration & Deployment

- **[Configuration Guide](docs/05-configuration.md)** - Environment variables and settings
- **[Deployment Guide](docs/06-deployment.md)** - Production deployment instructions
- **[Docker Guide](docs/07-docker.md)** - Docker build and deployment

### Advanced Topics

- **[WebSocket Guide](docs/08-websocket.md)** - Real-time WebSocket communication
- **[Observability Guide](docs/09-observability.md)** - Monitoring, metrics, and tracing
- **[Performance Tuning](docs/10-performance.md)** - Optimization and scaling

## 🔒 Security

### Security Features

- **Non-root Containers**: Runs as user ID 1001 (non-privileged)
- **Distroless Production**: Minimal attack surface with distroless base image
- **Read-only Filesystem**: Immutable container filesystem
- **Security Headers**: CORS, CSP, and other security headers
- **Input Validation**: Strict Pydantic validation for all inputs
- **Model Security**: Models loaded from trusted Hugging Face Hub

### Security Best Practices

1. **Environment Variables**: Use secrets management for sensitive data
2. **HTTPS/WSS**: Enable TLS for all communications in production
3. **Rate Limiting**: Implement at API Gateway level
4. **Model Validation**: Verify model checksums and signatures
5. **Regular Updates**: Keep dependencies and base images updated
6. **Vulnerability Scanning**: Regular security scans of Docker images

## 🚀 Deployment

### Docker Deployment

```bash
# Build production image
docker build --target production -t hope-nlp:1.0.0 .

# Run with environment variables
docker run -d \
  --name hope-nlp-prod \
  -p 8864:8864 \
  -e NLP_HOST=0.0.0.0 \
  -e NLP_PORT=8864 \
  -e NLP_ENVIRONMENT=production \
  -e TEXT_CLASSIFIER_USE_GPU=true \
  -e TOKEN_CLASSIFIER_USE_GPU=true \
  --gpus all \
  --restart unless-stopped \
  --memory="4g" \
  --cpus="2.0" \
  hope-nlp:1.0.0
```

### Docker Compose

```yaml
version: '3.8'

services:
  nlp:
    build:
      context: ./apps/nlp
      dockerfile: Dockerfile
      target: production
    container_name: hope-nlp
    ports:
      - "8864:8864"
    environment:
      - NLP_ENVIRONMENT=production
      - TEXT_CLASSIFIER_USE_GPU=true
      - TOKEN_CLASSIFIER_USE_GPU=true
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8864/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Production Considerations

1. **GPU Support**: Enable GPU for 2-5x performance improvement
2. **Resource Limits**: Set appropriate CPU and memory limits
3. **Health Checks**: Configure health check probes
4. **Logging**: Configure log aggregation (ELK, Loki, etc.)
5. **Monitoring**: Set up Prometheus + Grafana dashboards
6. **Scaling**: Use horizontal pod autoscaling based on CPU/memory

For detailed deployment instructions, see the [Deployment Guide](docs/06-deployment.md).

## 🧪 Testing

### Running Tests

```bash
# Run all tests
uv run pytest

# Run with coverage
uv run pytest --cov=src --cov-report=html

# Run specific test file
uv run pytest tests/test_text_classifier.py -v

# Run integration tests
uv run pytest tests/integration/ -v
```

### Test Structure

```
tests/
├── unit/                        # Unit tests
│   ├── test_text_classifier.py
│   ├── test_token_classifier.py
│   ├── test_medical_suggester.py
│   └── test_text_corrector.py
├── integration/                 # Integration tests
│   ├── test_api.py
│   └── test_websocket.py
├── fixtures/                    # Test fixtures
│   └── sample_data.py
└── conftest.py                 # Pytest configuration
```

### API Testing

```bash
# Using curl
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient is very happy", "language": "en"}'

# Using httpie
http POST localhost:8864/api/v1/classify/tokens \
  text="Patient has diabetes" \
  aggregation_strategy=simple \
  language=en
```

## 📈 Monitoring & Observability

### Available Metrics

**Service Metrics:**
- `nlp_requests_total` - Total requests by endpoint and status
- `nlp_request_duration_seconds` - Request processing latency
- `nlp_active_requests` - Currently processing requests
- `nlp_model_inference_duration_seconds` - ML model inference time

**Model Metrics:**
- `nlp_text_classification_total` - Text classification requests
- `nlp_token_classification_total` - Token classification requests
- `nlp_diagnosis_suggestions_total` - Diagnosis suggestion requests
- `nlp_text_corrections_total` - Text correction requests
- `nlp_model_load_duration_seconds` - Model loading time

**Resource Metrics:**
- `nlp_cpu_usage_percent` - CPU usage percentage
- `nlp_memory_usage_bytes` - Memory usage in bytes
- `nlp_gpu_memory_usage_bytes` - GPU memory usage (if available)

### Health Monitoring

```bash
# Basic health check
curl http://localhost:8864/api/v1/health

# Response
{
  "status": "healthy",
  "service": "nlp",
  "version": "0.1.0",
  "models": {
    "text_classifier": "loaded",
    "token_classifier": "loaded",
    "medical_suggester": "loaded",
    "text_corrector": "loaded"
  },
  "timestamp": "2024-01-01T10:00:00Z"
}

# Prometheus metrics
curl http://localhost:8864/metrics
```

### Logging

Structured JSON logging with correlation IDs:

```python
from nlp.core.logging import get_logger

logger = get_logger(__name__)

logger.info("Processing classification request", extra={
    "model": "text_classifier",
    "text_length": 150,
    "language": "en",
    "confidence": 0.92
})
```

## 🤝 Contributing

### Development Setup

1. Fork and clone the repository
2. Install dependencies: `uv sync`
3. Configure environment: `cp env.example .env`
4. Run tests: `uv run pytest`
5. Start development server: `uv run python src/nlp/main.py`

### Code Standards

- **Type Hints**: Use type hints for all functions
- **Docstrings**: Google-style docstrings for all public APIs
- **Testing**: Maintain >80% code coverage
- **Linting**: Code must pass ruff and black checks
- **Async/Await**: Use async patterns for I/O operations

### Pull Request Process

1. Create a feature branch from `main`
2. Implement changes with tests
3. Update documentation
4. Run full test suite
5. Submit PR with clear description

## 📝 Configuration

### Required Environment Variables

```bash
# Service Configuration
NLP_NAME=nlp
NLP_VERSION=0.1.0
NLP_NAMESPACE=hope
NLP_ENVIRONMENT=development  # development, staging, production
NLP_HOST=0.0.0.0
NLP_PORT=8864
NLP_WORKERS=1
NLP_LOG_LEVEL=INFO

# Text Classification Model
TEXT_CLASSIFIER_MODEL_NAME=michellejieli/emotion_text_classifier
TEXT_CLASSIFIER_MODEL_VERSION=1.0.0
TEXT_CLASSIFIER_MAX_SEQUENCE_LENGTH=512
TEXT_CLASSIFIER_BATCH_SIZE=16
TEXT_CLASSIFIER_USE_GPU=true
TEXT_CLASSIFIER_CONFIDENCE_THRESHOLD=0.6

# Token Classification Model
TOKEN_CLASSIFIER_MODEL_NAME=blaze999/Medical-NER
TOKEN_CLASSIFIER_MODEL_VERSION=1.0.0
TOKEN_CLASSIFIER_MAX_SEQUENCE_LENGTH=512
TOKEN_CLASSIFIER_BATCH_SIZE=16
TOKEN_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_AGGREGATION_STRATEGY=simple
TOKEN_CLASSIFIER_CONFIDENCE_THRESHOLD=0.5

# Medical Diagnosis Suggester
MEDICAL_SUGGESTER_MODEL_NAME=shanover/symps_disease_bert_v3_c41
MEDICAL_SUGGESTER_MODEL_VERSION=1.0.0
MEDICAL_SUGGESTER_USE_GPU=true
MEDICAL_SUGGESTER_CONFIDENCE_THRESHOLD=0.5

# Text Corrector
SPELLING_CORRECTOR_DICTIONARY_PATH=./data/dictionaries
SPELLING_CORRECTOR_MAX_EDIT_DISTANCE=2
SPELLING_CORRECTOR_PREFIX_LENGTH=7
SPELLING_CORRECTOR_MAX_SUGGESTIONS=5

# Security
SECURITY_CORS_ORIGINS=["*"]
SECURITY_CORS_METHODS=["GET", "POST", "PUT", "DELETE", "OPTIONS"]

# WebSocket
WEBSOCKET_MAX_CONNECTIONS=100
WEBSOCKET_CONNECTION_TIMEOUT=300
WEBSOCKET_HEARTBEAT_INTERVAL=30

# Observability
OTEL_SERVICE_NAME=hope-nlp
OTEL_SERVICE_VERSION=1.0.0
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
```

For a complete list of configuration options, see the [Configuration Guide](docs/05-configuration.md).

## ❓ Troubleshooting

### Common Issues

#### Service Won't Start

```bash
# Check Python version
python --version  # Must be 3.11+

# Verify dependencies
uv sync

# Check environment variables
cat .env

# View logs
tail -f logs/nlp.log
```

#### Model Loading Failures

```bash
# Clear Hugging Face cache
rm -rf ~/.cache/huggingface/

# Manually download models
python -c "from transformers import AutoModel; AutoModel.from_pretrained('michellejieli/emotion_text_classifier')"

# Check GPU availability
python -c "import torch; print(torch.cuda.is_available())"
```

#### Out of Memory Errors

```bash
# Reduce batch size in .env
TEXT_CLASSIFIER_BATCH_SIZE=8
TOKEN_CLASSIFIER_BATCH_SIZE=8

# Disable GPU if needed
TEXT_CLASSIFIER_USE_GPU=false
TOKEN_CLASSIFIER_USE_GPU=false

# Use CPU mode
docker run --memory="2g" ...
```

#### WebSocket Connection Issues

```bash
# Test WebSocket connection
wscat -c ws://localhost:8864/ws/classify/text/test-session

# Check active connections
curl http://localhost:8864/api/v1/health

# View WebSocket logs
docker logs hope-nlp | grep websocket
```

For more troubleshooting help, see the [Development Guide](docs/04-development-guide.md).

## 📄 License

This project is part of the HOPE platform. See the main repository for license information.

## 🔗 Related Projects

- **HOPE API Gateway**: Central API gateway and authentication
- **HOPE STT Service**: Speech-to-Text companion service
- **HOPE TTS Service**: Text-to-Speech companion service
- **HOPE SMR Service**: Medical summarization service
- **HOPE Infrastructure**: Shared infrastructure components

## 📞 Support

For support and questions:

- Check the [documentation](docs/) for detailed guides
- Review the [troubleshooting section](#-troubleshooting) for common issues
- Open an issue in the repository for bugs or feature requests
- Contact the development team for enterprise support

---

## 📊 Service Status

**Current Status**: Production Ready ✅
**Version**: 0.1.0
**Python**: 3.11+
**Framework**: FastAPI
**ML Framework**: Transformers (PyTorch)
**Deployment**: Docker with GPU support
**Last Updated**: January 2025

## 🎯 Quick Feature Summary

✅ **Text Classification** (11 emotion categories)
✅ **Token Classification** (Medical NER)
✅ **Medical Diagnosis Suggestion** (41 disease classes)
✅ **Text Correction** (Spelling + Medical terminology)
✅ **REST API** (Synchronous processing)
✅ **WebSocket API** (Real-time streaming)
✅ **Multi-language Support** (English + Malayalam)
✅ **GPU Acceleration** (2-5x performance boost)
✅ **Production Ready** (Docker + Observability)
✅ **Comprehensive Documentation** (10 detailed guides)

