import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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

  // TASK-658 — the STRUCTURED edit path. Declared here for the same reason as
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
