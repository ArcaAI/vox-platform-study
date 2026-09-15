# Logging Service — pluggable, multi-transport structured logging

`ILoggingService` / `LoggingService` (`@arcaai/applications`), the shared logger every NestJS
service in the platform injects. It fans one structured log call out to whichever transports are
enabled by environment variable: console, rotating file, Highlight.io, Grafana Loki, and an
OpenTelemetry OTLP exporter (or an OTel log-bridge).

## Layout

| Path | What it holds |
|---|---|
| `ILoggingService.ts` | The injectable interface (`Symbol('ILoggingService')`) — `fatal/error/warn/info/debug/verbose/http`, `logWithLevel`, `setContext`, `child`, `withMeta`, `flush`, `getLevel`/`setLevel` |
| `logging.service.ts` | `LoggingService` — reads env, builds the transport list, redacts, dispatches |
| `transports/` | `base.transport.ts` + one file per transport (console, file, highlight, loki, otel, otel-log-bridge) |
| `redactor.ts` | PHI field redaction applied before any transport sees a log entry |
| `nestjs-logger.adapter.ts` | Adapts `ILoggingService` to Nest's `LoggerService` interface |
| `env.utils.ts` | `getEnvString`/`getEnvBoolean`/`getEnvNumber` helpers with defaults |

## How it works

### Transport selection (env-gated, verified in `logging.service.ts`)

| Transport | Enabled by | Key env vars |
|---|---|---|
| Console | `LOG_CONSOLE_ENABLED` (default `true`) | `LOG_CONSOLE_COLORIZE`, `LOG_CONSOLE_PRETTY`, `LOG_CONSOLE_JSON` (all default from `NODE_ENV`) |
| File | `LOG_FILE_ENABLED` (default `false`) | `LOG_FILE_PATH`, `LOG_FILE_MAX_SIZE`, `LOG_FILE_MAX_FILES`, `LOG_FILE_SEPARATE_ERROR` |
| Highlight.io | presence of `HIGHLIGHT_PROJECT_ID` (or its fallback `AGENTIC_HIGHLIGHT_PROJECT_ID`) | `HIGHLIGHT_BACKEND_URL`, `HIGHLIGHT_OTLP_ENDPOINT` |
| Grafana Loki | `LOKI_ENABLED` AND `LOKI_HOST` both set | `LOKI_BASIC_AUTH`, `LOKI_LABELS`, `LOKI_BATCH_INTERVAL`, `LOKI_BATCH_SIZE`, `LOKI_TIMEOUT` |
| OpenTelemetry | `OTEL_LOGS_ENABLED` | `OTEL_LOG_BRIDGE` (`true` selects the log-bridge transport instead of the OTLP HTTP exporter), `OTEL_EXPORTER_OTLP_ENDPOINT` (or fallback `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`), `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_INJECT_TRACE_CONTEXT`, `OTEL_RESOURCE_ATTRIBUTES` |

Common to all: `LOG_LEVEL`, `SERVICE_NAME`, `SERVICE_VERSION`, `NODE_ENV`.

### PHI redaction runs before every transport

`redactor.ts` is applied at the single `dispatch()` chokepoint in `logging.service.ts`, before ANY
transport sees the entry — mirroring the browser SDK's own redactor (`@arcaai/vox`
`core/logger/redactor.ts`) so both runtimes share one PHI key list and one set of semantics. It is a
deliberate copy, not a shared import: `packages/applications` is server-side and must not take a
dependency on a browser-only SDK. `LOG_REDACT_FIELDS` extends the built-in key list.

### Contextual loggers

`logger.child(context)` returns a new `ILoggingService` fixed to a context string (class/service
name); `logger.withMeta(meta)` returns one with default metadata (e.g. `requestId`, `tenantId`)
merged into every subsequent call.

## Gotchas

- The redactor **returns the original object reference when nothing needed redacting** — this is
  load-bearing, not an optimization: transports branch on `instanceof Error`, so a redacted `Error`
  is rebuilt as a real `Error` rather than a plain object, and identity-comparing callers keep
  working on the clean path.
- The OTel branch is exclusive: `OTEL_LOG_BRIDGE=true` selects the log-bridge transport INSTEAD of
  the OTLP HTTP exporter — both are never active together.
- Redaction lived nowhere on the backend until it was added here: before this module, `redactFields`
  was declared on `LoggingConfig` but had zero call sites, so every backend log line reached every
  transport unredacted.

## Related

- [`@arcaai/applications` README](../../../../README.md) — where `LoggingServiceModule` is wired in
- [`09-infrastructure-devops.md`](../../../../../../.claude/rules/09-infrastructure-devops.md) — observability stack (Loki/Tempo/Prometheus/Grafana)
