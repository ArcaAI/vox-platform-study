# tts — Text-to-Speech Service

**Owner**: Platform / Voice · **Introduced**: TASK-488 · **Last verified**: 2026-07-21

Realtime, multi-provider text-to-speech for the HOPE platform (English + Malayalam).
Cloud and self-hosted engines sit behind one provider abstraction with per-locale
fallback chains; the service is stateless and per-tenant behaviour is resolved by
the NestJS gateway and injected per request.

- **Port:** 8865
- **Package:** `tts` (src-layout under `src/`)
- **Gateway:** browsers never call this service directly. The NestJS gateway
  proxies `POST /api/v1/speech/synthesize` → `/api/v1/audio/speech`,
  `GET /api/v1/speech/voices` → `/api/v1/voices`, and the WS gateway
  `/ws/tts/stream` → `/api/v1/audio/stream`, injecting `X-Service-Token`.

## Providers

Registered in `create_app()` / lifespan, each gated by its own `enabled` flag
(`src/tts/providers/`). Cloud providers register at boot; local engines
register unconditionally and load weights on the first synth request, then release
on an idle TTL (TASK-529 lazy lifecycle — see `docs/operations/inference/model-retention.md`).

| Provider                   | Key            | Kind                      | Locale(s)            | Notes                                                                                                                                                                                                    |
| -------------------------- | -------------- | ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Speech            | `azure`        | cloud (managed)           | en, ml               | Primary managed path; shares the stt Azure Speech credential                                                                                                                                             |
| Sarvam Bulbul              | `sarvam`       | cloud                     | ml (code-switch), en | `bulbul:v3`; public API is NOT PHI-safe — point `base_url` at an enterprise VPC/on-prem host before real patient data (TASK-493)                                                                         |
| Kokoro                     | `kokoro`       | self-hosted               | en                   | Local English engine                                                                                                                                                                                     |
| AI4Bharat Indic Parler-TTS | `indic_parler` | self-hosted               | ml                   | Loads from an ungated local mirror in prod (TASK-495)                                                                                                                                                    |
| AI4Bharat IndicF5          | `indic_f5`     | self-hosted (voice-clone) | ml                   | **EXPERIMENTAL, gated OFF** — prod/commercial enablement is NO-GO pending license review (CC-BY-NC base weights; TASK-494). The gate is the SYSTEM `AiProviderConnection(tts, indic_f5)` row, seeded DISABLED: enabling it is a SUPER_ADMIN write with an audit trail |

Routing: an ORDERED CHAIN OF CANDIDATES, first healthy wins, resolved by the
gateway and pushed with every request as a `ResolvedTtsSpec` (TASK-879). This
service reads no selection of its own: which engine speaks, in which voice, from
which weights, and whether it may serve at all are the tenant's TEXT_TO_SPEECH
AGENT (`AgentAssignment` cascade or an explicit `agentSlug`), the `AiModel` row
it binds, and the `AiProviderConnection` row that serves each engine. A request
with no spec is REFUSED (422); a spec whose candidates are all unroutable fails
CLOSED (503, `TtsRoutingUnconfiguredError`) — never a substituted vendor.

`routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings` are GONE
with the `TenantTtsConfig` fold that produced them.

Registration is IMAGE-driven, not config-driven: every engine this image can
import is registered at boot (registration says what the PROCESS contains), and
whether an engine may be ROUTED to is the connection row's three-state `enabled`,
resolved per request. The five `TTS_*_ENABLED` flags are gone.

## Endpoints

All under the `/api/v1` prefix (Swagger at `/api/v1/docs`).

| Method | Path                                     | Purpose                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/audio/speech`                          | OpenAI-compatible synthesis. `input`/`voice`/`response_format`/`speed` mirror OpenAI Create speech, plus `stream_format`: unset → full audio (batch); `"audio"` → chunked raw audio bytes; `"sse"` → `speech.audio.delta` (base64) + `speech.audio.done` events |
| `WS`   | `/audio/stream`                          | WS-duplex streaming (TASK-492): incremental text frames in (`init`/`text`/`flush`/`end`), binary PCM (s16le/mono) frames out — audio starts after the first sentence. `init` is validated up front; errors are generic/PHI-safe                                 |
| `GET`  | `/voices`                                | Voice catalog: stable internal voice IDs, locale, and bound providers                                                                                                                                                                                           |
| `GET`  | `/health` `/health/live` `/health/ready` | Liveness / readiness                                                                                                                                                                                                                                            |
| `GET`  | `/metrics`                               | Prometheus metrics (unprefixed)                                                                                                                                                                                                                                 |

Both synthesis surfaces REQUIRE the gateway-resolved agent (TASK-879):
`resolved_spec` (the engine chain, the bound model with its mirror, artifacts and
voices, the provider connections, and the funding-gated fallback governance) and,
BESIDE it, `provider_overrides` — the decrypted BYO credentials. Credentials never
travel on the spec: it is a document a caller might persist or log.

`voice` is OPTIONAL on both; absent means the agent's own `parameters.voice`. A
voice the resolved model does not declare is a 404, never a substitution.

## Layout

```
src/tts/
├── main.py                    # create_app() + lifespan (provider registration, retention client)
├── core/
│   ├── config.py              # pydantic-settings (Settings + per-provider sub-configs)
│   ├── effective_config.py    # control-plane pull client for local-engine retention (TASK-535)
│   ├── audio.py · metrics.py · logging.py · dependencies.py
├── spec.py                    # ResolvedTtsSpec — the pydantic mirror of the gateway contract (TASK-879)
├── providers/                 # azure_speech · sarvam · kokoro · indic_parler · indic_f5 · base (ProviderRegistry) · registration
│                              #   every adapter declares `from_spec` — the ONE factory that turns a
│                              #   resolved candidate into a request-scoped engine
├── routing/                   # router (executes the spec's chain + circuit breaker) · chunking · sentence_adapter · circuit_breaker
├── catalog/voices.py          # VoiceCatalog — the `/voices` listing and boot warm-up ONLY; the
│                              #   synthesis path takes its voices from the spec's bound model
├── api/
│   ├── middleware/auth.py     # ServiceAuthMiddleware (X-Service-Token, constant-time)
│   └── endpoints/             # speech · stream_ws · voices · health
└── tests/                     # pytest (in-package, unit/)
```

## Configuration

Root env prefix `TTS_`; each provider sub-config carries its own prefix
(`TTS_AZURE_`, `TTS_SARVAM_`, `TTS_KOKORO_`, `TTS_PARLER_`, `TTS_INDICF5_`).

The table below is nearly everything this service still reads from the
environment, and that is the point: TASK-879 moved every model id, mirror path,
artifact path, endpoint, region, timeout, voice and engine flag onto the row that
owns it — the `AiModel`, its `AiProviderConnection`, or the Agent — where it is
resolved per request. What remains is the process itself (port, tokens,
transport) plus the three knobs a DEPLOYMENT genuinely answers once: the request
ceiling, the boot strategy, and where an engine loads (`*_DEVICE`). A field whose
value moved carries a dead `validation_alias` naming the variable it used to
read, so an operator grepping for it lands on something that says where it went.

| Variable                      | Description                                                                                        | Default                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| `TTS_PORT` (`port`)           | Service port                                                                                       | `8865`                         |
| `TTS_SERVICE_TOKEN`           | Inter-service auth (empty = auth disabled for local dev)                                           | —                              |
| `TTS_MAX_INPUT_CHARS`         | Max synthesis input length                                                                         | `4096`                         |
| `TTS_PARLER_DEVICE` / `TTS_INDICF5_DEVICE` | Torch device the engine loads onto — a property of the POD, not of the model row      | `cpu`                          |
| `TTS_WARMUP_ENABLED`          | Load local-engine weights at boot instead of first request (fail-at-boot)                          | `false`                        |
| `TTS_GATEWAY_URL`             | Control-plane bootstrap transport for retention config (TASK-535)                                  | `http://localhost:8868/api/v1` |
| `TTS_MODEL_CACHE_TTL_SECONDS` | Idle TTL for local-engine weights (bootstrap fallback; runtime value comes from the control plane) | `600`                          |

## Develop

```bash
pnpm tts:dev            # uvicorn on :8865 (conda arcaenv)
pnpm tts:dev:watch      # + reload
pnpm tts:test        # pytest (src/tts/tests/)
pnpm tts:test:unit   # unit only
pnpm tts:test:cov    # with coverage
pnpm tts:lint        # ruff
pnpm tts:format      # black
pnpm tts:typecheck   # mypy
```
