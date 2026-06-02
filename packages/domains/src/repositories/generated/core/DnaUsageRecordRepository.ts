import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { DnaUsageRecordEntityMapper } from '../../../mappers';
import { DnaUsageRecordEntity } from '../../../entities';
import { DnaUsageRecord } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class DnaUsageRecordRepository extends Repository<DnaUsageRecordEntity, DnaUsageRecord> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'dnaUsageRecord', DnaUsageRecordEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all usage records for a doctor
   */
  async findByDoctor(doctorId: string): Promise<DnaUsageRecordEntity[]> {
    return this.findAll({
      filters: {
        doctorId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find all usage records for a DNA report
   */
  async findByReport(reportId: string): Promise<DnaUsageRecordEntity[]> {
    return this.findAll({
      filters: {
        dnaReportId: reportId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Find all usage records for a consultation
   */
  async findByConsultation(consultationId: string): Promise<DnaUsageRecordEntity[]> {
    return this.findAll({
      filters: {
        consultationId,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  // ============================================
  // Aggregate Query Methods (TASK-328 A5 — DNA dashboard)
  // ============================================

  /**
   * TASK-328 A5 — Count usage records created on/after `since` (mirrors the
   * Prisma `count` precedent). `tenantId` omitted ⇒ all tenants.
   */
  async countSince(since: Date, tenantId?: string): Promise<number> {
    const where: Record<string, unknown> = { createdAt: { gte: since } };
    if (tenantId) where.tenantId = tenantId;
    return (this as any).db.count({ where });
  }

  /**
   * TASK-328 A5 — Per-day usage counts on/after `since`, returned oldest→newest
   * as `{ date: 'YYYY-MM-DD' (UTC), count }`. Prisma cannot `groupBy` a
   * truncated day on a timestamp column, so we select the in-range timestamps
   * and bucket them in memory — `DnaUsageRecord` is a lightweight, bounded
   * audit log so the row volume over a short window stays small.
   */
  async getDailyUsageCounts(since: Date, tenantId?: string): Promise<Array<{ date: string; count: number }>> {
    const where: Record<string, unknown> = { createdAt: { gte: since } };
    if (tenantId) where.tenantId = tenantId;

    const rows: Array<{ createdAt: Date }> = await (this as any).db.findMany({
      where,
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      const day = row.createdAt.toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return Array.from(counts, ([date, count]) => ({ date, count }));
  }

  /**
   * TASK-328 A5 — The most recent usage records (newest first). `tenantId`
   * omitted ⇒ all tenants. Delegates to the base `findAll` so mapping stays in
   * one place.
   */
  async findRecent(limit: number, tenantId?: string): Promise<DnaUsageRecordEntity[]> {
    const filters: Record<string, unknown> = {};
    if (tenantId) filters.tenantId = tenantId;
    return this.findAll({ filters, sort: [{ createdAt: 'desc' }], limit });
  }
}
