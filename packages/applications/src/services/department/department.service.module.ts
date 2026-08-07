import { Module } from '@nestjs/common';
import { DepartmentService } from './department.service';
import { IDepartmentService } from './IDepartmentService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    DepartmentService,
    {
      provide: IDepartmentService,
      // useExisting, not useClass — useClass would construct a second
      // DepartmentService instance instead of aliasing the one above. No
      // cache/listener/timer state here, so the duplicate was harmless, but
      // aliasing is free.
      useExisting: DepartmentService,
    },
  ],
  exports: [IDepartmentService, DepartmentService],
})
export class DepartmentServiceModule {}
