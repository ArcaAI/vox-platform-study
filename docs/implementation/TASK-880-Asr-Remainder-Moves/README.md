# TASK-880 — the ASR remainder: the last `stt.*` platform keys move to the agent, the model row, or the provider connection

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor |
| **Program** | TASK-870 Configuration Governance, wave 3a lane B |
| **Branch** | `task-880-asr-remainder-moves` (worktree `hope-v2-task-880`) |
| **Base** | `4923cac40` off `dev-2.2` |
| **Merge target** | `dev-2.2` — merged by the orchestrator, not by this lane |

## Requirement Analysis

The owner's model (TASK-870 §Requirement Analysis, points 6 and 7): the tenant's **agent** owns
every per-session behaviour; **model-coupled facts** ride the `AiModel` row; **connection facts**
ride the `AiProviderConnection` row (SYSTEM = platform fallback, tenant = BYO, disabled = veto).
A platform settings key survives only when it is genuinely a platform-PROCESS knob with no tenant
or agent opinion, and a redundant key is removed **completely** — descriptor, `Settings` field,
control-plane map entry, reader, env path — never dual-homed.

Twelve `stt.*` keys still fail that test. Registry 277 → **265**.

| Key | New home |
|---|---|
| `stt.whisperCpp.consultationPromptEnabled` | the agent's `instruction.initialPrompt` |
| `stt.vad.modelPath` | `AiModel(VOICE_ACTIVITY_DETECTION).localPath` (already on the spec) |
| `stt.vad.speechPadMs` | agent `audioFrontEnd.vad.speechPadMs` → `AsrSpecVad.speech_pad_ms` |
| `stt.transcription.chunkLengthS` / `.strideLengthS` | agent `decoding.{chunkLengthSec,strideLengthSec}` |
| `stt.whisperCpp.maxAudioSeconds` | `AiModel._metadata.asr.maxDecodeWindowSec` |
| `stt.streaming.partialWindowS` | `AiModel._metadata.asr.partialWindowSec` |
| `stt.azureSpeech.region` | `AiProviderConnection(stt, azure-speech).region` |
| `stt.sarvam.baseUrl` | `AiProviderConnection(stt, sarvam).baseUrl` |
| `stt.openai.baseUrl` | `AiProviderConnection(stt, openai).baseUrl` |
| `stt.azureFoundry.endpoint` / `.enabled` | a new `AiProviderConnection(stt, azure-foundry)` row |

`stt.diarization.hfModelId` is **NOT** moved (owner default assumption, option 1): it declares the
embedding SPACE enrolled voice profiles live in. The real defect TASK-877 found is closed instead.

## Current State Evaluation (verified at `4923cac40`)

- **The prompt flag has no agent counterpart in force.** `whisper_cpp_asr.py:355-358` builds a
  hardcoded, language-derived clinical line and prepends it to every decode when
  `whisper_cpp_consultation_prompt_enabled` is on. The agent's OWN literal prompt already reaches
  the decoder by a different route on the streaming path (`spec.py:455`
  `instruction.initial_prompt` → `InferenceConfig.initial_prompt_text` →
  `session_manager.py:1960` → `inference.py:634` `compose_prompt` → the adapter's `prompt`
  argument) — so setting `_context_prompt` from the same instruction would apply it TWICE. On the
  BATCH path the agent's prompt never arrives at all: `batch_service.py:406-409` resolves
  `initial_prompt` only from the deprecated `spec.inference.initial_prompt` TEMPLATE UUID.
- **`stt.vad.modelPath` is a singleton bootstrap, and the spec already carries the model.**
  `silero_service.py:430` constructs the singleton with `settings.vad_model_path`;
  `AsrSpecModel.localPath` is already on the wire for the `vad` role.
- **`stt.vad.speechPadMs` is only a fallback.** `silero_service.py:141` uses it when the caller
  passes no `speech_pad_ms`; both pipeline callers already pass `VadConfig.padding_ms`
  (`preprocessing.py:234,359`). `AsrSpecVad` carries no padding field, so `VadConfig.padding_ms`
  can only ever hold its dataclass default (200) — identical to the platform key's default.
- **Chunking is already half-moved.** TASK-877 added `decoding.{chunkLengthSec,strideLengthSec}`
  and `batch_service.py:1245-1258` prefers them; `batch_service.py:2371-2374`
  (`_transcribe_optimum_onnx`) does not, and both still fall back to the platform settings.
- **`InferenceConfig.chunk_length_sec` / `stride_length_sec` default to `None`**, so the platform
  settings are the only source of the effective 15 / (4,2).
- **The four cloud non-secret halves are already override-first and unreachable without a row.**
  Every STT cloud loader is BYOK-only with no env key path: `openai_loader.py:75`,
  `sarvam_loader.py:95`, `azure_speech_loader.py:130`, `azure_foundry_loader.py:80` all raise
  before the endpoint matters unless a `provider_overrides` entry exists. An entry exists only for
  an ENABLED row WITH key material (`ai-provider-connection.service.ts:355`), which is also the row
  that carries `baseUrl` / `region`. So the settings halves can only ever have served a row that
  forgot to set its own — deleting them makes the row the single source.
- **`azure_foundry_loader` has no provider identity of its own.** It reads
  `settings.azure_foundry_enabled` as its gate (`:49`) and borrows the `azure-speech` credential
  entry (`:56-58, 75`). `azure-foundry` is not in `CLOUD_BYO_PROVIDERS.stt`, so no row can exist.
- **The two model-coupled keys have no metadata channel.** `AsrSpecModel` carries no metadata
  block on either half, and `ResolvedAgentModel` (`packages/types/src/agent.ts`) carries none
  either, so nothing can reach the runtime from `AiModel._metadata`.
- **`ResolvedAgentModelRole` is missing `'endpointing'`** although TASK-877 shipped the role on
  the wire and the committed fixture already carries `"role": "endpointing"`.
- **The diarization defect (TASK-877 deliverable 5) is real and precisely located.**
  `session_manager.py:570-579` resolves a per-session embedding model ONLY from an INLINE
  `ModelRef`; `spec.py:410` emits a SLUG ref. Every agent's `models.embedding` is therefore
  dropped and the platform singleton (`embedding_service.py:291`, `diarization_hf_model_id`)
  serves. `UserVoiceProfile.embedding` is `vector(256)` (`user.prisma:257`) and the platform
  singleton is the 256-d wespeaker model, while the contract fixture's agent binds the 192-d
  ECAPA row — so making the slug resolve without a guard would feed 192-d vectors into a
  `vector(256)` column and fail every enrollment.
- **`ASR_SPEC_FALLBACK_DEFAULTS` (`build-resolved-asr-spec.ts:37`) duplicates
  `AGENT_FALLBACK_DEFAULTS`** (`packages/workflow-contract/src/agent-schemas.ts:151`), whose own
  comment already claims the builder reads from it.
- **`decoding.strideLengthSec` is typed `number` in the agent JSON Schema** (`agent-schemas.ts:305`)
  while the wire type, the builder's `pair()` reader and the committed fixture all use a
  `[left, right]` array. An agent literally cannot express the value the runtime consumes.

## Implementation Plan

TDD per deliverable: failing test → implement → gates.

1. **Model metadata channel** — `AsrSpecModel.metadata` on both halves + the fixture;
   `ResolvedAgentModel.metaData`; `build-resolved-asr-spec.ts` maps it.
2. **`whisperCpp.maxAudioSeconds` → `_metadata.asr.maxDecodeWindowSec`**; `partialWindowS` →
   `_metadata.asr.partialWindowSec`; seeded on the five WHISPER_CPP rows in `audio.ts`; read via
   `InferenceConfig.max_decode_window_sec` and `StreamingConfig.partial_window_s`.
3. **`consultationPromptEnabled` → the instruction.** Delete `_context_prompt` and the two
   hardcoded lines; make the batch path prefer `initial_prompt_text`.
4. **`vad.modelPath`** — the singleton takes the spec's `models.vad.localPath`; key deleted.
5. **`vad.speechPadMs`** — agent schema + `AsrSpecVad.speech_pad_ms` + `VadConfig.padding_ms`;
   `silero_service.py:141` falls back to the dataclass default.
6. **`transcription.{chunkLengthS,strideLengthS}`** — spec becomes the ONLY source;
   `InferenceConfig` carries the engine defaults; both batch readers repointed; schema `stride`
   corrected to a pair.
7. **The four cloud halves + the `azure-foundry` provider row.**
8. **Diarization** — slug refs resolve; a publish-time refusal on an embedding-space mismatch.
9. **Types** — `'endpointing'` on `ResolvedAgentModelRole`; `ASR_SPEC_FALLBACK_DEFAULTS` →
   `AGENT_FALLBACK_DEFAULTS`, sourced from the contract package.
10. **Removals** — descriptors, `CONTROL_PLANE_KEYS`, `Settings` fields, tests; registry 265.

## Implementation Summary

All ten deliverables landed. Registry **277 → 265** (measured, not assumed).

### The twelve keys, and where each one went

| Key | New home | Reader replaced at | Test that proves it |
|---|---|---|---|
| `stt.whisperCpp.consultationPromptEnabled` | the agent's `instruction.initialPrompt` | `streaming/whisper_cpp_asr.py:346` (`_context_prompt` and the two hardcoded lines deleted); `transcription/batch_service.py:436` now prefers `initial_prompt_text` | `test_whisper_cpp_asr.py::test_the_callers_prompt_is_passed_verbatim` |
| `stt.vad.modelPath` | `AiModel(VOICE_ACTIVITY_DETECTION).localPath`, already on the spec | `vad/silero_service.py:437` (`get_vad_service(model_path=…)`); fed by `streaming/session_manager.py:1718` | `test_task880_audio_front_end.py::TestVadWeightsComeFromTheModelRow` (4 cases) |
| `stt.vad.speechPadMs` | agent `audioFrontEnd.vad.speechPadMs` → `VadConfig.padding_ms` | `vad/silero_service.py:145` | `test_task880_audio_front_end.py::TestSpeechPadIsAnAgentValue` (3 cases) |
| `stt.transcription.chunkLengthS` | agent `decoding.chunkLengthSec` → `InferenceConfig` | `transcription/batch_service.py:1281` and `:2405` (both via `_resolve_chunking`) | `test_task880_model_geometry.py::TestBatchChunkingHasOneSource` |
| `stt.transcription.strideLengthS` | agent `decoding.strideLengthSec` | ″ | ″ |
| `stt.whisperCpp.maxAudioSeconds` | `AiModel._metadata.asr.maxDecodeWindowSec` | `streaming/whisper_cpp_asr.py:352` | `test_whisper_cpp_asr.py::test_the_decode_window_comes_from_the_model_row_not_a_platform_setting` |
| `stt.streaming.partialWindowS` | `AiModel._metadata.asr.partialWindowSec` → `StreamingConfig.partial_window_s` | `streaming/session_manager.py:427` (the manager-wide cache at `:308` deleted) | `test_preprocessor_wiring_kwargs.py::test_partial_window_comes_from_the_asr_rows_metadata` |
| `stt.azureSpeech.region` | `AiProviderConnection(stt, azure-speech).region` | `models/azure_speech_loader.py:128` | `test_azure_speech_loader.py::test_region_falls_back_to_the_connection_row` |
| `stt.sarvam.baseUrl` | `AiProviderConnection(stt, sarvam).baseUrl` | `models/sarvam_loader.py:66` | `test_sarvam_loader.py::test_a_row_with_a_key_but_no_base_url_fails_closed` |
| `stt.openai.baseUrl` | `AiProviderConnection(stt, openai).baseUrl` | `models/openai_loader.py:62` | `test_openai_loader.py::test_a_row_with_a_key_but_no_base_url_fails_closed` |
| `stt.azureFoundry.endpoint` | `AiProviderConnection(stt, azure-foundry).baseUrl` | `models/azure_foundry_loader.py:78` | `test_azure_foundry_loader.py::test_the_rows_key_and_endpoint_are_used` |
| `stt.azureFoundry.enabled` | the `AiProviderConnection(stt, azure-foundry)` ROW STATE | `models/azure_foundry_loader.py:57` | `test_azure_foundry_loader.py::TestAzureFoundryEngineGate` |

Each is asserted ABSENT from the whole registry (not just from `stt-runtime.descriptors.ts`)
by `stt-runtime.descriptors.test.ts` — a re-declaration under any other descriptor file
would be the dual-homing the owner's rule forbids.

### 1–2. The model-metadata channel, and the two keys that use it

`AsrSpecModel` gained an optional `metadata` block on both halves of the contract and in
the committed fixture, `ResolvedAgentModel` gained `metaData`, and the builder maps it.
`maxDecodeWindowSec` reaches `InferenceConfig.max_decode_window_sec`; `partialWindowSec`
reaches `StreamingConfig.partial_window_s`. Because `pipeline_spec_from_resolved` runs
per CHAIN, **the fallback engine now decodes on its own window** rather than inheriting
the primary's — which is the whole point of moving a model fact off a platform key.

Seeded on all five `WHISPER_CPP` rows as `7` / `6`, the numbers the deleted keys carried,
so behaviour is unchanged. `_DEFAULT_PARTIAL_WINDOW_S` in `streaming/preprocessor.py`
drops 8.0 → 6.0: the deleted key defaulted to 6.0 and the manager passed it on EVERY
session, so 8.0 was never the effective value and would have been a silent regression.

### 3. The whisper.cpp prompt is the agent's, and only the agent's

The flag gated two hardcoded consultation lines the adapter prepended to every decode.
The agent's own `instruction.initialPrompt` already reached the adapter by a different
route (`spec.py` → `InferenceConfig.initial_prompt_text` → `session_manager` →
`compose_prompt` → the `prompt` argument), so setting `_context_prompt` from the same
instruction would have applied it TWICE. Both hardcoded lines,
`consultation_prompt_for_language` and the flag are deleted; `effective_prompt` is the
caller's prompt verbatim.

**A defect closed on the way:** `batch_service` resolved `initial_prompt` only from the
deprecated `spec.inference.initial_prompt` TEMPLATE UUID, so a batch job on an agent with
an `instruction.initialPrompt` decoded with no prior context at all. It prefers
`initial_prompt_text` now, matching the streaming path.

### 6. Chunking has ONE source

TASK-877 put `decoding.{chunkLengthSec,strideLengthSec}` on the agent and made
`_run_per_segment_inference` prefer it — but `_transcribe_optimum_onnx` still read the
platform settings, so an agent's chunking applied on one batch path and not the other.
Both read `InferenceConfig` through one `_resolve_chunking` helper now, and the engine
defaults the keys carried (15 s, `[4, 2]`) are declared on the dataclass with every other
engine default.

The agent JSON Schema's `decoding.strideLengthSec` was typed `number` while the wire
field, the builder's `pair()` reader and the committed fixture are all a `[left, right]`
PAIR — an agent literally could not author the value the runtime consumes. Corrected to a
two-item array.

### 7. Cloud connection facts ride the row

Every STT cloud loader is BYOK with no env key, so it raises before the endpoint matters
unless a `provider_overrides` entry exists — and an entry exists **only** behind an
ENABLED, KEYED row, which is the same row that carries `baseUrl`/`region`. The five
platform halves could therefore only ever have patched a row that forgot to set its own,
while making a PUBLIC vendor endpoint (`api.sarvam.ai`, `api.openai.com`) the silent
default on a PHI platform. All four loaders now fail closed naming the row, and none
imports `get_settings` at all.

**Azure Foundry got its own `azure-foundry` provider identity** rather than keeping the
`azure-speech` alias. The alias made one credential the gate for two engines with
different data-residency postures: a tenant could not enable Speech without also enabling
a PREVIEW service for its PHI, and could not point Foundry at a different resource. The
row's three states replace the kill-switch — no row / disabled / keyless = no entry = the
engine cannot load — which is the same OFF-by-default preview veto, now decidable per
tenant. `_OVERRIDE_KEY_BY_FORMAT` and the ledger engine id move with it, or a Foundry
call served on the tenant's own key would meter as platform `CLOUD`.

`stt-runtime.descriptors.ts` now declares **no kill-switch at all**; the test that pinned
the one survivor asserts the empty set and re-states why `stt.pubsub.enabled` (which
defaults ON) is deliberately not marked.

### 8. Diarization — the deferred defect, closed on both sides

- **Runtime half.** `_spec_embedding_model_id` resolves a SLUG ref off the session's spec
  bundle, not only an INLINE one. `spec.py` emits slugs for every agent, so before this
  every agent's `models.embedding` was dropped and the platform singleton served. No
  database read is added to the agent path — the bundle already holds the resolved row.
- **Producer half.** `buildResolvedAsrSpec` REFUSES an embedding model whose DECLARED
  width is not the voice-profile column's, on the primary and the fallback chain, with its
  own code `ASR_AGENT_EMBEDDING_SPACE_MISMATCH` that `AsrAgentResolverService` surfaces as
  the 409 body's `code`. The check is evidence-based: an undeclared row cannot be judged,
  and both SYSTEM catalogue rows now declare their width (192 ECAPA / 256 wespeaker).

`stt.diarization.hfModelId` is KEPT, SYSTEM-scope, `globalOnly` (owner default assumption,
option 1), and its descriptor now says WHY: it declares the vector SPACE enrolled profiles
live in, so changing it is a re-enrolment exercise, not a config edit. A test pins the
scope, the default and the reason.

### 9. Types

`'endpointing'` added to `ResolvedAgentModelRole` — TASK-877 shipped the role on the ASR
wire and in the committed fixture without ever declaring it, so the one role a
`ResolvedAgent` could legitimately carry was the one the union rejected.
`ASR_SPEC_FALLBACK_DEFAULTS` → `AGENT_FALLBACK_DEFAULTS`, re-exporting the ONE declaration
in `@arcaai/workflow-contract` instead of re-typing the literals — which is what TASK-876's
own comment already claimed this builder did.

## Handoffs

Exact edits the orchestrator must apply in files this lane does not own.

### H-1 — `packages/applications/src/services/ai-provider-connection/constants.ts` (lane A)

`azure-foundry` must be tenant-BYO-eligible on the `stt` plane, or a tenant can never hold
its own Foundry row and `AsrAgentResolverService.resolveProviderOverrides` (which iterates
`CLOUD_BYO_PROVIDERS.stt`) will never resolve one for the batch pull.

```ts
// in CLOUD_BYO_PROVIDERS
  stt: ['azure-speech', 'azure-foundry', 'sarvam', 'openai'],
```

Add beside the existing `stt` comment: *"`azure-foundry` is separate from `azure-speech`
on purpose (TASK-880): a Foundry resource IS an Azure Speech resource, but the two engines
have different data-residency postures, and one credential gating both meant a tenant
could not enable Speech without also enabling a PREVIEW service for its PHI."*

### H-2 — `packages/database/src/prisma/db_main/seed/17-ai-provider-connection.ts` (lane A)

Three edits, all in `SYSTEM_AI_PROVIDER_CONNECTIONS`.

(a) A NEW row for Foundry, after the `azure-speech` STT row (`…0000c1`). It replaces the
`stt.azureFoundry.enabled` kill-switch, so it MUST seed `enabled: false`:

```ts
  {
    // Azure AI Foundry (MAI-Transcribe) — a SEPARATE row from `azure-speech` since
    // TASK-880. `enabled: false` is the PREVIEW VETO that replaced the platform
    // kill-switch `stt.azureFoundry.enabled`: no entry is folded into
    // `provider_overrides`, so `azure_foundry_loader` refuses to load. A tenant that has
    // signed off on data residency brings its own credential and enables it — per
    // tenant, which a platform boolean could never express. `baseUrl` is the resource
    // endpoint (`https://<res>.cognitiveservices.azure.com`), left null: it is
    // per-deployment and no placeholder is invented.
    id: '87000000-0000-0000-0000-0000000000c4',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'azure-foundry',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    apiKeyPlaintext: null,
    enabled: false,
    metaData: null,
  },
```

(b) On the `stt`/`sarvam` row (`…0000c2`), replace `baseUrl: null` with the value the
deleted `stt.sarvam.baseUrl` carried, so a platform admin who adds a key gets a working
row:

```ts
    baseUrl: 'https://api.sarvam.ai',
```

(c) On the `stt`/`openai` row (`…0000c3`), likewise:

```ts
    baseUrl: 'https://api.openai.com/v1',
```

The `stt`/`azure-speech` row's `region` stays `null` — it is per-deployment, and the
deleted key's own default was unset.

**Note for whoever applies (b)/(c):** the override fold replaces per PROVIDER KEY, not per
field, so a TENANT row that carries a key but no `baseUrl` does NOT inherit the SYSTEM
row's. That is why the loaders fail closed naming the row rather than silently reaching
for a platform value. See DEFERRED-2.

### H-3 — `packages/database/src/prisma/db_main/seed/25-agents.ts` (lane A)

(a) `ASR_INSTRUCTION` (line 111) **already carries** the clinical prompt the deleted flag
was gating, so no edit is REQUIRED for correctness. If the Malayalam half of the deleted
`_CONSULTATION_PROMPT_ML` line is wanted, this is the replacement:

```ts
const ASR_INSTRUCTION = { initialPrompt: 'Clinical consultation between a clinician and a patient. ഇത് ഒരു consultation ആണ്, ഒരു doctor നും ഒരു രോഗിക്കും തമ്മിലുള്ളത്. English and Malayalam medical terminology.', hotwords: [] as string[] };
```

(b) `ASR_PARAMETERS` (lines 104-110) sets no chunking and no VAD padding. Behaviour is
identical either way — the runtime defaults are the numbers the deleted keys carried — but
the platform TEMPLATE should say what it wants rather than inherit:

```ts
const ASR_PARAMETERS = {
  audioFrontEnd: { vad: { modelSlug: 'silero-vad', threshold: 0.5, minSpeechMs: 250, minSilenceMs: 500, speechPadMs: 200 }, diarization: { enabled: false } },
  decoding: { languageMode: 'ml-en', codeSwitching: true, wordTimestamps: true, beamSize: 5, temperature: 0, chunkLengthSec: 15, strideLengthSec: [4, 2] },
  postProcessing: { punctuation: { enabled: true, modelSlug: 'cadence-punctuation' }, disfluency: true, stabilizer: true },
  streaming: { partialIntervalMs: 500, endpointing: 'semantic', maxUtteranceSec: 60 },
  fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
};
```

### H-4 — `packages/applications/src/services/agent/agent-resolver.service.ts` (unowned in 3a)

`toResolvedModel` must carry the narrow `_metadata` slice, or the seeded
`_metadata.asr.*` never reaches the spec and the embedding-space guard never fires.
`AiModelEntity` exposes the column as `metaData`.

```ts
function toResolvedModel(model: AiModelEntity, role: ResolvedAgentModelRole): ResolvedAgentModel {
  return {
    role,
    slug: model.slug,
    // …unchanged…
    tenantId: model.tenantId,
    // TASK-880 — the runtime-relevant slice of `AiModel._metadata`: ASR decode geometry
    // (which replaced `stt.whisperCpp.maxAudioSeconds` / `stt.streaming.partialWindowS`)
    // and the speaker-embedding width the ASR spec builder validates. `buildResolvedAsrSpec`
    // reads only the declared members; everything else in `_metadata` belongs to other planes.
    ...(model.metaData ? { metaData: model.metaData as ResolvedAgentModel['metaData'] } : {}),
  };
}
```

Also add `'endpointing'` to `ASR_AUX_MODEL_PATHS` if an agent should be able to bind the
EOU model by parameter path — TASK-877 added the ROLE and the schema property
(`streaming.semantic.modelSlug`) but no resolver path, so today only a hand-built
`ResolvedAgent` can carry one:

```ts
  { role: 'endpointing', path: ['streaming', 'semantic', 'modelSlug'] },
```

### H-5 — `packages/applications/src/services/usageLedger/vocabulary.ts` (unowned)

`KNOWN_PROVIDERS` has neither `azure_foundry` nor `azure-foundry`, so the Foundry engine
id was already outside the vocabulary; this lane changed it from `azure_foundry` to
`azure-foundry` (matching the connection id, as `azure-speech` already does). Add:

```ts
  'azure-speech',
  'azure-foundry',
```

### H-6 — generated artifacts (orchestrator, after the merge)

`turbo.json#globalEnv`, `.env.sample`, `apps/stt/.env.sample`, `env-surface.generated.md`
and `scripts/generated/python-env-surface.json` still carry the twelve
`*__MOVED_TO_CONTROL_PLANE` entries, which came from the deleted `Settings` fields. Order
matters: `pnpm env:python-surface` THEN `pnpm env:sync`, on a freshly built
`@arcaai/applications`. `pnpm env:python-dead` is already green (370 fields, all read, 4
allow-listed) and no `INTENTIONALLY_UNREAD` entry names a deleted field.

## Deferred, with the seam

**DEFERRED-1 — the cloud ASR model rows declare `provider: 'azure'`, not `azure-speech`.**
`AI_MODEL_PROVIDERS` (`seed/ai-models/shared.ts`, not this lane's) has no `azure-speech`
or `azure-foundry` member, so `azure-speech-stt` and `mai-transcribe-1.5` both say
`azure`. `AsrAgentResolverService.resolveCredentials` gates on
`isCloudByoProvider('stt', spec.models.asr.provider)`, and `'azure'` is not in
`CLOUD_BYO_PROVIDERS.stt` — so **a streaming SESSION on an Azure ASR agent resolves no
credential at all** and the loader fails closed. Pre-existing, unchanged by this lane, and
it does not affect Foundry, which is batch-only and served by the whole-service pull
(`resolveProviderOverrides`, keyed by connection provider ids). Fixing it needs
`AI_MODEL_PROVIDERS` widened AND the two rows repointed AND `CLOUD_BYO_PROVIDERS`
confirmed — three files across two lanes' ownership.
Seam: `packages/applications/src/services/stt/agent-resolver/asr-agent-resolver.service.ts:183`.

**DEFERRED-2 — the override fold replaces per provider, not per field.**
`resolveTenantCloudOverrides` merges SYSTEM then tenant *per provider KEY*
(`ai-provider-connection.service.ts:345-377`), so a tenant row with a key and no `baseUrl`
does not inherit the SYSTEM row's endpoint. That is why the four loaders fail closed with
both halves named instead of reaching for a platform value. If field-level inheritance is
wanted, it belongs in that one fold, not in four loaders.
Seam: `packages/applications/src/services/ai-provider-connection/ai-provider-connection.service.ts:374`.

**DEFERRED-3 — `models.endpointing` has no resolver path.** See H-4; TASK-877 added the
role, the wire field and the schema property but no `ASR_AUX_MODEL_PATHS` entry, so no
real agent can bind an EOU model yet. The committed fixture carries one, so the contract
is exercised.

## Verification

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded against the verified base state. |
