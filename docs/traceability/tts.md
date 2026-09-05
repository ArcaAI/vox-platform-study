# Traceability — Text-to-Speech (TTS)

Multi-provider text-to-speech: the stateless `apps/tts` synthesis service, the gateway
`speech` proxy that fronts it, and the DB-backed per-tenant TTS configuration + BYO
provider-credential plane. This entire domain had **zero rows** in
the legacy matrix (the former `apps/tts` service and its `tts.contract.test.ts` were
removed, and the new `apps/tts` was never added back) — an earlier audit flagged this
as a P0 gap.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture: the gateway resolves a tenant's effective TTS spec (tenant row merged over
the SYSTEM-tenant platform default, clamped to platform limits) and injects it into the
**stateless** `apps/tts` per request — the Python service never touches Postgres.
BYO provider keys are Vault-Transit ciphertext at rest, decrypted only at injection time.

## Capabilities

### T1 — Speech synthesis service (`apps/tts`)

| Field | Value |
|---|---|
| App / service | `apps/tts` (`tts`, port 8865) — multi-provider (Azure Speech + local Kokoro / Indic Parler / IndicF5 + Sarvam), en + ml |
| Endpoints (mounted `prefix="/api/v1"` in `main.py`) | `POST /api/v1/audio/speech` (`api/endpoints/speech.py`, OpenAI-compatible); `GET /api/v1/voices` (`api/endpoints/voices.py`); WS `/api/v1/audio/stream` (`api/endpoints/stream_ws.py`); `GET /api/v1/health*` (`api/endpoints/health.py`) |
| Auth | `X-Service-Token` middleware (`api/middleware/auth.py`), empty token = dev bypass; health/docs/metrics exempt |
| Prisma models | — (stateless; effective spec injected by the gateway per request) |
| Tests | py(tts): `unit/test_speech_endpoint.py`, `unit/test_stream_ws.py`, `unit/test_voice_bindings_override.py`, `unit/test_catalog.py`, `unit/test_effective_config_retention.py`, `unit/test_router.py`, `unit/test_chunking.py`, `unit/test_audio.py`, provider suites (`test_azure_provider.py`, `test_kokoro_provider.py`, `test_parler_provider.py`, `test_indic_f5_provider.py`, `test_sarvam_provider.py`), `unit/test_auth_middleware.py`, `unit/test_health.py` |

### T2 — Gateway speech proxy (browser-facing TTS)

| Field | Value |
|---|---|
| App / service | `apps/api` fronts `apps/tts` (browsers never call the Python service directly) |
| Key modules | `apps/api/src/modules/speech` (`speech-proxy.controller.ts`, `tts-ws.gateway.ts`, `speech.module.ts`) |
| Prisma models | — (proxy; resolves the effective spec via T3's service, injects `X-Service-Token`) |
| Key API endpoints | `@Controller('speech')` → `POST /speech/synthesize`, `GET /speech/voices`; WS gateway `@WebSocketGateway({ path: '/ws/tts/stream' })` → WS `/ws/tts/stream` |
| Console | consumed by the playground (`apps/admin-console` playground surfaces) |
| Tests | unit(api): `speech/__tests__/speech-proxy.controller.test.ts`, `speech/__tests__/tts-ws.gateway.test.ts`; e2e: `speech-proxy-auth.spec.ts` |

### T3 — Per-tenant TTS selection + BYO provider credentials

RETIRED as a config surface of its own. `TenantTtsProviderCredential` was folded
into `AiProviderConnection(service='tts')` (TASK-862), and `TenantTtsConfig` — the
per-tenant spec row, its service, its `admin/tts-config` routes, its
`admin:tenant-tts-config:manage` scope and its console feature — was dropped
outright by TASK-888 once TASK-879 had made the speech path agent-first.

| Field | Value |
|---|---|
| App / service | `apps/api` + Vault (BYO key encryption) |
| Key modules | `packages/applications/src/services/agent/tts-agent-resolver.service.ts` + `tts-spec.ts` (resolve the tenant's TEXT_TO_SPEECH `Agent` through the `AgentAssignment` cascade and build a `ResolvedTtsSpec`); `packages/applications/src/services/ai-provider-connection` (the credential fold) |
| Prisma models | `Agent` / `AgentModelFallback` / `AgentAssignment` (the selection), `AiModel` (`_metadata.voices`, `artifacts`), `AiProviderConnection` (`service='tts'`, Vault-Transit `encryptedApiKey` + `keyVersion`) |
| Key API endpoints | the agent surface (`admin/agents/**`) and `admin/providers/**`; there is no `admin/tts-config` any more |
| Auth | `@CanManage('Agent')` on the agent surface; provider connections carry their own two 403 boundaries (see `development-patterns-and-standards.md` §BYO provider credentials) |
| Console | `/agents?task=TEXT_TO_SPEECH` and `/ai-providers`; `/ai-configuration`'s Voice tab is now only the way through to them |
| Tests | unit(app): `agent/__tests__/tts-agent-resolver.service.test.ts`; contract: `tests/contracts/resolved-tts-spec-parity.contract.test.ts` + `resolved-tts-spec.fixture.json`; unit(api): `speech/__tests__/speech-proxy.controller.test.ts` |

## Honest notes / gaps

- **No TTS BYO-credential e2e.** T3 has unit and contract coverage but no `apps/api/tests/e2e` spec exercising a BYO-credential round-trip against a live DB + Vault. These round-trips are env-gated (live-DB e2e, Vault-live BYO, browser-WS).
- **The audit's "test / directory-credentials / sync" routes were never on `tenant-tts-config`.** An earlier audit attributed those to that module; they live on `tenant-idp-config` and are recorded in [`auth-identity.md`](./auth-identity.md) (capability I3).
- **Infra/creds-gated verification** (Docker/k3s deploy, live Azure key, GPU local weights, human-audio quality, live Azure text-stream) is tracked with the TTS service rollout work, not here.

Last verified: 2026-09-06 (T3 rewritten for the agent-first speech path)
