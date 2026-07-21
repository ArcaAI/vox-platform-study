import { ApiProperty } from '@nestjs/swagger';
import { UserResponse } from '@arcaai/applications';

/**
 * Per-id failure record for `POST /admin/users/bulk`.
 *
 * Used so a partially-failing bulk delete returns a structured response
 * instead of throwing on the first id and leaving the caller unable to
 * tell which deletes did and didn't land.
 */
export class BulkDeleteUserFailure {
  @ApiProperty({ description: 'User ID that failed to delete', example: 'user-1' })
  id!: string;

  @ApiProperty({
    description: 'Human-readable reason for the failure (Error.message or stringified throw).',
    example: 'User not found',
  })
  reason!: string;
}

/**
 * Bulk delete response with partial-failure semantics.
 *
 * This struct is preferred over wrapping the loop in
 * `databaseService.client.$transaction(...)` because:
 *   - `IUserService.deleteById` does not accept a transaction client today,
 *     and threading one through would change the public service surface
 *     (out of scope for an apps/api hygiene sweep).
 *   - Partial failure is genuinely useful information for admin tooling —
 *     transactional roll-back hides _which_ id was the problem.
 */
export class BulkDeleteUsersResponse {
  @ApiProperty({
    description: 'Users that were deleted successfully.',
    type: [UserResponse],
  })
  succeeded!: UserResponse[];

  @ApiProperty({
    description: 'Ids that could not be deleted, paired with a human-readable reason.',
    type: [BulkDeleteUserFailure],
  })
  failed!: BulkDeleteUserFailure[];
}
