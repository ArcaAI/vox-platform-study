import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, Validate, ValidateIf, ValidateNested } from 'class-validator';
import { TenantPlan } from '@arcaai/domains';
import { NotReservedTenantKeyConstraint } from '../../validators/not-reserved-tenant-key.validator';

/** HTTP-validated counterpart of the `TenantAdminSpec` union. */
export class ProvisionTenantAdminBlock {
  @ApiProperty({ description: 'existing: pick an existing user by id. new-local: create a local account.', enum: ['existing', 'new-local'] })
  @IsIn(['existing', 'new-local'])
  mode!: 'existing' | 'new-local';

  @ApiPropertyOptional({ description: 'Required when mode=existing' })
  @ValidateIf((o: ProvisionTenantAdminBlock) => o.mode === 'existing')
  @IsString()
  @IsNotEmpty()
  userId?: string;

  @ApiPropertyOptional({ description: 'Required when mode=new-local' })
  @ValidateIf((o: ProvisionTenantAdminBlock) => o.mode === 'new-local')
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Optional for mode=new-local (defaults to email)' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'Required when mode=new-local' })
  @ValidateIf((o: ProvisionTenantAdminBlock) => o.mode === 'new-local')
  @IsString()
  @IsNotEmpty()
  password?: string;
}

/** `POST /admin/tenants/provision` (global-admin create-tenant-with-admin). */
export class ProvisionTenantRequest {
  @ApiProperty({ description: 'Name of the tenant' })
  @IsString()
  @IsNotEmpty()
  tenantName!: string;

  @ApiPropertyOptional({ description: 'Unique key for the tenant (auto-generated from name when omitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Validate(NotReservedTenantKeyConstraint)
  tenantKey?: string;

  @ApiPropertyOptional({ description: 'Commercial plan (defaults to STARTER)', enum: TenantPlan })
  @IsOptional()
  @IsIn(Object.values(TenantPlan))
  plan?: TenantPlan;

  @ApiProperty({ description: "The tenant's initial TENANT_ADMIN", type: () => ProvisionTenantAdminBlock })
  @IsDefined()
  @ValidateNested()
  @Type(() => ProvisionTenantAdminBlock)
  admin!: ProvisionTenantAdminBlock;
}
