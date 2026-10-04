import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { MediaServiceModule } from '../media/media/media.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';
import { TenantBucketServiceModule } from '../tenant-bucket/tenant-bucket.service.module';
import { IMediaUploadService } from './IMediaUploadService';
import { MediaUploadService } from './media-upload.service';

/**
 * TASK-1038 (F1) — `IMediaUploadService`. `IBlobStorageService` is @Global (`BlobStorageModule`);
 * `TenantSettingsService` is provided LOCALLY over `CommonServiceModule`'s settings plane, the
 * `AgentModule` / `WorkflowRunCompletionModule` precedent.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, MediaServiceModule, TenantBucketServiceModule],
  providers: [TenantSettingsService, { provide: IMediaUploadService, useClass: MediaUploadService }],
  exports: [IMediaUploadService],
})
export class MediaUploadServiceModule {}
