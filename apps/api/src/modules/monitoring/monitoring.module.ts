import { ApiKeyServiceModule, ServiceHealthMonitoringServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';

@Module({
  imports: [ApiKeyServiceModule, ServiceHealthMonitoringServiceModule],
  controllers: [MonitoringController],
})
export class MonitoringModule {}
