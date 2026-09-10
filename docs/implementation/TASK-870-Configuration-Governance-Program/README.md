# TASK-870 — Configuration Governance Program

| | |
|---|---|
| **Status** | **Completed** (closed out 2026-09-10 — see §Close-out) |
| **Type** | refactor / feature (program) |
| **Branch** | `dev-2.2` (all lanes merge here) |
| **Base** | `c364bb8ec` |
| **Owner decisions** | 10 answers + 4 follow-up directions, recorded in the review artifact and restated below; 12 post-close owner items, dispositioned in §Close-out |
| **Review record** | https://claude.ai/code/artifact/d0acc802-b6da-47f2-b83f-0b4b3ff7e541 |

## Requirement Analysis

A two-day review of all 341 settings-registry descriptors, run after the audio-pipeline
retirement (TASK-861/865) and the AI-consolidation program (TASK-859..864), established for
every key whether it is read, whether changing it does anything, and — against the owner's
target model — where it belongs. The owner then answered every open decision. This program
executes the result.

**The target model, as decided (2026-09-05):**

1. BYO keys — a tenant admin provides them; each affects only that tenant.
2. Built-in providers (LM Studio, Ollama, NLP, TTS, vLLM) — the platform admin manages them.
3. Capabilities are agents and workflows, cloned from SYSTEM templates or any existing agent.
   Global (`50000000-…`) is the platform's build-and-test tenant; SYSTEM (`00000000-…`) is the
   template every customer tenant refers to and the tenant template for new tenants. A
   multi-tenant admin syncs among his own tenants; tenant admins import/export JSON.
4. Fallback is a platform HA capability: every agent falls back to the platform default
   provider on outage, by default, metered as platform-funded. The toggle is per agent node.
5. Guardrail is built-in and platform-only. It gates every text-generation request before send
   and every response after receive, for built-in and BYO providers alike. No tenant admin
   manages any guardrail setting.
6. Settings exist for platform admins to control platform behaviour. No tenant-managed
   conditions (department, visit type); developers branch in workflows; tenant admins align
   agents by key:value tags. Admins overwrite an agent's hyperparameters and instruction by
   injected context or hard-coded node values, not by settings.
7. Priorities: transcription, text generation, NLP, and safety against jailbreak/injection
   first; harness policy later. Redundant settings from the old architecture are removed
   completely, not dual-homed.
8. **Diarization is an ASR-agent option, OFF by default (owner, 2026-09-05).** The platform does
   NOT keep `stt.diarization.hfModelId` as "the" embedding space. The ASR agent node carries
   `diarization.enabled`, and the admin declares the embedding model(s) for diarization on the
   agent. When enabled, the runtime diarizes automatically and labels the transcript either with
   generic labels (speaker 0, speaker 1, …) or with labelled embeddings — the enrolled voice
   profile of the end-user who is using the agent/workflow. Consequence: enrolled profiles must
   live in the embedding space of the model that will match them, so the profile store is keyed
   by embedding model, not pinned to one dimension.

**Outcome the program lands:** 341 → 208 registry keys; tenant-scoped keys 59 → 6 (the five
clamped security floors plus the platform-written credential ceiling); the old text-selection,
ASR-pipeline, pipeline-policy and tenant-guardrail surfaces removed; nine capability gaps
closed. Per-key decisions, prerequisites and the removal list are in the review artifact.

## Current State Evaluation

Verified facts the lanes build on (file:line references point at `c364bb8ec`):

- `_apply_guardrail_gate` (`apps/text/src/text/api/endpoints/generate.py:149`) is the only
  moderation gate in `apps/text` and runs once, on the request (`:435`). Both `stream.py`
  routes are `GET` replay endpoints over a generation only `POST /generate` can start, so
  input is gated on every path and output on none.
- STT streaming attributed a whole session to ONE engine — and, as TASK-874 established, to
  whichever engine was loaded LAST (`_session_asr_formats`), not the primary as first recorded
  here. A BYO session that failed over billed every minute as platform `CLOUD`; one that switched
  back hid the platform's fallback minutes inside `BYOK`. Both directions mis-billed. Separately,
  `asr-agent-resolver.service.ts:169-178` resolved one `fundingTier` per session first-wins — a
  latent trap with no consumer yet. TASK-874 replaced both with per-engine usage segments
  anchored to the session totals (`Σ segments == audio_seconds`), additive on the wire and
  backward-compatible in both directions.
- `AiRoutingPolicyRepository.findCandidates` (`:93-100`) hard-filters `resourceStatus: ENABLED`
  + `enabled: true`; `resolveDefault` (`ai-routing-policy.service.ts:176-179`) widens to SYSTEM
  on an empty tenant tier. Guardrail (`tenant_config.py:198,517`) treats DISABLED as a veto.
- `svc:admin:*` scopes are renamespaced from `apikey-scopes.registry.ts`; the seed test at
  `service-account-seed.test.ts:113` asserts `tenant-storage:manage → manage:Tenant` while
  30 routes across 8 controllers require a different subject.
- 46 descriptors are dead with no prerequisite (list: `REMOVE-DEAD`/`REMOVE-FALLBACK` rows with
  an empty `prerequisite` in the review's reconciled decisions). No seed writes any of them;
  no live DB row holds any of them.
- `apps/text` had the `pythonpath` half of the worktree guard but not the `conftest.py`
  `assert_source_tree` half (rule 14 §4); TASK-871 added it (and found two more packages —
  `hope_otel`, `hope_async_contract` — resolving from the primary checkout until it did).

### Corrections established during wave 1

- **`text.serviceToken` and `tts.serviceToken` are NOT dead.** The review traced only the
  Python side, where each service's `config.py` retired them; the gateway still fetches both
  through `SecretsService` (`TEXT_SERVICE_TOKEN` at `base-proxy.controller.ts:68` and as the
  fallback after `INTERNAL_ACCESS_TOKEN` in `text-proxy`/`text-compat`; `TTS_SERVICE_TOKEN`
  at four `apps/api` sites). `vault-seed-secrets.sh` derives its key list from the
  descriptors, so removing one silently breaks a Vault deployment. Both KEPT by TASK-872;
  retiring the gateway readers in favour of the shared `internal.accessToken` is `apps/api`
  work for a later wave. `nlp.serviceToken` was genuinely dead and is removed.
- **The three `stt.streaming.{batchWaitMs,embeddingDevice,multiGpuStrategy}` descriptors are
  removed, but their override branches at `apps/stt/src/stt/streaming/execution_profile.py:377-387`
  survive as dead code** (the fields can now only hold their code default). Behaviour is
  unchanged — those values never reached a consumer — but the branches belong to the wave-2
  ASR lane that owns `apps/stt/streaming`.
- **The five dead `models.*` task keys keep their `AI_TASK_KEYS` entries and seed rows**; only
  the descriptors went (via a documented `UNCATALOGUED_TASK_KEYS` list). They are an OpenAPI
  enum, a console catalogue, seed elections pinned by tests, and three recorded open owner
  decisions — retiring them is the `models.*` family retirement in wave 2, with the
  five-artifact regeneration.
- **A behaviour change on fresh local setups, correct per the 2026-08-22 owner decision:**
  removing `entitlements.enabledDefault` drops `ENTITLEMENTS_ENABLED_DEFAULT=false` from the
  generated `.env.sample`, which `pnpm setup:dev` copies into `.env.dev`. That committed sample
  had been forcing quota enforcement OFF on every new laptop against the decision that local
  dev runs ON. Existing `.env.dev` files are untouched.
- Registry size after wave 1 is **286**, not the 287 the plan implied: TASK-872 removed 55 —
  the 46 with no prerequisite, the five dead `models.*`, the three judge keys that went with
  `guardrail-policy.descriptors.ts`, and `nlp.serviceToken` — while keeping the two live
  service tokens.

## Implementation Plan

Waves. A wave's lanes run in parallel in separate worktrees with disjoint file ownership; the
next wave starts only after the previous one is merged into `dev-2.2` and its gates re-run.

### Wave 1 — safety gate, fast wins, dead removal, metering

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-871 | Post-receive guardrail gate | `apps/text/**` | fable |
| B | TASK-872 | Registry cleanup + routing-policy veto: flip `globalOnly` on 5 keys; align `resolveDefault` to the three-state rule; remove the 46 dead descriptors and the dead plumbing beside them; amend `forcePathStyle` `consumedBy`; re-anchor the tighten-only floor tests | `packages/applications/src/services/settings-registry/**`, `.../ai-routing-policy/**`, `.../effective-config/**`, `packages/domains/src/repositories/generated/core/AiRoutingPolicyRepository.ts`, `packages/database/src/prisma/db_main/seed/16-ai-routing-policy.ts`, `apps/guardrail/src/guardrail/core/effective_config.py`, `apps/{harness,tts}/**/test_effective_config_retention.py` | opus |
| C | TASK-873 | Service-account scope alignment (widen `implies`), delete the two orphaned admin-console feature folders, regenerate the five API artifacts | `packages/applications/src/services/apiKey/**`, `.../serviceAccount/**`, `packages/database/src/prisma/db_main/seed/__tests__/service-account-seed.test.ts`, `apps/admin-console/src/features/audio-pipelines/**`, `.../features/pipeline-policy/**` (+ referencing tests/nav lines), `apps/api/route-manifest.json`, `apps/api/openapi.json`, the `api:portal` output, `packages/vox-node/src/resources/admin/**` | opus |
| D | TASK-874 | STT fallback funding on engine switch | `packages/applications/src/services/stt/**`, `apps/stt/src/stt/streaming/**`, `apps/stt/src/stt/core/api_client/**`, their tests | opus |

Deliberately NOT in wave 1 (shared surfaces the orchestrator serialises, or wave-2 prerequisites):
Prisma schema changes (`AiTaskDefault` table drop, `TenantFrontendConfig` client-AI columns,
display-only `PlanEntitlement` columns); `nlp.logging.*` removal (needs the deployment repo
confirmed for stdout logging); `apps/stt/src/stt/pipeline/spec.py` (wave 2 ASR wiring).

### Wave 2 — agent-first text, ASR spec wiring, guardrail outbound (base: wave-1 close commit)

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-876 | Agent-first text on both lanes: TEXT_GENERATION `fallback` block and SPEECH_TO_TEXT `decoding.{chunkLengthSec,strideLengthSec}` in the agent schema; a runtime reader for `AgentModelFallback` on TEXT_GENERATION; realtime `CoreAgentHandler` resolves `agentRef`, else the assigned agent; `resolveTextSelection` precedence 1 → the assigned TEXT_GENERATION agent; both lanes fall back to the SYSTEM-assigned agent on primary failure, honouring the per-agent-node toggle, funding derived per row | `packages/workflow-contract/src/agent-schemas.ts`, `packages/applications/src/services/{agent,agent-assignment,harness-policy,consultation/live-documentation}/**`, `apps/harness/src/harness/temporal/nodes/**`, `apps/harness/src/harness/temporal/_llm_policy.py`, their tests | fable |
| B | TASK-877 | ASR spec wiring: map `streaming.{partialIntervalMs,endpointing,maxUtteranceSec}`, `decoding.vadFilter` and the two chunking fields (declared optional on the Python wire) in `pipeline_spec_from_resolved`; an end-of-utterance model role; `build-resolved-asr-spec.ts` maps the new agent parameters; then delete the eight platform duplicates (`stt.streaming.partialIntervalS`, `stt.semanticEndpoint.*`), the dead override branches at `execution_profile.py:377-387`, and turn the punctuation boot gate into a lazy per-spec load | `apps/stt/src/stt/{pipeline,streaming,punctuation}/**`, `apps/stt/src/stt/core/control_plane.py`, `apps/stt/tests/**`, `packages/types/src/asr-spec.ts`, `tests/contracts/resolved-asr-spec.fixture.json`, `packages/applications/src/services/stt/agent-resolver/**`, `packages/applications/src/services/settings-registry/descriptors/stt-runtime.descriptors.ts` + its test | opus |
| C | TASK-878 | Guardrail outbound gaps from TASK-871: `jailbreak_detection` in `OUTBOUND_TASKS`, `usage_detail` on `ScreenResponse`, the containment-echo nonce; judge `temperature`/`maxTokens` from `config.py:32-33` literals to `AiModel._metadata.policy` (seeded on the guardian rows, resolved via `policy.py`); a new `guardrail.judge.timeoutSeconds` descriptor on the pull route replacing `config.py:34` | `apps/guardrail/**`, `apps/text/src/text/services/{external_guardrail,output_gate}.py` + tests, a new `descriptors/guardrail-judge.descriptors.ts` + its `registry.ts` spread + test, `packages/database/src/prisma/db_main/seed/06-ai-models.ts` + seed tests | opus |

Orchestrator-owned in wave 2 (shared surfaces, serialised after the lanes): the Prisma drops
(`AiTaskDefault` table + trio + `CoreDatabaseModule` registration; the five `TenantFrontendConfig`
client-AI columns; the three display-only `PlanEntitlement` columns; the per-tenant guardrail
availability column) — the Prisma CLI refuses a Claude-invoked migration, so these go through
the `prisma-local` MCP or the owner; `nlp.logging.*` removal — the deployment repo deploys
Loki (`base/loki.yaml`) and mounts no log volume for nlp, so stdout is the shipping path and the
eleven file/rotation keys are removable; no wave-2 lane owns `service-runtime.descriptors.ts`
+ `apps/nlp/core/logging.py`, so it is a wave-3 registry follow-up; post-merge artifact
regeneration; the e2e matrix at close.

Disjointness: A owns the agent schema file and B only reads its shape (`build-resolved-asr-spec`
maps `parameters` it receives, testable with fixtures); B owns `stt-runtime.descriptors.ts`
and does not touch `registry.ts`, which C edits for one spread line; C's two `apps/text`
files are the guardrail client and the output gate, which A never touches. Every worktree is
pre-built by the orchestrator (`pnpm install`, `pnpm db:generate`, `turbo run build`) before
its agent starts — both C and D in wave 1 lost time discovering an empty `dist/`.

### Wave 3 — the remaining moves and removals, then the capabilities (base: wave-2 close commit)

Computed, not remembered: the review's reconciled per-key decisions intersected with the
EXECUTED registry after wave 2 (277 keys). 79 keys still carry a non-keep decision; the six
end-state tenant keys (`apiKey.maxLifetimeDays`, `refreshToken.ttlSeconds`, `rateLimit.{enabled,
maxRequests,windowMs}`, `entitlements.featurePlatformDefaultCredential`) are already the only
tenant-scoped keys outside that list. Every lane below removes its keys COMPLETELY (descriptor,
reader, Settings field, seed, console reader) — never dual-homed. Registry target after 3a: 198.

Two sub-waves, because the capabilities touch the same service folders the moves clean up:

**3a — moves and removals (five lanes, disjoint by service and descriptor file):**

| Lane | Ticket | Scope (keys by reconciled decision) | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-879 | Speech path becomes agent-first: TEXT_TO_SPEECH agent resolution on `apps/api`'s speech path (`AgentAssignment` cascade, `agentSlug` selector, 404-over-403) — then 7 `tts.*` MOVE-TO-AGENT keys (`defaultVoiceEn`, `sarvam.model`, `indicParler.{hfModel,modelPath}`, `indicF5.{hfModel,modelPath}`, `limits.sampleRate`), 8 MOVE-TO-PROVIDER (`azure.{region,enabled}`, `sarvam.{baseUrl,timeoutS,enabled}`, `kokoro/parler/indicf5.enabled` → `AiProviderConnection` rows; self-host provider ids added to the vocabulary), 3 MOVE-TO-MODEL-METADATA (`indicParler.descEncoderPath`, `indicF5.{refAudioPath,refText}` → `AiModel._metadata`); retire the `TTS_SERVICE_TOKEN` readers in its own API module in favour of `internal.accessToken` | `apps/tts/**`, `apps/api/src/modules/tts*/**`, `packages/applications/src/services/{tts,tenant-tts-config}/**` + a new `agent/tts-agent-resolver*`, `descriptors/tts*.descriptors.ts` + tests, TTS rows in `seed/ai-models/*`, console `features/tenant-tts-config` | opus |
| B | TASK-880 | ASR remainder: 5 MOVE-TO-AGENT (`whisperCpp.consultationPromptEnabled` → `instruction.initialPrompt`; `vad.{modelPath,speechPadMs}`; `transcription.{chunkLengthS,strideLengthS}` — the SYSTEM agent's `decoding.*` is now the default, so the platform keys go), 5 MOVE-TO-PROVIDER (`azureSpeech.region`, `azureFoundry.{enabled,endpoint}`, `sarvam.baseUrl`, `openai.baseUrl`), 2 MOVE-TO-MODEL-METADATA (`whisperCpp.maxAudioSeconds`, `streaming.partialWindowS` → `AiModel._metadata.asr.*`); add `'endpointing'` to `ResolvedAgentModelRole`; `ASR_SPEC_FALLBACK_DEFAULTS` → `AGENT_FALLBACK_DEFAULTS`. **`stt.diarization.hfModelId`: the lane was briefed with the SUPERSEDED option 1 (keep as the platform embedding space; refuse a mismatching agent) before the owner decided otherwise — its slug-ref fix in `session_manager.py` stands, its `globalOnly` keep and its 409 refusal are removed by TASK-887 in the second batch** | `apps/stt/**`, `packages/applications/src/services/stt/**`, `descriptors/stt-runtime.descriptors.ts` + test, `packages/types/src/{asr-spec,agent}.ts`, `tests/contracts/resolved-asr-spec*`, ASR rows in `seed/ai-models/*` | opus |
| C | TASK-881 | `models.*` family retirement — all 12 keys and the `AiTaskDefault` facade: the 3 `models.text.*` + 2 `.fallback` are unread since TASK-876; the 7 MOVE-TO-ROUTING (`models.guardrail.{validate,safety,groundedness,pii}`, `models.nlp.{ner,diagnosis}`, `models.harness.judge`) already resolve through `AiRoutingPolicy.resolveDefault` — delete the descriptor projection, the effective-settings echo, `AI_TASK_KEYS`, the `AiTaskDefault` admin route + DTOs + service, the domain trio, the `CoreDatabaseModule` registration, the seed rows and the console readers (6 areas: `app/(console)`, `features/{harness-policy,playground-consultation,tenant-tts-config}`, `shared/{catalog,navigation}`); the `AiRoutingPolicy` admin surface is the ONLY selection surface. Edits `ai.prisma` to drop the model; the migration SQL is the orchestrator's | `packages/applications/src/services/{ai-task-default,ai-routing-policy}/**`, `descriptors/model-defaults.descriptors.ts` + test, `apps/api/src/modules/{ai-task-default,ai-routing-policy}/**`, `packages/domains/**/AiTaskDefault*`, the `AiTaskDefault` seed + `ai.prisma` model, those six console readers, `packages/vox-node` hand-authored `admin-resource.ts` only | fable |
| D | TASK-882 | Pipeline/workflow/harness repoints: REMOVE-DEAD `pipeline.{autoNerEnabled,harnessEnabled,dnaRedactionEnabled}` + `pipeline.templateResync.{enabled,cron}` (with `pipeline-template-resync.cron.service.ts`) + `consultation.visitTypes` (retire the `(task,visitType)→prompt` binding; workflow authors branch; tenants align by `Agent.tags`); MOVE-TO-WORKFLOW `pipeline.autoSummaryEnabled` (→ the workflow generation node's `enabled`), `agentic.revisit.carryForwardEnabled` (→ a context-binding field), `consultation.endpoint.actions` (→ the assigned graph's `trigger:'on-end'` chain); SPLIT `pipeline.dnaStyleEnabled`; MOVE-TO-HARNESS-POLICY `harness.{warmStartEnabled,nerPriorsEnabled,atomicFactEnabled}` (→ the SYSTEM `HarnessPolicy` row); the three `globalOnly:true` flips (`text.guardrailPolicy.{requireMedical,includeReasoning}`, `consultation.realtime.graphExecutor.enabled`); `modelSlug` off `GET /internal/harness/policy`; `withLlmBinding()` out of the node schemas; `HarnessPolicy.textProvider/textModel` + the `PipelinePolicy` columns dropped from `harness.prisma` / `pipeline.prisma` (SQL by the orchestrator) | `descriptors/{pipeline,visit-type,consultation-*,agentic-revisit,harness-sensor,text-guardrail-policy}.descriptors.ts` + tests, `packages/applications/src/services/{pipeline-policy,consultation,harness-policy,workflow-definition,prompt-management}/**`, `packages/workflow-contract/src/node-config-schemas.ts`, `apps/harness/src/harness/{core/config,temporal/interpreter/nodes}/**`, `apps/api/src/modules/{consultation,harness*,pipeline*}/**`, console `features/{harness-policy,agentic-policy,workflow-studio}`, `harness.prisma` + `pipeline.prisma` | fable |
| E | TASK-883 | Client-AI and display-only column retirement + service-runtime dead keys: `TenantFrontendConfig.{asrModel,noiseCancel,vad,voiceEnrollment,diarization}` (25 readers: console `features/{tenants,account,entitlements}`, `apps/api/src/modules/tenant-frontend-config`, `packages/agentic-sdk-v2` `frontend-pipeline-config.ts` + `useEntitlements.ts`, the applications service/DTOs/entitlement resolver, `seed/05-tenant.ts`); `PlanEntitlement.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess}` (no gate call site; the descriptor comment says they came from a three-row table); the 11 `nlp.logging.*` keys with `apps/nlp`'s file/rotation logging (stdout only — Loki confirmed, no nlp log volume in the deployment repo); the `TEXT_SERVICE_TOKEN` readers in `text-proxy` / `text-compat` / `base-proxy` → `internal.accessToken`. Edits `tenant.prisma` / `entitlement.prisma`; SQL by the orchestrator | `packages/applications/src/services/{tenant-frontend-config,entitlements}/**`, `apps/api/src/modules/{tenant-frontend-config,text-compat,streaming/text-proxy*}/**` + `src/shared/base-proxy*`, console `features/{tenants,account,entitlements}`, `packages/agentic-sdk-v2/src/{types/frontend-pipeline-config.ts,hooks/useEntitlements.ts,hooks/useTenantFrontendConfig*}`, `apps/nlp/**`, `descriptors/service-runtime.descriptors.ts` + test, `seed/05-tenant.ts`, `tenant.prisma` + `entitlement.prisma` | opus |
| F | TASK-887 | **Diarization as a declared agent option (owner decision 8; second batch, after lane B merges).** `diarization.enabled` stays OFF by default; the agent's `diarization.embeddingModelSlug` (a `SPEAKER_EMBEDDING` `AiModel` row) is the ONLY source of the embedding model — delete `stt.diarization.hfModelId`, its `Settings` field and the singleton loader; `stt.voiceProfile.minSimilarity` → the agent's `diarization.matchThreshold`; `stt.diarization.device` stays (process placement). Enrollment embeds with the model declared by the agent the end-user is enrolling for and stores `UserVoiceProfile.modelId` (mandatory); matching considers only profiles embedded by the agent's model; `embedding` becomes dimension-agnostic (`vector` without a fixed size — small per-tenant sets, no ANN index) via the orchestrator's migration. Labelling: generic `speaker N` when no profile matches, the end-user's profile label when one does. Console + SDK enrollment pass the agent (`agentSlug`) they enroll for | `apps/stt/src/stt/{diarization,voice_profile}/**` + the diarization paths of `streaming/session_manager.py` / `transcription/batch_service.py`, `packages/applications/src/services/*voice-profile*/**` + `stt/agent-resolver/**` (embedding role), `apps/api/src/modules/voice-profile/**`, `packages/agentic-sdk-v2` voice-profile hooks, `packages/workflow-contract/src/agent-schemas.ts` SPEECH_TO_TEXT `diarization` block, `packages/types/src/asr-spec.ts` + `spec.py` + fixture, `user.prisma` (`UserVoiceProfile`) + its seed | opus |

Orchestrator-owned in 3a, serialised after the merges: ONE schema-retirement migration authored on
the shadow DB (rule 02 recipe) covering every column and the `AiTaskDefault` table the five lanes
removed from the `.prisma` files; the five-artifact regeneration (`api:route-manifest`, `openapi`,
`portal`, `gen:admin`) after lanes C and D/E; env-surface regeneration (`env:python-surface`
THEN `env:sync`, on a freshly built `@arcaai/applications`); deleting the `text.serviceToken` /
`tts.serviceToken` descriptors once BOTH gateway readers are gone (A owns TTS, E owns TEXT — the
descriptor file is shared, so the orchestrator makes the two-line edit); the e2e route-authz
matrix; `pnpm gen:model` + `gen:entity` / `gen:factory` reconciliation for the dropped model.

**3b — capabilities (after 3a is merged; these edit the agent and workflow services 3a cleans):**

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| F | TASK-884 | Agent capabilities: clone (from a SYSTEM template or any agent visible to the tenant — owner #2); key:value `tags` on agents + tag-based selection in the assignment cascade (owner #6 — the per-tenant/department condition surface that replaced visit types); agent import/export JSON (owner #4); a per-`core.agent`-node `overrides.fallback.autoSwitch` ONLY if the owner confirms it (else nothing) | `packages/applications/src/services/{agent,agent-assignment}/**`, `apps/api/src/modules/agent*/**`, console `features/agents`, `packages/workflow-contract/src/agent-schemas.ts` | opus |
| G | TASK-885 | Workflow capabilities: workflow import/export JSON and the Global → SYSTEM promotion path (owner #4: platform admin builds in Global, promotes into SYSTEM; SYSTEM is the template every customer tenant refers to and the new-tenant template); relax the promotion gate accordingly; multi-tenant admin sync among their own tenants | `packages/applications/src/services/{workflow-definition,workflow-assignment,promotion}/**`, `apps/api/src/modules/workflow*/**`, console `features/workflow-studio` | opus |
| H | TASK-886 | Guardrail per-tenant availability (owner #3): a SYSTEM-managed, super-admin-only per-tenant row saying which safety policies apply to a tenant; every request/response still passes the gate (availability selects policies, it never disables the gate); `injectionScreeningCriteria` gets its reader or goes | `apps/guardrail/**`, `packages/applications/src/services/guardrail*/**`, `apps/api/src/modules/guardrail*/**`, console `features/security-policy` | opus |
| I | TASK-889 — wave-3b residue (19 files, +1000 / −134, merged at `58afbbcda`; regen + style `e6b01de55`): the workflow bundle rides the shared portable-bundle contract F introduced (`kind: 'workflow'`, the shared validator on import — G's local alias retired); both tenant-to-tenant syncs run membership-bounded through `runInTenantContext` (source read under the source tenant, each copy written under its target — the agent sync had been unchecked on the unscoped client), proven over the REAL tenant-scope extension; a multi-tenant admin's sync gets a data path across their own tenants; one integration proof (`agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts`) is `skip`ped until the test DB is reset. Five artifacts regenerated (bundle schema, sync route description). | `58afbbcda` + `e6b01de55` | workflow-contract 1548 · applications 11687 (665 files, 6 skipped) · api 4187 · database 1731 + the 8 pre-attributed · scripts+contracts 464 · admin-console build/lint green, 2287 · vox-node typecheck + 375 · gen:model/entity/factory:check, openapi/portal/gen:admin drift checks, env:sync:check all rc=0 · applications lint 0 errors · **boot + matrix on the final tree:** the test API on 8968 served `0.0.0-dev-2-2.e6b01de5` healthy (every boot audit passed) and `task-776-route-authz-matrix` 7 passed against it | removed (`task-889-wave3b-residue` deleted) |

Owner decisions still open for wave 3 (each lane carries the default assumption above until told
otherwise): (1) diarization — DECIDED 2026-09-05 (target model item 8, lane F/TASK-887); (2) per-node fallback override — assumed NOT
wanted (the agent-level toggle covers both lanes); (3) the exact semantics of "per-tenant guardrail
availability" — assumed policy SELECTION, never gate removal.

### Rules every lane follows

- **Boot smoke is a gate (added 2026-09-06 after TASK-886).** A lane that adds or changes a controller must prove the gateway BOOTS: `pnpm api:build` then `NODE_ENV=test node apps/api/dist/main` (or `pnpm test:up:api`) until `/api/v1/health` answers, and paste the line. The boot audits (`service-account-surface-audit`, the admin-scope audit, the deny-by-default authz audit) run only at startup; unit suites do not exercise them, and a silent admin route is refused there.

- TDD: failing test first, evidence pasted (rule 01). Python lanes run under `arcaenv` from the
  worktree; lane A adds the `assert_source_tree` guard to `apps/text` conftest before trusting
  a result.
- No `git stash`, no `pnpm install`, no `db:*`, no Docker, no merges, no artifact regeneration
  except lane C (rule 14 §3). No touching files outside the lane's ownership column.
- Each lane keeps its own `docs/implementation/TASK-87N-*/README.md` through the lifecycle.
- Merge target is `dev-2.2`, merged by the orchestrator from the primary checkout, gates re-run
  after merge, worktree removed only after the merge commit exists (rule 14 §5).

## Implementation Summary

### Wave 1 (in progress)

| Lane | Ticket | Merge commit | Post-merge gates (primary checkout) | Worktree |
|---|---|---|---|---|
| A | TASK-871 — post-receive guardrail gate | `9a8e2af0b` | `pnpm text:test` 1614 passed / 4 skipped (1587 baseline + 27 new); `pnpm text:typecheck` clean | removed |
| C | TASK-873 — scope alignment, dead console folders, artifacts | `76686c60d` | applications 660 files / 11514 tests passed (a first run showed 13 files failing to load — a concurrent `api:build` rewriting `dist/`; clean re-run green); database 1767 passed; `api:build` clean; `api:openapi:check`, `api:portal:check`, `gen:admin:check` all no-drift; admin-console build + lint clean, 2269 tests; vox-node typecheck clean, 375 tests | removed |
| B | TASK-872 — registry cleanup (341 → 286) + six `globalOnly` flips + routing-policy veto | `94a311e4d` | applications 659 files / 11519 tests; domains 161 files / 1919; database 79 / 1767; api 280 / 4211; applications lint 0 errors; repo lint 39/39; all three drift checks no-drift; `stt:test` 1 failed / 3181 passed (the pre-existing MinIO env test); `tts:test` 459; `guardrail:test` 426; `harness:test` 6 failed / 2091 and `nlp:test` 2 failed / 583 — both sets pre-existing: the merged wave-1 diff under `apps/harness/` is `.env.sample` plus one retention test fixture, and touches nothing under `apps/nlp/`, `apps/harness/src/harness/temporal/` or the replay fixtures. First agent stalled on the harness watchdog after three commits; a continuation resumed on that tree and finished (ten commits total). | removed |
| D | TASK-874 — STT fallback funding per engine segment | `f8f7835a1` | `pnpm stt:test` 1 failed / 3193 passed / 210 errors — identical to the lane's baseline (the failure is the pre-existing `test_minio_credentials_default_to_empty`; the errors are integration tests with no test DB); `stt:lint` clean; `stt:typecheck` clean (140 files); applications 660 files / 11521 tests (+7 = the lane's new TS cases); api 280 files / 4211 tests; artifacts regenerated with zero diff (the usage callback is a doc-excluded internal route, so the DTO change never reached `openapi.json`); all three drift checks no-drift; vox-node typecheck clean, 375 tests | removed |

Lane A chose design (d): gate the assembled completion at end-of-stream for SSE (published tokens
cannot be recalled; buffering would kill time-to-first-token) and buffer-then-gate on the
non-streaming path; rejection is a terminal `error` frame every existing consumer discards on,
the task is `FAILED`, nothing persists. It also released the provider concurrency permit before
the gate (a guardrail outage would otherwise pin a slot per request). Guardrail's outbound screen
exists (`POST /api/v1/guardrail/screen/outbound`) but lacks `jailbreak_detection`, a
`usage_detail`, and a nonce — owed to a guardrail lane in wave 2.

Lane C evaluated per `(route, declared scope)` — `enforceServiceAccountScopes` is
`required.some(...)` — and found 31 mismatches over 9 controllers (one more than the audit's
union view). Two routes were narrowed rather than over-granting: `GlobalSettingController`
reveal/rotate now `@ForbidServiceAccount()` (they re-authenticate the caller's own password, so a
machine could never have executed them); `PromptManagementController.assignDepartment` narrowed
`manage:Department` → `update:Department`. A per-scope regression guard
(`svc-scope-route-ability-coverage.test.ts`, 436 cases) now walks the manifest. Both orphaned
console folders deleted (no live import). Lane C ran `pnpm db:generate` once in its worktree —
pure codegen, no DB contacted — and disclosed it.

**Wave-1 close-out — e2e route-authz matrix: GREEN.** `task-776-route-authz-matrix.spec.ts`
ran against `dev-2.2` at `6123ffbb1` (all four lanes plus the owner's TASK-869 merge) on the
existing seeded test DB with `RESET_DB=false` — no wave-1 lane changed a seed file, and the
Prisma CLI refuses a Claude-invoked `db push --force-reset` by design — after the owner stopped
the TASK-869 watch-mode API that held 8968: **7 passed (2.1 s)**, API healthy after 90 s.
Containers left up.

**TASK-869 merge verified non-reverting.** Of the 129 files wave 1 changed, 869's merge later
touched three: `.env.sample` and `turbo.json` (both additive — two new `SEED_*` variables) and
this README (no change on 869's side; the overlap was this file's own later commit). All six
paths wave 1 deleted remain absent; the veto (`task-selection-veto`), the output gate
(`screen_output`), the usage segments (`usage_segments`) and the scope guard test are present
at HEAD.

**Wave 1 status: COMPLETE.** Registry 341 → 286 (executed). Four lanes merged, gated post-merge
in the primary checkout, worktrees removed, branches deleted.

### Wave 2 (in progress)

Base `030df76b5`. Two owner-session commits landed on `dev-2.2` mid-wave (`3f0adf98a`, `5c6c17dfc`
— `scripts/**` and the generated env artifacts); every lane merge is intersection-guarded against
whatever `dev-2.2` accumulated since the base, and each row below states the result.

Two reds are on `dev-2.2` for the whole wave and belong to neither the wave nor the program:
(1) `@arcaai/database` — 8 seed tests in `ai-model-registry-seed.test.ts` / `task-863-agents.test.ts`,
all one cause: `9a21f7edc` (TASK-869) seeded a 36th catalogue row (`whisper-large-v3-turbo-q8_0`)
against tests pinned at "exactly 35 SYSTEM rows" and 9 agent specs; (2) `@arcaai/api` lint — 5
errors (4 prettier, 1 unused import) in three e2e specs last touched by TASK-869
(`harness-gate.spec.ts`, `shared-component-contracts.spec.ts`) and TASK-875
(`auth-throttle-per-endpoint.spec.ts`). No wave-2 lane owns any of those files.

| Lane | Ticket | Merge commit | Post-merge gates (primary checkout) | Worktree |
|---|---|---|---|---|
| C | TASK-878 — guardrail outbound judge: `jailbreak_detection` in `OUTBOUND_TASKS`, `usage_detail` on `ScreenResponse`, the containment-echo nonce; judge `temperature`/`maxTokens` moved from `config.py` literals to `AiModel._metadata.policy` (seeded on the SYSTEM guardian row, fail-closed); `guardrail.judge.timeoutSeconds` on the pull route | `dfd4102a6` | `guardrail:test` 458 passed; `guardrail:lint` clean; `guardrail:typecheck` clean (44 files); `text:test` 1620 passed / 4 skipped; `api:build` clean; applications 660 files / 11525 tests; database 77 files / 1762 passed with the 8 pre-attributed failures above (no assertion touches the guardian row this lane re-seeded); `apps/api` lint = the 5 pre-attributed errors, `applications` lint 0 errors. Intersection guard: 10 files on `dev-2.2` since base × 28 lane files = ∅. | removed |
| B | TASK-877 — ASR spec wiring: `streaming.{partialIntervalMs,endpointing,maxUtteranceSec}`, `decoding.vadFilter`, chunking and semantic-endpointing fields wired from the resolved spec (`_endpoint_config`, a new `models.endpointing` role); nine platform duplicates deleted (`stt.streaming.partialIntervalS`, six `stt.semanticEndpoint.*`, `stt.punctuation.{enabled,modelName}`) plus the orphaned `semanticEndpoint.enabled` feature flag — registry 286 → 277 on the merged tree (B measured 276 in a worktree that predated lane C's `guardrail.judge.timeoutSeconds`: 286 − 9 − 1 + 1); the dead `execution_profile.py` override branches removed; punctuation loads per spec; batch chunking consumer; boot warm-up removed. **Diarization (deliverable 5) DEFERRED on evidence**: `stt.diarization.hfModelId` declares the embedding SPACE enrolled voice profiles live in (`UserVoiceProfile.embedding` is `vector(256)`, enrolled with the 256-d wespeaker model; the platform ASR agent binds a 192-d model), so wiring `models.embedding` through would fail every enrollment — owner decision pending, default assumption option 1 (keep the key as the platform embedding space, validate the agent's reference against it at publish) | `113d36978` (+ `012e66666` env-surface regeneration by the orchestrator) | Rebased onto `094d639f4` (clean, 5/5) and gated on the rebased tree, whose content the merge reproduced byte-for-byte: `stt:test` 1 failed (pre-existing MinIO) / 3188 passed / 210 errors (integration, no test DB), provenance guard silent; `stt:lint` + `stt:typecheck` clean (140 files); `@arcaai/types` build + typecheck clean; applications 660 files / 11535 tests, lint 0 errors; `tests/contracts` 16 files / 208 tests. Env artifacts regenerated in the right order (`env:python-surface` THEN `env:sync` — the generator reads the built `@arcaai/applications` dist and the Python surface JSON, so both must be fresh): `env:sync:check` + `env:python-surface:check` green, `env-sync.test.ts` 39/39, the nine names absent from all six artifacts. First agent finished 5 deliverables minus diarization; a `sonnet` continuation closed its three follow-ups. | removed |
| A | TASK-876 — agent-first text on both lanes: TEXT_GENERATION `fallback` block with governance defaults (autoSwitch ON, platform-controlled); `TextAgentResolverService` → `ResolvedTextGenerationSpec` with an ordered chain (explicit fallback agent → own model chain → the SYSTEM-assigned platform default), funding DERIVED per row and the toggle funding-gated (`effectiveAutoSwitch = toggle || funding !== tenant`); `resolveTextSelection` precedence 1 = the assigned TEXT_GENERATION agent (tenant → department threaded → SYSTEM); realtime `core.agent` resolves `agentRef` pinned fail-closed else the assigned agent; Temporal `core.agent` AND the durable documentation workflow walk the chain inside the activity budget (exhaustion → DEGRADED, never a re-billed retry); the prompt-template test path is agent-first; the internal resolve route ships `textPrimary` + `textFallback`; a tenant-keyed ≤ 30 s resolver cache for the live-flush hop; publish clamp honours pinned versions; endpoint-level chain dedupe; `switchAfterConsecutiveFailures` REMOVED from the TEXT block (no reader); `selection_source` → `assigned-agent`; `llmBinding`, the `text.*` task keys, the `HarnessPolicy` text columns and the frozen `liveLlm` tier retired. **Review gate:** an `opus` read-only review (7 lenses) returned 2 BLOCKERs, 6 MAJOR, 5 MINOR, 5 NOTE — the orchestrator verified the blockers in code (documentation workflow still on the policy columns; no funding gate on the toggle) and an `opus` fix lane closed all 13 actionable findings in the worktree (15 commits, each with a test) BEFORE the merge. The first `fable` agent stalled on the 600 s watchdog with all code committed and the README unfinished; the orchestrator finished the README from its own gate runs. | `9bbdc51b7` (24 commits; rebased three times onto the moving `dev-2.2` — 7/7, 8/8, 23/23, all clean) | Gates on the MERGED tree (primary): domains 161 files / 1919; workflow-contract 35 / 1492; applications 661 / 11559, lint 0 errors; api 280 / 4214, typecheck clean; database 77 / 1762 + the 8 pre-attributed failures; repo lint = the 5 pre-attributed errors only; `api:openapi:check`, `api:portal:check`, `gen:admin:check`, `env:sync:check` all clean; route-manifest regeneration produced no diff; harness 6 pre-existing replay failures / 2099 passed (2084 → 2099 reconciled: +5 in the core.agent fallback test, +10 in the new documentation-workflow fallback test), `harness:lint` + `harness:typecheck` clean (148 files); text 1620; stt 1 pre-existing / 3188; **e2e route-authz matrix 7 passed** against the API built from the merged tree. | removed |

**Wave 2 status: COMPLETE.** Registry 286 → 277 (executed). Three lanes merged, each rebased onto the current `dev-2.2` before merging (owner request), gated on the rebased tree AND on the merged primary, worktrees removed, branches deleted; the e2e route-authz matrix is green on the merged tree; no worktrees remain. Three owner decisions are carried as default assumptions into wave 3 (no per-node fallback override; guardrail availability = policy selection; diarization was decided by the owner right after — model item 8).

### Wave 3a (in progress)

Base `4923cac40` (+ the diarization-decision commit `eeadd5ecf`). First batch: lanes A (TASK-879), B (TASK-880), E (TASK-883) in parallel; second batch after they merge: C (TASK-881), D (TASK-882), F (TASK-887). Each lane is rebased onto the current `dev-2.2` before merging and gated on the merged primary; artifact regeneration (five API artifacts; `env:python-surface` THEN `env:sync` on a freshly built `@arcaai/applications`) follows every merge that changes a DTO or a descriptor.

Pre-existing reds carried through the wave, none in program files: the 8 database seed failures (TASK-869's 36th catalogue row), the 5 `@arcaai/api` e2e-spec lint errors (869/875), `nlp` 2 (`test_metrics_endpoint_task636.py`) and 3 `W291` lint errors from the pre-release comment cleanup `d2e3ec5fc`, `text` 2 `W291`, `harness` 6 replay-nondeterminism failures, `stt` 1 (`test_minio_credentials_default_to_empty`).

| Lane | Ticket | Merge commit | Post-merge gates (primary checkout) | Worktree |
|---|---|---|---|---|
| E | TASK-883 — client-AI column retirement: `TenantFrontendConfig.{asrModel,noiseCancel,vad,voiceEnrollment,diarization}` and the four `configJson` knobs that only tuned those stages; `PlanEntitlement` AND `TenantEntitlement` `.{featureDnaReports,featureVoiceEnrollment,featureMonitoringAccess}` (the override of a base that no longer exists went with it — grep pasted, no gate call site); the 11 `nlp.logging.*` keys with `apps/nlp`'s file/rotation logging (stdout only); the three gateway `TEXT_SERVICE_TOKEN` readers → the shared internal access token. Registry 277 → 266. **Not yet retirable:** `text.serviceToken` — ~10 `packages/applications` call sites still pass the legacy name to `resolveInternalAccessToken` as a fallback (plus `ai-model-discovery.service.ts:359`, two guard name-maps, the `common.service.module.ts` warm list); `vault-seed-secrets.sh` derives its key list from descriptors, so the descriptor stays until those are gone (batch 2 item). Two console surfaces lost UI deliberately (the plan editor's feature switches, the plan grid's Features column). SDK hard-off gate verified unweakened. Migration SQL (three `ALTER TABLE … DROP COLUMN` statements incl. `TenantEntitlement`) recorded in the ticket README for the orchestrator's single 3a migration. | `a04954c55` (+ `chore` regen commit) | `db:generate`; builds domains/types/workflow-contract/applications/api; domains 161 / 1919; applications 664 / 11572, lint 0 errors; api 280 / 4219, typecheck clean; database 77 / 1762 + the 8 pre-attributed; admin-console build + lint clean, 258 / 2269; `@arcaai/vox` 282 / 4373, typecheck clean; `gen:model:check` no drift (185), `gen:entity:check` + `gen:factory:check` schema coverage OK (104); five artifacts regenerated (openapi ×3, vox-node schemas, portal) and vox-node typecheck + 25 / 375 after; `env:python-surface` (387 names) + `env:sync` (150 TS keys + 339 Python fields), `env:sync:check` clean; `nlp:test` 586 passed + the 2 pre-existing, `nlp:typecheck` clean (59 files), `nlp:lint` = the 3 pre-existing `W291` in files the lane never touched. Worktree lesson recorded: the vox and admin-console suites need `@arcaai/ui` and the six audio packages built (41 phantom failures, 52 phantom `TS2307` until then) — batch-2 prep builds them. | removed |
| A | TASK-879 — the speech path is agent-first: `TtsAgentResolverService` + `ResolvedTtsSpec` (`packages/types/src/tts-spec.ts` ↔ `apps/tts/.../spec.py`, parity-pinned on `tests/contracts/resolved-tts-spec.fixture.json`; explicit `agentSlug` or the assignment cascade, 404-over-403; chain = explicit fallback agent | own `AgentModelFallback` chain, always terminated by the SYSTEM-assigned agent, `autoSwitch` funding-gated through the shared `effectiveAutoSwitch`; connection facts with per-row derived funding; the TEXT_TO_SPEECH schema gained its `fallback` block); `apps/tts` executes the pushed spec (`resolved_spec` REQUIRED on both surfaces, the router walks `candidate_chain`, every adapter `from_spec`, registration image-driven, routing enablement = the connection row); 18 `tts.*` keys moved to the agent / `AiModel` rows + `_metadata` / `AiProviderConnection` rows and deleted; three latent routing defects closed with tests (an absent optional engine crashed the router; a keyless cloud engine could be handed a session; duplex answered `ready` before an engine existed). Deferred with seams: `TenantTtsConfig` is now fully redundant (every reader retired, console read-only) but its model/trio/route/scope deletion is a lane of its own; `AiModel(indic-f5)` not re-seeded (CC-BY-NC provenance) so its four keys have a shape and no row; `black --check apps/tts` red on the untouched baseline. **Two corrections to the lane's report:** (1) it ran `git stash` / `pop` once in the worktree (rule 14 §3) — the shared stack was verified intact (`stash@{0}` only) by the lane and again by the orchestrator; (2) "all four `TTS_SERVICE_TOKEN` readers retired" was a PREFERENCE change, not a retirement — four outbound sites kept the name as a migration fallback and a fifth reader lived in the internal-token guard's name map; `vault-kv-coverage.test.ts` caught it the moment the descriptor went, and the orchestrator retired all five (`0b1ef2743`). | `e407f5d6a` (+ orchestrator commits `1e50834d7` handoffs, `1e81c4966` test pins, `960765fde` env regen, `0b1ef2743` fix set) | Intersection guard 126 × 83 = {`agent-schemas.ts`} (two blocks, auto-merged); rebased 20/20 onto `f987d17d5`; gates on the merged primary after the fix set: `tts:test` 412 passed / 3 skipped (459 → 412 reconciled in the lane README), `tts:lint` + `tts:typecheck` clean (41 files); `stt:test` 3189 + the 1 pre-existing; builds domains/types/workflow-contract/applications/api; workflow-contract 35 / 1493; applications 666 / 11638, lint 0 errors; api 280 / 4219, lint = the 5 pre-attributed; database + the 8 pre-attributed; `tests/contracts` 17 / 218; admin-console build + lint clean, 258 / 2270; `@arcaai/vox` 282 / 4373 + typecheck; scripts 15 / 239; `env:python-surface` 356 names / 309 fields THEN `env:sync` 149 TS keys, both checks clean; five artifacts regenerated (`HarnessSynthesizeSpeechRequest` gained `agentSlug`, `voice` optional), `api:openapi:check` / `api:portal:check` / `gen:admin:check` clean, vox-node 25 / 375. | removed |
| C (batch 2) | TASK-881 — `models.*` family and the `AiTaskDefault` facade retired (144 files, +1307 / −4164): the 12 descriptors and the `EffectiveSettingsService` `models.*` lane gone (asserted absent per key, no `models.` prefix survives); the task-key vocabulary re-homed to `ai-routing-policy/constants.ts` minus the five text keys; every reader (NER injection ×3, harness judge, effective-config `modelWeights`, `ai-inference`, `text-proxy`) calls `resolveDefault(…, { systemOnly: true })` directly; the `admin/ai-task-defaults` routes, tag, `admin:` + `svc:` scopes, bootstrap rows, CASL grant and e2e spec deleted; the Prisma model, domain trio, `CoreDatabaseModule` and tenant-scope entries deleted (`ResourceType.AiTaskDefault` kept, marked retired — a Postgres enum value cannot be dropped in place); `HarnessPolicy.textProvider/textModel` dropped from schema, entity, factory, knobs, DTO, console controls and seed (the response fields stay, derived by the assigned-agent overlay); seeds: 3 `text.*` elections + 2 fallback exemptions gone; console: the dead `ai-task-keys` catalogue + lockstep test deleted. Deferred: the facade's write-time `AiModel.taskType` ↔ task-key check never existed on `AiRoutingPolicyService.create/update` (seam recorded). **Owner decision pending:** a soft-retire `UPDATE` for the five stale `text.*` routing rows (the lane would not run it unasked). **Before the migration lands:** `apps/harness/src/harness/eval/judge/selection.py` `_SELECT_SQL` still reads `core."AiTaskDefault"` (the CI eval gate; TASK-862 missed it) — the replacement query is in the lane README and is applied by the orchestrator once lane D (which owns `apps/harness`) merges, together with the `run-gate.sh:69,78` messages and the stale descriptions the lane listed for D. | `432003975` (+ `aa068fac1` builder fix, `eebd0473f` artifact regen) | Intersection guard 17 × 144 = ∅; rebased 13/13 onto `a266df9e1`. The merged tree failed the applications build once — the two policy response builders lost the derived text fields the dropped columns used to supply (`aa068fac1`: null placeholders, the overlay fills them). Then on the primary: `db:generate`; builds; domains 158 / 1907; applications 662 / 11620, lint 0 errors; api 279 / 4199; database + the 8 pre-attributed; `tests/contracts` 17 / 218; `gen:model/entity/factory:check` clean; admin-console build + lint clean, 257 / 2271; five artifacts regenerated (four routes, one tag, one scope, the vox-node `ai-task-default` admin area removed), vox-node typecheck + 25 / 375, `api:openapi:check` / `api:portal:check` / `gen:admin:check` clean; `env:sync:check` clean (149 TS keys — the twelve were not env-tier); `harness:test` 6 pre-existing replay failures / 2099, identical set. A false alarm on the way: the integrity contract and the env generator both walk `git ls-files`, so the not-yet-committed deletion of the vox-node file read as a missing tracked file. | removed |
| F (batch 2) | TASK-887 — diarization as a declared ASR-agent option (owner decision, model item 8; 91 files): the agent's `audioFrontEnd.diarization.{enabled,backend,embeddingModelSlug,maxSpeakers,matchThreshold}` is the ONLY source (default OFF; `matchThreshold` 0.6 replaces `stt.voiceProfile.minSimilarity`; `stt.diarization.hfModelId` and the embedding-service singleton deleted with their `Settings` fields, control-plane entries and boot warm-up); a profile lives in the space of the model that embedded it (`UserVoiceProfile.modelId` REQUIRED and holds the `AiModel` slug, `embedding` an unsized `vector` — brute-force cosine over one user's few profiles, no ANN index by design); enrollment (`POST voice-profiles/enroll`, SDK `enroll({agentSlug})`) resolves the agent and PUSHES its embedding model + threshold to `apps/stt`; `GET voice-profiles/enrollment-target` tells a client which model the assigned agent needs; at session start / batch submit the gateway pushes the end-user's profiles embedded by the agent's model beside `provider_overrides` (the model is a WHERE clause, never a post-filter; `preseed.py`'s direct DB read and `voice_profile_model.py` deleted); labels: the enrolled label only at or above the threshold, else `speaker N`; console agent editor picks from the `SPEAKER_EMBEDDING` catalogue, the voice-profiles playground flags profiles the assigned agent could never match; TASK-880's superseded option-1 pieces removed (`globalOnly` keep, pin test, the 409 refusal — a `ASR_AGENT_DIARIZATION_MODEL_MISSING` 409 remains for an enabled block with no model). Handoffs applied by the orchestrator (`64b73130f`): the SYSTEM ASR template names `wespeaker-voxceleb-resnet34` with diarization still off (flipping it on is no longer a 409); the two wespeaker/ecapa seed comments describe instead of defend a width. Migration (F's part of the wave's single migration): `embedding` → `vector`, backfill `modelId` to the wespeaker slug, `SET NOT NULL`. | `aafdfcf2e` (+ `64b73130f` seed handoffs, artifact regen `chore`) | Intersection guard 169 × 91 = ∅; rebased 9/9 onto `eaca27a17`; gates on the merged primary: `stt:test` 3196 passed + the 1 pre-existing (3189 → 3196 reconciled by the lane), `stt:lint` + `stt:typecheck` clean (139 files); `db:generate`; builds; workflow-contract 36 / 1498; domains 158 / 1907; applications 662 / 11640, lint 0 errors; api 279 / 4199; database + the 8 pre-attributed (same two files after the seed edits); `tests/contracts` 17 / 218; `gen:model/entity/factory:check` clean; `@arcaai/vox` 282 / 4383 + typecheck; admin-console build + lint clean, 257 / 2278; five artifacts regenerated (the new route + `agentSlug` on enroll; admin SDK zero-diff), vox-node typecheck + 25 / 375, `api:openapi:check` / `api:portal:check` / `gen:admin:check` clean; `env:python-surface` 354 names / 307 fields then `env:sync` 149 TS keys, both checks clean, the two env names absent from all five artifacts. | removed |
| D (batch 2) | TASK-882 — pipeline / consultation / harness repoints (191 files, +2264 / −7663): `PipelinePolicy` + `PipelinePolicyChange` retired OUTRIGHT (no live column remained — model, trios, `CoreDatabaseModule`, allow-lists, service, module, `admin/harness/pipeline-policy` controller, scope audit + TASK-773 map, 3 CASL rows, `admin:`/`svc:` scopes; the `PipelinePolicyScope` enum stays for the assignment tables); `pipeline.autoNerEnabled` / `harnessEnabled` / `dnaRedactionEnabled` GONE (dead or shadowed by nodes); `pipeline.autoSummaryEnabled` = the assigned graph's generation node `enabled` (DOCTOR tier dropped, owner #5); `pipeline.dnaStyleEnabled` SPLIT into an `agent.dna_style` node (both runtimes, parity snapshot, placed on the seeded SOAP graph) + a per-user `UserSettings` `dna/styleEnabled` preference written by `PUT dna-writing-styles/settings` (OCC on the row); `consultation.visitTypes` GONE — the `(task, visitType) → prompt` binding retired, seven callers drop `visitTypeKey`, a named seam for TASK-884; `agentic.revisit.carryForwardEnabled` → a `carryForward` binding on `consultation.assemblePrompt` / `core.agent.overrides`; `consultation.endpoint.actions` → the assigned graph's `trigger:'on-end'` chain (`livedoc.stop` + `harness.finalize` node types on both runtimes; membership = presence + `enabled`, order = edge order; a graph declaring none runs the platform default stage — the seeded legacy SOAP graph cannot carry the chain because `consultation.hitlGate` is terminal); `harness.{warmStart,nerPriors,atomicFact}Enabled` → the `HarnessPolicy` column ONLY (TS + Python, `null` → OFF, no env twin); the three `globalOnly` flips were already true on the base; `modelSlug` off `GET internal/harness/policy`; `withLlmBinding()` + `llmBinding` out of the node schemas; `pipeline.templateResync.{enabled,cron}` STAY (they die with the `AsrPipeline` cron in R4). Registry −11. Rebase conflicted in 8 files with lane C — both lanes had removed neighbouring entries (the `models.*` and `pipeline.*` lanes of `EffectiveSettingsService`, four count pins); resolved by the orchestrator as "both deletions", verified by the four affected suites before merging. **Orchestrator sweep after the merge (`5086e3fc6`, `dbcc248d2`):** the CI eval judge's `_SELECT_SQL` reads the `AiRoutingPolicy` default row (pinned by a hermetic test; docstrings, gate messages and eval comments follow); the dead `modelSlug` option left `getEffectivePolicy`; rule 05's exemplar and seven descriptions stop naming `AiTaskDefault` / `PipelinePolicy`; the console e2e spec that drove the retired route deleted (the redirect page stays one release). The SYSTEM workflow seeds' derived blobs were regenerated on the merged tree (`a2ddd0955`) — the lane had regenerated them before lane F's schema change landed. Handoffs left: the `docs/**` and `.claude/rules` stale mentions the lane listed (residue lane), the harness comment-only `AiTaskDefault` mentions (residue lane). | `25f57f2aa` (+ `5086e3fc6`, `6bacf9c74`, `b10ced28e`, `dbcc248d2`, `a2ddd0955`) | Intersection guard 263 × 191 = 35 shared files (all with lane C); rebased 7/7 with the eight resolutions above; gates on the merged primary after the sweep: `db:generate`; builds; workflow-contract 36 / 1531; domains 156 / 1892; applications 657 / 11560, lint 0 errors; api 278 / 4179; database 77 / 1736 + the 8 pre-attributed (after the seed regeneration); `tests/contracts` 17 / 218 and `env:sync:check` clean once the vox-node deletion was committed (the same `git ls-files` false alarm as lane C); `gen:model/entity/factory:check` clean; admin-console build + lint clean, 256 / 2265; `@arcaai/vox` 282 / 4383 + typecheck; five artifacts regenerated (four routes, one scope, the vox-node `pipeline-policy` admin area removed), vox-node typecheck + 25 / 375, `api:openapi:check` / `api:portal:check` / `gen:admin:check` clean; `env:python-surface` 352 names / 305 fields then `env:sync` 146 TS keys, both checks clean, the three harness names absent from the artifacts; `harness:test` 6 pre-existing replay failures / 2101 (+ the new judge-selection pin, green after the docstring sweep), `harness:lint` + `harness:typecheck` clean (148 files). | removed |
| R (residue) | TASK-888 — wave-3a residue (140 files, +1233 / −2783): TEXT joins the ONE shared internal token (the ten `packages/applications` legacy-name call sites, `ai-model-discovery.service.ts`, both guards, the `common.service.module.ts` warm list, the descriptor, both secrets scripts, the `env-sync` legacy list — `apps/text` had already retired the name at base, so every gateway reader was authenticating against a credential the service could not present); `TenantTtsConfig` retired outright (model, trio, `CoreDatabaseModule`, tenant-scope lists, service, routes, scope, both bootstrap audits, CASL, seed, console feature — `/ai-configuration` kept, its Speech tab reads the live `TenantSttConfig`); the Azure ASR identity unified as `azure-speech` end to end (a streaming session on an Azure agent now resolves its credential — contract test reads the real seed); `AiRoutingPolicyService.assertModelServesTask` (409 `ROUTING_MODEL_TASK_MISMATCH`, 404-over-403) with `AI_TASK_MODEL_TASK_TYPES` re-homed as a SET per key — the retired map declared `guardrail.safety` as `TOKEN_CLASSIFICATION` while the seed is `TEXT_CLASSIFICATION`, so re-homing it verbatim would have made the platform's own seed unwritable; the stale-mention sweep (13 harness sites, TASK-882's H-5 list, both conformance docs, 17 docs, one wave-wide deprecation-register section). **Two defects found and fixed:** `ServiceReleaseTokenGuard` had lost the shared token when the TTS name was struck; the task-type map disagreed with the seed. Orchestrator follow-ups applied: the three rule-file mentions of `AiTaskDefault` as live (`0894dc8f6`), the second migration (`TenantTtsConfig` drop, `f6396cf8b`), a prettier fix the sweep left in `harness-internal.controller.ts` (`0457b8e40`), the judge-selection test's message regex (this commit). Handoffs left: the deployment repo's `TEXT_SERVICE_TOKEN` overlay + Vault policy paths (+ `infrastructure/docker/configs/vault/dev-init.sh:143` and the two `.hcl` policies here, left as the TTS retirement left theirs); `apps/{text,guardrail,nlp}` ~60 comment/doc `AiTaskDefault` mentions; `HARNESS_TEXT_SERVICE_TOKEN` (harness's peer copy, still a live Python field) and the remaining per-service tokens (`guardrail.serviceToken`, `harness.serviceToken`, `harness.internalServiceToken`) against the one shared token — the next seam. | `745fa4bd8` (+ `fb4d357e7` regen, `f6396cf8b` migration, `0894dc8f6` rules, `0457b8e40`, this test fix) | Intersection guard 2 × 140 = ∅; rebased 9/9 onto `954a08dd1`; gates on the merged primary: `db:generate`; builds; workflow-contract 36 / 1531; domains 156 / 1892; applications 655 / 11542, lint 0 errors; api 277 / 4172, lint back to the 5 pre-attributed after the prettier fix; database 76 / 1725 + the 8 pre-attributed; scripts + contracts 34 / 464; `gen:model/entity/factory:check` clean; admin-console build + lint clean, 256 / 2265; `@arcaai/vox` 282 / 4383 + typecheck; five artifacts regenerated (the `tenant-tts-config` routes and scope gone, the vox-node admin area removed), vox-node typecheck + 25 / 375, all three drift checks clean; `env:python-surface` 352 names / 305 fields then `env:sync` 145 TS keys, both checks clean. `text:test` 1620 (the coalescing test `test_xadd_count_is_far_below_the_delta_count` failed once under CPU contention with the TS chain and passed twice in isolation; no `apps/text` code changed). | removed |

**Wave 3a batch 1 status: COMPLETE** at `0b1ef2743`. Registry **235** on the merged tree (measured: 277 − 11 [E] − 12 [B] − 18 [A] − 1 [`tts.serviceToken`]). Orchestrator work between the merges, all gated on the primary: lane B's handoffs H-1/H-2/H-5 (`azure-foundry` in the stt BYO vocabulary and the usage-ledger providers, its SYSTEM veto row seeded `enabled:false`, sarvam/openai stt rows carry their base URLs) and H-4 (`toResolvedModel` carries the `_metadata` slice; `endpointing` resolver path); `tts.serviceToken` retired end to end (descriptor, five gateway reads, the two secrets scripts, the env surface); the inert `TTS_KOKORO_ENABLED` generator row; the Parler mirror doc follows the model row; `apps/tts` closes moved env paths with the `__ENV_REMOVED` tombstone shape the surface generator recognises (its own `__MOVED_TO_THE_REGISTRY_ROW` suffix was being advertised as twelve settable names). Two absolute pins were converted to lane-local invariants (A's registry total, the three-row STT catalogue). Carried to batch 2 / the residue lane: `text.serviceToken` (applications fallback names), `TenantTtsConfig` retirement, B's D-1 (cloud ASR rows declare `provider:'azure'`, not `azure-speech`), the single schema-retirement migration (E's three `ALTER TABLE … DROP COLUMN` incl. `TenantEntitlement`, plus A's `DELETE` of five orphaned `GlobalSetting` rows).

**Wave 3a status: COMPLETE on the code side** at `a62a466e0` + the migration commit. Six lanes merged (TASK-879 / 880 / 883 / 881 / 882 / 887), each rebased onto the current `dev-2.2` and gated on the merged primary; worktrees removed. **Registry measured at 210** (target 208: `pipeline.templateResync.{enabled,cron}` stay until the `AsrPipeline` cron's R4 removal; `text.serviceToken` waits on the residue lane; `guardrail.judge.timeoutSeconds` was added by TASK-878). Tenant-scoped keys: the six end-state ones plus three `globalOnly` keys the PLATFORM writes per tenant (`text.guardrailPolicy.{requireMedical,includeReasoning}`, `consultation.realtime.graphExecutor.enabled`).

**The single schema-retirement migration** — `packages/database/src/prisma/db_main/migrations/20260905192057_task_870_wave3a_schema_retirement/` — was authored on a throwaway shadow database per rule 02: ledger replayed (64 migrations), Prisma generated the structural diff (13 column drops on `HarnessPolicy` / `PlanEntitlement` / `TenantEntitlement` / `TenantFrontendConfig`, `UserVoiceProfile.modelId SET NOT NULL`, three `DROP TABLE`s: `AiTaskDefault`, `PipelinePolicy`, `PipelinePolicyChange`); four statements were hand-inserted because Prisma cannot express them (`UserVoiceProfile.embedding` `vector(256)` → unsized `vector`; the `modelId` backfill to the wespeaker slug BEFORE the `NOT NULL`; the `DELETE` of the five orphaned `tts.*.enabled` `GlobalSetting` rows; the owner-gated soft-retire of the five stale `text.*` routing rows recorded as a COMMENT, not run); applied on the shadow, `migrate diff --from-config-datasource --to-schema` printed an empty migration, the column type / nullability / dropped objects were verified by query, the shadow dropped. **The local dev database (`db push`-managed, no ledger) has NOT been synced — `pnpm db:push` drops the same columns and tables there and needs the owner's go-ahead.** The test database (5433) likewise still carries the old columns (harmless for reads; the Playwright global setup resets it when allowed to).

**E2E on the merged tree: green.** The route-authz matrix and the six depth specs TASK-881 repointed (`task-615-{usage-ledger,usage-analytics-cross-tenant,invoice-lifecycle,billing-cross-tenant}`, `task-729`, `task-779`) — **60 passed** — ran against a test-environment API already serving the current HEAD (`0.0.0-dev-2-2.2880f462`, started by the owner's session; this program started and stopped nothing), `RESET_DB=false`. Two launcher facts recorded for the next run: `scripts/start-test-app.sh` refuses to start while 8968 is held regardless of a host `PORT`, because it runs `dotenv -o` (the file overrides the host env); a running test API on the current HEAD is a valid target for the specs without starting a second one.

**Program status: WAVES 1, 2, 3a AND THE RESIDUE LANE COMPLETE on `dev-2.2`** (not pushed). **Registry measured at 209** on the final tree; the only reconciled non-keep decisions left are `pipeline.templateResync.{enabled,cron}` (R4, with the `AsrPipeline` cron); nine tenant-scoped keys (six tenant-writable, three `globalOnly` written per tenant by the platform). Both migrations (`…task_870_wave3a_schema_retirement`, `…task_888_tenant_tts_config_retirement`) authored and proven on a shadow database — empty diff, two ledger rows — and NOT applied to the local dev database. **E2E on the final tree: 66 passed** (route-authz matrix, the six repointed depth specs, the shared-token retention spec) against the owner's test API serving `fb4d357e`. **Python close gate on the final tree:** stt 3196 + the 1 pre-existing; text 1620 (one CPU-contention flake, green twice in isolation); guardrail 458; nlp 586 + the 2 pre-existing; tts 412; harness 2102 + the 6 pre-existing replay failures (after the judge-selection regex update); lint clean except the pre-existing `W291` (text 2, nlp 3); typecheck clean on all six.

**Open, owner:** (1) sync the local dev DB (`pnpm db:push` — drops the same columns/tables locally); (2) soft-retire the five stale `text.*` `AiRoutingPolicy` rows (commented in the wave-3a migration); (3) a per-workflow-node fallback override (assumed NOT wanted). **Next seams (wave 3b, see the section below):** TASK-884 tags + clone + agent import/export, TASK-885 workflow import/export + promotion, TASK-886 guardrail per-tenant availability; the remaining per-service tokens against the one shared token; the deployment-repo handoffs listed per lane.

### Wave 3b (complete — program landed; registry 209)

Base `3227be8d6` (the program's close-of-3a commit). Three capability lanes in parallel, pre-built worktrees, disjoint ownership: F TASK-884 (`agent`, `agent-assignment`, `agentPromotion`, the new shared `portable-bundle.ts`, `features/agents`), G TASK-885 (`workflow-definition`, `workflow-assignment`, `eval`, `features/workflow-studio`, the workflow seeds), H TASK-886 (`apps/guardrail`, a new `guardrail-availability` service + gateway module + `TenantGuardrailPolicy` model, `features/security-policy`). Known reconciliation at merge: G codes against a local alias of the bundle contract F owns. H's new table becomes a third shadow-authored migration. The assumption H builds on — "availability" = policy SELECTION, never gate removal — is stated in its brief and README for the owner to confirm.

| Lane | Ticket | Merge commit | Post-merge gates (primary checkout) | Worktree |
|---|---|---|---|---|
| F | TASK-884 — agent capabilities (47 files, +3346 / −92): `POST :slug/clone` from a SYSTEM template or any visible agent (values copied, model re-resolved by slug else a named 409, provenance columns `sourceAgentId/sourceTenantId/sourceSlug/sourceVersionNumber`, eval gate kept on a same-tenant clone, foreign source 404, cross-tenant clone 403); `key:value` tags with a grammar in the agent schema, validated on write, a tag-qualified `AgentAssignment` (`selectorKey`, matched before an unqualified one at the same scope; the scope+task unique index gains the selector) and `PromptResolutionService.resolve` filled at the TASK-882 seam — no department or visit-type condition added; the shared `portable-bundle.ts` envelope (`kind` agent | workflow, `schemaVersion`, `source` tenant kind, validator + builder) with `GET :slug/export` / `POST import` (values only, credentials never, model slugs re-resolved, unresolvable → named 409); `POST :slug/sync` for a caller holding `manage:Agent` in every target (unmanaged target 404, SYSTEM 403, non-portable bindings 409) — records no `AgentPromotion` row (that table feeds the workflow-promotion view); a tenant-owned prompt template or MCP server never crosses a tenant (409, export/import is the path). Handoffs left to the owner: no console Clone button (hook wired); cloning/exporting a SYSTEM template cannot read its fallback chain (`AgentModelFallback` is not shared-read — pre-existing since TASK-863). | `88a876e49` (+ regen `chore`) | Intersection guard 99 × 48 = ∅; rebased 6/6; gates on the merged primary: `db:generate` + database dist rebuilt (the H lesson); builds; workflow-contract 38 / 1548; domains 156 / 1892; applications 664 / 11681, lint 0 errors (242 only-warn warnings — triaged at the wave close); api 279 / 4186, lint = the 5 pre-attributed; database + the 8 pre-attributed; scripts + contracts 34 / 464; `gen:model/entity/factory:check` clean; admin-console build + lint clean, 259 / 2287; five artifacts regenerated (four routes, `admin-agents` tag reused, no scope change), vox-node typecheck + 25 / 375, all three drift checks clean; `env:sync:check` clean. Migration (provenance columns, `selectorKey` on assignment + change, the unique-index swap; every existing row gets `selectorKey = ''` so no data step) authored on the shadow after the merge. | removed |
| G | TASK-885 — workflow capabilities (31 files, +3487 / −42): `GET :id/export` (portable keys only — no row id, credential, PHI pointer or derived artifact; cross-tenant 404), `POST /import` (resolves against the caller's catalogue, 409 `WORKFLOW_IMPORT_UNRESOLVED_REFERENCES` naming every one, recompiles, DRAFT), `POST /promote-to-system` (the existing promotion service CONSUMED, recompiled and published as the SYSTEM template, prior version demoted not deleted, 403 for non-super-admins), `POST /slug/:slug/sync` (`manage:WorkflowDefinition` in the source — 403 — and every target — 404; re-resolved per target, all-or-nothing); the eval promotion gate at `warn` by default on the Global → SYSTEM path with `block` still available (owner #7); console export/import; route docs + `AUTH-NOTE`s. **Two owner-decision gaps found:** (1) new tenants get NO copy (pinned) but do not refer to SYSTEM either — `WorkflowAssignmentService.resolve` walks department → tenant only and the dispatcher's lookup is tenant-scoped, so an unopinionated tenant dispatches nothing (closing it = a SYSTEM tier + a widened lookup in `consultation/workflow-dispatch`, a runtime change for every unopinionated tenant); (2) a non-super-admin sync is authorised but its data path is blocked by `tenant-scope.ts`'s super-admin-only pass-through. Bundle contract coded against a local alias of lane F's `portable-bundle.ts` (reconciled at F's merge). | `f9be18547` (+ `169e77b93` regen, `c1472f964` lint fix) | Intersection guard 1 × 31 = ∅; rebased 8/8; gates on the merged primary: builds; workflow-contract 36 / 1531; applications 660 / 11586, lint 0 errors; api 278 / 4176, lint = the 5 pre-attributed; database + the 8 pre-attributed; scripts + contracts 34 / 464; admin-console build clean, 257 / 2273, lint green after one unused test import; five artifacts regenerated (four routes, no new tag or scope), vox-node typecheck + 25 / 375, `api:openapi:check` / `api:portal:check` / `gen:admin:check` clean; `env:sync:check` clean (145 TS keys). | pending (removed at the wave close) |
| H | TASK-886 — guardrail per-tenant availability (57 files, +3770 / −197): a `TenantGuardrailPolicy` row per TENANT (one blob resolved as a unit beside `GuardrailPolicy`; the eight screening checks are not task keys — six ride one delegated `classify` call — and the selection plane `guardrail.*` task keys already belong to `AiRoutingPolicy`); the catalogue = exactly the eight check names in `screening.py::_DECLARED_FAIL_MODES` (`medical_validation` / `groundedness` deliberately absent: separately-invoked routes, not the gate); "no off" enforced three times (absent / empty / all-disabled ⇒ SYSTEM set; unseeded SYSTEM or unreachable config DB ⇒ the built-in full set; a de-selected check recorded `skipped/not_selected_for_tenant`, never omitted); tighten-only enforced at the write lane (403 via the registry's `assertTightenOnlyFloor`) AND structurally at runtime (`tighten()` composes strictly); a derived rule flagged for the owner — a non-empty selection must cover BOTH directions (400) since the owner asked for all requests and all responses gated (`assertBothDirectionsCovered`, one call to revert); the runtime read through guardrail's sanctioned SQL path with the `task_key::tenant_id` cache; a super-admin-only admin surface (`GET/PUT /admin/guardrail/availability/:tenantId`, list; OCC; no `svcScopes` — deny-by-default for both machine classes) and a console tab; `injectionScreeningCriteria` removed (no reader). Domain trio hand-authored; `ResourceType` in both enums; count pins moved (`TENANT_SCOPED_MODELS` 87 → 88, `ADMIN_SCOPED_CONTROLLERS` 62 → 63). Handoffs left: owner review of the both-directions rule (the nav label was fixed by the orchestrator, `3b4542cca`). **Boot regression found by the orchestrator's e2e run, not by any suite:** the controller declared nothing about service-account access (deny-by-default by silence), and `service-account-surface-audit.ts` REFUSES TO START on a silent admin route — every unit suite was green, the API would not boot. Fixed with an explicit `@ForbidServiceAccount()` + a metadata pin (`ba025da15`); the manifest now carries `forbidServiceAccount` on the four routes; the route-authz matrix passed 7/7 on that tree. | `625999eb8` (+ regen `chore`) | Intersection guard 39 × 57 = ∅; rebased 6/6; the merged primary's first applications build failed on a STALE `@arcaai/database` dist (H is the first lane to ADD a `ResourceType` member; every earlier lane only narrowed) — rebuilt, then: `db:generate`; builds; domains 156 / 1892; applications 662 / 11625, lint 0 errors (228 only-warn warnings, +13 in the new service); api 279 / 4181, lint = the 5 pre-attributed; database 77 / 1731 + the 8 pre-attributed; `gen:model/entity/factory:check` clean, `resourceType.enum-parity` 10 / 10; scripts + contracts 34 / 464; admin-console build + lint clean, 258 / 2279 (axe pass on the new tab); five artifacts regenerated (four routes; the scope-less admin area yields no vox-node area, the audit schema gains the enum value), vox-node typecheck + 25 / 375, all three drift checks clean; `env:python-surface` + `env:sync` unchanged, both checks clean; `guardrail:test` 483 (458 + 25), `guardrail:lint` + `guardrail:typecheck` clean (45 files); `text:test` 1620 (the caller's contract unchanged). | pending (removed at the wave close) |

**Wave-3b close (2026-09-06).** Registry measured **209** on the final tree (target 208: `pipeline.templateResync.{enabled,cron}` stay, R4-deferred with the template-resync cron; `guardrail.judge.timeoutSeconds` was added by TASK-881 as the judge's one tuning knob). Four migrations proven together on one throwaway shadow with an empty diff and four ledger rows (`task_870_wave3a_schema_retirement`, `task_888_tenant_tts_config_retirement`, `task_886_tenant_guardrail_policy`, `task_884_agent_provenance_and_assignment_selector`); the local dev DB and the test DB were reset and synced by the owner on 2026-09-06 (both diff empty against the schema; the four migrations are the ledger for every other environment). Python close sweep at baseline (stt 3196, text 1620, guardrail 483, nlp 586, tts 412, harness 2102 + replay). Every worktree removed after its merge and gates.

**Open, owner (the complete list as of the close; items 1 and 2 CLOSED 2026-09-06):** ~~(1) sync the local dev DB~~ done; ~~(2) reset the test DB, then un-`skip` the membership-bounded-sync integration proof~~ done — the proof runs and passes (`1c7a5fbe7`), and the whole integration suite is green on the reset DB (8 files, 108 tests); (3) soft-retire the five stale `text.*` `AiRoutingPolicy` rows (commented in the wave-3a migration); (4) `WorkflowAssignmentService.resolve` has no SYSTEM tier and the dispatch lookup is tenant-scoped — an unopinionated tenant dispatches nothing (G's recorded gap); (5) H's both-directions rule (`assertBothDirectionsCovered`) — keep or drop; (6) F's H-6: `AgentModelFallback` is not shared-read for SYSTEM templates; (7) a per-workflow-node fallback override (assumed NOT wanted); (8) `HARNESS_TEXT_SERVICE_TOKEN` and the remaining per-service tokens against the one shared internal token; (9) ~60 comment/doc mentions of `AiTaskDefault` in `apps/{text,guardrail,nlp}`; (10) deployment-repo handoffs: the `TEXT_SERVICE_TOKEN` overlay + Vault policy paths, the retired env names per lane; (11) five pre-existing `apps/api` lint errors in the TASK-869/875 e2e specs (`auth-throttle-per-endpoint`, `harness-gate`, `shared-component-contracts`) — the owner's in-flight work, untouched by this program; ~~(12) the two `TENANT_IDP_*_ENABLED` directory-sync kill-switches~~ — **CLOSED 2026-09-10, implemented; see below.**

### Item 12 — `TENANT_IDP_*_ENABLED`: platform-wide env switches over per-tenant work (filed 2026-09-10, from TASK-940 OD-4)

TASK-940 taught `scripts/env-sync.mts` to see `configService.get()` reads and found 21 undeclared
env names. Eighteen were live-documentation's and that ticket tiered them. **Three were not**, and
two of those land in this program's scope:

| Env var | Reader | Shape |
|---|---|---|
| `TENANT_IDP_GOOGLE_DIRECTORY_ENABLED` | `directory-sync/google-directory.provider.ts:47` | `String(configService.get(…) ?? '').toLowerCase() === 'true'` in the CONSTRUCTOR; `fetchUsers` throws `BadRequestException` naming the env var when off |
| `TENANT_IDP_MS_GRAPH_ENABLED` | `directory-sync/ms-graph-directory.provider.ts:40` | identical |

(The third, `HARNESS_BASE_URL`, is correctly `env`-tier topology and needed only the declaration
TASK-940 gave it. No follow-up.)

**The defect is not the tier label, it is the SCOPE.** Both are platform-wide switches gating work
that is inherently per-tenant: `DirectorySyncService.enqueueSync(tenantId, providerId)` runs against
credentials the TENANT provisions itself (its own Google service account with delegated directory
scopes, or its own Azure AD app registration). So today a tenant that has done all of that still
cannot sync until the platform flips a global env var — and flipping it enables the capability for
**every** tenant at once, with a redeploy. That is the `09-infrastructure-devops.md`
§"Tenant-first resolution" rule (tenant → SYSTEM, widening only on absence), not a cosmetic
retiering; and corollary L1 rules out the constructor freeze independently.

**Recommended shape — they are already-written feature gates.** Move both into
`FEATURE_AVAILABILITY_SETTINGS` (`feature-availability.descriptors.ts`), which is this exact
pattern and supplies every property they need without a new family:

- `tier: 'global-kv'`, `maxScope: feature.maxScope ?? 'tenant'` → the tenant → SYSTEM cascade and
  per-tenant rollout, for free;
- `killSwitch: true` is auto-derived for a `default: false` entry, and both defaults are already
  `false` — so the governance rule "a kill-switch MUST default OFF" is satisfied by construction
  rather than by remembering;
- `failMode: 'open-to-default'` with the safe end as the default, which matches the current
  fail-closed-to-`BadRequestException` behaviour for an unresolvable read;
- declare each env name as `SettingDescriptor.envOverride` (the mechanism TASK-940 added) so it
  keeps working as a pre-resolution seed, stays in `turbo.json#globalEnv`, and appears on the
  deprecation register as a name with a scheduled end rather than one discovered later.

The one real code change beyond the descriptors: resolve per call instead of in the constructor, so
`fetchUsers` consults the gate for the tenant it is syncing. The error message should then name the
setting key, not the env var.

**Two notes for whoever picks this up.** The family already has history — `TENANT_IDP_ENABLED` sits
in `env-sync.test.ts`'s dead-keys list ("no reader at all"), retired for exactly the ungoverned-knob
reason, so these two are the survivors of that sweep rather than new ground. And this is a `redis-flag`
candidate only if it must flip mid-incident; it is a per-tenant entitlement-shaped capability, so
`global-kv` at `maxScope: 'tenant'` is the better read.

#### OWNER DECISION (2026-09-10): only a platform admin manages which features are enabled per tenant

This closes the one question item 12 left open, and it confirms the recommended home rather than
changing it — `FEATURE_AVAILABILITY_SETTINGS` already encodes exactly this rule, in the two fields
its own header says answer different questions:

- **`globalOnly: true`** — *who may write*: a platform admin only. It is a LITERAL in the mapper,
  not a `FeatureSpec` field, so no entry can opt out of it by omission or by a typo.
- **`maxScope: 'tenant'`** — *where the row lives*: one row per tenant, so availability is still
  decided per tenant. A tenant admin simply never authors it.

Enforced in three independent places, verified 2026-09-10:

| Where | Mechanism |
|---|---|
| `settings-registry-write.service.ts:235` and `:417` | `descriptor.globalOnly && !isSuperAdmin(requestUser)` → **403** on the write and on the reset/delete path |
| `feature-availability.service.ts:154`, `:194` | `assertPlatformMatrixAccess()` on BOTH the cross-tenant matrix read and its `PUT` — the per-tenant management surface itself (TASK-932 R-8) |
| the descriptor mapper | `globalOnly: true` unconditional, so the gate cannot be skipped by a new entry |

Audited against the live family the same day — **all 9 entries are `globalOnly: true`, zero
exceptions**; 7 carry `maxScope: 'tenant'` (per-tenant rows, platform-written) and 2 are `'system'`
(`registration.selfSignupEnabled`, `enable-local-raw-capture` — platform-wide by nature, where a
per-tenant row could never be enforced). So the rule already holds across the whole family and this
decision adds no new mechanism.

**Consequence for item 12's implementation:** take `maxScope: 'tenant'` with the mapper's default
`globalOnly: true` and write no bespoke guard. A tenant that has provisioned its own Google service
account or Azure AD app registration gets the capability when a platform admin enables it *for that
tenant* — which is the per-tenant rollout the current global env var cannot express, without handing
the tenant the switch. The error raised when the gate is off should name the setting key, and should
read as "not enabled for this tenant" rather than implying the caller can change it.

#### IMPLEMENTED 2026-09-10

| File | Change |
|---|---|
| `settings-registry/descriptors/feature-availability.descriptors.ts` | two keys — `tenantIdp.googleDirectory.enabled`, `tenantIdp.msGraph.enabled` — with `default: false` and each legacy env name as `envOverride`. No bespoke properties: the mapper's `globalOnly: true` × `maxScope: 'tenant'` IS the owner rule, and `killSwitch: true` is auto-derived from the `false` default |
| `directory-sync/directory-availability.ts` | **new** — `isDirectorySyncEnabled()` + `directoryAvailabilityKey()` + `directorySyncDisabledError()`. One file because two callers need the same answer and the `config.directoryProvider` → settings-key mapping must exist exactly once |
| `directory-sync/directory-sync.service.ts` | `@Optional() EffectiveSettingsService`; the gate is the LAST link of `enqueueSync`'s validation chain, so a misconfigured row is reported before a gate that can change without any edit to that row |
| `directory-sync/directory-sync.processor.ts` | the same gate, before the paging loop |
| `directory-sync/{google,ms-graph}-directory.provider.ts` | the constructor freeze, the `enabled` field, the `fetchUsers` throw and the orphaned `ConfigService` / `BadRequestException` imports all deleted |
| `directory-sync.service.module.ts` | imports `EffectiveSettingsModule`, without which the `@Optional` injection is undefined and every sync denies — fail-closed, but silently, so the import is load-bearing rather than decorative |
| tests | new `directory-sync.feature-gate.task870.test.ts` (9 cases); the two provider tests drop the env-gate case (the behaviour moved to the callers) and their `configService` mock; the service/processor harnesses wire an enabled facade; the explicit feature-key inventory goes 10 → 12, deliberately |

**Gated in BOTH places that hold a `tenantId`**, for the reason `assertEqualTenants` is also in both:
`enqueueSync` is the front door and owes an HTTP caller a 400 rather than a job that fails minutes
later; the processor is the work boundary, so a capability a platform admin disables stops syncing
even for a job already queued — BullMQ retries and a drained worker both widen that window well past
"seconds".

**FAIL CLOSED, and the two rules agree rather than conflict here.** `failMode: 'open-to-default'`
degrades a TUNING value to its default, and a capability must never grant itself — both give the same
answer, because the declared default IS `false`. An absent facade, an absent row and a resolution
failure all deny, and none needs a special case.

**Two things deliberately NOT done.** The keys are not added to the console's `FeatureGateKey` union:
that union gates nav entries and routes, and its own header calls itself "a console VISIBILITY +
route decision only, not an authorisation boundary" — these are backend capability gates. And no
screen was built: `/features` derives its matrix rows from the descriptor catalogue, so both keys
appear there automatically, which is exactly the platform-admin surface the owner decision names.

**`globalEnv` unchanged at 503.** Both names were already in the cache key (TASK-940's scanner found
them); they now arrive by `envOverride` declaration instead of by scan. `env-sync.test.ts` pins that
transition explicitly, because it is the clearest evidence the two TASK-940 mechanisms are
complementary rather than redundant: a name can leave the SCAN, stay DECLARED, and `globalEnv` must
not notice the difference.

**Verification**

```
pnpm env:sync:check                OK — 503 globalEnv entries, 12 artifacts
directory-sync suite               30 passed (5 files)
+ settings-registry + env-sync     460 passed (44 files)
@arcaai/applications               build clean · 12680 passed / 6 skipped (753 files)
pnpm typecheck:all                 44/44 successful
lint                               182 warnings / 0 errors — exactly the pre-change baseline
```

The one failing file is the same out-of-scope one TASK-940 recorded:
`membership-bounded-sync.integration.test.ts` dies in its own `beforeAll` against a test database
that is not running, and reports its two actual tests as skipped.

## Close-out (2026-09-10)

**Status → Completed.** All four waves landed on `dev-2.2`; every lane merged, gated and its
worktree removed. The registry measures **232** descriptors today against the program's own
reconciled target of 209 — the difference is later tickets registering new governed keys
(TASK-890 L12 +5, then TASK-930/931/932/933/939 and TASK-940, plus item 12's +2), not program
scope that went unexecuted.

### Every post-close owner item, dispositioned against the current tree

Audited by inspection on 2026-09-10 rather than by recollection. **Eight of the twelve are
closed**, four of them silently — by later tickets, or by an assumption that simply held.

| # | Item | Disposition |
|---|---|---|
| 1 | sync the local dev DB | **closed** 2026-09-06 (owner) |
| 2 | reset the test DB, un-`skip` the membership-bounded-sync proof | **closed** 2026-09-06 — `1c7a5fbe7` |
| 3 | soft-retire the five stale `text.*` `AiRoutingPolicy` rows | **OPEN** — carried forward |
| 4 | `WorkflowAssignmentService.resolve` has no SYSTEM tier, so an unopinionated tenant dispatches nothing | **CLOSED since the item was filed.** `resolve()` now walks `department → tenant → platform default` (`workflow-assignment.service.ts:49`, `:75-115`), with the platform default as "the declared last" step. G's recorded gap is gone |
| 5 | H's both-directions rule (`assertBothDirectionsCovered`) — keep or drop | **OPEN** (a decision, not work) — still present in `guardrail-availability/{policy-catalogue,guardrail-availability.service}.ts` |
| 6 | `AgentModelFallback` is not shared-read for SYSTEM templates (F's H-6) | **CLOSED since the item was filed** — `AgentModelFallback` is now in `SYSTEM_SHARED_READ_MODELS` (`tenant-scope.ts:357`), so cloning or exporting a SYSTEM template can read its fallback chain |
| 7 | a per-workflow-node fallback override (assumed NOT wanted) | **CLOSED — the assumption held.** No `nodeFallback` / `fallbackOverride` field exists anywhere in `packages/`; nothing was built, and nothing since has needed it |
| 8 | `HARNESS_TEXT_SERVICE_TOKEN` + the remaining per-service tokens against the one shared internal token | **OPEN** — carried forward |
| 9 | ~60 comment/doc mentions of `AiTaskDefault` in `apps/{text,guardrail,nlp}` | **OPEN** — carried forward. Measured today: **76** (text 19, guardrail 38, nlp 19) |
| 10 | deployment-repo handoffs: the `TEXT_SERVICE_TOKEN` overlay + Vault policy paths, the retired env names per lane | **CLOSED for the env-name half, and the token half is item 8.** Checked `hope-v2-deployment/deployment/k8s/**`: every name the lanes retired is ABSENT (`TTS_SERVICE_TOKEN`, and TASK-940's `LIVE_DOC_TEXT_PROVIDER` / `LIVE_DOC_TEXT_MODEL` / `LIVE_DOC_HEARTBEAT_MS` / `LIVE_DOC_STATS_TTL_SEC`, plus item 12's two `TENANT_IDP_*_ENABLED`). `TEXT_SERVICE_TOKEN` is not set there at all; what remains is `GUARDRAIL_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`, `HARNESS_INTERNAL_SERVICE_TOKEN` — which is exactly item 8's scope, so this is not a separate handoff |
| 11 | five pre-existing `apps/api` lint errors in the TASK-869/875 e2e specs | **CLOSED** — `pnpm --filter @arcaai/api lint` now reports **0 errors** (65 warnings). The owner's in-flight work landed |
| 12 | the two `TENANT_IDP_*_ENABLED` directory-sync kill-switches | **closed** 2026-09-10 — implemented, §Item 12 above |

### Residual items carried PAST this close — four, and none is program work

Recorded here deliberately rather than absorbed into "Completed", because a closed ticket is
eventually archived and these must not go with it. **Two are owner decisions the program cannot
make for itself, one is coordinated with another repository, and one is a documentation sweep.**

| # | What remains | Why it is not program work | Shape of the fix |
|---|---|---|---|
| **3** | Five `AiRoutingPolicy` rows for `text.live`, `text.finalize`, `text.test`, `text.live.fallback`, `text.finalize.fallback` are inert but present in any already-deployed database. The seed no longer writes them and nothing resolves them | The SQL is WRITTEN and deliberately COMMENTED at `migrations/20260905192057_task_870_wave3a_schema_retirement/migration.sql:78-82` — its own comment says "Soft-retire is an OWNER decision". Deleting data is never the program's call | uncomment the `UPDATE`, or leave the rows inert forever and delete the comment so it stops reading as a pending action |
| **5** | `assertBothDirectionsCovered` — lane H DERIVED the rule that a non-empty guardrail selection must cover both request and response directions (400), from the owner's "all requests and all responses gated". It was flagged at the wave close for confirmation and never answered | A derived rule is a guess until the owner confirms it. One call to revert | confirm → delete the flag; reject → remove the assertion and its test |
| **8** | The legacy per-service tokens are still a live fallback. `peer_service_token(legacy)` (`harness/core/config.py:432-437`) returns `first_real_secret(internal_access_token, legacy)`, so the legacy field is genuinely consulted — and the deployment repo still SETS `GUARDRAIL_SERVICE_TOKEN`, `HARNESS_SERVICE_TOKEN`, `HARNESS_INTERNAL_SERVICE_TOKEN` | Owner decision D-D already says these "remain only as the fallback for an environment that has not been migrated yet". Retiring them means proving every environment presents `INTERNAL_ACCESS_TOKEN` FIRST, which is a deployment-repo change coordinated with a code change — two repos, not one lane | confirm every overlay sets `INTERNAL_ACCESS_TOKEN`, then drop the legacy fields, the `legacy` parameter and the Vault paths in one pass |
| **9** | 76 stale `AiTaskDefault` mentions in comments and docs across `apps/text` (19), `apps/guardrail` (38), `apps/nlp` (19). The table, service, routes and descriptors were all removed by TASK-881 | Pure prose. No reader, no behaviour, no gate — which is also why no gate catches it | a mechanical sweep repointing each to `AiRoutingPolicy.resolveDefault` / `Agent.modelId` |

None blocks anything and none is load-bearing. **They are now tracked as
[TASK-941 — TASK-870 Residue](../TASK-941-Task-870-Residue/README.md)** (filed 2026-09-10 at the
owner's request), which carries each one's verified current state, its fix shape with verification,
and the two owner decisions R1/R2 depend on. This table stays as the program's own record; TASK-941
is where the work is tracked.

### What this program actually delivered

Four waves, nineteen lanes (TASK-871..889), every one merged with its gates pasted. The registry
went **341 → 209** on the program's own reconciled set, the configuration tiers became declarable
facts (`tier`, `targetTier`, `failMode`, `consumedBy`, `floorDirection`, `globalOnly`) rather than
prose, and the two rules that outrank convenience — *never hardcode configuration* and
*resolution is tenant → platform default* — acquired enforcement instead of restatement. The
durable artifacts are the descriptor families under
`packages/applications/src/services/settings-registry/descriptors/`, the write-lane gates in
`settings-registry-write.service.ts`, and the generated env surface
(`env-surface.generated.md`, `turbo.json#globalEnv`) that TASK-940 later taught to see reads it
had been blind to.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Program opened; wave 1 partitioned into TASK-871..874 off `c364bb8ec`. |
| 2026-09-05 | Lane A (TASK-871) merged at `9a8e2af0b`; lane C (TASK-873) merged at `76686c60d`; both post-merge gates green; worktrees removed. E2E authz matrix deferred to close-out. |
| 2026-09-05 | Lane D (TASK-874) merged at `f8f7835a1`; STT billing defect direction corrected (last-loaded engine, both directions wrong). Lane B (TASK-872) merged at `94a311e4d` after a watchdog stall and continuation; registry 341 → 286; two service tokens kept (gateway still reads them). |
| 2026-09-05 | Owner merged TASK-869 (`6123ffbb1`) on top; verified non-reverting. E2E route-authz matrix green (7 passed) on the merged tree. **Wave 1 complete.** |
| 2026-09-05 | Setup-script pass on the wave-1 close, outside the wave-2 partition (`scripts/**` plus the generated env artifacts; verified untouched by TASK-876..878). `3f0adf98a`: `generate-env-file.sh` was ROTATING `INTERNAL_ACCESS_TOKEN` and `WEBHOOK_SECRET_PEPPER` and BLANKING `VAULT_ROLE_ID` on every `pnpm setup:dev` — `_CARRY_FORWARD_KEYS` was hand-maintained alongside the generated-secret list and had drifted; the two now share one `_GENERATED_SECRET_KEYS` array. `VAULT_WRAPPED_SECRET_ID` is blanked instead of left as `CHANGE_ME`: the provider branches on truthiness, so the placeholder selected the production wrapped path and failed Vault auth at boot. Two reporting defects behind the symptom — an unanchored `=CHANGE_ME` grep matched the sample's commented duplicate lines and word-split comment prose into a list of "unclassified secrets", and `_ENV_REMOVED_TOMBSTONE` matched `__ENV_REMOVED_TASK_<n>` but not the bare `__ENV_REMOVED` used by harness and stt, leaking 7 closed env paths into the manifest and 6 into `.env.sample` as live paste-a-value prompts. Regenerating also cleared drift TASK-869 left: `E2E_ISOLATED_API_URL` added to `turbo.json#globalEnv`, two `SEED_*` keys no tracked source reads dropped from `.env.sample`. Gates: env-sync suite 39/39, `env:sync --check` and `env:python-surface:check` green, shellcheck clean, `.env.dev` regenerates with zero value changes (17 generated secrets hash-identical to a pre-run backup). |
| 2026-09-05 | `5c6c17dfc`: closed the `apps/tts` dead-field HANDOFF. Lane B (TASK-872, `94a311e4d`) dropped `AzureSpeechConfig.max_concurrent`, `SarvamConfig.max_concurrent` and `SarvamConfig.use_streaming` with their descriptors and overlay entries, but left their three `INTENTIONALLY_UNREAD` rows in `scripts/python-env-surface.py` — so the self-cleaning rule failed `pnpm env:python-dead` from that merge onward, which is the last step the handoff's own rationale string had scripted. Rows and the now-orphaned `_TTS_CONTROL_PLANE_HANDOFF` constant deleted; the scanner-limitation comment citing those fields corrected to past tense. `env:python-dead` OK — 394 fields across 6 services, every one read, 4 allow-listed. |
| 2026-09-05 | Lane C (TASK-878) merged at `dfd4102a6`; post-merge gates green; the two reds on `dev-2.2` attributed to TASK-869 (36th catalogue row → 8 database seed tests) and TASK-869/875 e2e-spec lint — none in a wave-2 file; worktree removed. Lanes A (TASK-876) and B (TASK-877) in flight. |
| 2026-09-05 | Owner asked for every lane to be rebased onto the current `dev-2.2` and re-checked. Lane B (TASK-877) rebased (5/5 clean), re-gated on the rebased tree, merged at `113d36978`; env-surface artifacts regenerated at `012e66666`; worktree removed. Lane A (TASK-876) rebased twice (7/7, then 8/8 onto `012e66666`), gated on the rebased tree (workflow-contract 35/1491, applications 661/11527, api 280/4213, harness 6 pre-existing replay failures / 2084 with the −7 reconciled to the deleted `test_llm_binding_task816.py`), then held at the review gate: an `opus` read-only review returned 2 BLOCKERs verified by the orchestrator (the durable documentation workflow still selects from `HarnessPolicy.textProvider/textModel` because the policy activity passes no task key; `autoSwitch:false` is honoured with no funding gate) plus a dropped primary funding tier on the internal route — a fix lane is closing them in the worktree before the merge. |
| 2026-09-05 | Lane A (TASK-876) held at the review gate, fixed in place (13 findings, 15 commits), rebased a third time and merged at `9bbdc51b7`; combined gates re-run on the merged primary, all at baseline; e2e matrix 7 passed; worktree removed. **Wave 2 complete — registry 277.** Wave 3 partitioned from the executed registry × the reconciled decisions: 3a = five move/removal lanes (TASK-879..883) with one orchestrator-authored schema-retirement migration; 3b = three capability lanes (TASK-884..886). |
| 2026-09-05 | Owner decision on diarization (model item 8): an ASR-agent option, OFF by default, embedding model declared on the agent, generic or profile-based labels; `stt.diarization.hfModelId` is NOT kept as the platform embedding space. Lane B (TASK-880) was already running with the superseded option-1 brief; its option-1 pieces are removed by the new lane F (TASK-887) in 3a's second batch, which owns the redesign. |
| 2026-09-05 | Wave 3a batch 1 opened (TASK-879 / 880 / 883 in pre-built worktrees). Lane E (TASK-883) merged at `a04954c55`, artifacts regenerated, gates at baseline, worktree removed; `text.serviceToken` found NOT yet retirable (applications fallback readers) — batch-2 item; migration covers `TenantEntitlement` too. |
| 2026-09-05 | Lane B (TASK-880) merged at `c61719fda` after rebase; H-4 applied on the primary (`8bdd3b314`); env surface regenerated; gates at baseline; worktree removed. Registry 254 on the merged tree. D-1 (Azure ASR provider identity) recorded as a cross-lane defect for batch 2. |
| 2026-09-06 | Lane A (TASK-879) merged at `e407f5d6a` after a clean 20/20 rebase; B's handoffs H-1/H-2/H-4/H-5 applied; `tts.serviceToken` retired end to end after `vault-kv-coverage.test.ts` exposed five surviving reads the lane had reported retired; tts tombstone suffix aligned; fix set `0b1ef2743` gated green on the primary. **Batch 1 complete — registry 235.** Batch 2 (TASK-881 / 882 / 887) running in pre-built worktrees off `1e81c4966`. |
| 2026-09-06 | Lane C (TASK-881) merged at `432003975` after a clean 13/13 rebase; builder fix `aa068fac1`; artifacts regenerated `eebd0473f`; gates at baseline; worktree removed. Registry 223 (computed; measured at batch close). Pending D: the eval-judge SQL replacement before the migration. |
| 2026-09-06 | Lane F (TASK-887) merged at `aafdfcf2e` after a clean 9/9 rebase; seed handoffs `64b73130f`; artifacts regenerated; gates at baseline; worktree removed. Registry 221 (computed). Lane D (TASK-882) still running — the last of batch 2. |
| 2026-09-06 | Lane D (TASK-882) merged at `25f57f2aa` after an eight-file conflict resolution against lane C; post-batch sweep, artifact and env regeneration, workflow-seed regeneration; gates at baseline; worktree removed. **Registry measured at 210 on the merged tree** (target 208: the two `pipeline.templateResync.*` keys stay until R4, `text.serviceToken` waits on the residue lane, `guardrail.judge.timeoutSeconds` was added). |
| 2026-09-06 | Wave 3a code complete. The single schema-retirement migration authored and proven on a shadow database (hand-inserted: vector retype, modelId backfill, GlobalSetting purge; soft-retire commented); dev DB sync and the e2e run pending the owner (port 8968 held by a foreign debugger-attached API). Residue lane TASK-888 opened. |
| 2026-09-06 | Wave 3a e2e green on the merged tree: route-authz matrix + the six repointed depth specs, 60 passed, against the test API serving `2880f462`. Residue lane TASK-888 running in `../hope-v2-task-888`. |
| 2026-09-06 | Residue lane (TASK-888) merged at `745fa4bd8` and gated; rules updated; second migration proven; e2e 66 passed on the final tree; Python close gate at baseline. **Program complete through wave 3a — registry 209.** Status → Review (owner: dev-DB sync, stale routing rows, wave 3b go/no-go). |
| 2026-09-06 | Wave 3b opened: TASK-884 / 885 / 886 running in pre-built worktrees off `3227be8d6` (all three `opus`). |
| 2026-09-06 | Wave 3b: lane G (TASK-885) merged at `f9be18547`, lane H (TASK-886) merged at `625999eb8`, both gated on the primary; a stale `@arcaai/database` dist bit the first lane to ADD an enum member. Lane F (TASK-884) done in its worktree, merging after H's migration is authored. |
| 2026-09-06 | Lane F (TASK-884) merged at `88a876e49` and gated; artifacts regenerated. All three 3b lanes on `dev-2.2`; residue lane TASK-889 (bundle reconciliation, the sync data path) running. |
| 2026-09-06 | Lane H's controller failed the service-account surface audit at BOOT (silent on the machine class) although every suite was green — fixed (`ba025da15`), manifest regenerated; e2e route-authz matrix 7 passed on the wave-3b tree with the twelve new routes. A boot-smoke gate joins the lane rules. All four program migrations proven together on one shadow. TASK-889 running. |
| 2026-09-06 | Lane I (TASK-889) merged at `58afbbcda`; five artifacts regenerated + prettier on the wave-3b agent-side files (`e6b01de55`); every suite and check green on the primary; the owner's test API served the final tree healthy and the route-authz matrix passed 7/7 against it; worktree removed. |
| 2026-09-06 | **Program complete — waves 1, 2, 3a, 3b landed on `dev-2.2`; registry 209; four migrations proven, dev DB not synced.** Status → Review with the eleven owner items listed at the wave-3b close. |
| 2026-09-06 | Owner reset and synced the dev and test databases. Both diff empty against the schema. The membership-bounded sync proof un-skipped and passing after two fixture corrections (the tenant's required `key`, a `code` field the model lacks) plus a cleanup of its fixture tenants (`1c7a5fbe7`); `pnpm test:integration` 8 files / 108 tests green on the reset DB. Owner items 1 and 2 closed. |
| 2026-09-06 | Noted, not touched: an uncommitted prettier pass over 24 files appeared in the primary checkout (the owner's; it includes the two TASK-869 specs carrying the five lint errors). |
| 2026-09-06 | **Registry 209 → 214** — TASK-890 lane L12 (inference readiness, wave 1) registered five `global-kv` keys in a new `ai-readiness.descriptors.ts`: the sweep's `inference.readiness.{enabled,intervalSeconds,cloudProbeIntervalSeconds}`, plus two previously ungoverned model-inventory keys it retro-registered. All five are `globalOnly`, `failMode: 'open-to-default'` (measurement cadence and a switch — no selection). Measured on the TASK-890 wave-1 close tree: `HOPE_SETTINGS_REGISTRY.byKey.size === 214`. No TASK-870 decision is reopened; the program's own reconciled set is unchanged. |
| 2026-09-06 | **Registry 209 → 214** — TASK-890 lane L12 (inference readiness, wave 1) registered five `global-kv` keys in a new `ai-readiness.descriptors.ts`: the sweep's `inference.readiness.{enabled,intervalSeconds,cloudProbeIntervalSeconds}`, plus two previously ungoverned model-inventory keys it retro-registered. All five are `globalOnly`, `failMode: 'open-to-default'` (measurement cadence and a switch — no selection). Measured on the wave-1 close tree: `HOPE_SETTINGS_REGISTRY.byKey.size === 214`. No TASK-870 decision is reopened; the program's own reconciled set is unchanged. |
| 2026-09-10 | **Owner item 12 filed** from TASK-940 OD-4: the two `TENANT_IDP_*_ENABLED` directory-sync kill-switches. TASK-940's new `configService.get()` scanner found 21 undeclared env reads; it declared all of them and tiered the 18 in live-documentation, leaving these two (and `HARNESS_BASE_URL`, which needed only the declaration). They are platform-wide constructor-frozen switches over per-tenant work — a tenant with its own provisioned service account cannot sync until a global env var is flipped for everyone, which is the §"Tenant-first resolution" rule rather than a tier label. Recommended home is `FEATURE_AVAILABILITY_SETTINGS` at `maxScope: 'tenant'`, with the env names kept as `envOverride`. No registry count change yet — nothing implemented. |
| 2026-09-10 | **Owner decision on item 12: only a platform admin manages per-tenant feature availability.** Confirms the recommended home unchanged — `FEATURE_AVAILABILITY_SETTINGS` already encodes it as `globalOnly: true` (who writes) × `maxScope: 'tenant'` (where the row lives), enforced at `settings-registry-write.service.ts:235`/`:417` (403) and by `assertPlatformMatrixAccess()` on both halves of the feature matrix. Audited: all 9 live entries are `globalOnly`, zero exceptions. Item 12's open question is closed; the implementation needs no bespoke guard. |
| 2026-09-10 | **Item 12 IMPLEMENTED and closed.** Two `FEATURE_AVAILABILITY_SETTINGS` keys (`tenantIdp.googleDirectory.enabled`, `tenantIdp.msGraph.enabled`), resolved per tenant at BOTH `enqueueSync` (400) and the worker (so a queued job cannot outlive the gate being turned off), with the legacy env names kept as `envOverride` pre-resolution seeds; both provider constructor freezes deleted along with their now-orphaned imports. Fail-closed throughout — absent facade, absent row and resolution failure all deny, because the declared default is `false`. `globalEnv` unchanged at 503 (the names moved from scanner-detected to declared). Gates: 30 directory-sync, 460 with settings-registry + env-sync, applications 12680 passed, typecheck 44/44, lint at the 182/0 baseline. |
| 2026-09-10 | **Program CLOSED — status Review → Completed.** All twelve post-close owner items dispositioned against the current tree by inspection (§Close-out): eight closed, four of them silently since filing — item 4 by `WorkflowAssignmentService.resolve` gaining its `department → tenant → platform default` walk, item 6 by `AgentModelFallback` entering `SYSTEM_SHARED_READ_MODELS`, item 7 by its "not wanted" assumption holding (no node-level fallback field exists), item 10 by every lane-retired env name being absent from `hope-v2-deployment` (its token half is item 8), and item 11 by `apps/api` lint reaching 0 errors. Four residual items carried PAST the close and recorded in their own section so archiving cannot lose them: 3 and 5 are owner decisions, 8 is a two-repo coordination, 9 is a 76-mention doc sweep. Registry measures 232 (program target 209; the rest are later tickets' keys). |
| 2026-09-10 | The four residual items filed as **TASK-941 — TASK-870 Residue** at the owner's request, so a Completed program cannot archive them. Every claim re-verified on `0d7ed352f` while filing; two refinements on the close-out's own wording: R3 is 3 legacy fields + 8 call sites (not one reader), and R4's 76 mentions include no compared value at all, so the sweep's real risk is stale GUIDANCE in assertion failure messages rather than a rewritten assertion. |
