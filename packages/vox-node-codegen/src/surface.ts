/**
 * Build the {@link AdminSurface} from the two cross-checked input artifacts.
 *
 * ## The cross-check (ticket §3.1)
 *
 * Two sources, each authoritative for a different half:
 *
 * - **`route-manifest.json`** (Nest `ModulesContainer` walk) — which routes
 *   exist, their verb and path, and the `svc:*`/`@ForbidServiceAccount`/
 *   `@RequiresIfMatch` posture. It is what `UnifiedAuthGuard` reads at request
 *   time, so it cannot be wrong about reachability.
 * - **`openapi.json`** — request/response TYPES, from the DTOs.
 *
 * They are joined on the OpenAPI `operationId`, which `@nestjs/swagger`
 * derives as `<ControllerClass>_<handler>` — precisely the pair the Nest walk
 * records. The generator FAILS when they disagree about which admin routes
 * exist, in either direction, because that disagreement is a real finding: a
 * route the document does not describe is a route missing its Swagger
 * decorators, and a document entry with no live route is a stale artifact.
 * The one sanctioned exemption is a route carrying
 * `@ApiExcludeEndpoint()`/`@ApiExcludeController()` — a DELIBERATE absence,
 * which the manifest records as `apiExcluded` so the check can tell the two
 * apart instead of blanket-tolerating gaps.
 *
 * ## What is deliberately NOT generated
 *
 * `MACHINE_CLOSED_CONTROLLERS` names the five admin controllers that owner
 * decisions D-3 and O-1 keep machine-closed. They would already fall out of
 * the surface by derivation (no `svc:*` scope ⇒ `enforceServiceAccountScopes`
 * denies them ⇒ nothing to generate), so the list is not what excludes them —
 * it is an ASSERTION that they are still closed. If a future edit gives one of
 * them a `svc:*` scope, this generator fails loudly rather than quietly
 * emitting a surface an owner decision forbids.
 */

import { areaKeyFromScope, controllerSlug, toCamelCase, toIdentifier, toPascalCase } from './naming';
import { SchemaRenderer, sanitizeComment } from './schema-to-ts';
import type {
  AdminArea,
  AdminMethod,
  AdminSurface,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchema,
  PathParam,
  RouteManifest,
  RouteManifestEntry,
} from './types';

/**
 * Admin controllers that must stay machine-closed, with the decision that
 * closed them. Asserted, never used to filter — see the module header.
 */
export const MACHINE_CLOSED_CONTROLLERS: ReadonlyMap<string, string> = new Map([
  ['ServiceAccountController', 'D-3 — self-replication: a machine must not mint another machine (also pinned by boot audit E).'],
  [
    'AdminImpersonationController',
    'D-3 — impersonation is a machine assuming a human identity, which defeats the audit attribution service accounts exist to provide.',
  ],
  ['ConsentGrantController', 'D-3 — consent is an act of a person; a machine recording it is a compliance claim the platform cannot substantiate.'],
  [
    'MonitoringController',
    'O-1(b) — never class-level scope-gated, so there is no admin:* scope to renamespace; left machine-closed with @ForbidServiceAccount().',
  ],
  ['AdminHealthServicesController', 'O-1(b) — same: never class-level scope-gated; left machine-closed with @ForbidServiceAccount().'],
]);

/** The house `PaginatedQuery` fields, which {@link AdminListQuery} already models on the base class. */
const PAGINATED_QUERY_FIELDS = new Set(['page', 'limit', 'search', 'searchFields', 'filters', 'sort']);

export class CrossCheckError extends Error {
  constructor(problems: string[]) {
    super(
      `vox-node-codegen: refused to generate — the route manifest and the OpenAPI document disagree about the admin surface ` +
        `(${problems.length} problem(s)). Re-run \`pnpm api:route-manifest\` and \`pnpm api:openapi\` on the same tree; if they still ` +
        `disagree, a route is missing its Swagger decorators (or carries @ApiExcludeEndpoint by mistake):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'CrossCheckError';
  }
}

export function buildAdminSurface(manifest: RouteManifest, document: OpenApiDocument): AdminSurface {
  const adminRoutes = manifest.routes.filter((route) => route.routePath === '/admin' || route.routePath.startsWith('/admin/'));
  const operations = indexOperations(document);

  assertCrossChecked(adminRoutes, operations);
  assertMachineClosedStillClosed(adminRoutes);

  const renderer = new SchemaRenderer(document);
  const reachable = adminRoutes.filter(isMachineReachable);

  const byArea = new Map<string, RouteManifestEntry[]>();
  for (const route of reachable) {
    const key = areaKeyFromScope(route.svcScopes[0]);
    const bucket = byArea.get(key);
    if (bucket) bucket.push(route);
    else byArea.set(key, [route]);
  }

  const areas: AdminArea[] = [];
  for (const key of [...byArea.keys()].sort()) {
    const routes = sortRoutes(byArea.get(key) ?? []);
    const scopes = [...new Set(routes.map((r) => r.svcScopes[0]))];
    if (scopes.length !== 1) {
      throw new CrossCheckError([
        `area '${key}' resolves to more than one svc:* scope (${scopes.join(', ')}). The area key is derived from the scope, so this is impossible ` +
          `unless two different scopes share an area name — rename one scope rather than teaching the generator an exception.`,
      ]);
    }

    areas.push({
      key,
      property: toCamelCase(key),
      className: `Admin${toPascalCase(key)}Resource`,
      svcScope: scopes[0],
      controllers: [...new Set(routes.map((r) => r.controller))].sort(),
      methods: buildMethods(routes, operations, renderer),
    });
  }

  const closedCounts = new Map<string, number>();
  for (const route of adminRoutes) {
    if (isMachineReachable(route)) continue;
    closedCounts.set(route.controller, (closedCounts.get(route.controller) ?? 0) + 1);
  }

  return {
    areas,
    schemas: renderer.usedSchemaNames().map((name) => ({ name, declaration: renderer.declare(name) })),
    machineClosed: [...closedCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([controller, routes]) => ({ controller, routes })),
  };
}

function isMachineReachable(route: RouteManifestEntry): boolean {
  return route.svcScopes.length > 0 && !route.forbidServiceAccount;
}

function sortRoutes(routes: RouteManifestEntry[]): RouteManifestEntry[] {
  return [...routes].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      a.controller.localeCompare(b.controller) ||
      a.handler.localeCompare(b.handler),
  );
}

interface IndexedOperation {
  path: string;
  method: string;
  operation: OpenApiOperation;
}

function indexOperations(document: OpenApiDocument): Map<string, IndexedOperation> {
  const index = new Map<string, IndexedOperation>();
  for (const path of Object.keys(document.paths ?? {}).sort()) {
    for (const method of Object.keys(document.paths[path]).sort()) {
      const operation = document.paths[path][method];
      if (!operation?.operationId) continue;
      index.set(operation.operationId, { path, method: method.toUpperCase(), operation });
    }
  }
  return index;
}

function assertCrossChecked(adminRoutes: RouteManifestEntry[], operations: Map<string, IndexedOperation>): void {
  const problems: string[] = [];

  for (const route of adminRoutes) {
    const operationId = `${route.controller}_${route.handler}`;
    const entry = operations.get(operationId);

    if (!entry) {
      if (route.apiExcluded) continue;
      problems.push(
        `${route.method} ${route.path} (${operationId}) exists in the route manifest but has no operation in openapi.json, and does not carry ` +
          `@ApiExcludeEndpoint()/@ApiExcludeController(). Give it Swagger decorators (so its request/response types are derivable) or exclude it explicitly.`,
      );
      continue;
    }

    if (route.apiExcluded) {
      problems.push(
        `${route.method} ${route.path} (${operationId}) is marked @ApiExclude* yet appears in openapi.json — the emitted document is stale.`,
      );
      continue;
    }
    if (entry.method !== route.method || entry.path !== route.path) {
      problems.push(
        `${operationId} disagrees between sources: route manifest says ${route.method} ${route.path}, openapi.json says ${entry.method} ${entry.path}.`,
      );
    }
  }

  // Reverse direction: an admin operation the document describes but no live
  // route serves. That is a stale artifact, and generating from it would ship
  // methods that 404.
  const liveIds = new Set(adminRoutes.map((route) => `${route.controller}_${route.handler}`));
  for (const [operationId, entry] of operations) {
    if (!entry.path.includes('/admin/')) continue;
    if (liveIds.has(operationId)) continue;
    problems.push(
      `${entry.method} ${entry.path} (${operationId}) is described by openapi.json but no live admin route serves it — re-emit the artifacts.`,
    );
  }

  if (problems.length > 0) throw new CrossCheckError(problems.sort());
}

function assertMachineClosedStillClosed(adminRoutes: RouteManifestEntry[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const route of adminRoutes) {
    const reason = MACHINE_CLOSED_CONTROLLERS.get(route.controller);
    if (!reason || !isMachineReachable(route) || seen.has(route.controller)) continue;
    seen.add(route.controller);
    problems.push(
      `${route.controller} is machine-CLOSED by owner decision but now declares ${route.svcScopes.join(', ')} at ${route.method} ${route.path}. ` +
        `${reason} Re-opening it is an owner decision, not a code-review call — remove the scope, or remove the controller from ` +
        `MACHINE_CLOSED_CONTROLLERS with the new decision recorded.`,
    );
  }

  if (problems.length > 0) throw new CrossCheckError(problems.sort());
}

function buildMethods(routes: RouteManifestEntry[], operations: Map<string, IndexedOperation>, renderer: SchemaRenderer): AdminMethod[] {
  // Two passes so the collision rule is a property of the AREA, not of
  // iteration order: a handler name shared by two controllers in the same area
  // qualifies EVERY member of the collision, never just the second one.
  const handlerCounts = new Map<string, number>();
  for (const route of routes) handlerCounts.set(route.handler, (handlerCounts.get(route.handler) ?? 0) + 1);

  const taken = new Set<string>();
  const methods: AdminMethod[] = [];

  for (const route of routes) {
    const entry = operations.get(`${route.controller}_${route.handler}`);
    const operation = entry?.operation ?? {};

    const collided = (handlerCounts.get(route.handler) ?? 0) > 1;
    const base = collided ? toCamelCase(`${controllerSlug(route.controller)}-${route.handler}`) : toCamelCase(route.handler);
    const name = uniqueName(base, taken);

    // Each type-bearing part is rendered in its OWN capture so the module's
    // import list is exactly what the emitted text names, and nothing more —
    // see `SchemaRenderer.capturing`. The split matters for a paginated route:
    // it renders BOTH `PaginatedXResponse` (as the declared 2xx body) and `X`
    // (the row), but only the row reaches the emitted signature, because the
    // page shape itself is the base class's `PaginatedPage<T>`.
    const row = renderer.capturing(() => detectPaginatedRow(operation, renderer));
    const paginated = Boolean(row.value);
    const query = renderer.capturing(() => buildQueryParams(operation, renderer, paginated));
    const body = renderer.capturing(() => buildBodyType(operation, renderer));
    const returned = renderer.capturing(() => buildReturnType(operation, renderer));

    const rendered = { paginatedRow: row.value, query: query.value, bodyType: body.value, returnType: returned.value };
    const refs = [...new Set([...query.refs, ...body.refs, ...(paginated ? row.refs : returned.refs)])].sort();

    const iterateName = paginated ? uniqueName(`${name}Iterate`, taken) : undefined;

    methods.push({
      name,
      iterateName,
      httpMethod: route.method,
      path: route.routePath.replace(/^\//, ''),
      documentedPath: route.path,
      controller: route.controller,
      handler: route.handler,
      pathParams: buildPathParams(route, operation),
      query: rendered.query,
      bodyType: rendered.bodyType,
      bodyRequired: operation.requestBody?.required === true,
      returnType: rendered.returnType,
      rowType: rendered.paginatedRow,
      paginated,
      requiresIfMatch: route.requiresIfMatch,
      summary: operation.summary ? sanitizeComment(operation.summary) : undefined,
      description: operation.description ? sanitizeComment(operation.description) : undefined,
      schemaRefs: refs,
    });
  }

  return methods;
}

function uniqueName(candidate: string, taken: Set<string>): string {
  let name = candidate;
  let suffix = 2;
  while (taken.has(name)) name = `${candidate}${suffix++}`;
  taken.add(name);
  return name;
}

function buildPathParams(route: RouteManifestEntry, operation: OpenApiOperation): PathParam[] {
  const declared = new Map((operation.parameters ?? []).filter((p) => p.in === 'path').map((p) => [p.name, p]));
  const names = [...route.routePath.matchAll(/:([A-Za-z0-9_]+)\??/g)].map((match) => match[1]);

  return names.map((name) => ({
    name,
    identifier: toIdentifier(name),
    tsType: declared.get(name)?.schema?.type === 'number' || declared.get(name)?.schema?.type === 'integer' ? 'number' : 'string',
  }));
}

function buildQueryParams(
  operation: OpenApiOperation,
  renderer: SchemaRenderer,
  paginated: boolean,
): { name: string; tsType: string; required: boolean; description?: string }[] {
  const params = (operation.parameters ?? []).filter((p): p is OpenApiParameter => p.in === 'query');
  return params
    .filter((p) => !(paginated && PAGINATED_QUERY_FIELDS.has(p.name)))
    .map((p) => ({
      name: p.name,
      // A query parameter with no schema (`{}`) is the document declining to
      // say more than "this exists"; `QueryValue` is the transport's own
      // accepted union and is the honest answer.
      tsType: p.schema && Object.keys(p.schema).length > 0 ? renderer.render(p.schema) : 'QueryValue',
      required: p.required === true,
      description: p.description ? sanitizeComment(p.description) : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildBodyType(operation: OpenApiOperation, renderer: SchemaRenderer): string | undefined {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  if (!schema) return undefined;
  const rendered = renderer.render(schema);
  return rendered === 'unknown' ? 'unknown' : rendered;
}

function successResponseSchema(operation: OpenApiOperation): OpenApiSchema | undefined {
  const codes = Object.keys(operation.responses ?? {})
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  for (const code of codes) {
    const schema = operation.responses?.[code]?.content?.['application/json']?.schema;
    if (schema) return schema;
  }
  return undefined;
}

function buildReturnType(operation: OpenApiOperation, renderer: SchemaRenderer): string {
  const schema = successResponseSchema(operation);
  if (!schema) return 'unknown';
  return renderer.render(schema);
}

/**
 * Is this operation's 2xx body the house `Paginated<T>` page? Detected
 * STRUCTURALLY (an object carrying `data: T[]` plus `count`/`page`/`limit`)
 * rather than by the `Paginated…Response` name, because the name is a DTO
 * convention while the shape is the contract `AdminResource.listPage`/`listAll`
 * actually consume.
 *
 * @returns the row type when paginated, otherwise `undefined`.
 */
function detectPaginatedRow(operation: OpenApiOperation, renderer: SchemaRenderer): string | undefined {
  const schema = successResponseSchema(operation);
  const resolved = renderer.resolve(schema);
  const properties = resolved?.properties;
  if (!properties?.data || !properties.count || !properties.page || !properties.limit) return undefined;
  if (properties.data.type !== 'array') return undefined;
  const row = renderer.render(properties.data.items);
  return row === 'unknown' ? 'unknown' : row;
}
