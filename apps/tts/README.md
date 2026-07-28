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
| AI4Bharat IndicF5          | `indic_f5`     | self-hosted (voice-clone) | ml                   | **EXPERIMENTAL, gated OFF** — prod/commercial enablement is NO-GO pending license review (CC-BY-NC base weights; TASK-494). Never set `TTS_INDICF5_ENABLED=true` in production without written clearance |

Routing: per-locale ordered fallback chains, first healthy wins. As of TASK-577
there is no env-configured default chain — `routing_en`/`routing_ml` are
DB-sourced (the SYSTEM `TenantTtsConfig` default, built-in-first: `kokoro` /
`indic_parler`), resolved by the gateway and injected per request; the router
fails CLOSED (503, `TtsRoutingUnconfiguredError`) if the gateway injects no
chain. The gateway can also override the provider whitelist, per-tenant BYO
credentials, and voice bindings per request.

## Endpoints

All under the `/api/v1` prefix (Swagger at `/api/v1/docs`).

| Method | Path                                     | Purpose                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/audio/speech`                          | OpenAI-compatible synthesis. `input`/`voice`/`response_format`/`speed` mirror OpenAI Create speech, plus `stream_format`: unset → full audio (batch); `"audio"` → chunked raw audio bytes; `"sse"` → `speech.audio.delta` (base64) + `speech.audio.done` events |
| `WS`   | `/audio/stream`                          | WS-duplex streaming (TASK-492): incremental text frames in (`init`/`text`/`flush`/`end`), binary PCM (s16le/mono) frames out — audio starts after the first sentence. `init` is validated up front; errors are generic/PHI-safe                                 |
| `GET`  | `/voices`                                | Voice catalog: stable internal voice IDs, locale, and bound providers                                                                                                                                                                                           |
| `GET`  | `/health` `/health/live` `/health/ready` | Liveness / readiness                                                                                                                                                                                                                                            |
| `GET`  | `/metrics`                               | Prometheus metrics (unprefixed)                                                                                                                                                                                                                                 |

Per-request tenant overrides accepted on both synthesis surfaces (gateway-injected
from the tenant's resolved config): `routing_en` / `routing_ml`,
`allowed_providers`, `provider_overrides` (decrypted BYO credentials, TASK-496),
and `voice_bindings` (`{internalVoiceId: {provider: voiceName}}`, TASK-506 —
merged over the catalog's default bindings).

## Layout

```
src/tts/
├── main.py                    # create_app() + lifespan (provider registration, retention client)
├── core/
│   ├── config.py              # pydantic-settings (Settings + per-provider sub-configs)
│   ├── effective_config.py    # control-plane pull client for local-engine retention (TASK-535)
│   ├── audio.py · metrics.py · logging.py · dependencies.py
├── providers/                 # azure_speech · sarvam · kokoro · indic_parler · indic_f5 · base (ProviderRegistry) · registration
├── routing/                   # router (fallback chains + circuit breaker) · chunking · sentence_adapter · circuit_breaker
├── catalog/voices.py          # VoiceCatalog: internal voice IDs → per-provider bindings
├── api/
│   ├── middleware/auth.py     # ServiceAuthMiddleware (X-Service-Token, constant-time)
│   └── endpoints/             # speech · stream_ws · voices · health
└── tests/                     # pytest (in-package, unit/)
```

## Configuration

Root env prefix `TTS_`; each provider sub-config carries its own prefix
(`TTS_AZURE_`, `TTS_SARVAM_`, `TTS_KOKORO_`, `TTS_PARLER_`, `TTS_INDICF5_`). The
Azure credential falls back to the shared `AZURE_SPEECH_KEY` /
`AZURE_SPEECH_REGION` already used by stt.

| Variable                      | Description                                                                                        | Default                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| `TTS_PORT` (`port`)           | Service port                                                                                       | `8865`                         |
| `TTS_SERVICE_TOKEN`           | Inter-service auth (empty = auth disabled for local dev)                                           | —                              |
| `TTS_MAX_INPUT_CHARS`         | Max synthesis input length                                                                         | `4096`                         |
| `TTS_SAMPLE_RATE`             | PCM sample rate                                                                                    | `24000`                        |
| `TTS_<PROVIDER>_ENABLED`      | Per-provider enable flag (makes the provider AVAILABLE — does not select it; see Routing above)    | `false`                        |
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
