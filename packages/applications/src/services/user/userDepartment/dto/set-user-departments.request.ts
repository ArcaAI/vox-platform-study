import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Bulk-set a user's department memberships.
 *
 * `userId` comes from the `/admin/users/:id/departments` route param (never the
 * body). The service reconciles the user's active assignments to EXACTLY
 * `departmentIds` (adds the missing ones, soft-deletes the rest) and makes
 * `primaryDepartmentId` the single primary. Backs the SDK
 * `useUsers.assignDepartments` call used by the Create-User dialog's initial
 * departments and the bulk "Assign department" action.
 */
export class SetUserDepartmentsRequest {
  @ApiProperty({ description: 'The complete set of department IDs the user should belong to', type: [String] })
  @IsArray()
  @IsString({ each: true })
  departmentIds!: string[];

  @ApiPropertyOptional({ description: "Which of departmentIds becomes the user's primary department" })
  @IsOptional()
  @IsString()
  primaryDepartmentId?: string;
}
