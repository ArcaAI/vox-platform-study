# API Gateway B08b — Internal Module

Companion explainer for `api-gateway-b08b-internal-misc.html`.

## Scope
`B08b` completes `B08-billing-internal-misc`: `internal` module — **20 routes / 8 controllers** (reconciled from `inventory/modules.json`). All controllers are internal/service-to-service surfaces (`@ApiExcludeController`). Repo @ `8cb2e5e8e6bbddf5ee7c676782ebb5ad683c23a0`.

## Endpoint groups

| Group | Controllers/routes | Guard/auth evidence | Downstream |
|---|---|---|---|
| Internal agent/model/config | `AgentInternalController` (`/internal/agents`), `AgentVersionInternalController`, `ComposedPromptInternalController` (`/internal/composed-prompts`), `EffectiveConfigController` (`/internal/effective-config`), `ModelRegistryInternalController` (`/internal`), `ModelServingInternalController` (`/internal/models`, `GET :slug/serving-spec`) | Most use `@Public` + `InternalServiceTokenGuard` + `InternalTenantLockGuard` (evidenced per controller) | Agent/model/config state; internal callers (harness/NLP/serving) |
| Internal STT callbacks/ops | `SttInternalController` (`/internal/stt`, 12 routes): transcripts, segments, streaming usage, job start/progress/complete/fail/status, audio-records, media, model-registry-credential, provider-overrides | `@ApiExcludeController` + `@UseGuards(InternalTenantLockGuard)` evidenced; **verify full token/auth mechanism** (not assumed identical to other internal controllers) | STT/transcript/job/media state; media/provider integrations |
| Internal STT session transcript | `SttSessionTranscriptInternalController` (`/internal/stt/sessions/:sessionId/transcript`) | `@Public` + `HarnessServiceTokenGuard` + `InternalTenantLockGuard` (evidenced) | STT session transcript state |

## Example input/output (representative)
- **Agent/model/config internal:** service-to-service requests (model serving spec, registry lookups, effective config, agent/version/composed prompt ops) -> internal config/model/agent payloads. Verify DTOs and caller identities.
- **STT internal:** POST transcripts/segments/audio-records/media, PATCH job lifecycle, GET job status/provider overrides/model-registry-credential -> persisted STT/job/media state and provider/config payloads.
- **STT session transcript:** `GET /internal/stt/sessions/:sessionId/transcript` with internal auth + tenant context -> transcript payload. Verify tenant scoping and PHI handling.

## Security / validation / limitations
- **Sensitive/internal-only:** all controllers are excluded from public API docs; most use service token + tenant lock patterns. `SttInternalController` auth pattern differs from the `@Public`+service-token pattern shown on others — **verify its full auth/token mechanism before relying on this summary**.
- Archify finalize **pass** (`validate/deliver/check/browser-check`). Browser evidence pass; visual review not requested.
- Advisory route readability: 3 crossings / 3 detours (gates pass; expected due to bidirectional internal caller/handler relationships). Position-only repair optional.
- Limitations: grouped endpoint nodes (20 routes/8 controllers); per-controller service wiring and exact DTO/security semantics not fully enumerated; reconcile with implementation/OpenAPI-internal inventory before treating contracts as stable.
