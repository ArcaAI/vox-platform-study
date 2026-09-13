import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SECURITY_SCHEME_BEARER, securityForRoute } from '../openapi/operation-security';
import type { RouteAuthorizationFacts } from '../openapi/operation-security';

/**
 * TASK-971 lane F (finding F-F2) — the artifact half.
 *
 * `apps/api/route-manifest.json` is the authorization ORACLE
 * (`.claude/rules/05-nestjs-api.md` §API Test Standard). This suite asserts that
 * the committed `openapi.json` publishes, for EVERY documented operation,
 * exactly the credential classes the oracle says can reach it — not a sample.
 *
 * Before TASK-971 it could not: every business operation carried
 * `[{bearer},{bearer}]` (`bearer` twice, 647 of 665 operations) while the
 * registered `api-key` and `service-account` schemes were referenced by zero
 * operations, so the reference told a developer to use a JWT on routes their
 * API key was minted for.
 *
 * The join is `operationId` = `<Controller>_<handler>`, which is Nest's default
 * factory and the same pair the manifest keys on. It is asserted TOTAL below: a
 * documented operation with no manifest entry means the join broke, and a silent
 * skip there would hide exactly the operations whose security nobody checked.
 */

const OPENAPI_PATH = resolve(__dirname, '..', '..', 'openapi.json');
const MANIFEST_PATH = resolve(__dirname, '..', '..', 'route-manifest.json');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

interface ManifestRoute extends RouteAuthorizationFacts {
  controller: string;
  handler: string;
  method: string;
  path: string;
  apiExcluded: boolean;
}

interface DocumentedOperation {
  key: string;
  operationId: string;
  security?: Record<string, string[]>[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const document = readJson<{
  components?: { securitySchemes?: Record<string, unknown> };
  paths: Record<string, Record<string, { operationId?: string; security?: Record<string, string[]>[] }>>;
}>(OPENAPI_PATH);

const manifest = readJson<{ routes: ManifestRoute[] }>(MANIFEST_PATH);

const routesByOperationId = new Map(manifest.routes.map((route) => [`${route.controller}_${route.handler}`, route]));

const operations: DocumentedOperation[] = [];
for (const [path, item] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
    operations.push({
      key: `${method.toUpperCase()} ${path}`,
      operationId: operation.operationId ?? '',
      security: operation.security,
    });
  }
}

describe('openapi.json — per-operation security', () => {
  it('documents at least the whole published surface (sanity: the artifact is not empty)', () => {
    expect(operations.length).toBeGreaterThan(600);
  });

  it('joins every documented operation to the route manifest', () => {
    const unmatched = operations.filter((operation) => !routesByOperationId.has(operation.operationId)).map((operation) => operation.key);

    expect(unmatched).toEqual([]);
  });

  it('publishes exactly the credential classes the route manifest says can reach each operation', () => {
    const mismatches: string[] = [];

    for (const operation of operations) {
      const route = routesByOperationId.get(operation.operationId);
      if (!route) continue;

      const expected = securityForRoute(route);
      const actual = operation.security;

      if (JSON.stringify(actual ?? null) !== JSON.stringify(expected ?? null)) {
        mismatches.push(`${operation.key} — expected ${JSON.stringify(expected ?? null)}, got ${JSON.stringify(actual ?? null)}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('never repeats a security scheme within one operation', () => {
    const repeated: string[] = [];

    for (const operation of operations) {
      const names = (operation.security ?? []).flatMap((requirement) => Object.keys(requirement));
      if (names.length !== new Set(names).size) {
        repeated.push(`${operation.key} — ${JSON.stringify(names)}`);
      }
    }

    expect(repeated).toEqual([]);
  });

  it('names only schemes that are registered in components.securitySchemes', () => {
    const registered = new Set(Object.keys(document.components?.securitySchemes ?? {}));
    const unregistered = new Set<string>();

    for (const operation of operations) {
      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) {
          if (!registered.has(name)) unregistered.add(`${operation.key} — ${name}`);
        }
      }
    }

    expect([...unregistered]).toEqual([]);
  });

  it('references the api-key and service-account schemes it registers', () => {
    const named = new Set(operations.flatMap((operation) => (operation.security ?? []).flatMap((requirement) => Object.keys(requirement))));

    expect(named).toContain(SECURITY_SCHEME_BEARER);
    expect(named).toContain('api-key');
    expect(named).toContain('service-account');
  });
});
