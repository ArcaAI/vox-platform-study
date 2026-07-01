import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-389 #14 (AG8/A3) — server-side prompt-version diff.
 *
 * A single change segment from a line/word diff. Shape-compatible with the
 * `diff` npm package output and the SDK `DiffChange` type so the SDK can keep
 * returning its existing `DiffResult` with no consumer break.
 */
export class PromptDiffChangeDto {
  @ApiProperty({ description: 'The changed text segment' })
  value: string;

  @ApiPropertyOptional({ description: 'True when this segment was added in the "to" version' })
  added?: boolean;

  @ApiPropertyOptional({ description: 'True when this segment was removed from the "from" version' })
  removed?: boolean;

  @ApiPropertyOptional({ description: 'Line/word count of this segment' })
  count?: number;
}

/**
 * Additions / deletions / unchanged counts for a diff.
 */
export class PromptDiffStatsDto {
  @ApiProperty({ description: 'Number of added lines/words' })
  additions: number;

  @ApiProperty({ description: 'Number of removed lines/words' })
  deletions: number;

  @ApiProperty({ description: 'Number of unchanged lines/words' })
  unchanged: number;
}

/**
 * Per-field diff breakdown (e.g. `content`, `variables`). Available for a
 * future field-aware diff UI; the SDK currently maps only the combined diff.
 */
export class PromptFieldDiffDto {
  @ApiProperty({ description: 'The compared field name', example: 'content' })
  field: string;

  @ApiProperty({ description: 'Whether this field changed between the two versions' })
  changed: boolean;

  @ApiPropertyOptional({ description: 'Serialized value in the "from" version' })
  before?: string;

  @ApiPropertyOptional({ description: 'Serialized value in the "to" version' })
  after?: string;

  @ApiProperty({ description: 'Line-diff segments for this field', type: [PromptDiffChangeDto] })
  changes: PromptDiffChangeDto[];

  @ApiProperty({ description: 'Diff stats for this field', type: PromptDiffStatsDto })
  stats: PromptDiffStatsDto;
}

/**
 * Structured field-level diff between two versions of a prompt template.
 *
 * Returned by `GET /admin/prompt-templates/:id/versions/:from/diff/:to`. The
 * top-level `changes`/`patch`/`stats` are the COMBINED (content + variables)
 * line diff — byte-identical to the SDK's previous client-side
 * `serializeVersionForDiff` + `computePromptDiff`, so `compareVersions` keeps
 * returning `DiffResult` unchanged. `fields[]` is the richer per-field
 * breakdown for future UI.
 */
export class PromptVersionDiffResponse {
  @ApiProperty({ description: 'Prompt template ID' })
  promptTemplateId: string;

  @ApiProperty({ description: 'The "from" (base) version number', example: 1 })
  fromVersion: number;

  @ApiProperty({ description: 'The "to" (target) version number', example: 2 })
  toVersion: number;

  @ApiProperty({ description: 'Per-field diff breakdown', type: [PromptFieldDiffDto] })
  fields: PromptFieldDiffDto[];

  @ApiProperty({ description: 'Combined (content + variables) line-diff segments', type: [PromptDiffChangeDto] })
  changes: PromptDiffChangeDto[];

  @ApiProperty({ description: 'Unified patch string for the combined diff' })
  patch: string;

  @ApiProperty({ description: 'Combined diff stats', type: PromptDiffStatsDto })
  stats: PromptDiffStatsDto;
}
