import { Module } from '@nestjs/common';
import { RolePermissionService } from './rolePermission.service';
import { IRolePermissionService } from './IRolePermissionService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IRolePermissionService,
      useClass: RolePermissionService,
    },
  ],
  exports: [IRolePermissionService],
})
export class RolePermissionServiceModule {}
