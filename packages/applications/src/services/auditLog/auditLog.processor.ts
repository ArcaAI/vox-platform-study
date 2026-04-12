import type { AuditLogJob } from '@arcaai/domains';
import { AuditLogFactory, AuditLogRepository, JobQueue } from '@arcaai/domains';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor(JobQueue.AuditLog)
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(private readonly auditLogRepository: AuditLogRepository) {
    super();
  }

  async process(job: Job<AuditLogJob>): Promise<void> {
    const {
      action,
      responsibleUserId,
      responsibleIp,
      resourceId,
      resourceType,
      data,
      previousData,
      correlationId,
      tenantId,
    } = job.data;

    const entity = AuditLogFactory.CreateAuditLog({
      action,
      responsibleUserId,
      responsibleIp,
      resourceId,
      resourceType,
      data: data ?? {},
      previousData: previousData ?? {},
      correlationId,
      tenantId,
    });

    await this.auditLogRepository.create(entity);
  }
}
