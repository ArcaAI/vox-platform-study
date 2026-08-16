# ValidationReport contract (TASK-719 Task 3)

Re-derived against the live tree on `feat/loop` at commit `718533453` (2026-08-16).

## Verdict: the SHAPE is delivered; the WIRING and the RULE SET are not

Unlike the registry and the definition API, this contract has real, cited source: the pure
engine package `@arcaai/workflow-contract` (TASK-716 Phase C, "built and green" per that
ticket's own status line) ships the exact type this ticket needs.

## The shape

`packages/workflow-contract/src/report.ts:29-35`:

```ts
export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';
export type WorkflowRuleClass = 'structural' | 'invariant' | 'schema';

export interface WorkflowFinding {
  ruleId: string;                    // e.g. 'WF-S-001' | 'WF-I-006' | 'WF-C-004' | 'WF-INTERNAL'
  ruleClass: WorkflowRuleClass;
  severity: WorkflowFindingSeverity;
  nodeId: string | null;             // null = graph-level finding, not attributable to one node
  edgeId?: string;
  path?: string;                     // JSON pointer into the node's config
  message: string;
  registerRefs?: readonly string[];  // INV-xxx ids from 01-invariant-register.md
}

export interface WorkflowValidationReport {
  reportVersion: 1;
  ok: boolean;                       // true iff no ERROR-severity findings — see below
  findings: WorkflowFinding[];
  ruleSetVersion: number;
  registryChecksum: string;
  evaluatedAt: string;               // ISO datetime
}
```

Everything the ticket's Task 14 (validation rail) needs is present:

| Need (README §4 Task 14 / §1 part 4) | Field |
|---|---|
| Severity levels | `WorkflowFinding.severity: 'ERROR' \| 'WARNING'` (`report.ts:12`) |
| The node (or edge) each problem points at | `nodeId: string \| null` + optional `edgeId` (`report.ts:19-20`) |
| Rule class | `ruleClass: 'structural' \| 'invariant' \| 'schema'` (`report.ts:13`) |
| Stable rule id for a help link | `ruleId: string` (`report.ts:18`) — the doc comment gives the id grammar: `WF-S-*` structural, `WF-I-*` invariant, `WF-C-*` schema/config, `WF-INTERNAL` reserved |
| Publish-blocking predicate | `hasBlockingFindings(findings)` (`report.ts:38-40`) — "`true` iff any finding is ERROR-severity — the sole publish-blocking predicate"; `WorkflowValidationReport.ok` is **derived from this, never set independently** (`buildValidationReport`, `report.ts:44-56`) |

The publish-gate rule for Task 15 / the acceptance-criteria line "Publish is disabled until the
**server** `ValidationReport` is clean" therefore maps to one field: `report.ok === true`. The
Studio never re-derives `ok` from `findings` itself — it reads the field the server already
computed, so a future server-side change to the blocking predicate (e.g. a new severity tier)
cannot silently desync from a client-side reimplementation. This is the same rationale as
`jsonSchemaValueProblems` not being reimplemented (README §3.1 pitfall 1 / knowledge §2.4).

## The internal-error convention (needed for "never silently ok")

`internalErrorFinding(ruleId, ruleClass, error)` (`report.ts:65-77`) is what an orchestrator
emits when a rule evaluator throws — `ruleId: 'WF-INTERNAL'`, `severity: 'ERROR'`, `nodeId:
null`. The validation rail's "grouped by severity then node" rendering (README Task 14
approach) therefore needs a graph-level bucket (`nodeId === null`) distinct from per-node
groups — `WF-INTERNAL` and `WF-SHAPE` (the shape-check ruleId used by `validate()` when
`workflowGraphProblems` fails, `packages/workflow-contract/src/validate.ts:35-41`) both land
there.

## What is NOT wired — the rule set is DRAFT, and there is no server endpoint

Two separate gaps, both explicit in the delivered code itself, not inferred:

1. **No application-layer caller.** `validate.ts:1-8` states outright: "NOT wired to anything
   in the application layer in this session." There is no `WorkflowValidatorService`, no
   `POST admin/workflow-definitions/:id/validate` controller route (confirmed absent — see
   `definition-api.contract.md`). A `WorkflowValidationReport` cannot be obtained from a live
   server today, gated or otherwise.
2. **The rule set itself is DRAFT and not clinician-reviewed.** `packages/workflow-contract/src/index.ts:9-13`:
   > "IMPORTANT — rule-set status: the rule INSTANCES exported from `./rule-catalogue` are a
   > DRAFT… and NOT YET clinician-reviewed… The ENGINE… is mechanism, not policy, and is safe
   > to build against; the *specific 22 rules* are safe to TEST against but must not be
   > presented as a validated safety boundary or wired as an enforcing gate until that review
   > completes."

   This matches the orchestrator's own framing of TASK-716 for this session ("whose RULE SET
   is marked DRAFT and is NOT clinician-reviewed"). Consequence for Studio v1: the validation
   rail, publish gate, and every fixture used in this ticket's tests treat
   `WorkflowValidationReport` as **an interface to build the UI against**, not as a live safety
   verdict — no code in this ticket presents draft-rule-set output to a tenant admin as
   authoritative, because no code in this ticket can reach a live validator at all (gap 1). The
   distinction matters for the day Phase B/D ship: at that point the *shape* (this contract)
   does not need to change, but the *rule set* still needs the clinical review before its
   output is trustworthy — that review is out of scope for both TASK-716 and this ticket.

## Consequence for Studio v1's build order

Task 14 (validation rail) and Task 9 (inspector field-level errors) are built and unit-tested
against **fixture** `WorkflowValidationReport` values constructed directly from the delivered
`WorkflowFinding`/`WorkflowValidationReport` types (imported as dev-time type references — the
Studio does not take a runtime dependency on `@arcaai/workflow-contract`, since that package is
architecturally the server-validator's engine, not a browser artifact; the console only needs
the *shape*, which is why this contract file exists in prose rather than as a shared import).
This is safe to do now and will not need to change when Phase B/D land, because the shape is
already real, delivered, `file:line`-cited code — only the live round trip is gated.
