/**
 * Pure drift-comparison math for the shadow-metering report.
 *
 * Deliberately dependency-free (no Prisma, no Decimal) — the report job feeds
 * plain numbers already summed by its own queries. Keeping this pure means
 * the threshold behaviour (research-findings.md: "shadow-meter one full
 * billing cycle before enforcing anything … alert on drift > 2%") is testable
 * without a database.
 *
 * Sign convention: `drift = (actual - expected) / expected`, so a POSITIVE
 * drift means `actual` (the comparison surface — SummaryMeta, TenantUsageMeter,
 * a provider control total) is HIGHER than the ledger; NEGATIVE means the
 * ledger over-counts relative to the surface being reconciled against.
 */

/** research-findings.md — alert threshold, expressed as a fraction (0.02 = 2%). */
export const DRIFT_ALERT_THRESHOLD = 0.02;

export interface DriftComparison {
  /** Human-readable label for the pair being compared (e.g. "ledger-vs-summaryMeta:LLM_TOKENS"). */
  label: string;
  /** The ledger total (AiUsageEvent sums) — the system of record. */
  expected: number;
  /** The comparison surface's total (SummaryMeta / TenantUsageMeter / provider control total). */
  actual: number;
}

export interface DriftResult extends DriftComparison {
  /** `actual - expected`. */
  absoluteDiff: number;
  /**
   * `(actual - expected) / expected`, signed. `null` when `expected` is 0 and
   * `actual` is also 0 (no drift, ratio undefined-but-moot) — see
   * {@link computeDrift} for the 0/0 vs N/0 distinction.
   */
  relativeDrift: number | null;
  /** `|relativeDrift| > threshold`. Always `false` when `relativeDrift` is `null`. */
  breachesThreshold: boolean;
}

/**
 * Computes signed relative drift for one (expected, actual) pair.
 *
 * Zero-handling (both branches matter for a metering job that WILL see
 * genuinely empty tenants/periods):
 *   - `expected === 0 && actual === 0` → no activity on either side; drift is
 *     reported as `0`, not a breach. Dividing 0/0 would otherwise yield `NaN`,
 *     which is not a valid "no breach" signal downstream.
 *   - `expected === 0 && actual !== 0` → the ledger recorded nothing but the
 *     comparison surface did (or vice versa via a negative-expected caller,
 *     which never happens for a SUM). This is a real, unbounded drift — report
 *     `null` (undefined ratio) but STILL breach, since any non-zero delta
 *     against a zero base is definitionally over threshold.
 */
export function computeDrift(comparison: DriftComparison): DriftResult {
  const { expected, actual } = comparison;
  const absoluteDiff = actual - expected;

  if (expected === 0) {
    const breachesThreshold = actual !== 0;
    return { ...comparison, absoluteDiff, relativeDrift: breachesThreshold ? null : 0, breachesThreshold };
  }

  const relativeDrift = absoluteDiff / expected;
  return {
    ...comparison,
    absoluteDiff,
    relativeDrift,
    breachesThreshold: Math.abs(relativeDrift) > DRIFT_ALERT_THRESHOLD,
  };
}

/** Maps {@link computeDrift} over a batch and partitions into clean vs breaching. */
export function computeDriftReport(comparisons: DriftComparison[]): { results: DriftResult[]; breaches: DriftResult[] } {
  const results = comparisons.map(computeDrift);
  return { results, breaches: results.filter((r) => r.breachesThreshold) };
}
