# Guardrail Service

AI-powered content safety and medical context validation service with Ollama integration.

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
- Ollama server with the configured guardrail model

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
# Ollama configuration
GUARDRAIL_OLLAMA_BASE_URL=http://localhost:11434
GUARDRAIL_OLLAMA_GUARDRAIL_MODEL=meta-llama/Prompt-Guard-86M
GUARDRAIL_OLLAMA_GUARDIAN_MODEL=meta-llama/Prompt-Guard-86M

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

## Architecture

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐
│   Client    │───▶│  Guardrail      │───▶│   Ollama    │
│   Service   │    │    Service      │    │   Model     │
└─────────────┘    │                 │    └─────────────┘
                   │  ┌─────────────┐│
                   │  │ Job Queue   ││
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

- **Default model**: `meta-llama/Prompt-Guard-86M`
- **Override general guardrail model**: `GUARDRAIL_OLLAMA_GUARDRAIL_MODEL`
- **Override guardian model**: `GUARDRAIL_OLLAMA_GUARDIAN_MODEL`

## License

MIT License
