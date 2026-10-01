import { Module } from '@nestjs/common';
import { TenantCheckpointServiceModule } from '@arcaai/applications';
import { TenantCheckpointController } from './tenant-checkpoint.controller';

@Module({
  imports: [TenantCheckpointServiceModule],
  controllers: [TenantCheckpointController],
})
export class TenantCheckpointModule {}
