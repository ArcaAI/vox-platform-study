import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Min } from 'class-validator';

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export class SetRateLimitEnabledRequest {
  @ApiProperty({ description: 'Global rate-limit kill-switch. `false` disables throttling for every route.' })
  @IsBoolean()
  enabled!: boolean;
}

export class SetRateLimitTierRequest {
  @ApiProperty({ required: false, minimum: 1, description: 'Max requests allowed within the window.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false, minimum: 1, description: 'Window length in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  ttl?: number;
}

export class SetRateLimitRouteRequest {
  @ApiProperty({ required: false, minimum: 1, description: 'Per-endpoint max requests (overrides the route decorator and tier baseline).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiProperty({ required: false, minimum: 1, description: 'Per-endpoint window length in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  ttl?: number;

  @ApiProperty({ required: false, description: 'Per-endpoint toggle. `false` disables throttling for just this route.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Response DTOs (Swagger documentation only — the service returns the matching
// `RateLimitPolicy` plain object)
// ---------------------------------------------------------------------------

export class RateLimitTierPolicyResponse {
  @ApiProperty({ enum: ['default', 'strict', 'heavy', 'relaxed'] })
  tier!: string;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  ttl!: number;

  @ApiProperty({ enum: ['db', 'code', 'default'] })
  limitSource!: string;

  @ApiProperty({ enum: ['db', 'code', 'default'] })
  ttlSource!: string;
}

export class RateLimitRoutePolicyResponse {
  @ApiProperty({ example: 'auth.login' })
  routeId!: string;

  @ApiProperty()
  controller!: string;

  @ApiProperty({ required: false })
  handler?: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: ['default', 'strict', 'heavy', 'relaxed'] })
  tier!: string;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  ttl!: number;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ enum: ['db', 'code', 'default'] })
  limitSource!: string;

  @ApiProperty({ enum: ['db', 'code', 'default'] })
  ttlSource!: string;
}

export class RateLimitPolicyResponse {
  @ApiProperty({ description: 'Effective global kill-switch state.' })
  enabled!: boolean;

  @ApiProperty({ enum: ['db', 'default'] })
  enabledSource!: string;

  @ApiProperty({ type: [RateLimitTierPolicyResponse] })
  tiers!: RateLimitTierPolicyResponse[];

  @ApiProperty({ type: [RateLimitRoutePolicyResponse] })
  routes!: RateLimitRoutePolicyResponse[];
}

// ---------------------------------------------------------------------------
// Rate-limit RULES (TASK-785) — ranks 1, 2 and 4 of the precedence chain
// ---------------------------------------------------------------------------

export class CreateRateLimitRuleRequest {
  @ApiPropertyOptional({
    description:
      'Tenant this rule applies to. Omit (or pass the SYSTEM tenant) for a platform-wide rule. A tenant-scoped rule outranks every platform rule.',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiProperty({
    description:
      'Route key `METHOD:/path` (METHOD may be `*`), or the reserved `*` for every route. A platform-scoped rule may not use `*` — set the platform-wide limit on the base tiers instead.',
    example: 'POST:/api/v1/auth/login',
  })
  @IsString()
  @IsNotEmpty()
  routeMatch!: string;

  @ApiPropertyOptional({
    enum: ['EXACT', 'PREFIX'],
    description: 'EXACT compares the whole route key; PREFIX allows a trailing `*`. Defaults to EXACT.',
  })
  @IsOptional()
  @IsIn(['EXACT', 'PREFIX'])
  matchKind?: 'EXACT' | 'PREFIX';

  @ApiProperty({ minimum: 1, description: 'Requests allowed per window.' })
  @IsInt()
  @Min(1)
  limitValue!: number;

  @ApiProperty({ minimum: 1, description: 'Window length in milliseconds.' })
  @IsInt()
  @Min(1)
  windowMs!: number;

  @ApiPropertyOptional({
    description: '`false` EXEMPTS this scope from throttling. A matching rule always terminates resolution — it never falls through.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Why this rule exists — shown in the admin list.' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateRateLimitRuleRequest {
  @ApiPropertyOptional({ minimum: 1, description: 'Requests allowed per window.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  limitValue?: number;

  @ApiPropertyOptional({ minimum: 1, description: 'Window length in milliseconds.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  windowMs?: number;

  @ApiPropertyOptional({ description: '`false` EXEMPTS this scope from throttling.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Why this rule exists.' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class SetRateLimitPlanRequest {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'ABSOLUTE requests-per-window for every tenant on this plan. Null/omitted keeps the plan expressing its limit through `rateLimitTier`.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitPerMinute?: number | null;

  @ApiPropertyOptional({ minimum: 1, description: 'Window paired with `rateLimitPerMinute`. Read only when that is set.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitWindowMs?: number | null;

  @ApiPropertyOptional({ description: 'Named tier this plan selects when it carries no absolute limit.' })
  @IsOptional()
  @IsString()
  rateLimitTier?: string;

  @ApiProperty({ description: 'OCC token — the `_version` the caller believes it is updating.' })
  @IsInt()
  expectedVersion!: number;
}

export class RateLimitRuleResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty({ description: '`true` when this is a SYSTEM-owned, platform-wide rule.' }) platform!: boolean;
  @ApiProperty() routeMatch!: string;
  @ApiProperty({ enum: ['EXACT', 'PREFIX'] }) matchKind!: string;
  @ApiProperty() limitValue!: number;
  @ApiProperty() windowMs!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty({ required: false, nullable: true }) description?: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RouteCatalogEntryResponse {
  @ApiProperty({ description: 'Route key `METHOD:/path` — paste straight into a rule `routeMatch`.' }) routeId!: string;
  @ApiProperty() method!: string;
  @ApiProperty() path!: string;
  @ApiProperty() controller!: string;
  @ApiProperty() handler!: string;
  @ApiProperty({ required: false, description: 'The route’s `@Throttle` limit, which seeds rank 5.' }) decoratorLimit?: number;
  @ApiProperty({ required: false }) decoratorWindowMs?: number;
}

export class RateLimitExplainOfferResponse {
  @ApiProperty({ enum: ['tenant-route', 'tenant', 'plan', 'platform-route', 'platform-base'] }) level!: string;
  @ApiProperty() limitValue!: number;
  @ApiProperty() windowMs!: number;
  @ApiProperty({ required: false }) ruleId?: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ description: '`true` for the level that decided.' }) winner!: boolean;
}

export class RateLimitExplainResponse {
  @ApiProperty({ required: false, nullable: true }) tenantId!: string | null;
  @ApiProperty() routeKey!: string;
  @ApiProperty({ required: false, nullable: true, description: '`null` when the winning level EXEMPTS the scope.' })
  effective!: { limitValue: number; windowMs: number } | null;
  @ApiProperty({ enum: ['tenant-route', 'tenant', 'plan', 'platform-route', 'platform-base'] }) level!: string;
  @ApiProperty({ required: false }) ruleId?: string;
  @ApiProperty({ enum: ['tenant', 'ip'], description: 'How the counter is bucketed — the answer to "why do these callers share a budget?".' })
  bucket!: string;
  @ApiProperty({ type: [RateLimitExplainOfferResponse] }) trace!: RateLimitExplainOfferResponse[];
}

/** Swagger shape for the plan projection (`PlanEntitlementResponse`, rate-limit fields only). */
export class RateLimitPlanResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['STARTER', 'TRIAL', 'PRO', 'ENTERPRISE'] }) plan!: string;
  @ApiProperty({ description: 'Named tier this plan selects when it carries no absolute limit.' }) rateLimitTier!: string;
  @ApiProperty({ required: false, nullable: true, description: 'ABSOLUTE requests-per-window; null = use the tier.' })
  rateLimitPerMinute?: number | null;
  @ApiProperty({ required: false, nullable: true }) rateLimitWindowMs?: number | null;
  @ApiProperty({ description: 'OCC token — echo as `expectedVersion` on update.' }) version!: number;
}
