# Breast & Endocrine (BREN) Consultation — End-to-End Workflow

> **Audience**: Tech leads and platform engineers. One document tracing the full
> chain from a BREN (Breast & Endocrine) doctor clicking "start consultation" in
> the client software through to the signed case note — the workflow that runs,
> every API in call order, the exact data each API carries, where every piece of
> configuration lives, and how the whole thing degrades when something is down.
>
> **Source of truth**: code + seed data verified against
> `project-hope/apps/{api,harness,stt,nlp,text,guardrail,tts}`, the
> `arcaai-bren-consultation` compiled workflow
> (`packages/database/src/prisma/db_main/seed/29-arcaai-agents-and-workflows.generated.ts`)
> and the codewalk in this folder (`vox.md` + per-service docs + 50 Archify
> sequence diagrams in `diagrams/`).
> **Note**: BREN appears as `department_code: "BREN"` in the encounter payload and
> `style_DNA_doctor_department_breast_endocrine` in the DNA slot. The seeded
> workflow slug is `arcaai-bren-consultation` (lower-case "bren").
>
> Two engines can document a consultation (substrate exclusivity):
> - **Substrate A** — the durable `HarnessDocWorkflow` (Temporal) started through
>   `document:start`. Runs when **no tenant-authored workflow governs** the
>   consultation.
> - **Substrate B** — the graph **interpreter** (`core.*` nodes) that executes the
>   published `arcaai-bren-consultation` compiled config. Runs when the department
>   / tenant assignment dispatches it **at `open`**, and marks the consultation so
>   Substrate A stands down.
>
> This document walks **both** paths because the same doctor click can land on
> either one (Appendix A shows how to tell which). The graph workflow is the
> BREN-specific contract; Substrate A is the platform-default loop that runs when
> no BREN graph is assigned.

---

## 1. System map and dependencies

```
┌─────────────────────────────┐
│  Client software            │  Admin Console (Next.js) / @arcaai/vox SDK
│  (doctor initiates)         │  → BFF proxy → API Gateway
└──────────────┬──────────────┘
               │ HTTPS / WSS / SSE
┌──────────────▼──────────────┐
│  API Gateway  apps/api      │  Auth (JWE cookie), RBAC, scopes, tenants,
│  (system-of-record)         │  consultations, summaries, MSB/MCP, streaming WS,
│                             │  service-account bridge to internal services
└──────┬──────────┬───────────┘
       │X-Service-Token + X-Tenant-Id (internal /api/v1/internal/*)
┌──────▼──────────┐ ┌─────────▼──────────┐ ┌─────────▼──────────┐
│ apps/harness    │ │ apps/stt           │ │ apps/nlp           │
│ Temporal        │ │ streaming WS +     │ │ GLiNER / classifier │
│ orchestration   │ │ internal session   │ │ guard endpoints    │
│ interpreter     │ │ API + Redis        │ │ model cache        │
└──────┬──────────┘ └────────────────────┘ └─────────┬──────────┘
       │                                            │
┌──────▼──────────┐ ┌─────────▼──────────┐ ┌────────▼──────────┐
│ apps/text       │ │ apps/guardrail     │ │ apps/tts          │
│ LLM text gen    │ │ safety/medical/    │ │ (TTS used later,  │
│ (providers)     │ │ PII/groundedness   │ │ optional in BREN) │
└─────────────────┘ └────────────────────┘ └───────────────────┘
```

**State / infra stores**

| Store | What it holds | Services |
|---|---|---|
| PostgreSQL `db_main` | Consultations, users/doctors, departments, ContextItems, SummaryMeta, NamedEntity, agents, AI models, routing policies, provider connections, workflow definitions, assignments, DNA writing styles, document templates, guardrail taxonomy, WORM audits | apps/api, apps/harness (via activity), apps/text, apps/guardrail, apps/stt |
| Temporal | Durable workflows (`HarnessDocWorkflow`, `ConsultationLoopWorkflow`, interpreter runs) + search-attribute `HarnessTenantId` | apps/harness |
| Redis | STT audio/result streams (`stt:audio:*`, `stt:result:*`), drag/handoff, live-summary pub/sub (`consultation:live-summary:{id}`), progress/assurance feeds | apps/api, apps/stt, apps/harness (activities) |
| S3/MinIO | Claim-check objects (offloaded large prompt/note refs), compiled-config refs, audio blobs | apps/api, apps/harness |
| Qdrant | Knowledge base embeddings (institutional RAG chunks) | apps/harness (retrieve_context) |

**Hard dependencies at runtime**: API Gateway must reach Harness (Temporal),
Text, NLP, Guardrail, STT and the DB. The **workflow cannot degrade text
failures** (a failed generate never silently downgrades — no draft is
persisted); NLP/guardrail/RAG degrade to *reduced assurance* (forced human
review, never auto-pass).

---

## 2. Where every configuration lives

All control-plane configuration is **PostgreSQL**, resolved tenant-first. The
platform default (`tenantId` = SYSTEM tenant `50000000-0000-0000-0000-000000000001`)
sits below a tenant's override; a tenant override beats SYSTEM; a department /
doctor-scope override beats the tenant tier where one exists.

| # | Config | Storage (prisma `db_main`) | Service exposing it | Resolution order |
|---|---|---|---|---|
| C1 | **Agents** (task, params, fallback chain, `guards.enabled`, DNA/redaction flags) | `Agent` / `AgentModelFallback` (slug `arcaai-bren-summary-new-visit`, `arcaai-bren-summary-revisit`, `case-notes-pre-summary`, `medical-ner`, `realtime-transcription`, `casenote-finalization`) | AgentService (`packages/applications/.../agent/`) | Tenant → SYSTEM |
| C2 | **AI models** (provider, task-capable models) | `AiModel` | AiModelService | Tenant → SYSTEM |
| C3 | **Routing policies** (task-keyed chains, predicates, fallback, funding) | `AiRoutingPolicy` | AiRoutingPolicyService | Tenant → SYSTEM (tenant vetoes) |
| C4 | **Provider connections** (BYO keys, endpoints) | `AiProviderConnection` (keys encrypted) | AiProviderConnectionService | Tenant BYO → SYSTEM |
| C5 | **Workflow definitions** (published compiled graphs) | `WorkflowDefinition` — `slug: arcaai-bren-consultation`, `versionNumber 1`, compiled stages/nodes | WorkflowDefinitionService | Tenant authored; published/active only |
| C6 | **Workflow assignments** per department/tenant | `WorkflowAssignment` (palette `core`, selector tags `visit-type:new-visit` / `visit-type:revisit`) | IWorkflowAssignmentService | Department → Tenant (no SYSTEM) |
| C7 | **DNA writing styles** (prompt slot + versions) | `DnaWritingStyleReport` / `DnaWritingStyleVersion` — slot `style_DNA_doctor_department_breast_endocrine` | DnaWritingStyleService | Doctor's report → department default → none |
| C8 | **Document templates** (SOAP) | `DocumentTemplate` — `arcaai-bren-soap-new-visit`, `arcaai-bren-soap-revisit` | DocumentTemplateService | Tenant → SYSTEM |
| C9 | **Context schema** (trigger `resolved` schema, `followsLatest`) | `ContextSchema` + pin — schema id `79000000-...-21` / version id `89000000-...-21` | EffectiveTriggerSchemaService | Authored schema → tenant pin |
| C10 | **Guardrail posture** | `AiRoutingPolicy` (guardrail task) + effective-config (apps/api control plane) | TextRequestEnrichment / GuardrailAvailability | Decision cascade (below) |
| C11 | **Effective policy for the harness loop** (`max_regen`, gate SLA/escalation, sensor thresholds, `phi_enabled`, `text_provider/model`, judge, retrieval/ner/atomic-fact toggles, MCP) | Db/API served as `HarnessPolicy` per tenant + **department default agent's `harnessOverrides`** | apps/api consultaion → `fetch_policy` activity | Policy overlay → code defaults |

**Guardrail decision cascade** (compiled in `workflow-contract/src/guardrail-optout.ts`):
`node config.guardrail.enabled` → `workflow policyBindings.guardrail.enabled` → `agent.parameters.guards.enabled` → `default = enabled`. Platform kill-switch `text.externalGuardrail.enabled` (control plane key) can disable screening globally; disposition: `screened | opted_out | platform_off`.

**DNA writing-style toggles** are stored per doctor (doctor-scope), inherited from department default when unset, and the **tenant flag** must also be on before any DNA prompt is injected.

---

## 3. The BREN workflow definition (`arcaai-bren-consultation`)

Compiled config (`compiledConfig`, formatVersion 1, palette `core`, checksum
`e5dc7ffa...`, caps `maxTotalSeconds 3600 / maxNodeSeconds 600 / maxAttempts 5`).
This is what **Substrate B** executes node-by-node via the interpreter.

```
Stage 0  n_trigger        core.trigger     kinds [consultation, api]   guardrail ON
Stage 1  n_asr            core.agent       realtime-transcription      perTurn / realtime
         n_presummary     core.agent       case-notes-pre-summary      onStart / realtime + guardrail ON
Stage 2  n_ner            core.agent       medical-ner                 perTurn / realtime
Stage 3  n_visit          core.condition   visit_type == 'new-visit' → new_visit
                                           visit_type == 'revisit'    → revisit
Stage 4  n_summary_new    core.agent       arcaai-bren-summary-new-visit   template arcaai-bren-soap-new-visit  guardrail ON
         n_summary_revisit core.agent      arcaai-bren-summary-revisit      template arcaai-bren-soap-revisit   guardrail ON
Stage 5  n_finalize       core.agent       casenote-finalization      onEnd / durable + guardrail ON + dna.enabled ON
Stage 6  n_review         core.humanReview clinical_finalization       assignRole DOCTOR timeout 3600s allowEdit
Stage 7  n_output         core.output      protocols [http, http-sse, socket]  outputSchema { case_note, redactions[] }
```

Edges (from the node `inputs`):
- `n_trigger.next → n_asr.after`, `n_trigger.out → n_presummary.context`
- `n_asr.transcript → n_ner.in`
- `n_ner.out → n_visit.in`
- `n_visit.{else,new_visit} → n_summary_new.after` (branchGuards) ·
  `n_visit.revisit → n_summary_revisit.after`
- `n_trigger.out → n_summary_{new,revisit}.context` (shared context)
- `n_presummary.next → n_finalize.after`, `n_summary_*.out → n_finalize.in`
- `n_finalize.out → n_review.in`
- `n_review.next → n_output.after`, `n_finalize.data → n_output.in`

**Trigger context schema** (required on `encounter`: `doctor_id`, `event_id`,
`department_code`, `visit_type`) plus `vitals`, `previous_case_notes`,
`work_note`, `case_note`, `attachment`, and the formatted `context` block
(`current_department`, `language`, `safe_age/dob/gender`, `formatted_previous_visits`,
`formatted_vitals`, `pre_summary_text`, `prior_visit_summary`, `dna_style_text`,
`style_DNA_doctor_department_breast_endocrine`, …). `followsLatest: true` means
the trigger re-binds to the tenant's current schema pin at dispatch.

---

## 4. End-to-end sequence (step by step)

Below, each step lists the **exact client→gateway call**, then the **internal
call chain** and the **data carried**. `internalServiceHeaders` =
`X-Service-Token: <INTERNAL_ACCESS_TOKEN / HARNESS_SERVICE_TOKEN>` +
`X-Tenant-Id` (+ `X-Internal-Tenant-Id` on harness calls / `X-Service-Token`
guard on harness inbound).

### Step 0 — Session & consent

`POST /api/auth/login` → JWE httpOnly cookie (A256GCM). Doctor carries
`roles`, `tenantId`, scopes. Every route below is tenant-scoped via CLS and
RBAC `@Authorize` + scope checks; PHI routes add `verifyConsultationAccess`.

### Step 1 — Open the consultation (Substrate dispatch decision)

```
POST /api/v1/consultations/open
Authorization: Bearer <JWT>        Scope: svc:consultation:session:write
Body (OpenConsultationRequest):
{
  "patientId": "pat_...",
  "departmentId": "dept_bren_...",
  "clinicianUserId": "user_doctor_bren",      // or staff-id identity via context
  "workflowDefinitionSlug": "arcaai-bren-consultation",  // optional; else assignment decides
  "visitType": "new-visit" | "revisit",       // client may state it (TASK-951)
  "context": { ... }                           // validated against trigger schema
}
```
`ConsultationService.getOrCreate` (apps/api `consultation.controller.ts:584`):
1. **Clinician attribution** — `resolveActingClinicianId`; service account must name a clinician; `CLINICIAN_REQUIRED / _MISMATCH / _NOT_ALLOWED` 400s.
2. **Context validation** — payload checked against the governing workflow's effective trigger schema; `CONTEXT_SCHEMA_VIOLATION` 400; also user-identity resolution (auto-provision a user row from staff id if the tenant allows).
3. **Workflow dispatch** — `ConsultationWorkflowDispatchService.dispatchForConsultation`:
   - resolves assignment `IWorkflowAssignmentService.resolve(tenantId, CORE_PALETTE_KEY, departmentId, [`visit-type:<key>`])` → Department tier beats Tenant tier (no SYSTEM);
   - **nothing assigned → Substrate A** (`dispatched:false`); this is the common default;
   - BREN assigned → verifies published+active+selectable, mints a claim-check for the **effective** trigger config (`mintCompiledConfigClaimCheckRef` → S3, resolving `followsLatest` to the tenant's current schema pin), records `WorkflowRun` (`recordRunStarted`, session id `consultation-dispatch:<runId>`), then:
   - `harnessGateway.startWorkflowRun({runId, sessionId, workflowVersionId, tenantId, configRef, subject:{consultationId,userId,externalPatientId}, payload: authoredContext})` **→ Substrate B interpreter starts on Temporal**;
   - `recordGovernance` writes the governing-engine marker into `consultation.metadata` (`workflowRunId`, `workflowDefinitionSlug`) so Substrate A stands down.
4. Returns 200 `ConsultationResponse` (`id`, `status: OPEN`, version).

In parallel, `resolveSttPipelineId` resolves the tenant's **SPEECH_TO_TEXT agent**
(ASR spec) — the realtime WS lane binds this at session start (see Step 3).

### Step 2 — Consent checkpoint (optional, consent-enabled tenants)

```
POST /api/v1/consultations/{id}/prime      (RequiresConsent AI_DOCUMENTATION)
→ ConsultationService.primeConsultation   → status OPEN → PRIMED
```

### Step 3 — Start recording + live streaming

```
POST /api/v1/consultations/{id}/recording/start    200 RecordingStateResponse
Body: { "sessionId": "sess_..." }   (optional)
```
Flips `Consultation.status → RECORDING`, starts the per-consultation
**LiveDocumentationService** session (live-summary + pre-summary pipeline),
and resolves the ASR binding.

**Realtime audio (SDK holding the websocket):**
```
WS /ws/stt/stream?sessionId=<sid>&ticket=<single-use ticket minted by gateway>
```
Handshake: CSWSH origin registry, ticket consumed + scope `stt_session:<sid>` +
owner/tenant binding (`stt-ws.gateway.ts`). After handshake the gateway creates
the STT session:

```
POST {STT}/internal/streaming/sessions         201 StreamingSessionResponse
X-Service-Token: <...>      X-Tenant-Id: <tenant>
Body (CreateStreamingSessionRequest): {
  "session_id": "...", "tenant_id": "...", "pipeline_id": "<ResolvedAsrSpec.pipeline>",
  "consultation_id": "...", "sample_rate": 16000, "audio_bucket_name": "hope-audio",
  "user_id": "...", "language": "en", "storage": {...},
  "provider_overrides": null, "fallback_pipeline_id": "...", "language_mode": "...",
  "start_on": "primary", "auto_switch_enabled": true,
  "resolved_spec": { "pipelineId": "...", "engine": "faster-whisper|whisper.cpp", "model": "..." }
}
```
Then: binary audio frames → WS → Redis `stt:audio:{sessionId}` → STT inference →
partial/final transcripts → Redis `stt:result:{sessionId}` → gateway bridges to
SSE (`POST /text-generations/tasks/:taskId/stream` style result transport per
transcription job; `transcription-job.controller.ts`).

**Live UI (SSE, from the SDK / console):**
```
GET /api/v1/consultations/{id}/live-summary/stream        scope consultation_live_summary:<id>
GET /api/v1/consultations/{id}/harness-progress/stream
GET /api/v1/consultations/{id}/harness-assurance/stream
GET /api/v1/consultations/{id}/loop/stream
```
Pre-summary generation runs `onStart` (`case-notes-pre-summary`), NER per turn
(`medical-ner`), summarization per turn — see graph Stage 1–2.

### Step 4 — Stop recording; pre-summary snapshot

```
POST /api/v1/consultations/{id}/recording/stop
Body: { "persistSnapshot": true,
        "acceptedProposals": [ {proposalId,start,end,original,proposed,category,confidence,status} ] }
```
Tears down the live session; persists the final pre-summary as a `PRE_SUMMARY`
ContextItem; status → OPEN (harness later promotes to PENDING_REVIEW). Accepted
corrections are forwarded verbatim to `feedback.capture`.

### Step 5 — Generate the final note

**Substrate A (default) — async harness route:**
```
POST /api/v1/consultations/{id}/summary/async
Scope: svc:consultation:report:write
Body (GenerateSummaryRequest): { transcription?, contextItemIds?, options?, dnaStyleId?, template?, ... }
```
`SummaryService.generateSummaryAsync` → `NoteGenerationService.generate`:
- Harness-supported trigger (`SUMMARY_REGENERATE`/`TRANSCRIPTION_CREATED`) →
  resolves `externalPatientId` (consent gate) then calls
  `harnessGatewayService.start(...)` with:
  ```
  jobId: "harness-doc-<uuid>", correlationId, contextItemId,
  transcriptText, redactionRules (decrypted gateway-side), externalPatientId
  ```
- `HarnessGatewayService` POSTs:
```
POST {HARNESS}/api/v1/internal/consultations/{id}/document:start
X-Service-Token: <INTERNAL_ACCESS_TOKEN|HARNESS_SERVICE_TOKEN>   X-Tenant-Id: <tenant>
Body (StartDocumentRequest, camelCase at boundary): {
  "tenantId", "userId", "jobId", "correlationId", "contextItemId",
  "externalPatientId", "transcriptText", "conversationLanguage": "en",
  "dnaStyleId", "template", "textProvider", "textModel",
  "redactionRules": [ {id,type,match,pattern,replacement?,note?} ]
}
```
Harness `start_document` builds `HarnessDocWorkflowInput` (incl. `HarnessGateConfig`
snapshotted from env: `max_regen`, `gate_sla_seconds`, `gate_escalation_seconds`,
`optimistic_delivery_enabled`), stamps memo `{tenantId,consultationId}` +
search-attribute `HarnessTenantId`, and starts Temporal
`HarnessDocWorkflow.run` with **workflow id `harness-doc-{consultationId}`**
(idempotent — `WorkflowAlreadyStartedError` → `status: "already_running"`).
Returns `{ "workflowId": "harness-doc-<id>", "status": "started" }`.

**Substrate B (BREN graph) alternative**: summary is produced by the graph's own
`n_summary_*` nodes inside the interpreter run that started at `open` — the
gateway never calls `document:start` for governed consultations.

The **synchronous legacy** `POST /consultations/{id}/summary` still exists but
is explicitly **not** harness-routing (see `summary.service.ts:628`: it runs the
legacy body directly — DNA effective id, client clinical context, `assemble`,
`POST {TEXT}/api/v1/generate`, persist ContextItem + SummaryMeta).

### Step 6 — HarnessDocWorkflow execution (Substrate A, in Temporal)

Deterministic body; every side effect is an activity. Phases:

**POLICY** — `fetch_policy` activity reads the tenant + department-default-agent
`harnessOverrides` effective policy → `HarnessPolicy` (`max_regen`, gaté SLA,
sensor thresholds, guardrail/PHI/retrieval/NER/atomic-fact/judge/MCP knobs,
`text_provider_model`, `text_fallback`, `optimistic_delivery_enabled`). Failure →
code defaults + `policy_degraded` (reduced assurance).

**EXTRACT** — `extract_entities` (NLP NER on `transcriptText`, with optional
coding-priors reuse) → `persist_entities` (NamedEntity rows) → (opt-in) MCP
terminology validation (`call_mcp_tool`, PHI fail-closed) → `retrieve_context`
(institutional RAG, Qdrant hybrid retrieval, `retrieved_chunk_ids` +
`knowledge_chunks`). **NLP failure degrades (forced human review); retrieval/MCP
failure flags reduced assurance.**

**GENERATE (bounded regen loop)** — per iteration:
1. `assemble_prompt` (F-13 — assembled once pre-delivery) — resolves `template`,
   `dna_style_id`, conversation language; returns `user_prompt(_ref)`,
   `system_prompt(_ref)`, `response_format`, `hyperparameters`,
   `segment_citations`.
2. `generate` — the TEXT call:
   ```
   POST {TEXT}/api/v1/generate
   X-Service-Token, X-Tenant-Id
   Body: { prompt, prompt_ref?, system_prompt, system_prompt_ref, prompt_block,
           response_format, hyperparameters, provider, model, text_fallback,
           phi_enabled, phi_fail_closed, regen_feedback?, segment_citations }
   ```
   Response carries `content(_ref)`, `model`, `stats`, usage blocks.
3. `extract_entities` on the generated note; `run_sensors` (five computational
   sensors: entity faithfulness, coverage/omission, PHI leak, grounding/citations,
   etc. → `sensors.results`, `citations_map`) → `aggregate` → computational
   verdict `REGEN | PASS | FLAG`. Regen consumes budget while
   `max_regen`/token budget remain; critique (`build_regen_feedback`) feeds the
   next iteration.

**INFER (inferential pass, once settled)** — `run_inferential_sensors`:
LLM-as-judge groundedness (DB-selected `harness.judge` provider/model) + safety
screen that calls **apps/guardrail** (tenant-scoped, `X-Tenant-Id` mandatory).
Safety imposes `FLAG` (never auto-regen); groundedness may use one regen.
Infernal failure → reduced assurance (never auto-pass).

**PERSIST** — `persist_draft`:
```
POST {API}/… (internal)  → ContextItem + SummaryMeta, status PENDING_REVIEW,
  DRAFT_PENDING_SENSORS (optimistic path)
carries: content(_ref), model_name, sensor_scores, citations_map,
  guardrail_decisions, reduced_assurance, rag_triad_score,
  prompt_template_id/version, dna_style_id, gate_decision, is_auto_generated,
  redaction_applied, redaction_manifest
```
Optimistic two-phase delivery may deliver early and run assurance after
(`finalize_assurance`, or **`retract_draft`** on FLAG — retraction net).

**GATE** — wait on `approval` signal raced against durable SLA timer
(`gate_sla_seconds`); breach → `escalate_gate` (reason `gate_sla_breached`, then
terminal `gate_sla_abandoned` at `gate_max_escalations` bound). Workflow id stays
`harness-doc-{id}`.

**RECORD** — `record_gate_decision` writes WORM GATE_DECISION audit
(`decision`, `gate_decision`, `contextItemVersionId`, `attestationHash`,
`clinician_id`). Result: `{decision, contextItemId, regens_used, escalations,
approved, clinician_id}`.

### Step 7 — Clinician sign-off

The doctor reviews in the client; approve/edit/reject:

```
POST /api/v1/consultations/{id}/summary/{contextItemId}/approve
Body (ApproveSummaryRequest): { decision: "approve" | "edit" | "reject",
                                contextItemVersionId?, clinicianUserId? }
```
→ gateway forwards to the running workflow:
```
POST {HARNESS}/api/v1/internal/workflows/{id}/signal/approve
Body (ApprovalRequest): { tenantId, contextItemVersionId, attestationHash,
                          clinicianId, decision }
```
(signal `edit` = `/signal/edit` with `{content, contextItemVersionId, editedBy}`;
assurance re-binds to the edited version.)

Finally the durable document is committed and delivered — graph `n_output`
protocols `http | http-sse | socket` — and the WR view (documents/sections,
`GET /consultations/{id}/documents/sections`, confirm via
`PATCH .../documents/{doc}/sections/{section}` under `If-Match`) reflects the
final note.

### TTS (optional, downstream of a finalized note)

`POST /api/v1/text-speech/...` or `POST {TTS}/api/v1/tts/generate` to read the
note aloud; sees the same tenant-scoped routing policy (`text-to-speech` task)
and agent resolution (`text-to-speech` agent task `TEXT_TO_SPEECH`).

---

## 5. API call matrix (full chain, in order)

| # | Call | Service | Method | Key request data | Key response |
|---|---|---|---|---|---|
| 0 | `/api/auth/login` | Admin Console → Gateway | POST | credentials | `{user, token(s)}` + JWE cookie |
| 1 | `/api/v1/consultations/open` | Gateway | POST | patientId, departmentId, clinicianUserId, workflowDefinitionSlug?, visitType?, context | `{id, status: OPEN, version}` (dispatch recorded) |
| 2 | `/api/v1/consultations/{id}/prime` | Gateway | POST | (consent) | `{status: PRIMED}` |
| 3 | `/api/v1/consultations/{id}/recording/start` | Gateway | POST | `{sessionId?}` | `RecordingStateResponse` (RECORDING) |
| 4 | `WS /ws/stt/stream?sessionId&ticket` | Gateway→STT | WS | binary audio frames | partial/final transcripts |
| 5 | `{STT}/internal/streaming/sessions` | Gateway→STT | POST | session fields (+ resolved_spec) | 201 `{session_id,status,pipeline_id,active_engine,…}` |
| 6 | `/api/v1/consultations/{id}/live-summary/stream` (+ progress/assurance/loop streams) | Gateway | SSE | — | transcriptions, pre-summary, progress |
| 7 | `/api/v1/consultations/{id}/recording/stop` | Gateway | POST | `{persistSnapshot, acceptedProposals?}` | `RecordingStateResponse` (OPEN + PRE_SUMMARY persisted) |
| 8 | `/api/v1/consultations/{id}/summary` **or** `summary/async` | Gateway | POST | transcription/contextItemIds/options/dnaStyleId/template | SummaryResponse **or** `{jobId,status}` (harness) |
| 9 | `/api/v1/internal/consultations/{id}/document:start` | Gateway→Harness | POST | StartDocumentRequest (camelCase) | `{workflowId, status: started\|already_running}` |
| 10 | Temporal `HarnessDocWorkflow.run` | Harness | — | HarnessDocWorkflowInput + gate config | `HarnessDocWorkflowResult` |
| 11 | `{NLP}/api/v1/classify/tokens` (extract_entities) | Harness→NLP | POST | text, language, priors | `{entities:[{label,start,end,score,code?}]}` |
| 12 | `{TEXT}/api/v1/generate` (generate) | Harness→Text | POST | prompt/system/response_format/provider/model | `{content, model, stats, usage}` |
| 13 | `run_sensors` / `run_inferential_sensors` | Harness | activity | note, transcript, citations, knowledge chunks | verdicts/scores |
| 14 | `{GUARDRAIL}/api/v1/guardrail/…` (safety screen, inferential) | Harness→Guardrail | POST | note text, tenant | `{safe, issues, confidence, …}` |
| 15 | persist_draft → internal | Harness→Gateway | POST | PersistDraftInput (PENDING_REVIEW) | summary/ContextItem |
| 16 | `/api/v1/consultations/{id}/summary/{cid}/approve` | Client→Gateway | POST | decision, contextItemVersionId, attestationHash, clinicianId | `{approved…}` |
| 17 | `{HARNESS}/api/v1/internal/workflows/{id}/signal/approve` | Gateway→Harness | POST | ApprovalRequest | ack (signal resolves gate) |
| 18 | `GET /consultations/{id}/documents/sections` + `PATCH …/sections/{s}` | Client→Gateway | GET/PATCH | If-Match ETag + content | durable document view (confirmed sections) |
| 19 | `{TTS}` (optional) | Client→Gateway→TTS | POST | text/voice/style | audio |

---

## 6. Data contracts by boundary

**Tenant/identity headers on internal service calls** (`internalServiceHeaders`):
`X-Service-Token: INTERNAL_ACCESS_TOKEN` (or `HARNESS_SERVICE_TOKEN`, both
accepted), `X-Tenant-Id: <tenant>`, `X-Internal-Tenant-Id` on harness routing,
`X-Tenant-Id` mandatory on guardrail (missing → 428).

**OpenConsultationRequest** — `{ patientId, departmentId, clinicianUserId?,
workflowDefinitionSlug?, visitType?, parentConsultationId?, context? }`. Errors:
`CLINICIAN_*` 400, `CONTEXT_SCHEMA_VIOLATION` 400, `DEPARTMENT_{MISMATCH,AMBIGUOUS}`
400/404, `VISIT_TYPE_INVALID` 400, `USER_IDENTITY_*` 400/404/409, 503 (context
validation unavailable), dispatch failure → **falls back to Substrate A silently**
(a clinician must always be able to open).

**document:start request** — see Step 5 body. `redactionRules` parsed to
`RedactionRule` at the harness boundary (malformed rule → 422). Memo +
`HarnessTenantId` search-attribute carry tenant ownership (admin visibility).

**HarnessDocWorkflowInput** — `{ consultation_id, tenant_id, user_id, job_id,
correlation_id, context_item_id, transcript_text, external_patient_id,
conversation_language, dna_style_id, template, text_provider, text_model,
redaction_rules[], gate: HarnessGateConfig }`.

**TEXT /generate response** — `{ content, model, provider?, usage_detail,
guardrail_usage, stats: {stop_reason, ttft_ms, tokens_per_second} }`. The gateway
parses usage via `parseTextUsageDetail` (ledger attribution) and guardrail usage
for the WORM trail.

**Guardrail analyze** — Body `{ text, guardrail_type, request_id?, priority? }` →
`{ safe, issues[], confidence, processing_time_ms, request_id, timestamp }`.
`X-Tenant-Id` mandatory; fail-closed 503 when a model selection is missing.

**Workflow-run (Substrate B) start** — `startWorkflowRun({runId, sessionId,
workflowVersionId, tenantId, configRef, sandbox, subject, payload})`; identity
stamped from `subject`, never from caller `payload`.

---

## 7. How the engine decision is made (Substrate A vs B)

| Condition | Engine |
|---|---|
| No `core`-palette workflow assigned for `(tenant, department, visit-type)` | **Substrate A** — `HarnessDocWorkflow` via `document:start` |
| Department/tenant assigns `arcaai-bren-consultation` (BREN) | **Substrate B** — interpreter run at `open`; `document:start` stands down (governing-engine marker on consultation metadata) |
| Caller passes a `workflowDefinitionSlug` | caller-selected replaces cascade; must be published+selectable or 404/403 |

Read the decision at runtime: `GET /api/v1/consultations/{id}/workflow` (gateway
`consultation.controller.ts:676`) returns the governing workflow +
`workflowRunId` if Substrate B owns it.

---

## 8. Dependencies and failure modes

| Failure | Behavior | Notes |
|---|---|---|
| STT down / at capacity | WS handshake rejected (single-use ticket), session create 503 + `Retry-After`; WS can resume with backoff | language-mode unsupported → 422 naming supported modes |
| NLP down (NER) | Substrate A: `degraded=true` → forced human review, never auto-pass | Substrate B `n_ner` `onError: degrade` |
| TEXT down | **generate error propagates** — no draft persisted (never silently downgrade) | Substrate B: `n_asr`/`n_finalize` `onError: fail`; `n_*_summary` `degrade` |
| Guardrail down | fail-closed on input screen; inferential safety fails open only to reduced assurance, never auto-pass | 503 on missing model selection |
| Temporal down | `document:start` degrades; `dispatchForConsultation` catches and **still opens the consultation under Substrate A** | clinician-open must never be blocked |
| Search attribute missing | `start_document` falls back to memo-only start (admin filters memo client-side) | logged `harness.document.start.search_attribute_unavailable` |
| DNA style missing | gateway logs warning; falls back to department default slot → none | tenant flag off → no DNA prompt |
| Clinician never signs | gate escalates `gate_sla_breached` → `gate_sla_abandoned` at bound; draft stays PENDING_REVIEW | 1h SLA default |
| Inferential = FLAG (optimistic) | draft **retracted** (`retract_draft`), status RETRACTED, WORM audit carries FLAG + flagged claims | never silent swap |
| Redaction fail-closed | forces FLAG even on a passing assurance verdict | retracted above |

Health contract (every service): `/health` (always 200), `/health/live`,
`/health/ready`, `/health/startup` (probes may refuse while draining/unready).

---

## Appendix A — How a BREN doctor's click reaches the note (both engines)

1. **Authn** → JWE session (roles/scopes/tenant).
2. `open` → context schema validated → assignment picks
   `arcaai-bren-consultation` (if dispatched) OR default.
3. Recording: WS `ticket` mint → STT `internal/streaming/sessions` →
   audio→transcript (Redis) → live SSE feed.
4. Stop recording → pre-summary snapshot.
5. Finalize: **A)** `summary/async` → `document:start` → `HarnessDocWorkflow`
   (policy→extract→generate→sensors→infer→persist→gate→record)
   **B)** interpreter graph `n_trigger→n_asr+n_presummary→n_ner→n_visit
   →n_summary_{new,revisit}→n_finalize→n_review→n_output`.
6. Doctor approves → approval signal → WORM GATE_DECISION → durable document
   delivered over `http`/`http-sse`/`socket`.

---

## Appendix B — Related artifacts

- Codewalk overview: [`vox.md`](./vox.md) · services: [`api.md`](./api.md),
  [`harness.md`](./harness.md), [`stt.md`](./stt.md), [`nlp.md`](./nlp.md),
  [`text.md`](./text.md), [`guardrail.md`](./guardrail.md), [`tts.md`](./tts.md)
- Sequence diagrams (Archify, `diagrams/*.html`): STT streaming session/transcription,
  harness doc start/signals/eval-gate, admin-console impersonation pair, Text
  generate/streaming, Guardrail analyze/medical/redact/groundedness, NLP
  classify/guard/entailment, health probes.
- Seed source of the BREN workflow/agents/templates:
  `packages/database/src/prisma/db_main/seed/29-arcaai-agents-and-workflows.generated.ts`
  (workflow at ~4576, DNA slot ~4875).