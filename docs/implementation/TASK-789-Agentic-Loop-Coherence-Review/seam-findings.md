# TASK-789 — Seam Findings

Status: Stage 1 COMPLETE (A1–A5). Every finding below was re-verified by the orchestrator against
the working tree, not accepted on an agent's word.

## The headline: two agentic-loop substrates that never meet

| | **Substrate A — what runs** | **Substrate B — what you author** |
|---|---|---|
| Engine | `ConsultationLoopWorkflow` + `HarnessDocWorkflow` (`temporal/workflows.py:1895`, `:280`) | `WorkflowInterpreter` (`temporal/interpreter/workflow.py:88`) |
| Config | `DepartmentAgent` + a **fixed 7-action vocabulary** | Tenant-authored `WorkflowDefinition` → compiled graph |
| Vocabulary size | 7 hardcoded action keys (`temporal/models.py:1153-1172`) | 30 registry node types, 3 palettes |
| Authored in | Agents screen | **Workflow Studio** |
| Entered via | Gateway `POST /internal/workflows/:id/signal/context-added` (`harness-gateway.service.ts:399`) | `POST /workflow-runs:start` — **sandbox / api-invoke only** |
| Drives a real consultation? | **YES** | **NO** |

**Workflow Studio authors graphs for an engine that never runs a consultation's LOOP. The
playground runs an engine Workflow Studio does not author.** That is the disconnection, located.

**But the two substrates are not hermetically separate** — they share a write plane and a
configuration plane. See C-7 below, which materially narrows this claim.

---

## CRITICAL

### C-1 — No `consultation open` trigger exists. The assignment cascade is never consulted.
`WorkflowRun.trigger` is documented as `consultation open | api invoke | webhook | schedule`
(`workflow-run.response.ts:34`). Only **two** values are ever stamped in production code:
`'workbench sandbox'` (`workflow-sandbox-run.service.ts:71`) and `'api invoke'`
(`workflow-exposure.service.ts:124`). `'consultation open'` appears only inside `@ApiProperty`
description strings and one test docstring — never as a stamped value.

`WorkflowAssignmentService.resolve()` — the department → tenant → platform-default cascade — has
**no production caller**; its only invocations are in
`workflow-assignment.resolution.test.ts`. `WorkflowsController.invoke` resolves purely by an
explicit `:slug` path param via `findPublishedBySlug`, bypassing the cascade entirely.

**Consequence:** R1's "tenant admin defines the workflow" is authorable but inert. Opening a
consultation dispatches nothing the tenant authored. The Assignment Matrix writes rows that
nothing reads.

### C-2 — ~~Substrate B's real invoke path is broken~~ **STRUCK — THIS FINDING WAS WRONG.**

Stage 2 refuted it. `WorkflowExposureService.invoke()` **does** forward the payload:
`workflow-exposure.service.ts:141` passes `payload: dto.input`, with a comment stating this was
previously missing and has since been fixed.

The Python docstring at `interpreter/models.py:128-136` still claims otherwise. **That docstring
is stale**, and Stage 1 quoted it as current fact. The real invoke path is not broken.

Correction discipline note: this is the same failure mode as A3's registry error — a code comment
trusted over the code it describes. The stale docstring should be corrected in the source.

### C-3 — The clinician cannot edit the SOAP note in the playground. R5 and R7 are unreachable.
`case-note-column.tsx:280` renders the draft as `<article aria-label="Personalized draft note">`
— inert text. The playground's only `PATCH` is job-cancel (`client.ts:72`); no summary-edit call
exists in its client.

The backend edit path is **fully built**: `PATCH :id/summary/:summaryId` with mandatory
`If-Match` (`consultation.controller.ts:1073-1109`), OCC via `updateWithVersion`
(`context.service.ts:522`), append-only `ContextItemVersion` with `contentDiff`/`fieldChanges`,
and a passing test `summary.service.edit-capture.test.ts`. **The UI never calls any of it.**

### C-4 — The fine-tuning feedback pipeline is complete, well-designed, orphaned code.
`GateEditMiningQueue.enqueue()` (`gate-edit-mining.processor.ts:19-33`) has **zero call sites**.
Every reference to `IGateEditMiningQueue` / `GateEditMiningQueue` / `MineGateEditExemplar` lives
inside `services/gate-edit-mining/` itself. No module registers
`BullModule.registerQueue({ name: JobQueue.MineGateEditExemplar })`, and
`GateEditMiningServiceModule.providers` omits the processor and queue entirely. The read side,
`IGateEditExemplarRetriever` (intended for few-shot prompt assembly), is likewise never consumed.

Orchestrator verification — every `@Processor` class in `packages/applications` enumerated, and
whether it appears in any `.module.ts`:

| Processor | Registered in |
|---|---|
| `WebhookDeliveryProcessor` | `webhook.service.module.ts` |
| `DnaWritingStyleProcessor` | `dna-writing-style.service.module.ts` |
| `PreSummaryProcessor` | `consultation-job.service.module.ts` |
| `ComprehensiveSummaryProcessor` | `consultation-job.service.module.ts` |
| `UsageOutboxProcessor` | `usage-ledger.service.module.ts` |
| `IngestKnowledgeDocumentProcessor` | `knowledge.service.module.ts` |
| `AuditLogProcessor` | `auditLog.service.module.ts` |
| `DirectorySyncProcessor` | `directory-sync.service.module.ts` |
| **`GateEditMiningQueue`** | **NOT IN ANY MODULE** |

It is the sole exception in the codebase.

**The retrieval half is independently dead too.** `PromptAssemblyService` injects
`IGateEditExemplarRetriever` with `@Optional()` (`prompt-assembly.service.ts:355`). Only two files
import `GateEditMiningServiceModule` — the module itself and `harness-admin.module.ts` (the admin
curation UI). None of the four modules that construct `PromptAssemblyService` for live generation
do. So even with C-4 fixed and rows present, generation would still see `undefined` and silently
degrade to zero-shot.

**Consequence:** `ContextItemVersion` correctly records edits alongside the AI original — R7's raw
substrate is sound — but nothing mines, curates, or retrieves it. The loop is open at both ends.

---

## HIGH

### H-1 — `WorkflowInvariantRule` has no HTTP surface at all.
Zero controllers in `apps/api/src` reference it (grep: no matches), so a tenant admin cannot
write a row. `WorkflowValidatorService` (169 lines, real merge-strictness logic, its own tests)
is imported nowhere outside its own module. `WorkflowDefinitionService.validateGraph()` calls
`validate()` directly against the static code-owned rule set (`workflow-definition.service.ts:468-473`),
never resolving invariant rows. The documented "tenant may add strictness rules" capability does
not exist in the running system.

### H-2 — The seeded platform-default workflow has silently drifted from the registry.
Seed `REGISTRY_CHECKSUM` (`seed/21-workflow-definition.ts:59`) =
`2ae7222a…` — self-documented as computed over **7** entries.
Current `registryChecksum()` = `9635b9a9…` over **30** entries. They do not match.

`node-registry.ts:558-563` promises this mismatch triggers `NEEDS_REVIEW` re-validation. But
`needsReview` is **never assigned `true` anywhere** in `packages/applications/src` or
`apps/api/src` — only entity/factory/mapper/DTO plumbing and a factory `?? false` default. The
drift exists and the mechanism designed to surface it does not.

### H-3 — R3's tail has no implementation anywhere.
Intelligent suggestions, and spelling / medical-term / drug-name correction, correspond to **no
node, activity, or sensor** in either substrate. The nearest neighbours only *verify*:
`consultation.bindTerminology` validates codes read-only (`consultation_nlp.py:167-260`); the
sensor suite flags mismatches without correcting them (`sensors/computational/numeric_dose.py`
flags a dose mismatch, never fixes it). Realtime *short summaries* likewise have no action —
`client.emit` only announces that an action ran; `harness.finalize` is lifecycle-end only.

### H-4 — R4's department scoping is real in the service layer and permanently dead at the input.
`consultation-demo-screen.tsx:300` calls `sdkSession.open({ patientId })`. `departmentId` exists
on the request type and on the SDK's `OpenSessionInput`, and the backend resolver reads it
(`summary.service.ts:367,606`) — but `consultation.departmentId` is null for every consultation
the playground opens, so the resolver can never fire. DNA style is the same:
`GenerateSummaryRequest.dnaStyleId` is never populated. The footer's "Note assistant" control is
decorative (`onNoteChange={() => undefined}`).

### H-5 — `dispatch_batch_transcription` is registered but has no workflow caller.
Documented as "the ONE place harness dispatches STT batch work"; defined at `activities.py:1475`,
registered at `:2620`, and called only by its own unit tests. The 9-node STT palette's execution
story is unwired end to end. `SttPipelineResolverService` is exported for a consumer its own
module comment calls "a FUTURE, separate wiring pass" — and it is injected nowhere.

---

## MEDIUM

- **M-1** `guardrail.check`'s `config.onFail: 'abort'` is accepted and recorded but has no
  enforcement mechanism — `critical` is a code-owned registry property no config value can
  override (`nodes/guardrail_check.py:13-22`). A tenant authoring `abort` gets silent non-enforcement.
- **M-2** `output.deliver` writes its result to claim-check storage with no read-back path — no
  callback endpoint, no `resultRef` column (`nodes/deliver.py:16-22`).
- **M-3** Two hand-authored node vocabularies (TS `WORKFLOW_NODE_REGISTRY`, Python
  `NODE_REGISTRY`) kept in sync by a committed JSON fixture plus matching tests. Currently in
  exact parity (30 keys, zero drift both directions) — but parity is a *test* invariant, not a
  structural one.
- **M-4** `ContextItemEntityMapper` lacks the `FIELDS_NOT_WRITABLE = ['version']` guard rule 03
  mandates for OCC-written models (its sibling `SummaryMetaEntityMapper:18` has it). Not currently
  exploitable — `Repository.updateWithVersion` strips `version` as defense in depth
  (`repository.ts:216-219`) — but a genuine one-line convention violation.
- **M-5** Two parallel client-side SSE stacks solve the identical ticket-mint → EventSource →
  reconnect problem: the SDK's `SSEClient` (`useArcaLiveSummary.ts:21,66`) and the admin console's
  `use-event-stream.ts:52-120`.
- **M-6** `DocumentationReviewPanel` is dead code — no route, no importer outside its own test.
- **M-7** The async summary path (`generateSummaryAsync`, `getConsultationJob`,
  `cancelConsultationJob`, `consultationJobStreamPath`, plus 91 lines of merge logic in
  `useSummaryJobProgress`) is fully implemented with zero call sites in any screen.
- **M-8** Hardcoded model/engine selection as pydantic-settings defaults, contrary to rule 00:
  `SafetyGuardConfig.model = "granite-guardian-4.1-8b"`, `provider = "lm-studio"`
  (`harness/core/config.py:82-84`), `RetrievalConfig.embeddings_model = "text-embedding-bge-m3"`
  (`config.py:198-201`). Notable because the *same runtime* resolves its judge model correctly via
  tenant → SYSTEM `AiTaskDefault` and fails closed when unresolved.

---

## Corrections to Stage-1 agent reports

**A3's D-1 was wrong.** It reported the node registry ships only `noop`/`passthrough`, concluding
no clinical workflow could be authored. It trusted a stale docstring and a TASK-719 contract doc
over the code. The registry actually carries **30 entries across three palettes** —
`consultation` (13), `stt` (9), `summarization` (6), plus 2 boundary markers and 2 utility nodes —
independently confirmed by A2 via a key-set diff against the Python registry (zero drift). A3's
downstream D-3 ("assignment matrix renders zero columns") inherits the same error.

A3's other findings (D-2 no workflow test-run control; D-4 the `WorkflowDefinition` /
`DepartmentAgent` model split; D-6 DNA style is a binary `INHERIT|DISABLED` gate, never a
selector) were spot-checked and hold.


---

## Added by A5 (feedback & training capture)

### C-5 — `GoldenCase` has no automated producer from clinical data.
The only DB write path is a manual admin `POST /admin/harness/golden-sets/:id/cases`
(`eval.service.ts:152-165`). No code path connects a signed, clinician-edited consultation — or a
`GateEditExemplar` — into a `GoldenCase`. Curation only advances a row's `curationStatus`; it never
creates a golden case. The harness's own module docstring is explicit
(`eval/golden/sources.py:8-32`):

> the shipped fixture is *synthetic* and exists only to exercise the harness end-to-end and keep CI
> hermetic. The Phase-0 exit gate … requires the **REAL clinician-authored golden set** … That set
> is an outstanding prerequisite and MUST replace this fixture before any eval result is used to
> gate a clinical claim.

So `EvalRun`/`EvalScore` work end to end, but no eval result in this system is derived from real
clinician behaviour.

### C-6 — There is no fine-tuning export path anywhere.
The nearest thing is `GET /admin/harness/gate-edit-exemplars` — a JSON admin read, capped at 500
rows, of a table that is always empty. No job, script, or endpoint assembles
`(original, edited, context)` triples into a dataset artifact. **R7's second clause — "used for
fine-tuning and training models" — is structurally unmet**: no code could consume the captured
data for that purpose even on the day C-4 is fixed.

### H-6 — `Fedl*` is schema-only.
`FedlClient` / `FedlRound` / `FedlUpdate` / `FedlModelVersion` have no domain entity, repository,
service, or controller. The only non-schema references are a generic coverage checker and RBAC
permission seed rows. Zero writers, zero readers.

### M-9 — Quality-signal thresholds are hardcoded literals.
`APPROVED_CLEAN_MAX_RATIO = 0.05`, `HEAVILY_EDITED_MIN_RATIO = 0.3`
(`gate-edit-mining.service.ts:32-33`) decide the training-label taxonomy. Per rule 00 these belong
in `db-config` with a tenant → SYSTEM cascade. Moot while the pipeline is dead; a violation the
moment it is wired.

---

## What is genuinely sound (do not "fix" these)

Not everything is a seam. Three things verified as correct and worth protecting:

1. **R6 holds, and is well built.** Exactly one site transitions a consultation to SIGNED —
   `summary.service.ts:1184`, inside `approveSummary`. It throws without a request user id, the
   route carries ownership verification plus `@RequiresIfMatch()` OCC, and the harness's own
   gate-decision callback explicitly *cannot* flip status — its comment states apps/api has already
   written the SIGNED_NOTE + ATTEST as system-of-record. The machine cannot finalize.
   `POST admin/workflow-runs/:runId/gate/approve` carries a matching AUTH-NOTE with
   `@Authorize(['update','Consultation']) @ForbidServiceAccount()`, deliberately overriding the
   class-level read scope so that listing runs never implies signing authority.
2. **R7's capture substrate is real.** `ContextItemVersion` is append-only with a genuine
   authorship discriminator (`changeReason` / `changeSource` / `changedBy`), an immutable
   `ai_draft_v1` baseline, `contentDiff` / `fieldChanges`, Vault-Transit encryption, and
   attestation fields. `approveSummary` additionally diffs the AI baseline against the final signed
   content. The original *is* retained beside the edit. Only the consumers are missing.
3. **Cross-language registry parity is enforced.** TS `WORKFLOW_NODE_REGISTRY` and Python
   `NODE_REGISTRY` carry the identical 30 keys with zero drift, held by a committed fixture plus
   matching tests on both sides.


---

## Added by Stage 2 (adversarial refutation) — the claim was too strong

Stage 2 was tasked with refuting the two-substrate conclusion. It **partially succeeded**. The
*execution* separation holds — no dispatch path stamps `'consultation open'`, no caller invokes
`WorkflowAssignmentService.resolve()`, `HarnessDocWorkflow`/`internal.py` never start a
`WorkflowInterpreter`, and `ConsultationLoopWorkflow`'s config reads no `WorkflowDefinition`. All
five hypotheses testing for a hidden loop-dispatch path dead-ended.

The *conclusion drawn from it* — "a tenant admin's Workflow Studio graph has no effect on any live
consultation" — is **false**.

### C-7 — Publishing an `stt`-palette graph mutates the live ASR catalog. LIVE TODAY, ungated.

`WorkflowDefinitionService.publish()` calls `compileSttPipelineIfNeeded`
(`workflow-definition.service.ts:333`), which calls `SttPipelineCompilerService.compileAndPublish`
(`compilers/stt-pipeline.compiler.ts:166-186`). That writes a **real `AsrPipeline` +
`AsrPipelineVersion`** through the production `PipelineService` — `create` on first publish,
`update` + version snapshot on republish. Not a shadow table; the same rows every other pipeline
lives in.

Orchestrator-verified chain to a live consultation:
`GET audio/pipelines` (`audio-pipeline-catalog.controller.ts:36`) returns `pipelineService.getAll()`
— all ENABLED pipelines for the tenant, **with no provenance filter**. So a workflow-compiled
pipeline appears in the consultation playground's Listener selector beside hand-authored ones, and
is bindable either explicitly (`body.pipelineId`, `audio.start({ pipelineId })`) or implicitly via
`resolveDefaultPipelineId`'s `isDefault` pick (`transcription-job.controller.ts:245-256`).

Gating: only the `paletteStt` entitlement, which `workflow-definition.service.ts:425` documents as
**a no-op while the entitlements kill-switch is OFF**. `WORKFLOW_EXPOSURE_ENABLED` does not gate
this at all — that flag guards the exposure plane, not the admin publish path.

**So R1 is TRUE for the STT palette and false for the consultation palette.** A tenant admin authoring
an `stt` graph in Workflow Studio genuinely changes how live consultations are transcribed, today.

Note the earlier Stage-1 reading of `SttPipelineResolverService` ("exported for a future consumer,
injected nowhere") was true but misleading: the unwired piece is only the *slug → pipelineId
convenience binding*. The **compiler** is fully wired and already mutates the live catalog.

### C-8 — The exposure plane can write to a real consultation. Kill-switched, not architecturally barred.

With C-2 struck, this chain is structurally complete:
`POST /workflows/:slug/invoke` forwards caller-controlled `dto.input` verbatim into
`InterpreterInput.payload` with `sandbox: false` (`workflow-exposure.service.ts:133,141`) → every
node's `run_payload` → consultation-palette nodes read `consultationId` / `externalPatientId` /
`userId` / `jobId` from it (`nodes/_consultation_shared.py:45-57`) → `consultation_persist.py:82-90`
calls **the same `persist_draft` activity `HarnessDocWorkflow` uses** (`activities.py:2155`, used at
`workflows.py:1109,1501`).

The sandbox suppression at `interpreter/workflow.py:228` reads
`if inp.sandbox and spec.external_write:` — it fires **only** when `sandbox` is true, so it does not
apply to the exposure plane.

What holds it shut today:
- `WORKFLOW_EXPOSURE_ENABLED` = `false` in `.env.dev:292` (`true` in `.env.test:2453`), returning
  404 while off. Its descriptor (`feature-flags.descriptors.ts:77`) states the precondition
  explicitly: *"TASK-708's API-key scope enforcement must be verified end-to-end before this ships
  enabled; Temporal is also not yet production-ready."*
- The route requires the `workflow:run:write` scope (`workflows.controller.ts:56`).

**Why this matters before the flag flips:** the route carries no `@ForbidApiKey`, so it is
API-key-reachable by design, and Workflow Studio's `paletteKey` is a free-text `<Input>`
(`create-definition-form.tsx:59`) with no client-side restriction to safe palettes. Enabling the
flag without closing that gap means a scoped API-key holder can drive writes into a real
consultation's `ContextItem` through a published consultation-palette graph. This should be treated
as a precondition on the kill-switch, not discovered after it flips.

### Corroborating evidence that the consultation palette is intended to be live

- All 13 consultation nodes are `implemented=True` (`interpreter/registry.py:284-407`) — not stubs.
- `rule-catalogue.ts:472-476` makes `consultation.persistDraft` a **mandatory** node for the palette,
  and `:567-571` requires `occ: true` on it. Mandatory-node rules are not written for a palette
  nobody can run.
- `interpreter_consultation_consent_gate` enforces **real** consent against
  `ConsentPurpose.AI_DOCUMENTATION` using the payload's `externalPatientId`. A purely synthetic
  substrate would not need that.
- `ConsultationGateWorkflow` (`external_write=True`, `critical=True`) is a durable human-in-the-loop
  approval surface with live `/gate` and `:approve` routes.

### Restated claim (this supersedes the headline framing above)

> The two substrates are **separate executors that share a write plane and a configuration plane** —
> not two non-interoperating systems.
>
> Substrate B's interpreter never executes as the **governing loop** of a live consultation, and
> that separation is real and well-evidenced. But a tenant's Workflow Studio graph *does* reach live
> consultations by two non-loop mechanisms: the `stt`-palette compile-to-`AsrPipeline` lane (live,
> ungated, today) and the exposure plane's shared write activities (one flag away).

---

## Added by Stage 3 — a finding the mapping stages missed

### C-9 — Every interpreter run's trajectory is silently dropped. Enum mismatch, swallowed 400.

`apps/harness/src/harness/temporal/activities.py` declares nine step-type constants. Eight of them
match `AgentStepType` members exactly:

```
155: STEP_PHASE     = "PHASE"       ✓        160: STEP_GUARDRAIL = "GUARDRAIL"  ✓
156: STEP_TOOL_CALL = "TOOL_CALL"   ✓        161: STEP_THINKING  = "THINKING"   ✓
157: STEP_RETRIEVAL = "RETRIEVAL"   ✓        162: STEP_GATE      = "GATE"       ✓
158: STEP_LLM_CALL  = "LLM_CALL"    ✓        166: STEP_NODE      = "NODE"       ✗ NOT IN THE ENUM
159: STEP_SENSOR    = "SENSOR"      ✓
```

`AgentStepType` (`agent-trajectory.prisma:38-50`) has exactly: `LLM_CALL`, `TOOL_CALL`, `SENSOR`,
`RETRIEVAL`, `GUARDRAIL`, `THINKING`, `SIGNAL`, `GATE`, `PHASE`. **There is no `NODE`.**

Every Substrate-B interpreter node emits `step_type=STEP_NODE`
(`interpreter/nodes/_shared.py:38`). The ingest DTO validates
`@IsEnum(AgentStepType) stepType` (`harness-internal.controller.ts:176-178`), so every such post is
rejected 400 — and because the trajectory post is fire-and-forget, the rejection is swallowed.

**Consequence:** even with C-1 fixed and C-2 already false, **every interpreter run's trace would be
empty**. `/workflow-runs/:id/trace` would render nothing for a graph run.

**Why this sharpens the two-substrate finding:** the one step type that is invalid is the one used
*exclusively* by the interpreter. Substrate A's eight are all valid. This is direct evidence that
Substrate B's observability path was never exercised end to end against a real gateway — a mismatch
this mechanical cannot survive one live run.

Fix is one enum member plus an `ALTER TYPE … ADD VALUE` migration (rule 03 §4 requires the enum be
added in both `agent-trajectory.prisma` and the domain enum).

---

## Provenance and concurrency caveat

**Another session wrote to this checkout during the review.** Two commits landed mid-run:
`1560feeb9 fix(TASK-787,TASK-788)` (touching the consultation playground page,
`case-note-column.tsx`, `nav-config.ts` and four e2e specs) and `23954a663 docs: update current
active branch in CLAUDE.md from feat/loop to dev-2.2` — which independently fixed the stale-branch
issue this review flagged in §0.

Consequence for these findings: the working-tree state A4 analysed has since been committed, and the
uncommitted-diff caveat in its report is stale. **C-3 was re-verified against the post-commit tree**
— `case-note-column.tsx:280` still renders `<article>`, still with no write path — so the finding
stands. Findings in `packages/applications`, `apps/harness` and `packages/workflow-contract` were
untouched by those commits.

Per rule 14 §3 this checkout has more than one writer; anyone acting on these findings should
re-verify against `HEAD` at the time of the fix rather than trusting this document's line numbers.
