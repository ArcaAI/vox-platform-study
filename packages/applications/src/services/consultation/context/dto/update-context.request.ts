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
