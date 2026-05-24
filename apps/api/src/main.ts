import { ILoggingService } from '@arcaai/applications';
import { Logger, LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { auditAdminRoutePermissions } from './bootstrap/admin-route-permission-audit';
import { ETagInterceptor } from './interceptors';
import { GracefulShutdownService } from './services';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import session = require('express-session');

// Bootstrap-level logger for CORS decisions (temporary Logger until app is initialized)
const corsLogger = new Logger('CORS');

/**
 * CORS origin logger - only logs in debug mode with structured metadata
 */
function logCorsDecision(origin: string | undefined, allowed: boolean, reason: string): boolean {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
    corsLogger.debug({
      message: 'CORS decision',
      origin: origin || 'none',
      allowed,
      reason,
    });
  }
  return allowed;
}

/**
 * Shared CORS configuration for both HTTP and WebSocket
 */
export function isOriginAllowed(origin: string | undefined, nodeEnv: string): boolean {
  // Allow requests with no origin (mobile apps, server-to-server, etc.)
  if (!origin) {
    return logCorsDecision(origin, true, 'no_origin_provided');
  }

  if (nodeEnv === 'production') {
    // Get allowed origins from environment variable
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS;
    if (allowedOrigins) {
      const originList = allowedOrigins.split(',').map((o) => o.trim());
      if (originList.includes(origin)) {
        return logCorsDecision(origin, true, 'cors_allowed_origins_match');
      }
    }

    // Default allowed origins (your own domains)
    const defaultAllowedOrigins = ['https://app.arcaai.com', 'https://dashboard.arcaai.com', 'https://admin.arcaai.com'];

    if (defaultAllowedOrigins.includes(origin)) {
      return logCorsDecision(origin, true, 'default_allowed_domain');
    }

    // Allow development tools in production for SDK testing
    const devToolPatterns = [
      /\.ngrok\.io$/, // ngrok.io domains
      /\.ngrok-free\.app$/, // ngrok free tier domains
      /\.loca\.lt$/, // localtunnel domains
      /\.vercel\.app$/, // Vercel preview deployments
      /\.netlify\.app$/, // Netlify preview deployments
    ];

    if (devToolPatterns.some((pattern) => pattern.test(origin))) {
      return logCorsDecision(origin, true, 'dev_tool_pattern_match');
    }

    // For SDK usage: Allow any HTTPS origin
    if (origin.startsWith('https://')) {
      // Block suspicious origins
      const blockedPatterns = [
        /\.onion$/, // Tor domains
        /localhost/, // Localhost in production
        /127\.0\.0\.1/, // Local IPs
        /192\.168\./, // Private networks
        /10\./, // Private networks
        /172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private networks
      ];

      const isBlocked = blockedPatterns.some((pattern) => pattern.test(origin));
      if (isBlocked) {
        return logCorsDecision(origin, false, 'suspicious_pattern_blocked');
      }

      return logCorsDecision(origin, true, 'https_sdk_allowed');
    }

    return logCorsDecision(origin, false, 'not_https');
  } else if (nodeEnv === 'staging') {
    // Allow localhost patterns
    const localhostPatterns = [
      /^http:\/\/localhost:\d+$/,
      /^https:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^https:\/\/127\.0\.0\.1:\d+$/,
    ];

    // Allow staging domains
    const stagingDomains = ['https://staging.arcaai.com', 'https://staging-app.arcaai.com', 'https://staging-dashboard.arcaai.com'];

    // Allow development tools (ngrok, localtunnel, etc.)
    const devToolPatterns = [
      /\.ngrok\.io$/, // ngrok.io domains
      /\.ngrok-free\.app$/, // ngrok free tier domains
      /\.loca\.lt$/, // localtunnel domains
      /\.cloudflare\.com$/, // Cloudflare tunnel domains
      /\.vercel\.app$/, // Vercel preview deployments
      /\.netlify\.app$/, // Netlify preview deployments
      /\.surge\.sh$/, // Surge.sh domains
      /\.repl\.co$/, // Repl.it domains
      /\.gitpod\.io$/, // Gitpod workspace domains
      /\.codesandbox\.io$/, // CodeSandbox domains
    ];

    const isLocalhost = localhostPatterns.some((pattern) => pattern.test(origin));
    const isStagingDomain = stagingDomains.includes(origin);
    const isDevTool = devToolPatterns.some((pattern) => pattern.test(origin));

    if (isLocalhost) {
      return logCorsDecision(origin, true, 'localhost_pattern_match');
    }
    if (isStagingDomain) {
      return logCorsDecision(origin, true, 'staging_domain');
    }
    if (isDevTool) {
      return logCorsDecision(origin, true, 'dev_tool_pattern_match');
    }

    return logCorsDecision(origin, false, 'staging_not_allowed');
  } else {
    // Development: Allow all origins
    return logCorsDecision(origin, true, 'development_all_allowed');
  }
}

/**
 * Get CORS origins based on environment
 */
function getCorsOrigins(
  nodeEnv: string,
): string[] | boolean | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void) {
  if (nodeEnv === 'development') {
    // Development: Allow all origins for local development
    return true;
  } else {
    // Production and Staging: Use callback for flexible origin validation
    return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const isAllowed = isOriginAllowed(origin, nodeEnv);
      callback(null, isAllowed);
    };
  }
}

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
    const config = new DocumentBuilder().setTitle('Api').setDescription('Main api backend').setVersion('1.0').addBearerAuth().build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document);
  }
  // Session configuration (debug logging removed - session config is sensitive)
  app.use(
    session({
      secret: process.env.SESSION_SECRET_KEY || 'a-very-secret-key',
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

  // Phase 0 Item 3 (TASK-302 Stream A) — refuse to start if any admin
  // route lacks an explicit permission decorator. Throws an Error that
  // propagates out of bootstrap() and terminates the process before
  // any request can be served.
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
