import { HealthCheckServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ApiHealthController } from './health.controller';

@Module({
    imports: [HealthCheckServiceModule, HttpModule],
    controllers: [ApiHealthController],
})
export class HealthModule {}