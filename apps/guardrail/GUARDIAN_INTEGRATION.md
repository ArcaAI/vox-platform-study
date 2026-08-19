# Guardian Model Integration Guide

## Overview

The Guardian service provides medical context validation to ensure only medical-related content reaches the SMR (medical documentation) service. This guide explains how to integrate the Guardian model with your API proxy.

**Guardrail hosts no LLM engine** (TASK-735). It owns the medical-context CRITERIA, the
confidence floor, the verdict shape and the fail-closed posture, and delegates the model
call to `apps/text`'s isolated judge lane — `POST {TEXT_URL}/api/v1/generate/internal/judge`,
which sits outside `text`'s own moderation gate and runs on its own pool. Provider and model
come from `AiTaskDefault` (`guardrail.validate`), the tenant's row first and the SYSTEM row
as the platform fallback; the tenant's credential comes from its own `llm`
`AiProviderConnection` and is forwarded as an opaque `provider_overrides` blob that
guardrail never decrypts, stores or logs.

## Architecture

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐    ┌──────────────────┐
│   Client    │───▶│  API Proxy      │───▶│  Guardian   │───▶│  apps/text       │
│  (Frontend) │    │  (NestJS)       │    │  (policy)   │    │  judge lane      │
└─────────────┘    │                 │    └─────────────┘    │  (owns engines)  │
                   │  ✓ Validates    │           │           └──────────────────┘
                   │  ✓ Blocks       │           ▼
                   │                 │    ┌─────────────┐
                   │                 │───▶│    SMR      │
                   │                 │    │  Service    │
                   └─────────────────┘    └─────────────┘
```

## Guardian Model Configuration

### 1. Environment Variables

Guardrail declares **no engine, endpoint, model or vendor key**. What it needs is transport
and identity only:

```bash
# Where apps/text lives (repo-wide; guardrail adds no env var of its own).
TEXT_URL=http://localhost:8862
# Inbound/outbound internal auth (one shared token across every HOPE service).
INTERNAL_ACCESS_TOKEN=...
```

There is deliberately no `GUARDRAIL_V2_PROVIDER` and no
`GUARDRAIL_{OPENAI_COMPAT,VLLM,LLAMA_CPP,AZURE,BEDROCK}_*` block: an engine name, model id,
endpoint or API key in guardrail's env is configuration wearing a costume, and a vendor key
there is a leak. Selection is `AiTaskDefault`; tuning is the provider-level
`AiRuntimeProfile`; the credential is the tenant's own connection.

### 1b. Per-Tenant DB Configuration (TASK-338, optional)

DB-driven per-tenant resolution is the ONLY source of a provider/model, and it is on by
default. There is no env-only mode to fall back to:

```bash
# Default: TRUE. Setting it false does not produce an env-only mode — with no engine left
# to name, medical validation simply 503s.
GUARDRAIL_DB_CONFIG_ENABLED=true
# Read-only connection to the shared HOPE core DB (postgres:// auto-normalized to asyncpg).
GUARDRAIL_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/hope
# NOTE: no "default tenant" knob exists. Resolution is request tenant -> SYSTEM
# (00000000-...); a request without X-Tenant-Id resolves SYSTEM only.
# Resolved-config cache TTL (seconds).
GUARDRAIL_CONFIG_CACHE_TTL_S=60
```

When enabled, the service resolves the guardian provider/model at request time by reading
`core."GlobalSetting"` (read-only SQLAlchemy + asyncpg, mirroring STT):

| namespace   | key                          | meaning                                         |
| ----------- | ---------------------------- | ----------------------------------------------- |
| `guardrail` | `default-guardrail-provider` | `lm-studio` \| `vllm` \| `llama-cpp` \| `azure` \| `bedrock` |
| `guardrail` | `default-guardrail-model`    | guardian model id / slug                        |
| `guardrail` | `guardrail-azure-deployment` | non-secret Azure deployment name (may be empty) |

- **Tenant selection** comes from the **`X-Tenant-Id`** request header (OQ1).
- **Resolution order:** request tenant rows → default/system tenant rows → env defaults.
- A **~60s per-tenant TTL cache** keeps steady-state latency unaffected (OQ2).
- `base_url`/`api_key` always come from env; the DB only carries provider, model, and the
  non-secret Azure deployment name. The **Azure API key stays env/Vault** (never stored in a
  plaintext `GlobalSetting`).
- DB access is **fail-safe**: any error falls back to the env-selected engine.

### 2. Choosing the Model

The model is **not chosen here and not chosen in env**. A platform admin publishes the
approved guardian models as SYSTEM-tenant `AiModel` rows and points the SYSTEM
`AiTaskDefault` row for `guardrail.validate` at one of them; a tenant may select any model
from that approved list for its own row, and bring its own key for it. Guardrail resolves
tenant row → SYSTEM row and fails CLOSED (503) when neither exists — it never substitutes a
compiled-in default.

## API Endpoints

### Primary: Medical Validation

**Endpoint:** `POST /api/medical/validate`

**Headers (optional):**

- `X-Tenant-Id`: consultation tenant. When `GUARDRAIL_DB_CONFIG_ENABLED=true`, this selects
  the per-tenant guardian provider/model (see §1b). Ignored in env-only mode. SMR forwards
  the consultation tenant here automatically.
- `X-Service-Token`: inter-service auth token (when configured).

**Request:**

```json
{
  "text": "Patient presents with chest pain and shortness of breath.",
  "request_id": "req_123",
  "include_reasoning": true
}
```

**Response:**

```json
{
  "is_medical": true,
  "confidence": 0.95,
  "context_type": "clinical",
  "reasoning": "Text contains clinical symptoms and patient presentation",
  "processing_time_ms": 250.5,
  "request_id": "req_123",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

### Batch Validation

**Endpoint:** `POST /api/medical/validate/batch`

**Request:**

```json
{
  "texts": ["Patient diagnosed with hypertension", "Meeting scheduled for tomorrow"],
  "request_id": "batch_001"
}
```

### Health Check

**Endpoint:** `GET /api/medical/health`

**Response:**

```json
{
  "status": "healthy",
  "guardian_enabled": true,
  "model": "granite-guardian-4.1-8b",
  "model_available": true,
  "base_url": "http://localhost:1234/v1"
}
```

## Validation Behavior

### Confidence Thresholds

- **>= 0.75**: High confidence - medical content
- **0.50 - 0.74**: Medium confidence - may contain medical terms
- **< 0.50**: Low confidence - likely non-medical

### Context Types

- **clinical**: Direct patient care, diagnoses, treatments
- **administrative**: Medical scheduling, referrals, documentation
- **general**: Non-medical content

### Fail-Open vs Fail-Closed

**Fail-Open (Default):**

- If Guardian service is unavailable, allow requests
- Use keyword-based fallback validation
- Suitable for production with high availability needs

**Fail-Closed (Strict):**

- If Guardian service is unavailable, block requests
- No fallback validation
- Suitable for strict compliance requirements

## Testing

### Test Medical Content

```bash
curl -X POST "http://localhost:8863/api/medical/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Patient presents with acute myocardial infarction. Started on aspirin and nitroglycerin.",
    "include_reasoning": true
  }'
```

Expected: `is_medical: true`, `confidence: > 0.9`

### Test Non-Medical Content

```bash
curl -X POST "http://localhost:8863/api/medical/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Please schedule a team meeting for next Tuesday at 2 PM.",
    "include_reasoning": true
  }'
```

Expected: `is_medical: false`, `confidence: < 0.3`

### Test Edge Cases

```bash
curl -X POST "http://localhost:8863/api/medical/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "The doctor recommended I take a vacation to reduce stress.",
    "include_reasoning": true
  }'
```

Expected: `is_medical: true/false` (borderline), `confidence: 0.4-0.6`

## Monitoring

### Metrics

The Guardian service exposes Prometheus metrics at `/metrics`:

- `guardian_validations_total` - Total validations performed
- `guardian_validation_duration_seconds` - Validation latency
- `guardian_confidence_score` - Distribution of confidence scores
- `guardian_medical_detected_total` - Medical content detected
- `guardian_errors_total` - Validation errors

### Logs

Guardian logs include:

```json
{
  "message": "guardian.validation_completed",
  "is_medical": true,
  "confidence": 0.95,
  "context_type": "clinical",
  "processing_time_ms": 250.5,
  "request_id": "req_123"
}
```

## Troubleshooting

### Guardian Service Not Responding

**Symptom:** Timeout errors when validating

**Solutions:**

1. Check Guardian service is running: `curl http://localhost:8863/api/health`
2. Verify the LLM engine is accessible: `curl http://localhost:1234/v1/models` (LM Studio default)
3. Check the configured model id is loaded in the engine

### Low Confidence Scores

**Symptom:** Medical content getting low confidence

**Solutions:**

1. Use a medical-specialized model (meditron, biomistral)
2. Lower the confidence threshold
3. Add domain-specific keywords to the validator

### High False Positives

**Symptom:** Non-medical content marked as medical

**Solutions:**

1. Increase confidence threshold to 0.85+
2. Review and refine the validation prompt
3. Use stricter keyword matching

## Best Practices

1. **Always validate before SMR**: Never skip validation for production traffic
2. **Monitor confidence scores**: Track distribution to tune thresholds
3. **Use batch validation**: For multiple texts, use batch endpoint for efficiency
4. **Cache results**: Cache validation results for identical prompts
5. **Graceful degradation**: Implement fallback validation when Guardian is down
6. **Log all validations**: Keep audit trail for compliance
7. **Test edge cases**: Regularly test borderline medical content

## Security Considerations

1. **Internal Service Token**: Always use `INTERNAL_SERVICE_TOKEN` for proxy protection
2. **Rate Limiting**: Implement rate limiting on validation endpoints
3. **Input Sanitization**: Validate and sanitize all input text
4. **Audit Logging**: Log all validation requests with user context
5. **Fail-Closed for Compliance**: Use fail-closed mode for HIPAA/compliance requirements

## Performance Optimization

1. **Model Selection**: Use smaller models (3B) for faster validation
2. **Concurrent Requests**: Configure `max_concurrent` based on hardware
3. **Caching**: Cache validation results with Redis
4. **Batch Processing**: Use batch endpoint for multiple validations
5. **Async Validation**: Use job queue for non-blocking validation

## Support

For issues or questions:

- Check logs: `docker-compose logs guardrail`
- Health endpoint: `GET /api/medical/health`
- Metrics: `GET /metrics`
