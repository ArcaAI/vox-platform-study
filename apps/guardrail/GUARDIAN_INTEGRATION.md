# Guardian Model Integration Guide

## Overview

The Guardian service provides medical context validation to ensure only medical-related content reaches the SMR (medical documentation) service. This guide explains how to integrate the Guardian model with your API proxy.

The default LLM engine is **LM Studio** (OpenAI-compatible, `http://localhost:1234/v1`)
running `granite-guardian-4.1-8b`. Medical-context validation uses a generic JSON prompt
path over `POST {base_url}/v1/chat/completions`. The engine is selectable via
`GUARDRAIL_V2_PROVIDER` (`lm-studio` default | `ollama` | `azure` | `bedrock`).

## Architecture

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐    ┌──────────────────┐
│   Client    │───▶│  API Proxy      │───▶│  Guardian   │───▶│  LLM engine      │
│  (Frontend) │    │  (NestJS)       │    │  Service    │    │  (LM Studio      │
└─────────────┘    │                 │    └─────────────┘    │   default)       │
                   │  ✓ Validates    │           │           └──────────────────┘
                   │  ✓ Blocks       │           ▼
                   │                 │    ┌─────────────┐
                   │                 │───▶│    SMR      │
                   │                 │    │  Service    │
                   └─────────────────┘    └─────────────┘
```

## Guardian Model Configuration

### 1. Environment Variables

Add to your Guardrail service `.env` (default LM Studio engine):

```bash
# Engine selector
GUARDRAIL_V2_PROVIDER=lm-studio

# Guardian Model Configuration (OpenAI-compatible engine)
GUARDRAIL_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
GUARDRAIL_OPENAI_COMPAT_API_KEY=lm-studio
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL=granite-guardian-4.1-8b
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_ENABLED=true
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_TEMPERATURE=0.05
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MAX_TOKENS=300
GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MIN_CONFIDENCE=0.75
```

To use the optional Ollama engine instead, set `GUARDRAIL_V2_PROVIDER=ollama` and configure
the `GUARDRAIL_OLLAMA_*` block.

### 2. Recommended Models

**Default (LM Studio):**
- Model: `granite-guardian-4.1-8b`
- Load `lmstudio-community/granite-guardian-4.1-8b-GGUF` and ensure LM Studio's model id resolves to `granite-guardian-4.1-8b` (or override via `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL`)

**Optional (Ollama engine):**
- A medical or general chat model served by Ollama (e.g. `gemma3`); uses the generic JSON prompt path

### 3. Load / Pull the Model

```bash
# LM Studio (default): load the GGUF via the LM Studio UI / CLI, then start the server on :1234

# Or, with the optional Ollama engine:
ollama pull gemma3:latest
```

## API Endpoints

### Primary: Medical Validation

**Endpoint:** `POST /api/medical/validate`

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
  "texts": [
    "Patient diagnosed with hypertension",
    "Meeting scheduled for tomorrow"
  ],
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
