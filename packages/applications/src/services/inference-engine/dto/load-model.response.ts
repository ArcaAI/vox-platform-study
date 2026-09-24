import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { LmStudioLoadConfig, LmStudioLoadOutcome, LmStudioResidencyModel } from '../lmstudio-engine.client';

/** The configuration LM Studio reports an instance was loaded with (whitelisted — never the prompt template). */
export class LmStudioLoadConfigResponse implements LmStudioLoadConfig {
  @ApiPropertyOptional({ description: '`context_length` — the window the engine actually applied.' })
  contextLength?: number;

  @ApiPropertyOptional({ description: '`eval_batch_size`.' })
  evalBatchSize?: number;

  @ApiPropertyOptional({ description: '`physical_batch_size`.' })
  physicalBatchSize?: number;

  @ApiPropertyOptional({ description: '`parallel` — decode slots. Not settable over REST; the pod`s `LMS_PARALLEL` decides it.' })
  parallel?: number;

  @ApiPropertyOptional({ description: '`flash_attention`.' })
  flashAttention?: boolean;

  @ApiPropertyOptional({ description: '`offload_kv_cache_to_gpu`.' })
  offloadKvCacheToGpu?: boolean;

  @ApiPropertyOptional({ description: '`num_experts`, for a mixture-of-experts model.' })
  numExperts?: number;
}

/**
 * One loaded instance in the residency contract's `gateway` shape
 * (`tests/contracts/model-residency-agent.fixture.json`). LM Studio reports no
 * per-model bytes, in-flight count or timestamps, so those are `null` rather
 * than invented.
 */
export class LmStudioResidencyModelResponse implements LmStudioResidencyModel {
  @ApiProperty({ description: 'The exact engine model key — `AiModel.wireModelId`.' })
  modelRef!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The platform catalogue row that claims this key, when known.' })
  aiModelId!: string | null;

  @ApiProperty({ description: 'LM Studio`s model type (`llm`, `embedding`, …).' })
  cache!: string;

  @ApiProperty({ enum: ['loading', 'loaded', 'unloading'] })
  state!: 'loading' | 'loaded' | 'unloading';

  @ApiProperty({ description: '`multi`: the daemon splits a model across both cards itself (`LMS_GPU_SPLIT_STRATEGY`).' })
  device!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Resident bytes. Always `null` here — LM Studio reports none; the residency controller measures it.',
  })
  bytes!: number | null;

  @ApiProperty({ enum: ['measured', 'unknown'] })
  bytesSource!: 'measured' | 'unknown';

  @ApiProperty({ type: Number, nullable: true, description: 'Requests in flight. Always `null` — LM Studio does not report it.' })
  inFlight!: number | null;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty()
  adminPinned!: boolean;

  @ApiProperty({ type: Number, nullable: true, description: 'Idle TTL. `null` — REST v1 has no TTL; idle unload is the controller`s job.' })
  ttlSeconds!: number | null;

  @ApiProperty({ type: String, nullable: true })
  loadedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastUsedAt!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`load_time_seconds` of the load that produced this answer; `null` when it was already loaded.',
  })
  loadSeconds!: number | null;

  @ApiProperty({ description: 'The instance handle an unload takes.' })
  instanceId!: string;

  @ApiProperty({ type: LmStudioLoadConfigResponse })
  loadConfig!: LmStudioLoadConfigResponse;
}

/**
 * The 200 body of `POST .../models/{modelKey}/load` (TASK-1005).
 *
 * `already_loaded` is the answer for a key the engine already holds: REST v1
 * load is not idempotent (a second load creates `<key>:2`, a second full copy
 * in VRAM), so the gateway lists first and returns the existing instance.
 */
export class LoadLmStudioModelResponse {
  @ApiProperty({ enum: ['loaded', 'already_loaded'] })
  outcome!: LmStudioLoadOutcome;

  @ApiProperty({ type: LmStudioResidencyModelResponse })
  model!: LmStudioResidencyModelResponse;
}

/** The 202 body of `POST .../models/{identifier}/unload`. */
export class UnloadLmStudioModelResponse {
  @ApiProperty({ description: 'Whether the engine accepted the unload.' })
  unloaded!: boolean;

  @ApiProperty({
    description:
      'ALWAYS `true`, and it is a warning rather than a capability. JIT loading cannot be disabled on this build — there is no CLI flag, no REST field and no settings key for it — so the next inference request reloads the model, on the JIT defaults (`lmStudio.jit.*`) rather than on the profile it was unloaded from. An unload is therefore ADVISORY: it returns VRAM now, it does not keep the model gone.',
  })
  jitReloadPossible!: true;
}
