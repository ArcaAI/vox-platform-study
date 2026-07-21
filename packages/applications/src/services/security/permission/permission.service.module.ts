import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { IPermissionService } from './IPermissionService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IPermissionService,
      useClass: PermissionService,
    },
  ],
  exports: [IPermissionService],
})
export class PermissionServiceModule {}
