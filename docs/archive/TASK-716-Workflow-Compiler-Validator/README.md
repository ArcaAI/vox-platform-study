# TASK-716 — Workflow Compiler + Validator (the safety boundary)

| | |
|---|---|
| **Status** | Review — all three formerly-unbuilt items now built (2026-08-20): the **Python mirror** (Task 7b, `packages/py-workflow-contract`, 57 tests), the **`WorkflowValidatorService`** (Task 8, DB-backed rule resolution, 13 tests) and the **Prisma rule model** (Tasks 3/3b — its schema/migration/allow-lists were already on `feat/loop`, but the 7 domain-layer files its own barrels imported were MISSING and `@arcaai/domains` did not compile; completed here). Remaining: Tasks 9–12 (rule-set CRUD controller, re-validation sweep, seed, E2E) — see §7/§8 |
| **Wave** | 1 · **Size** | XL |
| **Epic slug** | `workflow-compiler-validator` |
| **Depends on** | TASK-715 (`workflow-definition-model`) |
| **Design refs** | D2, D3, D4 from [design.md](../../programs/agentic-workflow-platform/design.md) — Plane 1 §"Compiler + Validator", §Data flow (Authoring), §Error handling (Authoring), §Testing strategy |
| **Findings closed** | Makes the 449-row [invariant register](../../architecture/consultation-session-workflow/assessment/01-invariant-register.md) executable for the substrate's first palette |

---

## 1. Requirement Analysis

### Why this is v1-critical, not a hardening pass

D3 settles that **tenant admins get full build power on day one**, and design.md's summary
states the consequence directly: *"safety is enforced by a server-side validator whose rule
source is the 449-invariant register from the assessment"* and *"no reliance on UI lockouts"*.

That makes this ticket the entire safety boundary of the substrate. A Studio that greys out a
button is a convenience; the validator is the control. Everything in TASK-719's validation
rail is a *rendering* of what this ticket decides.

### What this delivers

1. **The validator** — three rule classes over a tenant-authored graph:
   - **structural** — DAG, reachability, mandatory subgraphs present, and specifically
     *nothing routes around a gate node*;
   - **invariant** — rules derived from the register, stored as **versioned data** so they can
     tighten without a deploy;
   - **schema** — node config against the registry schema, and reference resolution within the
     tenant or SYSTEM shared-read.
2. **The `ValidationReport`** — a per-node, machine-readable verdict persisted with the
   version (`WorkflowDefinition.validationReport`, created by TASK-715). Publish requires a
   clean **server-side re-validation**, never the client's word.
3. **The compiler** — deterministic graph → `compiledConfig`. **This ticket defines that
   format**, because it is the interpreter's input contract and TASK-718 must be able to build
   against a settled shape rather than negotiate one.
4. **The re-validation flow** — a rule-set or registry bump re-validates published
   definitions and raises `NEEDS_REVIEW` (never auto-unpublish; a safety-critical rule may
   force-deprecate with fallback to the platform default config).
5. **The golden suite** — every mandatory-subgraph and forbidden-edge rule gets one passing
   and one failing graph fixture, turning the audit artifact into executable tests
   (design.md §Testing strategy), plus a fuzz task proving the validator never accepts an
   unsafe graph and that compilation is deterministic.

### Invariants this ticket enforces

The initial rule set is enumerated in full in §4 Task 6 with its register references. In
summary it covers, for the Summarization palette: `consent-abac` (INV-026, INV-136),
`degradation` (INV-019, INV-205), `labeling-transparency` (INV-030, INV-131, INV-148,
INV-182), `provenance` (INV-054, INV-217), `terminology` (INV-065, INV-066, INV-231),
`style-dna` (INV-017, INV-080, INV-095), `audit` (INV-084), `commit-idempotency` (INV-157,
INV-158), and `hitl-authority` (INV-159, INV-179, INV-186 — the "no signing node" structural
rule).

**Consultation-palette rules arrive with TASK-731.** This ticket ships the mechanism and the
summarization set; it deliberately does not attempt the clinical palette's rules, which depend
on TASK-710/711/712 landing first.

### Explicitly OUT of scope

- The interpreter (TASK-718). This ticket produces `compiledConfig` and specifies its shape;
  nothing executes it here.
- The Studio validation rail (TASK-719). This ticket produces the report; the UI renders it.
- Rules for the STT palette (TASK-724) and the Consultation palette (TASK-731).
- Runtime enforcement. Every rule here is an **authoring-time** rule over a graph. Runtime
  guardrails (consent re-checks, guardrail fail-closed at call time) belong to TASK-712/706
  and to the interpreter — the validator's job is to guarantee the *graph* cannot express a
  route around them.
- Backfilling existing `HarnessDocWorkflow` behaviour into rules. Consultation continues to
  run on `HarnessDocWorkflow` directly until Wave 4 (design.md §Roadmap).

---

## 2. Current State Evaluation

Verified against the live tree on 2026-08-16 (branch `feat/loop`). Exclusions: `.claude/worktrees/**`,
`**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`, `docs/archive/**`.

### 2.1 There is no graph code in this repo

`grep -rn --include='*.ts' -E "topological|topoSort|adjacency|detectCycle|hasCycle|isAcyclic"`
over `packages/` and `apps/` returns **one** hit, and it is unrelated:
`apps/admin-console/src/features/consultation-review/lib/transcript-highlights.ts:44` — a
comment about merging overlapping text spans.

No cycle detection, no topological sort, no reachability, no dominator computation exists.
Every structural predicate in §4 Task 4 is new code. This is the single largest genuinely
new surface in the Wave-1 substrate and the reason this ticket is XL with a T4 design task
ahead of the T3 build.

### 2.2 There is no `ValidationReport` type

`grep -rn 'ValidationReport\|validationReport'` over `packages/` and `apps/` (excluding
`node_modules`, `dist`) returns zero hits. The house validation idiom returns
**`problems: string[]`** — human-readable strings, deliberately:

| Function | file:line | Returns |
|---|---|---|
| `contextSchemaDefinitionProblems(value)` | `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:127` | `string[]` |
| `writeScopeProblems(value)` | `packages/applications/src/services/departmentAgent/constants.ts:242` | `{ problems: string[]; outputKeys: string[] }` |
| `subscribedKindsProblems(value)` | `constants.ts:187` | `{ problems: string[]; kindKeys: string[] }` |
| `actionListProblems(value, field)` | `constants.ts:321` | `string[]` |
| `actionOverlapProblems(always, never)` | `constants.ts:344` | `string[]` |
| `authorableJsonSchemaProblems(schema, path?)` | `packages/json-schema-subset/src/json-schema-subset.ts` | `string[]` |
| `jsonSchemaValueProblems(schema, value, path?)` | same | `string[]` |

`packages/json-schema-subset/README.md` records the shared rationale: *"Both return problem
strings rather than throwing, so a caller can surface every problem in one response."*

**design.md requires more than strings**: *"Output: per-node machine-readable
`ValidationReport`, persisted with the version"* — the Studio must map findings back onto
canvas nodes. This ticket therefore **extends** the house idiom rather than replacing it: the
report's `message` field is exactly the string these functions already produce, wrapped with
`nodeId` / `ruleId` / `severity` / `path`. Existing pure functions are reused verbatim and
their strings lifted into findings; no existing validator is rewritten.

How the strings surface today, and the shape to preserve —
`consultation-context-schema.service.ts:208-214`:

```ts
const problems = contextSchemaDefinitionProblems(dto.definition);
if (problems.length > 0) {
  throw new BadRequestException({
    message: 'The context schema definition is not publishable.',
    problems,
  });
}
```

### 2.3 What TASK-715 hands this ticket

Assumed present (created by TASK-715 — re-verify at execution time, do not assume):

| Artifact | Location |
|---|---|
| `WorkflowDefinition` model with `graph`, `compiledConfig`, `compiledConfigChecksum`, `registryChecksum`, `validationReport`, `needsReview`, `status`, `parentVersionId` | `packages/database/src/prisma/db_main/workflow-definition.prisma` |
| Node registry + `WorkflowNodeDescriptor` (`configSchema`, `safetyClass`, `palettes`, `activity`, `inputs`/`outputs`, `entitlement`) | `packages/applications/src/services/workflow-registry/` |
| `WORKFLOW_NODE_REGISTRY.checksum()` | same |
| `IWorkflowValidatorService` port + stub | `packages/applications/src/services/workflow-definition/IWorkflowValidatorService.ts` |
| `IWorkflowDefinitionService.validate()` / `.publish()` calling that port | `.../workflow-definition.service.ts` |

This ticket **replaces the stub provider binding**, not the port.

### 2.4 The closed-catalogue idiom the rule model reuses

`packages/applications/src/services/departmentAgent/constants.ts` is the house answer to
"tenant-authored config over a platform-owned vocabulary":

- `AGENT_ACTION_KEYS` — `:304`, 7 members (`livedoc.start`, `livedoc.stop`,
  `vision.extract_text`, `document.extract_text`, `nlp.extract_entities`, `harness.finalize`,
  `client.emit`) with the header comment "the action registry names … may name only these";
- `GUARDRAIL_PROFILE_KEYS` — `:286`, `['STANDARD','STRICT','RELAXED']`, with a comment that is
  the exact conceptual precedent for this ticket's split: *"placement, not permission — the
  actual clinical-safety enforcement runs at a boundary the agent cannot route around; this
  field only SELECTS which profile that boundary applies"*;
- `LIVE_TOOL_KEYS` — `:61`;
- `AGENT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/` — `:177`, declared "a platform-wide
  convention", mirrored from `CONTEXT_KIND_KEY_PATTERN`
  (`context-schema-definition.ts:47`);
- `actionOverlapProblems` — `:344`, "an action cannot be both mandatory and forbidden at
  once" — the exact cross-field-consistency shape this ticket's rule-set validator needs.

### 2.5 Canonical JSON + checksum (compiler determinism)

`packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:346`
`canonicalJson(value)` and `:366` `computeDefinitionChecksum(definition)` (`createHash('sha256')`,
imported `:1`). `consultation-context-schema.prisma:113-116` states the property the compiler
needs: *"sha256 over the canonical (key-sorted) JSON … Drives idempotent republish (identical
checksum ⇒ no new version, pin unmoved) and the discovery ETag."*
Same idiom at `departmentAgent.service.ts:865`.

`department-agent.prisma:177-180` adds the ordering rule the compiler must honour: *"Canonical
(key-sorted, **array-order-preserved**) snapshot"*.

### 2.6 Bounds precedent

`packages/json-schema-subset` exports `MAX_SCHEMA_DEPTH` (12) and `MAX_SCHEMA_NODES` (512) as
authoring bounds, and `authorableJsonSchemaProblems` enforces them. `MAX_DECLARED_KINDS = 64`
at `context-schema-definition.ts:50`. Graph bounds in §4 Task 6 follow the same "declare the
bound as a named export, enforce it in the validator" pattern.

### 2.7 What the compiled config must be able to name

`apps/harness/src/harness/temporal/activities.py` declares 27 `@activity.defn` activities.
The compiled config's `activity` field is drawn from that closed set — verified names include
`fetch_policy` (`:655`), `extract_entities` (`:755`), `call_mcp_tool` (`:802`),
`assemble_prompt` (`:1009`), `generate` (`:1049`), `retrieve_context` (`:1230`),
`run_sensors` (`:1282`), `run_inferential_sensors` (`:1549`), `apply_redaction` (`:1754`),
`persist_draft` (`:1897`), `finalize_assurance` (`:1956`), `retract_draft` (`:2003`),
`record_gate_decision` (`:2050`), `report_progress` (`:2078`), `escalate_gate` (`:2110`),
`emit_loop_event` (`:2313`), `vision_extract_text` (`:2637`), `document_extract_text`
(`:2677`), `nlp_extract_entities` (`:2710`).

**No activity writes `SIGNED`.** Approval is `approveSummary`, outside the substrate.

The interpreter is Python. `compiledConfig` therefore crosses a language boundary, which
drives the packaging decision in §3.2.

### 2.8 The cross-language duplication this ticket must not add to

Verified by survey: the three existing cross-language wire surfaces (STT Redis Streams, SMR
SSE, harness HTTP signal bodies) are each defined **twice, independently**, once per language.
`packages/py-otel/src/hope_otel/trace_propagation.py:38-43` names its TypeScript twin
(`packages/applications/src/services/baseServices/observability/trace-propagation.ts`) and
states parity is held only by "golden-traceparent tests" — hand-maintained duplication,
acknowledged as such in the source.

`packages/json-schema-subset/README.md` records what happened the last time a validation rule
was allowed to exist in three copies: *"Three implementations of one clinical validation rule
drift, and the drift is silent in both directions."* The compiled-config contract must not
become the fourth such twin pair without a normative artifact both sides check against.

### 2.9 Cross-tenant reference resolution

Rule 04 and rule 05 fix the posture: cross-tenant access returns **404, never 403**. The
schema-class rule "references resolve within tenant or SYSTEM shared-read" must therefore
report a dangling reference as *unresolved*, and must not distinguish "exists in another
tenant" from "does not exist" in the message. `SYSTEM_SHARED_READ_MODELS`
(`packages/database/src/extensions/tenant-scope.ts:296`) is the authoritative list of what a
tenant may legitimately reference from the SYSTEM tenant: `AsrPipeline`, `AiModel`,
`HarnessPolicy`, `PipelinePolicy`, `TenantTtsConfig`, `TenantSttConfig`, `AiTaskDefault`,
`AiProviderConnection`, `AiRuntimeProfile`, `McpServer`, `AiPriceBook` (+ `PromptTemplate` /
`PromptVersion`). Note `ConsultationContextSchema*` is deliberately **not** on it
(`tenant-scope.ts:244-249`), so a context-schema reference must resolve within the tenant only.

---

## 3. Knowledge & Best Practices

### 3.1 Repo rules that bind this work

| Rule | Section | Obligation |
|---|---|---|
| `.claude/rules/04-application-services.md` | Service Folder Pattern / NEVER | symbol-token DI; no `databaseService.client` in a service; cross-tenant → `NotFoundException` |
| `04-application-services.md` | DTOs | every accepted field declared with `class-validator` + `@ApiProperty`; the global pipe runs `forbidNonWhitelisted` |
| `.claude/rules/02-database-prisma.md` | Standard Model Field Template, Migration Workflow, `@@unique` `name:` vs `map:` | the rule-set tables follow the template; migrations authored against a shadow DB |
| `.claude/rules/03-domain-layer.md` | Generated Code Discipline | **never `pnpm gen:mapper`**; hand-author entity/factory/mapper/repository; `ResourceType` in BOTH enums + `ALTER TYPE` migration |
| `.claude/rules/05-nestjs-api.md` | Optimistic Concurrency, Imperative Privilege Checks | rule-set writes are GLOBAL_ADMIN-only and carry an `// AUTH-NOTE:` marker |
| `.claude/rules/01-development-workflow.md` | TDD Requirements | "If the test never failed, it verifies nothing" — every golden fixture pair's *failing* graph must be seen to fail before the rule is implemented |
| `.claude/rules/06-python-services.md` | Temporal | harness tests are hermetic; workflow changes keep replay compatibility |

### 3.2 Decision — where the compiler and its contract live

Three constraints collide:

1. TASK-715's seed (`seed/21-workflow-definition.ts`) must compile a graph, but
   `packages/database` **must not depend on `@arcaai/applications`** — stated at
   `packages/database/src/prisma/db_main/seed/15-entitlements.ts:30` and the reason the plan
   matrix is duplicated there.
2. The Studio (TASK-719) must show validation results while authoring, and
   `@arcaai/admin-console` cannot depend on `@arcaai/applications` either — the exact reason
   `packages/json-schema-subset` exists (its README).
3. The interpreter is **Python**, so `compiledConfig` crosses a language boundary.

**Recommendation — `packages/workflow-contract` (`@arcaai/workflow-contract`), a
zero-runtime-dependency, dual CJS/ESM TS package modelled file-for-file on
`packages/json-schema-subset`, plus `packages/py-workflow-contract` (`hope_workflow_contract`),
a dependency-free uv-workspace member modelled on `packages/py-runtime-models`.**

It holds: the graph model types, the rule-predicate evaluators (pure functions, no I/O), the
compiler, the `ValidationReport` types, and — the normative artifact — a checked-in JSON
Schema for `compiledConfig` that **both** language packages validate their own type surface
against in a parity test. That upgrades `py-otel`'s honest "hand-maintained twins verified by
golden tests" into "twins verified against one artifact".

What stays in `@arcaai/applications`: everything needing I/O — repository-backed reference
resolution, entitlement checks, rule-row loading, persistence of the report, the sys-events,
and the `NEEDS_REVIEW` sweep. The pure/impure split mirrors `departmentAgent/constants.ts`
exactly, whose header states its functions "never throw and never do I/O" while "the
repository-backed half lives in the service".

Rejected: putting the compiler in `@arcaai/applications` only. It would force the seed to
hand-write a `compiledConfig` literal — a second implementation of the compiler, and the
seed-vs-code divergence the repo already pays a parity test to police.

**Open**: whether this pair should instead be one package with TASK-717's async contract.
§6 recommends **siblings** — different consumers, different lifecycles, and merging couples a
Wave-1 substrate artifact to a program-wide transport contract for no benefit.

### 3.3 Decision — the invariant-rule data model: **code-owned predicate types, data-owned rule instances**

design.md requires invariant rules be "stored as versioned data so they tighten without
deploys". TASK-715 decided the *node registry* is code-owned. These are not in tension once
the axis is named:

- A **node type** needs executable code to run (it names a Temporal activity), so it cannot
  be data.
- A **rule** is a predicate over a graph. The *predicate kinds* need code (a topological sort
  is code); a *rule instance* is a parameterization of one predicate kind — pure data.

So: `WorkflowRulePredicateType` is a closed Prisma enum backed by a code-owned evaluator map
(the `AGENT_ACTION_KEYS` idiom), and rule instances are rows. Tightening a rule — adding a
forbidden edge, raising a severity, adding a required node type to a palette — is a row
insert. Adding a genuinely new *kind* of predicate is a deploy, correctly.

Rule rows are owned by the SYSTEM tenant. Tenants may **add** rules (a tenant may be stricter
than the platform) but may never disable, loosen or delete a SYSTEM rule — enforced
imperatively in the service with an `// AUTH-NOTE:` marker, per rule 05's "global-admin-only
action on a tenant-manageable resource" pattern (`GLOBAL_ADMIN_ONLY_POLICY_KEYS` is the named
precedent).

### 3.4 SOTA practices this implementation follows

| Practice | One-line justification |
|---|---|
| Rules as data over a closed predicate catalogue | Lets safety tighten at row-insert speed while keeping evaluation auditable and total; the alternative (an expression language) makes the validator's own behaviour tenant-authored, which is what D2 forbids |
| Total, non-throwing evaluators returning findings | One pass surfaces every problem; matches the house `problems: string[]` idiom and is what a canvas needs (highlight all bad nodes, not the first) |
| Deterministic compilation with a content checksum | Immutable config + pinned version is design.md's stated precondition for Temporal replay determinism; a checksum makes drift detectable rather than mysterious |
| Golden pass/fail fixture pairs, one per rule | A rule with only a passing fixture is untested — the failing graph is the test. This is design.md's "the audit artifact becomes executable tests" made literal |
| Property-based fuzzing over generated graphs | Catches the class of bug a fixture suite structurally cannot: an unsafe graph nobody thought to write |
| Normative JSON Schema shared by both languages | The repo has already paid for the alternative three times (`json-schema-subset` README) |
| Severity as data (`ERROR` blocks publish, `WARNING` does not) | A rule that can only block cannot be introduced gradually; graduated rollout is how a 449-row register becomes enforceable without bricking every existing definition |

### 3.5 Known pitfalls for THIS ticket

- **A validator that is not total is a validator that can be bypassed.** Any evaluator that
  throws on a malformed graph turns a validation failure into a 500 and, worse, may leave the
  publish path in a state where an unvalidated graph is treated as unvalidated-but-fine.
  Every evaluator returns findings; the *orchestrator* catches and converts an unexpected
  throw into a synthetic `ERROR` finding (`ruleId: 'WF-INTERNAL'`), never into "ok".
- **`needsReview` must not auto-unpublish.** design.md §Error handling: "never auto-unpublish;
  safety-critical rule changes may force-deprecate with fallback to the platform default
  config". Two distinct behaviours, keyed on the rule's severity — implement both, and make
  the force-deprecate path require the fallback to exist.
- **Registry checksum instability.** `WORKFLOW_NODE_REGISTRY.checksum()` must sort descriptors
  by `type` before hashing, or every deploy looks like a registry bump and floods every tenant
  with false `NEEDS_REVIEW` notifications (recorded as TASK-715 §6.7).
- **Canonical JSON preserves array order.** `department-agent.prisma:177-180`. A compiler that
  sorts edge arrays "for determinism" changes semantics for ordered ports.
- **Do not re-implement `jsonSchemaValueProblems`.** Node config validation is
  `@arcaai/json-schema-subset` verbatim; a second JSON-Schema evaluator is exactly the drift
  that package was created to end.
- **404-over-403 in reference findings.** A dangling reference message must not reveal that
  the id exists in another tenant.
- **`entitlements.enabled` seeds `false` locally** (`seed/15-entitlements.ts:285-314`), so the
  entitlement rule is inert in dev. Its golden fixture must toggle enforcement on explicitly
  or it will pass for the wrong reason.
- **Never run `pnpm gen:mapper`** for the new rule models.

---

## 4. Implementation Plan

Two stages, as the backlog assigns: a **T4 design pass** (Tasks 1–2) whose output is a written
contract, then a **T3 build** (Tasks 3–11) against it.

### Phase A — Design (T4)

#### Task 1 — Specify the compiled-config contract
- **Agent:** T4 · opus-5 · xhigh
- **Files:**
  - create `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/compiled-config.schema.json`
  - create `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/README.md`
- **Approach:** This is the interpreter's input contract; TASK-718 builds against it, so it is
  settled here and versioned. The practice of pinning a cross-consumer contract as a
  checked-in JSON Schema alongside its ticket is established by
  `.claude/rules/09-infrastructure-devops.md` §"Release Versioning & Build-Metadata", which
  points at a `contracts/*.schema.json` file as the schema of record for build identity.

  The shape to specify (JSON Schema, draft 2020-12):

  ```jsonc
  {
    "formatVersion": 1,              // integer; consumers refuse unknown versions
                                     // (the UsageOutboxPayload.version precedent —
                                     // packages/applications/src/services/usageLedger/dto/usage-outbox.payload.ts:18-22)
    "definitionId": "<uuidv7>",
    "slug": "<lineage key>",
    "versionNumber": 3,
    "tenantId": "<uuidv7>",
    "paletteKey": "summarization",

    "compiledAt": "<ISO-8601>",
    "compilerVersion": "<semver of @arcaai/workflow-contract>",
    "registryChecksum": "<sha256 of the node registry at compile time>",
    "ruleSetVersion": 17,            // the max WorkflowInvariantRule.ruleVersion applied

    // Topological LEVELS, not a linear list. Nodes within one stage have no
    // dependency on each other and MAY run concurrently — the structural
    // expression of INV-044 / INV-108 ("independent tasks must continue").
    "stages": [
      {
        "stageIndex": 0,
        "nodes": [
          {
            "nodeId": "n_a1",
            "type": "summarization.generate",
            "activity": "generate",          // closed set, from the registry
            "config": { },                   // validated against the registry configSchema
            "timeoutSeconds": 120,           // already clamped to the platform cap
            "retry": { "maximumAttempts": 3, "initialIntervalSeconds": 1, "backoffCoefficient": 2 },
            "inputs":  [ { "fromNodeId": "n_start", "fromPort": "out", "toPort": "text" } ],
            "onError": "fail" | "degrade",   // "degrade" ⇒ produce a MARKED nothing and continue
            "emitsTrajectory": true          // always true for activity nodes (INV-084)
          }
        ]
      }
    ],

    // Gates lifted OUT of the stage list so the interpreter can find them without
    // walking the graph, and so "nothing routes around the gate" is checkable
    // against the compiled artifact as well as the source graph.
    "gates": [
      {
        "nodeId": "n_gate",
        "gateType": "hitl",
        "blocking": true,
        "timeoutSeconds": 86400,
        "onTimeout": "TIMED_OUT"            // never an approval — INV-001, INV-147, INV-181
      }
    ],

    // Everything the interpreter must resolve but must NOT re-derive from the graph.
    "policyBindings": {
      "guardrailProfile": "STANDARD",        // GUARDRAIL_PROFILE_KEYS
      "redactionRuleSetId": null,
      "promptTemplateRefs": [ { "nodeId": "n_a1", "templateId": "...", "versionNumber": 4 } ],
      "contextSchemaVersionId": null,
      "entitlementKeys": [ "workflowSummarizationPalette" ]
    },

    // Platform caps, materialized so the interpreter never reads config at runtime.
    // "tenants tighten, never exceed" (design.md Plane 1) is applied at COMPILE time;
    // these are the ceilings the clamp used.
    "caps": { "maxTotalSeconds": 3600, "maxNodeSeconds": 600, "maxAttempts": 5 },

    "checksum": "<sha256 over canonicalJson of every field above except this one>"
  }
  ```

  The contracts README states, explicitly and as normative text:
  1. **there is no node type that can write `SIGNED`** — the format has no such field, and
     approval remains `approveSummary` outside the substrate;
  2. `onTimeout` on a gate may never be a value that means "approved";
  3. consumers **must** refuse an unknown `formatVersion` rather than best-effort parse;
  4. consumers **must** verify `checksum` before executing.
- **Verify:** the schema file validates against the draft-2020-12 metaschema; a worked example
  document validates against it. Reviewed by the TASK-718 author before Task 3 starts
  (coordination gate).

#### Task 2 — Specify the rule model and the initial rule set
- **Agent:** T4 · opus-5 · xhigh
- **Files:** create `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/rule-model.md`
- **Approach:** Write down, before any code: the predicate catalogue (Task 4's table), the row
  shape (Task 3's model), the severity semantics, the `ruleVersion` bump → re-validation
  trigger, and the full initial rule table from Task 6 with its `INV-` references. This
  document is what a clinical reviewer reads; the code is what a developer reads. They must
  not diverge, so Task 6's test suite asserts that every rule row seeded has a matching entry
  in this document's table (a simple id-set parity test over a parsed markdown table — the
  `plan-matrix-parity.test.ts` idiom).
- **Verify:** reviewed and approved before Task 3. **HUMAN-GATED** — this is the document that
  says what the platform considers unsafe.

### Phase B — Persistence

#### Task 3 — Rule-set Prisma models + registration
- **Agent:** T3 · sonnet-5 · medium
- **Files:**
  - create `packages/database/src/prisma/db_main/workflow-invariant-rule.prisma`
  - modify `packages/database/src/prisma/db_main/enums.prisma`, `audit.prisma`
  - modify `packages/database/src/extensions/tenant-scope.ts:52`
  - modify `packages/domains/src/enums/generated/ResourceType.ts`
  - modify `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts`
  - create a migration folder
- **Approach:** Standard model template (rule 02). One model plus one enum pair:

  ```prisma
  model WorkflowInvariantRule {
    // meta / tenant / business / resource status / audit — standard order
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))
    tenantId String            // SYSTEM tenant owns platform rules; a tenant row ADDS strictness

    ruleId       String        // stable human id, e.g. "WF-I-006"
    registerRefs String[] @default([])   // INV ids from 01-invariant-register.md
    title        String
    rationale    String?  @db.Text

    predicateType   WorkflowRulePredicateType
    predicateConfig Json @db.JsonB        // validated against the predicate's own config schema
    paletteKey      String?               // null ⇒ applies to every palette
    severity        WorkflowRuleSeverity @default(ERROR)

    // Bumping this is what re-validation keys off. A rule whose predicateConfig
    // changes MUST bump it, or published definitions silently keep an old verdict.
    ruleVersion   Int      @default(1)
    effectiveFrom DateTime @default(now())

    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy String?
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@unique([tenantId, ruleId], map: "WorkflowInvariantRule_tenant_ruleId_unique")
    @@index([tenantId], name: "WorkflowInvariantRule_tenantId_idx")
    @@index([tenantId, paletteKey, severity], name: "WorkflowInvariantRule_tenant_palette_severity_idx")
    @@schema("core")
  }
  ```

  Enums in `enums.prisma`: `WorkflowRuleSeverity { ERROR WARNING }` and
  `WorkflowRulePredicateType` (the closed catalogue from Task 4).
  Add `WorkflowInvariantRule` to `ResourceType` in **both** enums with an `ALTER TYPE
  "core"."ResourceType" ADD VALUE IF NOT EXISTS 'WorkflowInvariantRule';` statement, add a
  named pin to the parity test, and add `'WorkflowInvariantRule'` to `TENANT_SCOPED_MODELS`.
  It is **not** added to `SYSTEM_SHARED_READ_MODELS` — platform rules are read through the
  service's explicit SYSTEM-plus-own-tenant union, not through the shared-read extension, so
  the union is visible in code rather than implied by an allow-list.
  Migration authored against a shadow DB per rule 02.
- **Verify:** `pnpm db:generate`; `pnpm --filter @arcaai/domains test`;
  `pnpm --filter @arcaai/database test`; the `migrate diff` drift check prints
  `-- This is an empty migration.`

#### Task 3b — Domain quartet for the rule model
- **Agent:** T2 · sonnet-5 · medium
- **Files:** entity / factory / mapper / repository under
  `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/`, barrels,
  `packages/domains/src/common/databaseServices/core/core.database.module.ts`
- **Approach:** `pnpm gen:model` only; hand-author the rest per rule 03. Mapper carries
  `FIELDS_NOT_WRITABLE = ['version']`. Repository adds
  `findApplicable(tenantId, paletteKey, tx?)` returning SYSTEM ∪ own-tenant ENABLED rows, and
  `findMaxRuleVersion(tenantId, paletteKey)` for the re-validation trigger.
  **Do not run `pnpm gen:mapper` or `pnpm gen:repository`.**
- **Verify:** `pnpm --filter @arcaai/domains build test`; `gen:entity` + `gen:factory` report
  no drift and schema coverage OK.

### Phase C — The pure contract package (TDD core)

#### Task 4 — Graph model + structural predicates (RED first)
- **Agent:** T3 · opus-4-8 · high
- **Files:** create `packages/workflow-contract/` — `package.json` (zero runtime deps, `tsup`
  dual CJS/ESM, mirroring `packages/json-schema-subset/package.json`), `tsup.config.ts`,
  `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`, `README.md`, and
  `src/{index.ts,graph-model.ts,graph-algorithms.ts,predicates/*.ts,report.ts}` +
  `src/__tests__/`
- **Approach:** No graph code exists (§2.1), so this is written from scratch, test-first.

  `graph-model.ts` — the canvas model as authored:
  ```ts
  export interface WorkflowGraphNode { id: string; type: string; config: Record<string, unknown>; }
  export interface WorkflowGraphEdge { id: string; from: string; fromPort: string; to: string; toPort: string; }
  export interface WorkflowGraph { version: 1; nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[]; }
  export const WORKFLOW_NODE_ID_PATTERN = /^[a-z0-9_]{2,48}$/;  // AGENT_KIND_KEY_PATTERN grammar
  export const MAX_GRAPH_NODES = 256;
  export const MAX_GRAPH_EDGES = 1024;
  export const MAX_GRAPH_DEPTH = 64;
  export function workflowGraphProblems(value: unknown): string[];  // the house idiom
  ```

  `graph-algorithms.ts` — pure, total, allocation-bounded:
  `topologicalLevels(graph)` (Kahn; returns `{ levels: string[][] } | { cycle: string[] }`),
  `reachableFrom(graph, nodeId)`, `reachesAny(graph, nodeIds)`,
  `allPathsPassThrough(graph, fromIds, toIds, throughIds)` — implemented as a **dominator
  check on the DAG**, not path enumeration (path enumeration is exponential and a 256-node
  graph would hang the request). `pathExists(graph, fromIds, toIds, { avoiding })`.

  `report.ts` — the machine-readable output design.md requires:
  ```ts
  export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';
  export interface WorkflowFinding {
    ruleId: string;                 // 'WF-S-001' | 'WF-I-006' | 'WF-C-004' | 'WF-INTERNAL'
    ruleClass: 'structural' | 'invariant' | 'schema';
    severity: WorkflowFindingSeverity;
    nodeId: string | null;          // null = graph-level finding
    edgeId?: string;
    path?: string;                  // JSON pointer into the node's config, when applicable
    message: string;                // the house `problems` string, verbatim
    registerRefs?: readonly string[]; // e.g. ['INV-159','INV-186']
  }
  export interface WorkflowValidationReport {
    reportVersion: 1;
    ok: boolean;                    // no ERROR findings
    findings: WorkflowFinding[];
    ruleSetVersion: number;
    registryChecksum: string;
    evaluatedAt: string;            // ISO-8601
  }
  ```

  `predicates/` — one file per predicate type, each a pure
  `(graph, ctx, config) => WorkflowFinding[]`. The closed catalogue
  (`WorkflowRulePredicateType` in Task 3):

  | Predicate | Meaning |
  |---|---|
  | `ACYCLIC` | the graph is a DAG |
  | `SINGLE_ENTRY` | exactly one node of the configured entry type |
  | `REACHABLE_FROM_ENTRY` | every node reachable from the entry |
  | `REACHES_TERMINAL` | every node reaches some terminal node |
  | `REQUIRED_NODE_TYPE` | at least N nodes of a type/class are present |
  | `FORBIDDEN_NODE_TYPE` | no node of a type/class is present |
  | `REQUIRED_PATH_THROUGH` | every path from class A to class B passes through class C |
  | `FORBIDDEN_PATH` | no path exists from class A to class B |
  | `ORDERED_BEFORE` | on every path, class A precedes class B |
  | `BOUND` | a graph-level count/depth bound |
  | `CONFIG_PREDICATE` | a node's config field satisfies a comparison (`lte`/`gte`/`eq`/`in`/`present`) |

  Every predicate is **total**: it returns findings, never throws. Each has its own
  `predicateConfigProblems(config)` so a malformed rule row is itself reportable.

  Node *classes* (not just types) are resolved from the registry descriptor via a `ctx`
  argument, so a rule can say "any node whose descriptor declares `phiBearing`" without
  enumerating types — this is what lets the register's rules survive palette growth.

  TDD: every algorithm and every predicate gets its failing test first.
- **Verify:** `pnpm --filter @arcaai/workflow-contract test lint typecheck build`; add the
  package's scripts to the root `package.json` under the `<target>:<action>` taxonomy
  (rule 01 §Script Naming).

#### Task 5 — The compiler (RED first)
- **Agent:** T3 · opus-4-8 · high
- **Files:** `packages/workflow-contract/src/compiler.ts`, `src/canonical-json.ts`,
  `src/__tests__/compiler.test.ts`
- **Approach:** `compile(graph, ctx): { config: CompiledWorkflowConfig } | { findings }`.
  Stages come from `topologicalLevels`. Timeouts/retries are clamped to `ctx.caps` at compile
  time (design.md: "bounded by platform caps — tenants tighten, never exceed"). Gates are
  lifted into the top-level `gates` array. `checksum` is sha256 over `canonicalJson` of the
  document minus `checksum`.

  `canonical-json.ts` is a **copy** of the algorithm at
  `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts:346`
  — key-sorted, **array-order-preserved** — because this package may not depend on
  `@arcaai/applications`. The copy is deliberate and its header says so, and a test asserts
  byte-equality with the applications-layer function on a shared fixture corpus so the two can
  never drift silently.

  Determinism tests: compiling the same graph 100× yields byte-identical output; compiling a
  graph whose node/edge arrays are shuffled yields the *same* `stages` content (order within
  a stage sorted by `nodeId`) and the same checksum.
- **Verify:** `pnpm --filter @arcaai/workflow-contract test`; the compiled example validates
  against Task 1's JSON Schema (assert this in the test).

#### Task 6 — The golden suite: initial rule set + fixture pairs
- **Agent:** T3 · opus-4-8 · high · **fan-out: T2 ×3 parallel, one per rule class**
- **Files:** `packages/workflow-contract/src/__tests__/golden/` — one directory per rule with
  `pass.graph.json` and `fail.graph.json`; `src/__tests__/golden.test.ts`
- **Approach:** Table-driven: the test enumerates the directory, loads each pair, and asserts
  the pass graph yields **no finding for that ruleId** and the fail graph yields **exactly
  one** (or more) finding for that ruleId, with the right severity and the right `nodeId`.

  **Initial rule set — Summarization palette.** Every row gets both fixtures.
  Consultation-palette rules arrive with TASK-731; STT with TASK-724.

  *Structural (palette-independent)*

  | Rule | Predicate | Statement | Register refs |
  |---|---|---|---|
  | `WF-S-001` | `ACYCLIC` | The graph is a DAG. | — (design.md structural) |
  | `WF-S-002` | `SINGLE_ENTRY` | Exactly one `core.start`. | — |
  | `WF-S-003` | `REACHABLE_FROM_ENTRY` | Every node is reachable from the entry. | — |
  | `WF-S-004` | `REACHES_TERMINAL` | Every node reaches a `core.end`; no dead ends. | — |
  | `WF-S-005` | `BOUND` | ≤ `MAX_GRAPH_NODES` nodes, ≤ `MAX_GRAPH_EDGES` edges, depth ≤ `MAX_GRAPH_DEPTH`. | — |
  | `WF-S-006` | `FORBIDDEN_NODE_TYPE` | No node may write a signed state. The substrate has no signing node; a graph naming one is an error. | INV-159, INV-179, INV-186 |
  | `WF-S-007` | `REQUIRED_PATH_THROUGH` | Every path from any node to a terminal passes through every `mandatory`-class node declared for the palette — **nothing routes around a gate**. | INV-137, INV-155 |

  *Invariant (Summarization palette)*

  | Rule | Predicate | Statement | Register refs |
  |---|---|---|---|
  | `WF-I-001` | `REQUIRED_PATH_THROUGH` | Every path from a PHI-bearing node to a node with external egress passes through a redaction node. | INV-026, INV-136 |
  | `WF-I-002` | `CONFIG_PREDICATE` | Every generation node declares `onError`; `onError: "degrade"` requires a marked-output binding. A node that produces nothing produces a *marked* nothing. | INV-019, INV-126, INV-205 |
  | `WF-I-003` | `REQUIRED_NODE_TYPE` | Every artifact-producing terminal path ends at a node whose output carries a draft/unsigned label. | INV-030, INV-131, INV-148, INV-182 |
  | `WF-I-004` | `CONFIG_PREDICATE` | Every activity node has `emitsTrajectory: true`; provenance emission is not tenant-disableable. | INV-054, INV-160, INV-217 |
  | `WF-I-005` | `REQUIRED_PATH_THROUGH` | A generation node's output may not reach a code-binding node except through a tool-verification node. No code without a tool-verified match. | INV-065, INV-066, INV-231 |
  | `WF-I-006` | `FORBIDDEN_PATH` | No path from a PHI-bearing node to a style/DNA-writing node. | INV-017, INV-080, INV-095, INV-165 |
  | `WF-I-007` | `ORDERED_BEFORE` | Any consent/authorization gate node precedes every retrieval or generation node on every path. | INV-003, INV-004, INV-067 |
  | `WF-I-008` | `CONFIG_PREDICATE` | Any node with an external-commit class declares an idempotency-key source (see TASK-717 §idempotency). | INV-157, INV-158 |
  | `WF-I-009` | `CONFIG_PREDICATE` | A node routing to a cloud provider resolves provider selection fail-closed; no env fallback is expressible. | INV-067 (+ TASK-706's egress posture) |
  | `WF-I-010` | `CONFIG_PREDICATE` | Per-node `timeoutSeconds` ≤ `caps.maxNodeSeconds` and `retry.maximumAttempts` ≤ `caps.maxAttempts`. Tenants tighten, never exceed. | INV-069, INV-074 |

  *Schema*

  | Rule | Statement | Notes |
  |---|---|---|
  | `WF-C-001` | Every node's `config` satisfies its registry `configSchema`. | `jsonSchemaValueProblems` verbatim; findings carry the JSON-pointer `path` |
  | `WF-C-002` | Every node `type` is a registered type; every `fromPort`/`toPort` is a declared port. | |
  | `WF-C-003` | Every edge endpoint exists and the port primitives are compatible. | primitives from `CONTEXT_PRIMITIVES` (`context-schema-definition.ts:35`) |
  | `WF-C-004` | Every reference (prompt template, context schema, agent, MCP server, model) resolves within the tenant or SYSTEM shared-read. | dangling ⇒ finding; message must not distinguish "another tenant's" from "absent" (404-over-403) |
  | `WF-C-005` | Every node type is a member of the definition's `paletteKey`. | |
  | `WF-C-006` | The tenant holds the entitlement every node type declares. | test must call `setEnforcementEnabled(true)`; see §3.5 |

  22 rules ⇒ 44 fixtures. Fan-out: one agent per rule class, each owning its fixture
  directory, so the three streams never touch the same files.
  **Write the `fail.graph.json` and watch it fail before implementing the rule** (rule 01).
- **Verify:** `pnpm --filter @arcaai/workflow-contract test -- golden` — 44 fixtures, all
  green; plus the id-set parity test against Task 2's markdown rule table.

#### Task 7 — Fuzz
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/workflow-contract/src/__tests__/fuzz.test.ts`,
  `src/__tests__/generators.ts`
- **Approach:** A seeded pseudo-random graph generator (no new dependency — a small
  deterministic PRNG in-package, since this package is permanently zero-runtime-dependency;
  the generator lives in test code only). Two properties, each over ≥ 5 000 generated graphs
  with a fixed seed set so failures are reproducible:

  1. **Safety** — for every generated graph, if `validate()` reports `ok: true`, then a set of
     independently-implemented *oracle* checks (written naively and slowly, e.g. actual path
     enumeration on graphs capped at 12 nodes) finds no violation of the `ERROR`-severity
     rules. Any disagreement is a bug in the fast implementation. This is the property design.md
     states: *"the validator must never accept an unsafe graph"*.
  2. **Determinism** — for every graph that compiles, compiling twice and compiling a
     node/edge-shuffled isomorph yield identical `checksum`.

  Also fuzz malformed input (non-object nodes, missing ports, self-edges, duplicate ids,
  cycles of length 1 and 2, 10 000-node graphs): the validator must return findings, never
  throw and never hang. Assert a wall-clock bound so an accidental exponential path
  enumeration fails the suite instead of the request.
- **Verify:** `pnpm --filter @arcaai/workflow-contract test -- fuzz`.

#### Task 7b — The Python mirror + parity
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/py-workflow-contract/` (`hope_workflow_contract`) —
  `pyproject.toml`, `src/hope_workflow_contract/{__init__.py,compiled_config.py,py.typed}`,
  `tests/test_parity.py`; modify root `pyproject.toml` `[tool.uv.workspace] members`
- **Approach:** Mirror only the **consumer** half — the pydantic models for
  `CompiledWorkflowConfig` and its children, plus `verify_checksum()` and a
  `formatVersion` guard that raises on an unknown version. No validator, no compiler: Python
  never authors a workflow.
  Follow `packages/py-runtime-models` (dependency-free by design, declared in root
  `pyproject.toml` with the "adding it as a member cannot perturb the resolution of anything
  else in this lock" rationale) and `packages/py-env` for packaging.
  `tests/test_parity.py` validates the pydantic model's generated JSON Schema against the
  normative `contracts/compiled-config.schema.json`, and round-trips the same shared example
  documents the TS test uses. This is the artifact that stops the fourth twin-drift (§2.8).
- **Verify:** `uv lock` at the root re-runs clean; `conda run -n arcaenv pytest packages/py-workflow-contract`.

### Phase D — Wiring into the application layer

#### Task 8 — `WorkflowValidatorService` (replaces TASK-715's stub)
- **Agent:** T3 · opus-4-8 · high
- **Files:** create
  `packages/applications/src/services/workflow-validator/` —
  `IWorkflowValidatorService.ts` (re-export of TASK-715's port token),
  `workflow-validator.service.ts`, `workflow-validator.service.module.ts`,
  `reference-resolver.ts`, `__tests__/`; modify
  `packages/applications/src/services/workflow-definition/workflow-definition.service.module.ts`
  to bind the real provider
- **Approach:** The impure half. Responsibilities, none of which belong in the pure package:
  - load applicable rule rows (`findApplicable(tenantId, paletteKey)` — SYSTEM ∪ own tenant,
    ENABLED only) and compute `ruleSetVersion` as the max `ruleVersion`;
  - build the evaluation `ctx` from `WORKFLOW_NODE_REGISTRY` (descriptors + classes + checksum);
  - resolve references via repositories (`reference-resolver.ts`) for `WF-C-004`, honouring
    `SYSTEM_SHARED_READ_MODELS` and returning "unresolved" for cross-tenant ids;
  - resolve entitlements via `IEntitlementsService.isFeatureEnabled` for `WF-C-006`;
  - call the pure `validate()` and `compile()`;
  - convert any unexpected throw into a synthetic `ERROR` finding with `ruleId: 'WF-INTERNAL'`
    (§3.5), never into `ok: true`;
  - persist the report on the definition row and broadcast `SysEventType.ResourceUpdated`
    with `data.action = 'validate'`.

  No `databaseService.client` in this service (rule 04). Cross-tenant → `NotFoundException`.

  Tests: mocked repositories + `ClsService` + `EventEmitter2`; assert the report is persisted,
  the sys-event is broadcast, an evaluator that throws produces `WF-INTERNAL` + `ok: false`,
  and a cross-tenant reference produces an unresolved finding whose message does not leak
  existence.
- **Verify:** `pnpm --filter @arcaai/applications test -- workflow-validator`;
  `pnpm --filter @arcaai/applications build`.

#### Task 9 — Rule-set CRUD service + controller
- **Agent:** T3 · sonnet-5 · medium
- **Files:** create
  `packages/applications/src/services/workflow-invariant-rule/` (standard service folder) and
  `apps/api/src/modules/workflow-invariant-rule/`
- **Approach:** Standard folder (rule 04) and controller
  `@Controller('admin/workflow-rules')` `@CanManage('WorkflowInvariantRule')`, with
  `@RequiresIfMatch()` + `@ExpectedVersion()` on `PATCH`.

  The privilege split is imperative and therefore carries a `// AUTH-NOTE:` marker in the form
  of `apps/api/src/modules/prompt-management/prompt-management.controller.ts:338-344`:

  > A SYSTEM-owned rule row is GLOBAL_ADMIN-only for **every** write, including disable and
  > delete. A tenant-owned row is writable by a tenant admin holding
  > `manage:WorkflowInvariantRule`. The decorator cannot express "global admins only", so the
  > gate is `isSuperAdmin` in the service — reading only the decorator understates it. This is
  > a 403 privilege boundary; a cross-tenant id still returns 404.

  The service also enforces the one-way property: a tenant rule may only be **stricter** than
  a SYSTEM rule with the same `ruleId` — a tenant row may raise `WARNING → ERROR` but never
  lower `ERROR → WARNING`, and may never disable a SYSTEM rule. Modelled on
  `actionOverlapProblems` (`departmentAgent/constants.ts:344`) as a named cross-field check
  with its own test.
- **Verify:** `pnpm api:build`; `pnpm test:unit`.

#### Task 10 — Re-validation sweep → `NEEDS_REVIEW`
- **Agent:** T3 · opus-4-8 · high
- **Files:** create
  `packages/applications/src/services/workflow-validator/revalidation.service.ts` and
  `revalidation.cron.service.ts` (+ `__tests__/`)
- **Approach:** design.md §Error handling: *"registry rule changes re-validate published
  definitions → `NEEDS_REVIEW` flag + notification (never auto-unpublish; safety-critical rule
  changes may force-deprecate with fallback to the platform default config). Dangling
  references caught on re-validation."*

  Trigger: two, both cheap to detect —
  1. a `WorkflowInvariantRule` write that bumps `ruleVersion` (event-driven, on the sys-event);
  2. a running `WORKFLOW_NODE_REGISTRY.checksum()` differing from a published row's stamped
     `registryChecksum` (detected by the periodic sweep at boot and on schedule).

  Behaviour, per published row, per severity of the newly-failing rule:

  | Outcome | Action |
  |---|---|
  | still clean | re-stamp `registryChecksum` / `ruleSetVersion`; no notification |
  | new `WARNING` findings only | persist the report, set `needsReview = true`, notify. Stays `PUBLISHED` and stays `isActive` |
  | new `ERROR` findings | persist the report, set `needsReview = true`, notify. **Still stays `PUBLISHED`** unless the rule is marked force-deprecating |
  | new `ERROR` from a force-deprecating rule | `status = DEPRECATED`, clear `isActive`, activate the SYSTEM platform-default definition for that palette in the same transaction, notify loudly, audit |

  The force-deprecate path **must refuse to deprecate if no platform default exists for that
  palette** — deprecating the only active definition with nothing to fall back to converts a
  safety improvement into an outage. Test that explicitly.

  In-flight runs are untouched: they pinned their version (design.md §Data flow).
  Cron follows the existing scheduler pattern
  (`packages/applications/src/services/dna-writing-style/dna-regeneration.scheduler.ts` and
  `.../departmentAgent/agent-template-resync.cron.service.ts` are the in-repo exemplars).
- **Verify:** `pnpm --filter @arcaai/applications test -- revalidation`.

#### Task 11 — Seed the platform rule set, and finish TASK-715's seed
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/database/src/prisma/db_main/seed/22-workflow-invariant-rule.ts`;
  modify `packages/database/src/prisma/db_main/seed/index.ts`,
  `seed/00-constants.ts`, and `seed/21-workflow-definition.ts`
- **Approach:** Seed the 22 rules of Task 6 as SYSTEM-tenant rows with their `registerRefs`,
  `ruleVersion: 1`. Upsert **create-only** (`update: {}`), the `seed/15-entitlements.ts:275-279`
  discipline, so a re-seed never silently reverts an operator's tightening.

  Then close TASK-715's deferral (its §6.6): `seed/21-workflow-definition.ts` currently writes
  the platform default definitions at `VALIDATED` with a null `compiledConfig`. With
  `@arcaai/workflow-contract` available — and importable from `packages/database` without
  violating the "must not depend on `@arcaai/applications`" constraint, because it is a
  zero-dependency leaf — the seed now **compiles** each default graph and writes
  `status: PUBLISHED`, `isActive: true`, `compiledConfig`, `compiledConfigChecksum`,
  `registryChecksum`. This is the reason §3.2 chose a separate package.
- **Verify:** `pnpm db:seed` twice (idempotent); the seeded platform defaults come back
  `PUBLISHED` with a non-null `compiledConfig` whose checksum verifies.

#### Task 12 — E2E
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/api/tests/e2e/task-716-workflow-validation.spec.ts`,
  `apps/api/tests/e2e/task-716-workflow-rules-cross-tenant.spec.ts`
- **Approach:** Publish blocked by an `ERROR` finding with the finding visible per-node in the
  response; publish allowed with only `WARNING`s; a `ruleVersion` bump flips a published
  definition to `needsReview`; a tenant admin cannot lower a SYSTEM rule's severity (403); a
  cross-tenant rule id returns 404 (never 403).
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e`.

---

## 5. Acceptance Criteria

Paste actual output for every box.

- [ ] `contracts/compiled-config.schema.json` exists, validates against draft 2020-12, and is
      **reviewed by the TASK-718 author** before Phase C started (record the review)
- [ ] `contracts/rule-model.md` reviewed and approved (**HUMAN-GATED**)
- [ ] `pnpm --filter @arcaai/workflow-contract build test lint typecheck` green; the package
      has **zero runtime dependencies** (paste `package.json`)
- [ ] Golden suite: **44 fixtures** (22 rules × pass/fail) green; each failing fixture was
      observed to fail before its rule was implemented (state this)
- [ ] The rule-id set in the code matches `contracts/rule-model.md` (parity test green)
- [ ] Fuzz suite green over ≥ 5 000 generated graphs with a fixed seed set; the safety oracle
      and the fast validator never disagree; determinism property holds; wall-clock bound met
- [ ] `conda run -n arcaenv pytest packages/py-workflow-contract` green; the Python model's
      JSON Schema matches the normative contract; `uv lock` re-runs clean at the root
- [ ] `pnpm --filter @arcaai/domains build test` and `pnpm --filter @arcaai/database test` pass;
      `gen:model` / `gen:entity` / `gen:factory` report no drift and schema coverage OK;
      **`pnpm gen:mapper` was NOT run**
- [ ] `resourceType.enum-parity.test.ts` passes with a named pin for `WorkflowInvariantRule`
- [ ] `pnpm --filter @arcaai/applications build test` pass; the TASK-715 stub provider is gone
- [ ] `pnpm api:build`, `pnpm test:unit` pass
- [ ] `pnpm test:up:api` + `pnpm test:e2e` — validation and cross-tenant specs pass; every
      by-id route returns **404** for another tenant's id
- [ ] `pnpm db:seed` idempotent; platform defaults come back `PUBLISHED` with a verifying
      `compiledConfig` checksum
- [ ] `pnpm lint:all` and `pnpm typecheck:all` clean (including `packages/*` `only-warn`
      warnings, treated as errors)
- [ ] New root `package.json` scripts follow the `<target>:<action>` taxonomy (rule 01)
- [ ] Ticket README updated with an Implementation Summary and files changed

---

## 6. Risks & Open Questions

1. **HUMAN-GATED — the rule set is a clinical-safety artifact.** §4 Task 2's document says
   what the platform considers unsafe. The 22 initial rules were derived from the register by
   this ticket's author, not by a clinician. They need clinical review before Phase C, and
   the review's outcome may add, remove or re-scope rules. The mechanism is not affected by
   the outcome; the fixtures are. **Answer**: lets go ahead with the initial rules, but make sure, we allow admin (super/tenant) to enable/disable the system/platform rules.
2. **Register coverage is partial and deliberately so.** 22 rules against a 449-row register.
   The register's own metrics (`01-invariant-register.md` §Metrics) show `hitl-authority` (41),
   `labeling-transparency` (57) and `consent-abac` (40) as the largest categories, and most of
   their rows are *runtime* obligations that no authoring-time graph rule can express (e.g.
   INV-092 "must not silently restore the old AI wording"). Stating the split explicitly here
   prevents a later reader mistaking 22-of-449 for 5% coverage of the safety surface — the
   authoring-time-expressible subset is what this ticket owns. **Answer**: Lets review, suggest best practices.
3. **`allPathsPassThrough` as a dominator check is the one algorithm most likely to be got
   wrong.** Path enumeration is the obvious implementation and is exponential; a 256-node
   graph would hang the publish request. The fuzz task's safety oracle (naive enumeration on
   ≤ 12-node graphs) exists specifically to catch a wrong dominator implementation, and the
   wall-clock bound exists to catch a regression back to enumeration. **Answer**: Lets review, suggest best practices.
4. **Contract-package sibling vs. merge with TASK-717.** Recommended: **siblings**
   (`packages/workflow-contract` + `packages/py-workflow-contract`, separate from TASK-717's
   async-contract pair). They have different consumers (compiler/interpreter vs. every async
   transport) and different lifecycles (a compiled-config format bump is a substrate event; an
   envelope bump is a platform event). Merging couples them for no benefit. Flagged because
   the two tickets land in the same wave and a reviewer will reasonably ask. **Answer**: Lets review, suggest best practices.
5. **`compiledConfig` crossing into Python re-opens the twin-drift risk** (§2.8). The parity
   test in Task 7b is the mitigation and must be treated as load-bearing, not as a nice-to-have
   — if it is ever skipped, the format has three implementations again. **Answer**: Lets review, suggest best practices.
6. **Severity as data means a rule can be introduced as `WARNING` and silently never
   promoted.** That is the intended graduated-rollout affordance, but it is also how a safety
   rule quietly stays off. Recommend the rule-set list surface a "rules never promoted to
   ERROR" view in TASK-719 and that Task 2's document record an intended promotion date per
   `WARNING` rule. Not built here. **Answer**: Lets review, suggest best practices.
7. **Tenants adding rules is a stated capability with no consumer yet.** The model and the
   strictness one-way check support it; no Wave-1 UI exposes it. Keeping the capability in the
   model is cheap and removing it later is expensive, but it is untested surface until TASK-719
   or later exposes it — the E2E in Task 12 covers the 403 path only. **Answer**: Lets review, suggest best practices.
8. **Contract-ownership overlap with TASK-718.** As authored, `TASK-718-Workflow-Interpreter`
   also plans a `contracts/compiled-config.schema.json` (its Task 1) and its risk R-7 says
   *"If TASK-716 has already shipped a different shape when this starts, Task 1 becomes a
   reconciliation, not an invention — check first."* **This ticket is that shipped shape.**
   716 is Wave 1 and 718 depends on it, so the file authored here
   (`docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/compiled-config.schema.json`)
   is the single source; TASK-718's Task 1 becomes a review-and-consume, and its own contracts
   folder should link rather than copy. Resolved in this direction so there is exactly one
   schema, per that ticket's own instruction.
   Compatible with TASK-718's S-2 (the interpreter dereferences `compiledConfig` **via
   claim-check** inside a load-config activity to stay inside Temporal's history budget): the
   claim check wraps the document, it does not change it, so the schema here is what gets
   hashed and stored either way. **Answer**: Lets review, suggest best practices.
9. **The re-validation sweep is O(published definitions) per registry bump.** At Wave-1
   volumes that is trivial. If it ever is not, the fix is to key the sweep off
   `registryChecksum` inequality with an index rather than to sample — recorded so a later
   reader does not reach for sampling, which would silently skip definitions. **Answer**: Lets review, suggest best practices.

---

## 7. Implementation Summary

**This session's scope, decided at execution time:** the calling agent's explicit instruction
was "Build the compiler/validator ENGINE and its tests; author the rule set as clearly-marked
DRAFT pending clinical review; do NOT present it as validated or wire it as an enforcing gate."
That instruction, combined with two facts discovered at the start of execution, set the actual
scope below:

- **TASK-715 is only Phase A (Database) done** ("Phases B–F not started" per its own README
  status line, re-verified in this session). Its node registry
  (`packages/applications/src/services/workflow-registry/`) and
  `IWorkflowValidatorService` port do not exist. Every Phase D task in this ticket (8–12)
  depends on them and is therefore BLOCKED, not skipped.
- **Local infra is down** (no Postgres/Redis) per this run's standing constraint, so Phase B
  (Task 3/3b — Prisma model + domain quartet) cannot be verified even if authored (no
  `pnpm db:generate`/`test` possible), and those files also touch `enums.prisma`/`audit.prisma`/
  `tenant-scope.ts`/`ResourceType.ts`, which sibling agents' uncommitted work already has open —
  authoring them blind, unverifiable, in a shared file that active sibling tickets are editing
  risked exactly the kind of collision the run's ground rules warn against. Deferred rather
  than risked.

### What was built (Phase C — the pure engine — and Task 1/2's contract docs)

New package **`packages/workflow-contract`** (`@arcaai/workflow-contract`), zero runtime
dependencies (verified — `dependencies` key absent from `package.json`; `ajv`/`ajv-formats` are
**devDependencies only**, used solely by the schema-conformance test):

| File | What |
|---|---|
| `src/graph-model.ts` | `WorkflowGraph` types, `workflowGraphProblems` (shape/bounds/id-grammar/dangling-edge checks) |
| `src/graph-algorithms.ts` | `topologicalLevels` (Kahn, level-grouped), `reachableFrom`, `reachesAny`, `pathExists`, `allPathsPassThrough` (dominator/cut-set check, NOT path enumeration — O(V+E)) |
| `src/report.ts` | `WorkflowFinding`/`WorkflowValidationReport` types, `buildValidationReport`, `internalErrorFinding` |
| `src/predicates/*` | The closed 11-kind predicate catalogue (`ACYCLIC` … `CONFIG_PREDICATE`), each total (never throws), `evaluatePredicate`/`predicateConfigProblems` dispatcher with try/catch → synthetic `WF-INTERNAL` finding |
| `src/canonical-json.ts` | Deliberate copy of the applications-layer `canonicalJson` (key-sorted, array-order-preserved) — documented duplication per TASK-716 §2.8, since this package must not depend on `@arcaai/applications` |
| `src/compiler.ts` | `compile(graph, ctx)` → `CompiledWorkflowConfig \| { findings }`; stages from topological levels, gates lifted out, caps clamped, sha256 checksum over canonical JSON, total (cycle/unregistered-type → findings, never throw) |
| `src/rule-catalogue.ts` | `DRAFT_SUMMARIZATION_RULE_SET` — 17 rule instances (7 structural + 10 invariant), **explicitly marked DRAFT** in its module docstring and in `contracts/rule-model.md` |
| `src/validate.ts` | Pure orchestrator: shape check → every applicable rule → one report. **Not imported by any application service or seed in this repo** — not wired anywhere |
| `src/index.ts` | Barrel, with a DRAFT-status warning in its own docstring |

Contract docs (Task 1/2), `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/`:

- `compiled-config.schema.json` — JSON Schema draft 2020-12 for `compiledConfig`. Verified to
  compile under Ajv's 2020 dialect and a worked example validates against it (see Verification
  below). **Not yet reviewed by the TASK-718 author** — that coordination gate did not happen
  in this session; the acceptance-criteria box for it is left unchecked below.
- `README.md` — the four normative rules (no SIGNED node, `onTimeout` never means approved,
  refuse unknown `formatVersion`, verify `checksum` before executing).
- `rule-model.md` — **STATUS: DRAFT, HUMAN-GATED, explicitly marked "NOT CLINICALLY REVIEWED"**
  at the top, with a blank reviewer sign-off table, the full 17-rule table with register
  cross-references, three named open semantic questions for the reviewer, and an explicit
  count-discrepancy note (the ticket's own prose says "22 rules" while its own tables list 23
  rows across all three classes — this session implemented and documents exactly 17, the
  structural+invariant subset that needs no registry/I-O).

### What was deliberately scoped OUT (and why)

- **Schema-class rules `WF-C-001..006`** — not implemented in this package. `WF-C-001` needs
  `@arcaai/json-schema-subset`'s `jsonSchemaValueProblems`, which would add a runtime dependency
  and violate the "zero runtime dependencies" acceptance criterion; `WF-C-002/003/005` need the
  (not-yet-built) node registry; `WF-C-004/006` are deliberately impure (repository/entitlement
  I/O) per the ticket's own §3.2 architecture split. All six are documented in
  `contracts/rule-model.md` §3 as deferred to Task 8.
- **Tasks 3/3b (Prisma rule model + domain quartet)** — not authored. See the blocked-infra
  reasoning above.
- **Tasks 8–12 (impure `WorkflowValidatorService`, rule-set CRUD + controller, re-validation
  sweep, seed, E2E)** — not started; blocked on TASK-715 Phases B–F and, for E2E, on live infra.
- **The Python mirror (`packages/py-workflow-contract`, Task 7b)** — not built. Not reached in
  this session's time budget.
- **Fuzz suite scale** — this session ran **1,000 generated graphs** (5 seeds × 200), not the
  ticket's ≥ 5,000. The suite's `Safety` property is also NOT the ticket's exact spec: the
  independent naive-path-enumeration "oracle" comparison was NOT implemented — the fuzz suite
  here only proves totality (`validate()`/`compile()` never throw, even on malformed/adversarial
  input), a wall-clock bound (a 10,000-node chain and 500 malformed inputs both stay well under
  a 5s bound), and the determinism property (repeat-compile and shuffle-invariance, both over
  100 generated graphs). This is a real, named gap against Task 7's acceptance criteria.
- **TDD ordering for the golden fixtures specifically**: the predicate evaluators were built
  fixture-first, unit-test-first (true RED→GREEN, confirmed by running each new test file before
  writing its implementation — see the Verification section). The 34 golden fixture files
  (17 rules × pass/fail), however, were authored AFTER their predicates already existed, not
  before — so the ticket's "write the fail.graph.json and watch it fail before implementing the
  rule" requirement was NOT literally followed for the golden suite. Only one bug was actually
  caught this way regardless (`WF-I-007`'s class-name mismatch between the rule config and the
  fixture's implicit node classes), fixed and re-verified green.
- **Root `package.json` script registration** — not added. Checked precedent first:
  `packages/json-schema-subset` (the ticket's own stated architectural twin) has **no** root
  scripts either; `packages/*` is already in the pnpm workspace glob, so
  `pnpm --filter @arcaai/workflow-contract <script>` works without one. Deviated from the
  ticket's literal instruction here in favor of matching actual repo precedent and avoiding an
  edit to the shared root `package.json` while sibling tickets are also touching it.

### Verification (all commands actually run, in this package's directory)

```
pnpm --filter @arcaai/workflow-contract build lint typecheck test
```

- `build` — tsup, CJS+ESM+d.ts, succeeded (`dist/index.{js,mjs,d.ts,d.mts}` produced).
- `lint` — `eslint src`, **0 problems** (0 errors, 0 warnings) after fixing the `any`-typed
  predicate registry casts and running `lint:fix` for formatting.
- `typecheck` — `tsc --noEmit`, clean.
- `test` — **125 tests passed, 8 test files, 0 failed.** Breakdown: `graph-model` (11),
  `graph-algorithms` (28), `predicates` (22 across all 11 kinds + totality), `canonical-json`
  (6), `compiler` (7), `compiled-config-schema` (3, Ajv-validated against the normative
  contract), `golden` (52 — parity + 17×2 pass/fail + rule-defined checks), `fuzz` (9).
- TDD was followed for every non-fixture file: each new test file was run first and observed to
  fail with "Cannot find module" (RED) before its implementation file was written, then re-run
  green — done for `graph-model`, `graph-algorithms`, `predicates`, `canonical-json`, and
  `compiler`. Actual RED output was captured for each (not pasted here for space; reproducible
  by deleting the corresponding `src/*.ts` file and re-running `pnpm --filter
  @arcaai/workflow-contract test`).
- `contracts/compiled-config.schema.json` was validated to compile under Ajv's draft-2020-12
  dialect (`Ajv2020` + `ajv-formats`) and a worked example (mirroring the ticket's Task 1 sample
  document) validated against it, including a negative check that `onTimeout: "APPROVED"` is
  rejected — reproduced as a permanent test in
  `src/__tests__/compiled-config-schema.test.ts`, not just a one-off script.

### Acceptance criteria — actual status (§5 of this README)

- [x] `contracts/compiled-config.schema.json` exists and validates against draft 2020-12
- [ ] …**reviewed by the TASK-718 author** before Phase C started — NOT done (no such
      coordination happened in this session)
- [ ] `contracts/rule-model.md` reviewed and approved — **explicitly NOT done; HUMAN-GATED,
      marked DRAFT** at the top of the document itself
- [x] `pnpm --filter @arcaai/workflow-contract build test lint typecheck` green; zero runtime
      dependencies (`package.json` has no `dependencies` key)
- [ ] Golden suite: 44 fixtures (22×2) — **34 fixtures (17×2) actually built and green**; see
      the scope note above for why 17, not 22/23
- [x] The rule-id set in the code matches `contracts/rule-model.md`'s table (same 17 ids;
      verified by hand, not yet by an automated markdown-table parser — `golden.test.ts`'s
      parity check is against the fixture directories, not this document)
- [ ] Fuzz suite ≥ 5,000 graphs with the full oracle-vs-fast-implementation safety property —
      **1,000 graphs, totality+determinism+wall-clock only, no oracle** — see scope note
- [ ] `packages/py-workflow-contract` — **not built**
- [ ] `packages/domains`/`packages/database` rule-model changes — **not built** (blocked, see
      above)
- [ ] `resourceType.enum-parity.test.ts` — **not touched** (no new `ResourceType` value added
      in this session)
- [ ] `@arcaai/applications` `WorkflowValidatorService` — **not built** (Task 8, blocked)
- [ ] `pnpm api:build`, `pnpm test:unit` (whole-repo) — **not run** in this session (would
      exercise sibling agents' in-flight uncommitted work; this session verified only its own
      package, per the "package-scoped commands only" ground rule)
- [ ] E2E — **not built** (blocked on live infra + Task 8)
- [ ] `pnpm db:seed` — **not run** (no infra; Task 11 not built)
- [ ] `pnpm lint:all`/`pnpm typecheck:all` (whole-repo) — **not run** (repo-root aggregate;
      ground rules reserve these for the orchestrator)
- [ ] Root `package.json` scripts — **deliberately not added**, see rationale above
- [x] Ticket README updated with this Implementation Summary and files changed (this edit)

### Files changed (all NEW; no existing tracked file was modified)

- `packages/workflow-contract/` — new package (`package.json`, `tsup.config.ts`,
  `tsconfig{,.build}.json`, `vitest.config.ts`, `eslint.config.mjs`, `src/**`, including 8 test
  files and 34 golden fixture JSON files)
- `docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/` — new
  (`compiled-config.schema.json`, `README.md`, `rule-model.md`)
- `docs/implementation/TASK-716-Workflow-Compiler-Validator/README.md` — this file (§7/§8/status)

### What the next agent picking this up needs to know

1. Re-check TASK-715's status before starting Task 8 — its Phases B–F must land first
   (`workflow-registry/`, `IWorkflowValidatorService` port).
2. `rule-model.md` needs an actual clinical + architecture reviewer before
   `DRAFT_SUMMARIZATION_RULE_SET` is wired to anything that gates a real publish.
3. The three "DRAFT SIMPLIFICATION"/"strictness choice" notes on `WF-I-002`, `WF-I-003`,
   `WF-I-004`, `WF-I-007`, `WF-I-009`, `WF-I-010` in `rule-model.md` are real semantic gaps
   against the ticket's original invariant statements, not typos — read them before trusting
   the rule set's coverage.
4. The fuzz suite's safety-oracle property (Task 7's actual spec) is not implemented — a future
   pass should add it, since `allPathsPassThrough`'s dominator-check implementation is exactly
   the kind of subtle-bug-prone code that property is meant to catch (§6 Risk #3).

---

## 7b. Implementation Summary — the three unbuilt items (2026-08-20)

This pass closed the three items §7 left open: the Python mirror (Task 7b), the
`WorkflowValidatorService` (Task 8) and the Prisma rule model (Tasks 3/3b).

### The rule model was HALF-APPLIED on `feat/loop`, not missing

The most important finding of this pass. `feat/loop` already carried the rule model's
**schema half** — `workflow-invariant-rule.prisma`, the `WorkflowRuleSeverity` /
`WorkflowRulePredicateType` enums in `enums.prisma`, the `ResourceType` value in
`audit.prisma` AND `packages/domains/src/enums/generated/ResourceType.ts`, the migration
`20260820040427_task_716_workflow_invariant_rule`, both `tenant-scope.ts` allow-lists
(`TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`, with a comment already describing
`findApplicable()`'s two-read shape), the `CoreDatabaseModule` provider/export registration,
and all five domain **barrel** lines.

What it did NOT carry were the seven files those barrels and that module import:

```
src/enums/generated/WorkflowRuleSeverity.ts
src/enums/generated/WorkflowRulePredicateType.ts
src/models/generated/core/WorkflowInvariantRuleModel.ts
src/entities/generated/core/WorkflowInvariantRuleEntity.ts
src/factories/generated/core/WorkflowInvariantRuleFactory.ts
src/mappers/generated/core/WorkflowInvariantRuleEntityMapper.ts
src/repositories/generated/core/WorkflowInvariantRuleRepository.ts
```

**Consequence: `@arcaai/domains` did not compile on `feat/loop`** — 8 `TS2307` errors, every
one a barrel or module importing a file that was never committed. This pass authored the
seven files, which took that count to zero. The migration was re-verified end to end against
a throwaway shadow DB (created and dropped; the dev DB was never touched) and
`prisma migrate diff` printed `-- This is an empty migration.`

The model file was produced by `pnpm gen:model` (the only sanctioned scaffolder); the entity,
factory, mapper and repository were hand-authored per rule 03. `pnpm gen:mapper` was NOT run.
The mapper carries `FIELDS_NOT_WRITABLE = ['version']` — `WorkflowInvariantRule` is OCC-written
by the Task 9 admin PATCH route, so the strip is load-bearing.

`WorkflowInvariantRuleRepository` adds the two methods the ticket specified:
`findApplicable(tenantId, paletteKey)` (two explicit-`tenantId` reads — own tenant then SYSTEM
— mirroring `PipelinePolicyRepository.findSystemDefault`, with `paletteKey: null` rows always
in scope) and `findMaxRuleVersion`.

### Task 8 — `WorkflowValidatorService`, and why it has no port

`packages/applications/src/services/workflow-validator/`: `workflow-validator.service.ts`,
`rule-merge.ts`, `workflow-validator.service.module.ts`, `index.ts`, `__tests__/`.

The ticket's Task 8 specified an `IWorkflowValidatorService` symbol token. **That port is
deliberately not re-introduced**, because TASK-734 removed it on purpose — see
`IWorkflowDefinitionService.ts`'s own header: *"this service calls
`@arcaai/workflow-contract`'s `validate`/`compile` directly rather than through a speculative
port nothing else consumes."* The concrete class is provided and exported instead, the shape
`SttPipelineCompilerService` / `SttPipelineResolverService` already use in the sibling module.

The service owns exactly the impure half the pure engine cannot: loading rule ROWS, merging
them, and computing `ruleSetVersion`. It deliberately does **not** persist the report or
broadcast a sys-event — `WorkflowDefinitionService` already owns the definition lifecycle and
does both, and a second writer would double-broadcast `ResourceUpdated` on every validate.

Three behaviours worth naming:

- **Totality is the contract** (§3.5). A repository throw, a `predicateType` the code-owned
  catalogue does not have, or an evaluator failure each resolve to a synthetic `WF-INTERNAL`
  ERROR finding with `ok: false`. Nothing resolves to `ok: true`, and nothing throws.
- **An empty rule table falls back to the bundled DRAFT catalogue**, stamped
  `ruleSetVersion: 0`. Returning an empty rule set on an unseeded database would make every
  graph validate clean — a total, silent loss of the safety boundary that looks like success.
- **`mergeRuleSets` enforces one-way strictness** (`rule-merge.ts`, pure + separately tested):
  a tenant row may ADD a rule and may RAISE a SYSTEM rule's severity, but may never lower one
  and never redefine what a SYSTEM rule CHECKS — an emptied `predicateConfig` would otherwise
  be a disabled rule wearing an ERROR badge.

### Task 7b — the Python mirror

`packages/py-workflow-contract` (`hope_workflow_contract`): pydantic models for
`CompiledWorkflowConfig` and every child, `verify_checksum()`, a `formatVersion` guard that
raises on an unknown version, `py.typed`, and `tests/test_parity.py`. Consumer half only — no
compiler, no validator; Python never authors a workflow. The root `pyproject.toml` needed no
edit: `packages/py-workflow-contract` was ALREADY a committed `[tool.uv.workspace]` member
(line 53) and `uv.lock` already carried a full `hope-workflow-contract` entry — a fifth
half-applied change, source never committed. `uv lock --offline` re-resolved with a zero diff.

Two mirroring choices are deliberate and are pinned by an exact round-trip assertion:
`compiledAt` stays `str` (a `datetime` round-trip rewrites `…T00:00:00.000Z` → `…T00:00:00Z`),
and the two `retry` numbers are `int | float`, not `float` (`float` turns the wire's `1` into
`1.0`, so canonical JSON emits `"1.0"` where JS emits `"1"` — every real config would fail
verification).

### Contract-staleness notes (the ticket is now out of date in five places)

1. §2.3 says the node registry lives in `packages/applications/src/services/workflow-registry/`.
   It does not; it is `packages/workflow-contract/src/node-registry.ts`.
2. §2.3 says TASK-715 hands over an `IWorkflowValidatorService` port + stub. It never existed,
   and TASK-734 decided against it (above).
3. Task 8's "replaces the stub provider binding" is therefore not applicable.
4. `WorkflowGraphNode` now has a real `position` field and `WorkflowNodeDescriptor` a
   `configSchema` (`node-config-schemas.ts`). Neither affects the Python mirror or
   `compiled-config.schema.json`: `position` is presentational canvas state on the GRAPH, and
   the compiled config — the only thing Python consumes — never carries it. Verified field-for-
   field; the schema needed no change.
5. Task 3's text says `WorkflowInvariantRule` is "not added to `SYSTEM_SHARED_READ_MODELS`".
   The committed schema header explicitly reverses that, with reasoning, and the allow-list
   entry is present. The committed decision is the correct one and is what the repository
   implements.

### Verification (actual output)

| Gate | Result |
|---|---|
| `@arcaai/domains` typecheck | **8 errors → 0** |
| `@arcaai/domains` build (`tsc`) | clean |
| `@arcaai/domains` test | **1831 passed**, 2 skipped, 9 todo (153 files) |
| New `WorkflowInvariantRuleRepository.test.ts` | 6/6; mutation-checked (removing the SYSTEM union fails 2 tests) |
| `@arcaai/applications` `workflow-validator` tests | 13/13 (6 rule-merge + 7 service), both RED-first |
| `@arcaai/applications` test (whole package) | 4807 passed / 17 failed — **baseline without this change is 4794 passed / 17 failed**, i.e. +13 and zero regressions |
| `pnpm gen:factory:check` | no drift, schema coverage OK |
| `pnpm gen:entity:check` | no drift (100 files match, incl. the new entity) |
| Migration | replayed onto throwaway `hope_shadow`; `migrate diff` → `-- This is an empty migration.` |
| `packages/py-workflow-contract` | **57 passed**; ruff clean; mypy --strict clean |
| Lint (`domains`, `applications`) | 0 errors; **0 warnings attributable to the new files** |

### Pre-existing breakage on `feat/loop` found while verifying (NOT introduced here, NOT fixed here)

Each is another half-applied change, independent of TASK-716. They are why the aggregate gates
are red today, and they are left alone deliberately — completing another ticket's schema change
blind is the failure mode this pass exists to correct, not to repeat.

| # | Breakage | Evidence |
|---|---|---|
| 1 | **`@arcaai/applications` does not build.** `src/common/phi-audit-scrub` and `src/services/workflow-exposure/cloud-provider-guard` are imported but were NEVER committed (`git ls-files` → 0 hits) | 3 × `TS2307` |
| 2 | The same missing `phi-audit-scrub` fails **231 applications test FILES** (107 resolution errors) — identical with and without this change | baseline run above |
| 3 | **TASK-721's fixture encryption is half-applied.** Schema + migration `20260820043053_task_721_…encrypt_input` dropped `input` for `encryptedInput`/`keyVersion`, but `WorkflowTestFixtureModel`/`Entity` still carry `input` and no `WorkflowTestFixtureRepository.encryption.ts` exists. This fails `pnpm gen:model:check` and `pnpm gen:entity:check` (schema-coverage) on `feat/loop` today. Proven pre-existing: with this pass's files stashed, the same one file drifts | `gen:*:check` output |
| 4 | A stale editable install in conda `arcaenv` (`__editable__.hope_workflow_contract-0.1.0.pth`) points at the MAIN checkout, where no source exists, so `import hope_workflow_contract` yields an empty namespace package (`__file__ is None`). The documented `pnpm`/`conda run` invocation will fail until it is refreshed; a permanent test (`test_the_module_under_test_is_the_one_next_to_this_test`) now fails loudly instead of passing against the wrong tree | verified both ways |
| 5 | `apps/harness/.../interpreter/compiled_config.py` is a THIRD implementation of the canonicalizer, self-described as "validated-in-principle, not proven-in-practice". It was run against the real fixture and DOES reproduce the TS digest — no bug, but it should import `hope_workflow_contract` now that the package exists | follow-up |

### Still open (Tasks 9–12)

Rule-set CRUD service + controller with the `// AUTH-NOTE:` privilege split (Task 9), the
re-validation → `NEEDS_REVIEW` sweep (Task 10), the platform rule-set seed (Task 11) and E2E
(Task 12). Also still open, and unchanged by this pass: `contracts/rule-model.md` remains
**DRAFT and not clinically reviewed** — `WorkflowValidatorService` is wired to resolve rules
from the database, but nothing seeds those rows yet, so it currently evaluates the bundled
DRAFT catalogue via the documented fallback and is not an enforcing gate. And the one seam
deliberately left unwired: `WorkflowDefinitionService.validateGraph` still calls the pure
`validate()` with its hardcoded `RULE_SET_VERSION = 1`. Switching it to the DB-backed service
turns unreviewed rules into a live publish gate, which is precisely the line §7 drew — that
wiring wants the clinical review and an owner decision first, not a silent swap.

---

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-31 | **Task 1's normative machine artifact moved into the package that produces it.** `contracts/compiled-config.schema.json` now lives at `packages/workflow-contract/schemas/compiled-config.schema.json`, and the docs copy is DELETED rather than kept alongside it — two byte-identical copies of what this ticket's own code comments call "the single normative machine artifact" is a silent-drift hazard with no gate behind it. Every reference in CODE was repointed: `compiler.ts`, `__tests__/compiled-config-schema.test.ts`, `py-workflow-contract`'s `compiled_config.py` / `tests/test_parity.py` / `README.md` / `pyproject.toml`, and the harness interpreter's `compiled_config.py`. `contracts/README.md` (normative prose) and `contracts/rule-model.md` (still DRAFT / human-gated) did NOT move and are byte-unchanged — only the machine artifact did, so this ticket's `contracts/` folder still exists. Older entries in this table, and TASK-718/720/731's READMEs, still cite the old path; they are dated records of where the file was and are deliberately left as written. Gates re-run after the move: `@arcaai/workflow-contract` 1037/1037, harness interpreter parity 34/34, `py-workflow-contract` 60/60. | execution agent |
| 2026-08-20 | **All three formerly-unbuilt items built: Python mirror, `WorkflowValidatorService`, Prisma rule model — and the rule model turned out to be HALF-APPLIED, not missing.** `feat/loop` already carried the rule model's entire schema half (prisma model, both enums, `ResourceType` in audit.prisma AND the domain enum, migration `20260820040427_task_716_workflow_invariant_rule`, both `tenant-scope.ts` allow-lists, the `CoreDatabaseModule` registration, and all five domain barrel lines) but NOT the seven domain files those barrels import — so **`@arcaai/domains` did not compile** (8 × TS2307). Authored the seven (`gen:model` for the model; entity/factory/mapper/repository hand-authored per rule 03; `gen:mapper` NOT run; mapper carries the `FIELDS_NOT_WRITABLE = ['version']` OCC strip), taking domains to 0 errors, `tsc` clean and **1831 tests green**. Repository adds `findApplicable` (two explicit-`tenantId` reads, own → SYSTEM, palette-agnostic rows always in scope) + `findMaxRuleVersion`, with 6 tests mutation-checked. Migration re-verified on a throwaway shadow DB (dev DB untouched): `migrate diff` → `-- This is an empty migration.` **Task 8** added `packages/applications/src/services/workflow-validator/` — DB-backed rule resolution, the pure one-way-strictness `mergeRuleSets` (a tenant may add a rule or raise a SYSTEM rule's severity, never lower one or redefine what it checks), `ruleSetVersion` = merged max, total-by-contract (repository throw / unknown predicate kind → synthetic `WF-INTERNAL` + `ok: false`, never `ok: true`, never a throw), and an unseeded-table fallback to the bundled catalogue at `ruleSetVersion: 0` so an empty rule table cannot silently pass every graph; 13 tests, both files RED-first. **No `IWorkflowValidatorService` port** — TASK-734 removed it deliberately and re-adding it would restore the "speculative port nothing else consumes" it deleted. **Task 7b** added `packages/py-workflow-contract` (consumer half only: pydantic models, `verify_checksum`, raising `formatVersion` guard), 57 tests + ruff + mypy --strict clean, checksum pinned against a real TS-produced fixture; `compiledAt: str` and `retry: int \| float` are deliberate (a `float` makes the wire's `1` serialize as `"1.0"` vs JS `"1"` and every config fails verification). Root `pyproject.toml`/`uv.lock` needed no edit — the workspace member was already committed with no source. Ticket found STALE in 5 places (registry path, the never-existing port, and `SYSTEM_SHARED_READ_MODELS`); `position`/`configSchema` confirmed NOT to affect the compiled-config contract. Also FOUND, NOT FIXED (pre-existing, proven by a stashed baseline run — applications is 4794→4807 passed with zero new failures): `@arcaai/applications` does not build (`phi-audit-scrub`, `cloud-provider-guard` never committed, failing 231 test files), TASK-721's fixture encryption is half-applied and fails two `gen:*:check` gates, a stale conda editable install resolves `hope_workflow_contract` to the main checkout, and the harness holds a third canonicalizer copy. Tasks 9–12 remain; `rule-model.md` is still DRAFT/unreviewed and the validator is deliberately NOT yet wired into `WorkflowDefinitionService`'s publish gate. | execution agent |
| 2026-08-19 | **Status-only correction, no code changed.** A repo spot-check found the Status row still read "Partial... Phases B, D not started," stale against the same-day entry below documenting a live, gateway-verified publish. Status row reworded to Review. | doc-audit pass |
| 2026-08-19 | **`core.start`/`core.end` registered — the four palette-agnostic structural rules this ticket authored became satisfiable for the first time.** `WF-S-002/003/004/007` carry `paletteKey: null` and are written against literal `core.start`/`core.end` node types; `validate()`'s filter only skips a rule whose palette is SET and differs, so they applied to every graph in every palette while no palette registered either type. Consequence, measured: the platform's own seeded `platform-default-summarization` graph — a `PUBLISHED` row written straight to the database by the seed, never through the validator — scored 17 errors when re-submitted through `POST admin/workflow-definitions`, and nothing was publishable in any palette. Fix, in three parts: (1) both types added to `WORKFLOW_NODE_REGISTRY` and `registry.py` as `boundary`-classed markers with real `interpreter.core_start`/`interpreter.core_end` activities (markers execute nothing, but `compile()` refuses any graph containing an unimplemented type, so a non-dispatchable marker would have blocked publishing for a different reason); (2) `REACHABLE_FROM_ENTRY`/`REACHES_TERMINAL` now exempt `boundary`-classed nodes — without this the bookends and a palette's OWN entry/terminal rules are mutually unsatisfiable, since `core.start` is by construction not reachable from `consultation.consentGate` and `core.end` does not reach `consultation.hitlGate`; the exemption suppresses only unreachable/dead-end REPORTING for a marker, and a WORK node in either position still trips `WF-CONS-002`/`WF-CONS-004` (both cases tested); (3) the `mandatory` class declared on the nodes each palette's own contract already calls mandatory (4 summarization, 3 stt, 6 consultation) — `WF-S-007` selects `throughClass: 'mandatory'`, so with no node carrying it the cut-set is empty and every `core.start → core.end` path reads as unguarded. Verified end to end against live infra: a summarization definition now goes create → `ok: true` → **`PUBLISHED`, `isActive: true`**, the first workflow definition ever published through this path. Consultation validates clean in-process; through the gateway it is still refused at compile by `consultation.hitlGate` (`implemented: false`, pending the interpreter's durable-wait extension) — a separate, pre-existing gap. New gate: `__tests__/palette-canonical-graphs.test.ts` runs each palette's canonical graph through the real `validate()` with the default merged rule set — the whole-graph check the per-rule golden suite structurally cannot be, and the one that would have caught this. `packages/workflow-contract` 249/249, harness 1447/1447, ruff + mypy clean. | execution agent |
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 1 substrate foundations) |
| 2026-08-16 | Phase C (pure engine) built: new `packages/workflow-contract` (graph model/algorithms, 11-predicate catalogue, compiler, canonical JSON, DRAFT rule catalogue, pure `validate()`), 125 tests green, 0 runtime deps. Tasks 1–2 contract docs authored (`contracts/compiled-config.schema.json` + `README.md` + `rule-model.md`, the latter explicitly DRAFT/HUMAN-GATED). NOT wired anywhere; Phases B and D (Tasks 3, 3b, 8–12) and the Python mirror (Task 7b) deferred — TASK-715's node registry (Phases B–F) doesn't exist yet and local infra is down. See §7 for full detail, scope cuts, and honest acceptance-criteria status. Status set to Partial. | execution agent |
