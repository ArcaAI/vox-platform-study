# SDK-205: Implementation Planning

> **Status:** Ready for Implementation
> **Estimated Effort:** 6 days
> **Priority:** High

---

## Task Breakdown

### Phase 1: Remove Kafka Infrastructure (Day 1) ✅ COMPLETED

#### Task 1.1: Remove Kafka from Docker Compose ✅
- [x] Edit `infrastructure/docker/docker-compose.dev.yml`
- [x] Remove `kafka` service block
- [x] Remove `kafka-init` service block
- [x] Remove `KAFKA_BROKERS` from `vault-init` environment

#### Task 1.2: Delete Kafka Scripts ✅
- [x] Delete `infrastructure/docker/scripts/init-kafka-topics.sh`
- [x] Delete `infrastructure/docker/scripts/create-stt-kafka-topics.sh`

#### Task 1.3: Remove NestJS Kafka Service ✅
- [x] Delete entire directory: `packages/applications/src/services/kafka/`

#### Task 1.4: Update Package Exports ✅
- [x] Edit `packages/applications/src/services/index.ts`
- [x] Remove kafka export

#### Task 1.5: Update API Gateway App Module ✅
- [x] Edit `apps/api/src/app.module.ts`
- [x] Remove `KafkaServiceModule` from imports and common array

#### Task 1.6: Remove Python Kafka Client ✅
- [x] Delete `apps/stt/src/stt/services/kafka_client.py`
- [x] Edit `apps/stt/src/stt/services/__init__.py` - remove kafka reference

#### Task 1.7: Update Environment Variables ✅
- [x] Edit `.env.example`, `.env.dev`, `.env.production`, `.env.test`
- [x] Edit `infrastructure/docker/env.stt-dev.example`
- [x] Edit `apps/stt/.env.dev.example`, `apps/stt/.env.production.example`, `apps/stt/env.dev.example`
- [x] Edit `apps/tts/.env.example`, `apps/tts/.env.production.example`

#### Task 1.8: Remove Package Dependencies ✅
- [x] Remove `kafkajs` from `packages/applications/package.json`

#### Task 1.9: Verify Removal ✅
- [x] Verified no Kafka imports remain in TypeScript code
- [x] Pre-existing build errors in `summary.service.ts` are unrelated to Kafka

---

### Phase 2: Verify Existing Audit System (Day 2) ✅ COMPLETED

#### Task 2.1: Verify ResourceType Enum ✅
- [x] Confirmed `ResourceType` enum includes all consultation types
- [x] Location: `packages/database/src/prisma/db_main/audit.prisma`

#### Task 2.2: Verify AuditLogService Module is Imported ✅
- [x] Added `AuditLogServiceModule` to `apps/api/src/app.module.ts`

#### Task 2.3: Verify Consultation Services Use BaseService ✅
- [x] Verified all services extend `BaseService`
- [x] `ConsultationService`, `ContextService`, `SummaryService` all extend BaseService

---

### Phase 3: Implement Async Job Queue (Day 3-4) ✅ COMPLETED

#### Task 3.1: Update JobQueue Enum ✅
- [x] Added `GeneratePreSummary`, `GenerateSummary`, `ExtractNamedEntities` queues

#### Task 3.2: Create Job DTOs ✅
- [x] Created `packages/applications/src/services/consultation/jobs/dto/job.dto.ts`
- [x] Defined all payload, status, and response types

#### Task 3.3: Create Consultation Job Service ✅
- [x] Created `consultation-job.service.ts` with all methods

#### Task 3.4-3.6: Create Processors ✅
- [x] Created `summary.processor.ts`
- [x] Created `pre-summary.processor.ts`
- [x] Created `ner.processor.ts`

#### Task 3.7: Create Job Service Module ✅
- [x] Created `consultation-job.service.module.ts`
- [x] Updated exports

---

### Phase 4: Update Consultation APIs (Day 5) ✅ COMPLETED

#### Task 4.1: Create Job Controller ✅
- [x] Created `apps/api/src/modules/consultation/job.controller.ts`
- [x] Implemented GET, DELETE, and SSE endpoints

#### Task 4.2: Update Summary Controller ✅
- [x] Added async endpoints for pre-summary, summary, and NER
- [x] Fixed user context retrieval (`clsService.get('user')?.id`)

#### Task 4.3: Update Consultation Module ✅
- [x] Added `ConsultationJobServiceModule` and `ConsultationJobController`
- [x] Processors are included in `ConsultationJobServiceModule`

#### Task 4.4: Register New Queues ✅
- [x] Added `GeneratePreSummary`, `GenerateSummary`, `ExtractNamedEntities` to `CommonServiceModule`
- [x] Added `RedisCacheModule.register()` to `ConsultationJobServiceModule`

#### Task 4.5: Update Summary Service (SKIPPED)
> **Note:** Async methods are NOT needed in `SummaryService` - the controller directly calls `ConsultationJobService` for async operations. This is the correct pattern: controllers handle the sync/async routing.

#### Task 4.6: Verify Audit Logging in Existing Services ✅
- [x] Verified `ConsultationService` calls `broadcastSysEvent` on create/update
- [x] Verified `ContextService` calls `broadcastSysEvent` on add/update
- [x] Verified `SummaryService` calls `broadcastSysEvent` on summary generation
- [x] `AuditLogServiceModule` added to `app.module.ts` to enable event listeners

#### Task 4.7: Test API Endpoints (MANUAL TESTING REQUIRED)
- [ ] Test async summary generation
- [ ] Test async pre-summary generation
- [ ] Test async NER extraction
- [ ] Test job status endpoint
- [ ] Test job cancellation
- [ ] Test SSE streaming

---

### Phase 5: Update Documentation (Day 6) ✅ COMPLETED

#### Task 5.1: Update COMMUNICATION_AND_DATA_TRANSFER.md ✅
- [x] Rewrote document to remove all Kafka references
- [x] Updated architecture diagram (Redis/BullMQ focus)
- [x] Added job queue architecture section
- [x] Added real-time notifications section
- [x] Added PostgreSQL audit logging section

#### Task 5.2: Update technical-architecture-overview.md ✅
- [x] Removed Kafka from mermaid diagram
- [x] Updated Infrastructure table (removed Kafka row)
- [x] Updated Storage Architecture section
- [x] Updated future roadmap section

#### Task 5.3: Update CONSULTATION_WORKFLOW.md ✅
- [x] Added async endpoint documentation
- [x] Added job status endpoints
- [x] Added async workflow example with code
- [x] Added job status response schema
- [x] Updated version to 1.1

---

## Verification Checklist

### After Phase 1 (Kafka Removal)
- [ ] `pnpm build` succeeds
- [ ] `pnpm lint` passes
- [ ] `docker compose up` works without Kafka
- [ ] API Gateway starts without errors
- [ ] No Kafka-related errors in logs

### After Phase 2 (Verify Existing Audit System)
- [ ] Confirmed `ResourceType` enum includes consultation types
- [ ] Verified `AuditLogService` is imported in app module
- [ ] Tested audit logging by creating a consultation
- [ ] Verified audit entries in database

### After Phase 3 (Job Queue)
- [ ] Jobs are created in Redis
- [ ] Jobs are processed by workers
- [ ] Job status updates work
- [ ] Redis pub/sub notifications work

### After Phase 4 (API Updates)
- [ ] Async endpoints return job IDs
- [ ] SSE streaming works
- [ ] Job cancellation works
- [ ] Audit events logged for all operations

### After Phase 5 (Documentation)
- [ ] No Kafka references in docs
- [ ] Architecture diagrams updated
- [ ] API documentation complete

---

## Rollback Plan

If issues arise during implementation:

1. **Phase 1 Rollback**: Restore Kafka files from git
   ```bash
   git checkout HEAD -- packages/applications/src/services/kafka/
   git checkout HEAD -- infrastructure/docker/docker-compose.dev.yml
   git checkout HEAD -- apps/api/src/app.module.ts
   ```

2. **Phase 2-4 Rollback**: New features are additive, can be removed without affecting existing functionality

3. **Database Rollback**:
   ```bash
   cd packages/database
   npx prisma migrate reset
   ```

---

## Dependencies

- Redis must be running for job queue
- PostgreSQL must be running for audit events
- SMR service must be available for summary generation
- NLP service must be available for NER extraction

---

## Notes

- Keep sync endpoints for backward compatibility
- Async endpoints return immediately with job ID
- SSE provides real-time updates without polling
- Audit events replace Kafka audit topics
- Redis pub/sub replaces Kafka for real-time notifications
