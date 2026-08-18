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
    // Envelope-encrypt data/previousData before the row is
    // written. @Optional so tests that construct the processor directly without
    // the encryption service degrade to plaintext-only (dual-read soak).
    @Optional() private readonly auditLogEncryption?: AuditLogEncryptionService,
  ) {
    super();
  }

  async process(job: Job<AuditLogJob>): Promise<void> {
    const {
      action,
      responsibleUserId,
      responsibleServiceAccountId,
      responsibleIp,
      resourceId,
      resourceType,
      data,
      previousData,
      metadata,
      correlationId,
      tenantId,
    } = job.data;

    // Fail-closed when tenantId is missing.
    // Guards against legacy queue entries that predate the multi-tenancy
    // hardening contract. BullMQ will retry per `attempts` then DLQ.
    if (!tenantId) {
      throw new Error('AuditLogProcessor: job.data.tenantId is required');
    }

    // Worker processes run OUTSIDE the API edge
    // ClsModule middleware. Rebind tenantId + user into a fresh CLS scope so
    // the tenantScope Prisma extension sees the correct context
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
        // TASK-762 — exactly one actor reaches the row. When the job names a
        // service account the factory leaves `responsibleUserId` NULL, so a
        // machine action is never recorded against a person.
        responsibleUserId,
        responsibleServiceAccountId,
        responsibleIp,
        resourceId,
        resourceType,
        data: data ?? {},
        previousData: previousData ?? {},
        // Impersonation provenance (and any other event metaData)
        // lands on the row's plaintext `metadata` JSONB column (non-PHI).
        metadata: metadata ?? null,
        correlationId,
        tenantId,
      });

      // Best-effort envelope encryption (no-op + plaintext
      // fallback when unavailable); never blocks the audit write.
      await this.auditLogEncryption?.encryptIntoEntity(entity);

      await this.auditLogRepository.create(entity);
    });
  }
}
