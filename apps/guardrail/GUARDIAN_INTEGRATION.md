# Guardian Model Integration Guide

## Overview

The Guardian service provides medical context validation to ensure only medical-related content reaches the SMR (medical documentation) service. This guide explains how to integrate the Guardian model with your API proxy.

## Architecture

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐    ┌─────────────┐
│   Client    │───▶│  API Proxy      │───▶│  Guardian   │───▶│   Ollama    │
│  (Frontend) │    │  (NestJS)       │    │  Service    │    │   Model     │
└─────────────┘    │                 │    └─────────────┘    └─────────────┘
                   │  ✓ Validates    │           │
                   │  ✓ Blocks       │           ▼
                   │                 │    ┌─────────────┐
                   │                 │───▶│    SMR      │
                   │                 │    │  Service    │
                   └─────────────────┘    └─────────────┘
```

## Guardian Model Configuration

### 1. Environment Variables

Add to your Guardrail service `.env`:

```bash
# Guardian Model Configuration
GUARDRAIL_OLLAMA_GUARDIAN_MODEL=meta-llama/Prompt-Guard-86M
GUARDRAIL_OLLAMA_GUARDIAN_ENABLED=true
GUARDRAIL_OLLAMA_GUARDIAN_TEMPERATURE=0.05
GUARDRAIL_OLLAMA_GUARDIAN_MAX_TOKENS=300
GUARDRAIL_OLLAMA_GUARDIAN_MIN_CONFIDENCE=0.75
```

### 2. Recommended Models

**Option 1: Default**
- Model: `meta-llama/Prompt-Guard-86M`
- Good for: Prompt safety and lightweight guardrail classification
- Size: lightweight

**Option 2: Medical Specialized (Recommended)**
- Model: `meditron:7b` or `biomistral:7b`
- Good for: Enhanced medical terminology understanding
- Size: ~4GB

**Option 3: Alternative Lightweight**
- Model: another Ollama-compatible lightweight classifier
- Good for: Fast validation with lower resource usage
- Size: varies

### 3. Pull the Model

```bash
# Pull the default model
ollama pull meta-llama/Prompt-Guard-86M

# Or pull a medical-specialized model
ollama pull meditron:7b
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
  "model": "meta-llama/Prompt-Guard-86M",
  "model_available": true,
  "base_url": "http://localhost:11434"
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
2. Verify Ollama is accessible: `curl http://localhost:11434/api/tags`
3. Check model is loaded: `ollama list`

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
