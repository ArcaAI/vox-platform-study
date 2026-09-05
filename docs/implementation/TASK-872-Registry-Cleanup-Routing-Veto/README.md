# TASK-872 — Settings-registry cleanup and routing-policy veto alignment

| | |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Program** | [TASK-870 — Configuration Governance](../TASK-870-Configuration-Governance-Program/README.md), wave 1 lane B |
| **Branch** | `task-872-registry-cleanup-routing-veto` |
| **Base** | `f3c91ca0c` (off `dev-2.2`) |
| **Merge target** | `dev-2.2` (merged by the orchestrator, not by this lane) |

## Requirement Analysis

Three independent pieces of work, all owned by the settings-registry / routing-policy surface.

1. **`globalOnly` flips (owner decisions #3, #7 + the graphExecutor amendment).** Six keys are
   catalogued as tenant-editable but, under the 2026-09-05 target model, are platform-only:
   guardrail is built-in and platform-only (no tenant admin manages any guardrail setting), and
   TEXT's per-tenant moderation posture is part of that guardrail plane. The realtime
   graph-executor gate is a platform ROLLOUT switch, so it stays `maxScope: 'tenant'` (a super
   admin rolls it out per tenant) but is not a tenant-editable key.
2. **The routing-policy veto.** `AiProviderConnection`'s three-state rule (absent = no opinion →
   SYSTEM; enabled = the tenant wins; disabled = a VETO in both tiers) is the platform's
   resolution contract, and `apps/guardrail` already implements it
   (`TenantSelectionVetoedError`). `AiRoutingPolicyService.resolveDefault` did not: a tenant's
   own elected row that had been parked (`enabled: false` or `resourceStatus: DISABLED`) was
   invisible to `findCandidates`, so the tenant tier read EMPTY and the resolver widened to
   SYSTEM with `source: 'system'` — serving the platform's model to a tenant that had explicitly
   switched its own selection off.
3. **Dead-descriptor removal.** The TASK-870 review established a set of registry descriptors
   that nothing reads. Removing them is behaviour-neutral by construction and shrinks the
   surface an admin console, a catalog endpoint and a governance test all have to carry.

## Current State Evaluation

The registry held **341** descriptors at the branch base and holds **286** at its head: 55
removed, none added. Nothing about the resolution machinery changed — no lane was added or
retired, and `EffectiveSettingsService.resolveEffective` dispatches exactly as before.

The removals fall into three honesty classes, and it is worth keeping them apart, because only
the first is the "pure cleanup" the ticket was scoped as:

| Class | What it means | Where it applies |
|---|---|---|
| **Unreachable** | No lane, no reader, no seed row consults the key. Removing it cannot change behaviour. | the 13 `guardrail.policy.*`, the 5 credentials, the 5 `models.*`, `nlp.serviceToken`, `guardrailV2.groundedness.enabled`, the 4 plan flags, most of the service-runtime and TTS knobs |
| **Reachable but shadowed** | A reader exists, but a higher-precedence source always supplies the value first. | the three `stt.vad.*` keys — `ResolvedAsrSpec` carries its own VAD parameters since TASK-861 |
| **Reachable, and the removal closes the path** | A reader exists and the control-plane value could reach it. Named individually below. | the three `stt.streaming.*` keys; the two `*.enabledDefault` keys |

Two proposed removals were **refused on evidence** and are documented in §Deviations.

## Implementation Plan

1. Part 1 — the six `globalOnly` flips + the tests that assert the old posture.
2. Part 2 — TDD the veto: `findCandidates({ includeParked })`, veto decided in
   `resolveDefault`, propagated by the `AiTaskDefaultService` facade, every caller checked.
3. Part 3 — the removals, one commit per descriptor family, each with the grep that proves the
   key has no remaining reference.
4. Regenerate the env artifacts (`pnpm env:python-surface`, `pnpm env:sync`) — descriptors of
   tier `env`/`vault-kv` feed `.env.sample` and `turbo.json#globalEnv`, and `env:sync --check`
   is a CI gate.

## Implementation Summary

### Part 1 — the `globalOnly` flips (`a0506a338`)

Six keys moved to platform-only. `SUPER_ADMIN_ONLY_TASK_KEYS` was emptied but deliberately
RETAINED as a mechanism: it expressed "a key-level lock inside an otherwise tenant-configurable
prefix", and owner decision #3 subsumed its two entries by locking the whole `guardrail.` prefix.
Re-deriving that mechanism later is not a one-line change; keeping the empty list is.

### Part 2 — a parked tenant row is a VETO, not an absence (`cb22d3b0a`)

`AiProviderConnection` fixes the platform's resolution vocabulary in three states, and
`resolveDefault` implemented two of them. `findCandidates` hard-filtered
`resourceStatus: ENABLED` + `enabled: true`, so a tenant that had switched its OWN elected
configuration off read as an EMPTY tenant tier — byte-identical to "never configured" — and the
resolver widened to SYSTEM with `source: 'system'` on the response to say everything was normal.
A tenant that says *"do not send our data to this model"* was answered with the platform's model.

The fix keeps the three states distinguishable end to end:

- `AiRoutingPolicyRepository.findCandidates` gains `includeParked`, which admits DISABLED /
  not-`enabled` rows instead of filtering them out at the SQL boundary. The default is unchanged,
  so no other caller's result set moves.
- `resolveDefault` inspects the tenant tier BEFORE widening. A parked row raises
  `TaskSelectionVetoedError` (`ai-routing-policy/task-selection-veto.ts`); only a genuinely empty
  tenant tier widens to SYSTEM.
- The `AiTaskDefaultService` facade propagates the veto rather than translating it into an
  absence, and `harness-policy.service.ts` — the one caller that swallowed a resolution failure —
  fails closed.

`TaskSelectionVetoedError` extends `ServiceUnavailableException` (503), deliberate parity with
guardrail's `TenantSelectionVetoedError`. This is NOT the 404-over-403 cross-tenant posture and
not a 4xx at all: the caller addressed its own tenant legitimately and asked a question the
configuration refuses to answer.

### Part 3 — the removals

**55 descriptors, in ten families.**

| Family | Count | Keys |
|---|---|---|
| `guardrail.policy.*` (`759e62855`) | 13 | the whole file, including `judgeTemperature` / `judgeMaxTokens` / `judgeTimeoutSeconds` |
| Service runtime (`2ffb7ec98`) | 8 | `{stt,nlp,guardrail,harness,tts}.modelCache.vramBudgetMb`, `guardrail.modelCache.{ttlSeconds,maxModels}`, `tts.modelCache.maxModels` |
| TTS runtime (`2ffb7ec98`) | 7 | `tts.azure.{timeoutS,maxConcurrent}`, `tts.sarvam.{sampleRate,maxConcurrent,useStreaming}`, `tts.kokoro.device`, `tts.limits.defaultFormat` |
| Credentials (`2ffb7ec98`) | 5 | `tts.credential.{azure,sarvam}`, `stt.credential.{azure-speech,sarvam,openai}` |
| `stt.fallback.*` (`2ffb7ec98`) | 3 | `pipelineSlug`, `autoSwitchEnabled`, `consecutiveFailureThreshold` |
| STT runtime (`1715c64d7`) | 6 | `stt.vad.{threshold,minSpeechDurationMs,minSilenceDurationMs}`, `stt.streaming.{batchWaitMs,embeddingDevice,multiGpuStrategy}` |
| Plan (`cf8c9d8ac`) | 4 | `entitlements.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess,featureGuardrailModelSelection}` |
| Seed-time + flags (`cf8c9d8ac`) | 3 | `entitlements.enabledDefault`, `metering.reconcile.enabledDefault`, `guardrailV2.groundedness.enabled` |
| Service token (`cf8c9d8ac`) | 1 | `nlp.serviceToken` |
| Dead `models.*` (`cf8c9d8ac`) | 5 | `models.{guardrail.pii.spans,nlp.classification,nlp.sentiment,nlp.toxicity,vlm.extract}` |

Also: `storage.platformDefault.forcePathStyle` keeps its key and loses `consumedBy: ['harness']`
(the harness never parses it off the pull route), and the stale `REGISTRATION POINT` banner left
`registry.ts` with the `guardrail.policy` commit.

#### `MODEL_CACHE_SERVICES` was doing two jobs, and they are now two constants

One `as const` list drove BOTH the retention-descriptor generator AND the gate in
`EffectiveConfigService.resolveModelWeights`. The two only ever agreed by coincidence — they
answer different questions: *"does this service expose cache-retention knobs"* and *"does this
service need to be told where its weights live"*. Dropping guardrail's three dead cache knobs
would therefore have silently stopped serving guardrail its `modelWeights` block, a real
behaviour change hiding inside a cleanup.

`MODEL_WEIGHT_SERVICES` is the split-out second list and still contains guardrail;
`MODEL_CACHE_SERVICES` no longer does. `model-retention.descriptors.test.ts` pins the difference
with a test that says why, so collapsing them back fails with a sentence rather than a diff.

Two consequences worth naming: `vramBudgetMb` also leaves `EffectiveRetention`, and guardrail now
receives NO `retention` group at all (the `if (!ttl) return {}` gate) — which is precisely what
every client already reads as "keep your own values". `apps/guardrail`'s matching `retention()`
accessor and its `_sources()` entry are deleted; both had zero callers.

#### The two `*.enabledDefault` keys — the only removal that changes a default

The brief's guard was: *if a seed reads the descriptor's `default` to seed a `GlobalSetting`
row, move that literal into the seed and keep the row seeded.* It does not apply.
`seed/15-entitlements.ts` reads `process.env.ENTITLEMENTS_ENABLED_DEFAULT` /
`METERING_RECONCILE_ENABLED_DEFAULT` as an explicit OVERRIDE over its own derived fallback
(`seedsEnforcementOn()` / `isDeployedEnvironment()`), never the descriptor. Seeding is unchanged,
the override still works from host env, and both names stay in `turbo.json#globalEnv` because
`env-sync` picks them up from that `process.env` read.

What the descriptors did do was emit `ENTITLEMENTS_ENABLED_DEFAULT=false` into the generated
`.env.sample` — and `pnpm setup:dev` copies that file to `.env.dev`. So the committed sample was
FORCING quota enforcement off on every laptop, against the 2026-08-22 owner decision that local
dev runs with enforcement ON (`seedsEnforcementOn()` returns true outside CI/test). A stale
declaration that beats the code it documents is worse than no declaration. After this change a
fresh `.env.dev` carries neither variable and the seed's own derived default applies.

`METERING_RECONCILE_ENABLED_DEFAULT` had no such effect: its fallback (`isDeployedEnvironment()`)
is already false locally, so the removed `=false` line agreed with the code.

#### Where the three judge keys go in wave 2

`guardrail.policy.judgeTemperature` / `judgeMaxTokens` / `judgeTimeoutSeconds` were removed with
their file, and the concepts are not lost:

- **`judgeTemperature` and `judgeMaxTokens` belong on `AiModel._metadata.policy`.** They shape a
  specific checkpoint's OUTPUT, so they are MODEL-COUPLED — the same argument that already puts
  `groundednessEntailmentThreshold` there. On a platform-scope settings key they would drift away
  from the model they calibrate the moment a selection changed.
- **`judgeTimeoutSeconds` becomes a new `guardrail.judge.timeoutSeconds`** (tier `global-kv`,
  `consumedBy: ['guardrail']`, served on the pull route) — but only once
  `apps/guardrail/src/guardrail/core/config.py:32-34` actually reads it. Registering it before
  the reader exists recreates exactly the defect this ticket removed.

### Verification

Test-specimen churn was unavoidable: several tests used a now-removed key as a stand-in for a
CLASS of behaviour. Each was retargeted onto a live key of the same class rather than deleted,
and each carries a comment saying what it used to run on and why the substitute is equivalent —
`minio.secretKey` for "a secret is refused", `entitlements.featurePlatformDefaultCredential` for
"the `entitlement` tier has no lane", `tts.defaultVoiceEn` for "a db-config key with no lane
raises", `voice_profile_min_similarity` / `vad_speech_pad_ms` for the STT control-plane overlay
mechanics, `tts.sarvam.timeoutS` / `tts.limits.maxInputChars` for the TTS ones.

One test title was corrected rather than preserved: `effective-settings.db-config.test.ts` said
"fails CLOSED … selection never falls back", but `failMode` is never consulted on that path — the
throw comes from having no resolution lane at all. The new title says what actually runs.

The bare `_size-probe.test.ts` scaffold was deleted, not converted. An exact registry-size
assertion fails on every unrelated descriptor addition and teaches people to bump a number; the
per-family ABSENCE assertions added here (no `db-secret` descriptor, no `vramBudgetMb`, no
`models.guardrail.pii.spans`, no seed-time-only companion) name what must not come back.

## Deviations from the removal list

Both are refusals, both on evidence found while doing the work, and both are reported to the
orchestrator rather than resolved unilaterally.

### 1. `text.serviceToken` and `tts.serviceToken` are KEPT (2 of the 3 proposed service tokens)

`vault-kv-coverage.test.ts` — a guard whose whole purpose is "read ⇒ declared" — failed on the
removal. The gateway still fetches both names through `SecretsService`:

```
apps/api/src/shared/base-proxy.controller.ts:68            getSecretSync('TEXT_SERVICE_TOKEN')
apps/api/src/modules/streaming/text-proxy.controller.ts:376   … after INTERNAL_ACCESS_TOKEN
apps/api/src/modules/text-compat/text-compat.controller.ts:915 … after INTERNAL_ACCESS_TOKEN
apps/api/src/modules/agent/agent.controller.ts:259         getSecretSync('TTS_SERVICE_TOKEN')
apps/api/src/modules/speech/speech-proxy.controller.ts:149 getSecretSync('TTS_SERVICE_TOKEN')
apps/api/src/modules/speech/tts-ws.gateway.ts:310          getSecretSync('TTS_SERVICE_TOKEN')
apps/api/src/modules/speech/harness-tts-internal.controller.ts:238  getSecretSync('TTS_SERVICE_TOKEN')
```

`scripts/vault-seed-secrets.sh` derives its key list FROM these descriptors, so removing one
stops Vault ever being seeded with that name — and the read then resolves to undefined on a
Vault-backed deployment while every `SECRETS_PROVIDER=env` dev box stays green. The four
`TTS_SERVICE_TOKEN` sites do not even prefer `INTERNAL_ACCESS_TOKEN` first. The READ has to be
retired before the descriptor can be; that is a proxy-controller change, not a registry one.

`nlp.serviceToken` IS removed: no gateway call site asks for `NLP_SERVICE_TOKEN` and no
`apps/nlp` pydantic field carries it.

### 2. The five dead `models.*` task keys stay in `AI_TASK_KEYS`, with their seed rows

Only the DESCRIPTORS were removed, via a documented `UNCATALOGUED_TASK_KEYS` list in
`model-defaults.descriptors.ts` (so `META` stays exhaustive over what remains). The task keys
themselves are `AiRoutingPolicy` vocabulary with a much wider blast radius than the registry:

- they are an enum in `apps/api/openapi.json` and both admin-console API-doc copies;
- they are mirrored in `apps/admin-console/src/shared/catalog/ai-task-keys.ts`;
- `guardrail.pii.spans` and `nlp.classification` have seeded SYSTEM elections pinned by
  `seed/__tests__/ai-model-consolidation-seed.test.ts`;
- `vlm.extract`, `nlp.sentiment` and `nlp.toxicity` are recorded in the seed's own
  `SYSTEM_TASK_DEFAULT_EXEMPTIONS` as OPEN OWNER DECISIONS, with the reason each is unselected.

Retiring them means the five-artifact regeneration chain (`api:build`, `route-manifest`,
`openapi`, `portal`, `vox-node gen:admin`) plus the console catalog plus deleting a recorded
decision the owner has not made. That is a routing-domain ticket, not a registry cleanup.

The descriptor removal itself is safe and evidenced: guardrail resolves `guardrail.pii` and only
that (`core/dependencies.py` → `TASK_KEY_GUARDRAIL_PII`); the `.spans` variant has no reader
anywhere, `nlp.classification`'s own seed comment calls it "an explicitly DISABLED placeholder
… (fails closed)", and the other three are the exemptions above.

## Open items for the orchestrator

1. **`stt.streaming.{batchWaitMs,embeddingDevice,multiGpuStrategy}` — not strictly
   behaviour-neutral.** `apps/stt/src/stt/streaming/execution_profile.py:377-387` reads those
   three `Settings` fields as overrides on the detected hardware profile, and their env path is
   already closed by `moved_alias`. With the control-plane mapping gone the fields can only ever
   hold their code default, so those three override branches become unreachable. Deleting them
   belongs to `streaming/**`, which this lane does not own. Either finish the retirement there,
   or restore the three descriptors.
2. **`env:sync --check` was already red at `f3c91ca0c`.** The regeneration commit picks up nine
   pre-existing additions (`DATABASE_ENABLED`, `TTS_KOKORO_MODEL_PATH__MOVED_TO_CONTROL_PLANE`
   and seven `*__ENV_REMOVED` alias names) for fields this ticket never touched.
3. **The two deviations above** need an owner call on whether to open follow-ups.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded. |
| 2026-09-05 | Part 1 landed (`a0506a338`): six `globalOnly` flips; `SUPER_ADMIN_ONLY_TASK_KEYS` emptied but retained as a mechanism. |
| 2026-09-05 | Part 2 landed (`cb22d3b0a`): `TaskSelectionVetoedError`, `findCandidates({ includeParked })`, `resolveDefault` decides the veto before widening, `harness-policy.service.ts` fails closed. |
| 2026-09-05 | Part 3, first family (`759e62855`): the 13 `guardrail.policy.*` descriptors; tighten-only floor tests re-anchored on locally registered descriptors; `REGISTRATION POINT` banner dropped. |
| 2026-09-05 | Part 3 (`2ffb7ec98`): service-runtime, TTS-runtime, credential and `stt.fallback` families (23 keys); `MODEL_CACHE_SERVICES` split from `MODEL_WEIGHT_SERVICES`; guardrail's dead `retention()` accessor deleted. |
| 2026-09-05 | Part 3 (`1715c64d7`): the six shadowed `stt.vad.*` / `stt.streaming.*` descriptors and their control-plane mappings. |
| 2026-09-05 | Part 3 (`cf8c9d8ac`): plan, seed-time, feature-flag, `nlp.serviceToken` and dead `models.*` families (13 keys); `forcePathStyle` loses `consumedBy`; two removals refused on evidence (see §Deviations). |
| 2026-09-05 | Step 4 (`97c462c9f`): `pnpm env:python-surface` + `pnpm env:sync` regenerated; registry 341 → 286. |
