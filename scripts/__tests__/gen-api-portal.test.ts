import { describe, expect, it } from 'vitest';

import {
  buildPortalSpecs,
  credentialNote,
  credentialsFor,
  factsFor,
  isBusinessVisible,
  type ManifestRoute,
  type OpenApiDocument,
} from '../gen-api-portal';

/**
 * TASK-783 — the portal generator decides what a tenant developer is allowed
 * to SEE, so its credential logic is a security boundary, not a formatting
 * concern. These tests pin the two rules that are easy to get subtly wrong:
 * `@ForbidApiKey()` being unconditional, and "no declared scope" meaning DENY
 * rather than "unknown".
 */

const PREFIX = 'api/v1';

function route(overrides: Partial<ManifestRoute> = {}): ManifestRoute {
  return {
    controller: 'ThingController',
    handler: 'list',
    method: 'GET',
    path: '/api/v1/things',
    svcScopes: [],
    forbidServiceAccount: false,
    apiKeyForbidden: false,
    apiKeyScopes: [],
    requiredPermissions: null,
    isPublic: false,
    permissionMode: null,
    requiresIfMatch: false,
    apiExcluded: false,
    ...overrides,
  };
}

describe('credentialsFor', () => {
  it('reports a public route as public and nothing else', () => {
    expect(credentialsFor(route({ isPublic: true, apiKeyScopes: ['thing:read'] }))).toEqual(['public']);
  });

  it('always allows a user JWT on a non-public route', () => {
    expect(credentialsFor(route())).toContain('user-jwt');
  });

  it('admits an API key only when a scope is declared — absent means DENY, not unknown', () => {
    expect(credentialsFor(route({ apiKeyScopes: [] }))).not.toContain('api-key');
    expect(credentialsFor(route({ apiKeyScopes: ['thing:read'] }))).toContain('api-key');
  });

  it('rejects an API key on a @ForbidApiKey() route even when scopes are declared', () => {
    // The guard checks @ForbidApiKey() BEFORE scopes, so the 403 is
    // unconditional. Treating a broad scope as an escape hatch here would
    // publish an admin route to tenant developers.
    expect(credentialsFor(route({ apiKeyForbidden: true, apiKeyScopes: ['thing:read'] }))).not.toContain('api-key');
  });

  it('applies the same two rules to the service-account class', () => {
    expect(credentialsFor(route({ svcScopes: [] }))).not.toContain('service-account');
    expect(credentialsFor(route({ svcScopes: ['svc:thing:read'] }))).toContain('service-account');
    expect(credentialsFor(route({ forbidServiceAccount: true, svcScopes: ['svc:thing:read'] }))).not.toContain('service-account');
  });
});

describe('factsFor', () => {
  it('classifies an /admin/ path as the admin plane', () => {
    expect(factsFor(route({ path: '/api/v1/admin/users' }), PREFIX).plane).toBe('admin');
    expect(factsFor(route({ path: '/api/v1/consultations' }), PREFIX).plane).toBe('business');
  });

  it('does not mistake a business path that merely contains the word admin', () => {
    expect(factsFor(route({ path: '/api/v1/administrators' }), PREFIX).plane).toBe('business');
  });

  it('flattens abilities to action:subject and sorts them', () => {
    const facts = factsFor(route({ requiredPermissions: [['update', 'Thing'], ['read', 'Thing']] }), PREFIX);

    expect(facts.abilities).toEqual(['read:Thing', 'update:Thing']);
  });

  it('treats absent permission metadata and a bare @Authorize() alike for display', () => {
    // The manifest distinguishes null from [] and the boot audit cares; the
    // rendered ability LIST is empty either way.
    expect(factsFor(route({ requiredPermissions: null }), PREFIX).abilities).toEqual([]);
    expect(factsFor(route({ requiredPermissions: [] }), PREFIX).abilities).toEqual([]);
  });
});

describe('isBusinessVisible', () => {
  it('excludes every admin-plane route', () => {
    const facts = factsFor(route({ path: '/api/v1/admin/users', apiKeyForbidden: true }), PREFIX);

    expect(isBusinessVisible(facts)).toBe(false);
  });

  it('includes a business route reachable by a tenant credential', () => {
    expect(isBusinessVisible(factsFor(route({ apiKeyScopes: ['thing:read'] }), PREFIX))).toBe(true);
  });

  it('includes a public business route', () => {
    expect(isBusinessVisible(factsFor(route({ isPublic: true }), PREFIX))).toBe(true);
  });
});

describe('credentialNote', () => {
  it('states plainly that an API key is rejected', () => {
    const note = credentialNote(factsFor(route({ apiKeyForbidden: true }), PREFIX));

    expect(note).toContain('API key **rejected (403)**');
  });

  it('documents the OCC requirement when the route needs If-Match', () => {
    const note = credentialNote(factsFor(route({ requiresIfMatch: true }), PREFIX));

    expect(note).toContain('If-Match');
    expect(note).toContain('428');
    expect(note).toContain('412');
  });

  it('joins abilities with "or" under OR mode and "and" under AND mode', () => {
    const permissions: [string, string][] = [['read', 'Thing'], ['manage', 'Thing']];

    expect(credentialNote(factsFor(route({ requiredPermissions: permissions, permissionMode: 'OR' }), PREFIX))).toContain('` or `');
    expect(credentialNote(factsFor(route({ requiredPermissions: permissions, permissionMode: 'AND' }), PREFIX))).toContain('` and `');
  });
});

describe('buildPortalSpecs', () => {
  const document: OpenApiDocument = {
    openapi: '3.0.0',
    tags: [{ name: 'things' }, { name: 'admin-users' }],
    paths: {
      '/api/v1/things': { get: { tags: ['things'], summary: 'List things' } },
      '/api/v1/admin/users': { get: { tags: ['admin-users'], summary: 'List users' } },
    },
  };
  const manifest = {
    globalPrefix: PREFIX,
    routes: [
      route({ path: '/api/v1/things', apiKeyScopes: ['thing:read'] }),
      route({ path: '/api/v1/admin/users', controller: 'UserAdminController', apiKeyForbidden: true, svcScopes: ['svc:admin:user:manage'] }),
    ],
  };

  const { admin, business, unmatched } = buildPortalSpecs(document, manifest);

  it('keeps every documented operation in the admin projection', () => {
    expect(Object.keys(admin.paths).sort()).toEqual(['/api/v1/admin/users', '/api/v1/things']);
  });

  it('omits admin paths from the business projection entirely — not merely hides them', () => {
    // The payload is served to tenant developers; presence is the leak,
    // regardless of what the client chooses to render.
    expect(Object.keys(business.paths)).toEqual(['/api/v1/things']);
  });

  it('drops tag groups left empty in the business projection', () => {
    expect((business.tags ?? []).map((tag) => tag.name)).toEqual(['things']);
  });

  it('attaches the credential facts as vendor extensions', () => {
    const operation = admin.paths['/api/v1/admin/users'].get;

    expect(operation['x-hope-plane']).toBe('admin');
    expect(operation['x-hope-credentials']).toEqual(['user-jwt', 'service-account']);
    expect(operation['x-hope-service-account-scopes']).toEqual(['svc:admin:user:manage']);
  });

  it('appends the credential note to the operation description', () => {
    expect(admin.paths['/api/v1/things'].get.description).toContain('**Credentials**');
  });

  it('reports operations with no manifest route instead of inventing facts for them', () => {
    const orphan = buildPortalSpecs({ ...document, paths: { '/api/v1/ghost': { get: {} } } }, manifest);

    expect(orphan.unmatched).toEqual(['GET /api/v1/ghost']);
    expect(orphan.admin.paths['/api/v1/ghost'].get['x-hope-plane']).toBeUndefined();
    expect(orphan.business.paths['/api/v1/ghost']).toBeUndefined();
  });

  it('produces no unmatched operations for a consistent pair', () => {
    expect(unmatched).toEqual([]);
  });

  it('is deterministic — same inputs, byte-identical output', () => {
    const again = buildPortalSpecs(document, manifest);

    expect(JSON.stringify(again.admin)).toBe(JSON.stringify(admin));
    expect(JSON.stringify(again.business)).toBe(JSON.stringify(business));
  });
});
