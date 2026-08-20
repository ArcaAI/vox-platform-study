import { describe, expect, it } from 'vitest';

import { checkExampleHygiene, checkOpenApiCoverage, QUALITY_RATCHET, type OpenApiDocument, type RouteManifest } from '../check-openapi-coverage';

/**
 * TASK-783 — the coverage gate must go RED on each failure mode it claims to
 * catch. A gate nobody has watched fail is a gate that might be asserting
 * nothing; that is precisely how `apiExcluded` stayed broken for 657 routes.
 */

function manifestRoute(overrides: Partial<RouteManifest['routes'][number]> = {}): RouteManifest['routes'][number] {
  return {
    controller: 'ThingController',
    handler: 'list',
    method: 'GET',
    path: '/api/v1/things',
    apiExcluded: false,
    ...overrides,
  };
}

function documentWith(paths: OpenApiDocument['paths']): OpenApiDocument {
  return { paths };
}

const DOCUMENTED_OPERATION = {
  summary: 'List things',
  description: 'Returns every thing the caller may see.',
  tags: ['things'],
  responses: { '200': {}, '403': {} },
};

describe('checkOpenApiCoverage', () => {
  it('passes when every manifest route has a spec operation', () => {
    const report = checkOpenApiCoverage(documentWith({ '/api/v1/things': { get: DOCUMENTED_OPERATION } }), { routes: [manifestRoute()] });

    expect(report.failures).toEqual([]);
    expect(report.manifestRoutes).toBe(1);
    expect(report.specOperations).toBe(1);
  });

  it('FAILS on a served route with no OpenAPI metadata', () => {
    const report = checkOpenApiCoverage(documentWith({}), { routes: [manifestRoute()] });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('GET /api/v1/things');
    expect(report.failures[0]).toContain('ThingController.list');
    expect(report.failures[0]).toContain('@ApiExcludeEndpoint()');
  });

  it('does NOT fail on a route that is deliberately excluded', () => {
    const report = checkOpenApiCoverage(documentWith({}), { routes: [manifestRoute({ apiExcluded: true })] });

    expect(report.failures).toEqual([]);
    expect(report.excluded).toBe(1);
  });

  it('FAILS on a spec operation with no manifest route — the stale-artifact case', () => {
    // The real occurrence: openapi.json lagged one commit behind
    // route-manifest.json after TASK-733 and nothing noticed.
    const report = checkOpenApiCoverage(documentWith({ '/api/v1/ghosts': { delete: DOCUMENTED_OPERATION } }), { routes: [] });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('DELETE /api/v1/ghosts');
    expect(report.failures[0]).toContain('pnpm api:route-manifest');
  });

  it('reports both failure modes at once rather than stopping at the first', () => {
    const report = checkOpenApiCoverage(documentWith({ '/api/v1/ghosts': { delete: DOCUMENTED_OPERATION } }), { routes: [manifestRoute()] });

    expect(report.failures).toHaveLength(2);
  });

  it('matches the join key case-insensitively on the HTTP verb', () => {
    // The manifest stores verbs upper-case; OpenAPI stores them lower-case.
    // Getting this wrong would report every single route as undocumented.
    const report = checkOpenApiCoverage(documentWith({ '/api/v1/things': { get: DOCUMENTED_OPERATION } }), {
      routes: [manifestRoute({ method: 'GET' })],
    });

    expect(report.failures).toEqual([]);
  });

  it('counts quality gaps without failing on them', () => {
    const report = checkOpenApiCoverage(
      documentWith({
        '/api/v1/things': { get: { summary: 'List things', responses: { '200': {} } } },
      }),
      { routes: [manifestRoute()] },
    );

    expect(report.failures).toEqual([]);
    expect(report.withoutDescription).toBe(1);
    expect(report.withoutFailureMode).toBe(1);
    expect(report.withoutTag).toBe(1);
    expect(report.withoutSummary).toBe(0);
  });
});

describe('checkExampleHygiene', () => {
  it('accepts an e-mail on a reserved documentation domain', () => {
    // RFC 2606 reserves example.com precisely so documentation can use it.
    expect(checkExampleHygiene(documentWith({ '/a': { get: { summary: 'x', description: 'mail doctor@example.com' } } }))).toEqual([]);
  });

  it('FAILS on an e-mail that could be a real address', () => {
    const violations = checkExampleHygiene(documentWith({ '/a': { get: { summary: 'x', description: 'mail ops@arcaai.com' } } }));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('ops@arcaai.com');
    expect(violations[0]).toContain('RFC 2606');
  });

  it('permits the documented platform tenant constants', () => {
    // SYSTEM and the GLOBAL customer tenant are constants a caller has to
    // recognise; hiding them from examples would make the docs less usable.
    const document = documentWith({
      '/a': { get: { summary: 'x', description: 'tenant 00000000-0000-0000-0000-000000000000 or 50000000-0000-0000-0000-000000000000' } },
    });

    expect(checkExampleHygiene(document)).toEqual([]);
  });

  it('FAILS when a seeded credential identity leaks into an example', () => {
    const violations = checkExampleHygiene(
      documentWith({ '/a': { get: { summary: 'x', description: 'key 70000000-0000-0000-0000-000000000001' } } }),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('70000000-0000-0000-0000-000000000001');
  });

  it('reports each distinct violation once, not once per occurrence', () => {
    const document = documentWith({
      '/a': { get: { summary: 'x', description: 'ops@arcaai.com' } },
      '/b': { get: { summary: 'y', description: 'ops@arcaai.com again' } },
    });

    expect(checkExampleHygiene(document)).toHaveLength(1);
  });
});

describe('the documentation-quality ratchet', () => {
  const manifest = { routes: [manifestRoute({ path: '/api/v1/a' }), manifestRoute({ path: '/api/v1/b', handler: 'get' })] };
  const UNDOCUMENTED = { summary: 'a', responses: { '200': {} } };

  function docWithDescriptions(count: number): OpenApiDocument {
    return documentWith({
      '/api/v1/a': { get: count > 0 ? DOCUMENTED_OPERATION : UNDOCUMENTED },
      '/api/v1/b': { get: count > 1 ? DOCUMENTED_OPERATION : UNDOCUMENTED },
    });
  }

  const strict = { withoutSummary: 0, withoutDescription: 0, withoutFailureMode: 0 };

  it('passes when everything is documented', () => {
    const report = checkOpenApiCoverage(docWithDescriptions(2), manifest, strict);

    expect(report.withoutDescription).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('FAILS when an operation ships with no description', () => {
    const report = checkOpenApiCoverage(docWithDescriptions(1), manifest, strict);

    expect(report.withoutDescription).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('went BACKWARDS');
    expect(report.failures[0]).toContain('operations with no description: 1 (ratchet allows 0)');
  });

  it('FAILS when an operation declares no failure mode', () => {
    const report = checkOpenApiCoverage(docWithDescriptions(2), manifest, { ...strict, withoutFailureMode: 0 });
    const noFourXx = checkOpenApiCoverage(
      documentWith({ '/api/v1/a': { get: { summary: 'a', description: 'd', tags: ['t'], responses: { '200': {} } } } }),
      { routes: [manifestRoute({ path: '/api/v1/a' })] },
      strict,
    );

    expect(report.failures).toEqual([]);
    expect(noFourXx.failures[0]).toContain('operations with no 4xx response: 1 (ratchet allows 0)');
  });

  it('tells the reader how to resolve it rather than just failing', () => {
    const report = checkOpenApiCoverage(docWithDescriptions(0), manifest, strict);

    expect(report.failures[0]).toContain('@ApiOperation');
    expect(report.failures[0]).toContain('raise QUALITY_RATCHET');
  });

  it('passes at the repo-wide baseline it actually ships with', () => {
    // A small fixture can never exceed the real ratchet, so this asserts the
    // shipped defaults are a ceiling and not accidentally zero.
    const report = checkOpenApiCoverage(docWithDescriptions(0), manifest);

    expect(QUALITY_RATCHET.withoutDescription).toBeGreaterThan(0);
    expect(report.failures).toEqual([]);
  });
});
