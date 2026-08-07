import { ILoggingService, loadEnv, SecretsService } from '@arcaai/applications';
import { LogLevel, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { auditAdminRoutePermissions } from './bootstrap/admin-route-permission-audit';
import { assertGenaiContentCaptureDisabled } from './bootstrap/genai-content-capture-audit';
import { assertJwtSecretNotPlaceholder } from './bootstrap/jwt-secret-placeholder-audit';
// CORS helpers live in `cors.config.ts` so the dev / staging / production
// branches can be unit-tested without booting the Nest application.
// `isOriginAllowed` is re-exported so external consumers (docs reference)
// still have a working import.
import { apiEnv } from './config';
import { getCorsOrigins, isOriginAllowed } from './cors.config';
import { flushOtel } from './instrumentation';
import { ETagInterceptor } from './interceptors';
import { GracefulShutdownService } from './services';
// Swagger config lives in `swagger.config.ts` so the security-scheme list
// (bearer + api-key) is unit-testable.
import { buildSwaggerConfig } from './swagger.config';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- express-session ships an `export =` CJS module; `import session = require(...)` is the correct TS interop form, not an ESM default import
import session = require('express-session');

export { isOriginAllowed };

async function bootstrap() {
  // Read the env file for this NODE_ENV BEFORE anything in bootstrap() touches
  // `process.env`. `LOG_LEVEL`, `PORT`, `SHUTDOWN_*_MS` and
  // `CORS_ALLOWED_ORIGINS` below are all consumed before the Nest module graph
  // (and therefore ConfigService, the only previous caller of loadEnv) exists,
  // so without this line they silently saw host environment only.
  //
  // Safe to call here and again in ConfigService: the loader never overrides a
  // variable already present in `process.env`, and reads nothing when CI=true
  // or NODE_ENV=production.
  //
  // SCHEMA SEAM (TASK-558 lane D): the zod env schema validates *here*, right
  // after loadEnv() and before NestFactory.create(), so a missing env-tier var
  // fails fast at boot with the full list of problems (plan §9.2 L2).
  loadEnv();

  // PHI-safe telemetry (TASK-615 WS-G): refuse to boot in production unless
  // OTel GenAI content-capture is pinned off. Placed immediately after
  // `loadEnv()` — the earliest point `process.env` carries the fully
  // resolved (host env > env file) value — and before the zod schema below,
  // so a misconfigured production deploy fails on the single most direct
  // check rather than surfacing as a generic schema problem.
  assertGenaiContentCaptureDisabled();

  // Validate the declared env surface (built from the settings-registry
  // descriptors) and read the pre-bootstrap values from the TYPED result rather
  // than from `process.env` — the four reads below (`LOG_LEVEL`, `PORT`,
  // `SHUTDOWN_*_MS`, `CORS_ALLOWED_ORIGINS`) all happen before the Nest module
  // graph exists, so they are exactly the ones plan §4 B5 requires to move
  // behind the schema. Throws ONE error listing every problem; the process
  // exits before any port is bound.
  const env = apiEnv();

  // Disable colors in NestJS built-in logger
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- this WRITES the standard NO_COLOR convention var to steer a third-party logger; it is not an external config input, so it does not belong in turbo.json#globalEnv
  process.env.NO_COLOR = '1';

  // Helper function to parse log levels
  const getLogLevels = (level: string = 'info'): LogLevel[] => {
    const levels = ['error', 'warn', 'info', 'debug', 'verbose'];
    const currentLevelIndex = levels.indexOf(level);
    const result = currentLevelIndex >= 0 ? levels.slice(0, currentLevelIndex + 1) : ['error', 'warn', 'info'];
    return result.map((x) => (x === 'info' ? 'log' : x)) as LogLevel[];
  };

  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isDevelopment = nodeEnv === 'development';

  // In development, forceCloseConnections helps with hot reloading
  // In production, we want graceful shutdown to complete ongoing requests
  const app = await NestFactory.create(AppModule, {
    logger: getLogLevels(String(env.LOG_LEVEL)),
    bufferLogs: true,
    rawBody: true,
    forceCloseConnections: isDevelopment,
  });

  // Get the custom logging service and set it as the global logger
  const loggingService = app.get(ILoggingService);
  app.useLogger(loggingService);

  // Register crash handlers so uncaught exceptions/rejections are logged and flushed
  const { registerCrashHandlers } = await import('./crash-handlers');
  registerCrashHandlers(loggingService);

  // Use native WebSocket adapter for WebSocket support
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.useWebSocketAdapter(new WsAdapter(app) as any);

  const port = env.PORT as number;
  const globalPrefix = 'api/v1';

  app.setGlobalPrefix(globalPrefix, {
    exclude: [
      '/metrics',
      // v1-compat SMR summary shims (TASK-562). Excluded from the `api/v1`
      // global prefix so `@Controller('api/smr/api/v1')` yields the LITERAL v1
      // paths existing clients already call (TASK-560 §5.6), instead of being
      // rewritten to `/api/v1/api/smr/api/v1/...`.

      // v1-compatibility
      { path: 'api/smr/api/v1/summary/sync', method: RequestMethod.POST },
      { path: 'api/smr/api/v1/presummary', method: RequestMethod.POST },
      { path: 'api/stt/start_session', method: RequestMethod.POST },
      { path: 'api/stt/stop_session', method: RequestMethod.POST },
      { path: 'api/stt/switch', method: RequestMethod.POST },
    ],
  });

  if (!isProduction) {
    const config = buildSwaggerConfig().build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

  // The SecretsService cache is warmed inside `SecretsModule.forRoot`'s
  // async useFactory (driven by COMMON_SERVICE_WARMUP_KEYS in
  // packages/applications/src/services/baseServices/common.service.module.ts)
  // before NestJS instantiates any dependent provider, so JwtStrategy / the
  // OPENID_CLIENT factory / AuthController already observe a warm cache by
  // the time NestFactory.create() returns.
  const secretsService = app.get(SecretsService);

  // Refuse to start if JWT_SECRET_KEY resolved to the literal placeholder or
  // never warmed. Mirrors the in-strategy assertion in `JwtStrategy`
  // (defense-in-depth — strategy + bootstrap both refuse). With the
  // factory-driven warmup above, reaching this line means the strategy
  // already passed its own check, so this is a redundant sanity gate
  // retained for the audit trail.
  assertJwtSecretNotPlaceholder(secretsService);

  // Session configuration (debug logging removed - session config is sensitive)
  // SESSION_SECRET_KEY comes from SecretsService (warmed above), not process.env.
  const sessionSecret = await secretsService.getSecret('SESSION_SECRET_KEY');
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: isProduction,
        httpOnly: !isProduction,
        maxAge: 24 * 60 * 60 * 1000,
      },
    }),
  );

  // Strict input validation: whitelist + forbidNonWhitelisted + forbidUnknownValues
  // closes the JWT_SECRET_KEY mass-assignment exploit chain at the HTTP
  // boundary by rejecting any DTO key not declared on the target class.
  // Paired with the explicit-allowlist refactor in TenantService.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  // Renders RFC 7232 strong `ETag` headers from `body.version`. Non-versioned
  // routes pass through unchanged (the interceptor is zero-cost when there's
  // no version field). The `If-Match` round-trip on PATCH is enforced by
  // `@RequiresIfMatch()` + `@ExpectedVersion()`.
  app.useGlobalInterceptors(new ETagInterceptor());

  // Enable shutdown hooks for graceful termination
  // This activates onModuleDestroy, beforeApplicationShutdown, and onApplicationShutdown hooks
  // Required for proper Kubernetes/Docker graceful shutdown handling
  app.enableShutdownHooks();

  // Get the graceful shutdown service to log configuration
  const gracefulShutdownService = app.get(GracefulShutdownService);

  // Route the OTel flush through Nest's own shutdown sequence instead of the
  // competing SIGTERM handler `instrumentation.ts` used to install itself
  // (TASK-616 G0.1). `beforeApplicationShutdown` runs this alongside every
  // other cleanup callback, under its own timeout, after the readiness gate
  // has already closed and connections have started draining.
  gracefulShutdownService.registerCleanupCallback('otel-flush', flushOtel);

  loggingService.info(
    'Graceful shutdown enabled',
    {
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      drainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    },
    'Bootstrap',
  );

  // Configure CORS based on environment
  const corsOptions = {
    origin: getCorsOrigins(nodeEnv),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'api-key',
      'apikey',
      'x-api-key',
      'traceparent',
      'tracestate',
      'X-Request-Id',
      'X-Correlation-ID',
      'x-correlation-id',
      'X-Tenant-Id',
      'X-Project-Id',
      'X-Session-Id',
      'X-User-Agent',
      'X-SDK-Version',
      'Accept',
      'Accept-Language',
      'Accept-Encoding',
      'Cache-Control',
      'Origin',
      'Referer',
      'User-Agent',
    ],
  };

  app.enableCors(corsOptions);

  // Add security headers while maintaining SDK compatibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, res: any, next: any) => {
    // Security headers that don't interfere with SDK usage
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Only set CSP for HTML responses to avoid breaking API responses
    if (req.path.startsWith('/api/v1/docs')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    }

    next();
  });

  // Log CORS configuration
  const customOrigins = env.CORS_ALLOWED_ORIGINS as string | undefined;
  loggingService.info(
    'CORS configuration',
    {
      environment: nodeEnv,
      customOrigins: customOrigins ? customOrigins.split(',').map((o) => o.trim()) : null,
      policy: nodeEnv === 'development' ? 'allow_all' : nodeEnv === 'staging' ? 'localhost_and_staging_domains' : 'default_domains_and_https',
    },
    'Bootstrap',
  );

  // Refuses to start if ANY HTTP route lacks both `@Public()` and a
  // permission decorator (`@Authorize` / `@CanXxx`) — surfaces decorator
  // drift at boot rather than silently leaking PHI in production. Throws an
  // Error that propagates out of bootstrap() and terminates the process
  // before any request can be served. `UnifiedAuthGuard` (via `APP_GUARD`)
  // makes the same posture authoritative at request time.
  auditAdminRoutePermissions(app);

  await app.listen(port);

  // Use the custom logger for startup messages
  loggingService.info(
    'Application started',
    {
      environment: nodeEnv,
      port: Number(port),
      swaggerUrl: `http://localhost:${port}/api/v1/docs`,
      healthUrl: `http://localhost:${port}/api/v1/health`,
    },
    'Bootstrap',
  );
}

bootstrap();
