// Type-only import — erased at runtime, so this adds NO runtime coupling to
// `@arcaai/database` (it is already a declared dependency, and the ESLint guard
// only restricts the unscoped client *symbol*, not type imports). These are the
// generated Prisma model types and are the metadata source for filter coercion.
import type { AuditLog, User } from '@arcaai/database';

/**
 * TASK-375 §8 — model-aware filter-value coercion.
 *
 * The `field[op]:value` CSV `filters` contract is stringly-typed, so a Bool /
 * Int / DateTime column arrives as a string and Prisma rejects it. The previous
 * fix (DEFECT-F1) coerced ONLY booleans, and only for fields a resource opted
 * into by name. This generalises that to a model-aware scheme driven by the
 * generated Prisma model types: a resource passes its model NAME and every
 * boolean / number / date column of that model coerces automatically — no
 * per-column opt-in.
 *
 * Why the generated *types* and not DMMF: Prisma 7's `prisma-client` generator
 * does NOT expose a runtime `Prisma.dmmf` (`Prisma.dmmf === undefined`), so the
 * column types are read from the generated model types instead — at COMPILE time
 * via the `satisfies` guards below.
 */
export type FilterFieldType = 'boolean' | 'number' | 'date' | 'enum' | 'json';

/** A resolved map of column name → the scalar type its filter value coerces to. */
export type FilterFieldTypeMap = Readonly<Record<string, FilterFieldType>>;

/**
 * Map a generated model field's TS value type to the filter scalar type it
 * coerces to, or `never` for columns that must stay plain strings (String,
 * Bytes, scalar arrays, relations). Tuple-wrapped (`[NonNullable<V>] extends
 * […]`) to defeat union distribution so `boolean` (`true | false`) and enum
 * unions classify as a whole.
 *
 * TASK-375 §8 follow-up — enum and Json columns are now FIRST-CLASS:
 *   - A Prisma **enum** column is generated as a string-LITERAL union
 *     (`'CREATE' | 'READ' | …`). It is a subtype of `string`, but `string` is
 *     NOT assignable back to it — so `string extends NonNullable<V>` is `false`
 *     for an enum and `true` for a plain `string`. That's the discriminator.
 *   - A Prisma **Json** column is generated as `JsonValue`
 *     (`string | number | boolean | JsonObject | JsonArray | null`): a union
 *     that CONTAINS `string` (so `string extends NonNullable<V>` is `true`) but
 *     is NOT itself assignable to `string` (so the `[…] extends [string]` arm is
 *     skipped). That uniquely identifies Json among the remaining types (Bytes,
 *     arrays and relations all fail `string extends …`).
 */
type CoercibleFilterType<V> = [NonNullable<V>] extends [Date]
  ? 'date'
  : [NonNullable<V>] extends [boolean]
    ? 'boolean'
    : [NonNullable<V>] extends [number]
      ? 'number'
      : [NonNullable<V>] extends [string]
        ? string extends NonNullable<V>
          ? never // a plain String column — stays a string (no coercion)
          : 'enum' // a string-literal union (Prisma enum)
        : string extends NonNullable<V>
          ? 'json' // JsonValue: a union containing string but not assignable to string
          : never; // Bytes, scalar arrays, relations — stay strings

/**
 * The REQUIRED map of every coercible scalar column of a Prisma model → its
 * filter type, derived from the generated model type. Used with `satisfies` so
 * the compiler:
 *   - rejects a column that does not exist on the model (typo / renamed),
 *   - rejects a plain String / Bytes / array / relation column (excess-property
 *     error — those have no `FilterFieldType`),
 *   - rejects a mislabelled type (e.g. a Bool column tagged `'number'`, or an
 *     enum column tagged `'json'`),
 *   - and forces EVERY boolean/number/date/enum/json column to be listed
 *     (completeness).
 * A schema change to any covered model therefore fails the build until the
 * registry is updated — the drift guard that the old hand-list lacked.
 */
export type ModelFilterFieldTypes<TModel> = {
  [K in keyof TModel as CoercibleFilterType<TModel[K]> extends never ? never : K]: CoercibleFilterType<TModel[K]>;
};

/**
 * User columns exposed to the admin Users grid filter (TASK-375 item 3).
 * `resourceStatus` (enum) and `metaData` (Json) are listed so the completeness
 * guard holds; their values pass through as strings (see `coerceFilterValue`).
 */
export const USER_FILTER_FIELD_TYPES = {
  version: 'number',
  isServiceAccount: 'boolean',
  lastLoginAt: 'date',
  lastActiveAt: 'date',
  secret1Expiry: 'date',
  secret2Expiry: 'date',
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  resourceStatus: 'enum',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<User>;

/**
 * AuditLog columns exposed to the admin audit-log grid filter (TASK-328 A8).
 * The enum (`resourceType`/`action`/`resourceStatus`) and Json
 * (`metaData`/`data`/`previousData`/`metadata`) columns are listed for the
 * completeness guard; enum values pass through (Prisma validates them) and Json
 * values pass through as strings (path-operator filtering is not supported by
 * the CSV contract — see `coerceFilterValue`).
 */
export const AUDIT_LOG_FILTER_FIELD_TYPES = {
  version: 'number',
  success: 'boolean',
  dekKeyVersion: 'number',
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  resourceType: 'enum',
  action: 'enum',
  resourceStatus: 'enum',
  metaData: 'json',
  data: 'json',
  previousData: 'json',
  metadata: 'json',
} satisfies ModelFilterFieldTypes<AuditLog>;

/**
 * Registry of model NAME → its coercible-column map. Keys are the Prisma model
 * names (PascalCase). A resource opts in by passing its model name to
 * `withFormatted{Paginated,Count}Props`; an unknown name resolves to `undefined`
 * (no coercion) so a typo can never silently mangle filters.
 */
export const MODEL_FILTER_FIELD_TYPES: Readonly<Record<string, FilterFieldTypeMap>> = {
  User: USER_FILTER_FIELD_TYPES,
  AuditLog: AUDIT_LOG_FILTER_FIELD_TYPES,
};

/**
 * How a caller declares the filter field types:
 *   - `string` — a model name resolved against {@link MODEL_FILTER_FIELD_TYPES}.
 *   - `readonly string[]` — LEGACY boolean allow-list (DEFECT-F1 back-compat);
 *     each named field is treated as boolean.
 *   - {@link FilterFieldTypeMap} — an explicit column → type map.
 */
export type FilterFieldTypeSource = string | readonly string[] | FilterFieldTypeMap;

/** Resolve any {@link FilterFieldTypeSource} to a concrete field-type map. */
export function resolveFilterFieldTypes(source?: FilterFieldTypeSource): FilterFieldTypeMap | undefined {
  if (!source) return undefined;
  if (typeof source === 'string') return MODEL_FILTER_FIELD_TYPES[source];
  if (Array.isArray(source)) {
    const map: Record<string, FilterFieldType> = {};
    for (const field of source) map[field] = 'boolean';
    return map;
  }
  return source as FilterFieldTypeMap;
}
