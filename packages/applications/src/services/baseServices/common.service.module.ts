import { Module } from '@nestjs/common';

import { ConfigModule, AppSettingsModule, SecretsModule } from './_meta';

import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { IntegrationsModule, S3ServiceModule, RedisServiceModule, HealthCheckServiceModule, ObservabilityModule } from '.';

const imports = [
  ConfigModule,
  CoreDatabaseModule,
  SecretsModule.forRoot({
    defaultTtlSec: Number(process.env.SECRETS_TTL_SEC ?? 300),
    lruMax: Number(process.env.SECRETS_LRU_MAX ?? 200),
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
