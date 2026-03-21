import { IsString, IsOptional, IsArray, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateDnaReportRequest {
    @ApiPropertyOptional({ description: 'Text samples for analysis (if not provided, gathered from ContextItems)', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    textSamples?: string[];

    @ApiPropertyOptional({ description: 'Prompt template ID for DNA generation' })
    @IsOptional()
    @IsUUID()
    promptTemplateId?: string;

    @ApiPropertyOptional({ description: 'Edited summary text to use as input for DNA analysis' })
    @IsOptional()
    @IsString()
    editedSummary?: string;
}
