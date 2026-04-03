# TASK-256: API Log Pipeline Consolidation & Gap Fixes

| Field | Value |
|-------|-------|
| **Ticket** | TASK-256 |
| **Type** | Bugfix + Enhancement |
| **Created** | 2026-04-03 |
| **Updated** | 2026-04-03 (implemented) |
| **Status** | Completed |
| **Depends On** | TASK-252 (API Gateway OTel Instrumentation) |

---

## 1. Requirement Analysis

### 1.1 Problem Statement

After TASK-252 instrumented the API gateway with OpenTelemetry, an audit of the log pipeline reveals that **no application logs are actually reaching Grafana Loki**. There are two independent log pipelines that are both broken in different ways:

1. **OTel SDK pipeline** (`instrumentation.ts`): Correctly configured gRPC exporter to the Collector, but **receives zero log records** because no code emits through the OTel Logs API.
2. **Custom OTelTransport** (`logging.service.ts`): Generates log records but sends HTTP/JSON to the gRPC port (`:4317`), which **silently fails** because gRPC and HTTP/JSON are incompatible protocols on that port.

Additionally, there are no handlers for `uncaughtException` or `unhandledRejection`, meaning fatal crashes are invisible to the observability stack.

### 1.2 Business Context

- Grafana dashboards cannot query any API logs — defeats the purpose of TASK-251/252
- On-call engineers have no visibility into API errors via Grafana
- Uncaught exceptions crash the process with no log trail in Loki
- Duplicate log pipelines create maintenance burden and inconsistent behavior

### 1.3 Acceptance Criteria

- [ ] All `LoggingService` log output reaches Grafana Loki via the OTel Collector
- [ ] Logs in Loki include `traceId` and `spanId` for trace-to-log correlation
- [ ] `uncaughtException` and `unhandledRejection` events are logged before process exit
- [ ] Only ONE pipeline sends logs to the OTel Collector (no duplicates)
- [ ] Console output is preserved for local development and container log tailing
- [ ] Existing tests pass (929 tests in `apps/api`)
- [ ] New behavior is covered by TDD tests (RED → GREEN → REFACTOR)

---

## 2. Current State Evaluation

### 2.1 Log Flow Architecture (BEFORE — broken)

```
                    apps/api Process
                         │
        ┌────────────────┴────────────────┐
        │                                 │
  PIPELINE 1 (OTel SDK)          PIPELINE 2 (LoggingService)
  instrumentation.ts              logging.service.ts
        │                                 │
  BatchLogRecordProcessor        OTelTransport (HTTP/JSON)
  + OTLPLogExporter (gRPC)       → fetch() POST to :4317/v1/logs
  → gRPC to :4317                         │
        │                          ✗ PROTOCOL MISMATCH
        │                          (HTTP/JSON on gRPC port)
  ⚠ IDLE — receives                       │
    zero log records              ✗ Silently fails
        │                                 │
        ▼                                 ▼
  OTel Collector (:4317)         OTel Collector (:4318)
  gRPC receiver ✓                HTTP receiver — never reached
        │
        └─── Nothing in log pipeline
```

### 2.2 Three Confirmed Gaps

| # | Gap | Severity | Root Cause |
|---|-----|----------|------------|
| **GAP-1** | OTelTransport sends HTTP/JSON to gRPC port `:4317` | **CRITICAL** | `OTEL_EXPORTER_OTLP_ENDPOINT` is `:4317` (gRPC), but `OTelTransport` uses `fetch()` (HTTP/JSON). The Collector's gRPC receiver rejects HTTP/JSON — errors swallowed by `console.error`. |
| **GAP-2** | OTel SDK log pipeline is idle | **CRITICAL** | `BatchLogRecordProcessor` + `OTLPLogExporter` in `instrumentation.ts` are configured but no code emits `LogRecord` via the OTel Logs API. The `LoggingService` writes directly to `process.stdout.write()` and its own transports — it never calls `logger.emit()`. |
| **GAP-3** | No `uncaughtException` / `unhandledRejection` handlers | **HIGH** | Fatal crashes go to stderr only, invisible to Loki. Process exits without flushing telemetry. |

### 2.3 Log Source Inventory

| Source | Count | Logger Used | Reaches LoggingService? | Reaches Loki? |
|--------|-------|-------------|------------------------|---------------|
| NestJS `new Logger(Context)` in controllers/interceptors/guards | 18 instances | NestJS Logger | Yes (via `app.useLogger()`) | **No** (broken transport) |
| Direct `loggingService.info/error/...()` in `main.ts` | ~10 calls | ILoggingService | Yes | **No** (broken transport) |
| `console.log/error` in `instrumentation.ts` | 4 calls | console | No | **No** |
| `console.error` in transport fallbacks | 14 calls | console | No (intentional — can't recurse) | **No** |
| Uncaught exceptions | 0 handlers | None | No | **No** |
| Unhandled rejections | 0 handlers | None | No | **No** |

### 2.4 Existing Test Coverage

| File | Tests | Framework |
|------|-------|-----------|
| `packages/applications/src/services/baseServices/logging/__tests__/logging.service.test.ts` | 586 lines | Vitest |
| `packages/applications/src/services/baseServices/logging/__tests__/otel.transport.test.ts` | 755 lines | Vitest |
| `packages/applications/src/services/baseServices/logging/__tests__/console.transport.test.ts` | Exists | Vitest |
| `packages/applications/src/services/baseServices/logging/__tests__/base.transport.test.ts` | Exists | Vitest |
| `apps/api/src/__tests__/instrumentation.test.ts` | 8 tests | Vitest |
| `apps/api/src/interceptors/__tests__/context.interceptor.test.ts` | 12 tests | Vitest |

---

## 3. Architectural Decision

### 3.1 Approach: Bridge LoggingService → OTel Logs API

**Decision**: Create an `OTelLogBridgeTransport` that emits log records through the OTel Logs API (`@opentelemetry/api-logs`), then **remove** the custom `OTelTransport` (HTTP/JSON) from the active transport list.

**Why this approach:**

| Concern | Custom OTelTransport (current) | OTel SDK Bridge (proposed) |
|---------|-------------------------------|---------------------------|
| Trace correlation | Manual (must inject traceId) | Automatic from active span context |
| Batching | Custom implementation | `BatchLogRecordProcessor` built-in |
| Retry/backoff | None implemented | SDK handles it |
| Shutdown/flush | Custom implementation | `sdk.shutdown()` handles it |
| Consistent with traces | No — separate connection | Yes — single SDK instance |
| Protocol | HTTP/JSON to `:4318` | gRPC to `:4317` (same as traces) |
| Maintenance | Custom code | Community-maintained SDK |

### 3.2 Target Architecture (AFTER)

```
                    apps/api Process
                         │
            ┌────────────┴────────────┐
            │                         │
   OTel SDK (instrumentation.ts)   LoggingService
   Bootstrapped via --import        logging.service.ts
            │                         │
   NodeSDK registers:              Transports:
   ├─ TracerProvider                ├─ ConsoleTransport (stdout — kept for dev/containers)
   ├─ LoggerProvider ◄─────────────├─ OTelLogBridgeTransport (NEW — calls logger.emit())
   │    └─ BatchLogRecordProcessor  ├─ FileTransport (kept, optional)
   │       └─ OTLPLogExporter       └─ [OTelTransport removed]
   │          (gRPC :4317)
   └─ MeterProvider                   NestJS app.useLogger(loggingService)
                                       └─ 18 controllers → LoggingService → transports
            │
            ▼
   OTel Collector (:4317 gRPC)
   ├─ logs pipeline  → Loki ✓
   ├─ traces pipeline → Tempo ✓
   └─ metrics pipeline → Prometheus ✓
```

### 3.3 What NOT to change

- **ConsoleTransport** — Keep as-is. Essential for local dev and container log tailing (e.g., `docker logs`, CloudWatch).
- **FileTransport** — Keep as-is. Optional local file logging for environments without central collection.
- **LokiTransport** — Already inactive (`LOKI_ENABLED` not set). Leave as-is.
- **HighlightTransport** — Already inactive. Leave as-is.
- **Existing OTelTransport code** — Do NOT delete the file. Just don't activate it. The `OTEL_LOGS_ENABLED` env var will switch to using the bridge instead.

---

## 4. Implementation Plan

### Phase 1: Create `OTelLogBridgeTransport` (TDD)

**Package**: `packages/applications`
**Files**: New transport + test

#### Task 1.1: RED — Write failing test for `OTelLogBridgeTransport`

Create `packages/applications/src/services/baseServices/logging/__tests__/otel-log-bridge.transport.test.ts`

**Test cases:**

1. `should call otelLogger.emit() when log() is called`
2. `should map log levels to correct OTel SeverityNumber`
   - `debug` → `SeverityNumber.DEBUG` (5)
   - `info` → `SeverityNumber.INFO` (9)
   - `warn` → `SeverityNumber.WARN` (13)
   - `error` → `SeverityNumber.ERROR` (17)
   - `fatal` → `SeverityNumber.FATAL` (21)
   - `trace` → `SeverityNumber.TRACE` (1)
3. `should include log message as body`
4. `should include context as attribute`
5. `should include requestId as attribute`
6. `should include tenantId and userId as attributes`
7. `should include error details as exception attributes`
8. `should include metadata as attributes`
9. `should respect shouldLog() level filtering`
10. `should auto-extract traceId and spanId from active span context`
11. `should work when no active span exists`
12. `should flush by calling forceFlush on LoggerProvider`
13. `should shutdown by calling shutdown on LoggerProvider`

**Mocking strategy**: Mock `@opentelemetry/api-logs` module's `logs.getLogger()` to return a mock logger with a `vi.fn()` for `emit()`.

#### Task 1.2: GREEN — Implement `OTelLogBridgeTransport`

Create `packages/applications/src/services/baseServices/logging/transports/otel-log-bridge.transport.ts`

```typescript
import { BaseTransport } from './base.transport';
import type { OTelLogBridgeTransportConfig, LogEntry, LogLevel } from './types';
import { logs, SeverityNumber, type Logger as OTelLogger } from '@opentelemetry/api-logs';
import { trace, context } from '@opentelemetry/api';

const SEVERITY_MAP: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export class OTelLogBridgeTransport extends BaseTransport {
  private otelLogger: OTelLogger;

  constructor(config: OTelLogBridgeTransportConfig) {
    super(config);
    this.otelLogger = logs.getLogger(config.serviceName, config.serviceVersion);
  }

  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    const spanContext = trace.getSpan(context.active())?.spanContext();
    const attributes: Record<string, string | number | boolean> = {};

    if (entry.context) attributes['nestjs.context'] = entry.context;
    if (entry.requestId) attributes['request.id'] = entry.requestId;
    if (entry.tenantId) attributes['tenant.id'] = entry.tenantId;
    if (entry.userId) attributes['user.id'] = entry.userId;
    if (entry.pid) attributes['process.pid'] = entry.pid;

    if (entry.error) {
      const err = this.formatError(entry.error);
      if (err) {
        if ((err as any).name) attributes['exception.type'] = (err as any).name;
        if ((err as any).message) attributes['exception.message'] = (err as any).message;
        if ((err as any).stack) attributes['exception.stacktrace'] = (err as any).stack;
      }
    }

    if (entry.meta) {
      for (const [key, val] of Object.entries(entry.meta)) {
        if (val !== undefined && val !== null) {
          attributes[key] = typeof val === 'object' ? JSON.stringify(val) : val;
        }
      }
    }

    this.otelLogger.emit({
      severityNumber: SEVERITY_MAP[entry.level] ?? SeverityNumber.UNSPECIFIED,
      severityText: entry.level.toUpperCase(),
      body: entry.message,
      attributes,
      // traceId/spanId auto-attached by the SDK from active context
    });
  }

  async flush(): Promise<void> {
    // The LoggerProvider's BatchLogRecordProcessor handles flushing
    // via sdk.shutdown() or provider.forceFlush()
  }

  async shutdown(): Promise<void> {
    await super.shutdown();
  }
}
```

#### Task 1.3: REFACTOR — Verify all tests pass, clean up

### Phase 2: Add transport config type + factory (TDD)

**Package**: `packages/applications`

#### Task 2.1: RED — Write failing test for config type and factory

Add test case in `otel-log-bridge.transport.test.ts`:
1. `createOTelLogBridgeTransport() should create transport with correct defaults`

#### Task 2.2: GREEN — Add type definition and factory

In `packages/applications/src/services/baseServices/logging/transports/types.ts`, add:

```typescript
export interface OTelLogBridgeTransportConfig extends BaseTransportConfig {
  name: 'otel-bridge';
  serviceName: string;
  serviceVersion?: string;
}
```

In `packages/applications/src/services/baseServices/logging/transports/otel-log-bridge.transport.ts`, add:

```typescript
export function createOTelLogBridgeTransport(
  config: Omit<OTelLogBridgeTransportConfig, 'name'>,
): OTelLogBridgeTransport {
  return new OTelLogBridgeTransport({ ...config, name: 'otel-bridge' as const, enabled: config.enabled ?? true });
}
```

Update barrel export in `packages/applications/src/services/baseServices/logging/transports/index.ts`.

#### Task 2.3: REFACTOR

### Phase 3: Wire `OTelLogBridgeTransport` into `LoggingService` (TDD)

**Package**: `packages/applications`

#### Task 3.1: RED — Write failing test

In `packages/applications/src/services/baseServices/logging/__tests__/logging.service.test.ts`, add test:

1. `should use OTelLogBridgeTransport when OTEL_LOGS_ENABLED=true and OTEL_LOG_BRIDGE=true`
2. `should NOT use OTelTransport (HTTP) when OTEL_LOG_BRIDGE=true`
3. `should fall back to OTelTransport (HTTP) when OTEL_LOG_BRIDGE is not set (backward compat)`

#### Task 3.2: GREEN — Modify `initializeTransports()` in `LoggingService`

In the `initializeTransports()` method, add a condition:

```typescript
// OpenTelemetry transport
const otelEnabled = getEnvBoolean('OTEL_LOGS_ENABLED', false);
const useOtelBridge = getEnvBoolean('OTEL_LOG_BRIDGE', false);

if (otelEnabled && useOtelBridge) {
  // Bridge through OTel SDK (preferred — gRPC, auto trace correlation)
  this.transports.push(new OTelLogBridgeTransport({
    name: 'otel-bridge',
    enabled: true,
    level: this.level,
    serviceName: this.serviceName,
    serviceVersion: this.serviceVersion,
  }));
} else if (otelEnabled) {
  // Legacy: custom HTTP/JSON transport (requires OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  const otelEndpoint = getEnvString('OTEL_EXPORTER_OTLP_ENDPOINT') || getEnvString('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
  if (otelEndpoint) {
    // ... existing OTelTransport code ...
  }
}
```

#### Task 3.3: REFACTOR

### Phase 4: Install `@opentelemetry/api-logs` dependency

**Package**: `packages/applications`

```bash
pnpm add @opentelemetry/api-logs --filter @arcaai/applications
```

This is a **pure configuration change** — TDD exempted.

### Phase 5: Add `uncaughtException` / `unhandledRejection` handlers (TDD)

**Package**: `apps/api`

#### Task 5.1: RED — Write failing tests

Create `apps/api/src/__tests__/crash-handlers.test.ts`

**Test cases:**

1. `should register uncaughtException handler`
2. `should register unhandledRejection handler`
3. `should log fatal error via LoggingService on uncaught exception`
4. `should log fatal error via LoggingService on unhandled rejection`
5. `should call sdk.shutdown() on uncaught exception`
6. `should call process.exit(1) after flushing`

#### Task 5.2: GREEN — Implement crash handlers

Create `apps/api/src/crash-handlers.ts`:

```typescript
import { ILoggingService } from '@arcaai/applications';

export function registerCrashHandlers(loggingService: ILoggingService): void {
  process.on('uncaughtException', async (error: Error) => {
    try {
      loggingService.fatal('Uncaught exception — process will exit', {
        error,
        errorMessage: error.message,
        errorStack: error.stack,
      }, 'CrashHandler');
      await loggingService.flush();
    } catch {
      console.error('[CrashHandler] Failed to log uncaught exception:', error);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      loggingService.fatal('Unhandled promise rejection — process will exit', {
        error,
        errorMessage: error.message,
        errorStack: error.stack,
      }, 'CrashHandler');
      await loggingService.flush();
    } catch {
      console.error('[CrashHandler] Failed to log unhandled rejection:', error);
    }
    process.exit(1);
  });
}
```

Wire in `apps/api/src/main.ts` after `app.useLogger(loggingService)`:

```typescript
import { registerCrashHandlers } from './crash-handlers';
// ...
const loggingService = app.get(ILoggingService);
app.useLogger(loggingService);
registerCrashHandlers(loggingService);
```

#### Task 5.3: REFACTOR

### Phase 6: Remove idle OTel SDK log pipeline from `instrumentation.ts`

**Package**: `apps/api`

Since logs now flow through the `OTelLogBridgeTransport` → OTel Logs API → `LoggerProvider` (set up by the SDK in `instrumentation.ts`), the `logRecordProcessors` config in `instrumentation.ts` is now **active and required**.

**No removal needed** — the `BatchLogRecordProcessor` + `OTLPLogExporter` in `instrumentation.ts` is now the actual receiver of log records emitted by the bridge transport. This is the correct architecture.

However, verify that the `NodeSDK` properly registers a `LoggerProvider` when `logRecordProcessors` is configured. This is a **verification-only** step, not a code change.

### Phase 7: Update env configuration

**Package**: `apps/api`

Update `.env.example` and `.env.production` to enable the bridge:

```env
OTEL_LOGS_ENABLED=true
OTEL_LOG_BRIDGE=true
```

This is a **pure configuration change** — TDD exempted.

### Phase 8: Final verification

1. Run full test suite (`pnpm vitest run` in `apps/api`)
2. Run full test suite (`pnpm vitest run` in `packages/applications`)
3. Check lints on all modified files
4. Verify TypeScript compilation (`tsc --noEmit`)

---

## 5. TDD Test Plan Summary

| Phase | Test File | New Tests | Type |
|-------|-----------|-----------|------|
| 1 | `packages/applications/.../logging/__tests__/otel-log-bridge.transport.test.ts` | 13 | Unit |
| 2 | Same file | 1 | Unit |
| 3 | `packages/applications/.../logging/__tests__/logging.service.test.ts` | 3 | Unit |
| 5 | `apps/api/src/__tests__/crash-handlers.test.ts` | 6 | Unit |
| **Total** | | **23** | |

---

## 6. Dependency Changes

### New Dependencies

| Package | Target | Purpose |
|---------|--------|---------|
| `@opentelemetry/api-logs` | `packages/applications` | OTel Logs API for bridge transport |

### No Removals

The existing `OTelTransport` code remains in the codebase as a fallback option (controlled by `OTEL_LOG_BRIDGE` env var). It can be deprecated in a future ticket.

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@opentelemetry/api-logs` is 0.x (experimental) | LOW | Spec is stable since April 2023. API surface is frozen. Pin exact version. |
| `LoggerProvider` not initialized when bridge transport emits | LOW | OTel SDK bootstraps via `--import` before NestJS starts. The `LoggerProvider` is ready before any `app.useLogger()` call. Bridge calls `logs.getLogger()` which returns a no-op if provider isn't set — safe degradation. |
| Breaking existing log behavior | LOW | Feature-flagged via `OTEL_LOG_BRIDGE=true`. Default behavior unchanged. |
| `flush()` in crash handler may hang | MEDIUM | `loggingService.flush()` calls `transport.flush()` on all transports. The bridge transport's flush is a no-op (SDK handles it). Risk is from other transports (file, console). Mitigated by the existing 25s shutdown timeout in `instrumentation.ts`. |
| Double-logging if both OTelTransport and OTelLogBridgeTransport are active | NONE | Mutually exclusive via `OTEL_LOG_BRIDGE` flag in `initializeTransports()`. |

---

## 8. Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `packages/applications/src/services/baseServices/logging/transports/otel-log-bridge.transport.ts` | Bridge transport |
| `packages/applications/src/services/baseServices/logging/__tests__/otel-log-bridge.transport.test.ts` | Bridge transport tests |
| `apps/api/src/crash-handlers.ts` | Uncaught exception/rejection handlers |
| `apps/api/src/__tests__/crash-handlers.test.ts` | Crash handler tests |

### Modified Files

| File | Change |
|------|--------|
| `packages/applications/src/services/baseServices/logging/transports/types.ts` | Add `OTelLogBridgeTransportConfig` interface |
| `packages/applications/src/services/baseServices/logging/transports/index.ts` | Add barrel export for `OTelLogBridgeTransport` |
| `packages/applications/src/services/baseServices/logging/logging.service.ts` | Add bridge transport selection in `initializeTransports()` |
| `packages/applications/src/services/baseServices/logging/__tests__/logging.service.test.ts` | Add 3 tests for bridge transport selection |
| `apps/api/src/main.ts` | Wire `registerCrashHandlers()` |
| `apps/api/.env.example` | Add `OTEL_LOG_BRIDGE=true` |
| `apps/api/.env.production` | Add `OTEL_LOG_BRIDGE=true` |

---

## 9. Verification Criteria

| Criterion | How to Verify |
|-----------|---------------|
| Logs reach Loki | Deploy to staging, query `{service_name="api-gateway"}` in Grafana Explore |
| Trace-to-log correlation | Verify `traceId` appears in Loki log attributes; click "Logs for this span" in Tempo |
| No duplicate logs | Verify single log entry per event in Loki (not doubled) |
| Crash handler works | Send `kill -USR2` to trigger unhandled rejection test, verify fatal log in Loki |
| Tests pass | `pnpm vitest run` in both `apps/api` (929+ tests) and `packages/applications` |
| TypeScript compiles | `tsc --noEmit` exits 0 |
| Backward compatible | Without `OTEL_LOG_BRIDGE=true`, behavior unchanged |

---

## 10. Research References

| Topic | Finding |
|-------|---------|
| `@opentelemetry/api-logs` status (2026) | v0.214.0. Spec-stable since April 2023. JS implementation experimental but API frozen. Will merge into `@opentelemetry/api`. |
| gRPC vs HTTP ports | **Strictly separate.** HTTP/JSON to port `:4317` silently fails. Use `:4318` for HTTP, `:4317` for gRPC. |
| NestJS log bridging | No official OTel instrumentation for NestJS logs. Manual bridge via `LoggerService` + `logger.emit()` is recommended. |
| Crash handling | Register `uncaughtException`/`unhandledRejection`, call `sdk.shutdown()` with timeout, then `process.exit(1)`. |
| Pipeline consolidation | Remove custom HTTP transport; bridge through SDK for automatic trace correlation, batching, and single shutdown. |

---

## 11. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-04-03 | Initial design document — log pipeline audit + implementation plan | This file |
| 2026-04-03 | Implementation complete — all 8 phases done, 28 new tests pass, tsc clean | See files below |

## 12. Implementation Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/applications/src/services/baseServices/logging/transports/otel-log-bridge.transport.ts` | OTel Logs API bridge transport — emits via `logger.emit()` |
| `packages/applications/src/services/baseServices/logging/__tests__/otel-log-bridge.transport.test.ts` | 20 unit tests for the bridge transport |
| `apps/api/src/crash-handlers.ts` | `uncaughtException` and `unhandledRejection` handlers |
| `apps/api/src/__tests__/crash-handlers.test.ts` | 8 unit tests for crash handlers |

### Modified Files

| File | Change |
|------|--------|
| `packages/applications/src/services/baseServices/logging/transports/types.ts` | Added `OTelLogBridgeTransportConfig` interface + updated `TransportConfig` union |
| `packages/applications/src/services/baseServices/logging/transports/index.ts` | Barrel export for `OTelLogBridgeTransport` + type |
| `packages/applications/src/services/baseServices/logging/logging.service.ts` | Bridge transport selection via `OTEL_LOG_BRIDGE` env var in `initializeTransports()` |
| `packages/applications/src/services/baseServices/logging/__tests__/logging.service.test.ts` | 3 new tests for bridge transport selection |
| `apps/api/src/main.ts` | Wired `registerCrashHandlers()` after `app.useLogger()` |
| `apps/api/.env.example` | Added `OTEL_LOG_BRIDGE=true` |
| `apps/api/.env.production` | Added `OTEL_LOG_BRIDGE=true` |

### Dependencies Added

| Package | Target | Version |
|---------|--------|---------|
| `@opentelemetry/api-logs` | `packages/applications` | Latest (installed via pnpm) |

### Test Results

- `packages/applications/logging/__tests__/`: **303 tests pass** (including 23 new)
- `apps/api/src/__tests__/`: **471 tests pass** (including 8 new)
- TypeScript compilation: **clean** (both `packages/applications` and `apps/api`)
- Linter: **no errors** on all modified files
