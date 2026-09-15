# tts — text-to-speech service

Python/FastAPI service (port **8865**, package `tts`, src-layout) providing
realtime, multi-provider text-to-speech for the HOPE platform (English +
Malayalam). Cloud and self-hosted engines sit behind one provider
abstraction with per-locale fallback chains; the service is stateless and
per-tenant behaviour is resolved by the gateway and injected per request.
Browsers never call it directly — the gateway proxies
`POST /api/v1/speech/synthesize` -> `/api/v1/audio/speech`,
`GET /api/v1/speech/voices` -> `/api/v1/voices`, and `/ws/tts/stream` ->
`/api/v1/audio/stream`, injecting `X-Service-Token`.

## Layout

```
src/tts/
|-- main.py                    # create_app() + lifespan (provider registration, retention client)
|-- core/
|   |-- config.py               # Settings (env_prefix TTS_) + per-provider sub-configs
|   |-- control_plane.py        # Settings field -> control-plane registry key map (moved_alias)
|   |-- effective_config.py     # control-plane pull client for local-engine retention
|   `-- audio.py | metrics.py | logging.py | dependencies.py
|-- spec.py                     # ResolvedTtsSpec — the pydantic mirror of the gateway contract
|-- providers/                  # azure_speech, sarvam, kokoro, indic_parler, indic_f5, base (ProviderRegistry), registration
|                                #   every adapter declares from_spec() — the factory turning a
|                                #   resolved candidate into a request-scoped engine
|-- routing/                    # router (executes the spec's chain + circuit breaker), chunking, sentence_adapter
|-- catalog/voices.py           # VoiceCatalog — the /voices listing + boot warm-up only
|-- api/
|   |-- middleware/auth.py      # ServiceAuthMiddleware (X-Service-Token, constant-time)
|   `-- endpoints/              # speech, stream_ws, voices, health, models, providers
`-- tests/unit/                 # pytest (in-package)
```

## Commands

```bash
pnpm tts:setup          # install this service into arcaenv (or :apple / :gpu / :cpu)
pnpm tts:dev            # uvicorn on :8865 (conda arcaenv)
pnpm tts:dev:watch      # + reload
pnpm tts:test           # pytest apps/tts/src/tts/tests/
pnpm tts:test:unit      # unit only
pnpm tts:test:cov       # with coverage
pnpm tts:test:managed   # scripts/test-run.sh tts (infra + app handled)
pnpm tts:lint           # ruff
pnpm tts:lint:fix
pnpm tts:typecheck      # mypy
pnpm tts:format         # black
pnpm tts:format:check
```

There is no `pnpm tts:test:integration`/`:e2e` split.

## How it works

**Providers register unconditionally at boot** (`create_app()`/lifespan, each
adapter in `src/tts/providers/`). Cloud providers register at boot; local
engines register unconditionally too but load weights on the first synth
request and release them on an idle TTL (lazy lifecycle). Whether an engine
may be **routed** to is a separate question, answered per request by its
`AiProviderConnection(tts, <engine>).enabled` row — registration says what
the process contains, routing says what a tenant may reach.

| Provider | Key | Kind | Locale(s) | Notes |
|---|---|---|---|---|
| Azure AI Speech | `azure` | cloud (managed) | en, ml | Primary managed path; shares the STT Azure Speech credential |
| Sarvam Bulbul | `sarvam` | cloud | ml (code-switch), en | `bulbul:v3`; the public API is NOT PHI-safe — point `base_url` at an enterprise/on-prem host before real patient data |
| Kokoro | `kokoro` | self-hosted | en | Local English engine |
| AI4Bharat Indic Parler-TTS | `indic_parler` | self-hosted | ml | Loads from an ungated local mirror in prod |
| AI4Bharat IndicF5 | `indic_f5` | self-hosted (voice-clone) | ml | Experimental, gated off — the SYSTEM `AiProviderConnection(tts, indic_f5)` row is seeded DISABLED; enabling it is a SUPER_ADMIN write with an audit trail |

**Routing is an ordered chain of candidates, first healthy wins**, resolved
by the gateway and pushed with every request as a `ResolvedTtsSpec`
(`spec.py`). This service reads no selection of its own: which engine
speaks, in which voice, from which weights, and whether it may serve at all
are the tenant's `TEXT_TO_SPEECH` agent (`AgentAssignment` cascade or an
explicit `agentSlug`), the `AiModel` row it binds, and the
`AiProviderConnection` row serving each engine. A request with no spec is
refused (422); a spec whose candidates are all unroutable fails closed (503,
`TtsRoutingUnconfiguredError`) — never a substituted vendor.

**Both synthesis surfaces require the gateway-resolved agent**:
`resolved_spec` (the engine chain, the bound model with its mirror, artifacts
and voices, the provider connections, and funding-gated fallback governance)
and, beside it, `provider_overrides` — the decrypted BYO credentials.
Credentials never travel on the spec, since it is a document a caller might
persist or log. `voice` is optional on both; absent means the agent's own
`parameters.voice`. A voice the resolved model does not declare is a 404,
never a substitution.

**Config is almost entirely control-plane-owned, not env.** Root `Settings`
carries `env_prefix="TTS_"`; each provider sub-config carries its own
(`TTS_AZURE_`, `TTS_SARVAM_`, `TTS_KOKORO_`, `TTS_PARLER_`, `TTS_INDICF5_`).
Every model id, mirror path, artifact path, endpoint, region, timeout, voice
and per-engine flag was moved onto the row that owns it (the `AiModel`, its
`AiProviderConnection`, or the Agent). Several fields that look like process
settings are *also* now control-plane-owned — declared with a
`moved_alias(...)` dead env alias (e.g. `TTS_MAX_INPUT_CHARS`,
`TTS_WARMUP_ENABLED`, `TTS_MODEL_CACHE_TTL_SECONDS`, `TTS_KOKORO_DEVICE`,
`TTS_PARLER_DEVICE`, `TTS_INDICF5_DEVICE`) — the bare env var no longer binds,
and the served value comes from the gateway's effective-config route
(`core/effective_config.py`), pulled at boot and kept fresh by a Redis
pub/sub invalidation channel. A field whose value moved carries the dead
alias precisely so an operator grepping for the old variable name lands on
something that says where it went.

What remains genuinely settable from the environment: `TTS_PORT` (`8865`),
`TTS_HOST`, `TTS_GATEWAY_URL` (bootstrap transport for the control-plane
pull), `TTS_REDIS_URL` (control-plane invalidation subscription only — this
does not make the service stateful; it reads no keys and writes none),
`TTS_CORS_ENABLED`/`TTS_CORS_ORIGINS`, `TTS_METRICS_ENABLED`,
`TTS_OTEL_*`, `TTS_LOG_LEVEL`, `TTS_DEBUG`, and the shared
`INTERNAL_ACCESS_TOKEN`/`API_GATEWAY_KEY` credentials every service uses.

**Inbound auth.** `ServiceAuthMiddleware` requires `X-Service-Token`,
constant-time compare, health/docs/metrics exempt. The accepted credential is
the single shared `INTERNAL_ACCESS_TOKEN`; the old per-service
`TTS_SERVICE_TOKEN` is **retired** — there is now exactly one credential, so
there is nothing to fall back to.

## Endpoints

All under the `/api/v1` prefix (Swagger at `/api/v1/docs`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/audio/speech` | OpenAI-compatible synthesis. `input`/`voice`/`response_format`/`speed` mirror OpenAI Create speech, plus `stream_format`: unset -> full audio (batch); `"audio"` -> chunked raw audio bytes; `"sse"` -> `speech.audio.delta` (base64) + `speech.audio.done` events |
| `WS` | `/audio/stream` | WS-duplex streaming: incremental text frames in (`init`/`text`/`flush`/`end`), binary PCM (s16le/mono) frames out — audio starts after the first sentence. `init` is validated up front; errors are generic/PHI-safe |
| `GET` | `/voices` | Voice catalog: stable internal voice IDs, locale, and bound providers |
| `GET` | `/health` `/health/live` `/health/ready` | Liveness / readiness |
| `GET` | `/metrics` | Prometheus metrics (unprefixed) |

## Gotchas

- `TTS_SERVICE_TOKEN` no longer exists — only `INTERNAL_ACCESS_TOKEN` is
  accepted. Setting the old variable has no effect.
- `TTS_PARLER_DEVICE`, `TTS_INDICF5_DEVICE`, `TTS_KOKORO_DEVICE`,
  `TTS_MAX_INPUT_CHARS`, `TTS_WARMUP_ENABLED` and
  `TTS_MODEL_CACHE_TTL_SECONDS` are declared as `Settings` fields but their
  env path is closed (`moved_alias`) — setting them in an env file changes
  nothing; use the control plane.
- `routing_en`/`routing_ml`/`allowed_providers`/`voice_bindings` and the five
  `TTS_*_ENABLED` provider flags are gone; do not reintroduce them.
- The `indic_f5` provider is registered (the image can import it) but its
  SYSTEM connection row is seeded DISABLED — a 503 from that engine is
  expected until a SUPER_ADMIN enables it, not a bug.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — FastAPI service conventions, control-plane pull pattern
- [`01-development-workflow.md`](../../.claude/rules/01-development-workflow.md) — layer gates, test placement
- [`docs/operations/inference/model-retention.md`](../../docs/operations/inference/model-retention.md) — lazy-load / idle-TTL lifecycle for local engines
- [`apps/api` README](../api/README.md) — the gateway that resolves the spec and proxies these routes
- [`apps/stt` README](../stt/README.md) — shares the Azure Speech credential and the same control-plane pull pattern
