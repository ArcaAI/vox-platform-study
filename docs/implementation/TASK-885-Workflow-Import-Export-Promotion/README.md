# TASK-885 — Workflow capabilities: import/export, Global → SYSTEM promotion, multi-tenant sync

| | |
|---|---|
| **Status** | In Progress |
| **Type** | feature |
| **Program** | TASK-870 — Configuration Governance, wave 3b, lane G |
| **Branch** | `task-885-workflow-import-export-promotion` |
| **Base** | `3227be8d6` (`dev-2.2` + waves 1–3a + the residue lane) |
| **Owner decisions** | #4 (import/export + the Global → SYSTEM path), #7 (relax the promotion gate) |

## Requirement Analysis

The owner's target model (TASK-870 §Requirement Analysis, item 3) makes capabilities —
agents and workflows — portable artifacts rather than rows that exist only where they were
authored:

- A tenant admin **imports/exports workflows as JSON**.
- A tenant admin who manages several tenants **syncs among their OWN tenants**.
- The platform admin **builds in Global (`50000000-…`) and promotes into SYSTEM
  (`00000000-…`)**. SYSTEM is the template every customer tenant refers to and the tenant
  template for new tenants; only the platform admin manages SYSTEM.
- Owner #7 ("fast win"): the eval promotion gate must not block the Global → SYSTEM path on
  evaluation evidence that does not exist yet — `warn` by default for that path, `block` still
  available.

Standing rules this lane must not break: cross-tenant ids are **404**, SYSTEM writes by a
non-super-admin are **403** (a privilege boundary, not the 404-over-403 posture), and
promotion copies **VALUES, never REFERENCES**.

## Current State Evaluation

Verified against the base commit.

| Fact | Where |
|---|---|
| `clone()` already seeds a new lineage from an own-tenant row or a SYSTEM template, recomputing the report and dropping every publish artifact | `workflow-definition.service.ts:331` |
| It refuses a SYSTEM template that pins `promptTemplateId` / `documentTemplateId` — row ids the destination cannot resolve | `:937` `assertNoUnresolvableCatalogBindings` |
| `AgentPromotionService.promote()` already moves ONE immutable `WorkflowDefinition` version between ANY two tenants: elevated tenant-less context + super-admin, `manage:WorkflowDefinition` in BOTH tenants, prompt templates deep-copied, `evalGate` stripped, tenant-owned `documentTemplateId` blocking | `agentPromotion.service.ts:203` |
| …and it deliberately lands the target row as a **DRAFT** and does **not** recompile | same file, class header |
| The eval promotion gate is prompt-template centric (`approve` / `pin`) and defaults to `block` | `eval/eval-promotion-gate.service.ts`, `agentic-eval.descriptors.ts:25` |
| Node configs reference other rows by **row id** at arbitrary depth — `policies[].promptTemplateId` is nested | `node-config-schemas.ts:1143` |
| Portable keys exist for every referenced catalogue: `PromptTemplate @@unique([tenantId, name])`, `DocumentTemplate @@unique([tenantId, slug])`, `McpServer @@unique([tenantId, name])`, `Agent.slug`, `AiModel.slug`, `AiRoutingPolicy.taskKey` | `db_main/*.prisma` |
| The console already has GRAPH-level import/export of the **editor buffer** (TASK-864 B1) — graph only, no definition metadata, no reference rewriting | `features/workflow-studio/lib/graph-io.ts` |
| Tenant provisioning copies configs, a default department, the model / ASR-pipeline / department catalogues — and **no `WorkflowDefinition`** | `tenant.service.ts:139-205` |
| `WorkflowAssignmentService.resolve` walks `department → tenant` only; with no row it reports `platform-default` and the dispatcher then dispatches **nothing** | `workflow-assignment.service.ts:74`, `consultation-workflow-dispatch.service.ts:165` |

## Implementation Plan

### 1. The portable bundle (deliverable 1)

`packages/workflow-contract/src/portable-bundle.ts` is **lane F's** (TASK-884). Until it merges
this lane codes against that contract through a local alias in its own folder
(`portable-bundle.contract.ts`), marked `// TASK-884: replace with the shared PortableBundle
once merged`.

`portable-graph.ts` (pure, unit-tested) walks a node's `config` **recursively** — keyed on the
reference KEY NAMES, never a node-type allow-list — and rewrites row ids into portable keys:

| In the graph | Exported as | Import resolves |
|---|---|---|
| `promptTemplateId` (+ `promptVersionNumber`) | `promptTemplateRef: { name }`, pin dropped | `PromptTemplateRepository.findByName` |
| `documentTemplateId` (+ `documentVersionNumber`) | `documentTemplateRef: { slug }`, pin dropped | `DocumentTemplateRepository.findByTenantAndSlug` |
| `mcpServerId` | `mcpServerRef: { name }` | `McpServerRepository.findByTenantAndName` |
| `providerConfigRef.routingPolicyId` | `providerConfigRef.taskKey` (the pinned row's own task key) | `IAiRoutingPolicyService.resolveDefault` |
| `agentRef: { slug, versionNumber }` | `agentRef: { slug }` — version dropped | `AgentRepository.findPublishedActiveBySlug` |
| `modelSlug` | verbatim | `AiModelRepository.findBySlug` |
| `evalGate` | **STRIPPED** | — |

`evalGate.goldenSetId` names a corpus of Vault-Transit-encrypted PHI; not even the pointer
leaves the tenant — the same rule promotion already applies. Version pins are dropped for the
reason promotion drops them: they number a version in *another* lineage.

The derived `compiledConfig` / `compiledConfigChecksum` / `registryChecksum` /
`validationReport` are **not** exported — they are recomputed on import.

### 2. Routes

| Route | Behaviour |
|---|---|
| `GET admin/workflow-definitions/:id/export` | values-only bundle; cross-tenant id → 404 |
| `POST admin/workflow-definitions/import` | shape → 400; unresolvable references → **409 naming every one**; slug in use → 409; recompile + validate; creates a **DRAFT** |
| `POST admin/workflow-definitions/:slug/sync` | targets the caller manages; a target they do not → **404**; each target gets a DRAFT recompiled against ITS catalogue |
| `POST admin/workflow-definitions/promote-to-system` | Global → SYSTEM through `IAgentPromotionService.promote`, then recompile + publish the SYSTEM row; super-admin + elevated tenant-less, else 403 |

### 3. Promotion gate (deliverable 4)

A path-scoped default under the SAME registry key — no new key, so the program's key count is
untouched. `AGENTIC_EVAL_WORKFLOW_PROMOTION_GATE_DEFAULT = 'warn'` lives beside the existing
default in `agentic-eval.descriptors.ts`; `EvalPromotionGateService.evaluateWorkflowPromotion`
uses it **only when nobody has written the key** (`sourceScope === 'code-default'`). An explicit
`block` still blocks. The `approve` / `pin` gate keeps its `block` default untouched — owner #7
relaxed *that path*, not the clinical template-approval control.

### 4. New-tenant template (deliverable 5)

Confirm by test that provisioning writes no `WorkflowDefinition`, and report what the
"refers to SYSTEM" half actually does today.

### TDD order

1. `portable-graph` pure rewrite (both directions, nested, strip, drop).
2. `export` / `import` service tests incl. the 409 reference list.
3. `sync` — membership, 404 on an unmanaged target, per-target recompile.
4. Promotion gate — `block` / `warn` / `off` on the Global → SYSTEM path.
5. `promoteToSystem` orchestration.
6. Controller depth tests; console.

## Implementation Summary

_Filled on completion._

## Handoffs

_Filled on completion._

## Change History

| Date | Entry |
|---|---|
| 2026-09-06 | Ticket opened; current state verified against `3227be8d6`; plan recorded. |
