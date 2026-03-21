import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SummaryResponse {
    @ApiProperty()
    id: string;

    @ApiProperty()
    consultationId: string;

    @ApiProperty({ enum: ['summary', 'pre_summary'] })
    type: string;

    @ApiProperty()
    content: string;

    @ApiPropertyOptional({ description: 'Summary metadata including LLM info' })
    structuredData?: {
        llmProvider?: string;
        modelName?: string;
        processingTimeMs?: number;
        dnaStyleId?: string;
        inputTokens?: number;
        outputTokens?: number;
        entities?: Record<string, unknown>[];
    };

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;
}
