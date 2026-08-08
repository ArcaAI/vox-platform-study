import type { UsageSummaryLine } from './types';

/**
 * Pure, React-free rollups for the Consumption & Cost screen (TASK-615 #15a).
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
