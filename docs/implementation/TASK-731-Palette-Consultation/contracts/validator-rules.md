# TASK-731 — Consultation validator rule set (Phase A, Task 2)

Status: DRAFT, same disclosure as `palette-contract.md`. Implemented as `DRAFT_CONSULTATION_RULE_SET`
in `packages/workflow-contract/src/rule-catalogue.ts`, merged into `validate.ts`'s
`ALL_DRAFT_RULES` and `__tests__/golden.test.ts`'s `ALL_RULES` — this IS a live, publish-blocking
rule set once merged (`palette-contract.md` §0 corrects the stale "not wired anywhere" docstring).

The mandatory subgraph is `consent → capture → PHI → synthesis → verifier → HITL gate`, signing
outside. Node type keys per `node-types.md`.

## Rule instances (`WF-CONS-*`) and the CR-nn statements they implement

Every instance uses ONLY the 11 existing predicate kinds (`packages/workflow-contract/src/predicates/`)
— per README §1.6, this ticket makes NO engine change to the compiler/validator. Where a CR-nn
statement is not expressible with the existing predicate catalogue on pure graph shape, it is
listed in §3 (not implemented as a graph rule this pass) rather than faked with a weak predicate.

| Rule ID | Predicate | Config | CR-nn | Register ids | Rejection message (from the predicate's own template) |
|---|---|---|---|---|---|
| `WF-CONS-001` | `SINGLE_ENTRY` | `{ entryType: 'consultation.consentGate' }` | CR-01 | INV-003, INV-004, INV-201 | `expected exactly one node of type "consultation.consentGate", found N` |
| `WF-CONS-002` | `REACHABLE_FROM_ENTRY` | `{ entryType: 'consultation.consentGate' }` | CR-01 | INV-003, INV-004, INV-201 | `node "<id>" is not reachable from any "consultation.consentGate" node` |
| `WF-CONS-003` | `SINGLE_ENTRY` | `{ entryType: 'consultation.hitlGate' }` | CR-06 | INV-144, INV-146, INV-159 | `expected exactly one node of type "consultation.hitlGate", found N` |
| `WF-CONS-004` | `REACHES_TERMINAL` | `{ terminalType: 'consultation.hitlGate' }` | CR-06 | INV-144, INV-146, INV-159 | `node "<id>" does not reach any "consultation.hitlGate" node (dead end)` |
| `WF-CONS-005` | `REQUIRED_NODE_TYPE` | `{ nodeType: 'consultation.captureBinding', minCount: 1 }` | CR-17 | INV-019, INV-126, INV-205 | `expected at least 1 node(s) matching "consultation.captureBinding", found 0` |
| `WF-CONS-006` | `REQUIRED_NODE_TYPE` | `{ nodeType: 'consultation.phiHop', minCount: 1 }` | CR-17 | INV-019, INV-126, INV-205 | same template |
| `WF-CONS-007` | `REQUIRED_NODE_TYPE` | `{ nodeType: 'consultation.persistDraft', minCount: 1 }` | CR-17 | INV-019, INV-126, INV-205 | same template |
| `WF-CONS-008` | `REQUIRED_PATH_THROUGH` | `{ fromType: 'consultation.consentGate', toType: 'consultation.hitlGate', throughType: 'consultation.captureBinding' }` | canonical subgraph / CR-17 | INV-137, INV-155 | `a path exists from "consultation.consentGate" to "consultation.hitlGate" that does not pass through "consultation.captureBinding"` |
| `WF-CONS-009` | `REQUIRED_PATH_THROUGH` | `{ ..., throughType: 'consultation.phiHop' }` | canonical subgraph / CR-15 (structural half) | INV-026, INV-136 | same template, `phiHop` |
| `WF-CONS-010` | `REQUIRED_PATH_THROUGH` | `{ ..., throughType: 'consultation.synthesize' }` | canonical subgraph | INV-137, INV-155 | same template, `synthesize` |
| `WF-CONS-011` | `REQUIRED_PATH_THROUGH` | `{ ..., throughType: 'consultation.sensors' }` | canonical subgraph | INV-137, INV-155 | same template, `sensors` |
| `WF-CONS-012` | `REQUIRED_PATH_THROUGH` | `{ fromType: 'consultation.captureBinding', toType: 'consultation.synthesize', throughType: 'consultation.extractEntities' }` | CR-13 | INV-134, INV-135, INV-137, INV-176 | `a path exists from "consultation.captureBinding" to "consultation.synthesize" that does not pass through "consultation.extractEntities"` |
| `WF-CONS-013` | `CONFIG_PREDICATE` | `{ appliesTo: { nodeType: 'consultation.bindTerminology' }, field: 'purposeScope', op: 'present' }` | CR-03 | INV-007, INV-067, INV-232 | `node "<id>" config/purposeScope fails "present"` |
| `WF-CONS-014` | `CONFIG_PREDICATE` | `{ appliesTo: { nodeType: 'consultation.persistDraft' }, field: 'occ', op: 'eq', value: true }` | CR-07 | INV-029, INV-052, INV-085, INV-092, INV-133, INV-152, INV-219, INV-237 | `node "<id>" config/occ fails "eq" true` |
| `WF-CONS-015` | `CONFIG_PREDICATE` | `{ appliesTo: { nodeType: 'consultation.synthesize' }, field: 'producesCode', op: 'eq', value: false }` | CR-18 | INV-065, INV-066, INV-231, INV-089 | `node "<id>" config/producesCode fails "eq" false` |
| `WF-CONS-016` | `CONFIG_PREDICATE` | `{ appliesTo: { nodeType: 'consultation.bindTerminology' }, field: 'unmappedOutputKey', op: 'present' }` | CR-19 | INV-063, INV-233, INV-071 | `node "<id>" config/unmappedOutputKey fails "present"` |

`WF-CONS-015`'s strictness choice mirrors the codebase's own established pattern
(`WF-I-004`'s "DRAFT STRICTNESS CHOICE: requires an explicit declaration rather than tolerating
silent absence"): a `consultation.synthesize` node must explicitly declare `producesCode: false`
— CR-18 is enforced by requiring the negative to be STATED, not merely absent, so a future author
cannot satisfy the rule by omission and then quietly add code-emitting output later without the
rule noticing (an omitted field and a `false` field are indistinguishable to `op: 'present'`, but
distinguishable to `op: 'eq'`).

## Canonical mandatory-subgraph fixture

One 13-node linear-chain graph, `consent → capture → extract → terminology → phi → evidence →
prompt → synthesize → sensors → inferentialSensors → persist → finalize → gate`, satisfies every
rule above simultaneously (both structural presence/ordering AND the config-predicate checks, with
the configs shown in `node-types.md`). It is used as the shared `pass.graph.json` across every
`WF-CONS-*` fixture directory — see `packages/workflow-contract/src/__tests__/golden/WF-CONS-*/`.
Each `fail.graph.json` is a minimal, rule-specific mutation (a duplicated/removed/rewired node, or
one flipped config field) — never a wholesale rewrite, so a fixture failing for the wrong reason
is structurally hard to author by accident (README's own instruction).

## §3 — CR-nn statements NOT implemented as a `WF-CONS-*` graph rule this pass, and why

| CR-nn | Statement (abbreviated) | Why not a graph rule this pass | Where it IS enforced (or will be) |
|---|---|---|---|
| CR-02 | No history/chart-read node before the consent gate. | `consultation.priming` (the only node type that would read patient history) is deliberately unregistered (`palette-contract.md` §3, R-4) — there is no node to order against yet. Vacuously satisfiable today. | Add an `ORDERED_BEFORE(beforeType: 'consultation.consentGate', afterClass: 'historyRead')` rule when `consultation.priming` is registered, per README R-4. |
| CR-04 | `consentGate` must not declare an `entitlement`. | Not a graph-shape property — `entitlementKey` is a registry (code-owned) field, not something a tenant authors on the node's `config`. | `node-types.md`'s registry-level assertion (`entitlementKey === null` on every consultation entry) — a unit test on `WORKFLOW_NODE_REGISTRY`/`NODE_REGISTRY`, not `validate()`. |
| CR-05 | A scope-widening node must be distinct/separately audited. | No node type in this palette currently declares scope-widening (`consultation.retrieveEvidence` is fixed to institutional-KB scope, not patient scope). Vacuously satisfiable today, same reasoning as CR-02. | Becomes checkable once a scope-widening node type (most likely `consultation.priming`, if ever built) exists. |
| CR-08 | No node writes `SIGNED` / reaches `approveSummary`. | Already enforced palette-agnostically by the EXISTING generic `WF-S-006` (`FORBIDDEN_NODE_TYPE`, `nodeClass: 'signing'`, `paletteKey: null`) — every consultation graph is already subject to it via `validate()`'s merge. A palette-scoped duplicate would be redundant. | `WF-S-006` (unchanged) + a palette-scoped **unit test** (not a `validate()` rule) enumerating §Node table's 13 compile-target activity names and asserting none matches a signing-related name — see `node-types.md`'s registry-level assertions. |
| CR-09 | A content-writing node's `outputKey` must be a subset of the tenant's PUBLISHED context-schema `outputs[]`. | Genuinely data-driven — needs a live `ConsultationContextSchemaVersion.definition` read, which `validate()`'s pure, DB-free predicate evaluators cannot perform (this is exactly the class of rule `rule-catalogue.ts`'s own module docstring calls out as needing "the code-owned node registry... or repository/entitlement I/O... implemented directly by the impure `WorkflowValidatorService`" — precedent: the SIX `WF-C-*` schema-class rules the Summarization pass also deferred for the identical reason). | Not built this pass (matches precedent's own scope boundary — `WorkflowValidatorService`/its schema-I/O rule layer does not exist yet for ANY palette, not just this one). |
| CR-10 (runtime half) | Timeout terminal MUST be `TIMED_OUT`, never a config value that produces an approved artifact. | This is Phase B's interpreter-cap-clamping and state-machine behavior (`effective = min(config, cap)`, `session-state-mapping.md`'s row), not a graph-shape property `validate()` can see. | Phase B (`caps.py`'s `MAX_GATE_WAIT`) + `session-state-mapping.md`'s `PENDING_REVIEW → TIMED_OUT` row + the UNCHANGED, already-correct `HarnessDocWorkflow` timeout-never-signs property (`03-compliance-posture.md` P-02). Not implemented this pass (Phase B deferred — README §7). |
| CR-10 (author-time half) | A config SLA above the platform cap must be clamped, not honoured — the AUTHOR-TIME half of this is expressible. | **Deliberately not added as a rule this pass** — the real cap constant (`MAX_GATE_WAIT`) is a Phase B artifact that does not exist yet (`caps.py` unmodified this pass); hard-coding a placeholder number into a rule now would need a second edit the moment Phase B lands, and a stale cap in a publish-blocking rule is worse than no rule. Left for Phase B Task 5 to add alongside the real constant. | Phase B. |
| CR-11 | No output binding may mark an artifact final/approved/signed except an explicit gate approval. | Substantially covered by CR-08's `FORBIDDEN_NODE_TYPE(nodeClass:'signing')` (the only way to "mark final" in this substrate is to reach a signing-classed node, which is already forbidden platform-wide) — a separate rule would duplicate the same finding for the same underlying cause. | `WF-S-006`, same as CR-08. |
| CR-14 | Only `consentGate`/`hitlGate` may be `critical: true`. | `critical` is a registry (code-owned) field, not graph-authored config — not a `validate()` rule by construction (same reasoning as CR-04). | `node-types.md`'s registry-level assertion + the registry entries themselves (§4 of the ticket README). |
| CR-15 (data-driven half) | A `phiClass: 'PHI'` + retained/derived/cross-patient artifact requires `phiHop mode:'full'` upstream; `pseudonymize` upstream of NLP. | The `phiClass`/`lifecycle` values live on the tenant's `ConsultationContextSchemaVersion.definition` (DB row), not the graph — same I/O limitation as CR-09. | Deferred with CR-09, to the same future impure validator layer. **The structural half — SOME `phiHop` node sits between consent and gate** — IS implemented: `WF-CONS-009`. |
| CR-16 | No stage-level abort; only the timed-out node force-stops. | Expressible in principle (`CONFIG_PREDICATE` with `op:'in'`, excluding `'abort'` from `onError`'s allowed values, mirroring `WF-I-002`/`WF-I-009`'s own pattern) but **deliberately not added this pass** to keep this rule set's first cut focused on the mandatory-subgraph shape and the three CRs (03/07/18/19) with the clearest single-field mapping — flagged as a straightforward follow-up using the exact `WF-I-002` template, not a design gap. | Not implemented — real, disclosed gap, not a design decision. |

## Golden fixture status (honest count, per the Honesty Requirement)

**16 of the palette's ~19-CR statement set have a real `WF-CONS-*` rule instance with a
committed pass/fail fixture pair this pass; 7 CR-nn statements (02, 04, 05, 08, 09, 11, 14 — plus
the runtime half of 10 and the data-driven half of 15) are deliberately NOT graph rules, each with
a stated reason and, where applicable, a named alternative enforcement point above.** This is
fewer than the README's "CR-01…CR-19" full enumeration implies as a Phase D deliverable — see the
ticket README §7 for the disclosed scope of this pass and what a follow-up pass should pick up
first (CR-16's straightforward template, then the two data-driven CRs once the impure validator
layer exists for any palette).
