import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsEnum, ValidateNested, IsBoolean, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Policy scope enum
 */
export enum PolicyScopeDto {
  GLOBAL = 'GLOBAL',
  TENANT = 'TENANT',
}

/**
 * Policy rule DTO
 */
export class PolicyRuleDto {
  @ApiProperty({ description: 'Action (e.g., read, create, update, delete, manage)', example: 'read' })
  @IsString()
  action: string;

  @ApiProperty({ description: 'Subject/resource type (e.g., User, Consultation)', example: 'User' })
  @IsString()
  subject: string;

  @ApiPropertyOptional({
    description: 'Conditions for the rule (Prisma WhereInput format)',
    example: { tenantId: '${context.tenantId}' },
  })
  @IsOptional()
  conditions?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Allowed fields (if restricted)',
    example: ['id', 'name', 'email'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fields?: string[];

  @ApiPropertyOptional({
    description: 'If true, this rule denies the action (cannot)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  inverted?: boolean;

  @ApiPropertyOptional({
    description: 'Reason for denial (shown to user)',
    example: 'You can only access your own data',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * DTO for creating a new policy
 */
export class CreatePolicyDto {
  @ApiProperty({ description: 'Policy name (unique)', example: 'manager-policy' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'Policy description', example: 'Permissions for team managers' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Policy scope',
    enum: PolicyScopeDto,
    example: PolicyScopeDto.TENANT,
  })
  @IsEnum(PolicyScopeDto)
  scope: PolicyScopeDto;

  @ApiProperty({
    description: 'Policy rules',
    type: [PolicyRuleDto],
    example: [
      { action: 'read', subject: 'User', conditions: { tenantId: '${context.tenantId}' } },
      { action: 'create', subject: 'Consultation' },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyRuleDto)
  rules: PolicyRuleDto[];
}

/**
 * TASK-409 — break-glass step-up confirmation for dangerous RBAC mutations
 * (policy delete, role delete, detach-from-role, multi-role rule edits).
 * Both fields are optional at the DTO layer ON PURPOSE: the service maps a
 * missing confirmation to `428 Precondition Required` (not a generic 400),
 * so clients can distinguish "you must confirm" from "your input is wrong".
 */
export class BreakGlassDto {
  @ApiPropertyOptional({ description: "Caller's CURRENT password (step-up re-authentication; never logged)" })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: 'Exact name of the policy/role being mutated (type-to-confirm)' })
  @IsOptional()
  @IsString()
  confirmationName?: string;
}

/**
 * DTO for updating a policy
 */
export class UpdatePolicyDto {
  @ApiPropertyOptional({ description: 'Policy name (unique)', example: 'manager-policy' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Policy description', example: 'Permissions for team managers' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Policy scope',
    enum: PolicyScopeDto,
    example: PolicyScopeDto.TENANT,
  })
  @IsOptional()
  @IsEnum(PolicyScopeDto)
  scope?: PolicyScopeDto;

  @ApiPropertyOptional({
    description: 'Policy rules',
    type: [PolicyRuleDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyRuleDto)
  rules?: PolicyRuleDto[];

  @ApiPropertyOptional({ description: 'Resource status (ENABLED or DISABLED)', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ENABLED', 'DISABLED'])
  resourceStatus?: string;

  @ApiPropertyOptional({
    description: 'TASK-409 — break-glass confirmation, required when editing the rules of a policy attached to more than one role. Never persisted.',
    type: BreakGlassDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BreakGlassDto)
  breakGlass?: BreakGlassDto;
}

/**
 * Policy response DTO
 */
export class PolicyResponse {
  @ApiProperty({ description: 'Policy ID' })
  id: string;

  @ApiProperty({ description: 'Policy name' })
  name: string;

  @ApiPropertyOptional({ description: 'Policy description' })
  description?: string;

  @ApiProperty({ description: 'Policy scope', enum: PolicyScopeDto })
  scope: PolicyScopeDto;

  @ApiProperty({ description: 'Policy rules', type: [PolicyRuleDto] })
  rules: PolicyRuleDto[];

  @ApiProperty({ description: 'Resource status' })
  resourceStatus: string;

  @ApiProperty({
    description:
      'TASK-409 — true for the anti-lockout protected system policies (seed-managed, read-only; deletion/detach/disable are refused server-side)',
  })
  isProtected: boolean;

  @ApiProperty({ description: 'Created at timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Updated at timestamp' })
  updatedAt: Date;
}

/**
 * Paginated policy response
 */
export class PaginatedPolicyResponse {
  @ApiProperty({ type: [PolicyResponse], description: 'List of policies' })
  data: PolicyResponse[];

  @ApiProperty({ description: 'Total count' })
  total: number;

  @ApiProperty({ description: 'Page number' })
  page: number;

  @ApiProperty({ description: 'Page size' })
  pageSize: number;
}

/**
 * Policy validation request
 */
export class ValidatePolicyDto {
  @ApiProperty({
    description: 'Policy rules to validate',
    type: [PolicyRuleDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyRuleDto)
  rules: PolicyRuleDto[];
}

/**
 * Policy validation response
 */
export class PolicyValidationResponse {
  @ApiProperty({ description: 'Whether the policy is valid' })
  valid: boolean;

  @ApiPropertyOptional({ description: 'Validation errors', type: [String] })
  errors?: string[];

  @ApiPropertyOptional({ description: 'Validation warnings', type: [String] })
  warnings?: string[];
}
