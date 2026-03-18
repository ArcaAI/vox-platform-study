# NLP API Reference

Complete API documentation for the HOPE NLP Service, covering REST endpoints and WebSocket communication.

## Base URL

```
Development: http://localhost:8864
Production:  Accessed via the API Gateway (NestJS)
```

All REST endpoints are prefixed with `/api/v1`. WebSocket endpoints use `/ws/v1`. Interactive documentation is available at `/docs` (Swagger UI) and `/redoc`.

Authentication is handled by the API Gateway. When integrated, include the JWT token:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:8864/api/v1/classify/text
```

---

## Health & Monitoring

### GET / — Service Information

```json
{
  "service": "Medical Entity Recognition & NLP",
  "version": "1.0.0"
}
```

### GET /api/v1/health — Health Check

Returns service health status. The current implementation returns a minimal response. The 503 status is returned if the health check itself throws an exception.

**Response `200 OK`:**

```json
{}
```

> **Note**: The health check endpoint currently returns an empty object. Model-level status checks are not yet implemented in the monitoring router.

| Status | Meaning |
|--------|---------|
| `200` | Service is running |
| `503` | Health check failed (service unhealthy) |

### GET /metrics — Prometheus Metrics

Returns Prometheus-formatted metrics for scraping. See the [README](README.md#prometheus-metrics) for the full metric list.

---

## Text Classification

### POST /api/v1/classify/text — Classify Text

Classify input text using the `michellejieli/emotion_text_classifier` transformer model. The model returns all class probabilities via `pipeline("text-classification", ...)` and the service picks the top prediction. The actual label set (emotion categories) is determined by the model's `id2label` mapping loaded at runtime from HuggingFace.

**Typical emotions from `michellejieli/emotion_text_classifier`:** sadness, joy, love, anger, fear, surprise

**Request:**

```json
{
  "text": "The patient is very happy with the treatment results",
  "language": "en"
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | Input text to classify |
| `language` | string | No | `"en"` | Language code: `en`, `ml` |

**Response `200 OK`:**

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

| Field | Type | Description |
|-------|------|-------------|
| `predicted_label` | string | Top predicted emotion category |
| `confidence` | float | Confidence score (0.0-1.0) |
| `probabilities` | object | Probability distribution across all classes (labels come from the model) |
| `model_version` | string | Model version used |

**Example with curl:**

```bash
curl -X POST http://localhost:8864/api/v1/classify/text \
  -H "Content-Type: application/json" \
  -d '{"text": "The patient is very happy with the treatment results", "language": "en"}'
```

**Example with Python:**

```python
import httpx

response = httpx.post(
    "http://localhost:8864/api/v1/classify/text",
    json={"text": "The patient is very happy with the treatment results", "language": "en"}
)
result = response.json()
print(f"{result['predicted_label']}: {result['confidence']:.0%}")
```

**Errors:**

| Status | Description |
|--------|-------------|
| `400` | Invalid input (empty text, unsupported language) |
| `503` | Text classification model not loaded |
| `500` | Classification failed |

---

## Token Classification (NER)

### POST /api/v1/classify/tokens — Extract Medical Entities

Extract medical named entities from text using the `blaze999/Medical-NER` BERT model with BIO tagging. The pipeline returns raw BIO-prefixed entity labels (e.g., `B-SIGN_SYMPTOM`, `I-DISEASE_DISORDER`).

**Entity types from `blaze999/Medical-NER`** (BIO-tagged, e.g., `B-` prefix for beginning, `I-` for inside):
`SIGN_SYMPTOM`, `DISEASE_DISORDER`, `BIOLOGICAL_STRUCTURE`, `CLINICAL_EVENT`, `SEVERITY`, `DURATION`, `FREQUENCY`, `QUALITATIVE_CONCEPT`, `MEDICATION`, `THERAPEUTIC_PROCEDURE`, `DIAGNOSTIC_PROCEDURE`, `LAB_VALUE`, `DETAILED_DESCRIPTION`, and others as defined by the model's label mapping

**Request:**

```json
{
  "text": "Patient has diabetes and hypertension with chest pain",
  "aggregation_strategy": "simple",
  "language": "en"
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | Input text for entity extraction |
| `aggregation_strategy` | string | No | `"simple"` | Entity aggregation: `simple`, `first`, `max`, `average` |
| `language` | string | No | `"en"` | Language code: `en`, `ml` |

**Response `200 OK`:**

```json
{
  "entities": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "text": "diabetes",
      "normalized_text": "diabetes",
      "entity_type": "B-DISEASE_DISORDER",
      "confidence": 0.95,
      "position": {
        "start": 12,
        "end": 20
      },
      "created_at": "2026-02-19T10:00:00Z",
      "model_version": "1.0.0"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "text": "hypertension",
      "normalized_text": "hypertension",
      "entity_type": "B-DISEASE_DISORDER",
      "confidence": 0.93,
      "position": {
        "start": 25,
        "end": 37
      },
      "created_at": "2026-02-19T10:00:00Z",
      "model_version": "1.0.0"
    },
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "text": "chest pain",
      "normalized_text": "chest pain",
      "entity_type": "B-SIGN_SYMPTOM",
      "confidence": 0.89,
      "position": {
        "start": 43,
        "end": 53
      },
      "created_at": "2026-02-19T10:00:00Z",
      "model_version": "1.0.0"
    }
  ],
  "model_version": "1.0.0"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `entities` | array | Extracted entities |
| `entities[].id` | string | Unique entity UUID |
| `entities[].text` | string | Original entity text span |
| `entities[].normalized_text` | string | Normalized text (lowercase, trimmed) |
| `entities[].entity_type` | string | Entity type classification |
| `entities[].confidence` | float | Confidence score (0.0-1.0) |
| `entities[].position.start` | integer | Start character index |
| `entities[].position.end` | integer | End character index |
| `entities[].created_at` | string (ISO 8601) | Entity creation timestamp (UTC) |
| `entities[].model_version` | string | Model version |
| `model_version` | string | Pipeline model version |

**Example with curl:**

```bash
curl -X POST http://localhost:8864/api/v1/classify/tokens \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient has diabetes and hypertension with chest pain", "aggregation_strategy": "simple"}'
```

**Example with Python:**

```python
import httpx

response = httpx.post(
    "http://localhost:8864/api/v1/classify/tokens",
    json={
        "text": "Patient has diabetes and hypertension with chest pain",
        "aggregation_strategy": "simple",
        "language": "en"
    }
)
for entity in response.json()["entities"]:
    print(f"{entity['text']}: {entity['entity_type']} ({entity['confidence']:.0%})")
```

**Errors:**

| Status | Description |
|--------|-------------|
| `400` | Invalid input |
| `503` | Token classification model not loaded |
| `500` | Entity extraction failed |

---

## Medical Diagnosis Suggestion

### POST /api/v1/diagnosis/suggestions — Suggest Medical Conditions

Analyze symptom descriptions and suggest possible medical conditions using the `shanover/symps_disease_bert_v3_c41` model (41 disease classes). The service first extracts medical entities via the token classifier, filters relevant symptoms, then predicts diseases using the diagnosis model with a hardcoded label mapping.

> **Disclaimer**: This is an AI-based suggestion tool and must not be used as a substitute for professional medical diagnosis.

**41 Disease Classes:**
Vertigo (Paroxysmal Positional Vertigo), AIDS, Acne, Alcoholic hepatitis, Allergy, Arthritis, Bronchial Asthma, Cervical spondylosis, Chicken pox, Chronic cholestasis, Common Cold, Dengue, Diabetes, Dimorphic hemorrhoids (piles), Drug Reaction, Fungal infection, GERD, Gastroenteritis, Heart attack, Hepatitis B, Hepatitis C, Hepatitis D, Hepatitis E, Hypertension, Hyperthyroidism, Hypoglycemia, Hypothyroidism, Impetigo, Jaundice, Malaria, Migraine, Osteoarthritis, Paralysis (brain hemorrhage), Peptic ulcer disease, Pneumonia, Psoriasis, Tuberculosis, Typhoid, Urinary tract infection, Varicose veins, Hepatitis A

**Request:**

```json
{
  "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
  "min_confidence": 0.1,
  "language": "en"
}
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | Symptom description or patient conversation |
| `min_confidence` | float | No | `0.1` | Minimum confidence threshold (0.0-1.0) |
| `language` | string | No | `"en"` | Language code: `en`, `ml` |

**Response `200 OK`:**

```json
{
  "suggestions": [
    {
      "disease": "Pneumonia",
      "confidence": 0.78
    },
    {
      "disease": "Bronchial Asthma",
      "confidence": 0.65
    },
    {
      "disease": "Tuberculosis",
      "confidence": 0.52
    },
    {
      "disease": "Common Cold",
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

| Field | Type | Description |
|-------|------|-------------|
| `suggestions` | array | Disease suggestions ranked by confidence |
| `suggestions[].disease` | string | Disease/condition name (from the 41-class label mapping) |
| `suggestions[].confidence` | float | Confidence score (0.0-1.0, default `0.1`) |
| `symptoms_analyzed` | array | Relevant entities extracted by the token classifier |
| `model_version` | string | Model version used |

**Example with curl:**

```bash
curl -X POST http://localhost:8864/api/v1/diagnosis/suggestions \
  -H "Content-Type: application/json" \
  -d '{"text": "Patient complains of fever, cough, and difficulty breathing", "min_confidence": 0.1}'
```

**Example with Python:**

```python
import httpx

response = httpx.post(
    "http://localhost:8864/api/v1/diagnosis/suggestions",
    json={
        "text": "Patient complains of fever, cough, and difficulty breathing for 3 days",
        "min_confidence": 0.1
    }
)
result = response.json()
for s in result["suggestions"]:
    print(f"  {s['disease']}: {s['confidence']:.0%}")
```

**Errors:**

| Status | Description |
|--------|-------------|
| `400` | Invalid input |
| `503` | Medical suggester model not loaded |
| `500` | Diagnosis suggestion failed |

---

## Text Correction

### POST /api/v1/correct/text — Correct Spelling and Terminology

Correct spelling errors and standardize medical terminology using SymSpellPy with medical dictionaries. Supports English and Malayalam.

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

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `"spelling"` | Correction type: `spelling`, `grammar`, `all` |
| `text` | string | Yes | — | Text to correct |
| `language` | string | No | `"en"` | Language code: `en`, `ml` |
| `min_confidence` | float | No | `0.7` | Minimum confidence for corrections (0.0-1.0) |
| `include_alternatives` | boolean | No | `true` | Include alternative correction suggestions |

**Response `200 OK`:**

The `corrected_text` is the top SymSpell suggestion. For multi-word input, `lookup_compound` is used; for single words, `lookup` with `Verbosity.TOP` is used. The `alternatives` field contains additional suggestion terms (from index 1 onward), not formatted corrections.

```json
{
  "original_text": "paracetmol for fver and headach",
  "corrected_text": "paracetamol for fever and headache",
  "language": "en",
  "alternatives": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `original_text` | string | Original input text |
| `corrected_text` | string | Top SymSpell suggestion (best correction) |
| `language` | string (enum) | Language used: `en` or `ml` |
| `alternatives` | array of strings | Additional SymSpell suggestion terms (beyond the top result); may be empty |

**Example with curl:**

```bash
curl -X POST http://localhost:8864/api/v1/correct/text \
  -H "Content-Type: application/json" \
  -d '{"text": "paracetmol for fver", "language": "en"}'
```

**Example with Python:**

```python
import httpx

response = httpx.post(
    "http://localhost:8864/api/v1/correct/text",
    json={
        "type": "spelling",
        "text": "paracetmol for fver and headach",
        "language": "en"
    }
)
result = response.json()
print(f"Corrected: {result['corrected_text']}")
if result["alternatives"]:
    for alt in result["alternatives"]:
        print(f"  Alternative: {alt}")
```

**Errors:**

| Status | Description |
|--------|-------------|
| `400` | Invalid input |
| `500` | Correction failed |

---

## WebSocket API

Both WebSocket endpoints are managed by a shared `WebSocketManager` that handles session lifecycle, heartbeats, and cleanup.

### WS /ws/v1/classify/text/{session_id} — Real-Time Text Classification

Establish a WebSocket connection for streaming text classification.

**Connection URL:**

```
ws://localhost:8864/ws/v1/classify/text/{session_id}
```

### WS /ws/v1/classify/token/{session_id} — Real-Time Token Classification (NER)

Establish a WebSocket connection for streaming medical entity extraction.

**Connection URL:**

```
ws://localhost:8864/ws/v1/classify/token/{session_id}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `session_id` | string | Unique session identifier |

**Incoming message (client to server):**

Raw JSON matching the corresponding request schema. For text classification:

```json
{
  "text": "Patient is experiencing severe anxiety",
  "language": "en"
}
```

For token classification:

```json
{
  "text": "Patient has diabetes and hypertension",
  "aggregation_strategy": "simple",
  "language": "en"
}
```

**Outgoing message (server to client):**

Responses are wrapped in a `WebSocketMessage` envelope:

```json
{
  "type": "message",
  "session_id": "session-123",
  "data": {
    "predicted_label": "fear",
    "confidence": 0.88,
    "probabilities": {
      "fear": 0.88,
      "sadness": 0.08,
      "anger": 0.03
    },
    "model_version": "1.0.0"
  }
}
```

**WebSocket message types** (`type` field):

| Type | Description |
|------|-------------|
| `connect` | Connection established |
| `disconnect` | Connection closed |
| `message` | Normal result payload |
| `error` | Error response with `error_code` and `error_message` in `data` |
| `heartbeat` | Periodic keepalive with `is_active` in `data` |
| `status` | Status update |

**Example with JavaScript:**

```javascript
const ws = new WebSocket("ws://localhost:8864/ws/v1/classify/text/session-123");

ws.onopen = () => {
  ws.send(JSON.stringify({
    text: "Patient is experiencing severe anxiety",
    language: "en"
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "message") {
    const result = msg.data;
    console.log(`${result.predicted_label}: ${(result.confidence * 100).toFixed(0)}%`);
  } else if (msg.type === "heartbeat") {
    console.log("Heartbeat received");
  } else if (msg.type === "error") {
    console.error(`Error: ${msg.data.error_message}`);
  }
};
```

**Example with Python:**

```python
import asyncio
import json
import websockets

async def classify():
    async with websockets.connect("ws://localhost:8864/ws/v1/classify/text/session-123") as ws:
        await ws.send(json.dumps({
            "text": "Patient is experiencing severe anxiety",
            "language": "en"
        }))
        msg = json.loads(await ws.recv())
        if msg["type"] == "message":
            result = msg["data"]
            print(f"{result['predicted_label']}: {result['confidence']:.0%}")

asyncio.run(classify())
```

**Connection lifecycle:**

1. Client opens WebSocket connection with a unique `session_id`
2. Server accepts and registers the session in `WebSocketManager`
3. Client sends JSON requests (parsed and passed to the service's `process()` method)
4. Server responds with `WebSocketMessage` envelope containing the result in `data`
5. If no message received within 60s, server sends a heartbeat
6. Inactive sessions (no heartbeat for 120s) are automatically cleaned up
7. Either side can close the connection

**Features:**

- Bidirectional JSON communication via `WebSocketMessage` envelope
- Multiple requests per connection
- Session-based tracking
- Automatic heartbeat (every 30s) and inactive session cleanup (every 60s)
- Error responses with structured `error_code` and `error_message`

---

## Error Response Format

All REST error responses follow a consistent structure:

```json
{
  "error": "Error message describing the issue",
  "status_code": 400
}
```

Pydantic validation errors (422):

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

### Common Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Invalid input data or validation error |
| `404` | Endpoint not found |
| `422` | Pydantic validation error (missing/invalid fields) |
| `500` | Unexpected server error |
| `503` | Model not loaded or service unavailable |

---

## Rate Limiting

Rate limiting is handled at the API Gateway level:

| Scope | Limit |
|-------|-------|
| Per user | 100 requests/minute |
| Per IP | 1000 requests/minute |

Rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
```

---

## Performance Characteristics

| Capability | Typical Latency (CPU) | Typical Latency (GPU) |
|-----------|----------------------|----------------------|
| Text Classification | 100-200ms | 30-60ms |
| Token Classification (NER) | 200-300ms | 50-100ms |
| Medical Diagnosis | 150-250ms | 40-80ms |
| Text Correction | 50-100ms | 50-100ms (CPU-only) |
| WebSocket Classification | ~100-200ms | ~50-100ms |
