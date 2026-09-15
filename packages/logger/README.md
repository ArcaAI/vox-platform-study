# @arcaai/logger — standalone Winston logging library

A standalone Winston-based logging library for HOPE backend services. It wraps `winston` behind a
small `Logger` class with typed options, seven log levels, and console/file/rotating-file
transports, plus an `addTransport()` escape hatch for custom transports (for example S3-compatible
storage via `winston-s3-transport`). A leaf utility package with no HOPE-internal dependencies.

The API gateway's runtime request logging is currently implemented by the `LoggingService` inside
`@arcaai/applications` (`src/services/baseServices/logging/`), not by this package. `@arcaai/logger`
has no direct imports in workspace source today; it remains available as a self-contained Winston
wrapper for scripts and services that need one.

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | `Logger` class, `LogLevel` enum, `LoggerOptions`/`S3Config` types, `createLogger` factory, default logger instance, legacy `log()` |
| `src/__tests__/log.test.ts` | Vitest unit tests |

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsc` | `pnpm --filter @arcaai/logger build` |
| Watch | `tsc -w` | `pnpm --filter @arcaai/logger dev` |
| Test | `vitest run` | `pnpm --filter @arcaai/logger test` |
| Test (watch) | `vitest --watch` | `pnpm --filter @arcaai/logger test:watch` |
| Coverage | `vitest run --coverage` | `pnpm --filter @arcaai/logger test:cov` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/logger typecheck` |
| Lint | `eslint "src/**/*.ts*" --max-warnings 0` | `pnpm --filter @arcaai/logger lint` |
| Clean | `rimraf dist tsconfig.tsbuildinfo` | `pnpm --filter @arcaai/logger clean` |

## How it works

### Exports

| Export | Kind | Purpose |
|---|---|---|
| `default` | `Logger` instance | Pre-configured logger (console transport, INFO level) |
| `Logger` | class | Configurable logger wrapping a `winston.Logger` |
| `createLogger(options?)` | factory | `new Logger(options)` shorthand |
| `LogLevel` | enum | `ERROR`, `WARN`, `INFO`, `HTTP`, `DEBUG`, `VERBOSE`, `SILLY` |
| `LoggerOptions` | type | Constructor options (level, service, transports, format) |
| `S3Config` | type | Configuration shape for an S3/MinIO transport |
| `log(msg, meta?)` | function | Legacy helper; logs at INFO via the default logger |

### Basic usage

```typescript
import logger from '@arcaai/logger';

logger.info('Application started');
logger.warn('Configuration file not found, using defaults');
logger.error('Failed to connect to database', { dbHost: 'localhost', port: 5432 });
```

### Custom logger

```typescript
import { createLogger, LogLevel } from '@arcaai/logger';

const logger = createLogger({
  level: LogLevel.DEBUG,
  service: 'user-service',
  transports: {
    console: true,
    file: { enabled: true, filename: 'user-service.log', dirname: 'logs' },
  },
  format: { timestamp: true, colorize: true, json: false },
});

logger.debug('Detailed debug information');
```

### Transports

| Transport | Enabled via | Implementation |
|---|---|---|
| Console | `transports.console: true` | `winston.transports.Console` |
| File | `transports.file.enabled` | `winston.transports.File` (`filename`, `dirname`, `maxSize`, `maxFiles`) |
| Rotating file | `transports.rotate.enabled` | `winston-daily-rotate-file` (`datePattern`, `maxSize`, `maxFiles`) |
| S3 / MinIO | `logger.addTransport(...)` | Not constructed by the factory; consumers instantiate `winston-s3-transport` themselves and attach it |

The `Logger` constructor only builds console, file, and rotate transports. The `transports.s3`
option block and the `S3Config` type describe the configuration shape, but the S3 transport itself
must be added by the consumer:

```typescript
import { createLogger } from '@arcaai/logger';
import S3Transport from 'winston-s3-transport';

const logger = createLogger({ service: 'api-service', format: { json: true } });
logger.addTransport(new S3Transport({/* bucket, credentials, ... */}));
```

### Formatting

`format` options: `timestamp` (prefix each line), `colorize` (console colors), `json` (structured
JSON output; recommended for shipping to object storage or log aggregators). Non-JSON output
renders as `<timestamp> <level>: [<service>] <message> <meta-json>`.

## Gotchas

- This package is dependency-free of the rest of the monorepo but has zero real import call sites
  today — `@arcaai/applications`'s own `LoggingService` (see its README) is the one every NestJS
  service actually injects. Confirm which logger a new call site should use before wiring one in.

## Related

- [`@arcaai/applications` baseServices logging README](../applications/src/services/baseServices/logging/README.md) — the logger actually used by NestJS services
