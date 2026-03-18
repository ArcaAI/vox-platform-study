import { Module } from '@nestjs/common';
import { ConfigModule } from '../_meta/config';
import { IServiceHealthMonitoringService } from './IServiceHealthMonitoringService';
import { ServiceHealthMonitoringService } from './serviceHealthMonitoring.service';

@Module({
    imports: [ConfigModule],
    providers: [
        {
            provide: IServiceHealthMonitoringService,
            useClass: ServiceHealthMonitoringService,
        },
    ],
    exports: [IServiceHealthMonitoringService],
})
export class ServiceHealthMonitoringServiceModule {}
