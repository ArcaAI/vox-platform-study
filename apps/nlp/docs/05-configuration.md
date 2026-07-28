# Configuration Guide

Complete guide to configuring the HOPE NLP Service.

## Environment Variables

All configuration is done through environment variables, following the 12-factor app methodology.

### Service Configuration

```bash
# Service Identification
NLP_NAME=nlp
NLP_VERSION=0.1.0
NLP_NAMESPACE=hope

# Environment
NLP_ENVIRONMENT=development  # development, staging, production
NLP_DEBUG=false

# Server
NLP_HOST=0.0.0.0
NLP_PORT=8864
NLP_WORKERS=1
NLP_LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR, FATAL

# Processing Limits
NLP_MAX_TEXT_LENGTH=10000
NLP_MAX_BATCH_SIZE=100
```

### Text Classification Configuration

> **Open decision (TASK-330 §3.4) — doc-type classifier is unconfigured.** The
> `/classify/text` endpoint is meant for clinical _document-type_ classification (e.g.
> clinical note vs discharge summary vs lab report), but the intended model + label
> taxonomy has not been chosen yet. The default is therefore a non-functional placeholder
> (`__UNCONFIGURED_DOC_TYPE_CLASSIFIER__`); while it is in effect the service logs a loud
> warning at startup and `/classify/text` returns **HTTP 503**. Set
> `TEXT_CLASSIFIER_MODEL_NAME` to a real model to enable the endpoint. (The previous default,
> `michellejieli/emotion_text_classifier`, was an emotion model used only as a placeholder.)

```bash
# Model Configuration
# REQUIRED to enable /classify/text — defaults to an unconfigured placeholder (see note above).
TEXT_CLASSIFIER_MODEL_NAME=__UNCONFIGURED_DOC_TYPE_CLASSIFIER__
TEXT_CLASSIFIER_MODEL_VERSION=1.0.0
TEXT_CLASSIFIER_MODEL_PATH=  # Optional: local model path
TEXT_CLASSIFIER_TOKENIZER_NAME=__UNCONFIGURED_DOC_TYPE_CLASSIFIER__

# Processing Settings
TEXT_CLASSIFIER_MAX_SEQUENCE_LENGTH=512
TEXT_CLASSIFIER_BATCH_SIZE=16
TEXT_CLASSIFIER_NUM_LABELS=11

# Performance Settings
TEXT_CLASSIFIER_USE_GPU=true
TEXT_CLASSIFIER_FP16=false

# Confidence Settings
TEXT_CLASSIFIER_CONFIDENCE_THRESHOLD=0.6
TEXT_CLASSIFIER_RETURN_ALL_PROBABILITIES=true
```

### Token Classification Configuration

```bash
# Model Configuration
TOKEN_CLASSIFIER_MODEL_NAME=blaze999/Medical-NER
TOKEN_CLASSIFIER_MODEL_VERSION=1.0.0
TOKEN_CLASSIFIER_MODEL_PATH=  # Optional: local model path
TOKEN_CLASSIFIER_TOKENIZER_NAME=blaze999/Medical-NER

# Processing Settings
TOKEN_CLASSIFIER_MAX_SEQUENCE_LENGTH=512
TOKEN_CLASSIFIER_BATCH_SIZE=16
TOKEN_CLASSIFIER_STRIDE=128

# NER Specific Settings
TOKEN_CLASSIFIER_AGGREGATION_STRATEGY=simple
TOKEN_CLASSIFIER_IGNORE_LABELS=["O"]

# Performance Settings
TOKEN_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_FP16=false

# Confidence Settings
TOKEN_CLASSIFIER_CONFIDENCE_THRESHOLD=0.5
TOKEN_CLASSIFIER_ENTITY_CONFIDENCE_AGGREGATION=mean
```

### Medical Suggester Configuration

```bash
# Model Configuration
MEDICAL_SUGGESTER_MODEL_NAME=shanover/symps_disease_bert_v3_c41
MEDICAL_SUGGESTER_MODEL_VERSION=1.0.0
MEDICAL_SUGGESTER_TOKENIZER_NAME=shanover/symps_disease_bert_v3_c41

# Performance Settings
MEDICAL_SUGGESTER_USE_GPU=true
MEDICAL_SUGGESTER_FP16=false

# Confidence Settings
MEDICAL_SUGGESTER_CONFIDENCE_THRESHOLD=0.5
```

### Text Corrector Configuration

```bash
# Dictionary Configuration
SPELLING_CORRECTOR_DICTIONARY_PATH=./data/dictionaries

# SymSpell Settings
SPELLING_CORRECTOR_MAX_EDIT_DISTANCE=2
SPELLING_CORRECTOR_PREFIX_LENGTH=7
SPELLING_CORRECTOR_MAX_SUGGESTIONS=5
SPELLING_CORRECTOR_PRESERVE_CASE=true
SPELLING_CORRECTOR_IGNORE_NON_WORDS=true
SPELLING_CORRECTOR_IGNORE_TERM_WITH_DIGITS=true
```

### Security Configuration

```bash
# CORS Settings
SECURITY_CORS_ORIGINS=["*"]
SECURITY_CORS_METHODS=["GET", "POST", "PUT", "DELETE", "OPTIONS"]
SECURITY_CORS_HEADERS=["*"]
SECURITY_CORS_ALLOW_CREDENTIALS=true
SECURITY_CORS_MAX_AGE=3600
```

### WebSocket Configuration

```bash
WEBSOCKET_MAX_CONNECTIONS=100
WEBSOCKET_CONNECTION_TIMEOUT=300  # seconds
WEBSOCKET_HEARTBEAT_INTERVAL=30   # seconds
WEBSOCKET_PING_TIMEOUT=10         # seconds
```

### Observability Configuration

```bash
# OpenTelemetry Service Information
OTEL_SERVICE_NAME=hope-nlp
OTEL_SERVICE_VERSION=1.0.0
OTEL_SERVICE_NAMESPACE=hope

# OpenTelemetry Exporter Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_JAEGER_ENDPOINT=http://localhost:14268/api/traces
OTEL_EXPORTER_JAEGER_AGENT_HOST=localhost
OTEL_EXPORTER_JAEGER_AGENT_PORT=6831

# Resource Attributes
OTEL_RESOURCE_ATTRIBUTES=service.name=hope-nlp,service.version=1.0.0

# Feature Flags
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true
```

### Logging Configuration

```bash
LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR, FATAL
LOG_FORMAT=json  # json or text
LOG_FILE_ENABLED=false
LOG_FILE_PATH=./logs
LOG_FILE_MAX_SIZE=10485760  # 10MB in bytes
LOG_FILE_BACKUP_COUNT=5
```

## Configuration Files

### .env File (Development)

Create a `.env` file in the project root:

```bash
# Copy from example
cp env.example .env

# Edit configuration
nano .env
```

### Environment-Specific Configurations

**Development (.env.development):**

```bash
NLP_ENVIRONMENT=development
NLP_DEBUG=true
NLP_LOG_LEVEL=DEBUG
TEXT_CLASSIFIER_USE_GPU=false
TOKEN_CLASSIFIER_USE_GPU=false
```

**Production (.env.prod):**

```bash
NLP_ENVIRONMENT=production
NLP_DEBUG=false
NLP_LOG_LEVEL=INFO
TEXT_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_USE_GPU=true
TEXT_CLASSIFIER_FP16=true
```

## Docker Configuration

### Environment Variables in Docker

```bash
docker run -d \
  -e NLP_ENVIRONMENT=production \
  -e TEXT_CLASSIFIER_USE_GPU=true \
  -e TOKEN_CLASSIFIER_USE_GPU=true \
  --gpus all \
  hope-nlp:latest
```

### Using .env File with Docker

```bash
docker run -d \
  --env-file .env.prod \
  --gpus all \
  hope-nlp:latest
```

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  nlp:
    image: hope-nlp:latest
    environment:
      - NLP_ENVIRONMENT=production
      - TEXT_CLASSIFIER_USE_GPU=true
      - TOKEN_CLASSIFIER_USE_GPU=true
    env_file:
      - .env.prod
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

## Configuration Best Practices

1. **Never commit secrets** to version control
2. **Use .env files** for development only
3. **Use secrets management** in production
4. **Validate configuration** at startup
5. **Document all variables** in env.example
6. **Use type-safe configuration** with Pydantic
7. **Provide sensible defaults**
8. **Version configuration schemas**

## Validation

Configuration is validated using Pydantic at startup. Invalid configuration will prevent the service from starting.

```python
from nlp.core.config import settings

# Automatically validated
print(settings.text_classification.model_name)
print(settings.token_classification.batch_size)
```

## Advanced Configuration

### Custom Model Paths

```bash
# Use local model instead of downloading
TEXT_CLASSIFIER_MODEL_PATH=/path/to/local/model
```

### Multiple Model Versions

Run different instances with different models:

```bash
# Instance 1
docker run -e TEXT_CLASSIFIER_MODEL_NAME=model-v1 hope-nlp

# Instance 2
docker run -e TEXT_CLASSIFIER_MODEL_NAME=model-v2 hope-nlp
```

### Performance Tuning

```bash
# GPU optimization
TEXT_CLASSIFIER_USE_GPU=true
TEXT_CLASSIFIER_FP16=true
TEXT_CLASSIFIER_BATCH_SIZE=32

# CPU optimization
TEXT_CLASSIFIER_USE_GPU=false
TEXT_CLASSIFIER_BATCH_SIZE=8
NLP_WORKERS=4
```

## Configuration Reference

See `env.example` for the complete list of configuration options with descriptions and default values.
