# Deprecation register

| | |
|---|---|
| **Owner** | Platform / Architecture |
| **Introduced** | 2026-09-04 (TASK-859) |
| **Policy** | An item is *marked* deprecated in the release named in **Marked in** and *removed* in the release named in **Remove in** — "after the next two releases" (owner directive 2026-09-04). Removal releases are placeholders (`R1`, `R2`, …) until the owner names the tags (TASK-859 OD-2). A CI check (first implementing ticket) fails when a `@deprecated TASK-` marker in code has no row here, or when a row's removal release has shipped and the code still exists. |

Status values: `planned` (ticket not started) · `marked` (marker landed) · `removed`.

## Data model

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `AsrPipeline`, `AsrPipelineVersion` (Prisma, domain trio, `PipelineService`, `admin/audio/pipelines/**`, `audio/pipelines/**`) | TASK-861 | R2 | R4 | `Agent` (task `SPEECH_TO_TEXT`) + gateway-resolved `ResolvedAsrSpec` | marked — Prisma `/// @deprecated TASK-861 — removed in R4` on both models (`stt.prisma`); `@deprecated` JSDoc on both domain trios (entity / factory / mapper / repository), on `PipelineService` / `IPipelineService` / its module and on `pipeline-template-resync.{service,cron.service}`; `@ApiDeprecated` (`Deprecation: true` + `X-Deprecation-Notice` + `Link` → `/api/v1/admin/agents`, no `Sunset` until OD-2) on all 8 `admin/audio/pipelines` routes; the `audio/pipelines` catalogue reads keep answering (JSDoc marker only). Writes still succeed — the `410 Gone` step of §3.3 is owed once the Agents screen exposes the SPEECH_TO_TEXT authoring path |
| `TranscriptionJob.pipelineId` | TASK-861 | R2 | R4 | `TranscriptionJob.agentVersionId` + `resolvedSpec` | marked — migration `20260904150000_task_861_transcription_job_agent_version` (`pipelineId` nullable, FK re-added `ON DELETE SET NULL`; `agentVersionId` + `resolvedSpec` + index added); `@deprecated` on the entity / factory / model field, on `CreateJobRequest.pipelineId`, `JobResponse.pipelineId` and the console `transcription-jobs` type; `TranscriptionJobService.create` takes `agentVersionId` + `resolvedSpec` (no pipeline lookup) and the Dramatiq message carries `resolved_spec` |
| `TenantSttConfig` (+ `admin/stt-config/**`, `/ai-configuration` Speech tab) | TASK-861 | R2 | R4 | ASR Agent `fallback` block | marked — Prisma marker (`tenant-stt-config.prisma`); domain trio, `TenantSttConfigService` / `ITenantSttConfigService` / module `@deprecated`; `@ApiDeprecated` on all 4 `admin/stt-config` routes; the Speech tab (`stt-fallback-tab.tsx`) is a retirement notice linking to `/agents?task=SPEECH_TO_TEXT` (`stt-fallback-form.tsx` deleted); the agent path reads `ResolvedAsrSpec.fallback` instead. Still live for the window: the batch worker's credential pull (`internal/stt/*` → `resolveProviderOverrides`, repoint to `ProviderCredentialResolver` is a follow-up). `seedTenantSttConfig` is GONE (see Seeds): no SYSTEM row is seeded any more — the platform fallback is the assigned ASR agent's `fallbackModelSlugs` |
| `PipelinePolicy`, `PipelinePolicyChange` (+ `admin/harness/pipeline-policy`, `/harness/pipeline-policy`) | TASK-861 | R2 | **REMOVED — TASK-882** | `agent.dna_style` / `agent.dna_redaction` node presence + the doctor's `UserSettings` preference; auto-summary = the workflow generation node's `enabled` | REMOVED 2026-09-06 (owner: redundant old-architecture settings are removed completely, not dual-homed). Models, both domain trios, `PipelinePolicyService` + module, the 3 `admin/harness/pipeline-policy` routes, the CASL rows, the `admin:pipeline-policy:manage` scope and the five `pipeline.{autoSummaryEnabled,autoNerEnabled,harnessEnabled,dnaStyleEnabled,dnaRedactionEnabled}` descriptors are gone; `PipelinePolicyScope` STAYS (assignment tables). The console `/harness/pipeline-policy` redirect page is the one surviving surface (R4). Migration SQL: `DROP TABLE core."PipelinePolicyChange"; DROP TABLE core."PipelinePolicy";` (orchestrator-authored) |
| `Tenant.transcriptionMode`, `Tenant.captureMode` | TASK-861 (OD-13) | R2 | R4 | — (local transcription no longer exists) | planned (untouched by the TASK-861 branch — OD-13 still open) |
| `AiTaskDefault` (table, `AiTaskDefaultService`, `admin/ai-task-defaults`, `vox-node` admin resource) | TASK-862 | R1 | R3 | `AiRoutingPolicy.resolveDefault` (non-agent task defaults) + `Agent.modelId` | **removed (TASK-881, 2026-09-06)** — every reader repointed to `IAiRoutingPolicyService.resolveDefault`, the `models.*` descriptor family deleted with the facade, the routes/scope/CASL grant/domain trio gone, the table drop in the orchestrator's wave-3a migration; the generated `vox-node` admin resource follows the next `gen:admin` |
| `AiRuntimeProfile` (all layers, `/ai-runtime-profiles`) | TASK-862 | R1 (**removed outright** — deviation 2) | — | `Agent.parameters` (hyper-parameters) + `AiProviderConnection` ceilings | removed (`ResourceType.AiRuntimeProfile` enum member left in place) |
| `TenantTtsConfig` (+ `admin/tts-config/**`, `/ai-configuration` Voice tab) | TASK-862 / 863 | R1 | R3 | TTS Agent + `AgentAssignment` | marked (`@deprecated` on service/interface, `Deprecation` headers on every `admin/tts-config` route; credential facade already removed) |
| `AiRoutingPolicy.candidatesJson` | TASK-862 | R1 | R3 | candidate rows | planned (untouched by the TASK-862 wave — already `@deprecated` on the entity) |
| `AiModel.downloadStatus`, `downloadedAt`, `fileSizeMb`; free-text `localPath`; `AiModelFormat` cloud pseudo-values (`CLOUD_API`, `AZURE_SPEECH`, `AZURE_FOUNDRY`, `SARVAM`, `OPENAI`); `AiModelSource.MLFLOW`, `GITHUB` | TASK-860 | R1 | R3 | `availability`, derived `localPath` from `bucketPrefix`, `deploymentKind` + `libraryName` | marked |
| Customer-tenant clones of the model catalogue (`backfillCustomerTenantAiModels`) | TASK-860 | R1 (deleted — seed data) | — | SYSTEM-only catalogue with shared read | removed |
| `ProviderReconciliationRun` + `provider-reconciler*` + `admin/usage/reconciliation` + `/ai-operations/reconciliation` | TASK-862 | R1 (**removed outright**, owner directive) | — | — | removed (route keeps a one-release redirect to `/ai-operations/consumption`) |

## API routes

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `admin/ai-providers/**` (llm-only alias) | TASK-862 | R1 (**removed** — no caller remained) | — | `admin/providers/:service/:provider` | removed |
| `admin/tts-config/credentials/**`, `admin/stt-config/credentials/**` | TASK-862 | R1 (**removed** — console hooks were dead) | — | `admin/providers/**` + `POST …/test` | removed |
| `POST admin/ai-models/discovery/register` | TASK-860 | R1 | R3 | registry inventory "register from bucket" | marked |
| `pipelineId` on `POST audio/transcription-jobs/stream/session`, `POST …/transcribe`, `POST api/stt/start_session` | TASK-861 | R2 | R4 | `agentSlug` | marked — all three accept `agentSlug` (absent = the tenant's assigned ASR agent via the `AgentAssignment` cascade) and resolve a `ResolvedAsrSpec` through `AsrAgentResolverService`; all three still honour `pipelineId` and answer `Deprecation: true` + `X-Deprecation-Notice` + `Link: </api/v1/agents?task=SPEECH_TO_TEXT>; rel="successor-version"` (no `Sunset` until OD-2) from one shared literal (`apps/api/src/common/pipeline-id-deprecation.ts`; `api/stt/start_session` since `fcf9ede25`) WITHOUT the headers (follow-up); the DTO fields carry `@deprecated` |
| `POST /workflows/:slug/invoke` (alias) | already deprecated in code | — | R3 | `POST /workflows/:slug/runs` | marked |

## Workflow contract

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `stt` palette (8 node types), `WF-STT-*` rules, `stt-pipeline.compiler.ts`, `stt-pipeline-resolver.service.ts`, `stt_placeholder.py` | TASK-861 (node types marked by TASK-864: `deprecated: true`, `replacedBy: 'core.agent'`; step 10 closed by TASK-867) | R2 | R4 | ASR Agent | marked — all 8 descriptors are `implemented: false` on top of the TASK-864 flags, so `compile()` refuses any new or re-published `stt` graph (WF-C-002) while already-published rows keep loading, validating and rendering; `WF-STT-001..006` and their golden fixtures are DELETED from `rule-catalogue.ts` (rules scoped to a palette that cannot compile can never fire); `stt_placeholder.py` is DELETED together with its 8 `registry.py` specs and worker registrations — Python carries no `stt.*` spec at all, and both parity guards pin `implemented: false` ⇔ no Python spec / no served activity; the parity snapshot and seeds 21/23/24 are regenerated for the moved `registryChecksum`. Still in place until R4: the descriptors, `NODE_CONFIG_SCHEMAS`/`NODE_PORTS` entries, `stt-pipeline.compiler.ts` and `stt-pipeline-resolver.service.ts` (`@deprecated TASK-861`, now unreachable through `publish()`), and `EXPOSURE_ALLOWED_PALETTES` (unchanged) |
| `summarization`, `consultation`, `agentic` palettes + the palette-less `noop`/`passthrough`/`core.start`/`core.end`/`guard.*` (50 node types) | TASK-864 | R2 | R4 | `core.*` vocabulary (+ `core.action` catalogue, seeded Agents) — every descriptor carries `deprecated: true` + `replacedBy`; `deprecation.task864.test.ts` pins the set; the Studio rail hides them | marked |
| `EXPOSURE_ALLOWED_PALETTES` | TASK-864 | R2 | R4 | class-based exposure boundary (`clinicalWriteViolation`) — the palette sets now admit `core` and are consulted only for legacy graphs | marked |
| Harness `_llm_policy.get_policy(task_key)` over `AiTaskDefault` | TASK-863 | R1 | R3 | `/internal/agents/resolve` + `AiRoutingPolicy` | planned |
| `HarnessPolicy.textProvider`, `textModel` | TASK-863 | R1 | R3 | Agent binding | **removed (TASK-881, 2026-09-06)** — columns dropped (migration by the orchestrator), PATCH fields and console controls gone; the response fields stay, derived from the assigned TEXT_GENERATION agent (TASK-876) |

## Admin console routes and features

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `/ai-platform` (hub) + `features/ai-platform` | TASK-862 | R1 (redirect) | R3 | `/ai-providers`, `/ai-models`, `/agents`, `/ai-services/*` | marked — `redirect('/ai-providers')` stub; feature folder deleted |
| `/ai-task-defaults` redirect stub | TASK-862 | — | R1 | — | removed |
| `/ai-runtime-profiles` | TASK-862 | R1 | R1 (no nav entry) | — | removed |
| `/ai-configuration` (Speech & Voice) | TASK-861/862 | R2 (redirect) | R4 | `/agents` | marked (TASK-861: the Speech tab is a retirement notice pointing at `/agents?task=SPEECH_TO_TEXT`; the route still renders `SpeechAndVoiceScreen` for the Voice tab — the `redirect('/agents')` lands when the TTS binding retires with TASK-863) |
| `/ai-operations/reconciliation` | TASK-862 | R1 (redirect) | R3 | `/ai-operations/consumption` | marked — redirect stub |
| `/audio/pipelines`, `features/audio-pipelines` | TASK-861 | R2 (redirect) | R4 | `/agents?task=SPEECH_TO_TEXT` | marked — `page.tsx` is `redirect('/agents?task=SPEECH_TO_TEXT')` (`loading.tsx` deleted), nav entry removed; `features/audio-pipelines` kept with `@deprecated` on the api index + screen (no route mounts it) — `useAudioPipelines` still feeds the two playgrounds until TASK-865 gives `audio.start` an `agentSlug` |
| `/harness/pipeline-policy`, `features/pipeline-policy` | TASK-861 | R2 (redirect) | R4 | workflow assignments | marked — `page.tsx` is `redirect('/workflow-studio/assignments')` (`loading.tsx` deleted), nav entry removed; feature folder kept with `@deprecated` on the api index + screen |
| `features/tenant-stt-config`, `features/tenant-tts-config` | TASK-861/862 | R1–R2 | R3–R4 | agents | marked (TASK-862: dead credential hooks removed; `speech-and-voice-screen` relocated into `tenant-tts-config`, `@deprecated`; TASK-861: `stt-fallback-form.tsx` deleted, `stt-fallback-tab.tsx` is a retirement notice, `features/tenant-stt-config/api` `@deprecated`) |
| `/agents` redirect to `/prompt-templates` | TASK-863 | — | R1 (route becomes the Agents screen) | `/agents` Agents screen (`features/agents`); prompt-template components live under `features/prompt-templates` | removed |
| `/prompt-studio`, `/pstudio` redirect stubs | pre-existing | — | R1 | — | marked |
| `/ai-model-defaults` redirect stub | pre-existing | — | R1 | — | marked |

## SDK

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/stt` (browser Whisper), `@arcaai/med-ner`, `@arcaai/vox/plugins/med-ner` | TASK-865 | R2 | R4 | server-side VAD/denoise/ASR/NER via the ASR Agent and realtime lane | marked |
| `useLocalVoiceEmbedding` | TASK-865 (OD-11) | R2 | R4 | `useVoiceEmbedding` | marked |
| `AudioStartOptions.pipelineId`, `usePipelines`, `useArcaPipelines`, `selectedPipelineId` user setting, `useSttProviderToggle`, compat `sttPipelineId` | TASK-865 | R2 | R4 | `AudioStartOptions.agentSlug`, `useSelectableAsrAgents` | marked |
| `TranscriptionPipeline` local stages, `LOCAL_TRANSCRIPTION_ENABLED`, `DEFAULT_LOCAL_CONFIG` model pins | TASK-865 | R2 | R4 | — | marked |
| `audio.clientInference: { allow }` (the client-stage escape hatch, deprecated on arrival) | TASK-865 | R2 | R4 | — | marked |
| compat `V1SdkConfig.sttPipelineId` | TASK-865 | R2 | R4 | `V1SdkConfig.sttAgentSlug` | marked |
| `hope.admin.audioPipeline.*` (generated) | TASK-861 | R2 | R4 | `hope.admin.agent.*` (generated) | planned (the route markers it will pick up are in place; regeneration — `pnpm --filter @arcaai/vox-node gen:admin` with the other four artifacts — is owed post-merge, TASK-861 step 13) |

## Seeds (deleted immediately — no production data)

| Item | Ticket |
|---|---|
| `14-pipeline-policy.ts`, `23a-realtime-transcription-agent{,.generated}.ts`, regen script + their seed tests — DONE; `06-stt.ts` pipeline half (`DEFAULT_ASR_PIPELINES`, the four per-tenant / Global sets, `seedAsrPipelines`, `switchDefaultSttPipelineToGgufTurbo`, `retireRetiredAsrPipelines`) + `seedTenantSttConfig` — DONE (step 11 follow-up, after the TASK-860 file split; `06-stt.ts` now seeds STT Global Settings only). The six seeded `TranscriptionJob` rows are re-keyed to `agentVersionId` (`09-consultation.ts`); `seed.test.ts`, `managed-asr-addon-posture.test.ts` (now asserts the SYSTEM-assigned ASR agent is self-hosted, fallbacks included) and `ai-model-registry-seed.test.ts` re-pointed; e2e `pipeline-template-governance` / `pipeline-clone-resync-cross-tenant` DELETED 2026-09-05 (they probed only the seeded template copies, so once those went they asserted nothing; the code they covered stays live until R4 and keeps its unit suites) | TASK-861 |
| `16-ai-task-default.ts` (replaced by `16-ai-routing-policy.ts`), `18-ai-runtime-profile.ts`, `llm:sarvam` connection row — DONE; `19-tenant-tts-config.ts` — with TASK-863 | TASK-862 |
| 10 catalogue rows not in the owner's list; `RETIRED_AI_MODEL_SLUGS` ledger extended | TASK-860 |
| `21`, `23`, `24` workflow seeds rewritten in `core.*` — NOT DONE in the first TASK-864 landing: their derived blobs were regenerated for the core registry (checksums), the authoring sources still use the legacy palettes (owner question: the consultation rule set `CR-*` keys on `consultation.*` types, so a `core.action` rewrite needs the rules retargeted first) | TASK-864 |
