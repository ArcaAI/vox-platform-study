import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Observable } from 'rxjs';
import { IAppSettingsService } from '@arcaai/applications';

@Injectable()
export class MaintenanceInterceptor implements NestInterceptor {
  constructor(@Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const isMaintenanceMode = this.appSettingsService.getValueFromCache('isMaintenance');

    if (isMaintenanceMode) {
      throw new HttpException(
        {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'The system is currently under maintenance. Please try again later.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return next.handle();
  }
}
