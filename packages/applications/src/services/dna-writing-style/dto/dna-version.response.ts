import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DnaVersionResponse {
    @ApiProperty({ description: 'Version record ID' })
    id: string;

    @ApiProperty({ description: 'Parent report ID' })
    dnaReportId: string;

    @ApiProperty({ description: 'Version number' })
    versionNumber: number;

    @ApiPropertyOptional({ description: 'Report data at this version' })
    reportData?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Style text at this version' })
    styleText?: string;

    @ApiPropertyOptional({ description: 'Reason for the change' })
    changeReason?: string;

    @ApiPropertyOptional({ description: 'Who made the change' })
    changedBy?: string;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;
}
