import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { MODEL_RESIDENCY_SERVICES, ModelResidencyClass } from '@arcaai/domains';
import { RESIDENCY_CONTROLLED_SERVICES, type ResidencyControlledService } from '../model-residency.types';

/**
 * TASK-1005 — request bodies of `/api/v1/admin/model-residency/*`, exactly as
 * pinned by `tests/contracts/model-residency-admin.fixture.json`. Every field is
 * declared: the global pipe runs `whitelist + forbidNonWhitelisted`, so an
 * undeclared key is a 400 before anything reaches a service.
 */

/**
 * LM Studio REST v1's DOCUMENTED load keys, camelCased — and nothing else. The
 * engine's schema is strict (`ttl`, `identifier`, `gpu` answer 400
 * `unrecognized_keys`, TASK-1005 §10.1), so parallel slots, KV quantization and
 * GPU split are not expressible here. Accepted ONLY for service `lm-studio`
 * (400 `OPTIONS_UNSUPPORTED` otherwise).
 */
export class LmStudioResidencyLoadOptions {
  @ApiPropertyOptional({ description: 'Context window to load with (`context_length`).', minimum: 512, maximum: 1_048_576, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(512)
  @Max(1_048_576)
  contextLength?: number | null;

  @ApiPropertyOptional({ description: 'Prompt-processing batch size (`eval_batch_size`).', minimum: 1, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  evalBatchSize?: number | null;

  @ApiPropertyOptional({ description: 'Flash attention (`flash_attention`).', nullable: true })
  @IsOptional()
  @IsBoolean()
  flashAttention?: boolean | null;

  @ApiPropertyOptional({ description: 'Active experts for a mixture-of-experts model (`num_experts`).', minimum: 1, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  numExperts?: number | null;

  @ApiPropertyOptional({ description: 'Keep the KV cache in VRAM (`offload_kv_cache_to_gpu`).', nullable: true })
  @IsOptional()
  @IsBoolean()
  offloadKvCacheToGpu?: boolean | null;
}

/** TASK-1055 — a device a load may be placed on: `gpu<N>` (catalogue id, PCI-bus order), `multi` (LM Studio split across cards per the model's profile), `cpu`. */
export const RESIDENCY_DEVICE_PATTERN = /^(gpu\d+|multi|cpu)$/;

export class LoadModelResidencyRequest {
  @ApiProperty({ enum: RESIDENCY_CONTROLLED_SERVICES, description: 'The serving workload. `stt-worker` has no control API and is read-only.' })
  @IsIn(RESIDENCY_CONTROLLED_SERVICES)
  service!: ResidencyControlledService;

  @ApiProperty({
    description:
      'The key the service caches the model under: stt = the ASR model slug, nlp = the model name (hub id), lm-studio = the EXACT engine key (`AiModel.wireModelId`).',
    example: 'gemma-4-e4b-it-qat@q4_0',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  modelRef!: string;

  @ApiPropertyOptional({ description: 'Pin the model once loaded (never evicted by TTL or pressure).', default: false })
  @IsOptional()
  @IsBoolean()
  pin?: boolean;

  @ApiPropertyOptional({
    description:
      'Proceed over the memory budget (409 `OVER_BUDGET` otherwise) — REQUIRES a non-empty `reason`, which is audited (owner OD-3). With `replace`, also unloads a model that is serving requests.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({ description: 'Why — mandatory for a forced load; recorded on the audit event.', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({
    description:
      '"Apply & reload": unload the resident instance(s) of this model first, then load (with `options`), as ONE operation. Refused 409 `IN_FLIGHT` while the model serves requests unless `force`.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;

  @ApiPropertyOptional({ type: () => LmStudioResidencyLoadOptions, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LmStudioResidencyLoadOptions)
  options?: LmStudioResidencyLoadOptions | null;

  @ApiPropertyOptional({
    description:
      'TASK-1055 — where to load: `gpu<N>`, `multi` (LM Studio only: split across cards) or `cpu`. Absent = the model`s default placement (its `_metadata.residency.defaultDevice`, else the service default). A device that cannot hold the model answers 409 `OVER_BUDGET` with `candidates` + `suggestedDevice`.',
    nullable: true,
    example: 'gpu1',
  })
  @IsOptional()
  @IsString()
  @Matches(RESIDENCY_DEVICE_PATTERN)
  device?: string | null;

  @ApiPropertyOptional({
    description: 'TASK-1055 (OD-4) — also make `device` this model`s default placement (written to the catalogue row; used at boot and by the controller). Requires `device`.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  makeDefault?: boolean;
}

export class UnloadModelResidencyRequest {
  @ApiProperty({ enum: RESIDENCY_CONTROLLED_SERVICES })
  @IsIn(RESIDENCY_CONTROLLED_SERVICES)
  service!: ResidencyControlledService;

  @ApiProperty({ example: 'gliner-medical-large' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  modelRef!: string;

  @ApiPropertyOptional({ description: 'Unload even while the model serves requests (409 `IN_FLIGHT` otherwise).', default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({
    description:
      'Why — recorded on the audit event. TASK-1055 (OD-2): REQUIRED to unload a live-path model (409 `LIVE_PATH_REASON_REQUIRED` with its `consumers` otherwise).',
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;

  @ApiPropertyOptional({ description: 'TASK-1055 — unload only the copy on this device (`gpu<N>`); absent = every copy.', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(RESIDENCY_DEVICE_PATTERN)
  device?: string | null;
}

export class PinModelResidencyRequest {
  @ApiProperty({ enum: RESIDENCY_CONTROLLED_SERVICES })
  @IsIn(RESIDENCY_CONTROLLED_SERVICES)
  service!: ResidencyControlledService;

  @ApiProperty({ example: 'arcaai-whisper-ml-en-ggml' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  modelRef!: string;

  @ApiProperty({ description: 'Pin (true) or unpin (false). A pinned model survives its idle TTL and is never evicted.' })
  @IsBoolean()
  pinned!: boolean;

  @ApiPropertyOptional({
    description: 'Idle TTL in seconds; `null` resets to the service default; omitted leaves it as it is.',
    nullable: true,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  ttlSeconds?: number | null;
}

export class CreateModelResidencyPolicyRequest {
  @ApiProperty({ description: 'The catalogue model (`AiModel.id`) this policy governs.' })
  @IsString()
  @IsNotEmpty()
  aiModelId!: string;

  @ApiProperty({ enum: MODEL_RESIDENCY_SERVICES })
  @IsIn(MODEL_RESIDENCY_SERVICES)
  service!: string;

  @ApiPropertyOptional({ enum: ModelResidencyClass, default: ModelResidencyClass.ON_DEMAND })
  @IsOptional()
  @IsEnum(ModelResidencyClass)
  class?: ModelResidencyClass;

  @ApiPropertyOptional({ description: 'Idle TTL the controller enforces; `null` defers to the service`s own cache TTL.', nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  idleTtlSeconds?: number | null;

  @ApiPropertyOptional({ description: 'Higher = more valuable to keep resident.', default: 0 })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ description: 'Ceiling on concurrently resident instances.', default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxInstances?: number;

  @ApiPropertyOptional({ description: 'Advisory placement hint (`gpu0`, `gpu1`, `cpu`) — a tie-break, never a guarantee.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  preferredDevice?: string | null;
}

export class UpdateModelResidencyPolicyRequest {
  @ApiPropertyOptional({ enum: ModelResidencyClass })
  @IsOptional()
  @IsEnum(ModelResidencyClass)
  class?: ModelResidencyClass;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  idleTtlSeconds?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxInstances?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  preferredDevice?: string | null;

  /**
   * The body fallback for the CAS predicate; the `If-Match` header overrides it
   * (the controller folds the header in). Never staged onto the entity.
   */
  @ApiPropertyOptional({ description: 'Version from the prior read (the `If-Match` header wins when both are sent).', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
