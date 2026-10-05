# P-E plan — summarization completeness, ledger/recap producers, run record, deployment

Planner: opus (read-only), 2026-10-05. Consolidated into README §6; this file is the planner's record. Orchestrator additions are marked **[orch]**.

## Two shaping decisions

- **Governed ArcaAI lane: no graph change, no new node type.** The existing live-handoff read (`readLiveHandoff`) keeps its `text` and adds a `note_plan_ref` per summary-node output; the finalizer node's activity fetches and executes the plan. Activity code only → Temporal replay unaffected, **no drain**.
- **Plan in apps/api, execute in the harness.** apps/api composes the input + budget plan (one implementation, so the Prompt Inspector shows exactly what is sent); the harness executes it on both the default `harness-doc` engine and the governed lane via one shared Python module.

## 1. Contracts

### 1a. `FACT_LEDGER` item (encrypted JSON; type/storage owned by P-AB)

```json
{ "schema":"hope.fact_ledger.v1", "consultationId":"…", "encounterSeq":1,
  "builtFrom":{"segments":[{"id":"<segItemId>","v":3}],"digest":"sha256:<sorted id:v>"},
  "agent":{"slug":"fact-ledger-extraction","version":1}, "model":"gemma-4-e2b-it-qat", "createdAt":"…",
  "facts":[{ "id":"f1-007", "key":"med:metformin",
    "kind":"complaint|history|medication|dose_change|allergy|vital|exam|result|diagnosis|plan|order|follow_up|red_flag|negation|other",
    "statement":"…", "critical":true, "values":[{"value":"500","unit":"mg","text":"500 mg"}],
    "citations":["<segItemId>"], "status":"active|superseded|negated",
    "supersedes":["f1-003"], "supersededBy":null }],
  "stats":{"segmentCount":0,"factCount":0,"criticalCount":0,"droppedUncited":0} }
```

- Model cites rendered labels (`E1·S012`); producer maps to segment item ids at current version; unresolvable → dropped, counted in `droppedUncited`.
- `critical` set by code: medication, dose_change, allergy, diagnosis, plan, order, follow_up, red_flag, abnormal result.
- Supersession: within an encounter a later fact with the same `key` supersedes; E2 reads E1's ledger and records `supersedes` against E1 fact ids (latest encounter wins); E1's item is never rewritten.
- Cache: rebuilt only when `digest` changes; each rebuild = new `ContextItemVersion`; plain `metaData` `{schema, encounterSeq, digest, agentVersion, factCount, criticalCount}` (no PHI).
- `ENCOUNTER_RECAP`: pure template from the ledger, no model call; headings Complaint, Key findings, Medications, Plan/Orders, Pending; active facts verbatim; records `{schema:"hope.encounter_recap.v1", ledgerItemId, ledgerVersion}`; display-only.

### 1b. NotePlan (TS + Pydantic mirrors pinned by `tests/contracts/note-plan.fixture.json`)

```ts
interface NotePlanV1 { schema:'hope.note_plan.v1'; planId; consultationId; tenantId; inputDigest;
  model:{slug; wireModelId; provider; contextWindow};            // from AiModel row; missing => fail closed
  tokenizer:{mode:'exact'|'estimate'; id};
  mode:'single_pass'|'ledger_prior'|'section_groups'|'ledger_prior+section_groups';
  reductions:{kind:'prior_encounter_to_ledger'; encounterSeq; tokensBefore; tokensAfter}[];
  sources:{encounters:{seq;visitType;segmentCount;ledgerItemId?;ledgerVersion?;rendered:'verbatim'|'ledger_cited'}[];
           results:{contextItemId;version}[]; draft?:{contextItemId;version;clinicianSections:string[];aiSections:string[]};
           preSummary?:{contextItemId;version}};
  system?: string;                       // harness-doc lane only; governed lane composes from the agent
  blocks:{key:string; label:string; content:string; tokens:number}[];   // FIXED ORDER
  sections:{key;title}[];                // template order
  calls:{callId; sectionKeys:string[]; directive:string; maxTokens; promptTokens}[];  // ≤ 10
  coverage:{criticalFacts:{factId;encounterSeq;key;kind;anchors:string[];values:{value;unit}[];citations:string[]}[];
            segmentIndex:Record<string,{id:string;v:number}>} }
```

- Fixed block order (stable prefix for KV reuse): `pre_summary` → `encounter_1` (verbatim or ledger + cited segments) → `ledger_1` → `results` → `encounter_2` → `ledger_2` → … → `draft_clinician` → `draft_ai` → per-call `directive` last.
- Transcript lines from `TRANSCRIPT_SEGMENT` items of every encounter at latest version: `[E2·S014 · 12:03 · Doctor]`.
- Draft split: latest note vs latest AI version heading by heading — differing → `draft_clinician`, identical → `draft_ai`.
- Recap never an input: hard exclusion list (`ENCOUNTER_RECAP`) + canary test.
- Removed: `preSummaryText` from `LIVE_SOAP_SNAPSHOT`, handoff section text as an input.
- Delivery: Redis `note-plan:{planId}` (2 h TTL); harness receives `{planId, mode, promptTokens, callCount}` via `GET internal/consultations/:id/note-plans/:planId`; cache miss → recompose and record.
- **[orch] D-24:** uploaded-audio transcripts (`TRANSCRIPT` items with `metaData.origin='attachment_audio'`) enter as a cited block `attachment_audio` placed after `results` (same position rules as results; cited by attachment id).

### 1c. Budget rule (`note-budget-planner.ts`, pure)

Count every message (system + blocks + directive + 32 tokens chat overhead); `reserve(call) = max(1024, sections×perSection + overhead)`; single pass iff inputs ≤ `ratio × window` AND `prompt + reserve + safety ≤ window`; else every encounter before the last → ledger + cited segments (last verbatim), recorded in `reductions`; if total reserve > `maxCallOutputTokens` → G contiguous section groups (G ≤ 10) in parallel with the same prefix + group directive; else fail closed (`processing=failed`, `NOTE_INPUT_EXCEEDS_CONTEXT`, non-retryable). The 20 000 / 15 000 / 6 000 cuts are deleted (constants + call sites).

### 1d. CoverageResultV1 (harness, before persist)

```ts
{ schema:'hope.note_coverage.v1'; status:'complete'|'gaps'|'unchecked'; repairPasses:0|1;
  criticalFacts:{total;present;missing:string[]}; numbers:{total;matched;unsupported:number};
  citations:{total;resolved;unresolved:string[]}; groundedness?:{score;passed};
  gaps:{kind:'missing_fact'|'number_mismatch'|'unresolved_citation'|'ungrounded'|'ledger_unavailable';
        factId?;sectionKey?;segmentIds?;detail:string /* encrypted at rest */}[] }
```

Deterministic: each active critical fact present (anchors + values with units); each number+unit in a section matches a cited segment/result; each citation resolves. Finalizer output `{case_note, redactions, sources:[{sectionKey, refs:["E1·S012","result:<id>"]}]}` — `case_note` unchanged (Copy to EMR unaffected). One repair call regenerates only gap sections; remaining gaps → persistDraft → `processing=awaiting_review` (count plain, details encrypted). Groundedness sensor still runs (harness-doc via `run_inferential_sensors`; governed lane inside the activity).

### 1e. Settings (`consultation-note-composition.descriptors.ts`, global-kv, system-only, open-to-default)

`consultation.note.budget.singlePassRatio` 0.6 · `…budget.safetyTokens` 512 · `…budget.outputTokensPerSection` 384 · `…budget.outputOverheadTokens` 256 · `…budget.maxCallOutputTokens` 6144 · `…budget.maxSectionGroups` 10 (hard max) · `…coverage.repairPasses` 1 (0–1) · `…ledger.waitSeconds` 120 · `…tokenizer.allowEstimate` true. Estimate = `ceil(utf8Bytes/2)` (over-counts only; recorded `tokenizer.mode=estimate`). Context window is never a setting (AiModel row; fail closed if undeclared).

**[orch] D-23:** estimate allowed as the fallback (conservative, recorded); E1 must try the exact tokenizer first.

### 1f. Run-record stats keys on every `LLM_CALL` trajectory step

`activity_kind, encounter_seq, agent_slug, agent_version, workflow_slug, workflow_version, context_window, max_tokens, budget_mode, call_index, call_count, plan_id`.

### 1g. Prisma (for the single DB lane)

```prisma
enum AiActivityKind { TRANSCRIBE_STREAM TRANSCRIBE_BATCH NER LIVE_SUMMARY PRE_SUMMARY FACT_LEDGER NOTE_GENERATE NOTE_SECTION_GROUP NOTE_REPAIR SENSOR ATTACHMENT_EXTRACT  @@schema("core") }
enum AiActivityRunStatus { OK ERROR DEGRADED TIMEOUT SKIPPED  @@schema("core") }

/// Durable per-AI-activity run record (TASK-1045 §3.2). Ids/enums/numbers only — NO free text.
/// Append-only: MODELS_WITHOUT_SOFT_DELETE + TENANT_SCOPED_MODELS; not pruned with AgentTrajectoryStep.
model AiActivityRun {
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))
  tenantId String
  runKey   String @unique // "<producer>:<sessionId>:<runId>:<seq>" — idempotent upsert
  consultationId String?
  encounterSeq   Int?
  activityKind   AiActivityKind
  status         AiActivityRunStatus
  workflowSlug    String?
  workflowVersion Int?
  workflowRunId   String?
  nodeId          String?
  agentId         String?
  agentSlug       String?
  agentVersion    Int?
  promptTemplateId String?
  promptVersion    Int?
  model      String?
  provider   String?
  deployment AiDeploymentKind?
  startedAt  DateTime
  endedAt    DateTime?
  durationMs Int?
  inputTokens       Int?
  outputTokens      Int?
  contextTokensUsed Int?
  contextWindow     Int?
  outputCap         Int?
  stopReason        String?
  budgetMode        String?
  callIndex         Int?
  callCount         Int?
  costMicros     BigInt?
  costBasis      AiCostBasis?
  usageRequestId String?
  errorCode      String?
  contextItemId       String?
  outputVersionNumber Int?
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([tenantId, consultationId, startedAt], name: "AiActivityRun_tenant_consultation_started_idx")
  @@index([tenantId, workflowRunId], name: "AiActivityRun_tenant_workflowRun_idx")
  @@index([contextItemId], name: "AiActivityRun_contextItem_idx")
  @@schema("core")
}
// SummaryMeta additions
  coverageStatus          String?  // complete|gaps|unchecked
  coverageGapCount        Int?
  encryptedCoverageReport Bytes?   // CoverageResultV1, Transit
  budgetMode              String?
  notePlanInputDigest     String?
```

Ledger needs no table (FACT_LEDGER items). `GoldenCase` unchanged — multi-encounter case = JSON envelope in existing `encryptedTranscript` / `encryptedReferenceNote`, `metaData.caseShape='multi_encounter_v1'`.

**[orch]** P-D's `RunSummary`/`ActivityRunRecord` DTOs map from `AiActivityRun` (`outputVersionNumber` → `versionNumber`, `contextTokensUsed` → `contextUsed`, `inputTokens/outputTokens` → `tokensIn/tokensOut`). P-CG's `IActivityRunRecordReader.findProducerOf(...)` is added to lane E2 (`ai-activity-run.service.ts`).

Dependencies on P-AB: item types `TRANSCRIPT_SEGMENT`, `FACT_LEDGER`, `ENCOUNTER_RECAP`; reads `findSegmentsLatest(consultationId)` + `ConsultationEncounter`; versioned item write; event `EncounterStopped {consultationId, tenantId, encounterSeq}` after the final transcript; `transition(consultationId, processing, {reason?, gapCount?})`.

## 2. Lanes (none runs package-wide suites or replay-compat)

| Id | Tier | Wave | Depends | Files (C/M) | RED→GREEN test | Done |
|---|---|---|---|---|---|---|
| E1 tokenize | opus | 1 | — | C `apps/text/src/text/api/endpoints/tokenize.py`, `apps/text/src/text/services/tokenizer_registry.py`; M `providers/base.py` (`count_tokens`), `providers/lmstudio.py`, `api/endpoints/__init__.py`, `apps/text/pyproject.toml` (`tokenizers`; orchestrator runs `uv lock`) | `apps/text/src/text/tests/unit/test_tokenize_task1045.py` | `POST /api/v1/tokenize {provider, model, texts[]}` → `{counts[], mode, tokenizerId}`; LM Studio tokenizer if reachable, else HF `tokenizers` with sha-pinned Gemma `tokenizer.json`, else 501 `TOKENIZER_UNAVAILABLE` |
| E2 run record | opus | 1 (after DB) | DB | C `packages/domains/src/…/aiActivityRun/{entity,factory,repository}.ts`, `packages/applications/src/services/ai-activity-run/{IAiActivityRunService.ts,ai-activity-run.service.ts,.module.ts,activity-run.mapper.ts,index.ts}` (**[orch]** + `findProducerOf` reader for P-CG); M `agent-trajectory/agent-trajectory.service.ts` + module, `stt/internal/sttInternal.service.ts`, `stt/streaming/streamingSession.service.ts`, `consultation/summary/text-usage.ts` | `ai-activity-run/__tests__/activity-run.mapper.task1045.test.ts` | one LLM_CALL/NODE step → one record (idempotent `runKey`); STT one per session; sync summaries one per call; no free text |
| E3 composer | opus (high) | 2 | P-AB reads; E1 contract | C `consultation/note-composition/{note-plan.types.ts,note-input-composer.service.ts,note-budget-planner.ts,draft-split.ts,labelled-transcript.renderer.ts,text-token-count.client.ts,note-composition.service.module.ts,index.ts}`, `settings-registry/descriptors/consultation-note-composition.descriptors.ts`, `tests/contracts/note-plan.fixture.json`; M `harness-internal.service.ts` (`buildAssembleParams`, `assemble`, `previewAssembly`; remove live snapshot, constant at 249, `truncateAttachmentText`), `harness/dto/harness-internal.dto.ts` (`notePlanRef`), `harness/prior-visit-summary.ts`, `harness/same-day-prequel.ts`, `prompt/prompt-assembly.service.ts:1010`, `apps/api/src/modules/consultation/harness-internal.controller.ts` (note-plans GET) | `note-composition/__tests__/note-budget-planner.task1045.test.ts`, `…/note-input-composer.task1045.test.ts` | all budget branches incl. fail-closed; DB-free `composeFromSnapshot()` for E8 |
| E4 ledger + recap | opus | 2 | P-AB items + event | C `consultation/fact-ledger/{fact-ledger.schema.ts,fact-ledger.service.ts,fact-ledger.processor.ts,fact-ledger.listener.ts,fact-ledger-supersession.ts,encounter-recap.renderer.ts,fact-ledger.module.ts,index.ts}`; M `packages/domains/src/enums/JobQueue.enum.ts` (`BuildFactLedger`) | `fact-ledger/__tests__/fact-ledger.task1045.test.ts` | `EncounterStopped` → BullMQ (`ledger:{cid}:{seq}:{digest}`) → agent via `AgentInvocationService` (JSON schema) → validated ledger → recap; FACT_LEDGER run record |
| E5 harness executor | opus (high) | 3 | E3 fixture | C `apps/harness/src/harness/services/note_plan/{__init__,models,executor,merge,coverage}.py`; M `temporal/activities.py` (`execute_note_plan` + stats), `temporal/models.py` (optional `note_plan_ref`, `coverage`), `temporal/workflows.py` (`workflow.patched("task-1045-note-plan")` around `generate` ~881), `temporal/worker.py`, `interpreter/nodes/core.py` (prefer `note_plan_ref`), `services/api_client.py` | `tests/unit/note_plan/test_executor_task1045.py`, `test_coverage_task1045.py` | parallel groups via `asyncio.gather`; merge in template order; one repair; seq offsets governed NODE 0, groups 1–10, repair 11, failed 12–15 (pinned); hermetic |
| E6 governed + persist | opus | 3 (after E3 + P-AB) | E3, P-AB | M `live-documentation/live-documentation.service.ts` (`readLiveHandoff` keeps `text`, adds `note_plan_ref`; live-lane run-record hook), `harness-internal.service.ts` (`persistDraft`: coverage → SummaryMeta + `transition`) | `harness/__tests__/persist-draft-coverage.task1045.test.ts` | gaps → `awaiting_review` + count; failure → `failed` + reason |
| E7 seeds + deployment | sonnet | 1 | — | M `seed/25-agents.ts` (transcript-based finalizer prompt, `sources` in output schema, new `fact-ledger-extraction` agent T 0), `seed/29-arcaai-agents-and-workflows.ts`, `seed/ai-models/llm.ts` (32768, `kvCacheQuant {k:'q4_0', v:'q4_0'}`, `flashAttention: true`), TASK-1020/1022/1034/1001 finalizer seed tests; C `docs/implementation/TASK-1045-*/rollout.mjs`; deployment repo `deployment/k8s/base/lmstudio.yaml` (`LMS_CONTEXT` 32768, `LMS_PRELOAD_PLAN` gemma 32768/q4_0/q4_0), local commit only | `seed/__tests__/task-1045-note-agents.test.ts` | all seeded LLM agents T 0; `rollout.mjs` (`DRY_RUN=1`): republish finalizers (ArcaAI, Global, SYSTEM), create ledger agents, list + republish any T≠0 agent, PATCH Gemma serving profile + declared context |
| E8 golden set + evalGate | opus | 4 | E3, E5 | C `apps/harness/src/harness/eval/note_completeness/{metrics.py,runner.py}`, `eval/golden/fixtures/multi_encounter_v1.json` (synthetic, ≥12 cases); M `eval/eval-run.service.ts` (mode `note_completeness`), harness eval endpoint, `settings-registry/descriptors/agentic-eval.descriptors.ts` | `apps/harness/src/harness/tests/unit/eval/test_note_completeness_task1045.py` | critical recall 1.0, dose accuracy 1.0, unsupported ≤ 0.02, p95 stop→note; finalizer `evalGate` via `rollout.mjs` |

Live data: published agent params cannot be UPDATEd → new versions via the admin API (TASK-1022 `rollout.mjs` recipe); SYSTEM needs a super admin.

**[orch] D-22 section regenerate:** the plan's `calls[]` already scope sections, so `generateSummary({sectionKeys?: string[]})` composes a plan whose calls cover only those sections (same prefix, same coverage check limited to them) and persists a new note version with the other sections carried from the latest version. Lane E3 (composer accepts `sectionKeys`) + E5 (executor merges into the latest version). ALaaS W12 uses it.

## 3. Shared files

`harness-internal.service.ts` → P-AB first, then E3, then E6 (sequential). `live-documentation.service.ts` → E6 after P-AB. `consultation-event.handler.ts` → P-AB (resume read failure → `PipelineStepFailed` + `transition('failed','RESUME_READ_FAILED')`, never `null`). `registry.ts`, `JobQueue.enum.ts`, domains barrel, allow-lists, `uv.lock` → orchestrator at merge. Seeds `25-*`, `29-*` → E7. `temporal/models.py`, `activities.py` → E5.

## 4. Risks

1. Replay/drain: harness-doc behind `workflow.patched` + new activity; governed = activity code only, vocabulary unchanged → no drain; E6 keeps the old `text` for old workers (verify the old renderer ignores the extra key); deploy harness worker before API; quiet hours on dev.
2. Sequence stride 16 caps groups at 10 (test-pinned).
3. KV q4_0 at 32k on a 2B model: golden-set A/B (f16 vs q4_0) before cluster rollout; revert = PATCH row to q8_0 + pod restart; live lane ~12.2k prompt + 8192 output floor fits; prefix KV reused per slot only.
4. Declared vs served window: lower the row's declaration with or before the served value; pod reads its plan from hope-api (`LMS_PRELOAD_PLAN` fallback); deployment commit stays local (Q-2).
5. Republishing live agents via `rollout.mjs` with dry run; lists any T≠0.
6. Tokenizer availability (D-23).
7. Ledger recall bounds coverage (measured in E8; groundedness still runs); E2 ledger on the critical path after Stop, bounded wait → `unchecked` gap.
8. PHI: run records + metaData ids/numbers only; coverage details encrypted; plans in Redis 2 h like the handoff.
