import { IsString, IsOptional, IsEnum, IsArray, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePromptTemplateRequest {
    @ApiProperty({ description: 'Template name', example: 'SOAP Summary Prompt' })
    @IsString()
    @MaxLength(200)
    name: string;

    @ApiPropertyOptional({ description: 'Template description' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    description?: string;

    @ApiProperty({ description: 'Prompt content text' })
    @IsString()
    content: string;

    @ApiProperty({ description: 'Template category', enum: ['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'] })
    @IsEnum(['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'] as const)
    category: string;

    @ApiPropertyOptional({ description: 'Template variable definitions (JSON)' })
    @IsOptional()
    variables?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Department ID to assign template to' })
    @IsOptional()
    @IsString()
    departmentId?: string;

    @ApiPropertyOptional({ description: 'Tags for search/filtering', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];
}
