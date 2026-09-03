import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AiExplicitProviderMode, AiRoutingStrategy } from '@arcaai/domains';

/**
 * Edit an existing routing-policy revision.
 *
 * ## Only a DRAFT may change its routing semantics
 *
 * keeps every revision addressable for rollback. Editing an ACTIVE
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
  // ─────────── — the provider-configuration binding ───────────
  // All SEMANTIC, so all refused on a revision that is not a DRAFT: changing
  // which model or connection serves redirects PHI to a different vendor while
  // keeping a revision id an auditor already signed off.
  //
  // `isDefault` is absent on purpose — see `setDefault`.
  @ApiPropertyOptional({ description: 'Human label for this configuration.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ description: 'AiProviderConnection id that serves this configuration (real FK).' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  providerConnectionId?: string;

  @ApiPropertyOptional({ description: 'AiModel id from the tenant or platform catalogue (real FK).' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  modelId?: string;

  @ApiPropertyOptional({ description: 'Provider-side model id on the wire (Azure deployment, GGUF id) when it differs from the catalogue slug.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelRef?: string;

  @ApiPropertyOptional({ description: 'Whether this candidate is servable.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Opaque residency-class label; compared for EQUALITY only by the §3A.4 gate.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  residency?: string;

  @ApiPropertyOptional({ description: 'Whether a BAA covers this vendor AND this model.' })
  @IsOptional()
  @IsBoolean()
  baaCovered?: boolean;

  @ApiPropertyOptional({ description: 'Task-specific extras (thresholds and the like).', type: Object })
  @IsOptional()
  @IsObject()
  configJson?: Record<string, unknown>;

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
