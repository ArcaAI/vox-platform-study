/**
 * The sunset gate for `@ApiDeprecated` routes: `<prefix>deprecated_requests_total{route, removeIn}`.
 *
 * A deprecated route may be removed only after a window with zero requests on its series, so this
 * counts every request that reaches one. `route` is the route TEMPLATE (`/api/v1/consultations/:id/prime`),
 * never the resolved URL, so the series count is bounded by the number of deprecated routes.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Type } from '@nestjs/common';
import { Counter, register } from 'prom-client';
import type { Observable } from 'rxjs';

import { gatewayMetricPrefix } from './metric-naming';
import { resolveResponseRouteLabel } from './http-response-metrics';

/** Unprefixed metric name. */
export const DEPRECATED_REQUESTS_TOTAL = 'deprecated_requests_total';

function counter(): Counter<'route' | 'removeIn'> {
  const name = `${gatewayMetricPrefix()}${DEPRECATED_REQUESTS_TOTAL}`;
  return (
    (register.getSingleMetric(name) as Counter<'route' | 'removeIn'> | undefined) ??
    new Counter({
      name,
      help: 'Requests to routes marked @ApiDeprecated, by route template and the release that removes them.',
      labelNames: ['route', 'removeIn'] as const,
      registers: [register],
    })
  );
}

/** An interceptor class that counts requests to one deprecated route (its `removeIn` is fixed at decoration). */
export function deprecatedRouteCounter(removeIn: string): Type<NestInterceptor> {
  @Injectable()
  class DeprecatedRouteCounterInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
      try {
        const request = context.switchToHttp().getRequest();
        counter().inc({ route: resolveResponseRouteLabel(request), removeIn });
      } catch {
        // A metric must never break the request it observes.
      }
      return next.handle();
    }
  }
  return DeprecatedRouteCounterInterceptor;
}
