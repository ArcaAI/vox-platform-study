import { Module } from '@nestjs/common';
import { TenantBucketService } from './tenant-bucket.service';
import { ITenantBucketService } from './ITenantBucketService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { S3ServiceModule } from '../baseServices/storage/s3/s3.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, S3ServiceModule],
  providers: [
    TenantBucketService,
    {
      provide: ITenantBucketService,
      // useExisting, not useClass — useClass would construct a second
      // TenantBucketService instance instead of aliasing the one above. Its
      // `new Map()` usages are local variables inside method bodies (e.g.
      // building a tree), not instance state, so the duplicate was
      // harmless, but aliasing is free.
      useExisting: TenantBucketService,
    },
  ],
  exports: [ITenantBucketService, TenantBucketService],
})
export class TenantBucketServiceModule {}
