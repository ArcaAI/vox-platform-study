# Guardrail Service

> AI-powered content safety and medical-context validation for generated clinical text.

## Overview

The Guardrail service (`apps/guardrail`) validates content safety and medical context before/around LLM generation. **SMR calls it per generation** to validate medical content; the client honors a configurable fail-open / fail-closed policy, so SMR keeps working if Guardrail is unavailable.

- **Port:** 8863
- **Stack:** Python 3.11 · FastAPI · Redis (job queue/cache) · GLiNER ONNX
- **Default LLM engine:** **LM Studio** (OpenAI-compatible, `http://localhost:1234/v1`) running **IBM Granite Guardian** (`granite-guardian-4.1-8b`)

## Capabilities

- **Medical context validation (primary):** detect whether content is medical-related, with confidence and clinical/administrative/general classification.
- **Content safety:** harmful/inappropriate content, PII detection, prompt-injection detection, and a combined `comprehensive` check.
- **Processing modes:** real-time (direct API) and async (Redis job queue).

## LLM Engine

The engine is selected via `GUARDRAIL_V2_PROVIDER`:

| Provider | Transport | Protocol | Notes |
|---|---|---|---|
| `lm-studio` (default) | OpenAI-compatible chat | Granite Guardian `<guardian>` / `<score>` | `granite-guardian-4.1-8b` |
| `ollama` | Ollama native API | Generic SAFE/UNSAFE prompts | optional local engine |
| `azure` | OpenAI-compatible chat | Generic SAFE/UNSAFE fallback | requires a guardian-capable deployment |
| `bedrock` | OpenAI-compatible gateway | Generic SAFE/UNSAFE fallback | requires a guardian-capable model |

All engines **fail open** on timeout/error.

## Getting Started

```bash
# Install (handled by `pnpm py:setup`, or manually):
conda run -n arcaenv pip install -e "apps/guardrail[dev,test]"

# Ensure an LLM engine is reachable (LM Studio with granite-guardian-4.1-8b by default), then:
pnpm dev:guardrail        # → http://localhost:8863/api/health
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GUARDRAIL_V2_PROVIDER` | `lm-studio` | Engine selector (`lm-studio` \| `ollama` \| `azure` \| `bedrock`) |
| `GUARDRAIL_V2_PORT` | `8863` | Service port |
| `GUARDRAIL_OPENAI_COMPAT_BASE_URL` | `http://localhost:1234/v1` | LM Studio base URL |
| `GUARDRAIL_OPENAI_COMPAT_GUARDIAN_MODEL` | `granite-guardian-4.1-8b` | Guardian model id |
| `GUARDRAIL_REDIS_URL` | `redis://localhost:6379/0` | Redis for the job queue/cache |
| `GUARDRAIL_DB_CONFIG_ENABLED` | `false` | Opt-in per-tenant engine/model resolution from the DB |

## Per-Tenant Engine Configuration

By default the engine/model are **env-only**. When `GUARDRAIL_DB_CONFIG_ENABLED=true`, the service resolves the admin-chosen provider/model **per tenant at request time** by reading `core."GlobalSetting"` (read-only, with a short TTL cache):

| namespace | key | meaning |
|---|---|---|
| `guardrail` | `default-guardrail-provider` | `lm-studio` \| `ollama` \| `azure` \| `bedrock` |
| `guardrail` | `default-guardrail-model` | guardian model id / slug |
| `guardrail` | `guardrail-azure-deployment` | non-secret Azure deployment name |

Resolution order: request tenant → default/system tenant → env defaults. The DB only stores provider, model, and the non-secret Azure deployment name — `base_url`/`api_key` always come from env/Vault. DB access is fail-safe (any error → no override).

## API Reference

| Method | Path | Description |
|---|---|---|
| POST | `/api/medical/validate` | Medical-context validation (primary; accepts `X-Tenant-Id`) |
| POST | `/api/medical/validate/batch` | Batch medical validation |
| POST | `/api/guardrail/analyze` | Content-safety analysis (`content_safety` \| `pii_detection` \| `prompt_injection` \| `comprehensive`) |
| POST | `/api/guardrail/analyze/async` | Async job submission |
| GET | `/api/jobs/status/{id}` | Job status |
| GET | `/api/health` | Health check |
| GET | `/metrics` | Prometheus metrics |

## Testing

```bash
pnpm py:guardrail:test        # pytest
pnpm py:guardrail:test:cov    # with coverage
pnpm py:guardrail:lint        # ruff
pnpm py:guardrail:typecheck   # mypy
```

## Related Documentation

- [Architecture Overview](../architecture/README.md) — system topology
- [SMR V2](../smr-v2/README.md) — calls Guardrail in the generation path
- [Clinical Documentation Harness](../harness/README.md) — orchestrator
- Full service docs: [`apps/guardrail/README.md`](../../apps/guardrail/README.md)
