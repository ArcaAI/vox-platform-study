/**
 * Wire types for the Consumption & Cost screen.
 *
 * Re-declared locally rather than shared (rule 13 — features never import one
 * another). Money is ALWAYS an integer-micros STRING (the WS-I money
 * convention); it never rides a JSON number. Backed by the gateway
 * `admin/usage/*` surface (UsageAnalyticsService).
 */

/** Query params for the tenant-scoped usage reads; period is a UTC month (YYYY-MM). */
export interface UsagePeriodParams {
  period?: string;
  // Index signature so this is accepted as `QueryParams` by the shared client.
  [key: string]: string | number | boolean | undefined | null;
}

export interface UsageSummaryLine {
  capability: string;
  provider: string;
  /**
   * TASK-958 D-7 — WHICH of the tenant's connections funded this line.
   *
   * `null` = the platform's own credential served it; a string = the tenant
   * connection id (`AiUsageEvent.connectionId`). ABSENT is a third answer and
   * not the same as `null`: a gateway that does not carry the field yet cannot
   * say, so the screen renders no column at all rather than a column of dashes.
   * With two accounts of one vendor, `provider` alone can no longer answer
   * "which key did this spend?".
   */
  connectionId?: string | null;
  /** Empty-string sentinel when the capability selects no model. */
  model: string;
  unit: string;
  /** Summed quantity in the unit above. */
  quantity: string;
  /** Summed INTERNAL-basis rated cost, integer micros (excludes BYOK notional). */
  costMicros: string;
}

/**
 * TASK-959 — GPU vs CPU occupancy seconds across the inference capabilities.
 * Fixed-point strings, 6 dp, matching `UsageSummaryLine.quantity`'s convention
 * (a JSON number stops being exact at this scale).
 */
export interface UsageComputeSeconds {
  gpuSeconds: string;
  cpuSeconds: string;
}

/**
 * TASK-959 — bytes that crossed to a THIRD PARTY (deployment CLOUD or BYOK
 * only; self-hosted LAN traffic is excluded). Fixed-point strings, 6 dp.
 */
export interface UsageThirdPartyBytes {
  egressBytes: string;
  ingressBytes: string;
}

/**
 * TASK-959 — what the tenant was HOLDING at the latest nightly snapshot in
 * the period, split by storage class. A LEVEL, not the period's GB-day sum.
 * Fixed-point GB strings, 6 dp.
 */
export interface UsageStorageSnapshot {
  mediaGb: string;
  textGb: string;
  claimCheckGb: string;
  totalGb: string;
  /** When the snapshot was taken (end of the UTC day it measured), ISO-8601. */
  asOf: string;
}

export interface UsageSummaryResponse {
  period: string;
  periodStart: string;
  periodEnd: string;
  lines: UsageSummaryLine[];
  totalCostMicros: string;
  /** Product-visibility BYOK notional spend by capability — never billed (D14). */
  byokNotionalCostMicrosByCapability: Record<string, string>;

  /**
   * TASK-959 — compute, network and storage. Optional in this LOCAL mirror
   * even though the wire DTO declares them always-present: the same
   * ABSENT-vs-`null` convention as `connectionId` above — a gateway that
   * predates this ticket cannot say, and the screen must render nothing
   * rather than a misleading zero for a figure it never measured.
   */
  computeSeconds?: UsageComputeSeconds;
  /** Σ CPU_SECOND under capability WORKFLOW — the durable worker's own CPU, kept apart so it is never double-counted against computeSeconds. */
  workflowCpuSeconds?: string;
  thirdPartyBytes?: UsageThirdPartyBytes;
  /** `null` = no snapshot exists for the period (distinct from a zeroed object); `undefined` = an older gateway that carries no such field at all. */
  storage?: UsageStorageSnapshot | null;
}

/** Query params for `GET admin/usage/timeseries`. */
export interface UsageTimeseriesParams {
  capability: string;
  unit: string;
  granularity: 'day' | 'hour';
  /** Inclusive lower bound, ISO-8601 instant. */
  from: string;
  /** Exclusive upper bound, ISO-8601 instant. */
  to: string;
  tenantId?: string;
  // Index signature so this is accepted as `QueryParams` by the shared client.
  [key: string]: string | number | boolean | undefined | null;
}

/** One bucket of `GET admin/usage/timeseries` (TASK-959 §10.2). */
export interface UsageTimeseriesPoint {
  /** UTC bucket start, ISO-8601. */
  bucketStart: string;
  /** Summed quantity in the requested unit, across every provider/model. */
  quantity: string;
  costMicros: string;
  computeSeconds: UsageComputeSeconds;
  workflowCpuSeconds: string;
  thirdPartyBytes: UsageThirdPartyBytes;
  /** Null when the bucket carries no storage snapshot at all. */
  storageGb: string | null;
}

export interface UsageTimeseriesResponse {
  capability: string;
  unit: string;
  granularity: 'day' | 'hour';
  from: string;
  to: string;
  points: UsageTimeseriesPoint[];
}

export interface CostPerEncounterResponse {
  period: string;
  periodStart: string;
  periodEnd: string;
  /** Number of consultations that carried INTERNAL-basis cost this period. */
  count: number;
  p50Micros: string;
  p90Micros: string;
  p99Micros: string;
  meanMicros: string;
  totalMicros: string;
}

export interface TopTenantUsage {
  tenantId: string;
  costMicros: string;
}

/** Cross-tenant leaderboard (SUPER_ADMIN only) — NOT scoped to the working tenant. */
export interface TopTenantsResponse {
  period: string;
  periodStart: string;
  periodEnd: string;
  metric: 'cost';
  tenants: TopTenantUsage[];
}

/**
 * TASK-958 D-7 — the slice of `AiProviderConnectionResponse` this screen reads,
 * and nothing more: an id to match a usage line on, and the two fields that
 * NAME it. A local BFF mirror (features never import one another), deliberately
 * narrower than the editor's own type — this screen resolves labels, it does
 * not configure connections.
 */
export interface UsageConnection {
  id?: string;
  provider: string;
  slug?: string;
  name?: string | null;
}

/**
 * TASK-958 (wire review #6) — `GET admin/providers/:service/platform-defaults`,
 * narrowed to the same three fields.
 *
 * The OTHER half of the cascade this column describes. A platform-funded
 * generation carries the SYSTEM row's `connectionId` — only a self-hosted engine
 * yields `null` — so without this list every platform-funded line resolved to
 * nothing and rendered 8 characters of a UUID, which reads as "one of your
 * connections, unnamed" for a row the tenant does not own.
 *
 * A row with no `id` is a PLACEHOLDER (`version: 0`): the platform has no row for
 * that provider, so it names nothing and is skipped.
 */
export interface UsagePlatformDefaults {
  connections?: UsageConnection[];
}
