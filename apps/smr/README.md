# HOPE Summarization Service (SMR)

**Version:** 1.0.0
**Service Name:** `hope-smr`
**Port:** 5006

A FastAPI-based medical conversation summarization service with LLM integration supporting both Azure OpenAI and Ollama providers, featuring dual processing modes, structured outputs, and enterprise observability.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Monitoring & Observability](#monitoring--observability)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)

---

## Overview

The **HOPE Summarization Service (SMR)** is a microservice within the HOPE (Healthcare Optimized Patient Experience) platform that generates structured medical summaries from doctor-patient conversations. It processes conversation transcripts and produces comprehensive clinical documentation following medical best practices.

### What It Does

- **Medical Conversation Summarization**: Converts conversation transcripts into structured medical summaries
- **Multi-Provider LLM Support**: Works with Azure OpenAI (GPT-4) and Ollama (open-source models)
- **Dual Processing Modes**: Synchronous (immediate) and asynchronous (background) processing
- **Structured Outputs**: JSON-formatted summaries with schema validation
- **Specialty-Specific Prompts**: Customized for different medical specialties (Cardiology, Neurology, Surgery, etc.)
- **Enterprise Observability**: Comprehensive logging, metrics, and distributed tracing

### Why It Matters

- **Time Savings**: Automates clinical documentation, freeing up clinician time
- **Consistency**: Ensures standardized, comprehensive medical documentation
- **Accuracy**: Uses specialized medical prompts with validation
- **Compliance**: Supports HIPAA-compliant medical record keeping
- **Scalability**: Handles high volumes with async processing and job queuing

---

## Key Features

### 🏥 Medical Conversation Summarization

- **Specialized Medical Prompts**: Department and specialty-specific templates
- **Structured JSON Outputs**: Schema-validated medical summaries
- **Multi-strategy JSON Generation**: Intelligent parsing with fallback strategies
- **Enhanced Format**: Comprehensive clinical documentation with nested structures
- **Simple Format**: Backward-compatible flat structure

### 🤖 Multiple LLM Providers

| Provider | Success Rate | Features |
|----------|--------------|----------|
| **Azure OpenAI** | 99.9% | Strict schema, guaranteed JSON, GPT-4 support |
| **Ollama** | 80-95% | Open-source models, multi-strategy parsing, JSON repair |

### 🔄 Dual Processing Modes

1. **Synchronous Processing** (`POST /api/v1/summary/sync`)
   - Immediate results via HTTP
   - Real-time response
   - Best for interactive applications

2. **Asynchronous Processing** (`POST /api/v1/summary/async`)
   - Background job processing with Celery
   - Progress tracking via WebSocket/SSE
   - Best for batch operations

### 📊 Enterprise Observability

- **Structured JSON Logging** with correlation IDs
- **Prometheus Metrics** (summaries, latency, errors, resources)
- **OpenTelemetry Tracing** for distributed systems
- **Multi-level Health Checks** (basic, detailed, readiness, liveness)
- **Resource Monitoring** with configurable alerts
- **Security Headers** and CORS configuration

### 🎛️ Department-Specific Templates

Pre-configured templates for:
- Breast Endocrine (New Referral, Follow-up)
- Hematology (New Referral, Revisit)
- Medicine (New Referral, Follow-up)
- Neurology (New Referral, Follow-up)
- Orthopedics (New Referral, Review)
- Rheumatology (New Referral, Follow-up)
- Surgery (New Referral, Follow-up)

---

## Technology Stack

### Core Technologies

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| **Framework** | FastAPI | 0.104.0+ | High-performance async API |
| **Language** | Python | 3.11+ | Service implementation |
| **Package Manager** | pip/uv | Latest | Dependency management |
| **Database** | PostgreSQL | 17 | Medical summary persistence |
| **ORM** | SQLAlchemy | 2.0.0+ | Async database operations |
| **Migrations** | Alembic | 1.13.0+ | Database schema versioning |
| **Cache/Queue** | Redis | 8 | Job queue and caching |
| **Task Queue** | Celery | 5.3.0+ | Background job processing |

### LLM Integration

| Provider | SDK | Models | Features |
|----------|-----|--------|----------|
| Azure OpenAI | `openai>=1.10.0` | GPT-4, GPT-4 Turbo | Structured outputs, guaranteed JSON |
| Ollama | `ollama>=0.2.0` | Llama 2, Gemma, Custom | Local models, privacy-focused |

### Observability Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Logging** | structlog, python-json-logger | Structured JSON logging |
| **Metrics** | Prometheus, prometheus-client | System and business metrics |
| **Tracing** | OpenTelemetry | Distributed request tracing |
| **Monitoring** | psutil | Resource usage tracking |

### Development Tools

- **Testing**: pytest, pytest-asyncio, pytest-cov
- **Code Quality**: black, ruff, mypy
- **Documentation**: mkdocs, mkdocs-material (optional)

---

## Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      FastAPI Application                     │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   API       │  │  WebSocket   │  │   Server-Sent    │   │
│  │  Routes     │  │   Handlers   │  │     Events       │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼────────┐            ┌─────────▼────────┐
│  Summary       │            │   Job Service    │
│  Service       │            │                  │
│ • Text         │            │ • Async Jobs     │
│   Chunking     │            │ • Progress       │
│ • JSON Parsing │            │ • Notifications  │
│ • Validation   │            └─────────┬────────┘
└───────┬────────┘                      │
        │                               │
        │                      ┌────────▼─────────┐
┌───────▼────────┐            │     Redis        │
│  LLM Services  │            │                  │
│                │            │ • Job Queue      │
│ • Azure OpenAI │            │ • Pub/Sub        │
│ • Ollama       │            │ • Job Storage    │
└───────┬────────┘            └──────────────────┘
        │
        │
┌───────▼────────┐
│   PostgreSQL   │
│                │
│ • Summaries    │
│ • Job History  │
│ • Audit Logs   │
└────────────────┘
```

### Project Structure

```
apps/smr/
├── src/smr/                          # Source code
│   ├── api/                          # API layer
│   │   ├── routes.py                 # HTTP endpoints
│   │   ├── websockets.py             # WebSocket handlers
│   │   ├── sse.py                    # Server-Sent Events
│   │   └── middleware.py             # Custom middleware
│   ├── core/                         # Core configuration
│   │   ├── config.py                 # Settings management
│   │   ├── dependencies.py           # Dependency injection
│   │   └── logging_config.py         # Logging setup
│   ├── models/                       # Data models
│   │   ├── config.py                 # Configuration models
│   │   ├── requests.py               # API request models
│   │   ├── responses.py              # API response models
│   │   ├── jobs.py                   # Job models
│   │   ├── llm.py                    # LLM models
│   │   ├── medical_summary.py        # Medical summary models
│   │   ├── prompts*.py               # Department-specific prompts
│   │   └── sql_*.py                  # Database models
│   ├── services/                     # Business logic
│   │   ├── llm_service.py            # Abstract LLM interface
│   │   ├── azure_openai_service.py   # Azure OpenAI implementation
│   │   ├── ollama_service.py         # Ollama implementation
│   │   ├── summary_service.py        # Main summarization logic
│   │   ├── job_service.py            # Async job management
│   │   └── previous_visit_service.py # Pre-summary generation
│   ├── infrastructure/               # Infrastructure services
│   │   ├── logging_config.py         # Enhanced logging
│   │   ├── observability.py          # OpenTelemetry setup
│   │   ├── monitoring.py             # Metrics and alerts
│   │   ├── health_check.py           # Health endpoints
│   │   ├── middleware.py             # Request middleware
│   │   └── config_production.py      # Production config
│   ├── tasks/                        # Celery tasks
│   │   └── summarization_task.py     # Background tasks
│   ├── db.py                         # Database initialization
│   ├── celery_app.py                 # Celery configuration
│   └── main.py                       # Application entry point
├── tests/                            # Test suite
│   ├── unit/                         # Unit tests
│   ├── integration/                  # Integration tests
│   └── fixtures/                     # Test fixtures
├── migrations/                       # Alembic migrations
│   ├── versions/                     # Migration versions
│   └── env.py                        # Alembic environment
├── docs/                             # Service documentation
│   ├── 01-getting-started.md
│   ├── 02-api-reference.md
│   ├── 03-prompt-engineering.md
│   ├── 04-database-schema.md
│   ├── 05-observability-guide.md
│   ├── 06-environment-configuration.md
│   ├── 07-security-headers-guide.md
│   └── 08-deployment-guide.md
├── examples/                         # Example scripts
│   ├── test_sync_summary.py
│   ├── test_async_summary.py
│   └── test_websocket_client.py
├── scripts/                          # Utility scripts
│   └── setup_observability.sh
├── alembic.ini                       # Alembic configuration
├── env.example                       # Environment template
├── env.production.example            # Production template
├── pyproject.toml                    # Project metadata
├── Dockerfile                        # Container definition
├── run_dev.sh                        # Development runner
├── run_dev.py                        # Python development runner
├── run_celery_worker.py              # Celery worker runner
└── README.md                         # This file
```

---

## Quick Start

### Prerequisites

- Python 3.11 or higher
- PostgreSQL 17
- Redis 8
- Conda environment (recommended)
- Azure OpenAI account OR Ollama installation

### Installation

#### 1. Clone Repository

```bash
cd apps/smr
```

#### 2. Install Dependencies

Using `uv` (recommended):

```bash
# Install uv if not already installed
pip install uv

# Install dependencies
uv pip install -e .
```

Using `pip`:

```bash
pip install -e .
```

#### 3. Configure Environment

```bash
# Copy environment template
cp env.example .env

# Edit configuration
nano .env
```

Required environment variables:

```bash
# LLM Provider (azure_openai or ollama)
SUMMARY_AGENT_LLM_PROVIDER=azure_openai

# Azure OpenAI (if using Azure)
SMR_AZURE_API_KEY=your_api_key_here
SMR_AZURE_ENDPOINT=https://your-resource.openai.azure.com/
SMR_AZURE_DEPLOYMENT_NAME=gpt-4
SMR_AZURE_DEFAULT_MODEL=gpt-5-mini

# Ollama (if using Ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b

# Database
SUMMARY_AGENT_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope

# Redis
SUMMARY_AGENT_REDIS_URL=redis://localhost:6379

# Service Configuration
SUMMARY_AGENT_HOST=0.0.0.0
SUMMARY_AGENT_PORT=8862
SUMMARY_AGENT_LOG_LEVEL=INFO
```

#### 4. Setup Database

```bash
# Using Docker (recommended)
docker run -d \
  --name postgres-smr \
  -e POSTGRES_DB=hope \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:17

# Run migrations
alembic upgrade head
```

#### 5. Start Redis

```bash
docker run -d --name redis-smr -p 6379:6379 redis:8-alpine
```

#### 6. Run the Service

**Option 1: Using convenience script**

```bash
./run_dev.sh
```

**Option 2: Using Python runner**

```bash
python run_dev.py
```

**Option 3: Using uvicorn directly**

```bash
uvicorn smr.main:app --host 0.0.0.0 --port 8862 --reload
```

#### 7. Start Celery Worker (for async processing)

```bash
# In a separate terminal
python run_celery_worker.py
```

### Access the Service

- **API Documentation**: http://localhost:5006/docs
- **Alternative Docs**: http://localhost:5006/redoc
- **Health Check**: http://localhost:5006/api/v1/health
- **Metrics**: http://localhost:5006/metrics

---

## Configuration

### Environment Variables

#### Application Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVICE_NAME` | Service identifier | `hope-smr` |
| `SERVICE_VERSION` | Service version | `1.0.0` |
| `NODE_ENV` | Environment mode | `development` |
| `SUMMARY_AGENT_HOST` | Server host | `0.0.0.0` |
| `SUMMARY_AGENT_PORT` | Server port | `5006` |
| `SUMMARY_AGENT_DEBUG` | Debug mode | `false` |
| `SUMMARY_AGENT_LOG_LEVEL` | Logging level | `INFO` |

#### LLM Provider Configuration

##### Azure OpenAI

```bash
SUMMARY_AGENT_LLM_PROVIDER=azure_openai
SMR_AZURE_API_KEY=your_api_key
SMR_AZURE_ENDPOINT=https://your-resource.openai.azure.com/
SMR_AZURE_API_VERSION=2024-12-01-preview
SMR_AZURE_DEPLOYMENT_NAME=gpt-4
SMR_AZURE_DEFAULT_MODEL=gpt-5-mini
SMR_AZURE_TIMEOUT_S=120
SMR_AZURE_MAX_CONCURRENT=10
SMR_AZURE_TPM_LIMIT=80000
SMR_AZURE_RPM_LIMIT=480
SMR_AZURE_ADAPTIVE_LIMITS=true
SMR_AZURE_CONTENT_FILTER_SEVERITY=medium
```

##### Ollama

```bash
SUMMARY_AGENT_LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
OLLAMA_TEMPERATURE=0.1
OLLAMA_TOP_K=40
OLLAMA_TOP_P=0.9
OLLAMA_REPEAT_PENALTY=1.1
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=2048
```

#### Database Configuration

```bash
SUMMARY_AGENT_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope
SUMMARY_AGENT_DATABASE_ECHO=false
```

#### Redis Configuration

```bash
SUMMARY_AGENT_REDIS_URL=redis://localhost:6379
SUMMARY_AGENT_JOB_TIMEOUT=300
SUMMARY_AGENT_MAX_RETRIES=3
```

#### Celery Configuration

```bash
CELERY_BROKER_URL=redis://localhost:6379/0
CELERY_RESULT_BACKEND=redis://localhost:6379/0
CELERY_TASK_TRACK_STARTED=true
CELERY_WORKER_CONCURRENCY=3
```

#### Observability Configuration

```bash
# Logging
LOG_LEVEL=INFO
LOG_FILE_ENABLED=true
LOG_FILE_JSON_FORMAT=true

# OpenTelemetry
OTEL_SERVICE_NAME=hope-smr
OTEL_TRACES_ENABLED=false
OTEL_METRICS_ENABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317

# Prometheus
ENABLE_METRICS=true
METRICS_PATH=/metrics

# Resource Monitoring
RESOURCE_MONITORING_INTERVAL=30
ENABLE_BACKGROUND_MONITORING=true
ALERT_MEMORY_THRESHOLD=85
ALERT_CPU_THRESHOLD=80
```

#### Security Configuration

```bash
ENABLE_SECURITY_HEADERS=true
ENABLE_CORRELATION_TRACKING=true
CORS_ALLOW_ORIGINS=*
CORS_ALLOW_CREDENTIALS=false
```

### Configuration Files

- `env.example` - Development environment template
- `env.production.example` - Production environment template
- `alembic.ini` - Database migration configuration
- `pyproject.toml` - Python project configuration
- `Dockerfile` - Container image definition

---

## API Endpoints

### Core Endpoints

#### Synchronous Summary

**POST** `/api/v1/summary/sync`

Create a medical summary and return immediate results.

**Request Body:**

```json
{
    "session_data": {
        "session_id": "session_123",
        "created_at": "2024-01-01T10:00:00Z",
        "conversation_segments": [
            {
                "speaker": "patient",
        "text": "I've been having chest pain",
                "timestamp": "2024-01-01T10:01:00Z"
            },
            {
                "speaker": "doctor",
        "text": "Can you describe the pain?",
                "timestamp": "2024-01-01T10:01:30Z"
            }
        ],
        "patient_info": {
            "age": 45,
            "gender": "male",
            "medical_history": "hypertension"
    },
    "session_metadata": {
      "department": "Cardiology",
      "visit_type": "New Referral",
      "language": "en"
        }
  },
  "use_enhanced_format": true,
  "specialty": "cardiology",
  "encounter_type": "consultation"
}
```

**Response:**

```json
{
    "session_id": "session_123",
    "summary": {
    "chief_complaint": "Chest pain",
    "symptoms": ["chest pain", "shortness of breath"],
    "medical_history": "Hypertension",
    "examination": "Physical examination performed",
    "assessment": "Suspected angina",
    "treatment_plan": "ECG ordered, cardiology referral",
    "follow_up": "Follow-up in 1 week",
    "summary": "45-year-old male with chest pain"
    },
    "created_at": "2024-01-01T10:02:00Z",
    "processing_time_ms": 2500,
  "token_usage": {
    "prompt_tokens": 350,
    "completion_tokens": 180,
    "total_tokens": 530
  },
  "metadata": {
    "llm_provider": "azure_openai",
    "model_name": "gpt-4",
    "language": "en",
    "specialty": "cardiology"
  }
}
```

#### Asynchronous Summary

**POST** `/api/v1/summary/async`

Create a summary job for background processing.

**Response:**

```json
{
    "job_id": "job_456",
    "status": "pending",
    "created_at": "2024-01-01T10:00:00Z",
  "websocket_url": "ws://localhost:5006/api/v1/ws/jobs/job_456",
  "sse_url": "http://localhost:5006/api/v1/sse/jobs/job_456"
}
```

#### Pre-Summary Generation

**POST** `/api/v1/presummary`

Generate pre-visit summary from patient data.

**Request Body:**

```json
{
  "current_department": "Cardiology",
  "visit_type": "Follow-up",
  "age": 45,
  "gender": "male",
  "formatted_vitals": "BP: 140/90, HR: 85",
  "formatted_test_results": "Cholesterol: 220 mg/dL",
  "formatted_previous_visits": "Last visit: 2023-12-01...",
  "language": "en",
  "max_tokens": 800,
  "temperature": 0.2
}
```

### Job Management

#### Get Job Status

**GET** `/api/v1/jobs/{job_id}`

Retrieve the status of a specific job.

#### Cancel Job

**DELETE** `/api/v1/jobs/{job_id}`

Cancel a running or pending job.

#### List Jobs

**GET** `/api/v1/jobs?session_id={session_id}&status={status}&limit={limit}`

List jobs with optional filtering.

### Health & Monitoring

#### Basic Health Check

**GET** `/api/v1/health`

Quick application health status.

#### Detailed Health Check

**GET** `/api/v1/health?detailed=true`

Comprehensive health check including dependencies.

#### Kubernetes Readiness

**GET** `/readiness`

Readiness probe for Kubernetes.

#### Kubernetes Liveness

**GET** `/liveness`

Liveness probe for Kubernetes.

#### Prometheus Metrics

**GET** `/metrics`

Prometheus-formatted metrics endpoint.

### Real-time Communication

#### WebSocket Connection

**WS** `/api/v1/ws/jobs/{job_id}`

WebSocket endpoint for real-time job updates.

#### Server-Sent Events

**GET** `/api/v1/sse/jobs/{job_id}`

SSE endpoint for job progress streaming.

---

## Development

### Development Setup

1. **Activate Conda Environment** (if using)

```bash
conda activate hope-smr
```

2. **Install Development Dependencies**

```bash
pip install -e ".[dev]"
```

3. **Start Development Services**

```bash
# PostgreSQL
docker-compose up -d postgres

# Redis
docker-compose up -d redis

# Ollama (if using)
docker-compose up -d ollama
```

4. **Run Development Server**

```bash
./run_dev.sh
```

### Code Quality

#### Linting

```bash
# Run ruff
ruff check src/

# Auto-fix issues
ruff check --fix src/
```

#### Formatting

```bash
# Format with black
black src/ tests/

# Check formatting
black --check src/ tests/
```

#### Type Checking

```bash
# Run mypy
mypy src/
```

#### Pre-commit Hooks

```bash
# Install pre-commit hooks
pre-commit install

# Run manually
pre-commit run --all-files
```

### Database Management

#### Create Migration

```bash
# Auto-generate migration
alembic revision --autogenerate -m "Add summary table"

# Create empty migration
alembic revision -m "Custom migration"
```

#### Apply Migrations

```bash
# Upgrade to latest
alembic upgrade head

# Upgrade one version
alembic upgrade +1

# Downgrade one version
alembic downgrade -1

# View current version
alembic current

# View migration history
alembic history
```

#### Reset Database

```bash
# Downgrade all
alembic downgrade base

# Upgrade to latest
alembic upgrade head
```

---

## Testing

### Test Structure

```
tests/
├── unit/                           # Unit tests
│   ├── test_services.py            # Service layer tests
│   ├── test_models.py              # Model validation tests
│   ├── test_prompts.py             # Prompt template tests
│   └── test_core.py                # Core functionality tests
├── integration/                    # Integration tests
│   └── test_api_integration.py     # Full API flow tests
├── fixtures/                       # Shared test fixtures
│   └── sample_data.py              # Sample data generators
└── conftest.py                     # Pytest configuration
```

### Running Tests

```bash
# Run all tests
pytest

# Run specific test file
pytest tests/unit/test_services.py

# Run specific test
pytest tests/unit/test_services.py::test_summary_creation

# Run with coverage
pytest --cov=src/smr --cov-report=html

# Run with verbose output
pytest -v

# Run parallel tests
pytest -n auto

# Run only failed tests
pytest --lf

# Run with debugging
pytest --pdb
```

### Test Coverage

```bash
# Generate coverage report
pytest --cov=src/smr --cov-report=html

# View HTML report
open htmlcov/index.html
```

### Integration Testing

```bash
# Start test dependencies
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
pytest tests/integration/

# Cleanup
docker-compose -f docker-compose.test.yml down
```

---

## Deployment

### Docker Deployment

#### Build Image

```bash
# Build for development
docker build -t hope-smr:latest .

# Build for production
docker build -t hope-smr:1.0.0 -f Dockerfile.prod .
```

#### Run Container

```bash
docker run -d \
  --name hope-smr \
  -p 5006:5006 \
  --env-file .env.production \
  hope-smr:latest
```

### Docker Compose Deployment

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes Deployment

See [08-deployment-guide.md](docs/08-deployment-guide.md) for detailed Kubernetes deployment instructions.

### Production Checklist

- [ ] Update `.env.production` with production values
- [ ] Set `NODE_ENV=production`
- [ ] Configure proper database credentials
- [ ] Set up Redis cluster for high availability
- [ ] Enable observability (metrics, tracing, logging)
- [ ] Configure resource limits and autoscaling
- [ ] Set up health check monitoring
- [ ] Enable security headers
- [ ] Configure CORS appropriately
- [ ] Set up backup and disaster recovery
- [ ] Review and apply rate limiting
- [ ] Configure log aggregation
- [ ] Set up alerting and on-call
- [ ] Perform load testing
- [ ] Review security vulnerabilities
- [ ] Document runbook procedures

---

## Monitoring & Observability

### Key Metrics

#### System Metrics

- `smr_cpu_usage_percent` - CPU utilization
- `smr_memory_usage_bytes` - Memory consumption
- `smr_active_sessions_total` - Active processing sessions

#### Application Metrics

- `smr_summaries_created_total` - Total summaries generated
- `smr_summary_duration_seconds` - Summary generation latency
- `smr_llm_requests_total` - LLM API requests
- `smr_llm_tokens_total` - Token usage (input/output)
- `smr_errors_total` - Error counts by type

#### Job Metrics

- `smr_jobs_created_total` - Total jobs created
- `smr_job_duration_seconds` - Job processing time
- `smr_websocket_connections_total` - Active WebSocket connections

### Logging

Structured JSON logging with correlation tracking:

```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "INFO",
  "logger": "smr.services.summary_service",
  "message": "Summary generation completed",
  "correlation_id": "req-123e4567",
  "session_id": "session_123",
  "provider": "azure_openai",
  "duration_seconds": 2.3,
  "word_count": 156
}
```

### Health Checks

- **Basic Health**: `/api/v1/health` - Application status
- **Detailed Health**: `/api/v1/health?detailed=true` - Full dependency checks
- **Readiness**: `/readiness` - Ready to serve traffic
- **Liveness**: `/liveness` - Application alive status

### Tracing

OpenTelemetry distributed tracing with automatic instrumentation for:
- HTTP requests
- Database queries
- LLM API calls
- Background jobs

### Alerting

Monitored conditions:
- High CPU usage (>80%)
- High memory usage (>85%)
- High error rate (>10%)
- Slow response times (P95 >5s)
- LLM service unavailable

For detailed observability documentation, see [05-observability-guide.md](docs/05-observability-guide.md).

---

## Troubleshooting

### Common Issues

#### 1. LLM Connection Errors

**Symptom**: "Failed to connect to LLM service"

**Solution:**

```bash
# For Azure OpenAI
# 1. Verify API key and endpoint
curl -X POST "${SMR_AZURE_ENDPOINT}/openai/deployments/${SMR_AZURE_DEPLOYMENT_NAME}/chat/completions?api-version=${SMR_AZURE_API_VERSION}" \
  -H "api-key: ${SMR_AZURE_API_KEY}" \
  -H "Content-Type: application/json"

# For Ollama
# 1. Verify Ollama is running
curl http://localhost:11434/api/tags

# 2. Pull required model
ollama pull gemma3:1b
```

#### 2. Database Connection Errors

**Symptom**: "Cannot connect to database"

**Solution:**

```bash
# Check PostgreSQL is running
docker ps | grep postgres

# Test connection
psql postgresql://postgres:postgres@localhost:5432/hope

# Verify database exists
psql -U postgres -c "\l"
```

#### 3. Redis Connection Errors

**Symptom**: "Redis connection refused"

**Solution:**

```bash
# Check Redis is running
docker ps | grep redis

# Test Redis connection
redis-cli -h localhost -p 6379 ping

# Clear Redis data if needed
redis-cli FLUSHALL
```

#### 4. Migration Errors

**Symptom**: "Alembic migration failed"

**Solution:**

```bash
# Check current migration status
alembic current

# View migration history
alembic history

# Force downgrade and reapply
alembic downgrade -1
alembic upgrade head
```

#### 5. JSON Parsing Errors (Ollama)

**Symptom**: "Unable to parse JSON response"

**Solution:**

1. Lower temperature: `OLLAMA_TEMPERATURE=0.1`
2. Enable JSON repair in logs
3. Use multi-strategy parsing
4. Check model compatibility
5. Consider switching to Azure OpenAI

#### 6. High Memory Usage

**Symptom**: Service using excessive memory

**Solution:**

```bash
# Check memory usage
docker stats hope-smr

# Review batch sizes
# Reduce concurrent workers
# Enable resource monitoring
```

### Debug Mode

Enable debug mode for detailed logging:

```bash
# In .env
SUMMARY_AGENT_DEBUG=true
SUMMARY_AGENT_LOG_LEVEL=DEBUG

# Restart service
./run_dev.sh
```

### Log Analysis

```bash
# View real-time logs
tail -f logs/smr.log | jq .

# Find errors
jq 'select(.level == "ERROR")' logs/smr.log

# Track specific session
jq 'select(.session_id == "session_123")' logs/smr.log

# Performance analysis
jq 'select(.message | contains("completed")) | {timestamp, duration: .duration_seconds}' logs/smr.log
```

---

## Documentation

### Service Documentation

- [01-getting-started.md](docs/01-getting-started.md) - Setup and installation guide
- [02-api-reference.md](docs/02-api-reference.md) - Complete API documentation
- [03-prompt-engineering.md](docs/03-prompt-engineering.md) - Prompt design and customization
- [04-database-schema.md](docs/04-database-schema.md) - Database structure and models
- [05-observability-guide.md](docs/05-observability-guide.md) - Monitoring and logging
- [06-environment-configuration.md](docs/06-environment-configuration.md) - Configuration guide
- [07-security-headers-guide.md](docs/07-security-headers-guide.md) - Security configuration
- [08-deployment-guide.md](docs/08-deployment-guide.md) - Production deployment

### Project Documentation

- [Technical Architecture](../../docs/technical-architecture-overview.md)
- [Backend Architecture](../../docs/backend-architecture.md)
- [Tech Stack](../../docs/tech-stack.md)
- [Project Structure](../../docs/project-structure.md)

### External Documentation

- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Pydantic Documentation](https://docs.pydantic.dev/)
- [SQLAlchemy Documentation](https://docs.sqlalchemy.org/)
- [Alembic Documentation](https://alembic.sqlalchemy.org/)
- [Celery Documentation](https://docs.celeryproject.org/)
- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Prometheus Documentation](https://prometheus.io/docs/)

---

## Contributing

### Development Workflow

1. Create feature branch from `main`
2. Make changes following code standards
3. Write/update tests
4. Run test suite
5. Update documentation
6. Submit pull request

### Code Standards

- Follow PEP 8 style guide
- Use type hints for all functions
- Write docstrings (Google style)
- Maintain test coverage >80%
- Format code with `black`
- Lint code with `ruff`
- Type check with `mypy`

### Commit Messages

Follow conventional commits format:

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:

```
feat(api): add pre-summary generation endpoint
fix(llm): handle JSON parsing errors gracefully
docs(readme): update installation instructions
```

---

## License

Copyright © 2024 HOPE Project

This software is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.

---

## Support

For issues, questions, or contributions:

- **Issues**: [GitHub Issues](https://github.com/arcaai/hope/issues)
- **Documentation**: [Project Wiki](https://github.com/arcaai/hope/wiki)
- **Email**: support@hope-platform.com

---

## Acknowledgments

- **HOPE Platform Team** - Core development
- **Azure OpenAI** - LLM infrastructure
- **Ollama** - Open-source model support
- **FastAPI Community** - Framework development
- **OpenTelemetry** - Observability standards

---

**Version**: 1.0.0
**Last Updated**: 2024-01-10
**Maintained by**: HOPE Platform Team
