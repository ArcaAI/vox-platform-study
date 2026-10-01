import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export const CHECKPOINT_LIST_DEFAULT_LIMIT = 10;
export const CHECKPOINT_LIST_MAX_LIMIT = 100;

/** Offset page parameters shared by the checkpoint and restore lists (`skip = (page - 1) * limit`). */
export class CheckpointPageQuery {
  @ApiPropertyOptional({ description: 'Page number, one-based', default: 1, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(0)
  page?: number;

  @ApiPropertyOptional({ description: 'Items per page', default: CHECKPOINT_LIST_DEFAULT_LIMIT, minimum: 1, maximum: CHECKPOINT_LIST_MAX_LIMIT })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  @Max(CHECKPOINT_LIST_MAX_LIMIT)
  limit?: number;
}

export class ListCheckpointsQuery extends CheckpointPageQuery {
  @ApiPropertyOptional({ description: 'Only checkpoints of this kind', enum: ['MANUAL', 'SAFETY'] })
  @IsOptional()
  @IsIn(['MANUAL', 'SAFETY'])
  kind?: 'MANUAL' | 'SAFETY';

  @ApiPropertyOptional({ description: 'Case-insensitive match against the checkpoint label', minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  search?: string;
}

export class ListRestoresQuery extends CheckpointPageQuery {}
