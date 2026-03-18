import { Module } from '@nestjs/common';

import { ConfigModule, AppSettingsModule } from './_meta';

import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';

import { IntegrationsModule, S3ServiceModule, RedisServiceModule, HealthCheckServiceModule, ObservabilityModule } from '.';

const imports = [
    ConfigModule,
    CoreDatabaseModule,
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
