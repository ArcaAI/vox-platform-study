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

export interface UsageSummaryResponse {
  period: string;
  periodStart: string;
  periodEnd: string;
  lines: UsageSummaryLine[];
  totalCostMicros: string;
  /** Product-visibility BYOK notional spend by capability — never billed (D14). */
  byokNotionalCostMicrosByCapability: Record<string, string>;
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
