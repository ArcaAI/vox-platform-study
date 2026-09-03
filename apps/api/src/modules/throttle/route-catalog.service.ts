import { Injectable, RequestMethod } from '@nestjs/common';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { buildRouteKey } from '@arcaai/applications';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from '../../global-prefix.config';

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

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
};

/** One route, as the rate-limit admin surface offers it for selection. */
export interface RouteCatalogEntry {
  /** `METHOD:/api/v1/...` — exactly the key a `RateLimitRule.routeMatch` compares against. */
  routeId: string;
  method: string;
  /** Gateway path INCLUDING the global prefix, in Express shape (`/api/v1/tenants/:id`). */
  path: string;
  controller: string;
  handler: string;
  /** The route's `@Throttle({ default: … })` value, when it declares one. */
  decoratorLimit?: number;
  decoratorWindowMs?: number;
}

/**
 * The gateway's own route inventory.
 *
 * A super admin writing a rate-limit rule needs to pick from the real routes,
 * not type a pattern and hope. This walks the SAME `ModulesContainer` the route
 * manifest generator walks (`src/scripts/emit-route-manifest.ts`) and applies
 * the SAME global-prefix rules, so the catalog and the manifest cannot disagree
 * about what routes exist.
 *
 * It also surfaces each route's `@Throttle` value, which under OD-2 is now rank
 * 5's seed — so the admin screen can show what a route defaults to before any
 * rule is written, and `explain` can report the same number the guard uses.
 *
 * Built ONCE at boot: the route table is fixed for the process lifetime.
 */
@Injectable()
export class RouteCatalogService {
  private catalog: readonly RouteCatalogEntry[] = [];
  private byRouteId: ReadonlyMap<string, RouteCatalogEntry> = new Map();

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const entries = this.collect();
    this.catalog = entries;
    this.byRouteId = new Map(entries.map((entry) => [entry.routeId, entry]));
  }

  list(): readonly RouteCatalogEntry[] {
    return this.catalog;
  }

  find(routeId: string): RouteCatalogEntry | undefined {
    return this.byRouteId.get(routeId);
  }

  private collect(): RouteCatalogEntry[] {
    const metadataScanner = new MetadataScanner();
    const entries: RouteCatalogEntry[] = [];
    const seen = new Set<string>();

    for (const moduleRef of this.modulesContainer.values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const ControllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
        const instance = wrapper.instance as Record<string, unknown> | undefined;
        if (!ControllerClass || !instance) continue;

        const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
        if (!proto) continue;

        const controllerPath = readPath(ControllerClass);

        for (const handler of metadataScanner.getAllMethodNames(proto)) {
          const methodRef = proto[handler];
          if (typeof methodRef !== 'function') continue;

          const verb = Reflect.getMetadata(METHOD_METADATA, methodRef) as number | undefined;
          if (verb === undefined) continue;

          const routePath = joinPath(controllerPath, readPath(methodRef));
          const fullPath = isPrefixExempt(routePath) ? routePath : `/${API_GLOBAL_PREFIX}${routePath}`;
          const method = HTTP_METHOD_NAMES[verb] ?? `UNKNOWN_${verb}`;
          const routeId = buildRouteKey(method, fullPath);

          // The same controller instantiated in two modules is one route.
          if (seen.has(routeId)) continue;
          seen.add(routeId);

          const targets = [methodRef as never, ControllerClass] as const;
          entries.push({
            routeId,
            method,
            path: fullPath,
            controller: ControllerClass.name,
            handler,
            decoratorLimit: this.reflector.getAllAndOverride<number>(`${THROTTLER_LIMIT}default`, [...targets]),
            decoratorWindowMs: this.reflector.getAllAndOverride<number>(`${THROTTLER_TTL}default`, [...targets]),
          });
        }
      }
    }

    return entries.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }
}

function readPath(target: unknown): string {
  const raw = Reflect.getMetadata(PATH_METADATA, target as object) as unknown;
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

/** The `exclude` list `main.ts` passes to `setGlobalPrefix` — those paths keep their bare URL. */
function isPrefixExempt(routePath: string): boolean {
  const exclude = (API_GLOBAL_PREFIX_OPTIONS as { exclude?: unknown[] }).exclude ?? [];
  const bare = normalizePath(routePath);
  return exclude.some((entry) => {
    const raw = typeof entry === 'string' ? entry : ((entry as { path?: string })?.path ?? '');
    return normalizePath(raw) === bare;
  });
}
