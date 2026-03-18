# SMR Service — API Reference

Base URL: `http://localhost:8862/api/v1` (development) | Proxied via the API Gateway at `/api/v1/text` in production.

---

## Authentication

| Method | Header | Description |
|--------|--------|-------------|
| API Key | `X-API-Key: <key>` | Service-to-service authentication |
| JWT | `Authorization: Bearer <token>` | User authentication |
| None | — | Development mode (no auth enforced) |

All requests accept an optional `X-Correlation-ID` header for distributed tracing. If omitted, a UUID is auto-generated and returned in the response.

---

## Summary Generation

### POST /summary/sync

Generate a medical summary synchronously. The response is returned in the same HTTP request.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_data` | `SessionData` | Yes | Conversation transcript and patient context |
| `system_prompt` | string | No | Override the default system prompt |
| `user_prompt_template` | string | No | Override the default user prompt template |
| `temperature` | float | No | LLM temperature (0.0–2.0) |
| `max_tokens` | integer | No | Maximum output tokens (1–32000) |
| `context` | object | No | Additional context passed to the prompt |
| `use_enhanced_format` | boolean | No | Use enhanced nested summary format (default false) |
| `specialty` | string | No | Medical specialty (e.g. `"cardiology"`, `"surgery"`) |
| `encounter_type` | string | No | Encounter type (e.g. `"emergency"`, `"consultation"`) |
| `department` | string | No | Department name for prompt selection (e.g. `"Surgery"`, `"Rheumatology"`) |
| `visit_type` | string | No | Visit type for prompt selection (e.g. `"New Referral"`, `"Follow-up"`) |
| `include_pre_summary_in_context` | boolean | No | Include pre-summary in LLM context (default false) |
| `include_previous_visit_summary` | boolean | No | **Deprecated.** Use `pre_summary_text` with `include_pre_summary_in_context` instead (default true, ignored by service) |

**SessionData Object**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `session_id` | string | Yes | Unique session identifier |
| `created_at` | string (ISO 8601) | Yes | Session creation timestamp |
| `conversation_segments` | ConversationSegment[] | No | Conversation transcript (defaults to empty list) |
| `patient_id` | string | No | Patient identifier |
| `provider_id` | string | No | Provider identifier |
| `session_type` | string | No | Type of session |
| `patient_info` | object | No | Age, gender, medical history |
| `session_metadata` | object | No | Department, visit type, language |
| `test_results` | TestResult[] | No | Structured test results |
| `test_results_text` | string | No | Lab results or diagnostics as text |
| `previous_visits` | PreviousVisitRecord[] | No | Structured previous visit records |
| `previous_visits_text` | string | No | Formatted previous visit notes |
| `pre_summary_text` | string | No | Pre-visit summary text for context enrichment |

**ConversationSegment Object**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `speaker` | string | Yes | Speaker identifier (`"patient"`, `"provider"`, etc.) |
| `text` | string | Yes | Spoken text |
| `timestamp` | string (ISO 8601) | Yes | When the text was spoken |
| `confidence` | float | No | Transcription confidence (0.0–1.0) |
| `metadata` | object | No | Additional metadata |

**Response** `200`

```json
{
  "session_id": "sess_12345",
  "summary": {
    "chief_complaint": "Chest pain for two days",
    "symptoms": ["chest pain", "sharp pain", "pain on left side"],
    "medical_history": "Hypertension, Type 2 Diabetes",
    "examination": "Physical examination pending",
    "assessment": "Suspected cardiac chest pain",
    "treatment_plan": "ECG ordered, cardiac enzymes",
    "follow_up": "Follow-up within 24 hours",
    "summary": "55-year-old male presenting with intermittent sharp left-sided chest pain"
  },
  "created_at": "2025-01-15T10:03:00Z",
  "processing_time_ms": 2345,
  "token_usage": {
    "prompt_tokens": 425,
    "completion_tokens": 198,
    "total_tokens": 623
  },
  "confidence_score": null,
  "metadata": {
    "llm_provider": "azure_openai",
    "model_name": "gpt-4",
    "language": "en",
    "specialty": "cardiology",
    "encounter_type": "consultation"
  }
}
```

**Error Responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "detail": "Invalid session data: ..." }` | Missing required fields |
| 500 | `{ "detail": "Summary generation failed: ..." }` | LLM or internal error |
| 503 | `{ "detail": "Database unavailable ..." }` | PostgreSQL unreachable |

---

### POST /summary/async

Create a summary job for background processing via Celery.

**Request Body** — same as `/summary/sync`, plus the following additional fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `priority` | integer | No | Job priority 1 (highest) to 10 (lowest), default 5 |
| `callback_url` | string | No | URL to POST results when complete |
| `metadata` | object | No | Arbitrary job metadata |

**Response** `202`

```json
{
  "job_id": "job_abc123",
  "status": "pending",
  "created_at": "2025-01-15T10:00:00Z",
  "estimated_completion_time": "2025-01-15T10:01:00Z",
  "callback_url": null,
  "metadata": {}
}
```

---

### POST /presummary

Generate a pre-visit summary from patient data and previous visit history.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `current_department` | string | No | Current visit department (defaults to `"General"` if empty) |
| `visit_type` | string | No | Type of visit (defaults to `"Medical examination"` if empty) |
| `age` | string | No | Patient age |
| `dob` | string | No | Date of birth |
| `gender` | string | No | Patient gender |
| `formatted_vitals` | string | No | Latest vital signs |
| `formatted_test_results` | string | No | Recent test results |
| `formatted_previous_visits` | string | No | Previous visit summaries |
| `language` | string | No | Response language (default `"en"`) |
| `max_tokens` | integer | No | Maximum tokens (1–32000, default 800) |
| `temperature` | float | No | LLM temperature (0.0–2.0, default 0.2) |

**Response** `200`

```json
{
  "pre_summary": "55-year-old male with known hypertension on Lisinopril 10mg...",
  "structured_data": {
    "title": "Pre-Summary of Medical History",
    "sections": [
      { "heading": "Confirmed & Provisional Diagnoses", "content": "..." },
      { "heading": "Plan of Care (Latest Department Note)", "content": "..." }
    ]
  },
  "created_at": "2025-01-15T10:00:00Z"
}
```

---

### POST /summary/feedback

Submit clinician feedback on a generated summary. The summary must exist in the Qdrant vector store.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `summary_id` | string | Yes | ID of the summary being reviewed |
| `provider_id` | string | Yes | Clinician / provider ID |
| `rating` | integer | Yes | Rating (1–5) |
| `labels` | string[] | No | Feedback categories |
| `comment` | string | No | Free-text comment |
| `corrected_summary` | string | No | Clinician-corrected summary text |

**Response** `200`

```json
{
  "feedback_id": "fb_xyz789",
  "summary_id": "sum_123",
  "provider_id": "dr_smith",
  "rating": 4,
  "labels": ["accurate", "needs_more_detail"],
  "comment": "Good overall, missing medication dosages",
  "corrected_summary": null,
  "created_at": "2025-01-15T10:05:00Z"
}
```

---

## Job Management

### GET /jobs/{job_id}

Retrieve status and result of an async job.

**Response** `200`

```json
{
  "job_id": "job_abc123",
  "status": "completed",
  "created_at": "2025-01-15T10:00:00Z",
  "started_at": "2025-01-15T10:00:01Z",
  "completed_at": "2025-01-15T10:00:03Z",
  "progress_percent": 100,
  "current_step": "Completed",
  "result": { "...summary response..." },
  "error": null,
  "error_details": null,
  "retry_count": 0,
  "max_retries": 3,
  "metadata": {
    "session_id": "sess_12345",
    "llm_provider": "azure_openai",
    "specialty": "cardiology"
  }
}
```

**Job Status Values**: `pending` | `queued` | `running` | `completed` | `failed` | `cancelled` | `retry`

### DELETE /jobs/{job_id}

Cancel a running or pending job.

**Response** `200`

```json
{ "message": "Job job_abc123 cancelled successfully" }
```

### GET /jobs

List jobs with optional filtering.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_id` | string | — | Filter by session ID |
| `status` | string | — | Filter by status |
| `limit` | integer | 100 | Max results (max 1000) |
| `offset` | integer | 0 | Skip N results |

**Response** `200` — array of job status objects.

---

## Model Information

### GET /models/info

Returns the current LLM provider configuration. The response structure depends on the implementation of `SummaryService.get_model_info()`.

**Response** `200`

```json
{
  "provider": "azure_openai",
  "model": "gpt-4",
  "endpoint": "https://your-resource.openai.azure.com/",
  "deployment_name": "gpt-4",
  "max_tokens": 6000,
  "temperature": 0.1,
  "capabilities": ["structured_outputs", "json_mode", "function_calling"],
  "summary_service_version": "1.0.0",
  "parsing_method": "flexible_parsing",
  "prompt_system": "conversational"
}
```

---

## Health & Monitoring

### GET /health

Basic health check. Uses the `HealthChecker` infrastructure class.

**Query Parameters**: `detailed=true` for full dependency check (requires `SummaryService` dependency).

**Response** `200`

Basic response:

```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:00:00Z"
}
```

**Detailed Response** (when `detailed=true`) includes `database`, `redis`, `llm_service` checks with connection pool stats, ping times, and provider details.

### GET /readiness

Kubernetes readiness probe (requires `SummaryService` dependency for checking critical services).

**Response** `200` or `503`

```json
{ "status": "ready", "timestamp": "2025-01-15T10:00:00Z" }
```

### GET /liveness

Kubernetes liveness probe (lightweight, no dependencies required).

**Response** `200`

```json
{ "status": "alive", "timestamp": "2025-01-15T10:00:00Z" }
```

### GET /metrics

Prometheus-formatted metrics (exposed at root level, not under `/api/v1`). Key counters and histograms:

```
smr_summaries_created_total{provider="azure_openai",specialty="cardiology"} 1523
smr_summary_duration_seconds_bucket{...le="2.5"} 1156
smr_llm_requests_total{provider="azure_openai",model="gpt-4",status="success"} 1523
smr_errors_total{error_type="timeout",component="llm_service"} 5
smr_cpu_usage_percent 25.5
smr_memory_usage_bytes 1073741824
```

---

## Real-Time Communication

### WebSocket — WS /ws/jobs/{job_id}

Connect to receive real-time job progress updates via Redis Pub/Sub.

**Initial Message** (server → client, sent on connect)

```json
{
  "type": "status",
  "job_id": "job_abc123",
  "data": { "...job status response..." }
}
```

**Progress Updates** (server → client, via Redis Pub/Sub `job_updates:{job_id}`)

```json
{
  "job_id": "job_abc123",
  "status": "running",
  "progress_percent": 50,
  "current_step": "Generating medical summary",
  "timestamp": "2025-01-15T10:00:02Z"
}
```

The WebSocket supports ping/pong keepalive: send `{"type": "ping"}` and receive `{"type": "pong"}`.

**Client Example**

```javascript
const ws = new WebSocket('ws://localhost:8862/api/v1/ws/jobs/job_abc123');
ws.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(`[${update.status}] ${update.progress_percent}% — ${update.current_step}`);
};
```

### Server-Sent Events — GET /sse/jobs/{job_id}

Alternative to WebSocket for environments that don't support bidirectional connections.

**Event Format**

```
event: job_update
data: {"type":"status","job_id":"job_abc123","data":{...}}

event: heartbeat
data: {"type":"heartbeat","timestamp":"..."}

event: job_update
data: {"job_id":"job_abc123","status":"completed","progress_percent":100,...}
```

The stream closes automatically when the job reaches a terminal state (`completed`, `failed`, `cancelled`).

**Client Example**

```javascript
const source = new EventSource('http://localhost:8862/api/v1/sse/jobs/job_abc123');
source.addEventListener('job_update', (event) => {
  const update = JSON.parse(event.data);
  if (update.status === 'completed' || update.status === 'failed') {
    source.close();
  }
});
```

---

## Error Codes

| HTTP Status | Description |
|-------------|-------------|
| 200 | Success |
| 202 | Accepted (async job created) |
| 400 | Bad request / validation error |
| 401 | Unauthorized |
| 404 | Resource not found |
| 422 | Pydantic validation error |
| 429 | Rate limit exceeded |
| 500 | Internal server error |
| 503 | Service unavailable |

---

## Rate Limiting

| Setting | Default |
|---------|---------|
| Requests per minute per IP | 100 |
| Burst (10-second window) | 200 |

Response headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1705888000
```

---

## Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/json` |
| `Accept` | No | `application/json` |
| `X-API-Key` | Conditional | API key authentication |
| `Authorization` | Conditional | `Bearer <jwt>` |
| `X-Correlation-ID` | No | Custom correlation ID for tracing |

---

## Related Documentation

- [SMR Service Overview](./README.md)
- [Configuration](./configuration.md)
- [API Gateway Reference](../api/api-reference.md)
