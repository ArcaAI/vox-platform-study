import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TranscriptionJobEntityMapper } from '../../../mappers';
import { TranscriptionJobEntity } from '../../../entities';
import { TranscriptionJob } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { TranscriptionJobStatus, TranscriptionJobType } from '../../../enums';
import { JsonValue } from '../../../interfaces';

/**
 * TASK-999 — the transcript-size and served-engine facts the consultation
 * telemetry pane reads, and nothing else. Deliberately NOT an entity: see
 * `findTelemetryByConsultation`.
 */
export interface TranscriptionJobTelemetryRow {
  id: string;
  servedBy: JsonValue | null;
  resultWordCount: number | null;
  resultCharCount: number | null;
}

@Injectable()
export class TranscriptionJobRepository extends Repository<TranscriptionJobEntity, TranscriptionJob> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'transcriptionJob', TranscriptionJobEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all jobs for a consultation
   */
  async findByConsultation(consultationId: string): Promise<TranscriptionJobEntity[]> {
    return this.findAll({
      filters: {
        consultationId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * TASK-999 — `servedBy` + the transcript size counters for a consultation's
   * jobs, with NO ciphertext column selected.
   *
   * ## Why this is not `findByConsultation(...)`
   *
   * `encryptedResultText` / `encryptedResultMetadata` are the system of record
   * for the transcript, and the base `db` getter wraps the delegate with
   * decrypt-on-read (`phi-read-decrypt.ts`). So the entity finder pulls every
   * transcript body for the consultation through a Vault batch decrypt — as a
   * SIDE EFFECT of reading three scalars for an admin telemetry pane. That is
   * the same leak the case-note counters exist to avoid (D-3(a)): a reporting
   * read must never be the thing that decrypts PHI.
   *
   * `findMany` IS a decrypting method, but the walker skips any registered
   * ciphertext column that is not present in the row
   * (`phi-read-decrypt.ts` — `if (!(key in row)) continue`), so a projected
   * `select` that omits them collects zero decrypt jobs and never reaches
   * Vault. Keep the `select` free of `encrypted*` or this silently becomes a
   * decrypting read again.
   *
   * Newest-first, matching `findByConsultation`. `findByConsultation` remains
   * the right call when the transcript itself is actually wanted.
   */
  async findTelemetryByConsultation(consultationId: string): Promise<TranscriptionJobTelemetryRow[]> {
    const rows = await this.db.findMany({
      where: { consultationId },
      select: { id: true, servedBy: true, resultWordCount: true, resultCharCount: true },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows as TranscriptionJobTelemetryRow[];
  }

  /**
   * Find pending (queued) jobs for a tenant
   */
  async findPendingJobs(tenantId: string, limit: number = 100): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        status: TranscriptionJobStatus.QUEUED,
      },
      orderBy: { queuedAt: 'asc' },
      take: limit,
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find jobs by status
   */
  async findJobsByStatus(tenantId: string, status: TranscriptionJobStatus): Promise<TranscriptionJobEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        status,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find recent jobs for a tenant
   */
  async findRecentJobs(tenantId: string, limit: number = 50): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find jobs by type
   */
  async findByType(tenantId: string, jobType: TranscriptionJobType): Promise<TranscriptionJobEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        jobType,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find processing jobs (for worker health monitoring)
   */
  async findProcessingJobs(tenantId?: string): Promise<TranscriptionJobEntity[]> {
    const where: any = {
      status: TranscriptionJobStatus.PROCESSING,
    };
    if (tenantId) {
      where.tenantId = tenantId;
    }

    const models = await (this as any).db.findMany({
      where,
      orderBy: { startedAt: 'asc' },
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * TASK-992 — the reaper's eligibility query: batch jobs stuck in PROCESSING
   * with nothing writing to them.
   *
   * `updatedAt` is the staleness signal, not `startedAt`: the worker's progress
   * callbacks land through `repository.update`, so `updatedAt` is the closest
   * thing this row has to a heartbeat, while `startedAt` only says when the
   * current attempt began. A job that is still emitting progress is therefore
   * never eligible, however long it has been running.
   *
   * Deliberately CROSS-TENANT and unfiltered by tenant: this backs a
   * platform-wide maintenance tick with no CLS context bound, so the
   * tenant-scope Prisma extension passes through (the same shape
   * {@link findProcessingJobs} already relies on). Each row's WRITE is
   * re-bound to its own tenant by the caller.
   *
   * Backed by `TranscriptionJob_status_updated_idx`.
   */
  async findStaleProcessingJobs(staleBefore: Date, limit: number = 100): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        status: TranscriptionJobStatus.PROCESSING,
        updatedAt: { lt: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * BUG-042 — STREAMING rows still open (QUEUED/PROCESSING, no `completedAt`) that were created
   * before `createdBefore`. Keyed on `createdAt`, not `updatedAt`: a live session's row is not
   * written between open and teardown, so it has no heartbeat to go stale.
   */
  async findStaleStreamingJobs(createdBefore: Date, limit: number = 100): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        jobType: TranscriptionJobType.STREAMING,
        status: { in: [TranscriptionJobStatus.QUEUED, TranscriptionJobStatus.PROCESSING] },
        completedAt: null,
        createdAt: { lt: createdBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find failed jobs that can be retried
   */
  async findRetryableJobs(tenantId: string): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        status: TranscriptionJobStatus.FAILED,
        retryCount: {
          lt: (this as any).db.fields.maxRetries,
        },
      },
      orderBy: { completedAt: 'asc' },
    });

    // Filter in memory since Prisma doesn't support comparing two columns
    return models
      .filter((model: TranscriptionJob) => model.retryCount < model.maxRetries)
      .map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find jobs by worker ID
   */
  async findByWorker(workerId: string): Promise<TranscriptionJobEntity[]> {
    return this.findAll({
      filters: { workerId },
      sort: [{ startedAt: 'desc' }],
    });
  }

  /**
   * Count jobs by status for a tenant.
   *
   * Optional `ownerId` narrows the counts to a single creator
   * (`createdBy`) so the end-user surface reports only the caller's jobs while
   * the admin surface (no `ownerId`) keeps the tenant-wide totals.
   */
  async countByStatus(tenantId: string, ownerId?: string): Promise<Record<TranscriptionJobStatus, number>> {
    const counts: Record<TranscriptionJobStatus, number> = {
      [TranscriptionJobStatus.QUEUED]: 0,
      [TranscriptionJobStatus.PROCESSING]: 0,
      [TranscriptionJobStatus.COMPLETED]: 0,
      [TranscriptionJobStatus.FAILED]: 0,
      [TranscriptionJobStatus.CANCELLED]: 0,
      [TranscriptionJobStatus.DEAD]: 0,
    };

    const where: Record<string, unknown> = { tenantId };
    if (ownerId) {
      where.createdBy = ownerId;
    }

    const results = await (this as any).db.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    });

    for (const result of results) {
      counts[result.status as TranscriptionJobStatus] = result._count.status;
    }

    return counts;
  }

  /**
   * Find jobs in date range
   */
  async findByDateRange(tenantId: string, startDate: Date, endDate: Date): Promise<TranscriptionJobEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return models.map((model: TranscriptionJob) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find completed jobs for a consultation (latest first)
   */
  async findCompletedByConsultation(consultationId: string): Promise<TranscriptionJobEntity[]> {
    return this.findAll({
      filters: {
        consultationId,
        status: TranscriptionJobStatus.COMPLETED,
      },
      sort: [{ completedAt: 'desc' }],
    });
  }
}
