/**
 * Typed filter-control helpers. Pure so the boolean 3-state and
 * relative-date presets are unit-testable; the interactive controls live in
 * `data-grid-faceted-filter.tsx`.
 */
import type { Row } from '@tanstack/react-table';
import type { FilterRule } from '@/lib/shared';

export type BooleanFilterState = 'any' | 'yes' | 'no';

/**
 * Array-aware equality filter for faceted `multiSelect` columns on CLIENT-SIDE
 * grids (server grids serialize `inArray` to the gateway and never run this).
 * Keeps a row when its scalar cell value is one of the selected values; an
 * empty/absent selection means "no filter". The built-in `equalsString`/
 * `includesString` fns compare the cell against the whole array coerced to one
 * string, so they never match a multi-value selection — use this instead.
 */
export function includesSomeFilter<TData>(row: Row<TData>, columnId: string, filterValue: unknown): boolean {
  if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
  return filterValue.map(String).includes(String(row.getValue(columnId)));
}

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
