# TASK-885 — Workflow capabilities: import/export, Global → SYSTEM promotion, multi-tenant sync

| | |
|---|---|
| **Status** | Review |
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

### What landed

| # | Deliverable | Where | Proven by |
|---|---|---|---|
| 1 | `GET admin/workflow-definitions/:id/export` — values only | `workflow-definition.service.ts` `exportDefinition`, `portable-graph.ts`, controller `export` | `workflow-definition.import-export.task885.test.ts`, `portable-graph.task885.test.ts` |
| 1 | `POST admin/workflow-definitions/import` — resolve against the caller's catalogue, 409 naming the unresolvable | same service `importDefinition` | same, incl. the `WORKFLOW_IMPORT_UNRESOLVED_REFERENCES` body |
| 1 | Console: **Export bundle** on the definition detail, **Import** on the list | `features/workflow-studio` — `lib/bundle-io.ts`, `components/import-definition-dialog.tsx`, `studio-toolbar.tsx`, `definitions-list-screen.tsx` | `import-definition-dialog.task885.test.tsx` (incl. axe) |
| 2 | `POST admin/workflow-definitions/promote-to-system` — Global → SYSTEM through the existing promotion, then recompile + publish | service `promoteToSystem` | `workflow-definition.sync-promotion.task885.test.ts` |
| 3 | `POST admin/workflow-definitions/slug/:slug/sync` — DRAFT per managed target, recompiled against ITS catalogue | service `syncToTenants` | same file |
| 4 | Promotion gate relaxed to `warn` **on this path only** | `agentic-eval.descriptors.ts`, `eval-promotion-gate.service.ts` `evaluateWorkflowPromotion` | `eval-promotion-gate.workflow-promotion.task885.test.ts` |
| 5 | New-tenant template — confirmed, and the gap named | `workflow-assignment/__tests__/new-tenant-template.task885.test.ts` | see the finding below |
| 6 | Route documentation + depth tests | controller `@ApiOperation` + `AUTH-NOTE` markers | `workflow-definition.controller.task885.test.ts` |

### Decisions worth reading

**The bundle carries keys, never ids.** `PromptTemplate` is `@@unique([tenantId, name])`,
`DocumentTemplate` and `Agent` and `AiModel` carry slugs, `McpServer` is
`@@unique([tenantId, name])`, and `AiRoutingPolicy` has `taskKey` — so every reference a node
config can make has a portable key, and `portable-graph.ts` rewrites all of them. Discovery is a
RECURSIVE walk by key name, because a guardrail node carries `policies[].promptTemplateId` nested
inside an array (`node-config-schemas.ts:1143`); a shallow walk would have exported a live foreign
row id with no reference reported.

**`evalGate` is stripped and version pins are dropped**, for the reasons
`AgentPromotionService` already gives: a `goldenSetId` names Vault-Transit-encrypted PHI, and a
pin numbers a version inside another tenant's lineage.

**Import refuses the whole bundle; `importConfigurations` skips.** The divergence from
`IAiRoutingPolicyService.importConfigurations` (which SKIPS an unresolvable model) is deliberate
and stated in the code: a routing artifact is a set of independent rows, a graph is one artifact
whose parts are not independently useful.

**The gate relaxation is a path-scoped default under the SAME key.** A second registry key would
have needed its own owner decision and would have moved the program's key count;
`AGENTIC_EVAL_WORKFLOW_PROMOTION_GATE_DEFAULT = 'warn'` applies only when `resolveEffective`
reports `sourceScope: 'code-default'`, so a written `block` still blocks — which is exactly
"keeping `block` available". Template approval / pin re-point keep `block`: owner #7 relaxed one
path, not the OD-3 clinical control.

**`publish()` was split** into a tenant-guarded wrapper over `publishEntity`, so the elevated
SYSTEM path can publish a row with no caller tenant to compare against. The guard moved; it did
not disappear, and both callers establish who may publish before calling.

**The sync route is `slug/:slug/sync`,** not `:slug/sync`, following the `slug/:slug/webhook-secret`
precedent already in this controller: the id and the slug are different keys, and the URL should
say which one it wants.

### Finding — deliverable 5, stated in full

Tenant provisioning **does not copy workflows**: `tenant.service.ts` provisions configs, a default
department and the model / ASR-pipeline / department catalogues, and touches no
`WorkflowDefinition`. There was nothing to stop, and a source gate now pins it.

**But the "refers to SYSTEM" half does not exist yet.** `WorkflowAssignmentService.resolve` walks
`department → tenant` and stops; with no row it reports `platform-default`, and
`ConsultationWorkflowDispatchService` then dispatches NOTHING (`:165`, "no tier assigned anything
→ Substrate A keeps the consultation"). There is no SYSTEM tier in that cascade, and the
dispatcher's `findPublishedBySlug(tenantId, slug)` is tenant-scoped, so even a SYSTEM-sourced slug
would not resolve. Closing it is two changes — a SYSTEM tier in `resolve()` (this lane's folder)
and a widened lookup in `consultation/workflow-dispatch` (another lane's) — and it changes runtime
behaviour for every unopinionated tenant the moment a SYSTEM assignment row exists. That is an
owner decision, not a quiet fix, so it is DEFERRED and the current behaviour is pinned by test.

### Finding — who can actually sync today

`tenant-scope.ts` grants extension pass-through only when there is no CLS tenant **and** the actor
is `SUPER_ADMIN` (`:635`, `ClsTenantContextProvider.isSuperAdmin`). A cross-tenant read otherwise
throws `TenantScope: tenantId mismatch`. So `syncToTenants` requires the same elevated tenant-less
context promotion does, and a NON-super-admin multi-tenant customer admin — the person owner #4
names — cannot reach it yet. The authorization the owner specified (`manage:WorkflowDefinition` in
every listed tenant, via `PolicyEngine`) is implemented and tested; what is missing is the data
path. Closing it needs either explicit-client seams on five repository finders
(`PromptTemplateRepository.findByName`, `DocumentTemplateRepository.findByTenantAndSlug`,
`McpServerRepository.findByTenantAndName`, `AgentRepository.findPublishedActiveBySlug`,
`AiModelRepository.findBySlug` — all in `packages/domains/**`, outside this lane's ownership) or an
owner decision to widen pass-through to a declared multi-tenant operator. DEFERRED with that seam.

### TDD note

The service and pure-function suites were written RED-first and the failing runs are recorded in
each file's header. The controller suite
(`workflow-definition.controller.task885.test.ts`) is a CONFORMANCE pin written after the routes —
it asserts decorator metadata and delegation over code already in the tree, and is labelled as
such rather than dressed up as a red-first test.

## Handoffs

| To | Item |
|---|---|
| **Lane F (TASK-884)** | `portable-bundle.contract.ts` is a LOCAL ALIAS of lane F's `packages/workflow-contract/src/portable-bundle.ts`. When lane F merges: delete the file and import `PortableBundle` / `PortableSourceTenantKind` from `@arcaai/workflow-contract`. The shape this lane coded against is `{ kind, schemaVersion, exportedAt, source: { tenantKind, slug, versionNumber }, payload }`; `tenantKind` is `'system' \| 'global' \| 'tenant'`. Import sites: `workflow-definition.service.ts`, `dto/workflow-definition-bundle.ts`, and the console mirror in `features/workflow-studio/api/types.ts`. |
| **Lane F (TASK-884)** | NO change to `agentPromotion/**` was needed: `promote()` already does Global → SYSTEM, and the missing recompile + publish is orchestrated in `WorkflowDefinitionService.promoteToSystem` rather than added to the promotion service. `WorkflowDefinitionServiceModule` now imports `AgentPromotionServiceModule`; if lane F renames the module or the `IAgentPromotionService` token, that import and the two type imports in `workflow-definition.service.ts` follow. |
| **Orchestrator** | Regenerate the five artifacts — four NEW routes (`GET :id/export`, `POST import`, `POST promote-to-system`, `POST slug/:slug/sync`): `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`, then the three `:check` gates. No new tag (`admin-workflow-definitions` reused) and no new scope (`svc:admin:workflow-definition:manage` reused), so `tags.ts` and the scope registry need no edit. |
| **Orchestrator** | Run the e2e route-authz matrix after regeneration — the four routes are class-decorated, so they should be covered automatically. |
| **Owner** | Two decisions, both stated above: (1) should `WorkflowAssignment.resolve` gain a SYSTEM tier (and the dispatcher a widened lookup), making an unopinionated tenant actually run the SYSTEM template? (2) should a non-super-admin multi-tenant admin be able to sync — i.e. widen tenant-scope pass-through, or add client seams to five repository finders? |

## Change History

| Date | Entry |
|---|---|
| 2026-09-06 | Ticket opened; current state verified against `3227be8d6`; plan recorded. |
| 2026-09-06 | Implemented: portable graph rewrite; export/import; the workflow-promotion eval gate (owner #7); sync among own tenants; the Global → SYSTEM promotion; four documented routes; console export/import. Gates green at baseline. Two findings deferred with their seams (the SYSTEM assignment tier; non-super-admin sync). Status → Review. |
