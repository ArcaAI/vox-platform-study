# TASK-789 — Demo Seed Specification

Status: **Specification — awaiting owner review. No `seed/*.ts` written, no schema touched.**

Target tenant: **ArcaAI**, `50000000-0000-0000-0000-000000000001`
(`SEED_CUSTOMER_TENANT_IDS.ARCAAI`, `packages/database/src/prisma/db_main/seed/00-constants.ts:124`).

This document is the Stage-3 deliverable of the review recorded in `README.md`,
`seam-findings.md` and `requirements-traceability.md`. It designs the dataset that would make the
agentic loop **visible, testable and demonstrable**, and marks every element against what the
running code can actually do today.

---

## 1. Summary

### What this dataset demonstrates

1. **A tenant really can author a clinical workflow.** Two ArcaAI-owned `WorkflowDefinition` rows
   on the real `consultation` palette (13 node types), each **compiled and validated by the actual
   engine** — not hand-typed. Both are measurably different from the SYSTEM default
   `platform-default-summarization` (4 nodes, `summarization` palette,
   `seed/21-workflow-definition.ts:70-116`): 14 and 15 nodes, a human gate, a PHI hop, a
   terminology bind, and a per-department DNA-style binding.
2. **Department + writing style change the output, observably.** Two ArcaAI departments —
   General Medicine (`GEN`) and Rheumatology (`RHEUM`) — each with its own
   `ConsultationContextSchema` (a SOAP variant), its own `PromptTemplate`/`PromptVersion` pair, its
   own `DnaWritingStyleReport`, and a `DepartmentAgent` binding them. Two seeded consultations,
   one per department, show two visibly different notes from the same platform.
3. **One complete consultation trace, end to end.** Audio → `TranscriptSegment[]` →
   `NamedEntity[]` → `Highlight[]` → pre-summary → autofilled SOAP `ContextItem` →
   clinician-edited `ContextItemVersion` **with the immutable `ai_draft_v1` baseline retained** →
   attested `SummaryMeta` + signed version → `AgentTrajectoryStep[]` → a hash-chained
   `HarnessAuditEvent` WORM trail. This is the R5/R6/R7 substrate rendered as data.
4. **A deliberate near-miss.** A second consultation parked in `PENDING_REVIEW` with a guardrail
   `safety: FLAG`, a 0.41-confidence entity, an unmapped terminology term and a low RAG-triad
   score — so the verification surfaces are not seeded into an invisible all-green state, and so
   the sign-off safety stop (`summary.service.ts:1264-1269`) is demonstrable.
5. **Fixtures with something to run.** Two `WorkflowTestFixture` rows for the Workbench sandbox,
   a `GoldenSet` with two `GoldenCase` rows, and one `EvalRun` with four `EvalScore` rows.

### What this dataset deliberately does **not** demonstrate

- **It does not show a tenant-authored workflow governing a live consultation.** No code path does
  that (**C-1**). The two definitions and their assignments are seeded as what they honestly are:
  *authored, published, assigned — and never dispatched*. No `WorkflowRun` with
  `trigger: 'consultation open'` is seeded, because that value is never stamped in production code
  (`seam-findings.md` C-1).
- **It does not show a graph run producing a node trace.** See **NEW-1** below — a defect this
  review did not previously record.
- **It does not fabricate a fine-tuning corpus.** No export artifact exists to seed (**C-6**).
- **It does not fabricate a governance act.** No `AgentPromotion` row is seeded (see §3.7).

### NEW-1 — a finding not in `seam-findings.md`

**Every Substrate-B interpreter node emits a trajectory step the gateway rejects.**

`record_and_flush` stamps `step_type=STEP_NODE`
(`apps/harness/src/harness/temporal/interpreter/nodes/_shared.py:38`), and
`STEP_NODE = "NODE"` (`apps/harness/src/harness/temporal/activities.py:166`). The gateway ingest
DTO validates that field with `@IsEnum(AgentStepType)`
(`apps/api/src/modules/consultation/harness-internal.controller.ts:176-178`), and
`AgentStepType` has **no `NODE` member** — its nine values are `LLM_CALL TOOL_CALL SENSOR
RETRIEVAL GUARDRAIL THINKING SIGNAL GATE PHASE`
(`packages/database/src/prisma/db_main/agent-trajectory.prisma:38-50`,
`packages/domains/src/enums/generated/AgentStepType.ts:5-14`). The Python side types it as a bare
`step_type: str` (`apps/harness/src/harness/services/api_client.py:152`) and the post is
fire-and-forget, so the 400 is swallowed silently — the controller's own comment even names that
failure mode ("the harness fire-and-forget then silently drops",
`harness-internal.controller.ts:198-201`).

`STEP_NODE` is used in exactly two places, both inside the interpreter
(`interpreter/activities.py:88`, `interpreter/nodes/_shared.py:38`) — never by Substrate A, whose
`PHASE`/`LLM_CALL`/`SENSOR`/`GUARDRAIL`/`TOOL_CALL`/`RETRIEVAL`/`GATE` steps are all valid members.

**Consequence:** even with C-1 and C-2 fixed, `getRunTrace` would return `nodes: []` for every
interpreter run (`workflow-run.service.ts:239-268` folds steps by `step.name`, and there would be
no steps). The Runs screen's trace view is structurally empty for Substrate B. This is why §3.3
marks the interpreter trajectory rows **BLOCKED ON NEW-1** rather than seeding a shape the runtime
cannot produce.

### Two facts the seed itself surfaces

- **The typed `Consultation.status` column is never seeded.** `09-consultation.ts` sets only
  `metadata.status` (e.g. `'CLOSED'`, `'REVIEW'` — lines 76, 92, 245, 261); the typed column
  (`consultation.prisma:36`) is left at its `OPEN` default. So the Gate Queue
  (`harness-observability.service.ts:176-180`, which reads `findPendingReviewForTenant` +
  `findTimedOutForTenant`) is **empty on a freshly seeded database**, and every seeded consultation
  reads `OPEN` in the console. Every new consultation in this spec sets the typed column.
- **The `E0000000-…` id block was handed out twice.** `00-constants.ts:80-84` reserves it for
  Service Accounts, and `SEED_SERVICE_ACCOUNT_IDS.ARCAAI_ADMIN` is
  `e0000000-0000-0000-0000-000000000001` (`:354`) — but `SEED_CONSENT_GRANT_IDS.PAT_001_TOOL_LOOKUP`
  is `E0000000-0000-0000-0000-000000000001` (`:833`), the same UUID. Different tables, so no PK
  collision, but it violates the file's own "so the block is not handed out twice" rule (`:91`).
  Not this ticket's to fix; recorded so the new blocks in §4.1 are not allocated on top of it.

---

## 2. Buildability ledger

Legend:
**NOW** = the tables, columns and code paths exist; seeding it produces something a user can see
work today · **INERT** = the row can be written and will render in an admin screen, but no runtime
path consumes it · **BLOCKED** = cannot be honestly seeded until named wiring lands.

| # | Element | Rows | Verdict | Why |
|---|---|---|---|---|
| **Area 1 — tenant-authored workflow (R1)** ||||
| 1.1 | `WorkflowDefinition` `arcaai-consultation-soap` v1 (PUBLISHED, isActive) | 1 | **INERT** | Renders + is editable in Workflow Studio and re-validatable; **BLOCKED ON C-1** for dispatch — no `consultation open` trigger exists |
| 1.2 | `WorkflowDefinition` `arcaai-rheum-consultation-soap` v1 | 1 | **INERT** | Same as 1.1 |
| 1.3 | `WorkflowAssignment` TENANT → `arcaai-consultation-soap` | 1 | **INERT** | Renders in the Studio assignment matrix; `WorkflowAssignmentService.resolve()` has no production caller (**C-1**) |
| 1.4 | `WorkflowAssignment` DEPARTMENT(RHEUM) → `arcaai-rheum-consultation-soap` | 1 | **INERT** | Same as 1.3; exercises the department→tenant cascade only in tests |
| 1.5 | `WorkflowAssignmentChange` (creation rows) | 2 | **INERT** | Append-only WORM trail; no read endpoint exists in `apps/api/src/modules/workflow-assignment` |
| **Area 2 — two departments, two behaviours (R4)** ||||
| 2.1 | `ConsultationContextSchema` GEN (DEPARTMENT scope) + `…Version` | 2 | **NOW** | Renders in `/context-schemas`; DEPARTMENT scope wins over the tenant default in discovery (`consultation-context-schema.prisma:36-40`) |
| 2.2 | `ConsultationContextSchema` RHEUM (DEPARTMENT scope) + `…Version` | 2 | **NOW** | Same as 2.1 |
| 2.3 | `PromptTemplate` / `PromptVersion` per department | 0 new | **NOW (already seeded)** | `07b-arcaai-clinical-templates.ts:158-183`, v3 approved |
| 2.4 | `DnaWritingStyleReport` / `…Version` per doctor | 0 new | **NOW (already seeded)** | `08-dna-writing-style.ts:400-499` |
| 2.5 | `DepartmentAgent` / `…Version` per department | 0 new | **NOW (already seeded)** | `07a-agent-golden-library.ts:357-404` |
| 2.6 | Per-department DNA **selection** | — | **INERT** | `DepartmentAgent.dnaStylePolicy` is `INHERIT\|DISABLED` only (`department-agent.prisma:42`) — a gate, not a selector. See §3.2 |
| **Area 3 — the complete consultation trace (R3–R7)** ||||
| 3.1 | `Consultation` C1 (GEN, typed `status: SIGNED`) | 1 | **NOW** | Appears in the playground consultation list and in `/consultations` |
| 3.2 | `Consultation` C2 (RHEUM, typed `status: PENDING_REVIEW`) | 1 | **NOW** | Populates the Gate Queue — the first row that ever will |
| 3.3 | `ContextItem` (TRANSCRIPT ×2, AUDIO ×1, PRE_SUMMARY ×1, RAW_SUMMARY ×2, CASE_NOTE ×1) | 7 | **NOW** | Standard `09-consultation.ts` pattern |
| 3.4 | `TranscriptSegment` | 11 | **NOW** | First rows ever; required for `citedSegments` (`summary.service.ts:1332-1355`) |
| 3.5 | `Media` + `AudioRecording` | 3 + 1 | **NOW** | Mirrors the dual-capture demo (`09-consultation.ts:734-821`) |
| 3.6 | `NamedEntity` (incl. one low-confidence, one uncoded) | 8 | **NOW** | Renders in the entity panel |
| 3.7 | `Highlight` | 3 | **NOW** | First rows ever; full CRUD API exists (`consultation.controller.ts:929-965`) |
| 3.8 | `ContextItemVersion` `ai_draft_v1` baseline | 2 | **NOW** | The R7 substrate — `changeReason: 'ai_draft_v1'` (`summary.service.ts:1769`) |
| 3.9 | `ContextItemVersion` clinician edit (`user_edit`, with `contentDiff`/`fieldChanges`) | 1 | **NOW** | The R5 evidence; the backend edit path is real (`consultation.controller.ts:1073-1109`) even though the playground never calls it (**C-3**) |
| 3.10 | `ContextItemVersion` signed (`approved` + attestation) | 1 | **NOW** | Mirrors `CreateSignedNoteVersion` (`ContextItemVersionFactory.ts:86-93`) |
| 3.11 | `SummaryMeta` (citationsMap, guardrailDecisions, gateDecision, assurance) | 2 | **NOW** | Requires extending `SEED_PHI_MODELS` (§4.3) |
| 3.12 | `HarnessAuditEvent` WORM chain | 9 | **NOW** | First rows ever; requires a verbatim hash-chain copy (§4.3) |
| 3.13 | `AgentTrajectoryStep` — Substrate A (`HARNESS_DOC`, `PHASE`/`LLM_CALL`/`SENSOR`/`GUARDRAIL`) | 14 | **NOW** | All step types are valid `AgentStepType` members |
| 3.14 | `AgentTrajectoryStep` — Substrate B (interpreter node steps) | 0 | **BLOCKED ON NEW-1** | The runtime emits `stepType: "NODE"`, which the ingest DTO rejects; seeding any other value fabricates a shape the runtime cannot produce |
| 3.15 | `WorkflowRun` with `trigger: 'workbench sandbox'` (isSandbox) | 1 | **NOW** | `'workbench sandbox'` is really stamped (`workflow-sandbox-run.service.ts:71`); the Runs list renders it |
| 3.16 | `WorkflowRun` with `trigger: 'consultation open'` | 0 | **BLOCKED ON C-1** | That value is never stamped in production code — seeding it asserts a dispatch that never happened |
| 3.17 | Trace for 3.15 (`getRunTrace` → `nodes[]`) | 0 | **BLOCKED ON NEW-1** | Empty by construction; the seeded run row honestly shows `tracePruned: false, stepCount: 0` |
| **Area 4 — feedback / training (R7)** ||||
| 4.1 | `GateEditExemplar` (APPROVED_CLEAN + HEAVILY_EDITED) | 2 | **INERT** | Renders in `/harness` ops + the curation queue; **BLOCKED ON C-4** for both the writer (`GateEditMiningQueue` is in no module) and the retriever (no live-generation module imports `GateEditMiningServiceModule`) |
| 4.2 | `GoldenSet` (ArcaAI, department-scoped to GEN) | 1 | **NOW** | `GET admin/harness/golden-sets` renders it; `EvalRun` can execute against it |
| 4.3 | `GoldenCase` | 2 | **NOW** (synthetic) | Rows render and score. **BLOCKED ON C-5** for the *provenance claim* — no producer turns a signed consultation into a golden case, so these are hand-authored synthetic cases and must say so |
| 4.4 | `EvalRun` + `EvalScore` | 1 + 4 | **NOW** | `/harness` eval-runs renders both |
| 4.5 | Fine-tuning export artifact | 0 | **BLOCKED ON C-6** | Not a table; no job, script or endpoint assembles `(original, edited, context)` triples |
| 4.6 | `FedlClient` / `FedlRound` / `FedlUpdate` / `FedlModelVersion` | 0 | **BLOCKED ON H-6** | Schema-only: no entity, repository, service or controller |
| **Area 5 — deliberate near-miss** ||||
| 5.1 | Low-confidence `NamedEntity` (0.41) | 1 | **NOW** | Counted in 3.6 |
| 5.2 | Uncoded `NamedEntity` (no SNOMED/ICD/RxNorm) | 1 | **NOW** | Counted in 3.6; exercises the groundedness guard |
| 5.3 | `SummaryMeta.guardrailDecisions = { safety: 'FLAG' }` + `gateDecision: 'FLAG'` | 1 | **NOW** | Hard-blocks sign-off (`summary.service.ts:1264-1269`) — a *visible* safety stop |
| 5.4 | `HarnessAuditEvent` `REDUCED_ASSURANCE` | 1 | **NOW** | Counted in 3.12 |
| 5.5 | Unmapped terminology term in `citationsMap` | 1 | **NOW** | Counted in 3.11 |
| **Area 6 — fixtures (R2)** ||||
| 6.1 | `WorkflowTestFixture` (tenant-wide + definition-scoped) | 2 | **NOW** | Workbench lists them and can run a sandbox run against 1.1/1.2 |
| **Area 7 — screens with no renderable row** ||||
| 7.1 | `WorkflowInvariantRule` | 0 | **BLOCKED ON H-1** | Zero controllers reference it — no screen can render a row, and `WorkflowDefinitionService.validateGraph()` never resolves one (`:469-475`) |
| 7.2 | `AgentPromotion` | 0 | **NOW, deliberately excluded** | Seedable, but a promotion is a *governance act*; fabricating one is the same class of dishonesty `seed-mode.ts:42` calls out for the HIPAA audit trail |
| 7.3 | Harness `live/sessions` | 0 | **BLOCKED (not a table)** | Read live from Temporal, not from the database — no seed can populate it |

**Split: 19 NOW · 8 INERT · 7 BLOCKED · 2 already-seeded (no new rows) · 1 deliberately excluded.**

---

## 3. Per-area specification

### 3.0 Cast (all pre-existing — verified ids)

| Role | Id | Source |
|---|---|---|
| Tenant | `50000000-0000-0000-0000-000000000001` | `00-constants.ts:124` |
| Dept GEN | `70000000-0000-0000-0001-000000000001` | `00-constants.ts:291` |
| Dept RHEUM | `70000000-0000-0000-0001-000000000011` | `00-constants.ts:293` |
| Dr Olivia Tan (GEN) | `70000000-0000-0000-0000-000000000040` | `00-constants.ts:203` |
| Dr Nair (RHEUM) | `70000000-0000-0000-0000-000000000043` | `00-constants.ts:211` |
| Agent `gen-default` | `78000000-0000-0000-0001-000000000001` | `07a-agent-golden-library.ts:344,357` (GEN is index 0 of `ARCAAI_CLINICAL_DEPARTMENTS`, `04-department.ts:213`) |
| Agent `rheum-default` | `78000000-0000-0000-0001-000000000003` | same, RHEUM is index 2 (`04-department.ts:249`) |
| Template `MEDICINE_NEW_REFERRAL` | `71000000-0000-0000-0001-000000000012` | `07b-arcaai-clinical-templates.ts:161` |
| Template `MEDICINE_FOLLOWUP` | `71000000-0000-0000-0001-000000000013` | `:162` |
| Template `RHEUMATOLOGY_NEW_REFERRAL` | `71000000-0000-0000-0001-000000000014` | `:163` |
| Template `RHEUMATOLOGY_FOLLOWUP` | `71000000-0000-0000-0001-000000000015` | `:164` |
| Approved `PromptVersion` (v3) | `72000000-0000-0003-0001-0000000000XX` | `07b:195-201` (`versionId(templateId, 3)`) |
| DNA report — Dr Tan | `73000000-0000-0000-0001-000000000001` | `08-dna-writing-style.ts:405` |
| DNA report — Dr Nair | `73000000-0000-0000-0001-000000000003` | `08-dna-writing-style.ts:427` |
| ArcaAI tenant context schema | `79000000-0000-0000-0001-000000000001` | `07e-consultation-loop-defaults.ts:274-290` |
| SYSTEM user | `60000000-0000-0000-0000-000000000000` | `00-constants.ts:98` |

Synthetic patients (new, no PHI): `PAT-20260302-102` (GEN), `PAT-20260305-103` (RHEUM). Follows
the existing `PAT-YYYYMMDD-NNN` convention (`09-consultation.ts:49-57`, `:238`).

---

### 3.1 Tenant-authored workflow (R1)

#### 3.1.1 `WorkflowDefinition` — `arcaai-consultation-soap`

| Column | Value |
|---|---|
| `id` | `99000000-0000-0000-0001-000000000001` |
| `tenantId` | ArcaAI |
| `slug` | `arcaai-consultation-soap` |
| `name` | `ArcaAI Consultation — SOAP Documentation` |
| `paletteKey` | `consultation` |
| `versionNumber` | `1` · `parentVersionId` `null` |
| `status` | `PUBLISHED` · `isActive` `true` |
| `graph` | the 14-node graph below, **verbatim** |
| `graphChecksum` | `4a0a79d87f0aa1678307f563a9f5bbb1cc8ee8ac9d5dc83ec636cb20ec3db623` |
| `compiledConfig` | verbatim `compile()` output (13 stages, 1 gate) |
| `compiledConfigChecksum` | `d6449328dddb7634d34cb2b3c6404a8516648402dbc8d9f71bd18fb31abc4817` |
| `registryChecksum` | `9635b9a9d71ef932973827e95ff841291d7679f4cb8c5f61326a8bcc306e0afd` |
| `validationReport` | `{ reportVersion: 1, ok: true, findings: [], ruleSetVersion: 1, registryChecksum: <above>, evaluatedAt: '2026-08-22T00:00:00.000Z' }` |
| `needsReview` | `false` · `validatedAt` / `publishedAt` `2026-08-22T00:00:00.000Z` |
| `tags` | `['arcaai', 'consultation', 'tenant-authored']` |
| `createdBy` | ArcaAI tenant admin (`70000000-0000-0000-0000-000000000003`) — **not** the SYSTEM user; this row must read as tenant-authored |

**Graph** (node ids and configs are load-bearing — every one satisfies a named rule):

| Node id | type | config |
|---|---|---|
| `n_start` | `core.start` | `{}` |
| `n_consent` | `consultation.consentGate` | `{}` — identity comes from `run_payload`, never config (`nodes/consultation.py:49-55`) |
| `n_capture` | `consultation.captureBinding` | `{ action: 'start', persistSnapshot: true, onError: 'degrade' }` (`consultation_capture.py:38,61`) |
| `n_entities` | `consultation.extractEntities` | `{ language: 'en', persist: true, requiresFinalized: true, onError: 'degrade' }` — `requiresFinalized` is WF-CONS-017 |
| `n_terms` | `consultation.bindTerminology` | `{ purposeScope: 'terminology.validate', unmappedOutputKey: 'unmappedTerms', onError: 'degrade' }` — WF-CONS-013 / WF-CONS-016 |
| `n_phi` | `consultation.phiHop` | `{ mode: 'pseudonymize', onError: 'degrade' }` (`nodes/consultation.py:99-106`) |
| `n_evidence` | `consultation.retrieveEvidence` | `{ retrievalEnabled: true, onError: 'degrade' }` |
| `n_prompt` | `consultation.assemblePrompt` | `{ requiresFinalized: true, conversationLanguage: 'en', onError: 'degrade' }` — WF-CONS-018 |
| `n_synth` | `consultation.synthesize` | `{ taskKey: 'text.finalize', producesCode: false, onError: 'degrade' }` — WF-CONS-015 |
| `n_sensors` | `consultation.sensors` | `{ onError: 'degrade' }` |
| `n_persist` | `consultation.persistDraft` | `{ occ: true, onError: 'degrade' }` — WF-CONS-014 |
| `n_assure` | `consultation.finalizeAssurance` | `{ onError: 'degrade' }` |
| `n_gate` | `consultation.hitlGate` | `{ gateType: 'clinician_review', blocking: true, timeoutSeconds: 3600, onTimeout: 'TIMED_OUT' }` |
| `n_end` | `core.end` | `{}` |

Edges `e1…e13`, a single chain in the order above, all `fromPort: 'out'` / `toPort: 'in'`.

**This graph validates CLEAN against the full rule set** — `ok: true`, zero findings, verified by
running the real `validate()` from `packages/workflow-contract/dist` (see §5 for the procedure and
the negative control). That is a materially stronger claim than the SYSTEM row can make: the
seeded `platform-default-summarization` report is explicitly **scoped** to `WF-SUMM-*` because the
full catalogue produces ERRORs against it (`seed/21-workflow-definition.ts:48-59`). The
consultation palette can satisfy both rule families because `core.start`/`core.end` carry the
`boundary` class, which the two reachability predicates exempt
(`packages/workflow-contract/src/predicates/structural.ts:9-31,80,97`).

#### 3.1.2 `WorkflowDefinition` — `arcaai-rheum-consultation-soap`

Identical spine plus **two deliberate differences**, so "one definition per department" is
observable rather than asserted:

- an extra `n_infer` node (`consultation.inferentialSensors`, `{ onError: 'degrade' }`) between
  `n_sensors` and `n_persist` — rheumatology gets the LLM-as-judge pass;
- `n_prompt.config.dnaStyleId = '73000000-0000-0000-0001-000000000003'` (Dr Nair's report).
  `assemble_prompt` really reads this field (`consultation_compose.py:117`), which makes the
  workflow node the **only place in the platform where a specific DNA style can be selected** —
  see §3.2.

| Column | Value |
|---|---|
| `id` | `99000000-0000-0000-0001-000000000002` |
| `slug` | `arcaai-rheum-consultation-soap` · `versionNumber` 1 |
| `graphChecksum` | `d7ea94b9de05426b99c639eb1ab14a8af882522efb9238218a76fe043a8ac3c4` |
| `compiledConfigChecksum` | `bee564b8d48e5b56fdee7f41d2090cee44829256aa17088f49e77e8c10d7f868` |
| `registryChecksum` | as 3.1.1 · `validationReport.ok` `true`, zero findings (14 stages, 1 gate) |

#### 3.1.3 `WorkflowAssignment` + `WorkflowAssignmentChange`

| id | scope | scopeId | paletteKey | slug |
|---|---|---|---|---|
| `9A000000-0000-0000-0001-000000000001` | `TENANT` | `null` | `consultation` | `arcaai-consultation-soap` |
| `9A000000-0000-0000-0001-000000000002` | `DEPARTMENT` | RHEUM dept id | `consultation` | `arcaai-rheum-consultation-soap` |

Both satisfy the service's write-time referential check ("a PUBLISHED definition for this tenant on
this palette", `workflow-assignment.service.ts:278-280`) and the writable-scope guard (`:140-145`).

Change rows (`9A000000-0000-0001-0001-00000000000{1,2}`; third UUID group `0001` discriminates the
change table from the assignment table within the same block): `beforeSlug: null`,
`afterSlug: <slug>`, `assignmentVersion: 1`, `changedBy: <tenant admin>`,
`reason: 'Seeded day-1 assignment (TASK-789 demo dataset)'`.

**Honesty note to carry in the file header:** these four rows make the Studio's assignment matrix
render real data and make `WorkflowAssignmentService.resolve()` return `source: 'department'` /
`'tenant'` in a test — but nothing in production calls `resolve()` (**C-1**), so opening a
consultation still dispatches Substrate A. The seed must not imply otherwise.

---

### 3.2 Two departments, two behaviours (R4)

Three of the four axes are **already seeded** and need no new rows (ledger 2.3–2.5). The missing
axis is the context schema: `07e-consultation-loop-defaults.ts` seeds exactly one TENANT-scoped
schema per tenant (`:274-290`), so today every ArcaAI department shares one vocabulary.

#### 3.2.1 GEN department schema

| Column | Value |
|---|---|
| `id` | `79000000-0000-0000-0001-000000000010` · version `89000000-0000-0000-0001-000000000010` |
| `slug` | `consultation_gen_arcaai` (the model is `@@unique([tenantId, slug])`, `consultation-context-schema.prisma:77`) |
| `name` | `General Medicine Consultation Context` |
| `scope` | `DEPARTMENT` · `departmentId` = GEN |
| `status` | `PUBLISHED` · `pinnedVersionNumber` `1` · `isDefault` `true` |
| `templateLocked` | `false` · `sourceTemplateSlug` `null` (tenant-owned) |

`definition` (validated against `context-schema-definition.ts:35-41,52-67`):

```jsonc
{ "schemaVersion": "1.0",
  "kinds": [
    { "key": "audio_stream", "label": "Audio Stream", "primitive": "STREAM_AUDIO",
      "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "DURING", "producedBy": ["CLIENT"] },
    { "key": "work_note", "label": "Work Note", "primitive": "TEXT",
      "phiClass": "PHI", "cardinality": "MANY", "lifecycle": "ANY", "producedBy": ["CLIENT"] },
    { "key": "vitals", "label": "Vitals", "primitive": "STRUCTURED",
      "phiClass": "PHI", "cardinality": "ONE", "lifecycle": "PRE", "producedBy": ["CLIENT"],
      "fields": { "bp": "string", "hr": "number", "temp": "number", "spo2": "number" } },
    { "key": "attachment", "label": "Attachment", "primitive": "DOCUMENT",
      "phiClass": "PHI", "cardinality": "MANY", "lifecycle": "ANY", "producedBy": ["CLIENT"] }
  ],
  "outputs": [
    { "key": "soap_note", "label": "SOAP Note", "primitive": "TEXT" },
    { "key": "problem_list", "label": "Problem List", "primitive": "TEXT" }
  ] }
```

#### 3.2.2 RHEUM department schema

`id` `79000000-0000-0000-0001-000000000011`, version `89000000-0000-0000-0001-000000000011`, slug
`consultation_rheum_arcaai`. Same envelope; a deliberately different vocabulary:

- `joint_count` (`STRUCTURED`, `PRE`, fields `{ tender: number, swollen: number, das28: number }`)
- `inflammatory_markers` (`STRUCTURED`, `PRE`, fields `{ esr: number, crp: number }`)
- `work_note`, `attachment` (as above)
- outputs: `soap_note`, `disease_activity` (`TEXT`)

That contrast is the demonstrable claim: **the same platform produces a vitals-anchored general
note and a joint-count-anchored rheumatology note, because the department's declared vocabulary
differs.** It is visible in `/context-schemas` and in the SOAP section headings of the two seeded
drafts (§3.3).

#### 3.2.3 What `dnaStylePolicy` can and cannot do (ledger 2.6)

`DepartmentAgent.dnaStylePolicy` is `INHERIT | DISABLED` (`department-agent.prisma:42`) — a
**gate**, not a selector. It can answer "may this department use DNA style at all?"; it can never
answer "which style?". The selector column that would answer that,
`GenerateSummaryRequest.dnaStyleId`, is populated by no call site (**H-4**).

For the demo this means:

- Set `dnaStylePolicy: INHERIT` on both agents (already the seeded default,
  `07a:402` → `DAY1_AGENT_LOOP_CONFIG`) so the resolver may consult a DNA style.
- **Which** style is then resolved by the doctor→department fallback chain, i.e. by *who is
  logged in* (Dr Tan vs Dr Nair), not by the department configuration. That is the honest story.
- The one place a specific style **can** be selected is `consultation.assemblePrompt.config.
  dnaStyleId` in a tenant-authored graph (§3.1.2) — which is INERT until C-1 lands. The seed
  should carry that binding precisely so the gap is visible: the capability exists in the
  authoring model and nowhere in the live path.

---

### 3.3 A complete consultation trace (R3–R7)

Both consultations follow `09-consultation.ts` conventions exactly: `upsert`-by-id, plaintext PHI
keys handed to `encryptSeedRow` before persist (`:1410-1417`), `metadata` for the free-form fields
— **plus** the typed `status` column, which the existing seed omits.

#### 3.3.1 C1 — the signed trace (GEN)

| Column | Value |
|---|---|
| `id` | `90000000-0000-0000-0001-000000000003` |
| `patientId` | `PAT-20260302-102` · `appointmentDate` `2026-03-02` |
| `doctorId` | Dr Tan · `departmentId` GEN · `parentConsultationId` `null` |
| `status` (typed) | **`SIGNED`** |
| `metadata` | `{ visitType: 'NEW_PATIENT', chiefComplaint: 'Fever, productive cough and pleuritic chest pain for 4 days', language: 'en' }` |

**Why `appointmentDate` + `doctorId` matter:** `ConsultationService.getOrCreate` keys on
`(tenantId, patientId, appointmentDate, doctorId)` (`consultation.service.ts:131`), and the
playground's `handleOpenPatient` calls `sdkSession.open({ patientId })` with **today's** date
(`:128`). So typing this patient id into the playground creates a *second, empty* consultation
rather than attaching to the seeded one. The seeded consultation is reached the other way: the
playground lists real consultations (`consultation-demo-screen.tsx:262-269`,
`sdkSession.listConsultations`) and `handleSelect` loads any of them (`:284-296`). **The demo
script is therefore "log in as Dr Tan, pick the seeded consultation from the list" — not "open
patient X".** Recording that in the seed header prevents the obvious wrong demo.

| ContextItem | id | type / source | notes |
|---|---|---|---|
| Transcript | `91000000-0000-0000-0001-000000000010` | `TRANSCRIPT` / `TRANSCRIPTION` | **exactly one transcript on this consultation** — `resolveCitedSegments` returns `[]` when `transcripts.length !== 1` (`summary.service.ts:1341-1342`) |
| Audio | `91000000-0000-0000-0001-000000000011` | `AUDIO_RECORDING` / `USER` | `content: null` |
| Pre-summary | `91000000-0000-0000-0001-000000000012` | `PRE_SUMMARY` / `AI` | |
| Case note | `91000000-0000-0000-0001-000000000013` | `CASE_NOTE` / `USER` | |
| SOAP draft | `91000000-0000-0000-0001-000000000014` | `RAW_SUMMARY` / `AI` | `currentVersionNumber: 3`, `kindKey: 'soap_note'`, `contextSchemaVersionId: 89000000-…-0010` |

`kindKey` + `contextSchemaVersionId` (`consultation.prisma:125-126`) are set on the SOAP draft so
the department-schema binding is legible on the row itself — the existing seed leaves both NULL.

**`TranscriptSegment`** — 6 rows, `9F000000-0000-0000-0001-00000000001{0..5}`, `idx` 0–5,
alternating `speaker: 'doctor' | 'patient'`, `t0Ms`/`t1Ms` monotone, `charStart`/`charEnd`
covering the transcript exactly. Non-PHI by design (`consultation.prisma:616-622`), so **no
encryption path is needed**. The `@@unique([contextItemId, idx])` is the upsert key.

**`Media` + `AudioRecording`** — `96000000-0000-0000-0001-00000000000{1,2,3}` (primary / raw /
processed) and `93000000-0000-0000-0001-000000000001`, mirroring the dual-capture demo so the
playground's "Dual capture" badge renders (`09-consultation.ts:805-821`).

**`NamedEntity`** — 5 rows, `95000000-0000-0000-0001-00000000001{0..4}`, all anchored to the
transcript with `transcriptContextItemId` + `transcriptStartOffset`/`EndOffset` so the
click-to-source path works. Coded where honest (`rxnormCode`, `icdCode`), `assertion: 'PRESENT'`,
`confidence` 0.88–0.97. Encrypted fields: `text`, `normalizedText`, `metadata`.

**`Highlight`** — 2 rows, `9E000000-0000-0000-0001-00000000001{0,1}`,
`targetKind: 'TRANSCRIPT'`, `sourceContextItemId` = the transcript, W3C dual selectors
(`startOffset`/`endOffset` plaintext; `exact`/`prefix`/`suffix`/`note` encrypted), `color`,
`label: 'Key finding'`. Requires the `Highlight` entry added to `SEED_PHI_MODELS` (§4.3).

**`ContextItemVersion`** on the SOAP draft — the R7 evidence, three rows:

| version | id | `changeReason` / `changeSource` / `changedBy` | content |
|---|---|---|---|
| 1 | `94000000-0000-0000-0001-000000000010` | `ai_draft_v1` / `ai_model` / `system` | the AI draft, **retained immutably** (`summary.service.ts:1769`) |
| 2 | `94000000-0000-0000-0001-000000000011` | `user_edit` / `manual` / Dr Tan | the corrected note, with `contentDiff` + `fieldChanges` naming the two changed SOAP sections |
| 3 | `94000000-0000-0000-0001-000000000012` | `approved` / `manual` / Dr Tan | `attestedAt`, `attestedBy`, `attestationHash`, `modelName`, `sensorScores`; `contentDiff`/`fieldChanges` = the cumulative v1→v3 delta, exactly as `approveSummary` stamps it (`summary.service.ts:1074-1079`) |

`attestationHash` must be computed, not invented:
`sha256(`​`contextItemId:versionNumber:attestedBy:attestedAtISO:content`​`)`
(`summary.service.ts:1251-1253`).

The v2 edit is what makes R5 demonstrable **as data** while **C-3** keeps it undemonstrable *as an
interaction* — the playground renders the note as an inert `<article>`
(`case-note-column.tsx:280`). The seed header must say so rather than implying the UI produced it.

**`SummaryMeta`** — `92000000-0000-0000-0001-000000000001`, `contextItemId` = the SOAP draft:

```
aiModelId 'gpt-4o-mini' · aiModelVersion '2026-02-01' · modelName 'gpt-4o-mini'
promptResolvedFrom 'agent' · resolvedPromptId 71000000-0000-0000-0001-000000000012
promptVersion '3' · sessionAgentId 78000000-0000-0000-0001-000000000001
sessionAgentPromptVersion '71000000-0000-0000-0001-000000000012@3'
processingTimeMs 5100 · inputTokens 1240 · outputTokens 512 · ttftMs 380 · tokensPerSecond 41.2
stopReason 'stop' · cacheHit false · qualityScore 0.93
entityFaithfulnessScore 0.96 · coverageScore 0.91 · ragTriadScore 0.89
gateDecision 'PASS' · assuranceCompletedAt <ts> · redactionApplied true
attestationRef 94000000-0000-0000-0001-000000000012
caseNoteIds [<case note>] · preSummaryIds [<pre-summary>]
```

`citationsMap` (encrypted JSON) carries **both** shapes `collectCitedSegmentIds` understands
(`consultation/lib/transcript-segments.ts:227-258`):

```jsonc
{ "segmentCitedIds": ["9F000000-0000-0000-0001-000000000011",
                      "9F000000-0000-0000-0001-000000000013"],
  "claims": [
    { "text": "Fever and productive cough for four days.",
      "verdict": "PASS",
      "evidence": [{ "startOffset": 42, "endOffset": 96,
                     "segmentId": "9F000000-0000-0000-0001-000000000011" }] }
  ] }
```

`guardrailDecisions` (encrypted JSON): `{ "safety": "PASS", "groundedness": "PASS" }`.

**`HarnessAuditEvent`** — 5 rows for C1, `F5000000-0000-0000-0001-00000000000{1..5}`, in this
order: `GENERATE` → `SENSOR_RUN` → `GATE_DECISION` (`gateDecision: 'PASS'`) → `ATTEST`
(`clinicianId`, `attestationHash`, `contextItemVersionId` = v3) →
`SESSION_CLOSED_COMPLETE`. See §5.2 for the mandatory chain computation.

**`AgentTrajectoryStep`** — 14 rows, `9D000000-0000-0000-0001-0000000000XX`,
`sessionKind: 'HARNESS_DOC'`, `sessionId: 'harness-doc-90000000-0000-0000-0001-000000000003'`
(the real convention, `apps/harness/src/harness/api/endpoints/internal.py:83`), `runId: ''`
(the non-Temporal sentinel, `agent-trajectory.prisma:78-85`), `seq` 0…13, `consultationId` set.
Step types drawn **only** from the valid enum, mirroring what Substrate A actually emits
(`activities.py:155-166`):

`PHASE(start)` → `TOOL_CALL(nlp.extract_entities)` → `RETRIEVAL(retrieve_context)` →
`LLM_CALL(generate)` with a real `stats` object → `GUARDRAIL(guardrail.screen)` →
`SENSOR(sensor:entity_faithfulness)` → `SENSOR(sensor:coverage)` →
`SENSOR(sensor:numeric_dose)` → `LLM_CALL(judge:groundedness)` → `GATE(gate.open)` →
`GATE(gate.approved)` → `PHASE(finalize)`, plus two `THINKING` spans.
`payloadRef` stays `null` — the table's PHI posture is stats-first, payload-by-reference
(`agent-trajectory.prisma:8-11`).

#### 3.3.2 C2 — the near-miss (RHEUM)

| Column | Value |
|---|---|
| `id` | `90000000-0000-0000-0001-000000000004` |
| `patientId` | `PAT-20260305-103` · `appointmentDate` `2026-03-05` |
| `doctorId` | Dr Nair · `departmentId` RHEUM |
| `status` (typed) | **`PENDING_REVIEW`** |
| `degradedReasons` | `['inferential_safety_flag']` (`consultation.prisma:41`) |
| `metadata` | `{ visitType: 'NEW_PATIENT', chiefComplaint: 'Symmetrical small-joint pain and morning stiffness for 6 weeks', language: 'en' }` |

Rows: one `TRANSCRIPT` (`91000000-…-000000000020`) + 5 `TranscriptSegment`
(`9F000000-…-00000000002{0..4}`), one `RAW_SUMMARY` (`…-000000000021`,
`kindKey: 'soap_note'`, `contextSchemaVersionId: 89000000-…-0011`), one
`Highlight` (`9E000000-…-000000000020`), 3 `NamedEntity` (`95000000-…-00000000002{0,1,2}`),
one `ContextItemVersion` `ai_draft_v1` only (`94000000-…-000000000020`) — **no `approved`
version**, because it is unsigned, and 4 `HarnessAuditEvent` rows
(`F5000000-…-00000000000{6..9}`): `GENERATE` → `SENSOR_RUN` → `REDUCED_ASSURANCE` →
`GATE_DECISION` with `gateDecision: 'FLAG'`.

The five near-misses:

| # | Row | Value | What it makes visible |
|---|---|---|---|
| 5.1 | `NamedEntity` `…-000000000021` | `confidence: 0.41`, `className: 'MEDICATION'`, text `"methotrexate"` (ASR-garbled surface form `"methotrextate"` as `text`, correct `normalizedText`) | the low-confidence path; and R3's missing drug-name **correction** capability (**H-3**) — nothing in either substrate fixes it |
| 5.2 | `NamedEntity` `…-000000000022` | `className: 'CONDITION'`, **all five ontology columns NULL** | the coverage gap the groundedness guard makes explicit (`consultation.prisma:400-405`) |
| 5.3 | `SummaryMeta` `92000000-0000-0000-0001-000000000002` | `guardrailDecisions: { "safety": "FLAG", "groundedness": "REVIEW" }`, `gateDecision: 'FLAG'`, `ragTriadScore: 0.52`, `entityFaithfulnessScore: 0.63`, `assuranceCompletedAt` set | **the sign-off hard stop.** `hasSafetyFlag` blocks approval unless the clinician explicitly overrides (`summary.service.ts:1264-1269`, `:1090-1104`) — the demo's most concrete "the machine cannot finalize" moment |
| 5.4 | `HarnessAuditEvent` `…-000000000008` | `action: REDUCED_ASSURANCE` | the WORM record of a degraded run |
| 5.5 | `citationsMap.unmappedTerms` | `["anti-CCP", "DAS28-ESR"]` | the CR-19 coverage gap the `unmappedOutputKey` config surfaces (`consultation_nlp.py:184-185`) |

C2 is also the **only** row that will ever appear in the Gate Queue on a seeded database
(`harness-observability.service.ts:176-180`), and the only consultation for which
`GET admin/harness/edit-burden` returns non-zero telemetry.

---

### 3.4 Feedback / training rows (R7)

#### 3.4.1 `GateEditExemplar` — 2 rows (INERT, **C-4**)

`GateEditExemplar` has **plaintext** `redactedBefore` / `redactedAfter` columns
(`harness.prisma:486-488`) because redaction happens before persistence — so no encryption path is
needed, and the seeded snippets must be genuinely redaction-shaped (no names, no dates, no ids).

| id | source | `gateDecision` | `qualitySignal` | `editDistanceRatio` |
|---|---|---|---|---|
| `F4000000-0000-0000-0001-000000000001` | C1 | `PASS` | `APPROVED_CLEAN` | `0.03` (below `APPROVED_CLEAN_MAX_RATIO = 0.05`, `gate-edit-mining.service.ts:32`) |
| `F4000000-0000-0000-0001-000000000002` | C2 | `FLAG` | `HEAVILY_EDITED` | `0.38` (above `HEAVILY_EDITED_MIN_RATIO = 0.3`, `:33`) |

Both `curationStatus: PENDING`, `departmentId` set (the retrieval key), `visitType: 'new-patient'`,
`modelName`, `promptTemplateId`, `contextItemId`, `timeToSignSeconds`.

**Honesty requirement:** the file header must state that no live writer produces these
(`GateEditMiningQueue.enqueue()` has zero call sites, and the processor is registered in no module
— `seam-findings.md` C-4), and that the retrieval half is separately dead, so seeding them does
**not** make few-shot prompt assembly use them.

#### 3.4.2 `GoldenSet` / `GoldenCase`

`GoldenSet` `F0000000-0000-0000-0001-000000000001`: name `ArcaAI General Medicine — Regression v1`,
`pinnedVersion: 'v1'`, `departmentId` = GEN (the per-department picker key,
`harness.prisma:69-72`).

`GoldenCase` `F1000000-0000-0000-0001-00000000000{1,2}`: `label` `'respiratory-new-patient'` /
`'inflammatory-arthritis-new-patient'`, with encrypted `transcript` + `referenceNote`.

**Honesty requirement (C-5):** these are **hand-authored synthetic** cases, not derived from the
signed consultation. No code path connects a signed consultation or a `GateEditExemplar` into a
`GoldenCase` — the only write path is the manual admin POST (`eval.service.ts:152-165`), and the
harness's own module docstring says the shipped fixture is synthetic and must be replaced by a real
clinician-authored set before any eval result gates a clinical claim
(`apps/harness/src/harness/eval/golden/sources.py:8-32`). The seed must repeat that sentence, and
the `description` column should carry `SYNTHETIC — not clinician-authored; see TASK-789 C-5`.

#### 3.4.3 `EvalRun` / `EvalScore`

`EvalRun` `F2000000-0000-0000-0001-000000000001`: `goldenSetId` as above, `modelName 'gpt-4o-mini'`,
`promptTemplateId` = `MEDICINE_NEW_REFERRAL`, `promptVersionNumber: 3`,
`judgeModel 'granite-guardian'`, `triggerType: 'MANUAL'`, `status: 'COMPLETED'`,
`aggregateScores: { faithfulness: 0.94, coverage: 0.89 }`, encrypted `notes`.

`EvalScore` `F3000000-0000-0000-0001-00000000000{1..4}` — metrics `faithfulness` and `coverage`
per case, `maxScore: 1`, encrypted `rationale` + `details`.

---

### 3.5 Fixtures for testability (R2)

`WorkflowTestFixture` — `encryptedInput` is Vault-Transit JSON ciphertext
(`workflow-test-fixture.prisma:52-57`; registry `phi-read-decrypt.ts:84,120`), so this model must
be added to `SEED_PHI_MODELS` (§4.3).

| id | name | `paletteId` | `workflowDefinitionId` | `input` (plaintext, encrypted at seed) |
|---|---|---|---|---|
| `9B000000-0000-0000-0001-000000000001` | `Synthetic consultation — new patient` | `consultation` | `99000000-…-0001` | `{ consultationId, externalPatientId: 'SYNTH-001', userId, sessionId, transcriptText: '<synthetic>' }` |
| `9B000000-0000-0000-0001-000000000002` | `Synthetic consultation — rheumatology revisit` | `consultation` | `null` (tenant-wide) | same shape, rheumatology transcript |

The key names mirror what every consultation node actually reads out of `run_payload` —
`consultationId` / `externalPatientId` / `userId` / `jobId` / `sessionId`
(`interpreter/nodes/_consultation_shared.py:53-57`) — plus `transcriptText`, which the sensors node
reads (`consultation_verify.py:54`). **"Synthetic" is a contract, not a suggestion**
(`workflow-test-fixture.prisma:22-25`): no realistic patient data, in the seed or anywhere else.

`WorkflowRun` — one row, `9C000000-0000-0000-0001-000000000001`:
`trigger: 'workbench sandbox'`, `isSandbox: true`, `status: 'COMPLETED'`,
`workflowVersionId` = `99000000-…-0001`, `workflowSlug`/`workflowVersionNumber`/`definitionName`
denormalized, `runId: '<uuid>'`, `sessionId: 'workflow-interpreter-<runId>'`
(`workflow-run.service.ts:30`), `nodeCount: 13`, `failedNodeCount: 0`, `degradedNodeCount: 0`.
Its trace is **empty** — that is not a seeding shortcut, it is NEW-1 rendered honestly.

---

### 3.6 Admin-screen coverage (README §2)

| Screen / feature | Reads | Has a row after this seed? |
|---|---|---|
| `workflow-studio` | `admin/workflow-definitions`, `admin/workflow-nodes`, `admin/workflow-assignments` | **Yes** — 2 definitions + 2 assignments (registry is code-owned) |
| `workflow-runs` | `admin/workflow-runs`, `…/:runId/trace`, `admin/agent-trajectory` | **List: yes** (1 sandbox run). **Trace: no** — BLOCKED ON NEW-1 |
| `workbench` | `admin/workflow-test-fixtures`, `admin/workflow-definitions`, `admin/workflow-runs` | **Yes** — 2 fixtures |
| `agents` | `admin/department-agents`, `admin/prompt-templates`, `admin/agent-promotions` | **Agents/templates: yes** (pre-existing). **Promotions: no** — deliberately excluded (§2, 7.2) |
| `context-schemas` | `admin/consultation-context-schemas` | **Yes** — 2 new department-scoped + 1 pre-existing tenant default |
| `dna-writing-styles` | DNA endpoints | **Yes** (pre-existing) |
| `harness-policy` / `agentic-policy` | `admin/harness/policy`, `…/policy/global`, `admin/settings` | **Yes** (pre-existing SYSTEM row, `13-harness-policy.ts`) |
| `harness-ops` → audit | `admin/harness/audit` | **Yes** — 9 WORM rows (first ever) |
| `harness-ops` → gate-queue | `admin/harness/gate-queue` | **Yes** — C2 (first ever; today the queue is empty because the typed status column is never seeded) |
| `harness-ops` → edit-burden | `admin/harness/edit-burden` | **Yes** — C1 and C2 |
| `harness-ops` → eval-runs | `admin/harness/eval-runs` | **Yes** — 1 run, 4 scores |
| `harness-ops` → golden-sets | `admin/harness/golden-sets` | **Yes** — 1 set, 2 cases |
| `harness-ops` → gate-edit-exemplars | `admin/harness/gate-edit-exemplars` | **Yes** — 2 rows (INERT, C-4) |
| `harness-ops` → live/sessions | Temporal, live | **No, and un-seedable** — not a table |
| `consultations` / `consultation-review` | consultation + `admin/harness/consultations/:id` | **Yes** — C1, C2 |
| `playground-consultation` | `consultations/*` | **Yes** — C1, C2 via the consultation list (§3.3.1); SOAP editing still BLOCKED ON C-3 |
| `playground-live-transcription` | live STT | **No, and un-seedable** — a live session, not a row |

**Screens that remain empty and why** — the honest list this exercise was meant to produce:
`workflow-runs` trace (**NEW-1**), `agents` promotions (deliberate), `harness-ops` live sessions
and `playground-live-transcription` (live, not persisted), and any surface for
`WorkflowInvariantRule` (**H-1** — no controller exists at all) or `Fedl*` (**H-6**).

---

## 4. Seed file plan

### 4.1 New id blocks (append to `00-constants.ts`'s prefix table)

The 4th UUID group keeps the existing tenant-slot convention (`0001` = ArcaAI).

```
9A000000-xxxx  →  Workflow Assignments (3rd group 0001 = WorkflowAssignmentChange)
9B000000-xxxx  →  Workflow Test Fixtures
9C000000-xxxx  →  Workflow Runs
9D000000-xxxx  →  Agent Trajectory Steps
9E000000-xxxx  →  Highlights
9F000000-xxxx  →  Transcript Segments
F0000000-xxxx  →  Golden Sets
F1000000-xxxx  →  Golden Cases
F2000000-xxxx  →  Eval Runs
F3000000-xxxx  →  Eval Scores
F4000000-xxxx  →  Gate Edit Exemplars
F5000000-xxxx  →  Harness Audit Events
```

Existing blocks extended, not re-allocated: `90000000` (consultations, ArcaAI slots 003–004),
`91000000` (context items, 010+), `92000000`–`96000000` (summary metas / audio / versions /
entities / media, `-0001-` slot), `79000000`/`89000000` (context schemas, slots 010–011),
`99000000` (workflow definitions, `-0001-` slot).

### 4.2 New files, in call order

| File | Contents | Slots after | Depends on |
|---|---|---|---|
| `07f-arcaai-department-context-schemas.ts` | §3.2 — 2 schemas + 2 versions | `seedConsultationLoopDefaults` (`07e`) | tenants (05), departments (04), and the tenant default from 07e (so the "at most one default per (tenant, scope, departmentId)" rule is honoured per-department, not per-tenant) |
| `23-arcaai-workflow-authoring.ts` | §3.1 + §3.5 — 2 definitions, 2 assignments, 2 change rows, 2 fixtures, 1 sandbox run | `seedWorkflowDefinition` (`21`) | departments (04) for the DEPARTMENT-scope assignment |
| `09a-arcaai-agentic-loop-trace.ts` | §3.3 — 2 consultations + every child row + WORM audit + trajectory | `seedConsentGrant` (`22`), inside the `09-consultation` phase gate | 09-consultation (shared tables), 07f (schema version ids), users (91) |
| `09b-arcaai-feedback-corpus.ts` | §3.4 — exemplars, golden set/cases, eval run/scores | `09a` | 09a's consultations |

`07f` and `23` are **platform/tenant configuration** and run in every seed mode, matching
`07b-arcaai-clinical-templates.ts` and `21-workflow-definition.ts`.

`09a` and `09b` write **synthetic PHI** and must be added to `SEED_PHASES_EXCLUDED_FROM_SAFE`
(`seed-mode.ts:50-56`). That list is guarded by `seed-mode.test.ts` — "adding a new DEMO phase is a
deliberate act with a test that fails until it is listed" (`seed-mode.ts:46-48`), so this is a
required edit, not an optional one. In `index.ts` both calls go inside the existing
`isPhaseEnabled('09-consultation', mode)` block **and** carry their own
`isPhaseEnabled('09a-arcaai-agentic-loop-trace', mode)` guard, so the deny-list entry is real.

### 4.3 Edits to existing files

| File | Edit |
|---|---|
| `00-constants.ts` | the §4.1 prefix block + the new id maps (`SEED_ARCAAI_WORKFLOW_IDS`, `SEED_ARCAAI_TRACE_IDS`, …) |
| `phi-encryption.ts` | add **five** models to `SEED_PHI_MODELS` (`:157-201`), each mirroring `phi-read-decrypt.ts`'s registry exactly: `Highlight` (`exact`/`prefix`/`suffix`/`note` → `encrypted*`, `keyVersion`), `SummaryMeta` (`citationsMap`, `guardrailDecisions`, both `json: true`, `keyVersion`), `GoldenCase` (`transcript`, `referenceNote`), `EvalRun` (`notes`), `EvalScore` (`rationale`, `details` json), `WorkflowTestFixture` (`input`, json). Without this, `SummaryMeta` is written unencrypted-and-empty today — the current seed upserts it raw (`09-consultation.ts:1420-1426`) |
| `seed-mode.ts` | add `09a-arcaai-agentic-loop-trace`, `09b-arcaai-feedback-corpus` to `SEED_PHASES_EXCLUDED_FROM_SAFE` |
| `index.ts` | wire the four new calls in the order of §4.2 |
| new `seed/harness-audit-hash.ts` | verbatim copy of `computeHarnessAuditHash` + `GENESIS_PREV_HASH` (see §5.2) |

### 4.4 Idempotency / re-seed guards

Matching the guard each table's own semantics demand:

| Rows | Guard | Precedent |
|---|---|---|
| `WorkflowDefinition` | **CREATE-ONLY**, `findUnique({ id })` then skip | `21-workflow-definition.ts:227-233`. A PUBLISHED row is hard-immutable at three layers **plus a DB trigger** (`workflow-definition.prisma:29-50`) — an `upsert` with an `update` branch would raise at the database |
| `ConsultationContextSchema` | **CREATE-ONLY** on two conditions (own id **or** any other default at the same `(tenant, scope, departmentId)`) | `07e-consultation-loop-defaults.ts:324-339`, whose rule generalises to DEPARTMENT scope unchanged |
| `WorkflowAssignmentChange`, `HarnessAuditEvent` | **CREATE-ONLY** by id — these tables have `UPDATE`/`DELETE` REVOKEd for the app role (`workflow-assignment.prisma:27-31`, `harness.prisma:239-241`); an `upsert` would fail at the privilege layer, and re-running must never fork the hash chain |
| `WorkflowAssignment`, `WorkflowTestFixture`, `WorkflowRun`, `GoldenSet`/`Case`, `EvalRun`/`Score`, `GateEditExemplar`, `Consultation`, `ContextItem`, `Media`, `AudioRecording`, `NamedEntity`, `Highlight`, `SummaryMeta` | `upsert` by id with the encrypted payload as **both** `create` and `update` | `09-consultation.ts:1401-1470` |
| `ContextItemVersion` | `upsert` on `contextItemId_versionNumber` | `09-consultation.ts:1450-1455` |
| `TranscriptSegment` | `upsert` on `contextItemId_idx` (`consultation.prisma:668`) | new, same shape |
| `AgentTrajectoryStep` | `upsert` on `(tenantId, sessionId, runId, seq)` (`agent-trajectory.prisma:115`) | new, same shape |

---

## 5. Generation procedure for the derived blobs

**Nothing in §3.1 may be hand-typed.** `graph`, `compiledConfig`, `graphChecksum`,
`compiledConfigChecksum`, `registryChecksum` and `validationReport` are engine output.
`packages/database` deliberately declares **no** dependency on `@arcaai/workflow-contract`
(verified: `packages/database/package.json` `dependencies` lists none), so the values are produced
by a throwaway script and pasted verbatim — the precedent, and its rationale, is
`seed/21-workflow-definition.ts:19-46`.

### 5.1 Workflow blobs

1. Build the contract package: `pnpm --filter @arcaai/workflow-contract build`.
2. Write a throwaway script that imports the **built dist** and, for each definition:
   - constructs the `CompilerContext` with **exactly** the service's own constants — `compilerVersion: '0.1.0'`, `ruleSetVersion: 1`, `caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 }`, `policyBindings: { guardrailProfile: 'STANDARD', redactionRuleSetId: null, promptTemplateRefs: [], contextSchemaVersionId: null, entitlementKeys: [] }`, `nodeInfo` from the registry, `registryChecksum: registryChecksum()`, and a **fixed** `compiledAt` (`workflow-definition.service.ts:51-60,477-491`);
   - runs `validate(graph, { paletteKey: 'consultation', registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: registryChecksum(), evaluatedAt: <fixed> })`;
   - runs `compile(graph, ctx)`;
   - prints `createHash('sha256').update(canonicalJson(graph)).digest('hex')` — the same formula the service uses (`workflow-definition.service.ts:517-519`).
3. Paste all six values verbatim. **Delete the script.**
4. Re-run whenever the graph or the registry changes; never hand-edit the JSON.

**Two traps this procedure closes, both live in the seeded SYSTEM row:**

- **`caps.maxNodeSeconds` drift.** `21-workflow-definition.ts:204` carries `900`; the service's
  `DEFAULT_CAPS` is `600` (`workflow-definition.service.ts:53`). A republish through the real
  service would therefore produce a different `compiledConfig.checksum` than the seeded row claims.
- **`compilerVersion` drift.** The seeded row carries `'task-720-seed-1'` (`:127`); the service
  stamps `'0.1.0'` (`:51`). Same consequence.

**The H-2 trap.** The seeded SYSTEM row's `registryChecksum` is
`2ae7222a1e7dc97191309a71a6e438a5088d07174f649d541e1d98878478f97b`, self-documented as computed
over **7** registry entries (`21-workflow-definition.ts:65-68`). The registry now holds **30**, and
`registryChecksum()` returns
`9635b9a9d71ef932973827e95ff841291d7679f4cb8c5f61326a8bcc306e0afd` — verified by executing the
built dist during this review. The two new rows must carry the **current** value. Do **not** copy
the SYSTEM row's. And note that the drift-detection this mismatch is supposed to trigger does not
fire: `needsReview` is never assigned `true` anywhere (**H-2**), so the stale SYSTEM row will keep
reading "reviewed" until that is wired.

**Design-time values recorded in §3.1 are a reference, not a promise.** They were produced against
`packages/workflow-contract/dist` as it stands on 2026-08-22 (registry: 30 keys, checksum
`9635b9a9…`). The implementer must regenerate and compare; if any value differs, the registry moved
and the regenerated value wins.

**Verified during this review** (read-only, from the built dist): both graphs `compile()`
successfully and `validate()` returns `ok: true` with **zero findings** against the full rule set —
19 `WF-CONS-*` rules plus the palette-agnostic `WF-S-*` structural rules. A negative control
(removing `occ: true` from `n_persist`) correctly produced the single expected
`WF-CONS-014 ERROR at /occ`, proving the consultation rules really were evaluated and the clean
report is not an artifact of an empty rule set.

### 5.2 The WORM audit chain

`HarnessAuditEvent.hash` / `prevHash` form a per-tenant chain verified by
`verifyHarnessAuditChain` (`packages/domains/src/utils/harnessAuditHash.ts:190-217`). Seeding a row
with a fabricated hash breaks the chain for that tenant permanently — and the table is append-only
at the DB-privilege layer, so it cannot be repaired.

Requirements:

1. `packages/database` cannot import `@arcaai/domains` (cycle — the same constraint
   `phi-encryption.ts:11-17` and `07e-consultation-loop-defaults.ts:69-78` document). So
   `computeHarnessAuditHash` + `GENESIS_PREV_HASH` must be a **verbatim copy** in a new
   `seed/harness-audit-hash.ts`, with a parity test in `packages/domains` (or
   `packages/applications`) asserting byte-identical output — exactly the pattern
   `day1-loop-defaults.task686.test.ts` establishes for `07e`'s canonicalisers.
2. The chain must start from the tenant's **current tip**, not from genesis: read
   `HarnessAuditEvent` for ArcaAI ordered by `createdAt`, take the last `hash` as the first
   `prevHash`, and fall back to `GENESIS_PREV_HASH` when the tenant has none (which is the case
   today — no seed writes this table).
3. Fixed `createdAt` values in strictly increasing order; the digest folds
   `createdAt.toISOString()` (`harnessAuditHash.ts:123`).
4. `sensorScores` / `citations` stay **plaintext JSON** in the seeded rows, with `encrypted*` NULL.
   `computeHarnessAuditHash` then hashes the plaintext, which is the documented legacy path
   (`harnessAuditHash.ts:36-38`) and keeps the seed free of a fourth encryption surface. If the
   encrypt-before-hash path is wanted instead, the ciphertext must be produced **first** and the
   hash derived over it — never the other way round.
5. CREATE-ONLY. A re-seed that re-inserts would fork the chain.

### 5.3 Attestation hash

`ContextItemVersion.attestationHash` (§3.3.1 v3) and the `ATTEST` event's `attestationHash` must be
the **same** value, computed as
`sha256(contextItemId + ':' + versionNumber + ':' + attestedBy + ':' + attestedAt.toISOString() + ':' + content)`
(`summary.service.ts:1251-1253`). Compute it in the seed from the same literals it writes; do not
paste a constant.

### 5.4 Context-schema checksums

`ConsultationContextSchemaVersion.checksum` is `definitionChecksum(definition)` — already available
as a verbatim copy at `07e-consultation-loop-defaults.ts:113`, itself parity-tested against the real
`computeDefinitionChecksum`. `07f` imports that helper rather than adding a third copy.

---

## 6. What must be wired before the "full" demo is honest

The minimal change list, in dependency order. Each entry is what would move a ledger row from
**INERT/BLOCKED** to **NOW** — none is in this ticket's scope.

| # | Change | Unblocks | Effort shape |
|---|---|---|---|
| **W1** | Add `NODE` to `AgentStepType` (Prisma enum + `ALTER TYPE … ADD VALUE` migration + the generated domain enum), **or** map `STEP_NODE` to an existing member at the emitter | **NEW-1** → ledger 3.14, 3.17; the Runs trace view | One enum value + one migration. Note rule 03 step 4: `ResourceType` parity is a *separate* list and is not affected — `WorkflowRun`/`AgentTrajectoryStep` deliberately emit no sys-events (`workflow-run.prisma:33-39`) |
| **W2** | Forward `InvokeWorkflowRequest.input` through `WorkflowExposureService.invoke()` → `HarnessGatewayService.startWorkflowRun(...)` | **C-2** → a real graph invoke stops failing at the first node for lack of identity | One call-site argument; the gap is documented verbatim at `interpreter/models.py:128-136` |
| **W3** | Call `WorkflowAssignmentService.resolve(tenantId, 'consultation', consultation.departmentId)` on consultation open, dispatch the resolved definition, and stamp `WorkflowRun.trigger = 'consultation open'` | **C-1** → ledger 1.1–1.5, 3.16; R1 and R2 | The largest item. Requires deciding how Substrate B coexists with, or replaces, `ConsultationLoopWorkflow` — an architecture decision, not a wiring task |
| **W4** | Collect `departmentId` at `sdkSession.open(...)` in the playground | **H-4** → department-scoped resolution actually fires for playground consultations (it already works for the seeded ones, which set the column) | One field on one call (`consultation-demo-screen.tsx:300`) |
| **W5** | Call `PATCH :id/summary/:summaryId` from the playground note editor | **C-3** → R5 becomes an interaction, not just seeded data | The backend is complete, OCC and all (`consultation.controller.ts:1073-1109`) |
| **W6** | Register `GateEditMiningQueue` + `GateEditMiningProcessor` in a module with `BullModule.registerQueue({ name: JobQueue.MineGateEditExemplar })`, call `.enqueue()` from the sign-off path, and import `GateEditMiningServiceModule` into the modules that construct `PromptAssemblyService` for live generation | **C-4** → ledger 4.1 stops being INERT at both ends | Module registration + one call site + four imports |
| **W7** | A producer that turns a signed consultation (or an `APPROVED` `GateEditExemplar`) into a `GoldenCase` | **C-5** → ledger 4.3's provenance claim | New service method + an admin action |
| **W8** | An export path assembling `(original, edited, context)` triples into a dataset artifact | **C-6** → ledger 4.5 | New; nothing exists to extend |
| **W9** | Give `WorkflowInvariantRule` an HTTP surface and make `WorkflowDefinitionService.validateGraph()` merge tenant rows via `WorkflowValidatorService` | **H-1** → ledger 7.1 | Controller + service wiring; the validator service already exists (169 lines, tested, imported nowhere) |
| **W10** | Assign `needsReview = true` when a definition's stamped `registryChecksum` differs from the running registry | **H-2** → the stale SYSTEM row becomes visible | One comparison at read time |

**Two things this seed can do on day one, before any of the above.** They are the reason it is
worth building now rather than after W1–W10:

1. It makes the **near-miss visible**. The safety-flag sign-off stop, the low-confidence entity, the
   uncoded condition and the unmapped terms are all live code paths today — they have simply never
   had a row to fire on.
2. It gives **eleven admin surfaces their first row ever** — `HarnessAuditEvent`, `GoldenSet`,
   `GoldenCase`, `EvalRun`, `EvalScore`, `GateEditExemplar`, `WorkflowRun`, `WorkflowTestFixture`,
   `WorkflowAssignment`, `Highlight`, `TranscriptSegment` — none of which is written by any seed
   file today (verified: no `client.<model>.` call exists for any of them anywhere under
   `packages/database/src/prisma/db_main/seed/`).
