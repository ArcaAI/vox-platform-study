/**
 * Logger level enum
 */
export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
}

/**
 * Function decorator to log method calls with timing information
 * @param level Log level to use
 * @returns Method decorator
 */
export function LogMethod(level: LogLevel = LogLevel.INFO) {
  return function (_target: object, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: unknown[]) {
      const start = performance.now();
      const logger = new Logger(`Method:${propertyKey}`);

      switch (level) {
        case LogLevel.ERROR:
          logger.error(`Entering ${propertyKey}(${JSON.stringify(args)})`);
          break;
        case LogLevel.WARN:
          logger.warn(`Entering ${propertyKey}(${JSON.stringify(args)})`);
          break;
        case LogLevel.DEBUG:
          logger.debug(`Entering ${propertyKey}(${JSON.stringify(args)})`);
          break;
        default:
          logger.info(`Entering ${propertyKey}(${JSON.stringify(args)})`);
      }

      try {
        const result = originalMethod.apply(this, args);
        const end = performance.now();

        switch (level) {
          case LogLevel.ERROR:
            logger.error(`Exiting - execution time: ${(end - start).toFixed(2)}ms`);
            break;
          case LogLevel.WARN:
            logger.warn(`Exiting - execution time: ${(end - start).toFixed(2)}ms`);
            break;
          case LogLevel.DEBUG:
            logger.debug(`Exiting - execution time: ${(end - start).toFixed(2)}ms`);
            break;
          default:
            logger.info(`Exiting - execution time: ${(end - start).toFixed(2)}ms`);
        }

        return result;
      } catch (error) {
        const logger = new Logger(`Method:${propertyKey}`);
        logger.error(`Error occurred`, error);
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * ANSI color codes for terminal output
 */
const Colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',

  // Foreground colors
  fg: {
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
  },

  // Background colors
  bg: {
    black: '\x1b[40m',
    red: '\x1b[41m',
    green: '\x1b[42m',
    yellow: '\x1b[43m',
    blue: '\x1b[44m',
    magenta: '\x1b[45m',
    cyan: '\x1b[46m',
    white: '\x1b[47m',
  },
};

/**
 * Logger class with pretty console output implementation
 */
export class Logger {
  private context: string;
  private enabled: boolean = true;
  private showTimestamp: boolean = true;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Enable or disable logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Enable or disable timestamp display
   */
  setShowTimestamp(show: boolean): void {
    this.showTimestamp = show;
  }

  /**
   * Get current timestamp string
   */
  private getTimestamp(): string {
    if (!this.showTimestamp) return '';
    const now = new Date();
    return `${Colors.fg.gray}[${now.toISOString()}]${Colors.reset}`;
  }

  /**
   * Format the context string
   */
  private formatContext(): string {
    return `${Colors.bright}${Colors.fg.cyan}[${this.context}]${Colors.reset}`;
  }

  /**
   * Log an error message
   */
  error(message: string, ...optionalParams: unknown[]): void {
    if (this.enabled) {
      const levelTag = `${Colors.fg.red}${Colors.bright}[${LogLevel.ERROR}]${Colors.reset}`;
      console.error(`${this.getTimestamp()}${levelTag}${this.formatContext()} ${message}`, ...optionalParams);
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, ...optionalParams: unknown[]): void {
    if (this.enabled) {
      const levelTag = `${Colors.fg.yellow}${Colors.bright}[${LogLevel.WARN}]${Colors.reset}`;
      console.warn(`${this.getTimestamp()}${levelTag}${this.formatContext()} ${message}`, ...optionalParams);
    }
  }

  /**
   * Log an info message
   */
  info(message: string, ...optionalParams: unknown[]): void {
    if (this.enabled) {
      const levelTag = `${Colors.fg.green}[${LogLevel.INFO}]${Colors.reset}`;
      console.info(`${this.getTimestamp()}${levelTag}${this.formatContext()} ${message}`, ...optionalParams);
    }
  }

  /**
   * Log a debug message
   */
  debug(message: string, ...optionalParams: unknown[]): void {
    if (this.enabled) {
      const levelTag = `${Colors.fg.blue}[${LogLevel.DEBUG}]${Colors.reset}`;
      console.debug(`${this.getTimestamp()}${levelTag}${this.formatContext()} ${message}`, ...optionalParams);
    }
  }
}

export default Logger;
