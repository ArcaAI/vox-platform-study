import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

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
