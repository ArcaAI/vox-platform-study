/**
 * Cross-component query-state contract (TASK-372 §3.1.4, TASK-423 Phase 3).
 *
 * `DataQueryState` is the shared sort/filter/search/pagination model the grid
 * (and timeline) speak. `toPaginatedQuery` serializes it to the backend
 * `PaginatedQuery` params, emitting the **bracket filter grammar** the gateway
 * parser requires (TASK-423 Phase 2): `field[op]:value` tokens separated by
 * `;` (comma is reserved for `AND[…]`/`OR[…]` group internals). `sort` stays a
 * comma-joined `field:asc|desc` list.
 */

import type { FilterOperator, FilterVariant } from '../../types/data-table';
import type { PageRequest } from './pagination';

export interface SortRule {
  id: string;
  desc: boolean;
}

export interface FilterRule<T = unknown> {
  id: string;
  operator: FilterOperator;
  value: T;
  variant: FilterVariant;
}

export interface DataQueryState {
  pagination: PageRequest;
  sorting: SortRule[];
  filters: FilterRule[];
  globalSearch?: string;
}

export const DEFAULT_QUERY_STATE: DataQueryState = {
  pagination: { mode: 'offset', page: 0, limit: 20 },
  sorting: [],
  filters: [],
};

function isNonBlank(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** Trim strings; stringify everything else. Never escapes `;`/`[`/`]:` (the
 *  gateway grammar has no escape rule) — admin filter values don't contain them. */
function encodeValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value);
}

/**
 * Variant-independent scalar operator → gateway token map (documentation +
 * reuse for the console serializer). Text `eq` is the case-INsensitive
 * `iequals` (resolved in {@link scalarToken}); this map is the enum/number/
 * boolean/date form (`equals`). Comparison ops pass through 1:1.
 */
export const FILTER_OPERATOR_TOKENS: Partial<Record<FilterOperator, string>> = {
  eq: 'equals',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
};

function scalarToken(operator: FilterOperator, variant: FilterVariant): string | null {
  switch (operator) {
    // Case-insensitive string ops are String-column ONLY (Prisma `mode`); never
    // emit them on enum/number/boolean/date columns.
    case 'iLike':
      return variant === 'text' ? 'icontains' : null;
    case 'eq':
      return variant === 'text' ? 'iequals' : 'equals';
    case 'gt':
      return 'gt';
    case 'gte':
      return 'gte';
    case 'lt':
      return 'lt';
    case 'lte':
      return 'lte';
    // `ne` / `notILike` / `isEmpty` / `isNotEmpty` are not expressible in the
    // server-mode v1 grammar — omit them (client-only / deferred).
    default:
      return null;
  }
}

/**
 * Serialize a single {@link FilterRule} to zero, one, or two bracket-grammar
 * tokens:
 *   - range (`isBetween` / `isRelativeToToday`, value `[lo, hi]`) → up to two
 *     tokens `field[gte]:lo` + `field[lte]:hi` (each blank bound omitted);
 *   - lists (`inArray` / `notInArray`) → one pipe-joined `field[in]:a|b|c`
 *     token, dropping empty items and any item containing a literal `|`
 *     (unrepresentable), omitting the token if nothing remains;
 *   - scalars → one `field[op]:value` token, omitted when the value is
 *     blank or the operator has no server-mode representation.
 */
export function filterRuleToTokens(f: FilterRule): string[] {
  const { id, operator, variant, value } = f;

  if (operator === 'isBetween' || operator === 'isRelativeToToday') {
    const [lo, hi] = Array.isArray(value) ? (value as unknown[]) : [undefined, undefined];
    const tokens: string[] = [];
    if (isNonBlank(lo)) tokens.push(`${id}[gte]:${encodeValue(lo)}`);
    if (isNonBlank(hi)) tokens.push(`${id}[lte]:${encodeValue(hi)}`);
    return tokens;
  }

  if (operator === 'inArray' || operator === 'notInArray') {
    const token = operator === 'inArray' ? 'in' : 'notIn';
    const items = (Array.isArray(value) ? (value as unknown[]) : [value]).map((v) => encodeValue(v)).filter((v) => v !== '' && !v.includes('|'));
    if (items.length === 0) return [];
    return [`${id}[${token}]:${items.join('|')}`];
  }

  if (!isNonBlank(value)) return [];
  const op = scalarToken(operator, variant);
  if (!op) return [];
  return [`${id}[${op}]:${encodeValue(value)}`];
}

/**
 * Serialize `DataQueryState` → backend `PaginatedQuery` query params. `filters`
 * uses the bracket grammar (`field[op]:value;…`); `sort` is a comma-joined
 * `field:asc|desc` list.
 */
export function toPaginatedQuery(s: DataQueryState): Record<string, string> {
  const out: Record<string, string> = {};

  if (s.pagination.mode === 'offset') {
    out.page = String(s.pagination.page);
    out.limit = String(s.pagination.limit);
  } else {
    if (s.pagination.cursor) out.cursor = s.pagination.cursor;
    out.limit = String(s.pagination.limit);
  }

  if (s.globalSearch) out.search = s.globalSearch;

  if (s.sorting.length > 0) {
    out.sort = s.sorting.map((r) => `${r.id}:${r.desc ? 'desc' : 'asc'}`).join(',');
  }

  const tokens = s.filters.flatMap(filterRuleToTokens);
  if (tokens.length > 0) out.filters = tokens.join(';');

  return out;
}
