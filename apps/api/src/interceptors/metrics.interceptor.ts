import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IMonitoringService } from '@arcaai/applications';

/**
 * TASK-310 E-7 (AC-7) — when a request never matched a NestJS route
 * (404 fall-throughs, OPTIONS preflights handled by middleware, scanner
 * noise) `request.route?.path` is undefined. Pre-W7 we fell back to
 * `request.url`, which expanded to the raw URL and minted a new
 * Prometheus series per unique `/api/v1/<random>` — cardinality grew
 * linearly with traffic, eventually breaking the metrics scrape.
 *
 * Labelling unmatched requests with this constant keeps the series
 * count bounded by the templated-route set + 1.
 */
const UNMATCHED_ROUTE_LABEL = '<unmatched>';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(IMonitoringService)
    private readonly monitoringService: { recordHttpRequest: (method: string, path: string, status: number, duration: number) => Promise<void> },
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();
    const start = Date.now();
    const routeLabel = request.route?.path ?? UNMATCHED_ROUTE_LABEL;

    return next.handle().pipe(
      tap({
        next: () => {
          const response = httpContext.getResponse();
          this.monitoringService.recordHttpRequest(request.method, routeLabel, response.statusCode, (Date.now() - start) / 1000);
        },
        error: (err) => {
          this.monitoringService.recordHttpRequest(request.method, routeLabel, err?.status || err?.statusCode || 500, (Date.now() - start) / 1000);
        },
      }),
    );
  }
}
