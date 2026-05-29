import { ILoggingService, SecretsService } from '@arcaai/applications';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { auditAdminRoutePermissions } from './bootstrap/admin-route-permission-audit';
import { assertJwtSecretNotPlaceholder } from './bootstrap/jwt-secret-placeholder-audit';
// TASK-310 E-2 (AC-4): CORS helpers extracted to `cors.config.ts` so the
// dev / staging / production branches can be unit-tested without booting
// the Nest application. `isOriginAllowed` is re-exported so historic
// external consumers (docs reference) still have a working import.
import { getCorsOrigins, isOriginAllowed } from './cors.config';
import { ETagInterceptor } from './interceptors';
import { GracefulShutdownService } from './services';
// TASK-310 E-8 (AC-8): Swagger config extracted so the security-scheme
// list (bearer + api-key) is unit-testable.
import { buildSwaggerConfig } from './swagger.config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import session = require('express-session');

export { isOriginAllowed };

async function bootstrap() {
  // Disable colors in NestJS built-in logger
  // eslint-disable-next-line turbo/no-undeclared-env-vars
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
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    logger: getLogLevels(process.env.LOG_LEVEL || 'info'),
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

  const port = process.env.PORT || 8868;
  const globalPrefix = 'api/v1';

  app.setGlobalPrefix(globalPrefix, {
    exclude: ['/metrics'],
  });

  if (!isProduction) {
    const config = buildSwaggerConfig().build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

  // TASK-302 Phase 3 Task 3.1 / TASK-307 W2.1 follow-up — the
  // SecretsService cache is now warmed inside `SecretsModule.forRoot`'s
  // async useFactory (driven by COMMON_SERVICE_WARMUP_KEYS in
  // packages/applications/src/services/baseServices/common.service.module.ts).
  // NestJS awaits the factory before instantiating any dependent
  // provider, so JwtStrategy / GatewayJwtStrategy / the OPENID_CLIENT
  // factory / AuthController already observe a warm cache by the
  // time NestFactory.create() returns. The previous `secretsService
  // .boot(...)` call here ran AFTER those constructors and could
  // never satisfy them — that ordering gap is what made the strategy
  // throw "JWT_SECRET_KEY is the literal placeholder" at every boot.
  const secretsService = app.get(SecretsService);

  // TASK-307 W2.2 (closes audit C-6 part 2) — refuse to start if
  // JWT_SECRET_KEY resolved to the literal placeholder or never warmed.
  // Mirrors the in-strategy assertion in `JwtStrategy` (defense-in-depth
  // — strategy + bootstrap both refuse). With the factory-driven warmup
  // above, reaching this line means the strategy already passed its
  // own check, so this is a redundant sanity gate retained for the
  // audit trail.
  assertJwtSecretNotPlaceholder(secretsService);

  // Session configuration (debug logging removed - session config is sensitive)
  // TASK-302 Phase 3 Task 3.2: SESSION_SECRET_KEY now comes from
  // SecretsService (warmed above) instead of process.env.
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

  // Phase 0 Item 1 (TASK-302 Stream A) — strict input validation.
  // Stage 2 (current): whitelist + forbidNonWhitelisted + forbidUnknownValues.
  // Closes the JWT_SECRET_KEY mass-assignment exploit chain at the HTTP
  // boundary by rejecting any DTO key not declared on the target class.
  // Backed by the explicit-allowlist refactor in TenantService (Item 2).
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  // TASK-302 Stream D Phase D (D.1) — render RFC 7232 strong `ETag`
  // headers from `body.version`. Non-versioned routes pass through
  // unchanged (the interceptor is zero-cost when there's no version
  // field). The `If-Match` round-trip on PATCH is enforced by
  // `@RequiresIfMatch()` + `@ExpectedVersion()` (D.2).
  app.useGlobalInterceptors(new ETagInterceptor());

  // Enable shutdown hooks for graceful termination
  // This activates onModuleDestroy, beforeApplicationShutdown, and onApplicationShutdown hooks
  // Required for proper Kubernetes/Docker graceful shutdown handling
  app.enableShutdownHooks();

  // Get the graceful shutdown service to log configuration
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const shutdownService = app.get(GracefulShutdownService);
  loggingService.info(
    'Graceful shutdown enabled',
    {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      shutdownTimeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10),
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      drainDelayMs: parseInt(process.env.SHUTDOWN_DRAIN_DELAY_MS || '5000', 10),
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
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const customOrigins = process.env.CORS_ALLOWED_ORIGINS;
  loggingService.info(
    'CORS configuration',
    {
      environment: nodeEnv,
      customOrigins: customOrigins ? customOrigins.split(',').map((o) => o.trim()) : null,
      policy: nodeEnv === 'development' ? 'allow_all' : nodeEnv === 'staging' ? 'localhost_and_staging_domains' : 'default_domains_and_https',
    },
    'Bootstrap',
  );

  // TASK-307 W4a.1 — refuse to start if ANY HTTP route lacks both
  // `@Public()` and a permission decorator (`@Authorize` / `@CanXxx`).
  // Originally `Phase 0 Item 3 (TASK-302 Stream A)` covered only
  // `/admin/*`; W4a.1 widened the walk to every route so drift surfaces
  // at boot rather than silently leaking PHI in production. Throws an
  // Error that propagates out of bootstrap() and terminates the process
  // before any request can be served. The runtime guard flip (W4b) made
  // the same posture authoritative at request time via `APP_GUARD`.
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
