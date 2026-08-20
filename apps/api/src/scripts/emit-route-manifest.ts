/**
 * TASK-773 Phase D1 — emit the gateway's ROUTE MANIFEST to disk, offline.
 *
 * The companion of `emit-openapi.ts`, and the first of the two sources
 * `packages/vox-node-codegen` cross-checks (ticket §3.1):
 *
 * | Source | Authoritative for |
 * |---|---|
 * | **this manifest** (Nest `ModulesContainer` walk) | route existence, path, HTTP verb, and the FULL authorization surface of every route — all three credential classes: `@RequiredSvcScopes`/`@ForbidServiceAccount` (service account), `@RequiredApiKeyScopes`/`@ForbidApiKey` (API key), `@Public`/`@Authorize`+`@SetPermissionMode` (JWT) — plus `@RequiresIfMatch` |
 * | `openapi.json` (`emit-openapi.ts`) | request/response TYPES, from the class-validator/`@ApiProperty` DTOs |
 *
 * ## Why this script exists at all
 *
 * The ticket's preferred shape was for the generator to do the Nest walk
 * itself. It cannot: `packages/vox-node-codegen` is a standalone build-time
 * package, and walking `ModulesContainer` means constructing the entire
 * gateway (`NestFactory.create(AppModule)`) — a dependency on `@arcaai/api`,
 * on Prisma/Redis/JWT bootstrap env, and on the compiled `nest build` output.
 * The ticket names this exact fallback ("emit a route manifest from `apps/api`
 * … and consume THAT"), which also matches how `openapi.json` is already
 * produced and checked in: the generator then runs offline in CI against two
 * committed artifacts, with no gateway boot in its own job.
 *
 * ## Fidelity
 *
 * The walk is the SAME one the boot audits perform
 * (`src/bootstrap/service-account-surface-audit.ts#walkRoutes`) — `Reflector`
 * with `getAllAndOverride([methodRef, ControllerClass])`, so it sees exactly
 * what `UnifiedAuthGuard` sees at request time, INCLUDING class-level
 * decorators (which Nest does not copy onto route handlers). It is
 * re-implemented here rather than imported because that function is private to
 * the audit module, and this script must not change audit code.
 *
 * As of TASK-776 the manifest is the ORACLE for a generated authorization
 * conformance suite, so it claims fidelity for all THREE credential classes,
 * not just the service account:
 *
 * - **service account** — `svcScopes`, `forbidServiceAccount`
 * - **API key** — `apiKeyScopes`, `apiKeyForbidden`
 * - **JWT / user** — `isPublic`, `requiredPermissions`, `permissionMode`
 *
 * Two distinctions in there are load-bearing and must NOT be collapsed:
 *
 * 1. `requiredPermissions` is `null` when the metadata is ABSENT and `[]` when
 *    a bare `@Authorize()` set an empty array. The deny-by-default boot audit
 *    treats those two differently, so the manifest has to as well.
 * 2. `isPublic` mirrors `UnifiedAuthGuard#authenticate` EXACTLY: it is the OR of
 *    `SKIP_AUTH_KEY` and the legacy string key `'isPublic'`, both read through
 *    `getAllAndOverride`. Reading only `SKIP_AUTH_KEY` would under-report the
 *    routes the guard actually lets through unauthenticated.
 *
 * Same runtime contract as `emit-openapi.ts`: run against the compiled
 * `nest build` output, no `.listen()`, no live DB/Redis/Vault, placeholder env
 * supplied by the `route-manifest` package script. See that file's header for
 * why `abortOnError: false` and the bounded `app.close()` are load-bearing,
 * and `offline-infrastructure.ts` for why the BullMQ queues this bootstrap
 * brings up need an explicit owner for their (expected) connection errors.
 *
 * Output is deterministic: routes are sorted by (path, method, controller,
 * handler), keys are emitted in a fixed order, and NOTHING time- or
 * environment-derived is written — the file is a drift-gate input, so a
 * re-run on an unchanged tree must be byte-identical.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, NestFactory, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import {
  API_KEY_FORBIDDEN,
  API_KEY_REQUIRED_SCOPES,
  PERMISSION_MODE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  SERVICE_ACCOUNT_FORBIDDEN,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  SKIP_AUTH_KEY,
} from '@arcaai/applications';
import type { PermissionMode, RequiredPermission } from '@arcaai/applications';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../app.module';
// Side-effect import — applies `@Public()` (`SKIP_AUTH_KEY`) to vendored
// third-party controllers we cannot decorate at the source (willsoto's
// `PrometheusController.index`, i.e. `/metrics`). Its own header requires
// EVERY route-walking code path to import it; without it this manifest reports
// `isPublic: false` for a route the running gateway serves unauthenticated.
import '../bootstrap/third-party-public-routes';
import { REQUIRES_IF_MATCH_KEY } from '../decorators/requiresIfMatch.decorator';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from '../global-prefix.config';
import { isControllerApiExcluded, isEndpointApiExcluded } from '../openapi/api-exclude-metadata';
import { silenceBullQueueConnectionErrors } from './offline-infrastructure';

const OUTPUT_PATH = resolve(__dirname, '..', '..', 'route-manifest.json');

/**
 * The two exclusion-decorator readers live in `../openapi/api-exclude-metadata`
 * so they can be unit-tested against the REAL `@ApiExcludeController()` /
 * `@ApiExcludeEndpoint()` decorators (this script self-executes on import, so
 * a test cannot import it). See that module for why neither decorator stores a
 * boolean and why reading them with `=== true` silently reported "nothing is
 * excluded" for all 657 routes until TASK-783.
 *
 * Load-bearing for the cross-check: a route carrying one of these is ABSENT
 * from `openapi.json` BY DESIGN, so `check-openapi-coverage.ts` can tell that
 * apart from a route that is missing its Swagger decorators — which IS a
 * documentation defect worth failing on.
 */

const HTTP_METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.SEARCH]: 'SEARCH',
  [RequestMethod.PROPFIND]: 'PROPFIND',
  [RequestMethod.PROPPATCH]: 'PROPPATCH',
  [RequestMethod.MKCOL]: 'MKCOL',
  [RequestMethod.COPY]: 'COPY',
  [RequestMethod.MOVE]: 'MOVE',
  [RequestMethod.LOCK]: 'LOCK',
  [RequestMethod.UNLOCK]: 'UNLOCK',
};

/** One route, exactly as the manifest serializes it. */
interface RouteManifestEntry {
  /** Controller class name — half of the `operationId` join key into `openapi.json`. */
  controller: string;
  /** Handler method name — the other half. `openapi.json`'s `operationId` is `<controller>_<handler>`. */
  handler: string;
  /** Uppercase HTTP verb. */
  method: string;
  /** Gateway path INCLUDING the global prefix, in OpenAPI shape (`/api/v1/admin/tenants/{id}`). */
  path: string;
  /** Same path in Nest/Express shape (`/admin/tenants/:id`), WITHOUT the global prefix — what the SDK sends. */
  routePath: string;
  /** `@RequiredSvcScopes(...)` as resolved by `Reflector.getAllAndOverride`. Sorted, deduped. */
  svcScopes: string[];
  /** `@ForbidServiceAccount()`. */
  forbidServiceAccount: boolean;
  /**
   * `@ForbidApiKey()` — the API-key credential class is denied outright,
   * checked BEFORE any scope check (`UnifiedAuthGuard`). Every `/admin/*`
   * controller is expected to carry it.
   */
  apiKeyForbidden: boolean;
  /** `@RequiredApiKeyScopes(...)`. Sorted, deduped; `[]` when absent. */
  apiKeyScopes: string[];
  /**
   * `@Authorize(...)`/`@Can*(...)` as `[action, subject]` pairs.
   * `null` = metadata ABSENT (no permission decorator at all);
   * `[]` = present but empty (a bare `@Authorize()`). Not the same thing.
   */
  requiredPermissions: [string, string][] | null;
  /** `@Public()` — mirrors the guard: `SKIP_AUTH_KEY` OR the legacy `'isPublic'` key. */
  isPublic: boolean;
  /** `@SetPermissionMode(...)` — `null` when absent (the guard then defaults to `AND`). */
  permissionMode: 'AND' | 'OR' | null;
  /** `@RequiresIfMatch()` — the 428/412 optimistic-concurrency contract. */
  requiresIfMatch: boolean;
  /** `@ApiExcludeEndpoint()`/`@ApiExcludeController()` — deliberately absent from `openapi.json`. */
  apiExcluded: boolean;
}

function readPath(target: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, target as object);
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
  return '';
}

function normalizePath(path: string): string {
  if (!path) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function joinPath(controllerPath: string, methodPath: string): string {
  const a = normalizePath(controllerPath).replace(/\/$/, '');
  const b = methodPath ? normalizePath(methodPath).replace(/\/$/, '') : '';
  return `${a}${b}` || '/';
}

/**
 * `/admin/tenants/:id` → `/admin/tenants/{id}` (OpenAPI path-template shape).
 *
 * The character class is `[A-Za-z0-9_]`, NOT `[^/]`, because that is what the
 * path-to-regexp parser underneath Nest accepts as a parameter name. Keep it
 * that way even though no route currently depends on the distinction: a
 * greedier `[^/]` silently agrees with a MALFORMED parameter name instead of
 * rendering what the router actually binds, which is exactly how a broken route
 * hides.
 *
 * It has already caught one. `TenantController` shipped
 * `@Get('code-name/:code-name')`, which binds a parameter called `code`
 * followed by the LITERAL `-name` — so the true template was
 * `/code-name/{code}-name`, the route never matched its advertised URL, and
 * `@Param('code-name')` resolved to `undefined`. This regex rendered the truth,
 * disagreed with the OpenAPI document, and the cross-check refused to generate.
 * The controller is fixed; `src/__tests__/route-param-names.test.ts` now catches
 * the class of mistake at authoring time.
 */
function toOpenApiPath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)\??/g, (_match, name: string) => `{${name}}`);
}

/** The `exclude` list `main.ts` passes to `setGlobalPrefix` — those paths keep their bare URL. */
function isPrefixExempt(routePath: string): boolean {
  const exclude = (API_GLOBAL_PREFIX_OPTIONS as { exclude?: unknown[] }).exclude ?? [];
  const bare = normalizePath(routePath);
  return exclude.some((entry) => {
    const raw = typeof entry === 'string' ? entry : ((entry as { path?: string })?.path ?? '');
    return normalizePath(raw) === bare;
  });
}

function collect(app: Awaited<ReturnType<typeof NestFactory.create>>): RouteManifestEntry[] {
  const modulesContainer = app.get(ModulesContainer);
  const reflector = app.get(Reflector);
  const metadataScanner = new MetadataScanner();
  const entries: RouteManifestEntry[] = [];
  const seen = new Set<string>();

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const ControllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!ControllerClass || !instance) continue;

      const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!proto) continue;

      const controllerPath = readPath(ControllerClass);
      const controllerExcluded = isControllerApiExcluded(ControllerClass);

      for (const handler of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[handler];
        if (typeof methodRef !== 'function') continue;

        const verb = Reflect.getMetadata(METHOD_METADATA, methodRef) as number | undefined;
        if (verb === undefined) continue;

        const routePath = joinPath(controllerPath, readPath(methodRef));
        const targets = [methodRef as never, ControllerClass] as const;
        const rawScopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [...targets]);
        const rawApiKeyScopes = reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [...targets]);
        const rawPermissions = reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [...targets]);
        const rawMode = reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [...targets]);

        const entry: RouteManifestEntry = {
          controller: ControllerClass.name,
          handler,
          method: HTTP_METHOD_NAMES[verb] ?? `UNKNOWN_${verb}`,
          path: isPrefixExempt(routePath) ? toOpenApiPath(routePath) : toOpenApiPath(`/${API_GLOBAL_PREFIX}${routePath}`),
          routePath,
          svcScopes: Array.isArray(rawScopes) ? [...new Set(rawScopes)].sort() : [],
          forbidServiceAccount: reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [...targets]) === true,
          apiKeyForbidden: reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [...targets]) === true,
          apiKeyScopes: Array.isArray(rawApiKeyScopes) ? [...new Set(rawApiKeyScopes)].sort() : [],
          // Absent stays `null`; an empty array stays `[]` — see the interface.
          requiredPermissions: Array.isArray(rawPermissions) ? rawPermissions.map((p) => [p.action, p.subject] as [string, string]) : null,
          isPublic:
            reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [...targets]) === true ||
            reflector.getAllAndOverride<boolean>('isPublic', [...targets]) === true,
          permissionMode: rawMode === 'AND' || rawMode === 'OR' ? rawMode : null,
          requiresIfMatch: reflector.getAllAndOverride<boolean>(REQUIRES_IF_MATCH_KEY, [...targets]) === true,
          apiExcluded: controllerExcluded || isEndpointApiExcluded(methodRef),
        };

        // A controller instantiated in two modules is walked twice; the route
        // is the same route. De-dupe on identity, not on path — two DIFFERENT
        // controllers legitimately serving the same path must both be kept so
        // the cross-check can see the collision.
        const key = `${entry.controller}.${entry.handler}|${entry.method}|${entry.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) ||
      a.controller.localeCompare(b.controller) ||
      a.handler.localeCompare(b.handler),
  );
  return entries;
}

async function main(): Promise<void> {
  // See `emit-openapi.ts` — `abortOnError: false` is what turns a bootstrap
  // failure into a diagnosable rejection instead of a silent `process.exit(1)`.
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  // FIRST statement after `create()` — the queues' connection errors land a
  // few ticks later. See `offline-infrastructure.ts`.
  const silencedQueues = silenceBullQueueConnectionErrors(app);

  try {
    const routes = collect(app);
    writeFileSync(OUTPUT_PATH, JSON.stringify({ globalPrefix: API_GLOBAL_PREFIX, routes }, null, 2) + '\n', 'utf8');

    const admin = routes.filter((r) => r.routePath.startsWith('/admin'));
    const reachable = admin.filter((r) => r.svcScopes.length > 0 && !r.forbidServiceAccount);
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(
      `[emit-route-manifest] wrote ${routes.length} routes (${admin.length} admin, ${reachable.length} machine-reachable) to ${OUTPUT_PATH} ` +
        `(${silencedQueues} offline queues quiesced)`,
    );
  } finally {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.error('[emit-route-manifest] failed:', error);
    process.exit(1);
  });
