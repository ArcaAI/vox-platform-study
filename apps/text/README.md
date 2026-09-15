# Text — multi-provider text generation service

Python/FastAPI service (port **8862**, package `text`, source
`apps/text/src/text`) providing multi-provider text generation, summarization,
embeddings and translation for the HOPE platform. The gateway (`apps/api`)
fronts this service; browsers never call it directly. Several **wire
identifiers stay `text`** even though the directory and CLI moved off the old
`smr`/`summarization` naming — see [Frozen identifiers](#frozen-identifiers).

## Layout

```
apps/text/
|-- src/text/
|   |-- main.py                 # FastAPI factory + lifespan (`text.main:app`)
|   |-- api/endpoints/          # generate, tasks, stream, health, providers, embeddings, translate
|   |-- api/middleware/         # X-Service-Token auth, request-id, logging
|   |-- core/config.py          # Settings (env_prefix TEXT_) + nested sub-configs
|   |-- providers/               # LLM + embedding provider adapters, pooled egress clients
|   |-- routing/                 # provider/model routing
|   |-- services/                # task manager, queues, guardrail client
|   |-- models/                  # request/response pydantic models
|   |-- translation/             # translate providers
|   `-- tests/                   # unit / integration / e2e (in-package, NOT top-level)
|-- tests/bench/                 # standalone benchmark harness (see its own README)
|-- tests/load/                  # Locust resilience tests (see its own README)
|-- pyproject.toml
|-- Dockerfile                   # build from repo root; image name `text`
|-- docker-compose.yml           # optional local compose (`hope-text` container)
|-- .env.sample                  # generated (`pnpm env:sync`) — 9 fields, no provider/model config
|-- .env.prod                    # ops reference only
`-- monitoring/prometheus.yml
```

There is no worker process in this tree: `apps/text/src/text` has no
`worker.py` and no `pnpm text:worker:dev` script. "Worker pool" in the code
(`services/`, `api/endpoints/embeddings.py`) refers to an in-process batching
pool for embeddings, not a separate consumer process.

## Commands

```bash
pnpm text:setup            # install this service into arcaenv (or :apple / :gpu / :cpu)
pnpm text:dev              # uvicorn text.main:app on 127.0.0.1:8862
pnpm text:dev:watch        # scoped reload
pnpm text:test             # pytest apps/text/src/text/tests/
pnpm text:test:unit
pnpm text:test:integration
pnpm text:test:e2e
pnpm text:test:cov
pnpm text:test:managed     # scripts/test-run.sh text (infra + app handled)
pnpm text:lint             # ruff
pnpm text:typecheck        # mypy
pnpm text:format           # black
```

Stack subset (API + this service + harness worker): `pnpm stack:dev -- text
worker`. Local server directly (conda `arcaenv` active, `PYTHONPATH` covering
`apps/text/src`): `uvicorn text.main:app --host 127.0.0.1 --port 8862 --reload`.

- OpenAPI: `http://127.0.0.1:8862/docs`
- Health: `http://127.0.0.1:8862/api/v1/health`
- Metrics: `http://127.0.0.1:8862/metrics`

CI jobs: `test-text`, `build-text`.

### Docker

From the repo root (needs `hope-python-base` built first):

```bash
docker build -f apps/text/Dockerfile --target production -t text .
```

`apps/text/docker-compose.yml` names the API container `hope-text` and
publishes `${TEXT_PORT:-8862}`. Prefer `pnpm text:dev` for local development.

## How it works

**Text generation** — `POST /api/v1/generate` (sync or async task) across
registered LLM providers. The gateway injects `{provider, model}` (and tenant
BYO `provider_overrides`); this service never picks a default model from env.
**SSE streaming** — `GET /api/v1/tasks/{task_id}/stream` via Redis Streams
(`sse-starlette`). **Embeddings / translate / judge** —
`POST /api/v1/embeddings`, `/embeddings/batch`, `/translate`,
`/generate/internal/judge`. **Provider listing + health** —
`GET /api/v1/providers`, `GET /api/v1/health` (+ live/ready).

**Usage passthrough.** Every generation answers a `usage_detail` block (on the
blocking response, the streaming terminal frame, and a judge response)
carrying what only this service can know: which provider served, its own
usage object, the funding tier, `total_ms`, the engine's own `engine_ms` where
it reports one, and the response body bytes. The gateway turns those into
ledger rows; this service never rates anything.

**Providers are registered unconditionally, resolved per request.**
`_register_provider_factories` (`main.py`) registers a lazy factory per
adapter regardless of env config — local engines by `base_url`, cloud BYO
providers unconditionally — so the gateway can inject credentials per request.
Providers: LM Studio (`lm-studio`), `openai_compat` (generic OpenAI-wire
adapter), Azure OpenAI, OpenAI, Anthropic, Vertex, Bedrock, vLLM, llama.cpp,
TEI embed. `lm-studio` and `openai_compat` are distinct adapters — LM Studio
owns the `ttl` retention hint, the native `/api/v0/models` listing and a
non-standard `stats` blob that a generic OpenAI-wire server does not accept.
Resolution is fail-closed at call time (`core/connection.py`): a request
naming a provider with no resolved `AiProviderConnection` gets a typed 503
naming the missing row, never a substituted provider.

**Config is the bootstrap floor only.** `Settings` (`core/config.py`) carries
`env_prefix="TEXT_"`; nested sub-configs are `ExternalGuardrailConfig`
(`TEXT_EXTERNAL_GUARDRAIL_`), `InternalAccessConfig` (unprefixed —
`INTERNAL_ACCESS_TOKEN`) and `TelemetryPhiGuardConfig` (unprefixed — `NODE_ENV`,
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, enforced to
`NO_CONTENT` in production). `apps/text/.env.sample` is a generated file with
exactly **9 fields** and **no provider block, model id, endpoint or
credential** (`test_task799_config_surface.py` locks this). Provider
connections and model selection are DB/Vault-tier, resolved per request; host
env wins, and CI/production read no env file at all.

**Inbound auth.** `X-Service-Token`, constant-time compare, health/docs/metrics
exempt — the single shared `INTERNAL_ACCESS_TOKEN` (the legacy
`TEXT_SERVICE_TOKEN` is retired).

## Frozen identifiers

These are **live** names, not leftovers to "fix":

| Kind | Value |
|---|---|
| Health `service` field | `text` |
| Effective-config query | `?service=text` |
| Redis streams | `text:stream:` (DB 3) |
| Prometheus metrics | `text_*` (e.g. `text_generation_total`, `text_engine_cache_hit_rate`, `text_provider_bytes_total`) |
| OTEL service name (image default) | `text` (`TEXT_OTEL_SERVICE_NAME`) |
| Compat HTTP (gateway) | `/api/smr/api/v1/presummary`, `/api/smr/api/v1/summary/sync` |
| Vault AppRole | `hope-text` |
| Release tag prefix | `TEXT-` (image name is `text`) |

Grafana dashboard **files**: `infrastructure/grafana/dashboards/text-overview.json`,
`text-resilience.json`, `text-security.json`, `text-cache-friendliness.json`
(dashboard **UIDs** match the file stems).

## Gateway

| Surface | Location |
|---|---|
| Raw LLM proxy | `TextProxyController` — `apps/api/src/modules/streaming/text-proxy.controller.ts` (`@Controller('text-generations')`) |
| v1 summarization compat | `TextCompatController` — `apps/api/src/modules/text-compat/` (HTTP paths under `/api/smr/...` stay) |

## Gotchas

- There is no `pnpm text:worker:dev` script and no `text.worker` module —
  do not add call sites or docs referencing a standalone Text worker process.
- `apps/text/.env.sample` is generated by `pnpm env:sync`; hand-edits are
  reverted by the next sync.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — FastAPI service conventions, BYOK, peer-client rules
- [`01-development-workflow.md`](../../.claude/rules/01-development-workflow.md) — layer gates, test placement
- [`tests/bench/README.md`](tests/bench/README.md) — the benchmarking harness for this service
- [`tests/load/README.md`](tests/load/README.md) — Locust resilience/load tests for this service
- [`apps/api` README](../api/README.md) — the gateway that proxies and injects provider config
