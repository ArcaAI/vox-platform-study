import { IsString, IsOptional, IsIn, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSummaryRequest {
  @ApiPropertyOptional({ description: 'Updated summary content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Reason for the change' })
  @IsOptional()
  @IsString()
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Summary of what changed' })
  @IsOptional()
  @IsString()
  changeSummary?: string;

  @ApiPropertyOptional({ description: 'Source of the change', enum: ['doctor_edit', 'ai_regeneration', 'system'] })
  @IsOptional()
  @IsString()
  @IsIn(['doctor_edit', 'ai_regeneration', 'system'])
  changeSource?: string;

  /**
   * TASK-709 optimistic-concurrency token. Mirrors
   * `UpdateDepartmentRequest.expectedVersion` verbatim: required. The client
   * echoes the `version` it read from a prior GET; the service runs a
   * Compare-And-Set (`contextItemRepository.updateWithVersion`) and fails with
   * `OptimisticConcurrencyException` -> HTTP 412 on drift. On a
   * `@RequiresIfMatch()` route the controller folds the `If-Match` header
   * value over this field when both are present.
   */
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
