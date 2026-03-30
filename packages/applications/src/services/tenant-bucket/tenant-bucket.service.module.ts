import { Module } from '@nestjs/common';
import { TenantBucketService } from './tenant-bucket.service';
import { ITenantBucketService } from './ITenantBucketService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { S3ServiceModule } from '../baseServices/storage/s3/s3.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, S3ServiceModule],
  providers: [
    {
      provide: ITenantBucketService,
      useClass: TenantBucketService,
    },
    TenantBucketService,
  ],
  exports: [ITenantBucketService, TenantBucketService],
})
export class TenantBucketServiceModule {}
