import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * TASK-388 #9 — server-side bulk user actions.
 *
 * Action set (FLAG): `enable` | `disable` | `delete` | `assign-departments`.
 * This mirrors the two real client `Promise.allSettled` loops on the admin Users
 * surface (bulk disable + bulk assign-department) plus their trivial siblings
 * (`enable` = inverse of `disable`; `delete` already exists as `bulkDelete`).
 * `assign-role` is intentionally deferred (not exercised by the FE bulk bar;
 * single-user role assignment already exists via `POST /admin/users/:id/roles`).
 */
export type BulkUserAction = 'enable' | 'disable' | 'delete' | 'assign-departments';

export const BULK_USER_ACTIONS: BulkUserAction[] = ['enable', 'disable', 'delete', 'assign-departments'];

export class BulkUserActionRequest {
  @ApiProperty({ description: 'The action to apply to every id', enum: BULK_USER_ACTIONS })
  @IsIn(BULK_USER_ACTIONS)
  action!: BulkUserAction;

  @ApiProperty({ description: 'User IDs to act on', type: [String], example: ['uuid-1', 'uuid-2'] })
  @IsArray()
  @IsString({ each: true })
  ids!: string[];

  @ApiPropertyOptional({
    description: 'Departments to reconcile onto every id (action=assign-departments)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];

  @ApiPropertyOptional({ description: 'Primary department for the reconcile (action=assign-departments)' })
  @IsOptional()
  @IsString()
  primaryDepartmentId?: string;
}
