# @arcaai/room

## 5.0.0

No changes in this release.

## 4.1.0

No changes in this release.

## 4.0.1

### Patch Changes

- 461cab7: TASK-1012 — legacy residue sweep (agent/workflow architecture only). Fixes two live bugs and stops sending inputs the gateway refuses; dead exports are marked `@deprecated` and are removed in 5.0.0. No export is removed in this release.

  **Fixed**

  - `@arcaai/vox`: `generateSummary()` / `generatePreSummary()` (on `useArca().summary` and `useArcaSummary()`) and `KnowledgePipeline.triggerSummarization()` 404'd in 4.0.0 — they POSTed the synchronous `/consultations/:id/summary` and `/summary/pre-summary` routes that TASK-1006 removed. They now start the async job (`POST …/summary/async`, `…/summary/pre-summary/async`), poll `GET /consultations/jobs/:jobId` until it completes, and resolve the persisted note from `…/summary/latest` / `…/summary/pre-summary/latest`. Same signatures, same resolved `SummaryResponse` / text. A `FAILED` / `CANCELLED` job rejects with the job's error, and a job that has not finished within 5 minutes rejects too.
  - `@arcaai/vox`: every summary generate method (`useArca()` and `useArcaSummary()`, sync-shaped and `*Async`) now sends ONLY the fields its route's DTO declares — the gateway's ValidationPipe is `forbidNonWhitelisted`, so any other key was a 400. Summary (`GenerateSummaryRequest`): `transcription`, `dnaStyleId`, `template`, `includeNER`, `contextItemIds`, `options`, `idempotencyKey`, with the deprecated `transcript` → `transcription` and `promptTemplateId` → `template` mapped. Pre-summary (`GeneratePreSummaryRequest`): `dnaStyleId`, `caseNoteIds`, `options`, `idempotencyKey` only. Everything else — `departmentId` on both (the gateway reads the department from the consultation; `options.departmentId` was never read), and `transcript`/`transcription`/`promptTemplateId`/`template`/`includeNER` on pre-summary — is dropped with a one-time `console.warn` naming the key. `triggerSummarization` no longer sends the unknown `type` field.
  - `@arcaai/stt`: `StreamingBackendSTTProvider` no longer forwards a caller-supplied `pipelineId` on the streaming session create (the gateway answers 400 for it). The option stays typed and `@deprecated`, is ignored with one console warning per process, and `getPipelineId()` now always returns `null`.
  - `@arcaai/vox`: removed the dead `remoteConfig.pipelineId` → `resolvedConfig.stt.transcriptionPipelineId` injection (`AgenticProvider`, on mount and on a same-tab user switch) and the `remoteConfig.agentSlug` read in `useArcaAudio().startFromPreferences()` — the gateway has not sent `remoteConfig` since TASK-1006. The ASR agent is the gateway's choice unless you pass `agentSlug`.

  **Deprecated (removed in 5.0.0)**

  - `@arcaai/vox`: `SUMMARY_ENDPOINTS.GENERATE` / `SUMMARY_ENDPOINTS.PRE_SUMMARY` (no such POST routes), `NLP_ENDPOINTS` (no `/nlp/*` routes); the browser model registry — `ModelRegistry` (still used internally for the tenant config), `DEFAULT_STT_MODELS`, `DEFAULT_VAD_MODELS`, `DEFAULT_MODELS`, `DEFAULT_AVAILABLE_STT_MODELS`, `AvailableSttModel`, `SttTask`, `SelectedModels`, `ModelRegistryState`, `ModelRegistryActions`, `ModelLoadingStates`, `ModelLoadProgress`, `ModelLoadStatus`, `ModelLoadOptions`, `ModelRegistryConfig`, `ModelDefinition`, `AgenticConfig.models`, `useArcaConfig().models` / `.selectModel` / `.selectSttTask`; `RemoteConfigResponse` and `UserPreferences.remoteConfig`; `resolvedConfig.stt.transcriptionPipelineId` (never populated now); the legacy `TenantAudioConfig` browser-model fields (`defaultSttModel`, `vadSensitivity`, `localAsrModels`, `localVadModels`, `localNoiseSuppressionModels`), `LocalAsrModelInfo` / `LocalVadModelInfo` / `LocalNoiseSuppressionModelInfo` and their `TENANT_CONFIG_KEYS` entries.
  - `@arcaai/stt`: `StreamingRemoteProviderConfig.pipelineId`, `STTStreamingTransport.pipelineId`, `StreamingBackendSTTProvider.getPipelineId()`.
  - `@arcaai/vox-node`: `HopeStreamError` (nothing throws it since `hope.summarization.*` was removed).

  **Docs**

  - `@arcaai/vox`: deleted `docs/Compat-API-Reference.md` and `docs/Batch-Transcription-Reference.md` (they documented the removed compat entry and the removed `pipelineId` contract); `docs/API-Reference.md` and the README mark what 4.0.0 removed and use `agentSlug` throughout. `@arcaai/room` / `@arcaai/stt`: READMEs no longer link to the deleted `@arcaai/vad` / `@arcaai/noise-filter` / `@arcaai/med-ner`. `@arcaai/vox-node`: 48 admin areas (not 49), stale `summarization.ts` / `text-compat` references removed; the unexported, empty `PREFIX_EXEMPT_PATHS` set is gone (every path gets `api/v1`, as before).

## 4.0.0

No changes in this release.

## 3.6.0

No changes in this release.

## 3.5.0

No changes in this release.

## 3.3.0

### Minor Changes

- TASK-951 — the ArcaAI realtime contract on the SDKs.

  - `hope.stt.createStreamSession({ context })` (vox-node) / the stream-session request (vox): a client-declared session context (≤ 4 KB), validated against the ASR agent's frozen context schema and echoed VERBATIM on every transcript of that session together with `sessionEpochMs`.
  - `RealtimeSttSocket.setMetadata(value)` (vox-node) and `SttWebSocketClient.setMetadata(value)` (vox): declare the metadata in force from the current point of the audio onward — one microphone at a time, sticky until the next declaration, no timestamp. Every transcript then carries `metadata` (the flat object in force over its audio, e.g. `{ mic_id: '2' }`) and `metadataSpans` (`SttMetadataSpan[]` / `WsMetadataSpan[]`, the exact bounds clipped to the segment). Refusals arrive on the error channel — `METADATA_TOO_LARGE`, `METADATA_INVALID`, `METADATA_SCHEMA_VIOLATION` with `problems` — and never end the session.
  - `@arcaai/vox-codegen`: the context-schema marker roles (`userIdentity`, `department`, `visitType`, `externalRef`, `materializeAs`, `streamContext`) are emitted as documentation tags on the generated kind types.

## 3.2.0

No changes in this release.

## 3.1.0
