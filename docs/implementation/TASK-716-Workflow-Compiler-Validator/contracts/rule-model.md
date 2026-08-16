# Workflow rule model + initial rule set

## STATUS: DRAFT — NOT CLINICALLY REVIEWED. HUMAN-GATED. DO NOT TREAT AS A VALIDATED SAFETY BOUNDARY.

This document and the rule instances it describes (`packages/workflow-contract/src/rule-catalogue.ts`,
`DRAFT_SUMMARIZATION_RULE_SET`) were authored by an engineering pass over
[`01-invariant-register.md`](../../../architecture/consultation-session-workflow/assessment/01-invariant-register.md)
in this session. **No clinician has reviewed this table.** TASK-716 §6 Risk #1 states this
explicitly and requires the review before Phase C build starts; this session built Phase C
(the engine) anyway, on the parent task's explicit instruction to build the mechanism and mark
the rule set DRAFT rather than block entirely on an unavailable clinical reviewer. **The
mechanism (predicate evaluators, graph algorithms, compiler) is safe to build against and is
fully tested. The specific 17 rule PARAMETERIZATIONS below are not.**

Nothing in `@arcaai/workflow-contract`'s public API, and no application service in this repo,
treats this rule set as a publish-blocking gate. Wiring it behind `WorkflowValidatorService`
is TASK-716 Task 8 — gated in this session on TASK-715's node registry (Phases B–F) not
existing yet (see the ticket README §7).

### Reviewer sign-off (fill in before Phase C is treated as "shippable policy")

| Reviewed by | Role | Date | Outcome |
|---|---|---|---|
| _(pending)_ | Clinical reviewer | | |
| _(pending)_ | Architecture reviewer | | |

---

## 1. The predicate catalogue (code)

The closed set of predicate KINDS a rule instance may reference. Defined in
`packages/workflow-contract/src/predicates/`; `WORKFLOW_RULE_PREDICATE_TYPES` in
`predicates/index.ts` is the single source of truth (a test in that package asserts its length
stays 11 — adding a 12th kind is a deliberate deploy, not a data change, per TASK-716 §3.3).

| Predicate | Meaning | Config shape |
|---|---|---|
| `ACYCLIC` | The graph is a DAG. | `{}` |
| `SINGLE_ENTRY` | Exactly one node of the configured entry type. | `{ entryType }` |
| `REACHABLE_FROM_ENTRY` | Every node reachable from the entry. | `{ entryType }` |
| `REACHES_TERMINAL` | Every node reaches some terminal node. | `{ terminalType }` |
| `REQUIRED_NODE_TYPE` | At least N nodes of a type/class are present. | `{ nodeType? \| nodeClass?, minCount }` |
| `FORBIDDEN_NODE_TYPE` | No node of a type/class is present. | `{ nodeType? \| nodeClass? }` |
| `REQUIRED_PATH_THROUGH` | Every path from A to B passes through C (dominator check, not path enumeration). | `{ fromType?/fromClass?, toType?/toClass?, throughType?/throughClass? }` |
| `FORBIDDEN_PATH` | No path exists from A to B. | `{ fromType?/fromClass?, toType?/toClass? }` |
| `ORDERED_BEFORE` | No path from an "after" node back to a "before" node — see the semantic caveat below. | `{ beforeType?/beforeClass?, afterType?/afterClass? }` |
| `BOUND` | A graph-level count/depth bound. | `{ maxNodes?, maxEdges?, maxDepth? }` |
| `CONFIG_PREDICATE` | A node's config field satisfies a comparison. | `{ appliesTo: { nodeType? \| nodeClass? }, field, op, value? }`, `op ∈ { lte, gte, eq, in, present }` |

### Open questions for the reviewer

1. **`ORDERED_BEFORE` semantic** (`predicates/shape.ts` docstring): this predicate forbids an
   order INVERSION (a path from the "after" class back to the "before" class). It does **not**
   by itself require that a "before" node exist on every path to an "after" node — that is a
   `REQUIRED_PATH_THROUGH` concern. `WF-I-007` below uses `ORDERED_BEFORE` alone, which means
   a graph with NO consent gate at all currently passes `WF-I-007` (nothing to invert). If the
   register's INV-003/INV-004/INV-067 require mandatory presence, `WF-I-007` needs a paired
   `REQUIRED_PATH_THROUGH` rule — flagged rather than silently assumed either way.
2. **`CONFIG_PREDICATE`'s five ops have no "not-equal"/"absent-or-equals" combinator.** Rules
   `WF-I-004` and `WF-I-009` therefore require an EXPLICIT config declaration rather than
   tolerating silent absence with a safe default (see their per-rule notes below). A reviewer
   may prefer either a sixth op or a registry-level default instead.
3. **Register-row coverage is deliberately partial.** 17 rules against a 449-row register — the
   register's own metrics show `hitl-authority`, `labeling-transparency` and `consent-abac` as
   its largest categories, and most of their rows are RUNTIME obligations no authoring-time
   graph rule can express. This is not "17-of-449 coverage of the safety surface"; it is the
   authoring-time-expressible subset this engine can own (TASK-716 §6 Risk #2, restated here).

---

## 2. Rule set — Summarization palette, structural + invariant classes only

**Scope note:** the ticket's own draft (README §4 Task 6) enumerates 23 rows across its three
tables (7 structural + 10 invariant + 6 schema) while its prose says "22 rules ⇒ 44 fixtures" —
those two numbers in the ticket text disagree with each other; this document does not attempt
to resolve which the ticket author intended and instead states, precisely, what THIS session
implemented: **17 rules** (7 structural + 10 invariant), each with a passing and a failing
graph fixture (34 fixtures) in `packages/workflow-contract/src/__tests__/golden/<ruleId>/`.

The six `schema`-class rules (`WF-C-001` through `WF-C-006`) are **not implemented in this
package** and are listed separately in §3 as deferred — each needs either the code-owned node
registry (TASK-715 Phases B–F, not built as of this session) or repository/entitlement I/O
that is deliberately impure (TASK-716 §3.2).

A markdown-table parity test (`packages/workflow-contract/src/__tests__/golden.test.ts`)
asserts the fixture directory set equals `DRAFT_SUMMARIZATION_RULE_SET`'s rule-id set — it does
NOT (yet) parse this file's table; that stronger parity (code ⇄ this markdown document) is
listed as not-yet-built in the ticket README §7.

### Structural (palette-independent)

| Rule | Predicate | Statement | Register refs | Notes |
|---|---|---|---|---|
| `WF-S-001` | `ACYCLIC` | The graph is a DAG. | — | |
| `WF-S-002` | `SINGLE_ENTRY` | Exactly one `core.start`. | — | |
| `WF-S-003` | `REACHABLE_FROM_ENTRY` | Every node is reachable from the entry. | — | |
| `WF-S-004` | `REACHES_TERMINAL` | Every node reaches a `core.end`; no dead ends. | — | |
| `WF-S-005` | `BOUND` | ≤ 256 nodes, ≤ 1024 edges, depth ≤ 64. | — | |
| `WF-S-006` | `FORBIDDEN_NODE_TYPE` | No node may write a signed state — the substrate has no signing node. | INV-159, INV-179, INV-186 | |
| `WF-S-007` | `REQUIRED_PATH_THROUGH` | Every path to a terminal passes through every `mandatory`-class node — nothing routes around a gate. | INV-137, INV-155 | |

### Invariant (Summarization palette)

| Rule | Predicate | Statement | Register refs | Notes |
|---|---|---|---|---|
| `WF-I-001` | `REQUIRED_PATH_THROUGH` | Every path from a PHI-bearing node to external egress passes through a redaction node. | INV-026, INV-136 | |
| `WF-I-002` | `CONFIG_PREDICATE` | Every generation node declares `onError`. | INV-019, INV-126, INV-205 | **Simplified**: the full invariant also requires a marked-output binding when `onError: "degrade"` — not encoded; see §1 open question 2's op-catalogue limit. |
| `WF-I-003` | `REQUIRED_NODE_TYPE` | At least one draft/unsigned-labeled node exists (severity `WARNING`). | INV-030, INV-131, INV-148, INV-182 | **Simplified**: presence-only; the full invariant requires EVERY artifact-producing terminal path to end at one. |
| `WF-I-004` | `CONFIG_PREDICATE` | Every activity node explicitly declares `emitsTrajectory: true`. | INV-054, INV-160, INV-217 | **Strictness choice**: requires explicit declaration (see §1 open question 2) — the compiler (`compiler.ts`) independently forces `emitsTrajectory: true` on every compiled node regardless of this rule, so this authoring-time rule is defense-in-depth, not the only guarantee. |
| `WF-I-005` | `REQUIRED_PATH_THROUGH` | A generation node's output may not reach a code-binding node except through a tool-verification node. | INV-065, INV-066, INV-231 | |
| `WF-I-006` | `FORBIDDEN_PATH` | No path from a PHI-bearing node to a style/DNA-writing node. | INV-017, INV-080, INV-095, INV-165 | |
| `WF-I-007` | `ORDERED_BEFORE` | A consent/authorization gate never appears downstream of retrieval/generation. | INV-003, INV-004, INV-067 | **See §1 open question 1** — order-inversion only, not presence. |
| `WF-I-008` | `CONFIG_PREDICATE` | Any external-commit-class node declares an idempotency-key source. | INV-157, INV-158 | |
| `WF-I-009` | `CONFIG_PREDICATE` | A cloud-provider-routing node resolves provider selection fail-closed (`"fail-closed"` literal). | INV-067 | Same op-catalogue limit as `WF-I-004`. |
| `WF-I-010` | `CONFIG_PREDICATE` | Per-node `retry.maximumAttempts` ≤ the platform cap (5). | INV-069, INV-074 | **Simplified**: the companion `timeoutSeconds ≤ caps.maxNodeSeconds` check is a distinct `CONFIG_PREDICATE` row, not enumerated as its own rule id here. |

---

## 3. Deferred — schema-class rules (not implemented in this package)

| Rule | Statement | Why deferred |
|---|---|---|
| `WF-C-001` | Every node's `config` satisfies its registry `configSchema`. | Needs the code-owned registry's `configSchema` per node type (TASK-715, not built) **and** `jsonSchemaValueProblems` from `@arcaai/json-schema-subset` — importing it would give this package a runtime dependency, contradicting the ticket's own acceptance criterion that it stay dependency-free. Implement in the impure service (Task 8), which may depend on both. |
| `WF-C-002` | Every node type is registered; every port is declared. | Needs the registry (not built). |
| `WF-C-003` | Every edge endpoint exists and port primitives are compatible. | Needs `CONTEXT_PRIMITIVES` (applications-layer knowledge) and the registry. |
| `WF-C-004` | Every reference resolves within the tenant or SYSTEM shared-read. | Deliberately impure — repository-backed I/O (TASK-716 §3.2, §2.9's 404-over-403 posture). |
| `WF-C-005` | Every node type is a member of the definition's `paletteKey`. | Needs the registry (not built). |
| `WF-C-006` | The tenant holds the entitlement every node type declares. | Deliberately impure — `IEntitlementsService.isFeatureEnabled` (TASK-716 §3.5's `entitlements.enabled` seeds `false` locally caveat applies here). |

---

## 4. Severity semantics

- `ERROR` — blocks publish (`WorkflowValidationReport.ok` is `false` if any `ERROR` finding
  exists — see `report.ts`'s `hasBlockingFindings`).
- `WARNING` — does not block publish; surfaced for the Studio's validation rail (TASK-719).
- A rule may be introduced as `WARNING` and graduated to `ERROR` later via a `ruleVersion`
  bump — this is the "tighten without a deploy" affordance design.md requires, and is why rule
  INSTANCES are data (Prisma rows, TASK-716 Task 3 — not built in this session) while predicate
  KINDS are code.

## 5. Tenant strictness rule (not enforced by this package)

A tenant may ADD a rule (stricter than the platform) but may never disable, loosen, or delete a
SYSTEM rule, and a tenant row sharing a `ruleId` with a SYSTEM row may only raise
`WARNING → ERROR`, never lower `ERROR → WARNING` (TASK-716 §3.3). This is an application-service
concern (Task 9, not built in this session) — the pure package has no notion of tenant rows at
all, only rule instances passed in by the caller.
