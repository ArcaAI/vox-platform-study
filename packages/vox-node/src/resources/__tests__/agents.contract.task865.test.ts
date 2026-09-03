/**
 * TASK-865 — CONTRACT CONFORMANCE for `hope.agents`, against the shipped
 * `apps/api/route-manifest.json` (the authorization oracle).
 *
 * The routes are TASK-863's to ship. Until they appear in the manifest this
 * suite SKIPS ITSELF (not fails): a red test here would only say "863 has not
 * merged", which the orchestrator already knows. The moment the manifest
 * carries `/api/v1/agents`, every assertion below runs unchanged — so the SDK
 * cannot stay self-consistent while drifting from the gateway.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PLANE_ROUTES } from '../agents';

interface ManifestRoute {
  method: string;
  path: string;
  isPublic: boolean;
  apiKeyForbidden: boolean;
  apiKeyScopes: string[] | null;
  svcScopes: string[] | null;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error(`could not locate the repo root above ${process.cwd()}`);
    dir = parent;
  }
}

function loadManifest(): ManifestRoute[] {
  const raw = JSON.parse(readFileSync(join(findRepoRoot(), 'apps', 'api', 'route-manifest.json'), 'utf8')) as unknown;
  const rows = Array.isArray(raw) ? raw : ((raw as { routes?: unknown }).routes as unknown);
  if (!Array.isArray(rows)) throw new Error('route-manifest.json: unrecognized shape');
  return rows as ManifestRoute[];
}

const MANIFEST = loadManifest();
const find = (method: string, path: string) => MANIFEST.find((r) => r.method === method && r.path === path);

/** TODO(TASK-863): remove the skip once the agent routes ship in the manifest. */
const AGENT_ROUTES_SHIPPED = find('GET', '/api/v1/agents') !== undefined;

describe.skipIf(!AGENT_ROUTES_SHIPPED)('every route hope.agents calls exists in the shipped route manifest', () => {
  it.each(AGENT_PLANE_ROUTES)('$method $path', ({ method, path }) => {
    expect(find(method, path)).toBeDefined();
  });

  it.each(AGENT_PLANE_ROUTES)('$method $path is the business plane: API key allowed, no service-account scope', ({ method, path }) => {
    const route = find(method, path)!;
    expect(route.isPublic).toBe(false);
    expect(route.apiKeyForbidden).toBe(false);
    expect(route.svcScopes ?? []).toEqual([]);
  });
});

describe('AGENT_PLANE_ROUTES', () => {
  it('names the five TASK-863 §3.5 invocation-plane routes', () => {
    expect(AGENT_PLANE_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/v1/agents',
      'GET /api/v1/agents/{slug}',
      'POST /api/v1/agents/{slug}/invocations',
      'POST /api/v1/agents/{slug}/speech',
      'POST /api/v1/agents/{slug}/transcriptions',
    ]);
  });
});
