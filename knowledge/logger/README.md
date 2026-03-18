# @arcaai/logger

Winston-based structured logging library for the HOPE monorepo. Provides configurable, multi-transport logging with support for console output, file rotation, and S3/MinIO cloud storage.

## Architecture

```
@arcaai/logger
├── Logger class          # Core logger with configurable transports
├── createLogger()        # Factory for custom logger instances
├── defaultLogger         # Pre-configured singleton (default export)
└── log()                 # Legacy convenience function (INFO level)
        │
        ▼
Winston Engine
├── Console Transport     # Colorized terminal output
├── File Transport        # Static log files with size rotation
├── DailyRotateFile       # Time-based log file rotation
└── S3 Transport          # S3/MinIO cloud log shipping
```

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/logger` |
| **Version** | `0.0.1` |
| **Runtime** | TypeScript 5.8 |
| **Core Dependency** | `winston ^3.17` |
| **Transport Plugins** | `winston-daily-rotate-file ^5.0`, `winston-s3-transport ^2.0` |

## Quick Start

### Default Logger

```typescript
import logger from '@arcaai/logger';

logger.info('Application started');
logger.warn('Configuration file not found, using defaults');
logger.error('Failed to connect to database', { dbHost: 'localhost', port: 5432 });
logger.debug('Query executed', { sql: 'SELECT ...', durationMs: 42 });
```

### Custom Logger

```typescript
import { createLogger, LogLevel } from '@arcaai/logger';

const logger = createLogger({
  level: LogLevel.DEBUG,
  service: 'user-service',
  transports: {
    console: true,
    file: {
      enabled: true,
      filename: 'user-service.log',
      dirname: 'logs',
    },
  },
  format: {
    timestamp: true,
    colorize: true,
    json: false,
  },
});
```

### Legacy API

```typescript
import { log } from '@arcaai/logger';

log('Hello, world!');
log('User action', { userId: '123', action: 'login' });
```

## Log Levels

Levels follow the standard severity ordering (most to least severe):

| Level | Value | Description |
|-------|-------|-------------|
| `ERROR` | `error` | Errors that may still allow continued operation |
| `WARN` | `warn` | Warning conditions indicating potential issues |
| `INFO` | `info` | Normal operational messages (default level) |
| `HTTP` | `http` | HTTP request/response logging |
| `DEBUG` | `debug` | Detailed debugging information |
| `VERBOSE` | `verbose` | More detailed debugging messages |
| `SILLY` | `silly` | Most detailed tracing level |

Setting a level enables that level and all levels above it. For example, `LogLevel.DEBUG` enables `DEBUG`, `HTTP`, `INFO`, `WARN`, and `ERROR`.

## Transport Configuration

### Console

Outputs to stdout/stderr with optional color formatting.

```typescript
transports: {
  console: true,
}
```

### File

Writes to a static log file with optional size-based rotation.

```typescript
transports: {
  file: {
    enabled: true,
    filename: 'application.log',
    dirname: 'logs',
    maxSize: '10m',     // rotate after 10 MB
    maxFiles: '7d',     // retain for 7 days
  },
}
```

### Daily Rotate File

Time-based log rotation using `winston-daily-rotate-file`.

```typescript
transports: {
  rotate: {
    enabled: true,
    dirname: 'logs',
    filename: 'application-%DATE%.log',
    datePattern: 'yyyy-MM-dd',
    maxSize: '20m',
    maxFiles: '14d',
  },
}
```

### S3 / MinIO

Supports S3-compatible object storage for centralized log aggregation via `winston-s3-transport`.

> **Note:** The S3 transport configuration is provided in `LoggerOptions` but is not wired up automatically by the `Logger` class. Consumers should add the S3 transport manually via `logger.addTransport()` when needed.

**LoggerOptions S3 config:**

```typescript
transports: {
  s3: {
    enabled: true,
    bucket: 'application-logs',
    region: 'us-west-2',
    accessKeyId: 'YOUR_ACCESS_KEY',
    secretAccessKey: 'YOUR_SECRET_KEY',
    endpoint: 'http://minio.example.com:9000',   // for MinIO
    forcePathStyle: true,                          // for MinIO
    serverFilenameFormat: 'server-%DATE%.log',
    errorFilenameFormat: 'error-%DATE%.log',
    requestFilenameFormat: 'request-%DATE%.log',
  },
}
```

There is also an exported `S3Config` type for direct use with `winston-s3-transport`:

```typescript
type S3Config = {
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
```

## Format Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timestamp` | `boolean` | `true` | Prepend ISO timestamp to log entries |
| `colorize` | `boolean` | `true` | ANSI color codes for console output |
| `json` | `boolean` | `false` | Output structured JSON (recommended for cloud storage) |

### Output Examples

**Default format (human-readable):**

```
2026-02-19T10:30:00.000Z info: [user-service] User authenticated {"userId":"abc-123","role":"admin"}
```

**JSON format:**

```json
{"timestamp":"2026-02-19T10:30:00.000Z","level":"info","service":"user-service","message":"User authenticated","userId":"abc-123","role":"admin"}
```

## Configuration Reference

Full `LoggerOptions` interface:

```typescript
type LoggerOptions = {
  level?: LogLevel;           // minimum log level (default: INFO)
  service?: string;           // service name in log metadata (default: 'application')
  transports?: {
    console?: boolean;
    file?: { enabled: boolean; filename?: string; dirname?: string; maxSize?: string; maxFiles?: string };
    rotate?: { enabled: boolean; dirname?: string; filename?: string; datePattern?: string; maxSize?: string; maxFiles?: string };
    s3?: { enabled: boolean; bucket?: string; region?: string; accessKeyId?: string; secretAccessKey?: string; endpoint?: string; forcePathStyle?: boolean; serverFilenameFormat?: string; errorFilenameFormat?: string; requestFilenameFormat?: string };
  };
  format?: {
    timestamp?: boolean;
    colorize?: boolean;
    json?: boolean;
  };
};
```

## API Reference

### Logger Class

| Method | Signature | Description |
|--------|-----------|-------------|
| `error` | `(message: string, meta?: Record<string, any>)` | Log at ERROR level |
| `warn` | `(message: string, meta?: Record<string, any>)` | Log at WARN level |
| `info` | `(message: string, meta?: Record<string, any>)` | Log at INFO level |
| `http` | `(message: string, meta?: Record<string, any>)` | Log at HTTP level |
| `debug` | `(message: string, meta?: Record<string, any>)` | Log at DEBUG level |
| `verbose` | `(message: string, meta?: Record<string, any>)` | Log at VERBOSE level |
| `silly` | `(message: string, meta?: Record<string, any>)` | Log at SILLY level |
| `log` | `(level: LogLevel, message: string, meta?)` | Log at specified level |
| `addTransport` | `(transport: winston.transport)` | Add a custom transport at runtime |

### Exports

| Export | Type | Description |
|--------|------|-------------|
| `default` | `Logger` | Pre-configured default logger instance |
| `createLogger` | `(options?) => Logger` | Factory function for custom loggers |
| `log` | `(msg, meta?) => void` | Legacy helper (logs at INFO) |
| `Logger` | `class` | Logger class for direct instantiation |
| `LogLevel` | `enum` | Log level constants |
| `LoggerOptions` | `type` | Configuration options type |
| `S3Config` | `type` | S3 transport configuration type |

## Integration with NestJS

In the API gateway, the logger is typically configured as a NestJS provider via the logging module in [`@arcaai/applications`](../applications/README.md):

```typescript
import { createLogger, LogLevel } from '@arcaai/logger';

const appLogger = createLogger({
  level: process.env.LOG_LEVEL as LogLevel || LogLevel.INFO,
  service: 'api-gateway',
  transports: {
    console: true,
    rotate: {
      enabled: true,
      dirname: 'logs',
      filename: 'api-%DATE%.log',
      datePattern: 'yyyy-MM-dd',
      maxFiles: '30d',
    },
  },
  format: {
    timestamp: true,
    json: process.env.NODE_ENV === 'production',
  },
});
```

## Build and Testing

```bash
pnpm build        # Compile TypeScript
pnpm dev          # Watch mode
pnpm lint         # Lint
pnpm test         # Run tests (Vitest)
pnpm test:watch   # Watch mode tests
```

## Related Packages

- [`@arcaai/applications`](../applications/README.md) — Logging module wraps this package for NestJS DI
- [`@arcaai/exceptions`](../exceptions/README.md) — Exceptions carry correlation IDs for log correlation
