import { Module } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';

import { MonitoringService } from './monitoring.service';
import { IMonitoringService } from './IMonitoringService';
import { MetricsServiceModule } from '../metrics/metrics.service.module';
import { ConfigModule } from '../_meta/config';

@Module({
    imports: [ConfigModule, MetricsServiceModule],
    controllers: [],
    providers: [
        {
            provide: IMonitoringService,
            useClass: MonitoringService,
        },
        makeGaugeProvider({
            name: 'system_cpu_usage',
            help: 'Current CPU usage percentage',
        }),
        makeGaugeProvider({
            name: 'system_memory_usage',
            help: 'Current memory usage percentage',
        }),
    ],
    exports: [IMonitoringService],
})
export class MonitoringServiceModule {}
