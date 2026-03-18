import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class DnaReportResponse {
    @ApiProperty({ description: 'Report ID' })
    id: string;

    @ApiProperty({ description: 'Doctor ID' })
    doctorId: string;

    @ApiPropertyOptional({ description: 'Report data (JSON)' })
    reportData?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Extracted writing style text' })
    styleText?: string;

    @ApiProperty({ description: 'Whether this is the latest report' })
    isLatest: boolean;

    @ApiProperty({ description: 'Current version number' })
    currentVersionNumber: number;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;

    @ApiProperty({ description: 'Last update timestamp' })
    updatedAt: string;

    @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
    resourceStatus?: ResourceStatusType;
}
