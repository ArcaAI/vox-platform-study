import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  // TASK-387 (#7) — default DNA writing-style prompt template id for the
  // department. Loose string ref (parity with the sibling *PromptId slots).
  @ApiPropertyOptional({ description: 'Default DNA writing-style prompt template ID' })
  @IsOptional()
  @IsString()
  dnaWritingStylePromptId?: string;

  /**
   * Optimistic-concurrency token (TASK-302 Stream D Phase E.2).
   *
   * Required. The client must read the row first, then echo back the
   * `version` it observed. The service issues a Compare-And-Set
   * (`departmentRepository.updateWithVersion`) and fails with
   * `OptimisticConcurrencyException` → HTTP 412 Precondition Failed
   * if `_version` has drifted under the client between read and write.
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
