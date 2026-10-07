import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES,
  AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES,
  AI_MODEL_SERVING_MAX_GPUS,
  AI_MODEL_SERVING_RANGES,
} from '@arcaai/types';

/**
 * TASK-1050 W2h (OD-37) — `_metadata.serving.kvCacheQuant`: the K- and V-cache element types LM Studio loads the
 * model with. Vocabulary from `@arcaai/types` (`AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES`), never restated.
 */
export class ModelServingKvCacheQuantRequest {
  @ApiPropertyOptional({ enum: AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES, description: 'K-cache element type.' })
  @IsOptional()
  @IsIn(AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES as unknown as string[])
  k?: string;

  @ApiPropertyOptional({
    enum: AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES,
    description: 'V-cache element type. A quantized V-cache needs flash attention (checked when the profile is resolved).',
  })
  @IsOptional()
  @IsIn(AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES as unknown as string[])
  v?: string;
}

/** TASK-1050 W2h (OD-37) — `_metadata.serving.gpuSplit`: where LM Studio places THIS model across the GPUs. */
export class ModelServingGpuSplitRequest {
  @ApiPropertyOptional({ enum: AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES, description: 'How the model is spread over the visible GPUs.' })
  @IsOptional()
  @IsIn(AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES as unknown as string[])
  strategy?: string;

  @ApiPropertyOptional({ type: [Number], description: 'Device order for `priorityOrder`: distinct whole GPU indices.', example: [0] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AI_MODEL_SERVING_MAX_GPUS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(AI_MODEL_SERVING_MAX_GPUS - 1, { each: true })
  priority?: number[];

  @ApiPropertyOptional({ type: [Number], description: 'GPU indices the model must not touch: distinct whole indices.', example: [1] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AI_MODEL_SERVING_MAX_GPUS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(AI_MODEL_SERVING_MAX_GPUS - 1, { each: true })
  disabledGpus?: number[];
}

/** The LM Studio member names; a body naming any of them is an LM Studio write and need not restate `vramGiB`. */
const LM_STUDIO_SERVING_FIELDS = ['contextLength', 'parallel', 'flashAttention', 'kvCacheQuant', 'gpuSplit'] as const;
const isLmStudioOnly = (body: ModelServingFactsRequest): boolean =>
  body.vramGiB === undefined && LM_STUDIO_SERVING_FIELDS.some((field) => (body as unknown as Record<string, unknown>)[field] !== undefined);

/**
 * TASK-1021 (D-11) — `AiModel._metadata.serving` on the wire: the engine SIZING facts
 * `apps/vllm` builds an engine from, served per slug on the internal serving-spec route.
 *
 * Strict at the boundary (400 naming the field), unlike the lenient read-side builder, so an
 * admin is told their value was refused rather than have the row answer 409
 * `SERVING_FACTS_MISSING` later. `vramGiB` is required for a vLLM write: it sizes a GPU.
 *
 * TASK-1050 W2h (OD-37) — plus the LM Studio per-model fields the seed already writes
 * (`contextLength`, `parallel`, `flashAttention`, `kvCacheQuant`, `gpuSplit`), with the ranges and
 * vocabularies of `@arcaai/types` `lmstudio-serving-profile`. A body naming only LM Studio fields
 * does not restate `vramGiB`.
 */
export class ModelServingFactsRequest {
  @ApiPropertyOptional({
    description:
      'GiB of GPU memory one engine of this model claims inside its pool`s `vramBudgetGiB` (`vllm.pools`). Must be greater than 0. Required unless the body names only LM Studio fields.',
    example: 5,
  })
  @ValidateIf((body: ModelServingFactsRequest) => !isLmStudioOnly(body))
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  vramGiB?: number;

  @ApiPropertyOptional({
    description: 'vLLM `max_num_seqs` — the concurrent sequences one engine batches. Omit for the engine default.',
    example: 64,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxNumSeqs?: number;

  @ApiPropertyOptional({
    description: 'vLLM `enforce_eager` — disable CUDA graphs (less VRAM, slower). Omit for the engine default.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  enforceEager?: boolean;

  @ApiPropertyOptional({
    description: 'LM Studio load-time context window (tokens).',
    minimum: AI_MODEL_SERVING_RANGES.contextLength.min,
    maximum: AI_MODEL_SERVING_RANGES.contextLength.max,
    example: 16384,
  })
  @IsOptional()
  @IsInt()
  @Min(AI_MODEL_SERVING_RANGES.contextLength.min)
  @Max(AI_MODEL_SERVING_RANGES.contextLength.max)
  contextLength?: number;

  @ApiPropertyOptional({
    description: 'LM Studio concurrent sequences for this model.',
    minimum: AI_MODEL_SERVING_RANGES.parallel.min,
    maximum: AI_MODEL_SERVING_RANGES.parallel.max,
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(AI_MODEL_SERVING_RANGES.parallel.min)
  @Max(AI_MODEL_SERVING_RANGES.parallel.max)
  parallel?: number;

  @ApiPropertyOptional({ description: 'LM Studio flash attention. Required for a quantized V-cache.', example: true })
  @IsOptional()
  @IsBoolean()
  flashAttention?: boolean;

  @ApiPropertyOptional({ type: ModelServingKvCacheQuantRequest, description: 'KV-cache element types. Replaces the stored block whole.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelServingKvCacheQuantRequest)
  kvCacheQuant?: ModelServingKvCacheQuantRequest;

  @ApiPropertyOptional({ type: ModelServingGpuSplitRequest, description: 'Per-model GPU placement. Replaces the stored block whole.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelServingGpuSplitRequest)
  gpuSplit?: ModelServingGpuSplitRequest;
}
