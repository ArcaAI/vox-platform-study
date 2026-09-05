# TASK-870 — Configuration Governance Program

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature (program) |
| **Branch** | `dev-2.2` (all lanes merge here) |
| **Base** | `c364bb8ec` |
| **Owner decisions** | 10 answers + 4 follow-up directions, recorded in the review artifact and restated below |
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

Owner decisions still open for wave 3 (each lane carries the default assumption above until told
otherwise): (1) diarization — DECIDED 2026-09-05 (target model item 8, lane F/TASK-887); (2) per-node fallback override — assumed NOT
wanted (the agent-level toggle covers both lanes); (3) the exact semantics of "per-tenant guardrail
availability" — assumed policy SELECTION, never gate removal.

### Rules every lane follows

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
| B | TASK-880 — ASR remainder: 12 `stt.*` keys moved and deleted — the whisper.cpp prompt flag → `Agent.instruction.initialPrompt` (batch decoded with NO prior context before: defect closed in passing), VAD weights → the model row's `localPath`, `vad.speechPadMs` → the agent, chunking → the agent's `decoding.*` as the ONLY source (the ONNX batch path never consulted the spec: closed in passing), `whisperCpp.maxAudioSeconds` / `streaming.partialWindowS` → `AiModel._metadata.asr.{maxDecodeWindowSec,partialWindowSec}` surfaced on the spec, the five provider keys → `AiProviderConnection` rows (Foundry gets its own `azure-foundry` identity; the row's three states replace the kill-switch); `decoding.strideLengthSec` schema type corrected to the `[left,right]` pair the runtime consumes; `'endpointing'` added to `ResolvedAgentModelRole`. Diarization: briefed with the SUPERSEDED option 1 — slug refs now resolve off the spec bundle (stands), `stt.diarization.hfModelId` kept with a pin test and a 409 `ASR_AGENT_EMBEDDING_SPACE_MISMATCH` refusal (both REMOVED by TASK-887). **Handoffs applied by the orchestrator:** H-4 (`toResolvedModel` carries the `_metadata` slice + the `endpointing` resolver path, `8bdd3b314`, with tests); H-6 env regeneration. **Pending A's merge (its files):** H-1 `CLOUD_BYO_PROVIDERS.stt += 'azure-foundry'`, H-2 three `17-ai-provider-connection.ts` seed edits, H-5 `KNOWN_PROVIDERS += 'azure-foundry'`; H-3 not needed (the prompt line already exists). **Deferred with seams:** D-1 the cloud ASR rows declare `provider:'azure'` not `azure-speech`, so a streaming SESSION on an Azure agent resolves no credential (pre-existing, spans two lanes: `AI_MODEL_PROVIDERS` + two rows + the vocabulary); D-2 the override fold replaces per provider, not per field (loaders fail closed naming the row). Registry 266 → 254 on the merged tree. | `c61719fda` (+ H-4 `8bdd3b314`, regen `chore`) | Intersection guard 72 × 49 = ∅; rebased 10/10 onto `3270b3fc2`; gates on the merged primary: `stt:test` 3189 passed + the 1 pre-existing, lint + typecheck clean (140 files); builds types/domains/workflow-contract/applications/api; workflow-contract 35 / 1493; applications 664 / 11596, lint 0 errors; api 280 / 4219; database + the 8 pre-attributed; `tests/contracts` 16 / 210; five artifacts regenerated with no API diff, vox-node typecheck + 25 / 375; `env:python-surface` 374 names / 327 fields then `env:sync` 150 TS keys, both checks + `env-sync.test.ts` 39/39 clean; the twelve env names absent from all five artifacts. Counts reconciled by id-diff (Python 3408 → 3409: +55/−54; applications +22). | removed |

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
