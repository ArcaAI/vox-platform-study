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
   * Find all DNA writing style reports for a department
   */
  async findByDepartment(departmentId: string): Promise<DnaWritingStyleReportEntity[]> {
    return this.findAll({
      filters: {
        departmentId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
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
}
