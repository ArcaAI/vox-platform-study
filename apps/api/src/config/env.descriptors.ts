// The API gateway's env-tier declarations that the settings registry does not
// (yet) carry.
//
// WHY THIS FILE EXISTS
// Lane F registered the bootstrap floor (`BOOTSTRAP_ENV_SETTINGS`), the platform
// knobs, the feature gates and the platform secrets. It did NOT register the
// gateway's SERVICE TOPOLOGY (`*_URL` / `*_PORT`) or its process-level
// observability / Vault-client / storage knobs, even though the env-tier plan assigns
// all of them to the `env` tier ("all `*_PORT`, all `*_URL` service endpoints,
// `OTEL_*`, `LOG_FILE_*`, `SERVICE_NAME`, `HOSTNAME`, `CI`").
//
// They are declared HERE rather than in `descriptors/**` because that directory
// is lane F's; every descriptor below is a candidate to move there verbatim
// (nothing about it is apps/api-specific except its current home).
//
// THE RULE FOR THIS FILE — one declaration per key, and only real ones:
//   * every entry corresponds to a VERIFIED reader: a `process.env.<NAME>` read
//     in apps/api/** or packages/** (non-test), or a documented read in the
//     dev/test shell scripts (the `Ports` group below). The reading file is
//     named in the description; `default` is transcribed from that reader's own
//     fallback, never invented.
//   * `tier: 'env'` — a deploy-time value with no admin write path, so
//     `editableBy: EDITABLE_BY_NONE` (the governance invariant lane F binds
//     both ways).
// * `failMode` follows the boot contract: `closed` ⇒ the reader
//     has NO fallback and absence must fail fast; `open-to-default` ⇒ the reader
//     has a code fallback, transcribed into `default`.
//
// Nothing here is admin-editable and nothing is a secret: every platform secret
// already lives in `platform-secrets.descriptors.ts` (tier `vault-kv`).

import { EDITABLE_BY_NONE, type SettingDescriptor } from '@arcaai/applications';

function envKnob(
  key: string,
  dataType: SettingDescriptor['dataType'],
  category: string,
  label: string,
  description: string,
  defaultValue?: unknown,
): SettingDescriptor {
  return {
    key,
    tier: 'env',
    dataType,
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    // Every knob below has a transcribed code fallback, so the boot contract
    // is `open-to-default` throughout. The only unconditionally REQUIRED
    // gateway variable is `DATABASE_URL`, declared by lane F as `closed`.
    failMode: 'open-to-default',
    category,
    label,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

/**
 * Service topology: the gateway's downstream endpoints. Every one is resolved
 * through `IConfigService.getConfigValue(...)`; direct `process.env` reads of
 * these names inside `apps/api/src/modules/**` are lint-banned
 * (`arcaai-internal/no-direct-downstream-url-env`).
 *
 * Defaults transcribed from `ConfigService.loadBaseConfig()`
 * (`packages/applications/src/services/baseServices/_meta/config/config.service.ts`).
 */
const TOPOLOGY: SettingDescriptor[] = [
  envKnob('url', 'string', 'Topology', 'Gateway base URL', 'Public base URL the gateway advertises for itself.', 'http://localhost'),
  envKnob('stt.url', 'string', 'Topology', 'STT service URL', 'Speech-to-text service base URL (apps/stt, port 8861).', 'http://localhost:8861'),
  envKnob('text.url', 'string', 'Topology', 'Text service URL', 'Text service base URL (apps/text, port 8862).', 'http://localhost:8862'),
  envKnob('text.port', 'number', 'Topology', 'Text port', 'Port apps/text binds; the gateway keeps it only to build health-probe URLs.', 8862),
  envKnob(
    'guardrail.url',
    'string',
    'Topology',
    'Guardrail service URL',
    'Safety-engine base URL (apps/guardrail, port 8863).',
    'http://localhost:8863',
  ),
  envKnob('nlp.url', 'string', 'Topology', 'NLP service URL', 'Medical-NLP base URL (apps/nlp, port 8864).', 'http://localhost:8864'),
  envKnob('nlp.port', 'number', 'Topology', 'NLP port', 'Port apps/nlp binds.', 8864),
  envKnob('tts.url', 'string', 'Topology', 'TTS service URL', 'Text-to-speech base URL (apps/tts, port 8865).', 'http://localhost:8865'),
  envKnob('tts.port', 'number', 'Topology', 'TTS port', 'Port apps/tts binds.', 8865),
  envKnob(
    'harness.url',
    'string',
    'Topology',
    'Harness service URL',
    'Clinical Documentation Harness base URL (apps/harness, port 8866).',
    'http://localhost:8866',
  ),
  envKnob(
    'adminConsole.url',
    'string',
    'Topology',
    'Admin console URL',
    'Origin of the Next.js admin console; used by the gateway e2e harness and CORS guidance.',
    'http://localhost:5176',
  ),
  envKnob(
    'passwordReset.baseUrl',
    'string',
    'Topology',
    'Password-reset link base URL',
    'Base URL embedded in password-reset emails (`IPasswordResetMailer.DEFAULT_PASSWORD_RESET_BASE_URL`).',
    'http://localhost:5176',
  ),
  envKnob(
    'prometheus.url',
    'string',
    'Topology',
    'Prometheus base URL',
    'Prometheus query endpoint for the platform-metrics service (`prometheus-query.service.ts`).',
    'http://localhost:9090',
  ),
];

/**
 * The ports the local dev/test SUPERVISOR binds. Read by `scripts/dev-stack.sh`,
 * `scripts/start-test-app.sh`, `scripts/test-stack.sh`, `scripts/test-run.sh` and
 * `scripts/test-doctor.sh` — not by TypeScript, which is why they carry no
 * `process.env` reader. Declared anyway so the ONE port topology is documented in
 * ONE generated place: `.env.test` runs every application port at DEV + 100
 * (commit d84f538e), and the defaults below are the DEV half.
 *
 * `TEXT_PORT` / `NLP_PORT` / `TTS_PORT` are in the topology group above instead —
 * `ConfigService` really does read those three.
 */
const PORTS: SettingDescriptor[] = [
  envKnob(
    'api.port',
    'number',
    'Ports',
    'API gateway port (supervisor)',
    'Port the dev/test supervisor expects the gateway on; the gateway itself binds `PORT`.',
    8868,
  ),
  envKnob('stt.port', 'number', 'Ports', 'STT port', 'Port apps/stt binds (test: 8961).', 8861),
  envKnob('guardrail.port', 'number', 'Ports', 'Guardrail port', 'Port apps/guardrail binds (test: 8963).', 8863),
  envKnob('harness.port', 'number', 'Ports', 'Harness port', 'Port apps/harness binds (test: 8966).', 8866),
  envKnob(
    'api.inspectHostport',
    'string',
    'Ports',
    'Node inspector host:port',
    'Inspector endpoint for `nest start --debug`, so a test gateway can be debugged alongside a dev one (test: 127.0.0.1:9329).',
    '127.0.0.1:9229',
  ),
];

/** Process identity + logging (`ConfigService.loadBaseConfig()`). */
const PROCESS_IDENTITY: SettingDescriptor[] = [
  envKnob('serviceName', 'string', 'Process', 'Service name', 'Logical service name stamped on logs and metrics.', 'hope-api'),
  envKnob('debug', 'boolean', 'Process', 'Debug mode', 'Enables verbose config/service debug logging.', false),
  envKnob('nestDebug', 'boolean', 'Process', 'Nest debug mode', 'Enables NestJS-internal debug logging.', false),
  envKnob(
    'envFilePath',
    'string',
    'Process',
    'Explicit env-file path',
    'Overrides the NODE_ENV→file map used by `loadEnv()`. Unset in every normal deployment.',
  ),
  // The generated `.env.sample` is DEV-SHAPED, so it ships this ON; the runtime
  // default stays `false`. Keeping the two apart is the whole point of
  // `sampleValue` — a deployed environment reads host env only and leaves this
  // unset, and an unset boolean must resolve to "module off". Flipping the
  // `envKnob` default instead would mount Prisma Studio in exactly those
  // deployments, which is why the sample was previously hand-edited (and drifted).
  {
    ...envKnob(
      'enablePrismaStudio',
      'boolean',
      'Process',
      'Enable Prisma Studio module',
      'Mounts the Prisma Studio module (`app.module.ts`). ON in this dev-shaped sample so `pnpm setup:dev` leaves /db-studio working with no extra step; access still requires the dedicated `manage:PrismaStudio` ability (SUPER_ADMIN policy set). Deployed environments read host env only and leave it unset, which keeps the module off.',
      false,
    ),
    sampleValue: true,
  },
  envKnob(
    'appSettings.bootInvariant',
    'string',
    'Process',
    'AppSettings boot-invariant mode',
    'Set to `skip` (development only) to bypass the AppSettings boot invariant (`appSettings.service.ts`).',
  ),
  envKnob('logFile.enabled', 'boolean', 'Logging', 'File logging enabled', 'Writes rotating log files in addition to stdout.', false),
  envKnob('logFile.path', 'string', 'Logging', 'Log directory', 'Directory rotating log files are written to.', './logs'),
  envKnob('logFile.maxSize', 'string', 'Logging', 'Log rotation size', 'Rotate after this much data (winston-daily-rotate-file syntax).', '10m'),
  envKnob('logFile.maxFiles', 'number', 'Logging', 'Log files retained', 'Number of rotated log files kept.', 1000),
  envKnob('logFile.datePattern', 'string', 'Logging', 'Log rotation date pattern', 'Date pattern in rotated log file names.', 'yyyy-MM-dd'),
  envKnob(
    'logFile.separateError',
    'boolean',
    'Logging',
    'Separate error log',
    'Writes errors to their own file in addition to the combined log.',
    false,
  ),
  // Loki push transport (`logging.service.ts`). Declared here rather than
  // discovered by the TypeScript scan because the reader goes through
  // `getEnvString`/`getEnvBoolean` (`logging/env.utils.ts`), which index
  // `process.env[key]` dynamically — the scanner's `process.env.NAME` regex
  // cannot see them. They were therefore absent from `turbo.json#globalEnv`
  // entirely, so a fully-implemented transport had no declared config path and
  // Turbo never invalidated its cache when the destination changed
  // PHI redaction. The canonical PHI key list lives in
  // `logging/redactor.ts` and always applies; this only ADDS deployment-
  // specific field names. Declared here for the same reason as the Loki keys:
  // the reader goes through `getEnvString`, which the env-sync scanner cannot
  // see. This is the variable `LoggingConfig.redactFields` always implied.
  envKnob(
    'log.redactFields',
    'string',
    'Logging',
    'Extra PHI fields to redact',
    'Comma-separated field names redacted from every log entry, on top of the built-in PHI key list. Matching is case-insensitive and ignores _ and -.',
  ),
  // Console transport (`logging.service.ts:93-97`). Same reason as the Loki keys
  // below: the reads go through `getEnvString`/`getEnvBoolean`, whose dynamic
  // `process.env[key]` indexing the env-sync scanner cannot see — so they
  // reached `turbo.json#globalEnv` (which unions declared AND scanned names)
  // while appearing in NO `.env.sample`. `env:sync --check` only asserts the
  // opposite direction ("no unread keys"), so nothing flagged it: an operator
  // reading the sample could not discover that these knobs exist at all.
  //
  // Defaults are transcribed from the reader, INCLUDING the two that are
  // environment-dependent (`isDevelopment()`): the sample is dev-shaped, so the
  // dev value is the truthful one to show.
  envKnob(
    'logConsole.enabled',
    'boolean',
    'Logging',
    'Console logging enabled',
    'Writes log records to stdout. Turning this off leaves only the file/Loki/OTel transports.',
    true,
  ),
  // These three have NO runtime `default` on purpose, and that is not an
  // oversight: their reader's fallback is `isDevelopment()`, not a constant, so
  // transcribing either branch as a `default` would be inventing one — and
  // `.env.sample` is dev-shaped, so an operator copying it into production
  // would turn pretty-printing on there. `sampleValue` is exactly the seam for
  // that split (same reasoning as `enablePrismaStudio` above): the sample shows
  // the development shape while an unset variable leaves the reader's own
  // environment-dependent fallback in charge.
  {
    ...envKnob(
      'logConsole.colorize',
      'boolean',
      'Logging',
      'Colorize console output',
      'ANSI colour on stdout. Unset ⇒ ON in development and OFF elsewhere (`isDevelopment()`), so a collected log stream is not full of escape codes.',
    ),
    sampleValue: true,
  },
  {
    ...envKnob(
      'logConsole.pretty',
      'boolean',
      'Logging',
      'Pretty-print console output',
      'Human-readable multi-line records. Unset ⇒ ON in development and OFF elsewhere (`isDevelopment()`).',
    ),
    sampleValue: true,
  },
  {
    ...envKnob(
      'logConsole.json',
      'boolean',
      'Logging',
      'JSON console output',
      'One JSON object per record — the shape a collector parses. The inverse of the development default: unset ⇒ ON outside development.',
    ),
    sampleValue: false,
  },
  envKnob('loki.enabled', 'boolean', 'Logging', 'Loki transport enabled', 'Pushes logs to Loki in addition to stdout. Requires `LOKI_HOST`.', false),
  envKnob(
    'loki.host',
    'string',
    'Logging',
    'Loki base URL',
    'Loki base URL; the transport appends `/loki/api/v1/push`. Unset disables the transport.',
  ),
  envKnob(
    'loki.labels',
    'string',
    'Logging',
    'Loki extra labels',
    'Comma-separated `key=value` pairs merged into every stream label set. Keep LOW-cardinality — never a tenant, user, or request id.',
  ),
  envKnob(
    'loki.basicAuth',
    'string',
    'Logging',
    'Loki basic-auth credentials',
    'HTTP basic-auth string (`user:password`) for the Loki push endpoint. Unset means the endpoint is reached unauthenticated — appropriate only in-cluster.',
  ),
  envKnob('loki.batchInterval', 'number', 'Logging', 'Loki batch interval (ms)', 'How long the transport buffers records before pushing.', 5000),
  envKnob('loki.batchSize', 'number', 'Logging', 'Loki batch size', 'Maximum records per push.', 1000),
  envKnob('loki.timeout', 'number', 'Logging', 'Loki push timeout (ms)', 'Per-push HTTP timeout.', 30000),
  // Highlight.io session/error transport (`logging.service.ts:119-129`).
  // `HIGHLIGHT_PROJECT_ID` is the switch: unset ⇒ the transport never mounts,
  // which is why every field here is `open-to-default` with no default.
  envKnob(
    'highlight.projectId',
    'string',
    'Logging',
    'Highlight.io project id',
    'Enables the Highlight.io log transport. UNSET ⇒ the transport does not mount at all, which is the shipped posture.',
  ),
  envKnob(
    'agenticHighlight.projectId',
    'string',
    'Logging',
    'Highlight.io project id (legacy name)',
    'Legacy alias read only when `HIGHLIGHT_PROJECT_ID` is unset. Prefer the unprefixed name; this exists so an older deployment keeps working.',
  ),
  envKnob(
    'highlight.backendUrl',
    'string',
    'Logging',
    'Highlight.io backend URL',
    'Overrides the Highlight.io ingest backend. Unset uses the vendor default.',
  ),
  envKnob(
    'highlight.otlpEndpoint',
    'string',
    'Logging',
    'Highlight.io OTLP endpoint',
    'Overrides the Highlight.io OTLP endpoint. Unset uses the vendor default.',
  ),
];

/** OpenTelemetry (`apps/api/src/instrumentation.ts`, `observability/otel.service.ts`). */
const OBSERVABILITY: SettingDescriptor[] = [
  envKnob('otel.sdkDisabled', 'boolean', 'Observability', 'Disable the OTel SDK', 'Skips OpenTelemetry SDK start-up entirely.', false),
  envKnob('otel.debug', 'boolean', 'Observability', 'OTel diagnostic logging', 'Enables the OpenTelemetry diagnostic logger.', false),
  envKnob('otel.exporterOtlpEndpoint', 'string', 'Observability', 'OTLP endpoint', 'gRPC OTLP collector endpoint. Unset disables the exporters.'),
  envKnob('otel.serviceName', 'string', 'Observability', 'OTel service name', 'Value of the `service.name` resource attribute.', 'api-gateway'),
  envKnob('otel.serviceVersion', 'string', 'Observability', 'OTel service version', 'Value of the `service.version` resource attribute.', '1.0.0'),
  envKnob('otel.metricsEnabled', 'boolean', 'Observability', 'OTel metrics enabled', 'Turns on the OpenTelemetry metrics pipeline.', false),
  envKnob('otel.tracesEnabled', 'boolean', 'Observability', 'OTel traces enabled', 'Turns on the OpenTelemetry tracing pipeline.', false),
  // The OTel LOG pipeline (`logging.service.ts:158-183`) — distinct from the
  // trace/metric pipelines above, with its own enable flag, its own endpoint
  // and its own protocol. Read through `getEnvString`/`getEnvBoolean`, so
  // invisible to the env-sync scanner and previously absent from every sample.
  envKnob(
    'otel.logsEnabled',
    'boolean',
    'Observability',
    'OTel log export enabled',
    'Exports log records over OTLP in addition to the console transport.',
    false,
  ),
  envKnob(
    'otel.logBridge',
    'boolean',
    'Observability',
    'Use the OTel log bridge',
    'Emits through the OpenTelemetry logs bridge API rather than the direct exporter.',
    false,
  ),
  envKnob(
    'otel.exporterOtlpLogsEndpoint',
    'string',
    'Observability',
    'OTLP logs endpoint',
    'Signal-specific OTLP endpoint for LOGS. Read only when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset; the signal-specific name wins per the OTel spec.',
  ),
  envKnob(
    'otel.exporterOtlpProtocol',
    'string',
    'Observability',
    'OTLP protocol',
    'Wire protocol for the OTLP log exporter (`http/json`, `http/protobuf`, `grpc`).',
    'http/json',
  ),
  envKnob(
    'otel.injectTraceContext',
    'boolean',
    'Observability',
    'Inject trace context into logs',
    'Stamps the active trace/span ids onto every log record so logs and traces correlate.',
    true,
  ),
  envKnob(
    'otel.resourceAttributes',
    'string',
    'Observability',
    'OTel resource attributes',
    'Comma-separated `key=value` pairs merged into the OTel resource. Keep LOW-cardinality and PHI-free — resource attributes are attached to every exported record.',
  ),
  // Read by `logging.service.ts:61` to LABEL log records. It is NOT the release
  // version: build identity is baked into the image as `/app/build-info.json`
  // and is deliberately not settable from configuration. Declared
  // because the read is real and an undeclared read is invisible to operators —
  // not as an invitation to set it.
  envKnob(
    'serviceVersion',
    'string',
    'Process',
    'Service version label on logs',
    'Version string stamped on log records. Build identity comes from the image’s `build-info.json`, never from this.',
    '1.0.0',
  ),
  envKnob(
    'metricsPrefix',
    'string',
    'Observability',
    'Metrics name prefix',
    'Prefix for Prometheus metric names; defaults to the sanitized service name.',
  ),
  envKnob(
    'metricsCollectInterval',
    'number',
    'Observability',
    'Metrics collection interval (ms)',
    'Interval of the simplified monitoring collector.',
    15000,
  ),
  // PHI-safe telemetry, layer 1 of 4 (docs/operations
  // telemetry-phi-guardrails.md). This is a cross-process OTel
  // instrumentation-library convention — the SAME bare name is read by
  // apps/text's `TelemetryPhiGuardConfig` (Python) — so it carries no
  // per-service prefix. Deliberately no runtime `default`: the boot audit
  // (`bootstrap/genai-content-capture-audit.ts`, called from `main.ts`
  // immediately after `loadEnv()`) must be able to tell "unset" apart from
  // "explicitly NO_CONTENT" in production. `sampleValue` still pins the
  // literal in every generated `.env.sample`.
  {
    ...envKnob(
      'otel.instrumentation.genai.captureMessageContent',
      'string',
      'Observability',
      'GenAI content-capture switch',
      'Pins the OTel GenAI instrumentation-library content-capture switch off, so prompt/completion text (PHI) is never stamped onto spans. Boot-time audit refuses to start in production unless this is exactly NO_CONTENT.',
    ),
    sampleValue: 'NO_CONTENT',
  },
];

/**
 * Vault client + dynamic PostgreSQL credentials
 * (`secrets.module.ts`, `apps/api/src/vault-prisma.module.ts`,
 * `apps/api/src/workers/vault-rotation.worker.module.ts`,
 * `packages/database/src/vault-client.ts`). The AppRole credentials themselves
 * are lane F's bootstrap floor; these are the surrounding client settings.
 */
const VAULT_CLIENT: SettingDescriptor[] = [
  envKnob('vault.namespace', 'string', 'Secrets', 'Vault namespace', 'Vault Enterprise namespace. Unset on OSS Vault.'),
  envKnob(
    'vault.transitMount',
    'string',
    'Secrets',
    'Vault Transit mount',
    'Mount path of the Transit engine used for envelope encryption.',
    'transit',
  ),
  envKnob(
    'vault.transitKey',
    'string',
    'Secrets',
    'Transit key (GlobalSetting)',
    'Transit key that wraps `GlobalSetting.encryptedValue`.',
    'hope-globalsetting',
  ),
  envKnob('vault.transitKeyPhi', 'string', 'Secrets', 'Transit key (PHI)', 'Transit key that wraps PHI columns.', 'hope-phi'),
  envKnob('vault.requestTimeoutMs', 'number', 'Secrets', 'Vault request timeout (ms)', 'Per-request timeout of the Vault HTTP client.', 5000),
  {
    ...envKnob(
      'vault.auditLogPath',
      'string',
      'Secrets',
      'Vault audit-log path',
      'File the rotation worker tails for Vault audit events. Unset disables the worker.',
    ),
    sampleValue: './temp/vault.log',
  },
  envKnob('vault.token', 'string', 'Secrets', 'Vault token', 'Direct Vault token. Operator/CLI path only — services authenticate with AppRole.'),
  {
    ...envKnob(
      'vault.devRootToken',
      'string',
      'Secrets',
      'Vault dev root token',
      'Root token of the LOCAL dev Vault; used by seeds. Never set in a deployed environment.',
    ),
    // `docker-compose.dev.yml` boots Vault dev-mode with `${VAULT_DEV_ROOT_TOKEN:-root}`
    // — `root` is the fixed default for every developer's local Vault, not a
    // runtime fallback substituted for a missing value elsewhere.
    sampleValue: 'root',
  },
  envKnob('secrets.ttlSec', 'number', 'Secrets', 'Secret cache TTL (s)', 'Per-entry TTL of the SecretsService LRU cache.', 300),
  envKnob('secrets.lruMax', 'number', 'Secrets', 'Secret cache size', 'Maximum entries in the SecretsService LRU cache.', 200),
  envKnob(
    'secrets.rewarmIntervalSec',
    'number',
    'Secrets',
    'Secret warmup re-warm interval (s)',
    'How often the SecretsService re-warms its boot warmup set so the cache-only getSecretSync path (TEXT/TTS X-Service-Token) never expires cold. Unset/<=0 derives max(30, TTL/2).',
    0,
  ),
  envKnob(
    'pg.dynamicCreds',
    'boolean',
    'Database',
    'Vault dynamic DB credentials',
    'Opt in to Vault-issued, short-lived PostgreSQL credentials (plan §4 B6).',
    false,
  ),
  envKnob(
    'pg.vaultRole',
    'string',
    'Database',
    'Vault database role',
    'Vault database-engine role that mints the dynamic credentials.',
    'hope-app-role',
  ),
  envKnob('pg.vaultMaxTtlSec', 'number', 'Database', 'Dynamic credential max TTL (s)', 'Upper bound applied to a Vault-issued credential lease.'),
  envKnob(
    'pg.host',
    'string',
    'Database',
    'PostgreSQL host',
    'Host used when assembling a dynamic-credential connection (`vault-client.ts`).',
    'localhost',
  ),
  envKnob('pg.port', 'number', 'Database', 'PostgreSQL port', 'Port used when assembling a dynamic-credential connection.', 5432),
  envKnob('pg.database', 'string', 'Database', 'PostgreSQL database', 'Database used when assembling a dynamic-credential connection.', 'hope_main'),
];

/** Object storage + message bus (`ConfigService`, `media-storage.ts`, seeds). */
const DATA_PLANE: SettingDescriptor[] = [
  envKnob('minio.useSsl', 'boolean', 'Storage', 'MinIO/S3 TLS', 'Whether the object-storage endpoint is reached over TLS.', false),
  envKnob('minio.region', 'string', 'Storage', 'MinIO/S3 region', 'Region passed to the S3-compatible client.', 'us-east-1'),
  envKnob('mqtt.host', 'string', 'Messaging', 'MQTT host', 'MQTT broker host.', 'localhost'),
  envKnob('mqtt.port', 'number', 'Messaging', 'MQTT port', 'MQTT broker port.', 1883),
  envKnob('mqtt.user', 'string', 'Messaging', 'MQTT user', 'MQTT broker username. The password is a `vault-kv` secret (`MQTT_PASS`).'),
];

/** Gateway streaming backpressure (`stt-ws.gateway.ts`, `tts-ws.gateway.ts`). */
const STREAMING: SettingDescriptor[] = [
  envKnob(
    'stt.ws.egressHighWatermarkBytes',
    'number',
    'Streaming',
    'STT WS egress high-water mark (bytes)',
    'Buffered-amount threshold above which partial transcripts are dropped.',
    524288,
  ),
  envKnob(
    'stt.ws.resumeGraceMs',
    'number',
    'Streaming',
    'STT WS resume grace (ms)',
    'Window a disconnected STT session is held open for reconnect.',
    15000,
  ),
  envKnob(
    'tts.ws.egressHighWatermarkBytes',
    'number',
    'Streaming',
    'TTS WS egress high-water mark (bytes)',
    'Buffered-amount threshold above which TTS audio frames are dropped.',
    524288,
  ),
];

/**
 * Every gateway-owned env declaration. Consumed by `env.schema.ts` (boot
 * validation) and by `scripts/env-sync.ts` (example-file + turbo.json
 * generation) — one declaration, three derived artifacts.
 */
export const API_PLATFORM_ENV_SETTINGS: SettingDescriptor[] = [
  ...TOPOLOGY,
  ...PORTS,
  ...PROCESS_IDENTITY,
  ...OBSERVABILITY,
  ...VAULT_CLIENT,
  ...DATA_PLANE,
  ...STREAMING,
];
