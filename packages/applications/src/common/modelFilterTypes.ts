// Type-only import — erased at runtime, so this adds NO runtime coupling to
// `@arcaai/database` (it is already a declared dependency, and the ESLint guard
// only restricts the unscoped client *symbol*, not type imports). These are the
// generated Prisma model types and are the metadata source for filter coercion.
import type { AuditLog, GlobalSetting, Media, Notification, Role, Tag, Tenant, User, Webhook } from '@arcaai/database';
// Runtime enum member lists come from the `@arcaai/domains` GENERATED enums —
// code-generated from the same Prisma schema as the model types above, so the
// members can never drift from the database enums (and the application layer
// keeps its no-runtime-`@arcaai/database` convention).
import { AuditAction, NotificationType, ResourceStatusType, ResourceType, TenantPlan, ValueType } from '@arcaai/domains';

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
 * TASK-406 (P2-6b/c) extends the scheme:
 *   - enum columns now carry a RUNTIME member allow-list (an
 *     {@link EnumFilterFieldSpec}) so an invalid member is rejected with a 400
 *     at deserialization time instead of surfacing as a Prisma server-side
 *     error;
 *   - the registry covers Tenant / Media / Role / Tag / Webhook / Notification
 *     in addition to User / AuditLog. (`Permission` was named by TASK-375 but
 *     has NO Prisma model — the legacy `PermissionRepository` points at a
 *     nonexistent `prisma.permission` delegate — so there is no generated type
 *     to drive an entry; it is intentionally skipped.)
 *
 * Why the generated *types* and not DMMF: Prisma 7's `prisma-client` generator
 * does NOT expose a runtime `Prisma.dmmf` (`Prisma.dmmf === undefined`), so the
 * column types are read from the generated model types instead — at COMPILE time
 * via the `satisfies` guards below.
 */
export type FilterFieldType = 'boolean' | 'number' | 'date' | 'enum' | 'json';

/**
 * TASK-406 — an enum column's registry entry: the discriminating `type` plus
 * the runtime member allow-list used to validate filter values. `TMember` is
 * the generated string-literal union of the column, so the `satisfies` guards
 * below reject a member that does not exist on the database enum.
 */
export type EnumFilterFieldSpec<TMember extends string = string> = {
  readonly type: 'enum';
  readonly members: readonly TMember[];
};

/**
 * What a registry / explicit map declares for one column: a plain scalar tag,
 * or a member-carrying enum spec. A plain `'enum'` tag (only possible in an
 * explicit caller-provided map) stays the TASK-375 unvalidated pass-through.
 */
export type FilterFieldSpec = FilterFieldType | EnumFilterFieldSpec;

/** A resolved map of column name → how its filter value coerces/validates. */
export type FilterFieldTypeMap = Readonly<Record<string, FilterFieldSpec>>;

/** Build an {@link EnumFilterFieldSpec} from a `@arcaai/domains` generated enum object. */
export function enumFilterSpec<T extends Record<string, string>>(enumObject: T): EnumFilterFieldSpec<T[keyof T]> {
  return { type: 'enum', members: Object.values(enumObject) as T[keyof T][] };
}

/**
 * Map a generated model field's TS value type to the filter spec it requires,
 * or `never` for columns that must stay plain strings (String, Bytes, scalar
 * arrays, relations). Tuple-wrapped (`[NonNullable<V>] extends […]`) to defeat
 * union distribution so `boolean` (`true | false`) and enum unions classify as
 * a whole.
 *
 * How enum / Json columns are discriminated (TASK-375 §8 follow-up):
 *   - A Prisma **enum** column is generated as a string-LITERAL union
 *     (`'CREATE' | 'READ' | …`). It is a subtype of `string`, but `string` is
 *     NOT assignable back to it — so `string extends NonNullable<V>` is `false`
 *     for an enum and `true` for a plain `string`. That's the discriminator.
 *     TASK-406: the required entry is an `EnumFilterFieldSpec` whose `members`
 *     are typed against the column's literal union — a wrong/unknown member in
 *     the registry fails the build.
 *   - A Prisma **Json** column is generated as `JsonValue`
 *     (`string | number | boolean | JsonObject | JsonArray | null`): a union
 *     that CONTAINS `string` (so `string extends NonNullable<V>` is `true`) but
 *     is NOT itself assignable to `string` (so the `[…] extends [string]` arm is
 *     skipped). That uniquely identifies Json among the remaining types (Bytes,
 *     arrays and relations all fail `string extends …`).
 */
type CoercibleFilterSpec<V> = [NonNullable<V>] extends [Date]
  ? 'date'
  : [NonNullable<V>] extends [boolean]
    ? 'boolean'
    : [NonNullable<V>] extends [number]
      ? 'number'
      : [NonNullable<V>] extends [string]
        ? string extends NonNullable<V>
          ? never // a plain String column — stays a string (no coercion)
          : EnumFilterFieldSpec<NonNullable<V> & string> // a string-literal union (Prisma enum)
        : string extends NonNullable<V>
          ? 'json' // JsonValue: a union containing string but not assignable to string
          : never; // Bytes, scalar arrays, relations — stay strings

/**
 * The REQUIRED map of every coercible scalar column of a Prisma model → its
 * filter spec, derived from the generated model type. Used with `satisfies` so
 * the compiler:
 *   - rejects a column that does not exist on the model (typo / renamed),
 *   - rejects a plain String / Bytes / array / relation column (excess-property
 *     error — those have no `FilterFieldType`),
 *   - rejects a mislabelled type (e.g. a Bool column tagged `'number'`, or an
 *     enum column tagged `'json'`),
 *   - rejects an enum member list containing a value that is not a member of
 *     the column's generated literal union (TASK-406),
 *   - and forces EVERY boolean/number/date/enum/json column to be listed
 *     (completeness).
 * A schema change to any covered model therefore fails the build until the
 * registry is updated — the drift guard that the old hand-list lacked. Member
 * COMPLETENESS is guaranteed by sourcing `members` from the `@arcaai/domains`
 * generated enum objects (same schema, same generator run) via
 * {@link enumFilterSpec}, never from hand-written lists.
 */
export type ModelFilterFieldTypes<TModel> = {
  [K in keyof TModel as CoercibleFilterSpec<TModel[K]> extends never ? never : K]: CoercibleFilterSpec<TModel[K]>;
};

/**
 * User columns exposed to the admin Users grid filter (TASK-375 item 3).
 * `resourceStatus` (enum) is member-validated (TASK-406); `metaData` (Json)
 * passes through at the whole-column level and supports dotted-path filters
 * (see `deserializeFilterString`).
 */
export const USER_FILTER_FIELD_TYPES = {
  version: 'number',
  isServiceAccount: 'boolean',
  // TASK-400 — rotation tracking column.
  passwordChangedAt: 'date',
  lastLoginAt: 'date',
  lastActiveAt: 'date',
  secret1Expiry: 'date',
  secret2Expiry: 'date',
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  metaData: 'json',
} satisfies ModelFilterFieldTypes<User>;

/**
 * AuditLog columns exposed to the admin audit-log grid filter (TASK-328 A8).
 * The enum columns (`resourceType`/`action`/`resourceStatus`) are
 * member-validated (TASK-406); the Json columns
 * (`metaData`/`data`/`previousData`/`metadata`) pass through at the
 * whole-column level and support dotted-path filters.
 */
export const AUDIT_LOG_FILTER_FIELD_TYPES = {
  version: 'number',
  success: 'boolean',
  dekKeyVersion: 'number',
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  resourceType: enumFilterSpec(ResourceType),
  action: enumFilterSpec(AuditAction),
  resourceStatus: enumFilterSpec(ResourceStatusType),
  metaData: 'json',
  data: 'json',
  previousData: 'json',
  metadata: 'json',
} satisfies ModelFilterFieldTypes<AuditLog>;

/** Tenant list filters (TASK-406 P2-6c) — admin tenants grid. */
export const TENANT_FILTER_FIELD_TYPES = {
  version: 'number',
  plan: enumFilterSpec(TenantPlan),
  trialEndsAt: 'date',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Tenant>;

/** Media list filters (TASK-406 P2-6c). */
export const MEDIA_FILTER_FIELD_TYPES = {
  version: 'number',
  size: 'number',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Media>;

/** Role list filters (TASK-406 P2-6c). */
export const ROLE_FILTER_FIELD_TYPES = {
  version: 'number',
  isSystemRole: 'boolean',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Role>;

/** Tag list filters (TASK-406 P2-6c). */
export const TAG_FILTER_FIELD_TYPES = {
  version: 'number',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Tag>;

/** Webhook list filters (TASK-406 P2-6c). */
export const WEBHOOK_FILTER_FIELD_TYPES = {
  version: 'number',
  subscriptionMetadata: 'json',
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Webhook>;

/**
 * Notification list filters (TASK-406 P2-6c). The `encryptedMessage*` Bytes
 * columns are excluded by the type guard (they stay strings / unfilterable).
 */
export const NOTIFICATION_FILTER_FIELD_TYPES = {
  version: 'number',
  read: 'boolean',
  keyVersion: 'number',
  type: enumFilterSpec(NotificationType),
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<Notification>;

/**
 * GlobalSetting list filters (TASK-443) — admin settings grid faceting
 * (Namespace rides through as a plain String column; `dataType` is the
 * member-validated `ValueType` enum; `encryptedValue` is Bytes and stays
 * unfilterable by the type guard).
 */
export const GLOBAL_SETTING_FILTER_FIELD_TYPES = {
  version: 'number',
  locked: 'boolean',
  keyVersion: 'number',
  dataType: enumFilterSpec(ValueType),
  resourceStatus: enumFilterSpec(ResourceStatusType),
  resourceStatusUpdatedAt: 'date',
  createdAt: 'date',
  updatedAt: 'date',
  metaData: 'json',
} satisfies ModelFilterFieldTypes<GlobalSetting>;

/**
 * Registry of model NAME → its coercible-column map. Keys are the Prisma model
 * names (PascalCase). A resource opts in by passing its model name to
 * `withFormatted{Paginated,Count}Props`; an unknown name resolves to `undefined`
 * (no coercion) so a typo can never silently mangle filters.
 */
export const MODEL_FILTER_FIELD_TYPES: Readonly<Record<string, FilterFieldTypeMap>> = {
  User: USER_FILTER_FIELD_TYPES,
  AuditLog: AUDIT_LOG_FILTER_FIELD_TYPES,
  Tenant: TENANT_FILTER_FIELD_TYPES,
  Media: MEDIA_FILTER_FIELD_TYPES,
  Role: ROLE_FILTER_FIELD_TYPES,
  Tag: TAG_FILTER_FIELD_TYPES,
  Webhook: WEBHOOK_FILTER_FIELD_TYPES,
  Notification: NOTIFICATION_FILTER_FIELD_TYPES,
  GlobalSetting: GLOBAL_SETTING_FILTER_FIELD_TYPES,
};

/**
 * How a caller declares the filter field types:
 *   - `string` — a model name resolved against {@link MODEL_FILTER_FIELD_TYPES}.
 *   - `readonly string[]` — LEGACY boolean allow-list (DEFECT-F1 back-compat);
 *     each named field is treated as boolean.
 *   - {@link FilterFieldTypeMap} — an explicit column → spec map.
 */
export type FilterFieldTypeSource = string | readonly string[] | FilterFieldTypeMap;

/** Resolve any {@link FilterFieldTypeSource} to a concrete field-type map. */
export function resolveFilterFieldTypes(source?: FilterFieldTypeSource): FilterFieldTypeMap | undefined {
  if (!source) return undefined;
  if (typeof source === 'string') return MODEL_FILTER_FIELD_TYPES[source];
  if (Array.isArray(source)) {
    const map: Record<string, FilterFieldSpec> = {};
    for (const field of source) map[field] = 'boolean';
    return map;
  }
  return source as FilterFieldTypeMap;
}
