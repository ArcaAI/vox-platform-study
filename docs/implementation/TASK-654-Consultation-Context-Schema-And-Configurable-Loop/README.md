# TASK-654 — Tenant-Defined Consultation Context & Reasoning Consultation Loop

- **Status:** Pending (plan approved in principle; sub-tickets not yet created)
- **Type:** feature + refactor (the majority of the work extends existing machinery)
- **Requested:** 2026-08-11 (owner)
- **Baseline:** `dev-2.1` @ `a61df126b` (clean tree)
- **Sub-tickets:** TASK-655 … TASK-668 — full specs in [execution-plan.md](./execution-plan.md)
- **Related:** TASK-544 (agent platform concept, accepted), TASK-546/547/550 (DepartmentAgent + overrides + console), TASK-531/548 (golden-library clone + resync precedent), TASK-549 (eval-gated promotion), TASK-551 (redaction transform), TASK-339/340 (live documentation plane), TASK-355 (optimistic delivery), TASK-635 (capability-keyed template bindings)

> **Scope exclusion.** The v1 compatibility surface (`@arcaai/vox/compat`, `src/compat/**`, the `compat` tsup entry, `docs/Compat-API-Reference.md`) is **out of scope and must not be edited**. See §6.4 — compat is a thin client of core, so the exclusion extends to *shape changes* in shared SDK modules, not just to files under `src/compat/`.
>
> A second exclusion was stated by the owner but truncated in transmission. It has not been applied. **Confirm before execution begins.**

---

## 1. Requirement Analysis

### 1.1 Requirements (owner)

| # | Requirement |
|---|---|
| R1 | A tenant admin can **define a consultation context schema** — the kinds of context a consultation carries |
| R2 | A client can **automatically discover** that schema and build its workflow from it, sending context during a live consultation and receiving data back |
| R3 | A tenant admin can **manage and configure the harness loop**, setting behaviour per context condition |
| R4 | The **loop performs those actions** during a live consultation |

Worked examples: **E1** a schema of audio stream / work note / case note / attachment; **E2** audio stream → realtime STT, transcript becomes raw consultation context; **E3** an image attachment → VLM extracts its text; **E4** at end of consultation, finalize a SOAP note from a template with gates, findings and suggestions returned to the client.

### 1.2 Decisions taken during design (2026-08-11)

| # | Decision | Consequence |
|---|---|---|
| D1 | Long-lived signal-driven workflow, one per consultation | `HarnessDocWorkflow` becomes an unmodified child — its ~10 `workflow.patched` eras and replay fixtures stay valid |
| D2 | Fully tenant-defined context **kinds** | Resolved by each kind declaring one of five platform **primitives** (§4.1) |
| D3 | The main agent **reasons** | LLM planner runs as a Temporal *activity*, so its decision is recorded in history and replays deterministically |
| D4 | Client discovers the schema and builds against it | Runtime discovery is the wire contract; codegen is an accessory |
| D5 | SOAP note structure stays in the existing 3-tier template resolution | Schema declares output **envelopes**, never note sections |
| D6 | Loop config lives **on the agent** | A generalisation of `DepartmentAgent.toolConfig`, which already exists |
| D7 | Several agents live per consultation; the **primary owns the note and gate exclusively** | Orchestrator + specialists with a single writer |
| D8 | Tenant admins get a **constrained goal / tool / guardrail form**, not free-text agent instructions | Free-text prompt authoring stays where it is — approval-gated `PromptTemplate` |
| D9 | Tenants **can** configure past the clinical safety gate | Contained by *placement* (enforcement outside the agent's reasoning path), not by permission |
| D10 | Promotion is admin-chosen, **any tenant to any tenant** | No platform environment concept; authorization is "actor holds manage rights on both tenants" |
| D11 | **No rule engine.** Subscriptions + goals, with `always` / `never` as the compliance envelope | §4.3 |
| D12 | Primary **adjudicates**; the clinician finalises | Adjudication must be inspectable (§4.5) |
| D13 | **`LiveDocumentationService` stays** as the reflex lane; the loop dispatches it as an action | §3.4, §4.4 — the single most consequential current-state finding |

### 1.3 Requirement verdicts against the code

| # | Verdict | Evidence |
|---|---|---|
| R1 | **Missing entirely** | `ContextItemType` is a closed Prisma enum (`enums.prisma:224-237`); zero schema tables repo-wide; no schema builder in the console |
| R2 | **Mechanism exists, content missing** | `GET /tenant/me/config` runs at `AgenticProvider` mount with cache + `configReady` gate, but returns a flat `{key,value,namespace}[]` of feature flags |
| R3 | **Missing entirely** | No rule/condition model; loop-shape knobs are tier 10–19, so a tenant admin gets 404 on `/agentic-policy` |
| R4 | **Partial and mis-shaped** | Two orchestrators exist — a durable one-shot harness and a soft-state live loop — neither configurable, neither event-driven per context item |

---

## 2. Design Constraints (non-negotiable)

| # | Constraint | Consequence |
|---|---|---|
| C1 | Temporal workflow bodies are deterministic and replay-compatible | Tenant config is read **once** per run into pinned state. LLM calls are activities. |
| C2 | In-flight runs must keep replaying | `HarnessDocWorkflow` carries ~10 patched eras + fixtures (`test_replay_compat.py`). **Compose it as a child; do not edit its body.** |
| C3 | PHI is encrypted at rest and fail-closed on egress | Every tenant-declared kind resolves to a known PHI class and storage mode before a byte is accepted |
| C4 | Compliance controls are universal | Encryption, egress screen, WORM audit chain, attestation hold in every tenant, because real PHI is present in every tenant (owner-confirmed) |
| C5 | Cross-tenant access returns 404, not 403 | Schema/agent/promotion resources follow the same posture |
| C6 | House governance shape is resource → immutable version → movable pinned default | Already used by `PromptTemplate`/`PromptVersion`, `AsrPipeline`/`AsrPipelineVersion`, `DepartmentAgent` pinning |
| C7 | Global `whitelist + forbidNonWhitelisted + forbidUnknownValues` | Tenant-defined payloads ride **one declared envelope field**, validated in the service layer |
| C8 | The SDK's compat surface is a thin client of core | SDK changes to shared modules are **additive only** (§6.4) |

---

## 3. Current State Evaluation

Verified 2026-08-11 by seven code-exploration passes against `dev-2.1` @ `a61df126b`. File:line references will drift.

### 3.1 Context model — closed enum, no schema layer

`ContextItem` (`consultation.prisma:73-159`) is the single container for consultation content, discriminated by the closed enum `ContextItemType` (`enums.prisma:224-237`): `AUDIO_RECORDING | WORKNOTE | RAW_SUMMARY | MODIFIED_SUMMARY | PRE_SUMMARY | NAMED_ENTITY | TRANSCRIPT | CASE_NOTE | ATTACHMENT | SIGNED_NOTE`. Source is `USER | AI | SYSTEM | TRANSCRIPTION`.

A repo-wide search for `ConsultationSchema`, `ContextSchema`, `FormDefinition`, `FieldDefinition`, `CustomField`, `MetadataDefinition` returns **zero matches**. Adding a context kind today is a Prisma migration.

**Write path** (the extension point for schema validation):

```
consultation.controller.ts:626-636  addContext → verifyConsultationOwnership → contextService.addContext
context.service.ts:167-256          ContextService.addContext
  :180   assertParentInScope (tenant guard)
  :182-186 imperative kind check — the ONLY kind-aware validation today
  :188-197 ContextItemFactory.CreateContextItem
  :208   encryptContent  → encryptPhiFields → ContextItemRepository.encryption.ts:88-97
  :210   contextItemRepository.create
  :214-220 ContextItemVersionFactory.CreateInitialVersion
  :222-227 broadcastSysEvent(ResourceCreated)
  :235-253 eventEmitter.emit(ConsultationPipelineEvent.ContextAdded)
```

`AddContextRequest` (`add-context.request.ts:12-53`) is one flat DTO with `@IsEnum(ContextItemType) type` and everything else optional. `metadata` is documented as a schema-less escape hatch. There is **no discriminated-union validation pattern anywhere in the codebase** to copy.

**PHI encryption** is via Vault Transit key `hope-phi`, guarded by `encryptPhiFields` (`phi-field-encryption.ts:54-80`, gate at `:32-34`), implemented in `ContextItemRepository.encryption.ts:88-105`, primitives in `field-encryption.ts:26,83-106`. The plaintext `content` column was dropped (migration `20260618100000_task_369_phase3b_contextitem_encrypted_content`).

### 3.2 Two event systems, easily conflated

- **`SysEventType`** (`sysEventType.enum.ts:1-9`) has **no** `ContextAdded` member — context creation broadcasts generic `ResourceCreated` with `resourceType = ContextItem`.
- **`ConsultationPipelineEvent.ContextAdded`** (`consultation.events.ts:39`) is the in-process EventEmitter2 event that matters. Emission is **gated** by `LIVE_CONTEXT_TYPES = {WORKNOTE, CASE_NOTE, ATTACHMENT}` (`context.service.ts:64`). **Transcripts do not emit it** — this must widen for the cascade (§4.2).

Consumers today: `LiveDocumentationService.handleContextAdded` (`live-documentation.service.ts:882-902`) and `OcrEnrichmentProcessor.handleContextAdded` (`ocr-enrichment.processor.ts:85-86`). A new consumer needs only `@OnEvent(...)` — **no route or controller change**. That is the precedent for wiring the loop.

### 3.3 The harness loop — durable, one-shot, hardcoded

`HarnessDocWorkflow` (`workflows.py:222-1547`), 17 activities. Trigger: `TranscriptionCreated` → `ConsultationEventHandler.handleTranscriptionCreated` (`consultation-event.handler.ts:94-258`), whose branch is:

```
:146  if (config.harnessEnabled) {
:172    await this.harnessGatewayService?.start(consultationId, {...});
:190    return;
:193  }  // else legacy BullMQ summary path
```

`resolvePipelineConfig` (`:461-515`) resolves `harnessEnabled` at `:501` — per-consultation `metadata.pipelineConfig` override beats the doctor→department→tenant→SYSTEM cascade.

`HarnessGatewayService` (`harness-gateway.service.ts`) is the sole gateway→harness client: `start` (`:141`), `signalApproval` (`:167`), `signalEdit` (`:188`), `runEval` (`:209`), `buildHeaders` (`:222`). Every method is the same shape — a new signal copies `signalEdit` verbatim.

**Worker registration** (`worker.py:243-254`): `workflows=[HarnessPingWorkflow, HarnessDocWorkflow]`, `activities=[ping_activity, *DOCUMENT_ACTIVITIES]`. Replay fixtures live in `tests/unit/temporal/fixtures/`, captured by `_capture_replay_fixture.py`, asserted in `test_replay_compat.py`.

**Extension seams that exist**: `workflow.patched(...)` eras; `ClaimCheckRef` for large payloads; `HarnessPolicy.mcpServers` tool registry (one tool wired: `validate_codes`).
**Seams that do not**: `COMPUTATIONAL_SENSOR_NAMES` (`sensors/registry.py:19-25`), `HIGHEST_HARM_SENSORS` / `REGEN_FIXABLE_SENSORS` (`aggregator.py:55-71`) are literal tuples.

### 3.4 `LiveDocumentationService` — the finding that shapes the architecture

`live-documentation.service.ts`, 2,403 lines, one `@Injectable()` singleton. **This is a second orchestrator, and the earlier draft of this document never mentioned it.**

- **Lifecycle**: `start()` (`:521`) is synchronous fire-and-forget, called only from `consultation.controller.ts:472`; `stop()` (`:764`) from `:498` and `onModuleDestroy` (`:505-514`).
- **Triggers**: segment threshold (`ingestSegment` `:831`, flush at `:870-872`), idle debounce (`scheduleFlush` `:1580`), and `@OnEvent(ContextAdded)` (`:882`). Thresholds are settings-registry knobs (`agentic.context.liveFlush.*`) resolved per flush (`:1940-1946`), with a min-interval throttle (`:949-953`, default 4000ms).
- **Calls**: SMR `/api/v1/generate` (`:2036`), NLP `/api/v1/classify/tokens` (`live-tool-registry.ts:190`), Guardrail `/api/guardrail/ground`.
- **Clinical invariants**: SMR before NER (`:1063-1066`); **NER runs over the raw transcript delta, never the generated note** (`:1128-1143`); `groundEntitiesToNote` (`:2103`) drops entities absent from the rendered note. That last one closes the hallucination-laundering path.
- **Session model — soft state.** `sessions = new Map<string, LiveSession>()` (`:290`) in process memory. Redis holds only derivatives (`:last`, `:lock`, `:agent`, stats). **On a hard crash the transcript buffer is lost.** The only durable artifact is one upserted `PRE_SUMMARY` `LIVE_SOAP_SNAPSHOT` `ContextItem` (`persistDurableSnapshot` `:1779`, default every 30s).
- **Tests**: 14 files / ~4,174 lines, including `live-soap-prompt-checksum.test.ts`, which pins the **sha256 of prompt bytes** against the seeded SYSTEM template. That checksum is what makes the fail-open code-default tier clinically defensible (`:591-596`).

**`sessionAgentId` continuity** (the best-engineered chain in the feature — preserve end to end): freeze at `start()` (`:578` → `ensureAgentResolved` `:628`, three-tier Redis-adopt → lineage-repin → fresh resolve, never rejects); cached per flush (`:963`); stamped onto the snapshot (`:1793-1798`); read by the single reader `readLiveAgentLineage` (`live-agent-lineage.ts:18-23`); written to `SummaryMeta.sessionAgentId` (`harness-internal.service.ts:756`, `summary.service.ts:533`) and back as `pinnedAgentId` (`harness-internal.service.ts:599`) — so the agent that wrote the live note finalizes it.

**`warmStartEnabled` is vestigial.** It appears in exactly two lines of `apps/harness/src` (`models.py:307`, `:371`) and is never read by `workflows.py`/`activities.py` — prompt assembly happens in TypeScript (`assemble_prompt` `activities.py:922-957` calls back into `HarnessInternalService.assemble`). The real handoff is `injectPriorDraft = liveLineage !== null || resolveWarmStartEnabled(tenantId)` (`harness-internal.service.ts:552`) → `preSummaryText` (`:594`) → the `{pre_summary_text}` template variable.

### 3.5 Duplication that already exists

This is the "nearly refactoring" work the owner named. All of it is on the LiveDoc↔harness seam the loop will straddle.

| Concern | Copies today |
|---|---|
| **Live-snapshot resolution** | **four** — `findLiveSnapshotRow` (`live-documentation.service.ts:1860-1866`), `loadLiveSoapSnapshot` (`harness-internal.service.ts:1265-1274`), `resolveWarmStartPreSummary` (`summary.service.ts:1476-1486`), and a **byte-identical** copy (`summary.processor.ts:344-356`). All reimplement `ContextItemRepository.findLatestPreSummaryWithDecryptedContent` |
| **NER via `/classify/tokens`** | **four** callers — `live-tool-registry.ts:175-211`, `activities.py:671`, `ner.processor.ts:219`, `summary.service.ts:1571` |
| **Groundedness** | **two** implementations of one clinical question — NLI-over-HTTP (live plane) vs LLM judge (`activities.py:1599-1609`) |
| **Entity→note grounding** | **two** — `groundEntitiesToNote` (`:2103`) lexical, `provenance.py:79` span-mapping |
| **Publishing** | two channel/relay pairs, the second documented as *mirroring* the first |

Build the loop naively and the snapshot resolver becomes a **fifth** copy and NER a **fifth** caller.

### 3.6 Attachments — a live bug on the path E3 needs

Upload works: `storage.controller.ts:157-241` stores the object and creates a `Media` row, returning **both** `key` and `mediaId` (`:219-235`). `Media.uri` is the canonical `s3://<bucket>/<key>` (`:229`).

Three defects, and they interact:

1. **`OcrEnrichmentProcessor` treats `mediaId` as a storage key** — `getObject({ bucket: this.ocrBucket, key: mediaId })` (`:110-119`). It never reads the `Media` row.
2. **The caller sends the storage key as `mediaId`** — `context-panel.tsx:101,110` destructures only `key` and discards the returned `mediaId`. Same pattern in `use-dual-capture.ts:107-115`.
3. Consequently the two bugs cancel for OCR, but `resolveMediaUrls` (`context.service.ts:986-1031`) does it **correctly** — `mediaRepository.findAll({ id: { in: mediaIds } })` — so it matches nothing and **every attachment added through that flow silently never gets a presigned download or thumbnail URL.**

Fixing one side alone breaks the other. `parseStorageUri` (`context.service.ts:80-89`) is private and should be promoted to a shared util.

The SDK adds a fourth layer: `AddContextInput` (`context.ts:129-138`) has **no `mediaId` field** though `AddContextRequest` does, and `addAttachment` takes text only.

### 3.7 Vision — does not exist

`GenerateRequest.prompt` is `str` (`requests.py:79-102`); `LLMProvider.generate` is text-in/text-out (`providers/base.py:40-61`); all nine adapters build a plain-string content field. Deliberate — `smr-proxy.controller.ts:974-987` states attachments are OCR'd to text before SMR sees them.

Real OCR exists in `apps/nlp` (PyMuPDF + RapidOCR, `document_extractor.py:1-136`). Task keys (`ai-task-default/constants.ts:26-39`) number 12, with no `vlm.*`/`vision.*`/`ocr.*`. `ModelCategory.VISION`, `MULTI_MODAL`, `IMAGE_TEXT_TO_TEXT` and `VISUAL_QUESTION_ANSWERING` **exist in the enums and are used by zero seeded rows** — dead vocabulary awaiting use.

Smallest adapter lift: Bedrock/Anthropic (list-shaped content already) → OpenAI-compat/Azure/OpenAI (string → parts) → Ollama (unused `images` key). llama.cpp `/completion` stays text-only.

### 3.8 Agent, config and console

- **`DepartmentAgent` is many-per-department** — unique on `(tenantId, departmentId, slug)` (`department-agent.prisma:99`); `isDefault` is a plain boolean flipped atomically. It already carries five capability-keyed template bindings, `toolConfig`, `llmOverrides`, `harnessOverrides`, `goldenSetId`, and clone lineage.
- **Exactly one agent acts per consultation** — `resolveDepartmentAgent` (`prompt-resolution.service.ts:834-882`) picks the session-pinned agent or the department default. No fan-out, no supervisor. Multi-agent is **net-new capability**, not latent.
- **Validator pattern to copy**: `constants.ts` holds `LIVE_TOOL_KEYS` (`:61`), `TENANT_TIER_HARNESS_OVERRIDE_KEYS` (`:16-28`), `AGENT_LLM_OVERRIDE_TASKS` (`:73`) and pure `*Problems()` functions; `departmentAgent.service.ts:535-575` wraps each in a thin `validateX()` that throws `BadRequestException`.
- **Cross-tenant copy is SYSTEM → tenant only.** `DepartmentAgentService.clone` 404s on a foreign source. `provisionTenantAgentCatalog` (at creation) and `AgentTemplateResyncService` (nightly, four conservative rules) run under an elevated tenant-less context because `DepartmentAgent` is absent from `SYSTEM_SHARED_READ_MODELS`.
- **No environment/tier on `Tenant`** — `plan` is commercial (`ENTERPRISE|PRO|TRIAL|STARTER`).
- **`EvalPromotionGateService`** fires on exactly two transitions — template `approve` (`prompt-management.service.ts:469-500`) and agent `pin` (`departmentAgent.service.ts:275-329`) — defaulting to `block` and failing safe.
- **Console has no rule builder and no schema builder.** Every surface is a fixed DTO in a fixed form.

### 3.9 Config and SSE extension points

- **`GET /tenant/me/config`** (`my-tenant.controller.ts:53-76` → `tenant.service.ts:1145-1204`) returns a flat paginated list of `GlobalSetting` rows, each with a scalar `value`. One synthetic computed row is appended (`buildLocalRawCaptureRow` `:152-174`) — the precedent for server-computed additions. **A nested schema bundle does not fit**; every other structured tenant config in this repo (`tenant-stt-config`, `tenant-tts-config`, `tenant-storage-config`, …) is its own controller. → new sibling endpoint.
- **SSE exemplar** (trajectory): channel prefix `agent-trajectory.service.ts:68`, published at `:345` via `republishToLiveView` (`:339-356`), relayed at `consultation.controller.ts:566-608` with `TRAJECTORY_HEARTBEAT_MS` (`:177`) merged at `:589`, guarded by `@TenantOwnedResource` + `@StreamScope`. A brand-new stream = publisher service with its own prefix + `HarnessInternalController` POST + `ConsultationController` `@Sse()` route + DTO.
- **Harness internal API**: `@Public()` + `@UseGuards(HarnessServiceTokenGuard)` at `harness-internal.controller.ts:164-166`, prefix `internal/harness`. Best-effort callbacks use `@HttpCode(200)`; durable writes take `@Headers('Idempotency-Key')`.
- **Settings registry**: descriptor arrays per domain in `settings-registry/descriptors/`, spread into `HOPE_SETTINGS_REGISTRY` (`registry.ts:30-104`). A `tier: 'global-kv'` key is served automatically by `EffectiveSettingsService.resolveEffective` (`:108-112`).

---

## 4. Proposed Architecture

### 4.1 Tenant vocabulary over platform substrate (D2)

A tenant-defined kind declares one of five **primitives**, and the primitive is what the engine reasons about:

| Primitive | Storage | Existing machinery |
|---|---|---|
| `STREAM_AUDIO` | STT session + `AudioRecording` | `SttWsGateway`, Redis streams, `AsrPipeline` |
| `TEXT` | `ContextItem.encryptedContent` | today's `CASE_NOTE`/`WORKNOTE` path |
| `DOCUMENT` | `Media` + object storage, text via OCR | `OcrEnrichmentProcessor` → NLP `/extract` |
| `IMAGE` | `Media` + object storage | storage exists; **processing does not** (§3.7) |
| `STRUCTURED` | encrypted JSON validated against declared fields | one new `ContextItemType` value |

`ContextItem.type` keeps its meaning (so every existing row, query and encryption path is untouched); `kindKey` and `contextSchemaVersionId` are added as the tenant-facing discriminator above it. Schema-editor rejection of an unknown primitive is the enforcement point.

### 4.2 The context bus and the cascade

Everything is a context item on one bus; an action's output re-enters as context and can match further subscriptions. That is what makes E2 (audio → transcript) and E3 (image → text) the same mechanism.

**Required change**: `LIVE_CONTEXT_TYPES` (`context.service.ts:64`) must widen to emit `ContextAdded` for transcripts and derived kinds. Because `LiveDocumentationService` and `OcrEnrichmentProcessor` both consume that event, widening it changes their input set — each consumer needs an explicit kind filter before the widening lands.

**Termination**: derived context carries a depth counter; per-consultation action and token budgets are enforced; cycle detection on `(agent, kind)` pairs.

### 4.3 Agent configuration, not rules (D8, D11)

An agent declares: `role` (PRIMARY | SPECIALIST), `subscribedKinds` (with an optional filter), `writeScope` (which output kinds it may produce), a constrained `goal`, a tool allowlist, a selected guardrail profile, and the compliance envelope `always` / `never`. Reflex bindings derive from the primitive→capability map; everything conditional, ordered or judgement-based belongs to the reasoning primary.

Validators follow the existing `constants.ts` + `*Problems()` + thin `validateX()` pattern exactly (§3.8).

### 4.4 Runtime: two planes, one orchestrator (D13)

```
ConsultationLoopWorkflow (new, durable, one per consultation)
├─ pins (contextSchemaVersionId, agentConfigVersionId) at start
├─ signals: contextAdded, consultationEnding, cancel  (+ approval/edit forwarded)
├─ dispatches ACTIONS:
│    livedoc.start / livedoc.stop      → LiveDocumentationService (UNCHANGED)
│    vision.extract_text               → new (TASK-662)
│    document.extract_text             → NLP /extract (exists)
│    nlp.extract_entities              → exists
│    harness.finalize                  → HarnessDocWorkflow as CHILD (UNCHANGED)
│    client.emit                       → consultation:loop:{id} → SSE
└─ specialists run as CHILD workflows (own history budget, own failure isolation)
```

**Why LiveDoc is not absorbed**: 200–400 flushes per consultation would be the wrong Temporal workload; the generation-counter/`AbortController` supersede mechanism has no clean workflow analogue; the SSE relay would remain in the gateway regardless; and 4,174 lines of tests including a prompt-byte checksum underwrite the current safety argument.

The `LIVE_SOAP_SNAPSHOT` + `metaData.agent` lineage seam is inherited unchanged, so `harness.finalize` picks up the live note through the existing `{pre_summary_text}` path with **no change at all**.

**Temporal mechanics** (hard constraints): 51,200-event / 50MB ceiling → planned `continue_as_new` checkpoints; >2MB payload soft-error → `ClaimCheckRef` mandatory; signals must not call activities directly and need serialisation plus `@workflow.init`; specialists as children need explicit `ParentClosePolicy`.

### 4.5 Reasoning placement (D3, D12)

Reasoning goes to **planning and verification, not generation** — supported by *When Reasoning Hurts* (arXiv 2605.24902: LLM-judge score 4.10 → 3.28 with reasoning enabled on SOAP generation) and by the existing SMR/Guardrail split. Replanning happens at **checkpoints**, not per event (*Learning When to Plan*: an intermediate frequency beats per-step).

The primary adjudicates specialist disagreement; the clinician finalises. Adjudication must be **inspectable** — one reconciled note, with the disagreement and the basis visible on the existing evidence surface.

**Known trap**: adjudication *is* clinical inference, and `entity_faithfulness` / `coverage_omission` are lexical. *Beyond Literal Summarization* (arXiv 2604.14829) finds lexical evaluation reports 35% hallucination where inference-aware evaluation gives 9%. A good reconciliation will therefore score worse than a parroted one. **Measure before shipping the primary.**

### 4.6 Safety placement (D9, C4)

The floor is **architectural, not permissive**: the guardrail check runs at a boundary the agent cannot route around (the AWS AgentCore pattern — enforcement outside agent code). Compliance controls are universal; clinical-assurance controls are tenant-configurable, with an explicit typed acknowledgement when a check is weakened and a WORM record of every such change.

### 4.7 Client contract (D4)

New sibling endpoint (not `/tenant/me/config` — §3.9), JSON Schema draft 2020-12 as the wire artifact, immutable version + ETag, session pins its version, additive-only without a version bump, version carried in a header on every write, and an MCP-style `listChanged` notification riding the SSE plane. Client-side validation uses **valibot, already a bundled dependency** (`package.json:66`) — no new validator.

---

## 5. Risks

| # | Risk | Mitigation |
|---|---|---|
| RK-1 | Building the loop adds a fifth snapshot resolver and a fifth NER caller | TASK-655 collapses them **first**, as a prerequisite |
| RK-2 | Widening `LIVE_CONTEXT_TYPES` changes LiveDoc and OCR input sets | Add explicit per-consumer kind filters **before** widening |
| RK-3 | SDK change breaks compat at a distance | Additive-only rule on shared modules + a named build-verification step against `apps/compat-playground` |
| RK-4 | Unbounded cascade between specialists | Depth counter, per-consultation budget, `(agent, kind)` cycle detection |
| RK-5 | Workflow history exceeds Temporal ceilings | Planned `continue_as_new`, claim-check payloads, specialists as children |
| RK-6 | Lexical sensors penalise correct adjudication | Measure independently before the primary ships (§4.5) |
| RK-7 | `mediaId` fix breaks OCR if landed one-sided | Both sides in one ticket, one commit |
| RK-8 | Promotion is the largest net-new surface and was least discussed | Own ticket; eval re-runs at target; corpus never moves |
| RK-9 | `ContextItemType` / `ResourceType` enum parity missed | Dual-file parity + `resourceType.enum-parity.test.ts`; TASK-366 is the precedent failure |
| RK-10 | Concurrent agents destroy uncommitted work | Worktree-per-code-ticket; docs in the shared tree |

---

## 6. Execution

See **[execution-plan.md](./execution-plan.md)** for per-ticket specs, model tiers, waves and the agent contract.

### 6.1 Sub-ticket index

| Ticket | Scope | Wave | Tier | Status |
|---|---|---|---|---|
| TASK-655 | Collapse the live-snapshot resolver onto the repository helper | W0 | sonnet-5 | ✅ merged `09d8d0f7c` |
| TASK-656 | `mediaId` correctness both sides + promote `parseStorageUri` | W0 | sonnet-5 | ✅ merged `34ff3a0ea` |
| TASK-657 | Vision capability in SMR + `vlm.extract` task key + vision model seed | W0 | sonnet-5 | ✅ merged `b3d3fe590` |
| TASK-669 | Remove the deprecated `apps/ui-playground` (owner-requested, added 2026-08-11) | W0 | sonnet-5 | ✅ merged `a18412a9e` |
| TASK-658 | Context schema data model, validation, discovery endpoint | W1 | opus-4.8 | ✅ merged `55fa735c5` |
| TASK-659 | Agent config extension + `DepartmentAgentVersion` + validators | W2 | sonnet-5 | ✅ merged |
| TASK-660 | Loop event plane: cascade widening, loop signals, `consultation:loop:{id}` SSE | W2 | sonnet-5 | ✅ merged |
| TASK-661 | Schema compatibility, versioning and lifecycle guarantees | W2 | sonnet-5 | ✅ merged `8ea84ae62` |
| TASK-662 | `ConsultationLoopWorkflow` — mechanical loop, actions, child finalize | W3 | opus-5 | ✅ merged `43a4dc788` |
| TASK-663 | Agent promotion between tenants | W3 | opus-4.8 | ✅ merged — ⚠ cross-tenant e2e (OI-3) authored but NOT RUN |
| TASK-664 | Reasoning primary + specialists + adjudication | W4 | opus-5 |
| TASK-665 | SDK: schema discovery, validated context add, event hook | W4 | sonnet-5 |
| TASK-666 | Admin console: context schema editor | W4 | sonnet-5 |
| TASK-667 | Admin console: agent configuration form | W4 | sonnet-5 |
| TASK-668 | SDK codegen CLI | W5 | sonnet-5 |

### 6.2 Waves

```
W0  655 ∥ 656 ∥ 657        (prerequisite refactors + independent capability)
W1  658                     (DB — blocks everything downstream)
W2  659 ∥ 660 ∥ 661
W3  662 ∥ 663
W4  664 ∥ 665 ∥ 666 ∥ 667
W5  668
```

### 6.3 Working agreement

- **Worktrees for code tickets**, shared tree for documentation. Every worktree must be explicitly `git reset --hard dev-2.1` — worktrees spawn from `main` by default in this repo.
- **Commit per ticket, merge to `dev-2.1` locally. Do not push. Do not open a merge request.**
- One implementing session per worktree at a time.
- Paste real gate output into each ticket README; never claim completion without it.

### 6.4 Compat exclusion — the operative rule

Compat is a **thin client of core**, not a fork: `ArcaCompatProvider` renders `<AgenticProvider>` (`ArcaCompatProvider.tsx:61`); there is no parallel client, store or provider. It imports directly from `src/types/*` (`AgenticConfig`, `Consultation`, `AudioProcessingConstraints`), `src/core/AgenticClient`, `src/core/SSEClient`, `agenticStore` selectors, `useArcaAudio` and `useArcaSession`.

**Therefore**: do not edit `src/compat.ts`, `src/compat/**`, the `compat` tsup block, the `"./compat"` exports entries, or `docs/Compat-API-Reference.md` — **and** treat those six shared modules as additive-only. New optional fields and new methods are safe; signature or shape changes are not. Verification step: `apps/compat-playground` must build.

---

## 7. Implementation Plan

Not started. Each sub-ticket authors its own README from the spec in [execution-plan.md](./execution-plan.md) as its first action, then follows the 5-phase lifecycle with TDD.

## 8. Implementation Summary

Not started.

## Change History

- 2026-08-11 — **Wave 0 complete and merged to `dev-2.1`.** TASK-655 (`09d8d0f7c`), TASK-656 (`34ff3a0ea`), TASK-657 (`b3d3fe590`), TASK-669 (`a18412a9e`). Post-merge verification on `dev-2.1`: workspace 959 files / 16,369 tests passed, `@arcaai/ui` 656, `@arcaai/vox` 4,131, `compat-playground` 223, `admin-console` 1,339 — zero failures; lint 31/31 with 0 errors (65 `apps/api` warnings pre-existing and unchanged); SMR 109 failed / 1,009 passed, matching the standing TASK-639 baseline exactly.
  Three corrections learned during execution, all now folded into `execution-plan.md`:
  1. **Python tickets cannot gate from a worktree** — `arcaenv` editable installs pin to the main checkout, so worktree pytest imports main-tree source. Cost a false "+30 regression" reading on TASK-657 that was purely a measurement artifact. New §1.1a.
  2. **`py:<svc>:<action>` scripts do not exist** — TASK-557 renamed them all; `.claude/rules/06-python-services.md` is stale and was copied into the original specs.
  3. **TASK-655's premise was half wrong** — two of the four "duplicate" snapshot resolvers were already on the repository helper. The agent verified rather than trusting the spec.
  Owner scope decisions during the wave: `apps/ui-playground` is the second exclusion **and** is to be deleted outright (TASK-669, added and completed in this wave). The `@arcaai/vox/compat` exclusion holds — verified 0 files under `src/compat/**` touched across every merge.

- 2026-08-11 — Ticket opened. Seven exploration passes (harness internals, SDK context surface, gateway + Prisma model, admin console, multimodal capability, agent cardinality + promotion surface, live-documentation plane) plus two external research passes (client schema discovery; reasoning agents on durable execution). Design settled across 13 decisions (§1.2). Architecture in §4; sub-tickets TASK-655…668 specced in `execution-plan.md`. **Correction from the first draft: `LiveDocumentationService` was absent from it entirely; §3.4 and §4.4 now treat it as the reflex lane the loop dispatches rather than replaces.** Second owner scope-exclusion truncated in transmission and NOT applied — confirm before execution.
