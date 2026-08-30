import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsObject, IsOptional, Min } from 'class-validator';
import { AiExplicitProviderMode, AiRoutingStrategy } from '@arcaai/domains';

/**
 * Edit an existing routing-policy revision.
 *
 * ## Only a DRAFT may change its routing semantics
 *
 * §3A.8 keeps every revision addressable for rollback. Editing an ACTIVE
 * revision in place destroys that: the row a rollback would return to no
 * longer contains what it contained when it was serving, and the audit trail's
 * "before" becomes the only record of a configuration that once decided where
 * PHI went. So on an ACTIVE (or ARCHIVED) revision every field here is refused
 * EXCEPT `killSwitch` — the operator stop button has to work on the revision
 * that is actually live, which is the whole point of a stop button.
 *
 * To change an ACTIVE policy's routing: author a new DRAFT revision and
 * activate it. The activation archives its predecessor and records
 * `supersedesVersion`.
 *
 * `status` is absent by design — see `CreateAiRoutingPolicyRequest`.
 */
export class UpdateAiRoutingPolicyRequest {
  @ApiPropertyOptional({ description: 'Ordered candidate chain (DRAFT only)', isArray: true, type: Object })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  candidates?: unknown[];

  @ApiPropertyOptional({ description: 'Selection strategy (DRAFT only)', enum: AiRoutingStrategy })
  @IsOptional()
  @IsEnum(AiRoutingStrategy)
  strategy?: AiRoutingStrategy;

  @ApiPropertyOptional({ description: 'Explicit-provider semantics (DRAFT only)', enum: AiExplicitProviderMode })
  @IsOptional()
  @IsEnum(AiExplicitProviderMode)
  explicitProviderMode?: AiExplicitProviderMode;

  @ApiPropertyOptional({ description: 'Tie-break priority (DRAFT only)' })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ description: 'Operator stop button. The ONLY field editable on an ACTIVE revision.' })
  @IsOptional()
  @IsBoolean()
  killSwitch?: boolean;

  @ApiPropertyOptional({ description: 'Narrowing predicate (DRAFT only)', type: Object })
  @IsOptional()
  @IsObject()
  match?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Fallback contract (DRAFT only)', type: Object })
  @IsOptional()
  @IsObject()
  fallback?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Circuit/health thresholds (DRAFT only)', type: Object })
  @IsOptional()
  @IsObject()
  health?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Cache-affinity hints (DRAFT only)', type: Object })
  @IsOptional()
  @IsObject()
  affinity?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Concurrent-stream ceiling (DRAFT only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentStreams?: number;

  @ApiPropertyOptional({ description: 'Requests-per-minute ceiling (DRAFT only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  requestsPerMinute?: number;

  @ApiPropertyOptional({ description: 'Tokens-per-minute ceiling (DRAFT only)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  tokensPerMinute?: number;

  @ApiPropertyOptional({
    description: 'OCC token. The controller folds the RFC 7232 `If-Match` header over this; a mismatch is 412, an absent header 428.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
