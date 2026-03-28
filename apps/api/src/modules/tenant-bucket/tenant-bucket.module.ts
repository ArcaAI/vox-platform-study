import { TenantBucketServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { TenantBucketController } from './tenant-bucket.controller';

@Module({
  imports: [TenantBucketServiceModule],
  controllers: [TenantBucketController],
})
export class TenantBucketModule {}
