# TASK-882 — Pipeline, consultation and harness keys move to the workflow, the harness policy row, or go

| Field | Value |
|---|---|
| Status | In Progress |
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

_(filled at close)_

## Handoffs

_(filled at close)_

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened; current state verified on `1e81c4966`; plan recorded. |
