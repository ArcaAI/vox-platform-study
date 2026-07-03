import type { AuditLogJob } from '@arcaai/domains';
import { AuditLogFactory, AuditLogRepository, JobQueue } from '@arcaai/domains';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { createWorkerSession } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { AuditLogEncryptionService } from './auditLog-encryption.service';

@Processor(JobQueue.AuditLog)
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    private readonly cls: ClsService<IActiveUserContext>,
    // TASK-369 Phase 3D — envelope-encrypt data/previousData before the row is
    // written. @Optional so tests that construct the processor directly without
    // the encryption service degrade to plaintext-only (dual-read soak).
    @Optional() private readonly auditLogEncryption?: AuditLogEncryptionService,
  ) {
    super();
  }

  async process(job: Job<AuditLogJob>): Promise<void> {
    const { action, responsibleUserId, responsibleIp, resourceId, resourceType, data, previousData, metadata, correlationId, tenantId } = job.data;

    // TASK-305 D.9.3 follow-up — fail-closed when tenantId is missing.
    // Guards against legacy queue entries that predate the multi-tenancy
    // hardening contract. BullMQ will retry per `attempts` then DLQ.
    if (!tenantId) {
      throw new Error('AuditLogProcessor: job.data.tenantId is required');
    }

    // TASK-305 D.9.1 follow-up — Worker processes run OUTSIDE the API edge
    // ClsModule middleware. Rebind tenantId + user into a fresh CLS scope so
    // the Phase B tenantScope Prisma extension sees the correct context
    // (otherwise its "no CLS = super-admin pass-through" branch silently
    // bypasses scoping). Empty roles array — queue workers never have
    // SUPER_ADMIN bypass.
    //
    // No `assertEqualTenants` here: this processor only WRITES (never loads
    // an entity by id), so there is nothing to assert against. The factory's
    // required `tenantId` parameter + the fail-closed guard above are the
    // sufficient invariants.
    await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: responsibleUserId, tenantId, kind: 'audit' }));

      const entity = AuditLogFactory.CreateAuditLog({
        action,
        responsibleUserId,
        responsibleIp,
        resourceId,
        resourceType,
        data: data ?? {},
        previousData: previousData ?? {},
        // TASK-401 — impersonation provenance (and any other event metaData)
        // lands on the row's plaintext `metadata` JSONB column (non-PHI).
        metadata: metadata ?? null,
        correlationId,
        tenantId,
      });

      // TASK-369 Phase 3D — best-effort envelope encryption (no-op + plaintext
      // fallback when unavailable); never blocks the audit write.
      await this.auditLogEncryption?.encryptIntoEntity(entity);

      await this.auditLogRepository.create(entity);
    });
  }
}
