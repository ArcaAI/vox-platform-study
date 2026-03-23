import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromptTemplateResponse } from '@arcaai/applications';

export class PaginatedPromptTemplateResponse {
    @ApiProperty({ description: 'Prompt templates', type: [PromptTemplateResponse] })
    data!: PromptTemplateResponse[];

    @ApiProperty({ description: 'Total count of matching templates' })
    count!: number;

    @ApiProperty({ description: 'Page size limit' })
    limit!: number;

    @ApiProperty({ description: 'Current page number' })
    page!: number;
}

export class PromptUsageStatsResponse {
    @ApiProperty({ description: 'Total number of usages' })
    totalUsages!: number;

    @ApiPropertyOptional({ description: 'Last used timestamp', nullable: true })
    lastUsedAt!: string | null;
}
