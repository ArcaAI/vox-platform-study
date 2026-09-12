/** GET /admin/platform/metrics (PlatformMetricsResponse). */
export interface PlatformMetrics {
  requestsPerMinute: number;
  errorRatePct: number;
  p95LatencyMs: number;
  openSockets: number;
  socketsPerMinute: number;
  services: PlatformServiceMetric[];
  models: PlatformModelsSummary;
  requestVolumeSeries: RequestVolumePoint[];
  refreshedAt: string;
}

export interface PlatformServiceMetric {
  key: string;
  p95LatencyMs: number | null;
  requestsPerMinute: number | null;
  errorRatePct: number | null;
}

export interface PlatformModelsSummary {
  running: number;
  perModel: PlatformModelMetric[];
}

export interface PlatformModelMetric {
  id: string;
  service: string;
  running: number | null;
  avgLatencyMs: number | null;
}

export interface RequestVolumePoint {
  t: string;
  requests: number;
  sockets: number;
}

/** GET /admin/platform/sockets. */
export interface OpenSockets {
  open: number;
  perMinute: number;
  total: number;
  refreshedAt: string;
}

/** GET /admin/platform/consumption (optionally per tenant). */
export interface ConsumptionRollup {
  transcriptionMinutes: number;
  summaries24h: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  consultations: { total: number; today: number };
  refreshedAt: string;
}

/**
 * GET /admin/tenants/:id/usage (TenantUsageStatsResponse) — the tenant
 * dashboard's tiles (TASK-954). A tenant admin reads its OWN tenant's row; the
 * platform-wide `admin/platform/*` reads above are `manage:PlatformMetrics`
 * and never reach a tenant.
 */
export interface TenantUsage {
  totalUsers: number;
  totalDepartments: number;
  totalPromptTemplates: number;
  totalPipelines: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  transcriptionMinutes: number;
  summaries24h: number;
  totalConsultations: number;
}
