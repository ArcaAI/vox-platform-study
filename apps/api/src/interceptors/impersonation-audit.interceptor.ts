import { EventTypes } from '@arcaai/domains';
import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * TASK-224 Recommendation 3: Impersonation Audit Interceptor
 *
 * Intercepts every request and checks whether the authenticated user's JWT
 * contains an `impersonatedBy` claim. If so, it emits an audit event after
 * the request completes successfully, capturing the admin ID, the
 * impersonated user ID, the endpoint, and the client IP.
 *
 * Uses EventEmitter2 directly (globally available via EventEmitterModule)
 * instead of IAuthService to avoid DI scope issues with global interceptors.
 *
 * Audit emission is fire-and-forget so that failures in the audit
 * subsystem do not break business requests.
 */
@Injectable()
export class ImpersonationAuditInterceptor implements NestInterceptor {
    private readonly logger = new Logger(ImpersonationAuditInterceptor.name);

    constructor(
        private readonly clsService: ClsService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const httpContext = context.switchToHttp();
        const request = httpContext.getRequest();
        const user = this.clsService.get('user');

        if (!user?.impersonatedBy) {
            return next.handle();
        }

        const adminId: string = user.impersonatedBy;
        const impersonatedUserId: string = user.id;
        const method = request.method;
        const url = request.url;
        const ip = request.ip || '127.0.0.1';
        const userAgent = request.headers['user-agent'] || 'Unknown';

        return next.handle().pipe(
            tap({
                next: () => {
                    try {
                        this.eventEmitter.emit(EventTypes.UserAuthenticated, {
                            userId: adminId,
                            impersonatedUserId,
                            timestamp: new Date(),
                            ip,
                            userAgent,
                            endpoint: url,
                            method,
                        });
                    } catch (err: any) {
                        this.logger.warn(
                            `Failed to audit impersonation action: ${err?.message}`,
                        );
                    }
                },
            }),
        );
    }
}
