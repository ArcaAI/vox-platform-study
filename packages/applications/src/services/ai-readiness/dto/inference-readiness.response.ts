import { ApiProperty } from '@nestjs/swagger';
import { MODEL_READINESS_STATES } from '../inference-readiness.types';
import type { InferenceReadinessSnapshot, ModelReadiness, ReadinessProviderClass } from '../inference-readiness.types';

/**
 * `GET /api/v1/admin/ai-services/readiness` — the platform's last observation
 * of every inference surface (TASK-890 §3.12, OD-L).
 *
 * Read-only, platform tier. Deliberately carries HOSTS rather than URLs and
 * never a credential, a bucket prefix or a tenant id: this is an operator's
 * view of whether the platform can serve, not a projection of the registry.
 */
export class ReadinessEngineResponse {
  @ApiProperty({ description: 'Engine provider id, canonical spelling.', example: 'lm-studio' })
  provider!: string;

  @ApiProperty({ description: 'How this engine serves models.', example: 'engine-served' })
  providerClass!: ReadinessProviderClass;

  @ApiProperty({ nullable: true, description: 'Host of the resolved endpoint — never the full URL.', example: 'hope-lmstudio:1234' })
  baseUrlHost!: string | null;

  @ApiProperty({
    enum: ['up', 'down', 'unknown'],
    description: '`unknown` means the probe aggregator itself did not answer — nobody looked, which is not the same as the engine being down.',
  })
  status!: 'up' | 'down' | 'unknown';

  @ApiProperty({ nullable: true, description: 'Probe round-trip in milliseconds, as the text service measured it.' })
  latencyMs!: number | null;

  @ApiProperty({ description: 'Models the engine reports as resident.' })
  loadedCount!: number;

  @ApiProperty({ description: 'Models the engine lists at all.' })
  listedCount!: number;

  @ApiProperty({ nullable: true, description: 'Probe error or explanatory note.' })
  detail!: string | null;
}

export class ReadinessServiceResponse {
  @ApiProperty({ description: 'Service key as the heartbeat cron writes it.', example: 'stt' })
  key!: string;

  @ApiProperty({ description: 'Last heartbeat says up AND is recent enough to be evidence.' })
  healthy!: boolean;

  @ApiProperty({ nullable: true, description: 'ISO timestamp of the last heartbeat sample.' })
  lastSeenAt!: string | null;
}

export class ReadinessModelResponse {
  @ApiProperty() id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The registry row’s task type.', example: 'TEXT_GENERATION' }) taskType!: string;

  @ApiProperty({ nullable: true, description: 'Engine or vendor id from the registry row.' })
  provider!: string | null;

  @ApiProperty({ nullable: true, description: 'How this row is served, which is what decides how readiness is derived.' })
  providerClass!: ReadinessProviderClass | null;

  @ApiProperty({ enum: MODEL_READINESS_STATES, description: 'The verdict at `checkedAt`. `unknown` means nothing was measured.' })
  readiness!: ModelReadiness;

  @ApiProperty({ nullable: true, description: 'Why, in an operator’s words.' })
  detail!: string | null;
}

export class InferenceReadinessResponse {
  @ApiProperty({
    nullable: true,
    description:
      'When this observation was taken. `null` together with empty collections means there is no observation yet — a cold process, an ' +
      'expired snapshot, or the sweep switched off — and NOT that everything is down.',
  })
  checkedAt!: string | null;

  @ApiProperty({ type: [ReadinessEngineResponse] })
  engines!: ReadinessEngineResponse[];

  @ApiProperty({ type: [ReadinessServiceResponse] })
  services!: ReadinessServiceResponse[];

  @ApiProperty({ type: [ReadinessModelResponse] })
  models!: ReadinessModelResponse[];
}

/**
 * Snapshot → response. The models map becomes an array (a wire document is a
 * list; the map exists so the catalogue can do O(1) lookups), and an absent
 * snapshot becomes the honest empty document rather than a 404: "nothing has
 * been observed" is a state of the platform, not a missing resource.
 */
export function toInferenceReadinessResponse(snapshot: InferenceReadinessSnapshot | null): InferenceReadinessResponse {
  if (!snapshot) return { checkedAt: null, engines: [], services: [], models: [] };
  return {
    checkedAt: snapshot.checkedAt,
    engines: snapshot.engines,
    services: snapshot.services,
    models: Object.values(snapshot.models),
  };
}
