/**
 * Boot-time audit: policy **A1** — a non-`admin` (business) route
 * carries the auth model **JWT + API key**.
 *
 * The point of A1 is developer reach: an integrator holding a scoped tenant
 * API key should be able to drive the platform's business capabilities
 * (transcribe, summarize, run a consultation, read their own usage) without a
 * human session. Its counterpart A2 — `admin/*` ⇒ JWT only — is,
 * and this audit deliberately says nothing about that plane.
 *
 * ─── Why an audit and not just a sweep of decorators ───────────────────────
 *
 * Because A1 is not blanket. Applying it to every business route would open a
 * clinician's voice biometrics and personal writing model to a long-lived
 * static credential — no MFA, no session expiry, no revocation-on-logout. So
 * A1 ships as **default-convert with a narrow, named exemption list**, and the
 * only way to keep `@ForbidApiKey()` on a business route is to appear in
 * `BUSINESS_PLANE_KEY_FORBIDDEN` below. That makes each exemption reviewable
 * in one place instead of inferable from 18 scattered decorators.
 *
 * This is the same shape as `RESERVED_INTERNAL_SCOPE_CONTROLLERS`
 * (`api-key-scope-audit.ts`): a POLICED exemption, not a hole.
 *
 * ─── The deferral set is gone ( close-out) ────────────────
 *
 * A second set, `BUSINESS_PLANE_KEY_FORBIDDEN_DEFERRED`, once named
 * `MonitoringController` and `ApiHealthController` — two administrative
 * capabilities sitting on business prefixes that A1 had no opinion about while
 * was in flight. has landed (commit `7155c14d4`) and both are
 * now handled structurally rather than by name:
 *
 * - `MonitoringController` moved to `@Controller('admin/monitoring')`, so the
 *   `ADMIN_ROUTE_RE` skip below covers it — it is A2's plane now.
 * - `ApiHealthController` kept only its four `@Public()` probes (the CASL-gated
 *   ops routes became `AdminHealthServicesController` at `admin/health/services`),
 *   so the `@Public()` skip below covers it.
 *
 * The set had therefore become stale-but-inert, which is the worst state for a
 * named exemption list: it looked like a live carve-out while covering nothing.
 * Deleted rather than left to rot. Both controllers are pinned as `'FORBID'` in
 * `ADMIN_SCOPED_CONTROLLERS` (`admin-scope-audit.ts`) and policed by A2's
 * derived sweep.
 *
 * ─── What this does NOT check ──────────────────────────────────────────────
 *
 * Presence of a declaration is `auditEveryApiKeyReachableRouteDeclaresScopes`'s
 * job and stays there; this audit only judges the VALUE
 * `@ForbidApiKey()` on the business plane. A converted controller passes here
 * the moment it stops forbidding — whether the scope it now declares is the
 * RIGHT one is pinned by `business-plane-apikey-exemptions.test.ts` and the
 * per-controller e2e contract, not by a name list that would have to be
 * maintained twice.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { API_KEY_FORBIDDEN, SKIP_AUTH_KEY } from '@arcaai/applications';

// Side-effect import — patches @Public() onto third-party controllers we cannot
// decorate at the source. Must run before the walk, exactly as
// `admin-route-permission-audit.ts` requires.
import './third-party-public-routes';

/**
 * The business-plane controllers that keep `@ForbidApiKey()`, each for a
 * reason recorded in an `API-KEY-NOTE` at the decorator itself:
 *
 * - `AuthController` — the credential-issuing plane. A key authenticating
 *   `logout`/`refresh`/`me` is circular, and `stream-ticket` mints the SSE/WS
 *   tickets the whole streaming posture rests on.
 * - `VoiceProfileController` — voice biometrics. Enrolment audio is a
 *   biometric identifier; no static-credential path to it.
 * - `DnaWritingStyleController` — a clinician's personal writing model, with
 *   owner/doctor checks that live in the service (so the CASL decorator
 *   understates the gate).
 *
 * Adding a name here is an OWNER decision, not a way to make a boot failure go
 * away: the alternative — declaring the scope A1 asks for — is one line.
 */
export const BUSINESS_PLANE_KEY_FORBIDDEN: ReadonlySet<string> = new Set([
  'AuthController',
  'VoiceProfileController',
  'DnaWritingStyleController',
  // the 308 shim for the retired `voice-profile` prefix. A shim copies
  // its target's auth posture verbatim, so it inherits `VoiceProfileController`'s
  // exemption and must inherit its entry here too — otherwise the audit reads a
  // faithful shim as an unexplained hole and refuses to boot, which is exactly
  // what it did. Dies with the shim in `ALL-2.0.0`.
  //
  // API-KEY-NOTE: voice biometrics. Same reason as the target: a long-lived static
  // credential must not reach an enrolment or activation surface for a user's voice.
  'VoiceProfileRedirectShimController',
]);

/** `/admin/...` — A2's plane. Matched on the JOINED route path. */
const ADMIN_ROUTE_RE = /^\/admin(\/|$)/;

export function auditBusinessPlaneApiKeyExemptions(app: INestApplicationContext): void {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();

  const offenders: string[] = [];

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: unknown[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      if (BUSINESS_PLANE_KEY_FORBIDDEN.has(ControllerClass.name)) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readControllerPath(ControllerClass);

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        // Read through the app's own Reflector with
        // `getAllAndOverride([methodRef, ControllerClass])`, so this sees
        // exactly what `UnifiedAuthGuard` sees at request time — including
        // class-level decorators, which Nest does NOT copy onto handlers.
        const forbidden = reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [methodRef, ControllerClass]);
        if (forbidden !== true) continue;

        // @Public() — authentication never runs, so there is no credential
        // class to have an opinion about. Checked AFTER the forbid read so a
        // public route carrying a stray @ForbidApiKey() is simply inert
        // rather than an offender.
        const skipAuth = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, ControllerClass]);
        const legacyPublic = reflector.getAllAndOverride<boolean>('isPublic', [methodRef, ControllerClass]);
        if (skipAuth === true || legacyPublic === true) continue;

        const fullPath = joinPath(controllerPath, readMethodPath(methodRef));
        if (ADMIN_ROUTE_RE.test(fullPath)) continue;

        const httpMethod = mapRequestMethod(httpMethodCode as number);

        offenders.push(
          `Route ${httpMethod} ${fullPath} on ${ControllerClass.name}.${methodName} is a business-plane route that carries ` +
            `@ForbidApiKey() without being named in BUSINESS_PLANE_KEY_FORBIDDEN. Policy A1 says a non-admin route is ` +
            `JWT + API key: declare @RequiredScopes('<scope>') from ` +
            `packages/applications/src/services/apiKey/apikey-scopes.registry.ts. If this surface genuinely must never be ` +
            `reachable by a long-lived static credential, add it to BUSINESS_PLANE_KEY_FORBIDDEN with an // API-KEY-NOTE ` +
            `at the decorator saying why — that is an owner decision, not a way to silence this audit.`,
        );
      }
    }
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(`refused to start — ${offenders.length} route(s) forbid API keys on the business plane without an exemption:\n${list}`);
  }
}

function readControllerPath(controllerClass: new (...args: unknown[]) => unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, controllerClass);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function readMethodPath(methodRef: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, methodRef as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function joinPath(controllerPath: string, methodPath: string): string {
  const normalize = (segment: string): string => {
    if (!segment) return '';
    return segment.startsWith('/') ? segment : `/${segment}`;
  };
  const a = normalize(controllerPath).replace(/\/+$/, '');
  const b = normalize(methodPath).replace(/\/+$/, '');
  const joined = `${a}${b}` || '/';
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function mapRequestMethod(code: number): string {
  switch (code) {
    case RequestMethod.GET:
      return 'GET';
    case RequestMethod.POST:
      return 'POST';
    case RequestMethod.PUT:
      return 'PUT';
    case RequestMethod.DELETE:
      return 'DELETE';
    case RequestMethod.PATCH:
      return 'PATCH';
    case RequestMethod.OPTIONS:
      return 'OPTIONS';
    case RequestMethod.HEAD:
      return 'HEAD';
    case RequestMethod.ALL:
      return 'ALL';
    default:
      return 'UNKNOWN';
  }
}
