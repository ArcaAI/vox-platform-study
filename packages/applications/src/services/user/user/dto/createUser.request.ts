import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsDate } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserRequest extends BaseRequest {
  @ApiProperty({ description: 'Username of the user' })
  @IsString()
  username!: string;

  @ApiProperty({ description: 'Password for the user' })
  @IsString()
  password!: string;

  @ApiProperty({ description: 'External identifier', required: false })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiProperty({ description: 'Whether this is a service account', required: false, default: false })
  @IsBoolean()
  @IsOptional()
  isServiceAccount?: boolean;

  @ApiProperty({ description: 'First secret key', required: false })
  @IsString()
  @IsOptional()
  secret1?: string;

  @ApiProperty({ description: 'First secret key expiry', required: false })
  @IsDate()
  @IsOptional()
  secret1Expiry?: Date;

  @ApiProperty({ description: 'Second secret key', required: false })
  @IsString()
  @IsOptional()
  secret2?: string;

  @ApiProperty({ description: 'Second secret key expiry', required: false })
  @IsDate()
  @IsOptional()
  secret2Expiry?: Date;

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
