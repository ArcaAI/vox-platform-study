# Traceability — Text-to-Speech (TTS)

Multi-provider text-to-speech: the stateless `apps/tts-v2` synthesis service, the gateway
`speech` proxy that fronts it, and the DB-backed per-tenant TTS configuration + BYO
provider-credential plane (TASK-488 / TASK-496). This entire domain had **zero rows** in
the legacy matrix (the former `apps/tts` service and its `tts.contract.test.ts` were
removed in TASK-414; the new `apps/tts-v2` was never added back) — the TASK-538 Wave-1 P0
gap.

Route paths are relative to the global prefix `/api/v1`. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture: the gateway resolves a tenant's effective TTS spec (tenant row merged over
the SYSTEM-tenant platform default, clamped to platform limits) and injects it into the
**stateless** `apps/tts-v2` per request — the Python service never touches Postgres.
BYO provider keys are Vault-Transit ciphertext at rest, decrypted only at injection time.

## Capabilities

### T1 — Speech synthesis service (`apps/tts-v2`)

| Field | Value |
|---|---|
| App / service | `apps/tts-v2` (`tts_v2`, port 8865) — multi-provider (Azure Speech + local Kokoro / Indic Parler / IndicF5 + Sarvam), en + ml |
| Endpoints (mounted `prefix="/api/v1"` in `main.py`) | `POST /api/v1/audio/speech` (`api/endpoints/speech.py`, OpenAI-compatible); `GET /api/v1/voices` (`api/endpoints/voices.py`); WS `/api/v1/audio/stream` (`api/endpoints/stream_ws.py`); `GET /api/v1/health*` (`api/endpoints/health.py`) |
| Auth | `X-Service-Token` middleware (`api/middleware/auth.py`), empty token = dev bypass; health/docs/metrics exempt |
| Prisma models | — (stateless; effective spec injected by the gateway per request) |
| Tests | py(tts): `unit/test_speech_endpoint.py`, `unit/test_stream_ws.py`, `unit/test_voice_bindings_override.py`, `unit/test_catalog.py`, `unit/test_effective_config_retention.py`, `unit/test_router.py`, `unit/test_chunking.py`, `unit/test_audio.py`, provider suites (`test_azure_provider.py`, `test_kokoro_provider.py`, `test_parler_provider.py`, `test_indic_f5_provider.py`, `test_sarvam_provider.py`), `unit/test_auth_middleware.py`, `unit/test_health.py` |

### T2 — Gateway speech proxy (browser-facing TTS)

| Field | Value |
|---|---|
| App / service | `apps/api` fronts `apps/tts-v2` (browsers never call the Python service directly) |
| Key modules | `apps/api/src/modules/speech` (`speech-proxy.controller.ts`, `tts-ws.gateway.ts`, `speech.module.ts`) |
| Prisma models | — (proxy; resolves the effective spec via T3's service, injects `X-Service-Token`) |
| Key API endpoints | `@Controller('speech')` → `POST /speech/synthesize`, `GET /speech/voices`; WS gateway `@WebSocketGateway({ path: '/ws/tts-v2/stream' })` → WS `/ws/tts-v2/stream` |
| Console | consumed by the playground (`apps/admin-console` playground surfaces) |
| Tests | unit(api): `speech/__tests__/speech-proxy.controller.test.ts`, `speech/__tests__/tts-ws.gateway.test.ts`; e2e: `task-488-speech.spec.ts` |

### T3 — Per-tenant TTS config + BYO provider credentials (TASK-496)

| Field | Value |
|---|---|
| App / service | `apps/api` + Vault (BYO key encryption) |
| Key modules | `apps/api/src/modules/tenant-tts-config` (`tenant-tts-config-admin.controller.ts`, `tenant-tts-config.module.ts`); `packages/applications/src/services/tenant-tts-config` (`TenantTtsConfigService` — `getEffective`/`getRow`/`upsertRow`/`getPlatformCatalog`/`getCredentials`/`setCredential`/`removeCredential`) |
| Prisma models | `TenantTtsConfig` (one row per tenant, `tenantId @unique`; SYSTEM-tenant row = platform default), `TenantTtsProviderCredential` (per-(tenant, provider) BYO key — Vault-Transit ciphertext `encryptedApiKey` + `keyVersion`; `@@unique([tenantId, provider])`). Both in `db_main/tenant-tts-config.prisma`. `TenantTtsProviderCredential` is deliberately **non-OCC** (no `_version` strip) per rule 03 |
| Key API endpoints | `@Controller('admin/tts-config')`: `GET ''` (resolved effective spec), `GET row`, `PUT row` (create/CAS under `If-Match`; `@RequiresIfMatch()`, drift → 412, missing → 428), `GET catalog` (platform providers+voices from the `AiModel` registry), `GET credentials` (masked), `PUT credentials/:provider` (write-only key, Vault-encrypted, never returned), `DELETE credentials/:provider` (204) |
| Auth | `@Authorize()` class-level; per-route `read`/`manage` `TenantTtsConfig`. Tenant admins pinned to CLS tenant; global-admins act cross-tenant (incl. SYSTEM platform default) via `?tenantId=` |
| Console | `apps/admin-console` feature `tenant-tts-config` (`tenant-tts-config-screen.tsx`, `tts-config-form.tsx`, `tts-credentials-tab.tsx`, `voice-bindings-editor.tsx`); route `/tts-config` (tier 30–49, tenant-scoped) |
| Tests | unit(app): `tenant-tts-config/__tests__/tenant-tts-config.service.test.ts`, `tenant-tts-config/__tests__/platform-limits.test.ts`; unit(api): `tenant-tts-config/__tests__/tenant-tts-config-admin.controller.test.ts`; unit(console): `tenant-tts-config/components/__tests__/tenant-tts-config-screen.test.tsx`; e2e: `—` (no dedicated TTS-config e2e spec; live-DB / Vault-live BYO round-trips are env-gated per the TASK-496 ticket) |

## Honest notes / gaps

- **No TTS-config e2e.** T3 has unit coverage at service / controller / console layers but no `apps/api/tests/e2e` spec exercising the tenant-config CRUD or BYO-credential round-trip against a live DB + Vault. The TASK-496 ticket records these as env-gated (live-DB e2e, Vault-live BYO, browser-WS).
- **The audit's "test / directory-credentials / sync" routes are NOT on `tenant-tts-config`.** The TASK-538 Wave-1 audit description attributed those to this module; the code has no such routes here. Those routes exist on `tenant-idp-config` and are recorded in [`auth-identity.md`](./auth-identity.md) (capability I3).
- **Infra/creds-gated verification** (Docker/k3s deploy, live Azure key, GPU local weights, human-audio quality, live Azure text-stream) is tracked in the TASK-488 ticket, not here.

Last verified: 2026-07-21
