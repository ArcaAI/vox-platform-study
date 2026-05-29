import { Module } from '@nestjs/common';

import { ConfigModule, AppSettingsModule, SecretsModule } from './_meta';

import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { IntegrationsModule, S3ServiceModule, RedisServiceModule, HealthCheckServiceModule, ObservabilityModule } from '.';

// TASK-307 W2.1 follow-up — keys warmed during DI construction so
// downstream sync consumers (JwtStrategy, GatewayJwtStrategy, the
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
  'SMR_SERVICE_TOKEN',
  'MQTT_PASS',
  'REDIS_PASS',
] as const;

const imports = [
  ConfigModule,
  CoreDatabaseModule,
  SecretsModule.forRoot({
    defaultTtlSec: Number(process.env.SECRETS_TTL_SEC ?? 300),
    lruMax: Number(process.env.SECRETS_LRU_MAX ?? 200),
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
