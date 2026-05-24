import type { INestApplication } from '@nestjs/common';
import { REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY } from '@arcaai/applications';

/**
 * Phase 0 Item 3 (TASK-302 Stream A) — boot-time route audit.
 *
 * Walks the Express router and refuses to start the app if any route
 * matching ^/(api/v\d+/)?admin/ lacks an explicit permission decorator
 * (REQUIRED_PERMISSIONS_KEY metadata set to a non-empty array) AND is
 * not explicitly marked @Public() via SKIP_AUTH_KEY.
 *
 * Throwing here propagates to the bootstrap caller in main.ts; the
 * process exits non-zero before listen(). Continuous prevention of
 * TASK-301 §P0-3 regressions.
 *
 * Metadata reading is two-pronged:
 *   1. `handler.__metadata` — synthetic shape used by unit tests and
 *      any helper that explicitly attaches metadata to the express
 *      handler wrapper.
 *   2. `Reflect.getMetadata(KEY, handler)` — the standard NestJS path,
 *      populated by @CanManage / @Authorize / @Public via SetMetadata.
 *
 * The audit accepts metadata from either source so that the same
 * function passes the unit test mock AND validates a real bootstrapped
 * Nest app at runtime.
 */
export function auditAdminRoutePermissions(app: INestApplication): void {
  const http = app.getHttpAdapter();
  const instance = http.getInstance() as { _router?: { stack: Array<unknown> } };
  const stack = instance?._router?.stack ?? [];

  const adminRouteRegex = /^\/?(api\/v\d+\/)?admin\//;
  const offenders: string[] = [];

  for (const rawLayer of stack) {
    const layer = rawLayer as {
      route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle?: unknown }> };
      handle?: unknown;
    };
    const route = layer?.route;
    if (!route || typeof route.path !== 'string') continue;
    if (!adminRouteRegex.test(route.path)) continue;

    const handler = layer.handle ?? route.stack?.[0]?.handle;
    const metadata = readMetadata(handler);

    const isPublic = metadata[SKIP_AUTH_KEY] === true;
    const perms = metadata[REQUIRED_PERMISSIONS_KEY] as unknown[] | undefined;

    if (isPublic) continue;
    if (Array.isArray(perms) && perms.length > 0) continue;

    const methods = Object.keys(route.methods ?? {}).join(',').toUpperCase();
    offenders.push(`${methods} ${route.path} — missing permission decorator`);
  }

  if (offenders.length > 0) {
    const list = offenders.map((o) => `  - ${o}`).join('\n');
    throw new Error(
      `Phase 0 Item 3 (TASK-302): refused to start — ${offenders.length} admin route(s) ` +
        `lack an explicit @CanManage / @Authorize / @CanRead / @Public decorator:\n${list}`,
    );
  }
}

function readMetadata(handler: unknown): Record<string, unknown> {
  if (!handler) return {};
  const fn = handler as { __metadata?: Record<string, unknown> };
  const synthetic = fn.__metadata ?? {};

  // Try Reflect.getMetadata for production NestJS handlers. SetMetadata
  // attaches keys directly onto the handler function reference.
  const reflected: Record<string, unknown> = {};
  try {
    for (const key of [REQUIRED_PERMISSIONS_KEY, SKIP_AUTH_KEY]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (Reflect as any).getMetadata?.(key, handler);
      if (value !== undefined) reflected[key] = value;
    }
  } catch {
    // Reflect-metadata not available; rely on synthetic only.
  }

  return { ...synthetic, ...reflected };
}
