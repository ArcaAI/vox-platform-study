import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AiExplicitProviderMode, AiRoutingStrategy } from '@arcaai/domains';

/**
 * Author a NEW routing-policy revision (TASK-818 §3A.3).
 *
 * A new policy is always created as a DRAFT — `status` is deliberately NOT
 * accepted here. Promotion is its own audited transition (`POST :id/activate`)
 * because it is the moment PHI starts flowing to a different vendor, and the
 * supersede-only lineage (`supersedesVersion`, `activatedAt`) has to be written
 * atomically with the archival of the revision it replaces (§3A.8). A `status`
 * field on a create body would let a caller skip that.
 *
 * The nested structures stay `IsObject`/`IsArray` here and are validated for
 * shape in the service: the global pipe runs `forbidNonWhitelisted`, which
 * governs the TOP-LEVEL body only, and the §3A.4 gates need the parsed
 * candidate semantics (residency, baaCovered) rather than a decorator's
 * structural pass.
 */
export class CreateAiRoutingPolicyRequest {
  @ApiProperty({ description: 'AI task key this policy routes', example: 'text.finalize' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  taskKey!: string;

  @ApiProperty({
    description:
      'Ordered candidate chain. Every entry needs `connectionRef` (the AiProviderConnection `provider` under the `llm` service), `model`, `residency` and `baaCovered` — the last two are read by the §3A.4 hard gates, so an entry omitting them is rejected rather than defaulted.',
    isArray: true,
    type: Object,
    example: [{ rank: 0, weight: 100, connectionRef: 'azure', model: 'gpt-4o', residency: 'AZURE_US', baaCovered: true }],
  })
  @IsArray()
  @ArrayNotEmpty()
  candidates!: unknown[];

  @ApiPropertyOptional({
    description: 'AUTHORED revision. Omit to take the next revision after the highest existing one for this (tenant, taskKey).',
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  policyVersion?: number;

  @ApiPropertyOptional({ description: 'Selection strategy', enum: AiRoutingStrategy })
  @IsOptional()
  @IsEnum(AiRoutingStrategy)
  strategy?: AiRoutingStrategy;

  @ApiPropertyOptional({
    description:
      'Explicit-provider semantics. Defaults to STRICT — a request naming a provider that is down errors rather than substituting (§3A.4).',
    enum: AiExplicitProviderMode,
  })
  @IsOptional()
  @IsEnum(AiExplicitProviderMode)
  explicitProviderMode?: AiExplicitProviderMode;

  @ApiPropertyOptional({ description: 'Tie-break when two rows match equally specifically', example: 0 })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ description: 'Operator stop button. Defaults OFF.' })
  @IsOptional()
  @IsBoolean()
  killSwitch?: boolean;

  @ApiPropertyOptional({ description: '{ models, metadata, minContextTokens, maxContextTokens }', type: Object })
  @IsOptional()
  @IsObject()
  match?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      '{ maxDepth, triggers, requireSameResidencyClass, requireBaaCovered, crossFundingAllowed }. OMITTING this means NO fallback at all (maxDepth 0) — absence is fail-closed, never a guessed depth.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  fallback?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Circuit/health thresholds (§3A.5)', type: Object })
  @IsOptional()
  @IsObject()
  health?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Cache-affinity / sticky-routing hints', type: Object })
  @IsOptional()
  @IsObject()
  affinity?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Concurrent-stream ceiling' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentStreams?: number;

  @ApiPropertyOptional({ description: 'Requests-per-minute ceiling' })
  @IsOptional()
  @IsInt()
  @Min(0)
  requestsPerMinute?: number;

  @ApiPropertyOptional({ description: 'Tokens-per-minute ceiling' })
  @IsOptional()
  @IsInt()
  @Min(0)
  tokensPerMinute?: number;
}
