/**
 * TASK-850 lane B — CONTRACT CONFORMANCE.
 *
 * The other suite asserts the SDK calls the paths it means to. This one asserts
 * those paths are the ones the GATEWAY actually ships, by reading
 * `apps/api/route-manifest.json` — the authorization oracle
 * (`.claude/rules/05-nestjs-api.md` §API Test Standard) — off disk.
 *
 * Without this, an SDK is only ever self-consistent: every path assertion in
 * the sibling suite would keep passing after lane A renamed a route. Here a
 * rename is a red test.
 *
 * The manifest is read, never regenerated: regenerating it is lane A's job and
 * a diff here is a REPORT, not a fix.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESERVED_RUN_IDENTITY_KEYS } from '../../core/run-identity';
import { WORKFLOW_PLANE_ROUTES } from '../workflows';

interface ManifestRoute {
  method: string;
  path: string;
  isPublic: boolean;
  requiredPermissions: string[][] | null;
  apiKeyForbidden: boolean;
  apiKeyScopes: string[] | null;
  svcScopes: string[] | null;
}

/**
 * Vitest runs with this package as its root (`packages/vox-node`), so the repo
 * root is two levels up. Derived from `process.cwd()` rather than
 * `import.meta.url` because this package's tsconfig emits CommonJS, where
 * `import.meta` is a hard type error.
 */
const REPO_ROOT = resolve(process.cwd(), '..', '..');

function loadManifest(): ManifestRoute[] {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'api', 'route-manifest.json'), 'utf8')) as unknown;
  const rows = Array.isArray(raw) ? raw : ((raw as { routes?: unknown }).routes as unknown);
  if (!Array.isArray(rows)) throw new Error('route-manifest.json: unrecognized shape');
  return rows as ManifestRoute[];
}

const MANIFEST = loadManifest();

function find(method: string, path: string): ManifestRoute | undefined {
  return MANIFEST.find((r) => r.method === method && r.path === path);
}

describe('every route this SDK calls exists in the shipped route manifest', () => {
  it.each(WORKFLOW_PLANE_ROUTES)('$method $path', ({ method, path }) => {
    expect(find(method, path)).toBeDefined();
  });
});

describe('the credential class the SDK assumes is the one the gateway enforces', () => {
  it.each(WORKFLOW_PLANE_ROUTES)('$method $path accepts an API key and NOT a service account', ({ method, path }) => {
    const route = find(method, path)!;
    // API-key reachable — this plane is the business plane.
    expect(route.apiKeyForbidden).toBe(false);
    expect(route.apiKeyScopes?.length ?? 0).toBeGreaterThan(0);
    // `svcScopes: []` = deny-by-default for a service account. This is exactly
    // why `assertApiKeyPlane()` refuses early instead of shipping a 403.
    expect(route.svcScopes).toEqual([]);
  });

  it('pins the scope each plane requires', () => {
    expect(find('POST', '/api/v1/workflows/{slug}/runs')!.apiKeyScopes).toEqual(['workflow:run:write']);
    expect(find('GET', '/api/v1/workflows')!.apiKeyScopes).toEqual(['workflow:definition:read']);
    expect(find('GET', '/api/v1/workflows/{slug}/runs/{runId}/stream')!.apiKeyScopes).toEqual(['workflow:run:read']);
    // The consultation plane's scope is deliberately OUTSIDE the `workflow:` prefix,
    // so a key holding bare `workflow` cannot inherit the clinical-write plane.
    expect(find('POST', '/api/v1/consultations/{consultationId}/workflows/{slug}/runs')!.apiKeyScopes).toEqual(['workflows:execute']);
    expect(find('GET', '/api/v1/consultations/{consultationId}/workflows')!.apiKeyScopes).toEqual(['workflows:execute']);
  });

  it('pins the ability each plane requires — "may run" and "may run against a consultation" are different powers', () => {
    expect(find('POST', '/api/v1/workflows/{slug}/runs')!.requiredPermissions).toEqual([['create', 'WorkflowRun']]);
    expect(find('POST', '/api/v1/consultations/{consultationId}/workflows/{slug}/runs')!.requiredPermissions).toEqual([
      ['execute', 'ConsultationWorkflow'],
    ]);
  });

  it('none of these routes is public — the SDK always sends a credential', () => {
    for (const { method, path } of WORKFLOW_PLANE_ROUTES) {
      expect(find(method, path)!.isPublic).toBe(false);
    }
  });
});

describe("the SDK's reserved-key list is the gateway's list", () => {
  it('matches exposure-palette-policy.ts verbatim', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'applications', 'src', 'services', 'workflow-exposure', 'exposure-palette-policy.ts'),
      'utf8',
    );
    const match = /RESERVED_RUN_IDENTITY_KEYS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
    expect(match, 'RESERVED_RUN_IDENTITY_KEYS not found in exposure-palette-policy.ts').toBeTruthy();
    const gatewayKeys = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...RESERVED_RUN_IDENTITY_KEYS]).toEqual(gatewayKeys);
  });
});
