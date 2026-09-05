# TASK-882 — Pipeline, consultation and harness keys move to the workflow, the harness policy row, or go

| Field | Value |
|---|---|
| Status | Review |
| Program | TASK-870 (configuration governance), wave 3a, lane D (second batch) |
| Branch | `task-882-pipeline-workflow-harness-repoints` off `1e81c4966` (`dev-2.2` after wave-3a batch 1) |
| Classification | refactor (removal + repoint) |

## Requirement Analysis

Owner model (TASK-870 §Requirement Analysis, items 6–7): settings exist for platform admins to
control platform behaviour; there are NO tenant-managed conditions (department, visit type) —
developers branch in workflows, tenant admins align agents by key:value tags (TASK-884); redundant
old-architecture settings are removed completely, never dual-homed; the per-doctor auto-summary
opt-out is dropped (owner #5).

Keys this lane removes from the registry (11): `pipeline.{autoNerEnabled,harnessEnabled,
dnaRedactionEnabled,autoSummaryEnabled,dnaStyleEnabled}`, `consultation.visitTypes`,
`agentic.revisit.carryForwardEnabled`, `consultation.endpoint.actions`,
`harness.{warmStartEnabled,nerPriorsEnabled,atomicFactEnabled}`. Kept: `pipeline.templateResync.
{enabled,cron}` (they die with `pipeline-template-resync.cron.service.ts` at R4).

## Current State Evaluation (verified on `1e81c4966`)

- `PipelinePolicy` has exactly the five toggle columns; `templateResync.*` are `GlobalSetting`
  keys (`platform-ops.descriptors.ts:154,170`, seeded in `11-global-setting.ts`). So once the
  five columns go the model has NO live column → the model, `PipelinePolicyChange`, both domain
  trios, `admin/harness/pipeline-policy`, the CASL rows (`01-policy.ts:213,621,648`) and the API-key
  scope `admin:pipeline-policy:manage` retire. `PipelinePolicyScope` STAYS (agent/workflow
  assignment tables reuse it).
- `autoNerEnabled` reader: `consultation-event.handler.ts:291` — both branches emit
  `PipelineCompleted`; the read decides nothing. `harnessEnabled` reader: `note-generation.
  service.ts:69` → `generator:'legacy'`, which the handler (`:192-218`) reports as "no longer
  exists". `dnaRedactionEnabled`: `config-resolver.service.ts:296-312` answers only when the
  workflow resolvers are unwired. `autoSummaryEnabled`: `:124` gates the harness start.
  `dnaStyleEnabled`: DOCTOR row written by `PipelinePolicyService.setDnaStyleForDoctor`, read by
  `resolveEffectiveDnaStyleEnabled` (3 consumers).
- `consultation.visitTypes`: the `(task, visitType) → prompt` binding decides in
  `PromptResolutionService.resolveVisitTypeBinding` / `serveVisitTypeBinding` (:1370, :1409),
  consulted by the summary / pre-summary / live chains. No dedicated console editor exists (the
  generic registry JSON editor). The v1-compat `visit_type` DTO fields (`text-compat`, vox-node
  `summarization.ts`) are FROZEN wire fields normalised by `dept-templates.ts`, not catalogue
  readers — they stay.
- `agentic.revisit.carryForwardEnabled`: read once, `harness-internal.service.ts:442-456`,
  consumed at `:772`.
- `consultation.endpoint.actions`: read by `LoopConfigService.resolveConfiguredEndpointActions`
  (:325), edited by the Studio `EndpointSequenceEditor`; `resolveEndpointSequence` still accepts
  `alwaysActions`/`neverActions` that nothing supplies. Two endpoint stages (`livedoc.stop`,
  `harness.finalize`) have no node type; the other three do (TS + Python + parity snapshot).
  WF-CONS-004 makes `consultation.hitlGate` terminal, so the seeded legacy SOAP graph cannot
  carry an on-end chain after review; under Substrate B the interpreter (not the loop) runs the
  graph, so an endpoint chain placed BEFORE the gate would lock documents before review.
- `harness.{warmStartEnabled,nerPriorsEnabled,atomicFactEnabled}`: env fallbacks behind
  `HarnessPolicy` columns of the same name (`harness.prisma:385-388`). TS readers:
  `harness-internal.service.ts:255,418-428`, `prompt-assembly.service.ts:384,401-411`. Python:
  `core/config.py:522,534` (`Settings.ner_priors_enabled` / `atomic_fact_enabled`),
  `activities.py:1073,2506` via `_resolve_flag(policy, env_default=settings.x)`.
- `text.guardrailPolicy.{requireMedical,includeReasoning}` and `consultation.realtime.
  graphExecutor.enabled` ALREADY carry `globalOnly: true` on this base (owner decisions dated
  2026-09-05) — this lane pins them with a test rather than editing them.
- `modelSlug` on `GET internal/harness/policy` (`harness-internal.controller.ts:384-419`) is
  threaded into `HarnessPolicyService.getEffectivePolicy(_opts)` which consults nothing (TASK-876).
  `withLlmBinding()` (`node-config-schemas.ts:2181`) folds an `llmBinding` property no runtime
  reads (`api_client.py:384`, `_llm_policy.py:134`).

## Implementation Plan

1. Harness flags → `HarnessPolicy` row only (TS readers read the column, `null` → `false`; Python
   `Settings` fields deleted, `payload.x is True`); descriptors + test maps removed.
2. Inert surfaces: `modelSlug` off the internal route (lane C handoff for the `_opts` type);
   `withLlmBinding()` + `LLM_BINDING_PROPERTY` out of the node schemas; `node-llm-binding` test
   deleted.
3. Pin test for the three `globalOnly` flips (no edit needed).
4. `agentic.revisit.carryForwardEnabled` → `carryForward` on the assigned graph's context/agent
   binding (`core.agent.overrides.carryForward` + `input.context_binding.carryForward`), read
   where the key was read.
5. Endpoint stage → the assigned graph's `trigger:'on-end'` chain: `livedoc.stop` +
   `harness.finalize` node types (TS registry, Python `NodeSpec` + activities, snapshot,
   `ACTION_KEYS` both sides); `LoopConfigService` derives the stage from node presence + `enabled`
   in edge order, platform default when the graph declares none; descriptor, `validate`, console
   editor, `alwaysActions`/`neverActions` levers removed.
6. `consultation.visitTypes` → gone: descriptor, catalogue `prompts` binding, the resolver tier
   (seam `// TASK-884: Agent.tags resolution replaces the visit-type condition`); the two
   shipped visit types become a code constant derived from `parentConsultationId`.
7. `PipelinePolicy` retirement: DNA writing-style node `agent.dna_style` (registry + schema +
   Python marker activity + seeded SOAP graph); doctor opt-out → `UserSettings` (`arcaai-sdk` /
   `dna.styleEnabled`) written by `PUT dna-writing-styles/settings`; `ConfigResolver` keeps
   `resolveAutoSummaryEnabled` (generation node `enabled`), the two DNA resolvers and the
   preferred-template read; model, trios, service, route, CASL rows, scope, descriptors removed.
8. Seed regeneration (21/23/24) for the moved `registryChecksum`; parity snapshot updated.
9. Gates + README + handoffs.

## Intended migration SQL (orchestrator-authored, shadow-DB recipe of rule 02)

```sql
-- TASK-882: PipelinePolicy retired (no live column remains; PipelinePolicyScope enum stays —
-- AgentAssignment / WorkflowAssignment reuse it).
DROP TABLE IF EXISTS "core"."PipelinePolicyChange";
DROP TABLE IF EXISTS "core"."PipelinePolicy";
```

## Implementation Summary

Six commits on `task-882-pipeline-workflow-harness-repoints` (base `1e81c4966`), each gated
before the next; 190 files, +2106 / −7662 against the base.

### Per-key outcome

| Key | New home / gone | Reader replaced at | Proof |
|---|---|---|---|
| `pipeline.autoNerEnabled` | GONE (dead — both branches emitted `PipelineCompleted`; the `agent.ner` node's own `enabled` and the harness's `NamedEntity` persistence shadow it) | `consultation-event.handler.ts` `handleSummaryGenerated` (the read + the skip branch deleted) | `consultation-event.handler.test.ts` (unconditional skip), `task-882.removed-keys.test.ts` |
| `pipeline.harnessEnabled` | GONE (`false` routed to `generator:'legacy'`, which no longer exists — pinned true and deleted) | `note-generation.service.ts` `generate()` (the `harnessEnabled-false` branch + the `metadata.pipelineConfig.harnessEnabled` overlay), `types.ts` (`GenerationFallbackReason`) | `note-generation.service.test.ts` (every supported trigger routes to harness) |
| `pipeline.dnaRedactionEnabled` | GONE (shadowed by the `agent.dna_redaction` node) | `config-resolver.service.ts` `resolveEffectiveDnaRedactionEnabled` — the legacy cascade fallback for unwired resolvers is gone; unwired = OFF | `config-resolver.service.test.ts` §DNA redaction |
| `pipeline.autoSummaryEnabled` | the assigned workflow's generation node `enabled` (`core.agent` or any `generation`-classed type, delegated or not); DOCTOR tier dropped (owner #5) | `ConfigResolver.resolveAutoSummaryEnabled` → `note-generation.service.ts` `resolveConfig` (per-consultation `metadata.pipelineConfig.autoSummaryEnabled` overlay kept); handler `:124` unchanged | `config-resolver.service.test.ts` §auto-summary, `note-generation.service.test.ts` §resolveConfig |
| `pipeline.dnaStyleEnabled` | SPLIT — tenant/department gate = the `agent.dna_style` node (TS registry/ports/schema/`ACTION_KEYS` + Python `NodeSpec`/`interpreter.agent_dna_style` marker activity, parity snapshot, placed on the seeded SOAP graph `n_dna_style`); doctor opt-out = `UserSettings` `dna` / `styleEnabled` (`config-resolver/dna-style-preference.ts`) | `ConfigResolver.resolveEffectiveDnaStyleEnabled` / `resolveDoctorDnaPreference`; writer `DnaWritingStyleService.setDnaEnabled` (`PUT dna-writing-styles/settings`, OCC on the row's `_version`); readers `dna-writing-style.processor.ts:148`, `harness-internal.service.ts` `resolveEffectiveDnaStyleId`, `summary.service.ts` `resolveEffectiveDnaStyleId` (unchanged call, new implementation) | `config-resolver.service.test.ts` §DNA style + §preference, `dna-writing-style.service.test.ts` §DNA settings (create / update+OCC / 412 / clear), `task882-node-schemas`, parity tests both sides |
| `pipeline.templateResync.{enabled,cron}` | STAY (die with `pipeline-template-resync.cron.service.ts` at R4) | — | `task-882.removed-keys.test.ts` pins them present |
| `consultation.visitTypes` | GONE — the two visit types are a code constant derived from `parentConsultationId`; the `(task, visitType) → prompt` binding, `visitTypeKey` axis and trace fields are deleted | `PromptResolutionService.resolve` (seam `// TASK-884: Agent.tags resolution replaces the visit-type condition`), `resolve{Summary,PreSummary,Live}PromptId`; `VisitTypeService` off the settings lane; 7 callers drop `visitTypeKey` | `prompt-resolution.visit-type.test.ts`, `visit-type.service.test.ts`, `text-proxy.visit-type.controller.test.ts` |
| `agentic.revisit.carryForwardEnabled` | `carryForward` binding on `consultation.assemblePrompt` (also via `core.action`) and `core.agent.overrides` | `ConfigResolver.resolveRevisitCarryForwardEnabled` ← `harness-internal.service.ts` `resolveRevisitCarryForwardEnabled` (the `EffectiveSettingsService` injection removed); helpers moved to `consultation/harness/prior-visit-summary.ts` | `config-resolver.carry-forward.task882.test.ts`, `harness-internal.governance-wave2.test.ts` |
| `consultation.endpoint.actions` | the assigned graph's `trigger:'on-end'` chain — membership = node presence + `enabled`, order = edge order; `livedoc.stop` + `harness.finalize` node types added on both runtimes (`interpreter.livedoc_stop` = the idempotent session stop; `interpreter.harness_finalize` = ordering marker); platform default when a graph declares none; `alwaysActions`/`neverActions` and the console `EndpointSequenceEditor` removed | `endpointSequenceFromGraph` ← `LoopConfigService.deriveStartAndEndingActions(definition)` | `endpoint-sequence.test.ts`, `loop-config.node-source.task815.test.ts`, `endpoint-node-registry.test.ts` (5 keys), parity tests |
| `harness.warmStartEnabled` | GONE — `HarnessPolicy.warmStartEnabled` alone (`null` → OFF) | `harness-internal.service.ts` / `prompt-assembly.service.ts` `resolveWarmStartEnabled` (no `ConfigService`, no env branch) | `prompt-assembly.warm-start-policy.test.ts`, `harness-internal.service.test.ts` §effective warmStartEnabled |
| `harness.nerPriorsEnabled` | GONE — `HarnessPolicy.nerPriorsEnabled` alone | `apps/harness` `Settings.ner_priors_enabled` deleted; `activities.py` `extract_entities` reads `payload.ner_priors_enabled is True` | `test_policy_knobs.py::TestPolicyColumnsHaveNoEnvTwin`, `test_activities.py` |
| `harness.atomicFactEnabled` | GONE — `HarnessPolicy.atomicFactEnabled` alone | `Settings.atomic_fact_enabled` deleted; `run_inferential_sensors` reads `payload.atomic_fact_enabled is True` | same + `test_activities_inferential.py` |
| `text.guardrailPolicy.{requireMedical,includeReasoning}`, `consultation.realtime.graphExecutor.enabled` | already `globalOnly: true` on the base (owner decisions of 2026-09-05); `maxScope` left `tenant` (a super admin still writes one tenant's row) | — | `task-882.removed-keys.test.ts` §platform-only flips |
| `modelSlug` on `GET internal/harness/policy` | removed from the wire (`@ApiQuery` + param); `getEffectivePolicy(tenantId, { consultationId, taskKey })` | `harness-internal.controller.ts` | `harness-internal.controller.test.ts` |
| `withLlmBinding()` / `llmBinding` | deleted from `node-config-schemas.ts` (+ `node-llm-binding.task816.test.ts`) | — | `task882-node-schemas.test.ts` (no schema declares `llmBinding`) |

Registry: 11 keys fewer; `task-882.removed-keys.test.ts` asserts each absent (no total pinned).

`PipelinePolicy` ended with no live column, so the model, `PipelinePolicyChange`, both domain trios
(+ `PipelinePolicyChangeRepository.encryption.ts`), `CoreDatabaseModule` registration, the
`TENANT_SCOPED_MODELS` / `SYSTEM_SHARED_READ_MODELS` / `MODELS_WITHOUT_SOFT_DELETE` entries,
`PipelinePolicyService` + module, `admin/harness/pipeline-policy` (controller, module, app
module, scope audit, TASK-773 map), the three CASL rows (`01-policy.ts`), `svc:admin:pipeline-policy:manage`
and `admin:pipeline-policy:manage` retired. `PipelinePolicyScope` STAYS (the assignment tables).
`db:generate` re-run; seeds 21 (hand-pasted checksums), 23 and 24 regenerated for the moved
`registryChecksum`; the parity snapshot carries the three new node types.

### Decisions worth a second look

- **Endpoint chain fallback.** A graph that declares NO endpoint node runs the platform default
  stage. WF-CONS-004 makes `consultation.hitlGate` terminal, so the seeded legacy SOAP graph
  cannot carry the chain (placing it BEFORE the gate would let the interpreter lock documents
  before review under Substrate B); it therefore runs the default, byte-identical to today. A
  `core` graph declares the stage with `core.action` nodes after `core.humanReview`.
- **`harness.finalize` as an interpreter node is an ordering marker** (writes nothing, starts
  nothing): the loop starts the document child at that position; inside an interpreter run the
  graph IS the document workflow. `externalWrite: false` on that one type, `true` on
  `livedoc.stop`.
- **Unwired `ConfigResolver` = OFF for every DNA read** (the legacy `dnaRedactionEnabled`
  cascade that used to answer for unwired resolvers is gone); auto-summary fails toward ON.
- **`ResolvedDnaStyle` gains `doctorPreferenceVersion`** so `GET dna-writing-styles/settings`
  keeps echoing an OCC version (0 = no row) and the console contract is unchanged.

### Files changed (grouped)

- `packages/database`: `pipeline-policy.prisma` deleted; `enums.prisma` comment; `client.ts`,
  `extensions/tenant-scope.ts`; seeds `01-policy.ts`, `94-service-account.ts`,
  `23-arcaai-workflow-authoring.ts` (+ `.generated.ts`), `24-*.generated.ts`,
  `21-workflow-definition.ts` (checksums); tests `seed.test.ts`, `tenant-scope.test.ts`,
  `soft-delete-extension.test.ts`, `policy-change-soft-delete.task816.test.ts`,
  `service-account-seed.test.ts`, `tenant-admin-authority.test.ts`.
- `packages/domains`: 13 `PipelinePolicy*` files deleted; 5 barrels; `core.database.module.ts`;
  `PolicyEntityMappers.occ.task816.test.ts`, `worm-encryption.phase3d.test.ts` trimmed.
- `packages/workflow-contract`: `node-registry.ts` (+3 types), `node-ports.ts`,
  `node-config-schemas.ts` (`carryForward`, 3 schemas, `llmBinding` block deleted),
  `core-contract.ts` (`ACTION_KEYS`), `fixtures/node-registry.snapshot.json`; tests
  (`deprecation` 61, parity list, coverage list, `endpoint-node-registry`, `node-catalogue`,
  `agentic-catalogue`, new `task882-node-schemas`; `node-llm-binding.task816` deleted).
- `packages/applications`: `config-resolver/**` (rewrite + `dna-style-preference.ts`),
  `services/pipeline-policy/**` deleted, `settings-registry/{registry.ts,index.ts,
  registry.types.ts,effective-settings.{service,module}.ts}` + descriptors
  (`pipeline`, `visit-type`, `consultation-endpoint`, `agentic-revisit` deleted;
  `feature-flags` trimmed), `consultation/{events,note-generation,loop,visit-type,prompt,
  harness,summary,jobs}`, `dna-writing-style/**`, `agentic-instructions`, `apiKey/apikey-scopes.registry.ts`,
  `workflow-assignment` (comment), `common/assertExpectedVersion.ts` (comment), tests.
- `apps/api`: `modules/pipeline-policy-admin/**` deleted; `app.module.ts`, `bootstrap/{admin-scope-audit,
  task-773-admin-scope-map}.ts` (+ tests), `consultation/harness-internal.controller.ts`,
  `consultation.controller.ts` (comment), `dna-writing-style.controller.ts` (docs),
  `settings-catalog/**` (examples), `agentic-admin.controller.ts` (doc), `streaming/text-proxy.controller.ts`
  (doc) + `text-proxy.visit-type.controller.test.ts`; `tests/e2e/settings-registry-write.spec.ts` (specimen key).
- `apps/harness`: `core/config.py` (2 fields), `temporal/activities.py`, `temporal/models.py`
  (comments), `interpreter/{registry.py,activities.py,nodes/core.py,nodes/consultation_endpoint.py,
  nodes/agent_catalogue.py}`, `README.md`; tests `test_policy_knobs.py`, `test_activities.py`,
  `test_activities_inferential.py`, `test_trajectory.py`, `test_node_registry_parity.py`.
- `apps/admin-console`: `features/workflow-studio` (`api/endpoint-sequence.ts`, `components/endpoint-sequence/**`
  deleted; `hooks.ts`, `keys.ts`, both `index.ts`, `definitions-list-screen.tsx`);
  `features/agentic-policy` test fixtures.
- `docs/operations/deprecation-register.md` (`PipelinePolicy` row → REMOVED).

### Gates (actual output, on the final tree)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/database test` | `Failed Tests 8` — exactly the 8 pre-attributed (`ai-model-registry-seed.test.ts` ×4, `task-863-agents.test.ts` ×4; TASK-869's 36th catalogue row) |
| `gen:model:check` / `gen:entity:check` / `gen:factory:check` | `check: no drift — 183 generated file(s)` · `no drift — 104 … Schema coverage OK: 102 entity artifact(s) cover every persisted column of 106 Prisma model(s)` · `no drift — 104 … Schema coverage OK: 102 factory artifact(s) … 106 Prisma model(s)` |
| `pnpm --filter @arcaai/domains build` + `test` | build clean; `Test Files 159 passed | 2 skipped (161)` · `Tests 1904 passed | 2 skipped | 9 todo (1915)` |
| `pnpm --filter @arcaai/workflow-contract build` + `test` | `CJS/ESM/DTS ⚡️ Build success`; `Test Files 35 passed (35)` · `Tests 1526 passed (1526)` |
| `pnpm --filter @arcaai/applications build` / `typecheck` / `test` / `lint` | build + typecheck clean; `Test Files 3 failed | 658 passed | 1 skipped (662)` · `Tests 7 failed | 11554 passed | 4 skipped (11565)` — the 7 are NOT this lane's: 3× `svc-scope-route-ability-coverage.test.ts` (reads the GENERATED `apps/api/route-manifest.json`, which still lists `PipelinePolicyAdminController` — clears with the orchestrator's `api:route-manifest`), 3× `asr-agent-resolver.service.test.ts` (expects `['azure-speech','openai']`, receives `azure-foundry` first — the base's `1e50834d7` widened `CLOUD_BYO_PROVIDERS`; file last touched by TASK-874), 1× `vault-kv-coverage.test.ts` (4 `TTS_SERVICE_TOKEN` reads in `apps/api` speech/agent controllers after the base's `tts.serviceToken` descriptor retirement); lint `✖ 214 problems (0 errors, 214 warnings)` — 0 errors, and `eslint` over this lane's changed sources reports nothing |
| `pnpm --filter @arcaai/api typecheck` + `test` | typecheck clean; `Test Files 1 failed | 278 passed | 2 skipped (281)` · `Tests 3 failed | 4197 passed | 4 skipped (4204)` — the 3 are `stt-internal.controller.test.ts` (same `azure-foundry` base condition) |
| `pnpm harness:test` (equivalent, `arcaenv` interpreter) | `6 failed, 2100 passed` — exactly the six `[TMPRL1100]` replay: `test_gating_consolidation_replay` ×2, `test_replay_compat` ×4; interpreter/parity suites `473 passed` |
| `pnpm harness:lint` / `harness:typecheck` | `All checks passed!` · `Success: no issues found in 148 source files` |
| `pnpm --filter @arcaai/admin-console build lint test` | build `✓ Compiled successfully in 23.7s` · `Generating static pages (91/91)` (5 pre-existing Edge-runtime warnings in `instrumentation.ts`); lint exit 0; `Test Files 257 passed (257)` · `Tests 2257 passed (2257)` |

### Residue (grep of every retired key / env name / identifier)

Generated artifacts, regenerated by the orchestrator: `apps/api/route-manifest.json` (3
`PipelinePolicyAdminController` routes), `apps/api/openapi.json` + `apps/admin-console/src/server/api-docs/openapi.*.json`
(the 3 operations, `pipeline.*` examples), `packages/vox-node/src/resources/admin/{pipeline-policy.ts,schemas.ts,…}`
(`gen:admin`), `.env.sample` ×3 / `turbo.json#globalEnv` / `env-surface.generated.md` /
`scripts/generated/python-env-surface.json` (the three `HARNESS_*_ENABLED` names — `env:python-surface`
then `env:sync`). Outside this lane's ownership (comments/docs only): `apps/api/src/config/env.schema.ts:16`,
`apps/api/src/modules/tenant-tts-config/tenant-tts-config-admin.controller.ts:21`,
`apps/admin-console/src/features/ai-services/api/types.ts:92`, `features/settings-registry` test fixture
key, `packages/database/.../workflow-invariant-rule.prisma:35`, `packages/domains/.../WorkflowInvariantRuleRepository.ts:35`
(+ its test), `.claude/rules/05-nestjs-api.md:46`, `docs/architecture/{api-controller-inventory,
api-controller-groupings,configuration-storage-classification}.md`, `docs/architecture/consultation-session-workflow/assessment/02-conformance-matrix.md`,
`docs/operations/consultation/harness-migration-runbook.md`, `docs/development-patterns-and-standards.md:87,522`.
Everything else that matches is this lane's own retirement comment.

## Handoffs

| # | To | What |
|---|---|---|
| H-1 | lane C (`harness-policy.service.ts`) | `getEffectivePolicy(tenantId, _opts)` still types `modelSlug` on `_opts` — the wire no longer sends it; drop the field (the whole `_opts` is inert since TASK-876). |
| H-2 | orchestrator | Regenerate the five API artifacts (`api:route-manifest`, `openapi`, `portal`, `gen:admin`) — clears the 3 `svc-scope-route-ability-coverage` reds and removes `hope.admin.pipelinePolicy`. |
| H-3 | orchestrator | `env:python-surface` THEN `env:sync` on a freshly built `@arcaai/applications` — drops `HARNESS_{WARM_START,NER_PRIORS,ATOMIC_FACT}_ENABLED` from the env surface (`.env.sample` ×3, `turbo.json`, both generated manifests). |
| H-4 | orchestrator (single 3a migration) | `DROP TABLE core."PipelinePolicyChange"; DROP TABLE core."PipelinePolicy";` (SQL above). `PipelinePolicyScope` stays. |
| H-5 | rules/docs owner | `.claude/rules/05-nestjs-api.md:46` cites `PipelinePolicy`'s `globalOnly` descriptor lock as the exemplar of the super-admin-only pattern — swap the example (`SUPER_ADMIN_ONLY_POLICY_KEYS` on `HarnessPolicy` remains); the stale doc/comment sites listed under Residue. |
| H-6 | lane B / F (or orchestrator) | Pre-existing on the base, not this lane: `asr-agent-resolver.service.test.ts` ×3 + `stt-internal.controller.test.ts` ×3 (`azure-foundry` now first in `CLOUD_BYO_PROVIDERS`), `vault-kv-coverage.test.ts` (4 `TTS_SERVICE_TOKEN` reads in `apps/api` with no descriptor). |
| H-7 | console owner | `apps/admin-console/src/app/(console)/(tenant)/harness/pipeline-policy/page.tsx` (redirect, R4 per the register) and `apps/admin-console/tests/e2e/pipeline-policy.spec.ts` (drives the retired route) — outside this lane; the spec must go with the redirect. |
| H-8 | TASK-884 | Seam in `PromptResolutionService.resolve` (`// TASK-884: Agent.tags resolution replaces the visit-type condition`) — where the tag-selected agent's instruction enters the three chains. |

Deferred with a seam: none beyond H-8. Nothing in `packages/agentic-sdk-v2` read any of the
eleven keys (grep: `useText` forwards a free-text `visitType` request field — a frozen v1 wire
name, catalogue-independent — and nothing reads the DNA settings route's shape).

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened; current state verified on `1e81c4966`; plan recorded. |
| 2026-09-06 | `c1f9c092d` harness flags → the `HarnessPolicy` column only; lane pin test. |
| 2026-09-06 | `1cb9871e2` `modelSlug` off the internal route, `withLlmBinding()` out, carry-forward → graph binding. |
| 2026-09-06 | `3f496cbb7` endpoint stage → the assigned graph's on-end chain (two node types on both runtimes). |
| 2026-09-06 | `24cf962f7` `consultation.visitTypes` gone; TASK-884 seam. |
| 2026-09-06 | `PipelinePolicy` retired (DNA-style node + `UserSettings` preference; auto-summary = generation node); seeds regenerated; count pins; README closed. |
