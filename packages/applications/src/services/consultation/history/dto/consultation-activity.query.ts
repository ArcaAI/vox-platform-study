import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ACTIVITY_KINDS } from '@arcaai/types';

const csv = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : value;
const int = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export const ACTIVITY_INCLUDES = ['versions'] as const;

/** `GET admin/consultations/:id/activity` and `GET consultations/:id/history`. */
export class ConsultationActivityQuery {
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page (`nextCursor`).' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Transform(int)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Comma-separated activity kinds; absent = all.', enum: ACTIVITY_KINDS, isArray: true })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(ACTIVITY_KINDS, { each: true })
  kinds?: string[];

  @ApiPropertyOptional({ minimum: 1, description: 'Only this encounter.' })
  @IsOptional()
  @Transform(int)
  @IsInt()
  @Min(1)
  encounterSeq?: number;

  @ApiPropertyOptional({ description: 'Only items with more than one version.' })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  edited?: boolean;

  @ApiPropertyOptional({ description: 'Only items an AI run produced (AI or transcription source).' })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  aiRuns?: boolean;

  @ApiPropertyOptional({ enum: ['runs', 'none'], default: 'runs', description: '`runs` collapses consecutive transcript segments of one encounter.' })
  @IsOptional()
  @IsIn(['runs', 'none'])
  grouping?: 'runs' | 'none';

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive lower bound on the segment sequence (expanding a segment run).' })
  @IsOptional()
  @Transform(int)
  @IsInt()
  @Min(0)
  segmentSeqFrom?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive upper bound on the segment sequence.' })
  @IsOptional()
  @Transform(int)
  @IsInt()
  @Min(0)
  segmentSeqTo?: number;

  @ApiPropertyOptional({ description: 'Comma-separated extras; `versions` adds each item\'s version list.', enum: ACTIVITY_INCLUDES, isArray: true })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(ACTIVITY_INCLUDES, { each: true })
  include?: string[];
}

/** `GET …/items/:itemId/versions/:n/diff?against=m`. */
export class ItemVersionDiffQuery {
  @ApiProperty({ minimum: 1, description: 'The version to diff against (the `from` side).' })
  @Transform(int)
  @IsInt()
  @Min(1)
  against!: number;
}

/** `GET …/items/:itemId/runs?version=n`. */
export class ItemRunsQuery {
  @ApiPropertyOptional({ minimum: 1, description: 'Item version; absent = the current one.' })
  @IsOptional()
  @Transform(int)
  @IsInt()
  @Min(1)
  version?: number;
}
