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

_(filled in as the work lands)_

## Handoffs

_(filled in as the work lands)_

## Verification

_(filled in as the work lands)_

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded against the verified base state. |
