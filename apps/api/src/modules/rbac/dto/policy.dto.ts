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
