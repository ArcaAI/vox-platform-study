# @arcaai/logger

A flexible, configurable logging library for arcaai applications based on Winston.

## Features

- Multiple log levels: error, warn, info, http, debug, verbose, silly
- Multiple transport options: console, file, rotating file, S3/MinIO buckets
- Customizable formatting including timestamps, colors, and JSON output
- Metadata support for structured logging
- Simple API with both functional and class-based approaches

## Installation

```bash
# If using npm
npm install @arcaai/logger

# If using yarn
yarn add @arcaai/logger

# If using pnpm
pnpm add @arcaai/logger
```

## Basic Usage

```typescript
// Import the default logger
import logger from '@arcaai/logger';

// Log at different levels
logger.info('Application started');
logger.warn('Configuration file not found, using defaults');
logger.error('Failed to connect to database', { dbHost: 'localhost', port: 5432 });

// Add metadata to any log
logger.info('User authenticated', { userId: '123', role: 'admin' });
```

## Legacy API

```typescript
// Import the simple log function (logs at INFO level)
import { log } from '@arcaai/logger';

log('Hello, world!');
log('User action', { userId: '123', action: 'login' });
```

## Custom Logger Configuration

```typescript
import { createLogger, LogLevel } from '@arcaai/logger';

// Create a custom logger with specific configuration
const logger = createLogger({
  level: LogLevel.DEBUG,
  service: 'user-service',
  transports: {
    console: true,
    file: {
      enabled: true,
      filename: 'user-service.log',
      dirname: 'logs'
    }
  },
  format: {
    timestamp: true,
    colorize: true,
    json: false
  }
});

logger.debug('Detailed debug information');
logger.info('Operation completed successfully');
```

## S3/MinIO Configuration

Send logs directly to an S3-compatible storage service:

```typescript
import { createLogger, LogLevel } from '@arcaai/logger';

// Create a logger with S3 transport
const logger = createLogger({
  service: 'api-service',
  transports: {
    console: true,  // Also log to console
    s3: {
      enabled: true,
      bucket: 'application-logs',
      folder: 'api-service',
      filename: 'api-%DATE%.log',
      frequency: 'daily',
      // AWS S3 credentials
      accessKeyId: 'YOUR_ACCESS_KEY',
      secretAccessKey: 'YOUR_SECRET_KEY',
      region: 'us-west-2'
    }
  },
  format: {
    timestamp: true,
    json: true  // JSON format is recommended for cloud storage
  }
});

// For MinIO or other S3-compatible services
const minioLogger = createLogger({
  service: 'analytics-service',
  transports: {
    s3: {
      enabled: true,
      bucket: 'logs',
      // MinIO specific configuration
      endpoint: 'http://minio.example.com:9000',
      forcePathStyle: true,
      accessKeyId: 'MINIO_ACCESS_KEY',
      secretAccessKey: 'MINIO_SECRET_KEY',
      folder: 'analytics',
      filename: 'analytics-%DATE%.log',
      frequency: 'hourly'
    }
  }
});
```

## Configuration Options

### Log Levels

- `ERROR`: Error events that might still allow the application to continue running
- `WARN`: Warning events that indicate potential issues
- `INFO`: Informational messages that highlight the progress of the application
- `HTTP`: HTTP request-specific messages
- `DEBUG`: Detailed debugging information
- `VERBOSE`: More detailed debugging messages
- `SILLY`: The most detailed level for tracing

### Transport Options

- **Console**: Output logs to the console
  ```typescript
  transports: {
    console: true
  }
  ```

- **File**: Output logs to a file
  ```typescript
  transports: {
    file: {
      enabled: true,
      filename: 'application.log', // Filename
      dirname: 'logs',            // Directory
      maxSize: '10m',             // Max file size before rotating
      maxFiles: '7d'              // Retention period
    }
  }
  ```

- **Rotating File**: Output logs to files that rotate based on time
  ```typescript
  transports: {
    rotate: {
      enabled: true,
      dirname: 'logs',                     // Directory
      filename: 'application-%DATE%.log',  // Filename pattern
      datePattern: 'yyyy-MM-dd',          // Date format for rotation
      maxSize: '20m',                      // Max file size
      maxFiles: '14d'                      // Retention period
    }
  }
  ```

- **S3/MinIO**: Output logs to S3-compatible storage
  ```typescript
  transports: {
    s3: {
      enabled: true,
      bucket: 'logs',                      // S3 bucket name
      folder: 'application-logs',          // Folder within bucket
      filename: 'application-%DATE%.log',  // Filename pattern
      frequency: 'daily',                  // Rotation frequency ('daily', 'hourly', 'minutely', or number of minutes)
      accessKeyId: 'ACCESS_KEY',           // S3 access key
      secretAccessKey: 'SECRET_KEY',       // S3 secret key
      region: 'us-west-2',                 // AWS region (for AWS S3)
      endpoint: 'http://minio:9000',       // Custom endpoint (for MinIO)
      forcePathStyle: true                 // Path style access (for MinIO)
    }
  }
  ```

### Formatting Options

- **Timestamp**: Add timestamps to logs
  ```typescript
  format: {
    timestamp: true
  }
  ```

- **Colorize**: Add colors to console output
  ```typescript
  format: {
    colorize: true
  }
  ```

- **JSON**: Output logs in JSON format
  ```typescript
  format: {
    json: true
  }
  ```

## Contributing

Please refer to the contribution guidelines in the repository root.