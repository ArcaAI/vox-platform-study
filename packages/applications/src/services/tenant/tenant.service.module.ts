import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { ITenantService } from './ITenantService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { TenantBucketServiceModule } from '../tenant-bucket/tenant-bucket.service.module';

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule, TenantBucketServiceModule],
    providers: [
        {
            provide: ITenantService,
            useClass: TenantService
        }
    ],
    exports: [ITenantService]
})
export class TenantServiceModule {}
