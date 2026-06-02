import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * Assign a user to a department (TASK-328 A1).
 *
 * `userId` is taken from the `/admin/users/:id/departments` route param,
 * NOT the body, so it cannot be spoofed. The active tenant is sourced from
 * the CLS request context (global admins pass `X-Tenant-Id`).
 */
export class AssignUserDepartmentRequest {
  @ApiProperty({ description: 'Department to assign the user to' })
  @IsString()
  departmentId!: string;

  @ApiPropertyOptional({
    description: "Mark this as the user's primary department (demotes any existing primary)",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
