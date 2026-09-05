# TASK-879 — The speech path becomes agent-first; the `tts.*` platform keys move to their real homes

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature |
| **Program** | TASK-870 wave 3a, lane A |
| **Branch** | `task-879-tts-agent-speech-path` |
| **Base** | `4923cac40` (= `dev-2.2` at wave-3a open) |
| **Merge target** | `dev-2.2` (orchestrator merges from the primary checkout) |

## Requirement Analysis

Three deliverables, one model.

1. **TEXT_TO_SPEECH agent resolution on the speech path.** Today the three gateway speech
   entry points resolve `TenantTtsConfig` — a per-tenant routing/voice/format row — and inject
   `routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings` into every `apps/tts`
   request. In the target model a capability is an AGENT: the tenant → department → SYSTEM
   `AgentAssignment` cascade selects a published `TEXT_TO_SPEECH` agent (the seeded SYSTEM
   `platform-tts`, kokoro / af_heart), an explicit `agentSlug` names one visible to the tenant
   (404-over-403 for a foreign one), and the resolved spec — agent identity, the bound model
   with its provider-native id and `_metadata`, the parameters, the provider connection with
   funding derived per row, and an ordered fallback chain — travels PER REQUEST, exactly as
   `ResolvedAsrSpec` does for `apps/stt`.
2. **Move the 18 `tts.*` keys, then delete them** (descriptor, reader, `Settings` field, env
   path, seed). Registry 277 → 259.
3. **Console**: `features/tenant-tts-config` loses its editor and becomes a read-only summary
   that links to the agents screen.

### The 18 keys and where each one goes

| Key | New home |
|---|---|
| `tts.defaultVoiceEn` | `Agent.parameters.voice` |
| `tts.limits.sampleRate` | `Agent.parameters.sampleRate` |
| `tts.sarvam.model` | the `sarvam-bulbul` `AiModel` row (`sourceUri` = `bulbul:v3`) |
| `tts.indicParler.hfModel` / `.modelPath` | `AiModel(indic-parler-tts).sourceUri` / `.localPath` |
| `tts.indicF5.hfModel` / `.modelPath` | `AiModel(indic-f5).sourceUri` / `.localPath` |
| `tts.indicParler.descEncoderPath` | `AiModel(indic-parler-tts)._metadata.artifacts.descEncoderPath` |
| `tts.indicF5.refAudioPath` / `.refText` | a `voices[]` entry (`TtsVoiceBinding`) on `AiModel(indic-f5)._metadata` |
| `tts.azure.region` | `AiProviderConnection(tts, azure).region` |
| `tts.sarvam.baseUrl` / `.timeoutS` | `AiProviderConnection(tts, sarvam).baseUrl` / `.timeoutS` |
| `tts.azure.enabled` / `tts.sarvam.enabled` | the SYSTEM `AiProviderConnection(tts, …).enabled` |
| `tts.kokoro.enabled` / `tts.parler.enabled` / `tts.indicf5.enabled` | NEW SYSTEM-only self-host provider ids (`kokoro`, `indic_parler`, `indic_f5`) in the tts provider vocabulary + seeded SYSTEM rows |

`tts.serviceToken`'s DESCRIPTOR is deliberately NOT deleted here — `platform-secrets.descriptors.ts`
is shared with lane E's `text.serviceToken` and the orchestrator deletes both together. This lane
retires the four `TTS_SERVICE_TOKEN` READERS in `apps/api/src/modules/speech/**`.

## Current State Evaluation

Verified against `4923cac40`:

- `apps/api/src/modules/speech/tts-tenant-config.ts:42` resolves `ITenantTtsConfigService.getEffective`
  + `IProviderConnectionService.resolveTenantCloudOverrides('tts', …)`; `tts-ws.gateway.ts:326`
  duplicates the same pair inline. `speech-proxy.controller.ts:109`, `harness-tts-internal.controller.ts:206`
  are the two other folds.
- `ITenantTtsConfigService` is ALREADY `@deprecated` ("replaced by a TTS Agent + `AgentAssignment`;
  do not add writers"). Its eleven effective fields map onto the agent/connection planes with no
  remainder: voice/format/speed/sampleRate → `Agent.parameters`; routing chains + `allowedProviders`
  + `sarvamPublicApiAllowed` → the agent's model chain and the connection rows' three-state `enabled`;
  `voiceBindings` → `AiModel._metadata.voices`; `maxInputChars` stays a platform key.
- `AiModel._metadata.voices` already exists on all four TTS catalogue rows; `_metadata.ttsProvider`
  already carries the engine id for `built-in` rows (`tenant-tts-config.service.ts:242`).
- `AgentModelFallback` is task-agnostic, so a TEXT_TO_SPEECH agent CAN carry a model chain — but
  `TEXT_TO_SPEECH_PARAMETERS` (`agent-schemas.ts:358`) declares no `fallback` block, so nothing
  could express the governance. Adding `fallback: fallbackProperty('TEXT_TO_SPEECH')` is what makes
  the chain sayable.
- `AzureSpeechConfig.api_key` / `SarvamConfig.api_key` have no env path at all
  (`validation_alias="…__ENV_REMOVED_TASK_602"`), so a boot-registered cloud engine is ALWAYS
  `is_configured=False` and the router already excludes it from candidates. `settings.azure.enabled`
  therefore gates the registration of an engine that can never serve from the platform tier — the
  only live path is the per-request override engine.
- `/health/ready` requires ≥ 1 registered provider, and `test_keyless_readiness_task642` pins that a
  keyless deployment reaches 200 with ZERO outbound sockets. Registration must stay boot-time and
  I/O-free.

## Implementation Plan

1. `packages/types/src/tts-spec.ts` — the wire contract (`ResolvedTtsSpec`), barrel line.
2. `packages/applications/src/services/agent/tts-spec.ts` — the PURE builder (no I/O, no DI).
3. `packages/applications/src/services/agent/tts-agent-resolver.service.ts` (+ its module) — the ONE
   resolution: assignment cascade / explicit slug → ordered chain → connection + credential.
4. `ai-provider-connection`: `timeoutS` on `ResolvedProviderConnection`; the SYSTEM-only self-host
   TTS provider vocabulary.
5. `tests/contracts/resolved-tts-spec.fixture.json` + the two-sided parity tests.
6. `agent-schemas.ts` — the `TEXT_TO_SPEECH` `fallback` block.
7. Seeds: `ai-models/tts.ts` (artifacts + voice bindings, the IndicF5 row), `17-ai-provider-connection.ts`
   (region / baseUrl / timeoutS on the SYSTEM cloud rows, three new self-host rows), `25-agents.ts`.
8. Descriptor removals + `registry.ts` + `seed/11d-tts-engine-flags.ts` + the parity test.
9. `apps/api/src/modules/speech/**` — agent-first folds, `internal.accessToken`.
10. `apps/tts` — the pydantic mirror, the spec-driven router, the config/control-plane removals.
11. Console demotion.

## Implementation Summary

_(filled as the lane lands)_

## Handoffs

_(filled as the lane lands)_

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded off `4923cac40`. |
