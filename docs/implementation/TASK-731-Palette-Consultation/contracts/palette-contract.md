# TASK-731 — Consultation palette contract (Phase A, Task 1)

Status: DRAFT — engineering pass, not clinically reviewed. Mirrors the disclosure already
carried by `packages/workflow-contract/src/rule-catalogue.ts`'s module docstring for the
Summarization/STT rule sets: these are code-owned rule/registry INSTANCES derived from the
register by this ticket's execution agent, not by a clinician. They need clinical review before
being treated as a validated safety boundary.

Verified against the live tree on branch `feat/loop`, HEAD `ef2a9d437` (2026-08-17). See §0 for
the dependency-shape verification (Task 0).

---

## 0. Task 0 — dependency shapes verified this pass

The README's §2 was written before several dependencies finished landing (or landed with a
different shape than assumed). Re-verified fresh rather than trusted:

| Dependency | Landed shape (file:line) | Divergence from README §2 |
|---|---|---|
| **TASK-715/716/718 node registry + compiler + validator** | NOT at `packages/applications/src/services/workflow-registry/` as speculated — lives in **`packages/workflow-contract`** (zero-runtime-dep package): `node-registry.ts` (`WORKFLOW_NODE_REGISTRY`, `WorkflowNodeDescriptor`, `nodeInfo()`, `registryChecksum()`), `compiler.ts` (`compile()`), `validate.ts` (`validate()`, merges `DRAFT_SUMMARIZATION_RULE_SET` + `DRAFT_STT_RULE_SET` from `rule-catalogue.ts`, filtered by `paletteKey`), `predicates/*` (11 predicate kinds: `ACYCLIC`, `SINGLE_ENTRY`, `REACHABLE_FROM_ENTRY`, `REACHES_TERMINAL`, `REQUIRED_NODE_TYPE`, `FORBIDDEN_NODE_TYPE`, `REQUIRED_PATH_THROUGH`, `FORBIDDEN_PATH`, `ORDERED_BEFORE`, `BOUND`, `CONFIG_PREDICATE`). Python mirror: `apps/harness/src/harness/temporal/interpreter/registry.py` (`NodeSpec`, `NODE_REGISTRY`). Cross-language parity fixture: `docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json`, asserted by `node-registry-parity.test.ts` (TS) and `test_node_registry_parity.py` (Python). | Registry package location differs from every guess on record (TASK-716's own speculative path, this ticket's own §4 Task 7 example path). Follow `packages/workflow-contract`, not the guesses. |
| **`WorkflowDefinitionService`** wiring | `packages/applications/src/services/workflow-definition/workflow-definition.service.ts` calls `validate()`/`compile()` for real inside `validate()`/`publish()` (`:270`, `:422`) — this is a LIVE publish-blocking path for STT and Summarization today, not test-fixture-only, despite `rule-catalogue.ts`'s own (now stale) module docstring claiming "No application service in this repo imports this module." | The docstring is stale; the wiring is real. Treat `DRAFT_CONSULTATION_RULE_SET` additions as live, publish-blocking rules once merged into `validate.ts`'s `ALL_DRAFT_RULES`, not inert fixtures. |
| **Registry current contents** | `WORKFLOW_NODE_REGISTRY`/`NODE_REGISTRY` currently hold `noop`, `passthrough`, and the eight `stt.*` entries **only** — TASK-720's five summarization entries are committed-absent from both files (an explicit, dated code comment in `node-registry.ts:113-118` records "a concurrent sibling session's uncommitted work was reverted by an external tree operation mid-session" and defers restoration to TASK-720's own reconciliation). `rule-catalogue.ts`'s `DRAFT_SUMMARIZATION_RULE_SET` (WF-I-*, WF-SUMM-*) IS present and does not depend on the registry entries existing (rules are graph-shape checks; only `compile()` needs registry entries). | Not a TASK-731 problem to fix — flagged here only so this ticket's own additions are not confused with, or blamed for, that gap. This ticket's consultation entries are independent of it. |
| **TASK-710 phi-redactor** | Landed, gateway-side: `IPhiRedactor.redact(text, mode: 'pseudonymize' \| 'full')` (`packages/applications/src/services/gate-edit-mining/IPhiRedactor.ts:13-33`), implemented by `GuardrailPhiRedactor` (`packages/applications/src/services/phi-redaction/guardrail-phi-redactor.service.ts`) calling `POST /api/guardrail/redact` on `apps/guardrail`. The Python-side route is `POST /guardrail/redact` (`apps/guardrail/src/guardrail/api/endpoints/redact.py:267`) — directly callable peer-to-peer from `apps/harness`, no gateway hop required, following the SAME pattern TASK-720 already used for `guardrail.check` (`apps/harness/src/harness/services/guardrail_client.py`'s `GuardrailClient.analyze()` calling `POST /guardrail/analyze` directly). | README §2.4 correctly identified `apply_redaction` as the wrong compile target. This confirms the fix: extend `GuardrailClient` with a `redact()` method mirroring `analyze()`, not a new gateway route. |
| **TASK-711 session state machine** | Landed. `ConsultationStatus` (`packages/database/src/prisma/db_main/enums.prisma:296-...`) has **11** members, not 7+3: `OPEN, RECORDING, DRAFT_PENDING_SENSORS, PENDING_REVIEW, SIGNED, CLOSED (superseded, dead), REOPENED, PRIMED, DRAINING, TIMED_OUT, CLOSED_COMPLETE, CLOSED_INCOMPLETE`. `ConsultationEntity.transitionTo(next, actor, reason): boolean` (`packages/domains/src/entities/generated/core/ConsultationEntity.ts:327`), backed by `CONSULTATION_TRANSITIONS` (22 legal non-reflexive pairs, `:25-80`) and `RESERVED_DISABLED_TRANSITIONS` (`:84-90`, throws a named error rather than a generic illegal-pair error). | README §2.9 anticipated `PRIMED, DRAINING, TIMED_OUT` and correctly predicted `PENDING_REVIEW → DRAFT_PENDING_SENSORS` as reserved-disabled (confirmed: owning epic `'note-sections'`, exact match). It did not know about `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` (owner Q1 decision, dated after README authoring) — §4 Task 3's mapping below accounts for them. |
| **TASK-712 consent-abac** | Landed further than README §2.3 assumed — **a harness-reachable surface now exists** (dated "Phase 4" in code comments, matching the tree-state note "consent phase 4"): `apps/harness/src/harness/core/consent_client.py`'s `ConsentClient` (per-key TTL cache, fail-closed, `check()`) calling `POST {api_base_url}{consent_internal_prefix}/assert` — the gateway route is `apps/api/src/modules/consultation/consent-internal.controller.ts`'s `ConsentInternalController` (`POST /assert`, `:98`), fronting `IConsultationConsentService.checkConsent` (`packages/applications/src/services/consent/IConsultationConsentService.ts`). **`_check_consent()`** (`apps/harness/src/harness/temporal/activities.py:554`) is an existing plain async helper (not itself an `@activity.defn`) built on `ConsentClient`, already embedded inside two existing activities: `call_mcp_tool` (purpose `EXTERNAL_TOOL_LOOKUP`, `:929`) and `retrieve_context` (purpose `HISTORY_RETRIEVAL`, `:1376`). `ConsentPurpose` (`enums.prisma:668-674`) has five members, including `AI_DOCUMENTATION` — *"Consultation capture + AI-assisted note generation (INV-201, INV-004)"* — which is a byte-for-byte match to CR-01's own register ids. | R-3's premise ("consent has no harness-reachable surface... this is HUMAN-GATED if TASK-712's landed shape offers neither pattern") is **resolved, not blocked**: TASK-712 built exactly the "harness activity POSTing to a gateway internal route" pattern §2.3 named as candidate 1, and it is already proven in production use by two other activities. `consultation.consentGate`'s compile target is a NEW thin `@activity.defn` wrapping the existing `_check_consent(purpose="AI_DOCUMENTATION")` — see §4 below. No new gateway route, no new client. |
| **TASK-718 interpreter v1** | `apps/harness/src/harness/temporal/interpreter/workflow.py`: exactly one signal, `@workflow.signal(name="cancel")` (`:250-256`) — confirmed, no `approval`/`edit` signal exists on the interpreter workflow. Exactly one query, `@workflow.query(name="state")` (`:257`). `NodeSpec` fields confirmed as README §4 Task 0 lists (`registry.py:88-108`). `apps/harness/src/harness/api/endpoints/interpreter.py` dispatcher: `cancel_workflow_run` (`:185`) is the one code-allow-listed signal route, explicitly documented "never a caller-supplied signalName". | §2.6's central premise is confirmed exactly as stated: **v1 truly cannot express a durable human wait.** No drift to report — Phase A Task 1 §2 below carries the decision. |
| **TASK-704 `NoteGenerationService`** | `packages/applications/src/services/consultation/note-generation/note-generation.service.ts` exists, with `INoteGenerationService.ts`, `types.ts`, a module, and a grep-gate test (`__tests__/harness-enabled-single-reader.grep-gate.test.ts`) already guarding it as the single reader of the harness-enabled flag. | Confirms the dispatcher seam README §4 Task 13 names exists and is where the interpreter-start hop belongs. Not modified this pass — Task 13 is not attempted (§5 below). |
| **`HarnessDocWorkflow` gate machinery** | Re-spot-checked, still present, line numbers drifted by single digits from README §2.5 due to intervening commits (expected on a shared, actively-edited file): `approval`/`edit` signals at `workflows.py:337`/`:342`, `self._phase = "GATE"` at `:1533`. Mechanism intact. | Cosmetic drift only; no semantic divergence. |
| **Imaging / DICOM** | Re-verified repo-wide (excluding `docs/archive/**`, build artifacts, this ticket's own docs): **zero** `pydicom`/`dicom` hits in any source file. | README §1.3's imaging-deferral premise still holds exactly. |

**No dependency required a STOP.** Every dependency named in the README has landed with either
the assumed shape or a *more complete* shape than assumed (TASK-712 in particular). The one
genuine surprise — the registry package living in `@arcaai/workflow-contract` rather than
`packages/applications/src/services/workflow-registry/` — is a path correction, not a missing
capability, and is threaded through the rest of this document and §4's implementation.

---

## 1. Role → node-type mapping (all nine reference roles, exhaustive)

Reproduces README §1.2, confirmed against the verified shapes above. No change to the mapping
itself — the verification above only changes *how* each node type reaches its compile target.

| # | Reference role | Palette treatment | Compile target (re-verified) |
|---|---|---|---|
| 1 | Master/Harness loop (T0–T24) | NOT a node — the interpreter itself. | `apps/harness/src/harness/temporal/interpreter/workflow.py` |
| 2a | Compliance — consent | `consultation.consentGate` | **NEW** `@activity.defn interpreter.consultation_consent_gate`, thin wrapper over the existing `_check_consent(purpose="AI_DOCUMENTATION")` |
| 2b | Compliance — PHI | `consultation.phiHop` | **NEW** `@activity.defn interpreter.consultation_phi_hop`, thin wrapper over a new `GuardrailClient.redact()` method (mirrors `.analyze()`) |
| 3 | Summarization Agent (prior-history priming) | **DEFERRED — no node type registered.** See §3. | — |
| 4 | Transcription Agent | `consultation.captureBinding` — binding, not executing | `livedoc_start`/`livedoc_stop` (`activities.py:2268`,`:2293`) |
| 5 | Vision Agent | **DEFERRED — no node type registered.** README §1.3, restated §5 below. | — |
| 6a | NLP/Reasoning — extraction | `consultation.extractEntities` | `extract_entities` (`:754`) + `persist_entities` (`:980`) as the persist leg |
| 6b | NLP/Reasoning — terminology | `consultation.bindTerminology` | `call_mcp_tool` (`:801`) bound to `MCP_TERMINOLOGY_TOOL = "validate_codes"` |
| 7a | Note-taking / Composer — assembly | `consultation.assemblePrompt` | `assemble_prompt` (`:1008`) |
| 7b | Note-taking / Composer — synthesis | `consultation.synthesize` | `generate` (`:1048`) |
| 7c | (evidence hop feeding composer) | `consultation.retrieveEvidence` | `retrieve_context` (`:1229`) — knowledge-base RAG, NOT prior-history (see §3) |
| 8a | Verifier / Quality — computational | `consultation.sensors` | `run_sensors` (`:1281`) |
| 8b | Verifier / Quality — inferential | `consultation.inferentialSensors` | `run_inferential_sensors` (`:1548`) |
| 9 | Clinician | NOT a node — the actor. Entry: `consultation.hitlGate`. Exit: `approveSummary` (outside the substrate — §4/§1.4). | `record_gate_decision` (`:2049`) / `escalate_gate` (`:2109`) via the durable wait — see §2 |

Persistence nodes belong to no reference role (`consultation.persistDraft` → `persist_draft`
`:1896`; `consultation.finalizeAssurance` → `finalize_assurance` `:1955`) — `mandatory` for the
same reason README §1.2 gives.

---

## 2. The interpreter-semantics decision (§2.6 options A/B/C)

**Decision: Option (B) — delegate the gate to the existing, replay-fixtured `HarnessDocWorkflow`
gate machinery as a child workflow.**

> **CORRECTION (2026-08-19, Phase B implementation).** The decision below stands on its
> *reasoning* and was implemented on it; the specific delegation target did not survive contact
> with the code. §2's own stated falsifier — "TASK-718's `contracts/versioning.md` rules turn out
> to forbid a parent from starting a non-declared child workflow kind" — was re-confirmed and is
> **fine**: `versioning.md` carries no such prohibition, only rule 3's requirement that a new
> command in the shared loop ships behind a `workflow.patched` gate (which the interpreter side
> now carries as `task-731-hitl-gate`).
>
> The actual blocker is more basic and was not anticipated here: **`HarnessDocWorkflow` has no
> gate-only entry point.** `HarnessDocWorkflow.run` is a single ~1,100-line method that fetches
> policy, extracts entities, retrieves evidence, assembles a prompt, generates, runs both sensor
> passes and persists a draft *before* reaching `self._phase = "GATE"` (`workflows.py:1539`).
> Starting it as a child to "just wait at the gate" would re-run that whole pipeline and persist
> a SECOND draft for a consultation the interpreter's graph has already persisted one for — a
> competing writer, not a delegation. The "reuses that code UNCHANGED" premise of the table below
> is therefore false as written.
>
> **What shipped instead:** a new `@workflow.defn`, `ConsultationGateWorkflow`
> (`apps/harness/src/harness/temporal/interpreter/gate_workflow.py`), which keeps every axis the
> table below actually decided on — the interpreter's signal surface stays `cancel`-only for
> every palette (the decisive axis against option (A)); the gate is a child, addressed at the
> deterministic id `f"{run_id}-gate"`; and the audited side effects (`escalate_gate`,
> `record_gate_decision`) are reused verbatim. Being a NEW type is what makes it safe to write at
> all: a type with no recorded histories has no era to stay compatible with, which is exactly the
> precedent `ConsultationLoopWorkflow` set (`workflows.py:1634`). What is re-expressed rather
> than reused is the ~40-line wait/escalate/abandon shape — not the audited writes, and not the
> "timeout never signs" property, which `test_gate_workflow.py::TestTimeoutNeverSigns` now pins
> directly against a time-skipping server.
>
> Also not implemented, deliberately: the `edit` signal. It exists on `HarnessDocWorkflow` to
> re-run the optimistic-assurance pass against an edited note; the interpreter walks a linear
> compiled graph with no loop back to synthesis, so accepting one would imply a capability that
> does not exist. A clinician who edits and then signs is carried by the approval's
> `contextItemVersionId`. This is the README's own carried recommendation; this pass
defends it explicitly rather than adopting it by inertia.

### Why (B), argued against (A) and (C)

| Axis | (A) Extend the interpreter | **(B) Child-workflow delegation** | (C) Split the run at the gate |
|---|---|---|---|
| **Replay-compat blast radius** | Touches the SHARED dispatch loop every palette's compiled config walks — a bug in the new `durable_wait` node kind is a correctness risk for STT and Summarization too, not just Consultation. | Touches only the parent workflow's decision to `execute_child_workflow` at the gate node — the dispatch loop for every OTHER node kind is untouched. The child (`HarnessDocWorkflow`'s gate phase) already carries 11 patch eras and 12 replay fixtures of its OWN; this option adds work at the parent's call site, not inside that proven code. | Zero interpreter change, but pushes the replay-compat question onto a NEW seam (joining two runs in the runs-tab read model) that has no precedent anywhere in the platform. |
| **Sandbox safety** | A sandboxed run must remember to skip a brand-new node kind correctly — one more code path to get right under `external_write` suppression. | The gate is `external_write=True` in the registry exactly like every other write-shaped node — reuses the SAME suppression check every other consultation node already needs (§3.3 pitfall 7/8), not a new mechanism. | Same as (A): the split point itself becomes a second place sandbox suppression must be proven correct. |
| **Signal surface widened for other palettes** | The interpreter's own `cancel`-only signal allow-list widens to `approval`/`edit` for EVERY palette that ever compiles through this interpreter, including sandboxed Workbench runs of Summarization/STT graphs that will never contain a gate node. | The interpreter's signal surface stays exactly `cancel`-only — TASK-718's v1 refusal (AC bullet 2, R-2's *"deliberate: v1 refuses it and the schema enforces the refusal"*) is preserved in full. `approval`/`edit` widen only the ALREADY-EXISTING `HarnessDocWorkflow`'s signal surface, which has carried them since before this ticket. | No signal widening anywhere — the interpreter still only produces `cancel`. |
| **Reuse of proven code** | Re-implements ~1,330 LOC of durable-wait/escalation-ladder/terminal-abandon logic that `HarnessDocWorkflow` already has, fixtured, and passing. Highest line-for-line risk in the program. | Reuses that code UNCHANGED. The property `03-compliance-posture.md` calls *"the hardest property to get right, and it is right"* (timeout never signs, `P-02`) is never re-derived. | No reuse — the split still routes the clinician's approve call through `approveSummary`'s existing HTTP path, so it does reuse SOME code, but the run-joining logic at the seam is entirely new. |
| **Runs-tab observability** | One workflow id per consultation run — simplest to display, but the "wait" state is now a NEW state the runs tab must learn to render for the interpreter's own workflow type. | Two workflow ids to observe (parent interpreter run + child gate workflow) — a real but bounded cost; the runs tab already understands `HarnessDocWorkflow`'s `GATE` phase from displaying it for the legacy path, so half of this is a rendering case it already has. | Two SEPARATE runs (not parent/child) that the runs tab must explicitly JOIN as one logical consultation — strictly harder than (B)'s parent/child relationship, which Temporal's own tooling already understands natively. |

**What would falsify this choice:** if the gate's SLA reliably needs sub-second responsiveness to
a clinician action in a way a child-workflow signal hop cannot meet (it can — child workflows on
the SAME task queue, per `worker.py:257-262`, signal with the same latency profile as the parent);
or if TASK-718's `contracts/versioning.md` rules turn out to forbid a parent from starting a
non-declared child workflow kind (not verified this pass — **this is Phase B Task 5's own
precondition to re-confirm before implementation**, flagged here rather than silently assumed).

### How the child is addressed and how the clinician's approve call reaches it (design-level, not yet implemented — see §6)

- The interpreter starts the gate as `execute_child_workflow(HarnessDocWorkflow.run, ..., id=f"{parent_run_id}-gate")` (deterministic, derived id — no `uuid4()` inside the workflow) on the SAME `harness-task-queue` (`worker.py:257-262`'s existing rule for child workflows).
- The gate node's `NodeSpec.kind` is `"child_workflow"` (the field `registry.py`'s `NodeSpec.kind` already reserves for this — `registry.py:70-71`, currently unused by any entry, confirmed this pass).
- The clinician's approve/edit HTTP call (today's `POST /internal/harness/gate/{consultationId}/approval` route, wherever `harness-internal.controller.ts` mounts it for the legacy path) is retargeted, for interpreter-driven runs, to signal the CHILD workflow id (`{parent_run_id}-gate`), not the parent. The gateway resolves which id to signal from `WorkflowRun.childRunId` (a new, additive field on whatever read-model row TASK-723 already persists — not verified this pass, flagged for Phase B Task 5/12 to confirm against TASK-723's landed shape).

---

## 3. Loop-scope decision (§2.6 last paragraph, TASK-724's reasoning form)

**Decision: the reference's debounce/retrigger loops (T7, T12) stay OUTSIDE the interpreter,
exactly where TASK-724 put STT's realtime loop.**

`LiveDocumentationService` (`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:307`, 2434 LOC) already owns the debounce (~3 final segments or ~5s idle) and the STT stream attachment (`attachSttStream:1569`). The interpreter walks the ONE-SHOT post-capture pipeline — exactly the stage sequence `HarnessDocWorkflow` walks today. `consultation.captureBinding` dispatches `livedoc_start`/`livedoc_stop` (HTTP control only, no per-frame audio, no realtime session lifecycle inside a Temporal workflow) — a BINDING node, never a loop the tenant authors.

This is the same reasoning TASK-724 used for `stt.audioInput`/`stt.asrEngine` staying outside per-node interpreter dispatch (the STT palette compiles to an `AsrPipeline`, not node-by-node execution) — the shared principle both tickets apply is: **realtime, per-frame, or debounced-retrigger behavior never enters a Temporal workflow's deterministic execution model; only the durable, one-shot checkpoints do.** If a future palette genuinely needs an authored loop, TASK-718's R-2 already names the escape hatch (a new interpreter widening ticket with its own patch era) — this ticket does not take it.

CR-13/CR-17 (validator-rules.md) enforce the boundary structurally: a reconciliation stage must sit between capture and final synthesis, and capture/persist nodes are non-removable.

---

## 4. The two missing compile targets, resolved

### 4a. `consultation.consentGate` → new activity wrapping the existing consent primitive

§0 confirmed `_check_consent()` (`activities.py:554`) already exists, is tested (embedded in two
production activities), and is fail-closed with a distinguishable `unavailable` vs `reason`
denial. This ticket adds ONE new thin `@activity.defn`:

```python
@activity.defn(name="interpreter.consultation_consent_gate")
async def interpreter_consultation_consent_gate(payload: NodeActivityInput) -> NodeActivityResult:
    """consultation.consentGate — the mandatory-subgraph entry point (CR-01).
    Wraps the existing _check_consent() helper with purpose=AI_DOCUMENTATION
    (enums.prisma ConsentPurpose — "Consultation capture + AI-assisted note
    generation (INV-201, INV-004)", an exact match to CR-01's register ids)."""
```

This is the pattern §2.3 named as candidate 1 ("a new harness activity POSTing to a gateway
internal route") — except the gateway route (`ConsentInternalController.assert`) and the client
(`ConsentClient`) already exist from TASK-712, so this ticket contributes only the activity
wrapper, not a new integration pattern. **No third pattern invented** — this is the FIRST
pattern from the two §2.3 named, now that its prerequisite has landed.

### 4b. `consultation.phiHop` → new activity wrapping a new `GuardrailClient.redact()` method

§0 confirmed `apply_redaction` (`activities.py:1753`) is DNA style-redaction, not this. The
correct compile target is TASK-710's actual redactor, reached PEER-TO-PEER from harness — the
SAME pattern TASK-720 already established for `guardrail.check`
(`apps/harness/src/harness/services/guardrail_client.py`). This ticket:

1. Adds `GuardrailClient.redact(*, text, mode, tenant_id) -> RedactResult` calling
   `POST /guardrail/redact` (mirrors `.analyze()`'s shape and `X-Service-Token` +
   **mandatory** `X-Tenant-Id` headers, per TASK-737).
2. Adds `@activity.defn(name="interpreter.consultation_phi_hop")
   interpreter_consultation_phi_hop`, thin wrapper.

**Not TASK-724's `stt.phiHop` precedent verbatim** — that placeholder existed because TASK-710
had not landed yet at STT's execution time. TASK-710 HAS landed now (§0), so
`consultation.phiHop` registers `implemented: true` with a real compile target, unlike its STT
sibling (which remains someone else's — TASK-724's own — reconciliation to make, per README
§2.4's own framing: *"if TASK-710 has not landed, the node registers with a loud binding"* — it
has landed, so it does not).

### 4c. `consultation.priming` — DEFERRED, not registered (R-4's legitimate alternative)

No compile target exists (`retrieve_context` is knowledge-base RAG, confirmed §0/§1 row 7c; zero
`Primed` sys-event hits repo-wide, confirmed by grep this pass: `grep -rn "'Primed'\|\"Primed\""
packages apps` returns no hits outside enum declarations). README R-4 explicitly sanctions
omission as a *stated* deferral, same treatment as Vision, "because INV-011/012/015/016/018 hang
on it" — those invariant ids stay OPEN in the conformance matrix, named here rather than silently
dropped. **Reasoning for choosing omission over invention:** the register's role for this
capability is "load authorized prior notes within minimum-necessary scope" — a real, distinct
data-access pattern (patient-scoped, cross-consultation, minimum-necessary-audited) that
`retrieve_context`'s institutional-KB retrieval does not perform even approximately; binding the
node type to it would misrepresent what runs, exactly the failure mode §1.3 names for Vision
("worse than registering nothing"). Building the real activity is out of this ticket's scope
(§1.6: "Building consent, the redactor, or the state machine" are the only explicitly-named
building blocks this ticket inherits — priming was never one of them).

---

## 5. The imaging hole (restated in this contract, per README §1.3/Task 1 item 5)

No `consultation.vision*` node type is registered. Verified zero `pydicom`/`dicom` hits
repo-wide (§0). `vision_extract_text` (`activities.py:2773`) exists but is deliberately
non-diagnostic (*"Transcribe all legible text... Do not interpret, diagnose or summarise,"*
`temperature=0.0`) and is NOT bound to any node type in this palette — binding it would let a
tenant author a graph that *looks* like the reference's imaging lane while doing OCR. The
seventeen imaging invariants (INV-031…038, 142, 211…215, 363…369) stay OPEN in the conformance
matrix. This is a scope decision, restated honestly rather than allowed to silently disappear
from the coverage denominator (R-7).

---

## 6. `LOOP_ACTION_KEYS` / `AGENT_ACTION_KEYS` reconciliation (R-8)

**Decision: coexist, with a stated, non-overlapping dispatch rule.**

`LOOP_ACTION_KEYS` (`models.py:1039-1055`) is `ConsultationLoopWorkflow`'s OWN closed 7-key
vocabulary for the debounce/retrigger loop (§3's live-session behavior) — a runtime that stays
entirely outside any authored `WorkflowDefinition` graph. The consultation palette's node-type
registry (`consultation.*` keys in `WORKFLOW_NODE_REGISTRY`/`NODE_REGISTRY`) is the vocabulary
for the interpreter's one-shot, post-capture, TENANT-AUTHORED pipeline. **The two vocabularies
govern two different execution surfaces that never call into each other**: `ConsultationLoopWorkflow`
never dispatches through the interpreter's node registry, and the interpreter never dispatches
through `LOOP_ACTION_KEYS`. A future ticket that wants the live loop itself to become authorable
would need to widen the INTERPRETER (a TASK-718 widening ticket, per R-2), not overload
`LOOP_ACTION_KEYS`'s closed set — and vice versa. This is the "written rule for which one a
runtime dispatch consults" R-8 requires: **the answer is "whichever surface is executing" — there
is no shared dispatch point, so there is nothing to accidentally consult the wrong table for.**

---

## 7. What this contract does NOT decide

Per §1.6 (out of scope) and this pass's own scoping (see the ticket README §7 for the full
account of what was and was not implemented this pass): entitlement enforcement for the
consultation palette (R-6, deferred), per-section HITL, contradiction items, the legacy
generator's deletion (TASK-732), per-department assignment (TASK-733), and — the largest item —
Phase B's actual interpreter code change (implementing the child-workflow dispatch decided in §2;
this document decides and specifies it, it does not implement it — see README §7).
