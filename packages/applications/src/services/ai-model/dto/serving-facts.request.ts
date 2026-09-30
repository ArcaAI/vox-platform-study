import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/**
 * TASK-1021 (D-11) — `AiModel._metadata.serving` on the wire: the engine SIZING facts
 * `apps/vllm` builds an engine from, served per slug on the internal serving-spec route.
 *
 * Strict at the boundary (400 naming the field), unlike the lenient read-side builder, so an
 * admin is told their value was refused rather than have the row answer 409
 * `SERVING_FACTS_MISSING` later. `vramGiB` is required: it sizes a GPU.
 */
export class ModelServingFactsRequest {
  @ApiProperty({
    description: 'GiB of GPU memory one engine of this model claims inside its pool`s `vramBudgetGiB` (`vllm.pools`). Must be greater than 0.',
    example: 5,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  vramGiB!: number;

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
}
