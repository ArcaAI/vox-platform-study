# TASK-789 — Agentic Loop Coherence Review (Harness ↔ Studio ↔ Agents ↔ Templates ↔ Playground)

| | |
|---|---|
| **Status** | Review COMPLETE — Stages 1–3 delivered, findings verified and corrected under adversarial review |
| **Type** | `refactor` / `docs` (review first; remediation is a separate follow-up ticket) |
| **Target branch** | `dev-2.2` (owner decision, 2026-08-22) |
| **Owner question** | "I don't see any strong connections or relationships between the interfaces, data flows, functions/features, and the playgrounds." |

---

## 0. Owner decisions (settled 2026-08-22)

1. **Merge target: `dev-2.2`** — the branch this tree is already on. `CLAUDE.md`'s
   "CURRENT ACTIVE BRANCH: `feat/loop`" line is therefore **stale** and should be corrected in a
   separate housekeeping change.
2. **Report first; fixes are a follow-up ticket.** All review agents are READ-ONLY. No worktrees,
   no merges, no `db:*`/`pnpm install`/infra commands by any subagent.
3. **Seed home: the ArcaAI customer tenant** — `50000000-0000-0000-0000-000000000001`
   (`SEED_CUSTOMER_TENANT_IDS.ARCAAI`, `seed/00-constants.ts:124`). It is a real customer tenant
   that already owns seven departments (`GEN/SURG/RHEUM/NEUR/ORTH/HEME/BREN_ARCAAI`), doctors
   (`ARCAAI_DOCTOR*`), and existing consultation / DNA / audit seed — so the demo extends a live
   tenant story instead of inventing one, and the tenant→SYSTEM cascade is genuinely exercised.
   The "Global" tenant (`50000000-…0000`) stays out of the demo path entirely.

---

## 1. Requirement analysis — the owner's spec, restated as testable claims

The review is measured against these seven claims, not merely against internal consistency.
Each becomes a row in `requirements-traceability.md` with a verdict of
**IMPLEMENTED / PARTIAL / ABSENT / CONTRADICTED**, each backed by a file:line citation.

| # | Claim | Primary evidence surface |
|---|---|---|
| R1 | The harness agentic-loop workflow is **defined by the tenant admin** (not hardcoded, not SYSTEM-only) | `WorkflowDefinition` + Workflow Studio + `WorkflowAssignment` |
| R2 | The tenant admin can **manage, control and test** that workflow **using the playground** | Studio ↔ sandbox-run ↔ playground wiring |
| R3 | One workflow **coordinates the capability set**: record → transcribe → realtime entity extraction → realtime short summaries → autofill SOAP → suggestions → spelling/medical-term/drug-name correction | interpreter node registry vs. actual capabilities (STT/NLP/Text/Guardrail) |
| R4 | For a clinician the agent **follows the workflow**, autofills SOAP **scoped by department + DNA writing style**, highlights detected entities, shows suggestions — *during* the consultation | `DepartmentAgent`, `DnaWritingStyle*`, `ConsultationContextSchema`, `Highlight`, `NamedEntity` |
| R5 | The clinician can **edit the SOAP form while transcription/generation continues** (concurrent human + machine writers on one document) | `ContextItem` / `ContextItemVersion` / OCC + streaming |
| R6 | The clinician is the **sole finalizer** — confirm/finalize with full detail, accuracy, feedback | consultation finalize path + gate/approval |
| R7 | The system **captures the clinician's edits as feedback alongside the original**, for fine-tuning | `GateEditExemplar`, `SummaryMeta`, `AgentTrajectoryStep`, `GoldenCase`, `Fedl*` |

**Hypothesis under test (the owner's suspicion):** the five surfaces are each internally
coherent but the *seams* between them are weak — a definition authored in Studio may not be what
actually governs a live consultation, and a clinician edit may not become a training signal.
The review must confirm or refute this with evidence, not assume it.

---

## 2. Current-state inventory (established before this plan was written)

Verified by direct inspection, so the agent briefs carry real paths:

**Persistence** (`packages/database/src/prisma/db_main/`)
`workflow-definition.prisma` · `workflow-run.prisma` · `workflow-assignment.prisma`
(`WorkflowAssignment`, `WorkflowAssignmentChange`) · `workflow-invariant-rule.prisma` ·
`workflow-test-fixture.prisma` · `harness.prisma` (`GoldenSet`, `GoldenCase`, `EvalRun`,
`EvalScore`, `HarnessAuditEvent`, `HarnessPolicy`, `HarnessPolicyChange`, `GateEditExemplar`) ·
`consultation.prisma` (`Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`,
`NamedEntity`, `ContextItemVersion`, `Highlight`, `TranscriptSegment`) ·
`consultation-context-schema.prisma` · `department-agent.prisma` (`DepartmentAgent`,
`DepartmentAgentVersion`, `AgentPromotion`) · `prompt-template.prisma` (`PromptTemplate`,
`PromptVersion`) · `dna-writing-style.prisma` · `agent-trajectory.prisma` · `fedl.prisma`

**Contract** `packages/workflow-contract/src/` — `node-registry.ts`, `compiler.ts`,
`validate.ts`, `rule-catalogue.ts`, `node-config-schemas.ts`, `graph-model.ts`

**Runtime** `apps/harness/src/harness/temporal/` — `workflows.py` (141 KB), `activities.py`
(130 KB), `models.py` (83 KB), `interpreter/nodes/` (`consultation.py`,
`consultation_capture.py`, `consultation_compose.py`, `consultation_nlp.py`,
`consultation_persist.py`, `consultation_verify.py`, `context_binding.py`, `deliver.py`,
`guardrail_check.py`, `stt_placeholder.py`, `template_ref.py`, `text_generate.py`)

**Gateway** `apps/api/src/modules/` — `workflow-definition`, `workflow-node`, `workflow-run`,
`workflow-sandbox-run`, `workflow-assignment`, `workflow-test-fixture`, `workflows`,
`harness-admin`, `agentic-admin`, `agent-promotion`, `agent-trajectory`, `department-agent`,
`consultation`, `consultation-context-schema`, `prompt-management`, `dna-writing-style`

**UI** `apps/admin-console/src/features/` — `workflow-studio`, `workflow-runs`, `agents`,
`harness-policy`, `harness-ops`, `agentic-policy`, `pipeline-policy`, `context-schemas`,
`dna-writing-styles`, `playground-consultation`, `playground-live-transcription`, `workbench`,
`consultations`, `consultation-review`

**Existing seed** `seed/21-workflow-definition.ts` seeds exactly **one** SYSTEM-tenant
Summarization definition. `seed/07e-consultation-loop-defaults.ts`, `07c-live-agent-defaults.ts`,
`07b-arcaai-clinical-*.ts`, `09-consultation.ts` (1505 lines) carry the rest.
Two facts already visible in `21-workflow-definition.ts`'s own header comment and relevant to R1/R3:
its `validationReport` is **scoped** (the full rule set produces ERRORs against this palette), and
`registryChecksum` had to be back-filled after the registry was built later. Both are candidate
seam defects for the agents to confirm.

---

## 3. Agent fan-out plan

Rule 14 discipline: read-only agents get **no worktree**; tier is set **per stage**; the deciding
stage is never downshifted; fan-out is capped at what the orchestrator can actually verify.

### Stage 1 — Surface mappers (5 agents, parallel, READ-ONLY, `sonnet` / effort `high`)

Disjoint boundaries. Every brief carries: TASK-789, working dir, the rules to read, its exact
file boundary, "read-only — make no edits, run no `pnpm install`/`db:*`/infra commands", and the
**return contract** below.

| # | Agent | Type | Boundary |
|---|---|---|---|
| A1 | **Harness runtime** | `explorer` | `apps/harness/src/harness/{temporal,services,api,guards,sensors,eval}/**`. Rules: 00, 01, 06 |
| A2 | **Contract + gateway + persistence** | `explorer` | `packages/workflow-contract/**`, `packages/{domains,applications}/**` workflow/harness/agent slices, the `apps/api/src/modules/*` list in §2, the `*.prisma` list in §2. Rules: 00, 01, 02, 03, 04, 05 |
| A3 | **Studio / Agents / Templates UI** | `explorer` | `features/{workflow-studio,workflow-runs,agents,harness-policy,harness-ops,agentic-policy,pipeline-policy,context-schemas,dna-writing-styles}`. Rules: 00, 01, 13, 07 |
| A4 | **Clinician path** | `explorer` | `features/{playground-consultation,playground-live-transcription,workbench,consultations,consultation-review}`, `packages/agentic-sdk-v2/**`, `apps/api/src/modules/consultation*`. Rules: 00, 01, 13, 08 |
| A5 | **Feedback / training capture** | `explorer` | `GateEditExemplar`, `SummaryMeta`, `ContextItemVersion`, `AgentTrajectoryStep`, `PromptUsageRecord`, `DnaUsageRecord`, `Fedl*`, `GoldenSet`/`GoldenCase`/`EvalRun`, `apps/harness/src/harness/eval/**`. Rules: 00, 01, 02, 04, 06 |

**Return contract (identical for all five, so the results JOIN):**
1. `capabilities[]` — what this surface can actually do, each with file:line
2. `producesContracts[]` / `consumesContracts[]` — payload shape + the type/schema that declares it
3. `httpSurface[]` — endpoints exposed or called
4. `writes[]` / `reads[]` — DB tables, with the layer that touches them
5. `configResolution[]` — every tenant→SYSTEM cascade, every hardcoded value, every env read
6. `danglingEnds[]` — **the point of the exercise**: anything defined but never invoked, invoked
   but never defined, a second competing shape for the same concept, or a TODO/placeholder on a
   load-bearing path (`stt_placeholder.py` is a named starting suspicion, not a conclusion)
7. `evidence` — pasted excerpts for every non-obvious claim. Assertions without citations are
   rejected and the stage is re-run.

### Stage 2 — Seam audit (3 agents, parallel, READ-ONLY, `opus` / effort `xhigh`)

Runs **after** I have read and reconciled all five Stage-1 reports; each Stage-2 brief embeds the
joined map so the auditor argues against evidence rather than re-exploring. Distinct lenses, per
rule 14 §2 (N identical reviewers only catch the failure mode all N share).

| # | Lens | Question it must answer with a trace |
|---|---|---|
| S1 | **Control seam** (R1, R2) | Does a definition a *tenant admin* publishes in Studio actually govern a *live* consultation? Trace `WorkflowDefinition` → `WorkflowAssignment` → dispatch → interpreter → playground, naming every point that falls back to the SYSTEM default or a literal. Verdict must state whether R1 holds or the loop is effectively platform-authored. |
| S2 | **Data seam** (R3, R4, R5) | Does ONE payload shape survive end to end — transcript segment, entity, highlight, SOAP section, template variable, DNA style? Enumerate every place two competing shapes exist for one concept. Verify concurrent human+machine writes on one `ContextItem` (OCC/`_version`, last-write-wins, or lost updates). |
| S3 | **Feedback seam** (R6, R7) | Is clinician-edit → stored feedback → training corpus a closed loop or an open end? Is the *original* generation retained beside the edit? Is finalization actually clinician-gated, or can the machine finalize? |

Each returns: `verdict` (CONFIRMED / REFUTED / PARTIAL) per requirement, `findings[]` ranked by
severity with file:line + a concrete failure scenario, and `minimalFix[]` — the smallest change
that closes the seam (a proposal, not an edit).

### Stage 3 — Demo seed design (1 agent, `opus` / effort `high`, writes to `docs/` only)

Brief embeds Stages 1–2 output. Designs a **coherent end-to-end demo dataset** that makes the
whole loop visible and testable, subject to the hard constraints in §4. Deliverable is
`seed-spec.md` — a specification with concrete IDs and payloads, reviewed by the owner **before**
any `seed/*.ts` is written. Writing and running the seed is a separate, approved step: per rule
14 §3 the orchestrator (this session) owns `pnpm db:*` — no subagent runs it.

**Total: 9 agents across 3 gated stages.** I read and verify every report before the next stage
starts; nothing runs unreviewed.

---

## 4. Seed data — design constraints (binding on Stage 3)

The seed must *demonstrate* the loop, and must not become a config-leak or a lie:

1. **Tenant placement.** Demo rows belong to a real customer tenant. The runtime cascade is
   request-tenant → SYSTEM, two tiers (rule 00). `50000000-…` ("Global") must never appear as a
   fallback tier. Platform defaults that *should* be inherited go to SYSTEM; everything else is
   tenant-owned so the tenant-first path is actually exercised.
2. **It must prove tenant authorship (R1).** At least one **tenant-authored** published
   `WorkflowDefinition` that measurably differs from the SYSTEM default, plus a
   `WorkflowAssignment` binding it to a department — otherwise the seed demonstrates the platform
   default, which is precisely what the owner doubts.
3. **Two departments, two behaviours.** e.g. a Cardiology and a Paediatrics `DepartmentAgent`
   with different `ConsultationContextSchema` (SOAP variants), different `PromptTemplate`
   versions and different `DnaWritingStyle` — so "department + writing style change the output"
   is observable rather than asserted.
4. **A complete consultation trace.** Audio → `TranscriptSegment[]` → `NamedEntity[]` →
   `Highlight[]` → realtime pre-summary → autofilled SOAP `ContextItem` → clinician-edited
   `ContextItemVersion` → finalized `SummaryMeta` → `GateEditExemplar` (original + edit) →
   `AgentTrajectoryStep[]` → `WorkflowRun` with per-node status. Every UI panel named in §2 must
   have a row it can render; a panel with no seed row is itself a finding.
5. **At least one deliberate near-miss** — a low-confidence entity, a guardrail flag, a drug-name
   correction — so suggestion/correction surfaces are not seeded into a state where they are
   invisible.
6. **Fixtures for testability (R2).** `WorkflowTestFixture` + `GoldenSet`/`GoldenCase` rows so the
   Studio's test/sandbox path has something to run against.
7. **No PHI.** Synthetic patients only; respect the PHI-encryption path in `seed/phi-encryption.ts`.
8. **Honest provenance.** Where a blob must match compiler/validator output (as
   `21-workflow-definition.ts` documents), it is generated from the real `compile()`/`validate()`
   and pasted — never hand-typed, never a fabricated clean report.

---

## 5. Deliverables

| File (under this ticket dir) | Contents |
|---|---|
| `capability-map.md` | The five surfaces joined into one map: capability → contract → endpoint → table → UI |
| `requirements-traceability.md` | R1–R7 × verdict × evidence |
| `seam-findings.md` | Severity-ranked seam defects with failure scenarios and minimal fixes |
| `seed-spec.md` | The demo dataset specification (§4) |
| `README.md` (this file) | Updated with Implementation Summary + Change History |

## 6. Verification criteria

- Every claim in every deliverable carries a `file:line` citation; uncited claims are removed.
- R1–R7 each carry an explicit verdict — no requirement left unaddressed.
- Findings are re-verified by the orchestrator against the live tree before publication
  (rule 14 §2: a report is true only for the moment it was written).
- No source file is modified in Stages 1–2; `git status` at the end of Stage 2 shows only
  additions under `docs/implementation/TASK-789-*/`.

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-22 | Plan authored; owner settled §0 (branch `dev-2.2`, report-first, ArcaAI seed tenant). |
| 2026-08-22 | Stage 1 complete — five read-only mappers (A1–A5). All decisive claims re-verified by the orchestrator against the tree. `seam-findings.md` and `requirements-traceability.md` written. |
| 2026-08-22 | A3's headline claim (node registry near-empty) found FALSE and corrected — registry holds 30 entries in exact TS↔Python parity. Independently confirmed by A2 via key-set diff. |

## Implementation Summary (Stage 1)

**Owner's hypothesis confirmed, and located precisely.** The five surfaces are each internally
coherent; the seams between them are broken in specific, nameable places.

**Root cause — two parallel agentic-loop substrates, neither retired:**

- **Substrate A (live)**: `ConsultationLoopWorkflow` + `HarnessDocWorkflow`, driven by
  `DepartmentAgent` and a fixed 7-key action vocabulary. Entered from the gateway via
  `signal/context-added`. This is what runs during a real consultation.
- **Substrate B (authored)**: `WorkflowInterpreter` over a tenant-authored, compiled
  `WorkflowDefinition` graph with a 30-node registry. Reachable only from the Workbench sandbox and
  the `api invoke` exposure plane. Never runs a consultation — and its real (non-sandbox) invoke is
  broken because `WorkflowExposureService.invoke()` does not forward the payload every consultation
  node needs for identity.

Workflow Studio authors graphs for an engine that never runs a consultation; the playground runs an
engine Workflow Studio does not author.

**Six critical findings** (detail + citations in `seam-findings.md`): C-1 no `consultation open`
trigger and the assignment cascade has no production caller · C-2 Substrate B's real invoke path is
broken by its own admission · C-3 the playground cannot edit the SOAP note, though the OCC-protected
backend edit path is complete · C-4 `GateEditExemplar` has no live writer — `GateEditMiningQueue` is
the only `@Processor` in `packages/applications` registered in no module — and its retrieval half is
separately disconnected · C-5 `GoldenCase` has no automated producer from clinical data · C-6 no
fine-tuning export path exists anywhere.

**Requirement verdicts**: R6 IMPLEMENTED · R3/R4/R7 PARTIAL · R2 ABSENT · R1/R5 CONTRADICTED
(built, defeated by a live path). See `requirements-traceability.md`.

### Stage 2 (adversarial refutation) — two Stage-1 findings struck

The two-substrate claim was submitted to an agent tasked with refuting it. **Result: PARTIALLY
REFUTED.** The *execution* separation survived all six hypotheses. The *conclusion* did not.

- **C-2 struck.** "The real invoke path is broken" was based on a stale Python docstring;
  `workflow-exposure.service.ts:141` does forward `payload: dto.input`.
- **R1 revised CONTRADICTED → PARTIAL.** Publishing an `stt`-palette graph compiles it into a real
  `AsrPipeline` through the production `PipelineService` and it appears unfiltered in the
  playground's Listener selector. A tenant's Studio graph *does* change live consultations — via
  the STT catalog, not the loop.
- **C-8 added.** The exposure plane can write real `ContextItem` rows through the same
  `persist_draft` activity Substrate A uses; the sandbox suppression only fires when `sandbox` is
  true. Held shut by `WORKFLOW_EXPOSURE_ENABLED=false`, whose own descriptor names the precondition.

Both struck findings had the same cause: a code comment trusted over the code it describes.

### Stage 3 (seed spec) — `seed-spec.md`

816 lines, every table/column/ID verified against the live schema. Buildability split:
**19 SEEDABLE NOW · 8 SEEDABLE BUT INERT · 7 BLOCKED · 2 already seeded · 1 deliberately excluded**,
plus a 10-item wiring list (W1–W10) mapping each blocked element to the change that unblocks it.

Both designed consultation-palette graphs were run through the real `validate()`/`compile()` and
come back `ok: true` with zero findings against the full 19-rule `WF-CONS-*` set — a stronger
position than the seeded SYSTEM row, whose report is explicitly scoped because the full catalogue
ERRORs against it.

It also surfaced **C-9**, which the five mapping agents missed: every interpreter node emits
`stepType: "NODE"`, and `AgentStepType` has no `NODE` member, so every interpreter trajectory post
is rejected 400 and swallowed. Even with C-1 fixed, every graph run's trace would be empty.

### Concurrency caveat

Another session committed to this checkout mid-review (`1560feeb9`, `23954a663`). C-3 was
re-verified against the post-commit tree and stands. See `seam-findings.md` §Provenance.
