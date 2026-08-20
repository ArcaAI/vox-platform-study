import { BuildInfoService, ILoggingService, IServiceReleaseService, loadEnv, SecretsService } from '@arcaai/applications';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { auditAdminRoutePermissions } from './bootstrap/admin-route-permission-audit';
import { auditApiKeyRequiredScopes, auditInternalRoutesOffApiKeySurface } from './bootstrap/api-key-scope-audit';
import { auditAdminScopedControllers, auditAdminControllersDeclareNoApiKeyScopes } from './bootstrap/admin-scope-audit';
import { auditEveryApiKeyReachableRouteDeclaresScopes } from './bootstrap/api-key-surface-audit';
import { auditBusinessPlaneApiKeyExemptions } from './bootstrap/business-plane-apikey-exemptions-audit';
import { auditConsentRouteCoverage } from './bootstrap/consent-route-coverage-audit';
import { auditServiceAccountSurface } from './bootstrap/service-account-surface-audit';
import { auditWebSocketGatewayOwnerBinding } from './bootstrap/ws-gateway-owner-audit';
import { auditCaslEnforcePairReachability } from './bootstrap/casl-enforce-reachability-audit';
import { auditOptimisticConcurrencyCoverage } from './bootstrap/occ-coverage-audit';
import { assertGenaiContentCaptureDisabled } from './bootstrap/genai-content-capture-audit';
import { assertJwtSecretNotPlaceholder } from './bootstrap/jwt-secret-placeholder-audit';
// CORS helpers live in `cors.config.ts` so the dev / staging / production
// branches can be unit-tested without booting the Nest application.
// `isOriginAllowed` is re-exported so external consumers (docs reference)
// still have a working import.
import { apiEnv } from './config';
import { buildCorsOptions, isOriginAllowed } from './cors.config';
import { API_GLOBAL_PREFIX, API_GLOBAL_PREFIX_OPTIONS } from './global-prefix.config';
import { flushOtel } from './instrumentation';
import { ETagInterceptor } from './interceptors';
import { GracefulShutdownService, startServiceReleaseRegistration } from './services';
// Swagger config lives in `swagger.config.ts` so the security-scheme list
// (bearer + api-key) is unit-testable.
import { buildSwaggerConfig } from './swagger.config';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- express-session ships an `export =` CJS module; `import session = require(...)` is the correct TS interop form, not an ESM default import
import session = require('express-session');

export { isOriginAllowed };

async function bootstrap() {
  // Read the env file for this NODE_ENV BEFORE anything in bootstrap() touches
  // `process.env`. `LOG_LEVEL`, `PORT` and `SHUTDOWN_*_MS` below are all
  // consumed before the Nest module graph (and therefore ConfigService, the
  // only previous caller of loadEnv) exists, so without this line they
  // silently saw host environment only.
  //
  // Safe to call here and again in ConfigService: the loader never overrides a
  // variable already present in `process.env`, and reads nothing when CI=true
  // or NODE_ENV=production.
  //
  // SCHEMA SEAM: the zod env schema validates *here*, right
  // after loadEnv() and before NestFactory.create(), so a missing env-tier var
  // fails fast at boot with the full list of problems.
  loadEnv();

  // PHI-safe telemetry: refuse to boot in production unless
  // OTel GenAI content-capture is pinned off. Placed immediately after
  // `loadEnv()` — the earliest point `process.env` carries the fully
  // resolved (host env > env file) value — and before the zod schema below,
  // so a misconfigured production deploy fails on the single most direct
  // check rather than surfacing as a generic schema problem.
  assertGenaiContentCaptureDisabled();

  // Validate the declared env surface (built from the settings-registry
  // descriptors) and read the pre-bootstrap values from the TYPED result rather
  // than from `process.env` — the three reads below (`LOG_LEVEL`, `PORT`,
  // `SHUTDOWN_*_MS`) all happen before the Nest module graph exists, so they
  // are exactly the ones requires to move behind the schema. CORS
  // has no env entry at all any more — `TenantAllowedOrigin`
  // rows are the only source. Throws ONE error listing every problem; the
  // process exits before any port is bound.
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
  const globalPrefix = API_GLOBAL_PREFIX;

  app.setGlobalPrefix(globalPrefix, API_GLOBAL_PREFIX_OPTIONS);

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

  // Disable Express's default auto-generated ETag. Left on, it stamps a WEAK
  // content-hash validator (`W/"<len>-<hash>"`) on every JSON GET, including
  // the ~70% of GET routes whose body carries no `version`. Those tokens are
  // unusable as preconditions: replayed as `If-Match` they either fail the
  // strong-validator check with 400, or — on a route with no
  // `@ExpectedVersion()` — are silently discarded and the write proceeds
  // anyway. Advertising no validator is strictly safer than advertising one
  // the write path will never honour.
  //
  // This disables ETag GENERATION only. Express's own freshness check in
  // `res.send` is independent of this setting and still short-circuits to 304
  // for any response that carries an ETag, so conditional GET survives on
  // versioned routes; `ETagInterceptor` implements it explicitly regardless.
  // (Reached through the http adapter rather than a `NestExpressApplication`
  // generic on `NestFactory.create` so the bootstrap signature is untouched.)
  app.getHttpAdapter().getInstance().set('etag', false);

  // Renders RFC 7232 strong `ETag` headers from `body.version` — after the
  // line above, the ONLY ETag this API emits. Also serves the matching
  // conditional GET (`If-None-Match` -> 304) and sets
  // `Cache-Control: private, no-cache` on authenticated GETs. Non-versioned
  // routes pass through unchanged. The `If-Match` round-trip on PATCH is
  // enforced by `@RequiresIfMatch()` + `@ExpectedVersion()`.
  app.useGlobalInterceptors(new ETagInterceptor());

  // Enable shutdown hooks for graceful termination
  // This activates onModuleDestroy, beforeApplicationShutdown, and onApplicationShutdown hooks
  // Required for proper Kubernetes/Docker graceful shutdown handling
  app.enableShutdownHooks();

  // Get the graceful shutdown service to log configuration
  const gracefulShutdownService = app.get(GracefulShutdownService);

  // Route the OTel flush through Nest's own shutdown sequence instead of the
  // competing SIGTERM handler `instrumentation.ts` used to install itself
  // . `beforeApplicationShutdown` runs this alongside every
  // other cleanup callback, under its own timeout, after the readiness gate
  // has already closed and connections have started draining.
  gracefulShutdownService.registerCleanupCallback('otel-flush', flushOtel);

  // Self-registration: the gateway is the ONLY process that
  // registers IN-PROCESS — it already holds `IServiceReleaseService`, so it
  // calls `registerInstance()` directly rather than making a self-HTTP call
  // . Fire-and-forget, bounded-timeout, and — like every other
  // process — must NEVER block or fail boot; failures are logged and
  // swallowed inside `startServiceReleaseRegistration` itself.
  const serviceReleaseHandle = startServiceReleaseRegistration(app.get(IServiceReleaseService), new BuildInfoService(), nodeEnv, {
    onError: (error) =>
      loggingService.warn('Service-release registration failed (non-fatal)', { error: (error as Error)?.message ?? error }, 'Bootstrap'),
  });
  gracefulShutdownService.registerCleanupCallback('service-release-heartbeat', async () => serviceReleaseHandle.stop());

  loggingService.info(
    'Graceful shutdown enabled',
    {
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      drainDelayMs: env.SHUTDOWN_DRAIN_DELAY_MS,
    },
    'Bootstrap',
  );

  // CORS options — assembled in `cors.config.ts` so `credentials: false`
  // is unit-testable rather than buried in this closure.
  app.enableCors(buildCorsOptions(nodeEnv));

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

  // Log CORS configuration.
  //
  // This line is what an incident responder greps first, so it must describe
  // the code as it stands — a stale policy label here sends someone hunting a
  // behavior that no longer exists. It has been wrong twice already: it said
  // `allow_all` for three tickets after dev was pinned to localhost, and it
  // said `allowlist_then_any_https` for the few hours between landing
  // the header fixes and deleting the catch-all it named.
  //
  // Since the allow-list is the `TenantAllowedOrigin` table, indexed
  // by `OriginRegistryService` and consulted PER REQUEST — so there is no
  // static list to print here any more. There is also no env
  // bootstrap fallback: an unreachable or not-yet-loaded registry DENIES
  // every browser origin (see `cors.config.ts`'s `origin_registry_unavailable`
  // reason) rather than falling back to `CORS_ALLOWED_ORIGINS`, which no
  // longer exists.
  //
  // …AND SINCE ALL OF THAT IS GATED by `origin.enforcementEnabled`, which
  // THIS LINE DELIBERATELY DOES NOT REPORT.
  //
  // It tried to, and it was wrong: read here — right after NestFactory.create()
  // — the AppSettings cache is not yet warm, so the switch resolves to its
  // descriptor default. A gateway with enforcement ENABLED in the database
  // announced "ENFORCEMENT IS DISABLED" at boot and then correctly refused an
  // unregistered origin seconds later. A signal that lies about a security
  // posture is worse than no signal, and two places claiming the posture is how
  // they drift apart in the first place.
  //
  // The posture is therefore announced by `PlatformKnobsBinder`, from
  // `app-settings.cache-refreshed` — the first moment the value is trustworthy —
  // and re-announced on every CHANGE. Grep `ORIGIN ENFORCEMENT IS` for the
  // authoritative line. Everything below is STATIC: true at boot regardless of
  // which way the switch is set.
  loggingService.info(
    'CORS configuration',
    {
      environment: nodeEnv,
      // Pinned in `buildCorsOptions` — the reason an allow-all posture is an
      // ordinary public-API stance rather than a cross-origin read primitive.
      credentials: false,
      // What enforcement DOES when it is on; not a claim that it is.
      policyWhenEnforced: nodeEnv === 'development' ? 'origin_registry_plus_dev_loopback' : 'origin_registry_only',
      unavailableRegistryBehaviorWhenEnforced: 'deny_all',
      enforcementSetting: 'origin.enforcementEnabled',
      enforcementPostureLoggedBy: 'PlatformKnobsBinder (log marker: ORIGIN ENFORCEMENT)',
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

  // Refuses to start if any route on the HOPE Node SDK's day-1 summarization
  // surface lost its `@RequiredScopes(...)` metadata — closes
  // G1 (a leaked API key reaching every RBAC-permitted route unscoped) and
  // guards against a future refactor silently dropping the decorator.
  auditApiKeyRequiredScopes();

  // Refuses to start if any `/internal/*` route is reachable through
  // UnifiedAuthGuard's ordinary JWT/API-key auth path instead of a dedicated
  // platform service-token guard — closes G2 (TASK-708: any active API key
  // could reach SttInternalController) and guards against a future
  // `/internal/*` controller forgetting the guard.
  auditInternalRoutesOffApiKeySurface(app);

  // Policy A2 (TASK-757): `/api/v1/admin/*` is JWT-only. The DERIVED sweep is
  // the gate that survives new controllers — it fails the boot when any
  // admin-prefixed route declares `@RequiredScopes`, with no list to maintain.
  auditAdminControllersDeclareNoApiKeyScopes(app);

  // The named-list companion: every admin controller the gateway registers is
  // pinned as `@ForbidApiKey()`. Catches a controller disappearing from the
  // module graph, which the sweep above structurally cannot see.
  auditAdminScopedControllers();

  // Refuses to start if ANY non-`@Public()` route declares neither
  // `@RequiredScopes(...)` nor `@ForbidApiKey()` (TASK-742). The two audits
  // above pin that a NAMED surface keeps a NAMED scope; this one pins that no
  // route ANYWHERE is left undeclared. `UnifiedAuthGuard`'s API-key path now
  // fails closed, so an undeclared route already refuses every API key at
  // runtime — this turns that into a boot-time authoring error instead of a
  // production 403.
  auditEveryApiKeyReachableRouteDeclaresScopes(app);

  // Refuses to start if a NON-`admin/` route forbids API keys without being a
  // named, reasoned exemption (TASK-758, policy A1). The audit above pins that
  // every route DECLARES something; this pins that what the business plane
  // declares is JWT + API key, and that each `@ForbidApiKey()` surviving there
  // (auth, voice biometrics, personal writing model) is an owner decision
  // recorded in `BUSINESS_PLANE_KEY_FORBIDDEN`, not TASK-742's pending default.
  auditBusinessPlaneApiKeyExemptions(app);

  // Refuses to start if any route taking a `:patientId` route param lacks
  // both `@RequiresConsent(...)` and `@ConsentExempt(...)` (TASK-712,
  // consent-abac). `PatientConsentGuard` (APP_GUARD) makes the same
  // predicate authoritative at request time; this surfaces a forgotten
  // decorator at boot instead of a silent enforcement gap in production.
  auditConsentRouteCoverage(app);

  // Refuses to start if the THIRD credential class (TASK-762) has leaked into
  // either of the other two planes, or has lost its own gates:
  //   B  no /admin/* controller uses a peer-service token guard — the owner's
  //      TASK-708 §6 non-mixing ruling made MECHANICAL rather than left as an
  //      accident of implementation (§2.1 verified it holds today; nothing
  //      stopped it from changing tomorrow);
  //   C  no /internal/* route declares a svc:* scope — the mirror of B;
  //   D  every svc:* scope maps to a live admin area and vice-versa;
  //   E  /admin/service-accounts carries BOTH @ForbidApiKey() and
  //      @ForbidServiceAccount() — no key-path escalation into machine
  //      issuance, and no self-replication;
  //   F  POST /auth/service-token is @Public() AND guarded;
  //   G  every admin/ route declares EITHER a svc:* scope OR
  //      @ForbidServiceAccount() — never both, never a scope outside the
  //      registry, and never one that resolves to no CASL ability. The business
  //      plane is exempt: its default never changed, so silence there still
  //      means the implicit deny-by-default (TASK-773 A3/A5);
  //   H  each of the 64 swept admin controllers declares exactly the svc: twin
  //      of the admin:* scope TASK-757 removed from it — the MIS-assignment G
  //      structurally cannot see (TASK-773 A4).
  auditServiceAccountSurface(app);

  // Refuses to start if a `@WebSocketGateway()` class is not classified in
  // `WS_OWNER_BOUND_GATEWAYS` (TASK-761 G4). Structural note: this is the ONLY
  // audit here that walks `moduleRef.providers` — Nest registers gateways as
  // providers, so every `.controllers` sweep above is blind to all three of
  // them, and always has been. It pins the DECLARATION (a WS surface cannot
  // ship without someone answering "may THIS caller drive THIS stream?"), never
  // the behaviour; the behaviour is pinned by the specs each entry names.
  auditWebSocketGatewayOwnerBinding(app);

  // Refuses to start if a pair listed in `CASL_ENFORCED_PAIRS` cannot actually
  // produce the 403 it claims (TASK-781). TASK-712 listed three `ApiKey` pairs
  // whose resolver loads its row through a 404-throwing accessor, so on the
  // deny case the resolver threw, the guard failed open, and
  // `casl_enforce_denial_total` could never move — a counter reading zero
  // because it CANNOT fire is indistinguishable from one reading zero because
  // nothing diverged (TASK-779 F-1). Also refuses an enforced pair on an
  // OR-mode route, where an enforced denial would override an allow earned by
  // another alternative. Passes vacuously while the enforce list is empty.
  auditCaslEnforcePairReachability(app);

  // WARN-ONLY (REST review H-1). Reports version-bearing PATCH/PUT routes that
  // do not require `If-Match`. Deliberately does NOT refuse boot: closing the
  // gap is a breaking, owner-sequenced client migration, not drift an operator
  // can fix at startup. See the file header for the detection rule and limits.
  auditOptimisticConcurrencyCoverage(app);

  // KEEP-ALIVE MUST OUTLIVE THE UPSTREAM PROXY'S IDLE TIMEOUT.
  //
  // Node defaults `keepAliveTimeout` to 5s. Any client that pools connections —
  // nginx / an ALB (idle timeout typically ~60s), or a test runner's HTTP agent
  // — will happily hold a socket well past that. When the server closes an idle
  // socket the client still believes is usable, a request written into it at
  // that instant is answered with an RST, not a response: the peer sees
  // ECONNRESET and the server logs NOTHING, because the request never reached
  // the application layer. Behind a proxy that surfaces as an intermittent 502
  // on a healthy gateway; against the e2e suite it surfaced as a login that
  // reset roughly once a run, always on the first request of a spec file (the
  // moment a pooled socket is most likely to have gone idle).
  //
  // Making the server outlast the proxy moves the close to the CLIENT side,
  // where a half-closed socket is detected before a request is written rather
  // than after. `headersTimeout` must stay strictly greater than
  // `keepAliveTimeout` — it bounds the same wait, so an equal-or-lower value
  // reintroduces the race it is meant to close.
  const httpServer = app.getHttpServer();
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

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
