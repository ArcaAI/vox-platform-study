# TASK-544 — Agent Platform Concept: Review, Research & Proposal

- **Status:** Completed (proposal accepted 2026-07-23; execution in sub-tickets TASK-545…552, see §7)
- **Type:** review / research / proposal (no production code in this ticket)
- **Requested:** 2026-07-22 (owner)
- **Baseline:** `fix/2605-review` working tree (post TASK-542 defect clearance; TASK-543 planned)
- **Related:** SOTA-Track (2026-07-18/20 reviews, 2026-07-22 assessments, findings-register), TASK-531 (pipeline template governance), TASK-533 (agentic loop completion), TASK-543 (consultation scribe playground)

---

## 1. Requirement Analysis

The owner wants to formalize an **"agent" product concept** over capabilities that already exist in HOPE, give the agent types a coherent marketing name family, and close the gap between the product concept and the implementation.

### 1.1 Agent types (owner definitions, verbatim intent)


| #   | Agent type              | What it is technically                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Transcription agent** | Each configured audio pipeline for transcription (one per ASR pipeline configuration)                                                                                                                                                                                                                                                       |
| A2  | **NER agent**           | The shared named-entity-recognition capability serving all tenants                                                                                                                                                                                                                                                                          |
| A3  | **Department agent**    | Per tenant-department combination of: (a) template instructions for department-specific SOAP/case-note generation, (b) the harness agentic loop for realtime summarization, SOAP/case-note generation, and redaction (when DNA-writing-style redaction/rewrite is enabled and the user's personalized DNA report/instructions are provided) |
| A4  | **Local transcription agent** (added 2026-07-23) | The in-browser combination of VAD + noise suppression + a small transcription model, running entirely on the user's device. Implemented today as `@arcaai/vad` (Silero VAD v5, ONNX) + `@arcaai/noise-filter` (RNNoise WASM) + `@arcaai/stt` local Whisper WebWorker. **Owner action item: DISABLE local transcription for now — backend-based transcription only.** VAD + noise suppression stay active as preprocessing for the backend stream; only the on-device transcription half is disabled. |




### 1.2 Use-cases (owner, verbatim intent)


| #   | Use-case                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | A default set of department agents is available **day-1 for all tenants** (and future tenants); each tenant gets its **own copy** of the set                                                              |
| U2  | Tenant admin can **update/create department agents**, reusing the existing template-instruction/prompt **versioning**                                                                                     |
| U3  | Tenant admin can **pin a default agent (version) per department** for end-users; otherwise the **latest version** is used                                                                                 |
| U4  | Tenant admin can **control the harness agentic loop**: LLM model, context, steps, thresholds, gold standards, etc.                                                                                        |
| U5  | End-users (doctors) use **several agents concurrently** during a realtime/near-realtime consultation: transcript, information/knowledge extraction, note taking/generation, pop-up/notice of key findings |




### 1.3 Deliverables of this ticket

1. Current-state review of the implemented workflows: transcription, consultation & context management, harness-loop summarization (§2).
2. Deep research on latest best practices: ambient clinical documentation / agentic clinical summarization, and agent product packaging/naming (§3).
3. Findings + proposed solution, including a marketing name family and an implementation direction (§4–§6).

---



## 2. Current State Evaluation

All statements verified against the working tree 2026-07-22 (file:line refs will drift).

### 2.1 Transcription workflow ("transcription agent" = one `AsrPipeline` row)

**Unit of configuration**: `AsrPipeline` (`stt.prisma:12`) — `tenantId`, `slug`, `configYaml` (the whole capture→ASR chain), `isDefault`, `sourceTemplateSlug` **+** `templateLocked` (template lineage, TASK-531), OCC `_version`; immutable config history in `AsrPipelineVersion`. Models are referenced **by slug** into the `AiModel` registry (no FK).

**Runtime flow (streaming)**:

1. Browser: `useArcaAudio.startAudio({pipelineId,…})` → `PluginManager` composes config (runtimeOptions > userPreferences > plugin config > defaults) → `TranscriptionPipeline` stages **NoiseFilter → VAD → STT**; with a `pipelineId` the STT stage streams to the backend (`StreamingBackendSTTProvider` → `StreamingSessionManager` + `SttV2WebSocketClient`); without one it falls back to on-device Whisper.
2. Gateway session mint: `POST /audio/transcription-jobs/stream/session` — concurrency quota, pipeline-ownership 404-check, one-shot stream ticket (JWT never in URL), tenant binding (`transcription-job.controller.ts:312`).
3. `SttWsGateway` (`/ws/stt-v2/stream`) — ticket consumed once, tenant-claim fail-closed, resume/backpressure/gap semantics; audio → Redis Streams `stt:audio:{id}`; results ← `stt:result:{id}` (`stt-ws.gateway.ts`, `streamingAudioBridge.service.ts`).
4. stt-v2 `SessionManager` loads the pipeline config (`PipelineConfigReader`, tenant-scoped), warms/pins models, runs streaming engines (whisper.cpp / faster-whisper / parakeet.cpp / azure) with `local_agreement_2` commit policy; on finalize persists ONE aggregate transcript via `POST /internal/stt/transcripts` (requires `consultation_id`, else skipped).
5. Gateway `SttInternalService.createStreamingTranscript` — idempotent per consultation, encrypts content (Vault Transit `hope-phi`), persists `TranscriptSegment` rows (**offsets/timings/speaker only, no text** — PHI posture), emits `TranscriptionCreated`.

**Tenant-admin knobs per pipeline** (YAML schema v2): model slugs (asr/vad/denoise/embedding), preprocessing (normalize, denoise, resample, VAD thresholds, dual-capture), inference (device, compute_type, language, beam_size, temperature, code_switching, initial_prompt), diarization (enabled/backend/max_speakers), streaming commit policy, postprocessing (timestamps, punctuation, disfluencies, segment merge) — plus DB fields name/slug/description/tags/isDefault/enable-toggle. `templateLocked` is absent from every DTO (cannot be flipped over the API).

**Template governance already shipped (the U1 precedent)**: 9 SYSTEM-tenant template pipelines (default `production-whisper-large-v3-turbo-gguf`); `provisionTenantPipelineCatalog` clones all of them at tenant creation as `templateLocked:true` copies with `sourceTemplateSlug` lineage; `PipelineTemplateResyncService` nightly cron adds missing templates and fast-forwards *pristine* locked copies, never touching unlocked/drifted rows; `PipelineService.clone` unlocks a copy for tenant editing; locked rows reject edit/delete with 403 (`pipeline.service.ts:25,214`; `pipeline-template-resync.service.ts`).

**Caveats**: two independent streaming transcript writers (SDK posts a ContextItem per final segment AND stt-v2 posts one aggregate at finalize); streaming has no `TranscriptionJob` row (no per-job status/retry record); `PipelinePolicy` (auto-summary/NER/harness/DNA toggles, TENANT/DEPARTMENT/DOCTOR cascade) is a different thing from `AsrPipeline` and easy to conflate; model slug refs fail only at Python runtime if typo'd.

### 2.2 Consultation, context management & NER ("NER agent" = shared `apps/nlp` service)

**Consultation lifecycle**: SDK `session.open` → `POST /consultations/open` → `ConsultationService.getOrCreate` keyed `(tenantId, patientId, appointmentDate, doctorId)` with entitlement metering and `parentConsultationId` chains. Two status systems coexist: close/reopen mutate legacy `metadata.status` JSON while recording/harness transitions mutate the typed `status` column (`OPEN → RECORDING → DRAFT_PENDING_SENSORS → PENDING_REVIEW → SIGNED → CLOSED/REOPENED`).

**Context management**: `ContextItem` types `AUDIO_RECORDING, WORKNOTE, RAW_SUMMARY, MODIFIED_SUMMARY, PRE_SUMMARY, NAMED_ENTITY, TRANSCRIPT, CASE_NOTE, ATTACHMENT, SIGNED_NOTE`; sources `USER, AI, SYSTEM, TRANSCRIPTION`. All content PHI-encrypted at rest (`encryptedContent`, plaintext column dropped; fail-closed in staging/prod). `ContextItemVersion` append-only version history with attestation fields; `updateContext` = content-at-version semantics. `ContextAdded` events fan into the live-doc plane for WORKNOTE/CASE_NOTE/ATTACHMENT.

**Entity extraction — three planes**:

1. **Server NER (the shared "NER agent")**: `apps/nlp` `POST /api/v1/classify/tokens`, default model `blaze999/Medical-NER`, with an enabled-by-default deterministic **OntologyLinker** (UMLS/SNOMED/RxNorm/ICD/LOINC codes from a curated offline vocabulary subset) + assertion detection (PRESENT/ABSENT/HISTORICAL/FAMILY/HYPOTHETICAL). Called by the durable BullMQ `NerProcessor` and `SummaryService.extractEntities`; entities persisted as tenant-scoped, PHI-encrypted `NamedEntity` rows with transcript-span provenance. **Compute/model is a single shared deployment; data is strictly tenant-scoped.**
2. **Browser med-ner**: `@arcaai/med-ner` Transformers.js on-device (default preset `clinical`), fully isolated from server NER, disabled by default.
3. **Playground proxy**: `POST /ai/nlp/entities` resolves `AiTaskDefault('nlp.ner')` — the only path where model selection governs; **the consultation NER paths post to** `NLP_URL` **with no** `model_name`, so task-key routing does NOT govern the actual clinical pipeline (two model-resolution regimes coexist).

**Live documentation plane** (near-realtime): per-consultation transient session (Redis pub/sub, no Prisma rows per tick). Ingests STT finals; flush on ≥3 pending segments OR 5 s idle (per-tenant/user resolvable via effective settings; `LIVE_DOC_`* env override). Each flush: SMR builds a structured running SOAP (bounded JSON repair) → NER over the raw transcript delta → entities grounded back into the note lexically (unmatched mentions dropped) → `LiveSummaryEventDto {sections, entities, stats}` published to `consultation:live-summary:{id}` → SSE `GET :id/live-summary/stream`. `transcript.mode` whole|windowed. Stop optionally persists ONE `PRE_SUMMARY` ContextItem; the durable harness remains the system of record.

**Caveats**: SDK `context.extractEntities()` is a READ of persisted entities, not a trigger; `qdrantSynced` is dead weight (no semantic search wired); live entity offsets are lexically re-derived and lossy; stale schema comment claims no ontology linker exists (it does); SDK `NLP_ENDPOINTS` constants point at unmounted routes.

### 2.3 Harness agentic-loop summarization ("department agent" = emergent composition, no entity)

**Trigger**: `TranscriptionCreated` → `ConsultationEventHandler` → if effective `harnessEnabled` (a `PipelinePolicy` cascade toggle doctor→department→tenant→SYSTEM, plus per-consultation metadata override) → `HarnessGatewayService.start` → harness FastAPI → Temporal workflow with idempotent id `harness-doc-{consultationId}`.

**Loop spine** (`workflows.py:370`, all side effects in activities with bounded retries): `fetch_policy` (live DB policy per run; fetch failure ⇒ code defaults + `reduced_assurance`) → transcript NER (`extract_entities`; NLP down ⇒ degraded, never auto-PASS) → optional MCP terminology validation (flag-gated, allowlist ∩, fail-closed PHI screen) → optional institutional RAG retrieve → **bounded regen loop** [assemble_prompt → generate (SMR direct, idempotency-keyed, PHI-egress guard) → note NER → 5 computational sensors → aggregate; REGEN + budget left ⇒ critique-fed regen feedback appended as a strictly-trailing suffix (KV-cache-preserving)] → one costly inferential pass (groundedness judge, citation_verify judge, Granite Guardian safety, optional atomic-fact NLI; content-addressed verdict cache across passes) → persist draft (`PENDING_REVIEW`) → clinician gate (approval signal raced vs SLA timer, escalation ×N, terminal abandon) → WORM gate decision. Optimistic two-phase delivery (deliver early `DRAFT_PENDING_SENSORS`, assurance streams after, edit-rebind with rerun cap, retraction on post-delivery FLAG). Full trajectory persisted per step (`AgentTrajectoryStep`).

**Gate decisions** (`aggregator.py`): `PASS | REGEN | FLAG`; degraded ⇒ FLAG (never auto-PASS); highest-harm sensors (entity_faithfulness, numeric_dose, safety) ⇒ FLAG, safety never regenerates; regen-fixable sensors ⇒ REGEN while budget remains. Sign-off: a COMPLETED safety FLAG **hard-blocks** `approveSummary` unless an explicit one-click override (WORM `SAFETY_OVERRIDE`); early sign allowed and annotated; late adverse verdict ⇒ `POST_SIGN_FLAG`.

**Prompt personalization** (`PromptAssemblyService.assemble`): 3-tier resolution — doctor-preferred template → department template ids (`newPatientPromptId`/`revisitPromptId`/`preSummaryPromptId`) → hardcoded SYSTEM defaults; **only APPROVED templates resolve**. Assembly = template + variable substitution + per-department few-shot exemplars mined from clinician gate edits (`GateEditExemplar.redactedAfter`) + transcript + NER block + warm-start scratchpad (live SOAP as `{pre_summary_text}` when `warmStartEnabled`). Hyperparameters + strict SOAP JSON `response_format` from `template.metaData.promptConfig`. **DNA writing style** = per-doctor versioned `DnaWritingStyleReport` (Vault-encrypted styleText) injected as `{style_DNA_doctor_department_*}` variables, double-gated by tenant AND doctor opt-in (`pipeline.dnaStyleEnabled`). **No redaction/rewrite concept exists in the DNA model — style-text injection only.**

**Configuration-surface inventory (knob → who controls)**:


| Surface                                                                         | Knobs                                                                                                                                                                                                                                                           | Who                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `HarnessPolicy` (tenant row → SYSTEM row → code default; OCC + WORM change log) | 5 clinical sensor thresholds; `maxRegen`, `gateSlaSeconds`, `gateEscalationSeconds`, `toolAllowlist`                                                                                                                                                            | **Tenant admin**                                                                 |
| `HarnessPolicy` global-only keys                                                | `safetyEnabled/phiEnabled/phiFailClosed`, `safetyProvider/Model`, `smrProvider/Model`, `optimisticDeliveryEnabled`, `atomicFactEnabled`, `retrievalEnabled`, `warmStartEnabled`, `nerPriorsEnabled`, `maxEditReruns`, `regenFeedbackEnabled`, `mcpToolsEnabled` | **Global admin** (tenant write → 403; SYSTEM values overlaid at read)            |
| `AiTaskDefault` (`smr.live/finalize`, `harness.judge`, `nlp.*`, `guardrail.*`)  | task-key → model routing; judge fails closed if unset                                                                                                                                                                                                           | **Global admin** (all prefixes global-only)                                      |
| Settings registry `agentic.context.*`                                           | liveDelta.maxChars, flush segmentThreshold/idleMs, claimCheck.minBytes, transcript.mode, tokenBudget.perRun (0 = unbounded)                                                                                                                                     | **Global admin**                                                                 |
| Harness env (`config.py`)                                                       | safety/PHI/retrieval/claim-check/MCP/judge connection config, feature-flag fallbacks                                                                                                                                                                            | **Ops/deploy only**                                                              |
| `PipelinePolicy` cascade                                                        | autoSummaryEnabled, autoNerEnabled, harnessEnabled, dnaStyleEnabled per TENANT/DEPARTMENT/DOCTOR                                                                                                                                                                | Tenant admin (harnessEnabled descriptor `globalOnly:true`, capped at department) |


**Gold standards / eval state**: DB models exist (`GoldenSet` with `pinnedVersion`, `GoldenCase` encrypted transcript+reference note, `EvalRun`/`EvalScore`) with admin CRUD routes, and the harness ships a release-gate eval engine (GoldenSetRunner, PDSQI-9 judge, ICC(2,1)+Gwet's AC2 judge calibration, gate ICC ≥ 0.8) — but CI results emit to JSON only (not the DB tables), the shipped golden set is **synthetic** (`sources.py` flags clinician-curated replacement as an outstanding prerequisite), the CI gate is `allow_failure: true`, and no console screen surfaces golden sets (M-09).

**Key structural fact**: there is **no first-class "agent" entity** — the per-department agent is an emergent runtime composition of PipelinePolicy(`harnessEnabled`) + department/preferred prompt template + per-doctor DNA style + HarnessPolicy + AiTaskDefault model routing. Nothing binds a department to an agent identity, and HarnessPolicy has no department scope.

### 2.4 Department-agent building blocks & tenant provisioning (verified 2026-07-22)

**Today, "agent" = prompt template.** The console already brands templates as agents: nav `/agents` ("Agents & Prompt Templates", `IconRobot`, `nav-config.ts:237`), empty-state copy "Templates drive the tenant's summarization agents", the usage surface is called "Agent Jobs", and `/playground/llm` is labelled "Agent Playground". The SDK brand is `@arcaai/vox` with `AgenticProvider`; telemetry uses `AgentTrajectoryStep` / `AgentSessionKind {LIVE_DOC, HARNESS_DOC, SUMMARY_JOB, EVAL_RUN}`. There is **no first-class Agent entity** binding prompt + harness config + DNA style.

**PromptTemplate system** (`prompt-template.prisma`):

- Scopes: `TENANT_DEFAULT | DEPARTMENT_DEFAULT | USER_PERSONAL`; categories `SYSTEM | SUMMARY | DNA_ANALYSIS | CUSTOM`; status lifecycle `DRAFT → PUBLISHED → APPROVED`; `departmentId` FK; `ownerUserId` for personal templates.
- Versioning: `PromptVersion` append-only history `(promptTemplateId, versionNumber)`; every create/update/approve snapshots a version under OCC (`prompt-management.service.ts:195-406`).
- **No version pinning**: resolution always serves the template row's current `content`, gated only on `status === APPROVED` (`prompt-resolution.service.ts:180-270`). `activateVersion` is rollback-by-copy (old content becomes a NEW latest version), not a pin (`prompt-management.controller.ts:378-398`).
- Approve is **GLOBAL_ADMIN-only** (`isSuperAdmin` imperative check, `prompt-management.service.ts:425-464`).
- **No clone method** exists for prompt templates; the `templateLocked`/`sourceTemplateSlug` clone-lineage pattern exists only for ASR pipelines (`tenant.service.ts:307-318`).

**Department model** (`department.prisma:4-52`): `code/name/description/parentDepartmentId` hierarchy + **loose string refs (not FKs)** to prompts: `defaultSummaryTemplate`, `preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId`, `dnaWritingStylePromptId`, plus `promptConfig` JSONB (contextVariables, preferredSections, abbreviationDensity). Department-level default template assignment exists (`assignToDepartment`, `prompt-management.service.ts:917-928`) and per-doctor preferred template (`setPreferredPromptTemplate`). **No relation from Department to HarnessPolicy or any AI-runtime config.** Department-keyed AI artifacts elsewhere: `PipelinePolicy` scope rows (TENANT/DEPARTMENT/DOCTOR), `GateEditExemplar.departmentId` (per-department few-shot mining), `PromptUsageRecord`/`DnaUsageRecord.departmentId` (telemetry).

**HarnessPolicy scoping** (`harness.prisma:300-373`): system-default → **tenant override only** (`@@unique([tenantId])`) — no department or consultation scope. Tenant admins may patch **thresholds only**; model routing, context/token budget, loop-step toggles, judge, MCP are `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (`harness-policy.service.ts:127-145,476-480`). Golden sets (`GoldenSet/GoldenCase`, `EvalRun`) are tenant-scoped, not department-scoped.

**Tenant provisioning** (`tenant.service.ts:159-198`): a new tenant gets ONE bare `GEN` department (null prompt IDs, `departmentDefaults.ts:14-27`), the AiModel catalog, and the 9 cloned ASR pipelines — **no prompt-template catalog, no HarnessPolicy row, no DNA styles**. The rich 18-department catalog with prompt wiring exists only as seed fixtures for two fixed tenant IDs (`seed/04-department.ts:13-302`), not as per-new-tenant provisioning.

**Use-case verdicts** (evidence above):


| Use-case                                         | Verdict                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 day-1 department-agent set per tenant         | **Mostly missing** — clone machinery exists only for pipelines; template catalog is seed-only for 2 fixture tenants                               |
| U2 tenant admin create/update with versioning    | **Exists** (`/agents` screen + PromptVersion snapshots + OCC)                                                                                     |
| U3 pin default version per department            | **Missing at version level** — template-level department default exists; resolution is APPROVED-gated latest-wins                                 |
| U4 tenant admin controls harness loop            | **Partial per-tenant (thresholds only), missing per-department**; most knobs global-admin-only by deliberate E3 posture                           |
| U5 doctors use several capabilities concurrently | **Partial** — one session runs STT + live summary + note + review concurrently, but prompt resolution picks exactly ONE template per consultation |




## 3. Research Findings



### 3.1 Ambient clinical documentation & agentic summarization best practices (external research, 2025–2026 sources)

**The field has converged on HOPE's architecture.** Leaders (Abridge, Ambience, Corti, Oracle, Epic, Dragon Copilot, Nabla, Suki, Heidi, Freed, DeepScribe) all run evidence-grounded, coding-aware pipelines with span-level provenance back to the transcript. Realtime drafting is table stakes; the race has moved downstream into coding/CDI and upstream into grounding. HOPE's retrieve → assemble → generate → verify → gate → bounded-regen loop is squarely SOTA-shaped; differentiation now lives in **grounding fidelity, eval-gated promotion, and personalization**.

**Grounding is a product feature, not just an eval**: Abridge "Linked Evidence" (every summary span → transcript+audio span) and Corti "FactsR" (timestamped fact objects with confidence, composed into the note) are the reference patterns — matching HOPE's `[[seg:]]` segment-citation lane (now closed end-to-end per F-032) and arguing for surfacing the evidence panel at sign-off. Under FDA's revised CDS guidance (Jan 2026), the independently-reviewable evidence basis is also the compliance mechanism keeping suggestions on the non-device side ([NEJM 2025](https://clinician.nejm.org/ai-clinical-decision-support-ambient-scribes-2025-CLINeNA59596), [Covington](https://www.cov.com/news-and-insights/insights/2026/01/5-key-takeaways-from-fdas-revised-clinical-decision-support-cds-software-guidance)).

**Empirical failure modes to point sensors at** (independent studies): validated PDQI-9 study (n=97 encounters, 5 specialties) — AI notes more thorough/organized but **hallucinations 31% vs 20%** (p=0.01) and less succinct; reviewers still preferred AI 47% vs 39% ([PMC12586549](https://pmc.ncbi.nlm.nih.gov/articles/PMC12586549/)). Clinician edit-analysis studies (2026): **hedging restoration** (clinicians soften overconfident causal claims), **omissions** (ROS, negative screenings, ACP items) dominate, **Assessment & Plan carries ~59% of edits** — concentrate verification budget there. **"When Reasoning Hurts"** ([arXiv 2605.24902](https://arxiv.org/pdf/2605.24902)): reasoning models hallucinate MORE on SOAP generation — route reasoning to retrieve/assemble/verify/code, keep the generate step constrained and grounded. **Self-correction is unreliable when the generator checks itself** — use an independent verifier model for LLM-judged faithfulness; combine with deterministic sensors (HOPE already does).

**Eval-gating is the governance backbone**: treat prompt templates AND gold sets as versioned code; every prompt/model/retrieval change triggers a regression eval against a frozen golden set with hard thresholds before merge/promotion; golden set = 4 buckets (production sample, adversarial, edge cases, **shipped-failure replays**); post-deploy sample 5–10% of traffic for drift ("algorithmovigilance") ([Braintrust](https://www.braintrust.dev/articles/llm-evaluation-guide), [golden-set design](https://futureagi.com/blog/llm-eval-golden-set-design-2026/)). This is exactly the missing gate for HOPE's template APPROVED flow (today approval is a manual global-admin action with no eval run).

**Personalization patterns**: the dominant, lowest-risk pattern is a **versioned "example note" style profile learned from a small curated set of the clinician's own edited/approved notes** (Freed "Learn format", DeepScribe, Nabla), applied at the composition/style layer only — never altering fact selection, grounding, or hedging. Two-tier structure (department-standardized template + individual voice on top) is the proven shape (Heidi, DeepScribe) and matches HOPE's department template + DNA style. Freed's own caution: don't relearn continuously (style drift from noisy edits) — prefer curated exemplars, versioned. **Redaction/rewrite**: clinicians demonstrably de-stigmatize and remove sensitive content during edits, so a redaction feature matches documented need — build it as a first-class, auditable transform, separate from style. Patient-friendly summaries are a separate audience-tier generation, not a filter over the clinician note.

**Agentic-loop production practice**: durable execution (Temporal) is the recognized reliability layer — validates HOPE's choice; budgets belong at the whole-run level (HOPE's `tokenBudget.perRun` + regen caps match); multi-agent helps for decomposable workloads with single-purpose workers and an auditable trail (Corti Symphony: 4 role agents for coding) but is NOT universally better — keep a single orchestrated loop with narrow tool-agents. Task-based model routing (cheap-first cascade, escalate on low confidence) can cut cost ~85% at ~95% quality — HOPE's `AiTaskDefault` task keys are the right frame; `smr.live` being inert (D-26) is the gap.

**Regulatory**: scribe-only = outside FDA device jurisdiction; coding/diagnosis suggestions edge toward CDS — keep them reviewable recommendations. BAA must cover retention, training-use, storage location. **HIPAA ≠ recording-consent compliance** — 2026 class actions (Sutter/Sharp/Abridge named) under state wiretap/CIPA statutes make per-tenant/jurisdiction consent + recording/retention config a product requirement. ONC HTI-1 "source attributes" transparency (model cards per template/model version) is the emerging customer expectation.

Caveat: vendor benchmark numbers (Corti 94% groundedness, Ambience +27%, etc.) are self-reported.

### 3.2 Agent naming & packaging patterns (external research, 2025–2026 sources)

**Market state.** No single word has won: "copilot/assistant" = in-context human-in-the-loop helper; "agent" = goal-driven multi-step tool-using executor; "skill/tool" = a capability an agent invokes. Healthcare vendors deliberately skew conservative — Microsoft Dragon Copilot, Epic (Art/Emmie/Penny personas), Oracle, and Suki brand clinician-facing flagships as **assistants** even when agentic, because "assistant" reads safer to clinicians and regulators ([Dragon Copilot](https://news.microsoft.com/source/2025/03/03/microsoft-dragon-copilot-provides-the-healthcare-industrys-first-unified-voice-ai-assistant-that-enables-clinicians-to-streamline-clinical-documentation-surface-information-and-automate-task/), [Epic](https://www.healthcareitnews.com/news/epic-unveils-ai-agents-showcases-new-foundational-models), [HIMSS trust guidance](https://www.himss.org/resources/operationalizing-trust-practical-strategies-for-building-confidence-in-healthcare-ai-agents/)).

**The universal governance pattern — template → instance → immutable version → movable pointer.** Independently converged on by AWS Bedrock Agents (DRAFT → numbered immutable version → **Alias**), Microsoft Foundry (`name:version` immutability, draft → evaluate → publish lifecycle), LangSmith Prompt Hub (commits + movable tags like "production"), MLflow Model Registry (versions + "champion" **alias**; stages deprecated), Salesforce Agentforce (clone → inactive version → zero-downtime **activate**), Terraform module registry (semver + `~>` constraints). Key lessons:

- **Consumers reference the pointer, not the version** — the runtime resolves `department:default`; admins re-point for instant rollback with no serving gap.
- **Versions are immutable; edits fork a new version** — what makes rollback trivial.
- **Pin vs track-latest are distinct affordances** — offer "pin exact version", "track latest published", and "draft (never serves clinicians)".
- Named **evaluation gate before publish** (Foundry) and allow/deny/**require-approval** action policies (Databricks Unity Catalog) are the governance vocabulary for healthcare.

**Container words mean different things**: *Library/Garden* = curated starting templates (Google Agent Garden, Salesforce template library); *Store/Gallery* = marketplace (Hippocratic AI Agent App Store — 300+ agents, 25+ specialties, clinician-authored); *Registry/Catalog* = governance & inventory (Google Agent Registry, Databricks Unity Catalog). HOPE's per-tenant admin-managed set is a **Catalog** seeded from a platform **Library** — not a "store".

**Autonomy ladder implication for HOPE's three types**: the department documentation loop is a genuine **Agent** (plans, loops, uses tools). The transcription pipeline is a supervised **Pipeline/capability**. The shared NER service is unambiguously a **Skill/Service** — stateless, invoked, not goal-driven. Calling NER an "agent" is the one over-claim to avoid (trust/regulatory risk flagged by HIMSS/HLTH 2025 coverage).

**Healthcare packaging axis**: *specialty* is how healthcare AI is packaged (Hippocratic 25+, Oracle 30+ specialties, Abridge/DeepScribe specialty tuning); persona first-names (Epic's Art) suit a monolith but don't scale to a versioned per-department catalog ("Cardiology v3, pinned" needs capability nouns).

**Multi-tenant day-1 provisioning**: the market pattern matching HOPE's requirements is **clone-on-provision from a platform-owned golden library** (idempotent seed at tenant creation), with each clone keeping a `sourceTemplateId + sourceTemplateVersion` back-reference to power a later non-destructive "newer platform default available — review & adopt" flow (Salesforce-template / Hippocratic-copy model). The shared NER service stays a true shared reference (single platform instance, no per-tenant copy). This maps directly onto HOPE's existing SYSTEM-tenant (`00000000-…`) seed architecture and the ASR-pipeline clone precedent.

**Candidate naming families** (detail in §6): (1) plain descriptive "Clinical AI: Agents/Skills/Pipelines"; (2) **Scribe family — Scribe / Listener / Insight** (recommended clinician-facing); (3) "Specialists" (specialty framing; autonomy-overclaim risk); (4) "Assistant + skills" (most conservative, undersells the loop); (5) care-team/crew metaphor (highest trust risk); (6) **governance-first neutral taxonomy: Agent Template → Agent → Version → pinned Default, Skills, Catalog** (recommended admin-facing, underneath family 2).

Key sources: [Bedrock agent versioning](https://builder.aws.com/content/2tgaWN2cB7eYWNJpiXaS9ueEvHW/amazon-bedrock-agent-versioning-complete-guide) · [Foundry dev lifecycle](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/development-lifecycle) · [Salesforce agent versions](https://developer.salesforce.com/blogs/2025/05/deploy-your-agentforce-agents-with-zero-downtime-using-agent-versions) · [LangSmith prompt tags](https://changelog.langchain.com/announcements/prompt-tags-in-langsmith-for-version-control) · [MLflow registry aliases](https://mlflow.org/docs/3.0.1/model-registry/) · [Google Gemini Enterprise Agent Platform](https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform) · [Databricks governing agents](https://www.databricks.com/blog/governing-ai-agents-scale-unity-catalog) · [Hippocratic App Store](https://www.hippocraticai.com/ai-agent-app-store) · [Oracle Clinical AI Agent](https://www.oracle.com/health/clinical-suite/clinical-ai-agent/) · [Celonis autonomy ladder](https://www.celonis.com/blog/difference-ai-assistants-copilots-agents) · [Azure SaaS catalog provisioning](https://learn.microsoft.com/en-us/azure/azure-sql/database/saas-multitenantdb-provision-and-catalog?view=azuresql)

## 4. Gap Analysis vs Use-Cases


| #     | Use-case                                                                               | Have today                                                                                                                                                                                                                                                                                  | Missing                                                                                                                                                                                                                                                                                                                                                    | Size                  |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| U1    | Day-1 department-agent set, copied per tenant                                          | Full precedent for **pipelines**: SYSTEM golden catalog → clone-on-provision with `sourceTemplateSlug` + `templateLocked` lineage → nightly pristine-copy resync → explicit `clone` to unlock (TASK-531). Rich 18-department template catalog exists as seed fixtures for 2 fixture tenants | Apply the same pattern to the department-agent catalog (prompt templates + department wiring + policy defaults). New-tenant provisioning today creates ONE bare GEN department with null prompt refs                                                                                                                                                       | M                     |
| U2    | Tenant admin create/update with versioning                                             | `/agents` screen; `PromptTemplate` + append-only `PromptVersion` under OCC; DRAFT→PUBLISHED→APPROVED lifecycle; department + personal scopes                                                                                                                                                | Nothing structural — polish only (approval currently global-admin-only; see U4 owner decisions)                                                                                                                                                                                                                                                            | S                     |
| U3    | Pin default agent version per department; default = latest                             | Department default *template* selection (`assignToDepartment` → prompt-id columns); per-doctor preferred template; APPROVED-gated resolution                                                                                                                                                | **Version pinning** — resolution is latest-wins; `activateVersion` is rollback-by-copy. Need the industry-standard movable pointer: serve `pinnedVersionNumber ?? latest APPROVED`                                                                                                                                                                         | S–M                   |
| U4    | Tenant admin controls harness loop (model, context, steps, thresholds, gold standards) | Tenant-editable: 5 sensor thresholds, maxRegen, gate SLAs, toolAllowlist; `PipelinePolicy` toggles per TENANT/DEPARTMENT/DOCTOR                                                                                                                                                             | (a) **No department scope on HarnessPolicy** (tenant-only); (b) model routing / loop-step toggles / safety keys are global-admin-only **by deliberate E3 owner decision** — devolving any of them is an owner re-decision, not a bug; (c) golden sets are tenant-scoped, synthetic-only, eval results not persisted to DB, no console screen (M-09, F-013) | M–L + owner decisions |
| U5    | Doctors use several capabilities concurrently                                          | One session already runs STT + live SOAP SSE + NER + harness assurance concurrently; key findings available via live entities + per-claim assurance SSE                                                                                                                                     | Product framing only: nothing binds the concurrent capabilities into named "agents"; a key-findings pop-up surface is a UI feature over existing SSE streams (TASK-543 territory)                                                                                                                                                                          | S (naming)            |
| A1–A3 | A coherent "agent" concept                                                             | UI already calls templates "agents"; `AgenticProvider`, `AgentTrajectory*`, "Agent Playground"                                                                                                                                                                                              | **No first-class agent entity** binding department + template(+version) + DNA policy + harness overrides; NER/transcription would over-claim "agent" per the autonomy ladder                                                                                                                                                                               | M                     |


Cross-cutting defects that undermine the agent story regardless of naming (already in the findings register): consultation NER paths bypass `AiTaskDefault` model routing (two regimes — playground proxy governs, clinical pipeline doesn't); `smr.live` routing key inert (D-26); `claimCheck.minBytes` dead knob (F-008 residue); golden-set/eval gate soft (F-013); DNA "redaction/rewrite" does not exist in code (style injection only).

## 5. Proposed Solution



### 5.1 Concept mapping (the two-layer vocabulary)

**Layer 1 — clinician-facing product names** (marketing; final pick = owner decision, §6): reserve **"Agent"-strength branding for the department documentation loop** (the only capability that plans, loops, and uses tools). Frame transcription as a supervised capability/pipeline and NER as a shared skill/service. Recommended family: **HOPE Scribe** (department agent) powered by **Listener** (transcription pipeline) + **Insight** (shared NER skill).

**Layer 2 — admin/governance vocabulary** (industry-standard, use verbatim in schema/UI): **Agent Template** (SYSTEM-owned blueprint) → **Agent** (tenant/department-configured instance) → **Version** (immutable snapshot) → **Default** (movable pointer that clinicians are served) → **Draft** (author-only). Container word: per-tenant **Agent Catalog**, seeded from the platform **Library**.

### 5.2 Data-model direction: a thin first-class `DepartmentAgent` binding

Introduce ONE new entity rather than remodeling the existing pieces — everything underneath already exists and is runtime-proven:

```
DepartmentAgent (tenant-scoped, OCC, soft-delete, WORM change log)
├─ tenantId, departmentId (FK), name, description, status
├─ promptTemplateId (FK)  + pinnedVersionNumber?   // null ⇒ track latest APPROVED  (U3)
├─ dnaStylePolicy: INHERIT | DISABLED               // per-agent gate over pipeline.dnaStyleEnabled
├─ harnessOverrides?: JSONB subset                  // ONLY tenant-tier keys (thresholds, maxRegen, gate SLAs, toolAllowlist)
├─ goldenSetId?                                     // department-scoped eval set (U4)
├─ isDefault (per department, atomic flip)          // U3 default-agent-per-department
└─ sourceAgentTemplateSlug?, templateLocked         // lineage — same contract as AsrPipeline (U1)
```

- **Resolution change** (small): `PromptResolutionService` tier-1 consults the department's default `DepartmentAgent` → its template at `pinnedVersionNumber ?? latest APPROVED` (serve `PromptVersion.content`, not the mutable row). Fallback chain unchanged.
- **Harness policy**: keep `HarnessPolicy` as the tenant/global spine; `fetch_policy` overlays the consultation's resolved `DepartmentAgent.harnessOverrides` for tenant-tier keys only — global-only keys structurally cannot appear in the JSONB (validated against `GLOBAL_ADMIN_ONLY_POLICY_KEYS`). This gives per-department loop control (U4a) without a schema change to HarnessPolicy and without touching the E3 posture.
- **Existing department prompt-id columns** become legacy read-fallback, migrated into `DepartmentAgent` rows by a backfill; the `/agents` screen becomes the Agent Catalog (template tab + agent tab).



### 5.3 Day-1 provisioning (U1) — reuse the pipeline template pattern verbatim

Promote the 18-department seed catalog into **SYSTEM-tenant Agent Templates** (golden library). At tenant creation, `provisionTenantAgentCatalog()` clones: departments (from a canonical department set or tenant-chosen subset) + agent rows (`templateLocked:true`, `sourceAgentTemplateSlug`) + their APPROVED template snapshots. Extend `PipelineTemplateResyncService`'s contract to agents (add missing, fast-forward pristine locked copies, never touch unlocked/drifted). Tenant admins `clone` to unlock and customize (U2). This is exactly the shipped TASK-531 machinery, applied to a second resource.

### 5.4 Eval-gated promotion (U4 "gold standards")

- Add `departmentId?` to `GoldenSet`; persist CI/on-demand eval results into the existing `EvalRun`/`EvalScore` tables (today JSON-only); surface golden sets + eval runs on the console (closes M-09 surface gap).
- **Promotion gate**: flipping a template version to APPROVED (or re-pointing an agent's pinned version) triggers an eval run against the agent's golden set; block or warn-on-regression per policy (Foundry publish-gate pattern; addresses F-013's structural half — the clinician-curated golden set content remains the owner-side long pole).
- Seed golden sets per the 4-bucket design: production sample + adversarial (code-switching, multi-speaker, negations) + edge cases + shipped-failure replays; wire gate-edit mining (`GateEditExemplar`, GAP-A1) as the incoming candidate stream.



### 5.5 DNA redaction/rewrite (A3 clause — net-new)

Keep DNA style strictly at the composition layer (versioned example-note profile; never alters fact selection, grounding, or hedging — research-backed guardrail). Add **redaction/rewrite as a separate, auditable transform stage** after generation and before persist: deterministic rules + optional LLM rewrite with its own sensor pass, WORM-logged per removal. Patient-friendly output, if wanted later, is a separate audience-tier generation.

### 5.6 Wiring fixes that should ride along (defects, independent of the concept)

1. Route consultation NER through `AiTaskDefault('nlp.ner')` like the playground proxy (unify the two model-resolution regimes).
2. Activate `smr.live` at the live-doc call site (D-26) so live vs finalize two-tier routing actually happens.
3. Surface the segment-citation evidence panel (click-to-source) in the production console at sign-off — the compliance-relevant grounding surface (GAP-A2; UI half).



### 5.7 Phasing


| Phase | Content                                                                                                                                     | Size |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| P1    | Vocabulary + catalog UI: rename/frame `/agents` as Agent Catalog; read-only agent view composed from existing rows; naming decision applied | S    |
| P2    | `DepartmentAgent` entity + version pinning + per-department default + resolution change (U3, A3 identity)                                   | M    |
| P3    | Golden library + clone-on-provision + resync (U1)                                                                                           | M    |
| P4    | Per-agent `harnessOverrides` (tenant-tier keys) + owner-decided knob devolution (U4a/b)                                                     | M    |
| P5    | Department golden sets + persisted eval runs + eval-gated promotion (U4c)                                                                   | M–L  |
| P6    | DNA redaction/rewrite transform (A3)                                                                                                        | M    |




### 5.8 Owner decisions needed


| #    | Decision                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-1 | Naming family pick (§6) — clinician-facing name for the three capabilities; keep or narrow the word "agent". Decided: follow recommendation.                                                                                                                                                                               |
| OD-2 | U4 scope: which currently-global-only knobs (if any) devolve to tenant admins — model routing (`smr.*`), loop-step toggles, safety keys — vs stay global per the E3 decision. Recommendation: devolve nothing safety-related; consider tenant-visible read-only "effective config" instead. Decided: follow recommendation |
| OD-3 | Template approval: keep APPROVED global-admin-only (current) or allow tenant-admin approval for tenant-created agents with global approval only for library templates. Recommendation: tenant-admin approval for their own templates + mandatory eval-gate. Decided: follow recommendation                                 |
| OD-4 | Whether the day-1 department set ships as departments+agents (creates org structure) or agents-only bound to tenant-created departments Decided: day-1 department set ships as departments+agents                                                                                                                          |
| OD-5 | Golden-set clinical SME ownership (pre-existing F-013 open item) Decided: no clinical SME for now, lets global and tenant-admins manage it                                                                                                                                                                                 |




## 6. Naming Proposal

Candidate families (full rationale in §3.2 research):


| #   | Family                   | T1 transcription       | T2 NER              | T3 department agent                             | Verdict                                                                                                                      |
| --- | ------------------------ | ---------------------- | ------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain descriptive        | Transcription Pipeline | Medical NER Service | Documentation Agent                             | Safe, forgettable                                                                                                            |
| 2   | **Scribe family** ⭐      | **Listener**           | **Insight** (Skill) | **Scribe** (e.g. "Cardiology Scribe v3")        | Recommended clinician-facing: builds on existing "Consultation Scribe" language, function-named = trust, scales by specialty |
| 3   | Specialists              | Capture                | Insight             | Cardiology Specialist                           | Autonomy-overclaim risk ("knows cardiology better than me")                                                                  |
| 4   | Assistant + skills       | Transcription skill    | Entity skill        | Documentation Assistant                         | Most conservative; undersells the agentic loop                                                                               |
| 5   | Care-team/crew           | —                      | —                   | Note-writer/Coder/Reviewer crew                 | Highest trust risk; premature                                                                                                |
| 6   | **Governance-neutral** ⭐ | Pipeline               | Skill               | Agent (Template→Agent→Version→Default, Catalog) | Recommended admin-facing, underneath family 2                                                                                |


**Recommendation**: two-layer — **Family 2 for clinicians** ("HOPE Scribe, powered by Listener + Insight"), **Family 6 for admins** (Agent Catalog with Templates, Versions, pinned Defaults). Do not brand the shared NER service an "agent" (stateless invoked skill; over-claiming autonomy is the one naming move the 2025-26 healthcare-trust literature consistently warns against). If the owner prefers a single word everywhere, "agents" for all three is workable commercially (Hippocratic/Oracle precedent) — the cost is precision, not compliance.

## 7. Sub-Ticket Breakdown (execution plan for the Sonnet-5 team)

Decisions OD-1…OD-5 are recorded in §5.8; the plan below reflects them plus the A4 action item. Each sub-ticket has its own README under `docs/implementation/` containing the full context, verified current-state facts, step-by-step plan, TDD test list, and gates — written to be executable without reading this parent ticket (though it is linked for depth).

| Ticket | Scope | Depends on | Size | Outcome (workflow `wf_0a1eda49-121`, 2026-07-23) |
|---|---|---|---|---|
| [TASK-545](../TASK-545-Disable-Local-Transcription/README.md) | Disable local (in-browser) transcription; backend-only enforcement (A4 action item) | — | S | ✅ Completed — SDK kill-switch + typed error, server clamp, console sweep. Follow-up: `UserPreferencesService.resolveEffectiveTranscriptionMode` server path (owner decision) |
| [TASK-546](../TASK-546-Department-Agent-Entity/README.md) | `DepartmentAgent` entity: DB → domain → service → admin API; version pinning; per-department default; resolution change (U3, A3 identity) | — | M | ✅ Completed — full stack; dev-DB migration applied additively via psql; test-DB (5433) migration still pending |
| [TASK-547](../TASK-547-Agent-Catalog-Console/README.md) | Agent Catalog console: `/agents` reframe, naming rollout (OD-1), read-only effective-AI-config view (OD-2) | 546 | M | ✅ Completed — 3-tab catalog + pin/default UI + harness-policy card; live-stack browser round-trip verified |
| [TASK-548](../TASK-548-Agent-Golden-Library-Provisioning/README.md) | SYSTEM golden library (departments + agents per OD-4), clone-on-provision, resync (U1) | 546 | M | 🟡 Partial — clone-to-customize (Part 4) done+gated; Parts 1–3 (golden seed, provisionTenantAgentCatalog, resync) deferred as one DB-gated batch |
| [TASK-549](../TASK-549-Eval-Gated-Promotion/README.md) | Tenant-scoped template approval (OD-3), department golden sets managed by admins (OD-5), persisted eval runs, eval-gated promotion (U4 gold standards) | 546 (schema) | M–L | 🟡 Partial — OD-3 approval-split done+gated; eval-run endpoint, promotion gate, schema, console deferred with exact specs in its README |
| [TASK-550](../TASK-550-Per-Agent-Harness-Overrides/README.md) | Per-agent `harnessOverrides` (tenant-tier keys only, OD-2) overlaid in `fetch_policy` (U4) | 546 | M | ✅ Completed — end-to-end incl. harness activity + provenance; replay 17/17; live runtime proof deferred (8868 busy) |
| [TASK-551](../TASK-551-DNA-Redaction-Rewrite/README.md) | DNA redaction/rewrite as a separate auditable post-generation transform (A3 clause) | — | M | 🟡 Partial — Python core (rule engine + fail-closed `apply_redaction` activity) done, replay green; workflow insertion + DB + TS + console deferred with exact insertion points |
| [TASK-552](../TASK-552-Agent-Plane-Wiring-Fixes/README.md) | Wiring fixes: consultation NER through `AiTaskDefault`, `smr.live` activation (D-26), click-to-source evidence panel at sign-off | — | M | ✅ Completed — all 3 lanes (Lane B core already fixed upstream in `c6c44de2f`; provenance added); runtime proofs deferred (8868 busy) |

**Run verdict (gate-sweep agent):** all 9 cross-package gates PASS — build:api 8/8 · database 853 · domains 1388 · applications 6796 · test:unit 17153 · vox 3561 + typecheck fully clean (the D-01 "3 pre-existing errors" no longer reproduce) · admin-console 1189 tests + 67-route build + lint clean · harness 985 + replay 17/17 · monorepo lint 29/29 (pre-existing warnings only). **Environment note:** the `fable-thinking` skill was NOT installed in the execution environment — every agent recorded the fallback in its README per contract and proceeded with the 5-phase + TDD discipline; install/register the skill before the follow-up sessions if the mandate should bind.

**Execution contract for every sub-ticket (mandatory, owner directive):**
1. The implementing Sonnet-5 session **MUST invoke the `fable-thinking` skill before any other work** in the session.
2. Follow the 5-phase lifecycle (`.claude/rules/01-development-workflow.md`) with TDD Red-Green-Refactor; paste actual gate output into the ticket README.
3. Do **not** commit. Stage (`git add`) completed work — uncommitted+unstaged work has been destroyed by concurrent sessions in this tree before.
4. **One implementing session per working tree at a time.** Parallel tickets must use separate git worktrees, and any worktree must be `git reset --hard fix/2605-review` first (worktrees spawn from `main` by default).
5. Update the sub-ticket README (Implementation Summary + Change History) and this §7 table's status as work lands.

Recommended waves: **W1** = 545 ∥ 546 ∥ 552 (disjoint surfaces) → **W2** = 547 ∥ 548 ∥ 550 → **W3** = 549, 551.

**Run 2 verdict (workflow `wf_fdd468e7-976`, 2026-07-23, post DB-reset):** TASK-548 was completed in full by a separate owner-triggered session (all 4 parts; dev+test DBs seeded; its "CASL grant gap" proved to be stale-DB only — runtime-proven fixed by the reseed, no code change). This run then delivered: **549 backend + console COMPLETE** (eval endpoint, EvalRunService, blocking promotion gate + `agentic.eval.promotionGate`, governance Eval panel, promote-exemplar flow); **551 nearly complete** (workflow insertion with new replay fixture — replay 18/18 green, DB + CRUD + double-gate + transport; remaining: event-handler last-mile wiring + console rules editor, both precisely specced in its README; transport safely no-ops until wired); **runtime proofs 6/7 PASS on the live stack** — 545 clamp, 546/548 e2e (28 specs), 550 policy overlay + provenance, 552 NER model-injection capture + `smr.live` SSE provenance, and the 549 live blocking-409 → repoint → 200 APPROVED sequence with persisted EvalRun/EvalScore (real LLM judge). Only proof 3b (TASK-550 trajectory-step evidence) is blocked environmentally: the shared harness Temporal worker predates the staged code — restart worker + :8866, then re-capture. **Gate sweep 2: all 9 gates green** (test:unit 17,229 · applications 6,851 · harness 998 + replay 18/18 · admin-console 1,211 · monorepo lint 29/29). `fable-thinking` still absent from the execution environment across both runs.

**Run 3 verdict (GATE-SWEEP-3, final read-only sweep, 2026-07-23):** No implementation work in this run — read-only gate re-verification of the tree as staged after Run 2. All 9 gates green: `build:api` (8/8 turbo tasks) · `@arcaai/database` build+test (26 files, 868 tests) · `@arcaai/domains` build+test (118 passed/2 skipped, 1,390 tests) · `@arcaai/applications` build+test (340 passed/1 skipped, 6,862 tests) · `pnpm test:unit` (988 files, 17,243 tests) · `@arcaai/vox` build+test+lint+typecheck (206 files/3,561 tests; lint 3 pre-existing warnings, unrelated to this program, 0 errors) · `@arcaai/admin-console` build+lint(`--max-warnings 0`, clean)+test (157 files/1,218 tests) · `pnpm py:harness:test` (998 passed) + `-k replay` subset (18/18 passed) · `pnpm lint` (29/29 turbo tasks, exit 0, no new errors — only pre-existing benign "use client"-bundling build notices and long-standing `ui-playground` warnings untouched by this program). One flaky-looking domains-package log line ("Error: vault-down" / "MCP token denied") is expected negative-path test output, not a failure — test summary line confirms all-green; not re-run. `git status --short`: every file this program touched is staged (73 `M `, 12 `A `); the only non-staged entries are the owner's own `.env.dev` (unstaged modify) and `.mcp.json` (untracked) — nothing was left modified-but-unstaged. `fable-thinking` skill invocation returned `Unknown skill` again (3rd run in a row it's absent from this environment). No processes were started, killed, or restarted — this run only ran build/test/lint commands, none of which required the dev stack; the pre-existing `api`/`harness`/`harness:worker` processes (pids 80030/81068/81071, started ~13:58–13:59 same day) were left untouched as out of scope for a read-only sweep.


**Program closure (2026-07-23):** the final gap found by the Run-2 live proof — `apply_redaction` computing then DISCARDING its RedactionManifest — is CLOSED and proven: new `workflow.patched("task-551-redaction-audit")` era threads `redaction_applied` + a PHI-free compact manifest through both persist sites into `SummaryMeta.redactionApplied` + Vault-Transit `encryptedRedactionManifest` (mirroring `citationsMap`), with a GUARDRAIL trajectory step; new replay fixture, replay suite 19/19 green (frozen pre-audit fixture also green ⇒ replay-safe); live proof: persistDraft 201 + psql `redactionApplied=t`, `vault:v1:` manifest at rest, rule id absent from plaintext. Bonus fix: `scripts/dev-service.sh` now wires `HARNESS_SERVICE_TOKEN` to the harness API/worker (ambient → `.env.dev` → dev-Vault seed), removing the silent dev-mode `reduced_assurance` 401. The two idle proof workflows at the clinician gate were terminated. **All 8 sub-tickets are now functionally complete** (TASK-551 in Review pending owner sign-off). Remaining owner-only items: commit; authenticated browser walkthrough (`/agents?tab=governance`, `/harness/observability`, `/playground/dna-writing-style`); install `fable-thinking` (absent in all runs) or drop the clause; optional dev-data cleanup (one proof SummaryMeta row on consultation `90000000-0000-0000-0001-000000000002`; dev gateway + harness worker left running on current code).

## Change History

- 2026-07-22 — Ticket opened; requirement analysis captured from owner message; 4 codebase-exploration passes + 2 external-research passes dispatched.
- 2026-07-22 — All six passes complete. §2 current-state (transcription / consultation+context+NER / harness loop / provisioning), §3 research (clinical best practices; naming/packaging), §4 gap analysis, §5 proposed solution (DepartmentAgent binding, version pinning, golden-library provisioning, eval-gated promotion, DNA redaction stage, phasing P1–P6), §6 naming proposal (two-layer: Scribe/Listener/Insight + Agent Catalog governance vocabulary). Status → Review; 5 owner decisions listed (§5.8).
- 2026-07-23 — Owner decisions recorded in §5.8 (OD-1/2/3 = follow recommendations; OD-4 = departments+agents day-1; OD-5 = admin-managed golden sets, no SME). Added A4 "local transcription agent" type + the disable-local-transcription action item (§1.1). §7 sub-ticket breakdown authored: TASK-545…552 with per-ticket READMEs for the Sonnet-5 team (mandatory `fable-thinking` skill, staging discipline, wave plan). Status → Completed (proposal accepted; execution moves to sub-tickets).
- 2026-07-23 — Execution workflow `wf_0a1eda49-121` completed (9 agents, sequential, sonnet-5/opus-4.8, ~3.7 h): 545/546/547/550/552 ✅ completed, 548/549/551 🟡 partial with precisely-scoped remainders in their READMEs; gate sweep all-green (§7 outcome column). Nothing committed — all sub-ticket work staged for owner review. `fable-thinking` skill absent from the execution environment (recorded per contract).
- 2026-07-23 — Completion workflow `wf_fdd468e7-976` (5 agents, ~4 h, post DB-reset; TASK-548 finished in parallel by an owner-triggered session): 549 ✅ complete (backend + console), 551 🟡 near-complete (two scoped items left), runtime proofs 6/7 PASS on the live stack (only the 550 trajectory capture blocked by a stale shared worker), gate sweep 2 all-green (§7 Run 2 verdict). Program tail: 551 last-mile wiring + rules editor, proof 3b re-capture after worker restart, authenticated browser passes, optional DTO surfacings.
- 2026-07-23 — GATE-SWEEP-3: final read-only gate re-sweep, no code changes. All 9 gates green (§7 Run 3 verdict); `git status` confirms everything the program touched is staged, only the owner's own `.env.dev`/`.mcp.json` remain outside staging. `fable-thinking` skill absent for a 3rd consecutive run.
- 2026-07-23 — **RUNTIME-FINISH run (final live-stack proofs).** The previously-shared dev-stack processes (started 10:47–10:51 by ENDED sessions) were verified orphan and, per contract, killed + restarted from CURRENT code: gateway :8868 fresh `pnpm build:api` (8/8, database+domains dists rebuilt) → single non-watch instance (PID 80030); harness FastAPI :8866 + Temporal worker restarted from staged code with the Vault-resolved `HARNESS_SERVICE_TOKEN` wired for outbound `fetch_policy`. Dev containers/Temporal untouched. Per-proof outcomes:
  - **DI boot check (549-flagged) — PASS.** The fresh API booted clean: `EvalServiceModule dependencies initialized`, `Nest application successfully started`, `eval-runs` routes mapped, ZERO DI/circular-dependency errors. No cycle from `EvalServiceModule` imports.
  - **Proof 3b (TASK-550) — PASS (the one blocked item, now unblocked).** Pinned `coverageThreshold=0.95` on default agent `78000000-…0001`, started `HarnessDocWorkflow` (the stale-schema `Failed decoding arguments` is gone), and read the live worker's `fetch_policy` `AgentTrajectoryStep`: `stats.overrides_source = {keys:[coverageThreshold], agentId:78000000-…0001, agentSlug:gen-default}`. Pin reverted to NULL. (Full evidence in TASK-550 README.) Also surfaced a dev-config gap: `dev-service.sh` doesn't give the worker the Vault `HARNESS_SERVICE_TOKEN`, so default-dev `fetch_policy` would 401 → silent `reduced_assurance`.
  - **Proof (TASK-551 DNA redaction) — BLOCKED (implementation gap, not environment).** The redaction ENGINE + manifest are proven deterministic (spans removed; manifest carries only spans/counts, no PHI plaintext) and the gateway double-gate + rule decryption/threading are code-verified; BUT the workflow **computes then discards** the `RedactionManifest` (`workflows.py` ≈L902–912) — no GUARDRAIL manifest trajectory step and no `redactionApplied` `SummaryMeta` marker are persisted (empirically confirmed on a live run; repo-wide grep = 0 non-test hits). Proof pieces (2) manifest step and (3) encrypted-manifest marker are therefore un-producible; the audit-manifest persistence is a genuine remaining item. (Full detail in TASK-551 README.)
  - **Proof (TASK-552 clinical NER variant) — SKIPPED with reason (optional).** The clinical `extract-entities` route is user-JWT (`@Authorize(['create','Consultation'])`), reachable only via interactive login (prohibited here); NLP is up but degraded and doesn't surface `model_name` in a readable log. The injecting resolver is present in the built code and identical to the playground path already PASS. (Detail in TASK-552 README.)
  - **Residual state (disclosed):** two idle harness workflows remain waiting at the 24h clinician gate (consultations `90000000-…0000-…0001` = 7 steps, `90000000-…0001-…0001` = 16 steps) — harmless additive dev-DB data; can be terminated via the Temporal UI if desired. Restarted services LEFT RUNNING on current code: API :8868 (80030), harness FastAPI :8866, harness worker; SMR :8862 / NLP :8864 / STT :8861 left as the prior (functional) processes. Note the harness now enforces its inbound `X-Service-Token` (a plain `pnpm dev:harness` restart reverts it to empty-token). `fable-thinking` STILL absent (`Unknown skill`) across all three runs — recorded per contract.
- 2026-07-23 — Program closure: TASK-551 audit-manifest persistence landed (new redaction-audit era, replay 19/19, live psql proof) + dev-service.sh HARNESS_SERVICE_TOKEN wiring. All 8 sub-tickets functionally complete; only owner-side items remain (commit, browser walkthrough, fable-thinking install).
