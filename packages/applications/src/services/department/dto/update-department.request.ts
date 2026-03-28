import { IsString, IsOptional, IsObject, MaxLength, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdateDepartmentRequest {
  @ApiPropertyOptional({ description: 'Department code (unique per tenant)', example: 'CARD' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Department description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
  @IsOptional()
  @IsString()
  parentDepartmentId?: string | null;

  @ApiPropertyOptional({ description: 'Default summary template' })
  @IsOptional()
  @IsString()
  defaultSummaryTemplate?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
  @IsOptional()
  @IsString()
  preSummaryPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for new patients' })
  @IsOptional()
  @IsString()
  newPatientPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for revisit patients' })
  @IsOptional()
  @IsString()
  revisitPromptId?: string;

  @ApiPropertyOptional({ description: 'Department prompt configuration' })
  @IsOptional()
  @IsObject()
  promptConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;
}
