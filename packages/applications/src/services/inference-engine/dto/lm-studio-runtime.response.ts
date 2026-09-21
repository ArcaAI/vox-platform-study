import type { AiModelServingProfile } from '@arcaai/types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Whether the serving engine answered this read, and what it calls itself. */
export class LmStudioEngineStatusResponse {
  @ApiProperty({ description: 'Whether the engine answered `GET /api/v1/models` for this read. `false` is a result, not an error.' })
  reachable!: boolean;

  @ApiPropertyOptional({
    description:
      'The engine build, when it can be read. LM Studio exposes NO version over HTTP — `/api/v1/version` and every sibling path 404 (measured) — so this is absent on this build and only `lms version` inside the pod can answer. Reported as optional rather than invented.',
  })
  version?: string;
}

/** One GPU, from DCGM — the only per-device VRAM source there is. */
export class LmStudioDeviceResponse {
  @ApiProperty({ description: 'Device index, i.e. the DCGM `gpu` label. This is the index `gpuSplit.disabledGpus` / `.priority` name.' })
  index!: number;

  @ApiProperty({ description: 'The card, from the DCGM `modelName` label.' })
  name!: string;

  @ApiProperty({ description: 'Physical framebuffer, MiB — used + free + reserved, because DCGM publishes no total.' })
  totalMib!: number;

  @ApiProperty({ description: '`DCGM_FI_DEV_FB_USED`, MiB. Per DEVICE and shared by every time-sliced workload on it, never per pod.' })
  usedMib!: number;

  @ApiProperty({ description: '`DCGM_FI_DEV_FB_FREE`, MiB. The load precheck budgets against the LARGEST of these, not their sum.' })
  freeMib!: number;
}

/** One loaded model instance and the configuration the engine actually applied. */
export class LmStudioLoadedModelResponse {
  @ApiProperty({ description: 'The instance handle — what `POST .../models/{identifier}/unload` takes.' })
  identifier!: string;

  @ApiProperty({ description: 'The model key the engine answers to on the wire (`AiModel.wireModelId`).' })
  modelKey!: string;

  @ApiProperty({ description: "MEASURED: the GGUF's own size on disk, as the engine reports it." })
  weightsBytes!: number;

  @ApiProperty({
    enum: ['IDLE', 'ACTIVE'],
    description:
      'Residency state. This build exposes no busy/idle distinction over HTTP — `GET /api/v1/models` reports only that an instance exists — so a loaded instance always reads `IDLE`. `ACTIVE` is reserved for an engine that reports in-flight work.',
  })
  status!: 'IDLE' | 'ACTIVE';

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'What the engine is ACTUALLY running with, read back from the instance rather than from any stored profile. Carries only the fields the HTTP API reports — context window, decode slots and flash attention; KV-cache element types and GPU placement are visible only over the SDK websocket, so they are absent here rather than guessed.',
  })
  effective!: AiModelServingProfile;

  @ApiProperty({
    description:
      'ESTIMATE, never a measurement. Derived from `contextLength x parallel` (LM Studio gives every decode slot the FULL window) and scaled by the KV element types. Nothing in CUDA, NVML or DCGM reports per-model memory, so this is arithmetic, not observation.',
  })
  kvCacheEstimateBytes!: number;
}

/** `GET admin/inference-engines/lm-studio/runtime`. */
export class LmStudioRuntimeResponse {
  @ApiProperty({ type: LmStudioEngineStatusResponse })
  engine!: LmStudioEngineStatusResponse;

  @ApiProperty({ type: [LmStudioDeviceResponse], description: 'Every visible GPU, device index ascending. Empty when Prometheus has no DCGM data.' })
  devices!: LmStudioDeviceResponse[];

  @ApiProperty({ type: [LmStudioLoadedModelResponse], description: 'Every currently loaded instance.' })
  loaded!: LmStudioLoadedModelResponse[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The `lmStudio.serving.*` platform fallback — what a model whose `_metadata.serving` declares nothing inherits. Platform tier only: these keys are `globalOnly`, because they decide how much VRAM one process takes on cards shared with the STT and guardrail workloads.',
  })
  platformDefault!: AiModelServingProfile;
}
