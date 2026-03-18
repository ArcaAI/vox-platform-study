import {
    DnaWritingStyleReportEntity,
    DnaWritingStyleVersionEntity,
} from '@arcaai/domains';
import { DnaReportResponse } from './dto/dna-report.response';
import { DnaVersionResponse } from './dto/dna-version.response';

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
}
