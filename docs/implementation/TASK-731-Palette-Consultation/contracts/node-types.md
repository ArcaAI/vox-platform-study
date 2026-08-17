# Consultation palette — node registry contract (TASK-731 Phase A, Task 1)

Cross-references `docs/implementation/TASK-720-Palette-Summarization/contracts/palette.md` and
`docs/implementation/TASK-724-Palette-Stt/contracts/palette.md` — the mechanism (registry shape,
cross-language parity, `implemented: false` = "loud publish-time refusal, never a silent
pass-through") is identical; only the node set and compile targets are consultation-specific.
`packages/workflow-contract/src/node-registry.ts` and
`apps/harness/src/harness/temporal/interpreter/registry.py` are the code these tables describe.

## Node table

| # | Node type key | Safety class | `critical` | `external_write` | `implemented` | Activity (Temporal name) | Config schema |
|---|---|---|---|---|---|---|---|
| N-1 | `consultation.consentGate` | `mandatory` | **`true`** | `false` | `true` | `interpreter.consultation_consent_gate` | `nodes/consultation.consentGate.schema.json` |
| N-2 | `consultation.captureBinding` | `mandatory` | `false` | `false` | `true` | `interpreter.consultation_capture_binding` | `nodes/consultation.captureBinding.schema.json` |
| N-3 | `consultation.extractEntities` | `optional` | `false` | **`true`** (persist leg) | `true` | `interpreter.consultation_extract_entities` | `nodes/consultation.extractEntities.schema.json` |
| N-4 | `consultation.bindTerminology` | `optional` | `false` | `false` | `true` | `interpreter.consultation_bind_terminology` | `nodes/consultation.bindTerminology.schema.json` |
| N-5 | `consultation.phiHop` | `mandatory` | `false` | `false` | `true` | `interpreter.consultation_phi_hop` | `nodes/consultation.phiHop.schema.json` |
| N-6 | `consultation.retrieveEvidence` | `optional` | `false` | `false` | `true` | `interpreter.consultation_retrieve_evidence` | `nodes/consultation.retrieveEvidence.schema.json` |
| N-7 | `consultation.assemblePrompt` | `optional` | `false` | `false` | `true` | `interpreter.consultation_assemble_prompt` | `nodes/consultation.assemblePrompt.schema.json` |
| N-8 | `consultation.synthesize` | `optional` | `false` | `false` | `true` | `interpreter.consultation_synthesize` | `nodes/consultation.synthesize.schema.json` |
| N-9 | `consultation.sensors` | `optional` | `false` | `false` | `true` | `interpreter.consultation_sensors` | `nodes/consultation.sensors.schema.json` |
| N-10 | `consultation.inferentialSensors` | `optional` | `false` | `false` | `true` | `interpreter.consultation_inferential_sensors` | `nodes/consultation.inferentialSensors.schema.json` |
| N-11 | `consultation.persistDraft` | `mandatory` | `false` | **`true`** | `true` | `interpreter.consultation_persist_draft` | `nodes/consultation.persistDraft.schema.json` |
| N-12 | `consultation.finalizeAssurance` | `mandatory` | `false` | **`true`** | `true` | `interpreter.consultation_finalize_assurance` | `nodes/consultation.finalizeAssurance.schema.json` |
| N-13 | `consultation.hitlGate` | `mandatory` | **`true`** | **`true`** | **`false`** (Phase B not yet implemented — see below) | `interpreter.consultation_hitl_gate` | `nodes/consultation.hitlGate.schema.json` |

Deliberately **not registered** (palette-contract.md §3/§5): `consultation.priming` (no compile
target — deferred like Vision, R-4), `consultation.vision*` (no substrate — deferred, §1.3/§5).
A registry test asserts both absences (§4 below).

`entitlementKey: null` on every entry — R-6 (README §6): entitlement granularity/enforcement is
deferred to TASK-722 by TASK-718's own R-6; this ticket does not wire a `paletteConsultation`
entitlement column, matching the STT/Summarization precedent's OWN per-palette gate living at
`WorkflowDefinitionService.publish()`, not in the registry.

## `implemented: false` on `consultation.hitlGate` — the load-bearing gap, stated precisely

`compile()` treats an `implemented: false` entry identically to an unregistered node type (`WF-C-002`)
— refusing the ENTIRE graph, not just the one node. Concretely:

- **No consultation graph can compile or publish today.** CR-06 (validator-rules.md) requires
  exactly one `consultation.hitlGate` in the terminal stage of every consultation graph — it is
  not optional, so there is no consultation graph that both satisfies the mandatory-subgraph rule
  AND avoids the unimplemented node. This is the direct, disclosed consequence of shipping Phase A
  (design) + Phase C (registry) + Phase D (validator) without Phase B (the interpreter's
  durable-wait extension) in the same pass — see README §7 for why Phase B was not attempted this
  pass and what unblocks it.
- Every OTHER node type in this table is independently testable, registrable, and — for a graph
  that never claims the gate exists — independently publishable the moment Phase B lands, with
  zero further registry changes.
- This is the SAME mechanism `stt.phiHop` used while TASK-710 was unbuilt (`implemented: false` =
  a structural, publish-time refusal, never a runtime surprise) — applied here to the single
  highest-risk piece of new interpreter behavior instead of a missing peer-service integration.

The placeholder activity `interpreter_consultation_hitl_gate` exists (registry-parity
requirement — `NodeSpec.activity` is a required callable) and, if ever reached despite the
registry gate, returns `DEGRADED` naming exactly why (never a silent `SUCCEEDED`, never an
"approved"-reading result — the `03-compliance-posture.md` §3 forgery shape this must never
resemble, per README §3.3 pitfall 11).

## `critical` rationale

- **N-1 (`consentGate`) and N-13 (`hitlGate`) are the ONLY critical nodes** (CR-14). Consent is
  the entry the mandatory subgraph cannot proceed without (INV-003/004/201); the gate is the exit
  the reference's entire authority model depends on (INV-144/146/159). Every other node degrades
  visibly — a failing sensor, a skipped terminology bind, a KB-retrieval outage must not fail the
  whole run (CR-14's own register ids: INV-072/073/075/128/131/132).
- **N-2 (`captureBinding`), N-11 (`persistDraft`), N-5 (`phiHop`) are `mandatory` safety class but
  NOT `critical`** — mirrors TASK-715/TASK-720's own distinction: "mandatory" (§CR-17, the
  validator refuses a graph that omits them) is a GRAPH-SHAPE property; "critical" (a registry
  code-owned property consumed by the runtime's degrade-vs-fail decision) is deliberately a
  narrower, separate axis. A graph without a capture binding is REJECTED at publish time (CR-17);
  a capture binding that fails mid-run degrades the SAME way any other non-critical node does —
  there is no reference invariant requiring capture failure to hard-fail the whole run the way a
  denied consent gate must.
- **N-3's persist leg is `external_write: true`** even though the node's primary purpose
  (extraction) is not itself a ContextItem write — `persist_entities` (the second half of
  `extract_entities`'s activity pairing) does write. Flagged `true` structurally rather than
  finely split, matching §3.3 pitfall 7's instruction to declare `external_write=True` on "every
  consultation node that writes a ContextItem."

## Config schemas (authorable subset — `@arcaai/json-schema-subset`)

Flat objects only; no `if`/`then`/`else`, no undiscriminated `oneOf` (the subset's two hard
exclusions). See `contracts/nodes/*.schema.json`, one per node type, following the
`stt.phiHop.schema.json` precedent's shape exactly.

## Port keys

`CONTEXT_PRIMITIVES` vocabulary (`context-schema-definition.ts:35`): `STREAM_AUDIO`, `TEXT`,
`DOCUMENT`, `IMAGE`, `STRUCTURED`. Each node's `in`/`out` ports below are named by primitive, not
invented per-node vocabulary:

| Node | in | out |
|---|---|---|
| `consultation.consentGate` | — | `gate:boolean` (pass-through signal, not a context primitive) |
| `consultation.captureBinding` | — | `STREAM_AUDIO` |
| `consultation.extractEntities` | `STREAM_AUDIO`/`TEXT` (transcript) | `STRUCTURED` (entities) |
| `consultation.bindTerminology` | `STRUCTURED` (entities) | `STRUCTURED` (coded terms + `unmapped`) |
| `consultation.phiHop` | `TEXT`/`STRUCTURED` | same shape, sanitized |
| `consultation.retrieveEvidence` | `STRUCTURED` (query terms) | `TEXT` (evidence chunks + citations) |
| `consultation.assemblePrompt` | `TEXT`+`STRUCTURED` (evidence + entities) | `TEXT` (prompt) |
| `consultation.synthesize` | `TEXT` (prompt) | `TEXT` (draft note) |
| `consultation.sensors` | `TEXT` (draft) | `STRUCTURED` (sensor verdicts) |
| `consultation.inferentialSensors` | `TEXT` (draft) | `STRUCTURED` (sensor verdicts) |
| `consultation.persistDraft` | `TEXT` (draft) | — (`external_write`) |
| `consultation.finalizeAssurance` | `STRUCTURED` (verdicts) | — (`external_write`) |
| `consultation.hitlGate` | — | `gate:decision` (not dispatchable yet — implemented:false) |

## Registry-level assertions (Phase C, Task 7-equivalent)

Implemented as `packages/workflow-contract/src/__tests__/consultation-node-registry.test.ts`
(§4 of the ticket README): every consultation `NodeSpec.activity` resolves to a real
`@activity.defn`; only N-1/N-13 are `critical`; `external_write` matches the table above; no
descriptor mentions signing (TASK-715 assertion #6, palette-scoped); no `consultation.vision*`
key exists; `consultation.priming` is absent; every entry's `entitlementKey` is `null`.
