import { Module } from '@nestjs/common';

import { ConfigModule, AppSettingsModule, SecretsModule } from './_meta';

import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { IntegrationsModule, S3ServiceModule, RedisServiceModule, HealthCheckServiceModule, ObservabilityModule } from '.';

// Keys warmed during DI construction so
// downstream sync consumers (JwtStrategy, the
// OPENID_CLIENT factory, AuthController JWT sign path) observe a warm
// cache. SecretsModule.forRoot turns the SecretsService provider into
// an async useFactory when this list is non-empty (see
// secrets.module.ts → SecretsModuleOptions.warmupKeys).
//
// The list was previously passed to `secretsService.boot(...)` in
// `apps/api/src/main.ts`, but that call ran AFTER NestFactory.create()
// had already wired JwtStrategy against an empty cache. Moving the
// boot into the DI factory closes that ordering gap.
//
// Missing keys log a WARN (Promise.allSettled in SecretsService.boot)
// rather than throw, so a single misconfigured key doesn't block boot.
export const COMMON_SERVICE_WARMUP_KEYS = [
  'JWT_SECRET_KEY',
  'SESSION_SECRET_KEY',
  'API_KEY_PEPPER',
  'OIDC_CLIENT_SECRET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'TEXT_SERVICE_TOKEN',
  // Read ONLY through `getSecretSync` (SpeechProxyController.getForwardHeaders,
  // TtsWsGateway.openBridge) — both are on paths that cannot await. Because
  // `getSecretSync` is cache-only by design, an unwarmed key resolves to
  // undefined on EVERY request, not just the first, so the `X-Service-Token`
  // header was silently never attached. Pinned by `warmup-coverage.test.ts`.
  'TTS_SERVICE_TOKEN',
  'MQTT_PASS',
  'REDIS_PASS',
] as const;

const imports = [
  ConfigModule,
  CoreDatabaseModule,
  SecretsModule.forRoot({
    defaultTtlSec: Number(process.env.SECRETS_TTL_SEC ?? 300),
    lruMax: Number(process.env.SECRETS_LRU_MAX ?? 200),
    // Keep the sync-only service tokens (SMR/TTS X-Service-Token) continuously
    // warm; unset derives max(30, TTL/2) so warmed keys never expire cold.
    reWarmIntervalSec: process.env.SECRETS_REWARM_INTERVAL_SEC ? Number(process.env.SECRETS_REWARM_INTERVAL_SEC) : undefined,
    warmupKeys: [...COMMON_SERVICE_WARMUP_KEYS],
  }),
  AppSettingsModule.forRoot(),

  RedisServiceModule.register([
    // TODO: move the JobQueue to the application layer as a configuration
    JobQueue.AuditLog,
    JobQueue.UserActivity,
    JobQueue.SendEmail,
    JobQueue.SendSms,
    JobQueue.ReceiveEmail,
    JobQueue.ReceiveSms,
    JobQueue.SysEvent,
    JobQueue.WebCrawler,
    JobQueue.SpeechToText,
    // Consultation AI Processing Queues
    JobQueue.GeneratePreSummary,
    JobQueue.GenerateSummary,
    JobQueue.ExtractNamedEntities,
    // DNA Writing Style Analysis
    JobQueue.GenerateDnaReport,
  ]),

  IntegrationsModule,
  S3ServiceModule.forRoot(),
  HealthCheckServiceModule,
  ObservabilityModule,
];

const DatabasesModules = [CoreDatabaseModule];

const exportModules = [
  ConfigModule,

  ...DatabasesModules,

  AppSettingsModule,
  SecretsModule,
  RedisServiceModule,
  IntegrationsModule,
  S3ServiceModule,
  HealthCheckServiceModule,
  ObservabilityModule,
];

@Module({
  imports,
  exports: exportModules,
})
export class CommonServiceModule {}
