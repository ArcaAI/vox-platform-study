# `compiledConfig` contract — the interpreter's input contract

**Status:** DRAFT engine artifact, mechanism-reviewed only. This is TASK-716's shipped
`compiled-config.schema.json` per TASK-718's own risk R-7 ("if TASK-716 has already shipped a
different shape when this starts, Task 1 becomes a reconciliation, not an invention"). It has
**not** yet been reviewed by the TASK-718 author (that review is a coordination gate, not
performed in this session — see the ticket README §5 checkbox). It is a stable, versioned
contract (`formatVersion`), so building against it is safe; treat the field list as reviewed-
pending, not final.

## What this is

`compiledConfig` is what `@arcaai/workflow-contract`'s compiler (`compiler.ts`) produces from a
server-validated `WorkflowGraph`, and what the Python interpreter (TASK-718,
`hope_workflow_contract`) consumes. It is stored on `WorkflowDefinition.compiledConfig`
(TASK-715), stamped only at publish, and is never accepted from a client request — the graph is
untrusted input; the compiled config is a server-produced artifact.

The schema lives at [`compiled-config.schema.json`](./compiled-config.schema.json), JSON Schema
draft 2020-12. `packages/workflow-contract/src/__tests__/compiler.test.ts` asserts a compiled
example validates against it.

## Normative rules (binding on every consumer, in both languages)

1. **There is no node type that can write `SIGNED`.** The format has no such field anywhere in
   the schema. Approval remains `approveSummary`, outside the substrate entirely (TASK-716
   §2.7). A node whose `type` implies signing is rejected by the validator's `WF-S-006`
   (`FORBIDDEN_NODE_TYPE`) before compilation is ever reached.
2. **`onTimeout` on a gate may never be a value that means "approved".** INV-001, INV-147,
   INV-181. The schema encodes a mechanical tripwire (`not: { const: "APPROVED" }`); it is not
   a substitute for a human check that the actual enum contains no synonym for approval
   (`AUTO_APPROVE`, `GRANTED`, …) — check this explicitly whenever the gate-type enum grows.
3. **Consumers MUST refuse an unknown `formatVersion` rather than best-effort parse.** This
   package (and its Python mirror, `hope_workflow_contract`) raise/throw on any
   `formatVersion !== 1`. The precedent is `UsageOutboxPayload.version`
   (`packages/applications/src/services/usageLedger/dto/usage-outbox.payload.ts:18-22`).
4. **Consumers MUST verify `checksum` before executing.** `checksum` is sha256 over
   `canonicalJson` (key-sorted, array-order-preserved — `department-agent.prisma:177-180`) of
   every field except `checksum` itself. A verified mismatch means the stored document was
   tampered with or corrupted between compile and execution, not a warning to log and
   continue.

## Shape summary

| Field | Meaning |
|---|---|
| `stages[]` | Topological LEVELS (not a flat list) — nodes within one stage have no dependency on each other and MAY run concurrently (INV-044/INV-108, "independent tasks must continue"). |
| `stages[].nodes[].activity` | A closed set drawn from `apps/harness/src/harness/temporal/activities.py`'s `@activity.defn` names (TASK-716 §2.7). |
| `stages[].nodes[].timeoutSeconds` / `retry` | Already clamped to `caps` at compile time — the interpreter never re-derives a cap from config. |
| `stages[].nodes[].onError` | `"fail"` or `"degrade"` — `"degrade"` produces a MARKED nothing and continues (INV-019, INV-205); a node never silently produces an empty, unmarked result. |
| `stages[].nodes[].emitsTrajectory` | Always `true` for activity nodes (INV-084) — provenance emission is not tenant-disableable, so the schema pins it with `const: true` rather than leaving it optional. |
| `gates[]` | Gate nodes lifted OUT of the stage list so the interpreter can find them without walking the graph, and so "nothing routes around a gate" is checkable against the compiled artifact as well as the source graph. |
| `policyBindings` | Everything the interpreter must resolve but must NOT re-derive from the graph (guardrail profile, redaction rule set, prompt template pins, context schema version, entitlement keys). |
| `caps` | Platform ceilings materialized at compile time — "tenants tighten, never exceed" (design.md Plane 1) is applied HERE, not read again at runtime. |

## Cross-language duplication this contract exists to stop

TASK-716 §2.8 records that the repo's three existing cross-language wire surfaces are each
defined twice, independently, and that a prior three-way duplication of one clinical validation
rule "drift[ed], and the drift [was] silent in both directions"
(`packages/json-schema-subset/README.md`). This schema is the single normative artifact both
`@arcaai/workflow-contract` (TypeScript, authoring/compiling) and `hope_workflow_contract`
(Python, consuming) validate their own type surface against in a parity test
(`packages/py-workflow-contract/tests/test_parity.py` — Task 7b, gated in this session; see the
ticket README §7). **The parity test is load-bearing, not a nice-to-have** — if it is ever
skipped, the format has three implementations again (§6 Risk #5).

## DRAFT status of this document

This README and the schema it describes are the **mechanism**, and the mechanism is stable
regardless of the outcome of clinical review on the rule *set* (see
[`rule-model.md`](./rule-model.md), which is explicitly DRAFT pending clinician review). Nothing
in this schema depends on which 22 rules are correct — it depends only on the shape a compiled
graph takes, which is an engineering decision, not a clinical-safety one.
