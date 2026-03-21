import * as winston from 'winston';
import 'winston-daily-rotate-file';
// @ts-ignore - Adding type declaration for winston-s3-transport
import { S3Transport } from 'winston-s3-transport';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  HTTP = 'http',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
  SILLY = 'silly'
}

export type S3Config = {
  enabled: boolean;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  folder?: string;
  filename?: string;
  frequency?: 'daily' | 'hourly' | 'minutely' | number;
};

export type LoggerOptions = {
  level?: LogLevel;
  service?: string;
  transports?: {
    console?: boolean;
    file?: {
      enabled: boolean;
      filename?: string;
      dirname?: string;
      maxSize?: string;
      maxFiles?: string;
    };
    rotate?: {
      enabled: boolean;
      dirname?: string;
      filename?: string;
      datePattern?: string;
      maxSize?: string;
      maxFiles?: string;
    };
    s3?: {
      enabled: boolean;
      bucket?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
      serverFilenameFormat?: string;
      errorFilenameFormat?: string;
      requestFilenameFormat?: string;
    };
  };
  format?: {
    timestamp?: boolean;
    colorize?: boolean;
    json?: boolean;
  };
};

const defaultOptions: LoggerOptions = {
  level: LogLevel.INFO,
  service: 'application',
  transports: {
    console: true,
    file: {
      enabled: false,
      filename: 'logs/application.log',
      maxSize: '10m',
      maxFiles: '7d'
    },
    rotate: {
      enabled: false,
      dirname: 'logs',
      filename: 'application-%DATE%.log',
      datePattern: 'yyyy-MM-dd',
      maxSize: '20m',
      maxFiles: '14d'
    },
    s3: {
      enabled: false
    }
  },
  format: {
    timestamp: true,
    colorize: true,
    json: false
  }
};

export class Logger {
  private logger: winston.Logger;
  private options: LoggerOptions;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      ...defaultOptions,
      ...options,
      transports: {
        ...defaultOptions.transports,
        ...options.transports,
        file: {
          ...(defaultOptions.transports?.file || { enabled: false }),
          ...(options.transports?.file || {})
        },
        rotate: {
          ...(defaultOptions.transports?.rotate || { enabled: false }),
          ...(options.transports?.rotate || {})
        },
        s3: {
          ...(defaultOptions.transports?.s3 || { enabled: false }),
          ...(options.transports?.s3 || {})
        }
      },
      format: {
        ...defaultOptions.format,
        ...options.format
      }
    };

    this.logger = this.createLogger();
  }

  private createLogger(): winston.Logger {
    const formatters = [];

    if (this.options.format?.timestamp) {
      formatters.push(winston.format.timestamp());
    }

    if (this.options.format?.colorize) {
      formatters.push(winston.format.colorize());
    }

    formatters.push(winston.format.printf((info: winston.Logform.TransformableInfo) => {
      const { timestamp, level, message, service, ...rest } = info;
      const serviceStr = service ? `[${service}] ` : '';
      const timestampStr = timestamp ? `${timestamp} ` : '';
      const metaStr = Object.keys(rest).length ? JSON.stringify(rest) : '';

      return `${timestampStr}${level}: ${serviceStr}${message} ${metaStr}`.trim();
    }));

    const finalFormat = this.options.format?.json
      ? winston.format.combine(...formatters, winston.format.json())
      : winston.format.combine(...formatters);

    const transports: winston.transport[] = [];

    if (this.options.transports?.console) {
      transports.push(new winston.transports.Console());
    }

    if (this.options.transports?.file?.enabled) {
      transports.push(new winston.transports.File({
        filename: this.options.transports.file.filename,
        dirname: this.options.transports.file.dirname,
        maxsize: this.options.transports.file.maxSize
          ? parseInt(this.options.transports.file.maxSize)
          : undefined,
        maxFiles: this.options.transports.file.maxFiles
          ? parseInt(this.options.transports.file.maxFiles)
          : undefined
      }));
    }

    if (this.options.transports?.rotate?.enabled) {
      transports.push(new winston.transports.DailyRotateFile({
        dirname: this.options.transports.rotate.dirname,
        filename: this.options.transports.rotate.filename,
        datePattern: this.options.transports.rotate.datePattern,
        maxSize: this.options.transports.rotate.maxSize,
        maxFiles: this.options.transports.rotate.maxFiles
      }));
    }

    // S3 transport will be added by the consumer if needed
    // We provide the configuration structure but the actual implementation
    // will be in the consumer application

    return winston.createLogger({
      level: this.options.level,
      defaultMeta: { service: this.options.service },
      format: finalFormat,
      transports
    });
  }

  // Method to add a custom transport after initialization
  addTransport(transport: winston.transport): void {
    this.logger.add(transport);
  }

  error(message: string, meta?: Record<string, any> | any): void {
    this.logger.error(message, meta);
  }

  warn(message: string, meta?: Record<string, any> | any): void {
    this.logger.warn(message, meta);
  }

  info(message: string, meta?: Record<string, any> | any): void {
    this.logger.info(message, meta);
  }

  http(message: string, meta?: Record<string, any> | any): void {
    this.logger.http(message, meta);
  }

  debug(message: string, meta?: Record<string, any> | any): void {
    this.logger.debug(message, meta);
  }

  verbose(message: string, meta?: Record<string, any> | any): void {
    this.logger.verbose(message, meta);
  }

  silly(message: string, meta?: Record<string, any> | any): void {
    this.logger.silly(message, meta);
  }

  log(level: LogLevel, message: string, meta?: Record<string, any> | any): void {
    this.logger.log(level, message, meta);
  }
}

// Create a default logger instance for easy import
const defaultLogger = new Logger();

// For backward compatibility
export const log = (msg: any, meta?: Record<string, any>): void => {
  defaultLogger.info(String(msg), meta);
};

// Export the default logger and factory function
export default defaultLogger;
export const createLogger = (options?: LoggerOptions): Logger => new Logger(options);