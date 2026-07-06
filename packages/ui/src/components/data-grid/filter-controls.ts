/**
 * Typed filter-control helpers (TASK-423 Δ6). Pure so the boolean 3-state and
 * relative-date presets are unit-testable; the interactive controls live in
 * `data-grid-faceted-filter.tsx`.
 */
import type { FilterRule } from '@/lib/shared';

export type BooleanFilterState = 'any' | 'yes' | 'no';

/** 3-state boolean control → FilterRule (`Any` = filter off). */
export function booleanFilterRule(state: BooleanFilterState, columnId: string): FilterRule | null {
  if (state === 'any') return null;
  return { id: columnId, operator: 'eq', value: state === 'yes' ? 'true' : 'false', variant: 'boolean' };
}

/** Current boolean state from an existing rule (for controlled rendering). */
export function booleanStateFromRule(rule: FilterRule | undefined): BooleanFilterState {
  if (!rule) return 'any';
  return String(rule.value) === 'true' ? 'yes' : 'no';
}

export type RelativeDatePreset = 'today' | 'last7' | 'last30' | 'last90';

export const RELATIVE_DATE_PRESETS: { value: RelativeDatePreset; label: string; days: number }[] = [
  { value: 'today', label: 'Today', days: 0 },
  { value: 'last7', label: 'Last 7 days', days: 7 },
  { value: 'last30', label: 'Last 30 days', days: 30 },
  { value: 'last90', label: 'Last 90 days', days: 90 },
];

/** UTC calendar date (`yyyy-MM-dd`) — deterministic across timezones. */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve a relative preset to a concrete `[startISODate, endISODate]` range
 * (end = today). The grid serializes this to `field[gte]:start;field[lte]:end`.
 */
export function relativePresetToRange(preset: RelativeDatePreset, now: Date = new Date()): [string, string] {
  const days = RELATIVE_DATE_PRESETS.find((p) => p.value === preset)?.days ?? 0;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return [toISODate(start), toISODate(now)];
}
