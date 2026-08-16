import { IsString, IsOptional, IsObject, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateContextRequest {
  @ApiPropertyOptional({ description: 'Updated content text' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Updated DNA Writing Style ID' })
  @IsOptional()
  @IsString()
  dnaWritingStyleId?: string;

  @ApiPropertyOptional({ description: 'Reason for the change (for version history)' })
  @IsOptional()
  @IsString()
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Summary of what changed (for version history)' })
  @IsOptional()
  @IsString()
  changeSummary?: string;

  @ApiPropertyOptional({ description: 'Field-level changes for analytics' })
  @IsOptional()
  @IsObject()
  fieldChanges?: Record<string, { old: string; new: string }>;

  // The STRUCTURED edit path. Declared here for the same reason as
  // on `AddContextRequest`: the global pipe rejects anything undeclared. The
  // item's OWN `kindKey` and `contextSchemaVersionId` (stamped at create) are
  // what the payload is re-validated against — a caller cannot re-point an
  // existing item at a different kind or a different version, because neither
  // is accepted here.
  @ApiPropertyOptional({
    description:
      'Replacement structured payload for a STRUCTURED context item, re-validated against the SAME schema version ' +
      'the item was created under. Rejected when the item carries no `kindKey`.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /**
   * TASK-709 optimistic-concurrency token. Mirrors
   * `UpdateDepartmentRequest.expectedVersion` verbatim: required. The client
   * echoes the `version` it read from a prior GET; the service runs a
   * Compare-And-Set (`contextItemRepository.updateWithVersion`) and fails
   * with `OptimisticConcurrencyException` -> HTTP 412 on drift. On a
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

/**
 * Request to update a modified summary
 */
export class UpdateModifiedSummaryRequest extends UpdateContextRequest {
  @ApiPropertyOptional({ description: 'Content diff from previous version' })
  @IsOptional()
  @IsString()
  contentDiff?: string;
}
