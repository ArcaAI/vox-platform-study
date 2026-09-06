import { Module } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { ITenantService } from './ITenantService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { TenantBucketServiceModule } from '../tenant-bucket/tenant-bucket.service.module';
import { TenantReferenceSetServiceModule } from './reference-set/tenant-reference-set.service.module';

@Module({
  // TASK-890 §3.4 — `TenantService.create` provisions the SYSTEM reference set as its last
  // step. Importing the module is safe because it is a LEAF (it resolves the four kind-owning
  // services from the container at call time rather than importing their modules — see its own
  // doc comment for why that edge cannot exist).
  imports: [CommonServiceModule, CoreDatabaseModule, TenantBucketServiceModule, TenantReferenceSetServiceModule],
  providers: [
    {
      provide: ITenantService,
      useClass: TenantService,
    },
  ],
  exports: [ITenantService],
})
export class TenantServiceModule {}
