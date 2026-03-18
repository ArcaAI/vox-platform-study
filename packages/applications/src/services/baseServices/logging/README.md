# Logging Service

A pluggable logging system with support for multiple observability backends.

## Supported Transports

| Transport | Description | Use Case |
|-----------|-------------|----------|
| **Console** | stdout/stderr output | Development, container logs |
| **File** | Rotating log files | Local debugging, compliance |
| **Highlight.io** | Error tracking & monitoring | Production monitoring |
| **Loki** | Grafana log aggregation | Grafana stack integration |
| **OpenTelemetry** | OTLP export | Any OTLP-compatible backend |

## Environment Variables

### General Logging

```bash
NODE_ENV=development          # development, staging, production
LOG_LEVEL=info                # trace, debug, info, warn, error, fatal
SERVICE_NAME=api              # Service name for all logs
SERVICE_VERSION=1.0.0         # Service version
```

### Console Transport

```bash
LOG_CONSOLE_ENABLED=true      # Enable console logging
LOG_CONSOLE_COLORIZE=true     # Colorized output (dev only)
LOG_CONSOLE_PRETTY=true       # Pretty print format (dev only)
LOG_CONSOLE_JSON=false        # JSON format (production)
```

### File Transport

```bash
LOG_FILE_ENABLED=false        # Enable file logging
LOG_FILE_PATH=./logs          # Directory for log files
LOG_FILE_MAX_SIZE=10m         # Max file size before rotation
LOG_FILE_MAX_FILES=30         # Number of files to retain
LOG_FILE_SEPARATE_ERROR=true  # Separate error.log file
```

### Highlight.io Transport

```bash
HIGHLIGHT_PROJECT_ID=xxx      # Highlight.io project ID
HIGHLIGHT_BACKEND_URL=        # Custom backend URL (optional)
HIGHLIGHT_OTLP_ENDPOINT=      # Custom OTLP endpoint (optional)
```

### Grafana Loki Transport

```bash
LOKI_ENABLED=false            # Enable Loki transport
LOKI_HOST=http://loki:3100    # Loki server URL
LOKI_BASIC_AUTH=user:pass     # Basic auth (optional)
LOKI_LABELS=app=api,team=eng  # Additional labels
LOKI_BATCH_INTERVAL=5000      # Batch interval (ms)
LOKI_BATCH_SIZE=1000          # Max batch size
LOKI_TIMEOUT=30000            # Request timeout (ms)
```

### OpenTelemetry Transport

```bash
OTEL_LOGS_ENABLED=false                    # Enable OTLP logs
OTEL_EXPORTER_OTLP_ENDPOINT=http://...:4318  # OTLP endpoint
OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # Protocol
OTEL_INJECT_TRACE_CONTEXT=true             # Inject trace/span IDs
OTEL_RESOURCE_ATTRIBUTES=key=val,key2=val2 # Resource attributes
```

## Usage

### Basic Usage

```typescript
import { ILoggingService } from '@arcaai/applications';

@Injectable()
class MyService {
    constructor(
        @Inject(ILoggingService)
        private readonly logger: ILoggingService
    ) {}

    async doSomething() {
        this.logger.info('Processing request', 'MyService');

        try {
            // ...
        } catch (error) {
            this.logger.error('Failed to process', error, 'MyService');
        }
    }
}
```

### Structured Logging with Metadata

```typescript
// With trace context
this.logger.info('Request received', {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    requestId: req.id,
    userId: user.id,
    tenantId: tenant.id,
}, 'RequestHandler');

// With custom metadata
this.logger.info('Order processed', {
    orderId: order.id,
    amount: order.total,
    items: order.items.length,
}, 'OrderService');
```

### Child Loggers

```typescript
// Create a child logger with fixed context
const orderLogger = this.logger.child('OrderService');
orderLogger.info('Order created');  // Context: OrderService

// Create a child logger with default metadata
const requestLogger = this.logger.withMeta({
    requestId: req.id,
    userId: user.id,
});
requestLogger.info('Processing');  // Includes requestId and userId
```

## Log Entry Structure

All logs include the following fields:

```typescript
interface LogEntry {
    level: string;          // Log level (trace, debug, info, warn, error, fatal)
    message: string;        // Log message
    timestamp: string;      // ISO timestamp
    context?: string;       // Logger context (class/service name)
    traceId?: string;       // OpenTelemetry trace ID
    spanId?: string;        // OpenTelemetry span ID
    requestId?: string;     // Request correlation ID
    userId?: string;        // User ID
    tenantId?: string;      // Tenant ID
    error?: object;         // Error details (for error logs)
    meta?: object;          // Additional metadata
    serviceName: string;    // Service name
    serviceVersion: string; // Service version
    environment: string;    // Environment (dev/staging/prod)
    hostname: string;       // Host name
    pid: number;           // Process ID
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     LoggingService                          │
│  ├── createLogEntry()                                       │
│  ├── dispatch() ─────────────────────────────────────────┐  │
│  └── flush()                                             │  │
└──────────────────────────────────────────────────────────┼──┘
                                                           │
        ┌──────────────┬──────────────┬──────────────┬─────┼──────┐
        ▼              ▼              ▼              ▼     ▼      │
┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
│  Console  │  │   File    │  │ Highlight │  │   Loki    │  │   OTEL    │
│ Transport │  │ Transport │  │ Transport │  │ Transport │  │ Transport │
└───────────┘  └───────────┘  └───────────┘  └───────────┘  └───────────┘
      │              │              │              │              │
      ▼              ▼              ▼              ▼              ▼
   stdout        ./logs/      Highlight.io   Grafana Loki   OTLP Backend
   stderr      combined.log                                 (Tempo/Alloy)
```

## Best Practices

### Label Strategy for Grafana Loki

Use labels for **low-cardinality** data only:
- `service` - Service name
- `env` - Environment
- `level` - Log level

Store **high-cardinality** data in the log line:
- `trace_id`, `span_id`
- `request_id`
- `user_id`
- Any per-request data

### Trace Correlation

For full trace correlation with Grafana Tempo:

1. Enable OTEL transport with trace context injection
2. Use consistent `service.name` across all telemetry
3. Configure Grafana to link Loki → Tempo using `trace_id`

### Production Recommendations

1. **Console**: JSON format, shipped to log aggregator
2. **File**: Disabled (use container logs instead)
3. **Loki/OTEL**: Choose based on your stack
   - Grafana stack → Use Loki or OTEL transport
   - Highlight.io → Use Highlight transport

## Troubleshooting

### Logs not appearing in Loki

1. Check `LOKI_ENABLED=true` and `LOKI_HOST` is set
2. Verify network connectivity to Loki
3. Check Loki's `/ready` endpoint
4. Review Loki ingestion limits

### Trace IDs not correlating

1. Ensure `OTEL_INJECT_TRACE_CONTEXT=true`
2. Verify OTEL SDK is initialized before logging service
3. Check that traces are being sent to Tempo

### High memory usage

1. Reduce `LOKI_BATCH_SIZE` or `batchSize` in transports
2. Increase `LOKI_BATCH_INTERVAL` to flush more frequently
3. Review log volume - consider sampling for debug logs
