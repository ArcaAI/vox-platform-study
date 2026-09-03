/**
 * Route manifest loader + case generation helpers.
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

export type SkipReason = 'streaming' | 'auth-endpoint';

/**
 * Routes deliberately excluded from the sweep. Currently: NONE.
 *
 * - `streaming`: SSE routes. Every assertion here expects a guard REJECTION, which happens
 *   before the stream opens — but if the guard were to let one through, the response would
 *   never end and the sweep would hang. The per-request timeout already bounds that, so these
 *   are kept IN the sweep and a timeout is reported as a finding, not silently dropped.
 * - `auth-endpoint`: the credential-minting endpoints the sweep itself depends on. Sweeping
 *   them with a valid credential is safe (they are rejections too), so none are excluded.
 *
 * ## Why `apiExcluded` is NOT a skip reason — do not reinstate it
 *
 * This predicate used to skip `apiExcluded` routes, justified as "not part of the public HTTP
 * surface". That premise is FALSE. `@ApiExcludeController()` / `@ApiExcludeEndpoint()` only
 * hide a route from the generated OpenAPI DOCUMENT. The route is still mounted, still served
 * over HTTP, and still runs the full guard chain — so it is still an authorization surface,
 * and an attacker does not consult `openapi.json` before sending a request.
 *
 * Documentation visibility and authorization reachability are orthogonal. `apiExcluded` is the
 * right oracle for the FORMER (see `packages/vox-node-codegen/src/surface.ts`, which uses it to
 * tell a deliberate doc omission from a stale artifact) and carries no information about the
 * latter.
 *
 * The routes it covers are precisely the ones this sweep most needs: every `/internal/*`
 * controller carries `@ApiExcludeController()` — including the 24 `@Public()` routes assertion
 * A5b proves are service-token-gated rather than publicly reachable — and the redirect
 * shims carry `@ApiExcludeEndpoint()` while deliberately REPRODUCING their target's
 * `@Authorize()`/`@ForbidApiKey()` decorators, a reproduction nothing else verifies.
 *
 * The bug was dormant only because the emitter mis-read the metadata (`=== true` against
 * `@nestjs/swagger`'s wrapped `{ disable: true }` / `[true]` shapes), so the flag was always
 * `false` and the predicate skipped nothing. Once made the flag truthful, 70 of 657
 * routes would have silently dropped out of the sweep — the exact "silent truncation" the
 * predicate below exists to prevent.
 *
 * The list stays expressed as a predicate so any future exclusion must state its reason
 * explicitly — silent truncation is worse than a gap.
 */
export function skipReasonFor(_r: ManifestRoute): SkipReason | null {
  return null;
}

export function isStreamingRoute(r: ManifestRoute): boolean {
  return r.method === 'GET' && /\/stream$/.test(r.path);
}
