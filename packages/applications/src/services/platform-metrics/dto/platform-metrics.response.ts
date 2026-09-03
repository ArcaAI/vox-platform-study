import { ApiProperty } from '@nestjs/swagger';

/**
 * Per-service HTTP health row (sourced from Prometheus via the
 * canonical PromQL in METRIC-CONTRACT.md `null` = the metric is not
 * available for that service (e.g. Prometheus unreachable, or guardrail which
 * exposes no `http_*` series).
 */
export class PlatformServiceMetric {
  @ApiProperty({ description: 'Service key (Prometheus `service`/`job` label).' })
  key!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'p95 request latency in ms (null when unavailable).' })
  p95LatencyMs!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Requests per minute (null when unavailable).' })
  requestsPerMinute!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: '5xx error rate as a percentage (null when unavailable).' })
  errorRatePct!: number | null;
}

/**
 * Per-model running-instances + avg-latency row. `running`
 * / `avgLatencyMs` are `null` (NOT `0`) when the model is absent from the
 * Prometheus scrape, so the UI can distinguish "not reporting" from "idle".
 */
export class PlatformModelMetric {
  @ApiProperty({ description: 'Model id (matches `model` label + FE PLATFORM_MODELS).' })
  id!: string;

  @ApiProperty({ description: 'Owning service (`service` label: stt/text/nlp/guardrail).' })
  service!: string;

  @ApiProperty({ nullable: true, type: Number, description: 'Currently-running instances (null when not reporting).' })
  running!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Average inference latency in ms over 5m (null when not reporting).' })
  avgLatencyMs!: number | null;
}

export class PlatformModelsSummary {
  @ApiProperty({ description: 'Count of inventory models with ≥1 running instance.' })
  running!: number;

  @ApiProperty({ type: [PlatformModelMetric] })
  perModel!: PlatformModelMetric[];
}

export class RequestVolumePoint {
  @ApiProperty({ description: 'Bucket timestamp (ISO-8601).' })
  t!: string;

  @ApiProperty({ description: 'Requests/sec at this point (rate over the step).' })
  requests!: number;

  @ApiProperty({ description: 'Open sockets at this point.' })
  sockets!: number;
}

/**
 * Platform runtime metrics (super-admin). Prometheus-derived
 * fields (requests/error/p95/per-service/per-model/series) degrade to 0/[]/null
 * when Prometheus is unreachable; `openSockets` is sourced live from the
 * Redis-aggregated socket registry (#17) so it is accurate without Prometheus.
 */
export class PlatformMetricsResponse {
  @ApiProperty()
  requestsPerMinute!: number;

  @ApiProperty()
  errorRatePct!: number;

  @ApiProperty()
  p95LatencyMs!: number;

  @ApiProperty({ description: 'Open WebSocket sockets, aggregated across instances via Redis (#17).' })
  openSockets!: number;

  @ApiProperty()
  socketsPerMinute!: number;

  @ApiProperty({ type: [PlatformServiceMetric] })
  services!: PlatformServiceMetric[];

  @ApiProperty({ type: PlatformModelsSummary })
  models!: PlatformModelsSummary;

  @ApiProperty({ type: [RequestVolumePoint] })
  requestVolumeSeries!: RequestVolumePoint[];

  @ApiProperty({ description: 'When this payload was computed (ISO-8601).' })
  refreshedAt!: string;
}
