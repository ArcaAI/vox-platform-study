/**
 * URL <-> query-state codec for console data grids.
 *
 * QUERY state (search / sort / page / limit / typed filters) is shareable, so it
 * lives in the URL via nuqs; column personalization (order/size/visibility/pin/
 * density) is server-persisted separately (see `grid-persistence.ts`).
 *
 * This module is framework-light: it exports pure functions plus nuqs parser
 * definitions, so screens/hooks wire them into `useQueryStates` while server
 * loaders and tests call the pure helpers directly.
 *
 * `f` encoding — the typed filters travel in one compact param as a JSON array
 * of POSITIONAL tuples `[id, operator, variant, value]` (short + valid JSON +
 * round-trip stable). `value` keeps its native JSON type (string/number/boolean/
 * array; dates as ISO strings). Decoding is best-effort: malformed JSON or a
 * tuple with an unknown operator/variant is dropped rather than thrown.
 *
 * `toListParams` serializes the state to the console `ListParams`, emitting the
 * gateway BRACKET filter grammar: tokens `field[op]:value`
 * joined by `;` (comma is reserved for AND[]/OR[] groups); lists as
 * `field[in]:a|b`; ranges as `field[gte]:X;field[lte]:Y`.
 */

import { createParser, parseAsInteger, parseAsString } from 'nuqs/server';
import type { DataQueryState, FilterRule, SortRule } from '@arcaai/ui';
import type { ListParams } from '@/shared/api';

// `FilterVariant`/`FilterOperator` are not re-exported from the @arcaai/ui root
// barrel, so derive them from the exported `FilterRule` shape.
type FilterOperator = FilterRule['operator'];
type FilterVariant = FilterRule['variant'];

/** The client filter operators (mirrors `@arcaai/ui` dataTableConfig.operators). */
const FILTER_OPERATORS = [
  'iLike',
  'notILike',
  'eq',
  'ne',
  'inArray',
  'notInArray',
  'isEmpty',
  'isNotEmpty',
  'lt',
  'lte',
  'gt',
  'gte',
  'isBetween',
  'isRelativeToToday',
] as const satisfies readonly FilterOperator[];

/** The client filter variants (mirrors `@arcaai/ui` dataTableConfig.filterVariants). */
const FILTER_VARIANTS = [
  'text',
  'number',
  'range',
  'date',
  'dateRange',
  'boolean',
  'select',
  'multiSelect',
] as const satisfies readonly FilterVariant[];

const KNOWN_OPERATORS = new Set<string>(FILTER_OPERATORS);
const KNOWN_VARIANTS = new Set<string>(FILTER_VARIANTS);

/** Console grid defaults (plan Phase 4: 0-based page, page size 25). */
export const DEFAULT_PAGE = 0;
export const DEFAULT_LIMIT = 25;

// ---------------------------------------------------------------------------
// `f` filter codec — positional-tuple JSON
// ---------------------------------------------------------------------------

export function encodeFilters(rules: FilterRule[]): string {
  const tuples = rules
    .filter((rule): rule is FilterRule => Boolean(rule) && typeof rule.id === 'string' && rule.id.length > 0)
    .map((rule) => [rule.id, rule.operator, rule.variant, rule.value === undefined ? null : rule.value]);
  return JSON.stringify(tuples);
}

export function decodeFilters(raw: string): FilterRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rules: FilterRule[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [id, operator, variant, value] = entry as unknown[];
    if (typeof id !== 'string' || id.length === 0) continue;
    if (typeof operator !== 'string' || !KNOWN_OPERATORS.has(operator)) continue;
    if (typeof variant !== 'string' || !KNOWN_VARIANTS.has(variant)) continue;
    rules.push({ id, operator: operator as FilterOperator, variant: variant as FilterVariant, value });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// sort codec — `field:asc|desc` CSV
// ---------------------------------------------------------------------------

export function serializeSort(rules: SortRule[]): string {
  return rules
    .filter((rule) => rule && typeof rule.id === 'string' && rule.id.length > 0)
    .map((rule) => `${rule.id}:${rule.desc ? 'desc' : 'asc'}`)
    .join(',');
}

export function parseSort(csv: string): SortRule[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [id, direction] = token.split(':');
      return { id: (id ?? '').trim(), desc: (direction ?? '').trim().toLowerCase() === 'desc' };
    })
    .filter((rule) => rule.id.length > 0);
}

// ---------------------------------------------------------------------------
// nuqs parser definitions (URL keys)
// ---------------------------------------------------------------------------

export const searchParser = parseAsString.withDefault('');
export const pageParser = parseAsInteger.withDefault(DEFAULT_PAGE);
export const limitParser = parseAsInteger.withDefault(DEFAULT_LIMIT);

export const sortParser = createParser<SortRule[]>({
  parse: parseSort,
  serialize: serializeSort,
  eq: (a, b) => serializeSort(a) === serializeSort(b),
}).withDefault([]);

/** The compact `f` param carrying the typed filters. */
export const filtersParser = createParser<FilterRule[]>({
  parse: decodeFilters,
  serialize: encodeFilters,
  eq: (a, b) => encodeFilters(a) === encodeFilters(b),
}).withDefault([]);

/** Parser map screens pass to `useQueryStates` — keys are the URL params. */
export const gridQueryParsers = {
  search: searchParser,
  page: pageParser,
  limit: limitParser,
  sort: sortParser,
  f: filtersParser,
};

// ---------------------------------------------------------------------------
// searchParams -> DataQueryState
// ---------------------------------------------------------------------------

type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined>;

function readParam(input: SearchParamsInput, key: string): string | null {
  if (input instanceof URLSearchParams) return input.get(key);
  const value = input[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseSearchParams(input: SearchParamsInput): DataQueryState {
  const searchRaw = readParam(input, 'search');
  const pageRaw = readParam(input, 'page');
  const limitRaw = readParam(input, 'limit');
  const sortRaw = readParam(input, 'sort');
  const filtersRaw = readParam(input, 'f');

  const page = pageRaw !== null ? (pageParser.parse(pageRaw) ?? DEFAULT_PAGE) : DEFAULT_PAGE;
  const limit = limitRaw !== null ? (limitParser.parse(limitRaw) ?? DEFAULT_LIMIT) : DEFAULT_LIMIT;

  return {
    pagination: { mode: 'offset', page, limit },
    sorting: sortRaw ? parseSort(sortRaw) : [],
    filters: filtersRaw ? decodeFilters(filtersRaw) : [],
    globalSearch: searchRaw && searchRaw.length > 0 ? searchRaw : undefined,
  };
}

// ---------------------------------------------------------------------------
// DataQueryState -> console ListParams (gateway bracket-grammar filters)
// ---------------------------------------------------------------------------

function scalarToToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return null;
}

function isBlank(token: string | null): boolean {
  return token === null || token.trim() === '';
}

function scalarToken(id: string, op: string, value: unknown): string[] {
  const token = scalarToToken(value);
  return isBlank(token) ? [] : [`${id}[${op}]:${token}`];
}

function listToken(id: string, op: 'in' | 'notIn', value: unknown): string[] {
  const items = (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .map(scalarToToken)
    .filter((token): token is string => token !== null && token.trim() !== '');
  if (items.length === 0) return [];
  // `|` is the reserved list separator — a literal `|` in a value is not expressible.
  if (items.some((token) => token.includes('|'))) return [];
  return [`${id}[${op}]:${items.join('|')}`];
}

function rangeTokens(id: string, value: unknown): string[] {
  let min: unknown;
  let max: unknown;
  if (Array.isArray(value)) {
    [min, max] = value;
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    min = record.from ?? record.min ?? record.start ?? record.gte;
    max = record.to ?? record.max ?? record.end ?? record.lte;
  } else {
    return [];
  }
  const tokens: string[] = [];
  const minToken = scalarToToken(min);
  if (!isBlank(minToken)) tokens.push(`${id}[gte]:${minToken}`);
  const maxToken = scalarToToken(max);
  if (!isBlank(maxToken)) tokens.push(`${id}[lte]:${maxToken}`);
  return tokens;
}

/**
 * FilterRule -> bracket token(s). The mapping (grammar):
 *   text    iLike -> field[icontains]:v   |  eq -> field[iequals]:v
 *   non-text eq   -> field[equals]:v      (never an i-op on enum/boolean/number/date)
 *   lt/lte/gt/gte -> field[<op>]:v
 *   inArray/notInArray -> field[in|notIn]:a|b   (omit if any value contains `|`)
 *   isBetween     -> field[gte]:X;field[lte]:Y  (omit a blank bound)
 * Operators with no v1 server token (ne, notILike, isEmpty, isNotEmpty,
 * isRelativeToToday) are omitted; blank scalar/list values are omitted.
 */
function filterToTokens(rule: FilterRule): string[] {
  const { id, operator, variant, value } = rule;
  if (!id) return [];
  switch (operator) {
    case 'iLike':
      return variant === 'text' ? scalarToken(id, 'icontains', value) : [];
    case 'eq':
      return scalarToken(id, variant === 'text' ? 'iequals' : 'equals', value);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return scalarToken(id, operator, value);
    case 'inArray':
      return listToken(id, 'in', value);
    case 'notInArray':
      return listToken(id, 'notIn', value);
    case 'isBetween':
      return rangeTokens(id, value);
    default:
      // ne / notILike / isEmpty / isNotEmpty / isRelativeToToday: unsupported by the v1 grammar.
      return [];
  }
}

export interface ToListParamsOptions {
  /** Fields the global search targets → gateway `searchFields` CSV. */
  searchFields?: string[];
}

export function toListParams(state: DataQueryState, opts?: ToListParamsOptions): ListParams {
  const out: ListParams = {};

  if (state.pagination.mode === 'offset') {
    // The grid's page index is 0-based (TanStack), but the gateway list
    // contract is 1-based (`skip = (page - 1) * limit`). Convert at this single
    // seam so the SECOND page (index 1) maps to `skip = limit` instead of skip 0
    // — otherwise every page after the first re-fetches page 1 (defect).
    out.page = state.pagination.page + 1;
    out.limit = state.pagination.limit;
  } else {
    out.limit = state.pagination.limit;
    if (state.pagination.cursor) out.cursor = state.pagination.cursor;
  }

  const search = state.globalSearch?.trim();
  if (search) out.search = search;

  if (opts?.searchFields && opts.searchFields.length > 0) {
    out.searchFields = opts.searchFields.join(',');
  }

  if (state.sorting.length > 0) {
    const sort = serializeSort(state.sorting);
    if (sort) out.sort = sort;
  }

  const tokens = state.filters.flatMap(filterToTokens);
  if (tokens.length > 0) out.filters = tokens.join(';');

  return out;
}
