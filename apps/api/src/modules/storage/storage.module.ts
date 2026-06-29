import { ImageThumbnailService, MediaServiceModule, S3ServiceModule, TenantBucketServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';

@Module({
  imports: [S3ServiceModule, MediaServiceModule, TenantBucketServiceModule],
  controllers: [StorageController],
  // TASK-375 (thumbnails) — dependency-free image-derivative generator (sharp)
  // consumed by StorageController.uploadFile.
  providers: [ImageThumbnailService],
})
export class StorageModule {}
