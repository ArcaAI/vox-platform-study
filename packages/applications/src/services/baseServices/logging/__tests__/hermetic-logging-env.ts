/**
 * A copy of `env` with every variable that configures `LoggingService`'s
 * level and transports removed, so a suite asserts the service's DEFAULTS
 * rather than whatever the invoking shell happens to carry.
 *
 * `pnpm test:unit` runs under `dotenv -e .env.test`, which sets
 * `LOG_LEVEL=error` and `LOG_CONSOLE_JSON=false` / `LOG_CONSOLE_PRETTY=true`.
 * Suites that spread `process.env` into their fixture inherited those, so
 * every `info()` was gated out and the format-selection defaults were
 * overridden — 46 failures that vanished when the same files ran without the
 * env file (TASK-1026).
 *
 * Service identity (`SERVICE_NAME`, `NODE_ENV`, ...) is left alone: the
 * suites that care set it explicitly.
 */
const LOGGING_CONFIG_PREFIXES = ['LOG_', 'LOKI_', 'HIGHLIGHT_', 'AGENTIC_HIGHLIGHT_'];
const LOGGING_CONFIG_KEYS = ['OTEL_LOGS_ENABLED', 'OTEL_LOG_BRIDGE'];

export function hermeticLoggingEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !LOGGING_CONFIG_KEYS.includes(key) && !LOGGING_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );
}
