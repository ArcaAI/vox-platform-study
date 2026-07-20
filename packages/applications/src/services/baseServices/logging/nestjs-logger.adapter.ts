import { LoggerService } from '@nestjs/common';
import { ILoggingService } from './ILoggingService';

/**
 * NestJS Logger adapter that uses our custom logging service
 * This allows our logging service to be used as the global NestJS logger
 */
export class NestJSLoggerAdapter implements LoggerService {
  constructor(private readonly loggingService: ILoggingService) {}

  /**
   * Write a 'log' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    this.loggingService.info(this.formatMessage(message), context);
  }

  /**
   * Write an 'error' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(message: any, stackOrContext?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(message: any, stack?: string, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(message: any, stackOrContext?: string, context?: string): void {
    let actualError: Error | undefined;
    let actualContext: string | undefined;

    if (typeof stackOrContext === 'string' && context !== undefined) {
      // error(message, stack, context)
      actualError = new Error(stackOrContext);
      actualContext = context;
    } else if (typeof stackOrContext === 'string') {
      // Could be either stack or context
      if (stackOrContext.includes('\n') || stackOrContext.includes('at ')) {
        // Looks like a stack trace
        actualError = new Error(stackOrContext);
      } else {
        // Treat as context
        actualContext = stackOrContext;
      }
    } else if (stackOrContext && typeof stackOrContext === 'object' && 'message' in stackOrContext) {
      // It's an Error object
      actualError = stackOrContext as Error;
    }

    if (actualError) {
      this.loggingService.error(this.formatMessage(message), actualError, actualContext);
    } else {
      this.loggingService.error(this.formatMessage(message), actualContext);
    }
  }

  /**
   * Write a 'warn' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    this.loggingService.warn(this.formatMessage(message), context);
  }

  /**
   * Write a 'debug' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    this.loggingService.debug(this.formatMessage(message), context);
  }

  /**
   * Write a 'verbose' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verbose(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verbose(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verbose(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    this.loggingService.verbose(this.formatMessage(message), context);
  }

  /**
   * Write a 'fatal' level log.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fatal(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fatal(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fatal(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    this.loggingService.fatal(this.formatMessage(message), context);
  }

  /**
   * Set log levels
   * @param levels log levels
   */
  setLogLevels?(_levels: string[]): void {
    // This is a no-op since we handle log levels in our logging service
    // based on configuration
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatMessage(message: any): string {
    if (typeof message === 'string') {
      return message;
    }

    if (typeof message === 'object') {
      try {
        return JSON.stringify(message);
      } catch {
        return String(message);
      }
    }

    return String(message);
  }
}
