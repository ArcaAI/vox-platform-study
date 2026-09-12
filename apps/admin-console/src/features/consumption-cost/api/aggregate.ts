import type { UsageSummaryLine } from './types';

/**
 * Pure, React-free rollups for the Consumption & Cost screen.
 * Kept out of the component so they can be unit-tested directly. Micros are
 * summed as BigInt so a busy tenant's total never loses precision.
 */

export interface CapabilityCost {
  capability: string;
  /** Summed INTERNAL-basis cost across the capability's lines, integer micros. */
  costMicros: string;
}

function safeBig(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Sum `costMicros` per capability from the summary lines (the cost-by-capability
 * bar chart's data — derived here, NOT from a second endpoint). Descending by
 * cost; ties broken by capability name for a stable order.
 */
export function aggregateCostByCapability(lines: readonly UsageSummaryLine[]): CapabilityCost[] {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    totals.set(line.capability, (totals.get(line.capability) ?? 0n) + safeBig(line.costMicros));
  }
  return [...totals.entries()]
    .map(([capability, micros]) => ({ capability, costMicros: micros.toString() }))
    .sort((a, b) => {
      const delta = safeBig(b.costMicros) - safeBig(a.costMicros);
      if (delta !== 0n) return delta > 0n ? 1 : -1;
      return a.capability.localeCompare(b.capability);
    });
}

/** Total of a capability→micros map (e.g. BYOK notional), summed as BigInt → string. */
export function sumMicrosMap(map: Record<string, string> | null | undefined): string {
  if (!map) return '0';
  let total = 0n;
  for (const value of Object.values(map)) total += safeBig(value);
  return total.toString();
}

/** TASK-959 — a sensible default (capability, unit) pair for the usage-over-time chart. */
export interface DefaultSeries {
  capability: string;
  unit: string;
}

/**
 * Picks a default series for the usage-over-time chart: the highest-cost
 * capability (reusing `aggregateCostByCapability`'s ordering), and within it
 * the line with the largest quantity — the unit most likely to show
 * something. `null` when there is nothing to chart (no lines at all).
 *
 * Deliberately reads the summary lines rather than a hardcoded capability
 * list: the set of capabilities/units is a backend enum this screen never
 * mirrors (rule 09 — no hardcoded taxonomy), so "pick the one with data" is
 * the only default that cannot drift out of sync with it.
 */
export function pickDefaultSeries(lines: readonly UsageSummaryLine[]): DefaultSeries | null {
  if (lines.length === 0) return null;
  const [top] = aggregateCostByCapability(lines);
  let best: UsageSummaryLine | null = null;
  for (const line of lines) {
    if (line.capability !== top.capability) continue;
    if (!best || Number(line.quantity) > Number(best.quantity)) best = line;
  }
  return best ? { capability: best.capability, unit: best.unit } : null;
}
