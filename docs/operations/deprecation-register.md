# Deprecation register

| | |
|---|---|
| **Owner** | Platform / Architecture |
| **Introduced** | 2026-09-04 (TASK-859) |
| **Policy** | An item is *marked* deprecated in the release named in **Marked in** and *removed* in the release named in **Remove in** — "after the next two releases" (owner directive 2026-09-04). Removal releases are placeholders (`R1`, `R2`, …) until the owner names the tags (TASK-859 OD-2). A CI check (first implementing ticket) fails when a `@deprecated TASK-` marker in code has no row here, or when a row's removal release has shipped and the code still exists. |

Status values: `planned` (ticket not started) · `marked` (marker landed) · `removed`.

**R1 = &lt;tag TBD&gt;.** The first removal release has no tag yet — TASK-859 OD-2 is still open, so `R1`..`R4` remain placeholders. Its content is drafted in [`release-notes/ALL-4.0.0.md`](./release-notes/ALL-4.0.0.md); rename that file (and the `Remove in` cells here) once the owner names the tag.

## Wave 3a (TASK-879..883, 887, 888) — what was removed outright vs. deprecated

One entry for the whole wave, because the split is a POSTURE, not a per-item
judgement. HOPE is pre-production: there is no customer data behind any of these
surfaces, so a redundant old-architecture setting is removed COMPLETELY rather
than dual-homed behind a flag (owner directive, target model item 7). The two
exceptions below are deprecated rather than removed because something OUTSIDE
the platform still points at them.

**Removed outright in wave 3a** — descriptor, reader, `Settings` field, seed and
console reader in the same change, with no deprecation window:

| Removed | Ticket |
|---|---|
| 18 `tts.*` descriptors (7 to the agent, 8 to `AiProviderConnection`, 3 to `AiModel._metadata`) and the five TTS engine kill-switches | TASK-879 |
| 12 `stt.*` descriptors (5 to the agent, 5 to `AiProviderConnection`, 2 to `AiModel._metadata`) | TASK-880 |
| the whole `models.*` family (12 keys) with the `AiTaskDefault` table, service, routes, scope and domain trio | TASK-881 |
| `pipeline.{autoNerEnabled,harnessEnabled,dnaRedactionEnabled,autoSummaryEnabled,dnaStyleEnabled}`, `consultation.visitTypes`, `agentic.revisit.carryForwardEnabled`, `consultation.endpoint.actions`, `harness.{warmStartEnabled,nerPriorsEnabled,atomicFactEnabled}`, and `PipelinePolicy` + `PipelinePolicyChange` | TASK-882 |
| `TenantFrontendConfig.{asrModel,noiseCancel,vad,voiceEnrollment,diarization}`, `PlanEntitlement.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess}` + their `TenantEntitlement` twins, the 11 `nlp.logging.*` keys | TASK-883 |
| `stt.diarization.hfModelId`, `stt.voiceProfile.minSimilarity` | TASK-887 |
| `TenantTtsConfig` (model, service, routes, scope, seed, console feature); `text.serviceToken` / `TEXT_SERVICE_TOKEN` (descriptor, 13 gateway readers, warm list, both secret scripts) | TASK-888 |

**Deprecated, not removed** — each keeps a window because a consumer the wave
does not own still reaches it. Both come out in **R4**:

| Deprecated | Ticket | Why it is not removed with the rest |
|---|---|---|
| `pipeline.templateResync.{enabled,cron}` and `pipeline-template-resync.cron.service.ts` | TASK-882 | The cron is inert (its `AsrPipeline` templates are retired) but the SERVICE is still constructed, and deleting a scheduled job is a deploy-shaped change, not a config one |
| the `/harness/pipeline-policy` console redirect page | TASK-882 | A retired route keeps a `redirect()` for one release so a bookmark does not 404. (TASK-882's handoff also named `apps/admin-console/tests/e2e/pipeline-policy.spec.ts` — verified 2026-09-06: that spec is already gone, so only the page is left to remove.) |

Two more items look like exceptions and are not: `ResourceType.AiTaskDefault`
and `ResourceType.TenantTtsConfig` stay in both enums permanently, because a
Postgres enum value cannot be dropped in place and historical `AuditLog` rows
name them. They are tombstones, not deprecations.

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
| `TenantTtsConfig` (+ `admin/tts-config/**`, `/ai-configuration` Voice tab) | TASK-862 / 863 | R1 | **REMOVED — TASK-888** | TTS Agent + `AgentAssignment` (`ResolvedTtsSpec`); BYO keys on `AiProviderConnection(service='tts')` | REMOVED 2026-09-06 (pre-production posture: a redundant old-architecture surface is removed completely, not dual-homed). The Prisma model, the domain trio, the `CoreDatabaseModule` registration, both tenant-scope allow-list entries, `TenantTtsConfigService` + DTOs + module, the 4 `admin/tts-config` routes, the `admin:tenant-tts-config:manage` scope, the CASL grant, `seed/19-tenant-tts-config.ts` and the console feature are gone. `ResourceType.TenantTtsConfig` STAYS in both enums (a Postgres enum value cannot be dropped; historical AuditLog rows name it). `/ai-configuration` is NOT retired — its Speech tab still reads the live `TenantSttConfig` — so the screen moved into `features/tenant-stt-config` and the Voice tab became the links to `/agents?task=TEXT_TO_SPEECH`. Migration SQL: `DROP TABLE core."TenantTtsConfig";` (orchestrator-authored) |
| `AiRoutingPolicy.candidatesJson` | TASK-862 | R1 | R3 | candidate rows | planned (untouched by the TASK-862 wave — already `@deprecated` on the entity) |
| `AiModel.downloadStatus`, `downloadedAt`, `fileSizeMb`, free-text `localPath` (4 columns) + the `AiModelDownloadStatus` enum type | TASK-860 | R1 | R3 (**brought forward**) | `availability` / `availabilityCheckedAt` / `availabilityDetail`; `localPath` DERIVED from `bucketPrefix` (`derived-local-path.task890.test.ts`) | **removed (TASK-890 wave 2a, 2026-09-06)** — migration `20260906101622_task_890_context_schema_byo_model_provenance` (`ALTER TABLE core."AiModel" DROP COLUMN "downloadStatus", "downloadedAt", "fileSizeMb", "localPath"` then `DROP TYPE core."AiModelDownloadStatus"`). Applied to dev and test; `prisma migrate diff` printed the empty migration. The Prisma fields, the domain trio fields, the DTO fields and the console download panel are gone with them; no reader remained at the drop (grep pasted in the TASK-890 wave-2a close) |
| `AiModelFormat` cloud pseudo-values (`CLOUD_API`, `AZURE_SPEECH`, `AZURE_FOUNDRY`, `SARVAM`, `OPENAI`); `AiModelSource.MLFLOW`, `GITHUB` | TASK-860 | R1 | R3 | `deploymentKind = CLOUD` + `libraryName` (+ `wireModelId` for the vendor wire id) | marked — the `/// @deprecated TASK-860` markers are in place on all seven members (`enums.prisma`). Unlike the columns above these are Postgres ENUM VALUES, so removal is a schema rewrite, not a column drop, and the STT pipeline surface still binds engines by the format values until TASK-861's `AsrPipeline` retirement lands in R4 |
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
| `stt` palette (8 node types), `WF-STT-*` rules, `stt-pipeline.compiler.ts`, `stt-pipeline-resolver.service.ts`, `stt_placeholder.py` | TASK-861 (node types marked by TASK-864; step 10 closed by TASK-867) | R2 | R4 | ASR Agent | **removed (TASK-893 Phase 4, 2026-09-08)** — the eight descriptors, their `NODE_CONFIG_SCHEMAS` / `NODE_PORTS` entries and their Python specs are DELETED. Nothing is `implemented: false` any longer, so the deliberate TS/Python asymmetry TASK-867 documented is CLOSED and both parity guards now assert its inverse. `stt-pipeline.compiler.ts` and `stt-pipeline-resolver.service.ts` are NOT in this lane's ownership and remain — see the R4 row below |
| `summarization`, `consultation`, `agentic` palettes + the palette-less `noop`/`passthrough`/`core.start`/`core.end`/`guard.*` (50 node types) | TASK-864 | R2 | R4 | `core.*` vocabulary (+ the `core.action` catalogue, seeded Agents) | **removed (TASK-893 Phase 4, 2026-09-08)** — `WORKFLOW_NODE_REGISTRY` is the eleven `core.*` types (72 → 11) and `registry.py` the eleven matching `NodeSpec`s (64 → 11); `grep "deprecated: true"` returns 0. Seventeen of the retired types SURVIVE AS ACTIONS behind `core.action` (`action-catalogue.ts` / `action_catalogue.py`) with their descriptors, ports, schemas and activity callables copied verbatim — they are no longer node types, and their `mandatory` / `redaction` / `activity` classes reach a rule or a finding through `classesOf(type, config)`. `WF-CONS-*` and `WF-SUMM-*` are deleted from `rule-catalogue.ts`; the worker's served activity list is derived from the catalogue and is now exactly what is dispatched (65 → 29). **Deploy precondition: in-flight harness workflows must be DRAINED first** — a history recorded against a legacy node type no longer replays (see the R4 note below) |
| `EXPOSURE_ALLOWED_PALETTES` | TASK-864 | R2 | R4 | class-based exposure boundary (`clinicalWriteViolation`) — the palette sets now admit `core` and are consulted only for legacy graphs | marked |
| Harness `_llm_policy.get_policy(task_key)` over `AiTaskDefault` | TASK-863 | R1 | R3 | `/internal/agents/resolve` + `AiRoutingPolicy` | planned |
| `HarnessPolicy.textProvider`, `textModel` | TASK-863 | R1 | R3 | Agent binding | **removed (TASK-881, 2026-09-06)** — columns dropped (migration by the orchestrator), PATCH fields and console controls gone; the response fields stay, derived from the assigned TEXT_GENERATION agent (TASK-876) |


### TASK-893 Phase 4 — replay compatibility is a DEPLOY PRECONDITION, not a code gap (2026-09-08)

Deleting a node type from `NODE_REGISTRY` changes what the interpreter SCHEDULES for a graph that
used it: the type resolves to no spec, the walk records an observable `SKIPPED(unsupported_node_type)`
step, and no activity is dispatched. A Temporal history recorded when that node DID dispatch then
replays against a command sequence that no longer issues the activity, which is a
`NondeterminismError` — measured, not predicted:

```
TMPRL1100 Nondeterminism error: Complete workflow machine does not handle this event:
HistoryEvent(id: 11, ActivityTaskScheduled)
```

Six backward-guard replay tests failed for exactly this reason. They are now RESOLVED under the
owner ruling of 2026-09-08 (`docs/implementation/TASK-930-Agent-Workflow-Platform-Commitments/README.md`
§4.5): a recorded history stops being evidence once the vocabulary it replays is retired by
decision, so the fixtures are **re-captured onto `core.*` graphs** and the suite proves replay
compatibility of the CURRENT vocabulary. `_capture_interpreter_replay_fixture.py` builds the same
three command shapes (multi-stage walk, fan-out stage, one DEGRADED node settling alongside
SUCCEEDED siblings) out of `core.trigger` / `core.agent` / `core.output`.

Two consequences worth recording, because neither is visible from the test names:

* **The pre-stream era is now SYNTHESISED, not historical.** The shipped interpreter emits a
  run-completed event on every run, so no capture of it can omit the `task-849-run-event-stream`
  marker. `--no-stream` suppresses the mirror for the capture only (unsandboxed runner); replay
  always runs against the real method, so the guard — "a history with no marker still replays with
  the emits skipped" — is unchanged. It is synthesised because the genuine pre-stream recordings
  walked the retired `noop`/`passthrough` seed types.
* **`TestCoreVocabularyReplayCompatibility`'s backward guard is re-stated, not weakened.** It used
  to read "no history recorded before this ticket carries a `core.*` node". Every fixture is a
  `core.*` graph now, but `_CORE_PATCH` is consulted only for `core.humanReview` and `core.loop` —
  the two types dispatched as CHILD WORKFLOWS — and neither interpreter fixture carries one, which
  is exactly what the cheap-operand-first gate promises.

A `workflow.patched` marker cannot rescue an in-flight run, because a patch needs the OLD path to
still exist and the old path IS the deleted registry entries. So the mitigation is operational and
**stands unchanged**:

> **Drain in-flight harness workflows before deploying the Phase-4 image.** Any run still executing
> against a legacy-vocabulary definition must complete (or be terminated) first.

### TASK-893 fix-up — the agentic-loop subsystem, removed (2026-09-08)

`agentic.loop` was the only dispatcher of `AgenticLoopWorkflow` / `AgenticSubAgentWorkflow`, and it
left `NODE_REGISTRY` in Phase 4. Under OD-2 (a deprecated thing is removed completely) the orphaned
subsystem is deleted rather than left as unreachable workflow types the worker still registers:

| Removed | Note |
|---|---|
| `interpreter/loop_workflow.py` (`AgenticLoopWorkflow`, `AgenticSubAgentWorkflow`, their ids, `exhausted_bound`, `_result`) | `exhausted_bound` MOVED into `core_loop_workflow.py` and re-typed on `CoreLoopState` / `CoreLoopBounds`; `core.loop` reused it |
| `AgenticLoopBounds` / `AgenticLoopNodeSpec` / `AgenticLoopState` / `AgenticLoopInput` / `AgenticLoopResult` / `AgenticSubAgentInput` (`interpreter/models.py`) | `LoopStopReason`, `LoopCheckpointInput` and `LoopStateCheckpoint` are KEPT — `core.loop` uses all three |
| `_LOOP_PATCH` (`task-848-agentic-loop-child`), `_LOOP_NODE_TYPE`, `_loop_node_spec`, `_run_loop`, the loop-body index and its `SKIPPED(loop_body)` preflight (`interpreter/workflow.py`) | — |
| Both workflow registrations in `temporal/worker.py` | — |
| `interpreter/nodes/agentic.py` (all eight `interpreter.agentic_*` activities) | Dead since Phase 4: none was in `NODE_REGISTRY` OR `NODE_ACTIVITIES`. `interpreter_agentic_data` was its one live entry point (delegated to by `core.data`) and its body moved verbatim into `interpreter_core_data` |
| Tests: `test_agentic_loop_task848.py`, `test_task849_loop_iteration_emitter.py`, `_agentic_loop_stubs.py`, `_capture_loop_replay_fixture.py`, `fixtures/interpreter_loop_v1_history.json`, `test_agentic_nodes_task847.py`, `test_task849_agentic_tts.py`, `test_io_schema_tier3_task848c.py` | The data-reshape and TTS cases were RETARGETED (`test_core_data_reshape.py`, `test_core_agent_speech.py`), not dropped |

**`interpreter/loop_activities.py` is NOT deleted**, contrary to the first reading of the ruling:
`core.loop`'s `LoopWorkflow` schedules `interpreter.loop_state_checkpoint` on every iteration, so
the module is a live part of the SHIPPED vocabulary. Only its docstrings were re-keyed off the
agentic loop.

**Replay implication of dropping `_LOOP_PATCH`.** The marker existed because pre-TASK-848 histories
recorded `agentic.loop` as an ACTIVITY while the shipped code dispatched it as a CHILD WORKFLOW.
Removing the gate means neither shape replays any more — both are the deleted node type. This adds
no NEW deploy risk: it is the same drain precondition above, for the same reason, and a history
carrying an `agentic.loop` node is already unreplayable through `NODE_REGISTRY` alone.

**One behaviour was rescued rather than deleted.** `agentic.tts` streamed every synthesis frame on
the delta lane (`run_event_producer().emit_token_delta`); `core.agent`'s `_run_speech`, which
replaced it, stored the artifact but streamed nothing — so the audio half of the two-lane split had
been silently lost with the node type. The emission is ported into `_run_speech` and measured by
`test_task849_audio_two_lane_split.py`.

## Admin console routes and features

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `/ai-platform` (hub) + `features/ai-platform` | TASK-862 | R1 (redirect) | R3 | `/ai-providers`, `/ai-models`, `/agents`, `/ai-services/*` | marked — `redirect('/ai-providers')` stub; feature folder deleted |
| `/ai-task-defaults` redirect stub | TASK-862 | — | R1 | — | removed |
| `/ai-runtime-profiles` | TASK-862 | R1 | R1 (no nav entry) | — | removed |
| `/ai-configuration` (Speech & Voice) | TASK-861/862 | R2 (redirect) | R4 | `/agents` | marked (TASK-861: the Speech tab is a retirement notice pointing at `/agents?task=SPEECH_TO_TEXT`; TASK-888: the Voice tab is now only links to `/agents?task=TEXT_TO_SPEECH` — the row behind it is gone. The route still renders `SpeechAndVoiceScreen` because the Speech tab reads the LIVE `TenantSttConfig`; the `redirect('/agents')` lands when THAT binding retires) |
| `/ai-operations/reconciliation` | TASK-862 | R1 (redirect) | R3 | `/ai-operations/consumption` | marked — redirect stub |
| `/audio/pipelines`, `features/audio-pipelines` | TASK-861 | R2 (redirect) | R4 | `/agents?task=SPEECH_TO_TEXT` | marked — `page.tsx` is `redirect('/agents?task=SPEECH_TO_TEXT')` (`loading.tsx` deleted), nav entry removed; `features/audio-pipelines` kept with `@deprecated` on the api index + screen (no route mounts it) — `useAudioPipelines` still feeds the two playgrounds until TASK-865 gives `audio.start` an `agentSlug` |
| `/harness/pipeline-policy`, `features/pipeline-policy` | TASK-861 | R2 (redirect) | R4 | workflow assignments | marked — `page.tsx` is `redirect('/workflow-studio/assignments')` (`loading.tsx` deleted), nav entry removed; feature folder kept with `@deprecated` on the api index + screen |
| `features/tenant-stt-config` | TASK-861/862 | R1–R2 | R3–R4 | agents | marked (TASK-861: `stt-fallback-form.tsx` deleted, `stt-fallback-tab.tsx` is a retirement notice, `features/tenant-stt-config/api` `@deprecated`). `features/tenant-tts-config` is **REMOVED (TASK-888)**; `speech-and-voice-screen` moved here, into the feature of the one binding it still reads |
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
| `16-ai-task-default.ts` (replaced by `16-ai-routing-policy.ts`), `18-ai-runtime-profile.ts`, `llm:sarvam` connection row — DONE; `19-tenant-tts-config.ts` + `tenant-tts-config-seed.test.ts` — DONE (TASK-888) | TASK-862 |
| 10 catalogue rows not in the owner's list; `RETIRED_AI_MODEL_SLUGS` ledger extended | TASK-860 |
| `21`, `23`, `24` workflow seeds — **removed 2026-09-08**, and REBUILT in `core.*` from scratch rather than migrated (owner directive TASK-930 D-8; TASK-893 Phase 3 superseded). The owner question this row recorded ("the consultation rule set `CR-*` keys on `consultation.*` types, so a `core.action` rewrite needs the rules retargeted first") is answered: `WF-CONS-*` is deleted and the clinical steps carry their classes in the action catalogue, so a rule written against a class still fires on a migrated node. Deleted with them: `07e-consultation-loop-defaults.ts`, `07g-consultation-legacy-context-schema.ts` and both regen scripts; the replacements are `07e-consultation-note-context-schema.ts` (the ONE trigger context schema), `28-workflow-library{,.generated}.ts` (Global + SYSTEM) and `29-arcaai-agents-and-workflows{,.generated}.ts` | TASK-864 → TASK-893 / TASK-930 |
