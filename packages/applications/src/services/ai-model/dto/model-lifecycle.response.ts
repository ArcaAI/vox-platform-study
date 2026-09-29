import { ApiProperty } from '@nestjs/swagger';
import { MODEL_LIFECYCLE_STATUSES, type ModelLifecycleStatus, type ModelServiceState } from '../lifecycle/model-lifecycle.types';

const SERVICE_STATES: ModelServiceState[] = ['loaded', 'loading', 'unloading', 'not_loaded', 'failed'];

export class ModelServiceErrorResponse {
  @ApiProperty({ description: 'Stable failure code the service reported (for example `CUDA_OOM`).', example: 'CUDA_OOM' })
  code: string;

  @ApiProperty({ description: 'Human-readable failure message.' })
  message: string;

  @ApiProperty({ description: 'When the failure was recorded (ISO 8601).', nullable: true, type: String })
  at: string | null;
}

export class ModelServiceStatusResponse {
  @ApiProperty({ description: 'The workload reporting this model: `stt`, `stt-worker`, `nlp` or `lm-studio`.', example: 'nlp' })
  service: string;

  @ApiProperty({ description: 'What the service holds right now.', enum: SERVICE_STATES })
  state: ModelServiceState;

  @ApiProperty({ description: 'Where it is resident: `gpu<N>`, `multi`, or `cpu:<service>`; null when not loaded.', nullable: true, type: String })
  device: string | null;

  @ApiProperty({ description: 'Bytes the loaded model holds; null when not loaded or not measured.', nullable: true, type: Number })
  bytes: number | null;

  @ApiProperty({ description: 'Requests in flight on this model right now.', nullable: true, type: Number })
  inFlight: number | null;

  @ApiProperty({ description: 'Requests per minute over the recent window.', nullable: true, type: Number })
  requestsPerMin: number | null;

  @ApiProperty({ description: 'The last load failure, while the state is `failed`.', nullable: true, type: ModelServiceErrorResponse })
  error: ModelServiceErrorResponse | null;
}

export class ModelLifecycleDownloadResponse {
  @ApiProperty({ description: 'Bytes transferred so far by the current or last download.', nullable: true, type: Number })
  bytesDone: number | null;

  @ApiProperty({ description: 'Total bytes the download will transfer, when known.', nullable: true, type: Number })
  bytesTotal: number | null;

  @ApiProperty({
    description: 'Why the last download failed; `STALLED` when the worker stopped reporting progress.',
    nullable: true,
    type: String,
  })
  error: string | null;
}

export class ModelLifecycleUnregisterResponse {
  @ApiProperty({
    description: 'What happens to the weights: `deleting`, `deleted`, `kept-shared` (another model uses the same files) or `kept`.',
    example: 'deleting',
  })
  weights: string;

  @ApiProperty({ description: 'Why the unregister failed, if it did.', nullable: true, type: String })
  error: string | null;
}

export class ModelLifecycleResponse {
  @ApiProperty({
    description:
      'One status per model. In order of precedence: UNREGISTERING, DOWNLOADING, DOWNLOAD_FAILED, NOT_APPLICABLE (cloud), ' +
      'NOT_DOWNLOADED, LOAD_FAILED, LOADING, SERVING, DOWNLOADED (idle), NOT_OBSERVED (served by a workload whose loaded ' +
      'models are not reported).',
    enum: MODEL_LIFECYCLE_STATUSES,
  })
  status: ModelLifecycleStatus;

  @ApiProperty({ description: 'Per-service evidence behind the status.', type: [ModelServiceStatusResponse] })
  services: ModelServiceStatusResponse[];

  @ApiProperty({
    description: 'Progress of the current or last download; null when the model was never downloaded here.',
    nullable: true,
    type: ModelLifecycleDownloadResponse,
  })
  download: ModelLifecycleDownloadResponse | null;

  @ApiProperty({ description: 'The unregister in progress (or failed); null otherwise.', nullable: true, type: ModelLifecycleUnregisterResponse })
  unregister: ModelLifecycleUnregisterResponse | null;

  @ApiProperty({
    description: 'When the per-service view was observed (ISO 8601); null when it could not be read and the status rests on the registry alone.',
    nullable: true,
    type: String,
  })
  observedAt: string | null;
}
