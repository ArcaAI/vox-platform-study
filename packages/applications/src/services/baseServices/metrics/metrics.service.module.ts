import { Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { MetricsService } from './metrics.service';
import { IMetricsService } from './IMetricsService';
import { ConfigModule } from '../_meta/config';

@Module({
    imports: [
        ConfigModule,
        PrometheusModule.register({
            path: '/metrics',
            defaultMetrics: {
                enabled: false, // We'll handle default metrics in the service
            },
        }),
    ],
    providers: [
        {
            provide: IMetricsService,
            useClass: MetricsService,
        },
    ],
    exports: [IMetricsService, PrometheusModule],
})
export class MetricsServiceModule {}
