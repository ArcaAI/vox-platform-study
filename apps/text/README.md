# Text Service

**Owner**: Platform / Text generation · **Port**: **8862** · **Package**: `text` (`apps/text/src/text`)

Multi-provider text generation and summarization FastAPI service for the HOPE platform. The
directory and CLI were formerly `apps/text` / `text:*`; start it with `pnpm text:dev`. Several
**wire identifiers stay `text`** (health `serviceKey`, Redis stream prefix, Prometheus metric
names, compat HTTP paths) — see [Frozen identifiers](#frozen-identifiers).

The gateway fronts this service. Browsers should not call it directly.

## What it does

- **Text generation** — `POST /api/v1/generate` (sync or async task) across registered LLM
  providers. The gateway injects `{provider, model}` (and tenant BYO `provider_overrides`); this
  service does not pick a default model from env.
- **SSE streaming** — `GET /api/v1/tasks/{task_id}/stream` via Redis Streams (`sse-starlette`).
- **Embeddings / translate / judge** — `POST /api/v1/embeddings`, `/embeddings/batch`,
  `/translate`, `/generate/internal/judge`.
- **Provider listing + health** — `GET /api/v1/providers`, `GET /api/v1/health` (+ live/ready).
- **Optional worker pool** — `pnpm text:worker:dev` consumes Redis-Streams worker-pool tasks
  (separate process from the API).

Providers registered from connection config (local engines by `base_url`; cloud BYO registered
unconditionally so the gateway can inject credentials per request): LM Studio (`lm-studio`),
`openai_compat` (the generic OpenAI-wire portability adapter), Azure OpenAI, OpenAI, Anthropic,
Vertex, Bedrock, vLLM, llama.cpp, TEI embed. `lm-studio` and `openai_compat` are DISTINCT
adapters — LM Studio owns the `ttl` retention hint, the native `/api/v0/models` listing and the
non-standard `stats` blob, none of which a generic OpenAI-wire server accepts.

## Quick start

From the **monorepo root** (conda env `arcaenv`, Python 3.11):

```bash
pnpm text:setup          # install this service into arcaenv (or text:setup:apple / :gpu / :cpu)
pnpm text:dev            # uvicorn text.main:app on 127.0.0.1:8862
# pnpm text:dev:watch    # scoped reload
# pnpm text:worker:dev   # optional worker-pool consumer
```

Or, with `arcaenv` already active and `PYTHONPATH` covering `apps/text/src`:

```bash
conda activate arcaenv
uvicorn text.main:app --host 127.0.0.1 --port 8862 --reload
```

Stack subset (API + this service + harness worker):

```bash
pnpm stack:dev -- text worker
```

- **OpenAPI**: http://127.0.0.1:8862/docs
- **Health**: http://127.0.0.1:8862/api/v1/health
- **Metrics**: http://127.0.0.1:8862/metrics

Env is the BOOTSTRAP FLOOR only: `TEXT_PORT` (8862), `TEXT_URL` (gateway → this service),
`INTERNAL_ACCESS_TOKEN` (`X-Service-Token`; empty = local-dev bypass — the ONE shared internal
credential, unprefixed on purpose; the per-service `TEXT_SERVICE_TOKEN` is retired). Copy `apps/text/.env.sample`
for the full set — nine fields, and **no provider block, model id, endpoint or credential**
(`core/config.py`, locked by `test_task799_config_surface.py`). Provider connections and model
selection are DB/Vault-tier, resolved per request; there is no `.env.prod`. Host env wins;
CI and production read no env file at all.

## Project layout

```
apps/text/
├── src/text/
│   ├── main.py                 # FastAPI factory + lifespan (`text.main:app`)
│   ├── worker.py               # worker-pool consumer (`pnpm text:worker:dev`)
│   ├── api/endpoints/          # generate, tasks, stream, health, providers, …
│   ├── api/middleware/         # X-Service-Token auth, request-id, logging
│   ├── core/                   # config (env_prefix TEXT_), metrics, effective-config client
│   ├── providers/              # LLM + embedding providers
│   ├── services/               # task manager, queues, guardrail client, worker pool
│   ├── models/                 # request/response pydantic models
│   ├── translation/            # translate providers
│   └── tests/                  # unit / integration / e2e (in-package)
├── pyproject.toml
├── Dockerfile                  # build from repo root; image name `text`
├── docker-compose.yml          # optional local compose (`hope-text` container)
├── .env.sample
├── .env.prod                   # ops reference
└── monitoring/prometheus.yml
```

There is no Celery worker, no Alembic/SQLAlchemy schema, and no `run_dev.sh` in this tree.

## Tests and quality

```bash
pnpm text:test                 # pytest apps/text/src/text/tests/
pnpm text:test:unit
pnpm text:test:integration
pnpm text:test:e2e
pnpm text:test:cov
pnpm text:test:managed         # scripts/test-run.sh text (infra + app handled)
pnpm text:lint                 # ruff
pnpm text:typecheck            # mypy
pnpm text:format               # black
```

CI jobs: `test-text`, `build-text`.

## Docker

From the **repo root** (needs `hope-python-base` first):

```bash
docker build -f apps/text/Dockerfile --target production -t text .
```

`apps/text/docker-compose.yml` names the API container `hope-text` and publishes
`${TEXT_PORT:-8862}`. Prefer `pnpm text:dev` for local development.

## Frozen identifiers

These are **live** names, not leftovers to “fix” in code or docs that describe the wire:

| Kind | Value |
|---|---|
| Health `service` field | `text` |
| Effective-config query | `?service=text` |
| Redis streams | `text:stream:` (DB 3) |
| Prometheus metrics | `text_*` (e.g. `text_generation_total`, `text_engine_cache_hit_rate`) |
| OTEL service name (image default) | `text` (`TEXT_OTEL_SERVICE_NAME`) |
| Compat HTTP (gateway) | `/api/smr/api/v1/presummary`, `/api/smr/api/v1/summary/sync` |
| Task keys | `text.live`, `text.finalize`, `text.test` |
| Vault AppRole | `hope-text` |
| Release tag prefix | `TEXT-` (image name is `text`) |

Grafana dashboard **files** are `infrastructure/grafana/dashboards/text-overview.json`,
`text-resilience.json`, `text-security.json`, `text-cache-friendliness.json`. Dashboard
**UIDs** are still `text-overview`, `text-resilience`, `text-security`, `text-cache-friendliness`.

## Gateway

| Surface | Location |
|---|---|
| Raw LLM proxy | `TextProxyController` — `apps/api/src/modules/streaming/text-proxy.controller.ts` (`@Controller('text-generations')`) |
| v1 summarization compat | `TextCompatController` — `apps/api/src/modules/text-compat/` (HTTP paths under `/api/smr/...` stay) |
