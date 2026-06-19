import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { DnaWritingStyleReportEntityMapper } from '../../../mappers';
import { DnaWritingStyleReportEntity } from '../../../entities';
import { DnaWritingStyleReport } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class DnaWritingStyleReportRepository extends Repository<DnaWritingStyleReportEntity, DnaWritingStyleReport> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'dnaWritingStyleReport', DnaWritingStyleReportEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find the latest DNA writing style report for a doctor
   */
  async findLatestForDoctor(doctorId: string): Promise<DnaWritingStyleReportEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          doctorId,
          isLatest: true,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find all DNA writing style reports for a doctor
   */
  async findAllForDoctor(doctorId: string): Promise<DnaWritingStyleReportEntity[]> {
    return this.findAll({
      filters: {
        doctorId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * TASK-331 doc-02 F6 — repository-level pagination for the admin list.
   *
   * Returns both the page slice and the total matching count in one call so
   * the admin controller no longer materializes the full tenant result set
   * just to slice it in memory. Mirrors `PromptTemplateRepository.findPaginated`
   * (`db.findMany` + `db.count` against the same extended client, so soft-delete
   * semantics match the query-builder list path), ordering by `createdAt desc`.
   */
  async findPaginated(
    where: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<{ data: DnaWritingStyleReportEntity[]; count: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (this as any).db;
    const [models, count] = await Promise.all([
      db.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.count({ where }),
    ]);

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: models.map((model: DnaWritingStyleReport) => (this as any)._mapper.toDomainEntity(model)),
      count,
    };
  }

  // ============================================
  // Aggregate Query Methods (TASK-328 A5 — DNA dashboard)
  // ============================================

  /**
   * TASK-328 A5 — Count distinct doctors that have a current ("latest")
   * writing-style report. Uses Prisma `groupBy(['doctorId'])` and returns the
   * number of groups (mirrors the `groupBy` precedent in
   * `TranscriptionJobRepository.countByStatus`). When `tenantId` is omitted the
   * count spans every tenant (global-admin aggregate view).
   */
  async countDoctorsWithLatestReport(tenantId?: string): Promise<number> {
    const where: Record<string, unknown> = {
      isLatest: true,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    if (tenantId) where.tenantId = tenantId;

    const groups = await (this as any).db.groupBy({
      by: ['doctorId'],
      where,
    });
    return groups.length;
  }

  /**
   * TASK-328 A5 — Average `currentVersionNumber` across all latest reports
   * (mirrors `SummaryMetaRepository.getAverageProcessingTime`'s `aggregate._avg`).
   * Returns 0 when there are no matching rows. `tenantId` omitted ⇒ all tenants.
   */
  async averageCurrentVersion(tenantId?: string): Promise<number> {
    const where: Record<string, unknown> = {
      isLatest: true,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    if (tenantId) where.tenantId = tenantId;

    const result = await (this as any).db.aggregate({
      where,
      _avg: { currentVersionNumber: true },
    });
    return result._avg.currentVersionNumber ?? 0;
  }
}
