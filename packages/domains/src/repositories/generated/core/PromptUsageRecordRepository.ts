import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { PromptUsageRecordEntityMapper } from '../../../mappers';
import { PromptUsageRecordEntity } from '../../../entities';
import { PromptUsageRecord } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PromptUsageRecordRepository extends Repository<PromptUsageRecordEntity, PromptUsageRecord> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'promptUsageRecord', PromptUsageRecordEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all usage records for a prompt template
   */
  async findByTemplate(templateId: string): Promise<PromptUsageRecordEntity[]> {
    return this.findAll({
      filters: {
        promptTemplateId: templateId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find all usage records for a department
   */
  async findByDepartment(departmentId: string): Promise<PromptUsageRecordEntity[]> {
    return this.findAll({
      filters: {
        departmentId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  // ============================================
  // TASK-328 A4 — usage analytics aggregations
  // ============================================

  /**
   * Count usage records grouped by department for a tenant.
   *
   * Mirrors the `TranscriptionJobRepository.countByStatus` Prisma `groupBy`
   * precedent. The optional `promptTemplateId` narrows the analytics to a
   * single template (the admin surface omits it for tenant-wide totals).
   */
  async groupByDepartment(tenantId: string, promptTemplateId?: string): Promise<{ departmentId: string | null; count: number }[]> {
    const where: Record<string, unknown> = { tenantId };
    if (promptTemplateId) where.promptTemplateId = promptTemplateId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (this as any).db.groupBy({
      by: ['departmentId'],
      where,
      _count: { _all: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.map((r: any) => ({ departmentId: r.departmentId ?? null, count: r._count._all }));
  }

  /**
   * Count usage records grouped by doctor for a tenant.
   */
  async groupByDoctor(tenantId: string, promptTemplateId?: string): Promise<{ doctorId: string | null; count: number }[]> {
    const where: Record<string, unknown> = { tenantId };
    if (promptTemplateId) where.promptTemplateId = promptTemplateId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (this as any).db.groupBy({
      by: ['doctorId'],
      where,
      _count: { _all: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.map((r: any) => ({ doctorId: r.doctorId ?? null, count: r._count._all }));
  }

  /**
   * Count usage records bucketed by UTC day for a tenant.
   *
   * Prisma `groupBy` cannot `date_trunc` a DateTime column to a day without
   * raw SQL, so we project `createdAt` and bucket in-process. This keeps the
   * aggregation encapsulated in the repository (the service stays thin) and
   * unit-testable without a live database.
   */
  async groupByDay(tenantId: string, promptTemplateId?: string): Promise<{ day: string; count: number }[]> {
    const where: Record<string, unknown> = { tenantId };
    if (promptTemplateId) where.promptTemplateId = promptTemplateId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (this as any).db.findMany({ where, select: { createdAt: true } });

    const buckets = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of rows as { createdAt: Date | string }[]) {
      const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
      const day = createdAt.toISOString().slice(0, 10);
      buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }

    return Array.from(buckets.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }
}
