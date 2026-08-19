/**
 * The two INPUT artifacts and the one intermediate model this generator works
 * with. Nothing here is emitted; `emit.ts` renders from {@link AdminSurface}.
 */

// ─── input 1: apps/api/route-manifest.json ──────────────────────────────────

/** One route, as `apps/api/src/scripts/emit-route-manifest.ts` serializes it. */
export interface RouteManifestEntry {
  controller: string;
  handler: string;
  method: string;
  /** WITH the global prefix, OpenAPI shape: `/api/v1/admin/tenants/{id}`. */
  path: string;
  /** WITHOUT the global prefix, Nest shape: `/admin/tenants/:id`. */
  routePath: string;
  svcScopes: string[];
  forbidServiceAccount: boolean;
  requiresIfMatch: boolean;
  apiExcluded: boolean;
}

export interface RouteManifest {
  globalPrefix: string;
  routes: RouteManifestEntry[];
}

// ─── input 2: apps/api/openapi.json ─────────────────────────────────────────

/**
 * The subset of OpenAPI 3.0 this generator reads. Deliberately partial: an
 * exhaustive model would imply support this generator does not have, and the
 * fields it ignores (`security`, `servers`, `callbacks`, …) are ignored on
 * purpose — the route manifest, not the document, is authoritative for who may
 * call what.
 */
export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  nullable?: boolean;
  description?: string;
}

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenApiSchema }> }>;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

// ─── intermediate model ─────────────────────────────────────────────────────

/** A path parameter lifted out of the Nest route path, typed from OpenAPI. */
export interface PathParam {
  /** As it appears in the route (`:id` → `id`). */
  name: string;
  /** A valid TS identifier derived from {@link name}. */
  identifier: string;
  /** `'string'` or `'number'`. */
  tsType: string;
}

/** One generated method. */
export interface AdminMethod {
  name: string;
  /** For a paginated list, the extra async-iterator method name; otherwise `undefined`. */
  iterateName?: string;
  httpMethod: string;
  /** Gateway-relative, WITHOUT the `api/v1` prefix and without a leading slash. */
  path: string;
  /** Full path as documented (with prefix), for the doc comment. */
  documentedPath: string;
  controller: string;
  handler: string;
  /**
   * Every `svc:*` scope THIS route declares, sorted. Usually one — the area's
   * own scope — but a read route may also accept the area's `:read` sibling
   * (TASK-773 decision O-3), and `enforceServiceAccountScopes` is OR, so any
   * one of them is sufficient. Emitted into the 403 message so it names what
   * this route actually needs rather than what the area as a whole needs.
   */
  svcScopes: string[];
  pathParams: PathParam[];
  /** Typed query parameters, excluding the house `PaginatedQuery` fields on a paginated route. */
  query: { name: string; tsType: string; required: boolean; description?: string }[];
  /** Request-body TS type, or `undefined` when the route declares no JSON body. */
  bodyType?: string;
  bodyRequired: boolean;
  /** 2xx response TS type. `'unknown'` when the document declares no usable schema. */
  returnType: string;
  /** Row type when {@link paginated}. */
  rowType?: string;
  paginated: boolean;
  requiresIfMatch: boolean;
  summary?: string;
  description?: string;
  /** Component schema names this method's rendered types actually name — the module's import list. */
  schemaRefs: string[];
}

/** One generated module — a `hope.admin.<area>` resource. */
export interface AdminArea {
  /** kebab-case, derived from the `svc:` scope. Also the file name. */
  key: string;
  /** `hope.admin.<property>`. */
  property: string;
  /** `Admin<Pascal>Resource`. */
  className: string;
  /**
   * The one scope that reaches EVERY route in the area — the intersection of
   * the areas' routes' declarations, not the union. A read route may accept
   * more (see {@link AdminMethod.svcScopes}); nothing accepts less.
   */
  svcScope: string;
  controllers: string[];
  methods: AdminMethod[];
}

/** Everything `emit.ts` needs. */
export interface AdminSurface {
  areas: AdminArea[];
  /** Component schemas, transitively reachable from the generated surface, in emission order. */
  schemas: { name: string; declaration: string }[];
  /** Controllers on the admin plane that are NOT machine-reachable, with the reason. */
  machineClosed: { controller: string; routes: number }[];
}
