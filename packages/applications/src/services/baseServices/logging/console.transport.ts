import { Transform } from 'stream';

export interface ConsoleTransportOptions {
  colorize?: boolean;
}

export class ConsoleTransport extends Transform {
  private colorize: boolean;

  constructor(options: ConsoleTransportOptions = {}) {
    super({ objectMode: true });
    this.colorize = options.colorize ?? false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _transform(chunk: any, encoding: string, callback: (error?: Error) => void) {
    try {
      const formattedMessage = this.formatMessage(chunk);
      process.stdout.write(formattedMessage + '\n');
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatMessage(log: any): string {
    // Extract log data
    const timestamp = log.time ? new Date(log.time).toISOString() : new Date().toISOString();
    const pid = log.pid || process.pid;
    const level = this.mapLogLevel(log.level);
    const context = log.context || 'Application';
    const message = log.msg || log.message || '';

    // Format: [datetime iso string] [process id] LOG_LEVEL [context] message
    const baseMessage = `[${timestamp}] [${pid}] ${level} [${context}] ${message}`;

    // Add colors if enabled
    if (this.colorize) {
      return this.colorizeMessage(baseMessage, log.level);
    }

    return baseMessage;
  }

  private mapLogLevel(pinoLevel: number): string {
    // Pino levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
    if (pinoLevel >= 60) return 'FATAL';
    if (pinoLevel >= 50) return 'ERROR';
    if (pinoLevel >= 40) return 'WARN';
    if (pinoLevel >= 30) return 'INFO';
    if (pinoLevel >= 20) return 'DEBUG';
    return 'TRACE';
  }

  private colorizeMessage(message: string, level: number): string {
    if (!this.colorize) return message;

    // ANSI color codes
    const colors = {
      reset: '\x1b[0m',
      bright: '\x1b[1m',
      dim: '\x1b[2m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      gray: '\x1b[90m',
    };

    // Color based on log level
    if (level >= 60) return `${colors.red}${colors.bright}${message}${colors.reset}`; // FATAL
    if (level >= 50) return `${colors.red}${message}${colors.reset}`; // ERROR
    if (level >= 40) return `${colors.yellow}${message}${colors.reset}`; // WARN
    if (level >= 30) return `${colors.green}${message}${colors.reset}`; // INFO
    if (level >= 20) return `${colors.blue}${message}${colors.reset}`; // DEBUG
    return `${colors.gray}${message}${colors.reset}`; // TRACE
  }
}
