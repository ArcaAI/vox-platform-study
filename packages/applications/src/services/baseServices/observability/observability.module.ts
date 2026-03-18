import { Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { IMetricsService } from '../metrics/IMetricsService';
import { IMonitoringService } from '../monitoring/IMonitoringService';
import { SimplifiedMetricsService } from './simplified-metrics.service';
import { SimplifiedMonitoringService } from './simplified-monitoring.service';
import { OpenTelemetryService } from './otel.service';
import { JobMetricsService } from './job-metrics.service';
import { ConfigModule } from '../_meta/config';

@Module({
    imports: [
        ConfigModule,
        PrometheusModule.register({
            path: '/metrics',
            defaultMetrics: {
                enabled: false, // We handle default metrics in our service
            },
        }),
    ],
    providers: [
        OpenTelemetryService,
        JobMetricsService,
        {
            provide: IMetricsService,
            useClass: SimplifiedMetricsService,
        },
        {
            provide: IMonitoringService,
            useClass: SimplifiedMonitoringService,
        },
    ],
    exports: [
        IMetricsService,
        IMonitoringService,
        OpenTelemetryService,
        JobMetricsService,
        PrometheusModule,
    ],
})
export class ObservabilityModule {} 