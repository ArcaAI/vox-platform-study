import { IsString, IsOptional, IsEnum, IsArray, IsIn, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromptVariableDeclarationDto } from './prompt-variable-declaration.dto';
import { IsPromptTags } from './prompt-tag';

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

  // Upper bound on tenant/admin-authored prompt bodies (F-03). The prompt body
  // is folded verbatim into the clinical LLM prompt, so an unbounded field is
  // both a cost and a prompt-injection surface. 50k chars comfortably fits any
  // legitimate SOAP/summary template while capping abuse.
  @ApiProperty({ description: 'Prompt content text', maxLength: 50000 })
  @IsString()
  @MaxLength(50000)
  content: string;

  @ApiProperty({ description: 'Template category', enum: ['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'] })
  @IsEnum(['SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM'] as const)
  category: string;

  // Publication status; defaults to DRAFT server-side.
  @ApiPropertyOptional({ description: 'Publication status', enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT' })
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED'])
  status?: 'DRAFT' | 'PUBLISHED';

  // Typed declarations (TASK-890 §3.6, OD-K) — an ARRAY, never the retired
  // `{ [name]: { type, required } }` map. `@ValidateNested` + `@Type` reject a
  // legacy map outright (it fails `@IsArray`), which is the point: there is no
  // read-side normaliser for it any more.
  @ApiPropertyOptional({ description: 'Typed prompt-variable declarations', type: [PromptVariableDeclarationDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromptVariableDeclarationDto)
  variables?: PromptVariableDeclarationDto[];

  @ApiPropertyOptional({ description: 'Why the template is being created (recorded on version 1 and the audit event). Required when the platform policy says so.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Department ID to assign template to' })
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Tags for search/filtering — lower-case `key` or `key:value`, max 24', type: [String] })
  @IsOptional()
  @IsArray()
  @IsPromptTags()
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
