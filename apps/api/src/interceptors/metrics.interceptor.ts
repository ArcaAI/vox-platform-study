import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IMonitoringService } from '@arcaai/applications';

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

    return next.handle().pipe(
      tap({
        next: () => {
          const response = httpContext.getResponse();
          this.monitoringService.recordHttpRequest(
            request.method,
            request.route?.path || request.url,
            response.statusCode,
            (Date.now() - start) / 1000,
          );
        },
        error: (err) => {
          this.monitoringService.recordHttpRequest(
            request.method,
            request.route?.path || request.url,
            err?.status || err?.statusCode || 500,
            (Date.now() - start) / 1000,
          );
        },
      }),
    );
  }
}
