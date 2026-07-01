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

  // TASK-381 (V1) — the admin Create-User dialog collects an email for human
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

  // AC-05 (TASK-336) — secret1/secret2 are NOT client-assignable. They were
  // mass-assignable here, letting a caller seed arbitrary service-account
  // credentials on create. Secrets are provisioned only by the dedicated
  // rotation flow, never through the generic create payload.

  // TASK-331 r2605 #3 — optional membership. When supplied, the user is created
  // together with an ENABLED UserRoleAssignment and/or UserDepartment in the
  // ACTIVE tenant (taken from CLS, never the body) so a console-created user can
  // satisfy the TASK-305 Phase F login invariant in one step. Created atomically.
  @ApiProperty({ description: 'Role to assign in the active tenant (membership)', required: false })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiProperty({ description: 'Department to assign in the active tenant (membership)', required: false })
  @IsString()
  @IsOptional()
  departmentId?: string;

  @ApiProperty({ description: 'Mark the assigned department as the user primary', required: false, default: false })
  @IsBoolean()
  @IsOptional()
  isPrimaryDepartment?: boolean;
}
