import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDepartmentPromptConfigRequest {
  @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
  @IsOptional()
  @IsString()
  preSummaryPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for new patients' })
  @IsOptional()
  @IsString()
  newPatientPromptId?: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for revisits' })
  @IsOptional()
  @IsString()
  revisitPromptId?: string;
}
