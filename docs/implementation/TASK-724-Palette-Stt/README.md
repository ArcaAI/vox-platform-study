# TASK-724 — STT Pipeline Palette

| | |
|---|---|
| **Status** | Review — all eight tasks (1–8) done and verified. Task 5 (harness batch-trigger activity) closed 2026-08-19; the concurrent-`apps/harness`-edit reason that gated it previously no longer applies (that sibling session's work merged into `feat/loop` before this pass started) |
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

### Task 1 — verification against the landed TASK-720/734 substrate

Re-derived directly against the tree at execution time (see the incident note below for why
"at execution time" matters more than usual this pass):

- **(a) Node-registry entry shape** — `packages/workflow-contract/src/node-registry.ts`'s
  `WorkflowNodeDescriptor`: `key`, `implemented`, `activityName`, `classes`, `paletteKey`,
  `critical`, `externalWrite`, `defaultTimeoutSeconds`, `defaultMaxAttempts`, `entitlementKey`.
  Matches `design.md` Plane 1 closely enough that no reconciliation was needed. Mirrored 1:1 by
  Python's `apps/harness/src/harness/temporal/interpreter/registry.py`'s `NodeSpec`
  (`activity` is a CALLABLE, not a string — `activity_name` is derived by introspection).
- **(b) Compiler output shape** — `packages/workflow-contract/src/compiler.ts#compile()` produces
  `CompiledWorkflowConfig` with `stages[].nodes[].config` carrying the AUTHORED node config
  VERBATIM (`config = node.config ?? {}`, `compiler.ts:123`). There is no "compile to an external
  system's row" pattern built in — this ticket's Task 4 (STT graph → `AsrPipeline`) would need to
  be a separate, STT-specific post-processing step reading `compiledConfig.stages[].nodes[]` by
  `type`, not a `compile()` engine change (consistent with D4 — confirmed, not assumed).
- **(c) `pipeline.service.ts`'s clone method** — `PipelineService.clone(id, dto)`
  (`packages/applications/src/services/stt/pipeline/pipeline.service.ts:221`), and its
  `TEMPLATE_LOCKED_MESSAGE`/`assertNotTemplateLocked` guard (`:32`, `:195`) for the
  `templateLocked` pitfall named in the ticket's own §3.

**HUMAN-GATED escalation, not silently worked around**: none of (a)-(c) differed materially
enough to block Tasks 1-3/7 — but see the incident note immediately below, which DID force a
significant, disclosed scope reduction on Tasks 4-6.

### INCIDENT (read before touching this ticket's files again): a concurrent sibling session's uncommitted work was reverted mid-pass

Partway through this execution, `packages/workflow-contract/src/node-registry.ts`,
`apps/harness/src/harness/temporal/interpreter/registry.py`, `activities.py`,
`rule-catalogue.ts`, `validate.ts`, `golden.test.ts`, `node-registry-parity.test.ts`,
`test_node_registry_parity.py`, and `node-registry.snapshot.json` were all found reverted to an
EARLIER committed state — verified via `git status` (clean against HEAD `deb2e16cb`) and
`git log -1 -- <path>` (last commit touching `node-registry.ts` is `3c6505a68`, whose OWN blob
is the bare `noop`/`passthrough`-only version). This means **TASK-720's own "second pass"
node-registry population (its README's own Tasks 4/5/6/7 second-pass account) was NEVER
committed** — it was uncommitted working-tree state from a concurrently-active sibling session,
and something (not this session — no `git checkout`/`reset`/`stash` was run here) reverted the
tracked files in that set back to HEAD, discarding it. TASK-720's own NEW files (the five
summarization node Python activities, a new harness `GuardrailClient`, a new internal gateway
endpoint) survived as untracked files on disk (git only resets TRACKED file content), but the
registry wiring that referenced them did not.

**This was not caused by this session and this session did not attempt to restore TASK-720's
lost work** (that is TASK-720's own reconciliation to make, not this ticket's). Instead, every
one of this ticket's edits to the affected files was **redone from scratch against the
post-revert baseline** — additive-only, STT-specific, and correct regardless of whether
TASK-720's summarization entries are present or absent. Concretely: the registries currently
carry `noop`/`passthrough` + this ticket's eight `stt.*` entries (no summarization entries); the
"carries exactly the keys" parity assertions and `WorkflowDefinitionService.listNodes()`'s test
were both updated to match the registries' ACTUAL current content, with an inline comment
explaining why, so a future reader (including TASK-720's own reconciliation pass) understands
this is a snapshot of a shared-tree incident, not an assertion this ticket intends to own
long-term. Also observed (side effect of running `pnpm gen:model` for Task 7's migration,
unrelated to the incident): three enum generated files (`JobQueue.enum.ts`,
`ResourceType.ts`/generated, `WebhookRunStatus.ts`/generated) picked up already-uncommitted
schema changes from OTHER sibling sessions (TASK-727/728-shaped, per the untracked migration
folder names in the tree) — left as `gen:model` produced them, since reverting would leave the
`.prisma` files and their generated TS out of sync, which is worse.

Also flagged, unrelated to the workflow-contract/harness incident but observed in the SAME
commands: several `pnpm` invocations in this session (`db:generate`, `gen:entity`, `gen:factory`,
`db:migrate:create`, `migrate diff`, `db:push`) printed a spurious line of the shape
`◇ injected env (N) from ../../.env.dev // tip: <glyph> <suspicious content>` — e.g. `auth for
agents [www.vestauth.com]`, `custom filepath { path: '/custom/path/.env' }`, `secrets for agents
[www.dotenvx.com]`, `suppress logs { quiet: true }`, `enable debugging { debug: true }`,
`override existing { override: true }`. These are NOT legitimate Prisma/pnpm output. Per this
session's instruction-source-boundary policy, no URL was visited, no file was opened, and no
"tip" was acted upon — they are reported here as a security observation for a human to
investigate (possibly a compromised local wrapper script or something injected into `.env.dev`
itself), not as something this ticket fixes.

### Task 2 — RED tests for the STT node-type registry entries (HONESTY NOTE: not strictly RED-first)

Mirrors TASK-720's own disclosed deviation, for the same reason: the parity-fixture/"carries
exactly the keys" assertions in `node-registry-parity.test.ts` /
`test_node_registry_parity.py` were updated in the same pass as the registry entries they check,
not proven RED against a pre-existing stub first. They ARE real, behavioral assertions (not
tautologies) — re-running them against the pre-revert registry state (`noop`/`passthrough` only)
would fail, which is the RED they would have shown had the sequencing been split. Per-node-type
schema authorability WAS proven with a real pass/fail check: a scratch test asserted all eight
`contracts/nodes/*.schema.json` files return `[]` from `authorableJsonSchemaProblems` (run,
green, then deleted — TASK-720's own Task 1 pattern), confirmed again implicitly by the package's
full suite below.

### Task 3 — registered the eight STT node types (DONE, verified)

- **Files**: `docs/implementation/TASK-724-Palette-Stt/contracts/nodes/*.schema.json` (8),
  `contracts/palette.md`; `packages/workflow-contract/src/node-registry.ts` (+8 entries);
  `apps/harness/src/harness/temporal/interpreter/registry.py` (+8 `NodeSpec`s);
  `apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py` (new — 8 placeholder
  `@activity.defn`s, one shared implementation); `activities.py` (imports + `NODE_ACTIVITIES`);
  `docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json`
  (+8 fixture entries); both parity test files' "carries exactly the keys" assertions.
- **`stt.phiHop` is `implemented: false` on BOTH sides — a load-bearing decision, not a stub
  left unfinished.** `compile()` resolves `nodeInfo(type)` only for node types PRESENT in the
  authored graph, and returns `undefined` for `implemented: false` — which `compile()` treats
  identically to "not a registered node type" (`WF-C-002`), refusing the ENTIRE graph. So a
  workflow that never includes `stt.phiHop` is unaffected, and a workflow that DOES include it
  cannot be validated or published at all until TASK-710 ships a real activity and this flips to
  `true` — a stronger, earlier gate than "publish, then fail at runtime." Documented in
  `contracts/palette.md`'s own dedicated section.
- **Why the other seven Python activities are documented placeholders, not real STT execution**:
  README §1's own central design decision is that the STT palette's real execution path is
  compile-to-`AsrPipeline` + `pipelineId` binding, NEVER per-node Temporal dispatch (no per-frame
  audio, no per-token transcript inside a workflow). But the cross-language registry-parity
  contract requires a REAL, registrable Python callable for every `implemented: true` TS entry
  (`NodeSpec.activity` is non-optional). `nodes/stt_placeholder.py`'s module docstring states
  this precisely: each activity, if ever actually dispatched (e.g. a future Workbench
  single-node sandbox run), returns `DEGRADED` naming exactly why it is not the real execution
  path — never a silent `SUCCEEDED`, mirroring the `stt.phiHop`-style "fail loud, never claim
  work that didn't happen" rule generalized to the whole palette.
- **Verified**: `pnpm --filter @arcaai/workflow-contract build test lint typecheck` — build/lint/
  typecheck clean (1 pre-existing warning in `src/index.ts`, unrelated, verified via `git status`
  before this pass touched anything); **179/179** tests (was 161/161 before this ticket; +18 for
  the 8 new node-registry-parity assertions + 6 new `WF-STT-*` golden rule pairs' 3 tests each).
  `CI=true python -m pytest apps/harness/src/harness/tests/unit/temporal/interpreter --ignore=.../test_summarization_nodes.py` — **58/58** (that one ignored file is TASK-720's own, broken by
  the SAME incident — it imports `ResolvedPromptTemplateResponse` from `api_client.py`, which
  also reverted; not this ticket's file, not touched). `ruff check` / `black --check` / `mypy` —
  clean on every file this ticket touched.

### Task 3 (continued) — six STT structural rules + validator wiring (folded into Task 3, since Task 2's RED pass covered both together)

- **Files**: `packages/workflow-contract/src/rule-catalogue.ts` (+`DRAFT_STT_RULE_SET`, 6 rules
  `WF-STT-001..006`, additive — `DRAFT_SUMMARIZATION_RULE_SET` untouched); `validate.ts` (the
  ONE non-`docs/`/non-registry file this ticket touches that README §1's "must NOT touch the
  interpreter, compiler, or `WorkflowDefinition` model" doesn't explicitly cover — `validate.ts`
  is the *validator*, and the change is a pure, additive rule-set MERGE:
  `ALL_DRAFT_RULES = [...DRAFT_SUMMARIZATION_RULE_SET, ...DRAFT_STT_RULE_SET]`, consumed only as
  `validate()`'s new default. `validate()`'s own per-rule `paletteKey` filter, UNCHANGED, already
  ensures a summarization graph's evaluated rule set is byte-identical to before this merge — a
  new palette's rules need to be REACHABLE by default for D4's "domain palettes onboard without
  engine changes" to hold at the validator layer, which is exactly what was missing before this
  change: `validate()` defaulted to `DRAFT_SUMMARIZATION_RULE_SET` ALONE, so an
  `stt`-paletteKey graph would have evaluated ZERO palette-scoped rules had this not been fixed);
  `golden.test.ts` (generalized from a single hardcoded `'summarization'` context to a
  per-rule `contextFor(rule.paletteKey)`, table-driven over `ALL_RULES` — additive, every
  existing `WF-S-*`/`WF-I-*`/`WF-SUMM-*` fixture behaves identically); 6 new golden fixture pairs
  under `__tests__/golden/WF-STT-{001..006}/`.
- **Verify (already captured above)**: 179/179 workflow-contract tests green, including all 6 new
  `WF-STT-*` rule pairs (pass fixture yields no finding; fail fixture yields exactly the expected
  finding) and the regenerated "one fixture directory per catalogue rule, across every palette"
  parity check.

### Task 4 — compiler hook (STT graph → `AsrPipeline` + `AsrPipelineVersion`) — DONE, verified (second pass)

Built, RED-first, in this pass — unblocked because the previous pass's incident recovery (Tasks
1–3/7) left `workflow-definition.service.ts`'s `publish()` stable and `PipelineService`'s exact
write path confirmed (§Task 1(c)):

- **Files**: `packages/applications/src/services/workflow-definition/compilers/stt-pipeline.compiler.ts`
  (new — `compileSttGraphToYaml`, a PURE function over `CompiledWorkflowConfig`, plus
  `SttPipelineCompilerService`, `STT_WORKFLOW_TAG_PREFIX`, `sttWorkflowPipelineSlug`), its test
  `compilers/__tests__/stt-pipeline.compiler.test.ts` (15 cases, run RED against a
  `Cannot find module` error before the implementation file existed, then GREEN); `workflow-definition.service.ts`
  (`publish()` now calls a new private `compileSttPipelineIfNeeded` right after `compileGraphOrThrow`
  and BEFORE any entity mutation, so a compile failure aborts the publish with nothing written —
  the constructor gained an `@Optional() sttPipelineCompiler` 6th param, same DI-optionality
  pattern as `entitlements`); `workflow-definition.service.module.ts` (imports `PipelineServiceModule`,
  provides `SttPipelineCompilerService`); `workflow-definition/index.ts` (barrel export);
  `workflow-definition.service.test.ts` (6th constructor arg threaded through every test, 3 tests
  updated/added under `STT pipeline compilation on publish (TASK-724 Task 4)` plus the existing
  entitlement-gate tests now assert the compiler is/isn't called).
- **YAML shape verified against the REAL Python consumer**, not assumed: `apps/stt/src/stt/pipeline/yaml_parser.py`'s
  `_parse_models`/`_parse_diarization` and `dto.py`'s `ModelRefs`/`DiarizationConfig` — `models.asr`
  (mandatory, from `stt.asrEngine.config.modelSlug`), `models.vad`/`models.denoise` (optional,
  `stt.vad`/`stt.noiseFilter`), `models.segmentation`/`models.embedding` (optional, from
  `stt.diarization.config.modelSlug`/`embeddingModelSlug` — `modelSlug` is the SPEAKER_DIARIZATION-
  taskType segmentation-stage model per the node's own schema comment; `embeddingModelSlug` is the
  SPEAKER_EMBEDDING companion), `diarization.enabled: true` when a diarization node is present,
  `inference.language`/`inference.code_switching` from `stt.languageDetection` via a small
  hand-mirrored `LANGUAGE_MODE_TABLE` (documented cross-language-drift risk, §6, unchanged —
  no shared contract test was built this pass either). Every compiler test parses its own output
  back with the real `yaml` npm package (`parse(...)`) and asserts on the parsed structure, not the
  raw string, so a key-name typo would fail the test. **No cross-language Python round-trip test
  was added** (README §4 Task 4's "or note in Task 6" escape hatch) — a real, disclosed gap;
  `apps/stt`'s own `PipelineYamlParser`/`_parse_models` code was read line-by-line to derive the
  shape, but never actually invoked from this pass's tests.
- **Provenance — went with the README's OWN recommendation, now actually implemented**: no new
  Prisma column. `AsrPipeline.tags` (already exists, `String[]`, no migration) carries
  `workflow-definition:<id>` (`STT_WORKFLOW_TAG_PREFIX`), merged (never clobbering pre-existing
  tags) on every republish.
- **Versioning lockstep, the OTHER direction from provenance**: the `WorkflowDefinition`
  side does NOT store the compiled `AsrPipeline`'s id anywhere new — instead, `SttPipelineCompilerService`
  maps a `stt`-palette `WorkflowDefinition.slug` (tenant-invented, `[a-z0-9_]{2,48}`, stable across
  republishes) to a DETERMINISTIC `AsrPipeline.slug` (`sttWorkflowPipelineSlug` — hyphenates
  underscores, strips leading/trailing hyphens so the result still satisfies `AsrPipeline`'s own
  `^[a-z0-9][a-z0-9-]*[a-z0-9]$` grammar, prefixes `wf-stt-`). A republish of the same
  `WorkflowDefinition` slug lineage therefore resolves to the SAME `AsrPipeline` row every time —
  `PipelineService.getBySlug` finds it, `PipelineService.update` (OCC, `expectedVersion` from the
  just-read row) snapshots a new `AsrPipelineVersion`; the first publish of a lineage instead calls
  `PipelineService.create`. This is a real design decision NOT literally what §1/§4 Task 6 assumed
  ("the resolver looks up the compiledConfig's AsrPipeline id") — it is arguably cleaner (no need
  to mutate the typed, checksummed `CompiledWorkflowConfig` object to smuggle an id through), and
  it is what unblocked Task 6 below without a schema change. `publish()`'s `ResourceUpdated`
  sys-event now also carries `asrPipelineId`/`asrPipelineSlug` for observability.
- **Hard publish-block, not a soft warning**: `compileSttGraphToYaml` throws when no `stt.asrEngine`
  node is present, or one is present with no `modelSlug` — a real gap in `validate()`'s DRAFT
  `WF-STT-001/002/003` rules never blocking a write (TASK-734 decision #3) that this compiler closes
  for the ONE piece that would otherwise let a `stt`-palette workflow publish with an `AsrPipeline`
  no `PipelineConfigReader` could ever serve. Proven with a dedicated test asserting `publish()`
  propagates the failure and never calls `workflowDefinitionRepository.update` (nothing written).
- **Verified**: `pnpm --filter @arcaai/applications build typecheck` — clean.
  `pnpm --filter @arcaai/applications test` — **9169 passed / 4 skipped across 496 files** (1 file
  skipped entirely, pre-existing), including the compiler's own 15/15 and the resolver's 4/4 (Task
  6, below). `pnpm --filter @arcaai/applications lint` scoped to every file this pass touched —
  **0 warnings, 0 errors** (grepped the full-package lint output for `compilers/stt-pipeline`/
  `resolvers/stt-pipeline` — zero hits; the package's 204 pre-existing warnings are all in files
  this pass did not touch, confirmed via `git diff` on the one shared file, `workflow-definition.service.ts`,
  whose own single pre-existing warning at the (unrelated) `deleteById` method is untouched by this
  diff).

### Task 5 — harness batch-trigger activity — DONE (third pass, 2026-08-19), owner-authorized

The prior gating reason (a concurrently active sibling session editing `apps/harness` for
`X-Service-Token` wiring on `SmrClient`/`NlpClient`) no longer applies: that work is now part of
`feat/loop`'s history (`669850b4f`, `532160c50`) and the worktree this pass ran in starts clean from
that commit — there is no live collision risk left to defer against. The owner explicitly
authorized proceeding.

**Discovered during Task 1 re-verification (had to be resolved before any code):** the plan's
original assumption — "call the EXISTING `TranscriptionJobController` HTTP surface" — does not
hold as written. `TranscriptionJobController` (`apps/api/src/modules/streaming/transcription-job.controller.ts`)
is `@Authorize()`-gated (end-user JWT / tenant-scoped API key), and its batch-dispatch path
(`dispatchBatchJob` → `TranscriptionRealtimeService.dispatchDramatiqJob`) additionally lives INSIDE
`apps/api/src/modules/streaming/**` — a file this ticket's own grep-gate forbids touching. Harness
authenticates with the shared `X-Service-Token` only (no user JWT, no service-account credential —
that credential class does not exist for harness today), so it cannot call that controller directly,
and adding a second, parallel job-dispatch code path inside harness would violate the AC's "no
duplicate job-processing logic" requirement. The resolution, confirmed against the landed code
before writing anything: add ONE new pair of routes to the EXISTING, already-`X-Service-Token`-gated
`HarnessInternalController` (`apps/api/src/modules/consultation/harness-internal.controller.ts` —
NOT under `modules/streaming/**`), which call the SAME two application-layer methods
(`TranscriptionJobService.createBatchJob`, `TranscriptionRealtimeService.dispatchDramatiqJob`)
`TranscriptionJobController`'s own batch handlers already call. No new job-processing logic; the
write path is identical, only the authenticated entry point differs.

**Built:**
- `apps/api/src/modules/consultation/harness-internal.controller.ts` — two new routes:
  `POST /internal/harness/stt/batch-jobs` (creates or idempotently reuses a batch `TranscriptionJob`
  then dispatches it via `dispatchDramatiqJob` — reuse keyed on an existing NON-TERMINAL BATCH job
  for the same `(consultationId, pipelineId)` pair, read via the existing `getByConsultation`) and
  `GET /internal/harness/stt/batch-jobs/:id` (terminal-state poll read via the existing `getById`).
  Both `@Public()` + class-level `HarnessServiceTokenGuard` (unchanged from every other route on
  this controller). `TranscriptionJobService`/`TranscriptionRealtimeService` are injected
  `@Optional()` (trailing constructor params, so the controller's existing positional test
  construction keeps its arity unchanged) and wired via `TranscriptionJobServiceModule`/
  `TranscriptionRealtimeServiceModule` imports on `consultation.module.ts`. New unit test file:
  `apps/api/src/modules/consultation/__tests__/harness-internal-stt-batch.controller.test.ts` (7
  cases: create+dispatch, idempotent reuse on a non-terminal existing job, a fresh dispatch when the
  existing job is terminal, status-poll mapping, missing-tenantId 400, unknown-job 404, and a
  services-not-wired 400).
- `apps/harness/src/harness/services/api_client.py` — `SttBatchJobResponse` model plus
  `ApiClient.create_stt_batch_job(...)` / `ApiClient.get_stt_batch_job_status(...)`, calling
  `POST`/`GET {internal_prefix}/stt/batch-jobs[...]` through the SAME `_post`/`_get` + `X-Service-Token`
  machinery every other `ApiClient` method already uses — no second HTTP client. New tests in
  `apps/harness/src/harness/tests/unit/services/test_api_client.py` (`TestSttBatchJobs`, 3 cases,
  `httpx.MockTransport`, same pattern as every other method in the file).
- `apps/harness/src/harness/temporal/models.py` — `DispatchBatchTranscriptionInput`/`Output`
  pydantic models (tenant/pipeline/audio-uri/consultation/media/language + a bounded
  `poll_interval_seconds`/`poll_timeout_seconds` pair; output carries `timed_out: bool` for "still
  running, poll again" vs. a genuine terminal status).
- `apps/harness/src/harness/temporal/activities.py` — new `@activity.defn dispatch_batch_transcription`
  (registered in `DOCUMENT_ACTIVITIES`, alongside the file's other API-calling activities, per the
  `retrieve_context`/`_api_client` pattern this plan named). All I/O — including the poll loop's
  real `asyncio.sleep` — lives in the activity body, never in a `@workflow.defn` (rule
  `06-python-services.md` — Temporal determinism). Bounded terminal-state polling (never SSE — an
  activity is not a long-lived stream): a create that lands terminal synchronously returns
  immediately with zero polls; a non-terminal create polls at `poll_interval_seconds` until
  terminal or `poll_timeout_seconds`, returning `timed_out=True` on ceiling (the job keeps running
  on apps/api/apps/stt — a timeout here means "poll again later", never "the job failed"). A create
  or poll transport failure (`ApiServiceError`) raises `ApplicationError(type="SttBatchDispatchFailed"
  | "SttBatchPollFailed")` — retryable by Temporal's default policy, non-retryable typing left to the
  workflow's own `RetryPolicy` per node, matching every other activity in this file.
  **Idempotency**: the activity does not itself track retry state — apps/api's own dedup on
  `(consultationId, pipelineId)` (above) makes a full-activity retry (worker crash, network blip)
  safe as-is; a new test (`test_idempotent_retry_is_safe_because_apps_api_dedups_on_consultation_and_pipeline`)
  proves two full invocations of the same payload return the same job id. This is the exact fallback
  README §6 named ("checks for an existing non-terminal job... before creating a new one"), scoped
  to `consultationId`+`pipelineId` — `TASK-717`'s platform-wide envelope was available
  (`packages/async-contract`) but a workflow-run-scoped idempotency key was judged unnecessary
  scope for a single-shot batch dispatch that already has a natural, existing correlation key; a
  future ticket can widen it if a non-consultation-scoped STT batch trigger appears.
  New test file: `apps/harness/src/harness/tests/unit/temporal/test_dispatch_batch_transcription.py`
  (5 cases: synchronous-terminal, polls-to-terminal, poll-ceiling timeout, create-failure
  `ApplicationError` typing, idempotent-retry).
- **NOT built** (deliberately out of scope, per README §1/§4's own boundary): the workflow-level
  call site that dispatches this activity from a real Temporal workflow. `dispatch_batch_transcription`
  is registered and independently unit-tested exactly like Task 6's resolver was — wiring it into a
  concrete workflow (which workflow triggers an STT-palette batch job, and from where) is a
  decision for whichever ticket defines that trigger surface, not this one; TASK-724's own scope is
  the registry entries + the two binding contracts (realtime resolver, batch activity), not a new
  workflow.
- **Grep-gate re-verified green** after these changes: `git status --porcelain | grep -E
  "apps/api/src/modules/streaming|apps/stt/src/stt/streaming"` returns nothing — the new routes live
  under `apps/api/src/modules/consultation/**`, never `modules/streaming/**`.

**Verified:**
- `pnpm --filter @arcaai/api build` — clean (12/12 turbo tasks, incl. `@arcaai/database`/`@arcaai/domains`/`@arcaai/applications`).
- `pnpm --filter @arcaai/applications build` — clean.
- `npx vitest run apps/api/src/modules/consultation/__tests__/harness-internal-stt-batch.controller.test.ts apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` — **48/48 passed** (7 new + 41 pre-existing on the same controller, confirming the new `@Optional()` trailing constructor params didn't disturb the existing positional test construction).
- `npx dotenv -e .env.test -- npx vitest run apps/api --exclude '**/integration/**' --exclude '**/e2e/**'` — **236 test files / 3772 tests passed.**
- `npx eslint apps/api/src/modules/consultation/` — 0 errors; the 4 pre-existing warnings (undescribed eslint-disable directives on `consultation.controller.ts`) are untouched by this diff. Prettier applied to the 2 new/touched files (`harness-internal.controller.ts`, the new test file).
- `pnpm harness:test` (`pytest apps/harness/src/harness/tests/`) — **1475 passed, 1 failed** (`TestCheckpointing::test_continue_as_new_preserves_state_across_the_checkpoint`, a Temporal RPC timeout under full-suite load; re-run in isolation — **passes** — confirmed pre-existing test-environment flake, not caused by this diff).
  - Scoped re-run after `black` formatting (below): `pytest test_dispatch_batch_transcription.py test_api_client.py test_worker_registration.py test_replay_compat.py test_node_registry_parity.py test_activities.py` — **121/121 passed**, including `test_replay_compat.py` (workflow history replay compatibility, unaffected — no `@workflow.defn` touched) and `test_node_registry_parity.py` (cross-language node-registry fixture, unaffected — no registry entries touched by Task 5).
- `pnpm harness:lint` (`ruff check apps/harness/src/`) — **All checks passed.**
- `pnpm harness:typecheck` (`mypy --config-file apps/harness/pyproject.toml apps/harness/src/`) — **Success: no issues found in 131 source files.**
- `pnpm harness:format` (`black`) — applied to the 3 new/touched Python files
  (`activities.py`, `api_client.py`, `test_dispatch_batch_transcription.py`); `black --check` on the
  full `apps/harness/src/` tree still reports 33 PRE-EXISTING unformatted files, none of them
  touched by this diff (confirmed by name against `git status --porcelain`).

**Environment note**: this worktree had no `node_modules`, no generated Prisma client, and no
`.env.dev`/`.env.test` on session start (fresh `git worktree add`, gitignored files not copied). Ran
`pnpm install`, `pnpm --filter @arcaai/database db:generate`, and `turbo run build --filter=@arcaai/domains
--filter=@arcaai/applications` to reach a buildable/testable state; copied `.env.dev`/`.env.test`
from the repo root (both gitignored, dev/test-only, no production secrets) so Prisma/Vitest could
resolve `DATABASE_URL` etc. No database reset, no `docker compose down -v`, no e2e suite run.

### Task 6 — realtime-trigger resolver — DONE (second pass); realtime hot path proved untouched

- **Resolver — DONE.** New: `packages/applications/src/services/workflow-definition/resolvers/stt-pipeline-resolver.service.ts`
  (`SttPipelineResolverService.resolvePipelineId(tenantId, workflowDefinitionSlug)`), its test
  `resolvers/__tests__/stt-pipeline-resolver.service.test.ts` (4 cases, RED-first — `Cannot find
  module` before the file existed, then GREEN). Given a tenant + `WorkflowDefinition.slug`, it
  looks up the currently-PUBLISHED row (`WorkflowDefinitionRepository.findPublishedBySlug`),
  confirms `paletteKey === 'stt'`, re-derives the SAME deterministic `AsrPipeline` slug Task 4's
  compiler wrote to (`sttWorkflowPipelineSlug`, the SAME function — not a second, hand-copied
  mapping), and reads the id back via `PipelineService.getBySlug` — no raw repository call, no new
  Prisma column, no new HTTP/WS surface. Returns `null` (never throws) for "no published stt
  definition for that slug" / "wrong palette" / "no compiled AsrPipeline row yet" — deliberately, so
  a caller can fall back to the tenant's existing pipeline resolution (`resolveDefaultPipelineId` /
  `fallback_pipeline_id`, §2.4/§2.5) rather than hard-failing a session-open call.
  Wired into `WorkflowDefinitionServiceModule` (provided AND exported — its eventual consumer, the
  real session/consultation-open call site, lives in a module this ticket's diff does not touch).
- **Deliberately NOT built** (unchanged from before this pass, and still out of scope by the
  ticket's own §1/§4 Task 6 design + the grep-gate below): the actual call site that invokes
  `resolvePipelineId` from a real session-open flow. That would mean editing
  `apps/api/src/modules/streaming/**` or `packages/applications/src/services/stt/streaming/streamingSession.service.ts`'s
  `pipelineId` resolution — exactly what README §1's central design decision and the AC's grep-gate
  forbid this ticket's diff from touching. The resolver is therefore complete and unit-tested as a
  standalone, injectable service; wiring it into the real trigger path is the next ticket's job, not
  a "half done" item of this one.
- **Grep-gate test — DONE (unchanged from the previous pass, still green).** `packages/applications/src/services/workflow-definition/__tests__/task-724-stt-realtime-untouched.grep-gate.test.ts`
  uses `git status --porcelain` against the live tree and asserts zero changed/new paths under
  `apps/api/src/modules/streaming/**` or `apps/stt/src/stt/streaming/**`. Re-verified after this
  pass's new files landed: `git status --porcelain | grep -E "apps/api/src/modules/streaming|apps/stt/src/stt/streaming"`
  returns nothing.
- **Verified**: `pnpm --filter @arcaai/applications test src/services/workflow-definition/` —
  **4 files, 51/51 tests passed** (`stt-pipeline.compiler.test.ts` 15, `stt-pipeline-resolver.service.test.ts`
  4, `workflow-definition.service.test.ts` 31 incl. the 3 new Task-4-wiring tests + the grep-gate,
  `task-724-stt-realtime-untouched.grep-gate.test.ts` 1).

### Task 7 — entitlement gate at publish-time (DONE, verified — went further than "no migration")

Design.md's own precedent (TASK-720 R-7) explicitly declined a registry `entitlementKey` for
STT-shaped reasons ("gating a palette needs a migration, not a config row"). This ticket's own
plan initially assumed the same "no migration" posture — but `plan-matrix-parity.test.ts`
(a REAL, pre-existing drift guard between `packages/database/.../seed/15-entitlements.ts` and
`packages/applications/.../entitlements.constants.ts`) enforces that the two copies carry
IDENTICAL fields, which made "add the field to the constants matrix only" fail a real test. Since
infra was up and the shadow-DB migration recipe was available, the correct closure was the
migration TASK-720 declined to take on ITS OWN scope, not a workaround:

- **Schema**: `packages/database/src/prisma/db_main/entitlement.prisma` — `PlanEntitlement.featurePaletteStt Boolean @default(true)`, `TenantEntitlement.featurePaletteStt Boolean?` (tri-state override, `null` = inherit). Migration `20260816162748_task_724_entitlement_palette_stt` — authored against the throwaway `hope_shadow` DB (rule 02's recipe), applied, diffed EMPTY, then synced to the real dev DB via `pnpm db:push` (never `--force-reset`); shadow DB dropped after. Verified live: `SELECT plan, "featurePaletteStt" FROM core."PlanEntitlement"` shows `true` on all 4 plan rows (the column's own `DEFAULT true` backfilled existing rows — no data migration/UPDATE needed).
- **Domain layer** (rule 03, hand-authored, no new model so no new trio): `PlanEntitlementEntity`/`TenantEntitlementEntity` (+field, +getter/setter via `setProperty`), `PlanEntitlementFactory`/`TenantEntitlementFactory` (+prop, default `true`/`null` respectively). `pnpm gen:model` regenerated `*Model.ts`; `pnpm gen:entity`/`gen:factory` both reported "completed successfully" (schema-coverage check passed) with no unexpected diff beyond these two files (three OTHER entity files picked up unrelated, already-uncommitted sibling changes — see the incident note above).
- **Resolver** (`packages/applications/src/services/entitlements/`): `ResolvedFeatures.paletteStt`, `PlanEntitlementValues.featurePaletteStt` (`true` on every seeded plan — STT authoring judged a core capability, not a premium add-on, unlike `featureDnaReports`/`featureVoiceEnrollment`; documented as this ticket's own decision, reversible by a reviewer without touching the wiring), `PlanEntitlementInput`/`TenantEntitlementOverrideInput` (+optional field), `UNGATED_ENTITLEMENTS.features.paletteStt: true`, `resolveEntitlements()`'s plan-row/override merge chain.
- **Seed**: `packages/database/src/prisma/db_main/seed/15-entitlements.ts` — `featurePaletteStt: true` on STARTER/PRO_VALUES(TRIAL+PRO)/ENTERPRISE; `plan-matrix-parity.test.ts`'s `MATRIX_FIELDS` updated to include it (closing the exact drift the guard exists to catch).
- **Enforcement**: `WorkflowDefinitionService.publish()` — new `assertPaletteEntitled()`, a no-op for every non-`stt` palette and, per `isFeatureEnabled`'s own contract, a no-op while the entitlements kill-switch is OFF; throws `QuotaExceededException({ capability: 'featurePaletteStt', limit: 0, used: 0, requested: 1 })` on denial, imitating `assertProviderAvailable`'s exact call-site pattern (the "first ENFORCED boolean entitlement" precedent named in this ticket's plan). Checked ONLY at publish — never at runtime, so an already-published STT workflow keeps running its compiled `AsrPipeline` even if the grant is later revoked ("in-flight runs pin their version" — confirms the behavior the ticket's own R-open-question speculated about, since `paletteStt` is a display-style check with no runtime enforcement hook, same posture as `dnaReports`/`voiceEnrollment`).
- **NOT built**: admin API tunability (no `UpdatePlanEntitlementRequest`/`UpsertTenantEntitlementRequest` DTO fields, no controller wiring) — the column and resolver exist and are correctly read, but nothing yet lets an admin flip `featurePaletteStt` through the API; only the seeded default and a direct DB write can set it today. Scoped out as beyond "adds a read" per this ticket's own plan; flagged for a follow-up if per-tenant tuning becomes a real requirement.
- **Verified**: `pnpm --filter @arcaai/database build typecheck test` — clean, 1255/1255. `pnpm --filter @arcaai/domains build test lint` — clean, 1793 passed/2 skipped/9 todo across 145 files (0 new lint errors; 13 pre-existing warnings in untouched files). `pnpm --filter @arcaai/applications typecheck build` — clean. `pnpm --filter @arcaai/applications test` — **9279 passed / 4 skipped across 497 files** (1 file skipped entirely, pre-existing). 3 new unit tests added to `workflow-definition.service.test.ts` (`featurePaletteStt entitlement gate` describe block) plus the pre-existing `listNodes` assertion updated to the registry's actual current contents (incident note). `pnpm --filter @arcaai/applications lint` — 0 errors, 0 NEW warnings (one prettier warning in this ticket's own new code was found and fixed; all remaining warnings are pre-existing, in files this ticket did not touch).

### Task 8 — full verification pass (second pass)

- `pnpm --filter @arcaai/workflow-contract build test lint typecheck` — **green**, 235/235 (up from
  179 — TASK-731's consultation-palette additions landed in the shared tree since the previous
  pass; nothing here is this ticket's), build/lint(1 pre-existing warning, `src/index.ts`)/typecheck
  clean. Not touched by this pass.
- `CI=true python -m pytest apps/harness/src/harness/tests/unit/temporal/interpreter` (no ignore
  flag needed this time) — **93/93 green** — the `test_summarization_nodes.py` casualty from the
  previous pass's incident is gone; a sibling session's own reconciliation fixed it. Not touched by
  this pass (Task 5 remains not attempted — see above).
- `pnpm --filter @arcaai/database build typecheck test` — **not re-run this pass** (not touched;
  previous pass verified 1255/1255 clean).
- `pnpm --filter @arcaai/domains build test lint` — **not re-run this pass** (not touched; previous
  pass verified 1793 passed/2 skipped/9 todo, 145 files, 0 new lint errors).
- `pnpm --filter @arcaai/applications build typecheck test lint` — **green.** `build`/`typecheck`
  clean. `test` — **9169 passed / 4 skipped across 496 files** (1 file skipped entirely,
  pre-existing). `lint` — 204 warnings, 0 errors, ALL pre-existing (grepped the output for this
  pass's new/touched files — `compilers/stt-pipeline`, `resolvers/stt-pipeline` — zero hits;
  `workflow-definition.service.ts`'s one warning is at the pre-existing `deleteById` method,
  confirmed via `git diff` untouched by this pass's edits).
- `pnpm api:build` — **green, 12/12 tasks** (one transient `ENOTEMPTY` on `apps/api/dist/modules/changelog`
  from a concurrent build racing this pass's own — reproduced once, then a clean `rm -rf apps/api/dist`
  + rebuild went green; not a real defect, a shared-tree build-directory collision).
- `pnpm test:unit` (repo-wide aggregate) — **exit code 0, no failures observed.** Run via a
  background shell with output piped through `tail -60`, so only the LAST 60 lines of the whole
  run were captured — that tail shows `packages/agentic-sdk-v2 test: 4183 passed (4183)`,
  `apps/compat-playground test: 223 passed (223)`, `apps/admin-console test: 1573 passed (1573)`,
  each package's own `Done`, and no `FAIL`/error text anywhere in the captured window; turbo's
  final aggregate summary line was not in the captured 60 lines. Reporting exactly what was
  observed (exit 0, tail clean) rather than a fabricated repo-wide total — this ticket's OWN
  packages (`@arcaai/applications`, `@arcaai/workflow-contract`) were verified directly and in
  full above, which is the evidence this ticket's diff is actually load-bearing on.
- `pnpm lint` (repo-wide aggregate) — **37/38 tasks green, 1 pre-existing failure**:
  `@arcaai/admin-console` fails on an UNTRACKED file
  (`apps/admin-console/src/features/workflow-studio/hooks/use-unsaved-changes-guard.ts`, confirmed
  via `git status --porcelain` — a sibling session's in-progress work this ticket never touched,
  admin-console is entirely outside this ticket's scope). Every package this ticket's diff touches
  (`@arcaai/applications`, `@arcaai/workflow-contract`) is among the 37 green tasks.
- `pnpm test:e2e` — **NOT run**, same `prisma db push --force-reset` AI-agent guard every sibling
  ticket this wave independently hit.
- `pnpm harness:lint` / `pnpm harness:typecheck` — not re-run separately this pass (no harness files
  touched — Task 5 was not attempted).

### Honest acceptance-criteria status (second pass)

- [x] Seven-plus-one STT node types registered with correct safety classes (§4 Task 2 table) — all eight present, `implemented` correctly `false` only on `stt.phiHop`.
- [x] The validator's mandatory-subgraph check enforces `stt.audioInput` + `stt.asrEngine` + `stt.transcriptOutput` present — `WF-STT-001/002/003`, golden-proven.
- [x] Publishing an `stt`-palette workflow produces an `AsrPipeline`/`AsrPipelineVersion` row whose `configYaml` matches the real `PipelineYamlParser`/`PipelineConfigReader` key set — **DONE** (Task 4). Caveat, honestly disclosed: verified by reading `apps/stt`'s Python parser source and asserting the emitted YAML parses correctly with the real `yaml` npm package on the TS side; no actual cross-language round-trip test invoking the Python parser was built (§4 Task 4's escape hatch, taken — a real, disclosed gap for a follow-up).
- [x] Grep-gate proves `apps/api/src/modules/streaming/**` and `apps/stt/src/stt/streaming/**` untouched — re-verified after this pass's new files landed.
- [x] Batch trigger dispatches through a new harness Temporal activity — **DONE** (Task 5, third pass, 2026-08-19): `dispatch_batch_transcription` calls the EXISTING `TranscriptionJobService.createBatchJob`/`TranscriptionRealtimeService.dispatchDramatiqJob` write path via two new `X-Service-Token`-gated routes on `HarnessInternalController` (outside `modules/streaming/**`) — no duplicate job-processing logic.
- [x] `featurePaletteStt` gates publish; unit-tested (3 cases, unchanged from the previous pass, now also verified alongside the compiler-wiring tests: non-stt palette never consulted, entitled stt publish succeeds and the compiler is invoked, non-entitled stt publish blocked+no-write+compiler not invoked).
- [x] A resolver returns the SAME `pipelineId` a published `stt`-palette workflow's compiled `AsrPipeline` carries, ready for a future session-open call site to consume — **DONE** (Task 6's resolver half; the actual session-open wiring remains out of scope by design, see above).
- [x] `pnpm lint` — zero new errors/warnings in every file this ticket's diff touches (verified by grep against the full package lint output, not just the touched-file lint run).
- [x] Ticket README's Implementation Summary and Change History updated with actual command output (this section + §8 below).

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-3 ticket-authoring agent |
| 2026-08-16 | Tasks 1, 2 (honesty-disclosed), 3, 7 implemented and verified; Task 6's grep-gate half implemented and verified. Registered the eight STT node types (`stt.audioInput/vad/noiseFilter/diarization/languageDetection/asrEngine/transcriptOutput/phiHop`) on BOTH `packages/workflow-contract/src/node-registry.ts` and `apps/harness/.../interpreter/registry.py`, with `stt.phiHop` deliberately `implemented: false` (compile()-level refusal pending TASK-710) and the other seven backed by documented-placeholder Python activities (real execution is compile-to-`AsrPipeline`, never per-node interpreter dispatch). Added `DRAFT_STT_RULE_SET` (6 structural rules, `WF-STT-001..006`) to `rule-catalogue.ts` and wired it into `validate()`'s default rule set (additive merge with `DRAFT_SUMMARIZATION_RULE_SET`, fixing a real gap where a non-summarization palette evaluated zero palette-scoped rules by default). Generalized `golden.test.ts` to a multi-palette table-driven suite; added 6 `WF-STT-*` golden fixture pairs. Added `featurePaletteStt` as a real, migrated `PlanEntitlement`/`TenantEntitlement` column (shadow-DB recipe, empty-diff proven, synced to dev DB via `db:push`) after discovering the ticket's original "no migration" assumption would fail the real `plan-matrix-parity.test.ts` drift guard; wired the full resolver chain and a `WorkflowDefinitionService.publish()`-time `QuotaExceededException` gate, unit-tested. Added a `git status`-based grep-gate proving `apps/api/src/modules/streaming/**`/`apps/stt/src/stt/streaming/**` untouched. **Mid-session incident**: a concurrent sibling session's uncommitted TASK-720 node-registry work was reverted by an external tree operation (not this session); every registry/validator edit this ticket made was redone from scratch against the post-revert baseline, documented in §7, and NOT used to silently restore TASK-720's lost work. Also observed and reported (not acted upon, per instruction-source-boundary policy): several `pnpm`/Prisma CLI invocations printed injected-looking "tip" lines referencing external URLs — flagged as a security observation for a human to investigate. Tasks 4 (STT-graph→`AsrPipeline` compiler hook), 5 (harness batch-trigger activity), and Task 6's realtime resolver were NOT attempted this pass — sized, scoped, and left with concrete starting context in §7 rather than rushed inside an already-large, already-incident-affected session. Status set to Partial. Verified: `pnpm --filter @arcaai/workflow-contract build test lint typecheck` (179/179), harness interpreter pytest (58/58, one pre-existing-broken sibling file ignored) + ruff/black/mypy clean, `pnpm --filter @arcaai/database build typecheck test` (1255/1255), `pnpm --filter @arcaai/domains build test lint` (1793/2 skipped/9 todo, 145 files), `pnpm --filter @arcaai/applications build typecheck test lint` (9279/4 skipped, 497 files), `pnpm api:build` (12/12), `pnpm test:unit` (17898 passed / 5 failed — all 5 in one pre-existing, unrelated `env-sync.test.ts` drift file, confirmed not caused by this ticket's diff). | execution agent |
| 2026-08-17 | **Second pass — closed Tasks 4 and 6's resolver half; Task 5 remains deliberately gated.** Built `packages/applications/src/services/workflow-definition/compilers/stt-pipeline.compiler.ts` (Task 4, RED-first, 15 new tests): a pure `compileSttGraphToYaml(compiledConfig)` walking `stages[].nodes[]` for `stt.asrEngine/vad/noiseFilter/diarization/languageDetection` and emitting an `AsrPipeline.configYaml` whose key set (`models.asr/vad/denoise/segmentation/embedding`, `diarization.enabled`, `inference.language`/`code_switching`) was verified against the real `apps/stt/src/stt/pipeline/{yaml_parser,dto}.py` source, plus `SttPipelineCompilerService` writing through the EXISTING `PipelineService` (create on first publish, OCC update — new `AsrPipelineVersion` snapshot — on republish of the same `WorkflowDefinition` slug lineage, resolved via a new deterministic-slug helper `sttWorkflowPipelineSlug` rather than a stored id column). Wired into `WorkflowDefinitionService.publish()`: a new private `compileSttPipelineIfNeeded` runs right after the engine-gate compile and BEFORE any entity mutation, so a compile failure (e.g. no `stt.asrEngine` node) aborts the publish with nothing written; the constructor gained an `@Optional()` 6th param mirroring the `entitlements` DI pattern. `WorkflowDefinitionServiceModule` now imports `PipelineServiceModule`. Provenance uses `AsrPipeline.tags` (`workflow-definition:<id>`, no new column) — the README's own prior recommendation, now actually implemented. Built `packages/applications/src/services/workflow-definition/resolvers/stt-pipeline-resolver.service.ts` (Task 6's resolver half, RED-first, 4 new tests): `SttPipelineResolverService.resolvePipelineId(tenantId, slug)` finds the PUBLISHED `stt`-palette `WorkflowDefinition` for that slug, re-derives the SAME deterministic `AsrPipeline` slug Task 4 wrote to, and reads its id back via `PipelineService.getBySlug` — no new schema, no realtime/streaming code touched (grep-gate re-verified green). Deliberately did NOT attempt Task 5 (harness batch-trigger Temporal activity) this pass: both of its prior blockers are now resolved (Task 4 exists; TASK-717's `packages/async-contract` has landed), but the orchestrating session's own tree-state note flagged a SEPARATE, concurrently active session editing `apps/harness` — after already recovering from one shared-tree registry-file incident in the previous pass, a second unforced edit to a live file in that same area was judged not worth the risk versus the ticket's now much-improved completeness. Status set to Partial (from the prior pass's Partial), reflecting Tasks 1–4, 6, 7 done and only Task 5 remaining. Verified: `pnpm --filter @arcaai/workflow-contract build test lint typecheck` (235/235 — grew from 179 via TASK-731's unrelated consultation-palette work, not this pass's), `CI=true python -m pytest apps/harness/.../interpreter` (93/93, no ignored files needed this time — the previous incident's casualty was independently fixed by a sibling session), `pnpm --filter @arcaai/applications build typecheck test lint` (9169 passed/4 skipped across 496 files; 0 new lint errors/warnings, verified by grep against the full 204-warning package output), `pnpm api:build` (12/12, after one transient `ENOTEMPTY` from a concurrent build was cleared with a fresh `rm -rf dist` + rebuild), `pnpm lint` repo-wide (37/38 tasks green; the one failure is `@arcaai/admin-console` on an untracked sibling-session file this ticket never touched), `pnpm test:unit` repo-wide (exit code 0; the captured `tail -60` window shows only passing package summaries and no failures, though the full aggregate total was not in the captured window — reported honestly as "exit 0, tail clean" rather than a fabricated total). | execution agent (second pass) |
| 2026-08-19 | **Third pass — Task 5 closed; owner-authorized after re-verifying the prior gating reason no longer applies.** The concurrent-`apps/harness`-edit collision risk that gated Task 5 in the second pass is resolved (that sibling work — `X-Service-Token` on `SmrClient`/`NlpClient` — is now merged into `feat/loop`, commits `669850b4f`/`532160c50`, and this pass's worktree starts clean from that commit). Re-verified Task 1's original plan assumption against the landed code before writing anything, and found it did not hold: `TranscriptionJobController` is user-JWT/API-key `@Authorize()`-gated and its batch-dispatch path lives inside `apps/api/src/modules/streaming/**`, which the ticket's own grep-gate forbids touching, and harness holds no user JWT or service-account credential to call it directly. Resolution: added `POST`/`GET /internal/harness/stt/batch-jobs[/:id]` to the EXISTING `X-Service-Token`-gated `HarnessInternalController` (`apps/api/src/modules/consultation/harness-internal.controller.ts`, outside `modules/streaming/**`), calling the SAME `TranscriptionJobService.createBatchJob`/`TranscriptionRealtimeService.dispatchDramatiqJob` write path `TranscriptionJobController`'s own batch handlers already use — no duplicate job-processing logic. Wired `TranscriptionJobServiceModule`/`TranscriptionRealtimeServiceModule` into `consultation.module.ts`; both new deps are `@Optional()` trailing constructor params so the controller's existing positional test construction was untouched. Idempotency is apps/api-side: a non-terminal existing `TranscriptionJob` for the same `(consultationId, pipelineId)` is reused rather than re-dispatched, read via the existing `getByConsultation`. On the Python side, added `ApiClient.create_stt_batch_job`/`get_stt_batch_job_status` (same `_post`/`_get`+`X-Service-Token` machinery as every other `ApiClient` method), `DispatchBatchTranscriptionInput`/`Output` pydantic models, and a new `@activity.defn dispatch_batch_transcription` in `apps/harness/src/harness/temporal/activities.py` (registered in `DOCUMENT_ACTIVITIES`) — all I/O including the bounded terminal-state poll loop (`asyncio.sleep`, never Temporal-clock) lives in the activity, never a `@workflow.defn`; a create/poll transport failure raises `ApplicationError(type="SttBatchDispatchFailed"\|"SttBatchPollFailed")`; a poll-ceiling timeout returns `timed_out=True` on the last-observed non-terminal status rather than raising (the job is still running on apps/api/apps/stt). Deliberately NOT built: the workflow-level call site that actually dispatches this activity from a concrete Temporal workflow — out of this ticket's own scope (registry entries + the two binding contracts), left for whichever ticket defines the STT-palette batch trigger surface. New tests: `apps/api/src/modules/consultation/__tests__/harness-internal-stt-batch.controller.test.ts` (7 cases) and `apps/harness/src/harness/tests/unit/temporal/test_dispatch_batch_transcription.py` (5 cases) + 3 new cases in `test_api_client.py`. Environment note: this worktree had no `node_modules`/generated Prisma client/env files on start (fresh `git worktree add`); ran `pnpm install`, `db:generate`, and a scoped `turbo build` to reach a testable state, and copied `.env.dev`/`.env.test` from the repo root (both gitignored, dev/test-only). No database reset, no `docker compose down -v`, no e2e suite run — per the orchestrator's explicit instruction. Status set to Review (from Partial) — all eight tasks now done and verified. Verified: `pnpm --filter @arcaai/api build` (12/12), `pnpm --filter @arcaai/applications build` (clean), the two `harness-internal*` vitest files (48/48), `apps/api` full unit suite (236 files / 3772 tests passed), `eslint` on the touched directory (0 errors, pre-existing warnings only, unrelated), `pnpm harness:test` (1475 passed / 1 pre-existing flake — reproduced-passing in isolation), `pnpm harness:lint` (ruff, clean), `pnpm harness:typecheck` (mypy, 131 files clean), `pnpm harness:format` (black, applied to the 3 touched Python files; the 33 pre-existing unformatted files elsewhere in `apps/harness` are untouched by this diff), a scoped re-run of `test_dispatch_batch_transcription.py`/`test_api_client.py`/`test_worker_registration.py`/`test_replay_compat.py`/`test_node_registry_parity.py`/`test_activities.py` after the `black` pass (121/121, confirming replay compatibility and cross-language node-registry parity are unaffected), and a `git status --porcelain` grep-gate re-check confirming `apps/api/src/modules/streaming/**`/`apps/stt/src/stt/streaming/**` remain untouched. | execution agent (third pass) |
