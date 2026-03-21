# API Reference

Complete API documentation for the HOPE NLP Service.

## Base URL

```
Development: http://localhost:8864
Production: https://api.hope.example.com/nlp
```

## API Versioning

Current API version: `v1`

All endpoints are prefixed with `/api/v1` for REST endpoints and `/ws` for WebSocket endpoints.

## Authentication

Currently, the NLP service does not require authentication. Authentication is handled by the API Gateway.

When integrated with the API Gateway, include the JWT token:

```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8864/api/v1/classify/text
```

## REST API Endpoints

### Health & Monitoring

#### GET / - Service Information

Get basic service information.

**Request:**
```bash
curl http://localhost:8864/
```

**Response:**
```json
{
  "service": "Medical Entity Recognition & NLP",
  "version": "1.0.0"
}
```

#### GET /api/v1/health - Health Check

Check service health and model status.

**Request:**
```bash
curl http://localhost:8864/api/v1/health
```

**Response:**
```json
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
```

**Status Codes:**
- `200 OK`: Service is healthy
- `503 Service Unavailable`: Service is unhealthy or models not loaded

#### GET /metrics - Prometheus Metrics

Get Prometheus metrics for monitoring.

**Request:**
```bash
curl http://localhost:8864/metrics
```

**Response:**
```
# HELP nlp_requests_total Total number of requests
# TYPE nlp_requests_total counter
nlp_requests_total{endpoint="/api/v1/classify/text",method="POST",status="200"} 150
...
```

### Text Classification

#### POST /api/v1/classify/text - Classify Text

Classify text into emotion categories.

**Model:** `michellejieli/emotion_text_classifier`

**Supported Emotions:**
- anger
- fear
- joy
- love
- sadness
- surprise
- neutral
- disgust
- shame
- guilt
- confusion

**Request:**
```json
{
  "text": "The patient is very happy with the treatment results",
  "language": "en"
}
```

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| text | string | Yes | - | Input text to classify |
| language | string | No | "en" | Language code (en, ml) |

**Response:**
```json
{
  "predicted_label": "joy",
  "confidence": 0.92,
  "probabilities": {
    "joy": 0.92,
    "love": 0.05,
    "surprise": 0.02,
    "neutral": 0.01
  },
  "model_version": "1.0.0"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| predicted_label | string | Top predicted emotion category |
| confidence | float | Confidence score (0.0-1.0) |
| probabilities | object | Probability distribution across all classes |
| model_version | string | Model version used for classification |

**Example with curl:**
```bash
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{
    "text": "The patient is very happy with the treatment results",
    "language": "en"
  }'
```

**Example with Python:**
```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/classify/text",
    json={
        "text": "The patient is very happy with the treatment results",
        "language": "en"
    }
)

result = response.json()
print(f"Emotion: {result['predicted_label']}")
print(f"Confidence: {result['confidence']:.2%}")
```

**Status Codes:**
- `200 OK`: Classification successful
- `400 Bad Request`: Invalid input
- `503 Service Unavailable`: Model not loaded
- `500 Internal Server Error`: Classification failed

### Token Classification (NER)

#### POST /api/v1/classify/tokens - Extract Medical Entities

Extract medical entities from text using Named Entity Recognition.

**Model:** `blaze999/Medical-NER`

**Supported Entity Types:**
- DISEASE
- SYMPTOM
- TREATMENT
- MEDICATION
- ANATOMY
- PROCEDURE
- TEST
- DOSAGE

**Request:**
```json
{
  "text": "Patient has diabetes and hypertension with chest pain",
  "aggregation_strategy": "simple",
  "language": "en"
}
```

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| text | string | Yes | - | Input text for entity extraction |
| aggregation_strategy | string | No | "simple" | Entity aggregation strategy (simple, first, max, average) |
| language | string | No | "en" | Language code (en, ml) |

**Response:**
```json
{
  "entities": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
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
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "text": "hypertension",
      "normalized_text": "hypertension",
      "entity_type": "DISEASE",
      "confidence": 0.93,
      "position": {
        "start": 25,
        "end": 37
      },
      "model_version": "1.0.0"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "text": "chest pain",
      "normalized_text": "chest pain",
      "entity_type": "SYMPTOM",
      "confidence": 0.89,
      "position": {
        "start": 43,
        "end": 53
      },
      "model_version": "1.0.0"
    }
  ],
  "model_version": "1.0.0"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| entities | array | List of extracted entities |
| entities[].id | string | Unique entity identifier (UUID) |
| entities[].text | string | Original entity text |
| entities[].normalized_text | string | Normalized entity text (lowercase, trimmed) |
| entities[].entity_type | string | Entity type classification |
| entities[].confidence | float | Confidence score (0.0-1.0) |
| entities[].position | object | Entity position in text |
| entities[].position.start | integer | Start character index |
| entities[].position.end | integer | End character index |
| model_version | string | Model version used |

**Example with curl:**
```bash
curl -X POST http://localhost:8864/api/v1/classify/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Patient has diabetes and hypertension with chest pain",
    "aggregation_strategy": "simple",
    "language": "en"
  }'
```

**Example with Python:**
```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/classify/tokens",
    json={
        "text": "Patient has diabetes and hypertension with chest pain",
        "aggregation_strategy": "simple",
        "language": "en"
    }
)

result = response.json()
for entity in result['entities']:
    print(f"{entity['text']}: {entity['entity_type']} ({entity['confidence']:.2%})")
```

**Status Codes:**
- `200 OK`: Entity extraction successful
- `400 Bad Request`: Invalid input
- `503 Service Unavailable`: Model not loaded
- `500 Internal Server Error`: Entity extraction failed

### Medical Diagnosis Suggestion

#### POST /api/v1/diagnosis/suggest - Suggest Medical Conditions

Analyze symptoms and suggest possible medical conditions.

**Model:** `shanover/symps_disease_bert_v3_c41`

**Supported Conditions:** 41 disease classes including common conditions like:
- Pneumonia
- Diabetes
- Hypertension
- Asthma
- COVID-19
- Migraine
- And more...

**Request:**
```json
{
  "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
  "min_confidence": 0.1,
  "language": "en"
}
```

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| text | string | Yes | - | Patient conversation or symptom description |
| min_confidence | float | No | 0.1 | Minimum confidence threshold (0.0-1.0) |
| language | string | No | "en" | Language code (en, ml) |

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
    },
    {
      "disease": "Influenza",
      "confidence": 0.45
    }
  ],
  "symptoms_analyzed": [
    "fever",
    "cough",
    "difficulty breathing"
  ],
  "model_version": "1.0.0"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| suggestions | array | List of disease suggestions ranked by confidence |
| suggestions[].disease | string | Disease/condition name |
| suggestions[].confidence | float | Confidence score (0.0-1.0) |
| symptoms_analyzed | array | List of symptoms identified in the text |
| model_version | string | Model version used |

**Example with curl:**
```bash
curl -X POST http://localhost:8864/api/v1/diagnosis/suggest \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
    "min_confidence": 0.1,
    "language": "en"
  }'
```

**Example with Python:**
```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/diagnosis/suggest",
    json={
        "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
        "min_confidence": 0.1,
        "language": "en"
    }
)

result = response.json()
print("Possible conditions:")
for suggestion in result['suggestions']:
    print(f"- {suggestion['disease']}: {suggestion['confidence']:.2%}")
```

**Status Codes:**
- `200 OK`: Diagnosis suggestion successful
- `400 Bad Request`: Invalid input
- `503 Service Unavailable`: Model not loaded
- `500 Internal Server Error`: Diagnosis suggestion failed

**⚠️ Medical Disclaimer:**
This is an AI-based suggestion tool and should not be used as a substitute for professional medical diagnosis. Always consult qualified healthcare professionals for medical advice.

### Text Correction

#### POST /api/v1/correct/text - Correct Spelling and Terminology

Correct spelling errors and standardize medical terminology.

**Engine:** SymSpellPy with medical dictionaries

**Supported Languages:**
- English (en)
- Malayalam (ml)

**Request:**
```json
{
  "type": "spelling",
  "text": "paracetmol for fver and headach",
  "language": "en",
  "min_confidence": 0.7,
  "include_alternatives": true
}
```

**Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| type | string | No | "spelling" | Correction type (spelling, grammar, all) |
| text | string | Yes | - | Text to correct |
| language | string | No | "en" | Language code (en, ml) |
| min_confidence | float | No | 0.7 | Minimum confidence for corrections (0.0-1.0) |
| include_alternatives | boolean | No | true | Include alternative suggestions |

**Response:**
```json
{
  "original_text": "paracetmol for fver and headach",
  "corrected_text": "paracetamol for fever and headache",
  "language": "en",
  "alternatives": [
    "paracetmol -> paracetamol",
    "fver -> fever",
    "headach -> headache"
  ]
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| original_text | string | Original input text |
| corrected_text | string | Corrected text |
| language | string | Language of the correction |
| alternatives | array | List of corrections made |

**Example with curl:**
```bash
curl -X POST http://localhost:8864/api/v1/correct/text \
  -H "Content-Type: application/json" \
  -d '{
    "type": "spelling",
    "text": "paracetmol for fver and headach",
    "language": "en",
    "min_confidence": 0.7,
    "include_alternatives": true
  }'
```

**Example with Python:**
```python
import requests

response = requests.post(
    "http://localhost:8864/api/v1/correct/text",
    json={
        "type": "spelling",
        "text": "paracetmol for fver and headach",
        "language": "en",
        "min_confidence": 0.7,
        "include_alternatives": True
    }
)

result = response.json()
print(f"Original: {result['original_text']}")
print(f"Corrected: {result['corrected_text']}")
print("Corrections:", result['alternatives'])
```

**Status Codes:**
- `200 OK`: Correction successful
- `400 Bad Request`: Invalid input
- `500 Internal Server Error`: Correction failed

## WebSocket API Endpoints

### Real-time Text Classification

#### WS /ws/classify/text/{session_id} - Streaming Text Classification

Establish a WebSocket connection for real-time text classification streaming.

**Connection URL:**
```
ws://localhost:8864/ws/classify/text/{session_id}
```

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| session_id | string | Yes | Unique session identifier |

**Incoming Message Format:**
```json
{
  "text": "Patient is experiencing severe anxiety",
  "language": "en"
}
```

**Outgoing Message Format:**
```json
{
  "predicted_label": "fear",
  "confidence": 0.88,
  "probabilities": {
    "fear": 0.88,
    "sadness": 0.08,
    "anger": 0.03,
    "other": 0.01
  },
  "model_version": "1.0.0"
}
```

**Example with JavaScript:**
```javascript
const ws = new WebSocket('ws://localhost:8864/ws/classify/text/session-123');

ws.onopen = () => {
    console.log('WebSocket connected');

    // Send classification request
    ws.send(JSON.stringify({
        text: 'Patient is experiencing severe anxiety',
        language: 'en'
    }));
};

ws.onmessage = (event) => {
    const result = JSON.parse(event.data);
    console.log('Classification:', result.predicted_label);
    console.log('Confidence:', result.confidence);
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

ws.onclose = () => {
    console.log('WebSocket closed');
};
```

**Example with Python (websockets library):**
```python
import asyncio
import websockets
import json

async def classify_stream():
    uri = "ws://localhost:8864/ws/classify/text/session-123"

    async with websockets.connect(uri) as websocket:
        # Send classification request
        await websocket.send(json.dumps({
            "text": "Patient is experiencing severe anxiety",
            "language": "en"
        }))

        # Receive result
        response = await websocket.recv()
        result = json.loads(response)

        print(f"Classification: {result['predicted_label']}")
        print(f"Confidence: {result['confidence']:.2%}")

# Run
asyncio.run(classify_stream())
```

**Connection Lifecycle:**
1. Client establishes WebSocket connection
2. Server accepts connection and registers session
3. Client sends text classification requests (JSON)
4. Server processes and sends back results (JSON)
5. Connection stays open for multiple requests
6. Client or server can close connection

**Features:**
- Bidirectional communication
- Low latency (~50-100ms)
- Multiple requests per connection
- Automatic reconnection support
- Session-based tracking

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message",
  "status_code": 400
}
```

### Common Error Status Codes

| Code | Description | Example |
|------|-------------|---------|
| 400 | Bad Request | Invalid input data, validation error |
| 404 | Not Found | Endpoint not found |
| 422 | Unprocessable Entity | Pydantic validation error |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Model not loaded or service unavailable |

### Example Error Responses

**400 Bad Request:**
```json
{
  "error": "Text field is required",
  "status_code": 400
}
```

**422 Validation Error:**
```json
{
  "detail": [
    {
      "loc": ["body", "text"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ]
}
```

**503 Service Unavailable:**
```json
{
  "error": "Text classification model not available",
  "status_code": 503
}
```

## Rate Limiting

Rate limiting is handled at the API Gateway level. Default limits:

- **Per user**: 100 requests per minute
- **Per IP**: 1000 requests per minute

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

## CORS Configuration

The service is configured with permissive CORS for development. In production, configure specific origins:

```bash
SECURITY_CORS_ORIGINS='["https://app.hope.example.com"]'
SECURITY_CORS_METHODS='["GET", "POST"]'
```

## API Versioning Strategy

- Current version: `v1`
- All endpoints prefixed with `/api/v1`
- Breaking changes will introduce new versions (v2, v3, etc.)
- Old versions maintained for 6 months after new version release

## Client SDKs

### Python SDK

```bash
pip install hope-nlp-client
```

```python
from hope_nlp_client import NLPClient

client = NLPClient(base_url="http://localhost:8864")

# Text classification
result = client.classify_text("Patient is very happy")
print(result.predicted_label, result.confidence)

# Token classification
entities = client.classify_tokens("Patient has diabetes")
for entity in entities:
    print(entity.text, entity.entity_type)
```

### TypeScript/JavaScript SDK

```bash
npm install @hope/nlp-client
```

```typescript
import { NLPClient } from '@hope/nlp-client';

const client = new NLPClient({ baseUrl: 'http://localhost:8864' });

// Text classification
const result = await client.classifyText({
  text: 'Patient is very happy',
  language: 'en'
});

console.log(result.predictedLabel, result.confidence);
```

## OpenAPI Specification

The complete OpenAPI specification is available at:

```
http://localhost:8864/docs      # Swagger UI
http://localhost:8864/redoc     # ReDoc
http://localhost:8864/openapi.json  # OpenAPI JSON
```

## Testing the API

### Using curl

```bash
# Health check
curl http://localhost:8864/api/v1/health

# Text classification
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient is happy", "language": "en"}'

# Token classification
curl -X POST http://localhost:8864/api/v1/classify/tokens \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient has diabetes", "language": "en"}'
```

### Using HTTPie

```bash
# Health check
http GET localhost:8864/api/v1/health

# Text classification
http POST localhost:8864/api/v1/classify/text \
  text="Patient is happy" \
  language=en

# Token classification
http POST localhost:8864/api/v1/classify/tokens \
  text="Patient has diabetes" \
  language=en
```

### Using Postman

1. Import the OpenAPI specification from `/openapi.json`
2. Set base URL to `http://localhost:8864`
3. Use the generated collection

## Best Practices

1. **Always validate inputs** before sending to the API
2. **Handle errors gracefully** in your application
3. **Use WebSocket for real-time** streaming
4. **Implement retry logic** for transient failures
5. **Cache results** when appropriate
6. **Monitor rate limits** to avoid throttling
7. **Use appropriate timeouts** (recommended: 30 seconds)
8. **Log correlation IDs** for debugging

## Support

For API support:
- Check the [troubleshooting guide](04-development-guide.md#troubleshooting)
- Review the [FAQ](04-development-guide.md#faq)
- Open an issue on GitHub
- Contact the development team

