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
}
