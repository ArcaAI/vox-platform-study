import { PrismaClientKnownRequestError } from '@arcaai/database';
import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Request, Response } from 'express';

@Catch(PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PrismaClientExceptionFilter.name);

  catch(exception: PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const message = exception.message.replace(/\n/g, '');

    // Build structured log context
    const logContext = {
      errorCode: exception.code,
      errorMessage: message,
      errorMeta: exception.meta,
      method: request?.method,
      path: request?.url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestId: (request as any)?.requestId,
    };

    this.logger.error({
      message: 'Prisma database error',
      ...logContext,
      stack: exception.stack,
    });

    switch (exception.code) {
      case 'P2002': {
        // Unique constraint violation
        const status = HttpStatus.CONFLICT;
        response.status(status).json({
          statusCode: status,
          message: message,
          error: 'Unique constraint violation',
        });
        break;
      }
      case 'P2025': {
        // Record not found
        const status = HttpStatus.NOT_FOUND;
        response.status(status).json({
          statusCode: status,
          message: message || 'Record not found',
          error: 'Not found',
        });
        break;
      }
      case 'P2003': {
        // Foreign key constraint violation
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          message: message,
          error: 'Foreign key constraint violation',
        });
        break;
      }
      case 'P2014': {
        // Required relation violation
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          message: message,
          error: 'Required relation violation',
        });
        break;
      }
      default:
        // default 500 error code
        super.catch(exception, host);
        break;
    }
  }
}
