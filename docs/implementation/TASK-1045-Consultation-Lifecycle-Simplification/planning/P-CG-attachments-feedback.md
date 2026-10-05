# P-CG plan — attachments (C) + feedback & quality loop (G)

Planner: sonnet (read-only), 2026-10-05. Consolidated into README §6; this file is the planner's record.

Abbreviations: **A** = `packages/applications/src/services`, **D** = `packages/domains/src`, **DB** = `packages/database/src`, **API** = `apps/api/src/modules/consultation`. New controllers in new files (`consultation.controller.ts` untouched). New schema is soft-reference only (no FK; no edits to `Consultation` / `ContextItemVersion` models).

## 1. Contracts

### 1.1 Prisma (new files `DB/prisma/db_main/consultation-attachment.prisma`, `consultation-feedback.prisma`; enums in `enums.prisma`, all `@@schema("core")`)

```prisma
enum ConsultationAttachmentKind    { DOCUMENT IMAGE AUDIO CASE_NOTE }
enum ConsultationAttachmentPurpose { ATTACHMENT FEEDBACK }
enum ConsultationAttachmentStatus  { INTENT UPLOADED PROCESSING READY FAILED EXPIRED }
enum FeedbackRating                { UP DOWN CLEARED }
enum FeedbackTargetKind            { NOTE SECTION SEGMENT ENTITY TRANSCRIPT RECAP }

model ConsultationAttachment {            // rule-02 template: metaData/_version/id/tenantId … resourceStatus, audit
  tenantId String
  consultationId String                   // soft ref
  encounterSeq Int?
  purpose ConsultationAttachmentPurpose @default(ATTACHMENT)
  kind ConsultationAttachmentKind
  status ConsultationAttachmentStatus @default(INTENT)
  uploadMode String @default("PRESIGNED") // PRESIGNED | GATEWAY
  declaredMime String
  declaredSizeBytes Int
  declaredSha256 String                   // hex
  bucketName String
  objectKey String                        // ids only
  encryptedFileName Bytes?                // file name is PHI-prone
  keyVersion Int?
  idempotencyKey String?
  uploadExpiresAt DateTime                // 10 min
  intentExpiresAt DateTime                // 24 h reaper cutoff
  completedAt DateTime?
  failureCode String?
  mediaId String?
  contextItemId String?
  transcriptionJobId String?
  @@unique([tenantId, consultationId, idempotencyKey], map: "ConsultationAttachment_idem_uq")
  @@index([tenantId], name: "ConsultationAttachment_tenantId_idx")
  @@index([tenantId, consultationId], name: "ConsultationAttachment_tenant_consultation_idx")
  @@index([status, intentExpiresAt], name: "ConsultationAttachment_reap_idx")
  @@index([transcriptionJobId], name: "ConsultationAttachment_job_idx")
}

model ConsultationFeedback {              // append-only: no resourceStatus, no _version
  id String @id @default(uuid(7))
  tenantId String
  consultationId String
  encounterSeq Int?
  actorUserId String                      // human; machine callers act as the row's doctorId
  actorCredentialClass String             // jwt | api-key | service-account
  actorPrincipalId String?
  clientApp String?
  clientSurface String?
  targetKind FeedbackTargetKind?          // null = consultation-level free text
  targetContextItemId String?
  targetVersionNumber Int?                // server pins currentVersionNumber when omitted
  targetSectionKey String?
  targetDocumentKey String?
  targetEntityRef String?                 // NamedEntity.id
  entityLabel String?                     // NamedEntity.className
  targetKey String?                       // "kind|item|ver|section|entity"; null without target
  rating FeedbackRating?                  // null = comment/media/correction only
  reasonCodes String[] @default([])
  encryptedComment Bytes?
  keyVersion Int?
  mediaIds String[] @default([])          // READY purpose=FEEDBACK attachments' Media ids
  correctionContextItemId String?
  correctionVersionNumber Int?            // ContextItemVersion(changeSource=feedback); its metaData.feedbackId points back
  provenance Json? @db.JsonB
  provAgentSlug String?
  provAgentVersion Int?
  provModelName String?
  provPromptVersion String?
  provWorkflowRunId String?
  provActivityRunId String?
  idempotencyKey String?
  isLatest Boolean @default(true)
  supersedesId String?
  createdBy String? @default("60000000-0000-0000-0000-000000000000")
  createdAt DateTime @default(now())
  @@index([tenantId, consultationId, createdAt])
  @@index([tenantId, createdAt])
  @@index([tenantId, actorUserId, targetKey, isLatest])
}

model ConsultationFeedbackDailyRollup {   // derived, replaced per day
  id String @id @default(uuid(7))
  tenantId String
  day DateTime @db.Date                   // UTC
  targetKind FeedbackTargetKind
  agentSlug String @default("")
  agentVersion Int @default(0)
  modelName String @default("")
  promptVersion String @default("")
  sectionKey String @default("")
  entityLabel String @default("")
  reasonCode String @default("")          // '' row carries rating counts; a code row carries reasonedCount only
  upCount Int @default(0)
  downCount Int @default(0)
  clearedCount Int @default(0)
  commentCount Int @default(0)
  correctionCount Int @default(0)
  reasonedCount Int @default(0)
  computedAt DateTime @default(now())
  @@unique([tenantId, day, targetKind, agentSlug, agentVersion, modelName, promptVersion, sectionKey, entityLabel, reasonCode], map: "ConsultationFeedbackDailyRollup_dim_uq")
}
```

- Migration `<ts>_task_1045_consultation_attachments_feedback`; hand-added partial unique `ConsultationFeedback_latest_uq ON (tenantId, actorUserId, targetKey) WHERE "isLatest" AND "rating" IS NOT NULL AND "targetKey" IS NOT NULL` (precedent `Consultation_encounterKey_uq`); DB lane confirms empty diff (rule 02 step 3).
- `ResourceType` += `ConsultationAttachment`, `ConsultationFeedback`, `ConsultationFeedbackRollup` (`audit.prisma` + one `ADD VALUE` migration + `D/enums/generated/ResourceType.ts`; parity test guards).
- `TENANT_SCOPED_MODELS` += all three; `MODELS_WITHOUT_SOFT_DELETE` += `ConsultationFeedback`, `ConsultationFeedbackDailyRollup`.
- `GateEditExemplar` (`harness.prisma`) += `source String @default("GATE")`, `feedbackId String?`, `reasonCodes String[] @default([])`, `targetKind String?`, `@@index([tenantId, source])`; `findByConsultation` filters `source='GATE'`.

### 1.2 Attachment routes (new controller, prefix `consultations`; `@Authorize()` + `@RequiredScopes('consultation:session:write')` + `@RequiredSvcScopes('svc:consultation:session:write')`; reads `:read`; ownership = owner doctor | CASL manage | service account)

| Route | Request | Response |
|---|---|---|
| `POST :id/attachments` + `Idempotency-Key` | `{kind:'document'\|'image'\|'audio'\|'case_note', mime, sizeBytes, sha256 (hex), fileName?, purpose?:'attachment'\|'feedback', encounterSeq?}` | 201 `{attachmentId, status:'INTENT', kind, uploadMode, uploadUrl: string\|null, uploadMethod:'PUT', uploadHeaders:{'Content-Type','Content-Length','x-amz-checksum-sha256'?}, uploadExpiresAt, intentExpiresAt, maxSizeBytes}` |
| `POST :id/attachments/:aid/complete` | `{}` | 200 `{attachmentId, status:'READY', kind, mime, sizeBytes, sha256, mediaId, contextItemId\|null}`; 202 `status:'PROCESSING'` (+`transcriptionJobId?`) for audio or objects over the inline-verify size |
| `POST :id/attachments/:aid/content` (multipart `file`, ≤ `consultation.attachments.multipartMaxMb`) | file | same as complete (gateway fallback; SDK uses it when `uploadUrl` is null) |
| `GET :id/attachments`, `GET :id/attachments/:aid` | | status, failureCode, contextItemId, mediaId (poll PROCESSING) |

Replay (same key + body) → same `attachmentId`, re-presigned URL while INTENT; same key different body → 409 `IDEMPOTENCY_KEY_REUSED`. URL signed with bound content-type/length; client PUT sends no Authorization and no SSE header (bucket default SSE).

Errors: 400 validation · 404 consultation/attachment (cross-tenant) · 409 `CONSULTATION_APPROVED`/`CONSULTATION_CLOSED` (purpose=attachment) · 409 `QUOTA_EXCEEDED` (intent declared size + complete actual size) · 409 `ATTACHMENT_NOT_UPLOADED` (retryable) · 409 `IDEMPOTENCY_KEY_IN_FLIGHT`/`_REUSED` · 410 `ATTACHMENT_INTENT_EXPIRED` · 413 `ATTACHMENT_TOO_LARGE` · 415 `ATTACHMENT_TYPE_UNSUPPORTED`/`ATTACHMENT_CONTENT_MISMATCH` · 422 `ATTACHMENT_KIND_UNSUPPORTED` (at intent, `{supportedKinds[]}`) · 422 `ATTACHMENT_CHECKSUM_MISMATCH` · 402 spend limit (audio) · 503 `MEDIA_STORAGE_UNAVAILABLE`. Failed verify deletes the object, row FAILED, client opens a new intent.

Object key `consultations/{yyyy}/{MM}/{consultationId}/{attachments|feedback}/{attachmentId}/{attachmentId}.{ext}`; audio → recordings bucket, others → attachments bucket; `Media.name = {attachmentId}.{ext}`.

Dispatch on complete: `case_note` strict UTF-8 → `CASE_NOTE` v1 (`metaData.attachmentId`); `document`/`image` → `ATTACHMENT` item + existing `OcrEnrichmentProcessor`, PROCESSING→READY on extraction; `audio` → batch job (`createBatchJob` + `dispatchDramatiqJob`) → ONE `TRANSCRIPT` item (`source=TRANSCRIPTION`, `mediaId`=audio, `metaData.origin='attachment_audio'`), no segments, no `TranscriptionCreated` auto-summary; `purpose=feedback` → Media row only.

Capability `deriveSupportedKinds` (pure): `case_note` always; `audio` iff `AsrAgentResolverService.resolve` succeeds; `document` on the default engine, or under a governing workflow only with `document.extract_text` in `ILoopConfigService` subscriptions; `image` needs `vision.extract_text` (422 until TASK-1017). **OD-C1** (owner): default PDF supported, image 422 until TASK-1017.

### 1.3 Feedback routes (new controller; read-access check; no new scopes)

`POST consultations/:id/feedback` + `Idempotency-Key`:

```ts
{ target?: {kind, contextItemId, versionNumber?, sectionKey?, documentKey?, entityRef?},
  rating?: 'up'|'down'|'cleared', reasonCodes?: string[], comment?: string,
  attachmentIds?: string[], correction?: {content: string, expectedVersion?: number},
  client?: {app?: string, surface?: string} }
```

≥1 of rating/comment/attachmentIds/correction; rating needs a target; correction only on NOTE/SECTION/SEGMENT/TRANSCRIPT; reasonCodes only with `down`, validated against the effective list; ratings/comments allowed in every status; correction after approval → 409 `CONSULTATION_APPROVED`; OCC drift 412.

201 `FeedbackResponse {id, consultationId, target, rating, reasonCodes, comment (decrypted), attachmentIds, correction:{contextItemId,versionNumber}|null, isLatest, supersedes?, provenance, actor:{userId,credentialClass}, client, createdAt}`. Errors: 400 `FEEDBACK_REASON_UNKNOWN` (lists allowed) / `FEEDBACK_EMPTY` / `FEEDBACK_TARGET_REQUIRED` / `FEEDBACK_ATTACHMENT_INVALID`; 404; 409 `CONSULTATION_APPROVED`; 412; 413 comment length.

- `GET consultations/:id/feedback?targetKind&contextItemId&includeHistory&cursor&limit` (keyset; latest per actor+target default).
- `GET consultations/feedback/reason-codes` → `{items:[{code,label,appliesTo?}], source:'tenant'|'system'}`.
- `GET admin/feedback/rollups?from&to&groupBy=(day,agentVersion,model,promptVersion,section,entityLabel,reason,targetKind)&agentSlug&modelName` → `{rows:[…dims, up, down, cleared, comments, corrections, reasoned], truncated}`; TASK-1035 gate shape; PHI-free.
- Latest-per-target: append in a transaction flips the prior `isLatest`; target key includes the version.

### 1.4 Settings (new `A/settings-registry/descriptors/consultation-attachments-feedback.descriptors.ts`, `global-kv`, `open-to-default`)

| Key | Scope | Default |
|---|---|---|
| `consultation.attachments.multipartMaxMb` | tenant | 10 |
| `consultation.attachments.uploadUrlTtlSeconds` | system | 600 (60–3600) |
| `consultation.attachments.intentTtlHours` | system | 24 |
| `consultation.attachments.reapCron` | system | `*/15 * * * *` |
| `consultation.attachments.inlineVerifyMaxMb` | system | 32 |
| `consultation.feedback.reasonCodes` | tenant, json | `missing_information, wrong_medication_or_dose, wrong_patient_detail, made_something_up, wrong_section, too_long, wrong_language` |
| `consultation.feedback.commentMaxChars` | system | 4000 |
| `consultation.feedback.maxMediaPerFeedback` | system | 3 |
| `consultation.feedback.rollupCron` | system | `30 1 * * *` |
| `consultation.feedback.rollupLookbackDays` | system | 2 |

Reason list `{code,label,appliesTo?}[]`, tenant value replaces the list; validator 1–32 entries, code `^[a-z][a-z0-9_]{1,47}$`, unique, label 1–80. Presigned ceilings reuse `media.upload.maxAttachmentSizeMb` / `maxAudioSizeMb` and `stt.batch.maxFileSizeMb`.

### 1.5 Interfaces needed

- **P-E**: `IActivityRunRecordReader.findProducerOf({tenantId, consultationId, contextItemId, versionNumber?}) → {activityRunId, activityKind, encounterSeq, workflowSlug, workflowVersion, workflowRunId, nodeId, agentSlug, agentVersion, modelName, provider, deployment, promptTemplateId, promptVersion, startedAt, endedAt} | null` (note versions, sections, segments, full transcript, recap → ledger run, entity → parent item). Fallback until it lands: `SummaryMeta`.
- **P-AB**: `IConsultationLifecycleGate {assertContentWritable(id), touchActivity(id), beginProcessing(id,'processing_attachment',refId), endProcessing(id,refId,{failed?,reason?}), currentEncounterSeq(id)}`; `IContextService.appendVersion({contextItemId, content, expectedVersion?, changeSource:'feedback', changeReason, changedBy, metaData:{feedbackId}}) → {versionNumber}` (immutability trigger; derived full-transcript version on segment edit); uploaded-audio transcript type (`TRANSCRIPT` unless renamed; full-transcript rebuild ignores `metaData.origin`); call site in `sttInternal.createTranscript` → `IAttachmentTranscriptSink.onBatchTranscript({jobId,text}): Promise<boolean>` (true = handled: skip segments + `TranscriptionCreated`).
- **P-D**: SDK `sendAttachment` (sha256 → intent → PUT no auth → complete; `/content` when `uploadUrl` null; poll on 202; text case notes via existing `POST :id/context`); `sendFeedback` (feedback media first with `purpose:'feedback'`); retry 5xx/429/network with backoff+jitter + Retry-After; admin readers call `IConsultationFeedbackService.listForActivity(consultationId,{cursor,limit})` behind P-D's gate.

## 2. Lanes (each runs only its own test file)

| Lane | Tier/wave/deps | Files (create unless M) | Test / done |
|---|---|---|---|
| CG-DB | executed by the single DB lane | 2 `.prisma` files; M `enums.prisma`, `audit.prisma`, `harness.prisma`, `DB/client.ts`, `DB/extensions/tenant-scope.ts`, `D/enums/generated/ResourceType.ts`; migration | M `D/enums/__tests__/resourceType.enum-parity.test.ts`, `DB/extensions/__tests__/tenant-scope.test.ts`; shadow diff empty |
| CG-SET | sonnet W1 | descriptors file; M `A/settings-registry/registry.ts` | `…/__tests__/consultation-attachments-feedback.descriptors.task1045.test.ts` |
| CG-STO | sonnet W1 | M `A/baseServices/storage/providers/{IBlobStorageProvider.ts,s3-blob.provider.ts,azure-blob.provider.ts}`, `IBlobStorageService.ts`, `blob-storage.service.ts` | `…/storage/__tests__/blob-storage.presigned-intent.task1045.test.ts` — `headObject`, `getObjectRange`, `presignPut({contentLength, checksumSha256})`, `assertCanStore(bucket, bytes)`, `recordExternalWrite` |
| CG-POL | sonnet W1 | `A/consultation/attachment/{attachment-policy.ts,dto/*,index.ts}`, `A/consultation/feedback/{feedback-policy.ts,dto/*,index.ts}`, `A/media-upload/media-content-sniff.ts` (extracted); M `A/media-upload/media-upload.service.ts` | `attachment/__tests__/attachment-policy.task1045.test.ts`, `feedback/__tests__/feedback-policy.task1045.test.ts` |
| CG-DOM | sonnet W2 (CG-DB) | Entity/Factory/EntityMapper/Repository ×3; M barrels, `core.database.module.ts`; `ConsultationFeedbackRepository.encryption.ts` (Highlight pattern); `pnpm gen:model` | `D/__tests__/consultation-attachment-feedback.repositories.task1045.test.ts` — `appendWithSupersede(tx)`, `findLatestByActorTarget`, `listCursor`, `aggregateEvents`, `replaceDay`, `findReapable`, `claimIntentToUploaded` |
| C-SVC | opus W3 | `A/consultation/attachment/{IConsultationAttachmentService.ts,consultation-attachment.service.ts,attachment-capability.service.ts,consultation-attachment.service.module.ts,processors/{case-note,document,image}.processor.ts}` | `attachment/__tests__/consultation-attachment.service.task1045.test.ts` |
| C-AUD | sonnet W4 | `attachment/processors/audio.processor.ts`, `attachment/attachment-transcript.sink.ts`; M `A/stt/internal/sttInternal.service.ts` (one call site, P-AB-owned file) | `attachment/__tests__/audio-attachment.processor.task1045.test.ts` |
| C-REAP | sonnet W4 | `attachment/attachment-reaper.service.ts` + module (TenantStoragePurge cron + Redis lock + `createWorkerSession`) | `…/attachment-reaper.task1045.test.ts` — conditional INTENT→EXPIRED |
| C-API | sonnet W4 | `API/consultation-attachment.controller.ts`, `API/consultation-access.helper.ts`; M `API/consultation.module.ts` | `API/__tests__/consultation-attachment.controller.task1045.test.ts` |
| G-SVC | opus W3 | `A/consultation/feedback/{IConsultationFeedbackService.ts,consultation-feedback.service.ts,feedback-provenance.ts,consultation-feedback.service.module.ts}` | `feedback/__tests__/consultation-feedback.service.task1045.test.ts` |
| G-ROLL | sonnet W3 | `feedback/feedback-rollup.service.ts` + module | `…/feedback-rollup.service.task1045.test.ts` |
| G-API | sonnet W4 | `API/consultation-feedback.controller.ts`, `API/admin-feedback-rollup.controller.ts`; M `API/consultation.module.ts` | `API/__tests__/consultation-feedback.controller.task1045.test.ts` |
| G-MINE | sonnet W3 | M `A/gate-edit-mining/{gate-edit-mining.service.ts,gate-edit-mining.processor.ts,IGateEditMiningQueue.ts}`, exemplar domain trio, `A/consultation/feedback/IEvalGateCurationSink.ts` (+ no-op) | `gate-edit-mining/__tests__/gate-edit-mining.feedback.task1045.test.ts` — thumbs-down + corrections only, PENDING redacted rows, fail closed, de-identified NER labels |
| CG-E2E | sonnet W5 | `apps/api/tests/e2e/consultation-attachments-feedback-cross-tenant.spec.ts` (authored, not run) | orchestrator runs |

## 3. Shared files

DB/domain shared files → single DB/domain lane; `registry.ts` → one descriptor-wiring owner; `API/consultation.module.ts`, `app.module.ts`, `A/consultation/index.ts`, `A/services/index.ts` → orchestrator wiring after W4; `sttInternal.service.ts` → P-AB (one sink call); `context.service.ts`/`IContextService` → P-AB (`appendVersion`); `gate-edit-mining/*` → P-CG; `summary.service.ts` → P-E/P-AB; artifacts → orchestrator/R; `ocr-enrichment.processor.ts` → P-CG only if the READY/FAILED flip lands.

## 4. Risks

1. Presigned PUT needs public endpoint + CORS for a no-auth PUT; bucket default SSE unverified; Azure has no checksum header (server re-hash is authoritative).
2. Large audio synchronous hash → async verify above `inlineVerifyMaxMb` (202).
3. Quota at intent + complete; over-quota object deleted; `recordExternalWrite`; gate fails open on unreadable usage (as today).
4. OD-C1 capability default.
5. Uploaded audio must not trigger `TranscriptionCreated` auto-summary.
6. Item-type naming dependency on P-AB.
7. Batch dispatch logic lives in `agent.controller.ts` today — C-AUD replicates in the service layer incl. `failJob`; `asrResolver.resolve` with a bare consultationId unverified.
8. Partial unique index drift — rule 02 step 3.
9. Rollup counts events, not state (state from `isLatest`).
10. Reaper vs late complete — conditional update.
11. Machine feedback actor = consultation `doctorId` + `actorPrincipalId` (confirm with P-F).
12. Entity text is PHI — NER label export through `IPhiRedactor`, drop on failure.
13. Without P-E's reader, provenance falls back to `SummaryMeta` (empty for segments/transcripts).
