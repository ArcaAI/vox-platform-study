import { ApiProperty } from '@nestjs/swagger';
import { ServiceReleaseResponse } from './service-release.response';

export type InstanceLiveness = 'live' | 'stale';

export class CurrentServiceResponse {
  @ApiProperty({ example: 'smr' })
  serviceName!: string;

  @ApiProperty({ enum: ['dev', 'staging', 'prod'] })
  environment!: string;

  @ApiProperty({ type: ServiceReleaseResponse })
  release!: ServiceReleaseResponse;

  @ApiProperty({ description: 'Number of LIVE instances of this service in this environment' })
  instanceCount!: number;

  @ApiProperty({ enum: ['live', 'stale'] })
  liveness!: InstanceLiveness;

  @ApiProperty({ description: 'ISO-8601 — when the newest instance started' })
  startedAt!: string;

  @ApiProperty({ description: 'ISO-8601 — newest heartbeat' })
  lastSeenAt!: string;
}
