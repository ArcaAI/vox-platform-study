# HOPE Clinical Documentation Harness (`apps/harness`)

**Ticket:** TASK-330 · **Status:** Phase-0 scaffold · **Port:** 8866 · **Stack:** Python 3.11 / FastAPI / Temporal

A Python/FastAPI orchestrator that runs the bounded **`guides → generate → sensors → gate`**
clinical-documentation loop as a **Temporal durable workflow**. `apps/api` (NestJS) remains the
gateway and system-of-record (authZ, tenant/CLS, Postgres, WORM audit, consent, sign-off); the
harness reuses STT-v2 / NLP / SMR / Qdrant **as tools** (ACI).

> This is the **Phase-0 infra/scaffold lane**: the FastAPI app, health surface, configuration,
> structured logging, and a **real but trivial** Temporal worker + workflow + activity
> (`HarnessPingWorkflow`) that proves the durable substrate. Sensors, guides, the gate, and tool
> clients land in later phases (see the [implementation plan](../../docs/implementation/TASK-330-Clinical-Documentation-Harness/implementation-plan.md)).

---

## Architecture (Temporal mapping)

The loop body is a **deterministic** Temporal **workflow**; all non-deterministic work
(LLM/tool I/O, clock, randomness) lives in **activities**. The clinician sign-off gate will be a
`workflow.wait_condition()` on an approval **Signal** with SLA/escalation timers.

| Loop element | Temporal construct |
|---|---|
| guide / generate / sensors | Activity (idempotent, retryable) |
| bounded regen | deterministic loop in the Workflow |
| **gate (clinician sign-off)** | `wait_condition()` on an approval Signal + durable timer |

```
apps/harness/
├── src/harness/
│   ├── main.py                 # FastAPI app (create_app + lifespan); best-effort Temporal connect
│   ├── core/
│   │   ├── config.py           # pydantic-settings: Settings (HARNESS_*) + TemporalConfig (TEMPORAL_*)
│   │   └── logging.py          # structlog JSON logging (+ OTel trace context)
│   ├── api/endpoints/
│   │   └── health.py           # GET /api/v1/health, /health/live, /health/ready
│   ├── temporal/
│   │   ├── activities.py       # ping_activity — ALL I/O lives in activities
│   │   ├── workflows.py        # HarnessPingWorkflow — deterministic body
│   │   ├── client.py           # get_temporal_client() — env-configured address/namespace
│   │   └── worker.py           # worker entrypoint: python -m harness.temporal.worker
│   └── tests/unit/             # pytest (health + time-skipping workflow E2E)
├── Dockerfile                  # multi-stage on hope-python-base
├── pyproject.toml              # PEP 621 + uv; mirrors smr conventions
└── .env.example
```

---

## Quick start (local dev)

Python **always** runs in the conda env `arcaenv` (HOPE rule).

```bash
# 1. Install the service (editable) into the conda env
conda run -n arcaenv pip install -e "apps/harness[dev,test]"

# 2. (Optional) start the Temporal dev stack — opt-in via the `temporal` profile
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile temporal up -d temporal temporal-ui
#   Temporal persists into dedicated `temporal`/`temporal_visibility` databases
#   inside the shared hope-postgres instance (no dedicated PG container).
#   Temporal Web UI: http://localhost:8233   gRPC frontend: localhost:7233

# 3. Run the FastAPI app (from the monorepo root)
pnpm py:harness:dev
#   → http://localhost:8866/api/v1/health   ·   docs: /api/v1/docs

# 4. In a second terminal, run the Temporal worker
pnpm py:harness:worker
```

The FastAPI app starts even when Temporal is down (it degrades to "not ready" rather than
crashing — fail-safe). The **worker** requires a reachable Temporal server.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `HARNESS_HOST` | `0.0.0.0` | Bind host |
| `HARNESS_PORT` | `8866` | Service port |
| `HARNESS_LOG_LEVEL` | `info` | `debug`/`info`/`warning`/`error` |
| `HARNESS_CORS_ENABLED` / `HARNESS_CORS_ORIGINS` | `false` / `[]` | CORS |
| `HARNESS_METRICS_ENABLED` | `true` | Prometheus `/metrics` |
| `HARNESS_OTEL_*` | see `.env.example` | OpenTelemetry (deferred wiring) |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend (gRPC) |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `harness-task-queue` | Worker task queue |

See [`.env.example`](./.env.example) for the full list.

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Detailed health; echoes configured Temporal substrate (no dialing) |
| GET | `/api/v1/health/live` | Liveness — always 200 if the process is up |
| GET | `/api/v1/health/ready` | Readiness — 503 unless the Temporal frontend is reachable |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/v1/docs` | Swagger UI |

### Internal (service-to-service, `X-Service-Token`)

`apps/api` is the only caller; the Temporal SDK stays isolated in the harness. All routes
require the shared `HARNESS_SERVICE_TOKEN` (an empty configured token disables the guard for
local dev). Mounted under `/api/v1/internal`:

| Method | Path | Description |
|---|---|---|
| POST | `/internal/consultations/{id}/document:start` | Start the document loop (idempotent on `harness-doc-{id}`) |
| POST | `/internal/workflows/{id}/signal/approve` | Forward a clinician sign-off to the `approval` signal |
| POST | `/internal/harness/knowledge:ingest` | Enqueue/ingest a knowledge document (RAG) |

### Admin workflow-ops (`/api/v1/internal/harness`, `X-Service-Token`)

Wrap the Temporal client so the apps/api `HarnessOpsClient` can observe/operate the document
workflows. camelCase JSON; tenant ownership is enforced by apps/api from the surfaced `tenantId`.

| Method | Path | Description |
|---|---|---|
| GET | `/workflows?tenantId&status&consultationId&limit&pageToken` | List (visibility query; cursor-paged → `{ items, nextPageToken }`) |
| GET | `/workflows/{id}?phase=true` | Describe (adds `historyLength`, `memo`, `searchAttributes`, `result`; `phase=true` also queries the loop phase) |
| POST | `/workflows/{id}/cancel` | Request cancellation → `{ workflowId, runId, status, action:"cancel", requested:true }` |
| POST | `/workflows/{id}/terminate` | Terminate (body `{ reason? }`) |
| POST | `/workflows/{id}/signal` | Forward an arbitrary signal (body `{ signalName, payload? }`) |

A missing/closed workflow returns **404**; a `HarnessTenantId` search-attribute outage degrades
the list to a memo + client-side tenant filter (it never 500s).

#### One-time setup: the `HarnessTenantId` search attribute

`document:start` tags each workflow with a `HarnessTenantId` **Keyword** search attribute (so the
admin list can filter by tenant server-side) and a `tenantId` **memo** (the fallback). Register the
search attribute **once per cluster/namespace** before relying on server-side tenant filtering:

```bash
temporal operator search-attribute create --name HarnessTenantId --type Keyword
#   add --namespace <ns> if not "default"
```

If it is **not** registered, the harness still works: `document:start` retries the start memo-only,
and the admin list falls back to the memo + client-side tenant filtering. No crash either way.

---

## Testing

Tests use Temporal's **time-skipping `WorkflowEnvironment`**, so `HarnessPingWorkflow` runs
end-to-end **without an external Temporal server** (the test server binary is fetched once on
first run).

```bash
pnpm py:harness:test            # all tests, verbose
pnpm py:harness:test:cov        # with coverage
pnpm py:harness:lint            # ruff
pnpm py:harness:format          # black
pnpm py:harness:typecheck       # mypy
```

Or directly:

```bash
conda run -n arcaenv pytest apps/harness/src/harness/tests/ -v --tb=short
```

---

## Docker

The image builds on the shared `hope-python-base` (build it first) and serves the FastAPI app by
default; override the command to run the worker:

```bash
docker build -t hope-python-base infrastructure/docker/python-base/
docker build --target production -t harness apps/harness
docker run -p 8866:8866 harness                              # FastAPI app
docker run harness python -m harness.temporal.worker         # Temporal worker
```

---

## Conventions / deviations

- Mirrors **`apps/smr`** for dependency management (PEP 621 `pyproject.toml` + `uv.lock`),
  multi-stage Dockerfile on `hope-python-base`, `structlog` logging, pydantic-settings config,
  and the standardized health contract.
- Like the other Python services, the package is **editable-installed** into `arcaenv`. As a
  safety net `pyproject.toml` also sets `pytest` `pythonpath = ["src"]` so tests run pre-install.
- `pytest` coverage uses `term-missing` only (no html/xml artifacts) to keep the repo root clean.
- The Temporal dev stack is **opt-in** behind the compose `temporal` profile, mirroring the
  existing Vault precedent, so the default infra stack is unchanged.
