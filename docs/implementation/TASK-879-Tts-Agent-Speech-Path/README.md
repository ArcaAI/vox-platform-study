# TASK-879 — The speech path becomes agent-first; the `tts.*` platform keys move to their real homes

| | |
|---|---|
| **Status** | Review (implementation complete, gates green; awaiting the orchestrator merge) |
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

Landed in 18 commits on `task-879-tts-agent-speech-path`. 83 files, +5415 / −3148.

### 1. The speech path is agent-first

The contract is `ResolvedTtsSpec` (`packages/types/src/tts-spec.ts`) — the ASR spec's model/agent
blocks with the TEXT lane's ORDERED, funding-gated fallback chain. It is produced by one pure
builder (`services/agent/tts-spec.ts`) and one resolver (`TtsAgentResolverService`), and travels
PER REQUEST from the gateway to `apps/tts`, exactly as `ResolvedAsrSpec` does for `apps/stt`.

`TtsAgentResolverService` mirrors both precedents rather than inventing a third shape:

* explicit `agentSlug` → a PUBLISHED, ACTIVE `TEXT_TO_SPEECH` agent visible to the tenant, else
  the `AgentAssignment` cascade `department → tenant → SYSTEM` — both through `AgentResolverService`,
  which owns the 404-over-403 posture;
* the ORDERED chain: `parameters.fallback.agentSlug` when named (`fallback-agent`), else the
  agent's own `AgentModelFallback` chain (`fallback-model`), and ALWAYS the SYSTEM-assigned agent
  as the terminal `platform-default` unless the primary already is it. A fallback that will not
  resolve DEGRADES to the next option;
* `autoSwitch` is emitted EFFECTIVE (`effectiveAutoSwitch`, shared with the TEXT lane): a tenant
  may disable HA only for a primary it FUNDS;
* every candidate carries the non-secret `AiProviderConnection` facts (endpoint, region, timeout)
  with funding DERIVED from the tier that supplied the row; credentials ride BESIDE the spec as
  `provider_overrides`, never on it.

`AgentModelFallback` was always task-agnostic, but `TEXT_TO_SPEECH_PARAMETERS` declared no
`fallback` block — so an operator could bind a fallback engine and nothing could read the switch.
The block is now declared (no `switchAfterConsecutiveFailures`: synthesis is per-request and keeps
no cross-call state a threshold could count).

Cross-language parity is locked the ASR way: `tests/contracts/resolved-tts-spec.fixture.json`
(three cases) validated by BOTH `tests/contracts/resolved-tts-spec-parity.contract.test.ts` and
`apps/tts/src/tts/tests/unit/test_resolved_spec_parity.py`.

**Four gateway entry points** now resolve the agent and push the spec:
`speech-proxy.controller.ts` (with an optional `agentSlug` selector, stripped before forwarding),
`tts-ws.gateway.ts` (init-frame enrichment), `harness-tts-internal.controller.ts`, and
`agent.controller.ts#speech` (which calls `resolveFromAgent` — it has already resolved the agent,
and resolving twice could pick a different version between the two reads).

The HTTP folds FAIL CLOSED: there is no service-side default left to degrade to, so an
unresolvable agent surfaces as the 404/409 it is instead of an opaque downstream 503. The socket
still opens and ends in a `provider_unavailable` error frame, because every rejection on that
handshake is deliberately byte-identical — refusing it would report an agent-configuration problem
as an authentication failure.

### 2. `apps/tts` executes the spec instead of resolving selection

`routing/router.py` takes a spec and walks `candidate_chain`. Every filter above the circuit
breaker is a GATEWAY decision read verbatim (the funding-gated `autoSwitch`, the enabled
connection row, the voice each candidate can speak); the breaker is the one exclusion that is
genuinely local. `SpeechRequest.resolved_spec` and the WS `init.resolved_spec` are REQUIRED;
`routing_en` / `routing_ml` / `allowed_providers` / `voice_bindings` are gone.

Each of the five adapters gained `from_spec` — the ONE factory that turns a resolved candidate
into a request-scoped engine — and `from_override` was retired: a candidate carries the model,
mirror, artifacts, endpoint and region as well as the credential, so two factories would only have
been two places to get a tenant's engine wrong. Engines are cached by WHAT THEY LOAD AND
AUTHENTICATE TO, so a resident model stays resident and two tenants never share one.

Registration became IMAGE-driven: every engine the image can import registers at boot (that is the
honest answer to "what does this process contain"), and whether an engine may be ROUTED to is the
connection row. Three properties are preserved and pinned: boot does no I/O, a missing optional
image extra is logged rather than raised, and readiness still distinguishes healthy from
awaiting-credentials.

**Three defects the rewrite exposed and closed** (each has a test):

| Defect | Why it mattered | Fix |
|---|---|---|
| An engine the image does not contain raised `ProviderNotFoundError` out of the router | `[indic-parler]` is an optional image variant, so an agent naming it on a pod without it is a routing fact — exactly what the chain exists to survive — not a 500 | `_engine_for` returns `None`; the chain walks past it and records nothing against that engine's breaker |
| A keyless CLOUD engine could be handed a session | `candidates()` used to filter on `is_configured`; when registration stopped gating, nothing did. A boot-registered Azure with an empty key would have failed on the first sentence | the `is_configured` check moved to `_engine_for`, the one place engines are now obtained |
| The duplex path answered `ready` before knowing an engine could be built | a `ready` followed by a first-sentence failure is a worse answer than an up-front error | `stream()` resolves buildability eagerly (cheap and cached) |

### 3. The 18 keys, moved and deleted

Registry **277 → 259**, asserted by `tts-key-removal.task879.test.ts` (each key absent, the
surviving `tts.*` set exact, the count exact). `tts.descriptors.ts` was deleted entirely — there
is no per-tenant tts settings surface left; what a tenant owns is its AGENT and its BYO connection
row. `tts-runtime.descriptors.ts` keeps four process-level knobs (two `*_DEVICE`, the request
ceiling, the boot strategy).

The five `*_ENABLED` flags were the one HALF-migrated family in the service: served by the control
plane AND still env-readable, because closing the env path needed the k8s ConfigMaps in
`arca/hope-v2-deployment` to stop setting `TTS_KOKORO_ENABLED` first — and doing it in the wrong
order put `hope-tts` back to answering 503 with no Service endpoints. **This lane dissolved that
coupling instead of sequencing it**: "may this engine serve" is a connection row's three-state
`enabled`, so there is no key, no variable and no manifest left to coordinate, and
`ENV_BOOTSTRAP_KEYS` is now empty. `seed/11d-tts-engine-flags.ts` went with them.

| Key | New home | Reader replaced | Proof |
|---|---|---|---|
| `tts.defaultVoiceEn` | `Agent.parameters.voice` | `tenant-tts-config.service.ts` fold at `speech-proxy.controller.ts:109` (was) | `tts-spec.test.ts` "selects the binding the agent named"; fixture `platformDefault` |
| `tts.limits.sampleRate` | `Agent.parameters.sampleRate` | `router.py:335` / `speech.py:140` `settings.sample_rate` | `test_router.py::test_the_sample_rate_comes_from_the_candidate` + `…gets_the_one_code_default` |
| `tts.sarvam.model` | `AiModel(sarvam-bulbul).sourceUri` | `config.py` `SarvamConfig.model` (now empty + dead alias) | `sarvam.py#from_spec`; `test_router_uses_sarvam_when_the_agent_binds_it` |
| `tts.indicParler.hfModel` | `AiModel(indic-parler-tts).sourceUri` | `indic_parler.py:_resolve_model_source` | `test_parler_provider.py::test_model_source_comes_from_the_registry_row_not_a_hardcoded_default` |
| `tts.indicParler.modelPath` | `AiModel(indic-parler-tts).localPath` | `indic_parler.py:_resolve_model_source` | `test_the_mirror_and_the_description_tokenizer_come_from_the_row_too` |
| `tts.indicParler.descEncoderPath` | `AiModel._metadata.artifacts.descEncoderPath` | `indic_parler.py:_resolve_desc_source` | same test; fixture `tenantAgentWithCloudFallback` carries the artifact |
| `tts.indicF5.hfModel` / `.modelPath` | `AiModel(indic-f5).sourceUri` / `.localPath` | `indic_f5.py:140` | `indic_f5.py#from_spec` (see DEFERRED below — the row is retired) |
| `tts.indicF5.refAudioPath` / `.refText` | a `voices[]` entry (`TtsVoiceBinding`) selected by `Agent.parameters.voice` | `indic_f5.py:142-143` | `indic_f5.py#from_spec` REFUSES a clone voice with no reference; `tts-spec.test.ts` normalises the fields |
| `tts.azure.region` | `AiProviderConnection(tts, azure).region` | `main.py:88`, `azure_speech.py:_config.region` | `test_config.py::test_region_is_row_owned_not_env_sourced` + `…refused_rather_than_defaulted` |
| `tts.sarvam.baseUrl` / `.timeoutS` | `AiProviderConnection(tts, sarvam).baseUrl` / `.timeoutS` | `config.py` `SarvamConfig` | `sarvam.py#from_spec`; `config-plane-seed.test.ts` pins the seeded values |
| `tts.azure.enabled` / `tts.sarvam.enabled` | the SYSTEM connection row's `enabled` | `main.py:83` / `:96` | `test_task799_control_plane.py::TestProviderEnableFlagsAreGone` |
| `tts.kokoro.enabled` / `tts.parler.enabled` / `tts.indicf5.enabled` | NEW SYSTEM-only self-host provider ids + seeded rows | `main.py:109-153` | `config-plane-seed.test.ts::seeds the three TTS in-process engines…`; `spec.py#routable` |

`timeoutS` was added to `ResolvedProviderConnection` — a ceiling the row carried but the resolver
dropped. `PLATFORM_SELF_HOST_PROVIDERS` (`ai-provider-connection/constants.ts`) declares the
SYSTEM-only serving engines; `PLATFORM_INPROCESS_ENGINE_CONNECTIONS` in the seed classifies them
as a THIRD class — they take no `not-needed` placeholder key, because an in-process engine
authenticates to nothing and an entry in the `provider_overrides` fold would be an override for an
engine with no override path.

`tts.serviceToken`'s DESCRIPTOR is untouched by design (shared with lane E's `text.serviceToken`);
its four readers now prefer `INTERNAL_ACCESS_TOKEN` with `TTS_SERVICE_TOKEN` as the migration
fallback only.

### 4. Console

`features/tenant-tts-config` lost its editor (`tts-config-form`, `voice-bindings-editor`,
`tts-config-fields`, `usePutTtsRow`, the row and catalog reads) and became a read-only summary
with links to `/agents?task=TEXT_TO_SPEECH`, the assignments screen and `/ai-providers`. The form
is gone rather than disabled: it wrote a row nothing reads, so an operator would change a value,
see it saved, and hear no difference. The summary stays for the deprecation window so the old row
is legible while it is migrated.

## Gate output

```
$ pnpm tts:test          412 passed, 3 skipped, 2 deselected      (baseline 459)
$ pnpm tts:lint          All checks passed!
$ pnpm tts:typecheck     Success: no issues found in 41 source files
$ pnpm --filter @arcaai/types build       tsc --build            (clean)
$ pnpm --filter @arcaai/types typecheck   tsc --noEmit           (clean)
$ pnpm --filter @arcaai/applications build   rimraf dist && tsc  (clean)
$ npx vitest run packages/applications tests/contracts
    Test Files  680 passed | 1 skipped (681)
    Tests       11795 passed | 4 skipped (11799)
$ pnpm --filter @arcaai/applications lint    ✖ 217 problems (0 errors, 217 warnings)
$ npx tsc --noEmit -p apps/api/tsconfig.json   (clean)
$ npx vitest run apps/api
    Test Files  278 passed (278)
    Tests       4207 passed (4207)
$ pnpm --filter @arcaai/api lint          ✖ 70 problems (5 errors, 65 warnings)
$ npx vitest run packages/database
    Test Files  2 failed | 77 passed (79)
    Tests       8 failed | 1762 passed (1770)
$ pnpm --filter @arcaai/admin-console build   (clean)
$ pnpm --filter @arcaai/admin-console lint    eslint src --max-warnings 0   (clean)
$ pnpm --filter @arcaai/admin-console test
    Test Files  258 passed (258)
    Tests       2270 passed (2270)
```

**Reconciled counts.**

* `tts:test` 459 → 412 (−47). Two files were DELETED because the behaviour they pinned no longer
  exists: `test_task799_tts_enable_flags.py` (8 test functions, four of them parametrized over the
  five engines — the half-migrated env/control-plane precedence rule) and
  `test_voice_bindings_override.py` (12, the gateway-injected voice-binding merge). Their
  parametrised expansion is the bulk of the −47. Against that, `test_resolved_spec_parity.py` is
  new (10 collected) and the changed files are net +11 test functions — chiefly `test_router.py`
  25 → 32 (the absent-engine and keyless-cloud classes) and `test_task799_control_plane.py`
  23 → 25.
* `applications` 11795. This lane ADDS 59 cases across four suites — 18 pure-builder, 13 resolver,
  20 removal-assertion, 8 contract-parity — and removes the 8-case
  `tts-engine-flag-seed-parity.test.ts`, so +51 net. The wave-2 close recorded 11559 on its own
  merged tree; the remainder is `dev-2.2`'s drift between that measurement and this lane's base
  (`4923cac40`), which was not separately measured here.
* `apps/api` 4214 → 4207. The speech and agent suites were rebuilt around the resolver: the
  `TenantTtsConfig` fold cases (voice-binding injection ×2, provider-override injection ×2, the
  fail-open case ×2 across the proxy and the socket) and one stale override assertion went;
  five agent-shaped cases replaced them.
* `admin-console` 2269 → 2270 = +1 (the read-only Voice-tab assertion).
* `database` 8 failed = EXACTLY the pre-existing set the program README attributes to TASK-869's
  36th catalogue row (`ai-model-registry-seed.test.ts` ×4, `task-863-agents.test.ts` ×4). No
  assertion in either file touches a row this lane changed.
* `apps/api` lint 5 errors = EXACTLY the pre-existing set (`harness-gate.spec.ts`,
  `shared-component-contracts.spec.ts`, `auth-throttle-per-endpoint.spec.ts` — TASK-869/875). My
  two prettier errors in `agent.controller.ts` were fixed.
* `applications` lint 0 errors (the 217 warnings are `eslint-plugin-only-warn` prettier noise
  across the package; none in a file this lane wrote — checked by name).

## Handoffs

| # | What | Where | Why it is not in this lane |
|---|---|---|---|
| H1 | Regenerate the env artifacts (`env:python-surface` THEN `env:sync`) | `turbo.json`, `.env.sample`, `apps/tts/.env.sample`, `env-surface.generated.md`, `scripts/generated/python-env-surface.json` | Generated artifacts; the lane is barred from running the generators. 18 `TTS_*` variables are now unread and will drop out. |
| H2 | Delete the `['TTS_KOKORO_ENABLED', 'true', …]` row from `PYTHON_LOCAL_DEV_VALUES` | `scripts/env-sync.mts:177` | `scripts/**` is a shared surface the orchestrator recently swept. The row is INERT today (it is a lookup by field name and the field no longer exists), so nothing breaks meanwhile — but it documents a knob that is gone. |
| H3 | Delete the `tts.serviceToken` descriptor | `descriptors/platform-secrets.descriptors.ts` | Shared with lane E's `text.serviceToken`; the orchestrator makes the two-line edit once BOTH lanes' gateway readers are retired. This lane retired all four TTS readers. |
| H4 | Purge the orphaned `GlobalSetting` rows for the five deleted engine flags | a `DELETE` in the orchestrator's 3a schema-retirement migration | The registry no longer declares the keys, so the rows are unreachable; they are litter rather than drift, but a seeded environment will keep them until they are deleted. |
| H5 | The five-artifact regeneration | `api:route-manifest`, `api:openapi`, `api:portal`, `gen:admin` | `HarnessSynthesizeSpeechRequest` gained `agentSlug` and made `voice` optional; the `speech/synthesize` body gained `agentSlug`. The lane is barred from running the generators. |
| H6 | `docs/operations/tts-model-mirror/README.md` names `TTS_PARLER_MODEL_PATH` / `TTS_PARLER_DESC_ENCODER_PATH` as the way to point at a mirror | `docs/operations/**` | Outside the lane's ownership. The runbook is now wrong in ONE respect: the mirror path is `AiModel.localPath` and the tokenizer path is `_metadata.artifacts.descEncoderPath`. `apps/tts/scripts/mirror_parler_weights.py` prints the same two variable names at the end of a mirror run. |

### Edits made OUTSIDE the ownership column (disclosed)

Each was forced by a change inside it; none is owned by another 3a lane.

| File | Change | Why it could not wait |
|---|---|---|
| `apps/api/src/modules/agent/agent.controller.ts` + `agent.module.ts` + its test | the FIFTH `TenantTtsConfig` fold and the FOURTH `TTS_SERVICE_TOKEN` reader | `POST /agents/:slug/speech` would have 422'd the moment `resolved_spec` became required. The brief said "four sites in the speech module"; there are three there and one here. |
| `apps/api/src/modules/settings-catalog/__tests__/settings-catalog.controller.test.ts` | tenant-editable specimen `tts.defaultVoiceEn` → `rateLimit.maxRequests` | the specimen key was deleted by this lane. |
| `packages/applications/src/services/settings-registry/{registry.ts,index.ts}` | dropped the `TTS_SETTINGS` import/spread/export | the file it imported was deleted (the brief anticipated this). |
| `packages/applications/src/services/settings-registry/__tests__/{effective-settings.db-config,fail-mode.governance}.test.ts` | re-anchored two specimens | both named removed keys. The db-config "no lane" specimen now uses a resolver that claims nothing, so the next family retirement cannot break it again. |
| `packages/database/src/prisma/db_main/seed/{11d-tts-engine-flags.ts,index.ts}` | deleted the seed and its call | the five keys it seeds no longer exist in the registry. |

## Deferred (with the exact seam)

| # | What | Seam |
|---|---|---|
| D1 | **`TenantTtsConfig` is fully redundant and is NOT deleted.** All eleven effective fields map onto the agent/connection planes with no remainder, and nothing in any runtime reads the row any more. | Retirement = drop the Prisma model + its domain trio + `CoreDatabaseModule` registration, delete `packages/applications/src/services/tenant-tts-config/**` and `apps/api/src/modules/tenant-tts-config/**`, delete the `svc:admin:tenant-tts-config:manage` scope and the `TenantTtsConfig` CASL subject, delete the console feature, and regenerate the five artifacts. Out of this lane's ownership (`packages/domains/**`, the scope registry) and larger than the brief; the routes were already `@ApiDeprecated(removeIn: 'R3')` before this lane. What this lane did instead: retired every READER, and demoted the console to read-only. |
| D2 | **`AiModel(indic-f5)` is not re-seeded**, so `tts.indicF5.{hfModel,modelPath,refAudioPath,refText}` have a declared home and no row. | The engine is deliberately retired (`seed/ai-models/retired.ts`) on unresolved CC-BY-NC provenance, and re-adding it would contradict TASK-860's catalogue AND break the pinned "exactly 35 SYSTEM rows" test. The SHAPE is delivered end to end (`TtsSpecModel.artifacts`, `TtsVoiceBinding.refAudioPath/refText`, `IndicF5Provider.from_spec`), so restoring the row later needs no contract change. Belt and braces: its SYSTEM connection row is seeded DISABLED. |
| D3 | `apps/tts/src/tts/catalog/voices.py` (`DEFAULT_VOICES` + `VoiceCatalog`) survives for the `/voices` listing endpoint and boot warm-up ONLY. | The synthesis path no longer consults it. Retiring it means replacing `GET /api/v1/voices` with a registry-derived listing — a gateway change, not a service one, and not asked for here. |
| D4 | `black --check apps/tts/src/` reports 20 files needing reformatting — **on the untouched baseline too** (verified). | Pre-existing; `tts:format` is a mutation and is not in this lane's gate list. |

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded off `4923cac40`. |
| 2026-09-06 | Implementation complete in 18 commits. `ResolvedTtsSpec` + the pure builder + `TtsAgentResolverService` + the two-sided contract fixture; the `TEXT_TO_SPEECH` fallback block; the connection-row seeds that replace the five engine flags; the 18 descriptors deleted (registry 277 → 259); `apps/tts` rewritten to execute the pushed spec (three latent defects closed on the way); the four gateway entry points and the console. All gates green against the pre-attributed baselines. |
