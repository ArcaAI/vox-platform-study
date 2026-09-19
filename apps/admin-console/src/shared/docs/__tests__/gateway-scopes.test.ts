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
import {
  API_KEY_MINT_NOTE,
  GATEWAY_ROUTE_SCOPES,
  RATE_LIMIT_NOTE,
  scopeNote,
  serviceAccountNotes,
  type GatewayRouteKey,
} from '../gateway-scopes';

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

/**
 * TASK-991 wave 2, lane E — two things the scope column alone got wrong.
 *
 * A declared `svcScopes` entry only says the scope CHECK will pass. Several STT job routes then
 * resolve an owner from the request user (`transcription-job.controller.ts:219,266`), and
 * `UnifiedAuthGuard` deliberately never writes a service account onto `user` — so a token with the
 * right scope is refused by the handler. The run stream ticket is the same shape
 * (`workflows.controller.ts:383-384`). Both are annotated rather than removed, because the scope
 * IS what the gateway declares and deleting the row would hide the route instead of explaining it.
 */
describe('serviceAccountNote — where the declared scope overstates the route', () => {
  it('the batch upload tells a machine caller it must name the clinician', () => {
    expect(GATEWAY_ROUTE_SCOPES.transcriptionUpload.serviceAccountNote).toMatch(/clinician/i);
  });

  it('the run stream ticket is annotated as JWT/API-key only', () => {
    const note = GATEWAY_ROUTE_SCOPES.workflowRunStreamTicket.serviceAccountNote;
    expect(note).toMatch(/JWT or API key only/i);
    expect(note).toMatch(/401/);
  });

  it('collects the distinct notes for a lane, and stays empty where the scope is the whole answer', () => {
    expect(serviceAccountNotes(['transcriptionUpload', 'transcriptionJobStream'])).toHaveLength(1);
    expect(serviceAccountNotes(['agentInvocations', 'agentSpeech'])).toEqual([]);
  });
});

/**
 * A 429 is the LIMITER, and its budget is deployment-configured (`RateLimitConfigService` reads
 * `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS`), so the only honest answer is the header the
 * gateway sets on every response — never a number copied out of this repo.
 */
describe('the rate-limit note points at the header instead of a number', () => {
  it('names RateLimit-Policy and says the budget is per deployment', () => {
    expect(RATE_LIMIT_NOTE).toContain('RateLimit-Policy');
    expect(RATE_LIMIT_NOTE).toMatch(/429/);
    expect(RATE_LIMIT_NOTE).toMatch(/per deployment/i);
  });

  it('hardcodes no request budget', () => {
    // `q=<requests>;w=<seconds>` stays a template. A filled-in `q=10;w=60` here would be a promise
    // about somebody else's cluster — the whole reason this note points at the response header.
    expect(RATE_LIMIT_NOTE).toContain('q=<requests>;w=<seconds>');
    expect(RATE_LIMIT_NOTE).not.toMatch(/[qw]=\d/);
  });
});
