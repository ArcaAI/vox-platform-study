import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `POST admin/inference-engines/lm-studio/models/{modelKey}/load`.
 *
 * EXACTLY the options LM Studio's REST v1 load accepts, camelCased (TASK-1005
 * D-5), plus the gateway's own `force`. The engine's schema is STRICT — `ttl`,
 * `identifier` and `gpu` each answer 400 `unrecognized_keys` (§10.1) — so this
 * DTO is the whole surface, and the global pipe's `forbidNonWhitelisted`
 * rejects anything else before it reaches the adapter.
 *
 * Not expressible here, because REST v1 has no key for them: decode slots
 * (`parallel` — the pod's `LMS_PARALLEL`), KV-cache quantization, GPU placement
 * (the daemon's `LMS_GPU_SPLIT_STRATEGY`) and an idle TTL (the residency
 * controller's job). A model's `_metadata.serving` values for those fields are
 * applied only by the pod's boot preloader.
 *
 * `contextLength` and `flashAttention` omitted resolve request -> model row
 * (`_metadata.serving`) -> platform default (`lmStudio.serving.*`), widening only
 * on absence — so a load never falls back to the engine's own default window,
 * which for most models is far larger than the platform serves.
 */
export class LoadLmStudioModelRequest {
  @ApiPropertyOptional({
    description:
      'Context window to load with (`context_length`). Omit to use the model row`s `_metadata.serving.contextLength`, else `lmStudio.serving.contextLength`. Must not be narrower than the catalogue`s declared window (400).',
    minimum: 512,
    maximum: 1_048_576,
  })
  @IsOptional()
  @IsInt()
  @Min(512)
  @Max(1_048_576)
  contextLength?: number;

  @ApiPropertyOptional({ description: 'Prompt-processing batch size (`eval_batch_size`). Omit for the engine default.', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  evalBatchSize?: number;

  @ApiPropertyOptional({
    description:
      'Flash attention (`flash_attention`). Omit to use the model row, else `lmStudio.serving.flashAttention`. `false` against a model whose V-cache is quantized is a 400.',
  })
  @IsOptional()
  @IsBoolean()
  flashAttention?: boolean;

  @ApiPropertyOptional({ description: 'Active experts for a mixture-of-experts model (`num_experts`). Omit for the model default.', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  numExperts?: number;

  @ApiPropertyOptional({ description: 'Keep the KV cache in VRAM (`offload_kv_cache_to_gpu`). Omit for the engine default.' })
  @IsOptional()
  @IsBoolean()
  offloadKvCacheToGpu?: boolean;

  @ApiPropertyOptional({
    description:
      'Proceed despite the live VRAM budget. Bypasses the 409 `VRAM_BUDGET_EXCEEDED` gate AND ONLY that gate — never the super-admin 403, never the 404 for an unknown model, never a 400 on an incoherent profile, and never the 409 `LOAD_IN_PROGRESS` serialisation. The cards are time-sliced and give no memory isolation, so an over-budget load can take the STT and guardrail workloads down with it.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
