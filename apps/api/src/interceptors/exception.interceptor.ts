import { ApiErrorResponse, IClsContext } from '@arcaai/applications';
import {
    PrismaClientKnownRequestError,
    PrismaClientValidationError,
} from '@arcaai/database';
import { BaseException } from '@arcaai/exceptions';
import {
    BadRequestException,
    CallHandler,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NestInterceptor,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Injectable()
export class ExceptionInterceptor implements NestInterceptor {
    private readonly logger = new Logger(ExceptionInterceptor.name);

    constructor(private readonly clsService: ClsService<IClsContext>) {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest();
        let requestId: string | undefined;
        let userId: string | undefined;
        let tenantId: string | undefined;
        try {
            requestId = this.clsService.getId();
            userId = this.clsService.get('user')?.id;
            tenantId = this.clsService.get('tenantId');
        } catch {
            // CLS context unavailable (e.g. /metrics served outside CLS middleware)
        }

        return next.handle().pipe(
            catchError((err) => {
                const errorType = err?.constructor?.name || typeof err;
                const method = request?.method;
                const path = request?.url;

                // Build base context for all error logs
                const baseContext = {
                    requestId,
                    userId,
                    tenantId,
                    method,
                    path,
                };

                if (err instanceof PrismaClientKnownRequestError) {
                    this.logger.error({
                        message: 'Prisma database error',
                        ...baseContext,
                        errorCode: err.code,
                        errorMeta: err.meta,
                        stack: err.stack,
                    });

                    const errorResponse = {
                        status: HttpStatus.BAD_REQUEST,
                        error: 'Prisma Error',
                        message: err.message,
                        meta: err.meta,
                        correlationId: requestId,
                    };
                    return throwError(
                        () => new HttpException(errorResponse, HttpStatus.BAD_REQUEST),
                    );
                }

                if (err instanceof PrismaClientValidationError) {
                    this.logger.error({
                        message: 'Prisma validation error',
                        ...baseContext,
                        validationMessage: err.message,
                        stack: err.stack,
                    });

                    return throwError(
                        () =>
                            new HttpException(
                                {
                                    status: HttpStatus.BAD_REQUEST,
                                    error: 'Validation Error',
                                    message: 'Data validation failed before the database operation.',
                                    correlationId: requestId,
                                },
                                HttpStatus.BAD_REQUEST,
                            ),
                    );
                }

                if (err.status >= 400 && err.status < 500) {
                    // Client errors - log at debug level
                    this.logger.debug({
                        message: 'Client error',
                        ...baseContext,
                        status: err.status,
                        errorType,
                    });

                    const isClassValidatorError =
                        Array.isArray(err?.response?.message) &&
                        typeof err?.response?.error === 'string' &&
                        err.status === 400;

                    // Transforming class-validator errors to a different format
                    if (isClassValidatorError) {
                        err = new BadRequestException(
                            new ApiErrorResponse({
                                statusCode: err.status,
                                message: 'Validation error',
                                error: err?.response?.error,
                                subErrors: err?.response?.message,
                                correlationId: err.correlationId || requestId,
                            }),
                        );
                    }
                }

                if (err instanceof BaseException) {
                    this.logger.warn({
                        message: 'Application exception',
                        ...baseContext,
                        correlationId: err.correlationId,
                        exceptionType: err.constructor.name,
                        errorMessage: err.message,
                        stack: err.stack,
                    });

                    return throwError(
                        () =>
                            new HttpException(
                                err.toJSON(),
                                HttpStatus.INTERNAL_SERVER_ERROR,
                            ),
                    );
                }

                // Ensure correlationId is set
                if (!err.correlationId) {
                    err.correlationId = requestId;
                }

                if (err.response) {
                    err.response.correlationId = err.correlationId;
                }

                // Log unexpected errors
                if (!err.status || err.status >= 500) {
                    this.logger.error({
                        message: 'Unexpected server error',
                        ...baseContext,
                        status: err.status || 500,
                        errorType,
                        errorMessage: err.message,
                        stack: err.stack,
                    });
                }

                return throwError(err);
            }),
        );
    }
}
