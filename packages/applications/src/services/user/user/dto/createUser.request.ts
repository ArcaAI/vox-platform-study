import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserRequest extends BaseRequest {
  @ApiProperty({ description: 'Username of the user' })
  @IsString()
  username!: string;

  @ApiProperty({ description: 'Password for the user' })
  @IsString()
  password!: string;

  // The admin Create-User dialog collects an email for human
  // accounts. `email` lives on `UserProfile` (not `User`), so the service
  // upserts it onto the profile after the identity row is created. Whitelisted
  // here so the global `forbidNonWhitelisted` pipe doesn't 400 a human create.
  @ApiProperty({ description: 'Email address (persisted on the user profile)', required: false })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'External identifier', required: false })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiProperty({ description: 'Whether this is a service account', required: false, default: false })
  @IsBoolean()
  @IsOptional()
  isServiceAccount?: boolean;

  // secret1/secret2 are NOT client-assignable, to avoid a caller seeding
  // arbitrary service-account credentials on create. Secrets are provisioned
  // only by the dedicated rotation flow, never through the generic create
  // payload.

  // Membership. When supplied, the user is created together with an ENABLED
  // UserRoleAssignment and/or UserDepartment in the ACTIVE tenant (taken from
  // CLS, never the body), atomically, so the user satisfies the login
  // invariant in one step.
  //
  // Optional to class-validator, MANDATORY in a tenant (TASK-983 R6 / OD-4):
  // the rule depends on the CALLER's context, which a DTO decorator cannot
  // see, so `UserService.create` enforces it — 400 `USER_ROLE_REQUIRED` /
  // `USER_DEPARTMENT_REQUIRED`. Both stay optional on the wire only for the
  // tenant-less platform-user create.
  @ApiProperty({
    description:
      'Role to assign in the active tenant (membership). REQUIRED whenever the caller acts inside a tenant — omitting it is rejected with 400 USER_ROLE_REQUIRED, because a user with no role assignment belongs to no tenant and cannot sign in. A non-super-admin caller may not name the SUPER_ADMIN role (403).',
    required: false,
  })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiProperty({
    description:
      'Department to assign in the active tenant (membership). REQUIRED for a HUMAN user whenever the caller acts inside a tenant — omitting it is rejected with 400 USER_DEPARTMENT_REQUIRED. Service accounts are exempt, mirroring assertUserBelongsToTenant.',
    required: false,
  })
  @IsString()
  @IsOptional()
  departmentId?: string;

  @ApiProperty({ description: 'Mark the assigned department as the user primary', required: false, default: false })
  @IsBoolean()
  @IsOptional()
  isPrimaryDepartment?: boolean;
}
