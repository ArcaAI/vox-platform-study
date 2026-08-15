# TASK-724 — STT Pipeline Palette

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 3 · **Size** | L |
| **Epic slug** | `palette-stt` |
| **Depends on** | TASK-720 (`palette-summarization` — first palette onto the substrate; this ticket is the second and must not re-derive registry/compiler mechanics TASK-720 already established) |
| **Design refs** | D4 (generic engine, domain palettes onboard without engine changes), D5 (palette sequencing Summarization → STT → Consultation — this is the STT step), D7 (async contract — the batch-dispatch/poll shape below is exactly the "task/event envelope over existing infra" D7 scopes), Plane 1 (`WorkflowDefinition`, node registry, Compiler+Validator, Interpreter), Exposure plane (entitlement gate reuses the same mechanism as feature management) |
| **Findings closed** | — (net-new Wave-3 extension; not adjudicated in the consultation assessment) |

## 1. Requirement Analysis

TASK-720 proves the workflow substrate (`WorkflowDefinition`, node registry, compiler/validator,
interpreter, Studio canvas) on the Summarization palette — a single-agent, no-audio, no-clinical-gate
palette chosen specifically because it is simple. This ticket is the **second** palette: it adds the
STT pipeline node types to the code-owned registry so a tenant admin can author an ASR pipeline
(audio input → VAD → noise filter → diarization → language detection → ASR engine selection →
optional PHI hop → transcript output) as a `WorkflowDefinition` graph on the same canvas, validated
by the same compiler, and published through the same lifecycle (`DRAFT → VALIDATED → PUBLISHED →
DEPRECATED`).

Per D4 ("generic engine, domain palettes… palettes onboard without engine changes"), this ticket
must NOT touch the interpreter, compiler, or `WorkflowDefinition` model — those are TASK-720's
delivery and must already exist as documented in `design.md` Plane 1 by the time this ticket
executes. What this ticket delivers is exactly:

1. Seven STT node-type registry entries (config JSON schema, safety class, activity/service
   mapping) as described in the assignment.
2. The **binding contract** between a published STT `WorkflowDefinition` and the two paths STT
   already runs on today — realtime streaming and batch file transcription — without forcing either
   through Temporal in a way that breaks realtime audio's latency budget.
3. Node-level entitlement gating wired onto the existing STT entitlement primitives.

**The central design decision this ticket makes and must defend:** a published STT `WorkflowDefinition`
does not need a new execution surface at all. §2 below shows that both of STT's existing entry
points — realtime (`stt-ws.gateway.ts` → Redis Streams → `apps/stt` streaming session) and batch
(`TranscriptionJobController` → Dramatiq → `apps/stt` batch worker) — already parameterize on
`pipelineId`, and that id already resolves to an `AsrPipeline` row (`configYaml` referencing
`models.asr` / `models.vad` / `models.denoise` by slug). **Publishing an STT `WorkflowDefinition`
therefore compiles the graph into an `AsrPipeline` + `AsrPipelineVersion` row** (reusing the model
verbatim, no new schema) rather than inventing a second, parallel "compiled STT config" shape. The
interpreter's role is reduced to exactly one thing for this palette: at publish time, walk the
graph and emit `configYaml`; at trigger time, resolve which `AsrPipeline` id a session should bind
to. **No per-frame audio, no per-token transcript, and no realtime session lifecycle ever executes
inside a Temporal workflow.** Batch, by contrast, is already an async, bounded, retryable job — the
existing Dramatiq job is a legitimate thing for a Temporal *activity* to dispatch-and-poll, so batch
CAN legitimately run one hop inside the interpreter without inventing new STT capability.

**Out of scope:**
- The node registry API surface, compiler, validator, or interpreter themselves (TASK-720/715/716/718).
- `phi-redactor` (TASK-710) — verified NOT built (§2.8). The "optional guardrail/PHI hop" node type
  is registered but its activity binding is a documented placeholder until TASK-710 ships; the
  compiler must allow a workflow to validate and publish without this node present (it is
  `optional` safety class, never `mandatory`).
- Any change to `apps/stt`, `apps/api/src/modules/streaming/**`, or the STT Prisma models. This
  ticket is additive at the registry/compiler-input layer only — §4 confirms this with a grep-gate.
- Workflow Studio UI work beyond what TASK-719/720 already generalized (palette rail node cards,
  inspector forms) — the registry entries are consumed generically; no STT-specific screen code.
- Entitlement enforcement changes to the concurrency/quota logic itself (`entitlements.service.ts`)
  — this ticket only adds a `featurePaletteStt`-shaped read at the point a workflow is validated
  for publish, following the existing boolean-feature pattern.

## 2. Current State Evaluation

Re-derived directly against `feat/loop`, excluding `.claude/worktrees/**`, `**/dist/**`,
`**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`.

### 2.1 `apps/stt` today — modular, engine-agnostic, no Temporal

`apps/stt/src/stt/` is organized by concern, each with its own `dto.py`/service: `vad/`
(`silero_service.py`, `session_manager.py`), `diarization/` (`pyannote_embedding.py`,
`speechbrain_embedding.py`, `streaming_sortformer.py`, `speaker_tracker.py`), `postprocessing/`
(`disfluency.py`, `overlap.py`), `punctuation/` (`service.py`, `cadence_fast.py`), `models/` (one
loader per engine: `faster_whisper_loader.py`, `nemo_loader.py`, `whisper_cpp_loader.py`,
`parakeet_cpp_loader.py`, `azure_speech_loader.py`, `azure_foundry_loader.py`, `sarvam_loader.py`,
`cloud_asr.py`, `openai_loader.py`), `streaming/` (realtime session machinery), `transcription/`
(batch machinery + `workers/transcribe_file.py`). `apps/stt/src/stt/worker.py` is a **Dramatiq**
entry point (`stt-worker` console script) — grep for `temporal` (case-insensitive) across
`apps/stt/src` returns zero hits; only `apps/harness` uses Temporal, exactly as rule
`06-python-services.md` states.

### 2.2 The existing ASR pipeline taxonomy — the node-type source of truth

`apps/stt/src/stt/pipeline/dto.py:9-19` already declares `ModelTaskType` (`StrEnum`):
`AUTOMATIC_SPEECH_RECOGNITION`, `VOICE_ACTIVITY_DETECTION`, `AUDIO_DENOISING`, `AUDIO_TO_AUDIO`
(comment: "For noise suppression (RNNoise, etc.)"), `SPEAKER_DIARIZATION`, `SPEAKER_EMBEDDING`.
This is the platform's own existing taxonomy for what an ASR pipeline stage is — the seven palette
node types in §4 are a direct, verified mapping onto it plus two orchestration-only node types
(transcript output, PHI hop) that have no `ModelTaskType` because they are not model stages.

`packages/database/src/prisma/db_main/stt.prisma:12-67` — `AsrPipeline`: `configYaml` (`String
@db.Text`, comment "Contains model references by slug: models.asr, models.vad, models.denoise"),
`isDefault`, `sourceTemplateSlug`/`templateLocked` (SYSTEM-tenant catalog rows are templates;
tenant copies are locked-for-content, clone-to-customize — `:33-42`), unique on `[tenantId, slug]`.
`AsrPipelineVersion` (`:74-106`) is immutable snapshot history for rollback/diff — the **same shape**
`WorkflowDefinition` versioning needs, already built for this exact domain.
`AiModel` (`:114-201`) is the slug-referenced model registry (`category`, `taskType: ModelTaskType`,
`source`/`sourceUri`/`format`, `localPath` override, `checksum`) — pipeline YAML references models
by slug, no FK, "the AiModel slug-reference convention" cited by
`packages/database/src/prisma/db_main/ai-task-default.prisma:8`.
`TranscriptionJob` (`:208-270`) tracks batch job status/progress, `pipelineId` FK to `AsrPipeline`,
results as `encryptedResultText`/`encryptedResultMetadata` (Vault-Transit ciphertext, plaintext
columns dropped per the model's own comment `:238-239`).

### 2.3 Realtime path — WS gateway + Redis Streams, already `pipelineId`-parameterized

`apps/api/src/modules/streaming/stt-ws.gateway.ts` is the `SttWsGateway` cited in rule
`05-nestjs-api.md` (`@WebSocketGateway({ path: '/ws/stt/stream' })`). Verified mechanics:
- Single-use stream tickets via `StreamTicketService` (never a JWT in the URL) — `stt-ws.gateway.ts`
  imports `StreamTicketService` from `../auth/stream-ticket.service`.
- Handshake failures collapse to one generic `4401 Authentication failed` close code
  (`WS_CLOSE_CODES.AUTH_FAILED = 4401`, `stt-ws.gateway.ts:39-41`) — deliberately non-enumerable
  per the file's own doc comment (`:22-35`).
- A bounded per-session replay buffer (`RESUME_BUFFER_SIZE = 200`, `:53`) survives brief disconnects.
- **`isFinal`-aware backpressure**: `relayResult` (`:775`) drops queued PARTIALS when the client
  socket is backpressured (`msg.isFinal !== true`, `:779`) but queues (never drops) FINALS
  (`msg.isFinal === true`, `:792`) — a clinician-facing caption may lag, but a final transcript
  segment is never silently lost.
- `pipelineId` is already the parameter that selects the ASR pipeline for a streaming session:
  `packages/applications/src/services/stt/streaming/streamingSession.service.ts:115` sends
  `pipeline_id: dto.pipelineId` to `apps/stt`; `apps/stt/src/stt/streaming/api/schemas.py:15`
  declares `pipeline_id: str` as a required field on the session-create request; a
  `fallback_pipeline_id` (`:59`) is the tenant's configured fallback (see §2.5).
  `streamingAudioBridge.service.ts:747,798` also threads `pipeline_id` through from the WS layer.

`apps/stt/src/stt/streaming/redis_streams.py:1-13` documents the three-component contract: an
**IngestionConsumer** reads `stt:audio:{session_id}` (blocking `XREAD`) and dispatches frames to
the session manager; a **ResultPublisher** writes `SegmentResult` rows to `stt:result:{session_id}`
via `XADD`; a **ControlListener** reads `stt:control:{session_id}` for finalize/pause/cancel.
Consumer-group name `AUDIO_CONSUMER_GROUP = "stt-ingest"` (`:49`) with periodic `XAUTOCLAIM`
dead-worker handoff (`:52-58`). `apps/stt/src/stt/streaming/schemas.py:171` — `is_final: bool =
False` on the wire-level result dataclass; `session.py:283,354,379,413` only commits results where
`r.is_final` to the session's final transcript; `packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts:862-895`
does tolerant coercion of `isFinal`/`is_final` and explicitly documents "absent/unparseable isFinal
degrades to a partial (false) — never a dropped caption" (`:886-887`).

### 2.4 Batch path — Dramatiq, already `pipelineId`-parameterized, already ownership-checked

`apps/api/src/modules/streaming/transcription-job.controller.ts` — `TranscriptionJobController`.
`dispatchBatchJob` (`:77`) is the internal dispatch method; the create-job handler resolves
`pipelineId` from the request body or falls back to the tenant's default/fallback pipeline
(`:363-378`, `resolveDefaultPipelineId`), then calls `assertPipelineOwnership(pipelineId)` (`:202-206`,
throws `NotFoundException` — 404-over-403 for a cross-tenant pipeline id) before dispatching.
`apps/stt/src/stt/transcription/workers/transcribe_file.py:33-45` — `@dramatiq.actor(queue_name=
"stt_batch", max_retries=3, min_backoff=10000, max_backoff=300000,
time_limit=get_settings().transcription_timeout_seconds * 1000)`, signature includes `pipeline_id:
str`. Broker: `apps/stt/src/stt/core/messaging/broker.py` — `RedisBroker` with `AgeLimit`,
`CurrentMessage`, `Retries`, `TimeLimit` middleware and a `Results`/`RedisBackend` for job-result
polling.

**This confirms the binding contract in §1**: both entry points already accept exactly the
identifier (`pipelineId`) that a compiled STT `WorkflowDefinition` needs to resolve to. No new
parameter, no new transport, no new job type.

### 2.5 Per-tenant STT config — gateway-resolved injection (the rule-06 default, not the guardrail exception)

`packages/database/src/prisma/db_main/tenant-stt-config.prisma:1-26` — the file's own header
comment states the pattern explicitly: **"DB-backed, tenant-admin-editable STT 'spec', resolved at
request time by the apps/api gateway and injected into the STATELESS apps/stt service (the Python
service never touches Postgres)."** Model `TenantSttConfig` (`:28-61`): `tenantId @unique`,
`fallbackPipelineId`, `autoSwitchEnabled` (default `true`, tenant kill-switch for error-triggered
auto-switch), `configJson` escape hatch, OCC-versioned (`_version`, mapper strips it per rule
`03-domain-layer.md`). `apps/stt/src/stt/core/effective_config.py:1-16` is a **separate**, smaller
mechanism — a TTL-cached (`DEFAULT_TTL_S = 60`, ±10% jitter, negative-cached, single-flight) pull
of **platform-wide, non-tenant-keyed** tuning knobs (model-cache retention, worker concurrency)
over the existing gateway transport, reusing the `X-Internal-Service-Key` header from
`core/api_client/gateway.py` rather than minting a new credential. Confirms rule `06-python-services.md`'s
"Per-tenant config in a Python service → the default is gateway-resolved injection" applies to STT
verbatim — this is NOT the guardrail direct-SQL exception, and the palette must not introduce one.

### 2.6 Language-mode taxonomy already exists

`apps/stt/src/stt/pipeline/language_modes.py:37,97-127` — `LanguageModeKind = Literal["single",
"code_switch", "auto"]`, `LANGUAGE_MODE_CATALOG` (`en`, `ml`, a code-switch mode, `vi`, and `auto` =
language-detection). `get_language_mode()` (`:238`) and `engine_supports_mode()` (`:254`) already
validate an engine can serve a requested mode, raising `LanguageModeUnsupportedError` (`:220`)
otherwise — the "ASR engine selection bounded by config" node type's engine/mode compatibility
check should call this, not reimplement it.

### 2.7 Entitlements — real, wired, kill-switch-gated

`packages/applications/src/services/entitlements/entitlements.service.ts`:
- `:88` — `monthlySttSessionSeconds: (u) => u.sttSessionSeconds` meter mapping.
- `:219` — `buildCapabilityRow('monthlySttSessionSeconds', resolved.limits.monthlySttSessionSeconds,
  meterUsage.sttSessionSeconds)` — surfaced on the capability/usage snapshot.
- `:395-424` — `assertConcurrencyQuota(tenantId, increment)`: inert while
  `!this.isEnforcementEnabled()` (`:397`); resolves `resolved.limits.maxConcurrentSessions`; `null`
  = unlimited; reads live concurrency via `this.socketRegistry.getTenantAggregateCount(tenantId)`
  (`:429-436`, fail-open to `0` on a registry miss/Redis blip, deliberately, per the method's own
  doc comment "a monitoring signal never hard-fails the session-start path"); on breach, emits
  `ENTITLEMENTS_QUOTA_BLOCKED_EVENT` then throws `QuotaExceededException` (maps to HTTP 429).
  `IEntitlementsService.ts:141` documents this as the "HARD-BLOCK a new STT streaming
  session/consultation" case verbatim.
- `IEntitlementsService` is injected into `apps/api/src/modules/streaming/streaming.module.ts:63`
  and used by `transcription-job.controller.ts` and `pipeline.service.ts`
  (`packages/applications/src/services/stt/pipeline/pipeline.service.ts`).

**Feature-flag precedent for palette availability gating** (design.md: "palette availability per
tenant plan uses the same mechanism as feature management"): `resolve-entitlements.ts:48-63` —
`ResolvedFeatures` is a closed, column-per-key boolean interface (`dnaReports`, `voiceEnrollment`,
`monitoringAccess`, `platformDefaultCredential`); `entitlements.constants.ts:131-148` defines the
per-plan default matrix (`featureDnaReports`, `featureVoiceEnrollment`, etc.). `EntitlementFeatureKey
= keyof ResolvedFeatures` (`IEntitlementsService.ts:17-19`) — "entitlements are COLUMN-per-key, so
the type system is the registry." A future `featurePaletteStt` boolean follows this exact pattern:
add a key to `ResolvedFeatures`, a column to the per-plan matrix, and a read at the point the STT
palette's node types are exposed in the registry rail / at publish-time validation. This ticket adds
the read; it does not touch the entitlement resolver's enforcement internals.

### 2.8 Guardrail PHI hop — confirmed NOT built (TASK-710 dependency risk)

`apps/guardrail/src/guardrail/api/endpoints/guardrails.py` — real routes are `POST
/guardrail/analyze` (`:59`), `POST /guardrail/analyze/batch` (`:111`), `POST
/guardrail/analyze/async` (`:179`), `GET /guardrail/types` (`:206`). **No `/redact` route exists.**
`apps/guardrail/src/guardrail/providers/gliner.py` exists and is real (GLiNER token-level PII/label
span detection, used for the `guardrail.safety` task type per
`packages/applications/src/services/ai-task-default/constants.ts:55`), but nothing in
`apps/guardrail/src/guardrail/api/` exposes a redaction/masking output — only detection/scoring.
This matches `design.md`'s own Wave-1 placement of `phi-redactor` (TASK-710) as a dependency of
this palette's PHI-hop node, not yet landed. §4 Task 3 registers the node type with a
**placeholder** activity binding and marks it `optional`, so a published STT workflow validates and
runs correctly with the node entirely absent.

### 2.9 What must be reused (registry entry sources)

- `apps/stt/src/stt/pipeline/dto.py:9-19` (`ModelTaskType`) — node config schema `taskType` values.
- `apps/stt/src/stt/pipeline/language_modes.py` (`LANGUAGE_MODE_CATALOG`, `engine_supports_mode`) —
  language-detection node's option list and validation call.
- `packages/database/src/prisma/db_main/stt.prisma` (`AsrPipeline`, `AsrPipelineVersion`, `AiModel`)
  — the compile target; no new Prisma model.
- `packages/applications/src/services/stt/pipeline/pipeline.service.ts` — existing
  `AsrPipeline` CRUD service; the STT-palette compiler writes through this service, not a new one.
- `packages/applications/src/services/entitlements/` — `assertConcurrencyQuota`,
  `ResolvedFeatures`/`EntitlementFeatureKey` pattern (§2.7).
- Whatever TASK-720 lands as the node-registry entry shape (config JSON schema, category, palette
  membership, safety class, entitlement gate) — this ticket's registry entries must match that
  shape exactly; if TASK-720's actual shape differs from `design.md`'s Plane 1 description, Task 1
  below must re-verify against the landed code before writing entries.

## 3. Knowledge & Best Practices

- `.claude/rules/06-python-services.md` — "Per-tenant config in a Python service… default is
  gateway-resolved injection" — confirmed STT's actual pattern (§2.5); no direct-SQL exception is
  introduced here. Also: "Don't bind services to 0.0.0.0 in local dev," "workflows are
  DETERMINISTIC… all side effects live in activities" (binds Task 5's batch-dispatch activity).
- `.claude/rules/04-application-services.md` — any new application-layer service this ticket adds
  (the STT-palette-to-`AsrPipeline` compiler hook) extends `BaseService`, uses symbol-token DI,
  broadcasts `SysEventType.ResourceCreated`/`ResourceUpdated` on `AsrPipeline`/`AsrPipelineVersion`
  writes exactly as the existing `pipeline.service.ts` already does — do not duplicate those calls.
- `.claude/rules/03-domain-layer.md` — no new Prisma model, so no new entity/factory/mapper/repository
  trio; if the compile step needs a new field on `AsrPipeline` for provenance
  (`sourceWorkflowDefinitionId`), that is a schema change following the standard model field
  template and migration workflow in `02-database-prisma.md`, decided in Task 1, not assumed here.
- `.claude/rules/_karpathy.md` §2/§3 — do not build the PHI-hop activity binding for real (TASK-710
  isn't landed); a documented placeholder that keeps the node `optional` is the surgical amount of
  work. Do not touch `apps/stt`, `apps/api/src/modules/streaming/**`, or Redis Streams code — the
  entire point of §2.3/§2.4's verification is that nothing there needs to change.
- **Known pitfall specific to this ticket**: do not let "STT palette" imply the interpreter walks
  individual audio frames or transcript segments as workflow nodes at runtime. The interpreter's
  Temporal determinism rule (`06-python-services.md` — "no I/O, no network… inside `@workflow.defn`")
  makes a per-frame Temporal signal loop for 16kHz realtime audio both a determinism violation risk
  and a latency disaster; the compile-once/bind-by-id design in §1 sidesteps this entirely rather
  than working around it inside a workflow.
- **Known pitfall**: `AsrPipeline.templateLocked` rows are read-only for content edits
  (`stt.prisma:33-42`). If the compiler ever targets a SYSTEM-template-derived tenant row, it must
  clone-then-write, never attempt to mutate a locked row — mirror
  `pipeline.service.ts`'s existing clone logic (verify its exact method name in Task 1) rather than
  reimplementing the locked/template check.

## 4. Implementation Plan

### Task 1 — Verify TASK-720's landed registry/compiler shape before writing anything
- **Agent:** T2 · sonnet-5 · low
- **Files:** none (verification only; produces the concrete API surface Tasks 2-6 code against)
- **Approach:** Read the actual landed `packages/applications/src/services/*` (or wherever TASK-720
  placed it — search for a `node-registry`/`workflow-registry` service folder, a
  `WorkflowDefinition` Prisma model, and the compiler/validator service) and confirm: (a) the exact
  shape of a node-registry entry (field names for config schema, category, palette membership,
  safety class, entitlement gate — `design.md` Plane 1 names these but TASK-720 is authoritative);
  (b) the exact compiler output shape (`compiledConfig` JsonB structure) and whether it already
  supports a "compile to an external system's row" pattern or whether this ticket must add one; (c)
  whether `pipeline.service.ts`'s clone-from-template method exists and its exact name/signature
  (§3 pitfall). If any of (a)-(c) is not yet landed or differs materially from this ticket's
  assumptions, STOP and flag as HUMAN-GATED in §6 rather than guessing.
- **Verify:** A short written note (in the PR/commit description, not a new doc file) listing the
  three confirmed API shapes with file:line citations against the landed TASK-720 code.

### Task 2 — Failing tests for the seven STT node-type registry entries
- **Agent:** T2 · sonnet-5 · medium
- **Files:** new test file under wherever TASK-720's registry tests live (confirm exact path in
  Task 1), e.g. `packages/applications/src/services/<registry-folder>/__tests__/stt-nodes.test.ts`
- **Approach:** Write RED tests asserting the registry, once this ticket's entries are registered,
  contains exactly these seven STT node types with the stated safety class and config schema shape:
  1. `stt.audioInput` — `mandatory`; config discriminates `mode: 'realtime' | 'batch'`; realtime
     mode has no further config (session creation supplies audio at runtime); batch mode config
     validates against `mediaId`/`audioUri` presence (mirrors `transcribe_file`'s params).
  2. `stt.vad` — `optional`; config schema mirrors `ModelTaskType.VOICE_ACTIVITY_DETECTION` model
     selection (a `modelSlug` referencing an `AiModel` with `taskType: VOICE_ACTIVITY_DETECTION`).
  3. `stt.noiseFilter` — `optional`; config schema mirrors `ModelTaskType.AUDIO_DENOISING` /
     `AUDIO_TO_AUDIO`.
  4. `stt.diarization` — `optional`; config schema mirrors `ModelTaskType.SPEAKER_DIARIZATION`
     (+ optional `SPEAKER_EMBEDDING` companion model slug).
  5. `stt.languageDetection` — `optional`; config schema is a `LanguageModeKind` selector
     (`single`/`code_switch`/`auto`) plus, for `single`, a `primary_language` drawn from
     `LANGUAGE_MODE_CATALOG` ids.
  6. `stt.asrEngine` — `mandatory`; config schema selects a `modelSlug` with
     `taskType: AUTOMATIC_SPEECH_RECOGNITION`, bounded by `TenantSttConfig` (tenant's allowed
     engines/fallback) and by `IEntitlementsService` feature/quota gates (§2.7) — the entitlement
     gate field on the registry entry points at `maxConcurrentSessions` /
     `monthlySttSessionSeconds` for runtime enforcement, and (once added) `featurePaletteStt` for
     publish-time availability.
  7. `stt.transcriptOutput` — `mandatory`; config schema is empty (sink node); the compiler asserts
     exactly one output node per graph (mirrors `stt-ws.gateway.ts`'s single-consumer-per-session
     model — no fan-out at the transcript sink in v1).
  8. `stt.phiHop` (optional guardrail redaction) — `optional`; config schema has a `mode:
     'pseudonymize' | 'full-redact'` field (per `design.md` D-adjacent language "pseudonymize
     identifier / full redaction for retained artifacts" — verify against TASK-710's landed shape
     if it exists by execution time; otherwise this is forward-declared and inert); activity binding
     is a documented `NotImplementedError`-style stub, never silently a no-op — a workflow that
     reaches this node before TASK-710 lands must fail loudly in the Workbench sandbox, not pass
     transcript through unredacted while claiming the hop ran.
  Each test asserts: registry lookup by node-type id returns the entry; safety class matches;
  `mandatory` nodes (`audioInput`, `asrEngine`, `transcriptOutput`) are reported by the validator's
  mandatory-subgraph check (reuse TASK-720's validator test harness/fixture pattern — confirm its
  name in Task 1).
- **Verify:** Run the registry test suite command confirmed in Task 1 — RED (entries don't exist).

### Task 3 — Register the seven node types
- **Agent:** T3 · sonnet-5 · medium
- **Files:** new module under the registry folder confirmed in Task 1, e.g.
  `packages/applications/src/services/<registry-folder>/nodes/stt/*.ts` (one file per node type,
  following whatever per-node-type file convention TASK-720 established — do not invent a
  different convention), plus the registry's aggregation/index file.
- **Approach:** Implement each entry per Task 2's spec. Config JSON schemas are zod schemas (per
  rule `13-nextjs-apps.md`'s "inspector forms generated from registry JSON schemas — zod + Field
  family" — the schema authored here is consumed generically by the Studio inspector, no STT-specific
  UI code). `stt.asrEngine`'s schema references `LANGUAGE_MODE_CATALOG` ids and `ModelTaskType`
  values as string enums mirrored 1:1 from the Python source (§2.2, §2.6) — do not let the TS and
  Python enums drift; if TASK-720's registry pattern includes a codegen or contract-test mechanism
  for this, use it (confirm in Task 1); otherwise add a plain string-literal-union type with a
  comment pointing at the Python source of truth.
- **Verify:** Task 2's suite — GREEN.

### Task 4 — Compiler hook: STT graph → `AsrPipeline` + `AsrPipelineVersion`
- **Agent:** T3 · sonnet-5 · high
- **Files:** new service (or extension of TASK-720's compiler, per Task 1's finding) — e.g.
  `packages/applications/src/services/<registry-folder>/compilers/stt-pipeline.compiler.ts` +
  `__tests__/stt-pipeline.compiler.test.ts` (RED first)
- **Approach:** On publish of a `stt`-palette `WorkflowDefinition`, walk the validated graph and emit
  a `configYaml` string in the shape `AsrPipeline.configYaml` already expects (`models.asr`,
  `models.vad`, `models.denoise` slug references — verify the exact YAML key set against
  `apps/stt/src/stt/pipeline/config_reader.py`'s `PipelineConfigReader` before writing the emitter,
  since that is the actual consumer). Write through the existing `pipeline.service.ts`
  (`AsrPipelineService` or equivalent — confirm exact class name) rather than a raw repository call,
  so its existing `broadcastSysEvent`/OCC behavior is reused unmodified. Each publish creates a new
  `AsrPipelineVersion` row (immutable snapshot, mirrors `WorkflowDefinition`'s own
  `parentVersionId` lineage — the two versioning schemes stay in lockstep by both being driven from
  the same publish action, one call each). Store the source `WorkflowDefinitionId` +
  `WorkflowDefinition` version on the `AsrPipeline`/`AsrPipelineVersion` row for provenance (Task 1
  determines whether this needs a new nullable column — if so, follow the migration workflow in
  `02-database-prisma.md` exactly, including the shadow-DB recipe).
- **Verify:** compiler test suite — GREEN; a fixture graph (audioInput → vad → asrEngine →
  transcriptOutput) compiles to a `configYaml` that `PipelineConfigReader` can parse without error
  (add a round-trip assertion calling into the Python parser via a contract test, or, if that's not
  feasible cross-language in this suite, assert the exact key/value shape `config_reader.py` expects
  and note in Task 6 that the cross-language contract test belongs there).

### Task 5 — Batch-trigger binding: harness activity dispatches to the existing batch path
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `apps/harness/src/harness/temporal/activities.py` (new activity, alongside the existing
  `retrieve_context` activity at `:1259` as the file's established pattern), its test in
  `apps/harness/src/harness/tests/` (in-package, per rule `06-python-services.md`'s test-location
  table)
- **Approach:** Add one `@activity.defn` that, given a resolved `AsrPipeline` id and a batch job's
  audio reference, calls the EXISTING `TranscriptionJobController` HTTP surface (or its underlying
  application-layer service directly if harness already has an authenticated path to
  `packages/applications` — confirm which; do not build a second HTTP client if one is reusable)
  to create a `TranscriptionJob`, then polls job status via the existing polling mechanism
  (`apps/stt/src/stt/core/messaging/broker.py`'s Dramatiq `Results`/`RedisBackend`, surfaced through
  whatever status-read endpoint `TranscriptionJobController` already exposes) until terminal state,
  bounded by a platform-capped timeout per `design.md`'s "tenants tighten, never exceed" rule. The
  activity is idempotent (retriable): a retry that finds an existing `TranscriptionJob` for the same
  idempotency key re-polls rather than re-dispatching (mirror whatever idempotency-key convention
  TASK-717's async contract established — verify in Task 1; if TASK-717 is not yet landed either,
  fall back to a simple "activity checks for an existing non-terminal job with a matching
  `workflowRunId` tag before creating a new one" and flag the gap in §6).
- **Verify:** `pnpm harness:test -- <new activity test file>` — GREEN; confirm the harness CI suite
  stays hermetic (rule `06-python-services.md` — "Temporal/LLM/reranker stubbed… keep new harness
  tests hermetic or the job breaks") by mocking the HTTP call to `TranscriptionJobController`, never
  hitting a live `apps/stt`.

### Task 6 — Realtime-trigger binding: session-open resolves `pipelineId`, never touches Temporal
- **Agent:** T2 · sonnet-5 · medium
- **Files:** wherever the (TASK-718-landed) interpreter's trigger-dispatch/session-open hook lives
  (confirm in Task 1 — likely alongside `NoteGenerationService`'s eventual interpreter-dispatcher
  role per `design.md` Plane 1, or a new small resolver service if TASK-718 doesn't already have
  this seam)
- **Approach:** When a session/consultation open (or an explicit palette invoke) resolves to a
  `PUBLISHED` `stt`-palette `WorkflowDefinition`, the resolver looks up the `compiledConfig`'s
  `AsrPipeline` id (written by Task 4) and passes it as `pipelineId` into the EXACT SAME
  `CreateStreamingSessionRequest`/`dto.pipelineId` path verified in §2.3 — no interpreter, no
  Temporal workflow, no new WS/Redis-Streams code. Write a unit test asserting: given a published
  STT `WorkflowDefinition`, the resolver returns the same `pipelineId` string Task 4's compiler
  wrote, and a grep-gate test (mirroring TASK-704's Task 6 pattern) asserting no file under
  `apps/api/src/modules/streaming/**` or `apps/stt/src/stt/streaming/**` was modified by this
  ticket's diff (proves the realtime hot path is untouched).
- **Verify:** the new unit test suite — GREEN; the grep-gate test — GREEN; `pnpm --filter
  @arcaai/applications test`.

### Task 7 — Entitlement gate wiring at publish-time
- **Agent:** T2 · sonnet-5 · low
- **Files:** the compiler/validator's publish path (from Task 1/4), one new test
- **Approach:** Add a `featurePaletteStt` key to `ResolvedFeatures`
  (`packages/applications/src/services/entitlements/resolve-entitlements.ts:48-63`) and the per-plan
  matrix (`entitlements.constants.ts:131-148` region), following the exact pattern of
  `featureDnaReports`/`featureVoiceEnrollment` (boolean, no enforcement logic beyond a read). At
  STT-palette publish time, the compiler reads this feature via `IEntitlementsService`; if `false`,
  publish is rejected with the same `QuotaExceededException`-family error the existing feature
  checks use (confirm exact exception type by finding where `platformDefaultCredential` is checked
  — it is described as "the first ENFORCED boolean entitlement," `resolve-entitlements.ts:56-60` —
  and imitate that call site, not `assertConcurrencyQuota`'s runtime-only pattern).
- **Verify:** new unit test — GREEN; `pnpm --filter @arcaai/applications test`.

### Task 8 — Full verification pass
- **Agent:** T2 · sonnet-5 · low
- **Files:** none
- **Approach:** Run every layer gate this ticket touches.
- **Verify:** `pnpm --filter @arcaai/applications build`, `pnpm --filter @arcaai/applications test`,
  `pnpm harness:test`, `pnpm api:build`, `pnpm test:unit`, `pnpm lint`.

## 5. Acceptance Criteria

- [ ] `pnpm --filter @arcaai/applications build` passes
- [ ] `pnpm --filter @arcaai/applications test` passes, including the new registry/compiler/resolver
      suites
- [ ] `pnpm harness:test` passes, including the new batch-dispatch activity test, hermetically
- [ ] `pnpm api:build` and `pnpm test:unit` pass
- [ ] The seven STT node types (audioInput, vad, noiseFilter, diarization, languageDetection,
      asrEngine, transcriptOutput) plus the placeholder `phiHop` node are registered with correct
      safety classes; the validator's mandatory-subgraph check enforces `audioInput` + `asrEngine` +
      `transcriptOutput` present in every publishable graph
- [ ] Publishing an `stt`-palette workflow produces an `AsrPipeline` + `AsrPipelineVersion` row whose
      `configYaml` a real `PipelineConfigReader` can parse without error
- [ ] A grep-gate test proves this ticket's diff touches no file under
      `apps/api/src/modules/streaming/**` or `apps/stt/src/stt/streaming/**` — the realtime hot path
      is provably unmodified
- [ ] Batch trigger dispatches through a new harness Temporal activity that calls the EXISTING
      `TranscriptionJobController`/Dramatiq path (no duplicate job-processing logic in harness)
- [ ] `featurePaletteStt` gates publish; a tenant without the feature cannot publish an STT-palette
      workflow (unit-tested)
- [ ] `pnpm lint` — zero new errors, including `only-warn` warnings in `packages/*` treated as errors
- [ ] Ticket README's Implementation Summary and Change History updated with actual command output
      pasted

## 6. Risks & Open Questions

- **HUMAN-GATED: this ticket cannot execute correctly until TASK-720's registry/compiler shape is
  real.** Task 1 is a hard gate — if the landed shape differs materially from `design.md`'s Plane 1
  prose (which is a design summary, not a spec), every subsequent task's file paths and approach
  need re-deriving against the real code, not this document's assumptions.
- **TASK-710 (`phi-redactor`) dependency**: confirmed not built (§2.8). The `phiHop` node type ships
  as an inert placeholder. If TASK-710 lands with a materially different activity contract than
  guessed here, a follow-up ticket (not this one) wires the real binding — do not let this ticket's
  scope creep into building the redactor.
- **TASK-717 (`async-contract`) dependency for Task 5's idempotency key**: design-only today (D7,
  no landed envelope). If it is still undesigned when Task 5 executes, the fallback idempotency
  check described there is a narrower, ticket-local mechanism that should be revisited once TASK-717
  lands — flag this explicitly in the PR description so it isn't mistaken for the platform-wide
  contract.
- **Cross-language enum drift** (§4 Task 3): `ModelTaskType`/`LanguageModeKind` exist independently
  in Python (`apps/stt`) and would be mirrored by hand into the TS node registry schemas. Without a
  shared contract test, these drift silently the next time either enum changes. Recommend a
  follow-up (not blocking this ticket) adding a contract test once TASK-720 establishes whether the
  registry has a cross-language schema-sync mechanism.
- **Provenance column on `AsrPipeline`/`AsrPipelineVersion`** (Task 4): if a new nullable column is
  needed, that's a real schema change requiring the full shadow-DB migration recipe in
  `02-database-prisma.md` — size this task generously; it is not "add a JSON field," it touches a
  model with live production rows (`isDefault`, `templateLocked` semantics must not regress).
- **Realtime feature-flag timing**: `featurePaletteStt` (Task 7) gates *publish*, not the already-running
  realtime path — a tenant whose feature flips off after a workflow is published keeps running the
  compiled `AsrPipeline` (in-flight-runs-pin-their-version semantics from `design.md`'s Data Flow
  section) until republished or deprecated. Confirm this is the intended behavior with the product
  owner if it is not obviously implied by "in-flight runs pin their version; publishes affect new
  runs only."

## 7. Implementation Summary

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-3 ticket-authoring agent |
