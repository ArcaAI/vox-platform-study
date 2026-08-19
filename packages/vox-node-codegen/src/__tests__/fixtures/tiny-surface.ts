/**
 * A miniature pair of input artifacts — one route manifest, one OpenAPI
 * document — shaped like the real ones but small enough to assert on
 * exhaustively.
 *
 * It carries one instance of every branch the generator has to get right:
 * a paginated list, an `@RequiresIfMatch()` write, a path parameter, an
 * untyped (`{}`) query parameter, a handler-name collision between two
 * controllers sharing one scope, a machine-CLOSED controller, and a
 * non-`admin:` scope (`svc:webhook:event:write`).
 */

import type { OpenApiDocument, RouteManifest } from '../../types';

export function makeManifest(overrides: Partial<RouteManifest> = {}): RouteManifest {
  return {
    globalPrefix: 'api/v1',
    routes: [
      route({ controller: 'WidgetController', handler: 'list', method: 'GET', routePath: '/admin/widgets', path: '/api/v1/admin/widgets' }),
      route({
        controller: 'WidgetController',
        handler: 'update',
        method: 'PATCH',
        routePath: '/admin/widgets/:id',
        path: '/api/v1/admin/widgets/{id}',
        requiresIfMatch: true,
      }),
      // Same scope, different controller, COLLIDING handler name.
      route({ controller: 'WidgetCatalogController', handler: 'list', method: 'GET', routePath: '/admin/widgets/catalog', path: '/api/v1/admin/widgets/catalog' }),
      route({
        controller: 'WebhookController',
        handler: 'ping',
        method: 'POST',
        routePath: '/admin/webhooks/ping',
        path: '/api/v1/admin/webhooks/ping',
        svcScopes: ['svc:webhook:event:write'],
      }),
      // Machine-closed: no svc scope, and named in MACHINE_CLOSED_CONTROLLERS.
      route({
        controller: 'ConsentGrantController',
        handler: 'record',
        method: 'POST',
        routePath: '/admin/consent-grants',
        path: '/api/v1/admin/consent-grants',
        svcScopes: [],
      }),
      // Not on the admin plane at all — must be ignored entirely.
      route({ controller: 'HealthController', handler: 'live', method: 'GET', routePath: '/health', path: '/api/v1/health', svcScopes: [] }),
      ...(overrides.routes ?? []),
    ],
    ...('globalPrefix' in overrides ? { globalPrefix: overrides.globalPrefix as string } : {}),
  };
}

function route(partial: Partial<RouteManifest['routes'][number]> & { controller: string; handler: string; method: string; routePath: string; path: string }) {
  return {
    svcScopes: ['svc:admin:widget:manage'],
    forbidServiceAccount: false,
    requiresIfMatch: false,
    apiExcluded: false,
    ...partial,
  };
}

export function makeDocument(): OpenApiDocument {
  return {
    paths: {
      '/api/v1/admin/widgets': {
        get: {
          operationId: 'WidgetController_list',
          summary: 'List widgets',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            // No schema at all — the document declining to describe a shape.
            { name: 'ownerId', in: 'query', schema: {} },
          ],
          responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedWidgetResponse' } } } } },
        },
      },
      '/api/v1/admin/widgets/{id}': {
        patch: {
          operationId: 'WidgetController_update',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateWidgetRequest' } } } },
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/WidgetResponse' } } } } },
        },
      },
      '/api/v1/admin/widgets/catalog': {
        get: { operationId: 'WidgetCatalogController_list', responses: { '200': {} } },
      },
      '/api/v1/admin/webhooks/ping': {
        post: { operationId: 'WebhookController_ping', responses: { '201': {} } },
      },
      '/api/v1/admin/consent-grants': {
        post: { operationId: 'ConsentGrantController_record', responses: { '201': {} } },
      },
      '/api/v1/health': {
        get: { operationId: 'HealthController_live', responses: { '200': {} } },
      },
    },
    components: {
      schemas: {
        WidgetResponse: {
          type: 'object',
          required: ['id', 'version', 'kind'],
          properties: {
            id: { type: 'string' },
            version: { type: 'number' },
            // A string enum: renders as quoted LITERALS, which must NOT end up
            // in the module's import list.
            kind: { type: 'string', enum: ['AiModel', 'ApiKey'] },
            label: { type: 'string', nullable: true },
          },
        },
        UpdateWidgetRequest: { type: 'object', properties: { label: { type: 'string' } } },
        PaginatedWidgetResponse: {
          type: 'object',
          required: ['count', 'limit', 'page', 'data'],
          properties: {
            count: { type: 'number' },
            limit: { type: 'number' },
            page: { type: 'number' },
            data: { type: 'array', items: { $ref: '#/components/schemas/WidgetResponse' } },
          },
        },
      },
    },
  };
}
