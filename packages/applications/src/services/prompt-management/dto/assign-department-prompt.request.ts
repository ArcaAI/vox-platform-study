import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignDepartmentPromptRequest {
  @ApiProperty({ description: 'Department ID to assign prompts to' })
  @IsString()
  departmentId: string;

  @ApiPropertyOptional({ description: 'Prompt template ID for the pre-summary slot' })
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

  /**
   * Optimistic-concurrency token for the target Department row
   * . Required. The caller must have read
   * the Department first and echo back the `version` it observed.
   */
  @ApiProperty({
    description: 'Current version of the Department row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
