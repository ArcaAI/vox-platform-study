/**
 * TASK-773 Phase D1 — emit the gateway's ROUTE MANIFEST to disk, offline.
 *
 * The companion of `emit-openapi.ts`, and the first of the two sources
 * `packages/vox-node-codegen` cross-checks (ticket §3.1):
 *
 * | Source | Authoritative for |
 * |---|---|
 * | **this manifest** (Nest `ModulesContainer` walk) | route existence, path, HTTP verb, `@RequiredSvcScopes`, `@ForbidServiceAccount`, `@RequiresIfMatch` |
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
 * Same runtime contract as `emit-openapi.ts`: run against the compiled
 * `nest build` output, no `.listen()`, no live DB/Redis/Vault, placeholder env
 * supplied by the `route-manifest` package script. See that file's header for
 * why `abortOnError: false` and the bounded `app.close()` are load-bearing.
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
import { SERVICE_ACCOUNT_FORBIDDEN, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../app.module';
import { REQUIRES_IF_MATCH_KEY } from '../decorators/requiresIfMatch.decorator';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from '../global-prefix.config';

const OUTPUT_PATH = resolve(__dirname, '..', '..', 'route-manifest.json');

/**
 * `@nestjs/swagger`'s own metadata keys for the two exclusion decorators.
 * Inlined as string literals (they are `DECORATORS.API_EXCLUDE_ENDPOINT` /
 * `DECORATORS.API_EXCLUDE_CONTROLLER` in `@nestjs/swagger/dist/constants`)
 * so this script does not reach into that package's internal module layout.
 *
 * Load-bearing for the cross-check: a route carrying one of these is ABSENT
 * from `openapi.json` BY DESIGN, so the generator must be able to tell that
 * apart from a route that is missing its Swagger decorators — which is a
 * documentation defect worth failing on.
 */
const API_EXCLUDE_ENDPOINT_KEY = 'swagger/apiExcludeEndpoint';
const API_EXCLUDE_CONTROLLER_KEY = 'swagger/apiExcludeController';

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
 * path-to-regexp parser underneath Nest accepts as a parameter name. It
 * matters: `@Get('code-name/:code-name')` on `TenantController` binds a
 * parameter called `code`, followed by the LITERAL text `-name` — so the
 * OpenAPI template is `/code-name/{code}-name`. A greedier regex renders
 * `{code-name}` here, which then disagrees with the document the same
 * controller produced, and the cross-check (correctly) refuses to generate.
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
      const controllerExcluded = Reflect.getMetadata(API_EXCLUDE_CONTROLLER_KEY, ControllerClass) === true;

      for (const handler of metadataScanner.getAllMethodNames(proto)) {
        const methodRef = proto[handler];
        if (typeof methodRef !== 'function') continue;

        const verb = Reflect.getMetadata(METHOD_METADATA, methodRef) as number | undefined;
        if (verb === undefined) continue;

        const routePath = joinPath(controllerPath, readPath(methodRef));
        const rawScopes = reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [methodRef as never, ControllerClass]);

        const entry: RouteManifestEntry = {
          controller: ControllerClass.name,
          handler,
          method: HTTP_METHOD_NAMES[verb] ?? `UNKNOWN_${verb}`,
          path: isPrefixExempt(routePath) ? toOpenApiPath(routePath) : toOpenApiPath(`/${API_GLOBAL_PREFIX}${routePath}`),
          routePath,
          svcScopes: Array.isArray(rawScopes) ? [...new Set(rawScopes)].sort() : [],
          forbidServiceAccount: reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [methodRef as never, ControllerClass]) === true,
          requiresIfMatch: reflector.getAllAndOverride<boolean>(REQUIRES_IF_MATCH_KEY, [methodRef as never, ControllerClass]) === true,
          apiExcluded: controllerExcluded || Reflect.getMetadata(API_EXCLUDE_ENDPOINT_KEY, methodRef) === true,
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

  try {
    const routes = collect(app);
    writeFileSync(OUTPUT_PATH, JSON.stringify({ globalPrefix: API_GLOBAL_PREFIX, routes }, null, 2) + '\n', 'utf8');

    const admin = routes.filter((r) => r.routePath.startsWith('/admin'));
    const reachable = admin.filter((r) => r.svcScopes.length > 0 && !r.forbidServiceAccount);
    // eslint-disable-next-line no-console -- CLI script, not application logging
    console.log(
      `[emit-route-manifest] wrote ${routes.length} routes (${admin.length} admin, ${reachable.length} machine-reachable) to ${OUTPUT_PATH}`,
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
