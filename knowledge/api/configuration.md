# API Gateway — Configuration

All configuration is read from environment variables. In development, place a `.env` file in `apps/api/`. In production, inject variables via your deployment platform (Docker env, Kubernetes secrets, etc.).

A template is provided at `apps/api/.env.example`.

---

## Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `development` | `development`, `staging`, or `production` |
| `PORT` | No | `8868` | HTTP listen port |
| `URL` | No | — | Public-facing base URL |

---

## Developer Tools

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENABLE_PRISMA_STUDIO` | No | `true` (non-production) | Enable embedded Prisma Studio at `/api/v1/admin/pstudio`. Set to `false` to disable, or `true` to force-enable in production. |

---

## Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_CONNECTION_STRING` | Yes | — | PostgreSQL connection URL (pooled) |
| `DB_CONNECTION_STRING_DIRECT` | No | — | Direct connection URL (migrations, Prisma Studio) |

---

## Redis

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_HOST` | Yes | `localhost` | Redis server hostname |
| `REDIS_PORT` | No | `6379` | Redis server port |
| `REDIS_PASS` | No | — | Redis password |

---

## Python Microservices

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STT_V2_PORT` | No | `8861` | STT v2 service port |
| `STT_V2_URL` | No | `http://localhost:8861` | STT v2 service base URL |
| `SMR_PORT` | No | `8862` | SMR service port |
| `SMR_URL` | No | `http://localhost:8862` | SMR service base URL |
| `NLP_PORT` | No | `8864` | NLP service port |
| `NLP_URL` | No | `http://localhost:8864` | NLP service base URL |
| `GUARDRAIL_V2_PORT` | No | `8863` | Guardrail service port |
| `HARNESS_PORT` | No | `8866` | Clinical Documentation Harness port |

> **Removed services:** The former TTS and FedL services no longer exist — `TTS_PORT`/`TTS_URL` (8863) and `FEDL_PORT`/`FEDL_URL` (8865) have been removed from the gateway config. Port 8863 now serves the Guardrail service (`GUARDRAIL_URL`).

---

## Authentication & Sessions

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET_KEY` | Yes | — | Secret for signing session cookies (min 32 chars) |

---

## CORS

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | No | — | Comma-separated list of allowed origins (production) |

CORS behavior varies by `NODE_ENV`:

| Environment | Behavior |
|-------------|----------|
| `development` | All origins allowed |
| `staging` | Localhost + staging domains + dev tools |
| `production` | Configured origins + default ARCAAI domains + any HTTPS origin (SDK-friendly) |

---

## Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `debug` | Logging level: `error`, `warn`, `info`, `debug` |
| `LOG_FILE_ENABLED` | No | `true` | Write logs to files |
| `LOG_FILE_PATH` | No | `./logs` | Directory for log files |
| `LOG_FILE_MAX_SIZE` | No | `10m` | Max size per log file before rotation |
| `LOG_FILE_MAX_FILES` | No | `1000` | Maximum number of rotated files to keep |
| `LOG_FILE_SEPARATE_ERROR` | No | `false` | Write error-level logs to a separate file |

---

## Sentry (Error Tracking)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN_API` | No | — | Sentry DSN for the API project |

---

## Highlight (Session Replay)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HIGHLIGHT_PROJECT_ID` | No | — | Highlight project ID |
| `AGENTIC_HIGHLIGHT_PROJECT_ID` | No | — | Alternative Highlight project ID (fallback) |
| `HIGHLIGHT_BACKEND_URL` | No | `https://pub.highlight.io` | Highlight backend URL |
| `HIGHLIGHT_OTLP_ENDPOINT` | No | `https://otel.highlight.io:4318` | OTLP endpoint for Highlight |

Highlight is initialized when `HIGHLIGHT_PROJECT_ID` or `AGENTIC_HIGHLIGHT_PROJECT_ID` is set.

---

## OpenTelemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTEL_SERVICE_NAME` | No | `hope-api` | Service name in traces |
| `OTEL_SERVICE_VERSION` | No | `1.0.0` | Service version |
| `OTEL_SERVICE_NAMESPACE` | No | `hope` | Namespace for service grouping |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | `http://localhost:4317` | OTLP gRPC collector endpoint |
| `OTEL_EXPORTER_JAEGER_ENDPOINT` | No | `http://localhost:4317` | Jaeger exporter endpoint |
| `OTEL_TRACES_ENABLED` | No | `true` | Enable distributed tracing |
| `OTEL_METRICS_ENABLED` | No | `true` | Enable metrics export |

---

## Graceful Shutdown

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SHUTDOWN_TIMEOUT_MS` | No | `30000` | Total shutdown timeout (match K8s `terminationGracePeriodSeconds`) |
| `SHUTDOWN_DRAIN_DELAY_MS` | No | `5000` | Delay before closing connections (LB drain time) |

---

## MQTT (Optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MQTT_HOST` | No | `localhost` | MQTT broker hostname |
| `MQTT_PORT` | No | `1883` | MQTT broker port |
| `MQTT_USER` | No | — | MQTT username |
| `MQTT_PASS` | No | — | MQTT password |

---

## Example .env (Development)

```bash
NODE_ENV=development
PORT=8868
URL=
ENABLE_PRISMA_STUDIO=true

DB_CONNECTION_STRING=postgres://prisma.arcaai:prisma@localhost:5432/postgres
DB_CONNECTION_STRING_DIRECT=postgres://prisma.arcaai:prisma@localhost:5432/postgres

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=redis-password

STT_V2_URL=http://localhost:8861
SMR_URL=http://localhost:8862
GUARDRAIL_URL=http://localhost:8863
NLP_URL=http://localhost:8864
HARNESS_URL=http://localhost:8866

MQTT_HOST=localhost
MQTT_PORT=1883

SESSION_SECRET_KEY=hope-session-secret

LOG_LEVEL=debug
LOG_FILE_ENABLED=true
LOG_FILE_PATH=./logs
LOG_FILE_MAX_SIZE=10m
LOG_FILE_MAX_FILES=1000
LOG_FILE_SEPARATE_ERROR=false

SENTRY_DSN_API=

OTEL_SERVICE_NAME=hope-api
OTEL_SERVICE_VERSION=1.0.0
OTEL_SERVICE_NAMESPACE=hope
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_JAEGER_ENDPOINT=http://localhost:4317
OTEL_TRACES_ENABLED=true
OTEL_METRICS_ENABLED=true

SHUTDOWN_TIMEOUT_MS=30000
SHUTDOWN_DRAIN_DELAY_MS=5000
```

---

## Production Checklist

- [ ] `NODE_ENV=production`
- [ ] Strong, unique `SESSION_SECRET_KEY`
- [ ] `DB_CONNECTION_STRING` using SSL (`?sslmode=require`)
- [ ] `REDIS_PASS` set
- [ ] `SENTRY_DSN_API` configured
- [ ] `HIGHLIGHT_PROJECT_ID` configured
- [ ] `CORS_ALLOWED_ORIGINS` restricted to known domains
- [ ] `SHUTDOWN_TIMEOUT_MS` matches Kubernetes `terminationGracePeriodSeconds`
- [ ] `LOG_LEVEL=info` or `warn`
- [ ] Secrets injected via environment, not `.env` files

---

## Related Documentation

- [API Gateway Overview](./README.md)
- [API Reference](./api-reference.md)
