import { IsString, IsOptional, IsArray, MaxLength, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdatePromptTemplateRequest {
    @ApiPropertyOptional({ description: 'Template name' })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    name?: string;

    @ApiPropertyOptional({ description: 'Template description' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    description?: string;

    @ApiPropertyOptional({ description: 'Prompt content text' })
    @IsOptional()
    @IsString()
    content?: string;

    @ApiPropertyOptional({ description: 'Template variable definitions (JSON)' })
    @IsOptional()
    variables?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Tags for search/filtering', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @ApiPropertyOptional({ description: 'Reason for the change (stored in version history)' })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    changeReason?: string;

    @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
    @IsOptional()
    @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
    resourceStatus?: ResourceStatusType;
}
