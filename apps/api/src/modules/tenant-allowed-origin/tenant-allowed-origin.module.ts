import { Module } from '@nestjs/common';
import { TenantAllowedOriginServiceModule } from '@arcaai/applications';
import { TenantAllowedOriginController } from './tenant-allowed-origin.controller';

@Module({
  imports: [TenantAllowedOriginServiceModule],
  controllers: [TenantAllowedOriginController],
})
export class TenantAllowedOriginModule {}
