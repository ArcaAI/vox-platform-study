import { BadRequestException } from '@nestjs/common';
import { DbFilters, DefaultDbFieldType, ICountProps, IFindAllProps } from '@arcaai/domains';
import { PaginatedQuery, DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from './dto';
import { FilterFieldSpec, FilterFieldTypeMap, FilterFieldTypeSource, resolveFilterFieldTypes } from './modelFilterTypes';

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
 * Coerce a stringly-typed CSV filter value to the scalar type of
 * its column (derived from the target model's generated Prisma type). Coercion
 * is conservative: only recognizable tokens are converted, otherwise the
 * original string is returned UNCHANGED so a malformed value is never silently
 * mangled (and never 400s differently than before). A column with no known type
 * (plain String / unknown field / no model) is always left a string.
 *
 * Enum and Json column handling:
 *   - `enum`: a registry entry carries the runtime member
 *     allow-list ({@link FilterFieldSpec} object form), so an invalid member is
 *     rejected HERE with a clear 400 instead of surfacing as a Prisma
 *     server-side error. A valid member passes through unchanged (Prisma
 *     accepts the enum's string value directly). A plain `'enum'` tag (only
 *     possible in an explicit caller-provided map) keeps an
 *     unvalidated pass-through.
 *   - `json`: at the whole-column level the value stays a string (a flat
 *     `field[op]:value` token can't express Prisma's JSON operators safely).
 *     Structured `column.path[op]:value` filtering is handled by the dotted-key
 *     grammar in `deserializeFilterStringWithMap`, not here.
 */
function coerceFilterValue(field: string, value: string, spec: FilterFieldSpec | undefined): boolean | number | Date | string {
  if (typeof spec === 'object') {
    // Member-carrying enum spec (registry-sourced) — validate the member.
    if (!(spec.members as readonly string[]).includes(value)) {
      throw new BadRequestException(`Invalid value '${value}' for enum filter field '${field}'. Allowed values: ${spec.members.join(', ')}.`);
    }
    return value;
  }
  switch (spec) {
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
 * The Prisma JSON path-filter operators the dotted-key grammar
 * accepts (PostgreSQL `JsonFilter`). Anything else on a JSON path is rejected
 * with a 400 — never forwarded for Prisma to blow up on server-side.
 */
const JSON_PATH_FILTER_OPERATORS: ReadonlySet<string> = new Set([
  'equals',
  'not',
  'lt',
  'lte',
  'gt',
  'gte',
  'string_contains',
  'string_starts_with',
  'string_ends_with',
  'array_contains',
  'array_starts_with',
  'array_ends_with',
]);

// The string_* operators only ever compare strings, so their value is NEVER
// JSON-parsed (a numeric-looking token must stay a string for them).
const JSON_STRING_OPERATORS: ReadonlySet<string> = new Set(['string_contains', 'string_starts_with', 'string_ends_with']);

/**
 * List operators: the token value is a '|'-separated list
 * (`field[in]:v1|v2|v3`) deserializing to Prisma's `{ in: [...] }` /
 * `{ notIn: [...] }`, with EACH item coerced/validated per the column spec.
 * NOTE: a literal '|' inside an item is NOT expressible in a list token —
 * the grid serializer must not emit list filters for values containing '|'.
 */
const LIST_FILTER_OPERATORS: ReadonlySet<string> = new Set(['in', 'notIn']);

/**
 * Case-insensitive string operators → the Prisma base operator they
 * deserialize to, alongside `mode: 'insensitive'`. String-column operators
 * only: the value intentionally BYPASSES {@link coerceFilterValue} (Prisma's
 * `mode` is only valid on String columns, where coercion is a no-op anyway —
 * coercing would produce nonsense like `{ equals: Date, mode: 'insensitive' }`
 * on misuse).
 */
const INSENSITIVE_STRING_OPERATORS: ReadonlyMap<string, string> = new Map([
  ['iequals', 'equals'],
  ['icontains', 'contains'],
  ['istartsWith', 'startsWith'],
  ['iendsWith', 'endsWith'],
]);

/**
 * Filter KEYS are attacker-controlled query-string input,
 * so field entries must be created as OWN properties: a plain
 * `filterObject[key] = {}` / truthiness guard with key `'__proto__'` walks the
 * prototype chain and pollutes `Object.prototype` for the whole process (and
 * `'toString'`-like keys silently write onto shared built-ins). For every
 * normal key this is byte-identical to the previous `{}` init + merge.
 */
function ensureOwnFieldObject(target: object, key: string): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    Object.defineProperty(target, key, { value: {}, enumerable: true, writable: true, configurable: true });
  }
  return (target as Record<string, Record<string, unknown>>)[key];
}

/**
 * Coerce a JSON-path filter value: for value operators the token is parsed as a
 * JSON literal when possible (`5` → number, `true` → boolean, `null` → null,
 * `["a"]` → array, `"x"` → string) and kept as the raw string otherwise
 * (`recording` stays `'recording'`); string_* operators always keep the raw
 * string.
 */
function coerceJsonPathValue(op: string, value: string): unknown {
  if (JSON_STRING_OPERATORS.has(op)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Deserialize the `field[op]:value` (`;`-separated) CSV filter contract into a
 * Prisma `where` fragment, coercing each value to its column's scalar type.
 *
 * `fieldTypes` declares HOW to coerce, and may be:
 *   - a model NAME (string) → resolved against the model field-type registry so
 *     every boolean/number/date column of that model coerces automatically (no
 *     per-column opt-in), enum members validate (400 on an invalid member), and
 *     JSON columns accept the dotted-path grammar below;
 *   - a `readonly string[]` → LEGACY boolean allow-list (DEFECT-F1 back-compat);
 *   - an explicit `{ column: spec }` map.
 *
 * JSON-path grammar: when the KEY is dotted and its root
 * segment is a declared `'json'` column (`metaData.a.b[equals]:1`), the token
 * deserializes to Prisma's JSON path filter
 * (`{ metaData: { path: ['a','b'], equals: 1 } }`) with the operator validated
 * against {@link JSON_PATH_FILTER_OPERATORS} and empty path segments rejected
 * (400). Operators on the SAME path merge (`gte` + `lte` range); a SECOND path
 * on the same column in one group is rejected with guidance to use `AND[…]`
 * groups (which recurse with the same rules). A dotted key whose root is NOT a
 * declared JSON column keeps the literal-key legacy behaviour byte-for-byte.
 *
 * When `fieldTypes` is omitted (or an unknown model / unknown field), behaviour
 * is byte-for-byte unchanged — every value stays a string — so existing callers
 * are unaffected. Coercion only ever applies to KNOWN columns of the target
 * model, so a genuine String column whose value is literally `"true"`/`"123"`
 * is never mangled.
 */
export function deserializeFilterString<T = DefaultDbFieldType>(filtersString: string, fieldTypes?: FilterFieldTypeSource): DbFilters {
  return deserializeFilterStringWithMap<T>(filtersString, resolveFilterFieldTypes(fieldTypes));
}

// Inner recursion carries the already-resolved map so a model name is only
// looked up once per top-level call (AND/OR groups reuse the same map).
function deserializeFilterStringWithMap<T = DefaultDbFieldType>(filtersString: string, fieldTypes?: FilterFieldTypeMap): DbFilters {
  const fields = filtersString.split(';');
  const filterObject: DbFilters<T> = {};
  // Case-insensitive ops accumulate per field in a SIDE bucket
  // (folded back in after parsing) so their shared `mode: 'insensitive'` can
  // never leak onto a sibling case-sensitive op on the same field: Prisma's
  // `mode` applies to the WHOLE field filter object, so the two families must
  // not share one object. A Map (not `{}`) so hostile keys like '__proto__'
  // stay plain data.
  const insensitiveBuckets = new Map<string, Record<string, unknown>>();

  fields.forEach((field) => {
    if (field.startsWith('AND[')) {
      const innerFiltersString = field.slice(4, -1);
      filterObject.AND = innerFiltersString.split(',').map((f) => deserializeFilterStringWithMap<T>(f, fieldTypes));
    } else if (field.startsWith('OR[')) {
      const innerFiltersString = field.slice(3, -1);
      filterObject.OR = innerFiltersString.split(',').map((f) => deserializeFilterStringWithMap<T>(f, fieldTypes));
    } else {
      // Hardened token parsing: split on the FIRST '[' and the FIRST
      // ']:' so values containing '[' or ']:' (JSON arrays/objects) survive.
      // For all previously-valid tokens this is byte-identical to the old
      // `split('[')` / `split(']:')` destructuring (which silently dropped the
      // extra pieces).
      const bracketIdx = field.indexOf('[');
      if (bracketIdx === -1) return;
      const key = field.slice(0, bracketIdx);
      const rest = field.slice(bracketIdx + 1);
      const closeIdx = rest.indexOf(']:');
      if (closeIdx === -1) return;
      const op = rest.slice(0, closeIdx);
      const value = rest.slice(closeIdx + 2);

      // Dotted key on a declared JSON column → Prisma JSON
      // path filter. Any other dotted key falls through to the literal-key
      // legacy behaviour below.
      const dotIdx = key.indexOf('.');
      if (dotIdx > 0 && fieldTypes?.[key.slice(0, dotIdx)] === 'json') {
        const rootField = key.slice(0, dotIdx);
        const path = key.slice(dotIdx + 1).split('.');
        if (path.some((segment) => segment.length === 0)) {
          throw new BadRequestException(`Invalid JSON path '${key}': empty path segment.`);
        }
        if (!JSON_PATH_FILTER_OPERATORS.has(op)) {
          throw new BadRequestException(
            `Unsupported JSON path filter operator '${op}' on '${key}'. Allowed operators: ${[...JSON_PATH_FILTER_OPERATORS].join(', ')}.`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = filterObject[rootField as keyof T] as any;
        if (existing && Array.isArray(existing.path) && existing.path.join('.') !== path.join('.')) {
          throw new BadRequestException(
            `Conflicting JSON paths on '${rootField}' ('${existing.path.join('.')}' vs '${path.join('.')}'). Combine different paths with AND[…] groups.`,
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filterObject[rootField as keyof T] = { ...(existing ?? {}), path, [op]: coerceJsonPathValue(op, value) } as any;
        return;
      }

      // List operators (`in` / `notIn`): split the value on '|'
      // and coerce each item with the column spec (enum members validate per
      // item, exactly like a scalar token). Empty items (trailing '|',
      // 'a||b', or an entirely empty value) are REJECTED with a 400 rather
      // than silently filtered: they always indicate a client serializer bug,
      // and dropping them could silently turn the token into `{ in: [] }`
      // (matches nothing).
      if (LIST_FILTER_OPERATORS.has(op)) {
        const items = value.split('|');
        if (items.some((item) => item.length === 0)) {
          throw new BadRequestException(`Invalid value for list filter '${key}[${op}]': items must be non-empty '|'-separated values.`);
        }
        const coercedItems = items.map((item) => coerceFilterValue(key, item, fieldTypes?.[key]));
        ensureOwnFieldObject(filterObject, key)[op] = coercedItems;
        return;
      }

      // Case-insensitive string ops: accumulate on the side bucket
      // (see above); multiple i-ops on one field safely SHARE one object and
      // one `mode`. The raw string value is kept on purpose (see the operator
      // map doc).
      const insensitiveOp = INSENSITIVE_STRING_OPERATORS.get(op);
      if (insensitiveOp) {
        let bucket = insensitiveBuckets.get(key);
        if (!bucket) {
          bucket = { mode: 'insensitive' };
          insensitiveBuckets.set(key, bucket);
        }
        bucket[insensitiveOp] = value;
        return;
      }

      const coercedValue = coerceFilterValue(key, value, fieldTypes?.[key]);
      ensureOwnFieldObject(filterObject, key)[op] = coercedValue;
    }
  });

  // Fold the case-insensitive buckets back in. A field with ONLY
  // i-ops keeps the flat `{ field: { contains, mode } }` shape; a field that
  // ALSO carries case-sensitive ops gets its insensitive bucket appended to
  // the top-level AND (top-level fields are implicitly AND-ed in Prisma), so
  // the bucket's `mode` cannot clobber the sensitive ops. This runs AFTER the
  // token loop, so an explicit `AND[…]` group is appended to — never clobbered.
  for (const [key, bucket] of insensitiveBuckets) {
    if (!Object.prototype.hasOwnProperty.call(filterObject, key)) {
      Object.defineProperty(filterObject, key, { value: bucket, enumerable: true, writable: true, configurable: true });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filterObject.AND = [...(filterObject.AND ?? []), { [key]: bucket } as any];
    }
  }

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

// Re-exported so existing `DEFAULT_PAGE_SIZE`/`DEFAULT_PAGE` imports from this
// module keep working. `PaginatedQuery` (`./dto/paginated.query.ts`) is the
// single source of truth for the values — it also applies them as the DTO's
// own runtime defaults, so the raw `page`/`limit` a client
// omits already equal what is used here.
export { DEFAULT_PAGE, DEFAULT_PAGE_SIZE };
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export function withFormattedPaginatedProps<T>(props: PaginatedQuery, fieldTypes?: FilterFieldTypeSource): IFindAllProps<T> {
  return {
    page: props.page ?? DEFAULT_PAGE,
    limit: props.limit ?? DEFAULT_PAGE_SIZE,
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
