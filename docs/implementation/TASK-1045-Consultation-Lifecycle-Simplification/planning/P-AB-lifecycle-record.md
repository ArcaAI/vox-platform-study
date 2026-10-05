# P-AB plan — lifecycle (A) + record model (B)

Planner: opus (read-only), HEAD `7bfbded6d`, 2026-10-05. Orchestrator addendum folded in. Consolidated into README §6; this file is the binding contract for the DB, domain, lifecycle, record, STT and API lanes.

**No harness Python change.** The harness never reads `ConsultationStatus`; it only sends the phase literal `"DRAFT_PENDING_SENSORS"` (`temporal/models.py:979`, mapped `harness-internal.dto.ts:205`) and the gate decision `"SIGNED"`. Both wire literals stay → Temporal replay unaffected.

## 1. Contracts

### 1.1 Prisma (one DB lane, two migrations)

```prisma
// enums.prisma — ConsultationStatus REPLACED (type swap in M2)
enum ConsultationStatus { OPEN RECORDING PAUSED STOPPED APPROVED CLOSED_COMPLETE CLOSED_INCOMPLETE  @@schema("core") }
enum ConsultationProcessing { IDLE FINALIZING_TRANSCRIPT SUMMARIZING PROCESSING_ATTACHMENT AWAITING_REVIEW FAILED  @@schema("core") }
enum ConsultationClosedReason { AUTO MANUAL APPROVED  @@schema("core") }
// ContextItemType += TRANSCRIPT_SEGMENT, FULL_TRANSCRIPT, FACT_LEDGER, ENCOUNTER_RECAP
// HarnessAuditAction (harness.prisma) += SESSION_APPROVED
// ResourceType (audit.prisma + domains ResourceType.ts) += ConsultationEncounter, ConsultationApproval
```

```prisma
// Consultation — add
  processing          ConsultationProcessing   @default(IDLE)
  processingReason    String?
  processingRefs      String[]                 @default([])
  processingPrior     ConsultationProcessing?
  processingUpdatedAt DateTime?
  lastActivityAt      DateTime                 @default(now())
  reopenCount         Int                      @default(0)
  currentEncounterSeq Int                      @default(1)
  segmentSeqHead      Int                      @default(0)
  recordingCursorMs   Int                      @default(0)
  approvedAt          DateTime?
  closedAt            DateTime?
  closedReason        ConsultationClosedReason?
  Encounters ConsultationEncounter[]
  Approvals  ConsultationApproval[]
  @@index([status, lastActivityAt], name: "Consultation_status_lastActivity_idx")
  @@index([tenantId, doctorId, patientId, departmentId], name: "Consultation_openKey_idx")

model ConsultationEncounter {
  metaData         Json?     @map("_metadata") @db.JsonB
  version          Int       @default(1) @map("_version")
  id               String    @id @default(uuid(7))
  tenantId         String
  consultationId   String
  Consultation     Consultation @relation(fields: [consultationId], references: [id])
  seq              Int
  visitType        String
  externalRef      String?
  startedAt        DateTime  @default(now())
  endedAt          DateTime?
  recordingStartMs Int?
  recordingEndMs   Int?
  createdBy        String?   @default("60000000-0000-0000-0000-000000000000")
  updatedBy        String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  @@unique([consultationId, seq], map: "ConsultationEncounter_consultation_seq_key")
  @@index([tenantId], name: "ConsultationEncounter_tenantId_idx")
  @@index([consultationId], name: "ConsultationEncounter_consultationId_idx")
  @@index([tenantId, externalRef], name: "ConsultationEncounter_tenant_externalRef_idx")
  @@schema("core")
}

model ConsultationApproval {
  metaData            Json?    @map("_metadata") @db.JsonB
  id                  String   @id @default(uuid(7))
  tenantId            String
  consultationId      String
  Consultation        Consultation @relation(fields: [consultationId], references: [id])
  approvedBy          String
  approvedAt          DateTime @default(now())
  consultationVersion Int
  encounterCount      Int
  snapshot            Json     @db.JsonB // {items:[{contextItemId,type,versionNumber,encounterSeq}]} ids only
  snapshotHash        String
  attestationHash     String?
  createdAt           DateTime @default(now())
  @@index([tenantId], name: "ConsultationApproval_tenantId_idx")
  @@index([consultationId, approvedAt], name: "ConsultationApproval_consultation_approvedAt_idx")
  @@schema("core")
}

// ContextItem — add (P-D's columns included)
  encounterSeq Int?
  segmentSeq   Int?
  segmentKey   String?   // "${sttSessionId}:${utteranceIndex}"
  t0Ms         Int?
  t1Ms         Int?
  speaker      String?
  capturedAt   DateTime?
  occurredAt   DateTime  @default(now())
  @@index([consultationId, occurredAt, id], name: "ContextItem_consultation_occurred_idx")
  @@index([consultationId, type, segmentSeq], name: "ContextItem_consultation_type_segmentSeq_idx")
  @@index([consultationId, encounterSeq], name: "ContextItem_consultation_encounter_idx")

// AudioRecording — add
  encounterSeq Int?
  recordingStartMs Int?
  sttSessionId String?
  codec String?
```

- `ConsultationEncounter`, `ConsultationApproval`: tenant-scoped, no soft delete → `TENANT_SCOPED_MODELS` + `MODELS_WITHOUT_SOFT_DELETE`.
- `ContextItemVersion`: no new columns; derived-version links in `_metadata.derivedFrom{contextItemId,versionNumber}`; documented `changeSource` `segment_edit|feedback|manual|ai` (legacy values stay readable; P-E adds `ai_section_regen`).

**M1 `<ts>_task_1045_enum_values`**: only `ALTER TYPE … ADD VALUE` (ContextItemType ×4, HarnessAuditAction, ResourceType ×2 + P-CG ×3) — separate because an added value cannot be used in the same transaction.

**M2 `<ts>_task_1045_consultation_lifecycle`** (order matters):
1. `CREATE TYPE ConsultationProcessing`, `ConsultationClosedReason`; columns, tables, indexes.
2. Backfill while old values are readable: `processing` (DRAINING→FINALIZING_TRANSCRIPT, DRAFT_PENDING_SENSORS→SUMMARIZING, PENDING_REVIEW→AWAITING_REVIEW, else IDLE); `reopenCount`=1 where REOPENED; `closedReason` (CLOSED_COMPLETE & CLOSED→APPROVED; TIMED_OUT→AUTO; CLOSED_INCOMPLETE→AUTO when `updatedBy` NULL/'system' else MANUAL); `closedAt`=`updatedAt` for closed; `lastActivityAt`=`now()` for non-closed (avoids a mass auto-close on deploy) else `updatedAt`; `ContextItem.occurredAt`=`createdAt`.
3. Encounter seq 1 per consultation: visitType from `metadata.visitType` (default `'new-visit'`), `externalRef` from the column, `startedAt`=`createdAt`, `endedAt`=`closedAt`; ids `gen_random_uuid()` (TASK-844 precedent).
4. SIGNED rows only: `ConsultationApproval` snapshot (`jsonb_agg` of id + `currentVersionNumber`, `_metadata.backfilled='task_1045'`).
5. Type swap: `CREATE TYPE "ConsultationStatus_new"`; `ALTER COLUMN status DROP DEFAULT`; `ALTER COLUMN status TYPE … USING CASE status::text WHEN 'PRIMED' THEN 'OPEN' WHEN 'REOPENED' THEN 'OPEN' WHEN 'DRAINING' THEN 'STOPPED' WHEN 'DRAFT_PENDING_SENSORS' THEN 'STOPPED' WHEN 'PENDING_REVIEW' THEN 'STOPPED' WHEN 'SIGNED' THEN 'APPROVED' WHEN 'TIMED_OUT' THEN 'CLOSED_INCOMPLETE' WHEN 'CLOSED' THEN 'CLOSED_COMPLETE' ELSE status::text END`; drop old, rename, `SET DEFAULT 'OPEN'` (one column only, `consultation.prisma:45`).
6. Close duplicates of the open key: keep the newest non-closed row per (tenant, doctor, patient, department), others → CLOSED_INCOMPLETE, `closedReason` AUTO, `metadata.task1045DuplicateClosed=true`. **(Owner decision OD-AB1.)**
7. Hand-written partial/expression indexes: `Consultation_openKey_uq` ON (`tenantId`, `doctorId`, `patientId`, COALESCE(`departmentId`,'')) WHERE status NOT IN (CLOSED_*) AND `resourceStatus` <> 'DELETED'; `ConsultationEncounter_externalRef_uq` (`consultationId`, `externalRef`) WHERE `externalRef` IS NOT NULL; `ContextItem_segmentKey_uq` (`consultationId`, `segmentKey`) WHERE `segmentKey` IS NOT NULL; `ContextItem_fullTranscript_uq` (`consultationId`) WHERE type='FULL_TRANSCRIPT' AND not deleted; `ContextItem_encounterArtifact_uq` (`consultationId`, type, `encounterSeq`) WHERE type IN ('FACT_LEDGER','ENCOUNTER_RECAP') AND not deleted. `Consultation_encounterKey_uq` (TASK-1020) kept.
8. Immutability triggers (TASK-810 pattern): `ContextItemVersion` DELETE raises; UPDATE raises only when `NEW IS DISTINCT FROM OLD` (seed no-op upsert tolerated). `ConsultationApproval` UPDATE/DELETE raise.

Other planners' models in the same DB lane: P-CG (`ConsultationAttachment`, `ConsultationFeedback`, `ConsultationFeedbackDailyRollup`, `GateEditExemplar` columns, partial `ConsultationFeedback_latest_uq`), P-E (`AiActivityRun`, `SummaryMeta` columns; final names per P-E "Final revision").

### 1.2 Transition matrix (`ConsultationEntity`)

| From | To | Command | Actor |
|---|---|---|---|
| OPEN | RECORDING | start | clinician / machine |
| OPEN | CLOSED_INCOMPLETE | close, auto-close | user / system |
| RECORDING | PAUSED | pause; stale (no bytes `recordingStaleMinutes`) | user / system |
| RECORDING | STOPPED | stop | user |
| RECORDING | CLOSED_INCOMPLETE | close (flush first), auto-close | user / system |
| PAUSED | RECORDING | start (resume) | user |
| PAUSED | STOPPED | stop | user |
| PAUSED | CLOSED_INCOMPLETE | close, auto-close | user / system |
| STOPPED | RECORDING | start (continue current encounter) | user |
| STOPPED | OPEN | open appends an encounter | open |
| STOPPED | APPROVED | approve | clinician |
| STOPPED | CLOSED_INCOMPLETE | close, auto-close | user / system |
| APPROVED | CLOSED_COMPLETE | close, auto-close | user / system |
| CLOSED_INCOMPLETE | OPEN | reopen | user |
| CLOSED_COMPLETE | OPEN | reopen, only if tenant policy allows | user |

Self-transitions are idempotent no-ops. `processing` has no matrix; `setProcessing` clears `processingReason` unless FAILED/AWAITING_REVIEW. Approve refused while processing is FINALIZING_TRANSCRIPT or SUMMARIZING.

### 1.3 Open key

1. `externalRef` set → encounters by (tenant, ref) joined to (patient, doctor); hit = idempotent (returns its consultation even if closed, `recordable:false`); same ref other patient → 409 `EXTERNAL_REF_CONFLICT`.
2. Else the non-closed consultation for (tenant, doctor, patient, department; null-safe).
3. Append an encounter when a new ref, or no ref + `visitType=revisit` + current encounter has `endedAt`. Only from OPEN/STOPPED; RECORDING/PAUSED → 409 `ENCOUNTER_CAPTURE_ACTIVE`; APPROVED → 409 `CONSULTATION_APPROVED`. Appending ends the previous encounter, bumps `currentEncounterSeq`, status OPEN.
4. No non-closed match → new consultation chained to the latest closed match as parent.
5. Appointment date leaves the key. 6. Race on `Consultation_openKey_uq` returns the winner.

### 1.4 Routes (business plane, `consultations/…`)

| Method / path | Request | Response | Errors |
|---|---|---|---|
| POST `open` | unchanged | `ConsultationResponse` + `encounterAppended` | as today + `ENCOUNTER_CAPTURE_ACTIVE`, `CONSULTATION_APPROVED` |
| POST `:id/start` | `{sessionId?}` | `CaptureState` | 409 `CONSULTATION_NOT_RECORDABLE`, `STT_SESSION_NOT_ACTIVE`, `CONSULTATION_TRANSITION_ILLEGAL` |
| POST `:id/pause` | `{}` | `CaptureState` | 409 illegal |
| POST `:id/stop` | `{waitForFinal?=true, persistSnapshot?, acceptedProposals?}` | `StopResult` | 409 illegal |
| POST `:id/approve` (If-Match) | `{clinicianUserId?, overrideSafetyFlag?}` | `ConsultationResponse` | 409 `CONSULTATION_PROCESSING_IN_FLIGHT`/illegal/safety; 412; 428 |
| POST `:id/close` (If-Match) | `{clinicianUserId?}` | `ConsultationResponse` | 409; 412; 428 |
| POST `:id/reopen` (If-Match) | `{reason?}` (≤256) | `ConsultationResponse` | 409 `CONSULTATION_REOPEN_NOT_ALLOWED`/illegal |
| GET `:id/encounters` | — | `Encounter[]` | 404 |
| GET `:id/recording` | — | `{contextItemId, versionNumber, codec, totalMs, parts:[{audioRecordingId, encounterSeq, startMs, durationMs, url, expiresAt}]}` | 404 |
| GET `:id/events` (SSE) | `?since=` | `LifecycleEvent` frames | 404 |

Deprecated one release (Deprecation/Sunset headers + register): `:id/recording/start|stop` (stop defaults `waitForFinal=false`); `:id/prime` (no-op → OPEN, consent decorator kept); `:id/summary/:contextItemId/approve` → session approve (OD-AB2).

Internal: POST `internal/stt/segments` (service token) `{tenantId, consultationId, sttSessionId, audioOffsetMs, segments:[{utteranceIndex, text, speaker?, startMs, endMs, capturedAt, language?}]}` → `{accepted, duplicates, lastSegmentSeq}`; empty batch = heartbeat (touches activity).

Authz: commands copy `recording/start` decorators (`svc:consultation:session:write`; start keeps `@RequiresConsent`); approve copies `approveSummary`; SSE uses the live-summary stream guards. Content lock: edits on APPROVED/CLOSED_COMPLETE → 409 `CONSULTATION_APPROVED`; on CLOSED_INCOMPLETE → 409 `CONSULTATION_CLOSED` (`summary.service.ts:775` 400 → 409).

DTOs: `CaptureState {consultationId, status, processing, encounterSeq, sessionId?, recording, paused, version, updatedAt}`; `StopResult` = CaptureState + `finalTranscript:{state:'complete'|'pending', contextItemId|null, versionNumber|null, segmentCount, lastSegmentSeq}`; `ConsultationResponse` += `processing, processingReason, lastActivityAt, autoCloseAt, reopenCount, closedReason, closedAt, reopenAllowed (CLOSED_INCOMPLETE true; CLOSED_COMPLETE policy; else false), currentEncounterSeq, encounters[], approval{id, approvedAt, approvedBy, snapshotHash, itemCount}|null`; `recordable` true for OPEN/RECORDING/PAUSED/STOPPED.

**ALaaS 4.1 compatibility:** without `X-Hope-Lifecycle: 2`, JSON `status` is projected to the old vocabulary (PAUSED→RECORDING; STOPPED+FINALIZING_TRANSCRIPT/IDLE→DRAINING; STOPPED+SUMMARIZING→DRAFT_PENDING_SENSORS; STOPPED+AWAITING_REVIEW/FAILED→PENDING_REVIEW; APPROVED→SIGNED); the real value is always in `lifecycle:{status, processing}`. SDK 5.0.0 sends the header.

**Lifecycle events:** `LifecycleEvent {type: opened|encounter_appended|started|paused|stopped|transcript_final|processing_changed|approved|closed|reopened, consultationId, status, processing, processingReason?, closedReason?, encounterSeq?, version, at, seq}` on Redis `consultation:lifecycle:{id}` (50-entry replay for `since`). Tenant-level fan-out pinned to the existing path: sys-event `ResourceUpdated` (resourceType `Consultation`, `data.action='lifecycle'`, `data.event`) → webhooks/resource subscriptions (how an unconnected consumer learns about an auto-close). AB-4a verifies the subscription filter can match `data.action`.

### 1.5 WS + STT control

| Dir | Message | Effect |
|---|---|---|
| client→gw | `{type:'pause'}` | `bridge.writeControlCommand(id,'pause')` (`streamingAudioBridge.service.ts:343`); gateway `capturePaused` |
| client→gw | `{type:'resume-capture'}` | control `'resume'` (`resume` is the reconnect handshake) |
| gw→client | `{type:'status', status:'paused', sessionId, audioOffsetMs}` | after the tail flush (last final arrives first) |
| gw→client | `{type:'status', status:'capturing', sessionId, audioOffsetMs}` | resumed |
| gw→client | `{type:'status', status:'pause_expired', sessionId}` then `closed` | pause over the limit |
| gw→client | `{type:'error', code:'PAUSE_UNSUPPORTED'}` | older STT |

Paused: gateway + STT drop frames without advancing the audio clock. HTTP pause/stop send the same control (server authoritative across pods). STT: PAUSE/RESUME (rejected today, `session_manager.py:5362`) → `_pause_capture` (await backlog, `_flush_final_utterance` + drain without the once-per-session tail latch, flush segment outbox, `capture_paused`, publish status) / `_resume_capture`; reaper skips paused until `streaming_pause_max_s` then finalizes `pause_expired` (consultation stays PAUSED; next start opens a new STT session at the recording cursor). New `segment_outbox.py` (≤25 per batch / 1500 ms, immediate on pause/finalize → `/internal/stt/segments`, transcript-outbox redrive pattern). Dual capture → Ogg/Opus via soundfile (`format='OGG', subtype='OPUS'`) (D-13). STT sends session-relative ms; gateway adds the binding offset (`TranscriptionJob.metaData.recordingOffsetMs`).

### 1.6 Service signatures (packages/applications)

```ts
IConsultationLifecycleService: start(id,{sttSessionId?,supersedeByDurableBinding?}):Promise<CaptureState>;
  pause(id,{reason?:'user'|'stale_recording'}):Promise<CaptureState>;
  stop(id,{waitForFinal?:boolean}):Promise<StopResult>;
  approve(id,{expectedVersion:number,clinicianUserId?,overrideSafetyFlag?,caller:ClinicalCaller,legacyContextItemId?}):Promise<ConsultationResponse>;
  close(id,{expectedVersion?,clinicianUserId?,caller?,auto?:boolean}):Promise<ConsultationResponse>;
  reopen(id,{expectedVersion:number,reason?}):Promise<ConsultationResponse>;
IConsultationLifecycleGate (P-CG): assertContentWritable(id); touchActivity(id);
  beginProcessing(id,'processing_attachment',refId); endProcessing(id,refId,{failed?,reason?}); currentEncounterSeq(id):Promise<number>;
  setProcessing(id,p,reason?)   // none bump _version; each emits processing_changed
ITranscriptRecordService: ingestSegments(input); onSessionFinal({tenantId,consultationId,sttSessionId,sessionDurationMs?}):Promise<{contextItemId,versionNumber,segmentCount}>;
  awaitFinal(consultationId,sttSessionIds,timeoutMs):Promise<'complete'|'pending'>;
  onSegmentEdited(segmentItemId,versionNumber,changedBy); appendRecordingPart({consultationId,audioRecordingId,mediaId,durationMs,encounterSeq,sttSessionId});
  upsertEncounterArtifact({consultationId,encounterSeq,type:'FACT_LEDGER'|'ENCOUNTER_RECAP',content,source,changedBy,metaData}) // storage for P-E producers
IContextService.appendVersion({contextItemId,content,expectedVersion?,changeSource:'feedback'|'segment_edit'|'manual'|'ai',changeReason,changedBy,metaData}):Promise<{versionNumber}>
IAttachmentTranscriptSink.onBatchTranscript({jobId,text}):Promise<boolean> // @Optional in sttInternal.createTranscript batch path; true ⇒ skip segments + TranscriptionCreated
ISecretsProvider.encryptBatch(plaintexts:Buffer[],keyName?):Promise<string[]>
```

Stop flow: STOPPED + FINALIZING_TRANSCRIPT → finalize control to every live bound STT session → `awaitFinal` (Redis `consultation:stt-final:{cid}:{sid}`, up to the setting timeout) → STT finalize lands in `createStreamingTranscriptInner` (aggregate TRANSCRIPT row still written one release) → `onSessionFinal` rebuilds FULL_TRANSCRIPT from segments (ignoring `metaData.origin` items) → only then `TranscriptionCreated` (so P-E reads the rebuilt transcript) → `FullTranscriptRebuilt` + `transcript_final` event. P-E's `EncounterStopped {consultationId, tenantId, encounterSeq}` is emitted at the same point. Recording: one AUDIO_RECORDING item per consultation; each stop appends a version with `_metadata` manifest `{parts[], totalMs}`. Segment and full-transcript items carry `metaData.sttRunKey` (for P-E's reader).

### 1.7 Settings

| Key | Tier / type | Max scope | Fail mode | Default |
|---|---|---|---|---|
| `consultation.autoClose` | global-kv json | tenant | open-to-default | `{mode:'idle', idleMinutes:720, dailyAt:null}`; 15–10080; `dailyAt` "HH:mm" tenant appointment-day TZ |
| `consultation.reopen.allowClosedComplete` | boolean | tenant | open-to-default | false |
| `consultation.stop.finalTranscriptTimeoutSeconds` | number | system | open-to-default | 30 (5–120) |
| `stt.streaming.pauseMaxSeconds` | number (consumer stt) | system | open-to-default | 600 |

Kept: `consultation.state.recordingStaleMinutes` (30, now auto-pause), `…sessionTimeoutSweep.cron` (drives auto-close). Deprecated one release (no consumer): `consultation.state.{sessionTimeoutMinutes,reviewTimeoutMinutes,openTimeoutMinutes,requirePrimedBeforeRecording}`, `consultation.session.completionTimeoutMinutes`. Harness gate SLA derives from `autoClose.idleMinutes × 60` (`harness-policy.service.ts:375-533`).

## 2. Lanes (A = `packages/applications/src/services/`)

| Lane | Tier | Wave | Depends | Files | RED→GREEN test | Done |
|---|---|---|---|---|---|---|
| AB-1 DB | opus | 1 | — | `db_main/{enums,consultation,audit,harness}.prisma`; M1+M2; `src/client.ts`; `src/extensions/tenant-scope.ts`; `seed/09-consultation.ts` (:77-264, :1465) — plus P-CG + P-E schema | `packages/database/src/__tests__/consultation-lifecycle-task1045.postgres.test.ts` | orchestrator applies on shadow DB; drift diff empty |
| AB-STT | opus | 1 | contract | `apps/stt/src/stt/streaming/{session_manager.py,session.py,schemas.py,redis_streams.py,segment_outbox.py (new)}`, `core/config/settings.py`, `core/control_plane.py`, `core/api_client/gateway.py` | `apps/stt/tests/unit/streaming/test_task1045_pause_resume_capture.py`, `test_task1045_segment_outbox.py` | last final before `paused`; frames dropped while paused; reaper exemption; Opus |
| AB-2 Domain | opus | 2 | AB-1 | `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/` Consultation, ContextItem, AudioRecording (edit), ConsultationEncounter*, ConsultationApproval* (new); `enums/generated/{ConsultationStatus,ConsultationProcessing,ConsultationClosedReason,ContextItemType,HarnessAuditAction,ResourceType}.ts`; `models/generated` (`gen:model`); `core.database.module.ts`; barrels (+ P-CG / P-E domain trios if one lane) | `entities/__tests__/ConsultationEntity.lifecycle.task1045.test.ts`, `repositories/generated/core/__tests__/ConsultationRepository.lifecycle.task1045.test.ts` | matrix; no-version-bump `touchActivity/setProcessing/allocateSegmentSeqs/advanceRecordingCursor`; `findOpenByKey`, `findAutoCloseEligible`, `findStaleRecording`, `findSegments`, `findFullTranscript`, `createSegmentsBatch`; coverage OK |
| AB-WS | sonnet | 2 | AB-STT contract | `apps/api/src/modules/streaming/stt-ws.gateway.ts` | `apps/api/src/modules/streaming/__tests__/stt-ws.gateway.pause-capture.task1045.test.ts` | control forwarded; paused audio dropped without clock advance; status relay |
| AB-3 Open | opus | 3 | AB-2 | `A/consultation/consultation/{consultation.service.ts,open-markers.ts,consultation.dto.mapper.ts,IConsultationService.ts,dto/consultation.response.ts,dto/encounter.response.ts (new)}`, `A/consultation/encounter/consultation-encounter.service.ts` (new); TASK-1020 README Change History pointer | `A/consultation/consultation/__tests__/consultation.service.open-episode.task1045.test.ts` | §1.3; prime/start/stop/close/reopen delegate to the lifecycle service |
| AB-4a Lifecycle | opus | 3 | AB-2 | `A/consultation/lifecycle/` (new: service, approval, content-lock gate, activity, legacy-status projection, events publisher, module, dto); `A/consultation/summary/summary.service.ts` (signing core, alias, lock); `A/consultation/document-section/document-section.service.ts` (lock); `A/consultation/index.ts` | `lifecycle/__tests__/consultation-lifecycle.service.task1045.test.ts`, `consultation-approval.service.task1045.test.ts` | snapshot + hash; ATTEST + SESSION_APPROVED; harness approval signal kept; 409 lock codes; events |
| AB-4b Auto-close | sonnet | 3 | AB-2 | `A/consultation/timeout-sweep/*`, `A/consultation/completion-timeout/*` (processor → draining no-op), `consultation-gates.constants.ts`, `settings-registry/descriptors/{consultation-gates,consultation-completion,consultation-lifecycle (new),stt-runtime}.descriptors.ts`, `settings-registry/registry.ts`, `harness-policy/harness-policy.service.ts` + `dto/harness-policy.response.ts`, `apps/api/src/scripts/cleanup-orphan-consultations.ts` | `timeout-sweep/__tests__/consultation-auto-close.sweep.task1045.test.ts` | idle/daily in tenant TZ; stale → pause; batch cap 200; `closedReason` AUTO |
| AB-4c Harness callers | opus | 3 | AB-2 | `A/consultation/harness/harness-internal.service.ts`, `harness/dto/harness-internal.dto.ts` (doc), `live-documentation/live-documentation.service.ts:1069`, `harness-observability/harness-observability.service.ts` + `dto/gate-queue.response.ts`, `agentPromotion/agentPromotion.service.ts:446` | `harness/__tests__/harness-internal.lifecycle-processing.task1045.test.ts` | `persistDraft` → processing SUMMARIZING/AWAITING_REVIEW (no status write); `failGovernedRun` → FAILED; escalation no longer closes |
| AB-5 Record | opus | 3 | AB-2 | `A/consultation/transcript-record/` (new), `A/stt/internal/sttInternal.service.ts`, `A/stt/internal/dto/internal.request.ts`, `A/consultation/context/context.service.ts` (`appendVersion`, lock, segment-edit derived version), `A/baseServices/_meta/secrets/{ISecretsProvider.ts,SecretsService.ts,providers/*}` (`encryptBatch`) | `transcript-record/__tests__/transcript-record.service.task1045.test.ts` | idempotent ingest, one Transit call per batch, timeline offset, FULL_TRANSCRIPT versions, recording manifest, attachment sink hook |
| AB-6 API | opus | 4 | AB-3, 4a, 5 | `apps/api/src/modules/consultation/{consultation.controller.ts,consultation.module.ts,admin-consultation.controller.ts (filter map :58-90),harness-internal.controller.ts (docs),dto/*}`, `apps/api/src/modules/internal/stt-internal.controller.ts`, vocabulary middleware (new), `docs/operations/deprecation-register.md` | `apps/api/src/modules/consultation/__tests__/consultation.controller.lifecycle.task1045.test.ts`; authors (not run) `apps/api/tests/e2e/consultation-lifecycle-task1045.spec.ts` (+cross-tenant) | §1.4 routes + aliases; SSE; header projection |
| AB-8 Test sweep | sonnet | 5 | all | legacy tests in §3 | only those files | new vocabulary |

## 3. Callers of the 12-state enum

- AB-1: `enums.prisma:296-320`; `consultation.prisma:45`; `seed/09-consultation.ts:77,95,111,127,143,161,179,196,215,248,264,1465`.
- AB-2: `ConsultationEntity.ts:39-86,316,370`; `ConsultationFactory.ts:58`; `ConsultationRepository.ts:396,415,449-453,483,513,542`; `enums/generated/ConsultationStatus.ts`.
- AB-3: `consultation.service.ts:2054-2105,2122-2134,2231-2243,2417-2454,2606-2616`; `open-markers.ts:136-150`; `dto/consultation.response.ts:66-86`; `IConsultationService.ts:146-198`.
- AB-4a: `summary.service.ts:775,875,1121,1147`.
- AB-4b: `consultation-timeout-sweep.service.ts:315,398-560`; `consultation-gates.constants.ts:91-218`; `consultation-gates.descriptors.ts:135-241`; `completion-timeout/*`; `harness-policy.service.ts:375-533`; `app.module.ts:382` (comment); `cleanup-orphan-consultations.ts`.
- AB-4c: `harness-internal.service.ts:163-178,954,994-1029,1882,2057,2084-2086,2414-2456,2496`; `live-documentation.service.ts:1069`; `harness-observability.service.ts:177-178`; `gate-queue.response.ts:14`; `agentPromotion.service.ts:446`.
- AB-6: `consultation.controller.ts:851-1095,2117-2150`; `admin-consultation.controller.ts:58-90`.
- P-E (one line handed over): `events/consultation-event.handler.ts:509` → `[APPROVED, CLOSED_COMPLETE]`.
- P-D: console `features/consultations/api/types.ts:18-28`, `consultation-status-badge.tsx`, `consultations-screen.tsx:23-33`, `consultation-workflow-meta.tsx`, `playground-consultation/api/types.ts`, `consultation-demo-screen.tsx:314`, `scribe/consultations-column.tsx`; vox-node `src/types/{consultation,consultation-realtime}.ts`, `src/resources/{consultations,consultation-recording,consultation-summaries}.ts`, `src/resources/admin/{schemas,consultation-admin}.ts`, `examples/06`, `examples/09`; agentic-sdk-v2 `src/types/consultation.ts`, `hooks/useArcaSession.ts`; OpenAPI artifacts.
- P-F: ALaaS svc + web_ui.
- AB-8 tests: apps/api `consultation.controller{,.recording-stop}.test.ts`, `tests/e2e/consultation-state-machine.spec.ts`; applications `consultation.dto.mapper.test.ts`, `consultation.service{,.close-attribution.task972,.open-encounter.task1020,.recording-stt-guard.task1001,.recording}.test.ts`, `consultation-event.handler.{governed-resume.task1022,resume.task1001}.test.ts`, `harness-internal.{fail-governed-run.task946,gate-abandon-close.task1001-wave5,governed-run-outcome.task982,same-day-prequel.task1020,service}.test.ts`, `same-day-prequel.task1020.test.ts`, 7 `live-documentation.*.test.ts`, 11 `summary.*.test.ts`, `consultation-timeout-sweep.service.test.ts`, `consultation-workflow-dispatch.supersede.task1022.test.ts`, `gate-edit-loop.e2e.test.ts`, `harness-observability.service.test.ts`, `consultation-completion-timeout.task1001.test.ts`; domains `clinical-harness-phase1-domain.test.ts`, `ConsultationEntity.transitions.test.ts`, `consultationStatus.wired.test.ts`, `ConsultationRepository.findTimeoutSweepEligible.test.ts`; database `clinical-harness-phase1-schema.postgres.test.ts`; sdk `consultation.types.test.ts` (P-D).

## 4. Shared files

`harness-internal.service.ts` → AB-4c first, then P-E E3, then E6. `live-documentation.service.ts` → AB-4c (one line) first, then E6. `consultation-event.handler.ts` → P-E (line handed over). `summary.service.ts` → AB-4a. `context.service.ts`, `sttInternal.service.ts` → AB-5 (P-CG consumes `appendVersion` + the sink). `consultation.controller.ts`, `admin-consultation.controller.ts` → AB-6 (P-CG/P-D add new controller files). `registry.ts` → AB-4b (others hand descriptor arrays). `core.database.module.ts` + barrels → AB-2. Prisma shared files → AB-1. Artifacts → P-D R.

## 5. Risks

- R1 replay: no workflow change; wire literals kept; in-flight gate timers escalate into `recordEscalation` (no close); pending completion-timeout jobs drain via the no-op processor; `test_replay_compat` in the gate.
- R2 mixed-version cutover: the type swap takes ACCESS EXCLUSIVE + rewrite; old pods would write removed values → cutover window (scale api + harness-worker to 0, PreSync migrate on DIRECT_URL, roll forward); deploy STT first (old STT → `PAUSE_UNSUPPORTED`).
- R3 data migration: duplicate open-key closure (OD-AB1; fallback Redis single-flight lock instead of the unique index); `lastActivityAt=now()`; 200-row sweep cap; full ContextItem UPDATE for `occurredAt`; partial/expression index drift handled like TASK-1020.
- R4 triggers only via migrations (db-push dev DBs have none) → AB-1 test on a migrated DB.
- R5 ALaaS 4.1 window: header projection + aliases; **late Copy to EMR on CLOSED_INCOMPLETE** used the removed edge CLOSED_INCOMPLETE→SIGNED → OD-AB2.
- R6 `_version` churn: processing/activity writes never bump `_version` (pinned AB-2).
- R7 segment volume: batched Transit + `createMany`; idempotency on `segmentKey`.
- R8 stop holds HTTP ≤30 s (ingress ~60 s); timeout → `state:'pending'`, client waits for `transcript_final`.
