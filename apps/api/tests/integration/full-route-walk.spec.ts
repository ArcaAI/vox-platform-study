/**
 * Full-route walker.
 *
 * Boots the harness in `apps/api/tests/helpers/test-app-module.ts`,
 * enumerates every controller route via `DiscoveryService` +
 * `MetadataScanner`, and asserts the global `APP_GUARD` contract on
 * the LIVE route table:
 *
 *   - Routes with `@Public()` (`SKIP_AUTH_KEY === true`)
 *     → MUST NOT respond 401 to an unauthenticated probe.
 *   - Every other route → MUST respond 401 to an unauthenticated probe.
 *
 * This is the "third leg" — the static metadata walker and the
 * synthetic-module runtime walker in `auth-coverage.spec.ts` already verify
 * the metadata + guard CONTRACT respectively. The piece they couldn't cover
 * (because booting `AppModule` in test was infeasible until the harness in
 * `test-app-module.ts` existed) is verifying the GUARD ACTUALLY RUNS on
 * every real route in the live route table — a regression where a route is
 * present in metadata but somehow exempt from the guard at runtime
 * (e.g. a future custom controller wires its own `@UseGuards()` that
 * silently overrides `APP_GUARD`) would be invisible to both prior
 * walkers.
 *
 * ## Status — blocked (deferred)
 *
 * `createTestApp()` does NOT currently return — `compile()` hangs after all
 * `InstanceLoader` dependency-init logs are emitted even with the documented
 * override surface applied (see `test-app-module.spec.ts` for the trace
 * evidence). Until that blocker is cleared this walker has nothing to point
 * at, so the suite below is pinned `it.skip(...)` to keep the file in tree
 * (and CI green) while making the deferral explicit: removing the `.skip`
 * is the entire verification step once the blocker lands.
 *
 * The implementation outline that ships under `.skip` is the
 * exact code we will exercise once `createTestApp()` returns —
 * keeping it inline (rather than commented-out or in a separate doc)
 * means the next agent can flip a single character to validate the
 * harness end-to-end.
 *
 * ## Why not stub more aggressively
 *
 * `test-app-module.ts` documents the current override surface; deepening it
 * to "shadow every transitive ioredis consumer" risks the walker silently
 * bypassing controllers whose modules failed to boot. That defeats the
 * third-leg argument, so no production code is modified to make this pass —
 * the fix belongs in a sibling piece of work and re-running this walker is
 * the verification gate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import request from 'supertest';

import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { createTestApp } from '../helpers/test-app-module';

interface DiscoveredRoute {
  controllerName: string;
  methodName: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
  path: string;
  isPublic: boolean;
}

function mapRequestMethod(code: number): DiscoveredRoute['httpMethod'] | null {
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
    default:
      return null;
  }
}

function readControllerPath(controllerClass: object): string {
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

/**
 * Replace path params (`:id`, `:name`, etc.) with synthetic
 * placeholders. The walker probes routes WITHOUT credentials so the
 * handler is never reached — only the guard runs — but the request
 * still has to match the route pattern. UUID-shaped placeholders
 * cover routes that use `ParseUUIDPipe`; "x" covers free-form params.
 */
function instantiatePath(template: string): string {
  return template.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
    if (/id$/i.test(name)) return '00000000-0000-0000-0000-000000000000';
    return 'x';
  });
}

describe.skip('TASK-309 AC-5 — full-route walker (deferred until AC-4 unblocks)', () => {
  let app: INestApplication;
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    app = await createTestApp();

    const discoveryService = app.get(DiscoveryService);
    const metadataScanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);

    const controllers = discoveryService.getControllers();
    const hits: DiscoveredRoute[] = [];

    for (const wrapper of controllers) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      for (const methodName of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[methodName];
        if (typeof methodRef !== 'function') continue;

        const httpMethodCode = Reflect.getMetadata(METHOD_METADATA, methodRef);
        if (httpMethodCode === undefined) continue;

        const httpMethod = mapRequestMethod(httpMethodCode as number);
        if (!httpMethod) continue;

        const isPublic = reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [methodRef, metatype]) === true;

        hits.push({
          controllerName: metatype.name,
          methodName,
          httpMethod,
          path: joinPath(readControllerPath(metatype), readMethodPath(methodRef)),
          isPublic,
        });
      }
    }

    routes = hits;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('discovers a non-empty list of HTTP routes from the live AppModule', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every non-@Public() route responds 401 without an Authorization header', async () => {
    const violations: Array<{ route: DiscoveredRoute; status: number }> = [];

    for (const route of routes) {
      if (route.isPublic) continue;

      const url = instantiatePath(route.path);
      const probe = request(app.getHttpServer()) as unknown as Record<
        string,
        (path: string) => { send: (body?: unknown) => Promise<{ status: number }> }
      >;
      const verb = route.httpMethod.toLowerCase();
      const send = probe[verb]?.(url).send;
      if (!send) continue;
      const res = await send.call(probe[verb]!(url));

      if (res.status !== 401) {
        violations.push({ route, status: res.status });
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  - ${v.route.httpMethod} ${v.route.path} on ${v.route.controllerName}.${v.route.methodName} → ${v.status} (expected 401)`,
      );
      throw new Error(
        `${violations.length} authenticated route(s) DID NOT return 401 to an unauthenticated probe:\n` +
          `${lines.join('\n')}\n\n` +
          `Either the route is missing @Authorize() / @CanXxx() metadata or a local @UseGuards() ` +
          `is overriding the global APP_GUARD. Both bypass the W4b guard contract.`,
      );
    }
  });

  it('every @Public() route does NOT respond 401 to the unauthenticated probe', async () => {
    const violations: Array<{ route: DiscoveredRoute; status: number }> = [];

    for (const route of routes) {
      if (!route.isPublic) continue;

      const url = instantiatePath(route.path);
      const probe = request(app.getHttpServer()) as unknown as Record<
        string,
        (path: string) => { send: (body?: unknown) => Promise<{ status: number }> }
      >;
      const verb = route.httpMethod.toLowerCase();
      const send = probe[verb]?.(url).send;
      if (!send) continue;
      const res = await send.call(probe[verb]!(url));

      if (res.status === 401) {
        violations.push({ route, status: res.status });
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  - ${v.route.httpMethod} ${v.route.path} on ${v.route.controllerName}.${v.route.methodName} → 401 (expected NOT 401)`,
      );
      throw new Error(
        `${violations.length} @Public() route(s) returned 401:\n` +
          `${lines.join('\n')}\n\n` +
          `Either the route is misannotated or APP_GUARD didn't honour SKIP_AUTH_KEY metadata.`,
      );
    }
  });
});
