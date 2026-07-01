/**
 * @arcaai/vox — Platform runtime metrics types (TASK-386).
 *
 * Mirrors the API DTOs returned by `@Controller('admin/platform')`
 * (E1 `/metrics`, E2 `/sockets`, E3 `/consumption`). Prometheus-derived fields
 * degrade to `0`/`[]`/`null` when Prometheus is unreachable; the Postgres-backed
 * consumption roll-up and the Redis-aggregated socket count stay accurate
 * without Prometheus.
 */

/** E1 — per-service HTTP health row (`null` = metric unavailable for that service). */
export interface PlatformServiceMetric {
  key: string;
  p95LatencyMs: number | null;
  requestsPerMinute: number | null;
  errorRatePct: number | null;
}

/** E1 / #19 — per-model running-instances + avg-latency (`null` = not reporting, NOT idle). */
export interface PlatformModelMetric {
  id: string;
  service: string;
  running: number | null;
  avgLatencyMs: number | null;
}

export interface PlatformModelsSummary {
  /** Count of inventory models with ≥1 running instance. */
  running: number;
  perModel: PlatformModelMetric[];
}

/** E1 — a single point on the requests/sockets time-series. */
export interface RequestVolumePoint {
  /** Bucket timestamp (ISO-8601). */
  t: string;
  /** Requests/sec at this point (rate over the step). */
  requests: number;
  /** Open sockets at this point. */
  sockets: number;
}

/** E1 — platform runtime metrics (super-admin). */
export interface PlatformMetrics {
  requestsPerMinute: number;
  errorRatePct: number;
  p95LatencyMs: number;
  /** Open WebSocket sockets, aggregated across instances via Redis (#17). */
  openSockets: number;
  socketsPerMinute: number;
  services: PlatformServiceMetric[];
  models: PlatformModelsSummary;
  requestVolumeSeries: RequestVolumePoint[];
  /** When this payload was computed (ISO-8601). */
  refreshedAt: string;
}

/** E2 / #17 — open-sockets tile (live Redis aggregate + Prometheus churn rate). */
export interface OpenSockets {
  open: number;
  perMinute: number;
  total: number;
  refreshedAt: string;
}

export interface ConsumptionConsultations {
  total: number;
  /** Consultations created since the start of today (UTC). */
  today: number;
}

/**
 * E3 / #18 — consumption / usage roll-up. Platform-wide for a super-admin (no
 * scope) or per-tenant when `tenantId` is supplied. All figures are
 * Postgres-derived; `storageQuotaBytes` is `null` until at least one in-scope
 * bucket sets a quota (#5).
 */
export interface ConsumptionRollup {
  transcriptionMinutes: number;
  summaries24h: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  consultations: ConsumptionConsultations;
  refreshedAt: string;
}
