import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AiExplicitProviderMode, AiRoutingStrategy } from '@arcaai/domains';

/**
 * Author a NEW routing-policy revision
 *
 * ## — this body now authors ONE PROVIDER CONFIGURATION
 *
 * The grain changed: a row is one CANDIDATE, and the ordered chain is the set of
 * rows sharing `(tenantId, taskKey)` ordered by `priority`. Supply
 * `providerConnectionId` + `modelId` (or `modelRef`) rather than a
 * `candidates` array; the array is still accepted so a pre-844 caller is not
 * broken, but nothing reads it.
 *
 * **`isDefault` is deliberately NOT accepted here.** Electing the default has
 * to unset the incumbent in the SAME transaction or the partial unique index
 * `AiRoutingPolicy_tenant_task_default_unique` rejects the write — so it is its
 * own audited transition (`POST :id/default`), not a field on a create body.
 *
 * A new policy is always created as a DRAFT — `status` is deliberately NOT
 * accepted here. Promotion is its own audited transition (`POST :id/activate`)
 * because it is the moment PHI starts flowing to a different vendor, and the
 * supersede-only lineage (`supersedesVersion`, `activatedAt`) has to be written
 * atomically with the archival of the revision it replaces ( A `status`
 * field on a create body would let a caller skip that.
 *
 * The nested structures stay `IsObject`/`IsArray` here and are validated for
 * shape in the service: the global pipe runs `forbidNonWhitelisted`, which
 * governs the TOP-LEVEL body only, and the gates need the parsed
 * candidate semantics (residency, baaCovered) rather than a decorator's
 * structural pass.
 */
export class CreateAiRoutingPolicyRequest {
  @ApiProperty({ description: 'AI task key this policy routes', example: 'text.finalize' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  taskKey!: string;

  @ApiPropertyOptional({
    description:
      'Human label for this configuration — what an administrator sees in the picker and what an export artifact is identified by. Not a key.',
    example: 'Azure GPT-4o (EU)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'AiProviderConnection id that serves this configuration. A real foreign key — the connection must exist.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  providerConnectionId?: string;

  @ApiPropertyOptional({
    description:
      'AiModel id from the tenant or platform catalogue. A real foreign key. Supply this or `modelRef`; a configuration that names no model is rejected.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  modelId?: string;

  @ApiPropertyOptional({
    description:
      'Provider-side model identifier sent on the wire when it differs from the catalogue slug — an Azure OpenAI DEPLOYMENT name, an LM Studio GGUF id, a vLLM served-model-name.',
    example: 'gpt-4o-eu-prod',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelRef?: string;

  @ApiPropertyOptional({
    description: 'Whether this candidate is servable. Defaults true. Distinct from `killSwitch` (operator stop) and soft delete (lifecycle).',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Opaque residency-class label. Compared for EQUALITY only by the fallback gate — there is no enumerated list of clouds in code to drift from reality.',
    example: 'AZURE_EU',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  residency?: string;

  @ApiPropertyOptional({
    description: 'Whether a BAA covers this vendor AND this model. Read by the BAA gate; never defaulted on your behalf.',
  })
  @IsOptional()
  @IsBoolean()
  baaCovered?: boolean;

  @ApiPropertyOptional({ description: 'Task-specific extras (thresholds and the like), absorbed from `AiTaskDefault.configJson`.', type: Object })
  @IsOptional()
  @IsObject()
  configJson?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'DEPRECATED by the ordered chain is now the SET of rows sharing (tenantId, taskKey), ordered by `priority`. Accepted only so a pre-844 caller is not broken; the resolver no longer reads it.',
    isArray: true,
    type: Object,
    deprecated: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  candidates?: unknown[];

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
    description: 'Explicit-provider semantics. Defaults to STRICT — a request naming a provider that is down errors rather than substituting.',
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

  @ApiPropertyOptional({ description: 'Circuit/health thresholds', type: Object })
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
