/**
 * TASK-983 lane I — the scope every documented request needs, pinned to the gateway's own
 * `route-manifest.json`.
 *
 * Why this exists: a seeded key opened an STT stream session and then answered
 * `403 API key does not have required scope(s): agent:invocation:write` on the very next
 * request in the same walkthrough. "An API key holding the business-plane scopes" is not a
 * contract — a developer cannot mint a key from it. Every lane now prints the EXACT scope, and
 * this test is what stops those strings from drifting away from the routes they describe.
 *
 * The manifest is the authorization ORACLE (`05-nestjs-api.md` §API Test Standard); it is read
 * here READ-ONLY, from the sibling app, exactly as the e2e authz matrix reads it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_KEY_MINT_NOTE, GATEWAY_ROUTE_SCOPES, scopeNote, type GatewayRouteKey } from '../gateway-scopes';

interface ManifestRoute {
  method: string;
  path: string;
  apiKeyScopes: string[] | null;
  svcScopes: string[] | null;
}

const MANIFEST_PATH = join(__dirname, '../../../../../api/route-manifest.json');

const manifest: { routes: ManifestRoute[] } = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { routes: ManifestRoute[] };

function findRoute(method: string, path: string): ManifestRoute | undefined {
  return manifest.routes.find((route) => route.method === method && route.path === path);
}

const ENTRIES = Object.entries(GATEWAY_ROUTE_SCOPES) as Array<[GatewayRouteKey, (typeof GATEWAY_ROUTE_SCOPES)[GatewayRouteKey]]>;

describe('every documented route exists in the gateway route manifest', () => {
  it('the manifest itself was readable (otherwise every case below is vacuous)', () => {
    expect(manifest.routes.length).toBeGreaterThan(100);
  });

  it.each(ENTRIES)('%s', (_key, entry) => {
    const route = findRoute(entry.method, entry.path);
    expect(route, `${entry.method} ${entry.path} is not a route this gateway serves`).toBeDefined();
    expect(route!.apiKeyScopes, `${entry.path} declares no API-key scope`).toContain(entry.apiKeyScope);
    expect(route!.svcScopes, `${entry.path} declares no service-account scope`).toContain(entry.serviceAccountScope);
  });
});

describe('scopeNote', () => {
  it('names each distinct scope once, in the order given', () => {
    expect(scopeNote(['agentInvocations', 'agentTranscriptions'])).toBe('Scopes this lane needs: agent:invocation:write');
  });

  it('joins several distinct scopes', () => {
    expect(scopeNote(['agentTranscriptions', 'transcriptionJobStream'])).toBe(
      'Scopes this lane needs: agent:invocation:write + stt:transcription:write',
    );
  });

  it('refuses an empty selection rather than printing a scope-less promise', () => {
    expect(() => scopeNote([])).toThrow(/at least one/i);
  });
});

describe('the mint note tells a developer where a scoped key comes from', () => {
  it('names the console screen and the admin route', () => {
    expect(API_KEY_MINT_NOTE).toContain('/api-keys');
    expect(API_KEY_MINT_NOTE).toContain('admin/api-keys');
    expect(API_KEY_MINT_NOTE).toContain('scopes');
  });
});
