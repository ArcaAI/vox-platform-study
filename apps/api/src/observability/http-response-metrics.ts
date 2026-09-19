/**
 * The gateway's response counter — the one that can see a REFUSAL.
 *
 * ============================================================================
 * WHY A SECOND REQUEST METRIC EXISTS, AND WHICH ONE IS AUTHORITATIVE
 * ============================================================================
 * `…_http_requests_total` is written by `MetricsInterceptor`. Nest runs guards
 * BEFORE interceptors, so a 429 from `TieredThrottlerGuard`, a 401 from
 * `UnifiedAuthGuard` or a 403 from `AuthorizationGuard` never reaches
 * `next.handle()` and the interceptor is never invoked. Lane G measured the
 * gap end to end: the client issued **96** requests, the gateway counted
 * **43**. The metric an HPA or an error-rate alert would read goes QUIET
 * exactly when the platform starts refusing traffic.
 *
 * No interceptor can fix that — the blindness is structural, a property of
 * where interceptors sit in the pipeline. Express middleware runs before the
 * guards and `res.on('close')` fires for every response however it was
 * produced, so that is where this counts.
 *
 * **`…_http_responses_total` is the authoritative count of what the gateway
 * answered.** `…_http_requests_total` is retained unchanged (it also carries
 * the duration histogram) and is now best read as "requests that reached a
 * handler". That makes their difference directly meaningful, which is why the
 * label sets are identical:
 *
 * ```promql
 * # requests refused before any handler ran
 * sum(rate(hope_api_http_responses_total[5m])) - sum(rate(hope_api_http_requests_total[5m]))
 * ```
 *
 * ============================================================================
 * CARDINALITY
 * ============================================================================
 * `path` is the TEMPLATED route (`/api/v1/tenants/:id`), never the resolved
 * URL — the same rule `MetricsInterceptor` and `TieredThrottlerGuard`'s
 * `resolveRouteKey` already follow. Express populates `req.route` during
 * `Route.dispatch`, i.e. BEFORE the Nest handler and therefore before any
 * guard inside it, so a refused request still carries its pattern. A request
 * that matched no route has no pattern at all and folds into a single
 * `<unmatched>` label, because falling back to the raw URL would mint a series
 * per scanner probe and grow the scrape without bound.
 *
 * Series count is therefore bounded by (templated routes x methods x statuses
 * observed) + 1, the same order as the existing family.
 */
import { Counter, register, type Metric } from 'prom-client';

import { gatewayMetricPrefix, gatewayServiceLabel } from './metric-naming';

/** Unprefixed metric name. */
export const HTTP_RESPONSES_TOTAL = 'http_responses_total';

/**
 * Label for a request that matched no route (404 fall-throughs, scanner
 * noise, OPTIONS handled in middleware). Deliberately the same literal
 * `MetricsInterceptor` uses, so the two families line up.
 */
export const UNMATCHED_ROUTE_LABEL = '<unmatched>';

/**
 * Status stamped on a connection the client closed before the response was
 * flushed. nginx's convention, and the only honest label for it: under
 * saturation these are the requests that gave up, and they are precisely the
 * ones a `'finish'`-only listener drops — leaving the metric quietest when
 * the platform is worst.
 */
const CLIENT_CLOSED_REQUEST = 499;

interface RouteBearingRequest {
  method?: string | undefined;
  url?: string | undefined;
  baseUrl?: string | undefined;
  route?: { path?: unknown } | undefined;
}

/**
 * The bounded `path` label for one request.
 *
 * @internal — exported for tests; the middleware is the only intended caller.
 */
export function resolveResponseRouteLabel(request: RouteBearingRequest): string {
  const pattern = request.route?.path;
  if (typeof pattern !== 'string' || pattern.length === 0) return UNMATCHED_ROUTE_LABEL;

  // Express strips the mount prefix from `route.path` and keeps it on
  // `baseUrl`; `TieredThrottlerGuard.resolveRouteKey` rejoins them the same
  // way, so the two agree on what a route is called.
  const baseUrl = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  return pattern.startsWith(baseUrl) ? pattern : `${baseUrl}${pattern}`;
}

function reuseOrCreate<T extends Metric>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

function responseCounter(): Counter<'method' | 'path' | 'status' | 'service'> {
  const name = `${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`;
  return reuseOrCreate(
    name,
    () =>
      new Counter({
        name,
        help:
          'Every HTTP response the gateway produced, INCLUDING the ones refused by a guard (429/401/403) and connections the client abandoned (status 499). ' +
          'Unlike ..._http_requests_total, which is written by an interceptor and so only sees requests that reached a handler, this one cannot go quiet under overload.',
        labelNames: ['method', 'path', 'status', 'service'] as const,
        registers: [register],
      }),
  );
}

/**
 * Express middleware that counts every response.
 *
 * Register it as the FIRST `app.use(...)` in `main.ts`: `res.on('close')`
 * fires wherever the listener was attached, but registering first is what
 * makes it observe responses short-circuited by the session, CORS or
 * security-header layers too.
 *
 * Never throws: a metric that breaks the request it is observing is worse than
 * a missing sample.
 */
export function httpResponseMetricsMiddleware() {
  const counter = responseCounter();
  const service = gatewayServiceLabel();

  return function httpResponseMetrics(
    request: RouteBearingRequest,
    response: { statusCode?: number; writableEnded?: boolean; once: (event: string, listener: () => void) => unknown },
    next: () => void,
  ): void {
    // `close` rather than `finish`: `finish` never fires for an abandoned
    // connection, which is the case worth counting most.
    response.once('close', () => {
      try {
        // A response that never finished writing has no meaningful status of
        // its own — `statusCode` is still whatever was last set, usually the
        // default 200, which would report an abandoned request as a success.
        const status = response.writableEnded === false ? CLIENT_CLOSED_REQUEST : (response.statusCode ?? 0);
        counter.inc({
          method: (request.method ?? 'UNKNOWN').toUpperCase(),
          path: resolveResponseRouteLabel(request),
          status: String(status),
          service,
        });
      } catch {
        // A registry conflict or a label mismatch must not surface on a
        // response that has already been sent.
      }
    });
    next();
  };
}
