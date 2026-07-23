import { IsString, IsOptional, IsObject, IsEnum, IsArray, IsInt, IsIn, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentAgentDnaPolicy, ResourceStatusType } from '@arcaai/domains';

/**
 * Update a DepartmentAgent. `departmentId` is identity and is NOT editable
 * here. Version PINNING has its own endpoint (`POST :id/pin`), so
 * `pinnedVersionNumber` is deliberately absent. Lineage columns
 * (`sourceAgentTemplateSlug`, `templateLocked`) are absent by design — the
 * whitelist pipe rejects any attempt to set them over the API.
 */
export class UpdateDepartmentAgentRequest {
  @ApiPropertyOptional({ description: 'Agent name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'URL-friendly slug (unique per department)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ description: 'Agent description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Bound PromptTemplate id (tenant-visible)' })
  @IsOptional()
  @IsString()
  promptTemplateId?: string;

  @ApiPropertyOptional({ description: 'DNA writing-style gate', enum: DepartmentAgentDnaPolicy })
  @IsOptional()
  @IsEnum(DepartmentAgentDnaPolicy)
  dnaStylePolicy?: DepartmentAgentDnaPolicy;

  @ApiPropertyOptional({ description: 'Tenant-tier HarnessPolicy overrides (thresholds + maxRegen/gateSla/gateEscalation/toolAllowlist only)' })
  @IsOptional()
  @IsObject()
  harnessOverrides?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Golden set id (consumed by eval gating)' })
  @IsOptional()
  @IsString()
  goldenSetId?: string;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
