import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  RecommendationAction,
  RecommendationReason,
  ResidencyBytesSource,
  ResidencyClassName,
  ResidencyClassSource,
  ResidencyErrorCode,
  ResidencyMode,
  ResidencyModelState,
  ResidencyOperationStatus,
  ResidencyServiceName,
} from '../model-residency.types';

/**
 * TASK-1005 — response shapes of `/api/v1/admin/model-residency/*`, key for key
 * `tests/contracts/model-residency-admin.fixture.json` (the console lane builds
 * against the same file).
 */

export class ModelResidencyFreshness {
  @ApiProperty({ description: 'Age in seconds of the OLDEST service report the view is built from (target ≤ 15 s).', example: 12 })
  maxAgeSeconds!: number;

  @ApiProperty({ description: 'Services whose last successful report is older than 30 s (their rows are the last known state).', type: [String] })
  staleServices!: string[];
}

export class ModelResidencyDevice {
  @ApiProperty({ example: 'gpu0', description: '`gpu<N>` = DCGM device N; `cpu:<service>` = that service`s host memory pool.' })
  id!: string;

  @ApiProperty({ enum: ['gpu', 'cpu'] })
  kind!: 'gpu' | 'cpu';

  @ApiProperty({ example: 'NVIDIA RTX 2000 Ada Generation' })
  name!: string;

  @ApiProperty() totalBytes!: number;
  @ApiProperty() usedBytes!: number;
  @ApiProperty() freeBytes!: number;

  @ApiProperty({ nullable: true, type: Number, description: 'DCGM `DCGM_FI_DEV_GPU_UTIL`; `null` for a CPU pool.' })
  utilisationPercent!: number | null;

  @ApiProperty({ description: 'The `residency.headroomPercent` in force.' })
  headroomPercent!: number;
}

export class ModelResidencyModel {
  @ApiProperty({ enum: ['stt', 'stt-worker', 'nlp', 'lm-studio'] }) service!: ResidencyServiceName;
  @ApiProperty({ description: 'Pod name (stt, nlp, stt-worker) or LM Studio instance id (a `<key>:2` duplicate is its own row).' })
  instance!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ nullable: true, type: String }) aiModelId!: string | null;
  @ApiProperty({ nullable: true, type: String }) aiModelName!: string | null;
  @ApiProperty({ description: '`gpu<N>`, `multi` (LM Studio spans both cards), `cpu:<service>`, or the service`s own id when it cannot be mapped.' })
  device!: string;
  @ApiProperty({ enum: ['loading', 'loaded', 'unloading'] }) state!: ResidencyModelState;
  @ApiProperty({ nullable: true, type: Number, description: 'MEASURED footprint, never a catalogue estimate.' }) bytes!: number | null;
  @ApiProperty({ enum: ['measured', 'unknown'] }) bytesSource!: ResidencyBytesSource;
  @ApiProperty({ nullable: true, type: Number }) inFlight!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'From Prometheus `model_inference_latency_seconds` (5 m rate).' })
  requestsPerMin!: number | null;
  @ApiProperty({ nullable: true, type: Number }) p50LatencyMs!: number | null;
  @ApiProperty({ nullable: true, type: String }) loadedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastUsedAt!: string | null;
  @ApiProperty({ nullable: true, type: Number }) loadSeconds!: number | null;
  @ApiProperty({ enum: ['PINNED', 'WARM', 'ON_DEMAND'] }) class!: ResidencyClassName;
  @ApiProperty({ enum: ['policy', 'implicit-live-path', 'default'] }) classSource!: ResidencyClassSource;
  @ApiProperty({ nullable: true, type: Number }) ttlSeconds!: number | null;
  @ApiProperty({ description: 'Never evicted: PINNED class, or pinned by an operator.' }) pinned!: boolean;
  @ApiProperty({ description: 'Pinned by an operator (or by the controller for the live path).' }) adminPinned!: boolean;
  @ApiProperty({ nullable: true, type: String }) policyId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) policyVersion!: number | null;
}

export class ModelResidencyRecommendation {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['load', 'unload', 'pin', 'unpin'] }) action!: RecommendationAction;
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ enum: ['idle_ttl_expired', 'promotion_rate', 'live_path_pin', 'make_room', 'admission_rejected'] })
  reason!: RecommendationReason;
  @ApiProperty({ enum: ['shadow', 'enforce'] }) mode!: ResidencyMode;
  @ApiProperty({ description: 'Whether the command was sent AND succeeded. Always `false` in shadow mode.' }) applied!: boolean;
}

export class ModelResidencyViewResponse {
  @ApiProperty({ enum: ['shadow', 'enforce'], description: '`shadow` until the SYSTEM setting `residency.enforce` is true.' })
  mode!: ResidencyMode;
  @ApiProperty() reportedAt!: string;
  @ApiProperty({ type: ModelResidencyFreshness }) freshness!: ModelResidencyFreshness;
  @ApiProperty({ type: [ModelResidencyDevice] }) devices!: ModelResidencyDevice[];
  @ApiProperty({ type: [ModelResidencyModel] }) models!: ModelResidencyModel[];
  @ApiProperty({ type: [ModelResidencyRecommendation], description: 'Newest first; bounded in-memory log.' })
  recommendations!: ModelResidencyRecommendation[];
}

export class ModelResidencyLoadResponse {
  @ApiProperty({ enum: ['accepted', 'already_loaded'] }) outcome!: 'accepted' | 'already_loaded';
  @ApiPropertyOptional({ description: 'Present on `accepted` (202): poll `GET operations/:operationId`.' }) operationId?: string;
  @ApiProperty({ type: ModelResidencyModel }) model!: ModelResidencyModel;
}

export class ModelResidencyUnloadResponse {
  @ApiProperty({ enum: ['unloaded', 'not_loaded'] }) outcome!: 'unloaded' | 'not_loaded';
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
}

export class ModelResidencyPinResponse {
  @ApiProperty({ type: ModelResidencyModel }) model!: ModelResidencyModel;
}

export class ModelResidencyOperationError {
  @ApiProperty() code!: ResidencyErrorCode | string;
  @ApiProperty() message!: string;
}

export class ModelResidencyOperationResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['load', 'replace'] }) action!: 'load' | 'replace';
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ enum: ['running', 'succeeded', 'failed'] }) status!: ResidencyOperationStatus;
  @ApiProperty({ type: ModelResidencyOperationError, nullable: true }) error!: ModelResidencyOperationError | null;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true, type: String }) finishedAt!: string | null;
}

export class ModelResidencyPolicyResponse {
  @ApiProperty() id!: string;
  @ApiProperty() aiModelId!: string;
  @ApiProperty() service!: string;
  @ApiProperty({ enum: ['PINNED', 'WARM', 'ON_DEMAND'] }) class!: ResidencyClassName;
  @ApiProperty({ nullable: true, type: Number }) idleTtlSeconds!: number | null;
  @ApiProperty() priority!: number;
  @ApiProperty() maxInstances!: number;
  @ApiProperty({ nullable: true, type: String }) preferredDevice!: string | null;
  @ApiProperty({ description: 'The OCC version (send it back as `If-Match`).' }) _version!: number;
  @ApiProperty({ description: 'Same value as `_version`; the field the gateway`s ETag interceptor reads.' }) version!: number;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ nullable: true, type: String }) updatedBy!: string | null;
}
