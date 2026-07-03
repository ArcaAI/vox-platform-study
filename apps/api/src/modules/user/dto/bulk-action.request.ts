import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * TASK-388 #9 — server-side bulk user actions.
 *
 * Action set: `enable` | `disable` | `delete` | `assign-departments` | `assign-role`.
 * This mirrors the two real client `Promise.allSettled` loops on the admin Users
 * surface (bulk disable + bulk assign-department) plus their trivial siblings
 * (`enable` = inverse of `disable`; `delete` already exists as `bulkDelete`).
 * `assign-role` (TASK-398 P1-6) closes the arm deferred by TASK-388: it fans the
 * single-user `POST /admin/users/:id/roles` semantics out over `ids`, so the
 * AC-02 posture (`manage:UserRoleAssignment` + the service-level tier/tenant
 * guards) applies per item.
 */
export type BulkUserAction = 'enable' | 'disable' | 'delete' | 'assign-departments' | 'assign-role';

export const BULK_USER_ACTIONS: BulkUserAction[] = ['enable', 'disable', 'delete', 'assign-departments', 'assign-role'];

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

  @ApiPropertyOptional({ description: 'Role to assign to every id (action=assign-role)' })
  @IsOptional()
  @IsString()
  roleId?: string;
}
