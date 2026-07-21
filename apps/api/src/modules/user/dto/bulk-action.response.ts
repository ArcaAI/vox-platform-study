import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Per-item outcome of a bulk user action. `error` is present only
 * on failure (a cross-tenant target, a not-found row, or a downstream error),
 * so admin tooling can surface exactly which ids failed and retry only those.
 */
export class BulkUserActionItemResult {
  @ApiProperty({ description: 'User ID this outcome refers to', example: 'user-1' })
  id!: string;

  @ApiProperty({ description: 'Whether the action succeeded for this id' })
  success!: boolean;

  @ApiPropertyOptional({ description: 'Human-readable failure reason (present only when success=false)' })
  error?: string;
}

/**
 * Aggregate result of a bulk user action with partial-failure
 * semantics (the call never throws mid-batch; every id gets an outcome).
 */
export class BulkUserActionResponse {
  @ApiProperty({ description: 'The action that was applied', example: 'disable' })
  action!: string;

  @ApiProperty({ description: 'Total ids submitted' })
  total!: number;

  @ApiProperty({ description: 'Count of ids that succeeded' })
  succeeded!: number;

  @ApiProperty({ description: 'Count of ids that failed' })
  failed!: number;

  @ApiProperty({ description: 'Per-item outcomes, in submission order', type: [BulkUserActionItemResult] })
  results!: BulkUserActionItemResult[];
}
