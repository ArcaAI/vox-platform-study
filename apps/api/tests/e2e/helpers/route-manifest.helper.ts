/**
 * TASK-776 — Route manifest loader + case generation helpers.
 *
 * `apps/api/route-manifest.json` is emitted by a Nest ModulesContainer walk that uses the
 * SAME reflector lookups `UnifiedAuthGuard` uses, so it records exactly what the guard sees
 * (including class-level decorators). That makes it an authorization ORACLE: the declared
 * metadata for every route. These helpers turn it into executable conformance cases.
 *
 * Owned by task-776-route-authz-matrix.spec.ts. Do NOT edit the manifest or its emitter here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ManifestRoute {
  controller: string;
  handler: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  routePath: string;
  svcScopes: string[];
  forbidServiceAccount: boolean;
  apiKeyForbidden: boolean;
  apiKeyScopes: string[];
  requiredPermissions: Array<{ action: string; subject: string }> | null;
  isPublic: boolean;
  permissionMode: 'AND' | 'OR' | null;
  requiresIfMatch: boolean;
  apiExcluded: boolean;
}

export interface RouteManifest {
  globalPrefix: string;
  routes: ManifestRoute[];
}

/** A well-formed UUIDv4 that is guaranteed not to exist in the seeded test DB. */
export const NONEXISTENT_ID = '00000000-dead-4000-8000-000000000776';

export function loadRouteManifest(): RouteManifest {
  // apps/api/tests/e2e/helpers -> apps/api
  const path = join(__dirname, '..', '..', '..', 'route-manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as RouteManifest;
}

/** Replace every `{param}` placeholder with a syntactically valid, non-existent id. */
export function substitutePathParams(path: string): string {
  return path.replace(/\{[^}]+\}/g, NONEXISTENT_ID);
}

/** Stable, human-readable route identity used in every failure message. */
export function routeLabel(r: ManifestRoute): string {
  return `${r.method} ${r.path} (${r.controller}.${r.handler})`;
}

export type SkipReason = 'apiExcluded' | 'streaming' | 'auth-endpoint';

/**
 * Routes deliberately excluded from the sweep.
 *
 * - `apiExcluded`: not part of the public HTTP surface.
 * - `streaming`: SSE routes. Every assertion here expects a guard REJECTION, which happens
 *   before the stream opens — but if the guard were to let one through, the response would
 *   never end and the sweep would hang. The per-request timeout already bounds that, so these
 *   are kept IN the sweep and a timeout is reported as a finding, not silently dropped.
 * - `auth-endpoint`: the credential-minting endpoints the sweep itself depends on. Sweeping
 *   them with a valid credential is safe (they are rejections too), so none are excluded.
 *
 * Net effect: only `apiExcluded` routes are skipped. The list is expressed as a predicate so
 * any future exclusion must state its reason explicitly — silent truncation is worse than a gap.
 */
export function skipReasonFor(r: ManifestRoute): SkipReason | null {
  if (r.apiExcluded) return 'apiExcluded';
  return null;
}

export function isStreamingRoute(r: ManifestRoute): boolean {
  return r.method === 'GET' && /\/stream$/.test(r.path);
}
