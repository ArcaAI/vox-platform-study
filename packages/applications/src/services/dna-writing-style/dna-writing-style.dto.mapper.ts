import { DnaWritingStyleReportEntity, DnaWritingStyleVersionEntity, DnaUsageRecordEntity } from '@arcaai/domains';
import { DnaReportResponse } from './dto/dna-report.response';
import { DnaVersionResponse } from './dto/dna-version.response';
import { DnaDashboardUsageEntry } from './dto/dna-dashboard.response';

export class DnaWritingStyleDtoMapper {
  static toReportResponse(entity: DnaWritingStyleReportEntity): DnaReportResponse {
    return {
      id: entity.id,
      doctorId: entity.doctorId ?? '',
      reportData: entity.reportData ?? undefined,
      styleText: entity.styleText ?? undefined,
      isLatest: entity.isLatest ?? false,
      currentVersionNumber: entity.currentVersionNumber ?? 1,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      resourceStatus: entity.resourceStatus ?? undefined,
      // TASK-326 X7 / D-2 — surface `_version` (the OCC token, distinct from
      // `currentVersionNumber`) so SDK clients can echo it back via
      // `If-Match: "<version>"` on the next PATCH.
      version: entity.version,
    };
  }

  static toVersionResponse(entity: DnaWritingStyleVersionEntity): DnaVersionResponse {
    return {
      id: entity.id,
      dnaReportId: entity.dnaReportId ?? '',
      versionNumber: entity.versionNumber ?? 0,
      reportData: entity.reportData ?? undefined,
      styleText: entity.styleText ?? undefined,
      changeReason: entity.changeReason ?? undefined,
      changedBy: entity.changedBy ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }

  /** TASK-328 A5 — usage record → dashboard recent-activity entry. */
  static toUsageEntry(entity: DnaUsageRecordEntity): DnaDashboardUsageEntry {
    return {
      id: entity.id,
      doctorId: entity.doctorId ?? '',
      dnaReportId: entity.dnaReportId ?? '',
      dnaVersionNumber: entity.dnaVersionNumber ?? undefined,
      consultationId: entity.consultationId ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
