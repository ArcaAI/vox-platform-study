import { DbFilters, DefaultDbFieldType, ICountProps, IFindAllProps } from '@arcaai/domains';
import { PaginatedQuery } from './dto';
import { FilterFieldType, FilterFieldTypeMap, FilterFieldTypeSource, resolveFilterFieldTypes } from './modelFilterTypes';

export function deserializeSearchFieldString(searchFieldsString: string): string[] {
  return searchFieldsString.split(',').map((field) => field.trim());
}

// A numeric filter token: optional sign + integer or simple decimal. Anything
// else (blank, "1,000", "abc", "1e9") is NOT coerced and stays a string.
const NUMERIC_FILTER_VALUE = /^[-+]?\d+(\.\d+)?$/;
// An ISO-8601 date / datetime token (date, optional time, optional zone). The
// strict shape avoids surprises like `new Date('123')` parsing to year 123.
const ISO_DATE_FILTER_VALUE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * TASK-375 §8 — coerce a stringly-typed CSV filter value to the scalar type of
 * its column (derived from the target model's generated Prisma type). Coercion
 * is conservative: only recognizable tokens are converted, otherwise the
 * original string is returned UNCHANGED so a malformed value is never silently
 * mangled (and never 400s differently than before). A column with no known type
 * (plain String / unknown field / no model) is always left a string.
 *
 * Enum and Json columns are RECOGNIZED but intentionally pass through as the
 * original string (TASK-375 §8 follow-up):
 *   - `enum`: Prisma accepts an enum's string value directly, so the valid
 *     member string is forwarded as-is. An invalid member is NOT mangled — it
 *     passes through and Prisma validates/rejects it server-side, exactly as
 *     before. (No runtime member allow-list is kept here to stay decoupled from
 *     the generated enum objects; validation is deferred to Prisma.)
 *   - `json`: JSON filtering requires Prisma path operators (`path`,
 *     `string_contains`, …) that the flat `field[op]:value` CSV grammar cannot
 *     express, so the value is left a string rather than silently mis-coerced.
 *     Structured JSON-path filtering is a deferred follow-up.
 *
 * Supersedes DEFECT-F1's boolean-only `coerceBooleanFilterValue`.
 */
function coerceFilterValue(value: string, type: FilterFieldType | undefined): boolean | number | Date | string {
  switch (type) {
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'number':
      return NUMERIC_FILTER_VALUE.test(value) ? Number(value) : value;
    case 'date':
      if (!ISO_DATE_FILTER_VALUE.test(value) || Number.isNaN(Date.parse(value))) return value;
      return new Date(value);
    case 'enum':
    case 'json':
      // Conservative, SAFE pass-through (see the function doc above).
      return value;
    default:
      return value;
  }
}

/**
 * Deserialize the `field[op]:value` (`;`-separated) CSV filter contract into a
 * Prisma `where` fragment, coercing each value to its column's scalar type
 * (TASK-375 §8).
 *
 * `fieldTypes` declares HOW to coerce, and may be:
 *   - a model NAME (string) → resolved against the model field-type registry so
 *     every boolean/number/date column of that model coerces automatically (no
 *     per-column opt-in);
 *   - a `readonly string[]` → LEGACY boolean allow-list (DEFECT-F1 back-compat);
 *   - an explicit `{ column: type }` map.
 *
 * When omitted (or an unknown model / unknown field), behaviour is byte-for-byte
 * unchanged — every value stays a string — so existing callers are unaffected.
 * Coercion only ever applies to KNOWN columns of the target model, so a genuine
 * String column whose value is literally `"true"`/`"123"` is never mangled.
 */
export function deserializeFilterString<T = DefaultDbFieldType>(filtersString: string, fieldTypes?: FilterFieldTypeSource): DbFilters {
  return deserializeFilterStringWithMap<T>(filtersString, resolveFilterFieldTypes(fieldTypes));
}

// Inner recursion carries the already-resolved map so a model name is only
// looked up once per top-level call (AND/OR groups reuse the same map).
function deserializeFilterStringWithMap<T = DefaultDbFieldType>(filtersString: string, fieldTypes?: FilterFieldTypeMap): DbFilters {
  const fields = filtersString.split(';');
  const filterObject: DbFilters<T> = {};

  fields.forEach((field) => {
    if (field.startsWith('AND[')) {
      const innerFiltersString = field.slice(4, -1);
      filterObject.AND = innerFiltersString.split(',').map((f) => deserializeFilterStringWithMap<T>(f, fieldTypes));
    } else if (field.startsWith('OR[')) {
      const innerFiltersString = field.slice(3, -1);
      filterObject.OR = innerFiltersString.split(',').map((f) => deserializeFilterStringWithMap<T>(f, fieldTypes));
    } else {
      const [key, opAndValue] = field.split('[');
      if (opAndValue) {
        const [op, value] = opAndValue.split(']:');
        const opKey = op as keyof DbFilters<T>[keyof T];
        if (!filterObject[key as keyof T]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filterObject[key as keyof T] = {} as any;
        }
        const coercedValue = coerceFilterValue(value, fieldTypes?.[key]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (filterObject[key as keyof T] as any)[opKey] = coercedValue;
      }
    }
  });

  return filterObject;
}

export function deserializeSortString(sortString: string): { [key: string]: 'asc' | 'desc' }[] {
  const fields = sortString.split(',');
  const sortObjects: { [key: string]: 'asc' | 'desc' }[] = [];
  fields.forEach((field) => {
    const [key, value] = field.split(':').map((part) => part.trim());
    sortObjects.push({ [key]: value as 'asc' | 'desc' });
  });
  return sortObjects;
}

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export function withFormattedPaginatedProps<T>(props: PaginatedQuery, fieldTypes?: FilterFieldTypeSource): IFindAllProps<T> {
  return {
    page: props.page || 0,
    limit: props.limit || DEFAULT_PAGE_SIZE,
    search: props.search,
    searchFields: props.searchFields ? deserializeSearchFieldString(props.searchFields) : undefined,
    filters: props.filters ? deserializeFilterString(props.filters, fieldTypes) : undefined,
    sort: props.sort ? deserializeSortString(props.sort) : undefined,
  };
}

export function withFormattedCountProps(props: PaginatedQuery, fieldTypes?: FilterFieldTypeSource): ICountProps {
  return {
    search: props.search,
    searchFields: props.searchFields ? deserializeSearchFieldString(props.searchFields) : undefined,
    filters: props.filters ? deserializeFilterString(props.filters, fieldTypes) : undefined,
  };
}
