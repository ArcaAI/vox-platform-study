# NLP — medical NLP service

Python/FastAPI service (port **8864**, package `nlp`) providing text
classification, token classification (NER), medical diagnosis suggestion,
text correction, document text extraction, and the guardrail-class inference
routes (PII detection, safety classification, entailment scoring) for the
HOPE platform. The gateway (`apps/api`) fronts this service; it is reached by
the gateway and by peer Python services, never directly by a browser.

**No model id is hardcoded.** Text/token classification and medical
suggestion all take their `model_name` from the caller (the gateway's
resolved agent/model selection) — this service has no compiled-in default
model, and a request that omits one gets a fail-closed error rather than a
silently-substituted classifier.

## Layout

```
apps/nlp/
|-- src/nlp/
|   |-- main.py                  # entrypoint: uvicorn.run("nlp.app:get_app", factory=True)
|   |-- app.py                   # get_app() factory: FastAPI app, middleware, routers
|   |-- lifespan.py              # ASGI lifespan (startup/shutdown)
|   |-- dependencies.py          # FastAPI DI providers (model cache, batchers, extractors)
|   |-- torch_runtime.py         # CPU thread config; reads the CONTAINER's CFS quota, not os.cpu_count()
|   |-- core/
|   |   |-- config.py            # NLPServiceConfig (env_prefix NLP_) + 6 per-concern sub-configs
|   |   |-- batching.py          # micro-batching queues (bulk + interactive lanes)
|   |   |-- concurrency.py       # ResizableSemaphore — bounded concurrent forward passes
|   |   |-- device.py            # device resolution (cpu/auto/cuda/mps)
|   |   |-- effective_config.py  # control-plane pull client (nlp.* registry keys)
|   |   `-- internal_auth.py     # boot-time refusal when no internal token is configured in prod
|   |-- api/
|   |   |-- middleware/auth.py   # ServiceAuthMiddleware (X-Service-Token)
|   |   |-- tenant.py            # X-Tenant-Id header assertion helper
|   |   `-- v1/
|   |       |-- rest/            # classify, correct, diagnosis, extract, guard, models, monitoring
|   |       `-- ws/               # classify (real-time streaming classification)
|   |-- services/                 # text_classifier, token_classifier, medical_suggester, text_corrector,
|   |                              #   gliner2_guard, entailment_scorer, document_extractor, model_cache, ...
|   `-- schemas/                  # request/response pydantic models
|-- data/dictionaries/{en,ml}/    # SymSpell medical terminology dictionaries
|-- tests/                        # flat pytest layout (top-level, NOT src/nlp/tests)
|-- docs/                         # 01-06 numbered guides (see docs/README.md)
|-- Dockerfile
`-- pyproject.toml
```

There is no `env.example` in this directory; the generated env template is
`.env.sample` (see Configuration below).

## Commands

```bash
pnpm nlp:setup            # install this service into arcaenv (or :apple / :gpu / :cpu)
pnpm nlp:dev              # scripts/dev-service.sh nlp
pnpm nlp:dev:watch        # scoped reload
pnpm nlp:test             # pytest apps/nlp/tests/
pnpm nlp:test:cov         # with coverage
pnpm nlp:test:managed     # scripts/test-run.sh nlp (infra + app handled)
pnpm nlp:lint             # ruff
pnpm nlp:lint:fix
pnpm nlp:typecheck        # mypy
pnpm nlp:format           # black
pnpm nlp:format:check
```

There is no `pnpm nlp:test:unit`, `:integration` or `:e2e` — `tests/` is a
single flat suite (with a `tests/load/` subfolder for a throughput test), run
in full by `pnpm nlp:test`.

CI jobs: `test-nlp`, `build-nlp`.

## How it works

**Startup is factory-based**, unlike the other Python services here:
`main.py` calls `uvicorn.run("nlp.app:get_app", factory=True, lifespan="on")`
rather than importing a built `app` object. `get_app()` (`app.py`) asserts an
internal access token is configured before doing anything else (refuses to
start in production with none set; local dev logs an error and continues),
builds the `FastAPI` instance with `lifespan` from `lifespan.py`, adds
`ServiceAuthMiddleware` then CORS, mounts Prometheus, and includes
`api.api_router` (which nests `rest_api_router_v1` at `/api/v1` and
`ws_api_router_v1` at `/ws`).

**Settings are split into 7 `BaseSettings` classes**, each with its own
`env_prefix`:

| Class | `env_prefix` | Covers |
|---|---|---|
| `NLPServiceConfig` | `NLP_` | Host/port (`NLP_PORT`, default `8864`), OTel, inference batching/concurrency lanes, model cache size/TTL, `HF_HOME` (unprefixed alias) |
| `TextClassificationConfig` | `TEXT_CLASSIFIER_` | GPU toggle only — no model id |
| `TokenClassificationConfig` | `TOKEN_CLASSIFIER_` | GPU toggle only — no model id |
| `MedicalSuggesterConfig` | `MEDICAL_SUGGESTER_` | GPU toggle only — no model id |
| `SecurityConfig` | `SECURITY_` | CORS origins/methods/credentials |
| `TextCorrectorConfig` | `SPELLING_CORRECTOR_` | Dictionary path + SymSpell tuning |
| `ExternalTextConfig` | `NLP_EXTERNAL_TEXT_` | Peer-call timeout/retry to `apps/text`; the base URL itself is the repo-wide `TEXT_URL`, not a second `NLP_EXTERNAL_TEXT_BASE_URL` |

The internal service credential (`INTERNAL_ACCESS_TOKEN`, unprefixed,
accepted as inbound `X-Service-Token` and presented on outbound peer calls)
and `API_GATEWAY_KEY` (presented as `X-Internal-Service-Key` on gateway
`/internal/*` calls) are the same shared credentials every HOPE service uses
— see `00-project-context.md` §Environment Files.

**Inference is two lanes, not one queue.** A BULK lane
(`NLP_INFERENCE_BATCH_LINGER_MS` / `NLP_INFERENCE_BATCH_MAX_SIZE`) batches
async per-utterance classification; a separate INTERACTIVE lane
(`NLP_INFERENCE_INTERACTIVE_BATCH_LINGER_MS` / `_MAX_SIZE` /
`_QUEUE_MAX_DEPTH` / `_QUEUE_MAX_WAIT_SECONDS`) serves the synchronous inline
guard path with its own tighter SLO — the two never share a queue geometry,
so a slow bulk pass cannot stall a synchronous guard call. Outbound calls to
`apps/text` (the `/classify/topic` and `/classify/intent` delegation) get
their own concurrency bound (`NLP_PEER_CALL_MAX_CONCURRENT`), separate from
`NLP_INFERENCE_MAX_CONCURRENT`, so a slow HTTP round-trip cannot starve local
GPU/CPU inference or be starved by it. Most of these are bootstrap fallbacks
only — the runtime value is pulled from the control plane
(`nlp.*` registry keys) via `core/effective_config.py`.

**Device placement.** `NLP_INFERENCE_DEVICE` is `cpu` (safe everywhere),
`auto` (best device present), or an explicit `mps`/`cuda` that raises rather
than silently falling back if absent. `NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES`
force-pins specific submodules (default: `count_embed.gru`) to CPU even on an
accelerator — a documented runtime-compatibility fact about the installed
`gliner2`/torch build on MPS, not a policy choice.

**Guardrail-class inference lives here, not in `apps/guardrail`.**
`apps/guardrail` holds no resident model weights; it owns policy (label
taxonomy, thresholds, verdict shape, fail-closed posture) and delegates
inference to this service, which already owns NER/classification and the
model cache:

| Route | Backing model | Returns |
|---|---|---|
| `POST /api/v1/guard/pii` | GLiNER2 | Entity spans, byte-exact offsets |
| `POST /api/v1/guard/classify` | GLiNER2 | Multi-task safety moderation |
| `POST /api/v1/guard/entailment` | MiniCheck | Raw NLI support probabilities |

Every guard route receives its model id AND its label taxonomy from the
caller. Fail posture: a missing selection or taxonomy is 503 (fail-closed,
never a substituted default); a runtime failure is 503 (never an empty
result that reads as "nothing found"); an absent tenant is 428.

**Other REST endpoints**: `POST /api/v1/classify/text` (single-label),
`/classify/text/multi-label`, `/classify/tokens` (NER), `/classify/topic`,
`POST /api/v1/correct/text` (SymSpell-based, English + Malayalam
dictionaries), `POST /api/v1/diagnosis/suggestions`, `POST /api/v1/extract`
(document text extraction: PyMuPDF for PDF text layers, RapidOCR for scanned
pages/images — always returns 200, an unsupported/corrupt input yields an
empty extraction rather than a 5xx), and `GET /api/v1/internal/models/resolvable`
(the gateway readiness sweep's runtime resolvability probe).
`WS /ws/classify/token/{session_id}` and `/ws/classify/text/{session_id}`
serve real-time streaming classification.

**Inbound auth**: `ServiceAuthMiddleware` requires `X-Service-Token` on every
route except its exempt health/docs/metrics paths, using the same shared
`INTERNAL_ACCESS_TOKEN` as every other service.

**Health + metrics**: `GET /api/v1/health`, `/health/live`, `/health/ready`;
`GET /metrics` (Prometheus, gated on `NLP_METRICS_ENABLED`, default on).

## Configuration

`apps/nlp/.env.sample` is generated by `pnpm env:sync` — do not hand-edit it
or create a separate `env.example`; regenerate after changing a `Field`
declaration. It documents every knob above (commented out at its code
default) plus a few not covered here: `NLP_MODEL_CACHE_MAX_MODELS` /
`_TTL_SECONDS` (LRU model cache), `NLP_TORCH_NUM_THREADS` /
`_NUM_INTEROP_THREADS`, and `NLP_WARM_MODELS` (a scheduling lever only — a
request still names and resolves its own model; this only decides that
those weights are loaded before the first caller asks, and a control-plane
`warmModels` key wins over it on conflict).

## Gotchas

- `NLP_TORCH_NUM_THREADS=0` (auto) reads the **container's CFS quota**
  (`hope_env.cpu.effective_cpu_quota`), never `os.cpu_count()` — on a real
  pod that difference was 2 vs 48 allocatable CPUs and cost an 11.7x
  slowdown on BERT-base forward passes before this was fixed. This is
  configured from `nlp/__init__.py`, before any `torch` import, so it cannot
  be changed later in the process lifetime.
- `count_embed.gru` (a `gliner2` submodule) trips an MPS assertion that
  **aborts the process** rather than raising a catchable exception if it
  runs on `mps` — `NLP_INFERENCE_DEVICE_CPU_ONLY_MODULES` exists specifically
  to keep it off the accelerator.
- Text/token classification and medical suggestion have **no default
  model** — `TextClassificationConfig.model_name` etc. either come from the
  request or are the sentinel "unconfigured" value, so calling these routes
  without a resolved `model_name` fails closed rather than picking a model.
- There is no `pnpm nlp:test:unit`/`:integration`/`:e2e` split; `tests/` is
  one flat pytest suite.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — FastAPI service conventions, per-tenant config, peer-client rules
- [`01-development-workflow.md`](../../.claude/rules/01-development-workflow.md) — layer gates, test placement
- [`docs/README.md`](docs/README.md) — the numbered developer/API/model documentation set for this service
- [`apps/guardrail` README](../guardrail/README.md) — the policy layer that delegates inference here
- [`apps/api` README](../api/README.md) — the gateway that resolves models/agents and injects `model_name`
