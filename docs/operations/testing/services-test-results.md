# Project HOPE - Live Cluster Verification Results

**Cluster Node:** `192.168.112.6`  
**Test Timestamp:** `2026-10-10T08:28:30Z`  
**Execution Mode:** Live end-to-end testing via API Gateway (`hope-api-gateway` NodePort `32458`)  

---

## 📊 Live Verification Status Summary (Via API Gateway)

| # | Service Component | Gateway Downstream Probe | State | Latency | Status Details |
|---|---|:---:|:---:|:---:|---|
| 1 | **API Gateway (`api`)** | `/api/v1/health` | ✅ **HEALTHY** | 0 ms | Version: 0.1.0, Uptime healthy |
| 2 | **Medical NLP (`nlp`)** | Gateway ➔ `hope-nlp-svc:8864` | ✅ **HEALTHY** | 7 ms | Fully connected, Uptime: 8036s |
| 3 | **Speech-to-Text (`stt`)** | Gateway ➔ `hope-stt-svc:8860` | ✅ **HEALTHY** | 7 ms | Fully connected, Uptime: 212233s |
| 4 | **Text-to-Speech (`tts`)** | Gateway ➔ `hope-tts-svc:8865` | ✅ **HEALTHY** | 8 ms | Fully connected, Uptime: 5173s |
| 5 | **Harness (`harness`)** | Gateway ➔ `hope-harness-svc:8866` | ✅ **HEALTHY** | 7 ms | Fully connected, Uptime: 9589s |
| 6 | **LLM Service (`text`)** | Gateway ➔ `hope-text-svc:8862` | 🟡 **DEGRADED** | 1436 ms | Cloud engines & Redis connected, GPU stubs idle |
| 7 | **Harness Worker** | Temporal UI `31888` | ✅ **CONNECTED** | N/A | Poller connected on `harness-task-queue` |

---

## 🔍 Exact Live Outputs Captured from Cluster

### 1. API Gateway Downstream Health Report (`GET /api/v1/admin/health/services`)
```json
{
  "status": "degraded",
  "timestamp": "2026-10-10T08:28:22.854Z",
  "services": {
    "nlp": {
      "status": "healthy",
      "service": "Medical NLP",
      "uptime_seconds": 8036.4,
      "duration_ms": 7
    },
    "tts": {
      "status": "healthy",
      "service": "Text to Speech",
      "uptime_seconds": 5173,
      "duration_ms": 8
    },
    "stt": {
      "status": "healthy",
      "service": "Speech to Text",
      "uptime_seconds": 212233,
      "duration_ms": 7
    },
    "harness": {
      "status": "healthy",
      "service": "Clinical Documentation Harness",
      "uptime_seconds": 9589.6,
      "duration_ms": 7
    },
    "text": {
      "status": "degraded",
      "service": "Text",
      "uptime_seconds": 6465.4,
      "duration_ms": 1436
    }
  }
}
```

---

### 2. End-to-End Medical NER Inference Through API Gateway (`POST /api/v1/text-analyses/entities`)

#### Request:
```bash
# Log in to get Bearer JWT:
LOGIN_RESP=$(curl -s -X POST "http://192.168.112.6:32458/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "super_admin", "password": "password123"}')
JWT_TOKEN=$(echo $LOGIN_RESP | jq -r '.token')

# Call API Gateway on NodePort 32458:
curl -s -X POST "http://192.168.112.6:32458/api/v1/text-analyses/entities" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d '{
    "text": "Patient reports severe chest pain and takes 10mg amlodipine.",
    "modelName": "medical-ner"
  }' | jq .
```

#### Exact Output (Received from API Gateway in 439 ms):
```json
{
  "entities": [
    {
      "id": "362b6782-71e6-4fe9-be22-c67320ec1823",
      "text": "severe",
      "normalized_text": "severe",
      "entity_type": "SEVERITY",
      "confidence": 0.6592645645141602,
      "position": { "start": 15, "end": 22 },
      "assertion": "PRESENT"
    },
    {
      "id": "e5551bca-1ae5-4332-9399-6f7a3b650d56",
      "text": "chest",
      "normalized_text": "chest",
      "entity_type": "DISEASE_DISORDER",
      "confidence": 0.11615584790706635,
      "position": { "start": 22, "end": 28 },
      "assertion": "PRESENT"
    },
    {
      "id": "0684ab72-3747-4bca-811a-67d03fc70044",
      "text": "pain",
      "normalized_text": "pain",
      "entity_type": "SIGN_SYMPTOM",
      "confidence": 0.13789153099060059,
      "position": { "start": 28, "end": 33 },
      "assertion": "PRESENT"
    },
    {
      "id": "1bd5412b-9c7e-4070-bd9a-d805a9763ec0",
      "text": "10mg",
      "normalized_text": "10mg",
      "entity_type": "DOSAGE",
      "confidence": 0.7115474343299866,
      "position": { "start": 43, "end": 48 },
      "assertion": "PRESENT"
    },
    {
      "id": "92ea29d6-3393-4d5b-9ca1-7953f22251a3",
      "text": "amlodipine",
      "normalized_text": "amlodipine",
      "entity_type": "MEDICATION",
      "confidence": 0.46284738183021545,
      "position": { "start": 48, "end": 59 },
      "assertion": "PRESENT"
    }
  ],
  "model_version": "1.0.0",
  "vitals": null,
  "inference_ms": 439,
  "device": "cpu"
}
```
