import { MediaServiceModule, S3ServiceModule, TenantBucketServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';

@Module({
  imports: [S3ServiceModule, MediaServiceModule, TenantBucketServiceModule],
  controllers: [StorageController],
})
export class StorageModule {}
