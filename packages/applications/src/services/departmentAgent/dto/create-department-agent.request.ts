import { IsString, IsOptional, IsObject, IsInt, IsEnum, IsArray, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentAgentDnaPolicy } from '@arcaai/domains';

export class CreateDepartmentAgentRequest {
  @ApiProperty({ description: 'Department this agent belongs to' })
  @IsString()
  departmentId!: string;

  @ApiProperty({ description: 'Agent name', example: 'Cardiology SOAP' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'URL-friendly slug (unique per department)', example: 'cardiology-soap' })
  @IsString()
  @MaxLength(100)
  slug!: string;

  @ApiPropertyOptional({ description: 'Agent description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: 'Bound PromptTemplate id (tenant-visible)' })
  @IsString()
  promptTemplateId!: string;

  @ApiPropertyOptional({
    description: 'Pin the agent to a specific PromptVersion number. Omit/null to track the latest APPROVED version.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  pinnedVersionNumber?: number | null;

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
}
