# BUG-019 — The ArcaAI case note is finalized with no template at all, the live note is written to General Medicine's shape, and a terminal consultation silently accepts a second recording

| Field | Value |
|---|---|
| **Status** | `Pending` — plan written, **no code before the owner's go** |
| **Type** | `bugfix` |
| **Branch** | target `dev-2.2` |
| **Discovered** | 2026-09-11, live end-to-end run of the ALaaS v3 realtime consultation scribe (`ALaaSv3.0`, `apps/audio-stream-svc` broker) against the local HOPE dev stack |
| **Environment** | tenant ArcaAI `50000000-0000-0000-0000-000000000001`, department Breast & Endocrine (`BREN`, `70000000-0000-0000-0001-000000000015`), clinician `arcaai_doctor_bren`, new visit, `language: en`, HOPE service account `hope_svc_3fadbeb86f75c4a8e9a00e2e`. Stack booted `2026-09-10T18:16:04Z` (`harness.log:4`); API log timestamps are local `UTC+07`, Python service logs are UTC |
| **Subjects** | **A (failed)** consultation `01a08c97-4d3d-7d2d-9de0-e78447e6f137` / run `01a08c97-4de5-7eab-8d6d-74f50c41b396` → `FAILED`, consultation `CLOSED_INCOMPLETE`. **B (completed)** consultation `01a08ca7-62bb-7194-9804-c672a0c47811` / run `01a08ca7-6325-7faf-b2b2-a1b8ac217447` (`arcaai-bren-consultation`) → `COMPLETED` with a note |
| **Severity** | **High.** On the completed run the tenant's authored note format governs neither the live document nor the finalized note, and the finalized note carries no writing style. On the failed run an entire recorded consultation is destroyed silently and a second `open` then records 5½ more minutes into it that can never become a case note |
| **Affected apps/packages** | `packages/applications` (`consultation/consultation`, `consultation/live-documentation`, `consultation/harness`), `apps/api` (`consultation` module), `apps/harness` (`temporal/interpreter`), `packages/database` (seeds `27-document-template-library.ts`, `28-workflow-library.ts`, `25-agents.ts`), `packages/domains` (`ConsultationEntity`, `ConsultationRepository`) |
| **Not at fault** | the STT language-mode plumbing (D5 — verified end to end and working); the visit-branch template freeze (TASK-946 lane T — verified working in this very run); the `DRAINING → CLOSED_INCOMPLETE` transition itself (TASK-946 lane D — verified working in this very run) |
| **Related tickets** | **TASK-946** (Review; its D2 template freeze, D3 terminal state and OD-4 fail-fast gate all behaved exactly as designed here — this ticket is the residue those fixes exposed, not a regression of them), TASK-932 (the 22 department note shapes; the `documentTemplateSlug` schema key), TASK-891 (the document-template library), TASK-938 / TASK-934 / TASK-935 / TASK-937 (ASR decode + language declaration), TASK-939 / TASK-943 (live lane, trigger context), TASK-933 (service-account consultation plane), TASK-947 (composite realtime instruction), TASK-950 (identity provisioning — opened minutes after this run) |
| **Citations pinned at** | `dev-2.2 @ 9e5347281` (2026-09-11 02:30 local). The tree moved under this investigation: a concurrent session merged **TASK-950 lanes A–E** while it was running, and **lane D touches `consultations/open` directly** (`752d58a64` — *"consultation open accepts schema context, resolves the user-identity field to doctorId"*). Every `path:line` below was re-verified against `9e5347281`; `getOrCreate` at that commit still carries **no status predicate**, so D4 is live on HEAD. Lane L must branch from a commit at or after this one |
| **Ticket number chosen** | `BUG-019`. `docs/README.md` §"Implementation Tickets" numbers tickets `TASK-XXX` from the global maximum, but the `BUG-*` series is a parallel, established convention (`docs/archive/BUG-001` … `BUG-018`) and the owner asked for a BUG ticket. `BUG-018` is the highest taken, so this is 019. No `TASK-*` folder is created |

---

## 1. Requirement Analysis

A governed consultation has exactly one clinical deliverable: **the case note the clinician signs.**
Everything else — the live document, the transcript, the workflow run — exists to produce it. Four
requirements follow, and this run violates all four.

| Id | Requirement | Source |
|---|---|---|
| R-1 | **The note a clinician signs must carry the heading set their department authored.** The corpus header calls the headings *"the EMR's section keys, not prose"*; a note that arrives as free narrative is not a case note | `27-document-template-library.ts:44-47` |
| R-2 | **A clinician must watch the same document being written that they later sign.** This is the stated purpose of the whole document-template library: *"a clinician watches one document being written and signs a different one. These two rows are what closes that"* | `27-document-template-library.ts:44-48` |
| R-3 | **A consultation that cannot produce a note must say so, to the caller, on the surface the caller is on.** `CLOSED_INCOMPLETE` is the honest state; honesty that only the server can see is not honesty | TASK-946 OD-4, `harness-internal.service.ts:672-673` |
| R-4 | **A terminal consultation must not accept new audio.** The state machine already says so — `CLOSED_INCOMPLETE`'s only legal successor is `REOPENED` | `ConsultationEntity.ts:73-76` |

**In scope**: D1–D4 below. **Out of scope for this ticket**: D5 (STT script bleed) — see §4.3;
and everything TASK-946 already closed.

---

## 2. Current State Evaluation

### 2.0 The run, as the logs record it

Local times are `~/.local/state/hope-dev/logs/dev/api.log` (`UTC+07`); UTC times are the Python
services. Line numbers are into the log files as captured.

| Time (local) | Event | Evidence |
|---|---|---|
| 01:27:07.142 | The caller resolves the clinician by username: `GET /admin/users?search=arcaai_doctor_bren&limit=5` | `api.log:27483` |
| **01:32:01.372** | **Consultation A opened**; run `01a08c97-4de5` dispatched — `"Consultation governed by tenant-authored workflow" … slug: arcaai-bren-consultation, source: department, governanceRecorded: true` | `api.log:27748` |
| 01:32:03.562 | `recording/start` on status `OPEN` — `"reached without PRIMED — kill-switch OFF, proceeding (would 409 if ON)"` | `api.log:27821` |
| 01:32:03.586 | `"Froze the realtime lane for this session" … laneSource: tenant-graph, stageCount: 3` | `api.log:27841` |
| **01:32:03.595** | **`"Froze the live document template for this session" … templateId: 8a000000-0000-0000-0001-000000000013, slug: arcaai-bren-soap-new-visit, versionNumber: 1, visitType: new-visit, branchHandles: [{n_visit, new_visit, matched: true}]`** | `api.log:27862` |
| 01:32:03.598 | Warm-start pre-summary degraded, `reason: no_case_notes`, `contentChars: 0` | `api.log:27872`, `:27874` |
| 01:32:46 / 01:33:04 / 01:33:49 | Three live flushes, each `sectionCount: 12`, **`summaryChars: 0`**, `turnSectionsAppended: 0`, `flushFailed: false` | `api.log:27932`, `:28039`, `:28165` |
| 01:34:12.423 | `recording/stop` #1 → **200** in 4,040 ms | `api.log:28343` |
| 01:34:12.441 | First `GET summary/latest` → **404** `No summary has been generated yet…` | `api.log:28350` |
| 01:34:18.357 | Durable lane resolves the finalizer: `GET /internal/agents/resolve?…&agentSlug=casenote-finalization` → 200 | `api.log:28381` |
| 18:34:09–18:34:23Z | **No `POST /api/v1/generate` follows that resolve.** The only two generations in the window carry `prompt_tokens` 10,472 and 10,537 — the live lane's own flushes, started earlier | `text.log`, requests `89fbaaad-…`, `81a1d56e-…` |
| — | `RuntimeError: core.output: result violates the declared output schema: (root): 'case_note' is a required property`, raised at `apps/harness/src/harness/temporal/interpreter/nodes/core.py:1949`; activity `interpreter.core_output`, `workflow_id workflow-interpreter-01a08c97-4de5-…` | `worker.log` traceback |
| 01:34:18.675 | `[HarnessInternalService] "Governed consultation closed incomplete — its workflow run ended without a clinical result", runStatus: FAILED, reason: FAILED` | `api.log:28403` |
| 01:34:12 → 01:37:13 | **37 × `GET summary/latest`, 5 s apart, every one 404.** 3 min 01 s | `api.log:28350` … `:29xxx` |
| **01:34:49.520** | `recording/stop` #2 → **409 `ConflictException`**, `"Illegal consultation state transition: CLOSED_INCOMPLETE → DRAINING"` | `api.log:28473` |
| **01:46:12.181** | **Second `POST /consultations/open` → 201 in 35 ms** (vs 303 ms and 183 ms for the two real creations). No `ConsultationWorkflowDispatchService` line follows | `api.log:29260` |
| **01:46:14.524** | **`recording/start` on the SAME consultation, `currentStatus: "CLOSED_INCOMPLETE"`** — kill-switch OFF, proceeding | `api.log:29311` |
| 01:46:14.552 | The dead consultation re-freezes the same template and re-subscribes its live lane | `api.log:29352-29353`, `:29344` |
| 01:46:42 → 01:48:41 | Five more flushes on the dead consultation; generation 5 reaches `turnSectionsRewritten: 1`, `entityCount: 1`, **`summaryChars: 92`** — real clinical content, written into a consultation whose governing run is already `FAILED` | `api.log:29405`, `:29465`, `:29591`, `:29694`, `:29795` |
| 01:48:41 → 01:49:47 | 14 more `summary/latest` 404s on the dead consultation | `api.log` |
| **01:49:35.334** | **Consultation B opened**; run `01a08ca7-6325` dispatched | `api.log:30053` |
| 01:49:35.403 | Same template frozen, same `branchHandles` match | `api.log:30128` |
| 01:50:06 → 01:56:53 | 16 flushes. Generation 15 → `summaryChars: 2115`; **generation 16 (01:56:53.622) → `sectionCount: 12`, `summaryChars: 2247`** — the last flush before stop | `api.log:30266` … `:31709` |
| 01:57:00.511 | `recording/stop` → 200 in 5,342 ms | `api.log:31896` |
| 01:57:10.103 | `casenote-finalization` resolved | `api.log:31935` |
| **18:57:10.262 → 18:57:33.472Z** | **The finalize generation**: `lm-studio` / `gemma-4-e2b-it-qat`, **`prompt_tokens: 826`**, `completion_tokens: 934`, `latency_ms 19452`. In the same seconds the live lane's two generations carry **`prompt_tokens: 10904` each** | `text.log`, request `4e7f64ab-518f-4ec1-9518-672378ea714c`; contrast `7170ee67-…`, `ad5df318-…` |
| 01:57:33.703 | `[HarnessInternalService] "Harness draft persisted" … gateDecision: null` | `api.log:32030` |
| 01:57:35.758 | First `GET summary/latest` → **200** | `api.log:32038` |
| 01:57:35.842 | The caller approves `n_review`; run completes | `api.log:32038`, `harness.log:15` |

Two numbers from that table do the most work in what follows:

* **826 prompt tokens** for the finalize call. `CASENOTE_FINALIZATION_SYSTEM_PROMPT` is ~2,000
  characters on its own (`25-agents.ts:307-313`), i.e. ~500 tokens with the DNA block rendering
  empty. That leaves roughly **330 tokens — ~1,300 characters — of actual user prompt**, against a
  live document that held 2,247 characters and 12 sections at the moment of stop. The finalizer was
  handed a fraction of the document, and no template.
* **`summaryChars: 0` on all three flushes of run A**, which is exactly why its handoff carried only
  `n_asr`, and exactly why the finalizer had nothing to bind.

### 2.1 Severity ranking, and what belongs in this ticket

The owner's labels D1–D5 are kept so the numbering is stable in conversation. The rank column is the
recommendation.

| Rank | Defect | Why here | Lane |
|---|---|---|---|
| **1** | **D4** — `consultations/open` re-attaches to a terminal consultation | Total, silent loss of a recorded consultation. The bypass writes `RECORDING` **over** `CLOSED_INCOMPLETE` through a deprecated matrix-bypassing setter, and 5½ minutes of real audio were then documented into a dead session. The caller has no signal at all: `isNew: false` is the normal, healthy answer | **Lane L** |
| **2** | **D2** — the finalized note ignores both templates | It is the deliverable. 100 % of ArcaAI finalizations are affected; the note that reaches the clinician is free prose with no headings and, in this run, no writing style | **Lane N** |
| **3** | **D1** — the live document uses the platform base shape, not the department heading set | Wrong-but-structured, and the divergence is *documented*; but it also means the model is given two incompatible instruction sets on every flush | **Lane N** |
| **4** | **D3** — an early stop destroys the consultation with no usable error | TASK-946 already made this fail fast and terminal. What remains is diagnosability and caller-facing honesty — real, but the data loss it causes is now bounded and named | **Lane L** |
| **5** | **D5** — STT script bleed | Genuinely serious (it is what starves D1/D2 and produced at least one false clinical assertion), but the language plumbing is **not** at fault, the tenant's own model and prompt are, and TASK-946 §7 already parks the residual. It needs a decode-quality ticket, not this one | **follow-up** |

**One ticket**: D1 + D2 (Lane N — "the department's note format governs the note") and D3 + D4
(Lane L — "a consultation's lifecycle is honest to its caller"). They are two coherent lanes that
touch disjoint files.
**Follow-up**: D5.

---

### 2.2 D1 — the live document is General Medicine's shape with two BREN sections bolted on

**Symptom.** The live document frozen for the session is `arcaai-bren-soap-new-visit` — 12 sections
whose 10-section spine is the *General Medicine* corpus. The department prompt the clinicians
actually authored specifies 14 different headings. The clinician watches one heading set being
written and reads another in their own department prompt.

**Evidence — CONFIRMED in code and in the run.**

The freeze, twice, byte-identical (`api.log:27862`, `api.log:30128`):

```
"Froze the live document template for this session",
templateId: "8a000000-0000-0000-0001-000000000013",
slug: "arcaai-bren-soap-new-visit", versionNumber: 1,
requestedSlug: "arcaai-bren-soap-new-visit", visitType: "new-visit",
branchHandles: [{ nodeId: "n_visit", handle: "new_visit", matched: true }]
```

The selection path, in order:

| Step | Code |
|---|---|
| Kicked off once at `start()` | `live-documentation.service.ts:1407` — `session.templatePromise = this.ensureTemplateResolved(session)` |
| The resolver | `live-documentation.service.ts:1687` |
| Reads the slug off the graph's realtime summary node, through the evaluated visit branch | `:1706` — `realtimeDocumentTemplateSlug(lane, branchHandles)` (TASK-946 lane T; working correctly here) |
| Resolves it | `:1707` — `documentTemplateService.resolveForGeneration(session.tenantId, laneSlug)` |
| Which is **tenant + slug only** | `document-template.service.ts:432-455` — `findByTenantAndSlug(tenantId, slug)`, then `isServable`. No department lookup, no visit-type lookup, no `PromptTemplate` lookup, no `scope` read anywhere in the file |

The slug comes from the graph node, not from the department:
`29-arcaai-agents-and-workflows.generated.ts:4237` — `"documentTemplateSlug": "arcaai-bren-soap-new-visit"` on `n_summary_new`.

**The two heading lists, side by side.**

`8a000000-…-013` is not a literal — it is computed by splicing two BREN sections into the platform
base at `27-document-template-library.ts:1272-1295` (splicer `spliceSections` at `:1235-1259`,
ordinal arithmetic at `:1274` → `6*2+0+1 = 13`).

| # | Document template `arcaai-bren-soap-new-visit` (12) — `key` / `title` | Origin | # | PromptTemplate `Breast & Endocrine - New Referral` v3 (14) |
|---|---|---|---|---|
| 1 | `presenting_complaints` — Presenting Complaints (`:242`) | base | 1 | **Patient Demographics** |
| 2 | `past_history` — Past History (`:251`) | base | 2 | **Risk Factors & Exposures** |
| 3 | `family_history` — Family History (`:259`) | base | 3 | **Personal & Reproductive History** |
| 4 | `drug_history` — Drug History (`:265`) | base | 4 | **Family History** |
| 5 | `hospital_admissions` — Hospital Admissions (`:274`) | base | 5 | **Presenting Complaints** |
| 6 | `examination_and_vitals` — General Examination & Vitals (`:280`) | base | 6 | **History of Illness** |
| 7 | `breast_and_nodal_examination` — Breast & Nodal Examination (`:1005`) | **BREN** | 7 | **Past Medical & Surgical History** |
| 8 | `endocrine_assessment` — Endocrine Assessment (`:1013`) | **BREN** | 8 | **Treatment History** |
| 9 | `previous_diagnosis` — Previous Diagnosis (`:289`) | base | 9 | **Medications & Allergies** |
| 10 | `reports` — Reports (`:297`) | base | 10 | **Physical Examination** |
| 11 | `current_diagnosis` — Current Diagnosis (`:306`) | base | 11 | **Investigations** |
| 12 | `plan_of_care` — Plan of Care (`:315`) | base | 12 | **Diagnosis** |
| | | | 13 | **Plan of Care** |
| | | | 14 | **Patient Education & Consent** |

Prompt row: `07b-arcaai-clinical-templates.ts:356-364` — id `71000000-0000-0000-0001-000000000022`,
`scope: 'DEPARTMENT_DEFAULT'` (`:362`), `departmentId: BREN_ARCAAI` (`:361`). The served body is v3
(`ARCAAI_CLINICAL_APPROVED_VERSION = 3`, `:561`, `:624-633`), 18,448 characters, at
`07b-arcaai-clinical-content-v3.ts:117-118`. The v1 constant the spec literal names
(`07b-arcaai-clinical-content.ts:88-89`) carries the same 14 headings with heading 6 spelled
*History of Present Illness*. Visit-type binding is not on the template — it is the department
column `Department.newPatientPromptId` (`04-department.ts:362`).

Net divergence for BREN new-visit: **6 prompt headings absent** from the note shape (Patient
Demographics, Risk Factors & Exposures, Personal & Reproductive History, History of Illness,
Treatment History, Patient Education & Consent); **4 template keys** with no prompt counterpart
or a renamed one (`hospital_admissions`, `previous_diagnosis`, `reports`, `endocrine_assessment`);
and four renamed pairs (Past Medical & Surgical History → `past_history`, Physical Examination →
`examination_and_vitals` + `breast_and_nodal_examination`, Medications & Allergies →
`drug_history`, Diagnosis → `current_diagnosis`).

**Which is intended to govern — settled, and it is not what the report assumed.**
The seed states the split explicitly (`27-document-template-library.ts:41-48`):

> *"the prompt keeps the protocol and keeps governing the FINALIZE note … this library governs the
> REALTIME running note, which `resolveForGeneration` is the only consumer of. What they must AGREE
> on is the heading list … and today they do not"*

So the live lane picking the document template is **correct by design**. The `scope` column is never
branched on at runtime (grep of `packages/applications/src` returns only prompt-management CRUD:
`prompt-management.service.ts:416, 821, 854, 878`).

**Root cause — two, separable.**

1. **The divergence is hand-authored and unratified.** The department sections were *"derived from
   the headings their own v3 prompt bodies carry … Only the headings a SOAP shape does not already
   express are lifted"* (`27-document-template-library.ts:749-752`), and the base 10 *"ARE the
   General Medicine shapes"* (`:757-760`). Three measured reasons are given for not lifting the
   bodies mechanically — SIZE (the protocol block is 10,119 chars against a 10,000 `globalInstruction`
   cap, `:53-56`), SEMANTICS (corpus RULE 3 "omitting a heading is always correct" contradicts a
   strict `json_schema` where every key is required, `:57-62`), STRUCTURE (`sections[]` is flat, the
   corpus nests, `:63-66`). All three are real. **But nothing enforces the residual agreement**:
   `arcaai-department-document-templates.task932.test.ts:93-117` asserts only that a non-GEN shape
   adds ≥1 heading, that base sections are inherited verbatim, that every workflow names a resolvable
   slug and that nothing is `required`. It **never** compares against `07b-arcaai-clinical-content-v3.ts`.
2. **The model is given both, every flush.** `stablePrefixFor`
   (`live-documentation.service.ts:4513-4520`, called at `:2754` and `:2838`) concatenates the
   department prompt's 14 prose headings with the document template's 12-key JSON instruction, and
   the response is then decoded against the 12 (`:5166`). The docblock immediately above names the
   hazard — *"a model told in prose to write a SOAP note while being constrained to a discharge
   summary has been given two incompatible jobs, and which one wins depends on the provider"*
   (`:4500-4504`) — and resolves it by declaring the template structurally authoritative. It is the
   right resolution of the wrong situation: the two should not disagree in the first place.

**Blast radius.** All 22 ArcaAI department × visit-type shapes are built by the same splice
(`27-document-template-library.ts:753`, eleven departments × two visit types). Every one of them is
General Medicine's spine plus 1–3 department headings, against a 12–14 heading department corpus.
Confirmed for BREN by this run; **INFERRED** for the other ten departments from the shared builder.

---

### 2.3 D2 — the finalizer is handed no template, no department prompt, and no trigger context

**Symptom.** `n_finalize` (`casenote-finalization`) returned `{"case_note": "<free prose>"}`,
`core.output` accepted it, and the persisted `RAW_SUMMARY` is 764 characters of unstructured
narrative with no headings and no `dnaStyleId`. The 12-section, 2,247-character live document that
existed at the moment of stop was discarded.

**Evidence — CONFIRMED in code; the run's own numbers corroborate.**

`n_finalize` is authored at `28-workflow-library.ts:169-173`:

```ts
id: 'n_finalize',
type: 'core.agent',
config: { agentRef: { slug: 'casenote-finalization' }, execution: { lane: 'durable', cadence: 'onEnd' }, guardrail: { enabled: true }, dna: { enabled: true }, onError: 'fail' },
```

There is **no `documentTemplateSlug`**, and there is **no `context` edge**. The template binding
helper is applied only to summary nodes (`28-workflow-library.ts:89-93`, called at `:106`, `:131`,
`:142`); the ArcaAI call site populates only those two keys
(`29-arcaai-agents-and-workflows.ts:179-182`). The compiled BREN blob carries
`"documentTemplateRefs": []` (`29-arcaai-agents-and-workflows.generated.ts:4473`).

The finalizer's edges are exactly two:

| Edge | Line | What it carries |
|---|---|---|
| `['n_presummary', 'next', 'n_finalize', 'after']` | `28-workflow-library.ts:227` | **ordering only** — `registry.py:82` maps `next → None`, so `_resolve_bound_inputs` skips it (`workflow.py:562-564`). The seed says so at `:223-226` |
| `summaryIds.map(id => [id, 'out', 'n_finalize', 'in'])` | `28-workflow-library.ts:246` | the realtime summary node's `text` |

Compare the summary nodes, which **do** get the trigger context:
`['n_trigger', 'out', 'n_summary_new', 'context']` at `:241`. `n_finalize` has no equivalent, so
`bound['context']` is always empty and `_run_text_generation` builds its user prompt from `in` alone
(`core.py:1231-1244`).

`core.output` cannot catch the result. Its declared schema
(`28-workflow-library.ts:203-210`, compiled at `29-arcaai-agents-and-workflows.generated.ts:4413-4442`):

```
required: ['case_note'],
properties: { case_note: { type: 'string' }, redactions: { … } }
```

`case_note: string` with no `minLength` and no shape constraint; `redactions` demoted from `required`
(it *is* required on the agent's own schema, `25-agents.ts:319`). And the agent's own `outputSchema`
is never validated post-hoc on this lane — it becomes a wire `response_format` hint only
(`core.py:1410-1416`, `:1712-1745`) and the response is `json.loads`-ed with no validation
(`core.py:1449-1455`).

The run's numbers agree: **826 prompt tokens** for the finalize call against ~500 for the system
prompt alone, while the live lane's contemporaneous generations carry **10,904** each. The finalizer
was given roughly 1,300 characters of partial summary and nothing else.

**Why no `dnaStyleId` — narrowed, not fully settled.**

The chain is: `resolveHandoffDnaContext` publishes `dna_style_id` into the handoff context
(`live-documentation.service.ts:5905-5945`, publish at `:5932`) → `readLiveHandoff` returns it as
`context` (`:5795`) → the interpreter seeds `_live_context` from it (`workflow.py:664-670`) →
`core.py:1131` reads `trigger.get("dna_style_id")` → `PersistDraftInput.dna_style_id`
(`core.py:1192-1194`) → `harness-internal.service.ts:1198` → `ContextItem.dnaWritingStyleId`. The
response's `structuredData` is then non-null **iff** `dnaWritingStyleId` is non-null on this endpoint,
because `findLatestRawSummary` never hydrates `SummaryMeta` (`ContextItemRepository.ts:146-161`;
mapper `summary.dto.mapper.ts:14-29`, and its own comment at `:11-13`). So "no `structuredData`" and
"no `dnaStyleId`" are one fact, not two.

Three things are established:

* **The seed is not at fault.** `08-dna-writing-style.ts:468-471` seeds a BREN report
  `73000000-0000-0000-0001-000000000007` for `SEED_USER_IDS.ARCAAI_DOCTOR_BREN`
  (`70000000-0000-0000-0000-000000000047`, `00-constants.ts:245`), with non-empty `styleText`.
  The GEN row at `:402-405` is `73000000-0000-0000-0001-000000000001` — the id the earlier
  General-Medicine run carried.
* **The handoff did end and did carry outputs.** `n_finalize` generated (826 prompt tokens at
  18:57:10Z), so `in` was bound; on this graph the only possible source is the live handoff, because
  `n_summary_new` is `lane: realtime` and the durable interpreter skips it
  (`workflow.py:718-724`). `_await_live_outputs` sets `_live_context` and seeds `_node_outputs` in
  the same `answer.ended` branch (`workflow.py:664-670`), so the context **was** applied — and it
  did not contain `dna_style_id`.
* **The decrypt did not fail.** `grep "Effective DNA style/redaction could not be resolved"` over
  `api.log` returns **0**, so the `catch` at `live-documentation.service.ts:5937-5944` never fired.

That leaves four branches inside `resolveHandoffDnaContext`, **all of which return silently**:
`!doctorId` or unwired `dnaReportRepository`/`secretsService` (`:5907`); both DNA gates off
(`:5919`); `!report` (`:5921`); or `styleEnabled === false` so `text` is `undefined` while
`redactionEnabled` stays true (`:5926-5932`). **I could not determine which fired** — none of them
logs, and the stack is stopped. *That silence is itself part of the defect*: a clinical-provenance
field can vanish with no trace.

**Root cause.** The graph never gives the finalizer the note's shape. `n_finalize` binds only the
realtime summary text, and the platform's entire heading-preservation contract lives in one prose
sentence in the system prompt — *"keeps the document template headings exactly as they appear in the
partial summaries (same names, same order)"* (`25-agents.ts:308`). When the partial summaries are
thin or degenerate, there are no headings to preserve, and `core.output`'s schema is too weak to
notice. The DNA null is a second, separate failure on the handoff-context path.

**Blast radius.** Every ArcaAI department (all 22 graphs are built by the same
`buildConsultationGraph`) and every platform tenant on the seeded consultation graph
(`28-workflow-library.ts:88-257`). Any consultation whose live lane produced a thin summary
finalizes as free prose, and `core.output` will publish it.

---

### 2.4 D3 — an early stop destroys the consultation with no usable error

**Symptom.** `recording/stop` arrived before the live lane had produced any output. The run failed
on a JSON-schema message, the consultation went `CLOSED_INCOMPLETE`, and the caller — polling
`summary/latest` — was told 37 times in a row that no summary had been generated *yet*.

**Evidence — CONFIRMED.** The traceback (`worker.log`):

```
File ".../apps/harness/src/harness/temporal/interpreter/nodes/core.py", line 1949, in interpreter_core_output
    raise RuntimeError(
RuntimeError: core.output: result violates the declared output schema: (root): 'case_note' is a required property
```

and the three flush lines that explain it — `summaryChars: 0` on generations 1, 2 and 3
(`api.log:27932`, `:28039`, `:28165`). With no summary output, the handoff carried only `n_asr`, so
`n_finalize` had nothing on `in`.

**(a) A degraded summariser should not surface as a schema violation.**

`_schema_violation` (`core.py:130-141`) validates the bound payload and reports the JSON path. With
zero bindings resolved, `_output_payload(_bound(payload))` is `{}` (`core.py:1925-1930`), so the
message is `(root): 'case_note' is a required property` — a statement about a schema, when the fact
is *"the summariser produced nothing"*. `_resolve_bound_inputs` silently `continue`s on an absent
producer (`workflow.py:560-564`), so "upstream degraded and stored nothing" and "the agent returned
`{}`" arrive as the identical value and produce the identical text. The exception is a bare
`RuntimeError` (`core.py:1949-1951`), not a typed domain error.

There is no route around it. `n_output` has exactly one data producer
(`28-workflow-library.ts:253` — `['n_finalize', 'data', 'n_output', 'in']`), no alternate edge, no
`core.data` default and no transcript passthrough. And a DEGRADED node writes nothing downstream —
only `SUCCEEDED` populates `_node_outputs` (`workflow.py:854-867`).

A related finding worth recording: the graph author's `onError` is **inert**. It is parsed into
`CompiledNode` (`compiled_config.py:136`) and never read again in `apps/harness`; criticality comes
only from the code-owned `NodeSpec.critical` (`registry.py:74` for `core.agent`, `:158` for
`core.output`), resolved by `effective_spec` (`registry.py:203-216`), which honours `config.onError`
for `core.action` alone. So `n_finalize`'s `onError: 'fail'` does not stop the walk — the run
continues to `n_output` and fails on the schema instead of on the finalizer.

**(b) `CLOSED_INCOMPLETE` is never reported to the caller on the surface the caller is on.**

Three things are written when the run fails
(`harness-internal.service.ts:687` `failGovernedRun`): `metadata.terminalReason` (`:730`), the
status transition (`:735`), a `ResourceUpdated` sys-event (`:739-744`), and a best-effort
harness-progress push with `stage: 'failed'` (`:748-753`). Every one of them lands somewhere the
polling client is not:

| Surface | Carries the terminal state? |
|---|---|
| `GET /consultations/:id` | yes — `status` and `metadata.terminalReason` (`consultation.dto.mapper.ts:29`, `:34`) |
| `GET /consultations/:id/harness-progress/stream` | yes — `closed: true` (`harness-progress.service.ts:154-163`), best-effort |
| **`GET /consultations/:id/summary/latest`** | **no** — `consultation.controller.ts:1546` throws `NotFoundException("No summary has been generated yet for consultation <id>")`. The route never reads `consultation.status`. `CLOSED_INCOMPLETE`-with-no-summary and `RECORDING`-with-no-summary-yet are byte-identical to the caller |

And `summary/latest` is the surface the caller is on — by design, on the ALaaS side:
`consultation-broker.service.ts:373-376` documents the bounded poll as *"the only surface that
reports the finalized note"*, `summaryTimeoutMs: 3 * 60_000` at `:123`, the loop at `:1004-1055`.
Each 404 is caught and logged as a transient warning (`:1032-1034`), so the client burns the whole
budget and then emits `SUMMARY_TIMEOUT` (`:1037-1044`) — a timeout message for a consultation that
was already dead 3 seconds into the poll.

**(c) The redundant stop 409s rather than being absorbed.**

`stopRecording` (`consultation.service.ts:1612`) calls `applyTransition(… DRAINING …)` at `:1625`
with no terminal-state pre-check. From `DRAINING` a second stop is a self-transition no-op
(`ConsultationEntity.ts:328-330`) → 200. From `CLOSED_INCOMPLETE` the guard at
`ConsultationEntity.ts:341-343` throws `BusinessException`, re-mapped to `ConflictException` by
`consultation.service.ts:1275-1281`. Ordering makes it worse: `liveDocumentationService.stop` runs
**first** (`consultation.controller.ts:911`) and *is* idempotent
(`live-documentation.service.ts:2274`) — the run's own log shows it succeeding
(`api.log:28471`, `owned: false`) 4 ms before the 409 (`api.log:28473`). The caller gets an error for
an operation whose side effects were already applied. `failGovernedRun` shows the right shape three
files away: it guards on the current status and returns `{ transitioned: false }` rather than
throwing (`harness-internal.service.ts:707-715`).

**Root cause.** The graph has no transcript-only fallback; `core.output`'s error is written for a
schema author, not a clinician; the terminal state is broadcast on channels the caller is not
listening to; and `stopRecording` has no idempotency guard for terminal statuses.

**Blast radius.** Any governed consultation stopped before the live lane produces a summary — short
consultations, silent rooms, a TEXT outage during the recording, or (as here) a run whose transcript
was too degraded to summarize. Every client that polls `summary/latest` is affected identically.

---

### 2.5 D4 — `consultations/open` silently re-attaches to a terminal consultation, and `recording/start` writes over the terminal status

**Symptom.** A second `POST /consultations/open` returned the existing `CLOSED_INCOMPLETE`
consultation with `isNew: false`; `recording/start` then proceeded on it; no workflow run was
dispatched; five more flushes wrote real content into a consultation that can never finalize.

**Evidence — CONFIRMED in code and captured live in the prisma query log.**

The reuse predicate, as it actually executed at 01:46:12 (`api.log`, prisma statement log):

```sql
FROM "core"."Consultation" AS "t0"
WHERE ("t0"."tenantId" = $1 AND "t0"."patientId" = $2 AND "t0"."appointmentDate" = $3
       AND "t0"."doctorId" = $4 AND "t0"."resourceStatus" = CAST($5::text AS "core"."ResourceStatusType"))
LIMIT $6 OFFSET $7
```

which is exactly `ConsultationRepository.findByUniqueKey` (`ConsultationRepository.ts:57-74`), called
from `getOrCreate` at `consultation.service.ts:601`, with the reuse return at `:620`
(`ConsultationDtoMapper.toResponse(withRelations ?? existing, false)` — the `false` is `isNew`).

Three facts follow, each verified:

* **No `status` filter of any kind.** `getOrCreate` (`consultation.service.ts:553-620`) never reads
  `existing.status`. It will re-attach to any of the twelve `ConsultationStatus` members
  (`enums.prisma:296-320`), `SIGNED`, `CLOSED`, `CLOSED_COMPLETE` and `CLOSED_INCOMPLETE` included.
* **The name is a misnomer.** `consultation.prisma:62` — *"Indexes (no unique constraint - allows
  multiple visits same doctor/day)"*. And `findFirst` is called with no `sort`
  (`repository.ts:120-129`), so with several rows on the key the winner is DB-order-dependent; the
  sibling `findByPatientAndDate` (`ConsultationRepository.ts:23-33`) *does* pass an ordering.
* **`departmentId` is not in the predicate.** A second `open` naming a different department
  re-attaches to the same row and drops the new department silently.

`recording/start` then bypasses the state machine (`consultation.service.ts:1566-1585`):

```ts
if (!requirePrimed && !consultation.canTransitionTo(ConsultationStatus.RECORDING)) {
  this.logger.warn({ message: 'recording/start reached without PRIMED — kill-switch OFF, proceeding (would 409 if ON)', … });
  consultation.status = ConsultationStatus.RECORDING;      // :1583
}
```

`:1583` uses the setter documented as `@deprecated: bypasses the legality matrix`
(`ConsultationEntity.ts:208-222`). From `CLOSED_INCOMPLETE`, `canTransitionTo(RECORDING)` is `false`
(only `REOPENED` is legal, `ConsultationEntity.ts:73-76`), so the bypass branch fires and writes
`RECORDING` straight over a terminal status. **The log line is misleading in this case** — the
problem was not "no `prime`", it was "terminal", and the condition does not distinguish the two.
The kill-switch is `consultation.state.requirePrimedBeforeRecording`
(`consultation-gates.constants.ts:91`), code default `false` (`:161`), descriptor
`killSwitch: true, globalOnly: true, failMode: 'open-to-default'`
(`consultation-gates.descriptors.ts:132-147`), and **no seed row exists** — `11c-consultation-gate-settings.ts:80-96`
seeds only the graph-executor and OCR gates. So it is OFF by default everywhere.

No new run is dispatched, and that is structural rather than a skip: the only call to
`dispatchForConsultation` is inside the create branch (`consultation.service.ts:716`), which the
reuse branch's early `return` at `:620` never reaches. The code says so at `:701-703`.

`metadata.governingEngine` is left pointing at the failed run. `readGoverningEngineMarker`
(`governing-engine.ts:95-110`) checks **shape only** — `:101-102` — and no consumer ever queries
`WorkflowRun` status; the module explains why at `:26-30` (*`WorkflowRun` carries no
`consultationId`, "so there is no key to join on"*). `failGovernedRun` stamps a **sibling**
`terminalReason` key (`harness-internal.service.ts:730`) and never clears `governingEngine`. So the
row simultaneously asserts *"run X governs me"* and *"run X ended FAILED"*, and the two readers that
matter — `LiveDocumentationService.ensureSubstrateResolved`
(`live-documentation.service.ts:1796`) and `LoopContextSignalService.standDownForTenantWorkflow`
(`loop-context-signal.service.ts:178`) — trust the first. That is precisely what the run shows: at
01:46:14 the dead consultation re-froze its lane and its template and started documenting again.

**The concrete harm, from the log.** Five flushes between 01:46:42 and 01:48:41 on the dead
consultation, the last reaching `turnSectionsRewritten: 1`, `entityCount: 1`, `summaryChars: 92`
(`api.log:29795`). Real clinical content, written into a consultation with a `FAILED` governing run
and no path to finalization — while the caller polled `summary/latest` 14 more times and got 404
every time.

**Root cause.** `open` is a get-or-create on a natural key with no lifecycle predicate;
`recording/start`'s kill-switch bypass cannot tell "not primed" from "terminal"; and nothing
invalidates `governingEngine` when its run dies.

**Intended semantics — established, with one gap.** The SDK contract is explicit
(`vox-node/src/resources/consultations.ts:88-94`): *"GET-OR-CREATE the consultation for
`(patientId, clinician, appointmentDate)`. Read `isNew` to tell which happened; calling this twice
for the same visit is the intended way to re-attach to a consultation you already opened, not an
error."* Same in `IConsultationService.ts:12-22` and
`docs/research/architecture/encounter-workflow-fit-gap-analysis-2026-03-10.md:41`. **None of them
qualifies the statuses.** The closest thing to a rule is TASK-946 OD-4
(`docs/implementation/TASK-946-Live-Consultation-Trial-Fixes/README.md:78`): *"A clinician cannot
sign an empty note; `CLOSED_INCOMPLETE` is the honest state and `reopen` exists"*, restated in code
at `harness-internal.service.ts:672-673`. **Re-attaching to a terminal consultation is never
correct**: the sanctioned way back is `POST :id/reopen`, which goes through the state machine.
`open` offers a competing path that skips it.

**No test covers it.** `consultation.service.test.ts:260-277` asserts `isNew === false` on a mocked
repository whose fixture is `OPEN`; a grep for `getOrCreate` co-occurring with
`closed|terminal|signed|timed` across every `*.test.ts` / `*.spec.ts` returns zero hits; and
`apps/api/tests/e2e/consultation-state-machine.spec.ts` opens every case with a fresh
`uniquePatientId(...)` (`:122`, `:141`, `:159`, …), so it never opens twice on the same key.

**Blast radius.** Every caller of `consultations/open`, including the ALaaS broker, which reads only
`consultation.id` and never inspects `isNew` (`consultation-broker.service.ts:247`,
`hope-realtime.vox-node.adapter.ts:344-350`; a grep for `isNew` across
`apps/audio-stream-svc/src/consultation` returns nothing).

---

### 2.6 D5 — STT script bleed (follow-up candidate)

**Symptom.** With `languageMode: en` and `language: en` over English-only audio, a substantial
minority of segments came back in Malayalam script, **including persisted finals**, and at least one
false clinical assertion ("reported having brain tumors") entered the note from a garbled segment.

**Does the agent honour the mode? Yes — and this is the part of the report the evidence contradicts.**
`languageMode` survives all eleven hops and reaches whisper.cpp as a pinned decode parameter:

| Hop | Code |
|---|---|
| broker → STT session | `ALaaSv3.0/apps/audio-stream-svc/src/consultation/consultation-broker.service.ts:752` |
| SDK → gateway | `vox-node/src/resources/stt.ts:59-66` |
| gateway DTO → controller | `transcription-job.dto.ts:130-137` → `transcription-job.controller.ts:816` |
| gateway → `apps/stt` | `streamingSession.service.ts:231` — `language_mode: dto.languageMode ?? null` |
| caller wins over the agent spec | `session_manager.py:1112-1121` (TASK-938's fix; docstring at `:210-232`) |
| mode → decode params | `language_modes.py:414-481` — `single` ⇒ `language='en'` |
| applied per session | `session_manager.py:2172-2181` |
| engine | `whisper_cpp_asr.py:359-364`, `:694` |

And the run proves it (`stt.log:1209`):

```
{"session_id": "01a08ca7-636c-…", "model_slug": "arcaai-whisper-large-ml-en-gguf",
 "model_format": "WHISPER_CPP", "language": "en",
 "event": "ASR pipeline loaded for streaming session", "timestamp": "2026-09-10T18:49:35.373650Z"}
```

**So this is tenant content tuning, plus one narrow platform gap.**

*Tenant content.* The agent `realtime-transcription` is bound to
`arcaai-whisper-large-ml-en-gguf` (`25-agents.ts:341-360`) — a Malayalam+English **code-switch
fine-tune** of `openai/whisper-large-v3-turbo`, `languages: ['ml','en']`, tagged `malayalam`,
`code-switch` (`ai-models/audio.ts:100-142`), and seeded as the platform STT default
(`06-stt.ts:203-221`). Its `ASR_INSTRUCTION` conditions the decoder on a prompt that **names
Malayalam**: `'Clinical consultation between a clinician and a patient. English and Malayalam medical
terminology.'` (`25-agents.ts:201`). Both are tenant-editable agent fields. ArcaAI does not author
its own copy — it receives the SYSTEM row verbatim through `copyAgents`
(`26-tenant-reference-set.ts:302-325`).

*The platform gap.* TASK-946 lane S added a script tripwire, and it fired correctly — four times on
session `01a08ca7-636c`, at utterance indices 11, 15, 22 and 37, each `latin_ratio: 0.0`
(`stt.log:1654`, `:1840`, `:1914`, `:2323`). But the guard only clears the decoder carry-forward when
the final is **majority** non-Latin (`inference.py:337-355` with `language_modes.py:272-280`), so
**mixed-script finals pass through untouched and are then fed back as decoder context**
(`inference.py:585-589`, 50-word window, `dto.py:804`). The run contains a matched record of exactly
that (`stt.log:2008`, utterance 26 at `18:53:34.703Z`, not among the flagged indices):

```
final_text: "ൽ എന്ന് പറഞ്ഞാൽ നിർത്തേക്കുന്നത്? തം. ൽ വർഷം. I just, because it's so bad, I was afraid my neighbor"
```

63 letters, **40 Latin (63 %)** — majority Latin, so `_is_script_mismatch` returns `False` and the
Malayalam primes the next decode. This is the same shape as the owner's quoted example
("കയൽ … Harris, I'll be your doctor today.").

*Why it matters to D1/D2.* The whole of consultation B's transcript is ~2,440 characters across 40
utterances (summing `text_len` over `stt.log` "Utterance transcribed" for that session, indices
0–39). That is what the live lane and then the finalizer had to work with, and it is why the note is
thin. A hallucinated clinical assertion arising from a garbled segment is a patient-safety issue in
its own right.

**Recommendation.** Follow-up, not this ticket — it belongs with the TASK-934/935/937/938/946-S
decode line, and TASK-946 §7 already parks the residual (*"Residual script noise on the live path …
Re-measure `partialWindowSec` 6 vs 15"*). What this run adds to that item is the **mixed-script
threshold**, which is new and is platform code.

---

### 2.7 Where the report's framing did not survive the evidence

Recorded here rather than quietly corrected, because three of these change what a fix has to do.

| # | Framing | What the evidence shows |
|---|---|---|
| 1 | D3: *"the state machine should … rather than 500-ing on the transition"* | It is a **409**, not a 500. `BusinessException` would map to 500 through the generic handler (`exception.interceptor.ts:340-352`), but `consultation.service.ts:1275-1281` re-maps it to `ConflictException`. Confirmed in the log: `errorType: "ConflictException", statusCode: 409` (`api.log:28473`). *Any transition site not wrapped in that helper would leak a 500 — worth pinning, but not what happened here* |
| 2 | D3: *"`n_summary_new` returned `status: DEGRADED, reason: "core.agent: nothing bound…"`"* | On the code, `n_summary_new` is `lane: realtime` (`29-arcaai-agents-and-workflows.generated.ts:4374-4376`) and the durable interpreter **SKIPs** it with `reason="realtime_lane"` (`workflow.py:718-724`). The only node that can emit that string on the durable lane is **`n_finalize`** (`core.py:1243-1250`, the sole occurrence in the repo), and the log corroborates: `casenote-finalization` was resolved at 01:34:18.357 (`api.log:28381`) and no generation followed (`text.log`, 18:34:09–18:34:23Z). **CONFIRMED from the Temporal history — see §2.8.** `n_summary_new` was never scheduled on the durable lane; `n_finalize` was, bound to `{"in": ""}`. Q-1 closed, no sixth defect |
| 3 | D4: *"the same (patient, doctor, department)"* | `departmentId` is **not** in the predicate — the key is `(tenantId, patientId, appointmentDate, doctorId, resourceStatus)`. Confirmed both in `ConsultationRepository.ts:57-74` and in the SQL the run actually issued |
| 4 | D1: *"why the live lane picks the document template rather than the DEPARTMENT_DEFAULT prompt"* | Picking the document template is **correct by design** and documented (`27-document-template-library.ts:41-48`): the prompt governs the finalize note, the library governs the realtime note. The defect is that the two heading lists were hand-derived and never reconciled, that no test enforces agreement, and that the model receives both instruction sets on every flush |
| 5 | D2: *"an earlier General-Medicine run … carried `dnaStyleId 73000000-0000-0000-0001-000000000001`"* | Correct, and it is the **GEN doctor's** report (`08-dna-writing-style.ts:402-405`). BREN has its own: `73000000-0000-0000-0001-000000000007` (`:468-471`). So the expected value for this run was `…-0007`, not `…-0001`. The regression claim stands; the target value does not |
| 6 | D2: *"the live document at that moment held 12 sections / 2115 chars"* | 2,115 was generation **15** at 01:56:30.169 (`api.log:31652`). The last flush before stop was generation **16** at 01:56:53.622 — `sectionCount: 12`, **`summaryChars: 2247`** (`api.log:31709`) |
| 7 | D5: *"Identify whether the ArcaAI `realtime-transcription` agent honours the mode at all"* | It does. `language: "en"` reached the decoder (`stt.log:1209`). The bleed is the ml-en fine-tuned model plus an `initialPrompt` that names Malayalam — both tenant content — with one genuine platform gap in the mixed-script threshold |
| 8 | D3: *"`CLOSED_INCOMPLETE` is not reported to the caller as a terminal outcome"* | True **on the summary route**, which is the only route the caller was on. It *is* reported on `GET /consultations/:id` (`metadata.terminalReason`) and on the harness-progress SSE stream. The fix is therefore about the polling surface and the client contract, not about writing the state |

---

### 2.8 Temporal history of both runs — Q-1 settled, and the mechanism of D2 in one line

The histories were captured from `http://localhost:8233/api/v1/namespaces/default/workflows/workflow-interpreter-<runId>/history` **while the stack was still up**, before the investigation began, and decoded from the base64 `activityTaskScheduledEventAttributes.input` payloads (each carries `node_id`, `node_type`, `config` and `bound_inputs`). This is the evidence §2.7 #2 could not reach and Q-1 asked for.

The decoded payloads for both runs are in [`evidence-temporal-durable-nodes.md`](./evidence-temporal-durable-nodes.md) beside this file.

**Run A (`01a08c97-4de5-7eab-8d6d-74f50c41b396`, FAILED).** After `n_trigger` (18:32:01Z) the durable lane scheduled **exactly three** nodes, all at 18:34:18Z:

| `node_id` | `node_type` | `bound_inputs` |
|---|---|---|
| `n_visit` | `core.condition` | `{"in": ""}` |
| `n_finalize` | `core.agent` (`casenote-finalization`) | `{"in": ""}` |
| `n_output` | `core.output` | `[]` |

`n_summary_new` was **never scheduled on the durable lane**. §2.7 #2 is therefore CONFIRMED and Q-1 is closed: the `DEGRADED — "core.agent: nothing bound on \`in\`/\`context\` to generate from"` came from **`n_finalize`**, not `n_summary_new`. There is **no sixth defect**, and Lane L's shape stands. `n_finalize`'s node config in the same payload, verbatim:

```json
{"agentRef":{"slug":"casenote-finalization"},"dna":{"enabled":true},
 "execution":{"cadence":"onEnd","lane":"durable"},"guardrail":{"enabled":true},"onError":"fail"}
```

**Run B (`01a08ca7-6325-7faf-b2b2-a1b8ac217447`, COMPLETED).** The same trigger plus three durable nodes, and `n_finalize` received:

```
bound_inputs.in = "The patient reported a terrible headache that looked 'really bad'.\n\nThe patient
                   reported a terrible headache that looked 'really bad'. The patient elaborated on…"
```

— that is, **the rendered PROSE of the live document, as one flat string**.

Two consequences:

1. **D2's root cause is sharper than §2.3 states.** The durable finalizer's only input is the live document's rendered text. It is handed no section boundaries, no heading keys, no `documentKey`/`sectionKey`, and no department/visit-type template — so it cannot preserve a structure it was never given. Prose in, prose out. This also explains the 826-vs-10,904 prompt-token gap recorded in §2.3 without needing a truncation hypothesis. N-1/N-2 should therefore be framed as *give `n_finalize` the structured document (or the template) instead of the flattened string*, not merely as *attach the department prompt*.
2. **Q-5 narrows.** `dna: {"enabled": true}` is present in `n_finalize`'s node config on **both** runs, so the null `dnaStyleId` is not a disabled-in-config case. One of the four silent branches at `live-documentation.service.ts:5907/5919/5921/5926` is eliminated; the DB read Q-5 asks for is still needed for the other three.

The empty `bound_inputs.in` on run A is also the mechanical link that completes D3's chain: live lane ends with no document → `n_finalize` bound to `""` → DEGRADED → `n_output` has no `case_note` → schema violation → run `FAILED` → `CLOSED_INCOMPLETE`.

---

## 3. Implementation Plan — awaiting owner approval

**Nothing below is implemented. No code, no seed change, no migration until the owner approves.**
TDD per `.claude/rules/01-development-workflow.md`: the failing tests land first and must be seen RED.

Two lanes, disjoint files, one worktree each per `.claude/rules/14-multi-agent-worktrees.md`.

### 3.1 Lane L — a consultation's lifecycle is honest to its caller (D4, then D3)

Ordered so the highest-severity defect lands first.

| # | Change | File |
|---|---|---|
| L-1 | `getOrCreate` refuses to re-attach to a terminal consultation. Introduce **one** named predicate — `CONSULTATION_TERMINAL_STATUSES` — derived from `CONSULTATION_TRANSITIONS` rather than hand-listed (a status whose only successor is `REOPENED`, or which has none), so the set cannot drift from the matrix | `packages/domains/src/entities/generated/core/ConsultationEntity.ts` (or a sibling constants file — see Q-3), `packages/applications/.../consultation/consultation.service.ts:553-620` |
| L-2 | The predicate excludes terminal rows, so a same-day revisit after a closed consultation **creates a new one**. `consultation.prisma:62` already permits multiple rows per (doctor, patient, day), and `parentConsultationId` already carries the link. Add the `sort` the sibling query has, so "the existing one" is deterministic | `packages/domains/src/repositories/generated/core/ConsultationRepository.ts:57-74` |
| L-3 | The response tells the caller which happened. `isNew` is a two-state answer to a three-state question; add `reattached: boolean` and, when a terminal row was passed over, `supersededConsultationId`. `isNew` keeps its meaning — no breaking change | `.../consultation/dto/consultation.response.ts`, `.../consultation.dto.mapper.ts:15,42` |
| L-4 | `recording/start` distinguishes "not primed" from "terminal". The kill-switch bypass stays for the PRIMED gap; a **terminal** status is a hard 409 regardless of the switch, and the log line says which of the two it hit | `.../consultation.service.ts:1566-1585` |
| L-5 | `failGovernedRun` clears `metadata.governingEngine` when it stamps `terminalReason`, so a dead run cannot keep asserting governance | `.../harness/harness-internal.service.ts:687-770` |
| L-6 | `stopRecording` absorbs a redundant stop on a terminal consultation instead of throwing: return the consultation with its current status, mirroring `failGovernedRun`'s `{ transitioned: false }` shape (`harness-internal.service.ts:707-715`). A stop on a *live* status is unchanged | `.../consultation.service.ts:1612-1640` |
| L-7 | `summary/latest` stops lying to a poller. On a terminal consultation with no summary, answer **409 `ConflictException`** naming the terminal status and `terminalReason` — distinct from the 404 that means "not yet". A 404 keeps meaning "still coming" | `apps/api/src/modules/consultation/consultation.controller.ts:1543-1548` |
| L-8 | `core.output`'s failure names the clinical fact. When the bound payload is empty **and** an upstream producer is DEGRADED/SKIPPED, raise a message that names the producing node and its reason instead of the schema path. Keep the schema text for a genuine shape mismatch | `apps/harness/src/harness/temporal/interpreter/nodes/core.py:1933-1956`, reading the walk's node results |
| L-9 | ALaaS: the broker treats a terminal answer as terminal — stop the poll, emit a named error, and check `isNew`/`reattached` on open | `ALaaSv3.0/apps/audio-stream-svc/src/consultation/consultation-broker.service.ts:247`, `:1004-1055` (separate repo; sequenced after L-3/L-7) |

**Deliberately NOT in this lane**: a transcript-only fallback branch in the graph. It is a real
option for D3(a) but it changes what a clinician is handed, and that is the owner's call — see Q-4.

#### Lane L — TDD list (RED first)

1. `getOrCreate` on a `CLOSED_INCOMPLETE` row with the same natural key **creates a new consultation**
   and returns `isNew: true` with `supersededConsultationId` set. *(new — `consultation.service.test.ts`,
   beside `:260-277`)*
2. Same for `SIGNED`, `CLOSED_COMPLETE`, `CLOSED`. `OPEN`/`RECORDING`/`DRAINING` still re-attach with
   `isNew: false`, `reattached: true` — the existing behaviour, pinned.
3. The terminal set is derived from `CONSULTATION_TRANSITIONS`, not hand-listed: adding a status to
   the matrix with no outgoing edge makes it terminal without a second edit.
4. `recording/start` on `CLOSED_INCOMPLETE` **409s with the kill-switch OFF**, and the message names
   the terminal status, not PRIMED. On `OPEN` with the switch OFF it still proceeds and still warns.
5. `failGovernedRun` leaves `metadata.governingEngine` **absent** and `terminalReason` present.
6. A second `recording/stop` on `CLOSED_INCOMPLETE` returns **200** with `status: CLOSED_INCOMPLETE`
   and performs no write; on `DRAINING` it stays a 200 no-op.
7. `GET summary/latest` on a terminal consultation with no summary → **409**, body naming the status
   and `terminalReason.runId`; on a live consultation with no summary → **404**, unchanged.
8. `apps/harness`: a graph whose `n_finalize` degrades produces a `core.output` error naming
   `n_finalize` and its reason. A graph whose finalizer returns `{"note": "..."}` still produces the
   schema-path message. *(`apps/harness/tests/…/test_bug019_output_diagnosis.py`, new)*
9. e2e: `apps/api/tests/e2e/consultation-state-machine.spec.ts` gains an open-twice-on-the-same-key
   case — the only spec in the repo that can catch this class, and today every case uses a fresh
   `uniquePatientId(...)`.

### 3.2 Lane N — the department's note format governs the note (D2, then D1)

| # | Change | File |
|---|---|---|
| N-1 | Bind the note's shape to the finalizer. Give `n_finalize` a `documentTemplateSlug` resolved the same way the summary nodes resolve theirs, and a `['n_trigger','out','n_finalize','context']` edge so the clinical trigger context (visit type, department, language) reaches it. Both summary nodes already have the latter (`:241-242`) | `packages/database/src/prisma/db_main/seed/28-workflow-library.ts:169-173`, `:227-247`; regenerate `29-arcaai-agents-and-workflows.generated.ts` |
| N-2 | Make the finalize prompt carry the heading list as **data**, not as the sentence *"keeps the document template headings exactly as they appear in the partial summaries"* (`25-agents.ts:308`). The compiled shape already produces `compiled.sectionKeys` and `compiled.checklist` (`27-document-template-library.ts:533`, `:494-526`) | `packages/database/src/prisma/db_main/seed/25-agents.ts:307-313`, harness prompt scope |
| N-3 | Strengthen `core.output`'s schema so a shapeless note cannot publish: `case_note` gets a `minLength`, and `redactions` returns to `required` to match the agent's own schema (`25-agents.ts:319`) | `28-workflow-library.ts:203-210` |
| N-4 | Validate the agent's declared `outputSchema` post-hoc on the interpreter lane, instead of using it only as a wire hint (`core.py:1410-1416`, `:1449-1455`) | `apps/harness/src/harness/temporal/interpreter/nodes/core.py` |
| N-5 | Make the DNA-context silence audible. Each of the four silent `return {}` branches in `resolveHandoffDnaContext` logs at INFO with a named reason (`no_doctor`, `unwired`, `gates_off`, `no_report`, `style_disabled`). This is the change that would have told us *which* one fired | `live-documentation.service.ts:5905-5945` |
| N-6 | **A parity test between the two corpora.** For every ArcaAI department × visit type, assert that each document-template section key maps to a heading in the served `PromptTemplate` body, or is on an explicit, reviewed exception list carrying a reason. This is the missing enforcement; `arcaai-department-document-templates.task932.test.ts:93-117` never compares the two | `packages/database/src/prisma/db_main/seed/__tests__/arcaai-department-document-templates.task932.test.ts` |
| N-7 | Reconcile BREN's 12 against the corpus's 14 — **content, and the owner's call** (Q-2). The three measured obstacles at `27-document-template-library.ts:53-66` are about lifting the *bodies*; they do not block adding *headings* | `27-document-template-library.ts:998-1043` and the ten sibling entries |

#### Lane N — TDD list (RED first)

1. A finalize run on the BREN new-visit graph receives the frozen document template's section keys in
   its prompt scope; assert the outgoing generation body contains them. *(`apps/harness`)*
2. `n_finalize` resolves `trigger.context.visit_type` and `current_department` — today it resolves
   neither, because it has no `context` edge.
3. `core.output` **rejects** `{"case_note": ""}` and `{"case_note": "<40 chars>"}`, and rejects a
   payload with no `redactions`.
4. The agent's declared `outputSchema` is enforced after parse: a response missing `redactions` fails
   the node rather than publishing.
5. Parity: BREN new-visit's 12 section keys all map to a v3 heading or to a listed exception; the test
   fails loudly when a department shape and its prompt drift. Run it for all 22 shapes.
6. `resolveHandoffDnaContext` emits a named reason on each empty return; a doctor with a seeded report
   and both gates on yields `dna_style_id`.
7. Regression: a BREN new-visit finalize with a healthy live document produces a note whose headings
   are the template's, in order — the assertion `25-agents.ts:308` currently only asks for in prose.

### 3.3 Follow-up (not this ticket) — D5

Append to the TASK-946 §7 residual-script item, or open a new decode ticket:

* the mixed-script threshold at `inference.py:337-355` / `language_modes.py:272-280` lets a
  majority-Latin final carry Malayalam forward as decoder context — **platform code**;
* the tripwire reports only `latin_ratio == 0.0`, so the observed rate (4 of 40 utterances flagged)
  understates the real bleed;
* whether ArcaAI should run a single-language `en` model rather than the `ml-en` code-switch
  fine-tune for English-declared sessions, and whether `ASR_INSTRUCTION.initialPrompt`
  (`25-agents.ts:201`) should stop naming Malayalam on an `en`-pinned session — **tenant content**;
* `pipeline/spec.py:522-543` maps `ml-en` → pinned `ml` on the **batch** path while streaming pins
  nothing (`language_modes.py:456-473`). Not this incident, but a live divergence worth closing.

### 3.4 Verification criteria

- [ ] A second `open` after a `CLOSED_INCOMPLETE` on the same key returns a **new** consultation with
      `isNew: true` and a dispatched workflow run; `recording/start` on the old one 409s.
- [ ] A poller on `summary/latest` learns within one interval that the consultation is terminal.
- [ ] A BREN new-visit finalize produces a note whose headings are the department's, in order, and
      whose `structuredData.dnaStyleId` is `73000000-0000-0000-0001-000000000007`.
- [ ] `core.output` on a degraded finalizer names `n_finalize` and its reason.
- [ ] The parity test is green for all 22 ArcaAI shapes, or red with a reviewed exception list.
- [ ] Gates: `pnpm --filter @arcaai/applications test`, `pnpm api:build`, `pnpm test:unit`,
      `apps/harness` pytest + ruff + mypy, seed tests — output pasted into §4.

---

## 4. Implementation Summary

*(Empty — nothing is implemented. This section is filled per lane after the owner approves §3.)*

---

## 5. Open Questions for the Owner

| Id | Question | Why it blocks |
|---|---|---|
| ~~**Q-1**~~ | **SETTLED — see §2.8.** The Temporal histories of both runs were captured before the stack went down. `n_summary_new` was never scheduled durably; the DEGRADED node was `n_finalize`, bound to `{"in": ""}`. | No longer blocks. No sixth defect; Lane L's shape stands |
| **Q-2** | Should BREN's live note shape grow to the corpus's 14 headings (adding Patient Demographics, Risk Factors & Exposures, Personal & Reproductive History, History of Illness, Treatment History, Patient Education & Consent), or is the 12-heading reduction a clinical decision you want kept? | N-7 is content, not code. The three obstacles recorded at `27-document-template-library.ts:53-66` are about lifting the prompt *bodies*; they do not block adding headings. Either answer is implementable — but only you can give it |
| **Q-3** | Is a same-day revisit after a `CLOSED_INCOMPLETE` supposed to **create a new consultation** (L-2's proposal, which `consultation.prisma:62` already permits) or to **refuse** with a 409 pointing at `POST :id/reopen`? | The two are equally consistent with everything written down. `reopen` is the sanctioned recovery path, but it needs a caller who knows to use it, and the ALaaS broker today does not look at `isNew` at all |
| **Q-4** | When the live lane produces nothing, should the durable lane emit a **transcript-only note** (marked as such, unsigned) rather than failing the run? | This is D3(a)'s other half. It is an option this plan deliberately leaves out because it changes what a clinician is handed. `CLOSED_INCOMPLETE` today is honest; a transcript-only note might be more useful, or might be worse |
| **Q-5** | For the DNA null: can you check, in the dev DB, whether a `DnaWritingStyleReport` exists for the consultation's `doctorId`, and whether `resolveEffectiveDnaStyleEnabled` is on for `(ArcaAI, BREN, that doctor)`? | Four code paths produce the null and **all four are silent** (`live-documentation.service.ts:5907`, `:5919`, `:5921`, `:5926`). N-5 makes it observable going forward, but only a DB read settles what happened on 2026-09-11 |
| **Q-6** | Was the dev DB reset or re-seeded between TASK-946's BREN verification (2026-09-10 ~14:30Z, which produced a **sectioned** 506-char note in DNA style `…-0007`) and this run (18:57Z)? | Something changed in that window. Candidates from `git log`: `c56b54e99 fix(TASK-949): wire the settings cascade into WorkflowExposureServiceModule` (17:14Z) and the TASK-948 SDK 3.2.0 release (15:26Z). TASK-950's lanes landed **after** the run (02:03–02:30 local, 19:03–19:30Z) so they cannot have caused it — but lane D changes the `open` path this ticket's Lane L rewrites, so Lane L must rebase on it. **I could not establish causation for the DNA regression** and will not guess |
| **Q-7** | Do you want D5 appended to TASK-946 §7, or opened as its own ticket alongside the TASK-934/935/937/938 decode line? | Purely a bookkeeping call, but it decides where the mixed-script threshold finding lands |

### What I could not determine

Stated plainly rather than guessed:

* **Which of four silent branches produced the DNA null** (Q-5). All four return `{}` with no log.
  §2.8 eliminates the disabled-in-config branch; three remain.
* **What regressed between TASK-946's green BREN verification and this run** (Q-6).
* **The 764-character `RAW_SUMMARY` length, the verbatim note opening, and the "brain tumors"
  assertion** are owner-supplied. The API does not log response bodies, and the persisted note is not
  in any log file. Everything else in §2 is from the logs or from code.
* **Whether the six dropped BREN headings were a per-department clinical decision or a side effect of
  reusing the General Medicine base.** The seed comments assert the former
  (`27-document-template-library.ts:749-752`); nothing enforces it, and no ticket ratifies BREN's
  12-vs-14 gap specifically.
* **Whether any provider ever resolves the prompt-vs-template conflict in the prompt's favour.**
  `stablePrefixFor`'s docblock says *"which one wins depends on the provider"*
  (`live-documentation.service.ts:4500-4504`); no test or trial log measures it, and this run's
  section patches used template keys only.

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-11 | Ticket opened from the live end-to-end run of the ALaaS v3 scribe against the local HOPE dev stack (consultations `01a08c97-4d3d` / `01a08ca7-62bb`). Five defects recorded, ranked, and split into two lanes plus one follow-up; every claim traced to `path:line` or to a log line with a timestamp. Eight points where the reporting framing did not survive the evidence are recorded in §2.7 rather than silently corrected — most consequentially: the redundant stop is a **409**, not a 500; the DEGRADED "nothing bound" almost certainly came from `n_finalize`, not `n_summary_new`; `departmentId` is not in the `open` reuse key; the live lane picking the document template is correct **by design**; and the STT language mode **is** honoured end to end (`stt.log:1209`), so D5 is tenant model/prompt tuning plus one narrow mixed-script threshold gap. Status `Pending` — no code until the owner answers Q-1…Q-7 and approves §3. |
| 2026-09-11 | **Q-1 settled and §2.8 added** by the orchestrator, from Temporal histories captured while the stack was still up. `n_summary_new` is never scheduled on the durable lane; the DEGRADED node is `n_finalize`, bound to `{"in": ""}` on the failed run and to the live document's **flattened prose** on the successful one — which is D2's root cause stated mechanically, and which re-frames N-1/N-2 around giving the finalizer the structured document rather than the rendered string. `dna.enabled` is `true` in `n_finalize`'s config on both runs, eliminating one of Q-5's four silent branches. §2.7 #2 promoted from "almost certainly" to CONFIRMED; no sixth defect. |
