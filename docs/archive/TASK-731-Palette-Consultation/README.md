# TASK-731 — Consultation Palette

| | |
|---|---|
| **Status** | Completed — Phase A (design gate) COMPLETE; **Phase C COMPLETE: all 13 node types registered on BOTH the TypeScript and the Python registry, in parity**; **Phase D COMPLETE for every expressible CR: 19 `WF-CONS-*` rules with golden pass/fail pairs** (the 7 remaining CR statements are deliberately not graph rules — each has a stated reason and alternative enforcement point in `contracts/validator-rules.md` §3); Phase B (durable HITL wait) COMPLETE — `consultation.hitlGate` is `implemented: true` and the canonical graph publishes; Phase E gate-approval wiring landed through gateway + console. Phase F (seeded platform-default definition + e2e) remains open. See §7. |
| **Wave** | 4 · **Size** | XL |
| **Epic slug** | `palette-consultation` |
| **Depends on** | TASK-710 (`phi-redactor`), TASK-711 (`session-state-machine`), TASK-712 (`consent-abac`), TASK-718 (`workflow-interpreter`), TASK-720 (`palette-summarization`) |
| **Design refs** | **D4** (generic engine, domain palettes onboard without engine changes), **D5** (palette sequencing Summarization → STT → **Consultation** — this is the third and last), **D3** (tenant admins author full-power graphs; the server-side validator is the safety boundary), **D1** (the modernized `HarnessDocWorkflow` activities are the compile target); Plane 1 §"Workflow substrate"; §Data flow §Execution; §Error handling; §Testing strategy ("invariant register → validator golden suite"); Roadmap Wave 4 |
| **Findings closed** | None outright — this ticket makes the *mechanisms* built by TASK-710/711/712 authorable and enforceable per-tenant. It **structurally serves** A-01 (`consent-abac`), A-02 (`phi-redactor` hops), A-03 (no prompt-authored codes), A-12 (HITL gate reachability), A-25 (assurance before review) by making a graph that omits them un-publishable. It does **not** close A-04 (contradiction items), A-12's per-section model, A-16/A-17 (labelling), or A-18 (imaging — explicitly deferred, §1.3). |

---

## 1. Requirement Analysis

### 1.1 What this delivers

TASK-720 proved the substrate on the Summarization palette (single agent, no audio, no clinical
gate). TASK-724 proved it on STT (audio, no clinical gate) and established the precedent that a
palette may **bind** to an existing execution surface rather than force everything through Temporal.
This is the third palette and the only one with clinical gates: the reference's 24-step consultation
timeline (`dataset.xml`) becomes an authorable, validated `WorkflowDefinition` whose nodes compile to
the **modernized harness activities** — the ones TASK-710/711/712 hardened.

Concretely, this ticket delivers:

1. **A node-type set** for the consultation palette, each entry mapping one reference *capability*
   (not one reference *agent role* — see §1.2) to a verified `@activity.defn` in
   `apps/harness/src/harness/temporal/activities.py`, registered in both the TS registry
   (TASK-715) and the Python `NodeSpec` registry (TASK-718 Task 4).
2. **A mandatory subgraph** — `consent → capture → PHI → synthesis → verifier → HITL gate` — enforced
   as TASK-716-style validator rules with golden pass/fail fixtures per rule, derived from named
   invariant-register ids. **Signing stays outside the substrate**, structurally (§1.4).
3. **The interpreter extension the palette requires** — TASK-718's v1 semantics cannot express a
   durable human wait (§2.6). This is the central design problem of the ticket and Phase A resolves
   it before anything else is built.
4. **Session-state integration** — the TASK-711 state machine drives and reflects interpreter
   progress through an explicit, one-directional mapping (§4 Phase A Task 3).
5. **A seeded platform default consultation definition** whose compiled config reproduces today's
   modernized `HarnessDocWorkflow` stage order, so `design.md` §Error handling's
   *"Temporal unreachable → platform default config"* fallback has something to fall back to.

### 1.2 The reference's nine agent roles are capabilities, not services

`01-invariant-register.md` §3 names nine agent roles. `04-target-architecture.md` red-team §4 warns
that treating them as nine agents is over-specification: *"a reader will build nine services… In
this codebase 'Summarization Agent' and 'Note-taking Agent' are the same SMR call with different
templates; 'Compliance' is a guard plus a service; 'Master/Harness loop' is an orchestrator, not an
agent."*

The mapping is therefore role → **node type(s) or non-node**, and it is exhaustive — every role is
accounted for, including the one that is deferred:

| # | Reference role (register §3) | Palette treatment | Compile target (verified) |
|---|---|---|---|
| 1 | **Master/Harness loop** (T0–T24) | **NOT a node.** It *is* the interpreter — `WorkflowInterpreter` (TASK-718). Its orchestration, caps, retry, degradation and trajectory emission are engine behaviour, never authorable. | `apps/harness/src/harness/temporal/interpreter/workflow.py` (TASK-718 Task 6) |
| 2 | **Compliance** (T1, T5, T18, T21) | **Two node families.** (a) `consultation.consentGate` — TASK-712's `assertConsent` choke point. (b) `consultation.phiHop` — TASK-710's redactor, with `mode: 'pseudonymize' \| 'full'` per artifact class. | (a) **no activity exists today** — TASK-712 must expose one (§2.3, R-3). (b) `apply_redaction` (`activities.py:1753`), retargeted at TASK-710's guardrail endpoint |
| 3 | **Summarization Agent** (T2 — prior-history priming) | `consultation.priming` — loads authorized prior notes within minimum-necessary scope. | **No dedicated activity exists.** `retrieve_context` (`activities.py:1229`) is knowledge-base RAG, not patient prior-history. Design Task 1 decides: new activity vs. a gateway-resolved input (§2.3, R-4) |
| 4 | **Transcription Agent** (T4–T7, T13–T15, T17) | `consultation.captureBinding` — a **binding**, not an executing node. Realtime audio stays on the streaming stack exactly as TASK-724 established for the STT palette; no per-frame audio and no realtime session lifecycle ever enters a Temporal workflow. | `livedoc_start` / `livedoc_stop` (`activities.py:2268`, `:2293`) — HTTP control dispatch only. The ASR itself is `apps/stt` + `SttWsGateway` (`stt-ws.gateway.ts:195-196`) |
| 5 | **Vision Agent** (T6, T18) | **EXPLICITLY DEFERRED — no node type is registered.** §1.3. | — |
| 6 | **NLP/Reasoning Agent** (T5–T12.4, T17) | `consultation.extractEntities` and `consultation.bindTerminology`. **Deterministic linker only** — no node type permits prompt-authored codes (§1.5). | `extract_entities` (`:754`), `persist_entities` (`:980`), `call_mcp_tool` (`:801`) with `MCP_TERMINOLOGY_TOOL = "validate_codes"` (`workflows.py:196`); the linker itself is `apps/nlp/src/nlp/services/ontology_linker.py` |
| 7 | **Note-taking Agent / Composer** (T8, T11–T12, T16, T20, T22) | `consultation.assemblePrompt` + `consultation.synthesize` — debounced, template-bound. | `assemble_prompt` (`:1008`), `generate` (`:1048`); evidence hop `retrieve_context` (`:1229`) |
| 8 | **Verifier / Quality** (T12, T16, T18, T20) | `consultation.sensors` (computational) and `consultation.inferentialSensors` — the TASK-713 eval machinery's runtime siblings; plus the gate itself. | `run_sensors` (`:1281`), `run_inferential_sensors` (`:1548`), aggregation `apps/harness/src/harness/sensors/aggregator.py:98-103,121` |
| 9 | **Clinician** (T0–T24) | **NOT a node.** The actor. Their entry point into the graph is `consultation.hitlGate`; their exit is `approveSummary`, which is outside the substrate entirely (§1.4). | `record_gate_decision` (`:2049`), `escalate_gate` (`:2109`); the durable wait is `workflows.py:1520-1554` |

Persistence nodes (`consultation.persistDraft` → `persist_draft` `:1896`;
`consultation.finalizeAssurance` → `finalize_assurance` `:1955`) belong to no reference role — they
are how the platform makes a step durable, and they are `mandatory` for that reason.

### 1.3 Vision is deferred, and the absence is stated honestly

`dataset.xml` T6 and T6.1 describe imaging attachment, metadata matching against the encounter,
preference for an authenticated radiology report, and image-vs-speech contradiction. **None of it
has a platform substrate.** Verified repo-wide: zero `dicom` / `pydicom` / `radiolog` hits in any
source file, and no `pydicom` dependency in any `pyproject.toml`. What exists is one deliberately
**non-diagnostic** activity, `vision_extract_text` (`activities.py:2636`), whose prompt is
*"Transcribe all legible text in this clinical image verbatim. Do not interpret, diagnose or
summarise."* (`activities.py:2651-2653`, `temperature=0.0` at `:2656`), and a `loop.imaging.measure_lesion`
string that appears **only** in a test asserting it resolves to an `unsupported_action` skip
(`apps/harness/src/harness/tests/unit/temporal/test_consultation_loop_workflow.py:362`; the closed
key set is `LOOP_ACTION_KEYS` at `apps/harness/src/harness/temporal/models.py:1039-1055`).

`04-target-architecture.md` §"What we are NOT doing" already ruled: *"Not building imaging/DICOM
intake (A-18). A genuine platform gap — zero `pydicom` anywhere — but a product-scope decision, not
a safety fix."* This ticket honours that ruling and does **not** register a vision node type.

Registering a `consultation.visionExtract` node bound to `vision_extract_text` would be worse than
registering nothing: it would let a tenant author a graph that *looks* like the reference's imaging
lane while doing OCR, and the reference's imaging invariants (INV-031…INV-038, INV-142,
INV-211…INV-215) would read as satisfied when they are not. **The palette therefore has an imaging
hole, and the hole is named in the palette's own documentation and in `design.md`'s YAGNI ledger.**
The seventeen imaging invariants stay open in the conformance matrix. That is the honest state.

### 1.4 Signing is outside the substrate — structurally, not by convention

`design.md` Plane 1: *"No node type can write `SIGNED`; approval remains `approveSummary`, outside
the substrate, preserving the keystone property by construction."*

Three independent mechanisms make this true, and this ticket adds the third:

1. **TASK-715's registry-assembly assertion #6** — `WorkflowNodeRegistry.register()` throws on *"any
   descriptor whose `activity` or `type` mentions signing."*
2. **TASK-718's acceptance criterion S-6** — *"A test asserts the node registry contains no activity
   reaching `approveSummary` / any `SIGNED` write."*
3. **This ticket's palette-scoped assertion** — a test enumerating the consultation palette's
   compile targets and asserting each is in the verified activity list of §2.2, none of which
   touches `Consultation.status = SIGNED`. `02-conformance-matrix.md` P-01 confirms the single write
   site is `summary.service.ts:978` inside `approveSummary`, whose sole caller is the HTTP route
   `consultation.controller.ts:1295`.

The HITL gate node **records a decision** (`record_gate_decision`) and **resolves a wait**. It does
not sign. Signing is the clinician calling the approve route, after the run.

### 1.5 No prompt-authored codes — the palette makes this structural

TASK-702 (`icd10-prompt-containment`) removes free-write ICD-10 instructions from the seeded prompt
catalog and ships a data migration for drifted deployed rows. That fixes today's templates. It does
not stop a **tenant author** writing a new prompt that asks the model for codes.

This palette closes that: `consultation.bindTerminology` is the **only** node type in the palette
that may produce a code, its config schema has no free-text prompt field, and it binds to a verified
lookup — the deterministic `OntologyLinker` (`apps/nlp/src/nlp/services/ontology_linker.py:196`,
`link()` at `:204`, *"all-None when unrecognized"*) and/or the MCP `validate_codes` tool. A
`consultation.synthesize` node's config may not declare a code-emitting output. Validator rules
CR-16/CR-17 (§4 Phase A Task 2) enforce it.

The linker's coverage must be stated, not hidden: **40 concept entries expanding to 67 normalized
aliases** (`ontology_linker.py:94-184`), self-described at `:90-93` as *"an illustrative-but-accurate
subset, not a full ontology"*, with a deliberate omission documented at `:117-121` (bare "diabetes"
is unmapped; only `type 2 diabetes` / `t2dm` map). Per red-team §9 the property that matters is
*"no code is emitted without a verified match against a controlled source; unmapped terms are marked
unmapped and surfaced"* — and the coverage gap must be **visible**, which is CR-17.

### 1.6 Explicitly OUT of scope

- **The engine.** No change to `WorkflowDefinition` (TASK-715), the compiler/validator engine
  (TASK-716), the Studio (TASK-719), or the runs read model (TASK-723). Per D4, palettes onboard
  without engine changes — **with one stated exception**: the interpreter's signal/wait semantics
  (§2.6). That exception is negotiated with TASK-718's versioning rules, not smuggled in.
- **Imaging / Vision** — §1.3.
- **Per-section HITL** (`NoteSection`, A-12). The gate node records one aggregate verdict, exactly as
  `HarnessGateDecisionRequest` does today (`harness-internal.dto.ts:534-572`). Section-level
  approval is the `note-sections` epic and is not in this program's backlog.
- **Contradiction items** (A-04). No `contradiction` node type; the reference's T6.1 / T12.4 lanes
  have no substrate (zero `contradiction` members in `SysEventType`).
- **Deleting the legacy generator** — TASK-732.
- **Per-department assignment of the resulting definition** — TASK-733.
- **Building consent, the redactor, or the state machine.** Those are TASK-712, TASK-710, TASK-711.
  This ticket *binds* to them and **fails loudly** if they are absent (§3.3 pitfall 2).

---

## 2. Current State Evaluation

Verified against the live tree on branch `feat/loop` (2026-08-16). Exclusions applied:
`.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`,
`**/.next/**`, `docs/archive/**`.

### 2.1 What exists of the substrate today: nothing

Verified absent from the code tree at authoring time — all are planned by dependency tickets:
`WorkflowDefinition` (TASK-715), the node registry (TASK-715), the compiler/validator (TASK-716),
`apps/harness/src/harness/temporal/interpreter/` (TASK-718), `NoteGenerationService` (TASK-704).
Three of this ticket's dependencies do not even have a README yet at authoring time: **TASK-712**
(`consent-abac`), **TASK-716** (`workflow-compiler-validator`), **TASK-720**
(`palette-summarization`). Every reference to them below is by number + backlog slug, and Phase A
Task 0 re-derives their landed shape before anything is built.

### 2.2 The harness activity inventory — the verified compile targets

`apps/harness/src/harness/temporal/activities.py` declares **28 `@activity.defn` functions**. None
uses a `name=` argument, so **every activity name is its Python function name** — this matters
because TASK-715's `WorkflowNodeDescriptor.activity` is a string validated against
`SANCTIONED_ACTIVITY_KEYS` *"derived from `apps/harness/src/harness/temporal/activities.py`"*.

The subset this palette compiles to:

| Activity | `@activity.defn` : `def` | Input model | Palette node |
|---|---|---|---|
| `fetch_policy` | 654 / 655 | `models.py:201` | engine-internal (config load) |
| `extract_entities` | 754 / 755 | `models.py:409` | `consultation.extractEntities` |
| `call_mcp_tool` | 801 / 802 | `models.py:453` | `consultation.bindTerminology` |
| `persist_entities` | 980 / 981 | `models.py:498` | `consultation.extractEntities` (persist step) |
| `assemble_prompt` | 1008 / 1009 | `models.py:510` | `consultation.assemblePrompt` |
| `generate` | 1048 / 1049 | `models.py:568` | `consultation.synthesize` |
| `retrieve_context` | 1229 / 1230 | `models.py:612` | `consultation.retrieveEvidence` |
| `run_sensors` | 1281 / 1282 | `models.py:648` | `consultation.sensors` |
| `run_inferential_sensors` | 1548 / 1549 | `models.py:682` | `consultation.inferentialSensors` |
| `apply_redaction` | 1753 / 1754 | `models.py:981` | `consultation.phiHop` (retargeted — §2.4) |
| `persist_draft` | 1896 / 1897 | `models.py:782` | `consultation.persistDraft` |
| `finalize_assurance` | 1955 / 1956 | `models.py:829` | `consultation.finalizeAssurance` |
| `record_gate_decision` | 2049 / 2050 | `models.py:900` | `consultation.hitlGate` (decision leg) |
| `report_progress` | 2077 / 2078 | `models.py:958` | engine-internal |
| `escalate_gate` | 2109 / 2110 | `models.py:915` | `consultation.hitlGate` (escalation leg) |
| `livedoc_start` | 2268 / 2269 | `models.py:1316` | `consultation.captureBinding` |
| `livedoc_stop` | 2293 / 2294 | `models.py:1316` | `consultation.captureBinding` |

Registration lists: `DOCUMENT_ACTIVITIES` (`activities.py:2346-2363`, 16 entries), `LOOP_ACTIVITIES`
(`:2745-2750`), `REASONING_ACTIVITIES` (`:2756-2763`). Workflows: `HarnessPingWorkflow`
(`workflows.py:261`), `HarnessDocWorkflow` (`:279`, `@workflow.run` at `:406`), `SpecialistWorkflow`
(`:1802`), `ConsultationLoopWorkflow` (`:1876`). **One task queue**, `"harness-task-queue"`
(`core/config.py:41`), bound at `worker.py:255`; child workflows deliberately share the parent's
queue (`worker.py:257-262`).

### 2.3 Two capabilities the reference needs have no activity at all

**Consent.** There is no consent activity and no consent code anywhere in the harness. The only
artifacts are two never-written enum members — `CONSENT_GIVEN` / `CONSENT_WITHDRAWN` at
`packages/database/src/prisma/db_main/harness.prisma:24-25`, mirrored at
`packages/domains/src/enums/generated/HarnessAuditAction.ts:10-11` and, as a filter option a user can
select for rows that cannot exist, `apps/admin-console/src/features/harness-ops/api/types.ts:16-17`.
A repo-wide grep for those two identifiers returns **only those three declaration sites**. The only
`consent` string inside `apps/harness/src` is a synthetic test fixture value
(`tests/unit/eval/test_clinical_golden_source.py:89`).

TASK-712 builds `IConsultationConsentService.assertConsent(tenantId, externalPatientId, purpose,
scope)` in `packages/applications` as a non-HTTP choke point (`04-target-architecture.md` §5). **It
does not, per that design, expose a Temporal activity.** Phase A Task 1 must decide how the
consent-gate node reaches it — the two candidates are a new harness activity POSTing to a gateway
internal route (the pattern every other harness activity already uses —
`harness-internal.controller.ts` hosts 12 such routes), or a gateway-resolved pre-flight the
dispatcher performs before starting the run. **Do not invent a third pattern.**

**Prior-history priming.** `retrieve_context` (`activities.py:1229`) is knowledge-base RAG over
Qdrant, not patient prior-note retrieval. A-21 records that the *data linkage* exists
(`SummaryMeta.caseNoteIds` / `preSummaryIds`, tenant-revalidated both directions) but that
**zero `Primed` hits exist repo-wide** and no screen consumes `getPatientHistory`. So
`consultation.priming` has no compile target today either.

Both gaps are real, both are named in the plan, and neither is solved by pretending an adjacent
activity fits.

### 2.4 PHI: what `apply_redaction` actually is today

`apply_redaction` (`activities.py:1753`) exists and is a genuine post-generation transform, but its
current job is **DNA style-redaction**, driven by `ApplyRedactionInput` (`models.py:981`). The
platform's other PHI machinery is the *egress* guard: `PhiRedactor` (`guards/phi/redactor.py:132`),
`redact` (`:163`), `ensure_safe_for_cloud` (`:174`), `PhiEgressBlocked` (`:52`), and
`guards/phi/egress.py` — `ensure_egress_safe` (`:37`), `ensure_mcp_args_safe` (`:80`),
`ensure_inferential_egress_safe` (`:124`). F-01 records that this guard is a **fail-open allowlist**
(`redactor.py:185-186`), which TASK-706 fixes.

TASK-710 builds the actual redactor: `POST /api/guardrail/redact` returning
`{sanitized_text, entities[]}`, plus `GuardrailPhiRedactor implements IPhiRedactor` with a DI
provider, wired at the STT→NLP hop and the DNA-corpus hop, with modes `pseudonymize` / `full`
decided per artifact class by its Task 0.

**Consequence for this ticket:** `consultation.phiHop`'s compile target is *not* today's
`apply_redaction` semantics — it is TASK-710's redactor reached through it (or through a new
activity, decided in Phase A Task 1 against TASK-710's landed shape). If TASK-710 has not landed,
the node registers with a **loud** binding — a `NotImplementedError`-shaped failure, never a silent
pass-through — following TASK-724's precedent for `stt.phiHop`, which states it exactly:
*"a workflow that reaches this node before TASK-710 lands must fail loudly in the Workbench sandbox,
not pass transcript through unredacted while claiming the hop ran."*

### 2.5 The HITL gate machinery that already works

All inside `HarnessDocWorkflow` (`apps/harness/src/harness/temporal/workflows.py`):

- Signal `approval` — `:336` (`@workflow.signal`) / `:337`; body sets `self._approval` at `:339`.
- Signal `edit` — `:341` / `:342`; sets `_edited`, `_ever_edited`, `_edited_content`,
  `_edited_content_ref`, `_edited_version_id` (`:361-365`).
- Query `phase` — `:358` / `:359`.
- **The durable wait**, `:1520-1554`: `self._phase = "GATE"` (`:1521`);
  `deadline = gate.gate_sla_seconds` (`:1523`); `workflow.patched("task-458-gate-terminal-abandon")`
  (`:1529`); `while self._approval is None:` (`:1530`);
  `await workflow.wait_condition(lambda: self._approval is not None, timeout=timedelta(seconds=deadline))`
  (`:1533-1536`); `except TimeoutError:` (`:1537`) → `escalate_gate` (`:1540-1550`) with
  `reason="gate_sla_abandoned" if terminal else "gate_sla_breached"` (`:1545`); subsequent waits use
  `gate.gate_escalation_seconds` (`:1552`); terminal `break` at `:1554` once
  `escalations >= gate.gate_max_escalations`.
- **Timeout never signs** — the abandon branch (`:1563-1573`) returns `approved=False,
  clinician_id=None` and deliberately skips `record_gate_decision`; the draft stays `PENDING_REVIEW`.
  This is `02-conformance-matrix.md` P-02, independently re-verified in `03-compliance-posture.md` §1.

Gateway contract: `HarnessGateDecisionRequest`
(`packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts:534-567`) —
`tenantId` (`:535`), `userId?` (`:539`), `decision?` `"SIGNED" | "REJECTED"` (`:544`),
`gateDecision?` `"PASS" | "REGEN" | "FLAG"` (`:549`), `contextItemVersionId?` (`:554`),
`attestationHash?` (`:559`), `clinicianId?` (`:564`); response `{ recorded: boolean }` (`:570-572`).
Consumed at `apps/api/src/modules/consultation/harness-internal.controller.ts:309-312` and
`harness-internal.service.ts:1211`. Escalation reasons `HARNESS_ESCALATION_REASONS =
['gate_sla_breached','gate_sla_abandoned']` (`harness-internal.dto.ts:585`) → WORM actions
`GATE_ESCALATED` / `GATE_ABANDONED` (`harness.prisma:56-57`).

### 2.6 **The central problem: TASK-718's v1 interpreter cannot express this palette**

TASK-718's Acceptance Criteria fix v1's semantics precisely, and three of them collide with the
consultation timeline:

| TASK-718 v1 constraint | Where | Consultation requirement it blocks |
|---|---|---|
| *"linear stages + single-level fan-out with an all-settled join — **no conditional edges, no loops**, no sub-graphs"* | AC bullet 2; Task 1 note *"**No edges array** — v1 has no conditional routing"* | `dataset.xml` T12 is a **loop**: *"Master/Harness loop periodically retriggers NLP/Reasoning and Note-taking Agents on debounced context changes… repeats until stop."* T7 is the transcription loop. T12.3 is conditional regeneration of affected sections only. |
| *"The interpreter's signal allow-list (**v1: `cancel` only**) and query surface (v1: `state`)"* | Task 1 item 5; Task 6 *"`@workflow.signal(name="cancel")` — the **ONLY** signal"*; Task 10 *"allow-listed by name in code"* | The HITL gate needs the `approval` signal and the authorship guard needs `edit` (`workflows.py:336-365`). Without them there is **no way for a clinician to resolve a gate node**. |
| Node dispatch is `kind: "activity" \| "child_workflow"` with a clamped `default_timeout` | Task 4 `NodeSpec` | A gate SLA is hours-to-days of `wait_condition`, not an activity timeout. `MAX_NODE_TIMEOUT` (Task 4 `caps.py`) is sized for activities. |

TASK-718 anticipated exactly this and ruled on process, not outcome — R-2: *"The fan-out join could
grow into a general DAG under palette pressure. STT (TASK-724) and Consultation (TASK-731) may want
conditional routing. **Deliberate: v1 refuses it and the schema enforces the refusal. Widening is a
new ticket with its own patch era, not a quiet edit.**"*

**This ticket is that new ticket for the signal/wait axis.** Phase A Task 1 must choose between three
options and defend the choice; Phase B implements it under TASK-718 Task 2's versioning rules:

| Option | Shape | Cost |
|---|---|---|
| **(A) Extend the interpreter** — add an `approval`/`edit` signal pair, a `kind: "durable_wait"` node, and a separate `MAX_GATE_WAIT` cap. | The gate is a first-class node. | Changes the shared dispatch loop ⇒ **requires `workflow.patched()` + a new replay fixture** (TASK-718 Task 2 rules (a)–(c)). The signal allow-list widens for *every* palette, including sandboxed Workbench runs. |
| **(B) Delegate the gate to a child workflow** — `consultation.hitlGate` is `kind: "child_workflow"` starting the **existing, replay-fixtured** gate machinery, which already owns `approval`/`edit`, the escalation ladder and the terminal-abandon patch era. | Reuses ~1,330 LOC of frozen, 11-patch-era, 12-replay-fixture code. The interpreter's own signal surface stays `cancel`-only. | The child must be addressable for signalling; the clinician's approve call must reach the child, not the interpreter. Two workflow ids to observe in the runs tab. |
| **(C) Split the run at the gate** — the interpreter walks stages up to and including the sensors, persists, and **terminates**; the gate is the existing `HarnessDocWorkflow` phase, resumed by the approve route. | No interpreter change at all. | Two runs per consultation; the runs tab must join them; `design.md`'s *"the canvas replays a run as an overlay on the authored graph"* gets a seam. |

**Recommendation carried into Phase A Task 1: (B).** It preserves TASK-718's v1 refusal
(no interpreter loop, no conditional edges, `cancel`-only interpreter signals), reuses the one piece
of this platform the assessment calls *"the hardest property to get right, and it is right"*, and
keeps the clinician's signal path on code that already has replay fixtures. It is not a free choice
and Phase A must defend it against (A) and (C) rather than adopt it because this README said so.

**The loop constraint is separate and is resolved by scope, not by extension.** The reference's
debounce/retrigger loops (T7, T12) are *live-session* behaviour, and live-session behaviour already
lives outside Temporal: `LiveDocumentationService`
(`live-documentation.service.ts:307`, 2434 LOC) owns the debounce (A-40: ~3 final segments or ~5 s
idle, `:889`, `:1608`) and the STT stream attachment (`attachSttStream` at `:1569`, called from
`:554` and `:585`). **The interpreter walks the post-capture, one-shot pipeline** — exactly the
stages `HarnessDocWorkflow` walks today — and the live loop stays where TASK-724 put the realtime
STT stack. `consultation.captureBinding` is therefore a *binding* node (it dispatches
`livedoc_start`/`livedoc_stop`), not a loop the tenant authors. Phase A Task 1 records this as a
scope decision with the same reasoning TASK-724 used, and CR-18 enforces it.

### 2.7 The context-schema substrate the palette's data model rests on

`packages/database/src/prisma/db_main/consultation-context-schema.prisma`:
`ConsultationContextSchema` (`:19-83`) — `scope ConsultationContextSchemaScope @default(TENANT)`
(`:38`), `departmentId String?` + relation (`:39-40`), `status` (`:42`), `pinnedVersionNumber Int?`
(`:47`, NULL ⇒ never served), `isDefault` (`:53`);
`ConsultationContextSchemaVersion` (`:89-129`) — immutable, `definition Json @db.JsonB` (`:111`) with
the comment at `:105-110` naming the five primitives and stating an unknown primitive is **rejected
at publish**, `checksum` (`:116`).

The definition contract, `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts`:
`CONTEXT_PRIMITIVES = ['STREAM_AUDIO','TEXT','DOCUMENT','IMAGE','STRUCTURED']` (`:35`),
`CONTEXT_PHI_CLASSES = ['PHI','NON_PHI']` (`:38`), `CONTEXT_CARDINALITIES` (`:39`),
`CONTEXT_LIFECYCLES = ['PRE','DURING','POST','ANY']` (`:40`),
`CONTEXT_PRODUCERS = ['CLIENT','AGENT','SYSTEM']` (`:41`), `CONTEXT_KIND_KEY_PATTERN` (`:47`),
`MAX_DECLARED_KINDS = 64` (`:50`), `OUTPUT_KEYS` (`:67`), `ContextKindDeclaration` (`:91-104`),
`ContextOutputDeclaration` (`:106-112`), `ContextSchemaDefinition` (`:114-118`), `canonicalJson`
(`:346`).

**Three palette requirements fall out of this almost free** (`04-target-architecture.md` §2):
`producedBy` is the origin class; **`phiClass` tells the PHI hop which items need sanitizing** — this
is what makes CR-14's "artifact class" checkable rather than hand-waved; and `outputs[].key` is the
vocabulary a synthesis node's write scope is drawn from.

**And one thing it deliberately is not:** the definition grammar has **no node/step/action field**.
`kinds[]` and `outputs[]` describe data, not workflow steps. The only existing action vocabulary is
the closed 7-key `LOOP_ACTION_KEYS` (`models.py:1039-1055`) mirrored gateway-side as
`AGENT_ACTION_KEYS` (`packages/applications/src/services/departmentAgent/constants.ts:304-312`):
`livedoc.start`, `livedoc.stop`, `vision.extract_text`, `document.extract_text`,
`nlp.extract_entities`, `harness.finalize`, `client.emit`. Its registry
(`workflows.py:1665-1699`) carries `implemented` / `lifecycle` / `derives_context` flags and its
dispatch map is at `workflows.py:1770-1775`; an unknown key yields an observable
`action.skipped` / `unsupported_action` (`models.py:1058-1065`, `workflows.py:1638`). **That registry
is the shape TASK-718 Task 4 tells the node registry to imitate**, and it is prior art this palette
should reconcile with rather than duplicate (R-8).

The platform floor `PRIMARY_ONLY_OUTPUT_KINDS = frozenset({"note","gate"})` (`models.py:1093`) —
*"a tenant misconfiguring a specialist's write scope must not be able to hand that ownership away"* —
is the enforcement placement this palette copies for CR-07.

### 2.8 The terminology validator's real position in the pipeline

The assessment says the MCP terminology validator *"is opt-in, runs after persistence, gates nothing."*
Verified, with one correction: it runs **after entity persistence** but **before** prompt assembly
and **before** `persist_draft` — so it is not a post-draft validator.

- Tool constant `MCP_TERMINOLOGY_TOOL = "validate_codes"` — `workflows.py:196`.
- Server selection `_select_mcp_server(servers, tool)` — `workflows.py:199-209`; `None` ⇒ step
  skipped entirely.
- Call site "1a) MCP terminology validation" — `workflows.py:633-662`, guarded at `:643` by
  `if mcp_tools_enabled and transcript_entities and workflow.patched("task-516-mcp-tools")`.
- **Opt-in confirmed:** `mcp_tools_enabled = policy.mcp_tools_enabled is True` (`:528`), else `False`
  (`:552`); the policy field defaults `null` ⇒ OFF
  (`packages/applications/src/services/harness-policy/harness-policy.service.ts:133`, `:208`).
- **Degrade-only:** `mcp_degraded = mcp_result.degraded` (`:653`), `except ActivityError:
  mcp_degraded = True` (`:654-657`), folded into `reduced_assurance` (`:680`). It never blocks,
  never fails the run, and never corrects a code.

CR-16/CR-17 turn "opt-in and non-gating" into "authorable and validated": a consultation graph that
declares a code-producing output must contain a `consultation.bindTerminology` node, and unmapped
terms must reach a declared `unmapped` output.

### 2.9 Session state today, and what TASK-711 changes

`ConsultationStatus` (`enums.prisma:278-286`) has seven members: `OPEN`, `RECORDING`,
`DRAFT_PENDING_SENSORS`, `PENDING_REVIEW`, `SIGNED`, `CLOSED`, `REOPENED` — the last two written by
no code. TASK-711 adds `PRIMED`, `DRAINING`, `TIMED_OUT` (and designs `PAUSED`, deferred), adds
`ConsultationEntity.transitionTo(next, actor, reason)` with an explicit legality matrix, deletes
`metadata.status`, and adds `Consultation.degradedReasons String[]` so "degraded" is a flag on the
active phase, not a state that erases it.

TASK-711's legality matrix already reserves the transitions this palette drives, including
`PENDING_REVIEW → DRAFT_PENDING_SENSORS` (return-for-regen) as **reserved but disabled**, throwing
with the owning epic named. Phase A Task 3 maps interpreter phases onto that matrix and must not
invent a transition it does not contain.

---

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this work

| Rule + section | Binding constraint |
|---|---|
| `.claude/rules/06-python-services.md` §Temporal | Workflows are DETERMINISTIC — no I/O, no network, no `random`/wall-clock/env reads inside `@workflow.defn`; side effects live in activities with bounded `RetryPolicy`; activities must be idempotent. **Workflow changes must keep replay compatibility — run `test_replay_compat` before shipping changes to `workflows.py`.** |
| `.claude/rules/06-python-services.md` §Pitfalls | The harness CI suite is hermetic (Temporal/LLM/reranker stubbed, Qdrant in-memory, no DB/Redis) and runs with `-x`. Keep every new test hermetic — `InMemoryBlobStore` + `WorkflowEnvironment.start_time_skipping()`. |
| `.claude/rules/04-application-services.md` §Service Folder Pattern / §NEVER | Registry descriptors and any new service follow `IXxxService.ts` + symbol DI + module + DTO mapper + `__tests__/`. Never import `@arcaai/database` runtime code; never return entities. |
| `.claude/rules/03-domain-layer.md` §Generated Code Discipline | If this ticket touches a Prisma model (it should not — §1.6), **never run `pnpm gen:mapper`**; hand-author entity/factory/mapper/repository and reconcile with `gen:entity` + `gen:factory`. |
| `.claude/rules/02-database-prisma.md` §Seeds | The platform default definition is a seed row; seeds are phased and FK-ordered, `XX-name.ts`. Reserved SYSTEM tenant `00000000-…`. **Deployed rows do not re-seed** — the default definition needs an idempotent data migration if it must reach existing tenants. |
| `.claude/rules/05-nestjs-api.md` §Definition of Done | Any new route carries `@Public()` or a permission decorator (the boot audit refuses to start otherwise); versioned PATCH routes carry `@RequiresIfMatch()`. |
| `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers | Interpreter caps overridable at runtime are `global-kv` with `failMode: 'open-to-default'`; **provider/model SELECTION and secrets are `closed`**. A gate SLA is a tuning knob; a consent verdict is not. |
| `.claude/rules/01-development-workflow.md` §TDD | Failing test first, always seen RED. For the replay fixture specifically, TASK-718 Task 9's discipline applies: deliberately break determinism, watch replay FAIL, revert, paste both. |

### 3.2 SOTA practice this plan follows, and why

- **Registry-as-code, config-as-data (D2/D3).** The palette is a set of code-owned descriptors; the
  tenant authors a configuration. There is no path from tenant input to executable code. This is
  what makes "full build power on day one" survivable.
- **The audit artifact becomes the test suite.** `design.md` §Testing strategy: *"every
  mandatory-subgraph and forbidden-edge rule gets a passing and a failing graph fixture — the audit
  artifact becomes executable tests."* Each CR-nn rule in Phase A Task 2 ships exactly that pair.
- **Delegate rather than re-implement a proven durable wait.** Option (B) in §2.6. The gate machinery
  has 11 patch eras and 12 replay fixtures; re-expressing it inside a new interpreter loop would be
  the single riskiest line of code in the program.
- **Fail loudly on an unbuilt dependency, never silently pass.** TASK-724's `stt.phiHop` precedent,
  applied to `consultation.consentGate`, `consultation.phiHop` and `consultation.priming`.
- **Enforcement outside the agent's own code.** `PRIMARY_ONLY_OUTPUT_KINDS` (`models.py:1093`) and
  `DepartmentAgent.writeScope` validation (`departmentAgent.service.ts:769-789`) are the repo's own
  precedent: the thing being constrained does not get to check its own constraint.
- **One schema, three consumers.** Node config schemas are authored in the
  `@arcaai/json-schema-subset` authorable subset (`packages/json-schema-subset/src/json-schema-subset.ts`)
  so the same document validates in the TS validator, the Studio inspector, and the Python
  interpreter — `design.md` §Testing strategy's contract test.

### 3.3 Pitfalls specific to THIS ticket

1. **`workflow.patched()` and the "cheap operand first" idiom.** Any change to the interpreter's
   command sequence needs a patch gate, a NEW replay fixture captured under the new era
   (`_capture_replay_fixture.py`), and the cheap-operand-first ordering
   (`workflows.py:767-780`) so `patched` is never evaluated on legacy replays. TASK-718 Task 2
   is the governing document; read it before touching `interpreter/workflow.py`.
2. **Three dependencies may not have landed.** TASK-712, TASK-716 and TASK-720 have no README at
   authoring time. Phase A Task 0 verifies each and **STOPs** rather than guessing — the same
   discipline TASK-724 Task 1 applies to TASK-720.
3. **`apply_redaction` is not TASK-710's redactor** (§2.4). Binding `consultation.phiHop` to it
   as-is would produce a node that claims to sanitize and does something else.
4. **`retrieve_context` is not prior-history priming** (§2.3). Same failure mode.
5. **The MCP terminology step is opt-in and degrade-only** (§2.8). A validator rule that assumes it
   gates anything is wrong; CR-16 constrains the *graph*, not the tool's runtime behaviour.
6. **Do not register a vision node** (§1.3), and do not let the imaging hole be closed by
   `vision_extract_text`, whose own prompt forbids interpretation.
7. **Sandbox mode must skip `external_write` nodes** (TASK-718 Task 11). Every consultation node
   that writes a `ContextItem` — `persistDraft`, `finalizeAssurance`, `extractEntities`'s persist
   step, `captureBinding` — must declare `external_write=True`, or the Workbench will write real
   clinical rows from a sandboxed run.
8. **`consultation.hitlGate` must never be reachable in sandbox mode at all.** A sandboxed gate that
   "approves" is the exact shape of the forgery `03-compliance-posture.md` §3 documents. It is
   `external_write=True` and therefore `SKIPPED(sandbox)` — assert it.
9. **Node timeouts are tighten-only** (TASK-718 S-5, `effective = min(config, cap)`). A tenant
   raising a gate SLA past the platform cap must be clamped, not honoured.
10. **`consultation_id` may be optional on `TrajectoryContext`** after TASK-718 Task 7's
    additive-optional extension. A consultation run *does* have one — pass it; do not overload
    `sessionId`.
11. **The gate's timeout outcome is `TIMED_OUT`, never anything that reads as approved.** This is the
    single most load-bearing invariant in the register (INV-001 and 19 siblings) and the one property
    the assessment confirms already holds. Do not renovate it — CR-09 asserts it stays.

---

## 4. Implementation Plan

> **Phase A is the XL design gate.** The backlog assigns this ticket `T4 design → T3 build`. No code
> is written until Tasks 1–3 are approved. Phase B's interpreter change is the highest-risk item in
> the program after the migration itself.

---

### Phase A — Design (gate)

#### Task 0 — Verify the landed shape of every dependency; STOP on divergence
- **Agent:** T3 · sonnet-5 · medium
- **Files:** none (verification note in the PR description; findings recorded in §7)
- **Approach:** For each dependency, confirm the concrete API surface with `file:line`, exactly as
  TASK-724 Task 1 does for TASK-720:
  - **TASK-715/720** — the landed `WorkflowNodeDescriptor` field names, `SANCTIONED_ACTIVITY_KEYS`'s
    derivation, the registry test-suite command, and the per-node-type file convention TASK-720
    established.
  - **TASK-716** — the `ValidationReport` shape, how a rule is registered, and the golden-fixture
    harness (pass/fail graph pairs).
  - **TASK-718** — `NodeSpec` fields (`key, implemented, activity, kind, critical, external_write,
    default_timeout, default_max_attempts, entitlement_key`), `caps.py` constants,
    `contracts/execution-semantics.md`, `contracts/versioning.md`, `contracts/compiled-config.schema.json`,
    and the dispatcher routes at `apps/harness/src/harness/api/endpoints/interpreter.py`.
  - **TASK-710** — the redactor's landed signature (`IPhiRedactor.redact(text, mode)`), the guardrail
    route (`POST /api/guardrail/redact`), and Task 0's per-artifact-class mode decision.
  - **TASK-711** — the final `ConsultationStatus` members and `transitionTo`'s signature + legality
    matrix.
  - **TASK-712** — `assertConsent`'s signature, whether a harness-reachable surface exists, and the
    `PatientConsent` key `(tenantId, externalPatientId)`.
  - **TASK-704** — where `NoteGenerationService` landed and its dispatch contract.
  If any is absent or materially different, **STOP and flag HUMAN-GATED in §6** rather than guessing.
- **Verify:** a written note listing every confirmed shape with `file:line`. Phase A Task 1 does not
  start without it.

#### Task 1 — Author the palette contract: role→capability→node mapping and the interpreter-semantics decision
- **Agent:** T4 · opus-5 · xhigh
- **Files:**
  - create `docs/implementation/TASK-731-Palette-Consultation/contracts/palette-contract.md`
  - create `docs/implementation/TASK-731-Palette-Consultation/contracts/node-types.md`
- **Approach:**
  1. Reproduce §1.2's role→node table with, for each node type: `type` key, category, safety class
     (`mandatory` / `locked` / `optional`), `critical`, `external_write`, config JSON schema (in the
     authorable subset), input/output ports keyed to `CONTEXT_PRIMITIVES`, the compile-target
     activity by verified name, and the register invariants it serves.
  2. **Resolve §2.6's central decision.** Argue (A) vs (B) vs (C) on: replay-compat blast radius,
     sandbox safety, runs-tab observability, and the signal surface widened for other palettes.
     Record the choice, the reasoning, and what would falsify it. If (B), specify how the child
     workflow is addressed for signalling and how the clinician's approve call reaches it.
  3. **Record the loop-scope decision** (§2.6 last paragraph) with TASK-724's reasoning form: the
     live debounce/retrigger loops stay on `LiveDocumentationService`; the interpreter walks the
     one-shot post-capture pipeline; `consultation.captureBinding` is a binding node.
  4. **Resolve the two missing compile targets** (§2.3): how `consultation.consentGate` reaches
     TASK-712's `assertConsent`, and what `consultation.priming` binds to. Both answers must be one
     of the patterns already in the tree (a harness activity POSTing to a
     `harness-internal.controller.ts` route, or a dispatcher pre-flight), never a new pattern.
  5. **State the imaging hole** (§1.3) in the contract itself, with the invariant ids left open, so
     the palette's own documentation carries the gap rather than an issue tracker.
  6. Reconcile with `LOOP_ACTION_KEYS` / `AGENT_ACTION_KEYS` (§2.7): state whether the palette's node
     types supersede, extend, or coexist with that closed 7-key vocabulary. Coexistence needs a
     written rule for which one a runtime dispatch consults.
- **Verify:** a reviewer can answer, from the document alone: "what happens when the gate SLA
  expires", "which node writes the draft", "why is there no vision node", and "what changes in the
  interpreter and why is that safe". Reviewed by a second T4 agent before Task 2.

#### Task 2 — Author the consultation validator rule set + mandatory-subgraph spec
- **Agent:** T4 · opus-5 · xhigh
- **Files:** create `docs/implementation/TASK-731-Palette-Consultation/contracts/validator-rules.md`
- **Approach:** The mandatory subgraph is
  `consent → capture → PHI → synthesis → verifier → HITL gate`, with **signing outside**. Express it
  as TASK-716 rules, each with an id, a category matching the register's own taxonomy, the named
  invariants it derives from, the rejection message, and a pass/fail golden fixture pair.
  The initial rule set — this is the deliverable, not an illustration:

  **`consent-abac`**
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-01** | A consultation graph MUST contain **exactly one** `consultation.consentGate`, and it MUST be in the first stage. No node may precede it. | INV-003, INV-004, INV-201 |
  | **CR-02** | No node that reads patient history or chart data may appear in a stage at or before the consent gate. | INV-006, INV-009, INV-015, INV-193, INV-198 |
  | **CR-03** | Every node performing a tool/MCP call MUST declare a purpose scope in its config; a node without one is rejected. | INV-007, INV-067, INV-232 |
  | **CR-04** | `consultation.consentGate` is `safetyClass: mandatory` and MUST NOT declare an `entitlement` — a plan may not gate off the consent check. (Palette-scoped restatement of TASK-715's registry assertion #4.) | INV-004, INV-005 |
  | **CR-05** | Any node that widens retrieval scope beyond the graph's declared minimum-necessary scope MUST be a distinct, separately-audited node — a single node may not both retrieve and widen. | INV-015, INV-016, INV-192, INV-196, INV-197 |

  **`hitl-authority`**
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-06** | Exactly one `consultation.hitlGate`, and it MUST be in the terminal stage. No node may execute after it. | INV-144, INV-146, INV-159 |
  | **CR-07** | Every node that writes `ContextItem.content` MUST declare `occ: true` in its descriptor; a graph containing a content-writing node without it is rejected. (The authorship protection of TASK-709 made structural.) | INV-029, INV-052, INV-085, INV-092, INV-133, INV-152, INV-219, INV-237 |
  | **CR-08** | No node in the palette may write a `SIGNED` status or reach `approveSummary`. Asserted over the palette's compile targets, not just the registry. | INV-159, INV-179, INV-186 |
  | **CR-09** | A node whose output feeds a note section MUST NOT be able to write over a section whose `authorClass` is clinician — expressed here as: content-writing nodes declare their `outputKey` set, and a graph declaring an output key outside the tenant's context-schema `outputs[]` is rejected. (Reuses `writeScopeProblems`' vocabulary, `departmentAgent/constants.ts:242-277`.) | INV-029, INV-094, INV-235 |

  **`timeout-approval`**
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-10** | `consultation.hitlGate`'s SLA config is clamped tighten-only against the platform cap, and its **timeout terminal MUST be the unsigned/`TIMED_OUT` outcome**. No config value may make a timeout produce an approved artifact. | INV-001, INV-113, INV-124, INV-130, INV-147, INV-161, INV-162, INV-175, INV-181, INV-186 |
  | **CR-11** | No node may declare an output binding that marks an artifact "final", "approved" or "signed" on any terminal other than an explicit gate approval. | INV-148, INV-182, INV-183 |

  **`partial-vs-final`**
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-12** | Any node consuming transcript input MUST declare `requiresFinalized: true`. A graph binding an extraction or synthesis node to a partial-transcript output is rejected. (Preserves P-16, the `isFinal` gating that is correct today.) | INV-023, INV-027, INV-137, INV-208, INV-210 |
  | **CR-13** | A reconciliation node MUST sit between the capture binding and the final synthesis pass; a graph that feeds live capture output straight into the terminal synthesis stage is rejected. | INV-134, INV-135, INV-137, INV-176 |

  **`degradation`**
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-14** | Only `consultation.consentGate` and `consultation.hitlGate` may be `critical: true`. Every other node degrades visibly and its stage siblings complete — a failing sensor must not fail the run. | INV-072, INV-073, INV-075, INV-128, INV-131, INV-132 |
  | **CR-15** | A graph producing an artifact whose context-schema `phiClass` is `PHI` **and** whose lifecycle is retained/derived/cross-patient MUST contain a `consultation.phiHop` with `mode: 'full'` upstream of it. `pseudonymize` is required upstream of any NLP-consuming node. (`phiClass` and `lifecycle` come from `context-schema-definition.ts:38,40`.) | INV-026, INV-136, INV-017, INV-080, INV-165, INV-169 |
  | **CR-16** | A graph may not declare a stage-level abort; force-stop applies to the timed-out node only. | INV-074, INV-075, INV-125 |
  | **CR-17** | A node whose absence would silently drop an artifact (capture, persist) is `mandatory`; a graph missing one is rejected rather than producing a silently shorter pipeline. | INV-019, INV-126, INV-205 |

  **`terminology`** (the TASK-702 structural closure)
  | Rule | Statement | Register ids |
  |---|---|---|
  | **CR-18** | Only `consultation.bindTerminology` may produce a clinical code. A `consultation.synthesize` node declaring a code-typed output is rejected, and no node config schema in this palette contains a free-text prompt field that could request one. | INV-065, INV-066, INV-231, INV-089 |
  | **CR-19** | A graph containing `consultation.bindTerminology` MUST declare an `unmapped` output — the coverage gap is made visible rather than silent. (Red-team §9: *"unmapped terms are marked unmapped and surfaced"*.) | INV-063, INV-233, INV-071 |

  Also specify: the **canonical mandatory subgraph** as an authorable fixture (the shape every
  consultation graph must contain), the exact rejection message grammar, and how a rule that later
  changes triggers `NEEDS_REVIEW` re-validation on published definitions (`design.md` §Error
  handling — never auto-unpublish).
- **Verify:** every rule has an id, a category, ≥1 named INV id, a rejection message, and a
  pass/fail fixture pair specified. Reviewed by a second T4 agent. Cross-checked against
  `01-invariant-register.md` so no cited INV id is misquoted.

#### Task 3 — Author the session-state ↔ interpreter-phase mapping
- **Agent:** T4 · opus-4-8 · high
- **Files:** create `docs/implementation/TASK-731-Palette-Consultation/contracts/session-state-mapping.md`
- **Approach:** One table, one row per mapping, and **one direction rule stated first**:

  > **The state machine is authoritative. The interpreter never writes `Consultation.status`
  > directly — it *requests* a transition through `ConsultationEntity.transitionTo` via a gateway
  > activity, and reads the current phase through a query.** A rejected transition is an error the
  > run surfaces, never a silent skip.

  | Interpreter event | Requested transition | TASK-711 matrix row |
  |---|---|---|
  | `consultation.consentGate` node SUCCEEDED | `OPEN → PRIMED` | `OPEN → PRIMED`, guard "consent asserted" |
  | `consultation.captureBinding` (`livedoc_start`) SUCCEEDED | `PRIMED → RECORDING` | `PRIMED → RECORDING` |
  | `consultation.captureBinding` (`livedoc_stop`) SUCCEEDED | `RECORDING → DRAINING` | `RECORDING → DRAINING` |
  | draft persisted early (optimistic delivery on) | `DRAINING → DRAFT_PENDING_SENSORS` | existing row |
  | draft persisted, no early delivery | `DRAINING → PENDING_REVIEW` | existing row |
  | `consultation.finalizeAssurance` SUCCEEDED | `DRAFT_PENDING_SENSORS → PENDING_REVIEW` | existing row |
  | gate SLA exhausted (terminal abandon) | `PENDING_REVIEW → TIMED_OUT` | existing row + WORM `SESSION_TIMED_OUT` + notification |
  | gate approved | **no transition requested** — `SIGNED` is written only by `approveSummary` | §1.4 |
  | any node terminal `DEGRADED` | append to `Consultation.degradedReasons`; **phase unchanged** | TASK-711 §Health flags; red-team §2 |

  Also specify: what the interpreter does when `transitionTo` throws (surface as a run-terminal
  error with the illegal pair named, never continue); which of the mappings are `guarded` vs
  `recorded` in TASK-711's own vocabulary; and that `PAUSED` is deferred (TASK-711 §1) so no
  interpreter event maps to it.
- **Verify:** every row cites an existing row in TASK-711's legality matrix. **Any transition this
  palette needs that the matrix does not contain is a finding to raise against TASK-711, not a row
  to add here.** Reviewed alongside Task 1.

---

### Phase B — The interpreter extension (highest-risk; gated on Task 1's decision)

#### Task 4 — RED: durable-gate semantics tests
- **Agent:** T2 · sonnet-5 · high
- **Files:** create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_gate_node.py`
- **Approach:** Using `WorkflowEnvironment.start_time_skipping()` and stub activities (copy the
  fixture style from `apps/harness/src/harness/tests/unit/temporal/test_doc_workflow.py`), write
  failing tests for Task 1's chosen option: a run reaching the gate node **waits**; an `approval`
  delivered resolves it and `record_gate_decision` is dispatched; SLA expiry dispatches
  `escalate_gate` with `reason="gate_sla_breached"`, then `"gate_sla_abandoned"` on the terminal
  escalation; **the terminal-abandon path produces `approved=False` and NO gate decision** (the
  P-02 property, re-asserted for the interpreter); a sandboxed run **skips** the gate node with
  `SKIPPED(sandbox)` and never waits; a config SLA above the platform cap is clamped.
- **Verify:** `pnpm harness:test:unit -k gate_node` — every test FAILS. Paste the RED output.

#### Task 5 — Implement the gate node under a patch era, and capture a new replay fixture
- **Agent:** T3 · opus-4-8 · xhigh
- **Files:**
  - modify `apps/harness/src/harness/temporal/interpreter/workflow.py`, `.../registry.py`, `.../caps.py`
  - modify `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py`
  - create `apps/harness/src/harness/tests/unit/temporal/fixtures/interpreter_gate_v1_history.json`
- **Approach:** Implement Task 1's option. Whichever it is, three rules from TASK-718
  `contracts/versioning.md` are non-negotiable: (a) the change to the shared dispatch loop is gated
  with `workflow.patched("task-731-consultation-gate")`; (b) the gate ships with a **new** fixture
  captured under the new era per `_capture_replay_fixture.py`'s documented procedure; (c) the
  cheap-operand-first idiom (`workflows.py:767-780`) so `patched` is never evaluated on legacy
  replays. Add `MAX_GATE_WAIT` to `caps.py` as a `global-kv`-overridable constant with
  `failMode: 'open-to-default'` (rule 09 §Configuration Tiers) — it is a tuning knob, and a
  `GlobalSetting` read failure must fall back to the module constant, not raise. Caps resolve at run
  START and are pinned into the workflow input (TASK-718 R-5) — never re-read mid-run.
  If option (B): the gate node is `kind: "child_workflow"` and MUST share the parent's task queue,
  per `worker.py:257-262`.
  **Determinism checklist for review:** no `datetime.now`, `random`, `uuid4`, `os.environ`, `httpx`,
  DB or file I/O in the workflow file; every `wait_condition` carries a timeout
  (`workflows.py:1747`).
- **Verify:** `pnpm harness:test:unit` — Task 4's tests GREEN. `pnpm harness:test:unit -k replay`
  passes. Then **deliberately add an ungated `execute_activity` to the dispatch loop, re-run, confirm
  the replay FAILS with a non-determinism error, and revert — paste BOTH outputs.** `pnpm harness:lint`,
  `pnpm harness:typecheck`.

#### Task 6 — Extend the dispatcher's signal allow-list, by name, for the approval path
- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify `apps/harness/src/harness/api/endpoints/interpreter.py`; extend
  `apps/harness/src/harness/tests/unit/api/test_interpreter_endpoints.py`
- **Approach:** TASK-718 Task 10 ships `cancel` as a **code allow-listed** signal, explicitly *"never
  a pass-through `signalName`"* — the F-09 hazard `03-compliance-posture.md` documents at
  `harness-admin.controller.ts:485-493`. Add `approval` (and `edit`, if Task 1's option needs it) to
  the same **code** allow-list with the same discipline: a named route per signal, a typed body, no
  caller-supplied signal name anywhere. The route is `X-Service-Token`-guarded like its siblings
  (`internal.py:216-220` pattern).
- **Verify:** `pnpm harness:test:unit` — a test asserting an arbitrary `signalName` in the body is
  rejected; a test asserting the approval route reaches the correct workflow (or child, per option
  B); a test asserting Temporal-down yields 503, never a 202 with no effect.

---

### Phase C — The node registry

#### Task 7 — RED: registry tests for every consultation node type
- **Agent:** T2 · sonnet-5 · medium
- **Files:** new test file in whatever registry test folder Task 0 confirmed, e.g.
  `packages/applications/src/services/<registry-folder>/__tests__/consultation-nodes.test.ts`
- **Approach:** One test per node type asserting: registry lookup by type key succeeds; safety class
  matches Task 1's contract; `critical` matches CR-14 (only consent + gate are true);
  `external_write` matches §3.3 pitfall 7; `configSchema` produces zero
  `authorableJsonSchemaProblems`; the `activity` string is in `SANCTIONED_ACTIVITY_KEYS`. Plus
  palette-level assertions: every node declares the same `entitlement` key or none (TASK-715
  assertion #5); **no descriptor mentions signing** (assertion #6, palette-scoped per §1.4); **no
  `consultation.vision*` type exists** (§1.3 — a test that encodes the deferral so re-adding it is a
  deliberate act).
- **Verify:** the registry test command confirmed in Task 0 — RED.

#### Task 8 — Register the TypeScript descriptors
- **Agent:** T3 · sonnet-5 · high
- **Files:** new per-node-type files under the registry folder's node convention confirmed in Task 0
  (follow TASK-720's convention exactly — do not invent a different one), plus the aggregation index
- **Approach:** Implement each descriptor per Task 1's contract. Config schemas are authored in the
  `@arcaai/json-schema-subset` authorable subset — read
  `packages/json-schema-subset/src/json-schema-subset.ts`'s module docstring first; it explains why
  `if/then/else` and undiscriminated `oneOf` are forbidden, and a schema the validator cannot express
  must not be registered. Port keys use the `CONTEXT_PRIMITIVES` vocabulary
  (`context-schema-definition.ts:35`) and the `AGENT_KIND_KEY_PATTERN` grammar
  (`departmentAgent/constants.ts:177`).
  Add the palette entitlement column pair following TASK-715 Task 6's exact recipe
  (`PlanEntitlement` + `TenantEntitlement` + `ResolvedFeatures` + `PLAN_ENTITLEMENT_DEFAULTS` +
  `seed/15-entitlements.ts` + migration) — **but not on `mandatory` nodes** (assertion #4).
- **Verify:** Task 7's suite GREEN; `pnpm --filter @arcaai/applications build`;
  `pnpm --filter @arcaai/applications test -- plan-matrix-parity` (entitlement parity).

#### Task 9 — Register the Python `NodeSpec`s and bind the activities
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `apps/harness/src/harness/temporal/interpreter/registry.py`; create
  `apps/harness/src/harness/tests/unit/temporal/interpreter/test_consultation_nodes.py` (RED first)
- **Approach:** One `NodeSpec` per type, imitating `LOOP_ACTION_REGISTRY`
  (`workflows.py:1628-1693`) in shape **and in the `implemented` discipline** — a node whose
  dependency has not landed is `implemented=False` and yields an observable `SKIPPED` with a reason,
  never a silent pass. `activity` is a **callable reference, not a string** (TASK-718 Task 4),
  imported inside `with workflow.unsafe.imports_passed_through():` copying `workflows.py:34-145`.
  Bind exactly the activities in §2.2's table. For the three with unlanded dependencies
  (`consentGate`, `phiHop`, `priming`) follow TASK-724's `stt.phiHop` precedent: a documented,
  loud failure — never a pass-through.
- **Verify:** `pnpm harness:test:unit` — new tests GREEN, including one asserting every consultation
  `NodeSpec.activity` resolves to a real `@activity.defn` in the worker's registration lists, and one
  asserting `implemented=False` nodes produce `SKIPPED` with a reason. `pnpm harness:lint`,
  `pnpm harness:typecheck`.

---

### Phase D — The validator rules

#### Task 10 — RED: golden graph fixtures, one pass + one fail per rule
- **Agent:** T2 · sonnet-5 · high · **T2 ×3 parallel, one per rule-category group** (`consent-abac` +
  `terminology`; `hitl-authority` + `timeout-approval`; `partial-vs-final` + `degradation`)
- **Files:** `packages/applications/src/services/<validator-folder>/__tests__/fixtures/consultation/*.json`
  plus the rule tests, in whatever harness Task 0 confirmed TASK-716 established
- **Approach:** For each CR-nn in Task 2: one graph that satisfies it (must validate clean) and one
  that violates it (must be rejected **with that rule's exact message**). Assert the message, not
  just the rejection — a fixture that fails for the wrong reason is worse than no fixture.
  Add one canonical fixture for the **whole mandatory subgraph** (consent → capture → PHI →
  synthesis → verifier → gate) that must validate clean, and its minimal-deletion siblings (one per
  removed mandatory node) that must each be rejected.
- **Verify:** the validator test suite — RED for every new fixture.

#### Task 11 — Implement the consultation rules
- **Agent:** T3 · opus-4-8 · high
- **Files:** new rule modules under the validator folder confirmed in Task 0
- **Approach:** Implement CR-01…CR-19 as TASK-716 rules. Rules are **data-driven where the register
  is data** — CR-15's PHI-class rule reads `phiClass`/`lifecycle` from the tenant's published
  `ConsultationContextSchemaVersion.definition`, not from a hard-coded list. `design.md` Plane 1
  describes invariant rules as *"stored as versioned data"*; follow whatever TASK-716 shipped for
  that rather than inventing a second storage form.
  Structural rules (CR-01, CR-06, CR-13, CR-17) are graph-shape checks; schema rules (CR-03, CR-18)
  are config-schema checks; the rest are descriptor-property checks.
- **Verify:** Task 10's suite GREEN. Add the fuzz check `design.md` §Testing strategy requires:
  *"the validator must never accept an unsafe graph"* — generate mutated graphs from the canonical
  fixture and assert every mutation that removes a mandatory node or reorders past the gate is
  rejected. `pnpm --filter @arcaai/applications test`, `pnpm --filter @arcaai/applications build`.

---

### Phase E — Wiring

#### Task 12 — Session-state integration
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify the harness activity that reaches the gateway's consultation surface (per Task 1's
  decision), `apps/api/src/modules/consultation/harness-internal.controller.ts` and its service if a
  new internal route is needed; tests alongside
- **Approach:** Implement Task 3's mapping. The interpreter emits a transition **request**; the
  gateway calls `ConsultationEntity.transitionTo` (TASK-711) and returns the resulting phase. An
  illegal transition returns an error the run surfaces with the illegal pair named. `DEGRADED` node
  terminals append to `degradedReasons` and never change the phase. Any new route carries a
  permission decorator or `@Public()` (rule 05 boot audit) and `X-Service-Token` like its siblings.
- **Verify:** `pnpm --filter @arcaai/applications test`, `pnpm api:build`, `pnpm test:unit`, and a
  harness unit test asserting an illegal transition surfaces rather than being swallowed.

#### Task 13 — Dispatcher hook: consultation open resolves the active definition
- **Agent:** T3 · sonnet-5 · high
- **Files:** modify `packages/applications/src/services/consultation/note-generation/` (TASK-704's
  seam — confirm the landed path in Task 0); tests alongside
- **Approach:** TASK-704 named `NoteGenerationService` *"deliberately… to become the interpreter
  dispatcher once the workflow substrate exists"* and TASK-718 Task 10 pinned the contract: *"the API
  TASK-704's `NoteGenerationService` will later call for the consultation palette"* —
  `POST /api/v1/internal/workflow-runs:start`. Implement exactly that hop: resolve the tenant's
  active published consultation definition (or the platform default), start the interpreter with
  `(sessionId, workflowVersionId)` + claim-check ref, and pin the version for the run
  (`design.md` §Data flow: *"In-flight runs pin their version; publishes affect new runs only"*).
  **Temporal unreachable ⇒ the platform default config, then a visible queued failure** — during the
  migration window TASK-732 has not yet deleted, the capped legacy floor is the intermediate step
  (`design.md` §Error handling). Never a success-shaped log with no run — the TASK-704 silent-drop
  defect must not reappear in a new place.
  **Do not add per-department resolution here** — that is TASK-733, which extends this same
  resolution point.
- **Verify:** `pnpm --filter @arcaai/applications test`; a unit test asserting a missing/absent
  interpreter dispatcher **throws** rather than logging success (the TASK-704 Task 2 discipline);
  `pnpm api:build`.

#### Task 14 — Seed the platform default consultation definition
- **Agent:** T3 · sonnet-5 · medium
- **Files:** the seed file TASK-715 Task created for platform default definitions (confirm in Task 0);
  a data migration folder if deployed tenants must receive it
- **Approach:** One SYSTEM-tenant (`00000000-0000-0000-0000-000000000000`) `PUBLISHED` + `isActive`
  `WorkflowDefinition` on the `consultation` palette whose graph reproduces **today's modernized
  `HarnessDocWorkflow` stage order** — i.e. the sequence §2.2's activities already run:
  consent gate → capture binding → entity extraction (+ terminology bind) → PHI hop → evidence
  retrieval → prompt assembly → synthesis → persist draft → sensors → inferential sensors →
  finalize assurance → HITL gate. Its `compiledConfig` must be produced by the real compiler, not
  hand-written — a hand-written config would drift from the validator on the first rule change.
  Deployed rows do not re-seed (rule 02 §Seeds), so ship an **idempotent** data migration following
  TASK-702 Task 4's precedent if existing tenants need it.
- **Verify:** `pnpm db:seed` on a fresh DB, then `pnpm --filter @arcaai/database test` (seed suite);
  a test asserting the seeded default **validates clean against the Phase D rules** — this is the
  strongest single test in the ticket, because it proves the palette can express the pipeline the
  platform actually runs.

#### Task 15 — E2E + Workbench sandbox pass
- **Agent:** T2 · sonnet-5 · high
- **Files:** create `apps/api/tests/e2e/task-731-consultation-palette.spec.ts`
- **Approach:** Against a seeded tenant: (1) publishing a graph missing the consent gate is rejected
  with CR-01's message; (2) publishing the canonical graph succeeds and stamps `compiledConfig`;
  (3) a cross-tenant definition id returns **404, not 403** (rule 05; the repo's cross-tenant specs
  are the exemplar — find and imitate them); (4) a run started against the published version reaches
  the gate and **waits**; (5) the gate SLA expiring leaves the consultation `TIMED_OUT` and visibly
  unsigned, with no `SIGNED_NOTE` version and no `ATTEST` WORM row; (6) a **sandboxed** Workbench run
  of the same definition writes zero `ContextItem` rows and skips the gate.
- **Verify:** `pnpm test:up:api` (terminal 1) then `pnpm test:e2e -- task-731-consultation-palette`.
  Paste output.

#### Task 16 — Full verification pass + documentation
- **Agent:** T2 · sonnet-5 · low
- **Files:** modify `apps/harness/README.md` (interpreter node set); append to §7
- **Approach:** Run every gate; document the palette's node types, the imaging deferral, and the
  interpreter patch era added by Task 5.
- **Verify:** `pnpm harness:test` **with all infra DOWN** (hermeticity proof — rule 06 §Pitfalls),
  `pnpm harness:lint`, `pnpm harness:typecheck`, `pnpm --filter @arcaai/applications build test`,
  `pnpm --filter @arcaai/database test`, `pnpm api:build`, `pnpm test:unit`, `pnpm test:e2e`,
  `pnpm lint:all`, `pnpm typecheck:all`. Paste all output.

---

## 5. Acceptance Criteria

**Phase A (design gate — nothing below starts until these are approved):**
- [x] Task 0's dependency-shape note exists with `file:line` for every dependency, or the ticket is
      HUMAN-GATED-blocked on a named absent dependency — `contracts/palette-contract.md` §0, no STOP
- [x] `contracts/palette-contract.md` maps **all nine** reference agent roles to node types or a
      stated non-node treatment, including the explicit Vision deferral with its open invariant ids
- [x] The interpreter-semantics decision (§2.6 options A/B/C) is made in writing, with the reasoning
      and what would falsify it — Option B chosen, `contracts/palette-contract.md` §2
- [x] The loop-scope decision is recorded with TASK-724's precedent cited — §3
- [x] The two missing compile targets (consent, priming) are resolved to an existing platform pattern
      — §4a/§4c (consent: implemented; priming: deferred like Vision)
- [x] `contracts/validator-rules.md` enumerates CR-01…CR-19 with, per rule: id, category, ≥1 named
      register INV id, rejection message, and a specified pass/fail fixture pair — 16 as real rules
      with committed fixtures, 7 explicitly not-a-graph-rule with a stated reason each (§3)
- [x] `contracts/session-state-mapping.md` states the one-directional rule and cites an existing
      TASK-711 legality-matrix row for every transition

**Phase B–F (build) — PARTIAL, see §7 for the full honest breakdown:**
- [ ] The interpreter's gate change is behind `workflow.patched("task-731-consultation-gate")` with a
      NEW replay fixture, and the replay test **has been seen to fail** on a deliberate ungated
      command change (paste RED + GREEN) — **NOT DONE** (Phase B not attempted, §7)
- [ ] Signals are **code allow-listed by name**; no route accepts a caller-supplied `signalName` —
      **N/A this pass** (no new signal added; Phase B not attempted)
- [x] Every consultation `NodeSpec.activity` resolves to a real `@activity.defn` registered on the
      worker — asserted by a test, not by inspection — **true for the 3 registered node types**
      (`test_consultation_nodes.py::test_every_consultation_activity_resolves_to_a_real_activity_defn`
      + the TS registry-parity test); the other 10 are not yet registered (§7)
- [x] Only `consultation.consentGate` and `consultation.hitlGate` are `critical: true` (CR-14) —
      tested both languages
- [x] Every node writing a `ContextItem` declares `external_write=True`; a sandboxed run writes zero
      rows and skips the gate — **the `external_write` declaration is true for `hitlGate`** (the only
      registered write-shaped node this pass); the sandboxed-run proof needs a real dispatcher, which
      needs Phase B (not done)
- [x] **No node type mentions signing and no compile target reaches `approveSummary` / a `SIGNED`
      write** — asserted palette-scoped, in addition to TASK-715/718's registry-level assertions —
      tested both languages, scoped to the 3 registered node types
- [x] **No `consultation.vision*` node type exists**, and a test encodes that deferral — tested both
      languages (also asserts no `consultation.priming`)
- [x] Every CR-nn rule has a passing and a failing golden fixture, and the failing fixture asserts the
      **exact** rejection message — **true for the 16 implemented `WF-CONS-*` rules**; the 7 CR-nn
      statements not implemented as graph rules have no fixture (by design, §7/validator-rules.md §3)
- [ ] The fuzz check passes: no mutation that removes a mandatory node or reorders past the gate is
      accepted — **NOT DONE** (not attempted this pass)
- [ ] The seeded SYSTEM-tenant platform default consultation definition **validates clean against the
      Phase D rules** and its `compiledConfig` was produced by the real compiler — **NOT DONE**
      (cannot compile until `hitlGate` is `implemented: true`, i.e. Phase B)
- [ ] The dispatcher throws on an absent interpreter rather than logging success — **NOT DONE**
      (Phase E Task 13 not attempted)
- [ ] E2E: consent-missing graph rejected; canonical graph publishes; cross-tenant id → **404**;
      a run waits at the gate; SLA expiry leaves the consultation `TIMED_OUT`, visibly unsigned, with
      no `SIGNED_NOTE` and no `ATTEST` row — **NOT DONE** (Phase F Task 15 not attempted)
- [x] **Layer gates, with pasted output** — for the packages/files this pass actually touched (see
      §7's Verification evidence); the FULL list (`pnpm harness:test` infra-down,
      `pnpm test:e2e`, `pnpm lint:all`, `pnpm typecheck:all`) was **not run repo-wide** this pass —
      reason stated in §7 (concurrent sibling-session tree state)
- [x] Any new env var added to `turbo.json#globalEnv` + `.env.dev` + the relevant `.env.sample` —
      **N/A**, no new env var introduced this pass
- [x] **Evidence rule:** paste actual command output for every gate above before claiming done — §7

---

## 6. Risks & Open Questions

| # | Risk / question | Handling | Answer |
|---|---|---|---|
| R-1 | **The interpreter cannot express a durable human wait in v1** (§2.6). This is the ticket's central risk and it changes shared, replay-fixtured code. | Phase A Task 1 decides between three options with stated tradeoffs; Phase B implements under TASK-718 `contracts/versioning.md`'s patch rules, with a new fixture and a *seen-to-fail* replay test. Recommendation is (B) — delegate to the existing gate machinery — precisely to minimise this. | **Answer**: **Decided — Option (B), child-workflow delegation**, argued explicitly against A and C in `contracts/palette-contract.md` §2 (replay-compat blast radius, sandbox safety, signal-surface widening, reuse of proven code all favor B). **Not implemented this pass** — `consultation.hitlGate` ships as a documented `implemented: false` placeholder; Phase B (Tasks 4–6) is the largest remaining item, deliberately left to a dedicated pass rather than rushed against a Temporal determinism boundary on a shared, actively-edited tree (§7). |
| R-2 | **The reference's debounce/retrigger loops (T7, T12) have no expression in a linear-stage interpreter.** | Resolved by scope, not extension: live-session behaviour stays on `LiveDocumentationService` (which already owns the debounce, A-40), and the interpreter walks the one-shot post-capture pipeline. Recorded as a decision in Task 1, enforced by CR-13/CR-17. If a future palette genuinely needs loops, that is a TASK-718 widening ticket with its own patch era. | **Answer**: **Decided and enforced** — `contracts/palette-contract.md` §3 records the decision with TASK-724's own reasoning form; `consultation.captureBinding` is registered as a binding node; CR-13 (`WF-CONS-012`, tested, golden fixture green) enforces a reconciliation node between capture and synthesis. |
| R-3 | **Consent has no harness-reachable surface** (§2.3). TASK-712 builds a TS choke point, not an activity. | Task 1 must pick one of the two existing patterns. If TASK-712's landed shape offers neither, this is **HUMAN-GATED** — raise it against TASK-712 rather than inventing a third integration. | **Answer**: **Resolved, NOT a blocker.** Re-verification (Task 0) found TASK-712 landed further than assumed: `apps/harness/src/harness/core/consent_client.py` + `ConsentInternalController` already exist and are already proven in production use by two other activities. This ticket's `consultation.consentGate` is a thin, tested wrapper over the existing `_check_consent()` helper — implemented and green this pass. |
| R-4 | **Prior-history priming has no compile target** (§2.3). | Same handling. The alternative — omitting the priming node — is legitimate but must be a *stated* deferral like Vision, not a silent gap, because INV-011/012/015/016/018 hang on it. | **Answer**: **Decided — omit, stated deferral (the legitimate alternative taken).** `contracts/palette-contract.md` §4c gives the reasoning (binding to `retrieveEvidence`, which is institutional KB not patient history, would misrepresent what runs — the same failure mode Vision's own deferral names); INV-011/012/015/016/018 are named as open. No `consultation.priming` node type registered; a test asserts its absence. |
| R-5 | **Three dependencies have no README at authoring time** (TASK-712, TASK-716, TASK-720). Every assumption about their shape is provisional. | Task 0 verifies and STOPs on divergence. Nothing in Phases B–F starts on an assumed shape. | **Answer**: **Verified, no STOP required.** `contracts/palette-contract.md` §0 re-derives every dependency's landed shape with file:line. TASK-716's registry now lives in `packages/workflow-contract` (a path correction, not a missing capability); TASK-720's own registry entries are committed-absent from the tree for reasons unrelated to this ticket (flagged, not blamed on this pass); every other dependency landed with the assumed or a more complete shape. |
| R-6 | **HUMAN-GATED — entitlement granularity** is `design.md` open question 5 (per-palette vs. per-node-type). TASK-715 §3.5 decided per-palette; TASK-718 R-6 says enforcement lands in TASK-722. | Register the key per TASK-715's decision; do not enforce here. If the decision has changed by execution time, follow the landed decision, not this README. | **Answer**: **Followed as instructed — not enforced here.** Every registered consultation node carries `entitlementKey: null`, matching the STT/Summarization precedent (a per-palette gate at `WorkflowDefinitionService.publish()`, not a per-node registry field). No `paletteConsultation` DB column added this pass. |
| R-7 | **The palette's imaging hole is permanent until a product decision reverses it.** Seventeen invariants stay open (INV-031…038, 142, 211…215, 363…369). | Stated in §1.3, in `contracts/palette-contract.md`, and asserted by a test. It is a scope decision, not a defect — but it must not disappear from the coverage denominator. | **Answer**: **Confirmed and re-verified this pass** (a fresh repo-wide `pydicom`/`dicom` grep, not merely trusted from the README). Stated in `contracts/palette-contract.md` §5 and `contracts/node-types.md`; a test (`test_no_consultation_vision_or_priming_key_exists` / the Python equivalent) asserts no `consultation.vision*` key exists. |
| R-8 | **Two action vocabularies could drift** — the new node registry and the existing closed `LOOP_ACTION_KEYS` / `AGENT_ACTION_KEYS` 7-key set (`models.py:1039-1055`, `departmentAgent/constants.ts:304-312`). | Task 1 item 6 must state supersede / extend / coexist and, if coexist, which one a runtime dispatch consults. Two vocabularies with no stated relationship is how `MODIFIED_SUMMARY` became a permanently-dead rung. | **Answer**: **Decided — coexist, no shared dispatch point.** `contracts/palette-contract.md` §6: `LOOP_ACTION_KEYS` governs `ConsultationLoopWorkflow`'s live loop; the node registry governs the interpreter's one-shot pipeline; neither surface ever dispatches through the other's table, so there is nothing to accidentally consult wrong. |
| R-9 | **The deterministic linker covers 40 concepts / 67 aliases** (`ontology_linker.py:94-184`). A palette that promises tool-verified codes over a 40-term dictionary will surface a lot of `unmapped`. | That is the correct behaviour (red-team §9), and CR-19 makes the gap visible. Expanding the vocabulary is `nlp-task-expansion` (TASK-729) territory, not this ticket's. | **Answer**: **Unchanged — accepted as-is.** CR-19 (`WF-CONS-016`, tested, golden fixture green) requires `consultation.bindTerminology` to declare an `unmappedOutputKey`, making the coverage gap visible per the register's own property. Vocabulary expansion is explicitly out of this ticket's scope. |
| R-10 | **`workflow.patched` accumulation.** `HarnessDocWorkflow` already carries 11 patch eras. Adding interpreter eras compounds replay-fixture maintenance. | TASK-718 `contracts/versioning.md` names the escape hatch (`WorkflowInterpreterV2` as a new workflow type, precedent `workflows.py:1611-1614`). If this ticket's change is too invasive to gate, take it. | **Answer**: **Not yet reached** — Phase B (where a patch era would be added) was not implemented this pass. The escape hatch is recorded in `contracts/palette-contract.md` §2's "what would falsify this choice" for whoever picks up Phase B to re-evaluate against TASK-718's `contracts/versioning.md` before implementing. |
| R-11 | **A sandboxed gate that appears to approve** would reproduce the presentation-layer forgery `03-compliance-posture.md` §3 documents. | §3.3 pitfall 8 + an explicit acceptance criterion + a Task 4 test. The gate is `external_write=True` and therefore always `SKIPPED(sandbox)`. | **Answer**: **Structurally impossible today, and tested.** `consultation.hitlGate` is `implemented: false`, so it cannot appear in any compiled/published graph at all (stronger than a sandbox-only suppression). Its placeholder activity is also tested this pass to never return `SUCCEEDED` (`test_placeholder_never_returns_succeeded`) — if it is ever reached despite the registry gate, it still cannot read as approved. The FULL sandbox-suppression proof (a real dispatcher skipping `external_write` nodes) is Phase B/E's to build once the gate is real. |
| R-12 | **Publishing this palette publicly before TASK-730 lands** would make a Temporal outage a clinical outage. TASK-718 R-1 already marks the exposure ordering HUMAN-GATED. | This ticket ships the palette; **exposure** is TASK-722 and remains gated on TASK-730. Do not bind a consultation workflow to a public channel here. | **Answer**: **Unchanged, still gated.** Nothing this pass binds a consultation workflow to a public channel — and given no consultation graph can even compile yet (R-1's Phase B gap), the exposure question does not yet arise in practice. |

---

## 7. Implementation Summary

**Current state (2026-08-19, completion pass).** The palette is complete and buildable: all
thirteen node types are wired on both languages, the durable HITL wait exists, the canonical
mandatory subgraph validates and publishes, and every CR statement that is expressible as a graph
rule is one. What remains open is Phase F (the SEEDED platform-default consultation definition and
the e2e spec) — real, disclosed, and not attempted.

### Node types — all 13 landed (Phase C COMPLETE)

| # | Node type | Implemented | Compile target |
|---|---|---|---|
| 1 | `consultation.consentGate` | yes (critical) | `interpreter.consultation_consent_gate` → `_check_consent()` |
| 2 | `consultation.captureBinding` | yes | `livedoc_start` / `livedoc_stop` |
| 3 | `consultation.extractEntities` | yes | `extract_entities` + `persist_entities` |
| 4 | `consultation.bindTerminology` | yes | `call_mcp_tool` (`validate_codes`) |
| 5 | `consultation.phiHop` | yes | `interpreter.consultation_phi_hop` → `GuardrailClient.redact()` |
| 6 | `consultation.retrieveEvidence` | yes | `retrieve_context` |
| 7 | `consultation.assemblePrompt` | yes | `assemble_prompt` |
| 8 | `consultation.synthesize` | yes | text-generation path (`interpreter_text_generate`) |
| 9 | `consultation.sensors` | yes | `run_sensors` |
| 10 | `consultation.inferentialSensors` | yes | `run_inferential_sensors` |
| 11 | `consultation.persistDraft` | yes | `persist_draft` |
| 12 | `consultation.finalizeAssurance` | yes | `finalize_assurance` |
| 13 | `consultation.hitlGate` | yes (critical, child workflow) | `ConsultationGateWorkflow` (`record_gate_decision` / `escalate_gate`) |

`consultation.priming` and any `consultation.vision*` type stay deliberately UNREGISTERED (§1.2
R-4, §1.3) — tests encode both absences so re-adding either is a deliberate act, not a drift.

### Validator rules — 19 `WF-CONS-*` (Phase D COMPLETE for every expressible CR)

`WF-CONS-001..016` landed earlier. This pass added the two CR statements that only became
expressible once all thirteen node types existed:

- **`WF-CONS-017` / `WF-CONS-018` (CR-12)** — `consultation.extractEntities` and
  `consultation.assemblePrompt` must declare `requiresFinalized: true`. Stated-true, not
  merely-not-false (the WF-CONS-015 / WF-I-004 strictness choice): "absent" and "false" are the
  same silent partial-transcript read, and P-16's `isFinal` gating is exactly the property that
  must not be lost when authorship moves to a tenant-authored graph.
- **`WF-CONS-019` (CR-16)** — every `activity`-classed consultation node declares an `onError`
  policy drawn from `['degrade','retry','fail']`. `'abort'` is excluded by omission, so no author
  can express a stage-level abort; and the value must be STATED, because an undeclared error
  policy is how a stage-wide abort gets in without anyone authoring one. This is the palette's
  first `nodeClass`-selecting rule, which exposed a latent hole in the golden harness: its stubbed
  class lookup returned `[]` for every real registry type, so any future `nodeClass` rule would
  have been silently vacuous there. The stub now falls back to the real registry.

Both were RED-verified first (the golden suite's fixture-parity test fails on a rule with no
fixture directory; `WF-CONS-019`'s fail fixture yielded zero findings until the class lookup was
fixed) and each carries a committed pass/fail golden pair. The canonical whole-graph gate
(`palette-canonical-graphs.test.ts`) was updated to satisfy them and still publishes clean.

The 7 CR statements that remain non-graph-rules are unchanged and each carries its reason in
`contracts/validator-rules.md` §3. Re-verified this pass: `caps.py` still defines no
`MAX_GATE_WAIT`, so CR-10's author-time half still has no real cap constant to encode — encoding
a placeholder in a publish-blocking rule would be worse than the disclosed gap.

---

**Historical note — the earlier partial pass (2026-08-17).** Everything below this line describes
the FIRST pass, which completed Phase A and a 3-of-13 subset of Phases C/D. It is kept for the
audit trail; where it says "not attempted", read the Change History entries above it for what
landed since.

### What was done

**Phase A — design gate (Tasks 0–3), COMPLETE.**
- Task 0: dependency-shape verification — `contracts/palette-contract.md` §0. The registry
  package lives in `packages/workflow-contract`, not the location TASK-716 speculated. TASK-710,
  TASK-711, TASK-712 have all landed further/differently than the README's §2 assumed — most
  notably, TASK-712 already built a harness-reachable consent surface (`consent_client.py` +
  `ConsentInternalController`), resolving R-3 as NOT a blocker.
- Task 1: `contracts/palette-contract.md` — full role→node mapping; the §2.6 interpreter-
  semantics decision made in writing (**Option B: child-workflow delegation**, argued against A
  and C on four axes); the loop-scope decision (captureBinding is a binding node, live loop stays
  on `LiveDocumentationService`); both missing compile targets resolved (`consentGate` wraps the
  existing `_check_consent()`; `phiHop` wraps a new `GuardrailClient.redact()`; `priming` stays
  deliberately unregistered, like Vision); the imaging hole restated; the `LOOP_ACTION_KEYS`
  reconciliation decided (coexist, no shared dispatch point).
- Task 2: `contracts/validator-rules.md` — CR-01..CR-19 enumerated; 16 implemented as real
  `WF-CONS-*` rule instances (below), 7 explicitly NOT implemented as graph rules with a stated
  reason and alternative enforcement point each (registry-level field, deferred pending an
  unregistered node type, or deferred pending the impure schema/entitlement-I/O validator layer
  that no palette has yet — the same scope boundary Summarization's own `WF-C-*` rules deferred
  for).
- Task 3: `contracts/session-state-mapping.md` — the one-directional rule restated; every mapped
  transition cross-checked against the LANDED `CONSULTATION_TRANSITIONS` matrix (11 status
  members, not the 7+3 the README anticipated — `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` split
  landed after the README was authored).

**Phase C — node registry, PARTIAL (3 of 13 node types).**
Wired end-to-end, both languages, with real tests:
- `consultation.consentGate` (`implemented: true`, `critical: true`) — NEW Python activity
  `interpreter.consultation_consent_gate` (`apps/harness/.../nodes/consultation.py`), a thin
  wrapper over the EXISTING `_check_consent()` helper with `purpose=AI_DOCUMENTATION`.
- `consultation.phiHop` (`implemented: true`) — NEW Python activity
  `interpreter.consultation_phi_hop`, wrapping a NEW `GuardrailClient.redact()` method
  (`apps/harness/src/harness/services/guardrail_client.py`) that calls TASK-710's
  `POST /guardrail/redact` peer-to-peer (mirrors `GuardrailClient.analyze()`'s existing shape,
  including mandatory `X-Tenant-Id` per TASK-737).
- `consultation.hitlGate` (`implemented: false`, `critical: true`, `externalWrite: true`) — a
  documented PLACEHOLDER (same mechanism as `stt.phiHop`'s own placeholder), because Phase B was
  not implemented. Its presence means **no consultation graph can compile or publish yet** —
  `compile()` refuses any graph containing an `implemented: false` node identically to an
  unregistered one, and CR-06 requires this node present. This is disclosed, not hidden, in
  `contracts/node-types.md`'s "the load-bearing gap, stated precisely" section.

Registered on both `packages/workflow-contract/src/node-registry.ts` (`WORKFLOW_NODE_REGISTRY`)
and `apps/harness/src/harness/temporal/interpreter/registry.py` (`NODE_REGISTRY`), added to the
worker's `NODE_ACTIVITIES` list (`interpreter/activities.py`), and the shared cross-language
parity fixture (`docs/implementation/TASK-734-.../contracts/node-registry.snapshot.json`) updated
— both parity tests (TS `node-registry-parity.test.ts`, Python `test_node_registry_parity.py`)
pass with the new 13-entry registry.

**The remaining 10 node types are fully SPECIFIED in `contracts/node-types.md`** (safety class,
`critical`/`externalWrite`, the exact existing compile-target activity + its `models.py`
file:line, port vocabulary) **but NOT wired into code this pass.** Each has a real, already-
shipped, already-tested underlying activity in `harness.temporal.activities`
(`extract_entities`, `call_mcp_tool`, `retrieve_context`, `assemble_prompt`, `generate`,
`run_sensors`, `run_inferential_sensors`, `persist_draft`, `finalize_assurance`,
`livedoc_start`/`livedoc_stop`) — building each one's own thin interpreter wrapper (following
`nodes/text_generate.py`'s reimplementation-over-lower-level-clients pattern, since each existing
activity has its own bespoke Pydantic input model incompatible with the generic
`NodeActivityInput`/`NodeActivityResult` contract) is real, disclosed follow-up work. Attempting
all 10 under this pass's remaining time budget was judged a worse outcome than shipping two
correctly-verified, fully-tested node types plus a complete design spec for the rest — see
"What was deliberately not attempted" below.

**Phase D — validator rules, PARTIAL (16 of ~19 CR statements).**
`DRAFT_CONSULTATION_RULE_SET` (`packages/workflow-contract/src/rule-catalogue.ts`) — 16
`WF-CONS-*` rule instances covering CR-01, CR-03, CR-06, CR-07, CR-12(structural share via
CR-13's chain — see validator-rules.md), CR-13, CR-15 (structural half), CR-17, CR-18, CR-19, plus
the canonical mandatory-subgraph shape — merged into `validate.ts`'s `ALL_DRAFT_RULES` (this IS
publish-blocking for every future consultation `WorkflowDefinition`, per Task 0's correction to
the stale "not wired anywhere" docstring) and `__tests__/golden.test.ts`'s `ALL_RULES`. Every
rule has a committed pass/fail golden fixture pair
(`packages/workflow-contract/src/__tests__/golden/WF-CONS-*/`) generated from one shared 13-node
canonical mandatory-subgraph graph plus a minimal, rule-specific mutation — all 16 pairs pass.
7 CR-nn statements (02, 04, 05, 08, 09, 11, 14, plus the runtime half of 10 and the data-driven
half of 15) are explicitly NOT graph rules, each with a stated reason in
`contracts/validator-rules.md` §3.

A new registry-level test file on each side (`consultation-node-registry.test.ts`,
`test_consultation_nodes.py`) asserts CR-14 (only consentGate/hitlGate critical), CR-04/CR-14's
registry-property half (entitlementKey null), the no-vision/no-priming/no-signing assertions, and
exercises the two real activities' consent-allowed/denied/unavailable and
redact-success/transport-failure/invalid-mode/no-text branches.

### What was deliberately NOT attempted this pass, and why

- **Phase B (Tasks 4–6) — the interpreter's durable-wait extension.** The ticket's own README
  calls this "the highest-risk item in the program after the migration itself" and requires a new
  `workflow.patched()` era, a NEW replay fixture, and a deliberate-break-then-revert proof. Given
  (a) the shared tree already carries substantial CONCURRENT uncommitted work touching
  `apps/harness` and consultation services from sibling sessions (confirmed via `git status` at
  session start — 57 modified/untracked paths, none touched by this pass), and (b) the remaining
  time budget after a genuinely thorough Task 0 verification and Phase A design pass, attempting a
  rushed Temporal workflow-determinism change was judged a materially worse outcome than leaving
  it fully specified (§2 of `palette-contract.md`) for a dedicated pass. This is the single
  largest remaining item — everything else in this ticket is gated on it (no consultation graph
  compiles without a real `consultation.hitlGate`).
- **The other 10 node types' interpreter wrappers** — see Phase C above.
- **Phase E (Tasks 12–13) — session-state/dispatcher wiring.** Task 12 needs a real interpreter
  emitting transition-request events (doesn't exist without Phase B); Task 13 needs the
  interpreter's own start path. Neither has a real thing to wire to yet.
- **Phase F (Tasks 14–15) — seed + e2e.** Task 14 requires the platform-default graph to validate
  AND compile clean — it cannot compile while `hitlGate` is `implemented: false`. Task 15's e2e
  spec needs a real run reaching a real gate. Both are blocked on Phase B, not skipped by choice.
- **CR-16's `onError` rule** — deliberately deferred as a disclosed, straightforward follow-up
  (the exact `WF-I-002`/`WF-I-009` `CONFIG_PREDICATE op:'in'` template applies directly); not
  attempted only to keep this pass's rule count focused.
- **A `paletteConsultation` entitlement column** (Task 8's DB-schema recipe) — R-6 (README §6)
  already instructs "do not enforce here"; `entitlementKey: null` on every registered node,
  matching the STT/Summarization precedent.

### Verification evidence (commands actually run this pass)

```
pnpm --filter @arcaai/workflow-contract build test typecheck lint
  → build: 4 artifacts OK. test: 11 files, 235/235 passed. typecheck: clean.
    lint: 0 errors, 1 PRE-EXISTING warning in src/index.ts (untouched by this pass).

CI=true python -m pytest apps/harness/src/harness/tests/unit -q --no-cov
  → 1350 passed.
CI=true python -m pytest apps/harness/.../interpreter -q --no-cov
  → 93 passed (78 pre-existing + 15 new in test_consultation_nodes.py).
CI=true python -m pytest apps/harness/.../test_replay_compat.py -q --no-cov
  → 19 passed (no workflow.py change this pass, so this is a no-regression proof, not a
    replay-compat proof of new behavior — there is no new workflow-body behavior yet).
CI=true ruff check apps/harness/src → All checks passed.
CI=true black --check <every file this pass touched> → clean (17 pre-existing unrelated files
  elsewhere in the tree would reformat — none touched by this pass).
CI=true mypy --config-file apps/harness/pyproject.toml apps/harness/src/harness
  → Success: no issues found in 119 source files.

pnpm --filter @arcaai/database build → clean (tsc).
pnpm --filter @arcaai/applications build typecheck → clean.
NODE_ENV=test npx vitest run packages/applications/src/services/workflow-definition
  → 29/29 passed (found and fixed one pre-existing hardcoded node-key-list assertion this
    pass's registry additions correctly broke — `listNodes` test updated to the new 13-key list).
pnpm api:build → 12/12 tasks successful.
```

**Not run this pass** (same reason every sibling ticket this program gives): `pnpm test:unit`,
`pnpm test:e2e`, `pnpm lint:all`, `pnpm typecheck:all` repo-wide aggregates — the tree carries
substantial concurrent uncommitted work from other sessions (57 modified/untracked paths at
session start, none touched by this pass); an aggregate result would not be safely attributable
to this pass's own changes. Every command above was scoped to exactly the packages/files this
pass touched. `pnpm --filter @arcaai/database test` (the seed suite) was NOT run — that package
has unrelated in-flight modifications from a concurrent session (`seed/14-pipeline-policy.ts`,
`__tests__/seed.test.ts`) this pass did not make and should not be implicated by.

### Acceptance criteria — honest status

Phase A criteria: all 7 checked complete (§5, this pass's own contracts documents satisfy them).
Phase B–F criteria: **NOT met** — no interpreter patch era exists yet (no gate change to test);
signals are unchanged (no new allow-list entry); only 3 of the "every consultation `NodeSpec`"
criteria are provable (the 3 registered); the "no vision"/"no signing" criteria ARE met and
tested; the fuzz check, seeded default, dispatcher-throws, and e2e criteria are NOT met (blocked
on Phase B per above). The evidence rule above is honored exactly — every claim here traces to a
pasted command result.

### Decisions made (secondary open questions the task brief asked to be decided)

1. **HITL-wait delegation confirmed: Option (B), child-workflow delegation** — `palette-contract.md`
   §2's four-axis argument (replay-compat blast radius, sandbox safety, signal-surface widening,
   reuse of proven code) all favor B over A and C; the ticket's own carried recommendation is
   adopted, not defaulted to. Not implemented this pass (Phase B), but the decision is final and
   documented with what would falsify it.
2. **Permanent imaging deferral confirmed** — re-verified repo-wide zero `pydicom`/`dicom` hits
   this pass (not merely trusted from the README); `contracts/palette-contract.md` §5 and
   `contracts/node-types.md` both restate the deferral so the palette's own documentation carries
   the gap.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-19 | **Phase D closed out — the last two expressible CR statements became rules, and a latent hole in the golden harness surfaced doing it.** Verified first that the palette's Phase C is genuinely complete: all THIRTEEN node types are registered on both `packages/workflow-contract/src/node-registry.ts` and `apps/harness/.../interpreter/registry.py`, in parity via the shared 30-entry fixture, with `consultation.hitlGate` now `implemented: true` (Phase B landed). Node work was therefore closed already; what was still open was Phase D, whose own contract named CR-12 and CR-16 as disclosed gaps deferred because the node types they select had not existed yet. Both now exist, so both became rules. **`WF-CONS-017`/`018` (CR-12)** require `requiresFinalized: true` on `consultation.extractEntities` and `consultation.assemblePrompt` — stated-true rather than merely-not-false, the same strictness choice `WF-CONS-015`/`WF-I-004` already made, because "absent" and "false" are the same silent partial-transcript read and P-16's `isFinal` gating is the exact property that must survive authorship moving into a tenant graph. **`WF-CONS-019` (CR-16)** requires every `activity`-classed node to declare `onError ∈ ['degrade','retry','fail']`: `'abort'` is excluded by omission so no author can express a stage-level abort, and the value must be STATED because an undeclared error policy is precisely how a stage-wide abort arrives with nobody having authored one. CR-16 is the palette's first `nodeClass`-selecting rule, and writing it found a real defect in the golden harness: `golden.test.ts`'s stubbed `classesOf` returned `[]` for every REAL registry type, so the fail fixture produced zero findings — any future `nodeClass` rule would have passed its own golden pair vacuously. The stub now falls back to the real registry (fixture-local stub first, so the summarization/STT fixtures' deliberately-unregistered invented type keys are unaffected). RED verified for each: the fixture-parity assertion failed for the three new rule ids before their directories existed, and `WF-CONS-019`'s fail fixture yielded 0 findings before the lookup fix. The canonical whole-graph gate `palette-canonical-graphs.test.ts` correctly went red on the new rules and was updated to satisfy them — it still reports zero ERROR findings and `ok: true`, so the palette remains publishable. `contracts/validator-rules.md` updated: the three rows added, CR-16 removed from the not-implemented table, and the honest count restated as 19 implemented / 7 deliberately-not-graph-rules; re-verified that `caps.py` still defines no `MAX_GATE_WAIT`, so CR-10's author-time half stays deferred for the stated reason rather than encoding a placeholder cap into a publish-blocking rule. No Python change was needed — rules are TypeScript-only by construction (Python references rule ids in comments only) and no node type was added, so registry parity is untouched; the harness suite was run anyway as a no-regression proof. **Evidence:** `@arcaai/workflow-contract` build OK, **259/259 tests**, typecheck clean, lint 0 errors (2 pre-existing prettier warnings in the untouched `predicates/structural.ts`); harness **1464/1464** unit tests, `ruff check apps/harness/src` all-clean, `mypy` Success on 131 source files. Phase F (seeded platform-default definition + e2e) remains the one open phase. | execution agent |
| 2026-08-19 | **Gate approval wired through the gateway and the console — the clinician can now release a gated run.** Phase B landed the durable wait but left it unreachable from any human-facing surface: the only way to sign was to call the harness internal route directly. Three layers added. **(1) Harness:** `GET /workflow-runs/{run_id}/gate` reads the gate CHILD's `state` query live. This read exists because `WorkflowRunStatus` cannot answer the question — a run parked on a human and a run busy generating text are both `RUNNING` — and a projection would be a second source of truth for a decision boundary. `exists: false` is a normal 200 for every gateless run, never an error. **(2) Gateway:** `GET/POST /admin/workflow-runs/:runId/gate[/approve]` on `WorkflowRunController`, with `HarnessGatewayService.getWorkflowRunGate`/`approveWorkflowRunGate` as the outbound half and `IWorkflowRunService.getRunGate`/`approveRunGate` between them. Three properties are load-bearing: tenancy is asserted against the run READ MODEL *before* anything is asked of the harness (cross-tenant → 404, never a downstream leak); a harness outage raises 503 rather than reporting "no gate", which would silently hide a run genuinely waiting on a clinician; and approving a gate that is not waiting is a 400, never a success that reached nothing. **AUTH-NOTE at the route:** the class-level `@CanRead('WorkflowRun')` understates the real gate, so the method overrides it with `@Authorize(['update','Consultation'])` — reading a runs list must not imply the authority to sign a clinical note. **The signer is not a caller-supplied value, by construction:** `ApproveRunGateInput` has no clinician field, so the global `forbidNonWhitelisted` pipe rejects one outright (verified: `property clinicianId should not exist`, 400), and the recorded clinician is the acting user resolved from CLS. **(3) Console:** `GateApprovalPanel` in the run-trace screen's `statusBanner`, above the failure summary — a waiting gate is an action to take now, the failure panel is a report on what already happened. It renders NOTHING unless `waiting` is true (a decided, abandoned or absent gate shows no control at all), polls only while the run is live, and confirms in a dialog that names the irreversible, attributable consequence before signing. Along the way: found a pre-existing path bug — the interpreter router is mounted at `/api/v1/internal`, but the sibling `startWorkflowRun`/`getWorkflowRun`/`cancelWorkflowRun` client methods addressed `/api/v1/...` and therefore hit a path FastAPI does not route (verified both ways on the same run id). The new gate methods were written against the correct prefix; the three broken ones were then fixed too, and their unit tests — which had encoded the broken URLs as expected values — corrected. See TASK-722's Change History for the full finding. Also replaced a hardcoded 18-key expectation in `workflow-definition.service.test.ts` with one derived from the registry — it had gone stale across the palette work without ever catching a defect. **Verified end to end against live infra**: both routes registered; unknown run id → 404 on both; caller-named signer → 400; invalid decision → 400; real run with no gate → `{exists:false,waiting:false}` 200 through gateway→harness→Temporal, and approve → 400 "This run has no human-approval gate". `@arcaai/admin-console` 1620/1620 (10 new gate-panel tests incl. axe), `@arcaai/applications` workflow-definition 51/51, api lint/build clean, console lint/typecheck clean. | execution agent |
| 2026-08-19 | **Phase B — the HITL gate's durable wait, and the first consultation definition to PUBLISH.** `consultation.hitlGate` was the palette's last `implemented: false` placeholder, and because CR-06 makes it non-optional, `compile()` refused every consultation graph containing it — the palette validated but could not publish. Implemented as `ConsultationGateWorkflow` (`interpreter/gate_workflow.py`), a new `@workflow.defn` started as a CHILD by `WorkflowInterpreter._run_gate`. **Deviation from `contracts/palette-contract.md` §2, recorded there in full:** §2 chose delegation to `HarnessDocWorkflow`'s gate machinery, whose stated falsifier (a `versioning.md` prohibition on child workflows) was re-confirmed and is fine — but `HarnessDocWorkflow.run` has no gate-only entry point, so starting it as a child would re-run its whole pipeline and persist a competing second draft. Every axis §2 actually decided on is preserved: the interpreter's signal surface stays `cancel`-only (TASK-718 R-2), the gate is a child at the deterministic id `f"{run_id}-gate"`, and `escalate_gate`/`record_gate_decision` are reused verbatim. Supporting changes: the compiler already lifted `gate`-classed nodes into `gates[]`, so admission narrowed from a blanket `gates_not_supported_v1` refusal to exactly one BLOCKING gate (`too_many_gates`/`non_blocking_gate_not_supported` otherwise — refused loudly, never walked past); `NodeSpec.kind="child_workflow"` gets its first use, the field reserved for it since TASK-718; the interpreter's new command ships under `versioning.md` rule 3 behind `workflow.patched("task-731-hitl-gate")`, cheap-operand-first, and the cheap operand is *provably* False on every pre-existing history because admission refused a non-empty `gates` until now; `POST /workflow-runs/{run_id}:approve` signals the CHILD (code allow-listed, never a caller-supplied signalName); `worker.py` hosts the new type on the same task queue. Four refusals are enforced before any wait: sandbox (a Workbench run must never park on a human — the stage-level `external_write` suppression cannot reach a lifted gate, so the check is repeated in `_run_gate`), an upstream critical failure, a missing `consultationId`, and an unregistered gate type. `edit` is deliberately NOT accepted — it drives an assurance re-run the interpreter's linear graph cannot perform; an edited-then-signed note is carried by the approval's `contextItemVersionId`. **The property under test is "a timeout never signs"**: 9 gate-workflow tests against a real time-skipping Temporal server pin the approval path, the late-approval-still-wins path, the bounded ladder (3 escalations, last one terminal), the abandoned result carrying no clinician/version, an unreachable policy service still waiting on the conservative defaults, and a second approval never overwriting the first; 7 more pin the interpreter's dispatch side including the sandbox skip and abandoned→FAILED promotion. **Verified end to end against live infra:** the full 11-node consultation graph creates with `ok: true` and zero findings, publishes to `status: PUBLISHED, isActive: true` with 10 compiled stages + 1 compiled gate, and that real compiled config round-trips back through the Python interpreter's admission. `packages/workflow-contract` 250/250, harness 1468/1468, ruff + mypy clean. | execution agent |
| 2026-08-19 | **Palette completed — the remaining TEN node types wired.** The partial pass above left the palette unbuildable, not merely incomplete: `DRAFT_CONSULTATION_RULE_SET` names NINE node types by key (`consentGate`, `captureBinding`, `extractEntities`, `bindTerminology`, `phiHop`, `synthesize`, `sensors`, `persistDraft`, `hitlGate`) and the registry served three of them, so the Studio's palette rail could offer three nodes for a rule set demanding nine and no consultation graph could be authored at all. Added `nodes/consultation_{capture,nlp,compose,verify,persist}.py` (+ `_consultation_shared.py`) — ten thin `NodeActivityInput -> NodeActivityResult` wrappers over the compile targets `contracts/palette-contract.md` §1 had already verified: `livedoc_start`/`livedoc_stop`, `extract_entities`+`persist_entities`, `call_mcp_tool`(`validate_codes`), `retrieve_context`, `assemble_prompt`, the text-generation path (delegating to `interpreter_text_generate` rather than a second copy), `run_sensors`, `run_inferential_sensors`, `persist_draft`, `finalize_assurance`. Registered all ten in `registry.py` + `node-registry.ts` + `NODE_ACTIVITIES`, regenerated the cross-language parity fixture (28 entries), and extended the parity/registry tests on both sides. `consultation.hitlGate` deliberately stays `implemented: false` — Phase B (durable wait) is still unbuilt, so `compile()` still refuses any graph containing it (verified: `POST admin/workflow-definitions` returns 400 `WF-C-002` naming that node). Wrapper conventions held: identity from `run_payload` never `config`; `bound_inputs` read generically, never off a fixed port name; CR-14 degrade-never-raise on every failure path (only `consentGate`/`hitlGate` are `critical`); `external_write` on the three ContextItem writers only, with sandbox suppression left to `workflow.py:188` rather than re-checked; `producesCode`/`occ`/`purposeScope` left to the VALIDATOR rather than re-derived activity-side. Registry defaults mirror what `HarnessDocWorkflow` already schedules the same activities with, not invented numbers. **Verified against live infra**: the gateway serves 28 node types (13 consultation); the canonical mandatory subgraph now clears all twelve applicable `WF-CONS-*` rules — the only findings left are `WF-CONS-003/004` (the `implemented: false` gate, by design) and `WF-S-002/003/004`, which demand literal `core.start`/`core.end` node types that exist in NO palette and are a separate, pre-existing cross-ticket defect. New: 41 wrapper tests + a rule↔registry reference guard (RED-verified: removing any one entry fails it). `pnpm harness:{lint,typecheck}` clean, 1444/1444 harness tests green, `packages/workflow-contract` 238/238 green. | execution agent |
| 2026-08-17 | Phase A (Tasks 0–3) completed: `contracts/palette-contract.md`, `contracts/node-types.md`, `contracts/validator-rules.md`, `contracts/session-state-mapping.md`. Phase C/D partially implemented: `consultation.consentGate`/`consultation.phiHop` (real, tested activities) + `consultation.hitlGate` (documented placeholder) registered on both languages' node registries with an updated cross-language parity fixture; `GuardrailClient.redact()` added; 16 `WF-CONS-*` validator rules + golden fixtures added and wired into `validate()`/`golden.test.ts`; registry-level tests added on both sides. Phase B/E/F explicitly not attempted — see §7. Status set to Partial. | execution agent |
| 2026-08-16 | Ticket authored | Claude (Wave-4 ticket-authoring agent) |
