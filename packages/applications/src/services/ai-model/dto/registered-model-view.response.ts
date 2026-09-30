import { ApiProperty } from '@nestjs/swagger';
import { MODEL_LIFECYCLE_STATUSES, type ModelLifecycleStatus } from '../lifecycle/model-lifecycle.types';

/**
 * One registered model as ANY admin may see it — the read-only registry view.
 *
 * Descriptive columns and a one-word status, nothing else: no per-service
 * residency detail, no usage referrers, no bucket prefix / object / local path /
 * checksum / manifest digest, no download or unregister errors, no `_metadata`.
 * The full row (`ModelResponse`) stays platform-admin only.
 */
export class RegisteredModelViewResponse {
  @ApiProperty({ description: 'Model id.' })
  id!: string;

  @ApiProperty({ description: 'URL-friendly unique identifier.' })
  slug!: string;

  @ApiProperty({ description: 'Display name.' })
  name!: string;

  @ApiProperty({ description: 'What the model is for, when the registry records it.', nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ description: 'Model task type (e.g. `AUTOMATIC_SPEECH_RECOGNITION`).' })
  taskType!: string;

  @ApiProperty({ description: 'Runtime library that loads the weights (e.g. `transformers`, `whisper.cpp`).' })
  libraryName!: string;

  @ApiProperty({ description: 'Weight format (e.g. `SAFETENSOR`, `GGUF`).' })
  format!: string;

  @ApiProperty({ description: 'The platform service that serves the model (e.g. `stt`, `nlp`).' })
  servedBy!: string;

  @ApiProperty({ description: 'Where the model runs: `SELF_HOSTED` on the platform or a `CLOUD` provider.' })
  deploymentKind!: string;

  @ApiProperty({ description: 'License identifier, when known.', nullable: true, type: String })
  license!: string | null;

  @ApiProperty({ description: 'Whether the source repository is gated (click-through), when known.', nullable: true, type: Boolean })
  gated!: boolean | null;

  @ApiProperty({ description: 'Languages the model supports.', type: [String] })
  languages!: string[];

  @ApiProperty({ description: 'Memory footprint in MB — measured when the platform has observed it, otherwise the estimate.', nullable: true, type: Number })
  memorySizeMb!: number | null;

  @ApiProperty({ description: 'One-word lifecycle status (e.g. `SERVING`, `DOWNLOADED`, `NOT_DOWNLOADED`).', enum: MODEL_LIFECYCLE_STATUSES })
  lifecycleStatus!: ModelLifecycleStatus;

  @ApiProperty({ description: 'Whether the weights are present in platform storage (`AVAILABLE`, `MISSING`, …).' })
  availability!: string;

  @ApiProperty({ description: 'Tasks this model is the platform default for.', type: [String] })
  isPlatformDefaultFor!: string[];

  @ApiProperty({ description: 'Row status (`ENABLED` / `DISABLED`).' })
  resourceStatus!: string;

  @ApiProperty({ description: 'Last update, ISO 8601.' })
  updatedAt!: string;
}

/** `GET admin/ai-models/registry` — the same envelope `GET admin/ai-models/list` returns. */
export class PaginatedRegisteredModelViewResponse {
  @ApiProperty({ type: [RegisteredModelViewResponse] })
  data!: RegisteredModelViewResponse[];

  @ApiProperty({ description: 'Total number of records' })
  total!: number;

  @ApiProperty({ description: 'Current page number' })
  page!: number;

  @ApiProperty({ description: 'Number of records per page' })
  limit!: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages!: number;
}
