import { describe, expect, it } from 'vitest';

import { areaKeyFromScope, toCamelCase, toIdentifier, toPascalCase } from '../naming';
import { buildAdminSurface, CrossCheckError } from '../surface';
import { makeDocument, makeManifest } from './fixtures/tiny-surface';

describe('naming', () => {
  it('derives the area from the scope, dropping the svc:/admin: prefixes and the trailing action', () => {
    expect(areaKeyFromScope('svc:admin:tenant:write')).toBe('tenant');
    expect(areaKeyFromScope('svc:admin:tenant-tts-config:manage')).toBe('tenant-tts-config');
    expect(areaKeyFromScope('svc:webhook:event:write')).toBe('webhook-event');
  });

  it('round-trips kebab ↔ camel ↔ Pascal', () => {
    expect(toCamelCase('tenant-tts-config')).toBe('tenantTtsConfig');
    expect(toPascalCase('tenant-tts-config')).toBe('TenantTtsConfig');
    expect(toIdentifier('code-name')).toBe('codeName');
  });

  it('renames a path parameter that would be a reserved word', () => {
    expect(toIdentifier('new')).toBe('newParam');
  });
});

describe('buildAdminSurface', () => {
  const surface = buildAdminSurface(makeManifest(), makeDocument());

  it('groups machine-reachable admin routes by svc: scope, ignoring non-admin routes', () => {
    expect(surface.areas.map((area) => area.key)).toEqual(['webhook-event', 'widget']);
    expect(surface.areas.map((area) => area.svcScope)).toEqual(['svc:webhook:event:write', 'svc:admin:widget:manage']);
  });

  it('omits machine-closed controllers from the surface and reports them', () => {
    const generated = surface.areas.flatMap((area) => area.methods.map((method) => method.controller));
    expect(generated).not.toContain('ConsentGrantController');
    expect(surface.machineClosed).toEqual([{ controller: 'ConsentGrantController', routes: 1 }]);
  });

  it('qualifies EVERY member of a handler-name collision, not just the second one', () => {
    const widget = surface.areas.find((area) => area.key === 'widget');
    expect(widget?.methods.map((method) => method.name).sort()).toEqual(['update', 'widgetCatalogList', 'widgetList']);
  });

  it('detects the house paginated page structurally and exposes the ROW type', () => {
    const list = surface.areas.find((a) => a.key === 'widget')?.methods.find((m) => m.name === 'widgetList');
    expect(list?.paginated).toBe(true);
    expect(list?.rowType).toBe('WidgetResponse');
    expect(list?.iterateName).toBe('widgetListIterate');
  });

  it('drops the house PaginatedQuery fields from a paginated route and types a schema-less query param as QueryValue', () => {
    const list = surface.areas.find((a) => a.key === 'widget')?.methods.find((m) => m.name === 'widgetList');
    expect(list?.query).toEqual([{ name: 'ownerId', tsType: 'QueryValue', required: false, description: undefined }]);
  });

  it('never imports a string-enum member as if it were a type', () => {
    const update = surface.areas.find((a) => a.key === 'widget')?.methods.find((m) => m.name === 'update');
    expect(update?.schemaRefs).toEqual(['UpdateWidgetRequest', 'WidgetResponse']);
  });

  it('carries the If-Match posture through from the route manifest', () => {
    const update = surface.areas.find((a) => a.key === 'widget')?.methods.find((m) => m.name === 'update');
    expect(update?.requiresIfMatch).toBe(true);
    expect(update?.pathParams).toEqual([{ name: 'id', identifier: 'id', tsType: 'string' }]);
  });

  it('emits only the component schemas the surface transitively reaches', () => {
    expect(surface.schemas.map((s) => s.name)).toEqual(['PaginatedWidgetResponse', 'UpdateWidgetRequest', 'WidgetResponse']);
  });

  it('returns unknown rather than a guess when the document declares no 2xx schema', () => {
    const ping = surface.areas.find((a) => a.key === 'webhook-event')?.methods[0];
    expect(ping?.returnType).toBe('unknown');
  });
});

describe('cross-check', () => {
  it('fails when an admin route has no operation in the OpenAPI document', () => {
    const manifest = makeManifest({
      routes: [
        {
          controller: 'WidgetController',
          handler: 'undocumented',
          method: 'GET',
          routePath: '/admin/widgets/secret',
          path: '/api/v1/admin/widgets/secret',
          svcScopes: ['svc:admin:widget:manage'],
          forbidServiceAccount: false,
          requiresIfMatch: false,
          apiExcluded: false,
        },
      ],
    });
    expect(() => buildAdminSurface(manifest, makeDocument())).toThrow(CrossCheckError);
  });

  it('tolerates an undocumented route that declares @ApiExcludeEndpoint', () => {
    const manifest = makeManifest({
      routes: [
        {
          controller: 'WidgetController',
          handler: 'undocumented',
          method: 'GET',
          routePath: '/admin/widgets/secret',
          path: '/api/v1/admin/widgets/secret',
          svcScopes: ['svc:admin:widget:manage'],
          forbidServiceAccount: false,
          requiresIfMatch: false,
          apiExcluded: true,
        },
      ],
    });
    expect(() => buildAdminSurface(manifest, makeDocument())).not.toThrow();
  });

  it('fails when the two sources disagree about a path', () => {
    const document = makeDocument();
    document.paths['/api/v1/admin/widgets/{widgetId}'] = document.paths['/api/v1/admin/widgets/{id}'];
    delete document.paths['/api/v1/admin/widgets/{id}'];
    expect(() => buildAdminSurface(makeManifest(), document)).toThrow(/disagrees between sources/);
  });

  it('fails when the document describes an admin operation no live route serves', () => {
    const document = makeDocument();
    document.paths['/api/v1/admin/ghosts'] = { get: { operationId: 'GhostController_list', responses: { '200': {} } } };
    expect(() => buildAdminSurface(makeManifest(), document)).toThrow(/no live admin route serves it/);
  });

  it('refuses to generate a machine-CLOSED controller that has been re-opened', () => {
    const manifest = makeManifest();
    const consent = manifest.routes.find((r) => r.controller === 'ConsentGrantController');
    consent!.svcScopes = ['svc:admin:consent:manage'];
    expect(() => buildAdminSurface(manifest, makeDocument())).toThrow(/machine-CLOSED by owner decision/);
  });
});
