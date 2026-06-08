# Clinical Documentation Harness

> Python / FastAPI orchestrator that runs the bounded clinical-documentation loop as a Temporal durable workflow.

## Overview

The Harness (`apps/harness`) drives the **`guides → generate → sensors → gate`** clinical-documentation loop. The API gateway (`apps/api`, NestJS) remains the gateway and system-of-record (authZ, tenant/CLS, Postgres, WORM audit, consent, sign-off); the Harness reuses **STT-v2 / NLP / SMR / Qdrant as tools** (agentic-compute-interface pattern) and isolates the Temporal SDK so `apps/api` is the only caller.

- **Port:** 8866
- **Stack:** Python 3.11 · FastAPI · Temporal (durable workflows)

## Architecture (Temporal mapping)

The loop body is a **deterministic** Temporal **workflow**; all non-deterministic work (LLM/tool I/O, clock, randomness) lives in **activities**. The clinician sign-off gate is a `workflow.wait_condition()` on an approval **Signal** with SLA/escalation timers.

| Loop element | Temporal construct |
|---|---|
| guide / generate / sensors | Activity (idempotent, retryable) |
| bounded regen | deterministic loop in the Workflow |
| gate (clinician sign-off) | `wait_condition()` on an approval Signal + durable timer |

Internal structure (`src/harness/`): `main.py` (FastAPI app + best-effort Temporal connect), `api/` (health + internal routes), `temporal/` (workflows, activities, client, worker), `sensors/`, `guides/`, `guards/`, `eval/`, `services/`, `core/` (config + structlog logging).

## Getting Started

Python always runs in the conda env `arcaenv`.

```bash
# Install (handled by `pnpm py:setup`, or manually):
conda run -n arcaenv pip install -e "apps/harness[dev,test]"

# Start the Temporal dev stack (opt-in `temporal` compose profile):
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile temporal up -d temporal-postgresql temporal temporal-ui
#   Temporal Web UI: http://localhost:8233 · gRPC frontend: localhost:7233

# Run the FastAPI app + the worker (separate terminals):
pnpm dev:harness          # → http://localhost:8866/api/v1/health · docs: /api/v1/docs
pnpm py:harness:worker
```

The FastAPI app starts even when Temporal is down (it degrades to "not ready" rather than crashing). The **worker** requires a reachable Temporal server.

**One-time per cluster:** register the tenant search attribute so the admin list can filter server-side:

```bash
temporal operator search-attribute create --name HarnessTenantId --type Keyword
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HARNESS_HOST` | `0.0.0.0` | Bind host |
| `HARNESS_PORT` | `8866` | Service port |
| `HARNESS_LOG_LEVEL` | `info` | Log verbosity |
| `HARNESS_METRICS_ENABLED` | `true` | Prometheus `/metrics` |
| `HARNESS_SERVICE_TOKEN` | — | Shared `X-Service-Token` for internal routes (empty disables the guard for local dev) |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend (gRPC) |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `harness-task-queue` | Worker task queue |

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Detailed health (echoes configured Temporal substrate) |
| GET | `/api/v1/health/live` | Liveness |
| GET | `/api/v1/health/ready` | Readiness — 503 unless Temporal is reachable |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/v1/docs` | Swagger UI |

Internal routes (service-to-service, `X-Service-Token`, mounted under `/api/v1/internal`) start the document loop, forward clinician sign-off signals, ingest knowledge documents, and expose admin workflow-ops (list/describe/cancel/terminate/signal). `apps/api` is the only caller.

## Testing

```bash
pnpm py:harness:test        # all tests (Temporal time-skipping WorkflowEnvironment — no external server needed)
pnpm py:harness:test:cov    # with coverage
pnpm py:harness:lint        # ruff
pnpm py:harness:typecheck   # mypy
```

## Related Documentation

- [Architecture Overview](../architecture/README.md) — system topology
- [Guardrail](../guardrail/README.md) — content-safety service used in the generate path
- [SMR V2](../smr-v2/README.md) · [STT V2](../stt-v2/README.md) · [NLP](../nlp/README.md) — tools the Harness orchestrates
- Full service docs: [`apps/harness/README.md`](../../apps/harness/README.md)
