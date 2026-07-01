import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-386 E2 / #17 — thin open-sockets tile source for the 380/383 dashboards.
 * `open` is the live Redis-aggregated count across API instances; `perMinute`
 * is the Prometheus-derived churn rate (0 when Prometheus is unreachable).
 */
export class OpenSocketsResponse {
  @ApiProperty({ description: 'Currently-open sockets, aggregated across instances.' })
  open!: number;

  @ApiProperty({ description: 'Socket churn per minute (Prometheus rate; 0 when unavailable).' })
  perMinute!: number;

  @ApiProperty({ description: 'Total sockets across the platform (currently mirrors `open`).' })
  total!: number;

  @ApiProperty({ description: 'When this payload was computed (ISO-8601).' })
  refreshedAt!: string;
}
