import { IsString, IsOptional, IsEnum, IsArray, IsIn, MaxLength } from 'class-validator';
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

  // Publication status; defaults to DRAFT server-side.
  @ApiPropertyOptional({ description: 'Publication status', enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT' })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED'])
  status?: 'DRAFT' | 'PUBLISHED';

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

  // Admin per-user prompt scope. Defaults to `TENANT_DEFAULT`
  // server-side; `USER_PERSONAL` provisions a personal prompt owned by
  // `ownerUserId` (an in-tenant user; falls back to the caller when omitted).
  // `DEPARTMENT_DEFAULT` remains department-assigned via the department config.
  @ApiPropertyOptional({
    description: 'Prompt scope (admin). Defaults to TENANT_DEFAULT.',
    enum: ['TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL'],
  })
  @IsOptional()
  @IsIn(['TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL'])
  scope?: 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL';

  @ApiPropertyOptional({ description: 'Owner user ID — required/implied only when scope=USER_PERSONAL' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}
